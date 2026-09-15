/**
 * Background reporting (PRD §二.8.1).
 *
 * A report is a statement of *observed fact*, and three rules in the
 * specification shape this module more than the rest:
 *
 * 1. **Only some events are worth reporting.** Turn end, failure and interruption
 *    are; a raw token stream is not (§二.7). A turn *starting* is not a change a
 *    controller needs to be woken for. {@link REPORTABLE_OUTCOMES} is that list,
 *    and `turn_started` is deliberately absent.
 * 2. **A report must be quiet when nothing meaningful changed.** Waking a session
 *    to say "nothing happened" is worse than not waking it: it spends the
 *    controller's attention and its context on an absence.
 * 3. **A report is not an instruction.** The notice carries an observation, and
 *    the execution it triggers is forbidden from calling the coordination write
 *    interfaces. That last part is enforced *server-side* — see
 *    {@link NOTICE_TRIGGERED_REFUSAL} and `reportBarrierOf` in `tools.ts` — because
 *    a prompt is advice and a barrier is a guarantee.
 *
 * Everything here is a pure function of facts the caller supplies, so the merge
 * window and the quiet rule are testable at any instant without waiting.
 *
 * @module dsh-session-conductor/service/report
 */

import type { TurnOutcome } from '../domain/state.ts'
import type { NotableEvent, SessionEventLike } from './projection.ts'

/**
 * The turn outcomes a controller is woken for.
 *
 * `blocked` is included because the projection reports a token ceiling as
 * `blocked` and never as `completed`; a run that stopped for want of budget is
 * exactly the kind of thing a controller must hear about.
 */
export const REPORTABLE_OUTCOMES: readonly TurnOutcome[] = ['completed', 'failed', 'interrupted', 'blocked']

/** What a report is about. Each kind is a distinct fact, not a severity. */
export const REPORT_KINDS = [
  'turn_ended',
  'needs_intervention',
  'user_question',
  'artifact_changed',
  'artifact_missing',
  'handoff_conflict',
  'target_unavailable',
  'workflow_blocked',
  'budget_limited',
] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

/**
 * Kinds that mean a human or a controller has to decide something.
 *
 * PRD §二.8.1 groups "an artifact was lost, a handoff conflicted, a target was
 * lost" together as things to be told about, and each of them invalidates
 * something: a missing artifact is a pinned input that is gone, a changed one is a
 * pinned input that no longer matches what was verified, a conflict means two
 * pieces of work disagree, and an unavailable target means the work cannot
 * continue where it is. §二.8.1's "工作流受阻、预算达到限制" join them — a run stopped for the user and a
 * run that has spent its budget are decisions, not status reports — and so does a **question**, because
 * the target is waiting on an answer and will not proceed without one. A plain turn end is the one status
 * report here — it is worth hearing about, but on its own it does not demand a decision.
 */
const INTERVENTION_KINDS: readonly ReportKind[] = [
  'needs_intervention',
  'user_question',
  'artifact_changed',
  'artifact_missing',
  'handoff_conflict',
  'target_unavailable',
  'workflow_blocked',
  'budget_limited',
]

/** One observed fact worth reporting. */
export interface ReportFact {
  readonly taskId: string
  readonly sessionId: string
  /**
   * Durable identity of the thing observed.
   *
   * This is what makes a report non-repeating: the same fact carries the same id
   * however many times the log is folded, so a re-read or an overlapping watcher
   * recognises it as already reported instead of sending it again.
   */
  readonly eventId: string
  /** Sequence within the target's stream, for the persistent cursor. */
  readonly seq: number
  /** When it happened, in epoch milliseconds. */
  readonly at: number
  readonly kind: ReportKind
  readonly outcome?: TurnOutcome
  /** Observation-only, and written to be read as an observation. */
  readonly summary: string
}

/**
 * Fold one target's events into the facts a controller should hear about.
 *
 * Only events *after* the reader's cursor are considered, which is what makes a
 * persistent cursor meaningful: a restart re-reads the same log and produces the
 * same facts, and the delivered-id list — not the cursor alone — decides whether
 * they are new. Reading both keeps a crash between "reported" and "cursor saved"
 * from producing a duplicate wake.
 *
 * @param target - which task and session the events belong to.
 * @param events - the session's events, in sequence order.
 * @param afterSeq - the reader's cursor; events at or below it are already known.
 * @returns the reportable facts, in the order they occurred.
 */
