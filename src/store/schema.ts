/**
 * The conductor's own storage domain (PRD §三.5 "数据域").
 *
 * The specification requires business data to live in an independent
 * `storageDomain`, and forbids adding custom Session events or writing the
 * Host's JSONL. This module is that domain: one declaration that owns its
 * identity, format version and record schemas.
 *
 * Two properties of the Host's domain layer shape everything here:
 *
 * - **A version mismatch is a hard rejection at open, not a silent rewrite.**
 *   The medium is stamped with `version`. This plugin copies the file and
 *   applies numbered steps in `store/migrate.ts` *before* that open, and a
 *   failed step restores the copy so the stamp does not advance. The version
 *   is bumped only together with a step in that chain, never casually.
 * - **Every stored record is validated at open.** A record that no longer
 *   matches its schema fails the whole open with `invalid-record`. That is why
 *   the records below are closed objects with explicit optional members rather
 *   than loose bags.
 *
 * @module dsh-session-conductor/store/schema
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  ACCEPTANCE_STATES,
  DELIVERY_STATES,
  PREPARATION_PHASES,
  PREPARATION_STATES,
  START_STRATEGIES,
  TURN_OUTCOMES,
} from '../domain/state.ts'

/**
 * Domain name. It is also the backend unit name and the storage file name, and
 * the Host applies no per-plugin namespacing, so it is chosen to be unlikely to
 * collide and is never derived from a package name at runtime.
 */
export const DOMAIN_NAME = 'session_conductor'

/** Format version of the domain above. See the module note before changing it. */
export const DOMAIN_VERSION = 1

/** How a task's starting context was produced (PRD §二.2.2). */
export const CONTEXT_MODES = ['empty', 'brief', 'fork'] as const
export type ContextMode = (typeof CONTEXT_MODES)[number]

/** Who asked for a task, as established from a Host-owned context, never from model text. */
export const CALLER_KINDS = ['user', 'relay', 'notice', 'rule'] as const
export type CallerKind = (typeof CALLER_KINDS)[number]

/**
 * Where a message came from (PRD §四.2), as a stored record.
 *
 * A zod schema rather than a bare interface because it is embedded in the operation record: §四.2
 * requires a rule execution to be **associated with** `grantId`, `ruleId` and `sourceEventId`, and
 * the association has to live somewhere durable. It lives on the operation the dispatch claimed, so
 * any message can be traced back to the authorisation that caused it — which is the only way to
 * answer "why was this sent to my task?" after the fact.
 */
export const messageSourceRecord = z.object({
  kind: z.enum(CALLER_KINDS),
  /** Rule execution attribution; present only for `rule`. */
  grantId: z.string().optional(),
  ruleId: z.string().optional(),
  sourceEventId: z.string().optional(),
})

export type MessageSourceRecord = z.infer<typeof messageSourceRecord>

/** Identity of the Host session currently carrying a logical task. */
export const bindingRecord = z.object({
  /** Stable identity of this binding, unique per binding attempt. */
  bindingId: z.string().min(1),
  taskId: z.string().min(1),
  hostId: z.string().min(1),
  sessionId: z.string().min(1),
  /** Monotonic version within the task; a stale writer is rejected by comparison. */
  version: z.number().int().nonnegative(),
  /** Working directory the session was created in, when the Host reported one. */
  cwd: z.string().optional(),
  /** Workspace the session is attached to, when one was registered. */
  workspaceId: z.string().optional(),
  /** Binding this one replaced, forming the session chain a handoff displays. */
  predecessorBindingId: z.string().optional(),
  /**
   * Last source-session event seq this successor was frozen through
   * (PRD §二.10.2 固定历史与文件状态). Absent on a binding that is not a handoff
   * successor, and absent when the source log was empty so the boundary was
   * named as unchecked rather than stored as if it were known.
   */
  frozenThroughSeq: z.number().int().optional(),
  createdAt: z.string(),
  /** Set when this binding stops being current; kept for the chain. */
  retiredAt: z.string().optional(),
})

