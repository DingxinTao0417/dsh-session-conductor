/**
 * Projecting a target session's state from its own event log.
 *
 * PRD §三.5 requires the plugin's state projection to come from Host facts and
 * states that a plugin cache can never independently prove a task is still
 * running. So this module derives everything from the session log the Host owns,
 * and derives it *purely*: a fold over `(previous state, events)` with no clock,
 * no I/O, and no hidden memory. That makes every rule testable directly and
 * makes replay after a restart produce the same answer as live observation.
 *
 * The three dimensions the specification separates are separate here too:
 * execution, interaction, and the outcome of the last turn.
 *
 * @module dsh-session-conductor/service/projection
 */

import {
  describeArtifactFactSummary,
  type ArtifactFactCounts,
} from '../domain/artifact-facts.ts'
import type { ExecutionState, InteractionState, TurnOutcome } from '../domain/state.ts'

/** The subset of a Host session event this projection reads. */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data?: unknown
}

/** Something that happened and may be worth waking a waiting reader for. */
export type NotableEvent =
  | { readonly kind: 'turn_started'; readonly turn: number }
  | { readonly kind: 'turn_ended'; readonly turn: number; readonly outcome: TurnOutcome; readonly detail: string }
  | { readonly kind: 'approval_asked'; readonly approvalId: string; readonly toolName?: string }
  /**
   * The target asked its user something (PRD §二.8.1's "用户问题").
   *
   * There is no session event for a question. The installed Host's `SessionEventMap` was read to establish
   * that rather than assumed: its members are `turn/start`, `turn/end`, `step/start`, `step/end`,
   * `user/message`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `todo/write`,
   * `request/header`, `request/context`, `session/end-seed`, `agent/inbox/spliced`, `command/run`,
   * `command/done`, `approval/asked`, `approval/decided`, `approval/policy`, the two code-dispatch
   * events, `goal/change`, `session/title` and the compaction events — and `TurnEndReasonMap` is
   * `completed | aborted | blocked | error | max-tokens | interrupted`. Nothing in either means "the
   * model asked a question".
   *
   * What the log *does* contain is the **call to the tool that asks one**. That is a real observation of a
   * real thing — the target is blocked on a human answer — and it is the honest signal available, so it is
   * reported as the question rather than as a turn that ended.
   */
  | { readonly kind: 'user_question'; readonly callId: string; readonly toolName: string }
  /**
   * An artifact was accepted (PRD §二.8.2's `artifact_accepted` trigger).
   *
   * The one member here that does **not** come from a session log: an acceptance is a decision the
   * conductor recorded, not something the Host emitted. It is in this type all the same because the
   * rule executor's vocabulary is "things worth reacting to", and a rule that listens for an
   * acceptance has to be able to see one — the trigger was declared in the schema and produced
   * nowhere until it was added here.
   */
  | { readonly kind: 'artifact_accepted'; readonly artifactId: string; readonly by: string }

/**
 * The tool whose **call** means the model is asking its user something.
 *
 * Named explicitly rather than pattern-matched: a heuristic like "any tool whose name contains `ask`"
 * would report a target that merely called something with an unlucky name, and a fact that fires on the
 * wrong event is worse than one that does not fire. A Host that names the tool differently produces no
 * question fact at all, which shows up as silence rather than as a wrong notice.
 */
export const QUESTION_TOOL_NAMES: readonly string[] = ['ask_user_question']

/** Everything the conductor knows about one target, derived from its log. */
export interface ProjectionState {
  readonly execution: ExecutionState
  readonly interaction: InteractionState
  /**
   * The outstanding `ask_user_question` call, when interaction is `waiting_input`.
   *
   * Kept so a later `tool/result` for **that** call can clear the wait, and a
   * result for a different tool cannot. Optional; absence means nothing is
   * waiting on a question.
   */
  readonly waitingCallId?: string | undefined
  /** Outcome of the most recent finished turn; absent before the first one ends. */
  readonly lastTurn: TurnOutcome | undefined
  /** The Host's own reason string for that outcome, kept verbatim. */
  readonly lastTurnDetail: string | undefined
  /** Sequence number of the last event folded in; the cursor a reader resumes after. */
  readonly cursor: number
  /** How many turns have started. */
  readonly turnsStarted: number
  /**
   * The Host's own number of the turn that is still open, when one is.
   *
   * This is the `expectedTurn` interrupt and stop ask for (PRD §二.6). It is
   * the `turn` on the unmatched `turn/start`, not `turnsStarted`, so a stop
   * can name the same turn the Host numbers.
   */
  readonly openTurn: number | undefined
  /** Sequence of that `turn/start` event — the `expectedStartSeq` stop can pin. */
  readonly openTurnStartSeq: number | undefined
}