export function factsOf(
  target: { readonly taskId: string; readonly sessionId: string },
  events: readonly SessionEventLike[],
  afterSeq = -1,
): ReportFact[] {
  const facts: ReportFact[] = []
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    const at = typeof event.time === 'number' ? event.time : 0
    if (event.type === 'turn/end') {
      const data = (event.data ?? {}) as Record<string, unknown>
      const outcome = typeof data['outcome'] === 'string' ? data['outcome'] as TurnOutcome : undefined
      // The projection is the only place that interprets a turn end, so the
      // outcome here comes from it rather than from a second reading of the same
      // payload. A caller that has the projection passes the vetted outcome in
      // through `notableFactsOf`; this path exists for a caller that does not.
      if (outcome === undefined || !REPORTABLE_OUTCOMES.includes(outcome)) continue
      facts.push({
        taskId: target.taskId,
        sessionId: target.sessionId,
        eventId: `${target.sessionId}#${String(event.seq)}`,
        seq: event.seq,
        at,
        kind: 'turn_ended',
        outcome,
        summary: `turn ${String(data['turn'] ?? '?')} ended: ${outcome}`,
      })
      continue
    }
    if (event.type === 'approval/asked') {
      const data = (event.data ?? {}) as Record<string, unknown>
      const toolName = data['toolName'] === undefined ? undefined : String(data['toolName'])
      facts.push({
        taskId: target.taskId,
        sessionId: target.sessionId,
        eventId: `${target.sessionId}#${String(event.seq)}`,
        seq: event.seq,
        at,
        kind: 'needs_intervention',
        summary: `waiting for approval${toolName === undefined ? '' : ` of ${toolName}`}`,
      })
    }
  }
  return facts
}

/**
 * Turn already-interpreted notable events into facts.
 *
 * Preferred over {@link factsOf} wherever a projection is available: the outcome
 * has then been mapped once, by the same code every other reader uses, so a report
 * cannot disagree with what `conductor_read` or `conductor_wait` says about the
 * same turn.
 *
 * @param target - which task and session the events belong to.
 * @param notable - notable events from the projection, with their seq.
 * @returns the reportable facts, in the order they occurred.
 */
export function notableFactsOf(
  target: { readonly taskId: string; readonly sessionId: string },
  notable: readonly { readonly event: NotableEvent; readonly seq: number; readonly at?: number }[],
): ReportFact[] {
  const facts: ReportFact[] = []
  for (const entry of notable) {
    const at = entry.at ?? 0
    if (entry.event.kind === 'turn_ended') {
      // A turn that merely started is not a change worth waking anyone for.
      if (!REPORTABLE_OUTCOMES.includes(entry.event.outcome)) continue
      facts.push({
        taskId: target.taskId,
        sessionId: target.sessionId,
        eventId: `${target.sessionId}#${String(entry.seq)}`,
        seq: entry.seq,
        at,
        kind: 'turn_ended',
        outcome: entry.event.outcome,
        summary: `turn ${String(entry.event.turn)} ended: ${entry.event.outcome} (${entry.event.detail})`,
      })
      continue
    }
    if (entry.event.kind === 'approval_asked') {
      facts.push({
        taskId: target.taskId,
        sessionId: target.sessionId,
        eventId: `${target.sessionId}#${String(entry.seq)}`,
        seq: entry.seq,
        at,
        kind: 'needs_intervention',
        summary: `waiting for approval${entry.event.toolName === undefined ? '' : ` of ${entry.event.toolName}`}`
          + ` (${entry.event.approvalId})`,
      })
      continue
    }
    if (entry.event.kind === 'user_question') {
      // §二.8.1's "用户问题". Reported as the question rather than as a turn that ended, because what the
      // controller has to do about it is answer — and reported from the tool call, which is the only
      // evidence the log carries (see `QUESTION_TOOL_NAMES`).
      facts.push({
        taskId: target.taskId,
        sessionId: target.sessionId,
        eventId: `${target.sessionId}#${String(entry.seq)}`,
        seq: entry.seq,
        at,
        kind: 'user_question',
        summary: `asked its user a question (${entry.event.toolName} call ${entry.event.callId}), so it is `
          + 'waiting on an answer before it can continue',
      })
    }
  }
  return facts
}

/**
 * Build a fact that did not come from the target's own event stream.
 *
 * An artifact that has gone missing, a handoff that conflicted, a target that is no
 * longer live: none of those are session events, so they cannot be folded out of a
 * log. They arrive from the code that observed them, and they carry their own
 * durable identity for exactly the same reason the folded ones do.
 *
 * @param fact - the observed fact.
 * @returns the report fact.
 */
