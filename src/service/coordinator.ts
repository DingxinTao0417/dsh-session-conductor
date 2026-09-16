/**
 * The coordination service: creating logical tasks and dispatching
 * instructions to them.
 *
 * This is where the specification's sharpest distinction lives. PRD §三.4
 * forbids collapsing these into one status:
 *
 *   environment ready ≠ message accepted ≠ message consumed
 *   ≠ turn ended ≠ acceptance passed ≠ artifact transfer completed
 *
 * So creation reports its own phases, a dispatch reports `accepted` when the
 * *Host* took the message (not when the target finished), and a failure to
 * prepare is recorded with its phase and reason while whatever was already
 * created is kept and reported rather than rolled back.
 *
 * Everything the Host does is reached through {@link CoordinatorDeps}, so the
 * whole state machine is tested against fakes and the same code runs against a
 * live Host.
 *
 * @module dsh-session-conductor/service/coordinator
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { ParentEnvironment } from './creation-environment.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { describeFailure, liveAgentOf, relaySource, type AgentLike, type AgentRegistryLike, type LiveAgentLike, type MessageSource } from './host.ts'
import {
  afterStopCheck,
  cancelExpectedTurn,
  interruptPrecondition,
  openTurnOf,
  pendingInputOf,
  turnEndOf,
  unconfirmedStopReport,
  type CancelTracker,
} from './stop.ts'
import { computeForkCut } from './fork.ts'
import { buildBrief, digestBrief, renderBrief, renderStartingContext } from './brief.ts'
import { createWorktree, planStart, type GitRunner, type SnapshotIo, type StartPlan, type StartStrategy } from './git.ts'
import { worktreeResourceId } from './cleanup.ts'
import { paramDigest } from '../domain/operation.ts'
import { DEFAULTS, DEFAULT_CONTEXT_MODE } from '../domain/defaults.ts'
import { forkOriginFieldsOf, forkOriginOf } from '../domain/fork-origin.ts'
import { countManagedTargets, managedTargetLimitReason } from '../domain/limits.ts'
import type { SessionEventLike } from './projection.ts'
import type { ConductorStore } from '../store/repository.ts'
import type { AccessRecord, BindingRecord, MessageSourceRecord, StoredOperationRecord, TaskRecord } from '../store/schema.ts'
import { mayRead, writeControlRefusal } from './access.ts'
import { selectionFromHeader, type CreationModelPort, type ModelSelection } from './modelconfig.ts'
import {
  admitPluginTurn,
  pendingDispatchOrder,
  sessionOccupies,
} from './concurrency.ts'

/** Send modes of PRD §二.6. */
export const SEND_MODES = ['steer', 'queue', 'interrupt', 'interrupt_and_send'] as const
export type SendMode = (typeof SEND_MODES)[number]

/** How often the stop sequence re-reads the session's event projection. */
const DEFAULT_STOP_POLL_MS = 25

/** A 32-byte URL-safe opaque value carried only by a native creation card. */
const SESSION_LINK_CAPABILITY = /^[A-Za-z0-9_-]{43}$/

function sessionLinkCapabilityOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!SESSION_LINK_CAPABILITY.test(value)) {
    throw new ConductorError('INVALID_SESSION_LINK_CAPABILITY', 'the native session-link capability is malformed')
  }
  return value
}

/** Wait a real delay, when no injected sleeper is supplied. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Everything the coordinator needs from its environment. */
export interface CoordinatorDeps {
  readonly localHostId?: string
  readonly remoteSend?: (request:SendRequest,binding:BindingRecord)=>Promise<SendResult>
  readonly remoteStop?: (request:StopRequest,binding:BindingRecord)=>Promise<StopResult>
  readonly remoteQueue?: (request:QueueRequest,binding:BindingRecord)=>Promise<QueueResult>
  /** The Host agent registry. */
  readonly agents: AgentRegistryLike
  /** The conductor's durable store. */
  readonly store: ConductorStore
  /** Build a user message with the Host's own identity rules. */
  readonly createMessage: (text: string, source: MessageSource) => { readonly id: string }
  /** Flush Host acceptance before recording a durable delivery receipt. */
  readonly flushSession?: (agent: AgentLike) => Promise<void>
  /** Revalidate persisted automatic grants and budgets at the actual Host dispatch boundary. */
  readonly dispatchAdmission?: (record: StoredOperationRecord) => string | undefined
  /** Mint a task id. */
  readonly newTaskId: () => string
  /** Mint a session id for a new Host session. */
  readonly newSessionId: () => string
  /** Mint a binding id. */
  readonly newBindingId: () => string
  /** Current time as ISO 8601 UTC. */
  readonly now: () => string
  /** Working directory a new session starts in when the caller names none. */
  readonly defaultCwd: () => string | undefined
  /** Runtime adapter reads the initiating session's directory and workspace membership. */
  readonly parentEnvironment?: (controllerSessionId: string) => ParentEnvironment
  /** Explicit native title, flushed before any first instruction is dispatched. */
  readonly setSessionTitle?: (agent: AgentLike, title: string) => Promise<string>
  /**
   * Agent-preset composition for a fork.
   *
   * A fork must rebuild the composition its source ran under, or the child
   * behaves differently from the session it claims to continue — the silently
   * different semantics PRD §一.5 forbids. The Host's own fork resolves the
   * source's preset and mounts it on the child, so this port does the same
   * through the Host's preset service rather than approximating it.
   *
   * Optional: a composition with no preset roster forks with no preset, which
   * is exactly what the Host's own fork does in the same situation.
   */
  readonly presets?: PresetPort
  /** Companion Host service; absence disables explicit model selection and snapshot freezing. */
  readonly models?: CreationModelPort
  /**
   * Sleep for a delay.
   *
   * Injected so the stop sequence — including the case that matters most, a turn
   * that never confirms — is testable without real time passing, and so a test can
   * advance the clock deterministically instead of racing it.
   */
  readonly sleep?: (ms: number) => Promise<void>
  /** How often the stop sequence re-reads the projection. */
  readonly pollMs?: number
  /**
   * The Git adapter (PRD §二.4).
   *
   * Absent when the composition mounts no subprocess service, in which case a create or fork that
   * asks for a Git starting state is refused with that reason — never quietly downgraded to
   * "run in the current directory", which is the one fallback the specification forbids outright.
   */
  readonly git?: GitRunner
  /** The filesystem port a worktree snapshot needs to copy the untracked paths the user chose. */
  readonly snapshotIo?: SnapshotIo
  /** The Host workspace registry, so a created worktree can be registered as a workspace. */
  readonly workspaces?: WorkspacePort
  /**
   * How many targets one controller session may manage at once (PRD §四.7).
   *
   * Defaults to the published table. Injected so a test can drive the ceiling
   * without creating twenty sessions, and so a live Host uses the configured
   * value rather than a second hardcoded 20.
   */
  readonly managedTargetLimit?: number
  /**
   * Plugin-initiated unfinished target turns allowed on this Host (PRD §四.4).
   * Waiting-for-user and waiting-for-approval occupy a slot. Defaults to 4.
   */
  readonly targetTurnConcurrency?: number
  /**
   * Record of conductor-issued cancels, so snapshots can report `interrupting`
   * while the cancelled turn is still open (PRD §三.4).
   *
   * Optional: tests that do not read execution overlay omit it.
   */
  readonly cancels?: CancelTracker
  /**
   * Concurrent conductor-notice turns allowed on this Host (PRD §四.4).
   * Defaults to 1.
   */
  readonly noticeConcurrency?: number
  /**
   * How long an interrupt-and-send waits for the expected turn to end (PRD §四.7).
   *
   * Defaults to the published 30 seconds. Injected so a live Host uses the
   * configured ceiling rather than a second hardcoded 30_000, and so a test
   * can drive an unconfirmed stop without waiting that long.
   */
  readonly interruptConfirmLimitMs?: number
}

/** The outcome of registering a directory with the Host workspace registry. */
export type WorkspaceRegistration =
  | { readonly ok: true; readonly workspaceId: string }
  | { readonly ok: false; readonly reason: string }

/**
 * The Host workspace registry, as the coordinator uses it (PRD §二.4).
 *
 * Two operations, because the Host splits them: registering a directory makes a workspace, and
 * attaching a session is what puts that session's own `cwd` into the workspace's account — and
 * the Host validates the session's header `cwd` against the workspace path while doing it, so a
 * session that is not actually in the directory is rejected there rather than believed here.
 */
