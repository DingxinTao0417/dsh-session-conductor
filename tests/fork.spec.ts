import { describe, expect, it } from 'vitest'
import { computeForkCut } from '../src/service/fork.ts'
import { describeForkOrigin, forkOriginFieldsOf, forkOriginOf } from '../src/domain/fork-origin.ts'
import { Coordinator, type CoordinatorDeps } from '../src/service/coordinator.ts'
import { forkTool, type ConductorToolContext } from '../src/tools.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Build a Host-shaped session event. */
function event(seq: number, type: string, data: unknown = {}): SessionEventLike {
  return { type, seq, time: seq, data }
}

const start = (seq: number, turn: number) => event(seq, 'turn/start', { turn })
const end = (seq: number, turn: number, kind = 'completed') => event(seq, 'turn/end', { turn, reason: { kind } })

/** One finished turn plus the opening of a second, unfinished one. */
const oneAndAHalfTurns = [
  start(0, 1),
  event(1, 'user/message', { content: [{ type: 'text', text: 'do it' }] }),
  end(2, 1),
  start(3, 2),
  event(4, 'user/message', { content: [{ type: 'text', text: 'still going' }] }),
]

describe('fork origin display (PRD §二.2.2)', () => {
  it('names the source task, source session and cutoff', () => {
    const origin = forkOriginOf({
      sourceTaskId: 'task-src',
      sourceSessionId: 'session-src',
      cutoffSeq: 2,
    })
    expect(origin).toEqual({
      sourceTaskId: 'task-src',
      sourceSessionId: 'session-src',
      cutoffSeq: 2,
    })
    expect(describeForkOrigin(origin!)).toBe(
      'forked from task task-src (session session-src) through event seq 2',
    )
    expect(forkOriginFieldsOf(origin)).toEqual({
      sourceTaskId: 'task-src',
      sourceSessionId: 'session-src',
      cutoffSeq: 2,
    })
  })

  it('omits an unrecorded origin rather than inventing empty ids', () => {
    expect(forkOriginOf(undefined)).toBeUndefined()
    expect(forkOriginFieldsOf(undefined)).toEqual({})
  })
})