export function externalFact(fact: {
  readonly taskId: string
  readonly sessionId: string
  readonly eventId: string
  readonly at: number
  readonly kind: Extract<
    ReportKind,
    'artifact_changed' | 'artifact_missing' | 'handoff_conflict' | 'target_unavailable'
    | 'workflow_blocked' | 'budget_limited'
  >
  readonly summary: string
}): ReportFact {
  // `seq: -1` is deliberate: an external fact has no position in the target's
  // stream, and inventing one would corrupt the reader's cursor.
  return { ...fact, seq: -1 }
}

/** Whether a fact is one a controller has to act on. */
export function needsIntervention(fact: ReportFact): boolean {
  return INTERVENTION_KINDS.includes(fact.kind)
}

/** One artifact as the store records it, reduced to what a report needs. */
export interface StoredArtifactFact {
  readonly artifactId: string
  readonly name: string
  readonly kind: string
  /** `claimed`, `present`, `missing` or `changed` (PRD §三.4). */
  readonly existence: string
  readonly contentVersion: number
  /** When existence was last checked, or when the artifact was recorded. */
  readonly observedAt: string
}

/** One transfer as the store records it, reduced to what a report needs. */
export interface StoredTransferFact {
  readonly transferId: string
  readonly artifactId: string
  readonly fromTaskId: string
  readonly toTaskId: string
  readonly conflicts: readonly string[]
  readonly applied: boolean
  readonly updatedAt: string
}

/**
 * One governing budget that **refuses**, as the budget gate itself decided it.
 *
 * The decision is handed in rather than recomputed here: `budgetDecision` is the single implementation of
 * what a limit means, and a second one written for the report would be free to disagree with the gate that
 * actually stops dispatches.
 */
export interface StoredBudgetFact {
  /** The policy's own key, so a reader can find the limit that was reached. */
  readonly policyKey: string
  /** Which limit was reached, when the decision named one. */
  readonly limit?: string | undefined
  readonly reason: string
  /** The run's anchor, when the ledger has one — what makes one run's fact different from the next run's. */
  readonly firstDispatchedAt?: string | undefined
  /** When the limit was reached, when the policy itself fixes the instant (a deadline). */
  readonly reachedAt?: string | undefined
}

/** One workflow run as the store records it, reduced to what a report needs. */
export interface StoredWorkflowFact {
  readonly runId: string
  readonly workflowId: string
  /** `running`, `paused`, `needs_user`, `completed` or `cancelled`. */
  readonly status: string
  /** Nodes that are blocked or failed, in the run's own order. */
  readonly blockedNodeIds: readonly string[]
  readonly updatedAt: string
}

/**
 * Facts that are already **recorded** rather than folded out of a session log.
 *
 * PRD §二.8.1 lists "an artifact was lost, a handoff conflicted, a target was lost" and "工作流受阻、预算达到
 * 限制" among the things a controller is told about, and none of those is a session event —
 * {@link externalFact} exists for them and, until now, had exactly one producer (`target_unavailable`).
 * The rest are facts the store already holds, so the report pass reads them instead of waiting for someone
 * to announce them:
 *
 * - an artifact recorded as `missing` or `changed`, which is a pinned input that is gone or no longer
 *   matches what was verified;
 * - a transfer that recorded conflicts, which means two pieces of work disagree;
 * - a governing budget that **refuses** the next automatic dispatch, decided by `budgetDecision` and handed
 *   in so the notice cannot disagree with the gate that stops the work;
 * - a workflow run that stopped for the user, or that holds a blocked or failed node.
 *
 * Deliberate silences: a `claimed` artifact is a **claim**, not a fact; a `present` artifact is not news;
 * a budget that is within its limits is not reported; and a run that is merely `running` or `paused` is not
 * blocked — reporting "paused" as "受阻" would invent a problem nobody has.
 *
 * Every event id is derived from the record — `(artifact, existence, content version)`,
 * `(transfer, updatedAt)`, `(policy, limit, run anchor)` and `(run, status, blocked nodes)` — for the same
 * reason the folded ids are: a re-read must recognise the same fact, and a *new* problem must not be
 * mistaken for the old one.
 *
 * @param target - which task and session the facts belong to.
 * @param input - the task's artifacts, the transfers involving it, the budgets that refuse it and the runs
 *   that got stuck on it, plus the current instant.
 * @returns the reportable facts, artifacts first.
 */
