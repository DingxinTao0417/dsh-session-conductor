/**
 * Moving a task to a different working directory (PRD §二.10.2).
 *
 * A session's working directory cannot be changed in place, so the specification
 * moves the *task* instead, through a successor session, in a fixed order:
 *
 *   stop and confirm → flush → freeze history and file state →
 *   prepare the target environment → create the successor session →
 *   atomically switch the logical binding
 *
 * Two properties matter more than the steps. The binding switch is **last**: a
 * failure anywhere before it leaves the task pointing at the source, with its
 * history and artifacts intact. And the switch is **atomic** in the sense that
 * matters here — the new binding is written and the task's pointer moves to it in
 * one store call, so no observer sees a task with no session.
 *
 * ## What this build checks, and what it does not
 *
 * The specification requires the target directory to pass a baseline check, an
 * existing-modification check and an occupancy check. Occupancy and existence
 * are always checked. The git baseline and existing-modification checks run
 * through the same Git adapter worktree creation uses, when the Host mounts a
 * subprocess service; without that adapter they stay named as unchecked rather
 * than implied. A dirty **target** tree **refuses** the handoff and does not
 * clean anything. This build still cannot tell whether another process holds
 * the directory.
 *
 * Freeze (固定历史与文件状态) records the source history cutoff when the log is
 * present, **stores that seq on the successor binding**, and captures the source
 * working tree as it stood — dirty or clean — without modifying it. A dirty
 * source is a frozen fact, not a refusal; only the target's existing
 * modifications stop the move. Without a Git adapter or a recorded source
 * directory that capture is named as unchecked rather than implied. Running
 * terminals, external processes and credentials are **not** migrated: the
 * successor is a new session seeded with history only, and that default
 * condition is named as checked rather than implied.
 *
 * The default conditions also require no unconsumed queue **and no unresolved
 * interaction**. A source waiting on `ask_user_question` or an approval is
 * refused at `stopping` *before* anything is cancelled, so a handoff cannot
 * abort a pending question as a side effect. A Host that exposes no event log
 * names that interaction check as unchecked rather than implying "none".
 *
 * Stop-and-confirm uses the same exact-stop critical section as `conductor_stop`
 * (PRD §二.6): the open turn is verified and cancelled with no await in between,
 * and confirmation is that turn's `turn/end`, never `whenIdle()`. A Host that
 * exposes no event log still waits on `whenIdle` and names that as not a
 * turn-end receipt.
 *
 * @module dsh-session-conductor/service/handoff
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import { describeFailure, type AgentLike } from './host.ts'
import type { ConductorStore } from '../store/repository.ts'
import type { BindingRecord, TaskRecord } from '../store/schema.ts'
import { writeControlRefusal } from './access.ts'
import { inspectTargetWorkingTree, type GitRunner } from './git.ts'
import { cancelExpectedTurn, openTurnOf, turnEndOf, type StopAgentLike } from './stop.ts'
import { DEFAULTS } from '../domain/defaults.ts'
import { initialProjection, pendingInterventionOf, projectEvents } from './projection.ts'

/** The PRD's handoff steps, in order. */
export const HANDOFF_STEPS = [
  'stopping',
  'flushing',
  'freezing',
  'preparing_target',
  'creating_successor',
  'switching_binding',
] as const
export type HandoffStep = (typeof HANDOFF_STEPS)[number]

/** What a caller asks for. */
export interface HandoffRequest {
  readonly operationId: string
  readonly callerSessionId: string
  readonly taskId: string
  /** Absolute working directory the successor session should use. */
  readonly targetPath: string
  /** Optional instruction delivered once the successor is ready. */
  readonly instruction?: string
  /** How long to wait for the cancelled source turn to confirm its end. */
  readonly stopTimeoutMs?: number
  /**
   * The binding version the caller observed. A move that already advanced it
   * refuses rather than migrating the successor under the old identity
   * (PRD §三.3 `handoff` 预期绑定, §二.10.2).
   */
  readonly expectedBindingVersion?: number
  /**
   * The write-control epoch the caller observed (PRD §三.2 MutationContext).
   * A transfer that landed in between is refused.
   */
  readonly expectedOwnerEpoch?: number
}

/** Which preconditions were established, and which were not. */
export interface PreconditionReport {
  readonly checked: string[]
  /** Named so a reader cannot mistake "not checked" for "checked and passed". */
  readonly unchecked: string[]
}