export interface WorkspacePort {
  /**
   * Register a directory as a workspace, or return the existing registration for that path.
   * @param path - the directory, canonicalized by the Host.
   * @param title - the display title to use if the directory is new to the registry.
   * @returns the workspace id, or why the directory could not be registered.
   */
  register(path: string, title: string): Promise<WorkspaceRegistration>
  /**
   * Attach a session to a workspace.
   * @param workspaceId - the workspace.
   * @param sessionId - the session, whose own recorded cwd the Host checks against the workspace.
   * @returns the outcome, or why the session could not be attached.
   */
  attach(workspaceId: string, sessionId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>
}

/** Agent-preset composition the coordinator needs for a create or a fork. */
export interface PresetPort {
  /**
   * Resolve the preset a source session actually ran under.
   * @param source - the source session's header and log.
   * @returns the preset id, or undefined when the session ran under none.
   */
  presetOf(source: { readonly header: unknown; readonly events: readonly unknown[] }): string | undefined
  /**
   * Compose that preset onto a newly created agent's context.
   * @param agentCtx - the scoped context the factory hands to `setup`.
   * @param presetId - the preset to mount, when the source had one.
   */
  mount(agentCtx: unknown, presetId: string | undefined): Promise<void>
  /**
   * Check a preset id against the Host's roster (PRD §二.3).
   *
   * Called **before** anything is created, because the alternative is meeting a bad preset when the Host
   * refuses to assemble the session — after a worktree exists and a task record already says `preparing`.
   * Optional, so a composition with no roster is representable; the coordinator then refuses a named preset
   * rather than creating a task without the composition the caller asked for.
   *
   * @param presetId - the requested preset id.
   * @returns the id to record, or why it cannot be used.
   */
  checkPreset?(
    presetId: string,
  ): Promise<{ readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string }>
  /** The preset the Host mounts when the caller names none, when it publishes one. */
  defaultPresetId?(): string | undefined
}

/** A refused request, with a stable code the caller can branch on. */
export class ConductorError extends Error {
  /**
   * @param code - stable machine-readable code.
   * @param message - operator-readable reason.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ConductorError'
  }
}

/** Request to create one logical task. */
export interface CreateTaskRequest {
  readonly operationId: string
  readonly controllerSessionId: string
  readonly title: string
  /** First instruction, dispatched after the environment becomes ready. */
  readonly instruction?: string
  /** Starting context mode of PRD §二.2.2. */
  readonly contextMode?: 'empty' | 'brief' | 'fork'
  /** Working directory for the new session. */
  readonly cwd?: string
  /** The Git starting state to prepare (PRD §二.4). */
  readonly workspace?: WorkspaceRequest
  /**
   * The Host preset to compose the new session with (PRD §二.3).
   *
   * Allowed here and at a fork, and nowhere else: a preset takes part in runtime assembly, so an existing
   * session cannot be recomposed — it moves to a successor session instead (`conductor_handoff`). Omitted
   * means the Host's own default, which is what every creation before this parameter existed got.
   */
  readonly preset?: string
  /** Explicit model for this new session; omission freezes the Host default when supported. */
  readonly selection?: ModelSelection
  /**
   * Opaque client-card capability supplied by the tool wrapper. It is never
   * model-facing and is persisted separately from the idempotent request
   * parameters so a replay keeps its original value.
   */
  readonly sessionLinkCapability?: string
}

/** Which starting state to prepare, and what it needs (PRD §二.4). */
export interface WorkspaceRequest {
  readonly strategy: StartStrategy
  /** The repository to start from, for the strategies that pin a commit. */
  readonly repoPath?: string | undefined
  /** A user-given reference, for `specific_rev`. */
  readonly rev?: string | undefined
  /** The directory the user explicitly chose, for `existing_directory` and `task_directory`. */
  readonly existingPath?: string | undefined
  /** Where a new worktree or task directory goes; the adapter supplies a default for a worktree. */
  readonly worktreePath?: string | undefined
  /** Which untracked paths a snapshot may carry; every other one is refused, not silently skipped. */
  readonly untrackedPaths?: readonly string[] | undefined
}

/**
 * A starting context the preparation phase produced, or could not.
 *
 * `ready` carries the text to queue; `unavailable` carries only a record whose `reason` explains
 * why nothing was queued. The distinction exists so the caller sees a missing Host ability as a
 * reported gap on a task that still exists, rather than as a failed creation.
 */
type PreparedContext =
  | { readonly kind: 'ready'; readonly text: string; readonly record: NonNullable<TaskRecord['context']> }
  | { readonly kind: 'unavailable'; readonly record: NonNullable<TaskRecord['context']> }

/**
 * One operation, as the `operation` family reports it (PRD §三.3).
 *
 * `task` is nested rather than flattened because the two are different facts with different
 * lifetimes: an operation's delivery settles once, while the task's preparation keeps moving. A
 * caller asking "how far has it got?" needs to see both without inferring one from the other —
 * which is the discipline of §三.4.
 */
export interface OperationStatus {
  readonly found: boolean
  readonly operationId: string
  readonly kind?: string
  readonly delivery?: string
  readonly withdrawn?: boolean
  readonly phase?: string
  readonly taskId?: string
  readonly messageId?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  /**
   * What caused this operation, when it was not a person (PRD §四.2).
   *
   * Reported so the association is readable, not merely stored: "why was this message sent to my
   * task?" is answered by the grant and the rule that produced it.
   */
  readonly attribution?: MessageSourceRecord
  /** The task's own preparation progress, when the operation names a readable task. */
  readonly task?: {
    readonly taskId: string
    readonly title: string
    readonly preparation: TaskRecord['preparation']
    readonly preparationPhase: TaskRecord['preparationPhase']
    readonly failureReason?: string
    readonly sessionId?: string
  }
  /** Whether this operation's preparation can still be cancelled, and why not when it cannot. */
  readonly cancellable?: boolean
  readonly cancellationRefusal?: string
  /** Set when the operation is not recorded. */
  readonly reason?: string
}

/** What cancelling a preparation did, and what it deliberately did not do. */
export interface PreparationCancellation {
  readonly taskId: string
  readonly operationId: string
  readonly preparation: 'cancelled'
  /** The phase preparation had reached; kept, because it is what the caller decides on next. */
  readonly preparationPhase: TaskRecord['preparationPhase']
  readonly alreadyCancelled: boolean
  /** True when an undelivered first instruction was withdrawn so a restart cannot send it. */
  readonly instructionWithdrawn: boolean
  /** What was created before the cancellation and is **kept** (PRD §二.2.1). */
  readonly kept: {
    readonly sessionId?: string
    readonly cwd?: string
    readonly start?: NonNullable<TaskRecord['start']>
    readonly originRepoPath?: string
    readonly workspaceId?: string
  }
  readonly summary: string
}

/**
 * Rebuild the preparation request a task was created with, from its operation record.
 *
 * The recorded parameters are the request that was actually made; taking them from the caller would
 * let a resume continue a half-remembered version of it, and PRD §四.1 makes the operation record
 * the authority on what a request was.
 *
 * @param record - the stored create or fork operation.
 * @param task - the task being resumed.
 * @returns the create request to continue with.
 */
function createRequestFrom(
  record: StoredOperationRecord,
  task: TaskRecord,
): CreateTaskRequest & { readonly sourceTaskId?: string } {
  const params = (record.params ?? {}) as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const value = params[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const workspace = params['workspace']
  const instruction = text('instruction')
  const cwd = text('cwd')
  const sourceTaskId = text('sourceTaskId')
  const preset = text('preset')
  const selection = selectionFromHeader({ config: params['selection'] })
  return {
    operationId: record.operationId,
    controllerSessionId: text('controllerSessionId') ?? task.controllerSessionId,
    title: text('title') ?? task.title,
    ...instruction === undefined ? {} : { instruction },
    ...cwd === undefined ? {} : { cwd },
    ...sourceTaskId === undefined ? {} : { sourceTaskId },
    ...preset === undefined ? {} : { preset },
    ...selection === undefined ? {} : { selection },
    ...workspace === null || workspace === undefined || typeof workspace !== 'object'
      ? {}
      : { workspace: workspace as WorkspaceRequest },
  }
}

/** Result of a create request. */
export interface CreateTaskResult {
  readonly taskId: string
  /**
   * The operation this request was recorded as (PRD §二.2.1).
   *
   * Returned rather than only accepted, because §二.2.1 has creation hand back "operationId 和逻辑
   * taskId" and §三.3 gives the `operation` family the job of reporting preparation progress. When
   * the caller supplies no id the tool substitutes the Host call id, and without echoing it back the
   * caller would have no way to ask about the operation it just started.
   */
  readonly operationId: string
  readonly preparation: TaskRecord['preparation']
  readonly preparationPhase: TaskRecord['preparationPhase']
  /** Host session now carrying the task, once one exists. */
  readonly sessionId?: string
  /** Set when preparation failed; the task record keeps the same reason. */
  readonly failureReason?: string
  /** True when this call replayed an earlier identical request. */
  readonly replayed: boolean
  /** Opaque native-card capability; callers render it only through presentation metadata. */
  readonly sessionLinkCapability?: string
  /**
   * What starting context the task actually got (PRD §二.2.2).
   *
   * Separate from the requested mode for the same reason `preparation` is separate from `accepted`:
   * a caller that asked for a brief needs to know whether it was built and whether the Host took
   * it, and `injected` deliberately does not claim the target ever consumed it.
   */
  readonly context?: TaskRecord['context']
  /**
   * What was prepared as the working directory, when a starting state was requested (PRD §二.4).
   *
   * Reported on the result rather than left for the caller to look up, because the caller is
   * usually the model: "which commit is this task pinned to, and did it get its own worktree"
   * is exactly what it needs to know before writing anything, and a claim that is only in the
   * store is a claim the model cannot check.
   */
  readonly workspace?: WorkspaceOutcome
  /**
   * Fork provenance (PRD §二.2.2): source task, source session, history cutoff.
   * Present on a successful fork; omitted on create/attach and on a fork that
   * failed before the cutoff was recorded.
   */
  readonly sourceTaskId?: string
  readonly sourceSessionId?: string
  readonly cutoffSeq?: number
}

/** The working directory a create or fork settled on, and how. */
export interface WorkspaceOutcome {  readonly strategy: StartStrategy
  /** The commit actually pinned; empty for the strategies that pin none. */
  readonly commit: string
  /** True when this conductor created the directory as a worktree. */
  readonly created: boolean
  /** The directory the task runs in. */
  readonly path?: string
  /** The project the directory was derived from, when it was derived from one. */
  readonly originRepoPath?: string
  /** The Host workspace the directory was registered as, when registration succeeded. */
  readonly workspaceId?: string
  /** Why registration did not happen or did not complete; absent when it did. */
  readonly failure?: string
}

/**
 * The fork provenance PRD §二.2.2 requires to be recorded *and shown*:
 * source task, source session, cutoff. Stored on the `fork-<taskId>` context
 * snapshot; returned here so a model does not have to look the record up.
 */
export type ForkOriginResult = {
  readonly sourceTaskId?: string
  readonly sourceSessionId?: string
  readonly cutoffSeq?: number
}

/** Request to dispatch text to an existing task. */
export interface SendRequest {
  readonly operationId: string
  readonly taskId: string
  readonly text: string
  readonly mode: SendMode
  /** The session asking; must be the task's current write controller. */
  readonly callerSessionId: string
  /** Internal stop-and-send fence, persisted so deferred dispatch still requires an idle target. */
  readonly requireIdle?: boolean
  readonly expectedOwnerEpoch?: number
  readonly expectedBindingVersion?: number
  /**
   * For the interrupt modes: the turn the caller observed, and how long to wait
   * for its end to be confirmed (PRD §二.6).
   */
  readonly expectedTurn?: number
  readonly expectedStartSeq?: number
  readonly confirmLimitMs?: number
  /**
   * What caused this dispatch, when it was not a person (PRD §四.2).
   *
   * A rule execution hands over `grantId`, `ruleId` and `sourceEventId`; the operation record keeps
   * them, so the message a target receives can be traced to the authorisation behind it.
   */
  readonly attribution?: MessageSourceRecord
}

/** One request to the queue surface (PRD §二.6, §三.3 `queue`). */
export interface QueueRequest {
  readonly operationId: string
  readonly taskId: string
  readonly callerSessionId: string
  readonly action: 'list' | 'edit' | 'withdraw'
  /** The unconsumed message to edit or withdraw. */
  readonly messageId?: string
  /** The replacement text, for `edit`. */
  readonly text?: string
  /**
   * The binding version the caller observed. A handoff that advanced it
   * refuses the change rather than editing the predecessor or the successor
   * under the old identity (PRD §二.10.2).
   */
  readonly expectedBindingVersion?: number
  /**
   * The write-control epoch the caller observed (PRD §三.2). A transfer that
   * advanced it refuses the change.
   */
  readonly expectedOwnerEpoch?: number
}

/** Result of a send request. */
export interface SendResult {
  readonly taskId: string
  readonly mode: SendMode
  /** Where the message stands. `accepted` means the Host took it; `pending` means it is kept for a free slot. */
  readonly delivery: 'accepted' | 'replayed' | 'pending'
  readonly messageId?: string
  /** Why a send was kept pending, when it was. */
  readonly reason?: string
}

/** A request to stop a turn, or to stop one and then send (PRD §二.6). */
export interface StopRequest {
  readonly operationId: string
  readonly taskId: string
  readonly callerSessionId: string
  /**
   * The turn the caller observed, from `conductor_read`.
   *
   * Supplying it is what makes the stop *exact*: a stop whose anchor no longer
   * matches the open turn is refused rather than retargeted. Omitting it stops
   * whatever turn is open, which the tool refuses to do without saying so.
   */
  readonly expectedTurn?: number
  readonly expectedStartSeq?: number
  /** Text to deliver once the expected turn has confirmed its end. */
  readonly text?: string
  readonly expectedOwnerEpoch?: number
  readonly expectedBindingVersion?: number
  /**
   * How long to wait for the matching turn end before reporting the stop unconfirmed.
   *
   * Omit to use the coordinator's configured ceiling (PRD §四.7, published 30s).
   */
  readonly confirmLimitMs?: number
}

/** Result of a stop request. */
export interface StopResult {
  readonly taskId: string
  /** What the stop reached. */
  readonly outcome: 'no_active_turn' | 'requested' | 'confirmed' | 'unconfirmed' | 'kept'
  /** The turn the caller expected, when it named one. */
  readonly expectedTurn?: number
  /** The turn the cancel was requested for. */
  readonly turn?: number
  /** The turn's end outcome, once it reported one. */
  readonly turnOutcome?: string
  /** Whether the caller's text was delivered. */
  readonly sent: boolean
  readonly messageId?: string
  readonly reason: string
  /** True when the caller's text was kept rather than delivered. */
  readonly keptText: boolean
}

/**
 * A request to cancel whatever turn is open, without waiting for it to end.
 *
 * This is the second of PRD §二.13.2's three actions: 按已授权策略请求取消当前轮次.
 * The confirmation wait belongs to a person asking to stop; a budget **requests**
 * the cancel and reports the actual state (`requested` or `no_active_turn`) rather
 * than blocking a background pass for thirty seconds.
 */
export interface TurnCancelRequest {
  readonly taskId: string
  /** Host-trusted controller identity; never a model-supplied id. */
  readonly callerSessionId: string
  /** Why the cancel was issued, recorded on the Host cancel cause. */
  readonly cause?: string
}

/** Result of requesting a turn cancel without waiting to confirm it. */
export interface TurnCancelResult {
  readonly taskId: string
  readonly outcome: 'requested' | 'no_active_turn'
  readonly reason: string
  readonly turn?: number
}

/** One unconsumed message (PRD §二.6, §三.3 `queue`). */
export interface QueuedMessage {
  readonly messageId: string
  readonly text: string
  /** `queue` waits for its own turn; `steering` enters the next step boundary. */
  readonly list: 'queue' | 'steering'
}

/** Result of reading or changing a task's unconsumed input. */
export interface QueueResult {
  readonly taskId: string
  readonly messages: QueuedMessage[]
  /** What the call changed, when it changed something. */
  readonly changed?: { readonly messageId: string; readonly action: 'edited' | 'withdrawn' | 'already_consumed' }
  readonly reason: string
}

/** Request to attach an existing Host session as a managed task. */
export interface AttachTaskRequest {
  readonly operationId: string
  readonly controllerSessionId: string
  /** The Host session to join. */
  readonly sessionId: string
  /** Conductor-side title; defaults to the session id. */
  readonly title?: string
  /** Directory recorded for display; the session's own directory is untouched. */
  readonly cwd?: string
}

/** Request to change a task's conductor-side organisation. */
export interface UpdateTaskRequest {
  readonly taskId: string
  readonly callerSessionId: string
  readonly title?: string
  readonly groupId?: string
  /** Remove the task from its group. */
  readonly clearGroup?: boolean
  readonly pinned?: boolean
  readonly archived?: boolean
  /**
   * The write-control epoch observed on this task. A transfer that landed in
   * between is refused rather than organising under a retired identity (PRD §三.2).
   */
  readonly expectedOwnerEpoch?: number
  /**
   * The binding version observed on this task. A handoff that moved it in
   * between is refused rather than organising the successor (PRD §三.2).
   */
  readonly expectedBindingVersion?: number
}

/** Request to fork a managed task's history into a new task. */
export interface ForkTaskRequest {
  readonly operationId: string
  readonly callerSessionId: string
  /** The task whose history is copied. */
  readonly sourceTaskId: string
  /** Copy only up to the completed turn containing this event. Defaults to the last one. */
  readonly atSeq?: number
  readonly title?: string
  /** Instruction for the new task, delivered once it is ready. */
  readonly instruction?: string
  /**
   * A starting state for the child's own directory (PRD §二.4, T05).
   *
   * A fork normally inherits the source's directory, which is right when the child continues the
   * same work. Forking into a **new worktree** is the case where it is not: the child is meant to
   * try something else, and doing that in the source's directory would have the two tasks editing
   * one tree. When this is set, the child gets the prepared directory instead, registered as its
   * own workspace, and the source directory is not touched.
   */
  readonly workspace?: WorkspaceRequest
  /**
   * A Host preset for the child, overriding the one inherited from the source (PRD §二.3).
   *
   * Omitting it is the documented default — 分叉继承源会话有效配置 — rather than a fallback, and the difference
   * matters: an inherited preset is resolved from the source's own log, so the child starts where the parent
   * actually ran rather than where its header says it was created. A named preset is checked against the
   * Host's roster before anything is created.
   */
  readonly preset?: string
  /** Explicit child model; omission freezes the source's effective next-request configuration. */
  readonly selection?: ModelSelection
  /** Opaque client-card capability supplied by the tool wrapper; see CreateTaskRequest. */
  readonly sessionLinkCapability?: string
  /**
   * The write-control epoch observed on the **source**. A transfer that landed
   * in between is refused rather than copying under a retired identity (PRD §三.2).
   */
  readonly expectedOwnerEpoch?: number
  /**
   * The binding version observed on the **source**. A handoff that moved the
   * source in between is refused rather than copying the successor (PRD §三.2).
   */
  readonly expectedBindingVersion?: number
}

/**
 * Create, address and drive logical tasks.
 */
export class Coordinator {
  /**
   * @param deps - the Host surface and clock this coordinator runs against.
   */
  constructor(private readonly deps: CoordinatorDeps) {}

  /**
   * Check a requested preset against the Host's roster before anything is assembled (PRD §二.3).
   *
   * Three answers, kept apart because they are three different situations: no preset requested (the Host's
   * own default applies, which is what every creation did before this parameter existed), a preset the
   * roster offers, and one it does not — or one it offers but calls **broken**, which is the roster's own
   * word for a directory that holds the id and cannot be assembled.
   *
   * @param requested - the preset the caller named, when they named one.
   * @returns the id to record and mount, or undefined for the Host's default.
   * @throws {ConductorError} when the preset cannot be used, so the preparation fails with the reason.
   */
  private async checkedPreset(requested: string | undefined): Promise<string | undefined> {
    if (requested === undefined) return undefined
    const presets = this.deps.presets
    const check = presets?.checkPreset
    if (presets === undefined || check === undefined) {
      throw new ConductorError(
        'PRESET_UNAVAILABLE',
        `preset "${requested}" was requested, but this Host composition mounts no preset roster the conductor `
        + 'can check it against. Nothing was created: composing the session without the preset the caller asked '
        + 'for would record a task whose configuration is not the one that was requested.',
      )
    }
    const checked = await check.call(presets, requested)
    if (!checked.ok) throw new ConductorError('PRESET_UNAVAILABLE', checked.reason)
    return checked.id
  }

  /** Freeze the defaults/source state once, before asynchronous environment preparation. */
  private async freezeConfiguration(
    taskId: string,
    request: { readonly preset?: string | undefined; readonly selection?: ModelSelection },
    sourceSessionId?: string,
  ): Promise<void> {
    if (this.deps.store.getTask(taskId)?.configurationSnapshot !== undefined) return
    const port = this.deps.models
    if (request.selection !== undefined && port === undefined) {
      throw new ConductorError('MODEL_SELECTION_UNAVAILABLE', 'an explicit creation model requires the callable companion Host writer and reader')
    }
    const desiredPreset = request.preset ?? (sourceSessionId === undefined ? this.deps.presets?.defaultPresetId?.() : undefined)
    const pendingSelection = request.selection !== undefined ? Promise.resolve(request.selection)
      : port === undefined ? Promise.resolve(undefined)
      : sourceSessionId === undefined ? port.defaultSelection() : port.stateForSession(sourceSessionId).then(state => state.selection)
    const [preset, selected] = await Promise.all([sourceSessionId === undefined ? this.checkedPreset(desiredPreset) : Promise.resolve(desiredPreset), pendingSelection])
    const selection = selected === undefined ? undefined : await port?.resolve(selected) ?? selected
    if (selection !== undefined && selectionFromHeader({ config: selection }) === undefined) {
      throw new ConductorError('MODEL_STATE_UNCONFIRMED', 'Host did not return a valid configuration to freeze')
    }
    await this.deps.store.updateTask(taskId, task => ({ ...task,
      configurationSnapshot: task.configurationSnapshot ?? {
        ...selection === undefined ? {} : { selection: { ...selection } },
        origin: selection === undefined ? 'unavailable' : request.selection !== undefined ? 'explicit' : sourceSessionId === undefined ? 'host_default' : 'source_session',
        ...preset === undefined ? {} : { preset },
        capturedAt: this.deps.now(), modelApplied: false,
      },
    }))
  }

  /** Apply the frozen selection before waking input; read reconciles an earlier lost acknowledgement. */
  private async applyFrozenConfiguration(taskId: string, sessionId: string): Promise<void> {
    const frozen = this.deps.store.getTask(taskId)?.configurationSnapshot
    if (frozen?.selection === undefined || frozen.modelApplied) return
    const port = this.deps.models
    if (port === undefined) throw new ConductorError('MODEL_SELECTION_UNAVAILABLE', 'the frozen model needs the companion Host writer and reader before preparation can finish')
    let normalized: ModelSelection
    if (frozen.modelWriteStarted) {
      const actual = await port.stateForSession(sessionId)
      if (!actual.persisted || actual.selection.provider !== frozen.selection.provider || actual.selection.model !== frozen.selection.model
        || actual.selection.reasoningEffort !== frozen.selection.reasoningEffort) {
        throw new ConductorError('MODEL_STATE_UNCONFIRMED', 'an earlier model write has no matching durable Host acknowledgement; it was not repeated')
      }
      normalized = actual.selection
    } else {
      await this.deps.store.updateTask(taskId, task => ({ ...task, configurationSnapshot: { ...frozen, modelWriteStarted: true } }))
      normalized = await port.apply(sessionId, frozen.selection)
    }
    await this.deps.store.updateTask(taskId, task => ({ ...task,
      configurationSnapshot: { ...frozen, selection: { ...normalized }, modelApplied: true },
    }))
  }

  /**
   * Create one logical task and, when an instruction is given, dispatch it.
   *
   * The task and its control record are persisted before anything is created,
   * so a crash mid-preparation leaves a record that says what was attempted and
   * how far it got (PRD §二.2.1). Nothing already created is deleted on failure.
   *
   * @param request - the create request.
   * @returns the task's identity and the phase it reached.
   * @throws {ConductorError} with code `OPERATION_CONFLICT` when the operation id was reused.
   */
  async createTask(request: CreateTaskRequest): Promise<CreateTaskResult> {
    const contextMode = request.contextMode ?? DEFAULT_CONTEXT_MODE
    const sessionLinkCapability = sessionLinkCapabilityOf(request.sessionLinkCapability)
    this.refuseOverManagedTargetLimit(request.controllerSessionId, request.operationId)
    // The task id is minted before the claim so the operation record can carry
    // it from the start. Minting it does not create anything: the record is
    // only written once the claim succeeds.
    const taskId = this.deps.newTaskId()
    const claim = await this.deps.store.beginOperation({
      operationId: request.operationId,
      kind: 'create',
      dispatchGuard: { ownerSessionId: request.controllerSessionId, ownerEpoch: 0, bindingVersion: 1 },
      params: {
        controllerSessionId: request.controllerSessionId,
        title: request.title,
        contextMode,
        cwd: request.cwd ?? null,
        // Empty text has the same no-initial-turn semantics as omission. Keep
        // that equivalence in the persisted digest too, so a safe replay does
        // not conflict merely because one caller serialized the absent value
        // as an empty string.
        instruction: hasInitialInstruction(request.instruction) ? request.instruction : null,
        // Part of the digest on purpose: retrying the same operationId with a different starting
        // state is a different request, and silently replaying the first one would hand back a
        // task pinned to a commit the caller did not ask for.
        workspace: request.workspace ?? null,
        // Left `undefined` when no preset was named rather than written as `null`, and the difference is
        // deliberate: the canonical form drops undefined members, so a create that names no preset digests
        // exactly as it did before this parameter existed. Writing `null` here would have changed the digest
        // of every ordinary creation — the compatibility cost C209 records — for a field it does not use.
        preset: request.preset,
        selection: request.selection,
      },
      ...sessionLinkCapability === undefined ? {} : { sessionLinkCapability },
      taskId,
    })
    if (claim.kind === 'conflict') {
      throw new ConductorError('OPERATION_CONFLICT', claim.reason)
    }
    if (claim.kind === 'replay') {
      // A retried creation is not a second creation. Report where the original
      // got to instead of minting another session.
      const originalId = claim.record.taskId
      const task = originalId === undefined ? undefined : this.deps.store.getTask(originalId)
      if (task === undefined) {
        throw new ConductorError(
          'OPERATION_UNKNOWN',
          `operation ${request.operationId} was accepted but its task is not readable`,
        )
      }
      const bound = this.boundSession(task.currentBindingId)
      const binding = task.currentBindingId === undefined
        ? undefined
        : this.deps.store.getBinding(task.currentBindingId)
      return {
        taskId: task.taskId,
        operationId: request.operationId,
        preparation: task.preparation,
        preparationPhase: task.preparationPhase,
        replayed: true,
        ...claim.record.sessionLinkCapability === undefined ? {} : { sessionLinkCapability: claim.record.sessionLinkCapability },
        ...bound,
        ...task.failureReason === undefined ? {} : { failureReason: task.failureReason },
        ...this.workspaceSummary(task, binding?.cwd),
        ...task.context === undefined ? {} : { context: task.context },
      }
    }

    const stamp = this.deps.now()
    await this.deps.store.createTask({
      taskId,
      title: request.title,
      pinned: false,
      archived: false,
      controllerSessionId: request.controllerSessionId,
      requestedBy: 'user',
      contextMode,
      preparation: 'accepted',
      preparationPhase: 'accepted',
      createdAt: stamp,
      updatedAt: stamp,
    })
    await this.deps.store.putAccess({
      taskId,
      ownerSessionId: request.controllerSessionId,
      ownerEpoch: 0,
      observerSessionIds: [],
      updatedAt: stamp,
    })

    try {
      await this.inheritedEnvironment(request)
      await this.freezeConfiguration(taskId, request)
      const prepared = await this.prepare(request, taskId, contextMode)
      return {
        ...prepared,
        ...sessionLinkCapability === undefined ? {} : { sessionLinkCapability },
      }
    } catch (error) {
      const failureReason = describeFailure(error)
      // A cancellation is not a failure (PRD §二.2.1 lists them as separate preparation states), and
      // the phase reached is kept either way: the record says how far preparation got before it
      // stopped, which is what makes "已创建目录和会话保留并报告" checkable later.
      const cancelled = this.deps.store.getTask(taskId)?.preparation === 'cancelled'
      if (!cancelled) {
        await this.deps.store.updateTask(taskId, current => ({
          ...current,
          preparation: current.preparation === 'cancelled' ? 'cancelled' : 'failed',
          failureReason,
        }))
        await this.deps.store.markDelivery(request.operationId, 'failed', 'preparation_failed')
      }
      const task = this.deps.store.getTask(taskId)
      return {
        taskId,
        operationId: request.operationId,
        preparation: cancelled ? 'cancelled' : 'failed',
        preparationPhase: task?.preparationPhase ?? 'accepted',
        failureReason,
        replayed: false,
        ...sessionLinkCapability === undefined ? {} : { sessionLinkCapability },
        ...this.boundSession(task?.currentBindingId),
        // A failed starting state still reports which strategy was attempted. The alternative —
        // omitting it — would make "preparation failed before any directory existed" and "prepared
        // in the default directory" indistinguishable to the caller.
        ...this.workspaceSummary(task, undefined),
      }
    }
  }

  /**
   * Fork a managed task's completed history into a new logical task.
   *
   * The fork is a **new task**, never a continuation of the same one (PRD §一.2),
   * and it inherits none of the source's control authority: the child's control
   * record starts fresh under the caller, and nothing about grants, timers or
   * workflow runs is carried across because none of it is copied. What is copied
   * is the completed-turn prefix of the source's log, which is what makes the
   * child able to continue the discussion rather than start cold.
   *
   * @param request - the fork request.
   * @returns the new task.
   * @throws {ConductorError} on a conflict, an unknown source, or a source with
   * nothing finished to fork.
   */
  async forkTask(request: ForkTaskRequest): Promise<CreateTaskResult> {
    const sessionLinkCapability = sessionLinkCapabilityOf(request.sessionLinkCapability)
    // Fork copies the source's completed history into a new task the caller then
    // controls. That is a write against the source, not a read: an observer, a
    // retired controller, or a pin that named a retired epoch/binding must not
    // mint the child (PRD §一.3 写控制者, §三.2 MutationContext). Checked before
    // beginOperation so a refused fork leaves no operation record.
    const sourceTask = this.requireControlledTask(request.sourceTaskId, request.callerSessionId)
    const access = this.deps.store.getAccess(request.sourceTaskId)
    if (request.expectedOwnerEpoch !== undefined && access !== undefined
      && access.ownerEpoch !== request.expectedOwnerEpoch) {
      throw new ConductorError(
        'STALE_OWNER_EPOCH',
        `control of task ${request.sourceTaskId} is at epoch ${String(access.ownerEpoch)}, not ${String(request.expectedOwnerEpoch)}`,
      )
    }
    const sourceBinding = sourceTask.currentBindingId === undefined
      ? undefined
      : this.deps.store.getBinding(sourceTask.currentBindingId)
    if (sourceBinding === undefined) {
      throw new ConductorError('NO_BINDING', `task ${request.sourceTaskId} has no session bound to it`)
    }
    if (request.expectedBindingVersion !== undefined && sourceBinding.version !== request.expectedBindingVersion) {
      throw new ConductorError(
        'STALE_BINDING',
        `task ${request.sourceTaskId} is bound at version ${String(sourceBinding.version)}, not ${String(request.expectedBindingVersion)}`,
      )
    }
    const source = (this.deps.agents as unknown as { get(id: unknown): { session: { header: unknown; events: readonly SessionEventLike[] } } | undefined })
      .get(sourceBinding.sessionId)
    if (source === undefined) {
      throw new ConductorError(
        'TARGET_UNAVAILABLE',
        `the session bound to task ${request.sourceTaskId} (${sourceBinding.sessionId}) is not live in this Host, `
        + 'and a fork copies from the live session',
      )
    }

    const events = source.session.events
    const cut = computeForkCut(events, request.atSeq)
    if ('error' in cut) throw new ConductorError('FORK_UNAVAILABLE', cut.error)

    const taskId = this.deps.newTaskId()
    this.refuseOverManagedTargetLimit(request.callerSessionId, request.operationId)
    const claim = await this.deps.store.beginOperation({
      operationId: request.operationId,
      kind: 'fork',
      dispatchGuard: { ownerSessionId: request.callerSessionId, ownerEpoch: 0, bindingVersion: 1 },
      params: {
        sourceTaskId: request.sourceTaskId,
        atSeq: request.atSeq ?? null,
        title: request.title ?? null,
        // See create: a blank initial instruction is an idle child, and must
        // have the same operation identity as an omitted instruction.
        instruction: hasInitialInstruction(request.instruction) ? request.instruction : null,
        workspace: request.workspace ?? null,
        preset: request.preset,
        selection: request.selection,
        ...request.expectedOwnerEpoch === undefined ? {} : { expectedOwnerEpoch: request.expectedOwnerEpoch },
        ...request.expectedBindingVersion === undefined
          ? {}
          : { expectedBindingVersion: request.expectedBindingVersion },
      },
      ...sessionLinkCapability === undefined ? {} : { sessionLinkCapability },
      taskId,
    })
    if (claim.kind === 'conflict') {
      throw new ConductorError('OPERATION_CONFLICT', claim.reason)
    }
    if (claim.kind === 'replay') {
      const originalId = claim.record.taskId
      const task = originalId === undefined ? undefined : this.deps.store.getTask(originalId)
      if (task === undefined) {
        throw new ConductorError('OPERATION_UNKNOWN', `operation ${request.operationId} has no readable task`)
      }
      return {
        taskId: task.taskId,
        operationId: request.operationId,
        preparation: task.preparation,
        preparationPhase: task.preparationPhase,
        replayed: true,
        ...claim.record.sessionLinkCapability === undefined ? {} : { sessionLinkCapability: claim.record.sessionLinkCapability },
        ...this.boundSession(task.currentBindingId),
        ...this.workspaceSummary(task, undefined),
        ...this.forkOriginFields(task.taskId),
      }
    }

    const stamp = this.deps.now()
    await this.deps.store.createTask({
      taskId,
      title: request.title ?? `Fork of ${sourceTask.title}`,
      pinned: false,
      archived: false,
      controllerSessionId: request.callerSessionId,
      requestedBy: 'user',
      contextMode: 'fork',
      preparation: 'accepted',
      preparationPhase: 'accepted',
      sourceTaskId: request.sourceTaskId,
      createdAt: stamp,
      updatedAt: stamp,
    })
    await this.deps.store.putAccess({
      taskId,
      ownerSessionId: request.callerSessionId,
      ownerEpoch: 0,
      observerSessionIds: [],
      updatedAt: stamp,
    })

    try {
      await this.inheritedEnvironment({ operationId: request.operationId, controllerSessionId: request.callerSessionId, workspace: request.workspace })
      // PRD §二.3's 分叉 row: a fork **inherits the source session's effective configuration**, and a caller
      // may name one instead — the second of the only two points at which a preset may be chosen. Inheriting
      // is the default rather than a fallback: the source's own preset is resolved from its log (a later
      // `agent-preset/selected` overrides the header), so the child starts where the parent actually ran.
      const inherited = this.deps.presets?.presetOf({ header: source.session.header, events })
      const requested = request.preset
      const presetId = requested === undefined ? inherited : await this.checkedPreset(requested)
      await this.freezeConfiguration(taskId, { ...request, preset: presetId }, sourceBinding.sessionId)
      // The child's directory is prepared before the session exists, exactly as in creation: a
      // worktree that cannot be made fails the fork rather than running the child in the source's
      // tree, where its edits would land on work the parent task still owns.
      const inheritedEnvironment = await this.inheritedEnvironment({ operationId: request.operationId, controllerSessionId: request.callerSessionId, workspace: request.workspace })
      const prepared = await this.prepareWorkspace(request.workspace, taskId)
      const cwd = prepared.cwd ?? inheritedEnvironment?.cwd ?? sourceBinding.cwd
      const sessionId = SessionId(this.deps.newSessionId())
      const seed = events.slice(0, cut.seedLength)
      await this.deps.agents.create({
        sessionId,
        seed,
        meta: {
          parentSession: SessionId(sourceBinding.sessionId),
          seedLength: cut.seedLength,
          ...cwd === undefined ? {} : { cwd },
          ...presetId === undefined ? {} : { agentPreset: presetId },
        },
        ...presetId === undefined ? {} : {
          setup: async (agentCtx: unknown) => { await this.deps.presets?.mount(agentCtx, presetId) },
        },
      })
      if (presetId !== undefined) {
        // Recorded after the session exists, for the same reason as in creation: the field means the
        // composition this task actually got. An inherited preset is recorded too — it *is* the child's
        // configuration, and leaving it unrecorded would make an inherited and a defaulted child look alike.
        await this.deps.store.updateTask(taskId, current => ({ ...current, preset: presetId, updatedAt: this.deps.now() }))
      }

      await this.deps.store.putBinding({
        bindingId: this.deps.newBindingId(),
        taskId,
        hostId: sourceBinding.hostId,
        sessionId: String(sessionId),
        version: 1,
        ...cwd === undefined ? {} : { cwd },
        createdAt: this.deps.now(),
      })
      await this.applyFrozenConfiguration(taskId, String(sessionId))
      await this.nameCreatedSession(taskId, request.operationId, this.deps.agents.get(sessionId)!, this.deps.store.getTask(taskId)!.title)
      await this.attachInheritedWorkspace(taskId, String(sessionId), inheritedEnvironment)
      await this.deps.store.updateTask(taskId, current => ({
        ...current,
        preparation: 'ready',
        preparationPhase: 'ready',
      }))

      // T05: the child's directory is its own workspace, and the project it came from stays
      // recorded on the task. A fork that reported "workspace ownership correct" without this
      // would be claiming the Host groups the child under the right folder when it does not.
      if (prepared.workspaceDirectory !== undefined) {
        if (this.deps.workspaces === undefined) {
          await this.deps.store.updateTask(taskId, current => ({
            ...current,
            workspaceFailure: 'this Host composition mounts no workspace registry (ctx.workspaceRegistry), so '
              + `${prepared.workspaceDirectory} was not registered as a workspace. The child runs in it regardless; `
              + 'the association with the original project is recorded on the task.',
          }))
        } else {
          await this.registerWorkspace(taskId, prepared.workspaceDirectory, request.title ?? sourceTask.title, String(sessionId))
        }
      }

      // The cut is recorded so a later reader can tell exactly how much history
      // the child carries and where it stops.
      await this.deps.store.putContext({
        snapshotId: `fork-${taskId}`,
        sourceTaskId: request.sourceTaskId,
        sourceSessionId: sourceBinding.sessionId,
        cutoffSeq: cut.boundarySeq,
        contentVersion: 0,
        contentDigest: paramDigest('fork', { seedLength: cut.seedLength }),
        deliveredToTaskId: taskId,
        createdAt: this.deps.now(),
      })

      if (hasInitialInstruction(request.instruction)) {
        await this.flushPendingDispatches()
      } else {
        // PRD §二.2.2: with no new instruction the fork finishes idle.
        await this.deps.store.markDelivery(request.operationId, 'accepted', 'ready')
      }

      const forked = this.deps.store.getTask(taskId)
      return {
        taskId,
        operationId: request.operationId,
        preparation: 'ready',
        preparationPhase: forked?.preparationPhase ?? 'ready',
        sessionId: String(sessionId),
        replayed: false,
        ...sessionLinkCapability === undefined ? {} : { sessionLinkCapability },
        ...this.workspaceSummary(forked, cwd),
        ...this.forkOriginFields(taskId),
      }
    } catch (error) {
      const failureReason = describeFailure(error)
      await this.deps.store.updateTask(taskId, current => ({
        ...current,
        preparation: 'failed',
        failureReason,
      }))
      await this.deps.store.markDelivery(request.operationId, 'failed', 'fork_failed')
      return {
        taskId,
        operationId: request.operationId,
        preparation: 'failed',
        preparationPhase: 'creating_session',
        failureReason,
        replayed: false,
        ...sessionLinkCapability === undefined ? {} : { sessionLinkCapability },
        ...this.boundSession(this.deps.store.getTask(taskId)?.currentBindingId),
        ...this.workspaceSummary(this.deps.store.getTask(taskId), undefined),
      }
    }
  }

  /**
   * Attach an existing Host session as a managed task (PRD §二.1, T01).
   *
   * Joining does not touch the session: no message is sent, no history is
   * rewritten, and the session's own working directory and history stay exactly
   * as they were. What changes is the conductor's record — a logical task now
   * points at that session, so the session's later turns can be observed and
   * addressed through the conductor.
   *
   * @param request - the attach request.
   * @returns the created task.
   * @throws {ConductorError} on a conflict, or when the session is already managed.
   */
  async attachTask(request: AttachTaskRequest): Promise<CreateTaskResult> {
    const existingTask = this.taskForSession(request.sessionId)
    if (existingTask !== undefined) {
      throw new ConductorError(
        'ALREADY_MANAGED',
        `session ${request.sessionId} is already managed as task ${existingTask}`,
      )
    }
    this.refuseOverManagedTargetLimit(request.controllerSessionId, request.operationId)
    const taskId = this.deps.newTaskId()
    const claim = await this.deps.store.beginOperation({
      operationId: request.operationId,
      kind: 'attach',
      params: {
        sessionId: request.sessionId,
        controllerSessionId: request.controllerSessionId,
        title: request.title ?? null,
      },
      taskId,
    })
    if (claim.kind === 'conflict') {
      throw new ConductorError('OPERATION_CONFLICT', claim.reason)
    }
    if (claim.kind === 'replay') {
      const originalId = claim.record.taskId
      const task = originalId === undefined ? undefined : this.deps.store.getTask(originalId)
      if (task === undefined) {
        throw new ConductorError('OPERATION_UNKNOWN', `operation ${request.operationId} has no readable task`)
      }
      return {
        taskId: task.taskId,
        operationId: request.operationId,
        preparation: task.preparation,
        preparationPhase: task.preparationPhase,
        replayed: true,
        ...this.boundSession(task.currentBindingId),
      }
    }

    const stamp = this.deps.now()
    await this.deps.store.createTask({
      taskId,
      title: request.title ?? request.sessionId,
      pinned: false,
      archived: false,
      controllerSessionId: request.controllerSessionId,
      requestedBy: 'user',
      contextMode: 'empty',
      preparation: 'ready',
      preparationPhase: 'ready',
      createdAt: stamp,
      updatedAt: stamp,
    })
    await this.deps.store.putAccess({
      taskId,
      ownerSessionId: request.controllerSessionId,
      ownerEpoch: 0,
      observerSessionIds: [],
      updatedAt: stamp,
    })
    await this.deps.store.putBinding({
      bindingId: this.deps.newBindingId(),
      taskId,
      hostId: 'local',
      sessionId: request.sessionId,
      version: 1,
      ...request.cwd === undefined ? {} : { cwd: request.cwd },
      createdAt: stamp,
    })
    await this.deps.store.markDelivery(request.operationId, 'accepted', 'joined_existing_session')
    return {
      taskId,
      operationId: request.operationId,
      preparation: 'ready',
      preparationPhase: 'ready',
      sessionId: request.sessionId,
      replayed: false,
    }
  }

  /**
   * Change a task's conductor-side organisation (PRD §二.5).
   *
   * A requested title also uses the public Host title service. Other organization is plugin bookkeeping:
   * archiving marks the conductor's own
   * collection and never calls the Host's one-way archive. It does not stop
   * execution, cancel authorised plans, delete data, or silence necessary notices
   * (PRD §二.5 / T15).
   *
   * @param request - the update request.
   * @returns the stored task.
   * @throws {ConductorError} when the task does not exist or the caller is not its controller.
   */
  async updateTask(request: UpdateTaskRequest): Promise<TaskRecord> {
    const task = this.requireControlledTask(request.taskId, request.callerSessionId)
    const access = this.deps.store.getAccess(request.taskId)
    if (request.expectedOwnerEpoch !== undefined && access !== undefined
      && access.ownerEpoch !== request.expectedOwnerEpoch) {
      throw new ConductorError(
        'STALE_OWNER_EPOCH',
        `control of task ${request.taskId} is at epoch ${String(access.ownerEpoch)}, not ${String(request.expectedOwnerEpoch)}`,
      )
    }
    if (request.expectedBindingVersion !== undefined) {
      const binding = task.currentBindingId === undefined
        ? undefined
        : this.deps.store.getBinding(task.currentBindingId)
      if (binding === undefined) {
        throw new ConductorError('NO_BINDING', `task ${request.taskId} has no session bound to it`)
      }
      if (binding.version !== request.expectedBindingVersion) {
        throw new ConductorError(
          'STALE_BINDING',
          `task ${request.taskId} is bound at version ${String(binding.version)}, not ${String(request.expectedBindingVersion)}`,
        )
      }
    }
    let title = request.title
    if (title !== undefined && this.deps.setSessionTitle !== undefined) {
      const binding = this.currentBinding(task.taskId)
      if (binding !== undefined && binding.hostId !== 'local' && binding.hostId !== this.deps.localHostId) throw new ConductorError('REMOTE_NAMING_UNAVAILABLE', 'native title changes require the task session on this Host')
      const agent = binding === undefined ? undefined : this.deps.agents.get(SessionId(binding.sessionId))
      if (agent === undefined) throw new ConductorError('SESSION_NOT_LIVE', 'the task session must be live before its native title can be changed')
      title = await this.deps.setSessionTitle(agent, title)
    }
    const next = await this.deps.store.updateTask(task.taskId, current => ({
      ...current,
      ...title === undefined ? {} : { title },
      ...request.groupId === undefined ? {} : { groupId: request.groupId },
      ...request.clearGroup === true ? { groupId: undefined } : {},
      ...request.pinned === undefined ? {} : { pinned: request.pinned },
      ...request.archived === undefined ? {} : { archived: request.archived },
    }))
    return next
  }

  /**
   * Release management of a task (PRD §二.5).
   *
   * PRD §二.5: releasing stops the monitoring that depends on this relationship
   * and blocks new automatic actions through it — but already accepted input is
   * **not** withdrawn. So the control record is marked rather than deleted: the
   * session keeps running, the operation history stays readable, and every
   * write path that checks control stops accepting new work for this task.
   *
   * @param taskId - the task to release.
   * @param callerSessionId - the session releasing it.
   * @returns the updated control record.
   * @throws {ConductorError} when the task is unknown or the caller is not its controller.
   */
  async detachTask(taskId: string, callerSessionId: string): Promise<AccessRecord> {
    this.requireControlledTask(taskId, callerSessionId)
    const access = this.deps.store.getAccess(taskId)
    if (access === undefined) {
      throw new ConductorError('NO_ACCESS', `task ${taskId} has no control record`)
    }
    return this.deps.store.putAccess({ ...access, detachedAt: this.deps.now(), updatedAt: this.deps.now() })
  }

  /**
   * Find the task currently managing one session, if any.
   * @param sessionId - the Host session id.
   * @returns the managing task id, or undefined.
   */
  taskForSession(sessionId: string): string | undefined {
    for (const task of this.deps.store.listTasks()) {
      if (task.currentBindingId === undefined) continue
      if (this.deps.store.getBinding(task.currentBindingId)?.sessionId === sessionId) return task.taskId
    }
    return undefined
  }

  /**
   * Check that a session holds write control of a task, and return the task.
   *
   * Public because the model-configuration surface needs the same gate as every other mutating
   * operation: it accepted a caller id and never checked it, so any session could ask to
   * reconfigure a task it does not control (PRD §一.3, §二.10.1). Reusing this method is what stops
   * a second, subtly different gate from growing beside the first.
   *
   * @param taskId - the logical task.
   * @param callerSessionId - the session asking, taken from the Host's trusted context.
   * @returns the task record.
   * @throws {ConductorError} when the task is unknown, released, or controlled by another session.
   */
  requireController(taskId: string, callerSessionId: string): TaskRecord {
    return this.requireControlledTask(taskId, callerSessionId)
  }

  /**
   * Refuse a *new* create, attach or fork when this controller already owns the
   * configured number of managed targets (PRD §四.7).
   *
   * A retry of an operation that already exists is not a new target — the
   * replay path must still return the original — so an operation id that is
   * already on file skips the ceiling. Released management frees a slot.
   *
   * @param ownerSessionId - the session that would own the new task.
   * @param operationId - the request's stable id.
   * @throws {ConductorError} `MANAGED_TARGET_LIMIT` when the slot is taken.
   */
  private refuseOverManagedTargetLimit(ownerSessionId: string, operationId: string): void {
    if (this.deps.store.getOperation(operationId) !== undefined) return
    const limit = this.deps.managedTargetLimit ?? DEFAULTS.managedTargetLimit
    const count = countManagedTargets(this.deps.store.listAccess(), ownerSessionId)
    const reason = managedTargetLimitReason(count, limit, ownerSessionId)
    if (reason !== undefined) {
      throw new ConductorError('MANAGED_TARGET_LIMIT', reason)
    }
  }

  private requireControlledTask(taskId: string, callerSessionId: string): TaskRecord {
    const task = this.deps.store.getTask(taskId)
    if (task === undefined) {
      throw new ConductorError('TASK_NOT_FOUND', `no managed task ${taskId}`)
    }
    const access = this.deps.store.getAccess(taskId)
    const refusal = writeControlRefusal(access, taskId, callerSessionId)
    if (refusal !== undefined) {
      throw new ConductorError(refusal.code, refusal.reason)
    }
    return task
  }

  /**
   * Resolve a task's current session id, for a result that reports where the
   * task ended up.
   * @param bindingId - the task's current binding id, when it has one.
   * @returns `{ sessionId }`, or an empty object when no session exists yet.
   */
  private boundSession(bindingId: string | undefined): { sessionId?: string } {
    if (bindingId === undefined) return {}
    const sessionId = this.deps.store.getBinding(bindingId)?.sessionId
    return sessionId === undefined ? {} : { sessionId }
  }

  /**
   * The source task, source session and cutoff a fork recorded (PRD §二.2.2).
   *
   * @param taskId - the child task.
   * @returns fields to spread onto a create/fork result, or empty when no snapshot exists.
   */
  private forkOriginFields(taskId: string): ForkOriginResult {
    return forkOriginFieldsOf(forkOriginOf(this.deps.store.getContext(`fork-${taskId}`)))
  }

  /**
   * Read a task's current binding, when it has one.
   *
   * Used by a resumed preparation, which must reuse the session a previous attempt already created
   * rather than making a second one (PRD §二.2.1: a cancelled or failed preparation keeps what it
   * created).
   *
   * @param taskId - the logical task.
   * @returns the binding record, or undefined when the task has none.
   */
  private currentBinding(taskId: string): BindingRecord | undefined {
    const bindingId = this.deps.store.getTask(taskId)?.currentBindingId
    return bindingId === undefined ? undefined : this.deps.store.getBinding(bindingId)
  }

  /**
   * Walk the preparation phases of PRD §二.2.1 and finish `ready`, dispatching
   * the first instruction when one was given.
   *
   * @param request - the originating create request.
   * @param taskId - the task being prepared.
   * @param contextMode - the recorded context mode.
   * @returns the result the caller sees.
   */
  private async prepare(
    request: CreateTaskRequest,
    taskId: string,
    contextMode: TaskRecord['contextMode'],
  ): Promise<CreateTaskResult> {
    /**
     * Move the preparation to its next phase, **unless the user cancelled it** (PRD §二.2.1).
     *
     * The check is a read of the durable record rather than an in-memory flag, because a cancel
     * arrives through its own Host call and this preparation is suspended at each of these `await`s
     * while it runs: an in-memory marker would be invisible to it, and a coordinator instance is
     * built per call. Reading the record is what makes "取消准备" mean something for a preparation
     * that is already in flight — the remaining phases stop, and what was already created stays.
     */
    const advance = async (preparation: TaskRecord['preparation'], phase: TaskRecord['preparationPhase']): Promise<void> => {
      let cancelled = false
      await this.deps.store.updateTask(taskId, current => {
        cancelled = current.preparation === 'cancelled'
        return cancelled ? current : { ...current, preparation, preparationPhase: phase }
      })
      if (cancelled) {
        throw new ConductorError(
          'PREPARATION_CANCELLED',
          `preparation of task ${taskId} was cancelled while it was running, so it stopped at `
          + `${phase}. Nothing already created was removed: the task record keeps the phase it reached, and any `
          + 'session or directory that was already made is still there and is reported.',
        )
      }
    }

    // A resumed preparation reuses what exists. PRD §二.2.1 says a cancelled or failed preparation
    // keeps "已创建目录和会话", and creating a second session (or a second worktree) while resuming
    // would both duplicate the resources and leave the first one orphaned.
    const inheritedEnvironment = await this.inheritedEnvironment(request)
    const existingBinding = this.currentBinding(taskId)
    await this.freezeConfiguration(taskId, request)
    const frozen = this.deps.store.getTask(taskId)?.configurationSnapshot
    const resuming = existingBinding !== undefined && this.deps.agents.get(SessionId(existingBinding.sessionId)) !== undefined
    if (existingBinding !== undefined && !resuming) {
      throw new ConductorError('SESSION_NOT_LIVE', `task ${taskId} already has session ${existingBinding.sessionId}; restore that session in the Host before resuming. No replacement session was created.`)
    }

    if (resuming) {
      await advance('preparing', 'creating_session')
    } else {
      await advance('preparing', 'preparing_workspace')
      // PRD §二.4. When a starting state was asked for, the phase either produces the directory the
      // task runs in or fails the preparation with the reason: there is deliberately no branch here
      // that falls back to the caller's own directory, because that is the fallback the
      // specification forbids — running work in the user's tree because a worktree could not be made.
      const prepared = await this.prepareWorkspace(request.workspace, taskId)
      const preparedCwd = prepared.cwd ?? request.cwd ?? inheritedEnvironment?.cwd ?? this.deps.defaultCwd()

      await advance('preparing', 'preparing_context')
      // PRD §二.2.2. `brief` is the default for a new task, so this phase is where the common path
      // either produces a brief or fails with the reason. It never records a context the task did
      // not receive: that was the state this phase was in before, and a task whose record said
      // `brief` while its session held nothing is exactly the claim the specification forbids.
      const context = await this.prepareContext(request, taskId, contextMode)

      await advance('preparing', 'creating_session')
      const sessionId = SessionId(this.deps.newSessionId())
      // PRD §二.3: a preset is chosen when the session is assembled, and it is checked **here** — after the
      // record exists but before the session does — so a bad preset fails this preparation with the Host's
      // own reason instead of surfacing as a Host assembly error with a worktree already on disk.
      const presetId = frozen?.preset ?? await this.checkedPreset(request.preset)
      const handle = await this.deps.agents.create({
        sessionId,
        meta: {
          ...preparedCwd === undefined ? {} : { cwd: preparedCwd },
          ...presetId === undefined ? {} : { agentPreset: presetId },
        },
        ...presetId === undefined ? {} : {
          setup: async (agentCtx: unknown) => { await this.deps.presets?.mount(agentCtx, presetId) },
        },
      })
      if (presetId !== undefined) {
        // Recorded **after** the session exists, so the field means "the preset this task's session was
        // composed with" rather than "the preset someone asked for". A preparation that failed before this
        // point records none, which is the truth: it has no session to have composed.
        await this.deps.store.updateTask(taskId, current => ({ ...current, preset: presetId, updatedAt: this.deps.now() }))
      }

      await this.deps.store.putBinding({
        bindingId: this.deps.newBindingId(),
        taskId,
        hostId: 'local',
        sessionId: String(sessionId),
        version: 1,
        ...preparedCwd === undefined ? {} : { cwd: preparedCwd },
        createdAt: this.deps.now(),
      })
      await this.applyFrozenConfiguration(taskId, String(sessionId))
      await this.nameCreatedSession(taskId, request.operationId, handle.agent, request.title)
      await this.attachInheritedWorkspace(taskId, String(sessionId), inheritedEnvironment)
      // The child identity is durable before model configuration can fail. A retry reuses it.
      const contextOutcome = await this.deliverContext(taskId, context, handle.agent)
      await advance('ready', 'ready')

      // PRD §二.4: the worktree is registered as a workspace, and the original project is recorded
      // on the task. Registration happens *after* the session exists because the Host's attach step
      // validates the session's own recorded `cwd` against the workspace path — attaching a session
      // that has no header yet would be asking the Host to confirm something it cannot see.
      //
      // A failure here does not fail the preparation: the session is ready and the directory is
      // real, so the task is usable, and the gap is recorded as `workspaceFailure` and reported.
      // Silently leaving `workspaceId` unset is the one option that is not taken, because "not
      // registered" and "registration was not attempted" would then look the same.
      if (prepared.workspaceDirectory !== undefined && this.deps.workspaces !== undefined) {
        await this.registerWorkspace(taskId, prepared.workspaceDirectory, request.title, String(sessionId))
      } else if (prepared.workspaceDirectory !== undefined) {
        await this.deps.store.updateTask(taskId, current => ({
          ...current,
          workspaceFailure: 'this Host composition mounts no workspace registry (ctx.workspaceRegistry), so '
            + `${prepared.workspaceDirectory} was not registered as a workspace. The directory itself exists and the `
            + 'task works in it; the association with the original project is recorded on the task.',
        }))
      }

      if (hasInitialInstruction(request.instruction)) {
        await this.flushPendingDispatches()
      } else {
        await this.deps.store.markDelivery(request.operationId, 'accepted', 'ready')
      }

      const preparedTask = this.deps.store.getTask(taskId)
      return {
        taskId,
        operationId: request.operationId,
        preparation: 'ready',
        preparationPhase: preparedTask?.preparationPhase ?? 'ready',
        sessionId: String(sessionId),
        replayed: false,
        ...this.workspaceSummary(preparedTask, preparedCwd),
        ...contextOutcome === undefined ? {} : { context: contextOutcome },
      }
    }

    // Resuming: the session already exists, so the remaining phases run against it. The first
    // instruction is dispatched here only if it was never dispatched — a resume that re-sent it
    // would be the duplicate delivery PRD §四.1 forbids, and a resume that dropped it would lose
    // the instruction the caller asked for.
    const sessionId = existingBinding?.sessionId as string
    const live = this.deps.agents.get(SessionId(sessionId))
    if (live === undefined) {
      throw new ConductorError(
        'SESSION_NOT_LIVE',
        `task ${taskId} already has session ${sessionId}, and it is not live in this Host, so the remaining `
        + 'preparation phases cannot be completed. Nothing was replaced and no second session was created; resume '
        + 'the session in the Host first.',
      )
    }
    const before = this.deps.store.getOperation(request.operationId)
    await this.applyFrozenConfiguration(taskId, sessionId)
    await this.nameCreatedSession(taskId, request.operationId, live, request.title)
    await this.attachInheritedWorkspace(taskId, sessionId, inheritedEnvironment)
    await advance('ready', 'ready')
    if (before?.delivery === 'prepared' && hasInitialInstruction(request.instruction)) {
      await this.flushPendingDispatches()
    } else if (before?.delivery === 'prepared') {
      await this.deps.store.markDelivery(request.operationId, 'accepted', 'ready')
    }

    const resumed = this.deps.store.getTask(taskId)
    return {
      taskId,
      operationId: request.operationId,
      preparation: 'ready',
      preparationPhase: resumed?.preparationPhase ?? 'ready',
      sessionId,
      replayed: false,
      ...this.workspaceSummary(resumed, existingBinding?.cwd),
      ...resumed?.context === undefined ? {} : { context: resumed.context },
    }
  }

  /**
   * Read one operation and the preparation progress it belongs to (PRD §三.3 `operation`).
   *
   * §二.2.1 has creation, forking and migration return an `operationId` immediately and report
   * preparation progress **through the operation's status**; this is that read. It reports the
   * recorded delivery state and phase, and — when the operation belongs to a task — the task's own
   * preparation, because those are two different facts: an operation can be `accepted` while its
   * task is still `preparing`, and the caller asking "how far has it got?" needs both.
   *
   * @param operationId - the operation to read.
   * @returns the operation, or the reason it is not readable.
   */
  operationStatus(operationId: string): OperationStatus {
    const record = this.deps.store.getOperation(operationId)
    if (record === undefined) {
      return {
        found: false,
        operationId,
        reason: `no operation ${operationId} is recorded. Operation ids are the ones handed back by `
          + 'conductor_create, conductor_fork and the other mutating calls; a send that reused a Host call id can be '
          + 'found from the task with the `list` action instead.',
      }
    }
    const task = record.taskId === undefined ? undefined : this.deps.store.getTask(record.taskId)
    return {
      found: true,
      operationId,
      kind: record.kind,
      delivery: record.delivery,
      withdrawn: record.withdrawn,
      ...record.phase === undefined ? {} : { phase: record.phase },
      ...record.taskId === undefined ? {} : { taskId: record.taskId },
      ...record.messageId === undefined ? {} : { messageId: record.messageId },
      ...record.attribution === undefined ? {} : { attribution: record.attribution },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...task === undefined
        ? {}
        : {
            task: {
              taskId: task.taskId,
              title: task.title,
              preparation: task.preparation,
              preparationPhase: task.preparationPhase,
              ...task.failureReason === undefined ? {} : { failureReason: task.failureReason },
              ...this.boundSession(task.currentBindingId),
            },
          },
      cancellable: this.cancellationRefusal(record, task) === undefined,
      ...(this.cancellationRefusal(record, task) === undefined
        ? {}
        : { cancellationRefusal: this.cancellationRefusal(record, task) as string }),
    }
  }

  /**
   * List the operations recorded for one task, newest last.
   *
   * @param taskId - the logical task.
   * @returns the operations, or the reason the task is unknown.
   */
  operationList(taskId: string): { readonly found: boolean; readonly operations: readonly OperationStatus[]; readonly reason?: string } {
    if (this.deps.store.getTask(taskId) === undefined) {
      return { found: false, operations: [], reason: `no managed task ${taskId}` }
    }
    return {
      found: true,
      operations: this.deps.store.listOperations({ taskId }).map(record => this.operationStatus(record.operationId)),
    }
  }

  /**
   * Why an operation's preparation cannot be cancelled, or undefined when it can.
   *
   * The rule from PRD §二.2.1 is narrow and worth stating exactly: after the user cancels, the
   * **undelivered** first instruction must not be executed, and what was already created is kept and
   * reported. So cancellation is refused once the instruction has been handed to the Host — at that
   * point the only honest verbs are stop and queue, and pretending to cancel would leave the caller
   * believing a message was not sent when it was.
   *
   * @param record - the stored operation.
   * @param task - its task, when the operation names one.
   * @returns the refusal reason, or undefined when cancellation is allowed.
   */
  private cancellationRefusal(record: StoredOperationRecord, task: TaskRecord | undefined): string | undefined {
    if (record.kind !== 'create' && record.kind !== 'fork' && record.kind !== 'handoff') {
      return `operation ${record.operationId} is a ${record.kind}, not a preparation, so there is no preparation to `
        + 'cancel. An ordinary message is withdrawn or stopped instead.'
    }
    if (task === undefined) {
      return `operation ${record.operationId} names no readable task, so there is no preparation state to cancel`
    }
    if (task.preparation === 'ready') {
      return `task ${task.taskId} finished preparing, so there is nothing left to cancel. Its first instruction, if it `
        + 'had one, was already handed to the Host; use conductor_stop or conductor_queue for what is pending.'
    }
    if (task.preparation === 'cancelled') return undefined
    if (task.preparation === 'failed') {
      return `task ${task.taskId} already failed to prepare (${task.failureReason ?? 'no reason recorded'}). `
        + 'Cancellation changes nothing here; use the `resume` action to continue from the phase it reached, or leave '
        + 'it failed.'
    }
    if (record.delivery === 'accepted' || record.delivery === 'consumed') {
      return `task ${task.taskId} already had its first instruction accepted by the Host, so the preparation is past `
        + 'the point cancellation covers. The message was delivered, and cancelling would not unsend it — use '
        + 'conductor_stop or conductor_queue instead.'
    }
    if (record.delivery === 'dispatching' || record.delivery === 'unknown') {
      return `the first instruction of task ${task.taskId} is recorded as ${record.delivery}, which means the Host `
        + 'may or may not have taken it. Cancelling here would claim a message was not sent, which nobody can '
        + 'confirm; reconcile the delivery first.'
    }
    return undefined
  }

  /**
   * Cancel a preparation the user no longer wants (PRD §二.2.1, §三.3 `operation`).
   *
   * What cancellation does, exactly: the task's preparation becomes `cancelled` and the phase it
   * reached is kept, the still-undelivered first instruction is withdrawn so a restart cannot
   * deliver it, and **nothing already created is removed** — the session and any worktree stay, and
   * they are reported back. That last part is the specification's, not a simplification: rolling
   * back a session or deleting a directory the user might still want would be a destructive act
   * taken on the strength of a cancellation.
   *
   * A preparation that is running right now stops at its next phase boundary rather than being
   * yanked: `prepare` re-reads the record at each boundary and refuses to continue once it says
   * `cancelled`.
   *
   * @param request - the operation to cancel and who is asking.
   * @returns what was cancelled and what was kept.
   * @throws {ConductorError} when the operation is unknown, or the caller does not control the task.
   */
  async cancelPreparation(request: {
    readonly operationId: string
    readonly callerSessionId: string
  }): Promise<PreparationCancellation> {
    const record = this.deps.store.getOperation(request.operationId)
    if (record === undefined) {
      throw new ConductorError('OPERATION_UNKNOWN', `no operation ${request.operationId} is recorded`)
    }
    const task = record.taskId === undefined ? undefined : this.deps.store.getTask(record.taskId)
    const refusal = this.cancellationRefusal(record, task)
    if (refusal !== undefined) {
      throw new ConductorError('PREPARATION_NOT_CANCELLABLE', refusal)
    }
    const target = task as TaskRecord
    const access = this.deps.store.getAccess(target.taskId)
    if (access?.ownerSessionId !== request.callerSessionId) {
      throw new ConductorError(
        'NOT_CONTROLLER',
        `session ${request.callerSessionId} does not control task ${target.taskId}, so it cannot cancel its `
        + `preparation. The writing controller is ${access?.ownerSessionId ?? 'nobody'}.`,
      )
    }

    const already = target.preparation === 'cancelled'
    // `withdrawn` is what makes "未投递的首条指令不执行" survive a restart: PRD §四.1 forbids a
    // withdrawn operation from being delivered again, which is exactly the guarantee wanted here.
    if (record.delivery === 'prepared') await this.deps.store.withdrawOperation(record.operationId)
    if (!already) {
      await this.deps.store.updateTask(target.taskId, current => ({
        ...current,
        // The phase is deliberately kept: it records how far preparation got, which is what the
        // caller needs in order to decide whether to resume or abandon.
        preparation: 'cancelled',
      }))
    }
    const after = this.deps.store.getTask(target.taskId)
    const binding = after?.currentBindingId === undefined ? undefined : this.deps.store.getBinding(after.currentBindingId)
    return {
      taskId: target.taskId,
      operationId: record.operationId,
      preparation: 'cancelled',
      preparationPhase: after?.preparationPhase ?? target.preparationPhase,
      alreadyCancelled: already,
      instructionWithdrawn: record.delivery === 'prepared',
      kept: {
        ...binding === undefined ? {} : { sessionId: binding.sessionId, ...binding.cwd === undefined ? {} : { cwd: binding.cwd } },
        ...after?.start === undefined ? {} : { start: after.start },
        ...after?.originRepoPath === undefined ? {} : { originRepoPath: after.originRepoPath },
        ...after?.workspaceId === undefined ? {} : { workspaceId: after.workspaceId },
      },
      summary: already
        ? `Task ${target.taskId} was already cancelled; nothing changed.`
        : `Preparation of task ${target.taskId} was cancelled at ${after?.preparationPhase ?? target.preparationPhase}`
          + `${record.delivery === 'prepared' ? ', and its undelivered first instruction was withdrawn so a restart '
            + 'cannot deliver it' : ''}. Nothing already created was removed: `
          + `${binding === undefined ? 'no session had been created yet' : `session ${binding.sessionId} is kept`}`
          + `${after?.start?.created === true ? `, and the worktree at ${binding?.cwd ?? 'the recorded directory'} is kept` : ''}.`,
    }
  }

  /**
   * Continue a preparation from the phase it reached (PRD §三.3 `operation`, §二.2.1).
   *
   * A preparation stops for reasons that do not destroy what it made: a worktree it could not create,
   * a brief it could not read, a Host that went away mid-flight. Resuming re-runs the phases that
   * had **not** completed, over the resources that already exist — it never creates a second session
   * and never creates a second worktree, because §二.2.1 says those are kept, not replaced.
   *
   * The recorded create/fork parameters are read back from the operation record rather than taken
   * from the caller, so a resume continues the request that was actually made instead of a
   * half-remembered version of it.
   *
   * @param request - the task to resume and who is asking.
   * @returns the outcome of the resumed preparation.
   * @throws {ConductorError} when the task is unknown, not the caller's, already prepared, or has no
   * recorded preparation operation to continue.
   */
  async resumePreparation(request: {
    readonly taskId: string
    readonly callerSessionId: string
    readonly operationId?: string
  }): Promise<CreateTaskResult> {
    const task = this.deps.store.getTask(request.taskId)
    if (task === undefined) {
      throw new ConductorError('TASK_NOT_FOUND', `no managed task ${request.taskId}`)
    }
    const access = this.deps.store.getAccess(task.taskId)
    if (access?.ownerSessionId !== request.callerSessionId) {
      throw new ConductorError(
        'NOT_CONTROLLER',
        `session ${request.callerSessionId} does not control task ${task.taskId}, so it cannot resume its `
        + `preparation. The writing controller is ${access?.ownerSessionId ?? 'nobody'}.`,
      )
    }
    if (task.preparation === 'ready') {
      throw new ConductorError(
        'PREPARATION_COMPLETE',
        `task ${task.taskId} is already ready (${task.preparationPhase}), so there is nothing to resume`,
      )
    }
    if (task.preparation === 'cancelled') {
      throw new ConductorError(
        'PREPARATION_CANCELLED',
        `task ${task.taskId} was cancelled deliberately, and resuming a cancelled preparation would undo a decision `
        + 'the user made. Create a new task if the work is wanted after all.',
      )
    }

    const origin = this.deps.store
      .listOperations({ taskId: task.taskId })
      .find(record => record.kind === 'create' || record.kind === 'fork')
    if (origin === undefined) {
      throw new ConductorError(
        'OPERATION_UNKNOWN',
        `task ${task.taskId} has no recorded create or fork operation, so the request it was preparing is not known `
        + 'and resuming it would mean inventing one.',
      )
    }

    const request2 = createRequestFrom(origin, task)
    // Recovery continues the original side effect, not a new :resume message identity.
    const operationId = origin.operationId
    if (origin.withdrawn || origin.delivery === 'dispatching' || origin.delivery === 'unknown'
      || (origin.delivery === 'failed' && origin.messageId !== undefined)) {
      throw new ConductorError('OPERATION_UNKNOWN', 'this preparation was withdrawn or entered message delivery; reconcile the original operation instead of resending it')
    }
    if (origin.kind === 'fork' && this.currentBinding(task.taskId) === undefined) {
      throw new ConductorError('FORK_RECOVERY_UNAVAILABLE', 'the original fork has no verifiable child binding. Restore its original session through the Host before resuming; creating another task would duplicate the fork and lose its frozen history boundary.')
    }
    if (origin.delivery === 'failed') {
      await this.deps.store.markDelivery(operationId, 'prepared', 'resuming_preparation')
    }

    try {
      const resumed = await this.prepare(
        { ...request2, operationId, controllerSessionId: request.callerSessionId, title: task.title },
        task.taskId,
        task.contextMode,
      )
      return resumed
    } catch (error) {
      const failureReason = describeFailure(error)
      const cancelled = this.deps.store.getTask(task.taskId)?.preparation === 'cancelled'
      if (!cancelled) {
        await this.deps.store.updateTask(task.taskId, current => ({ ...current, preparation: 'failed', failureReason }))
      }
      const after = this.deps.store.getTask(task.taskId)
      return {
        taskId: task.taskId,
        operationId,
        preparation: cancelled ? 'cancelled' : 'failed',
        preparationPhase: after?.preparationPhase ?? task.preparationPhase,
        failureReason,
        replayed: false,
        ...this.boundSession(after?.currentBindingId),
      }
    }
  }

  /**
   * Build the starting context a create request asked for (PRD §二.2.2).
   *
   * ## Why the brief is read from the *creating* session
   *
   * §二.1 puts task creation behind a natural-language request in a session, and §二.2.2 defines
   * `brief` as "goal, confirmed decisions, constraints, necessary references, open items and
   * acceptance conditions". Those live in the discussion that asked for the task, so the creating
   * session is the source — the same reading the on-demand `conductor_brief` takes of a managed
   * task's own session.
   *
   * ## The cutoff
   *
   * The brief stops at the last **completed turn**. An unfinished turn's partial output is not a
   * decision anyone made, and §二.2.2's whole point is that the brief distinguishes what a human
   * confirmed from what a model suggested and what is unverified. A source with no completed turn
   * yields a brief that is empty *and says so*, which is honest; refusing would be worse, because
   * a brand-new controller session legitimately has nothing to carry yet.
   *
   * @param request - the create request.
   * @param taskId - the task being prepared, so the snapshot is filed against it.
   * @param contextMode - the requested mode.
   * @returns the context to deliver, a recorded `none`, or nothing at all for `empty`.
   * @throws {ConductorError} only when the mode itself cannot be honoured, which is a caller error
   * rather than a missing Host ability.
   */
  private async prepareContext(
    request: CreateTaskRequest,
    taskId: string,
    contextMode: TaskRecord['contextMode'],
  ): Promise<PreparedContext | undefined> {
    if (contextMode === 'empty') return undefined

    if (contextMode === 'fork') {
      // Reachable through the coordinator API but not through the tools, which offer `empty` and
      // `brief` only. A created task cannot inherit a fork's history: that is the fork verb's job,
      // and quietly building one here would produce a child the caller never asked to be a child.
      throw new ConductorError(
        'CONTEXT_MODE_UNSUPPORTED',
        'a task cannot be created with `fork` context: inheriting completed history is what '
        + 'conductor_fork does, and it also decides the child\'s identity and control record. Create the task with '
        + '`brief`, or fork the task whose history should be carried.',
      )
    }

    const sourceSessionId = request.controllerSessionId
    const source = this.deps.agents.get(SessionId(sourceSessionId))
    const events = source?.session?.events
    if (events === undefined) {
      // Not a refusal: creating the task is what the caller asked for, and a brief that could not be
      // derived is a missing ability rather than a broken request. PRD §一.5 requires that ability to
      // be disabled **with its reason shown**, so the outcome is recorded and reported instead — and
      // what is *not* done is recording `brief` while the session received nothing, which is the
      // claim this whole phase exists to keep honest.
      return {
        kind: 'unavailable',
        record: {
          mode: contextMode,
          status: 'none',
          reason: `the \`brief\` starting context is taken from the creating session ${sourceSessionId}, and this `
            + 'Host cannot read its history, so no starting context was prepared. The task is created without one; '
            + 'pass `contextMode: "empty"` to say so explicitly, or create it from a live session.',
        },
      }
    }

    // The completed prefix, or nothing at all when no turn has finished.
    const cut = computeForkCut(events)
    const cutoffSeq = 'error' in cut ? -1 : cut.boundarySeq
    const built = buildBrief(events, cutoffSeq, sourceSessionId)
    const rendered = renderBrief(built)

    // The brief is filed against the session it came from, which need not be a managed task; the
    // task it was delivered to is the one being created.
    const callerTaskId = this.taskForSession(sourceSessionId)
    // Per source **session**, which is what the brief's version is monotonic against; the source is
    // usually a session rather than a managed task.
    const previous = this.deps.store.listContextsBySourceSession(sourceSessionId)
    const contentVersion = (previous[0]?.contentVersion ?? -1) + 1
    const record = {
      mode: contextMode,
      status: 'injected' as const,
      sourceSessionId,
      cutoffSeq,
      contentVersion,
      contentDigest: digestBrief(rendered),
    }
    await this.deps.store.putContext({
      snapshotId: `brief-${taskId}`,
      ...callerTaskId === undefined ? {} : { sourceTaskId: callerTaskId },
      sourceSessionId,
      cutoffSeq,
      contentVersion,
      contentDigest: record.contentDigest,
      deliveredToTaskId: taskId,
      createdAt: this.deps.now(),
    })
    return { kind: 'ready', text: renderStartingContext(built, sourceSessionId), record }
  }

  /**
   * Hand a prepared brief to the new session's Host agent and record what happened.
   *
   * The status is only `injected` once the Host actually took the message. A Host agent without the
   * starting-context primitive cannot deliver one, and saying `none` there is the honest answer —
   * the alternative, sending the brief as a follow-up turn, would both start a turn nobody asked
   * for and record plugin-generated text as if it came from the user.
   *
   * @param taskId - the task whose record carries the outcome.
   * @param context - what `prepareContext` built, when it built anything.
   * @param agent - the newly created Host agent.
   * @returns the outcome reported to the caller, or nothing when no context was requested.
   */
  private async deliverContext(
    taskId: string,
    context: PreparedContext | undefined,
    agent: AgentLike,
  ): Promise<TaskRecord['context'] | undefined> {
    if (context === undefined) return undefined
    if (context.kind === 'unavailable') {
      await this.deps.store.updateTask(taskId, current => ({ ...current, context: context.record }))
      return context.record
    }
    if (typeof agent.inject !== 'function') {
      const record = {
        ...context.record,
        status: 'none' as const,
        reason: 'this Host agent exposes no starting-context primitive (agent.inject), so the prepared brief was not '
          + 'queued. It was NOT sent as a follow-up turn instead: that would start a turn nobody asked for and put '
          + 'plugin-generated text in the log as if the user had written it.',
      }
      await this.deps.store.updateTask(taskId, current => ({ ...current, context: record }))
      return record
    }
    // `inject` does not wake the driver, so this is queued context and not a turn. Whether the
    // model ever consumes it is a separate fact, exactly as "accepted" is not "consumed" for an
    // ordinary message.
    //
    // A refusal from the Host is caught for the same reason a missing primitive is reported rather
    // than thrown: the session exists and the task is usable, so failing the whole creation because
    // the starting context was declined would throw away work the caller asked for. The record says
    // what happened instead.
    try {
      agent.inject(this.deps.createMessage(context.text, relaySource()))
    } catch (error) {
      const record = {
        ...context.record,
        status: 'none' as const,
        reason: `the Host refused the prepared brief (${describeFailure(error)}), so no starting context was queued. `
          + 'The task is created without one.',
      }
      await this.deps.store.updateTask(taskId, current => ({ ...current, context: record }))
      return record
    }
    await this.deps.store.updateTask(taskId, current => ({ ...current, context: context.record }))
    return context.record
  }

  /**
   * Summarise what a task's record says about its working directory.
   *
   * Read back from the record rather than assembled from local variables, so the reported outcome
   * is the same one a later reader sees — including a registration that failed after the session
   * was created.
   *
   * @param task - the task record, when it is readable.
   * @param path - the directory this call settled on.
   * @returns the workspace summary, or nothing when no starting state was requested.
   */
  /** Freeze omission defaults independently of the request digest, so retries cannot move a task. */
  private async inheritedEnvironment(request: { operationId: string; controllerSessionId: string; cwd?: string; workspace?: WorkspaceRequest | undefined }): Promise<ParentEnvironment | undefined> {
    if (request.cwd !== undefined || request.workspace !== undefined || this.deps.parentEnvironment === undefined) return undefined
    const operation = this.deps.store.getOperation(request.operationId)
    const params = operation?.params as Record<string, unknown> | undefined
    const frozen = params?.['inheritedEnvironment'] as ParentEnvironment | undefined
    if (frozen !== undefined) {
      if (typeof frozen.cwd !== 'string' || !frozen.cwd.trim() || (frozen.workspaceId !== undefined && typeof frozen.workspaceId !== 'string')) throw new ConductorError('PARENT_ENVIRONMENT_INVALID', 'the recorded initiating workspace is invalid; no substitute directory was chosen')
      return frozen
    }
    const environment = this.deps.parentEnvironment(request.controllerSessionId)
    if (!environment.cwd.trim()) throw new ConductorError('PARENT_DIRECTORY_UNAVAILABLE', 'the initiating session has no working directory')
    await this.deps.store.updateOperation(request.operationId, current => ({ ...current, params: { ...current.params as Record<string, unknown>, inheritedEnvironment: environment } }))
    return environment
  }

  private async nameCreatedSession(taskId: string, operationId: string, agent: AgentLike, title: string): Promise<void> {
    if (this.deps.setSessionTitle === undefined) return
    const params = this.deps.store.getOperation(operationId)?.params as Record<string, unknown> | undefined
    const named = params?.['sessionNaming'] as { sessionId?: string } | undefined
    if (named?.sessionId === String(agent.id)) return
    const accepted = await this.deps.setSessionTitle(agent, title)
    await this.deps.store.updateTask(taskId, task => ({ ...task, title: accepted }))
    await this.deps.store.updateOperation(operationId, current => ({ ...current, params: { ...current.params as Record<string, unknown>, sessionNaming: { sessionId: String(agent.id), title: accepted } } }))
  }

  private async attachInheritedWorkspace(taskId: string, sessionId: string, environment: ParentEnvironment | undefined): Promise<void> {
    if (environment?.workspaceId === undefined) return
    const result = await this.deps.workspaces?.attach(environment.workspaceId, sessionId)
    if (result?.ok !== true) {
      const reason = result?.reason ?? 'the Host workspace registry is unavailable'
      await this.deps.store.updateTask(taskId, task => ({ ...task, workspaceId: environment.workspaceId, workspaceFailure: reason }))
      throw new ConductorError('PARENT_WORKSPACE_UNAVAILABLE', reason)
    }
    await this.deps.store.updateTask(taskId, task => ({ ...task, workspaceId: environment.workspaceId, workspaceFailure: undefined }))
  }

  private workspaceSummary(task: TaskRecord | undefined, path: string | undefined): { workspace?: WorkspaceOutcome } {
    const start = task?.start
    if (start === undefined) {
      if (task?.workspaceId === undefined) return {}
      return { workspace: { strategy: 'existing_directory', created: false, commit: '', workspaceId: task.workspaceId, ...path === undefined ? {} : { path }, ...task.workspaceFailure === undefined ? {} : { failure: task.workspaceFailure } } }
    }
    return {
      workspace: {
        strategy: start.strategy,
        commit: start.commit,
        created: start.created,
        ...path === undefined ? {} : { path },
        ...task?.originRepoPath === undefined ? {} : { originRepoPath: task.originRepoPath },
        ...task?.workspaceId === undefined ? {} : { workspaceId: task.workspaceId },
        ...task?.workspaceFailure === undefined ? {} : { failure: task.workspaceFailure },
      },
    }
  }

  /**
   * Rebuild the directory a task should run in, if the caller asked for one (PRD §二.4).
   *
   * Returns the directory to use plus, when a worktree was created, the directory that should be
   * registered as a workspace and the project it came from. Everything the Git adapter decided is
   * recorded on the task **before** the session is created, so a later reader can tell which
   * commit a task started from without re-deriving it from a mutable branch.
   *
   * @param workspace - the requested starting state, when one was asked for.
   * @param taskId - the task being prepared, so its record can carry the starting state.
   * @returns the directory and what should be registered, or nothing when nothing was asked for.
   * @throws {ConductorError} when the starting state cannot be prepared or the worktree cannot be created.
   */
  private async prepareWorkspace(
    workspace: WorkspaceRequest | undefined,
    taskId: string,
  ): Promise<{ cwd?: string; workspaceDirectory?: string }> {
    if (workspace === undefined) return {}

    const git = this.deps.git
    if (git === undefined) {
      throw new ConductorError(
        'GIT_UNAVAILABLE',
        'a Git starting state was requested but this Host composition mounts no subprocess service '
        + '(ctx.subprocess), which is the only way to run `git` here. Nothing was prepared and the task is not run '
        + 'in the current directory instead: choose an existing or plain directory, or mount the subprocess service.',
      )
    }

    const planned = await planStart(git, {
      strategy: workspace.strategy,
      ...workspace.repoPath === undefined ? {} : { repoPath: workspace.repoPath },
      ...workspace.rev === undefined ? {} : { rev: workspace.rev },
      ...workspace.existingPath === undefined ? {} : { existingPath: workspace.existingPath },
      ...workspace.worktreePath === undefined ? {} : { worktreePath: workspace.worktreePath },
      ...workspace.untrackedPaths === undefined ? {} : { untrackedPaths: workspace.untrackedPaths },
    })
    if (!planned.ok) {
      throw new ConductorError('START_STATE_UNPLANNED', planned.reason)
    }
    const plan: StartPlan = planned.plan

    // The plan is recorded **before** the worktree is attempted, so a creation failure still
    // reports which commit the task would have started from. `created` stays false until the
    // directory actually exists: a record that claimed a worktree while the creation failed would
    // be the persisted half of a lie.
    await this.deps.store.updateTask(taskId, current => ({
      ...current,
      start: { strategy: plan.strategy, commit: plan.commit, created: false },
    }))

    if (plan.target.kind !== 'worktree') {
      return { cwd: plan.target.path }
    }

    const created = await createWorktree(git, plan, {
      ...this.deps.snapshotIo === undefined ? {} : { io: this.deps.snapshotIo },
      ...workspace.untrackedPaths === undefined ? {} : { untrackedPaths: workspace.untrackedPaths },
    })
    if (!created.ok) {
      if (created.leftoverPath !== undefined) {
        await this.registerWorktreeResource({
          taskId,
          path: created.leftoverPath,
          originRepoPath: plan.sourcePath,
          createdReason: `Git starting state ${plan.strategy} created a worktree that preparation then refused; `
            + 'the directory was kept because stop and a failed preparation do not delete it',
        })
      }
      throw new ConductorError('WORKSPACE_PREPARATION_FAILED', created.reason)
    }
    await this.deps.store.updateTask(taskId, current => ({
      ...current,
      originRepoPath: plan.sourcePath,
      start: { strategy: plan.strategy, commit: created.commit, created: true },
    }))
    await this.registerWorktreeResource({
      taskId,
      path: created.path,
      originRepoPath: plan.sourcePath,
      createdReason: `Git starting state ${plan.strategy} created an independent worktree from ${created.commit}`,
    })
    return { cwd: created.path, workspaceDirectory: created.path }
  }

  /**
   * Record a worktree this conductor created (PRD §三.6).
   *
   * The registry is how cleanup finds plugin-owned directories later. A failed
   * preparation that still left a directory on disk is registered too — stop
   * and a failed preparation do not delete it, so the leftover has to appear
   * in the preview rather than vanishing from the bookkeeping.
   *
   * @param input - the task, path, source repository and creation reason.
   */
  private async registerWorktreeResource(input: {
    readonly taskId: string
    readonly path: string
    readonly originRepoPath: string
    readonly createdReason: string
  }): Promise<void> {
    const stamp = new Date().toISOString()
    const resourceId = worktreeResourceId(input.taskId)
    const existing = this.deps.store.getResource(resourceId)
    await this.deps.store.putResource({
      resourceId,
      kind: 'worktree',
      path: input.path,
      originRepoPath: input.originRepoPath,
      taskId: input.taskId,
      createdReason: input.createdReason,
      owned: true,
      status: 'active',
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    })
  }

  /**
   * Register a prepared directory as a Host workspace and attach the new session to it.
   *
   * @param taskId - the task whose record carries the outcome.
   * @param directory - the directory to register.
   * @param title - the task's title, used as the workspace title for a new registration.
   * @param sessionId - the session to attach once the workspace exists.
   */
  private async registerWorkspace(taskId: string, directory: string, title: string, sessionId: string): Promise<void> {
    const workspaces = this.deps.workspaces
    if (workspaces === undefined) return
    const registered = await workspaces.register(directory, title)
    if (!registered.ok) {
      await this.deps.store.updateTask(taskId, current => ({
        ...current,
        workspaceFailure: registered.reason,
      }))
      return
    }
    const attached = await workspaces.attach(registered.workspaceId, sessionId)
    await this.deps.store.updateTask(taskId, current => ({
      ...current,
      workspaceId: registered.workspaceId,
      ...attached.ok
        ? { workspaceFailure: undefined }
        : {
            workspaceFailure: `${directory} is registered as workspace ${registered.workspaceId}, but the session `
              + `could not be attached to it: ${attached.reason}`,
          },
    }))
  }

  /**
   * Dispatch text to an existing task.
   *
   * The checks in PRD §二.6 and §四.2 are performed here, immediately before
   * the real dispatch: the task must be ready, the caller must still hold the
   * write control at the expected epoch, and the binding must still be the
   * expected version. A transfer or a handoff landing in between is thereby
   * refused rather than acted on.
   *
   * @param request - the send request.
   * @returns where the message stands.
   * @throws {ConductorError} on a conflict, a missing task, a stale caller, or an unsupported mode.
   */
  async send(request: SendRequest): Promise<SendResult> {
    // The two interrupt modes are not a variant of dispatch — they are a stop
    // followed by a send. Routing them through `stop` keeps that sequence in one
    // place, and the text travels the ordinary send path from there, so the
    // operation record and idempotency are the same as any other message.
    if (request.mode === 'interrupt' || request.mode === 'interrupt_and_send') {
      const stopped = await this.stop({
        operationId: request.operationId,
        taskId: request.taskId,
        callerSessionId: request.callerSessionId,
        ...request.confirmLimitMs === undefined ? {} : { confirmLimitMs: request.confirmLimitMs },
        ...request.mode === 'interrupt_and_send' ? { text: request.text } : {},
        ...request.expectedTurn === undefined ? {} : { expectedTurn: request.expectedTurn },
        ...request.expectedStartSeq === undefined ? {} : { expectedStartSeq: request.expectedStartSeq },
        ...request.expectedOwnerEpoch === undefined ? {} : { expectedOwnerEpoch: request.expectedOwnerEpoch },
        ...request.expectedBindingVersion === undefined ? {} : { expectedBindingVersion: request.expectedBindingVersion },
      })
      if (stopped.sent && stopped.messageId !== undefined) {
        return { taskId: request.taskId, mode: request.mode, delivery: 'accepted', messageId: stopped.messageId }
      }
      // Nothing was delivered. That is a refusal with a reason, not a silent
      // success: `accepted` would claim the Host took a message it never saw.
      throw new ConductorError(
        stopped.outcome === 'no_active_turn' ? 'NO_ACTIVE_TURN' : 'STOP_NOT_CONFIRMED',
        stopped.reason,
      )
    }

    const task = this.deps.store.getTask(request.taskId)
    if (task === undefined) {
      throw new ConductorError('TASK_NOT_FOUND', `no managed task ${request.taskId}`)
    }
    if (task.preparation !== 'ready') {
      throw new ConductorError(
        'NOT_READY',
        `task ${request.taskId} is ${task.preparation} (phase ${task.preparationPhase}); `
        + 'a task accepts sends only once its environment is ready',
      )
    }

    const access = this.deps.store.getAccess(request.taskId)
    const refusal = writeControlRefusal(access, request.taskId, request.callerSessionId)
    if (refusal !== undefined || access === undefined) {
      throw new ConductorError(
        refusal?.code ?? 'NOT_CONTROLLER',
        refusal?.reason ?? `session ${request.callerSessionId} does not hold write control of task ${request.taskId}`,
      )
    }
    if (request.expectedOwnerEpoch !== undefined && access.ownerEpoch !== request.expectedOwnerEpoch) {
      throw new ConductorError(
        'STALE_OWNER_EPOCH',
        `control of task ${request.taskId} is at epoch ${String(access.ownerEpoch)}, not ${String(request.expectedOwnerEpoch)}`,
      )
    }

    const binding = task.currentBindingId === undefined
      ? undefined
      : this.deps.store.getBinding(task.currentBindingId)
    if (binding === undefined) {
      throw new ConductorError('NO_BINDING', `task ${request.taskId} has no session bound to it`)
    }
    if (request.expectedBindingVersion !== undefined && binding.version !== request.expectedBindingVersion) {
      throw new ConductorError(
        'STALE_BINDING',
        `task ${request.taskId} is bound at version ${String(binding.version)}, not ${String(request.expectedBindingVersion)}`,
      )
    }

    if (binding.hostId !== 'local' && binding.hostId !== this.deps.localHostId) {
      if (!this.deps.remoteSend) throw new ConductorError('TARGET_UNAVAILABLE','the bound Host has no configured remote transport')
      return await this.deps.remoteSend(request,binding)
    }
    const agent = this.deps.agents.get(SessionId(binding.sessionId))
    if (agent === undefined) {
      throw new ConductorError(
        'TARGET_UNAVAILABLE',
        `the session bound to task ${request.taskId} (${binding.sessionId}) is not live in this Host`,
      )
    }

    const claim = await this.deps.store.beginOperation({
      operationId: request.operationId,
      kind: 'send',
      dispatchGuard: {
        ownerSessionId: request.callerSessionId, ownerEpoch: access.ownerEpoch,
        bindingId: binding.bindingId, bindingVersion: binding.version,
        ...request.requireIdle === true ? { requireIdle: true } : {},
      },
      params: {
        taskId: request.taskId,
        text: request.text,
        mode: request.mode,
        ...request.requireIdle === true ? { requireIdle: true } : {},
        ...request.expectedBindingVersion === undefined
          ? {}
          : { expectedBindingVersion: request.expectedBindingVersion },
        ...request.expectedOwnerEpoch === undefined
          ? {}
          : { expectedOwnerEpoch: request.expectedOwnerEpoch },
      },
      taskId: request.taskId,
      // §四.2: a rule execution is associated with the grant, the rule and the event that caused it.
      ...request.attribution === undefined ? {} : { attribution: request.attribution },
    })
    if (claim.kind === 'conflict') {
      throw new ConductorError('OPERATION_CONFLICT', claim.reason)
    }
    if (claim.kind === 'replay' && claim.record.delivery !== 'prepared') {
      if (claim.record.withdrawn || claim.record.delivery === 'withdrawn' || claim.record.delivery === 'failed') {
        throw new ConductorError('DISPATCH_REFUSED', claim.record.phase ?? 'the original operation was withdrawn or failed; it was not delivered')
      }
      if (claim.record.delivery === 'dispatching' || claim.record.delivery === 'unknown') {
        throw new ConductorError('DELIVERY_UNKNOWN', 'the original delivery is unknown; reconcile the existing operation before any resend')
      }
      return {
        taskId: request.taskId,
        mode: request.mode,
        delivery: 'replayed',
        ...claim.record.messageId === undefined ? {} : { messageId: claim.record.messageId },
      }
    }

    // A new claim, or a retry of one that was kept pending for a slot, is
    // offered to the Host-wide flush: explicit work goes first, automatic
    // yields, and at the limit the request stays prepared rather than refused.
    await this.flushPendingDispatches()
    const current = this.deps.store.getOperation(request.operationId)
    if (current?.delivery === 'unknown' || current?.delivery === 'dispatching') {
      throw new ConductorError('DELIVERY_UNKNOWN', 'Host delivery could not be confirmed; the original operation is unknown and must be reconciled')
    }
    if (current?.delivery === 'failed') {
      throw new ConductorError('DISPATCH_REFUSED', current.phase ?? 'the admitted send was refused before delivery')
    }
    if (current?.delivery === 'accepted') {
      return {
        taskId: request.taskId,
        mode: request.mode,
        delivery: claim.kind === 'replay' ? 'replayed' : 'accepted',
        ...current.messageId === undefined ? {} : { messageId: current.messageId },
      }
    }
    const slots = this.occupiedSlots()
    const decision = admitPluginTurn({
      occupiedTargets: slots.target,
      occupiedNotices: slots.notice,
      ...this.deps.targetTurnConcurrency === undefined ? {} : { targetLimit: this.deps.targetTurnConcurrency },
      ...this.deps.noticeConcurrency === undefined ? {} : { noticeLimit: this.deps.noticeConcurrency },
      slot: 'target',
    })
    return {
      taskId: request.taskId,
      mode: request.mode,
      delivery: 'pending',
      ...current?.messageId === undefined ? {} : { messageId: current.messageId },
      reason: decision.admit
        ? 'an earlier pending dispatch holds the remaining slot; this request is kept in order'
        : decision.reason,
    }
  }

  /**
   * Stop a turn, and optionally send once the stop is confirmed (PRD §二.6).
   *
   * The order is the specification's, and each step is here rather than spread
   * across callers because the sequence *is* the guarantee:
   *
   * 1. the queue is read and the expected turn is verified **in one synchronous
   *    critical section** with the cancel — see {@link cancelExpectedTurn}, which
   *    must never be made asynchronous;
   * 2. an unconsumed queue refuses the whole request *before* anything is
   *    cancelled, and the caller's text is kept;
   * 3. the matching turn end is awaited by turn number, never by "the session went
   *    idle";
   * 4. a new turn, new queue work, or a moved binding abandons the send and keeps
   *    the text;
   * 5. an unconfirmed stop is reported as unconfirmed, and the instruction is
   *    **not** sent — the caller's next decision depends on knowing that.
   *
   * With no operation record written for a refusal, a stopped-and-kept request can
   * simply be retried: nothing was dispatched, so there is nothing to reconcile.
   *
   * @param request - the stop request.
   * @returns where the stop and the optional send stand.
   * @throws {ConductorError} on a missing task, a stale epoch or binding, an
   * unavailable target, or an expectation that no longer matches the open turn.
   */
  async stop(request: StopRequest): Promise<StopResult> {
    const confirmLimitMs = request.confirmLimitMs
      ?? this.deps.interruptConfirmLimitMs
      ?? DEFAULTS.interruptConfirmLimitMs
    const task = this.deps.store.getTask(request.taskId)
    if (task === undefined) {
      throw new ConductorError('TASK_NOT_FOUND', `no managed task ${request.taskId}`)
    }
    if (task.preparation !== 'ready') {
      throw new ConductorError(
        'NOT_READY',
        `task ${request.taskId} is ${task.preparation} (phase ${task.preparationPhase}); `
        + 'a task accepts a stop only once its environment is ready',
      )
    }

    const access = this.deps.store.getAccess(request.taskId)
    const refusal = writeControlRefusal(access, request.taskId, request.callerSessionId)
    if (refusal !== undefined || access === undefined) {
      throw new ConductorError(
        refusal?.code ?? 'NOT_CONTROLLER',
        refusal?.reason ?? `session ${request.callerSessionId} does not hold write control of task ${request.taskId}`,
      )
    }
    if (request.expectedOwnerEpoch !== undefined && access.ownerEpoch !== request.expectedOwnerEpoch) {
      throw new ConductorError(
        'STALE_OWNER_EPOCH',
        `control of task ${request.taskId} is at epoch ${String(access.ownerEpoch)}, not ${String(request.expectedOwnerEpoch)}`,
      )
    }

    const binding = task.currentBindingId === undefined
      ? undefined
      : this.deps.store.getBinding(task.currentBindingId)
    if (binding === undefined) {
      throw new ConductorError('NO_BINDING', `task ${request.taskId} has no session bound to it`)
    }
    if (request.expectedBindingVersion !== undefined && binding.version !== request.expectedBindingVersion) {
      throw new ConductorError(
        'STALE_BINDING',
        `task ${request.taskId} is bound at version ${String(binding.version)}, not ${String(request.expectedBindingVersion)}`,
      )
    }

    if (binding.hostId !== 'local' && binding.hostId !== this.deps.localHostId) {
      if (!this.deps.remoteStop) throw new ConductorError('TARGET_UNAVAILABLE','the bound Host has no configured remote transport')
      return await this.deps.remoteStop(request,binding)
    }
    const agent = liveAgentOf(this.deps.agents.get(SessionId(binding.sessionId)))
    if (agent === undefined) {
      throw new ConductorError(
        'TARGET_UNAVAILABLE',
        `the session bound to task ${request.taskId} (${binding.sessionId}) is not live in this Host with the `
        + 'projections an exact stop needs, so the expected turn could not be verified and nothing was cancelled',
      )
    }

    const wantsSend = request.text !== undefined
    const base = {
      taskId: request.taskId,
      ...request.expectedTurn === undefined ? {} : { expectedTurn: request.expectedTurn },
    }

    // ─── one synchronous critical section: read the queue, verify, cancel ───
    // Nothing below this comment may await until `decision` has been taken. The
    // whole point is that the projection the turn was verified against cannot
    // change before the cancel, and an `await` here would remove that.
    const before = pendingInputOf(agent.inbox)
    if (wantsSend) {
      const precondition = interruptPrecondition(before)
      if (!precondition.ok) {
        return {
          ...base,
          outcome: 'kept',
          sent: false,
          keptText: true,
          reason: precondition.reason,
        }
      }
    }
    const decision = cancelExpectedTurn(agent, {
      ...request.expectedTurn === undefined ? {} : { turn: request.expectedTurn },
      ...request.expectedStartSeq === undefined ? {} : { startSeq: request.expectedStartSeq },
    })
    if (decision.kind === 'requested') {
      this.deps.cancels?.note(binding.sessionId, decision.turn.turn)
    }

    if (decision.kind === 'stale_turn') {
      // Refused rather than retargeted. Cancelling the turn that happens to be
      // open would stop work nobody asked to stop.
      throw new ConductorError('STALE_TURN', decision.reason)
    }

    if (decision.kind === 'no_active_turn') {
      if (!wantsSend) {
        return { ...base, outcome: 'no_active_turn', sent: false, keptText: false, reason: decision.reason }
      }
      // `interrupt_and_send` on an idle session is "check the state, then send":
      // there is no turn to stop, so the instruction goes out directly.
      return await this.deliverAfterStop(request, 'no active turn, so the instruction was sent directly')
    }

    const turn = decision.turn

    // ─── the wait is outside the critical section, by necessity ────────────
    const awaited = await this.awaitTurnEnd(agent, turn.turn, confirmLimitMs)

    if (!wantsSend) {
      return {
        ...base,
        outcome: awaited.ended ? 'confirmed' : 'unconfirmed',
        turn: turn.turn,
        ...awaited.outcome === undefined ? {} : { turnOutcome: awaited.outcome },
        sent: false,
        keptText: false,
        reason: awaited.ended
          ? `turn ${String(turn.turn)} reported its end (${awaited.outcome ?? 'unknown'})`
          : unconfirmedStopReport(confirmLimitMs, turn),
      }
    }

    if (!awaited.ended) {
      // PRD §二.6 step 7. The instruction is deliberately not sent: delivering it
      // while a turn the caller asked to stop is still running is how a caller
      // loses track of what the target is doing.
      return {
        ...base,
        outcome: 'unconfirmed',
        turn: turn.turn,
        sent: false,
        keptText: true,
        reason: unconfirmedStopReport(confirmLimitMs, turn),
      }
    }

    const after = {
      openTurn: openTurnOf(agent.session.events),
      queueLength: pendingInputOf(agent.inbox).queue.length,
      bindingVersion: this.currentBinding(request.taskId)?.version,
      ownerEpoch: this.deps.store.getAccess(request.taskId)?.ownerEpoch,
    }
    const check = afterStopCheck(
      { turn: turn.turn, queueLength: before.queue.length, bindingVersion: binding.version, ownerEpoch: access.ownerEpoch },
      after,
    )
    if (!check.ok) {
      return {
        ...base,
        outcome: 'kept',
        turn: turn.turn,
        ...awaited.outcome === undefined ? {} : { turnOutcome: awaited.outcome },
        sent: false,
        keptText: true,
        reason: check.reason,
      }
    }

    return await this.deliverAfterStop({ ...request, expectedOwnerEpoch: access.ownerEpoch,
      expectedBindingVersion: binding.version }, `turn ${String(turn.turn)} ended (${awaited.outcome ?? 'unknown'}) and nothing else changed`)
  }

  /**
   * Request cancellation of the open turn without waiting for its end (PRD §二.13.2).
   *
   * Same critical section as {@link stop}: verify and `cancel()` with no await in
   * between. Unlike `stop`, this method does **not** poll for the matching turn
   * end — a budget that has been reached must request the cancel and report the
   * actual state, not claim a confirmation it has not observed.
   *
   * @param request - the task and the Host-trusted controller identity.
   * @returns `requested` when `cancel()` was issued, or `no_active_turn` when the
   * session is idle. Does not wait.
   * @throws {ConductorError} on a missing task, a stale controller, or a target
   * that cannot be verified.
   */
  requestTurnCancel(request: TurnCancelRequest): TurnCancelResult {
    const task = this.deps.store.getTask(request.taskId)
    if (task === undefined) {
      throw new ConductorError('TASK_NOT_FOUND', `no managed task ${request.taskId}`)
    }
    if (task.preparation !== 'ready') {
      throw new ConductorError(
        'NOT_READY',
        `task ${request.taskId} is ${task.preparation} (phase ${task.preparationPhase}); `
        + 'a task accepts a cancel only once its environment is ready',
      )
    }

    const access = this.deps.store.getAccess(request.taskId)
    const refusal = writeControlRefusal(access, request.taskId, request.callerSessionId)
    if (refusal !== undefined || access === undefined) {
      throw new ConductorError(
        refusal?.code ?? 'NOT_CONTROLLER',
        refusal?.reason ?? `session ${request.callerSessionId} does not hold write control of task ${request.taskId}`,
      )
    }

    const binding = task.currentBindingId === undefined
      ? undefined
      : this.deps.store.getBinding(task.currentBindingId)
    if (binding === undefined) {
      throw new ConductorError('NO_BINDING', `task ${request.taskId} has no session bound to it`)
    }

    const agent = liveAgentOf(this.deps.agents.get(SessionId(binding.sessionId)))
    if (agent === undefined) {
      throw new ConductorError(
        'TARGET_UNAVAILABLE',
        `the session bound to task ${request.taskId} (${binding.sessionId}) is not live in this Host with the `
        + 'projections an exact stop needs, so the expected turn could not be verified and nothing was cancelled',
      )
    }

    // ─── one synchronous critical section: verify, cancel ───
    // Nothing in this method may await. The budget path must not wait 30s for a
    // confirmation it is not claiming, and the turn check must not yield.
    const decision = cancelExpectedTurn(
      agent,
      {},
      { reason: request.cause ?? 'conductor budget limit' },
    )
    if (decision.kind === 'requested') {
      this.deps.cancels?.note(binding.sessionId, decision.turn.turn)
    }
    if (decision.kind === 'no_active_turn') {
      return { taskId: request.taskId, outcome: 'no_active_turn', reason: decision.reason }
    }
    if (decision.kind === 'stale_turn') {
      // Unreachable without an expectation; named so a later caller that supplies
      // one cannot silently retarget.
      throw new ConductorError('STALE_TURN', decision.reason)
    }
    return {
      taskId: request.taskId,
      outcome: 'requested',
      turn: decision.turn.turn,
      reason: decision.reason,
    }
  }

  /**
   * Deliver the text an interrupt-and-send was holding, through the ordinary send.
   *
   * The instruction goes out as `steer`, which is what the specification's table
   * prescribes for an idle session, and it travels the normal send path so it
   * carries the same operation record, idempotency and delivery states as any
   * other message rather than a private shortcut.
   *
   * @param request - the stop request holding the text.
   * @param why - the condition that cleared the send.
   * @returns the completed stop result.
   * @throws {ConductorError} when the delivery itself is refused.
   */
  private async deliverAfterStop(request: StopRequest, why: string): Promise<StopResult> {
    const text = request.text ?? ''
    let sent: SendResult
    try {
      sent = await this.send({
      operationId: request.operationId,
      taskId: request.taskId,
      text,
      mode: 'steer',
      callerSessionId: request.callerSessionId,
      requireIdle: true,
      ...request.expectedOwnerEpoch === undefined ? {} : { expectedOwnerEpoch: request.expectedOwnerEpoch },
      ...request.expectedBindingVersion === undefined ? {} : { expectedBindingVersion: request.expectedBindingVersion },
      })
    } catch (error) {
      if (!(error instanceof ConductorError)) throw error
      return { taskId: request.taskId, outcome: 'kept', sent: false, keptText: true,
        reason: `the instruction was kept: ${error.code}: ${error.message}` }
    }
    return {
      taskId: request.taskId,
      ...request.expectedTurn === undefined ? {} : { expectedTurn: request.expectedTurn },
      outcome: 'confirmed',
      sent: sent.delivery === 'accepted',
      keptText: sent.delivery !== 'accepted',
      ...sent.messageId === undefined ? {} : { messageId: sent.messageId },
      reason: `${why}; the instruction went out as ${sent.delivery}`,
    }
  }

  /**
   * Wait for one specific turn to report its end.
   *
   * Polling the session's synchronous projection, which is the same mechanism
   * every other reader in this plugin uses; the sleep is injected so the whole
   * stop sequence is testable without real time passing. The deadline is the
   * configured confirmation ceiling, and reaching it is a *result* — an unconfirmed
   * stop — not an error to be swallowed.
   *
   * @param agent - the live agent.
   * @param turn - the turn number to wait for.
   * @param limitMs - the confirmation ceiling.
   * @returns whether the turn ended, and its outcome when it did.
   */
  private async awaitTurnEnd(
    agent: LiveAgentLike,
    turn: number,
    limitMs: number,
  ): Promise<{ readonly ended: boolean; readonly outcome?: string }> {
    const sleep = this.deps.sleep ?? defaultSleep
    const pollMs = this.deps.pollMs ?? DEFAULT_STOP_POLL_MS
    const nowMs = (): number => Date.parse(this.deps.now())
    const startedAt = nowMs()
    for (;;) {
      const end = turnEndOf(agent.session.events, turn)
      if (end !== undefined) return { ended: true, outcome: end.outcome }
      if (nowMs() - startedAt >= limitMs) return { ended: false }
      await sleep(pollMs)
    }
  }

  /**
   * Read, edit or withdraw a task's unconsumed input (PRD §二.6, §三.3 `queue`).
   *
   * Read from the Host's own inbox projection rather than from the conductor's
   * records, so what a caller sees is what the Host will actually consume. A
   * withdrawal is recorded in the operation table before it is attempted, so a
   * crash between the two leaves evidence that it was requested — and the record
   * is what stops a withdrawn message from being delivered again on recovery.
   *
   * @param request - the queue request.
   * @returns the resulting queue, and what changed.
   * @throws {ConductorError} on a missing task, a stale caller, or an unavailable target.
   */
  async queue(request: QueueRequest): Promise<QueueResult> {
    const task = this.deps.store.getTask(request.taskId)
    if (task === undefined) {
      throw new ConductorError('TASK_NOT_FOUND', `no managed task ${request.taskId}`)
    }
    const access = this.deps.store.getAccess(request.taskId)
    const refusal = request.action === 'list'
      ? access !== undefined && mayRead(access, request.callerSessionId)
        ? undefined
        : { code: 'NOT_READER', reason: `session ${request.callerSessionId} may not read task ${request.taskId}` }
      : writeControlRefusal(access, request.taskId, request.callerSessionId)
    if (refusal !== undefined) {
      throw new ConductorError(refusal.code, refusal.reason)
    }
    if (request.expectedOwnerEpoch !== undefined && access !== undefined
      && access.ownerEpoch !== request.expectedOwnerEpoch) {
      throw new ConductorError(
        'STALE_OWNER_EPOCH',
        `control of task ${request.taskId} is at epoch ${String(access.ownerEpoch)}, not ${String(request.expectedOwnerEpoch)}`,
      )
    }
    const binding = task.currentBindingId === undefined
      ? undefined
      : this.deps.store.getBinding(task.currentBindingId)
    if (binding === undefined) {
      throw new ConductorError('NO_BINDING', `task ${request.taskId} has no session bound to it`)
    }
    if (request.expectedBindingVersion !== undefined && binding.version !== request.expectedBindingVersion) {
      throw new ConductorError(
        'STALE_BINDING',
        `task ${request.taskId} is bound at version ${String(binding.version)}, not ${String(request.expectedBindingVersion)}`,
      )
    }
    if (binding.hostId !== 'local' && binding.hostId !== this.deps.localHostId) {
      if (!this.deps.remoteQueue) throw new ConductorError('TARGET_UNAVAILABLE','the bound Host has no configured remote transport')
      return await this.deps.remoteQueue(request,binding)
    }
    const agent = liveAgentOf(this.deps.agents.get(SessionId(binding.sessionId)))
    if (agent === undefined) {
      throw new ConductorError(
        'TARGET_UNAVAILABLE',
        `the session bound to task ${request.taskId} (${binding.sessionId}) is not live with a readable inbox`,
      )
    }

    const current = pendingInputOf(agent.inbox)
    const listed: QueuedMessage[] = [
      ...current.queue.map(message => ({ ...message, list: 'queue' as const })),
      ...current.steering.map(message => ({ ...message, list: 'steering' as const })),
    ]

    if (request.action === 'list') {
      return {
        taskId: request.taskId,
        messages: listed,
        reason: listed.length === 0
          ? 'the session has no unconsumed input'
          : `${String(current.queue.length)} queued and ${String(current.steering.length)} steering message(s) are unconsumed`,
      }
    }

    if (request.messageId === undefined) {
      throw new ConductorError('BAD_REQUEST', `queue action ${request.action} needs a messageId`)
    }

    const assertQueueAuthority = (): void => {
      const currentAccess = this.deps.store.getAccess(request.taskId)
      if (currentAccess?.ownerEpoch !== access?.ownerEpoch) throw new ConductorError('STALE_OWNER_EPOCH', 'control changed while recording the queue operation')
      const denied = writeControlRefusal(currentAccess, request.taskId, request.callerSessionId)
      if (denied !== undefined) throw new ConductorError(denied.code, denied.reason)
      if (this.currentBinding(request.taskId)?.bindingId !== binding.bindingId) throw new ConductorError('STALE_BINDING', 'the queue target changed while recording the operation')
    }

    if (request.action === 'withdraw') {
      // Recorded before the removal is attempted: a crash in between then leaves
      // evidence that a withdrawal was requested for this message, which is what
      // keeps a recovery pass from treating it as still pending.
      const claim = await this.deps.store.beginOperation({
        operationId: request.operationId,
        kind: 'queue_withdraw',
        params: { taskId: request.taskId, messageId: request.messageId },
        taskId: request.taskId,
        messageId: request.messageId,
      })
      if (claim.kind === 'conflict') throw new ConductorError('OPERATION_CONFLICT', claim.reason)
      if (claim.kind === 'replay') {
        return {
          taskId: request.taskId,
          messages: listed,
          changed: { messageId: request.messageId, action: 'already_consumed' },
          reason: `withdrawal of ${request.messageId} was already recorded; the queue is reported as it stands now`,
        }
      }
      assertQueueAuthority()
      const removed = agent.inbox.remove(request.messageId as MessageId)
      await this.deps.store.markDelivery(
        request.operationId,
        removed ? 'accepted' : 'failed',
        removed ? 'withdrawn_from_inbox' : 'already_consumed',
      )
      const after = pendingInputOf(agent.inbox)
      return {
        taskId: request.taskId,
        messages: [
          ...after.queue.map(message => ({ ...message, list: 'queue' as const })),
          ...after.steering.map(message => ({ ...message, list: 'steering' as const })),
        ],
        changed: { messageId: request.messageId, action: removed ? 'withdrawn' : 'already_consumed' },
        reason: removed
          ? `withdrew ${request.messageId}; the Host recorded the cancellation and it will not be consumed`
          : `${request.messageId} had already been consumed, so nothing was withdrawn`,
      }
    }

    if (request.text === undefined) {
      throw new ConductorError('BAD_REQUEST', 'editing a queued message needs the replacement text')
    }
    const claim = await this.deps.store.beginOperation({
      operationId: request.operationId,
      kind: 'queue_edit',
      params: { taskId: request.taskId, messageId: request.messageId, text: request.text },
      taskId: request.taskId,
      messageId: request.messageId,
    })
    if (claim.kind === 'conflict') throw new ConductorError('OPERATION_CONFLICT', claim.reason)
    if (claim.kind === 'replay') {
      return {
        taskId: request.taskId,
        messages: listed,
        changed: { messageId: request.messageId, action: 'already_consumed' },
        reason: `the edit of ${request.messageId} was already recorded; the queue is reported as it stands now`,
      }
    }
    const replacement = this.deps.createMessage(request.text, relaySource())
    assertQueueAuthority()
    const replaced = agent.inbox.replace(request.messageId as MessageId, replacement as never)
    await this.deps.store.markDelivery(
      request.operationId,
      replaced ? 'accepted' : 'failed',
      replaced ? 'replaced_in_inbox' : 'already_consumed',
    )
    const after = pendingInputOf(agent.inbox)
    return {
      taskId: request.taskId,
      messages: [
        ...after.queue.map(message => ({ ...message, list: 'queue' as const })),
        ...after.steering.map(message => ({ ...message, list: 'steering' as const })),
      ],
      changed: { messageId: request.messageId, action: replaced ? 'edited' : 'already_consumed' },
      reason: replaced
        ? `replaced ${request.messageId} with ${replacement.id}; the Host recorded the swap, so the new text is what will be consumed`
        : `${request.messageId} had already been consumed, so nothing was edited`,
    }
  }

  /**
   * How many plugin-initiated unfinished turns this Host currently holds (PRD §四.4).
   *
   * Observed from live agents, not from the ledger: concurrency is a state.
   * Native-interface turns are omitted. Waiting-for-user and waiting-for-approval
   * occupy a target slot.
   *
   * @returns the occupied target and notice counts.
   */
  occupiedSlots(): { readonly target: number; readonly notice: number } {
    let target = 0
    let notice = 0
    for (const agent of this.deps.agents.list()) {
      const slot = sessionOccupies(agent)
      if (slot === 'target') target += 1
      else if (slot === 'notice') notice += 1
    }
    return { target, notice }
  }

  /**
   * Dispatch prepared sends that now have a slot, explicit first (PRD §四.4).
   *
   * Reaching the Host-wide ceiling keeps work pending rather than refusing it.
   * A restart leaves those records `prepared`; this is what continues them when
   * a turn ends — not an automatic replay of a side effect.
   *
   * @returns how many sends the Host accepted this flush.
   */
  async flushPendingDispatches(): Promise<number> {
    return this.deps.store.withExclusive('target-dispatch', () => this.flushPendingDispatchesLocked())
  }

  private async flushPendingDispatchesLocked(): Promise<number> {
    const pending = this.deps.store.listOperations().filter(record =>
      record.delivery === 'prepared'
      && record.withdrawn === false
      && (record.kind === 'send' || this.isPendingInitialInstruction(record)))
    const ordered = pendingDispatchOrder(pending)
    let dispatched = 0
    for (const record of ordered) {
      const slots = this.occupiedSlots()
      const decision = admitPluginTurn({
        occupiedTargets: slots.target,
        occupiedNotices: slots.notice,
        ...this.deps.targetTurnConcurrency === undefined ? {} : { targetLimit: this.deps.targetTurnConcurrency },
        ...this.deps.noticeConcurrency === undefined ? {} : { noticeLimit: this.deps.noticeConcurrency },
        slot: 'target',
      })
      if (!decision.admit) break
      const accepted = record.kind === 'send'
        ? await this.dispatchPreparedSend(record.operationId)
        : await this.dispatchPreparedInitial(record.operationId)
      if (accepted) dispatched += 1
    }
    return dispatched
  }

  /**
   * Whether a create/fork still has an undelivered first instruction that a
   * slot may now take (PRD §四.4 新任务保持待派发).
   *
   * The session must already be ready: a preparation that has not finished must
   * not be flushed as if it were a send.
   *
   * @param record - a stored operation.
   * @returns whether flush may dispatch it as an initial instruction.
   */
  private isPendingInitialInstruction(record: StoredOperationRecord): boolean {
    if (record.kind !== 'create' && record.kind !== 'fork') return false
    const instruction = storedInstruction(record)
    if (instruction === undefined) return false
    const taskId = record.taskId
    if (taskId === undefined) return false
    const task = this.deps.store.getTask(taskId)
    return task?.preparation === 'ready'
  }

  /**
   * Hand a prepared create/fork first instruction to the Host.
   *
   * @param operationId - the prepared create or fork.
   * @returns whether the Host accepted it.
   */
  private async dispatchPreparedInitial(operationId: string): Promise<boolean> {
    const record = this.deps.store.getOperation(operationId)
    if (record === undefined || record.delivery !== 'prepared' || record.withdrawn) return false
    if (!this.isPendingInitialInstruction(record)) return false
    const instruction = storedInstruction(record)
    const taskId = record.taskId
    if (instruction === undefined || taskId === undefined) return false
    const task = this.deps.store.getTask(taskId)
    if (task === undefined || task.currentBindingId === undefined) return false
    const binding = this.deps.store.getBinding(task.currentBindingId)
    if (binding === undefined) return false
    const agent = this.deps.agents.get(SessionId(binding.sessionId))
    if (agent === undefined) return false
    const message = this.deps.createMessage(instruction, relaySource())
    const armedAt = this.deps.now()
    await this.deps.store.updateOperation(operationId, current => ({ ...current, messageId: message.id }))
    // This is deliberately not a Watch. A watch is user-requested continuous
    // monitoring; this one-shot record only waits for the exact initial relay
    // message that this create/fork operation is about to hand to the Host. It
    // is persisted before `followup()` so a very fast child turn cannot finish
    // between the Host acceptance and the callback becoming observable.
    await this.deps.store.updateTask(taskId, current => ({
      ...current,
      completionReturn: {
        operationId,
        bindingId: binding.bindingId,
        bindingVersion: binding.version,
        messageId: message.id,
        phase: 'armed',
        armedAt,
        updatedAt: armedAt,
      },
    }))
    await this.deps.store.markDelivery(operationId, 'dispatching', 'dispatching_initial_message')
    await this.deps.store.updateTask(taskId, current => ({
      ...current,
      preparation: 'ready',
      preparationPhase: 'dispatching_initial_message',
    }))
    /**
     * `followup()` can synchronously start and finish a Host turn before its
     * optional flush rejects.  Preserve the delivery receipt without allowing
     * that late failure path to replace a callback a completion pass already
     * made terminal.  The control lock is the same commit boundary used by
     * binding and access changes.
     */
    const markArmedCallbackDelivery = async (
      phase: 'delivery_failed' | 'delivery_unknown',
      reason: string,
    ): Promise<void> => {
      await this.deps.store.withExclusive(`control-commit:${taskId}`, async () => {
        await this.deps.store.updateTask(taskId, current => {
          const callback = current.completionReturn
          if (callback === undefined || callback.phase !== 'armed'
            || callback.operationId !== operationId
            || callback.bindingId !== binding.bindingId
            || callback.bindingVersion !== binding.version
            || callback.messageId !== message.id) return current
          return {
            ...current,
            completionReturn: { ...callback, phase, reason, updatedAt: this.deps.now() },
          }
        })
      })
    }
    const refusal = this.dispatchRefusal(operationId)
    if (refusal !== undefined) {
      await this.deps.store.markDelivery(operationId, 'failed', refusal)
      await markArmedCallbackDelivery('delivery_failed', refusal)
      return false
    }
    try {
      agent.followup(message)
      await this.deps.flushSession?.(agent)
    } catch (error) {
      await this.deps.store.markDelivery(operationId, 'unknown', describeFailure(error))
      const reason = describeFailure(error)
      await markArmedCallbackDelivery('delivery_unknown', reason)
      return false
    }
    await this.deps.store.markDelivery(operationId, 'accepted', 'initial_message_accepted')
    await this.deps.store.updateTask(taskId, current => ({
      ...current,
      preparation: 'ready',
      preparationPhase: 'initial_message_accepted',
    }))
    return true
  }

  /**
   * Hand one prepared send to the Host.
   *
   * @param operationId - the prepared send.
   * @returns whether the Host accepted it.
   */
  private async dispatchPreparedSend(operationId: string): Promise<boolean> {
    const record = this.deps.store.getOperation(operationId)
    if (record === undefined || record.delivery !== 'prepared' || record.withdrawn) return false
    const params = (record.params ?? {}) as {
      taskId?: unknown
      text?: unknown
      mode?: unknown
      expectedBindingVersion?: unknown
      expectedOwnerEpoch?: unknown
    }
    const taskId = record.taskId ?? (typeof params.taskId === 'string' ? params.taskId : undefined)
    const text = typeof params.text === 'string' ? params.text : undefined
    const mode = params.mode === 'queue' ? 'queue' : 'steer'
    if (taskId === undefined || text === undefined) return false
    const task = this.deps.store.getTask(taskId)
    if (task === undefined || task.preparation !== 'ready' || task.currentBindingId === undefined) return false
    const binding = this.deps.store.getBinding(task.currentBindingId)
    if (binding === undefined) return false
    const pinned = typeof params.expectedBindingVersion === 'number' ? params.expectedBindingVersion : undefined
    if (pinned !== undefined && binding.version !== pinned) {
      // PRD §二.10.2: a write that named the retired binding must not land on
      // the predecessor *or* silently follow the successor. Mark it failed so
      // recovery does not treat it as still pending.
      await this.deps.store.markDelivery(
        operationId,
        'failed',
        `STALE_BINDING: task ${taskId} is bound at version ${String(binding.version)}, not ${String(pinned)}`,
      )
      return false
    }
    const pinnedEpoch = typeof params.expectedOwnerEpoch === 'number' ? params.expectedOwnerEpoch : undefined
    const access = this.deps.store.getAccess(taskId)
    if (pinnedEpoch !== undefined && access !== undefined && access.ownerEpoch !== pinnedEpoch) {
      await this.deps.store.markDelivery(
        operationId,
        'failed',
        `STALE_OWNER_EPOCH: control of task ${taskId} is at epoch ${String(access.ownerEpoch)}, not ${String(pinnedEpoch)}`,
      )
      return false
    }
    const agent = this.deps.agents.get(SessionId(binding.sessionId))
    if (agent === undefined) return false
    const message = this.deps.createMessage(text, relaySource())
    const armedAt = this.deps.now()
    await this.deps.store.updateOperation(operationId, current => ({
      ...current,
      messageId: message.id,
      ...text.length === 0 ? {} : { completionReturn: {
        operationId, bindingId: binding.bindingId, bindingVersion: binding.version,
        messageId: message.id, phase: 'armed' as const, armedAt, updatedAt: armedAt,
      } },
    }))
    await this.deps.store.markDelivery(operationId, 'dispatching')
    const refusal = this.dispatchRefusal(operationId)
    if (refusal !== undefined) {
      await this.deps.store.markDelivery(operationId, 'failed', refusal)
      return false
    }
    try {
      this.dispatch(agent, message, mode)
      await this.deps.flushSession?.(agent)
    } catch (error) {
      await this.deps.store.markDelivery(operationId, 'unknown', describeFailure(error))
      return false
    }
    await this.deps.store.markDelivery(operationId, 'accepted', 'host_accepted')
    return true
  }

  /** Re-read trusted authority after the final persistence await, immediately before the Host call. */
  private dispatchRefusal(operationId: string): string | undefined {
    const record = this.deps.store.getOperation(operationId)
    if (record === undefined || record.withdrawn || record.delivery !== 'dispatching') return 'DISPATCH_WITHDRAWN: operation is no longer dispatchable'
    const guard = record.dispatchGuard
    if (guard === undefined) return 'DISPATCH_AUTHORITY_UNKNOWN: this legacy operation has no recorded dispatch authority; resubmit under a new operation id'
    const taskId = record.taskId ?? ''
    const task = this.deps.store.getTask(taskId)
    if (task?.preparation !== 'ready') return 'NOT_READY: task is no longer ready'
    const access = this.deps.store.getAccess(taskId)
    if (access?.ownerEpoch !== guard.ownerEpoch) return 'STALE_OWNER_EPOCH: control changed after this operation was admitted'
    const control = writeControlRefusal(access, taskId, guard.ownerSessionId)
    if (control !== undefined) return `${control.code}: ${control.reason}`
    const binding = this.currentBinding(taskId)
    if (binding === undefined || binding.retiredAt !== undefined || binding.version !== guard.bindingVersion
      || (guard.bindingId !== undefined && binding.bindingId !== guard.bindingId)) {
      return 'STALE_BINDING: the admitted target binding is no longer current'
    }
    if (guard.requireIdle === true) {
      const agent = liveAgentOf(this.deps.agents.get(SessionId(binding.sessionId)))
      if (agent === undefined || openTurnOf(agent.session.events) !== undefined || pendingInputOf(agent.inbox).queue.length > 0) {
        return 'STOP_STATE_CHANGED: a new turn or queued input appeared before the stopped instruction could be sent'
      }
    }
    return this.deps.dispatchAdmission?.(record)
  }

  /**
   * Perform the actual Host call for one mode.
   *
   * Only the two delivery modes reach here. The interrupt modes are handled by
   * {@link stop}, because they are a stop followed by a send rather than a
   * different way of handing a message to the Host — and the guard below is what
   * keeps that true if a caller ever invents a new mode.
   *
   * @param agent - the target agent.
   * @param message - the message to deliver.
   * @param mode - the requested mode.
   * @throws {ConductorError} for a mode this build does not implement correctly.
   */
  private dispatch(agent: AgentLike, message: unknown, mode: SendMode): void {
    switch (mode) {
      case 'steer':
        agent.steer(message)
        return
      case 'queue':
        agent.followup(message)
        return
      case 'interrupt':
      case 'interrupt_and_send':
        throw new ConductorError(
          'MODE_NOT_SUPPORTED',
          `mode ${mode} reached the delivery path, which only performs steer and queue; it must be handled by the `
          + 'stop sequence, where the expected turn is verified before anything is cancelled',
        )
    }
  }
}

/**
 * Digest the parameters of a send request, for tests that need to reason about
 * operation identity without reaching into the store.
 * @param request - the send request.
 * @returns the parameter digest.
 */
export function sendParamDigest(request: Pick<SendRequest, 'taskId' | 'text' | 'mode'>): string {
  return paramDigest('send', { taskId: request.taskId, text: request.text, mode: request.mode })
}

/** The first instruction stored on a create or fork, when one was given. */
function hasInitialInstruction(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

function storedInstruction(record: StoredOperationRecord): string | undefined {
  const params = (record.params ?? {}) as { instruction?: unknown }
  return typeof params.instruction === 'string' && hasInitialInstruction(params.instruction) ? params.instruction : undefined
}