export function storedFactsOf(
  target: { readonly taskId: string; readonly sessionId: string },
  input: {
    readonly artifacts: readonly StoredArtifactFact[]
    readonly transfers: readonly StoredTransferFact[]
    readonly budgets: readonly StoredBudgetFact[]
    readonly workflows: readonly StoredWorkflowFact[]
    /** Fallback instant for a record whose own timestamp cannot be parsed. */
    readonly nowMs: number
  },
): ReportFact[] {
  /** An instant from a stored timestamp, falling back rather than inventing a zero. */
  const instantOf = (iso: string): number => {
    const parsed = Date.parse(iso)
    // A fact placed at epoch zero would form its own merge window and look like ancient history, so an
    // unparseable timestamp is placed at the observation time and said so in the summary instead.
    return Number.isFinite(parsed) ? parsed : input.nowMs
  }

  const facts: ReportFact[] = []
  for (const artifact of input.artifacts) {
    if (artifact.existence !== 'missing' && artifact.existence !== 'changed') continue
    facts.push(externalFact({
      taskId: target.taskId,
      sessionId: target.sessionId,
      eventId: `${artifact.artifactId}:${artifact.existence}:v${String(artifact.contentVersion)}`,
      at: instantOf(artifact.observedAt),
      kind: artifact.existence === 'missing' ? 'artifact_missing' : 'artifact_changed',
      summary: artifact.existence === 'missing'
        ? `artifact ${artifact.artifactId} (${artifact.kind} "${artifact.name}") is recorded as missing: `
          + 'it was verified absent, so anything pinned to it is no longer backed by a file'
        : `artifact ${artifact.artifactId} (${artifact.kind} "${artifact.name}") changed since verification `
          + `and is now at content version ${String(artifact.contentVersion)}`,
    }))
  }
  for (const transfer of input.transfers) {
    if (transfer.conflicts.length === 0) continue
    const [first] = transfer.conflicts
    facts.push(externalFact({
      taskId: target.taskId,
      sessionId: target.sessionId,
      eventId: `${transfer.transferId}:conflict:${transfer.updatedAt}`,
      at: instantOf(transfer.updatedAt),
      kind: 'handoff_conflict',
      summary: `handoff ${transfer.transferId} of ${transfer.artifactId} from ${transfer.fromTaskId} `
        + `to ${transfer.toTaskId} recorded ${String(transfer.conflicts.length)} conflict(s) and was `
        + `${transfer.applied ? 'applied anyway' : 'not applied'}: ${first ?? ''}`,
    }))
  }
  for (const budget of input.budgets) {
    // The run anchor is part of the identity on purpose: the ledger of a target is never reset (PRD
    // §二.13.2 forbids an operation that could zero it), so a second run on the same target is a different
    // target id — and a limit reached again after the ledger moved is a new fact rather than a repeat.
    const anchor = budget.firstDispatchedAt ?? 'no-dispatch'
    facts.push(externalFact({
      taskId: target.taskId,
      sessionId: target.sessionId,
      eventId: `${budget.policyKey}:budget:${budget.limit ?? 'unspecified'}:${anchor}`,
      // A deadline fixes the instant the limit was reached; a counter does not record one, so the
      // observation time is used and the summary says which limit it was.
      at: budget.reachedAt === undefined ? input.nowMs : instantOf(budget.reachedAt),
      kind: 'budget_limited',
      summary: `${budget.policyKey} no longer permits automatic work: ${budget.reason}`,
    }))
  }
  for (const run of input.workflows) {
    const blocked = run.status === 'needs_user' ? 'stopped for the user' : 'holds stuck nodes'
    facts.push(externalFact({
      taskId: target.taskId,
      sessionId: target.sessionId,
      eventId: `${run.runId}:workflow:${run.status}:${run.blockedNodeIds.join('+')}`,
      at: instantOf(run.updatedAt),
      kind: 'workflow_blocked',
      summary: `workflow run ${run.runId} of ${run.workflowId} ${blocked} (${run.status}), `
        + `on node(s) ${run.blockedNodeIds.join(', ') || '(none named)'}`,
    }))
  }
  return facts
}

/** One controller's pending facts, after merging. */
export interface MergedReport {
  readonly controllerSessionId: string
  readonly facts: readonly ReportFact[]
  /** The earliest and latest facts in the merge window. */
  readonly from: number
  readonly until: number
  /** Tasks the report covers; a merged report can span several. */
  readonly taskIds: readonly string[]
  /** True when any fact in the window requires a decision. */
  readonly intervention: boolean
}

