import { describe, expect, it } from 'vitest'
import { ConductorError, Coordinator, type CoordinatorDeps } from '../src/service/coordinator.ts'
import { noticeSource, relaySource } from '../src/service/host.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * A fake live agent that records what the coordinator asked it to do.
 *
 * `events` and the inbox lists are mutable so a test can drive the exact
 * situations PRD §二.6 is about — a turn ending before the stop arrives, a queue
 * filling up mid-flight — instead of only the happy path.
 */
function fakeAgent(id: string) {
  const calls: { kind: string; message: unknown }[] = []
  const events: SessionEventLike[] = []
  const nextTurn: { id: string; text: string }[] = []
  const nextStep: { id: string; text: string }[] = []
  const agent = {
    id: id as SessionId,
    status: 'idle' as 'idle' | 'running',
    calls,
    session: {
      events,
      get seq() { return events.reduce((max, event) => Math.max(max, event.seq), 0) },
    },
    inbox: {
      get nextTurn() { return nextTurn },
      get nextStep() { return nextStep },
      get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 },
      remove: (messageId: string) => {
        const index = nextTurn.findIndex(entry => entry.id === messageId)
        if (index === -1) return false
        nextTurn.splice(index, 1)
        calls.push({ kind: 'remove', message: messageId })
        return true
      },
      replace: (messageId: string, message: { id: string; text: string }) => {
        const index = nextTurn.findIndex(entry => entry.id === messageId)
        if (index === -1) return false
        nextTurn[index] = message
        calls.push({ kind: 'replace', message: messageId })
        return true
      },
    },
    followup(message: unknown) { calls.push({ kind: 'followup', message }) },
    steer(message: unknown) { calls.push({ kind: 'steer', message }) },
    cancel(cause: unknown, options?: { keepInbox?: boolean }) {
      calls.push({ kind: 'cancel', message: { cause, options } })
    },
  }
  return agent
}

/** Open a turn in a fake agent's log. */
function openTurn(agent: ReturnType<typeof fakeAgent>, turn: number, seq = 1): void {
  agent.status = 'running'
  agent.session.events.push({ type: 'turn/start', seq, data: { turn } })
}

/** Close a turn in a fake agent's log. */
function closeTurn(agent: ReturnType<typeof fakeAgent>, turn: number, seq = 2): void {
  agent.status = 'idle'
  agent.session.events.push({
    type: 'turn/end', seq, data: { turn, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
}

/** Build coordinator dependencies over fresh in-memory tables and fake agents. */
function makeCoordinator(options: {
  failCreate?: Error
  presets?: CoordinatorDeps['presets']
  managedTargetLimit?: number
  targetTurnConcurrency?: number
  interruptConfirmLimitMs?: number
} = {}) {
  const tables = createInMemoryTables()
  let tick = Date.parse('2026-09-13T00:00:00.000Z')
  const now = () => new Date((tick += 1000)).toISOString()
  const store = new ConductorStore(tables, now)

  const created: ReturnType<typeof fakeAgent>[] = []
  const live = new Map<string, ReturnType<typeof fakeAgent>>()
  const createdOptions: unknown[] = []
  let nextTask = 0
  let nextSession = 0

  const agents = {
    async create(opts: { sessionId: SessionId; setup?: (agentCtx: unknown) => Promise<void> }) {
      if (options.failCreate !== undefined) throw options.failCreate
      createdOptions.push(opts)
      // The Host calls `setup` with the new agent's scoped context, which is where a preset is composed.
      // The fixture used to ignore it, so a preset's mount was invisible to every test — including the
      // fork path, which has been passing a `setup` since it was written.
      if (typeof opts.setup === 'function') await opts.setup({ sessionId: opts.sessionId })
      const agent = fakeAgent(String(opts.sessionId))
      created.push(agent)
      live.set(String(opts.sessionId), agent)
      return { agent, dispose: async () => {} }
    },
    get: (id: SessionId) => live.get(String(id)),
    list: () => [...live.values()],
  }

  const deps: CoordinatorDeps = {
    agents,
    store,
    createMessage: (text, source) => ({ id: `msg-${String(++nextTask)}`, text, source }),
    newTaskId: () => `task-${String(++nextTask)}`,
    newSessionId: () => `session-${String(++nextSession)}`,
    newBindingId: () => `binding-${String(nextSession)}`,
    now,
    defaultCwd: () => 'D:\\work',
    // The stop sequence must be driven, not waited on. An immediate sleeper plus
    // the tick-per-call clock above makes "the turn never confirms" terminate in
    // a bounded number of iterations instead of in real time.
    sleep: async () => {},
    pollMs: 0,
    ...options.presets === undefined ? {} : { presets: options.presets },
    ...options.managedTargetLimit === undefined ? {} : { managedTargetLimit: options.managedTargetLimit },
    ...options.targetTurnConcurrency === undefined ? {} : { targetTurnConcurrency: options.targetTurnConcurrency },
    ...options.interruptConfirmLimitMs === undefined
      ? {}
      : { interruptConfirmLimitMs: options.interruptConfirmLimitMs },
  }
  return { coordinator: new Coordinator(deps), store, tables, created, createdOptions, live }
}

/**
 * Create a ready task and return the coordinator plus its identity.
 *
 * Module scope because the send, stop and queue suites all build on the same
 * fixture; each gets its own in-memory tables, so the fixed operation id cannot
 * collide between them.
 */
async function ready() {
  const made = makeCoordinator()
  const created = await made.coordinator.createTask({
    operationId: 'create-1', controllerSessionId: 'controller', title: 't',
  })
  return { ...made, taskId: created.taskId }
}

describe('create (PRD §二.2.1)', () => {
  it('reaches ready and records the binding, control and session', async () => {
    const { coordinator, store, created } = makeCoordinator()
    const result = await coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Design the interface',
    })

    expect(result.preparation).toBe('ready')
    expect(result.preparationPhase).toBe('ready')
    expect(result.replayed).toBe(false)
    expect(created).toHaveLength(1)

    const task = store.getTask(result.taskId)
    expect(task?.preparation).toBe('ready')
    expect(task?.currentBindingId).toBeDefined()
    const binding = store.getBinding(task?.currentBindingId ?? '')
    expect(binding?.sessionId).toBe(result.sessionId)
    expect(binding?.cwd).toBe('D:\\work')
    expect(store.getAccess(result.taskId)?.ownerSessionId).toBe('controller')
  })

  it('dispatches the first instruction and reports the phase that follows', async () => {
    const { coordinator, store, created } = makeCoordinator()
    const result = await coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Implement',
      instruction: 'Build the front end.',
    })

    expect(result.preparationPhase).toBe('initial_message_accepted')
    expect(created[0]?.calls.map(call => call.kind)).toEqual(['followup'])

    const operation = store.getOperation('op-1')
    expect(operation?.delivery).toBe('accepted')
    expect(operation?.phase).toBe('initial_message_accepted')
    expect(operation?.taskId).toBe(result.taskId)
  })

  it('carries the plugin relay source, never the user source, on a forwarded instruction', async () => {
    const { coordinator, created } = makeCoordinator()
    await coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 't', instruction: 'go',
    })
    const message = created[0]?.calls[0]?.message as { source?: unknown }
    expect(message.source).toEqual(relaySource())
  })

  it('replays a retried creation instead of creating a second session', async () => {
    const { coordinator, created } = makeCoordinator()
    const first = await coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 't',
    })
    const second = await coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 't',
    })

    expect(second.replayed).toBe(true)
    expect(second.taskId).toBe(first.taskId)
    expect(second.sessionId).toBe(first.sessionId)
    expect(created).toHaveLength(1)
  })

  it('refuses one operation id reused with different parameters', async () => {
    const { coordinator } = makeCoordinator()
    await coordinator.createTask({ operationId: 'op-1', controllerSessionId: 'controller', title: 'a' })
    await expect(coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'b',
    })).rejects.toThrow(ConductorError)
  })

  it('keeps the task and reports the phase and reason when preparation fails', async () => {
    const { coordinator, store } = makeCoordinator({ failCreate: new Error('cwd does not exist') })
    const result = await coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 't', instruction: 'go',
    })

    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/cwd does not exist/)
    expect(result.preparationPhase).toBe('creating_session')
    // A failed preparation is not a deleted task: the record survives with the
    // reason, which is what an operator needs to act on.
    const task = store.getTask(result.taskId)
    expect(task?.preparation).toBe('failed')
    expect(task?.failureReason).toMatch(/cwd does not exist/)
    expect(store.getOperation('op-1')?.delivery).toBe('failed')
    expect(store.getOperation('op-1')?.phase).toBe('preparation_failed')
  })
})