/** One logical task (PRD §二.1 `Task`). */
export const taskRecord = z.object({
  taskId: z.string().min(1),
  title: z.string(),
  /** Plugin-owned grouping; the Host sidebar is untouched. */
  groupId: z.string().optional(),
  pinned: z.boolean(),
  /** Archiving is a conductor-level organisation fact, never a host archive call. */
  archived: z.boolean(),
  /** Session that coordinates this task. */
  controllerSessionId: z.string().min(1),
  /** Who asked for the task, from a Host-trusted context. */
  requestedBy: z.enum(CALLER_KINDS),
  contextMode: z.enum(CONTEXT_MODES),
  preparation: z.enum(PREPARATION_STATES),
  preparationPhase: z.enum(PREPARATION_PHASES),
  /** Current binding; absent until a session exists and is ready. */
  currentBindingId: z.string().optional(),
  /** Task this one was forked from, when created by a fork. */
  sourceTaskId: z.string().optional(),
  /** Reason the last preparation failed, or why the task was cancelled. */
  failureReason: z.string().optional(),
  /**
   * The project this task's working directory was derived from (PRD §二.4).
   *
   * Kept beside the Host workspace registration rather than inside it, because the association
   * "this worktree belongs to that project" is the conductor's own fact: the Host registry knows
   * the worktree as a directory and nothing about where it came from, and deleting a workspace
   * registration must not destroy the record of the project the task is still working on.
   */
  originRepoPath: z.string().optional(),
  /**
   * The Host preset this task's session was composed with (PRD §二.3).
   *
   * Written only when a preset was requested **and** the session was created, so it means "the composition
   * this task actually got" rather than "the one somebody asked for". Absent for every task created before
   * the parameter existed, and for one that took the Host's own default — which is why the field is
   * optional and why its absence needs no format-version bump.
   */
  preset: z.string().optional(),
  /** Frozen before workspace preparation; optional for records from older builds. */
  configurationSnapshot: z.object({
    selection: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() }).optional(),
    origin: z.enum(['explicit', 'host_default', 'source_session', 'unavailable']),
    preset: z.string().optional(),
    capturedAt: z.string(),
    modelApplied: z.boolean(),
    modelWriteStarted: z.boolean().optional(),
  }).optional(),
  /** The Git starting state this task was prepared from. */
  start: z.object({
    strategy: z.enum(START_STRATEGIES),
    /** The commit actually pinned, never the branch name it was resolved from. */
    commit: z.string(),
    /** Whether the working directory is a worktree this conductor created. */
    created: z.boolean(),
  }).optional(),
  /**
   * The Host workspace registered for the working directory.
   *
   * Optional because a composition may mount no workspace registry at all, and a missing service
   * is reported in `workspaceFailure` rather than being papered over by leaving this unset.
   */
  workspaceId: z.string().optional(),
  /** Why the directory could not be registered as a workspace, when it could not be. */
  workspaceFailure: z.string().optional(),
  /**
   * What starting context the task actually got (PRD §二.2.2).
   *
   * Recorded separately from `contextMode`, which is what was *asked for*. The two can differ —
   * that is the whole point of having both — and a task whose record said `brief` while the target
   * received nothing would be claiming a context it never had.
   *
   * A **fork** leaves this unset: its context is the seeded completed-turn prefix, which the Host
   * replays from the session log itself, and it is recorded as a `contexts` snapshot (source
   * session, cutoff, content version) rather than as a message the conductor injected.
   */
  context: z.object({
    mode: z.enum(CONTEXT_MODES),
    /**
     * `injected` once the Host took the message; `none` when nothing was handed over.
     *
     * `none` covers two situations that must not be confused with each other or with success, and
     * `reason` says which one it was: the mode carries no context at all, or a context was wanted
     * and could not be produced. The task is still created in the second case — PRD §一.5 requires a
     * missing ability to disable that ability and show the reason, not to fail the whole request.
     */
    status: z.enum(['injected', 'none']),
    /** Why nothing was delivered; present whenever `status` is `none`. */
    reason: z.string().optional(),
    /** Session the brief was built from; absent for the modes that carry no brief. */
    sourceSessionId: z.string().optional(),
    /** Last event sequence the brief is exact at; `-1` when the source had no completed turn. */
    cutoffSeq: z.number().int().optional(),
    /** Version of this brief's content for that source. */
    contentVersion: z.number().int().nonnegative().optional(),
    /** Deterministic digest of the rendered brief. */
    contentDigest: z.string().optional(),
  }).optional(),
  /**
   * One non-model completion return for the instruction that created or forked
   * this task.
   *
   * This is deliberately a task-local, one-shot record rather than a Watch:
   * a watch is continuous monitoring that reports every meaningful event, while
   * this record follows only the first relay message created with this task.
   * The parent chat reads it through the native creation card; it never wakes a
   * parent Agent, consumes a history cursor, or authorises another action.
   *
   * Optional for records written before completion returns existed. Its absence
   * means either that the task was created without an initial instruction or
   * that an older build created it, so adding it needs no format-version bump.
   */
  completionReturn: z.object({
    /** Creation/fork operation that owns this one callback. */
    operationId: z.string().min(1),
    /** Binding and version the initial delegated message was accepted on. */
    bindingId: z.string().min(1),
    bindingVersion: z.number().int().nonnegative(),
    /** Host message identity of the initial relay. Never infer a turn without it. */
    messageId: z.string().min(1),
    /**
     * `armed` waits for the exact relay to enter the Host log; `running` has
     * found its first turn; `returned` has one terminal fact. `delivery_unknown`
     * and `delivery_failed` preserve an uncertain or failed first dispatch
     * without pretending that no child work happened.
     */
    phase: z.enum(['armed', 'running', 'returned', 'delivery_unknown', 'delivery_failed']),
    armedAt: z.string(),
    messageSeq: z.number().int().optional(),
    turn: z.number().int().optional(),
    startSeq: z.number().int().optional(),
    endSeq: z.number().int().optional(),
    outcome: z.enum(TURN_OUTCOMES).optional(),
    detail: z.string().optional(),
    /** Bounded public assistant text from the matched initial turn only. */
    preview: z.string().optional(),
    completedAt: z.string().optional(),
    /** Honest reason when delivery or observation cannot be confirmed. */
    reason: z.string().optional(),
    updatedAt: z.string(),
  }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Control relationship of one task (PRD §一.3, §二.10.1). */
export const accessRecord = z.object({
  taskId: z.string().min(1),
  /** The single plugin write controller. */
  ownerSessionId: z.string().min(1),
  /** Incremented on every transfer; a late write from an older epoch is refused. */
  ownerEpoch: z.number().int().nonnegative(),
  /** Read-only observers; several may exist. */
  observerSessionIds: z.array(z.string()),
  /**
   * Set when management was released (PRD §二.5).
   *
   * The record is kept rather than deleted: releasing management stops the
   * monitoring and blocks new automatic actions, but it must not erase the
   * coordination record or anything already accepted. Optional so a record
   * written before this field existed still validates — which is why adding it
   * does not require a format-version bump.
   */
  detachedAt: z.string().optional(),
  updatedAt: z.string(),
})

/** One persisted operation (PRD §四.1). Mirrors `domain/operation.ts`. */
export const operationRecord = z.object({
  operationId: z.string().min(1),
  kind: z.string().min(1),
  paramDigest: z.string().min(1),
  /**
   * The request's parameters, kept so a preparation can be **resumed** (PRD §三.3 `operation`).
   *
   * §四.1 requires the stable id, the message id, the parameter digest and the phase; it does not
   * require the parameters themselves. They are kept anyway because "继续可恢复阶段" cannot be
   * honoured without them: a resumed preparation has to send the instruction that was asked for,
   * and re-deriving it from the caller would let a resume continue a half-remembered request.
   *
   * Optional, so a record written before this field existed still validates — which is why adding
   * it does not require a format-version bump. It is written for the same idempotency reason the
   * digest is: a replay returns the original record, so the original request is what it describes.
   */
  params: z.unknown().optional(),
  /** Durable prepared result used to reconcile external side effects without re-planning. */
  result: z.unknown().optional(),
  /**
   * What caused this operation, when something other than a person did (PRD §四.2).
   *
   * A rule execution records `grantId`, `ruleId` and `sourceEventId` here, so the message a target
   * receives can be traced to the authorisation, the rule and the exact event behind it.
   */
  attribution: messageSourceRecord.optional(),
  /** Trusted authority captured at admission, independently of optional caller pins. */
  dispatchGuard: z.object({
    ownerSessionId: z.string().min(1),
    ownerEpoch: z.number().int().nonnegative(),
    bindingId: z.string().optional(),
    bindingVersion: z.number().int().nonnegative(),
    requireIdle: z.boolean().optional(),
  }).optional(),
  /**
   * Opaque 32-byte capability issued by the native creation card's own tool
   * result. It is a local, read-only bearer scoped to this create/fork
   * operation; it is deliberately not part of `params`, so a retry keeps the
   * original capability instead of changing the operation's identity.
   *
   * Optional for operations recorded before native-card capabilities existed.
   * A legacy operation simply has no completion-return projection over the
   * unauthenticated HTTP route.
   */
  sessionLinkCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  /** Per-send receipt; the original create/fork receipt remains on Task. */
  completionReturn: taskRecord.shape.completionReturn,
  /** User-UI acknowledgement, separate from model history/watch cursors. */
  overviewReadAt: z.string().optional(),
  taskId: z.string().optional(),
  messageId: z.string().optional(),
  delivery: z.enum(DELIVERY_STATES),
  phase: z.string().optional(),
  withdrawn: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One reader's independent progress cursors and pending interventions for one target (PRD §二.7). */
export const watchRecord = z.object({
  controllerSessionId: z.string().min(1),
  taskId: z.string().min(1),
  /** Durable cursor for automatic background reports for this reader alone. */
  cursor: z.string(),
  /**
   * Cursor of direct `conductor_read` history pages.
   *
   * Optional so records from before history pages were separated remain
   * readable. Absence deliberately means "no direct history has been read",
   * rather than inheriting a watch or wait position and hiding history.
   */
  historyCursor: z.string().optional(),
  /** Binding whose public history the direct cursor belongs to. */
  historyBindingId: z.string().optional(),
  /**
   * Cursor of synchronous `conductor_wait` observations.
   *
   * Waiting reports only wake facts; it must not consume the direct history a
   * later read needs to show the actual result.
   */
  waitCursor: z.string().optional(),
  /** Binding whose wake observations the synchronous wait cursor belongs to. */
  waitBindingId: z.string().optional(),
  /**
   * Whether this record has an active automatic background watch.
   *
   * A direct read or wait also needs durable per-reader cursors, but it must
   * not silently turn on background reports. Older records predate this bit and
   * retain their original active-watch interpretation.
   */
  watchEnabled: z.boolean().optional(),
  /** Events reported but not yet acknowledged, so they are not reported twice. */
  deliveredEventIds: z.array(z.string()),
  lastNotifiedAt: z.string().optional(),
  /**
   * What a person must still do on this target (PRD §三.5 Watch 待介入事项).
   *
   * Optional: a watch recorded before the field existed has none, and a target
   * that is not waiting has none. Opening a panel does not clear this.
   */
  pendingIntervention: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One queued or delivered report to a controller session (PRD §二.8.1). */
export const notificationRecord = z.object({
  notificationId: z.string().min(1),
  controllerSessionId: z.string().min(1),
  taskId: z.string().min(1),
  /** Host event that produced this report. */
  sourceEventId: z.string(),
  /** Observation-only summary; never a dispatch instruction. */
  summary: z.string(),
  delivery: z.enum(DELIVERY_STATES),
  withdrawn: z.boolean(),
  /** When the controller acknowledged this report as read. Opening a panel does not set this. */
  acknowledgedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/**
 * One generated handoff brief (PRD §二.2.2, §三.5 `ContextSnapshot`).
 *
 * The specification requires a brief to record where it came from, how far the
 * history was read, when it was made, and which content version it is, so that a
 * later reader can tell whether the brief still describes the work it was taken
 * from.
 */
export const contextSnapshotRecord = z.object({
  snapshotId: z.string().min(1),
  /**
   * Logical task the brief was generated from, when the source *is* a managed task.
   *
   * Optional because a task's starting context is taken from the session that created it, and
   * that session need not be a managed task at all (PRD §一.2 keeps the two identities apart).
   * Recording a task id that does not exist would be exactly the identity mixing the
   * specification forbids, so the absence is recorded as an absence.
   */
  sourceTaskId: z.string().min(1).optional(),
  /** Host session the brief was generated from. */
  sourceSessionId: z.string().min(1),
  /** Last event sequence included; the cutoff the brief is exact at. */
  cutoffSeq: z.number().int(),
  /** Monotonic version of the brief's content for this source. */
  contentVersion: z.number().int().nonnegative(),
  /** Deterministic digest of the rendered brief, so a change is detectable. */
  contentDigest: z.string().min(1),
  /** Task the brief was delivered to as its starting context, when it was. */
  deliveredToTaskId: z.string().optional(),
  createdAt: z.string(),
})

/** Kinds of artifact the specification lists (PRD §二.9.1). */
export const ARTIFACT_KINDS = [
  'file', 'directory', 'link', 'patch', 'commit', 'test_report', 'service',
] as const

/**
 * Whether an artifact has been shown to exist, and whether it still is what was
 * recorded.
 *
 * These are deliberately not one flag. PRD §二.9.1 requires a model's claim to
 * produce an artifact to be distinguishable from the file having been found, and
 * from a check having passed — and requires a changed file to be reported as
 * changed rather than quietly substituted for.
 */
export const EXISTENCE_STATES = ['claimed', 'present', 'missing', 'changed'] as const

/**
 * One recorded artifact (PRD §二.9.1).
 *
 * The record keeps the four facts the specification refuses to merge: the model
 * **claimed** it, it was **verified present**, a check **passed**, and the user
 * **accepted** it. `existence` carries the first two and `acceptance` the last
 * two, so a reader can always tell which one it is looking at.
 */
export const artifactRecord = z.object({
  artifactId: z.string().min(1),
  /** Task the artifact came from. */
  taskId: z.string().min(1),
  /** Session the artifact was produced in, when it was produced in one. */
  sessionId: z.string().optional(),
  /** Turn of that session, when the producer named one. */
  turn: z.number().int().optional(),
  kind: z.enum(ARTIFACT_KINDS),
  name: z.string(),
  hostId: z.string().min(1),
  /** Filesystem path, when the artifact is one. */
  path: z.string().optional(),
  /** URL, when the artifact is one. */
  url: z.string().optional(),
  /** Git reference or commit, when the artifact is one. */
  gitRef: z.string().optional(),
  /** Digest of the content that was verified, when one was taken. */
  contentHash: z.string().optional(),
  /**
   * What the digest covers.
   *
   * A digest taken over a prefix of a file is recorded as such: a partial hash
   * presented as a whole-file hash would let a later reader treat a changed file
   * as unchanged.
   */
  hashScope: z.enum(['full', 'prefix']).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  /** Incremented each time verification finds the content changed. */
  contentVersion: z.number().int().nonnegative(),
  existence: z.enum(EXISTENCE_STATES),
  acceptance: z.enum(ACCEPTANCE_STATES),
  /**
   * Who recorded the acceptance, and when (PRD §二.9.1, §二.12).
   *
   * Optional, so a record written before the field existed still validates. Its absence is
   * meaningful rather than neutral: {@link acceptanceCounts} does **not** treat an unattributed
   * acceptance as one that may gate automatic work, because nothing then says the user or an
   * objective check accepted it.
   */
  acceptedBy: z.enum(['user', 'deterministic_check', 'model_review']).optional(),
  acceptedAt: z.string().optional(),
  /** Why the artifact is in that state — the evidence, not a restatement. */
  evidence: z.array(z.string()),
  /** Shared-constraint version this artifact was produced under, when known. */
  constraintVersion: z.number().int().nonnegative().optional(),
  /**
   * Shared constraints in force at registration (PRD §二.9.1 相关约束版本).
   *
   * Optional so a record written before the field existed still validates. A
   * single `constraintVersion` cannot name which constraint it belonged to, so
   * new registrations store this list instead.
   */
  constraints: z.array(z.object({
    constraintId: z.string().min(1),
    version: z.number().int().nonnegative(),
  })).optional(),
  /** Set when an existence check last ran. */
  verifiedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** How an artifact moves between tasks (PRD §二.9.2). */
export const TRANSFER_MODES = ['reference', 'snapshot_copy', 'patch'] as const

/**
 * One handoff attempt (PRD §二.9.2).
 *
 * The three flags are the specification's own vocabulary and are deliberately
 * not one status: a patch may have been **provided** without being **applied**,
 * and applied without being **verified**. Collapsing them is how "I sent it"
 * becomes "it is in place" without anyone checking.
 */
export const transferRecord = z.object({
  transferId: z.string().min(1),
  mode: z.enum(TRANSFER_MODES),
  artifactId: z.string().min(1),
  fromTaskId: z.string().min(1),
  toTaskId: z.string().min(1),
  /** Exact reference originally provided, so a replay cannot pick up later artifact content. */
  referenceText: z.string().optional(),
  /** The artifact or its content was offered to the receiver. */
  provided: z.boolean(),
  /** The receiver's state was actually changed — a copy written, a patch landed. */
  applied: z.boolean(),
  /** The resulting state was read back and confirmed. */
  verified: z.boolean(),
  /** Where the result went, when it went anywhere. */
  destination: z.string().optional(),
  /** Content hash the transfer was made against. */
  baselineHash: z.string().optional(),
  /** Content hash of the result, when one was taken. */
  resultHash: z.string().optional(),
  /** Why the transfer stopped, when it did. A conflict is never a success. */
  conflicts: z.array(z.string()),
  evidence: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** The events a one-time rule may be triggered by (PRD §二.8.2). */
export const RULE_TRIGGERS = ['turn_completed', 'turn_failed', 'artifact_accepted'] as const

/** One recorded firing of a rule. */
export const ruleFiring = z.object({
  /** The event that triggered it; also the deduplication identity. */
  sourceEventId: z.string().min(1),
  operationId: z.string().min(1),
  at: z.string(),
  /** Where the dispatch got to. */
  outcome: z.string().min(1),
  /**
   * The authorisation the firing ran under (PRD §四.2's `grantId`).
   *
   * Recorded per firing rather than read back from the rule: the rule's grant changes when it is
   * re-saved, so reading it later would attribute an old dispatch to a newer authorisation.
   */
  grantId: z.string().optional(),
})

/**
 * One user-authorised one-time rule (PRD §二.8.2, §三.5 `Grant / Rule`).
 *
 * The specification requires a saved rule to carry its source event, its input
 * requirement, its target, the exact action and instruction permitted, a maximum
 * execution count, and the authority it was granted under. All of those are
 * fields here, because a rule that can act on a target without stating its
 * limits is not an authorisation — it is a blank cheque.
 */
export const ruleRecord = z.object({
  ruleId: z.string().min(1),
  /** Bumped by every edit; a running evaluation pins the version it read. */
  version: z.number().int().nonnegative(),
  title: z.string(),
  trigger: z.enum(RULE_TRIGGERS),
  /** Task whose event triggers the rule. */
  sourceTaskId: z.string().min(1),
  /** Artifact that must exist and be accepted first, when the rule requires one. */
  requiredArtifactId: z.string().optional(),
  /** Task the action is performed on. */
  targetTaskId: z.string().min(1),
  /** Exactly what may be done; there is no free-form action field. */
  action: z.enum(['send', 'queue']),
  /** The instruction the action delivers. */
  instruction: z.string(),
  maxExecutions: z.number().int().positive(),
  /** Who authorised it, and in which session. */
  authorizedBy: z.string().min(1),
  /**
   * The authorisation this rule acts under (PRD §四.2's `grantId`).
   *
   * Minted on every save, so a re-save is a **new** authorisation rather than the same one quietly
   * extended, and a firing that already happened stays attributable to the grant it ran under.
   * Optional because a rule saved before the field existed has no grant identity to report — and
   * saying nothing is honest, where inventing one would attribute a past dispatch to a grant nobody
   * issued.
   */
  grantId: z.string().optional(),
  active: z.boolean(),
  /** ISO 8601 UTC instant after which the rule may no longer fire. */
  expiresAt: z.string().optional(),
  /** Every firing, newest last — the deduplication record. */
  firings: z.array(ruleFiring),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** How a schedule decides when to run (PRD §二.11). */
export const SCHEDULE_KINDS = ['once', 'interval', 'calendar'] as const

/** The kinds of occurrence a schedule has produced. */
/**
 * How one scheduled occurrence ended.
 *
 * `refused` is its own outcome rather than a `failed` or a `skipped_*`: PRD §二.13.2 requires a
 * reached budget limit to stop new automatic scheduling, and an occurrence stopped by a limit is a
 * decision the conductor made on purpose — reporting it as a failure would blame the schedule, and
 * as a skip would hide the reason.
 */
export const RUN_OUTCOMES = ['ran', 'missed', 'skipped_overlap', 'skipped_duplicate', 'refused', 'failed'] as const

/** One occurrence of a schedule. */
export const scheduleRun = z.object({
  /** The instant the occurrence was due, ISO 8601 UTC. */
  scheduledFor: z.string(),
  /** The instant it actually ran, when it did. */
  ranAt: z.string().optional(),
  outcome: z.enum(RUN_OUTCOMES),
  /** Why it did not run, when it did not. */
  reason: z.string().optional(),
})

/**
 * One saved schedule (PRD §二.11, §三.5 `Schedule`).
 *
 * Two fields carry the specification's harder rules. `timezone` is stored beside
 * the UTC instants because a calendar schedule's meaning is a *local* time — the
 * UTC instant is a consequence of it, not a substitute. And `graceMs` is the only
 * thing that authorises a catch-up run after downtime; without it a missed
 * one-shot stays missed, because the specification forbids replaying every missed
 * cycle.
 */
export const scheduleRecord = z.object({
  scheduleId: z.string().min(1),
  title: z.string(),
  kind: z.enum(SCHEDULE_KINDS),
  /** IANA zone the user chose; every instant is also stored in UTC beside it. */
  timezone: z.string().min(1),
  /** For `once`: the instant to run. For `interval` and `calendar`: the next due instant. */
  nextAt: z.string(),
  /** For `interval`: the spacing. */
  intervalMs: z.number().int().positive().optional(),
  /** For `calendar`: local wall-clock components in `timezone`. */
  wall: z.object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }).optional(),
  /**
   * What the occurrence does. `inspect` is the default and is read-only; an
   * execution plan must state its limits or it is saved as a draft.
   */
  action: z.enum(['inspect', 'send', 'queue']),
  targetTaskId: z.string().optional(),
  instruction: z.string().optional(),
  /** Required for an execution plan: how many times it may run in total. */
  maxRuns: z.number().int().positive().optional(),
  /** Required for an execution plan: when the plan stops being valid. */
  expiresAt: z.string().optional(),
  /** Only a stated grace window authorises one catch-up run after downtime. */
  graceMs: z.number().int().nonnegative().optional(),
  status: z.enum(['active', 'paused', 'draft', 'completed']),
  /** Why a plan is a draft rather than active. */
  draftReason: z.string().optional(),
  authorizedBy: z.string().min(1),
  runs: z.array(scheduleRun),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One node of a stored workflow definition (PRD §二.12). */
export const workflowNodeRecord = z.object({
  nodeId: z.string().min(1),
  taskId: z.string().min(1),
  /** Optional: a root node legitimately has no upstreams. */
  dependsOn: z.array(z.string()).optional(),
  inputArtifacts: z.array(z.string()).optional(),
  instruction: z.string().optional(),
  acceptance: z.string().optional(),
  failure: z.object({
    onFail: z.enum(['stop', 'continue', 'retry']),
    retries: z.number().int().nonnegative().optional(),
  }).optional(),
  requiresApproval: z.boolean().optional(),
})

/**
 * One saved workflow definition (PRD §二.12, §三.5 `Workflow`).
 *
 * `version` is stored beside the definition rather than derived from it, because a run
 * fixes the version it started under: a later edit must not silently change work in
 * flight, and it cannot be told apart from the original without a number that moves.
 */
export const workflowRecord = z.object({
  workflowId: z.string().min(1),
  title: z.string(),
  version: z.number().int().nonnegative(),
  nodes: z.array(workflowNodeRecord),
  rework: z.object({ maxRounds: z.number().int().nonnegative() }).optional(),
  budget: z.object({
    maxTurns: z.number().int().nonnegative().optional(),
    maxTokens: z.number().int().nonnegative().optional(),
    maxConcurrent: z.number().int().nonnegative().optional(),
  }).optional(),
  status: z.enum(['active', 'paused']),
  authorizedBy: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One node's state inside a stored run. */
export const workflowNodeRunRecord = z.object({
  nodeId: z.string().min(1),
  state: z.enum([
    'blocked', 'ready', 'running', 'waiting', 'validating', 'passed', 'failed', 'cancelled',
    // Names earlier builds stored when acceptance was collapsed into the node state.
    'pending', 'accepted', 'reviewed', 'inconclusive', 'skipped',
  ]),
  verdict: z.object({
    result: z.enum(['pass', 'fail', 'inconclusive']),
    by: z.enum(['user', 'deterministic_check', 'model_review']),
    command: z.string().optional(),
    output: z.string().optional(),
    evidence: z.array(z.string()).optional(),
    at: z.string(),
  }).optional(),
  attempts: z.number().int().nonnegative(),
  turnsUsed: z.number().int().nonnegative().optional(),
  /**
   * Who recorded the approval this node required, and when (PRD §二.12 condition 6).
   *
   * Optional, so a run recorded before the field existed still validates, and so a node that
   * requires no approval carries none.
   */
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  /**
   * Digest of the action and versions this approval bound (PRD §四.3).
   *
   * Optional so a run recorded before the field existed still validates.
   */
  approvedBinding: z.string().optional(),
})

/** One stored workflow run (PRD §二.12, §三.5 `WorkflowRun`). */
export const workflowRunRecord = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  /** The definition version this run fixed. */
  definitionVersion: z.number().int().nonnegative(),
  status: z.enum(['running', 'paused', 'needs_user', 'completed', 'cancelled']),
  reworkRoundsUsed: z.number().int().nonnegative(),
  reworkHistory: z.array(z.array(z.string())),
  nodes: z.array(workflowNodeRunRecord),
  /**
   * Everything this run fixed at start (PRD §三.3's "每次运行固定").
   *
   * Optional so a run recorded before the field existed still validates; a run without it reports
   * that it fixed nothing rather than pretending the current values were always its terms.
   */
  fixed: z.object({
    definitionVersion: z.number().int().nonnegative(),
    /** Each node's runtime configuration; missing legacy snapshots cannot authorize a new node. */
    modelConfigurations: z.array(z.object({
      nodeId: z.string().min(1), taskId: z.string().min(1), sessionId: z.string().min(1), bindingVersion: z.number().int().nonnegative(),
      selection: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() }),
      preset: z.string().optional(),
    })).optional(),
    authorisations: z.array(z.object({
      taskId: z.string().min(1),
      ownerSessionId: z.string().min(1),
      ownerEpoch: z.number().int().nonnegative(),
    })),
    constraints: z.array(z.object({
      constraintId: z.string().min(1),
      version: z.number().int().nonnegative(),
    })),
    artifacts: z.array(z.object({
      artifactId: z.string().min(1),
      contentVersion: z.number().int().nonnegative(),
    })),
    acceptance: z.array(z.object({ nodeId: z.string().min(1), rule: z.string() })),
    budget: z.string().optional(),
    /**
     * Each node's failure policy as frozen at start (PRD §二.12 失败处理).
     *
     * Optional so a run recorded before the field existed still validates; that
     * run consults the live definition rather than inventing `stop`.
     */
    failure: z.array(z.object({
      nodeId: z.string().min(1),
      onFail: z.enum(['stop', 'continue', 'retry']),
      retries: z.number().int().nonnegative().optional(),
    })).optional(),
    /**
     * The node graph this run executes (PRD §三.3).
     *
     * Optional so a run recorded before the snapshot existed still validates.
     */
    graph: z.array(workflowNodeRecord).optional(),
    title: z.string().optional(),
    rework: z.object({ maxRounds: z.number().int().nonnegative() }).optional(),
    budgetLimit: z.object({
      maxTurns: z.number().int().nonnegative().optional(),
      maxTokens: z.number().int().nonnegative().optional(),
      maxConcurrent: z.number().int().nonnegative().optional(),
    }).optional(),
  }).optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  /**
   * The run this one was opened from, when it is a partial rerun (PRD §三.3 重跑).
   *
   * Optional so an ordinary start still validates, and so a run recorded before
   * the field existed is not rejected. The source run is not deleted: this is a
   * pointer to the retained evidence, not a replacement of it.
   */
  sourceRunId: z.string().min(1).optional(),
  /** The nodes the caller named to redo; successors are derived, not stored here. */
  rerunOf: z.array(z.string().min(1)).optional(),
})

/**
 * One shared constraint (PRD §二.13.1).
 *
 * `version` is stored beside the text rather than derived: a run fixes the version it
 * started under, and a reader cannot tell a changed statement from an unchanged one
 * without a number that moves.
 */
export const constraintRecord = z.object({
  constraintId: z.string().min(1),
  kind: z.enum(['technical_choice', 'interface', 'prohibition', 'file_ownership', 'acceptance_requirement']),
  text: z.string().min(1),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/**
 * Where one target stands in receiving one constraint version (PRD §二.13.1).
 *
 * The four stages are recorded separately because they are four different facts:
 * "sent", "entered context", "target acknowledged" and "verified compliant".
 * Acknowledgement is not compliance, and the record keeps them apart.
 */
export const constraintDeliveryRecord = z.object({
  /** `<constraintId>@<version>::<targetId>` — one target, one version, one record. */
  deliveryKey: z.string().min(1),
  constraintId: z.string().min(1),
  version: z.number().int().nonnegative(),
  targetId: z.string().min(1),
  stage: z.enum(['sent', 'in_context', 'acknowledged', 'verified']),
  /** For `verified`: the check that established compliance. */
  checkCommand: z.string().optional(),
  checkOutput: z.string().optional(),
  updatedAt: z.string(),
})

/**
 * One budget policy (PRD §二.13.2).
 *
 * Every limit is optional: an absent one means "not limited here", which is different
 * from a limit of zero and must not be stored as one.
 */
export const budgetRecord = z.object({
  /** `<scope>::<targetId>` — one policy per governed thing. */
  policyKey: z.string().min(1),
  scope: z.enum(['task', 'group', 'workflow']),
  targetId: z.string().min(1),
  deadlineAt: z.string().optional(),
  maxConcurrent: z.number().int().nonnegative().optional(),
  maxDispatches: z.number().int().nonnegative().optional(),
  maxAttempts: z.number().int().nonnegative().optional(),
  maxReworkRounds: z.number().int().nonnegative().optional(),
  maxTokens: z.number().nonnegative().optional(),
  maxCost: z.number().nonnegative().optional(),
  /** True when the caller asked for a limit that must not be exceeded. */
  strict: z.boolean(),
  /**
   * When the second of PRD §二.13.2's three actions was last requested for this
   * policy. Optional so a policy written before the field existed still validates
   * (no format-version bump). Used so the background pass does not re-request
   * forever against an idle session.
   */
  cancelRequestedAt: z.string().optional(),
  /** Which limit the last cancel request was for. */
  cancelRequestedLimit: z.string().optional(),
  /** What that request reported as the actual stop state. */
  cancelOutcome: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One usage figure as stored (PRD §二.13.2's metering qualities). */
export const usageFactRecord = z.object({
  quality: z.enum(['actual_full', 'partial', 'estimated', 'unavailable']),
  /** Absent when unavailable: a number there would be read as a measurement. */
  value: z.number().optional(),
  missingRange: z.string().optional(),
  basis: z.string().optional(),
})

/**
 * The run ledger (PRD §二.13.2).
 *
 * Every field counts up. There is no reset anywhere in the code that writes it, because
 * a transfer, a restart or a retry must not be able to zero it — and the guarantee is
 * the absence of the operation, not a rule remembering not to call it.
 */
export const ledgerRecord = z.object({
  targetId: z.string().min(1),
  /** Durable event identities, saved atomically with their counter increments. */
  countedOperationIds: z.array(z.string()).optional(),
  firstDispatchedAt: z.string().optional(),
  dispatches: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  reworkRounds: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  reportTurns: z.number().int().nonnegative(),
  /**
   * Plugin-initiated acceptances (PRD §二.13.2's 验收计入账本).
   *
   * Optional so a ledger written before the field existed still validates — and it is read as `0` rather than
   * `undefined` at the boundary, because a counter that was never written counted nothing. That is why adding
   * it needs no format-version bump.
   */
  acceptances: z.number().int().nonnegative().optional(),
  tokens: usageFactRecord.optional(),
  cost: usageFactRecord.optional(),
  updatedAt: z.string(),
})

/**
 * One remote Host a user registered by hand (PRD §二.14.1).
 *
 * Registration is **explicit and named** — "work is never sent to a Host the user has not
 * named" — so the record holds only what identifies the Host and what it has reported
 * about itself. It deliberately holds **no credential**: the transport PRD §二.14.1
 * specifies uses the user's existing SSH configuration, and copying a key or a token into
 * the conductor's own store would be exactly the silent credential duplication the rules
 * forbid.
 */
export const remoteHostRecord = z.object({
  hostId: z.string().min(1),
  /** A label for the interface. Never a credential, and never a secret. */
  label: z.string(),
  /** Whether the user turned this registration on. */
  enabled: z.boolean(),
  // What the remote reported about itself. Absent means "not reached", which is different
  // from "reported nothing compatible" and is checked as such.
  protocolVersion: z.string().optional(),
  pluginVersion: z.string().optional(),
  models: z.array(z.string()).optional(),
  workspaceCapable: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/**
 * One published share (PRD §二.14.2).
 *
 * The record keeps the revocation instant rather than being deleted, because a deleted
 * record cannot answer "was this ever shared, and when did it stop?" — the question asked
 * after a leak, not before. Expiry is **not** stored: it is computed from `expiresAt`, so a
 * share cannot be "active" in the record and expired in reality.
 */
export const shareRecord = z.object({
  shareId: z.string().min(1),
  snapshotId: z.string().min(1),
  taskId: z.string().min(1),
  /** The unguessable path component; the whole of the far end's access control. */
  token: z.string().min(16),
  /** The cutoff the snapshot was fixed at. Nothing moves it after publishing. */
  cutoffAt: z.string(),
  publishedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().optional(),
})

/**
 * One plugin-owned resource the conductor registered (PRD §三.6, T32).
 *
 * Stop, archive, unmanage, migrate and uninstall never delete what this row
 * describes. Cleanup is a separate, explicit action against this registry:
 * the row carries the creation reason, whether anything still references it,
 * where it is kept, and — after a confirmed cleanup — the instant it was
 * cleaned. The record is kept rather than deleted so a later reader can tell
 * that a cleanup happened.
 *
 * Adding this table does not reject an existing medium (C30): a missing table
 * is empty, and that is the right reading for a store opened before the
 * registry existed.
 */
export const resourceRecord = z.object({
  resourceId: z.string().min(1),
  kind: z.literal('worktree'),
  path: z.string().min(1),
  /** The repository the worktree was added to, so `git worktree remove` has a cwd. */
  originRepoPath: z.string().optional(),
  taskId: z.string().min(1),
  /** The preparation that created it, when that operation id is known. */
  operationId: z.string().optional(),
  /** Why the conductor created it — the registry field PRD §三.6 names first. */
  createdReason: z.string().min(1),
  /** True when this conductor created the directory (as opposed to adopting one). */
  owned: z.boolean(),
  status: z.enum(['active', 'cleaned']),
  createdAt: z.string(),
  updatedAt: z.string(),
  cleanedAt: z.string().optional(),
  /** The cleanup operation that marked it, when one did. */
  cleanedBy: z.string().optional(),
})

/** Persisted global singleton: identity and recovery bookkeeping. */
export const domainGlobal = z.object({
  /** Schema version of the records below; written explicitly so a reader can tell. */
  schemaVersion: z.number().int().nonnegative(),
  /** First time this domain was materialised, ISO 8601 UTC. */
  initializedAt: z.string().optional(),
})

/** The conductor's domain declaration. */
export const conductorDomain = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  global: { schema: domainGlobal, initial: { schemaVersion: DOMAIN_VERSION } },
  tables: {
    tasks: domainTable<string, z.infer<typeof taskRecord>>(taskRecord),
    bindings: domainTable<string, z.infer<typeof bindingRecord>>(bindingRecord),
    access: domainTable<string, z.infer<typeof accessRecord>>(accessRecord),
    operations: domainTable<string, z.infer<typeof operationRecord>>(operationRecord),
    watches: domainTable<string, z.infer<typeof watchRecord>>(watchRecord),
    notifications: domainTable<string, z.infer<typeof notificationRecord>>(notificationRecord),
    contexts: domainTable<string, z.infer<typeof contextSnapshotRecord>>(contextSnapshotRecord),
    artifacts: domainTable<string, z.infer<typeof artifactRecord>>(artifactRecord),
    transfers: domainTable<string, z.infer<typeof transferRecord>>(transferRecord),
    rules: domainTable<string, z.infer<typeof ruleRecord>>(ruleRecord),
    schedules: domainTable<string, z.infer<typeof scheduleRecord>>(scheduleRecord),
    workflows: domainTable<string, z.infer<typeof workflowRecord>>(workflowRecord),
    workflow_runs: domainTable<string, z.infer<typeof workflowRunRecord>>(workflowRunRecord),
    constraints: domainTable<string, z.infer<typeof constraintRecord>>(constraintRecord),
    constraint_deliveries: domainTable<string, z.infer<typeof constraintDeliveryRecord>>(constraintDeliveryRecord),
    budgets: domainTable<string, z.infer<typeof budgetRecord>>(budgetRecord),
    ledgers: domainTable<string, z.infer<typeof ledgerRecord>>(ledgerRecord),
    remote_hosts: domainTable<string, z.infer<typeof remoteHostRecord>>(remoteHostRecord),
    shares: domainTable<string, z.infer<typeof shareRecord>>(shareRecord),
    resources: domainTable<string, z.infer<typeof resourceRecord>>(resourceRecord),
  },
})

/** Persisted task shape. */
export type TaskRecord = z.infer<typeof taskRecord>
/** Persisted binding shape. */
export type BindingRecord = z.infer<typeof bindingRecord>
/** Persisted access shape. */
export type AccessRecord = z.infer<typeof accessRecord>
/** Persisted operation shape (the storage projection of the domain model). */
export type StoredOperationRecord = z.infer<typeof operationRecord>
/** Persisted watch shape. */
export type WatchRecord = z.infer<typeof watchRecord>
/** Persisted notification shape. */
export type NotificationRecord = z.infer<typeof notificationRecord>
/** Persisted global shape. */
export type DomainGlobalRecord = z.infer<typeof domainGlobal>
/** Persisted handoff-brief record. */
export type ContextSnapshotRecord = z.infer<typeof contextSnapshotRecord>
/** Persisted artifact record. */
export type ArtifactRecord = z.infer<typeof artifactRecord>
/** Persisted transfer record. */
export type TransferRecord = z.infer<typeof transferRecord>
/** Persisted one-time rule. */
export type RuleRecord = z.infer<typeof ruleRecord>
/** One recorded firing of a rule. */
export type RuleFiring = z.infer<typeof ruleFiring>
/** Persisted schedule. */
export type ScheduleRecord = z.infer<typeof scheduleRecord>
/** One occurrence of a schedule. */
export type ScheduleRun = z.infer<typeof scheduleRun>
/** Persisted workflow definition. */
export type WorkflowRecord = z.infer<typeof workflowRecord>
/** Persisted workflow run. */
export type WorkflowRunRecord = z.infer<typeof workflowRunRecord>
/** Persisted shared constraint. */
export type ConstraintStoreRecord = z.infer<typeof constraintRecord>
/** Persisted constraint delivery. */
export type ConstraintDeliveryRecord = z.infer<typeof constraintDeliveryRecord>
/** Persisted budget policy. */
export type BudgetStoreRecord = z.infer<typeof budgetRecord>
/** Persisted run ledger. */
export type LedgerStoreRecord = z.infer<typeof ledgerRecord>
/** Persisted usage figure. */
export type UsageFactRecord = z.infer<typeof usageFactRecord>
/** Persisted remote-Host registration. */
export type RemoteHostRecord = z.infer<typeof remoteHostRecord>
/** Persisted published share. */
export type ShareStoreRecord = z.infer<typeof shareRecord>
/** Persisted plugin-owned resource (PRD §三.6). */
export type ResourceStoreRecord = z.infer<typeof resourceRecord>

/** Table names of {@link conductorDomain}, for keying and for tests. */
export const TABLE_NAMES = [
  'tasks', 'bindings', 'access', 'operations', 'watches', 'notifications',
  'contexts', 'artifacts', 'transfers', 'rules', 'schedules',
  'workflows', 'workflow_runs', 'constraints', 'constraint_deliveries', 'budgets', 'ledgers',
  'remote_hosts', 'shares', 'resources',
] as const
export type TableName = (typeof TABLE_NAMES)[number]