/** The state of a session that has produced no events yet. */
export function initialProjection(): ProjectionState {
  return {
    execution: 'idle',
    interaction: 'none',
    lastTurn: undefined,
    lastTurnDetail: undefined,
    cursor: -1,
    turnsStarted: 0,
    openTurn: undefined,
    openTurnStartSeq: undefined,
  }
}

/**
 * The two last-turn facts of PRD §二.1 / §二.7: 最近结果 (`lastTurn`) and 最近进展
 * (`lastTurnDetail`). Omitted together when no turn has finished, so a card cannot
 * invent a progress line from an idle session.
 *
 * @param state - the projection.
 * @returns the fields a panel, export or listing can spread.
 */
export function lastTurnFieldsOf(state: Pick<ProjectionState, 'lastTurn' | 'lastTurnDetail'>): {
  lastTurn?: TurnOutcome
  lastTurnDetail?: string
} {
  return {
    ...state.lastTurn === undefined ? {} : { lastTurn: state.lastTurn },
    ...state.lastTurnDetail === undefined ? {} : { lastTurnDetail: state.lastTurnDetail },
  }
}

/**
 * The interrupt/stop anchor of PRD §二.6, named as the tools already ask for it.
 *
 * Omitted together when no turn is open, so an idle snapshot cannot be copied
 * into `expectedTurn: 0` and look like an observed turn.
 *
 * @param state - the projection.
 * @returns `expectedTurn` / `expectedStartSeq` when a turn is open.
 */
export function interruptAnchorFieldsOf(state: Pick<ProjectionState, 'openTurn' | 'openTurnStartSeq'>): {
  expectedTurn?: number
  expectedStartSeq?: number
} {
  if (state.openTurn === undefined) return {}
  return {
    expectedTurn: state.openTurn,
    ...state.openTurnStartSeq === undefined ? {} : { expectedStartSeq: state.openTurnStartSeq },
  }
}

/**
 * Structured compact-snapshot fields of PRD §二.7, including the interrupt
 * anchor `conductor_send` / `conductor_stop` tell the caller to take from
 * `conductor_read`.
 *
 * @param state - the projection.
 * @returns fields a tool result can spread; undefined members omitted.
 */
export function readSnapshotFieldsOf(state: ProjectionState): {
  execution: ExecutionState
  lastTurn?: TurnOutcome
  lastTurnDetail?: string
  pendingIntervention?: string
  expectedTurn?: number
  expectedStartSeq?: number
} {
  const pending = pendingInterventionOf(state.interaction)
  return {
    execution: state.execution,
    ...lastTurnFieldsOf(state),
    ...pending === undefined ? {} : { pendingIntervention: pending },
    ...interruptAnchorFieldsOf(state),
  }
}

/**
 * The Watch 待介入事项 for one projected interaction (PRD §三.5).
 *
 * `none` is not an intervention: the field is absent rather than stored as a
 * sentinel, so a watch that is not waiting does not look like one that is.
 *
 * @param interaction - the projected interaction state.
 * @returns the durable label, or undefined when nobody must act.
 */
export function pendingInterventionOf(interaction: InteractionState): string | undefined {
  return interaction === 'none' ? undefined : interaction
}

/**
 * Restore an interaction state from a stored Watch 待介入事项.
 *
 * Only the two named waiting states count; anything else (including absence)
 * is `none`, so a stale or unknown label cannot invent a wait.
 *
 * @param pending - the stored label, when the watch has one.
 * @returns the interaction to show.
 */
export function interactionFromPending(pending: string | undefined): InteractionState {
  return pending === 'waiting_input' || pending === 'waiting_approval' ? pending : 'none'
}

/**
 * The stored 待介入事项 for one task, from any watch that recorded one.
 *
 * Used when the session is not live: the Host log cannot be folded, and the
 * watch field is the last observation. Live projection always wins over this.
 *
 * @param watches - watch records to scan.
 * @param taskId - the task.
 * @returns the stored label, or undefined.
 */