describe('managed target limit (PRD §四.7)', () => {
  it('refuses a second create when the controller is at the ceiling', async () => {
    const { coordinator } = makeCoordinator({ managedTargetLimit: 1 })
    const first = await coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'one',
    })
    await expect(coordinator.createTask({
      operationId: 'op-2', controllerSessionId: 'controller', title: 'two',
    })).rejects.toMatchObject({ code: 'MANAGED_TARGET_LIMIT' })
    // A retry of the first create is not a second target.
    const replayed = await coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'one',
    })
    expect(replayed.replayed).toBe(true)
    expect(replayed.taskId).toBe(first.taskId)
    // A different controller still has a slot.
    const other = await coordinator.createTask({
      operationId: 'op-3', controllerSessionId: 'other', title: 'other',
    })
    expect(other.preparation).toBe('ready')
  })

  it('frees a slot when management is released', async () => {
    const { coordinator } = makeCoordinator({ managedTargetLimit: 1 })
    const first = await coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'one',
    })
    await coordinator.detachTask(first.taskId, 'controller')
    const second = await coordinator.createTask({
      operationId: 'op-2', controllerSessionId: 'controller', title: 'two',
    })
    expect(second.preparation).toBe('ready')
    expect(second.taskId).not.toBe(first.taskId)
  })
})