/** The outcome of a handoff attempt. */
export interface HandoffOutcome {
  readonly taskId: string
  readonly operationId?: string
  readonly pending?: boolean
  /** The step the attempt reached. */
  readonly reached: HandoffStep
  readonly succeeded: boolean
  readonly previousSessionId?: string
  readonly successorSessionId?: string
  /**
   * Source-session event seq the successor was frozen through, when the log
   * was present to freeze (PRD §二.10.2). The same value is stored on the
   * successor binding as `frozenThroughSeq`.
   */
  readonly frozenThroughSeq?: number
  readonly reason?: string
  readonly instructionDelivery?: 'accepted' | 'replayed' | 'pending' | 'failed'
  readonly instructionReason?: string
  readonly preconditions: PreconditionReport
}

/** An agent surface rich enough to stop and freeze. */
interface StoppableAgent extends AgentLike {
  whenIdle?(): Promise<void>
}
/** The agent registry surface a handoff uses. */
export interface HandoffAgents {
  get(id: unknown): StoppableAgent | undefined
  create(options: {
    sessionId: SessionId
    seed?: readonly unknown[]
    meta?: Record<string, unknown>
    setup?: (agentCtx: unknown) => void | Promise<void>
  }): Promise<{ agent: AgentLike }>
}

/** The session store surface a handoff uses. */
export interface HandoffSessions {
  flush(session: unknown): Promise<boolean>
}

/** The filesystem surface the target check uses. */
export interface HandoffFs {
  resolve(path: string): Promise<unknown>
  stat(target: unknown, signal?: AbortSignal): Promise<{ size?: number } | undefined>
  listDir?(target: unknown, signal?: AbortSignal): Promise<readonly unknown[]>
}

