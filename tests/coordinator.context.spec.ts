/**
 * The starting context of a created task (PRD §二.2.2).
 *
 * `brief` is the **default** for a new task, and until this round the phase only recorded the mode:
 * a task's record said `brief` while its session held nothing. These tests are written around the
 * three facts that fix:
 *
 * 1. a brief is built from the **creating** session and stopped at its last completed turn;
 * 2. it reaches the target through the Host's starting-context primitive, which does **not** wake
 *    the session — so a task with a brief and no instruction is ready and idle;
 * 3. a context that could not be produced is a **refusal**, never a record claiming it was.
 */

import { describe, expect, it } from 'vitest'
import { Coordinator, ConductorError, type CoordinatorDeps } from '../src/service/coordinator.ts'
import { DEFAULT_CONTEXT_MODE } from '../src/domain/defaults.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentLike } from '../src/service/host.ts'

/** A controller session with one completed turn and one still running. */
const controllerTurns: SessionEventLike[] = [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'Make the parser strict.' }] } },
  { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 3, data: { turn: 2 } },
  { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: 'SECRET IN-FLIGHT REQUEST' }] } },
]

/** Build a coordinator whose controller session is readable, with recording fakes. */
function makeCoordinator(options: {
  callerEvents?: readonly SessionEventLike[] | undefined
  injectable?: boolean
  injectThrows?: boolean
  failCreate?: Error
} = {}) {
  const tables = createInMemoryTables()
  let tick = Date.parse('2026-09-13T00:00:00.000Z')
  const now = () => new Date((tick += 1000)).toISOString()
  const store = new ConductorStore(tables, now)
  let seq = 0
  /** Every message the coordinator handed to a target agent, in order, with its verb. */
  const calls: { sessionId: string; verb: string; text: string; source: unknown }[] = []
  const createdSessions: string[] = []
  const controllerId = 'controller'

  const messageText = (message: unknown): string => {
    const direct = (message as { text?: string } | undefined)?.text
    if (typeof direct === 'string') return direct
    const content = (message as { content?: { text?: string }[] } | undefined)?.content
    return content?.map(part => part.text ?? '').join('') ?? ''
  }
  const messageSource = (message: unknown): unknown => (message as { source?: unknown } | undefined)?.source

  const target = (id: string): AgentLike => {
    const agent: AgentLike = {
      id: id as SessionId,
      status: 'idle',
      session: { events: [], seq: -1, header: { id } },
      inbox: { hasPending: false },
      followup: (message: unknown) => { calls.push({ sessionId: id, verb: 'followup', text: messageText(message), source: messageSource(message) }) },
      steer: (message: unknown) => { calls.push({ sessionId: id, verb: 'steer', text: messageText(message), source: messageSource(message) }) },
      cancel: () => {},
    }
    if (options.injectable !== false) {
      agent.inject = (message: unknown) => {
        if (options.injectThrows === true) throw new Error('the inbox is closed')
        calls.push({ sessionId: id, verb: 'inject', text: messageText(message), source: messageSource(message) })
      }
    }
    return agent
  }

  const controller = options.callerEvents === undefined
    ? undefined
    : {
      id: controllerId as SessionId,
      status: 'idle' as const,
      session: { events: options.callerEvents, seq: (options.callerEvents.at(-1)?.seq ?? -1) },
      followup: () => {},
      steer: () => {},
      cancel: () => {},
    }

  const liveTargets = new Map<string, ReturnType<typeof target>>()

  const agents = {
    async create(opts: { sessionId: SessionId }) {
      if (options.failCreate !== undefined) throw options.failCreate
      createdSessions.push(String(opts.sessionId))
      const agent = target(String(opts.sessionId))
      liveTargets.set(String(opts.sessionId), agent)
      return { agent: agent as never, dispose: async () => {} }
    },
    get: (id: SessionId) => (String(id) === controllerId ? controller : liveTargets.get(String(id))),
    list: () => [
      ...controller === undefined ? [] : [controller],
      ...liveTargets.values(),
    ],
  }

  const deps: CoordinatorDeps = {
    agents,
    store,
    createMessage: (text, source) => ({ id: `msg-${String(++seq)}`, text, source }),
    newTaskId: () => `task-${String(++seq)}`,
    newSessionId: () => `session-${String(++seq)}`,
    newBindingId: () => `binding-${String(++seq)}`,
    now,
    defaultCwd: () => 'D:\\work',
  }
  return { coordinator: new Coordinator(deps), store, calls, createdSessions }
}