describe('the Host preset (PRD §二.3)', () => {
  /** A preset port that records what was mounted and answers with a fixed roster. */
  function presetPort(over: {
    readonly known?: readonly string[]
    readonly broken?: readonly string[]
  } = {}) {
    const known = over.known ?? ['default', 'fast']
    const broken = over.broken ?? []
    const mounted: (string | undefined)[] = []
    const checked: string[] = []
    return {
      mounted,
      checked,
      port: {
        presetOf: () => undefined,
        mount: async (_agentCtx: unknown, presetId: string | undefined) => { mounted.push(presetId) },
        checkPreset: async (presetId: string) => {
          checked.push(presetId)
          if (broken.includes(presetId)) return { ok: false as const, reason: `preset "${presetId}" is present but cannot be assembled: it has no agent.cordis.yml` }
          if (!known.includes(presetId)) {
            return { ok: false as const, reason: `preset "${presetId}" could not be resolved: no preset root offers it; available: ${known.join(', ')}` }
          }
          return { ok: true as const, id: presetId }
        },
        defaultPresetId: () => 'default',
      },
    }
  }

  it('composes the session with the named preset and records it on the task', async () => {
    const fixture = presetPort()
    const { coordinator, store, createdOptions } = makeCoordinator({ presets: fixture.port })
    const result = await coordinator.createTask({
      operationId: 'preset-1', controllerSessionId: 'controller', title: 't', preset: 'fast',
    })

    expect(result.preparation).toBe('ready')
    // Mounted through the Host's own service, and named in the session's own metadata — the two places a
    // preset takes effect.
    expect(fixture.mounted).toEqual(['fast'])
    expect(JSON.stringify(createdOptions[0])).toMatch(/"agentPreset":"fast"/)
    // Recorded on the task, so a reader can see the composition it actually got.
    expect(store.getTask(result.taskId)?.preset).toBe('fast')
  })

  it('refuses a preset the roster does not offer, and creates nothing', async () => {
    const fixture = presetPort({ known: ['default', 'fast'] })
    const { coordinator, store, created } = makeCoordinator({ presets: fixture.port })
    // A bad preset is a **preparation failure**, like any other: the task record survives with the reason
    // (that is what an operator acts on) and nothing was composed.
    const result = await coordinator.createTask({
      operationId: 'preset-2', controllerSessionId: 'controller', title: 't', preset: 'nope',
    })
    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/no preset root offers it/)
    expect(result.failureReason).toMatch(/available: default, fast/)

    // Nothing was composed and no session was created: the check runs before the session does.
    expect(fixture.mounted).toEqual([])
    expect(created).toEqual([])
    // The record survives, with no preset, because it has no session to have composed.
    expect(store.getTask(result.taskId)?.preset).toBeUndefined()
  })

  it('refuses a preset the roster lists as broken rather than composing a session that cannot assemble', async () => {
    const fixture = presetPort({ known: ['default', 'broken-one'], broken: ['broken-one'] })
    const { coordinator } = makeCoordinator({ presets: fixture.port })
    const result = await coordinator.createTask({
      operationId: 'preset-3', controllerSessionId: 'controller', title: 't', preset: 'broken-one',
    })
    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/cannot be assembled/)
    expect(fixture.mounted).toEqual([])
  })

  it('refuses a named preset when the composition has no roster to check it against', async () => {
    // The alternative would be composing the session without the preset that was asked for and recording a
    // task whose configuration is not the requested one — the claim the specification forbids.
    const { coordinator } = makeCoordinator({})
    const result = await coordinator.createTask({
      operationId: 'preset-4', controllerSessionId: 'controller', title: 't', preset: 'fast',
    })
    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/mounts no preset roster/)
  })

  it('freezes the Host default preset for an ordinary task', async () => {
    const fixture = presetPort()
    const { coordinator, store, createdOptions } = makeCoordinator({ presets: fixture.port })
    const result = await coordinator.createTask({
      operationId: 'preset-5', controllerSessionId: 'controller', title: 't',
    })
    expect(result.preparation).toBe('ready')
    expect(fixture.mounted).toEqual(['default'])
    expect(fixture.checked).toEqual(['default'])
    expect(JSON.stringify(createdOptions[0])).toMatch(/agentPreset/)
    expect(store.getTask(result.taskId)?.preset).toBe('default')
  })
})

describe('send (PRD §二.6, §四.2)', () => {

  it('steers a ready task and reports the message as accepted, not as finished', async () => {
    const { coordinator, store, created, taskId } = await ready()
    const result = await coordinator.send({
      operationId: 'send-1', taskId, text: 'Use the v2 endpoint.', mode: 'steer', callerSessionId: 'controller',
    })

    expect(result.delivery).toBe('accepted')
    expect(result.messageId).toBeDefined()
    expect(created[0]?.calls.map(call => call.kind)).toEqual(['steer'])

    // Acceptance is the Host taking the message. The operation carries no claim
    // that a turn started, was consumed, or ended.
    const operation = store.getOperation('send-1')
    expect(operation?.delivery).toBe('accepted')
    expect(operation?.phase).toBe('host_accepted')
  })

  it('queues a follow-up turn for the queue mode', async () => {
    const { coordinator, created, taskId } = await ready()
    await coordinator.send({
      operationId: 'send-1', taskId, text: 'Afterwards, run the tests.', mode: 'queue', callerSessionId: 'controller',
    })
    expect(created[0]?.calls.map(call => call.kind)).toEqual(['followup'])
  })
})

