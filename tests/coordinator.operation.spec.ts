/**
 * The `operation` family (PRD §三.3, §二.2.1).
 *
 * Preparation is asynchronous: creation hands back an operation and a task and returns. This is the
 * surface that answers "how far has it got?", "I do not want it after all" and "continue it", and
 * the rules around it are among the specification's most specific:
 *
 * - progress is read **through the operation** (§二.2.1);
 * - after a cancellation the still-undelivered first instruction must not run, and the session and
 *   directory that were already created are **kept and reported**, not rolled back;
 * - a resume continues from the phase it reached and does not create a second session or worktree.
 *
 * The cancellation window is the delicate part, so it is tested from both sides: legal before the
 * instruction is dispatched, and refused after — because at that point the message has been sent and
 * cancelling would leave the caller believing it had not been.
 */

import { describe, expect, it } from 'vitest'
import { Coordinator, ConductorError, type CoordinatorDeps } from '../src/service/coordinator.ts'
import type { GitResult, GitRunner } from '../src/service/git.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** A git runner that answers the read-only queries planning makes and can fail `worktree add`. */
function scriptedGit(options: { worktreeAdd?: GitResult } = {}) {
  const run: GitRunner['run'] = async (args) => {
    const key = args.join(' ')
    if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
    if (key === 'rev-parse HEAD') return { ok: true, stdout: 'b'.repeat(40) + '\n', stderr: '', code: 0 }
    if (key === 'rev-parse --abbrev-ref HEAD') return { ok: true, stdout: 'main\n', stderr: '', code: 0 }
    if (key === 'status --porcelain') return { ok: true, stdout: '', stderr: '', code: 0 }
    if (args[0] === 'worktree') return options.worktreeAdd ?? { ok: true, stdout: '', stderr: '', code: 0 }
    return { ok: true, stdout: '', stderr: '', code: 0 }
  }
  return { run }
}

/** A controller session with one completed turn, so a `brief` can be built. */
const controllerTurns: SessionEventLike[] = [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'Ship the parser.' }] } },
  { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

/** Build a coordinator whose controller is readable and whose store is in memory. */
function makeCoordinator(options: {
  git?: GitRunner
  callerEvents?: readonly SessionEventLike[] | undefined
} = {}) {
  const tables = createInMemoryTables()
  let tick = Date.parse('2026-09-13T00:00:00.000Z')
  const now = () => new Date((tick += 1000)).toISOString()
  const store = new ConductorStore(tables, now)
  let seq = 0
  const sessions = new Map<string, { header: Record<string, unknown>; events: SessionEventLike[]; seq: number }>()
  const calls: { sessionId: string; verb: string; text: string }[] = []

  const agentFor = (id: string) => ({
    id: id as SessionId,
    status: 'idle' as const,
    session: sessions.get(id),
    inbox: { nextTurn: [], nextStep: [], hasPending: false, remove: () => false, replace: () => false },
    followup: (message: unknown) => { calls.push({ sessionId: id, verb: 'followup', text: (message as { text?: string }).text ?? '' }) },
    steer: () => {},
    inject: (message: unknown) => { calls.push({ sessionId: id, verb: 'inject', text: (message as { text?: string }).text ?? '' }) },
    cancel: () => {},
  })

  const controller = options.callerEvents === undefined
    ? undefined
    : {
      id: 'controller' as SessionId,
      status: 'idle' as const,
      session: { events: options.callerEvents, seq: (options.callerEvents.at(-1)?.seq ?? -1) },
      followup: () => {},
      steer: () => {},
      cancel: () => {},
    }

  const agents = {
    async create(opts: { sessionId: SessionId; seed?: SessionEventLike[]; meta?: Record<string, unknown> }) {
      sessions.set(String(opts.sessionId), { header: { id: opts.sessionId, ...opts.meta }, events: opts.seed ?? [], seq: -1 })
      return { agent: agentFor(String(opts.sessionId)) as never, dispose: async () => {} }
    },
    get: (id: SessionId) => (String(id) === 'controller' ? controller : agentFor(String(id)) as never),
    list: () => [],
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
    ...options.git === undefined ? {} : { git: options.git },
  }
  return { coordinator: new Coordinator(deps), store, calls, sessions }
}

describe('operation status (PRD §二.2.1, §三.3)', () => {
  it('reports a settled operation and the task preparation it belongs to', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const created = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'Parser',
    })

    const status = made.coordinator.operationStatus('create-1')
    expect(status.found).toBe(true)
    expect(status.kind).toBe('create')
    expect(status.delivery).toBe('accepted')
    expect(status.taskId).toBe(created.taskId)
    // The two are separate facts: the operation settled, and the task is ready.
    expect(status.task?.preparation).toBe('ready')
    expect(status.task?.preparationPhase).toBe('ready')
    expect(status.task?.sessionId).toBe(created.sessionId)
    // A finished preparation is not cancellable, and the reason says what to use instead.
    expect(status.cancellable).toBe(false)
    expect(status.cancellationRefusal).toMatch(/nothing left to cancel/)
    expect(status.cancellationRefusal).toMatch(/conductor_stop/)
  })

  it('reports an unknown operation as not found rather than as an empty status', () => {
    const made = makeCoordinator()
    const status = made.coordinator.operationStatus('nope')
    expect(status.found).toBe(false)
    expect(status.reason).toMatch(/no operation nope is recorded/)
  })

  it('lists every operation recorded for a task', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const created = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'Parser', instruction: 'go',
    })
    const listed = made.coordinator.operationList(created.taskId)
    expect(listed.found).toBe(true)
    expect(listed.operations.map(operation => operation.operationId)).toContain('create-1')
    expect(made.coordinator.operationList('task-unknown').found).toBe(false)
  })
})