export function pendingInterventionFromWatches(
  watches: readonly { readonly taskId: string; readonly pendingIntervention?: string | undefined }[],
  taskId: string,
): string | undefined {
  for (const watch of watches) {
    if (watch.taskId === taskId && watch.pendingIntervention !== undefined) return watch.pendingIntervention
  }
  return undefined
}

/**
 * Map the Host's turn-end reason onto the conductor's outcome vocabulary.
 *
 * The Host has more reason kinds than the specification's four outcomes, so the
 * mapping is stated rather than inferred:
 *
 * - `completed` → `completed`;
 * - `error` → `failed`;
 * - `aborted` and `interrupted` → `interrupted` (both mean the turn stopped
 *   without finishing);
 * - `blocked` → `blocked`;
 * - `max-tokens` → `blocked`, because the turn stopped at a limit rather than
 *   finishing or failing — reporting it as `completed` would be the one answer
 *   the specification's notification rules exist to prevent.
 *
 * An unknown kind is `blocked` and keeps its verbatim detail, so a Host that
 * adds a reason later is surfaced rather than silently reported as a success.
 *
 * @param reason - the turn-end reason payload.
 * @returns the outcome and the verbatim detail.
 */
export function outcomeOf(reason: unknown): { outcome: TurnOutcome; detail: string } {
  const kind = typeof reason === 'object' && reason !== null && 'kind' in reason
    ? String((reason as { kind: unknown }).kind)
    : 'unknown'
  switch (kind) {
    case 'completed':
      return { outcome: 'completed', detail: kind }
    case 'error': {
      const error = (reason as { error?: { code?: unknown; message?: unknown } }).error
      const code = error?.code === undefined ? 'error' : String(error.code)
      return { outcome: 'failed', detail: error?.message === undefined ? code : `${code}: ${String(error.message)}` }
    }
    case 'aborted':
    case 'interrupted':
      return { outcome: 'interrupted', detail: kind }
    case 'blocked':
    case 'max-tokens':
      return { outcome: 'blocked', detail: kind }
    default:
      return { outcome: 'blocked', detail: `unrecognized turn end: ${kind}` }
  }
}

/**
 * Fold new events onto a previous projection.
 *
 * Events are applied in ascending `seq`; anything at or below the previous
 * cursor is skipped, so folding the same window twice is idempotent and a
 * reader that resumes from a persisted cursor never double-counts a turn.
 *
 * @param previous - the projection before this window.
 * @param events - the session's events, in log order.
 * @returns the new projection and the notable events in this window.
 */
export function projectEvents(
  previous: ProjectionState,
  events: readonly SessionEventLike[],
): { state: ProjectionState; notable: NotableEvent[] } {
  const folded = projectNotableAfter(previous, events)
  return { state: folded.state, notable: folded.notable.map(entry => entry.event) }
}

/** A notable event together with where it happened. */
export interface PositionedNotable {
  readonly event: NotableEvent
  /** The sequence of the event that produced it. */
  readonly seq: number
  /** Its timestamp, or 0 when the Host recorded none. */
  readonly at: number
}

/**
 * Fold events onto a previous projection, keeping each notable event's position.
 *
 * The same single interpretation as {@link projectEvents} — this function *is* the
 * fold, and `projectEvents` delegates to it — but it also reports *where* each
 * notable event came from. A reader that has to identify an event durably needs
 * that: a report is only non-repeating if it can name the event it is about, and a
 * cursor cannot, because one cursor advance covers several events at once.
 *
 * The caller supplies the *whole* previous projection rather than a bare sequence,
 * so a reader that resumes from a persisted cursor keeps everything the earlier
 * window established — the turn count, the last outcome, the interaction state.
 * Resuming from a sequence number alone would silently reset those.
 *
 * @param previous - the projection before this window.
 * @param events - the session's events, in log order.
 * @returns the new projection and the positioned notable events.
 */
export function projectNotableAfter(
  previous: ProjectionState,
  events: readonly SessionEventLike[],
): { state: ProjectionState; notable: PositionedNotable[] } {
  let state = previous
  const notable: PositionedNotable[] = []
  for (const event of events) {
    if (event.seq <= state.cursor) continue
    const applied = applyEvent(state, event)
    state = applied.state
    if (applied.notable !== undefined) {
      notable.push({ event: applied.notable, seq: event.seq, at: typeof event.time === 'number' ? event.time : 0 })
    }
  }
  return { state, notable }
}