describe('exact stop and interrupt-and-send (PRD §二.6, T09, T10)', () => {
  it('stops the expected turn and confirms its end', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    openTurn(agent, 3, 1)
    const pending = coordinator.stop({
      operationId: 'stop-1', taskId, callerSessionId: 'controller',
      expectedTurn: 3, expectedStartSeq: 1, confirmLimitMs: 30_000,
    })
    // The cancel is issued synchronously, before any waiting begins.
    expect(agent.calls.map(call => call.kind)).toContain('cancel')
    // The Host then reports the end.
    closeTurn(agent, 3, 2)

    const result = await pending
    expect(result.outcome).toBe('confirmed')
    expect(result.turn).toBe(3)
    expect(result.turnOutcome).toBe('interrupted')
    expect(result.sent).toBe(false)
    expect(result.keptText).toBe(false)
  })

  it('does not mis-stop a new turn when the expected turn ended first (T09)', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    // The caller observed turn 1; it finished and turn 2 began before the stop.
    openTurn(agent, 1, 1)
    closeTurn(agent, 1, 2)
    openTurn(agent, 2, 3)

    await expect(coordinator.stop({
      operationId: 'stop-1', taskId, callerSessionId: 'controller',
      expectedTurn: 1, expectedStartSeq: 1, confirmLimitMs: 30_000,
    })).rejects.toMatchObject({ code: 'STALE_TURN' })

    // Nothing was cancelled: turn 2 is still running.
    expect(agent.calls.map(call => call.kind)).not.toContain('cancel')
    expect(agent.status).toBe('running')
  })

  it('reports no active turn instead of cancelling when the session is idle', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')

    const result = await coordinator.stop({
      operationId: 'stop-1', taskId, callerSessionId: 'controller', confirmLimitMs: 30_000,
    })
    expect(result.outcome).toBe('no_active_turn')
    expect(result.sent).toBe(false)
    expect(agent.calls.map(call => call.kind)).not.toContain('cancel')
  })

  it('reports an unconfirmed stop and does not send when the turn never ends', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    openTurn(agent, 4, 1)

    const result = await coordinator.stop({
      operationId: 'stop-1', taskId, callerSessionId: 'controller',
      expectedTurn: 4, expectedStartSeq: 1, text: 'do this next', confirmLimitMs: 1000,
    })
    expect(result.outcome).toBe('unconfirmed')
    expect(result.sent).toBe(false)
    expect(result.keptText).toBe(true)
    // The exact wording of PRD §二.6 step 7, because the caller's next decision
    // depends on knowing the instruction was not delivered.
    expect(result.reason).toContain('stop not confirmed, instruction not sent')
    expect(agent.calls.map(call => call.kind)).not.toContain('steer')
  })

  it('uses the configured interrupt confirmation ceiling when a send omits one (PRD §四.7)', async () => {
    const made = makeCoordinator({ interruptConfirmLimitMs: 1_000 })
    const created = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 't',
    })
    const agent = made.created[0]
    if (agent === undefined) throw new Error('no agent')
    openTurn(agent, 1, 1)

    await expect(made.coordinator.send({
      operationId: 'int-1',
      taskId: created.taskId,
      text: 'after the stop',
      mode: 'interrupt_and_send',
      callerSessionId: 'controller',
      expectedTurn: 1,
      expectedStartSeq: 1,
    })).rejects.toMatchObject({
      code: 'STOP_NOT_CONFIRMED',
      message: expect.stringContaining('1000 ms'),
    })
    expect(agent.calls.map(call => call.kind)).not.toContain('steer')
  })

  it('falls back to the published 30s confirmation ceiling when none is configured', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    openTurn(agent, 5, 1)

    await expect(coordinator.send({
      operationId: 'int-2',
      taskId,
      text: 'after the stop',
      mode: 'interrupt_and_send',
      callerSessionId: 'controller',
      expectedTurn: 5,
      expectedStartSeq: 1,
    })).rejects.toMatchObject({
      code: 'STOP_NOT_CONFIRMED',
      message: expect.stringContaining('30000 ms'),
    })
  })

  it('keeps the text and cancels nothing when the queue is not empty', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    openTurn(agent, 1, 1)
    agent.inbox.nextTurn.push({ id: 'msg-waiting', text: 'queued earlier' })

    const result = await coordinator.stop({
      operationId: 'stop-1', taskId, callerSessionId: 'controller',
      expectedTurn: 1, expectedStartSeq: 1, text: 'do this', confirmLimitMs: 30_000,
    })
    expect(result.outcome).toBe('kept')
    expect(result.keptText).toBe(true)
    expect(result.reason).toMatch(/QUEUE_CONFLICT|unconsumed queued message/)
    // PRD §二.6 step 2: the refusal happens *before* the cancel.
    expect(agent.calls.map(call => call.kind)).not.toContain('cancel')
  })

  it('keeps the text when a new turn starts while the stop is in flight (T10)', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    openTurn(agent, 1, 1)

    // The Host reports the cancelled turn's end and immediately opens another
    // one. The stop must not deliver into a turn the caller never asked to stop.
    const cancel = agent.cancel
    agent.cancel = (cause: unknown, options?: { keepInbox?: boolean }) => {
      cancel(cause, options)
      agent.session.events.push({
        type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
      })
      agent.session.events.push({ type: 'turn/start', seq: 3, data: { turn: 2 } })
      agent.status = 'running'
    }

    const result = await coordinator.stop({
      operationId: 'stop-1', taskId, callerSessionId: 'controller',
      expectedTurn: 1, expectedStartSeq: 1, text: 'do this', confirmLimitMs: 30_000,
    })
    expect(result.outcome).toBe('kept')
    expect(result.sent).toBe(false)
    expect(result.keptText).toBe(true)
    expect(result.reason).toMatch(/turn 2 started/)
    expect(agent.calls.map(call => call.kind)).not.toContain('steer')
  })

  it('keeps the text when the queue grows while the stop is in flight (T10)', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    openTurn(agent, 1, 1)

    const cancel = agent.cancel
    agent.cancel = (cause: unknown, options?: { keepInbox?: boolean }) => {
      cancel(cause, options)
      agent.session.events.push({
        type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
      })
      agent.status = 'idle'
      agent.inbox.nextTurn.push({ id: 'msg-arrived', text: 'new work arrived mid-stop' })
    }

    const result = await coordinator.stop({
      operationId: 'stop-1', taskId, callerSessionId: 'controller',
      expectedTurn: 1, expectedStartSeq: 1, text: 'do this', confirmLimitMs: 30_000,
    })
    expect(result.outcome).toBe('kept')
    expect(result.keptText).toBe(true)
    expect(result.reason).toMatch(/queue grew from 0 to 1/)
    expect(agent.calls.map(call => call.kind)).not.toContain('steer')
  })

  it('stops and then sends when the turn ends and nothing else moved', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    openTurn(agent, 5, 1)

    // Close the turn on the first poll, which is the ordinary case.
    const pending = coordinator.stop({
      operationId: 'stop-2', taskId, callerSessionId: 'controller',
      expectedTurn: 5, expectedStartSeq: 1, text: 'carry on with the new plan', confirmLimitMs: 30_000,
    })
    closeTurn(agent, 5, 2)

    const result = await pending
    expect(result.outcome).toBe('confirmed')
    expect(result.sent).toBe(true)
    expect(result.keptText).toBe(false)
    expect(agent.calls.map(call => call.kind)).toContain('steer')
  })

  it('sends directly when an interrupt-and-send finds no active turn', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')

    const result = await coordinator.stop({
      operationId: 'stop-3', taskId, callerSessionId: 'controller',
      text: 'start this', confirmLimitMs: 30_000,
    })
    expect(result.sent).toBe(true)
    expect(agent.calls.map(call => call.kind)).toContain('steer')
  })

  it('keeps the caller’s pending steering by asking the Host not to clear the inbox', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    openTurn(agent, 1, 1)
    agent.inbox.nextStep.push({ id: 'msg-steer', text: 'a note for the next step' })

    const pending = coordinator.stop({
      operationId: 'stop-4', taskId, callerSessionId: 'controller',
      expectedTurn: 1, expectedStartSeq: 1, confirmLimitMs: 30_000,
    })
    closeTurn(agent, 1, 2)
    await pending

    const cancel = agent.calls.find(call => call.kind === 'cancel')
    expect(cancel?.message).toMatchObject({ options: { keepInbox: true } })
    // The conductor did not author that text, so a stop must not destroy it.
    expect(agent.inbox.nextStep.map(entry => entry.id)).toEqual(['msg-steer'])
  })

  it('requests a budget cancel without waiting for the turn to end', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    openTurn(agent, 4, 1)
    const result = coordinator.requestTurnCancel({
      taskId,
      callerSessionId: 'controller',
      cause: 'conductor budget deadline',
    })
    expect(result).not.toBeInstanceOf(Promise)
    expect(result.outcome).toBe('requested')
    expect(result.turn).toBe(4)
    expect(agent.calls.map(call => call.kind)).toEqual(['cancel'])
    expect(agent.calls[0]?.message).toMatchObject({
      cause: { kind: 'hook', reason: 'conductor budget deadline' },
      options: { keepInbox: true },
    })
    // The session is still running: the method did not wait for a turn end.
    expect(agent.status).toBe('running')
  })

  it('reports no active turn for a budget cancel against an idle session', async () => {
    const { coordinator, created, taskId } = await ready()
    const agent = created[0]
    if (agent === undefined) throw new Error('no agent')
    const result = coordinator.requestTurnCancel({ taskId, callerSessionId: 'controller' })
    expect(result.outcome).toBe('no_active_turn')
    expect(agent.calls.map(call => call.kind)).not.toContain('cancel')
  })
})