/**
 * Put a task into the state a preparation is left in when it stops mid-flight.
 *
 * This is the reachable cancellation window, and it is worth being precise about why: creation runs
 * its phases inside one Host call, so a task is only ever *observed* in `preparing` when the Host
 * went away between two phases (or when a cancellation lands while the phases are still running).
 * The record is therefore set directly, exactly as a crash would leave it — task still preparing,
 * first instruction still `prepared` and never dispatched.
 */
async function abandonedPreparation(
  made: ReturnType<typeof makeCoordinator>,
  operationId = 'create-1',
): Promise<string> {
  const created = await made.coordinator.createTask({
    operationId, controllerSessionId: 'controller', title: 'Parser', instruction: 'Ship it',
  })
  await made.store.updateOperation(operationId, current => ({ ...current, delivery: 'prepared', withdrawn: false }))
  await made.store.updateTask(created.taskId, current => ({ ...current, preparation: 'preparing' }))
  return created.taskId
}

describe('cancelling a preparation (PRD §二.2.1)', () => {
  it('withdraws an undelivered instruction and reports what was kept', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const taskId = await abandonedPreparation(made)
    // The session and directory this attempt created are what must be kept, not rolled back.
    const before = made.store.getTask(taskId)
    const sessionId = made.store.getBinding(before?.currentBindingId ?? '')?.sessionId

    const cancelled = await made.coordinator.cancelPreparation({
      operationId: 'create-1',
      callerSessionId: 'controller',
    })

    expect(cancelled.preparation).toBe('cancelled')
    expect(cancelled.instructionWithdrawn).toBe(true)
    expect(cancelled.alreadyCancelled).toBe(false)
    expect(cancelled.kept.sessionId).toBe(sessionId)
    expect(cancelled.summary).toMatch(/Nothing already created was removed/)
    expect(cancelled.summary).toMatch(/session .* is kept/)
    // The phase it reached is kept, so a reader can still see how far it got. Asserted against the
    // phase before the cancellation rather than a literal: "kept" is the property, not a value.
    expect(cancelled.preparationPhase).toBe(before?.preparationPhase)
    // And the withdrawal is durable: a restart must not deliver it.
    expect(made.store.getOperation('create-1')?.withdrawn).toBe(true)
    expect(made.store.getOperation('create-1')?.delivery).toBe('withdrawn')
  })

  it('refuses once the first instruction was accepted, naming the verbs that apply instead', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const created = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'Parser', instruction: 'Ship it',
    })
    expect(created.preparation).toBe('ready')
    const status = made.coordinator.operationStatus('create-1')
    expect(status.cancellable).toBe(false)
    // A ready task is refused on the plainest ground there is, and the reason routes the caller to
    // the verbs that can actually affect a delivered message.
    expect(status.cancellationRefusal).toMatch(/finished preparing/)
    expect(status.cancellationRefusal).toMatch(/conductor_stop or conductor_queue/)

    const error = await made.coordinator.cancelPreparation({
      operationId: 'create-1', callerSessionId: 'controller',
    }).catch((thrown: unknown) => thrown)
    expect((error as ConductorError).code).toBe('PREPARATION_NOT_CANCELLABLE')
  })

  it('refuses a preparation that already failed, and the refusal is not a cancellation', async () => {
    // A failed preparation is not a running one, so there is nothing to stop. It is left for
    // `resume` to continue rather than being marked cancelled as if the user had decided.
    const made = makeCoordinator({
      callerEvents: controllerTurns,
      git: scriptedGit({ worktreeAdd: { ok: false, stdout: '', stderr: 'fatal: exists', code: 128 } }),
    })
    const created = await made.coordinator.createTask({
      operationId: 'create-1',
      controllerSessionId: 'controller',
      title: 'Parser',
      instruction: 'Ship it',
      workspace: { strategy: 'current_head', repoPath: 'D:\\proj' },
    })
    expect(created.preparation).toBe('failed')

    const error = await made.coordinator.cancelPreparation({
      operationId: 'create-1', callerSessionId: 'controller',
    }).catch((thrown: unknown) => thrown)
    expect((error as ConductorError).code).toBe('PREPARATION_NOT_CANCELLABLE')
    expect((error as ConductorError).message).toMatch(/already failed to prepare/)
    expect((error as ConductorError).message).toMatch(/`resume` action/)
    expect(made.store.getTask(created.taskId)?.preparation).toBe('failed')
  })

  it('refuses a caller that does not control the task', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    await abandonedPreparation(made)
    const error = await made.coordinator.cancelPreparation({
      operationId: 'create-1', callerSessionId: 'someone-else',
    }).catch((thrown: unknown) => thrown)
    expect((error as ConductorError).code).toBe('NOT_CONTROLLER')
  })

  it('is idempotent: cancelling twice reports that nothing changed', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    await abandonedPreparation(made)
    await made.coordinator.cancelPreparation({ operationId: 'create-1', callerSessionId: 'controller' })
    const again = await made.coordinator.cancelPreparation({ operationId: 'create-1', callerSessionId: 'controller' })
    expect(again.alreadyCancelled).toBe(true)
    expect(again.summary).toMatch(/was already cancelled; nothing changed/)
  })

  it('refuses to cancel a message that is not a preparation at all', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const created = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'Parser',
    })
    await made.coordinator.send({
      operationId: 'send-1', taskId: created.taskId, text: 'more', mode: 'queue', callerSessionId: 'controller',
    })
    const error = await made.coordinator.cancelPreparation({
      operationId: 'send-1', callerSessionId: 'controller',
    }).catch((thrown: unknown) => thrown)
    expect((error as ConductorError).code).toBe('PREPARATION_NOT_CANCELLABLE')
    expect((error as ConductorError).message).toMatch(/not a preparation/)
  })
})