/**
 * Apply one event.
 * @param state - the state before this event.
 * @param event - the event to apply.
 * @returns the next state and any notable event it produced.
 */
function applyEvent(state: ProjectionState, event: SessionEventLike): { state: ProjectionState; notable?: NotableEvent } {
  const base = { ...state, cursor: event.seq }
  const data = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'turn/start': {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : 0
      return {
        state: {
          ...base,
          execution: 'running',
          interaction: 'none',
          waitingCallId: undefined,
          turnsStarted: state.turnsStarted + 1,
          openTurn: turn,
          openTurnStartSeq: event.seq,
        },
        notable: { kind: 'turn_started', turn },
      }
    }
    case 'turn/end': {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : 0
      const { outcome, detail } = outcomeOf(data['reason'])
      return {
        state: {
          ...base,
          execution: 'idle',
          interaction: 'none',
          waitingCallId: undefined,
          lastTurn: outcome,
          lastTurnDetail: detail,
          openTurn: undefined,
          openTurnStartSeq: undefined,
        },
        notable: { kind: 'turn_ended', turn, outcome, detail },
      }
    }
    case 'tool/call': {
      const name = data['name'] === undefined ? '' : String(data['name'])
      if (!QUESTION_TOOL_NAMES.includes(name)) return { state: base }
      const callId = data['callId'] === undefined ? 'unknown' : String(data['callId'])
      return {
        state: { ...base, interaction: 'waiting_input', waitingCallId: callId },
        notable: { kind: 'user_question', callId, toolName: name },
      }
    }
    case 'tool/result': {
      const callId = data['callId'] === undefined ? undefined : String(data['callId'])
      if (state.waitingCallId === undefined || callId !== state.waitingCallId) {
        return { state: base }
      }
      return { state: { ...base, interaction: 'none', waitingCallId: undefined } }
    }
    case 'approval/asked': {
      const approvalId = data['id'] === undefined ? 'unknown' : String(data['id'])
      const toolName = data['toolName'] === undefined ? undefined : String(data['toolName'])
      return {
        state: { ...base, interaction: 'waiting_approval' },
        notable: { kind: 'approval_asked', approvalId, ...toolName === undefined ? {} : { toolName } },
      }
    }
    case 'approval/decided':
      return { state: { ...base, interaction: 'none' } }
    default:
      return { state: base }
  }
}

/** Who authored a user-role history line (PRD §四.2 / T11). */
export type HistorySource = 'user' | 'relay' | 'notice' | 'plugin' | 'unknown'

/** One line of readable history, projected from a host event. */
export interface HistoryEntry {
  readonly seq: number
  readonly kind: 'user' | 'assistant' | 'tool_call' | 'tool_result'
  readonly text: string
  /**
   * Provenance of a user-role message, read from the Host's own `source`.
   *
   * `kind` is the role (user vs assistant vs tool). `source` is who spoke:
   * a person in the native UI (`user`), a forwarded controller instruction
   * (`relay`), a background report (`notice`), some other plugin form
   * (`plugin`), or a log that did not name one (`unknown`). Absent on
   * non-user kinds. T11 requires both ends to stay distinguishable.
   */
  readonly source?: HistorySource
}

/**
 * Read a user-message source as the vocabulary PRD §四.2 names.
 *
 * The Host records `{kind:'user'}` for native UI input, `{kind:'plugin', form:'relay'}`
 * for a forwarded instruction and `{kind:'plugin', form:'notice'}` for a report.
 * Collapsing those to the role `user` is how a history read made T11 unanswerable.
 *
 * @param source - the Host `source` on a `user/message` event.
 * @returns the provenance label.
 */
export function historySourceOf(source: unknown): HistorySource {
  if (typeof source !== 'object' || source === null) return 'unknown'
  const record = source as { kind?: unknown; form?: unknown }
  if (record.kind === 'user') return 'user'
  if (record.kind === 'plugin') {
    if (record.form === 'relay') return 'relay'
    if (record.form === 'notice') return 'notice'
    return 'plugin'
  }
  return 'unknown'
}