describe('queue management (PRD §二.6, §三.3 `queue`)', () => {
  /** A ready task whose agent holds the given unconsumed input. */
  async function queued(queue: { id: string; text: string }[], steering: { id: string; text: string }[] = []) {
    const made = await ready()
    const agent = made.created[0]
    if (agent === undefined) throw new Error('no agent')
    agent.inbox.nextTurn.push(...queue)
    agent.inbox.nextStep.push(...steering)
    return { ...made, agent }
  }

  it('lists the unconsumed input, naming which list each message is in', async () => {
    const { coordinator, taskId } = await queued([{ id: 'q-1', text: 'later' }], [{ id: 's-1', text: 'sooner' }])
    const result = await coordinator.queue({
      operationId: 'q-list', taskId, callerSessionId: 'controller', action: 'list',
    })
    expect(result.messages).toEqual([
      { messageId: 'q-1', text: 'later', list: 'queue' },
      { messageId: 's-1', text: 'sooner', list: 'steering' },
    ])
    expect(result.reason).toMatch(/1 queued and 1 steering/)
  })

  it('withdraws an unconsumed message and records the withdrawal', async () => {
    const { coordinator, taskId, store } = await queued([{ id: 'q-1', text: 'later' }])
    const result = await coordinator.queue({
      operationId: 'q-withdraw', taskId, callerSessionId: 'controller', action: 'withdraw', messageId: 'q-1',
    })
    expect(result.changed).toEqual({ messageId: 'q-1', action: 'withdrawn' })
    expect(result.messages).toEqual([])
    // The record is what keeps a recovery pass from re-delivering it.
    expect(store.getOperation('q-withdraw')?.delivery).toBe('accepted')
  })

  it('reports a message that had already been consumed rather than pretending to withdraw it', async () => {
    const { coordinator, taskId, store } = await queued([])
    const result = await coordinator.queue({
      operationId: 'q-withdraw', taskId, callerSessionId: 'controller', action: 'withdraw', messageId: 'q-gone',
    })
    expect(result.changed?.action).toBe('already_consumed')
    expect(store.getOperation('q-withdraw')?.delivery).toBe('failed')
  })

  it('edits an unconsumed message in place', async () => {
    const { coordinator, taskId, agent } = await queued([{ id: 'q-1', text: 'old' }])
    const result = await coordinator.queue({
      operationId: 'q-edit', taskId, callerSessionId: 'controller', action: 'edit',
      messageId: 'q-1', text: 'new text',
    })
    expect(result.changed?.action).toBe('edited')
    expect(agent.calls.map(call => call.kind)).toContain('replace')
  })

  it('refuses a queue change from a session that does not hold write control', async () => {
    const { coordinator, taskId } = await queued([{ id: 'q-1', text: 'later' }])
    await expect(coordinator.queue({
      operationId: 'q-withdraw', taskId, callerSessionId: 'someone-else', action: 'withdraw', messageId: 'q-1',
    })).rejects.toMatchObject({ code: 'NOT_CONTROLLER' })
  })

  it('replays a repeated withdrawal instead of removing twice', async () => {
    const { coordinator, taskId } = await queued([{ id: 'q-1', text: 'later' }, { id: 'q-2', text: 'and this' }])
    await coordinator.queue({
      operationId: 'q-withdraw', taskId, callerSessionId: 'controller', action: 'withdraw', messageId: 'q-1',
    })
    const again = await coordinator.queue({
      operationId: 'q-withdraw', taskId, callerSessionId: 'controller', action: 'withdraw', messageId: 'q-1',
    })
    expect(again.changed?.action).toBe('already_consumed')
    expect(again.reason).toMatch(/already recorded/)
  })

  it('refuses a queue write that names a retired binding version', async () => {
    const { coordinator, store, taskId } = await queued([{ id: 'q-1', text: 'later' }])
    const task = store.getTask(taskId)
    const binding = store.getBinding(task?.currentBindingId ?? '')
    await store.putBinding({ ...binding!, bindingId: 'binding-2', version: 2, sessionId: 'session-9' })
    await expect(coordinator.queue({
      operationId: 'q-stale', taskId, callerSessionId: 'controller', action: 'withdraw',
      messageId: 'q-1', expectedBindingVersion: 1,
    })).rejects.toMatchObject({ code: 'STALE_BINDING' })
  })

  it('refuses a queue write that names a retired control epoch', async () => {
    const { coordinator, store, taskId } = await queued([{ id: 'q-1', text: 'later' }])
    const access = store.getAccess(taskId)
    await store.putAccess({ ...access!, ownerEpoch: (access?.ownerEpoch ?? 0) + 1 })
    await expect(coordinator.queue({
      operationId: 'q-stale-epoch', taskId, callerSessionId: 'controller', action: 'withdraw',
      messageId: 'q-1', expectedOwnerEpoch: access?.ownerEpoch ?? 0,
    })).rejects.toMatchObject({ code: 'STALE_OWNER_EPOCH' })
  })
})