describe('resuming a preparation (PRD §三.3, §二.2.1)', () => {
  it('does not create a second session when the first attempt already made one', async () => {
    // The resume path exists because a preparation can stop after creating its session. Creating a
    // second one would duplicate the resource §二.2.1 says is kept.
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const created = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'Parser', instruction: 'first',
    })
    // Force the task back into a stopped state the way a failed resume would find it.
    await made.store.updateTask(created.taskId, current => ({ ...current, preparation: 'failed', failureReason: 'host went away' }))

    const resumed = await made.coordinator.resumePreparation({
      taskId: created.taskId, callerSessionId: 'controller',
    })
    expect(resumed.preparation, resumed.failureReason ?? '').toBe('ready')
    // The same session, not a new one.
    expect(resumed.sessionId).toBe(created.sessionId)
    expect(made.store.listTasks()).toHaveLength(1)
    const bindings = made.store.getTask(created.taskId)?.currentBindingId
    expect(made.store.getBinding(bindings ?? '')?.sessionId).toBe(created.sessionId)
    // And the instruction was not sent twice: it was already accepted before the resume.
    expect(made.calls.filter(call => call.verb === 'followup')).toHaveLength(1)
  })

  it('refuses to resume a cancelled preparation, because that would undo a decision', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const taskId = await abandonedPreparation(made)
    await made.coordinator.cancelPreparation({ operationId: 'create-1', callerSessionId: 'controller' })
    const error = await made.coordinator.resumePreparation({
      taskId, callerSessionId: 'controller',
    }).catch((thrown: unknown) => thrown)
    expect((error as ConductorError).code).toBe('PREPARATION_CANCELLED')
    expect((error as ConductorError).message).toMatch(/undo a decision the user made/)
  })

  it('refuses to resume a task that is already ready, and one with no recorded operation', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const created = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'Parser',
    })
    const complete = await made.coordinator.resumePreparation({
      taskId: created.taskId, callerSessionId: 'controller',
    }).catch((thrown: unknown) => thrown)
    expect((complete as ConductorError).code).toBe('PREPARATION_COMPLETE')

    const unknown = await made.coordinator.resumePreparation({
      taskId: 'task-nope', callerSessionId: 'controller',
    }).catch((thrown: unknown) => thrown)
    expect((unknown as ConductorError).code).toBe('TASK_NOT_FOUND')
  })

  it('refuses a resume from a session that does not control the task', async () => {
    const made = makeCoordinator({ callerEvents: controllerTurns })
    const created = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'Parser',
    })
    await made.store.updateTask(created.taskId, current => ({ ...current, preparation: 'failed' }))
    const error = await made.coordinator.resumePreparation({
      taskId: created.taskId, callerSessionId: 'intruder',
    }).catch((thrown: unknown) => thrown)
    expect((error as ConductorError).code).toBe('NOT_CONTROLLER')
  })
})