/** Everything the handoff needs. */
export interface HandoffDeps {
  readonly agents: HandoffAgents
  readonly store: ConductorStore
  /** Present when the Host composes a session store; `flush` is skipped without it. */
  readonly sessions?: HandoffSessions
  /** Present when the Host composes a filesystem; the target check is skipped without it. */
  readonly fs?: HandoffFs
  /**
   * Present when the Host composes a Git adapter. Without it the baseline and
   * existing-modification checks are named as unchecked rather than implied.
   */
  readonly git?: GitRunner
  readonly presets?: {
    presetOf(source: { readonly header: unknown; readonly events: readonly unknown[] }): string | undefined
    mount(agentCtx: unknown, presetId: string | undefined): Promise<void>
  }
  readonly createMessage: (text: string, source: unknown) => unknown
  /** Route successor input through the ordinary authority, budget and idempotency path. */
  readonly dispatchInstruction?: (request: {
    operationId: string
    taskId: string
    callerSessionId: string
    text: string
    expectedOwnerEpoch: number
    expectedBindingVersion: number
  }) => Promise<{ delivery: 'accepted' | 'replayed' | 'pending'; messageId?: string }>
  readonly newSessionId: () => string
  readonly newBindingId: () => string
  readonly now: () => string
  /**
   * Ceiling for confirming the cancelled source turn (PRD §四.7 打断确认等待上限).
   * Used when the request omits `stopTimeoutMs`.
   */
  readonly interruptConfirmLimitMs?: number
  /** Poll delay while waiting for the cancelled turn's end. */
  readonly pollMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Move a task to a successor session in a different directory.
 *
 * @param deps - the Host surfaces the handoff uses.
 * @param request - the handoff request.
 * @returns the outcome, naming the step reached and what was and was not checked.
 * @throws never for an expected condition: a refused handoff is reported, not thrown.
 */
export async function handoffTask(deps: HandoffDeps, request: HandoffRequest): Promise<HandoffOutcome> {
  if (request.instruction !== undefined && deps.dispatchInstruction === undefined) {
    return refused(request, 'stopping', 'successor instructions require the ordinary conductor dispatch service; nothing was moved', { checked: [], unchecked: [] })
  }
  const { outcome, epoch, version } = await deps.store.withExclusive('target-dispatch', async () => {
    const epoch = deps.store.getAccess(request.taskId)?.ownerEpoch
    const task = deps.store.getTask(request.taskId)
    const version = deps.store.getBinding(task?.currentBindingId ?? '')?.version
    return { outcome: await handoffTaskLocked(deps, request), epoch, version }
  })
  // Release the Host dispatch lock before re-entering Coordinator.send.
  if (!outcome.succeeded || request.instruction === undefined || deps.dispatchInstruction === undefined) return outcome
  try {
    if (epoch === undefined || version === undefined) throw new Error('the admitted control or binding version is unavailable')
    const sent = await deps.dispatchInstruction({ operationId: `${request.operationId}:instruction`, taskId: request.taskId,
      callerSessionId: request.callerSessionId, text: request.instruction, expectedOwnerEpoch: epoch,
      expectedBindingVersion: version + 1 })
    return { ...outcome, instructionDelivery: sent.delivery }
  } catch (error) {
    return { ...outcome, instructionDelivery: 'failed', instructionReason: describeFailure(error) }
  }
}

async function handoffTaskLocked(deps: HandoffDeps, request: HandoffRequest): Promise<HandoffOutcome> {
  const checked: string[] = []
  const unchecked: string[] = []
  const preconditions = (): PreconditionReport => ({ checked: [...checked], unchecked: [...unchecked] })

  const task = deps.store.getTask(request.taskId)
  if (task === undefined) {
    return refused(request, 'stopping', `no managed task ${request.taskId}`, preconditions())
  }
  const binding = task.currentBindingId === undefined ? undefined : deps.store.getBinding(task.currentBindingId)
  if (binding === undefined) {
    return refused(request, 'stopping', `task ${request.taskId} has no session bound to it`, preconditions())
  }
  const control = writeControlRefusal(deps.store.getAccess(request.taskId), request.taskId, request.callerSessionId)
  if (control !== undefined) {
    return refused(request, 'stopping', `${control.code}: ${control.reason}`, preconditions())
  }
  const access = deps.store.getAccess(request.taskId)
  if (request.expectedOwnerEpoch !== undefined && access !== undefined
    && access.ownerEpoch !== request.expectedOwnerEpoch) {
    return refused(
      request,
      'stopping',
      `STALE_OWNER_EPOCH: control of task ${request.taskId} is at epoch ${String(access.ownerEpoch)}, `
      + `not ${String(request.expectedOwnerEpoch)}`,
      preconditions(),
    )
  }
  if (request.expectedBindingVersion !== undefined && binding.version !== request.expectedBindingVersion) {
    return refused(
      request,
      'stopping',
      `STALE_BINDING: task ${request.taskId} is bound at version ${String(binding.version)}, `
      + `not ${String(request.expectedBindingVersion)}`,
      preconditions(),
    )
  }
  if (binding.sessionId === request.callerSessionId) {
    // PRD §二.10.2: a controller cannot migrate the execution context that is
    // carrying its own coordination service.
    return refused(
      request,
      'stopping',
      'the caller is the session being handed off, and a controller cannot migrate the execution context '
      + 'it is running in',
      preconditions(),
    )
  }

  const source = deps.agents.get(binding.sessionId)
  if (source === undefined) {
    return refused(
      request,
      'stopping',
      `the session bound to task ${request.taskId} (${binding.sessionId}) is not live in this Host`,
      preconditions(),
    )
  }

  // ── stop and confirm ─────────────────────────────────────────────────────
  if (source.inbox !== undefined) {
    if (source.inbox.hasPending) {
      return refused(
        request,
        'stopping',
        'the source session has unconsumed queued input; the specification requires an empty queue before '
        + 'a handoff',
        preconditions(),
      )
    }
    checked.push('the source has no unconsumed queued input')
  } else {
    unchecked.push('whether the source has unconsumed queued input')
  }

  const events = source.session?.events
  if (events === undefined || events.length === 0) {
    unchecked.push('whether the source has unresolved interaction')
  } else {
    const pending = pendingInterventionOf(projectEvents(initialProjection(), events).state.interaction)
    if (pending !== undefined) {
      return refused(
        request,
        'stopping',
        `the source session has unresolved interaction (${pending}); the specification requires none before `
        + 'a handoff',
        preconditions(),
      )
    }
    checked.push('the source has no unresolved interaction')
  }

  const stopped = await confirmSourceStopped(deps, request, source, checked, unchecked)
  if (!stopped.ok) {
    return refused(request, 'stopping', stopped.reason, preconditions())
  }

  // ── flush ────────────────────────────────────────────────────────────────
  if (deps.sessions !== undefined) {
    try {
      if (source.session === undefined || await deps.sessions.flush(source.session) !== true) {
        return refused(request, 'flushing', 'the source session flush was not acknowledged; binding is unchanged', preconditions())
      }
      checked.push('the source session was flushed to durable storage')
    } catch (error) {
      return refused(request, 'flushing', `the source flush failed (${describeFailure(error)}); binding is unchanged`, preconditions())
    }
  } else {
    unchecked.push('whether the source session was flushed')
  }

  // ── freeze history and file state ────────────────────────────────────────
  const cutoffSeq = source.session?.seq ?? -1
  const seed = [...(source.session?.events ?? [])]
  // A persisted snapshot is not a freeze of the live driver. Validate again at
  // every irreversible boundary, including inside the task-pointer commit.
  const validateSource = (): void => {
    const currentAccess = deps.store.getAccess(request.taskId)
    if (currentAccess?.ownerEpoch !== access?.ownerEpoch) throw new Error('STALE_OWNER_EPOCH: control changed during handoff')
    const denied = writeControlRefusal(currentAccess, request.taskId, request.callerSessionId)
    if (denied !== undefined) throw new Error(`${denied.code}: ${denied.reason}`)
    const currentTask = deps.store.getTask(request.taskId)
    if (currentTask?.currentBindingId !== binding.bindingId) throw new Error('STALE_BINDING: the source binding changed during handoff')
    if (source.inbox?.hasPending === true || (source.session === undefined && source.status === 'running')
      || openTurnOf(source.session?.events ?? []) !== undefined) {
      throw new Error('the source changed during handoff: an active turn or queued input appeared')
    }
    if (source.session !== undefined && source.session.seq !== cutoffSeq) {
      throw new Error('the source history changed after its snapshot was frozen')
    }
  }
  if (seed.length === 0) {
    unchecked.push('the source history boundary')
  } else {
    checked.push(`the source history is frozen through event seq ${String(cutoffSeq)}`)
  }
  checked.push(
    'running terminals, external processes and credentials were not migrated '
    + '(the successor is a new session seeded with history only)',
  )

  if (deps.git === undefined) {
    unchecked.push('the source file state at freeze')
  } else if (binding.cwd === undefined || binding.cwd.length === 0) {
    unchecked.push('the source file state at freeze (no recorded working directory)')
  } else {
    const frozen = await inspectTargetWorkingTree(deps.git, binding.cwd)
    if (frozen.kind === 'unreadable') {
      unchecked.push(`the source file state at freeze could not be read (${frozen.reason})`)
    } else if (frozen.kind === 'not_a_repo') {
      checked.push('the source is not a git working tree, so there is no file-state baseline to freeze')
    } else if (frozen.kind === 'dirty') {
      const named = frozen.changedPaths.slice(0, 8).join(', ')
      const extra = frozen.changedPaths.length > 8
        ? ` and ${String(frozen.changedPaths.length - 8)} more`
        : ''
      const at = frozen.head === undefined ? '' : ` at ${frozen.head}`
      checked.push(`the source file state is frozen dirty${at} (${named}${extra}); nothing was cleaned`)
    } else {
      checked.push(
        frozen.head === undefined
          ? 'the source file state is frozen clean'
          : `the source file state is frozen clean at ${frozen.head}`,
      )
    }
  }

  // ── prepare the target environment ───────────────────────────────────────
  const occupied = findOccupant(deps.store, request.targetPath, request.taskId)
  if (occupied !== undefined) {
    return refused(
      request,
      'preparing_target',
      `the target directory is already used by task ${occupied}`,
      preconditions(),
    )
  }
  checked.push('no other managed task is bound to the target directory')

  if (deps.fs !== undefined) {
    try {
      const info = await deps.fs.stat(await deps.fs.resolve(request.targetPath))
      if (info === undefined) {
        return refused(
          request,
          'preparing_target',
          `the target directory ${request.targetPath} does not exist; the conductor does not create it`,
          preconditions(),
        )
      }
      checked.push('the target directory exists')
    } catch (error) {
      return refused(request, 'preparing_target', `the target directory could not be checked: ${describeFailure(error)}`, preconditions())
    }
  } else {
    unchecked.push('whether the target directory exists')
  }

  // Named explicitly: an unchecked precondition reported as a gap is honest; one
  // silently omitted is how a migration claims a guarantee it never established.
  if (deps.git === undefined) {
    unchecked.push('the target\'s git baseline and existing local modifications')
  } else {
    const tree = await inspectTargetWorkingTree(deps.git, request.targetPath)
    if (tree.kind === 'dirty') {
      const named = tree.changedPaths.slice(0, 8).join(', ')
      const extra = tree.changedPaths.length > 8
        ? ` and ${String(tree.changedPaths.length - 8)} more`
        : ''
      return refused(
        request,
        'preparing_target',
        `the target directory has existing local modifications (${named}${extra}); `
          + 'the handoff stopped rather than automatically cleaning them',
        preconditions(),
      )
    }
    if (tree.kind === 'unreadable') {
      return refused(
        request,
        'preparing_target',
        `the target's git baseline could not be read (${tree.reason}), so the handoff stopped `
          + 'rather than migrating into an unverified tree',
        preconditions(),
      )
    }
    if (tree.kind === 'not_a_repo') {
      checked.push(
        'the target is not a git working tree, so there is no git baseline or local modification set to refuse',
      )
    } else {
      checked.push(
        tree.head === undefined
          ? 'the target git working tree is clean'
          : `the target git working tree is clean at ${tree.head}`,
      )
    }
  }
  unchecked.push('whether any process currently holds the target directory')

  // ── create the successor ─────────────────────────────────────────────────
  try {
    validateSource()
  } catch (error) {
    return refused(request, 'creating_successor', describeFailure(error), preconditions())
  }
  const successorId = SessionId(deps.newSessionId())
  try {
    const presetId = deps.presets?.presetOf?.({ header: source.session?.header, events: seed })
    await deps.agents.create({
      sessionId: successorId,
      seed,
      meta: {
        parentSession: SessionId(binding.sessionId),
        seedLength: seed.length,
        cwd: request.targetPath,
        ...presetId === undefined ? {} : { agentPreset: presetId },
      },
      setup: async (agentCtx: unknown) => { await deps.presets?.mount(agentCtx, presetId) },
    })
  } catch (error) {
    // Nothing was switched: the task still points at the source, which keeps its
    // history and artifacts.
    return refused(
      request,
      'creating_successor',
      `the successor session could not be created: ${describeFailure(error)}. The task still points at `
      + `${binding.sessionId} and nothing was changed.`,
      preconditions(),
    )
  }

  // ── switch the logical binding, atomically and last ──────────────────────
  try {
    await deps.store.putBinding({
      bindingId: deps.newBindingId(),
      taskId: request.taskId,
      hostId: binding.hostId,
      sessionId: String(successorId),
      version: binding.version + 1,
      cwd: request.targetPath,
      predecessorBindingId: binding.bindingId,
      ...seed.length === 0 ? {} : { frozenThroughSeq: cutoffSeq },
      createdAt: deps.now(),
    }, validateSource)
  } catch (error) {
    const pointer = deps.store.getTask(request.taskId)?.currentBindingId
    const committed = pointer === undefined ? undefined : deps.store.getBinding(pointer)
    if (committed?.sessionId === String(successorId)) {
      return { taskId: request.taskId, reached: 'switching_binding', succeeded: true,
        previousSessionId: binding.sessionId, successorSessionId: String(successorId),
        ...seed.length === 0 ? {} : { frozenThroughSeq: cutoffSeq },
        reason: `the successor binding is committed, but subsequent binding bookkeeping failed: ${describeFailure(error)}`,
        preconditions: preconditions() }
    }
    return refused(
      request,
      'switching_binding',
      `the successor session ${String(successorId)} was created but the binding could not be switched: `
      + `${describeFailure(error)}. The task still points at ${binding.sessionId}.`,
      preconditions(),
    )
  }

  return {
    taskId: request.taskId,
    reached: 'switching_binding',
    succeeded: true,
    previousSessionId: binding.sessionId,
    successorSessionId: String(successorId),
    ...seed.length === 0 ? {} : { frozenThroughSeq: cutoffSeq },
    preconditions: preconditions(),
  }
}

/**
 * Find another managed task already bound to a directory.
 * @param store - the conductor's store.
 * @param path - the candidate directory.
 * @param exceptTaskId - the task being moved, which does not count as an occupant.
 * @returns the occupying task id, or undefined.
 */
function findOccupant(store: ConductorStore, path: string, exceptTaskId: string): string | undefined {
  for (const task of store.listTasks()) {
    if (task.taskId === exceptTaskId) continue
    if (task.currentBindingId === undefined) continue
    const other = store.getBinding(task.currentBindingId)
    if (other?.cwd === path && other.retiredAt === undefined) return task.taskId
  }
  return undefined
}

/**
 * Confirm the source is stopped the way PRD §二.6 requires, not by `whenIdle()`.
 *
 * @param deps - sleep, poll and the configured confirmation ceiling.
 * @param request - may name its own `stopTimeoutMs`.
 * @param source - the live source agent.
 * @param checked - preconditions already established; a confirmed stop is appended.
 * @param unchecked - gaps; a missing event log is named rather than implied.
 * @returns ok, or the reason the handoff must stop here.
 */
async function confirmSourceStopped(
  deps: HandoffDeps,
  request: HandoffRequest,
  source: StoppableAgent,
  checked: string[],
  unchecked: string[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const timeout = request.stopTimeoutMs
    ?? deps.interruptConfirmLimitMs
    ?? DEFAULTS.interruptConfirmLimitMs
  const agent = stopAgentOf(source)
  if (agent === undefined) {
    unchecked.push('source turn and completed history are unavailable')
    return {ok:false,reason:'HOST_CAPABILITY_REQUIRED: the source event log is unavailable; exact stop and history freeze cannot be confirmed'}
  }

  const decision = cancelExpectedTurn(agent, {}, { reason: 'conductor environment handoff' })
  if (decision.kind === 'no_active_turn') {
    checked.push('the source has no active turn')
    return { ok: true }
  }
  if (decision.kind !== 'requested') {
    return { ok: false, reason: decision.reason }
  }
  const ended = await waitForTurnEnd(agent, decision.turn.turn, timeout, deps)
  if (!ended) {
    return {
      ok: false,
      reason: `the source turn ${String(decision.turn.turn)} did not confirm its end within ${String(timeout)} ms, `
        + 'so the handoff stopped rather than migrating a session that may still be working',
    }
  }
  const stillOpen = openTurnOf(agent.session.events)
  if (stillOpen !== undefined) {
    return {
      ok: false,
      reason: `a new turn ${String(stillOpen.turn)} started after the cancelled turn ended, `
        + 'so the handoff stopped rather than migrating a session that is working again',
    }
  }
  checked.push(`the source turn ${String(decision.turn.turn)} reported its end`)
  return { ok: true }
}

/** Narrow to the exact-stop surface when the event log is present. */
function stopAgentOf(source: StoppableAgent): StopAgentLike | undefined {
  if (source.session === undefined) return undefined
  return source as StopAgentLike
}

/**
 * Poll for one specific turn's end. `whenIdle()` is not a substitute.
 */
async function waitForTurnEnd(
  agent: StopAgentLike,
  turn: number,
  timeoutMs: number,
  deps: HandoffDeps,
): Promise<boolean> {
  const sleep = deps.sleep ?? defaultSleep
  const pollMs = deps.pollMs ?? 25
  const started = Date.now()
  for (;;) {
    if (turnEndOf(agent.session.events, turn) !== undefined) return true
    if (Date.now() - started >= timeoutMs) return false
    await sleep(pollMs)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Build a refusal outcome.
 * @param request - the originating request.
 * @param reached - the step the attempt stopped at.
 * @param reason - why it stopped.
 * @param preconditions - what was and was not checked.
 * @returns the outcome.
 */
function refused(
  request: HandoffRequest,
  reached: HandoffStep,
  reason: string,
  preconditions: PreconditionReport,
): HandoffOutcome {
  return { taskId: request.taskId, reached, succeeded: false, reason, preconditions }
}

/**
 * Render the precondition report for a reader.
 * @param report - what was and was not checked.
 * @returns the model-facing text.
 */
export function describePreconditions(report: PreconditionReport): string {
  const yes = report.checked.length === 0 ? '  (nothing)' : report.checked.map(item => `  - ${item}`).join('\n')
  if (report.unchecked.length === 0) return `Verified before the move:\n${yes}`
  const no = report.unchecked.map(item => `  - ${item}`).join('\n')
  return `Verified before the move:\n${yes}\n\nNOT verified (this is a gap, not a pass):\n${no}`
}

/** The binding a handoff produced, for callers that report the chain. */
export type HandoffBinding = BindingRecord
/** The task a handoff moved. */
export type HandoffTask = TaskRecord