describe('send refusals and idempotency (PRD §二.6, §四.2)', () => {
  it('refuses a send before the environment is ready', async () => {
    const { coordinator, store } = makeCoordinator()
    const created = await coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 't',
    })
    await store.updateTask(created.taskId, current => ({ ...current, preparation: 'preparing', preparationPhase: 'creating_session' }))
    await expect(coordinator.send({
      operationId: 'send-1', taskId: created.taskId, text: 'x', mode: 'steer', callerSessionId: 'controller',
    })).rejects.toMatchObject({ code: 'NOT_READY' })
  })

  it('refuses a caller that does not hold write control', async () => {
    const { coordinator, taskId } = await ready()
    await expect(coordinator.send({
      operationId: 'send-1', taskId, text: 'x', mode: 'steer', callerSessionId: 'someone-else',
    })).rejects.toMatchObject({ code: 'NOT_CONTROLLER' })
  })

  it('refuses a caller holding a stale control epoch', async () => {
    const { coordinator, store, taskId } = await ready()
    await store.putAccess({ taskId, ownerSessionId: 'controller', ownerEpoch: 1, observerSessionIds: [], updatedAt: 'now' })
    await expect(coordinator.send({
      operationId: 'send-1', taskId, text: 'x', mode: 'steer', callerSessionId: 'controller', expectedOwnerEpoch: 0,
    })).rejects.toMatchObject({ code: 'STALE_OWNER_EPOCH' })
  })

  it('refuses a caller addressing a stale binding version', async () => {
    const { coordinator, store, taskId } = await ready()
    const task = store.getTask(taskId)
    const binding = store.getBinding(task?.currentBindingId ?? '')
    await store.putBinding({ ...binding!, bindingId: 'binding-2', version: 2, sessionId: 'session-9' })
    await expect(coordinator.send({
      operationId: 'send-1', taskId, text: 'x', mode: 'steer', callerSessionId: 'controller', expectedBindingVersion: 1,
    })).rejects.toMatchObject({ code: 'STALE_BINDING' })
  })

  it('reports a target that is no longer live rather than failing silently', async () => {
    const { coordinator, live, taskId } = await ready()
    live.clear()
    await expect(coordinator.send({
      operationId: 'send-1', taskId, text: 'x', mode: 'steer', callerSessionId: 'controller',
    })).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' })
  })

  it('refuses the previous controller once control has been transferred', async () => {
    // PRD §二.10.1: "旧控制者迟到请求被拒绝". The epoch is what enforces it — the
    // transfer increments it, so the outgoing controller's next request fails the
    // check that every write path already performs. No transfer-specific rule is
    // needed, which is exactly why the freeze cannot be forgotten on a new path.
    const { coordinator, store, taskId } = await ready()
    const access = store.getAccess(taskId)
    await store.putAccess({ ...access!, ownerSessionId: 'controller-b', ownerEpoch: (access?.ownerEpoch ?? 0) + 1 })

    await expect(coordinator.send({
      operationId: 'send-1', taskId, text: 'x', mode: 'steer', callerSessionId: 'controller',
    })).rejects.toMatchObject({ code: 'NOT_CONTROLLER' })
    // With the epoch it believed it held, the refusal names the epoch specifically.
    await expect(coordinator.send({
      operationId: 'send-2', taskId, text: 'x', mode: 'steer', callerSessionId: 'controller-b',
      expectedOwnerEpoch: access?.ownerEpoch ?? 0,
    })).rejects.toMatchObject({ code: 'STALE_OWNER_EPOCH' })

    // The new controller can proceed.
    await expect(coordinator.send({
      operationId: 'send-3', taskId, text: 'x', mode: 'steer', callerSessionId: 'controller-b',
      expectedOwnerEpoch: (access?.ownerEpoch ?? 0) + 1,
    })).resolves.toMatchObject({ delivery: 'accepted' })
  })

  it('stops the previous controller from stopping a turn after a transfer', async () => {
    // The same epoch check guards the stop path, so the freeze is not a property of
    // one entry point.
    const { coordinator, store, taskId } = await ready()
    const access = store.getAccess(taskId)
    await store.putAccess({ ...access!, ownerSessionId: 'controller-b', ownerEpoch: (access?.ownerEpoch ?? 0) + 1 })
    await expect(coordinator.stop({
      operationId: 'stop-1', taskId, callerSessionId: 'controller', confirmLimitMs: 1000,
    })).rejects.toMatchObject({ code: 'NOT_CONTROLLER' })
  })

  it('replays an identical send without dispatching it twice', async () => {
    const { coordinator, created, taskId } = await ready()
    const first = await coordinator.send({
      operationId: 'send-1', taskId, text: 'go', mode: 'steer', callerSessionId: 'controller',
    })
    const second = await coordinator.send({
      operationId: 'send-1', taskId, text: 'go', mode: 'steer', callerSessionId: 'controller',
    })
    expect(first.delivery).toBe('accepted')
    expect(second.delivery).toBe('replayed')
    expect(second.messageId).toBe(first.messageId)
    expect(created[0]?.calls).toHaveLength(1)
  })

  it('treats the same text under a new operation id as a second, independent send', async () => {
    const { coordinator, created, taskId } = await ready()
    await coordinator.send({ operationId: 'send-1', taskId, text: 'go', mode: 'steer', callerSessionId: 'controller' })
    await coordinator.send({ operationId: 'send-2', taskId, text: 'go', mode: 'steer', callerSessionId: 'controller' })
    expect(created[0]?.calls).toHaveLength(2)
  })
})