describe('fork cut (PRD §二.2.2)', () => {
  it('copies only the completed prefix, never the in-flight turn', () => {
    const cut = computeForkCut(oneAndAHalfTurns)
    expect('error' in cut).toBe(false)
    if ('error' in cut) return
    // Stops before the second turn starts, so the unfinished turn is excluded.
    expect(cut.seedLength).toBe(3)
    expect(cut.boundarySeq).toBe(2)
  })

  it('anchors on the requested point when one is given', () => {
    const events = [
      start(0, 1), end(1, 1),
      start(2, 2), end(3, 2),
      start(4, 3), end(5, 3),
    ]
    const cut = computeForkCut(events, 2)
    expect('error' in cut).toBe(false)
    if ('error' in cut) return
    // The first turn end at or after event 2 is the one at seq 3.
    expect(cut.boundarySeq).toBe(3)
    expect(cut.seedLength).toBe(4)
  })

  it('uses the last completed turn when the requested point is past the end', () => {
    const cut = computeForkCut(oneAndAHalfTurns, 99)
    expect('error' in cut).toBe(false)
    if ('error' in cut) return
    expect(cut.boundarySeq).toBe(2)
  })

  it('refuses when the requested point sits inside an unfinished turn', () => {
    const cut = computeForkCut(oneAndAHalfTurns, 4)
    expect(cut).toEqual({
      error: expect.stringContaining('has not completed the turn containing event 4') as unknown as string,
    })
  })

  it('refuses a session with no completed turn', () => {
    const cut = computeForkCut([start(0, 1), event(1, 'user/message', {})])
    expect('error' in cut).toBe(true)
    if (!('error' in cut)) return
    expect(cut.error).toMatch(/no completed turn/)
  })

  it('refuses an empty session', () => {
    expect('error' in computeForkCut([])).toBe(true)
  })

  it('produces a seed that is a whole number of turns', () => {
    const cut = computeForkCut(oneAndAHalfTurns)
    if ('error' in cut) throw new Error('unexpected refusal')
    const seed = oneAndAHalfTurns.slice(0, cut.seedLength)
    // Balanced: the same number of turn starts and turn ends, so the Host's
    // seed validation cannot reject it for an open turn.
    const starts = seed.filter(e => e.type === 'turn/start').length
    const ends = seed.filter(e => e.type === 'turn/end').length
    expect(starts).toBe(ends)
  })

  it('does not copy inbox splices, pending approvals or background commands that sit after the completed turn', () => {
    const events = [
      start(0, 1),
      event(1, 'user/message', { content: [{ type: 'text', text: 'do it' }] }),
      end(2, 1),
      event(3, 'agent/inbox/spliced', { queued: 1 }),
      event(4, 'approval/asked', { id: 'a1', toolName: 'bash' }),
      event(5, 'command/run', { command: 'sleep 30' }),
      start(6, 2),
    ]
    const cut = computeForkCut(events)
    expect('error' in cut).toBe(false)
    if ('error' in cut) return
    expect(cut.boundarySeq).toBe(2)
    expect(cut.seedLength).toBe(3)
    const seed = events.slice(0, cut.seedLength)
    expect(seed.map(entry => entry.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
  })
})

describe('fork task (PRD §一.2, §二.2.2)', () => {
  /** A coordinator whose source session carries one completed turn. */
  function setup(over: { managedTargetLimit?: number } = {}) {
    const tables = createInMemoryTables()
    let tick = Date.parse('2026-09-13T00:00:00.000Z')
    const store = new ConductorStore(tables, () => new Date((tick += 1000)).toISOString())
    let seq = 0
    const created: { opts: unknown; calls: string[] }[] = []
    const sessions = new Map<string, { header: unknown; events: SessionEventLike[]; seq: number }>()
    const live = new Map<string, {
      id: SessionId
      status: 'idle' | 'running'
      session: { header: unknown; events: SessionEventLike[]; seq: number }
      inbox: { nextTurn: { id: string; text: string }[]; nextStep: { id: string; text: string }[]; hasPending: boolean }
      followup: () => void
      steer: () => void
      cancel: () => void
    }>()

    const deps: CoordinatorDeps = {
      agents: {
        async create(opts) {
          const record = { opts, calls: [] as string[] }
          created.push(record)
          const session = { header: { id: opts.sessionId }, events: [] as SessionEventLike[], seq: -1 }
          sessions.set(String(opts.sessionId), session)
          const nextTurn: { id: string; text: string }[] = []
          const nextStep: { id: string; text: string }[] = []
          const agent = {
            id: opts.sessionId as SessionId,
            status: 'idle' as 'idle' | 'running',
            session,
            inbox: {
              get nextTurn() { return nextTurn },
              get nextStep() { return nextStep },
              get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 },
            },
            followup: () => { record.calls.push('followup') },
            steer: () => { record.calls.push('steer') },
            cancel: () => {},
          }
          live.set(String(opts.sessionId), agent)
          return { agent, dispose: async () => {} }
        },
        get: (id: SessionId) => {
          const session = sessions.get(String(id))
          if (session === undefined) return undefined
          const agent = live.get(String(id))
          if (agent === undefined) return undefined
          agent.session = session
          return agent
        },
        list: () => [...live.values()],
      },
      store,
      createMessage: (text, source) => ({ id: `msg-${String(++seq)}`, text, source }),
      newTaskId: () => `task-${String(++seq)}`,
      newSessionId: () => `session-${String(++seq)}`,
      newBindingId: () => `binding-${String(++seq)}`,
      now: () => new Date((tick += 1000)).toISOString(),
      defaultCwd: () => 'D:\\work',
      presets: {
        presetOf: () => 'standard',
        mount: async () => {},
      },
      ...over.managedTargetLimit === undefined ? {} : { managedTargetLimit: over.managedTargetLimit },
    }
    return { coordinator: new Coordinator(deps), store, created, sessions, deps, live }
  }

  /** Create a source task whose live session has one completed turn. */
  async function withSource(made: ReturnType<typeof setup>, events: SessionEventLike[] = oneAndAHalfTurns) {
    const source = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'source',
    })
    made.sessions.set(source.sessionId ?? '', {
      header: { id: source.sessionId, cwd: 'D:\\work' },
      events,
      seq: events.length - 1,
    })
    return source
  }

  it('creates a new task with its own session and copies only completed history', async () => {
    const made = setup()
    const source = await withSource(made)
    const forked = await made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId, title: 'continuation',
    })

    expect(forked.preparation).toBe('ready')
    expect(forked.taskId).not.toBe(source.taskId)
    expect(forked.sessionId).not.toBe(source.sessionId)

    const childTask = made.store.getTask(forked.taskId)
    expect(childTask?.contextMode).toBe('fork')
    expect(childTask?.sourceTaskId).toBe(source.taskId)

    const options = made.created.at(-1)?.opts as {
      seed?: unknown[]
      meta?: { parentSession?: string; seedLength?: number; agentPreset?: string; cwd?: string }
    }
    expect(options.seed).toHaveLength(3)
    expect(options.meta?.parentSession).toBe(source.sessionId)
    expect(options.meta?.seedLength).toBe(3)
    expect(options.meta?.agentPreset).toBe('standard')
    expect(options.meta?.cwd).toBe('D:\\work')
  })

  it('leaves the fork idle when no instruction is given', async () => {
    const made = setup()
    const source = await withSource(made)
    const forked = await made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })
    expect(forked.preparationPhase).toBe('ready')
    expect(made.created.at(-1)?.calls).toEqual([])
  })

  it('delivers the instruction after the fork is ready', async () => {
    const made = setup()
    const source = await withSource(made)
    const forked = await made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId, instruction: 'continue please',
    })
    expect(forked.preparationPhase).toBe('initial_message_accepted')
    expect(made.created.at(-1)?.calls).toEqual(['followup'])
    expect(made.store.getOperation('fork-1')?.delivery).toBe('accepted')
  })

  it('gives the fork its own control record rather than inheriting the source', async () => {
    const made = setup()
    const source = await withSource(made)
    const forked = await made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })
    const childAccess = made.store.getAccess(forked.taskId)
    expect(childAccess?.ownerEpoch).toBe(0)
    expect(childAccess?.ownerSessionId).toBe('controller')
    // The source keeps its own record, untouched.
    expect(made.store.getAccess(source.taskId)?.ownerEpoch).toBe(0)
    expect(made.store.getAccess(source.taskId)?.detachedAt).toBeUndefined()
  })

  it('does not copy the source inbox onto the child (T04)', async () => {
    const made = setup()
    const source = await withSource(made)
    const sourceAgent = made.live.get(source.sessionId ?? '')
    sourceAgent?.inbox.nextTurn.push({ id: 'q-1', text: 'queued, do not copy' })
    const forked = await made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })
    expect(sourceAgent?.inbox.nextTurn).toEqual([{ id: 'q-1', text: 'queued, do not copy' }])
    expect(made.live.get(forked.sessionId ?? '')?.inbox.nextTurn).toEqual([])
    const seed = (made.created.at(-1)?.opts as { seed?: { type?: string }[] } | undefined)?.seed ?? []
    expect(seed.map(entry => entry.type)).not.toContain('agent/inbox/spliced')
  })

  it('does not inherit the source task\'s schedules (PRD §二.2.2)', async () => {
    const made = setup()
    const source = await withSource(made)
    await made.store.putSchedule({
      scheduleId: 'sched-source',
      title: 'keep checking',
      kind: 'once',
      timezone: 'UTC',
      nextAt: '2026-09-13T00:00:01.000Z',
      action: 'inspect',
      status: 'active',
      authorizedBy: 'controller',
      targetTaskId: source.taskId,
      runs: [],
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    })
    const forked = await made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })
    expect(made.store.listSchedules({ targetTaskId: source.taskId })).toHaveLength(1)
    expect(made.store.listSchedules({ targetTaskId: forked.taskId })).toHaveLength(0)
  })

  it('records the source and the cutoff', async () => {
    const made = setup()
    const source = await withSource(made)
    const forked = await made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })
    const snapshot = made.store.getContext(`fork-${forked.taskId}`)
    expect(snapshot?.sourceTaskId).toBe(source.taskId)
    expect(snapshot?.sourceSessionId).toBe(source.sessionId)
    expect(snapshot?.cutoffSeq).toBe(2)
    expect(snapshot?.deliveredToTaskId).toBe(forked.taskId)
    expect(forked.sourceTaskId).toBe(source.taskId)
    expect(forked.sourceSessionId).toBe(source.sessionId)
    expect(forked.cutoffSeq).toBe(2)
  })

  it('conductor_fork names the origin on the result and in the summary', async () => {
    const tool = forkTool({
      coordinator: () => ({
        forkTask: async () => ({
          taskId: 'child',
          operationId: 'fork-1',
          preparation: 'ready',
          preparationPhase: 'ready',
          sessionId: 'session-child',
          replayed: false,
          sourceTaskId: 'task-src',
          sourceSessionId: 'session-src',
          cutoffSeq: 2,
        }),
      }),
    } as unknown as ConductorToolContext)
    const out = await tool.execute(
      { sourceTaskId: 'task-src' },
      { agent: { id: 'controller' }, callId: 'fork-1' } as never,
    ) as {
      sourceTaskId?: string
      sourceSessionId?: string
      cutoffSeq?: number
      summary: string
    }
    expect(out.sourceTaskId).toBe('task-src')
    expect(out.sourceSessionId).toBe('session-src')
    expect(out.cutoffSeq).toBe(2)
    expect(out.summary).toContain(
      'forked from task task-src (session session-src) through event seq 2',
    )
  })

  it('refuses a source whose session is not live', async () => {
    const made = setup()
    const source = await withSource(made)
    made.sessions.clear()
    await expect(made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' })
  })

  it('refuses a source with nothing finished to fork', async () => {
    const made = setup()
    const source = await withSource(made, [start(0, 1)])
    await expect(made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })).rejects.toMatchObject({ code: 'FORK_UNAVAILABLE' })
  })

  it('replays a retried fork instead of forking twice', async () => {
    const made = setup()
    const source = await withSource(made)
    const first = await made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })
    const second = await made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })
    expect(second.replayed).toBe(true)
    expect(second.taskId).toBe(first.taskId)
    expect(second.sourceTaskId).toBe(first.sourceTaskId)
    expect(second.sourceSessionId).toBe(first.sourceSessionId)
    expect(second.cutoffSeq).toBe(first.cutoffSeq)
    expect(made.created).toHaveLength(2) // the source, then the fork — no third
  })

  it('refuses a fork from a session that does not hold write control of the source', async () => {
    const made = setup()
    const source = await withSource(made)
    await expect(made.coordinator.forkTask({
      operationId: 'fork-spy', callerSessionId: 'someone-else', sourceTaskId: source.taskId,
    })).rejects.toMatchObject({ code: 'NOT_CONTROLLER' })
    expect(made.store.getOperation('fork-spy')).toBeUndefined()
    expect(made.created).toHaveLength(1)
  })

  it('refuses a fork that names a retired control epoch on the source', async () => {
    const made = setup()
    const source = await withSource(made)
    const access = made.store.getAccess(source.taskId)
    await made.store.putAccess({ ...access!, ownerEpoch: (access?.ownerEpoch ?? 0) + 1 })
    await expect(made.coordinator.forkTask({
      operationId: 'fork-stale-epoch', callerSessionId: 'controller', sourceTaskId: source.taskId,
      expectedOwnerEpoch: access?.ownerEpoch ?? 0,
    })).rejects.toMatchObject({ code: 'STALE_OWNER_EPOCH' })
    expect(made.store.getOperation('fork-stale-epoch')).toBeUndefined()
    expect(made.created).toHaveLength(1)
  })

  it('refuses a fork that names a retired binding version on the source', async () => {
    const made = setup()
    const source = await withSource(made)
    const task = made.store.getTask(source.taskId)
    const binding = made.store.getBinding(task?.currentBindingId ?? '')
    await made.store.putBinding({ ...binding!, version: (binding?.version ?? 1) + 1 })
    await expect(made.coordinator.forkTask({
      operationId: 'fork-stale-binding', callerSessionId: 'controller', sourceTaskId: source.taskId,
      expectedBindingVersion: binding?.version ?? 1,
    })).rejects.toMatchObject({ code: 'STALE_BINDING' })
    expect(made.store.getOperation('fork-stale-binding')).toBeUndefined()
    expect(made.created).toHaveLength(1)
  })

  it('forks when the caller still holds the pinned epoch and binding', async () => {
    const made = setup()
    const source = await withSource(made)
    const access = made.store.getAccess(source.taskId)
    const binding = made.store.getBinding(made.store.getTask(source.taskId)?.currentBindingId ?? '')
    const forked = await made.coordinator.forkTask({
      operationId: 'fork-pinned', callerSessionId: 'controller', sourceTaskId: source.taskId,
      ...access?.ownerEpoch === undefined ? {} : { expectedOwnerEpoch: access.ownerEpoch },
      ...binding?.version === undefined ? {} : { expectedBindingVersion: binding.version },
    })
    expect(forked.preparation).toBe('ready')
    expect(forked.sourceTaskId).toBe(source.taskId)
  })

  it('leaves the source unchanged when the fork fails', async () => {
    const made = setup()
    const source = await withSource(made)
    // The source session is readable, but creating the child fails.
    const failing = new Coordinator({
      ...made.deps,
      agents: {
        ...made.deps.agents,
        create: async () => { throw new Error('session id already in use') },
      },
    })
    const result = await failing.forkTask({
      operationId: 'fork-2', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })
    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/already in use/)
    // The source task and its binding survive untouched.
    expect(made.store.getTask(source.taskId)?.preparation).toBe('ready')
    expect(made.store.getBinding(made.store.getTask(source.taskId)?.currentBindingId ?? '')).toBeDefined()
  })

  it('refuses a fork that would exceed the controller\'s managed-target ceiling', async () => {
    const made = setup({ managedTargetLimit: 1 })
    const source = await withSource(made)
    await expect(made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })).rejects.toMatchObject({ code: 'MANAGED_TARGET_LIMIT' })
  })
})