/**
 * Group facts into one report per controller per merge window.
 *
 * PRD §二.8.1: events within the merge window for the same main session become one
 * notice. Merging is by *time*, not by count: a controller woken twice in two
 * seconds for two turns of the same task has been woken once too often, while a
 * turn reported an hour later is a genuinely separate event and must not be folded
 * into the old one.
 *
 * Facts from different tasks merge too, because the constraint in the
 * specification is on the waking session, not on the target — and the report says
 * which tasks it covers rather than pretending it is about one.
 *
 * @param byController - the facts to report, grouped by the controller session.
 * @param windowMs - the merge window.
 * @returns one report per window, oldest first.
 */
export function mergeReports(
  byController: ReadonlyMap<string, readonly ReportFact[]>,
  windowMs: number,
): MergedReport[] {
  const reports: MergedReport[] = []
  for (const [controllerSessionId, facts] of byController) {
    const ordered = [...facts].sort((left, right) => left.at - right.at)
    let window: ReportFact[] = []
    const flush = (): void => {
      if (window.length === 0) return
      const times = window.map(fact => fact.at)
      reports.push({
        controllerSessionId,
        facts: window,
        from: Math.min(...times),
        until: Math.max(...times),
        taskIds: [...new Set(window.map(fact => fact.taskId))],
        intervention: window.some(needsIntervention),
      })
      window = []
    }
    for (const fact of ordered) {
      const previous = window[window.length - 1]
      if (previous !== undefined && fact.at - previous.at > windowMs) flush()
      window.push(fact)
    }
    flush()
  }
  return reports.sort((left, right) => left.from - right.from)
}

/** What to do with a report for one controller. */
export type ReportDelivery = 'wake' | 'queue' | 'silent'

/**
 * Decide how a report reaches its controller.
 *
 * PRD §二.8.1: wake the main session when it is idle, queue when it is running, and
 * do not interrupt current work. "Silent" is the third answer and the one that is
 * easy to forget: an empty window is not a report, and neither is a window whose
 * only content is a turn that started.
 *
 * @param status - the controller session's own lifecycle state.
 * @param report - the merged report, or undefined when there is nothing to say.
 * @returns the delivery decision.
 */
export function deliveryFor(status: 'idle' | 'running', report: MergedReport | undefined): ReportDelivery {
  if (report === undefined || report.facts.length === 0) return 'silent'
  return status === 'idle' ? 'wake' : 'queue'
}

/**
 * Render the model-facing text of one report.
 *
 * Written as an observation throughout, and it ends by stating what the report is
 * *not*: the specification forbids an execution triggered by a report from calling
 * the coordination write interfaces, and telling the reader so is the helpful half
 * of that rule. The enforcing half is the server-side barrier, because this text
 * is advice and a barrier is a guarantee.
 *
 * @param report - the merged report.
 * @returns the text to deliver as a notice.
 */
export function renderReport(report: MergedReport): string {
  const lines = report.facts.map(fact => `- [${fact.kind}] ${fact.taskId}: ${fact.summary}`)
  const window = report.until > report.from
    ? `${String(report.until - report.from)} ms of activity`
    : 'one event'
  return [
    `Observed on ${report.taskIds.length === 1 ? `task ${report.taskIds[0] ?? ''}` : `${String(report.taskIds.length)} tasks`}`
      + ` (${window}):`,
    ...lines,
    report.intervention
      ? 'At least one of these needs a decision before the work can continue.'
      : 'No decision is needed; this is a status report.',
    'This report is an observation, not an instruction. A turn opened by it may not create, send to, stop, '
      + 'reorganise, hand over or schedule anything: those calls are refused by the server.',
  ].join('\n')
}

/**
 * The text a report-triggered execution sees when it tries to write.
 *
 * The exact wording is asserted by a test, because it is the operator's only
 * explanation for a refusal that looks, from the model's side, like a bug.
 */
export const NOTICE_TRIGGERED_REFUSAL =
  'REPORT_TRIGGERED: this turn was opened by a conductor report, and a report may not cause coordination writes. '
  + 'A notice exists to inform a controller, never to authorise the next step — so no task was created, nothing was '
  + 'sent, stopped or scheduled, and nothing about the target changed. Ask the user, or issue the request from a turn '
  + 'the user started.'