describe('host-wide turn concurrency (PRD §四.4)', () => {
  /** Mark a fake agent as a running conductor-relay turn. */
  function occupyRelay(agent: ReturnType<typeof fakeAgent>): void {
    agent.status = 'running'
    agent.session.events.push(
      { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'busy' }], source: relaySource() } },
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
    )
  }

  it('keeps a send pending at the limit and dispatches it when a slot frees', async () => {
    const made = makeCoordinator({ targetTurnConcurrency: 1 })
    const first = await made.coordinator.createTask({
      operationId: 'c1', controllerSessionId: 'controller', title: 'a',
    })
    const second = await made.coordinator.createTask({
      operationId: 'c2', controllerSessionId: 'controller', title: 'b',
    })
    const busy = made.live.get(first.sessionId ?? '')
    expect(busy).toBeDefined()
    if (busy === undefined) throw new Error('no agent')
    occupyRelay(busy)
    expect(made.coordinator.occupiedSlots()).toEqual({ target: 1, notice: 0 })

    const pending = await made.coordinator.send({
      operationId: 'send-pending',
      taskId: second.taskId,
      text: 'wait your turn',
      mode: 'steer',
      callerSessionId: 'controller',
    })
    expect(pending.delivery).toBe('pending')
    expect(pending.reason).toMatch(/kept pending/)
    expect(made.store.getOperation('send-pending')?.delivery).toBe('prepared')
    expect(made.live.get(second.sessionId ?? '')?.calls).toEqual([])

    closeTurn(busy, 1, 2)
    const flushed = await made.coordinator.flushPendingDispatches()
    expect(flushed).toBe(1)
    expect(made.store.getOperation('send-pending')?.delivery).toBe('accepted')
    expect(made.live.get(second.sessionId ?? '')?.calls.map(call => call.kind)).toEqual(['steer'])
  })

  it('does not flush a pending send that pinned a binding version the handoff retired', async () => {
    const made = makeCoordinator({ targetTurnConcurrency: 1 })
    const first = await made.coordinator.createTask({
      operationId: 'c1', controllerSessionId: 'controller', title: 'a',
    })
    const second = await made.coordinator.createTask({
      operationId: 'c2', controllerSessionId: 'controller', title: 'b',
    })
    const busy = made.live.get(first.sessionId ?? '')
    expect(busy).toBeDefined()
    if (busy === undefined) throw new Error('no agent')
    occupyRelay(busy)

    const pending = await made.coordinator.send({
      operationId: 'send-pinned',
      taskId: second.taskId,
      text: 'wait your turn',
      mode: 'steer',
      callerSessionId: 'controller',
      expectedBindingVersion: 1,
    })
    expect(pending.delivery).toBe('pending')

    const task = made.store.getTask(second.taskId)
    const binding = made.store.getBinding(task?.currentBindingId ?? '')
    await made.store.putBinding({
      ...binding!,
      bindingId: 'binding-moved',
      version: 2,
      sessionId: second.sessionId ?? '',
    })

    closeTurn(busy, 1, 2)
    const flushed = await made.coordinator.flushPendingDispatches()
    expect(flushed).toBe(0)
    expect(made.store.getOperation('send-pinned')?.delivery).toBe('failed')
    expect(made.store.getOperation('send-pinned')?.phase).toMatch(/STALE_BINDING/)
    expect(made.live.get(second.sessionId ?? '')?.calls).toEqual([])
  })

  it('does not flush a pending send that pinned a control epoch a transfer retired', async () => {
    const made = makeCoordinator({ targetTurnConcurrency: 1 })
    const first = await made.coordinator.createTask({
      operationId: 'c1', controllerSessionId: 'controller', title: 'a',
    })
    const second = await made.coordinator.createTask({
      operationId: 'c2', controllerSessionId: 'controller', title: 'b',
    })
    const busy = made.live.get(first.sessionId ?? '')
    expect(busy).toBeDefined()
    if (busy === undefined) throw new Error('no agent')
    occupyRelay(busy)

    const pending = await made.coordinator.send({
      operationId: 'send-pinned-epoch',
      taskId: second.taskId,
      text: 'wait your turn',
      mode: 'steer',
      callerSessionId: 'controller',
      expectedOwnerEpoch: 0,
    })
    expect(pending.delivery).toBe('pending')

    const access = made.store.getAccess(second.taskId)
    await made.store.putAccess({
      ...access!,
      ownerSessionId: 'session-other',
      ownerEpoch: 1,
    })

    closeTurn(busy, 1, 2)
    const flushed = await made.coordinator.flushPendingDispatches()
    expect(flushed).toBe(0)
    expect(made.store.getOperation('send-pinned-epoch')?.delivery).toBe('failed')
    expect(made.store.getOperation('send-pinned-epoch')?.phase).toMatch(/STALE_OWNER_EPOCH/)
    expect(made.live.get(second.sessionId ?? '')?.calls).toEqual([])
  })

  it('dispatches a person\'s pending send before an automatic one', async () => {
    const made = makeCoordinator({ targetTurnConcurrency: 1 })
    const first = await made.coordinator.createTask({
      operationId: 'c1', controllerSessionId: 'controller', title: 'a',
    })
    const second = await made.coordinator.createTask({
      operationId: 'c2', controllerSessionId: 'controller', title: 'b',
    })
    const busy = made.live.get(first.sessionId ?? '')
    const dest = made.live.get(second.sessionId ?? '')
    if (busy === undefined || dest === undefined) throw new Error('no agent')
    occupyRelay(busy)

    await made.coordinator.send({
      operationId: 'auto-1',
      taskId: second.taskId,
      text: 'automatic',
      mode: 'steer',
      callerSessionId: 'controller',
      attribution: { kind: 'rule', ruleId: 'rule-1', sourceEventId: 'e1' },
    })
    await made.coordinator.send({
      operationId: 'user-1',
      taskId: second.taskId,
      text: 'from a person',
      mode: 'steer',
      callerSessionId: 'controller',
    })
    closeTurn(busy, 1, 2)
    const originalSteer = dest.steer.bind(dest)
    dest.steer = (message: unknown) => {
      originalSteer(message)
      occupyRelay(dest)
    }
    await made.coordinator.flushPendingDispatches()
    expect(made.store.getOperation('user-1')?.delivery).toBe('accepted')
    expect(made.store.getOperation('auto-1')?.delivery).toBe('prepared')
  })

  it('does not count a native-interface turn against the plugin quota', async () => {
    const made = makeCoordinator({ targetTurnConcurrency: 1 })
    const first = await made.coordinator.createTask({
      operationId: 'c1', controllerSessionId: 'controller', title: 'a',
    })
    const second = await made.coordinator.createTask({
      operationId: 'c2', controllerSessionId: 'controller', title: 'b',
    })
    const busy = made.live.get(first.sessionId ?? '')
    if (busy === undefined) throw new Error('no agent')
    busy.status = 'running'
    busy.session.events.push(
      { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'typed' }], source: { kind: 'user' } } },
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
    )
    const sent = await made.coordinator.send({
      operationId: 'send-1',
      taskId: second.taskId,
      text: 'plugin work',
      mode: 'steer',
      callerSessionId: 'controller',
    })
    expect(sent.delivery).toBe('accepted')
  })

  it('keeps a new task\'s first instruction pending at the limit (PRD §四.4 新任务保持待派发)', async () => {
    const made = makeCoordinator({ targetTurnConcurrency: 1 })
    const first = await made.coordinator.createTask({
      operationId: 'c1', controllerSessionId: 'controller', title: 'a',
    })
    const busy = made.live.get(first.sessionId ?? '')
    if (busy === undefined) throw new Error('no agent')
    occupyRelay(busy)

    const created = await made.coordinator.createTask({
      operationId: 'c2', controllerSessionId: 'controller', title: 'b', instruction: 'wait your turn',
    })
    expect(created.preparation).toBe('ready')
    expect(created.preparationPhase).toBe('ready')
    expect(made.store.getOperation('c2')?.delivery).toBe('prepared')
    expect(made.live.get(created.sessionId ?? '')?.calls).toEqual([])

    closeTurn(busy, 1, 2)
    const flushed = await made.coordinator.flushPendingDispatches()
    expect(flushed).toBe(1)
    expect(made.store.getOperation('c2')?.delivery).toBe('accepted')
    expect(made.store.getTask(created.taskId)?.preparationPhase).toBe('initial_message_accepted')
    expect(made.live.get(created.sessionId ?? '')?.calls.map(call => call.kind)).toEqual(['followup'])
  })
})

describe('message sources (PRD §四.2)', () => {
  it('attributes forwarded instructions to the plugin relay form', () => {
    expect(relaySource()).toEqual({ kind: 'plugin', plugin: 'dsh-session-conductor', form: 'relay' })
  })

  it('attributes a background report to the plugin notice form with its summary', () => {
    expect(noticeSource('task finished')).toEqual({
      kind: 'plugin', plugin: 'dsh-session-conductor', form: 'notice', summary: 'task finished',
    })
  })
})
