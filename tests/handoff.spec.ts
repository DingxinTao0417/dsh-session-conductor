import { describe, expect, it } from 'vitest'
import { describePreconditions, handoffTask, type HandoffDeps } from '../src/service/handoff.ts'
import { sessionContinuationFields } from '../src/domain/session-chain.ts'
import { Coordinator, type CoordinatorDeps } from '../src/service/coordinator.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GitResult, GitRunner } from '../src/service/git.ts'

/** Build a Host-shaped session event. */
function event(seq: number, type: string, data: unknown = {}): SessionEventLike {
  return { type, seq, time: seq, data }
}

const finishedTurn = [
  event(0, 'turn/start', { turn: 1 }),
  event(1, 'user/message', { content: [{ type: 'text', text: 'do it' }] }),
  event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
]

describe('environment handoff (PRD §二.10.2)', () => {
  /** A task bound to a live, idle source session. */
  function setup(over: {
    status?: 'idle' | 'running'
    hasPending?: boolean
    idle?: boolean
    failCreate?: boolean
    directories?: Map<string, true>
    events?: SessionEventLike[]
    onCancel?: (events: SessionEventLike[]) => void
  } = {}) {
    const tables = createInMemoryTables()
    let tick = Date.parse('2026-09-13T00:00:00.000Z')
    const store = new ConductorStore(tables, () => new Date((tick += 1000)).toISOString())
    const flushed: string[] = []
    let createdCount = 0
    const directories = over.directories ?? new Map<string, true>([['D:\\target', true]])
    const events = [...(over.events ?? finishedTurn)]
    const cancelled: unknown[] = []

    const delivered: { sessionId: string; kind: string }[] = []
    const live = new Map<string, {
      id: SessionId
      status: 'idle' | 'running'
      inbox: { hasPending: boolean }
      session: { readonly seq: number; events: SessionEventLike[]; header: { id: unknown } }
      followup: (message: unknown) => void
      steer: (message: unknown) => void
      cancel: (cause: unknown) => void
      whenIdle: () => Promise<void>
    }>()
    const makeAgent = (id: string, agentOver: {
      status?: 'idle' | 'running'
      hasPending?: boolean
      idle?: boolean
      events?: SessionEventLike[]
    }) => {
      const agentEvents = agentOver.events ?? events
      return {
        id: id as SessionId,
        status: agentOver.status ?? ('idle' as const),
        inbox: { hasPending: agentOver.hasPending ?? false },
        session: {
          get seq() { return agentEvents.at(-1)?.seq ?? -1 },
          events: agentEvents,
          header: { id },
        },
        followup: () => { delivered.push({ sessionId: id, kind: 'followup' }) },
        steer: () => { delivered.push({ sessionId: id, kind: 'steer' }) },
        cancel: (cause: unknown) => {
          cancelled.push(cause)
          over.onCancel?.(agentEvents)
        },
        whenIdle: async () => {
          if (agentOver.idle === false) await new Promise(resolve => { setTimeout(resolve, 200) })
        },
      }
    }
    live.set('session-source', makeAgent('session-source', over))
    const agents = {
      get: (id: unknown) => live.get(String(id)),
      list: () => [...live.values()],
      create: async (options: { sessionId: SessionId }) => {
        if (over.failCreate === true) throw new Error('session id already in use')
        createdCount += 1
        const agent = makeAgent(String(options.sessionId), { status: 'idle', hasPending: false, events: [] })
        live.set(String(options.sessionId), agent)
        return { agent }
      },
    }

    const deps: HandoffDeps = {
      agents,
      store,
      sessions: { flush: async (session) => { flushed.push(String((session as { header: { id: unknown } }).header.id)); return true } },
      fs: {
        resolve: async (path) => path,
        stat: async (target) => (directories.has(String(target)) ? {} : undefined),
      },
      presets: { presetOf: () => 'standard', mount: async () => {} },
      createMessage: () => ({ id: 'msg-1' }),
      newSessionId: () => `session-successor-${String(createdCount + 1)}`,
      newBindingId: () => `binding-successor-${String(createdCount + 1)}`,
      now: () => new Date((tick += 1000)).toISOString(),
    }
    return { deps, store, flushed, directories, created: () => createdCount, cancelled, events, delivered, live }
  }

  /** Seed a managed task with one binding. */
  async function seedTask(store: ConductorStore, over: { cwd?: string } = {}) {
    await store.createTask({
      taskId: 'task-1', title: 't', pinned: false, archived: false,
      controllerSessionId: 'session-controller', requestedBy: 'user', contextMode: 'brief',
      preparation: 'ready', preparationPhase: 'ready', currentBindingId: 'binding-1',
      createdAt: 'now', updatedAt: 'now',
    })
    await store.putBinding({
      bindingId: 'binding-1', taskId: 'task-1', hostId: 'local', sessionId: 'session-source',
      version: 1, createdAt: 'now', ...over.cwd === undefined ? {} : { cwd: over.cwd },
    })
    await store.putAccess({
      taskId: 'task-1',
      ownerSessionId: 'session-controller',
      ownerEpoch: 0,
      observerSessionIds: [],
      updatedAt: 'now',
    })
  }

  const request = {
    operationId: 'op-1', callerSessionId: 'session-controller', taskId: 'task-1', targetPath: 'D:\\target',
  }

  it('moves the task to a successor session and keeps the taskId', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    const outcome = await handoffTask(deps, request)

    expect(outcome.succeeded).toBe(true)
    expect(outcome.taskId).toBe('task-1')
    expect(outcome.previousSessionId).toBe('session-source')
    expect(outcome.successorSessionId).toBeDefined()
    expect(outcome.successorSessionId).not.toBe('session-source')

    const task = store.getTask('task-1')
    expect(task?.taskId).toBe('task-1')
    const successor = store.getBinding(task?.currentBindingId ?? '')
    expect(successor?.sessionId).toBe(outcome.successorSessionId)
    expect(successor?.cwd).toBe('D:\\target')
    expect(successor?.version).toBe(2)
    // The chain is retained: the old binding is retired, not deleted.
    expect(successor?.predecessorBindingId).toBe('binding-1')
    expect(successor?.frozenThroughSeq).toBe(2)
    expect(outcome.frozenThroughSeq).toBe(2)
    expect(store.getBinding('binding-1')?.retiredAt).toBeDefined()
    expect(sessionContinuationFields(store.listBindings('task-1'), task?.currentBindingId)).toEqual({
      continuation: `任务继续于新会话 ${outcome.successorSessionId}（此前 session-source）`,
      sessionChain: `session-source → ${outcome.successorSessionId}`,
    })
  })

  it('flushes the source before moving', async () => {
    const { deps, store, flushed } = setup()
    await seedTask(store)
    await handoffTask(deps, request)
    expect(flushed).toEqual(['session-source'])
  })

  it('routes the successor instruction through admitted dispatch with pinned authority', async () => {
    const { deps, store, delivered } = setup()
    await seedTask(store)
    const sent: unknown[] = []
    const outcome = await handoffTask({ ...deps, dispatchInstruction: async instruction => {
      sent.push(instruction)
      return { delivery: 'pending' }
    } }, { ...request, instruction: 'continue' })
    expect(outcome.succeeded).toBe(true)
    expect(outcome.instructionDelivery).toBe('pending')
    expect(delivered).toEqual([])
    expect(sent).toEqual([{ operationId: 'op-1:instruction', taskId: 'task-1',
      callerSessionId: 'session-controller', text: 'continue', expectedOwnerEpoch: 0, expectedBindingVersion: 2 }])
  })

  it('refuses a control transfer that arrives while target validation is awaiting', async () => {
    const { deps, store, created } = setup()
    await seedTask(store)
    const outcome = await handoffTask({ ...deps, fs: { ...deps.fs!, resolve: async path => {
      await store.putAccess({ ...store.getAccess('task-1')!, ownerSessionId: 'new-owner', ownerEpoch: 1 })
      return path
    } } }, request)
    expect(outcome.succeeded).toBe(false)
    expect(outcome.reason).toMatch(/STALE_OWNER_EPOCH|NOT_CONTROLLER/)
    expect(created()).toBe(0)
    expect(store.getTask('task-1')?.currentBindingId).toBe('binding-1')
  })

  it('refuses if the source starts a new turn during successor creation', async () => {
    const { deps, store, events } = setup()
    await seedTask(store)
    const outcome = await handoffTask({ ...deps, agents: { ...deps.agents, create: async options => {
      const created = await deps.agents.create(options)
      events.push(event(3, 'turn/start', { turn: 2 }))
      return created
    } } }, request)
    expect(outcome.succeeded).toBe(false)
    expect(outcome.reason).toMatch(/source.*changed|active turn/)
    expect(store.getTask('task-1')?.currentBindingId).toBe('binding-1')
    expect(store.getBinding('binding-1')?.retiredAt).toBeUndefined()
  })

  it('rechecks authority inside the binding commit after persistence yields', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    const original = store.putBinding.bind(store)
    store.putBinding = async (binding, validate) => {
      await store.putAccess({ ...store.getAccess('task-1')!, ownerSessionId: 'new-owner', ownerEpoch: 1 })
      return original(binding, validate)
    }
    const outcome = await handoffTask(deps, request)
    expect(outcome.succeeded).toBe(false)
    expect(store.getTask('task-1')?.currentBindingId).toBe('binding-1')
    expect(store.getBinding('binding-1')?.retiredAt).toBeUndefined()
  })

  it('reports a committed successor when bookkeeping fails after the pointer moved', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    const original = store.putBinding.bind(store)
    store.putBinding = async (binding, validate) => {
      await original(binding, validate)
      throw new Error('retirement receipt lost')
    }
    const outcome = await handoffTask(deps, request)
    expect(outcome.succeeded).toBe(true)
    expect(outcome.reason).toMatch(/binding is committed/)
    expect(store.getBinding(store.getTask('task-1')?.currentBindingId ?? '')?.sessionId).toBe(outcome.successorSessionId)
  })

  it('refuses when the source has unconsumed queued input', async () => {
    const { deps, store, created } = setup({ hasPending: true })
    await seedTask(store)
    const outcome = await handoffTask(deps, request)

    expect(outcome.succeeded).toBe(false)
    expect(outcome.reached).toBe('stopping')
    expect(outcome.reason).toMatch(/unconsumed queued input/)
    expect(created()).toBe(0)
    // The task still points at the source.
    expect(store.getBinding(store.getTask('task-1')?.currentBindingId ?? '')?.sessionId).toBe('session-source')
  })

  it('refuses a source waiting on a user question before cancelling anything', async () => {
    const { deps, store, created, cancelled } = setup({
      status: 'running',
      events: [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' }),
      ],
    })
    await seedTask(store)
    const outcome = await handoffTask(deps, request)

    expect(outcome.succeeded).toBe(false)
    expect(outcome.reached).toBe('stopping')
    expect(outcome.reason).toMatch(/unresolved interaction \(waiting_input\)/)
    expect(created()).toBe(0)
    expect(cancelled).toEqual([])
    expect(store.getBinding(store.getTask('task-1')?.currentBindingId ?? '')?.sessionId).toBe('session-source')
  })

  it('refuses a source waiting on an approval before cancelling anything', async () => {
    const { deps, store, created, cancelled } = setup({
      status: 'running',
      events: [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'approval/asked', { id: 'a1', toolName: 'bash' }),
      ],
    })
    await seedTask(store)
    const outcome = await handoffTask(deps, request)

    expect(outcome.succeeded).toBe(false)
    expect(outcome.reached).toBe('stopping')
    expect(outcome.reason).toMatch(/unresolved interaction \(waiting_approval\)/)
    expect(created()).toBe(0)
    expect(cancelled).toEqual([])
  })

  it('treats a resolved question as no unresolved interaction', async () => {
    const { deps, store, created } = setup({
      events: [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' }),
        event(2, 'tool/result', { callId: 'c1' }),
        event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ],
    })
    await seedTask(store)
    const outcome = await handoffTask(deps, request)

    expect(outcome.succeeded).toBe(true)
    expect(created()).toBe(1)
    expect(outcome.preconditions.checked).toContain('the source has no unresolved interaction')
  })

  it('stops rather than migrating a source whose cancelled turn does not confirm its end', async () => {
    const { deps, store, created, cancelled } = setup({
      status: 'running',
      events: [
        ...finishedTurn,
        event(3, 'turn/start', { turn: 2 }),
      ],
    })
    await seedTask(store)
    const outcome = await handoffTask(deps, { ...request, stopTimeoutMs: 20 })

    expect(outcome.succeeded).toBe(false)
    expect(outcome.reason).toMatch(/did not confirm its end/)
    expect(outcome.reason).toMatch(/20 ms/)
    expect(created()).toBe(0)
    expect(cancelled).toHaveLength(1)
  })

  it('uses the configured confirmation ceiling when the request omits stopTimeoutMs', async () => {
    const { deps, store } = setup({
      status: 'running',
      events: [
        ...finishedTurn,
        event(3, 'turn/start', { turn: 2 }),
      ],
    })
    await seedTask(store)
    const outcome = await handoffTask({ ...deps, interruptConfirmLimitMs: 1000 }, request)
    expect(outcome.succeeded).toBe(false)
    expect(outcome.reason).toMatch(/1000 ms/)
  })

  it('migrates after the cancelled turn reports its end, not after whenIdle', async () => {
    const { deps, store } = setup({
      status: 'running',
      events: [
        ...finishedTurn,
        event(3, 'turn/start', { turn: 2 }),
      ],
      onCancel: (events) => {
        events.push(event(4, 'turn/end', { turn: 2, reason: { kind: 'cancelled' } }))
      },
    })
    await seedTask(store)
    const outcome = await handoffTask(deps, request)
    expect(outcome.succeeded).toBe(true)
    expect(outcome.preconditions.checked.join(' ')).toMatch(/source turn 2 reported its end/)
  })

  it('stops when a new turn starts after the cancelled one ended', async () => {
    const { deps, store, created } = setup({
      status: 'running',
      events: [
        ...finishedTurn,
        event(3, 'turn/start', { turn: 2 }),
      ],
      onCancel: (events) => {
        events.push(event(4, 'turn/end', { turn: 2, reason: { kind: 'cancelled' } }))
        events.push(event(5, 'turn/start', { turn: 3 }))
      },
    })
    await seedTask(store)
    const outcome = await handoffTask(deps, request)
    expect(outcome.succeeded).toBe(false)
    expect(outcome.reason).toMatch(/new turn 3 started/)
    expect(created()).toBe(0)
  })

  it('refuses a target already occupied by another managed task', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    await store.createTask({
      taskId: 'task-2', title: 'other', pinned: false, archived: false,
      controllerSessionId: 'session-controller', requestedBy: 'user', contextMode: 'brief',
      preparation: 'ready', preparationPhase: 'ready', currentBindingId: 'binding-2',
      createdAt: 'now', updatedAt: 'now',
    })
    await store.putBinding({
      bindingId: 'binding-2', taskId: 'task-2', hostId: 'local', sessionId: 'session-other',
      version: 1, cwd: 'D:\\target', createdAt: 'now',
    })
    const outcome = await handoffTask(deps, request)

    expect(outcome.succeeded).toBe(false)
    expect(outcome.reached).toBe('preparing_target')
    expect(outcome.reason).toMatch(/already used by task task-2/)
  })

  it('refuses a target directory that does not exist, and does not create it', async () => {
    const { deps, store } = setup({ directories: new Map() })
    await seedTask(store)
    const outcome = await handoffTask(deps, request)

    expect(outcome.succeeded).toBe(false)
    expect(outcome.reason).toMatch(/does not exist; the conductor does not create it/)
  })

  it('leaves the binding pointing at the source when the successor cannot be created', async () => {
    const { deps, store } = setup({ failCreate: true })
    await seedTask(store)
    const outcome = await handoffTask(deps, request)

    expect(outcome.succeeded).toBe(false)
    expect(outcome.reached).toBe('creating_successor')
    expect(outcome.reason).toMatch(/still points at session-source/)
    const task = store.getTask('task-1')
    expect(store.getBinding(task?.currentBindingId ?? '')?.sessionId).toBe('session-source')
    expect(store.getBinding('binding-1')?.retiredAt).toBeUndefined()
  })

  it('refuses to migrate the session carrying the caller', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    await store.putAccess({
      taskId: 'task-1',
      ownerSessionId: 'session-source',
      ownerEpoch: 1,
      observerSessionIds: [],
      updatedAt: 'now',
    })
    const outcome = await handoffTask(deps, { ...request, callerSessionId: 'session-source' })

    expect(outcome.succeeded).toBe(false)
    expect(outcome.reason).toMatch(/cannot migrate the execution context/)
  })

  it('refuses a late handoff from a session that no longer holds write control', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    const outcome = await handoffTask(deps, { ...request, callerSessionId: 'session-previous' })

    expect(outcome.succeeded).toBe(false)
    expect(outcome.reason).toMatch(/NOT_CONTROLLER/)
    expect(store.getBinding(store.getTask('task-1')?.currentBindingId ?? '')?.sessionId).toBe('session-source')
  })

  it('names every precondition as checked or not checked', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    const outcome = await handoffTask(deps, request)

    expect(outcome.preconditions.checked).toContain('the source has no active turn')
    expect(outcome.preconditions.checked).toContain('the source has no unresolved interaction')
    expect(outcome.preconditions.checked).toContain('the source history is frozen through event seq 2')
    expect(outcome.preconditions.checked.join(' ')).toMatch(/terminals, external processes and credentials were not migrated/)
    expect(outcome.preconditions.checked).toContain('the target directory exists')
    // The gaps are named, not omitted: nothing in this build inspects git.
    expect(outcome.preconditions.unchecked.join(' ')).toMatch(/git baseline/)
    expect(outcome.preconditions.unchecked.join(' ')).toMatch(/source file state at freeze/)
    const text = describePreconditions(outcome.preconditions)
    expect(text).toMatch(/NOT verified \(this is a gap, not a pass\)/)
  })

  it('reports the source as unchecked when the Host exposes no inbox', async () => {
    const made = setup()
    await seedTask(made.store)
    const deps: HandoffDeps = {
      ...made.deps,
      agents: {
        create: made.deps.agents.create,
        get: () => ({
          id: 'session-source' as SessionId,
          status: 'idle' as const,
          session: { seq: 2, events: finishedTurn, header: {} },
          followup: () => {}, steer: () => {}, cancel: () => {},
          whenIdle: async () => {},
        }),
      },
    }
    const outcome = await handoffTask(deps, request)
    expect(outcome.succeeded).toBe(true)
    expect(outcome.preconditions.unchecked.join(' ')).toMatch(/unconsumed queued input/)
  })

  it('refuses missing source event history without substituting whenIdle for an exact stop', async () => {
    const made = setup()
    await seedTask(made.store)
    const deps: HandoffDeps = {
      ...made.deps,
      agents: {
        create: made.deps.agents.create,
        get: () => ({
          id: 'session-source' as SessionId,
          status: 'idle' as const,
          inbox: { hasPending: false },
          followup: () => {}, steer: () => {}, cancel: () => {},
          whenIdle: async () => {},
        }),
      },
    }
    const outcome = await handoffTask(deps, request)
    expect(outcome.succeeded).toBe(false)
    expect(outcome.reason).toContain('HOST_CAPABILITY_REQUIRED')
    expect(outcome.preconditions.unchecked.join(' ')).toMatch(/unresolved interaction/)
    expect(outcome.preconditions.unchecked.join(' ')).toMatch(/completed history/)
    expect(outcome.frozenThroughSeq).toBeUndefined()
    expect(made.store.getBinding(made.store.getTask('task-1')?.currentBindingId ?? '')?.frozenThroughSeq)
      .toBeUndefined()
  })

  it('refuses a dirty git target rather than automatically cleaning it', async () => {
    const { deps, store, created } = setup()
    await seedTask(store)
    const git: GitRunner = {
      async run(args) {
        const key = args.join(' ')
        if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
        if (key === 'rev-parse HEAD') return { ok: true, stdout: 'aaaa1111\n', stderr: '', code: 0 }
        if (key === 'status --porcelain') return { ok: true, stdout: ' M src/a.ts\n', stderr: '', code: 0 }
        return { ok: false, stdout: '', stderr: `no answer for ${key}`, code: 128 }
      },
    }
    const outcome = await handoffTask({ ...deps, git }, request)
    expect(outcome.succeeded).toBe(false)
    expect(outcome.reached).toBe('preparing_target')
    expect(outcome.reason).toMatch(/existing local modifications/)
    expect(outcome.reason).toMatch(/src\/a\.ts/)
    expect(outcome.reason).toMatch(/rather than automatically cleaning/)
    expect(created()).toBe(0)
    expect(store.getBinding(store.getTask('task-1')?.currentBindingId ?? '')?.sessionId).toBe('session-source')
  })

  it('records a clean git target as a checked baseline rather than leaving it as a gap', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    const git: GitRunner = {
      async run(args) {
        const key = args.join(' ')
        if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
        if (key === 'rev-parse HEAD') return { ok: true, stdout: 'aaaa1111bbbb2222\n', stderr: '', code: 0 }
        if (key === 'status --porcelain') return { ok: true, stdout: '', stderr: '', code: 0 }
        return { ok: false, stdout: '', stderr: `no answer for ${key}`, code: 128 }
      },
    }
    const outcome = await handoffTask({ ...deps, git }, request)
    expect(outcome.succeeded).toBe(true)
    expect(outcome.preconditions.checked.join(' ')).toMatch(/clean at aaaa1111bbbb2222/)
    expect(outcome.preconditions.unchecked.join(' ')).not.toMatch(/git baseline/)
    expect(outcome.preconditions.unchecked.join(' ')).toMatch(/source file state at freeze \(no recorded working directory\)/)
  })

  it('treats a non-git target as checked with no baseline to refuse, not as a silent pass of a repo', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    const git: GitRunner = {
      async run(): Promise<GitResult> {
        return { ok: false, stdout: '', stderr: 'not a git repository', code: 128 }
      },
    }
    const outcome = await handoffTask({ ...deps, git }, request)
    expect(outcome.succeeded).toBe(true)
    expect(outcome.preconditions.checked.join(' ')).toMatch(/not a git working tree/)
    expect(outcome.preconditions.unchecked.join(' ')).not.toMatch(/git baseline/)
  })

  it('stops when git is mounted but status cannot be read, rather than inventing a clean tree', async () => {
    const { deps, store, created } = setup()
    await seedTask(store)
    const git: GitRunner = {
      async run(args) {
        const key = args.join(' ')
        if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
        if (key === 'rev-parse HEAD') return { ok: true, stdout: 'aaaa1111\n', stderr: '', code: 0 }
        if (key === 'status --porcelain') return { ok: false, stdout: '', stderr: 'index.lock', code: 128 }
        return { ok: false, stdout: '', stderr: `no answer for ${key}`, code: 128 }
      },
    }
    const outcome = await handoffTask({ ...deps, git }, request)
    expect(outcome.succeeded).toBe(false)
    expect(outcome.reason).toMatch(/could not be read/)
    expect(outcome.reason).toMatch(/index\.lock/)
    expect(created()).toBe(0)
  })

  it('freezes a dirty source working tree as a fact rather than refusing the move', async () => {
    const { deps, store } = setup()
    await seedTask(store, { cwd: 'D:\\source' })
    const git: GitRunner = {
      async run(args, cwd) {
        const key = args.join(' ')
        const at = String(cwd)
        if (at === 'D:\\source') {
          if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
          if (key === 'rev-parse HEAD') return { ok: true, stdout: 'sourcehead99\n', stderr: '', code: 0 }
          if (key === 'status --porcelain') return { ok: true, stdout: ' M src/old.ts\n', stderr: '', code: 0 }
        }
        if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
        if (key === 'rev-parse HEAD') return { ok: true, stdout: 'targethead88\n', stderr: '', code: 0 }
        if (key === 'status --porcelain') return { ok: true, stdout: '', stderr: '', code: 0 }
        return { ok: false, stdout: '', stderr: `no answer for ${key}`, code: 128 }
      },
    }
    const outcome = await handoffTask({ ...deps, git }, request)
    expect(outcome.succeeded).toBe(true)
    expect(outcome.preconditions.checked.join(' ')).toMatch(/source file state is frozen dirty at sourcehead99 \(src\/old\.ts\); nothing was cleaned/)
    expect(outcome.preconditions.checked.join(' ')).toMatch(/target git working tree is clean at targethead88/)
    expect(store.getBinding(store.getTask('task-1')?.currentBindingId ?? '')?.sessionId).not.toBe('session-source')
  })

  it('records a clean source working tree as the frozen file state', async () => {
    const { deps, store } = setup()
    await seedTask(store, { cwd: 'D:\\source' })
    const git: GitRunner = {
      async run(args, cwd) {
        const key = args.join(' ')
        const at = String(cwd)
        if (at === 'D:\\source') {
          if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
          if (key === 'rev-parse HEAD') return { ok: true, stdout: 'sourceclean11\n', stderr: '', code: 0 }
          if (key === 'status --porcelain') return { ok: true, stdout: '', stderr: '', code: 0 }
        }
        if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
        if (key === 'rev-parse HEAD') return { ok: true, stdout: 'targetclean22\n', stderr: '', code: 0 }
        if (key === 'status --porcelain') return { ok: true, stdout: '', stderr: '', code: 0 }
        return { ok: false, stdout: '', stderr: `no answer for ${key}`, code: 128 }
      },
    }
    const outcome = await handoffTask({ ...deps, git }, request)
    expect(outcome.succeeded).toBe(true)
    expect(outcome.preconditions.checked.join(' ')).toMatch(/source file state is frozen clean at sourceclean11/)
    expect(outcome.preconditions.checked.join(' ')).toMatch(/target git working tree is clean at targetclean22/)
  })

  it('after a move, writes that name the retired binding fail and unpinned writes go to the successor', async () => {
    const { deps, store, delivered, live } = setup()
    await seedTask(store)
    const outcome = await handoffTask(deps, request)
    expect(outcome.succeeded).toBe(true)
    expect(outcome.successorSessionId).toBeDefined()

    const coordinator = new Coordinator({
      agents: {
        create: async (options: { sessionId: SessionId }) => deps.agents.create(options),
        get: (id: SessionId) => deps.agents.get(id),
        list: () => [...live.values()],
      },
      store,
      createMessage: (text: string) => ({ id: `msg-${text}`, text }),
      newTaskId: () => 'task-unused',
      newSessionId: deps.newSessionId,
      newBindingId: deps.newBindingId,
      now: deps.now,
      defaultCwd: () => 'D:\\work',
      sleep: async () => {},
      pollMs: 0,
    } as unknown as CoordinatorDeps)

    const unpinned = await coordinator.send({
      operationId: 'send-after',
      taskId: 'task-1',
      text: 'continue here',
      mode: 'steer',
      callerSessionId: 'session-controller',
    })
    expect(unpinned.delivery).toBe('accepted')
    expect(delivered.filter(entry => entry.kind === 'steer')).toEqual([
      { sessionId: outcome.successorSessionId, kind: 'steer' },
    ])

    await expect(coordinator.send({
      operationId: 'send-stale',
      taskId: 'task-1',
      text: 'this was for the old session',
      mode: 'steer',
      callerSessionId: 'session-controller',
      expectedBindingVersion: 1,
    })).rejects.toMatchObject({ code: 'STALE_BINDING' })
    expect(delivered.filter(entry => entry.kind === 'steer')).toHaveLength(1)
  })

  it('refuses a second move that still names the retired binding version (PRD §三.3 预期绑定)', async () => {
    const { deps, store } = setup({
      directories: new Map<string, true>([['D:\\target', true], ['D:\\target-2', true]]),
    })
    await seedTask(store)
    const first = await handoffTask(deps, request)
    expect(first.succeeded).toBe(true)
    const createdAfterFirst = store.getBinding(store.getTask('task-1')?.currentBindingId ?? '')?.version
    expect(createdAfterFirst).toBe(2)

    const late = await handoffTask(deps, {
      ...request,
      operationId: 'op-2',
      targetPath: 'D:\\target-2',
      expectedBindingVersion: 1,
    })
    expect(late.succeeded).toBe(false)
    expect(late.reached).toBe('stopping')
    expect(late.reason).toMatch(/STALE_BINDING/)
    expect(store.getBinding(store.getTask('task-1')?.currentBindingId ?? '')?.sessionId)
      .toBe(first.successorSessionId)
  })

  it('refuses a move that names a retired control epoch', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    const late = await handoffTask(deps, { ...request, expectedOwnerEpoch: 9 })
    expect(late.succeeded).toBe(false)
    expect(late.reason).toMatch(/STALE_OWNER_EPOCH/)
    expect(store.getBinding(store.getTask('task-1')?.currentBindingId ?? '')?.sessionId).toBe('session-source')
  })

  it('accepts a move that pins the current binding version', async () => {
    const { deps, store } = setup()
    await seedTask(store)
    const outcome = await handoffTask(deps, { ...request, expectedBindingVersion: 1, expectedOwnerEpoch: 0 })
    expect(outcome.succeeded).toBe(true)
  })
})