describe('starting context (PRD §二.2.2)', () => {
  it('builds a brief from the creating session by default and queues it without waking anything', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const result = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser',
    })

    expect(result.preparation, result.failureReason ?? '').toBe('ready')
    // The default mode is DEFAULT_CONTEXT_MODE (`brief`), and it is reported as actually delivered.
    expect(result.context).toEqual({
      mode: DEFAULT_CONTEXT_MODE,
      status: 'injected',
      sourceSessionId: 'controller',
      cutoffSeq: 2,
      contentVersion: 0,
      contentDigest: expect.any(String) as unknown as string,
    })
    expect(made.store.getTask(result.taskId)?.contextMode).toBe(DEFAULT_CONTEXT_MODE)

    // It reached the target through `inject`, which does not wake the driver — and the session was
    // never woken, because no instruction was given.
    const targetSession = made.createdSessions[0] as string
    expect(made.calls.map(call => `${call.sessionId}:${call.verb}`)).toEqual([`${targetSession}:inject`])

    // The brief carries the completed turn's goal, and not the in-flight request, which is not a
    // decision anyone has finished making.
    const brief = made.calls[0]?.text ?? ''
    expect(brief).toMatch(/Make the parser strict\./)
    expect(brief).not.toContain('SECRET IN-FLIGHT REQUEST')
    expect(brief).toMatch(/exact through event seq 2/)
    expect(brief).toMatch(/produced by the plugin, not sent by the user/)
  })

  it('records the brief as a context snapshot against the task and the source session', async () => {
    // §二.2.2 requires a brief to save its source session, cutoff, generation time and content
    // version, so a later reader can tell whether it still describes the work.
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const result = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser',
    })

    const records = made.store.listContextsDeliveredTo(result.taskId)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      snapshotId: `brief-${result.taskId}`,
      sourceSessionId: 'controller',
      cutoffSeq: 2,
      contentVersion: 0,
      deliveredToTaskId: result.taskId,
    })
    expect(records[0]?.contentDigest).toBe(result.context?.contentDigest)
    // The controller is not a managed task, so no task id is invented for it.
    expect(records[0]?.sourceTaskId).toBeUndefined()
  })

  it('names the calling task when the creating session is itself managed', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    // Join the controller as a managed task first, so its session has a task identity.
    const joined = await made.coordinator.attachTask({
      operationId: 'attach-1', controllerSessionId: 'controller', sessionId: 'controller', title: 'controller',
    })
    const result = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser',
    })
    expect(made.store.listContextsDeliveredTo(result.taskId)[0]?.sourceTaskId).toBe(joined.taskId)
  })

  it('queues the brief before the first instruction, so the instruction is read in that context', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    await made.coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Parser',
      instruction: 'Start with the lexer.',
    })
    expect(made.calls.map(call => call.verb)).toEqual(['inject', 'followup'])
    expect(made.calls[1]?.text).toBe('Start with the lexer.')
  })

  it('delivers an empty-but-honest brief when the source session has no completed turn', async () => {
    // A brand-new controller legitimately has nothing to carry; refusing would be worse than an
    // empty brief that says it is empty.
    const made = makeCoordinator({
      callerEvents: [{ type: 'turn/start', seq: 0, data: { turn: 1 } }],
    })
    const result = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser',
    })

    expect(result.preparation, result.failureReason ?? '').toBe('ready')
    expect(result.context?.cutoffSeq).toBe(-1)
    expect(result.context?.status).toBe('injected')
    expect(made.calls[0]?.text).toMatch(/not completed a turn yet, so this starting context is empty on purpose/)
    expect(made.calls[0]?.text).toMatch(/No human statement was found, so no goal is claimed/)
  })

  it('sends no context at all when `empty` was asked for', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const result = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser', contextMode: 'empty',
    })
    expect(result.context).toBeUndefined()
    expect(made.calls).toHaveLength(0)
    expect(made.store.getTask(result.taskId)?.context).toBeUndefined()
    expect(made.store.listContextsDeliveredTo(result.taskId)).toHaveLength(0)
    expect(made.store.getTask(result.taskId)?.contextMode).toBe('empty')
    expect(made.store.getTask(result.taskId)?.contextMode).not.toBe(DEFAULT_CONTEXT_MODE)
  })

  it('records `none` with the reason when the brief cannot be built, and still creates the task', async () => {
    // The caller session is not readable at all, so there is no history to summarise. The task is
    // still what the caller asked for, so it is created — with a record that says a brief was
    // wanted and was not delivered, and why. What must never happen is the old behaviour: a record
    // claiming `brief` with nothing behind it.
    const made = makeCoordinator()
    const result = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser',
    })

    expect(result.preparation, result.failureReason ?? '').toBe('ready')
    expect(result.context?.mode).toBe('brief')
    expect(result.context?.status).toBe('none')
    expect(result.context?.reason).toMatch(/cannot read its history/)
    expect(result.context?.reason).toMatch(/contextMode: "empty"/)
    // Nothing was queued and nothing was fabricated: no snapshot claims a brief exists.
    expect(made.calls).toHaveLength(0)
    expect(made.store.listContextsDeliveredTo(result.taskId)).toHaveLength(0)
    expect(made.store.getTask(result.taskId)?.context?.status).toBe('none')
    expect(result.sessionId).toBeDefined()
  })

  it('refuses `fork` context on create, naming the verb that does it', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const result = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser', contextMode: 'fork',
    })
    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/CONTEXT_MODE_UNSUPPORTED/)
    expect(result.failureReason).toMatch(/conductor_fork/)
    expect(made.createdSessions).toHaveLength(0)
  })

  it('reports `none` when the Host agent has no starting-context primitive', async () => {
    // A Host that cannot take model-facing context cannot deliver a brief, and the record must say
    // so. Sending it as a follow-up instead would start a turn nobody asked for and put
    // plugin-generated text in the log as if the user had written it.
    const made = makeCoordinator({ callerEvents: controllerTurns, injectable: false })
    const result = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser',
    })

    expect(result.preparation, result.failureReason ?? '').toBe('ready')
    expect(result.context?.status).toBe('none')
    expect(result.context?.reason).toMatch(/exposes no starting-context primitive/)
    expect(made.calls).toHaveLength(0)
    expect(made.store.getTask(result.taskId)?.context?.status).toBe('none')
  })

  it('records `none` with the reason when the Host refuses the brief, keeping the session it created', async () => {
    // The session exists and the task is usable; throwing away the creation because the Host
    // declined a starting context would discard work the caller asked for.
    const made = makeCoordinator({ callerEvents: controllerTurns, injectThrows: true })
    const result = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser',
    })

    expect(result.preparation, result.failureReason ?? '').toBe('ready')
    expect(result.context?.status).toBe('none')
    expect(result.context?.reason).toMatch(/the Host refused the prepared brief/)
    expect(result.context?.reason).toMatch(/inbox is closed/)
    expect(result.sessionId).toBeDefined()
    expect(made.store.getTask(result.taskId)?.context?.status).toBe('none')
    // The snapshot stays: a brief *was* built and filed, and it was the queueing that failed.
    expect(made.store.listContextsDeliveredTo(result.taskId)).toHaveLength(1)
  })

  it('reports the recorded context again when a create is replayed', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const first = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser',
    })
    const replay = await made.coordinator.createTask({
      operationId: 'op-1', controllerSessionId: 'controller', title: 'Parser',
    })
    expect(replay.replayed).toBe(true)
    expect(replay.context).toEqual(first.context)
    // A replay is not a second brief: nothing more was queued and nothing more was recorded.
    expect(made.calls).toHaveLength(1)
    expect(made.store.listContextsDeliveredTo(first.taskId)).toHaveLength(1)
  })

  it('reports a refused preparation as the typed error it is', async () => {
    // The tool layer renders `ConductorError.code`, so the code has to be the real one.
    const error = new ConductorError('CONTEXT_UNAVAILABLE', 'x')
    expect(error.code).toBe('CONTEXT_UNAVAILABLE')
    expect(error).toBeInstanceOf(Error)
  })
})