/**
 * Project one event onto a readable history line.
 *
 * The specification requires a detailed history view of public messages and
 * tool results, and requires raw token streams **not** to trigger a report to
 * the controller session. `assistant/chunk` — the streaming deltas — is
 * therefore deliberately not projected here at all. A user-role line keeps the
 * Host's own `source` so native-interface input and a controller relay stay
 * distinguishable (PRD §四.2, T11).
 *
 * @param event - a Host session event.
 * @returns the history line, or `undefined` when the event is not part of the readable history.
 */
export function historyOf(event: SessionEventLike): HistoryEntry | undefined {
  const data = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'user/message':
      return {
        seq: event.seq,
        kind: 'user',
        text: truncate(contentText(data['content']), HISTORY_ENTRY_TEXT_LIMIT),
        source: historySourceOf(data['source']),
      }
    case 'assistant/message': {
      const message = data['message'] as { content?: unknown } | undefined
      return { seq: event.seq, kind: 'assistant', text: truncate(contentText(message?.content), HISTORY_ENTRY_TEXT_LIMIT) }
    }
    case 'tool/call':
      return {
        seq: event.seq,
        kind: 'tool_call',
        text: truncate(
          `${data['name'] === undefined ? 'tool' : String(data['name'])}(${String(data['arguments'] ?? '')})`,
          HISTORY_ENTRY_TEXT_LIMIT,
        ),
      }
    case 'tool/result': {
      const message = data['message'] as { content?: unknown } | undefined
      const failed = data['error'] === undefined ? '' : ' [error] '
      return {
        seq: event.seq,
        kind: 'tool_result',
        text: truncate(`${failed}${contentText(message?.content)}`.trim(), HISTORY_ENTRY_TEXT_LIMIT),
      }
    }
    default:
      return undefined
  }
}

/**
 * How much of one history entry's text is kept.
 *
 * Every entry is bounded, not just tool output: a single long user or assistant
 * message would otherwise dominate a history window with no indication that
 * anything was left out (PRD §二.7 requires the truncation to be marked).
 */
export const HISTORY_ENTRY_TEXT_LIMIT = 480

/**
 * Flatten a message content field into text.
 * @param content - the content blocks, however shaped.
 * @returns the joined text.
 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block === 'object' && block !== null && 'text' in block) {
      parts.push(String((block as { text: unknown }).text))
    }
  }
  return parts.join('\n')
}

/**
 * Shorten text for a history line, marking that it was shortened.
 * @param text - the complete text.
 * @param limit - the maximum length.
 * @returns the text, with a marker when it had to be cut.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  const marker = '… [truncated]'
  return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`
}

/**
 * Render a projection as the compact snapshot of PRD §二.7.
 * @param state - the projection.
 * @returns the model-facing summary.
 */
export function describeProjection(state: ProjectionState): string {
  const parts = [`execution=${state.execution}`, `interaction=${state.interaction}`]
  if (state.openTurn !== undefined) {
    parts.push(
      `open turn=${String(state.openTurn)}`
      + (state.openTurnStartSeq === undefined ? '' : ` at seq ${String(state.openTurnStartSeq)}`),
    )
  }
  if (state.lastTurn !== undefined) {
    parts.push(`last turn=${state.lastTurn}${state.lastTurnDetail === undefined ? '' : ` (${state.lastTurnDetail})`}`)
  } else {
    parts.push('no turn has finished yet')
  }
  parts.push(`cursor=${String(state.cursor)}`)
  return parts.join('; ')
}

/** Artifact counts a compact snapshot can name (PRD §二.9.1's four facts). */
export type CompactArtifactSummary = ArtifactFactCounts

/**
 * The compact snapshot of PRD §二.7: 状态、最近进展、待介入事项和成果摘要.
 *
 * `describeProjection` is the state half. This adds the two halves that are
 * not a projection: whether a person must act, and how many artifacts stand.
 *
 * @param state - the session projection.
 * @param artifacts - durable artifact counts, when they can be read.
 * @returns the model-facing snapshot.
 */
export function describeCompactSnapshot(
  state: ProjectionState,
  artifacts?: CompactArtifactSummary | undefined,
): string {
  const pending = state.interaction === 'none'
    ? 'nothing waiting on a person'
    : `waiting: ${state.interaction}`
  const summary = artifacts === undefined
    ? 'artifact summary unavailable'
    : describeArtifactFactSummary(artifacts)
  return `${describeProjection(state)}; pending=${pending}; artifacts=${summary}`
}
