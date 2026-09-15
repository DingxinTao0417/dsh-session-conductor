/**
 * Locate the one initial delegated turn that may return to its creating chat.
 *
 * A completion return is deliberately narrower than a Watch: it follows one
 * exact relay message, finds the Host turn that encloses that message (or the
 * first later start on Hosts that log the message before the boundary), and
 * stops forever at that turn's own end. In particular, it never treats a
 * later turn as a continuation of the initial delegation.
 *
 * This module has no store, clock, Host, or delivery side effect.  A caller
 * persists {@link CompletionReturnObservation.record} only when `changed` is
 * true and supplies its own `updatedAt` timestamp at that write boundary.
 *
 * @module dsh-session-conductor/service/completion-return
 */

import type { TurnOutcome } from '../domain/state.ts'
import { outcomeOf, type SessionEventLike } from './projection.ts'

/** Maximum number of UTF-16 code units exposed in a completion preview. */
export const COMPLETION_RETURN_PREVIEW_LIMIT = 480

/** Maximum number of UTF-16 code units exposed from a Host terminal reason. */
export const COMPLETION_RETURN_DETAIL_LIMIT = 240

/** The durable lifecycle of a one-shot initial-delegation completion return. */
export type CompletionReturnPhase =
  | 'armed'
  | 'running'
  | 'returned'
  | 'delivery_unknown'
  | 'delivery_failed'

/**
 * Persisted callback state attached to the task created or forked by an
 * operation.
 *
 * This intentionally mirrors `TaskRecord['completionReturn']`.  `updatedAt`
 * is carried through unchanged because resolving Host facts is pure; the
 * persistence owner is responsible for stamping a changed record.
 */
export interface CompletionReturnCallback {
  /** Create/fork operation that owns this callback. */
  readonly operationId: string
  /** Binding on which the initial relay was accepted. */
  readonly bindingId: string
  /** Version of that binding; a successor must not inherit this callback. */
  readonly bindingVersion: number
  /** Exact Host `user/message` identity for the initial relay. */
  readonly messageId: string
  /** Durable callback lifecycle. */
  readonly phase: CompletionReturnPhase
  /** ISO-8601 time at which the callback was armed. */
  readonly armedAt: string
  /** Sequence of the exact relay message once it has appeared in Host history. */
  readonly messageSeq?: number | undefined
  /** Host turn number that enclosed the initial delegated relay. */
  readonly turn?: number | undefined
  /** Sequence of that turn's `turn/start`. */
  readonly startSeq?: number | undefined
  /** Sequence of that turn's terminal `turn/end`. */
  readonly endSeq?: number | undefined
  /** Normalized Host outcome for the terminal initial turn. */
  readonly outcome?: TurnOutcome | undefined
  /** Host-authored terminal detail. */
  readonly detail?: string | undefined
  /** Last public assistant text from the initial turn, bounded to 480 characters. */
  readonly preview?: string | undefined
  /** ISO-8601 time of the Host terminal event, when the event recorded one. */
  readonly completedAt?: string | undefined
  /** Why the first delivery or a later observation cannot be confirmed. */
  readonly reason?: string | undefined
  /** ISO-8601 timestamp written by the persistence owner. */
  readonly updatedAt: string
}

/** What the Host history currently proves about the callback. */
export type CompletionReturnStatus =
  /** The relay has not yet opened a provable initial turn. */
  | 'waiting'
  /** The exact initial turn has started but has not ended. */
  | 'running'
  /** The exact initial turn ended; its outcome is in `terminal`. */
  | 'terminal'
  /** Delivery remains uncertain and the Host has not supplied matching evidence. */
  | 'delivery_unknown'
  /** Delivery remains failed and the Host has not supplied matching evidence. */
  | 'delivery_failed'

/** The exact terminal fact from the initial delegated turn. */
export interface CompletionReturnTerminal {
  /** Host log sequence of the matching `turn/end`. */
  readonly seq: number
  /** Host event timestamp in epoch milliseconds, when it was present and finite. */
  readonly time?: number
  /** Mapped outcome of the initial turn. */
  readonly outcome: TurnOutcome
  /** Host-authored terminal detail. */
  readonly detail: string
  /** Last public assistant text emitted in the same turn, when any exists. */
  readonly preview?: string
}

/** The first Host turn safely associated with the exact initial relay. */
export interface CompletionReturnTurn {
  /** Host turn number. */
  readonly turn: number
  /** Host log sequence of the matching `turn/start`. */
  readonly startSeq: number
}

/**
 * A pure resolution of a durable callback against a Host log.
 *
 * `record` is the next durable shape without a new `updatedAt`; `changed`
 * says whether a persistence owner needs to write it.  `reason` explains a
 * non-terminal wait to a caller, but is intentionally not copied into the
 * durable callback because a normal wait is not an error.
 */
export interface CompletionReturnObservation {
  readonly status: CompletionReturnStatus
  readonly record: CompletionReturnCallback
  readonly changed: boolean
  /** Sequence of the exact initial relay once found. */
  readonly messageSeq?: number
  /** Initial turn once found. */
  readonly initialTurn?: CompletionReturnTurn
  /** Terminal fact when `status` is `terminal`. */
  readonly terminal?: CompletionReturnTerminal
  /** Why no initial turn was inferred, or why delivery remains unresolved. */
  readonly reason?: string
}

/**
 * Resolve a persisted completion callback against a Host event log.
 *
 * Only a `user/message` whose **direct** `data.id` exactly equals
 * `callback.messageId` may arm a turn. A missing id, a message without that
 * id, an earlier completed turn, and a later turn are never substitutes. The
 * current Host writes `turn/start` before the claimed `user/message`; a
 * compatible Host can write it after instead. Both proven layouts are
 * supported, but only a `turn/end` carrying that exact Host turn number can
 * finish it. `assistant/chunk`, reasoning blocks, and all non-public content
 * are deliberately ignored.
 *
 * @param callback - one persisted initial-delegation callback.
 * @param events - Host session history; order is normalized by `seq` without mutating it.
 * @returns the observed lifecycle and a record suitable for durable replacement.
 */
export function resolveCompletionReturn(
  callback: CompletionReturnCallback,
  events: readonly SessionEventLike[],
): CompletionReturnObservation {
  // A returned callback is one-shot.  Re-reading a growing history must not
  // turn a later user request into another return.
  if (callback.phase === 'returned') return returnedObservation(callback)

  const messageId = nonEmptyString(callback.messageId)
  if (messageId === undefined) {
    return waiting(callback, 'the initial relay has no readable message id, so no turn was inferred')
  }

  const ordered = orderBySequence(events)
  const anchored = runningAnchorOf(callback)
  const initial = anchored ?? locateInitialTurn(messageId, ordered)

  if (initial === undefined) {
    const matched = locateMessage(messageId, ordered)
    if (matched === undefined) return unresolved(callback, 'waiting for the exact initial relay message to appear in Host history')
    const record = armedRecord(callback, matched.seq)
    return waiting(
      record,
      `the exact initial relay appeared at seq ${String(matched.seq)}, but no later turn/start could be proven`,
      matched.seq,
      callback,
    )
  }

  const end = locateTurnEnd(initial, ordered)
  if (end === undefined) {
    const record = runningRecord(callback, initial)
    return {
      status: 'running',
      record,
      changed: !sameCallback(record, callback),
      messageSeq: initial.messageSeq,
      initialTurn: { turn: initial.turn, startSeq: initial.startSeq },
    }
  }

  const terminal = terminalOf(initial, end, ordered)
  const record = returnedRecord(callback, initial, terminal)
  return {
    status: 'terminal',
    record,
    changed: !sameCallback(record, callback),
    messageSeq: initial.messageSeq,
    initialTurn: { turn: initial.turn, startSeq: initial.startSeq },
    terminal,
  }
}

/** A relay message and the Host turn proven to contain it. */
interface InitialTurn {
  readonly messageSeq: number
  readonly turn: number
  readonly startSeq: number
}

/** Return the immutable, already-consumed state of a callback. */
function returnedObservation(callback: CompletionReturnCallback): CompletionReturnObservation {
  const outcome = callback.outcome
  const endSeq = callback.endSeq
  const detail = callback.detail
  const time = timeFromIso(callback.completedAt)
  const terminal = outcome === undefined || endSeq === undefined || detail === undefined
    ? undefined
    : {
        seq: endSeq,
        ...time === undefined ? {} : { time },
        outcome,
        detail,
        ...callback.preview === undefined ? {} : { preview: callback.preview },
      }
  return {
    status: 'terminal',
    record: callback,
    changed: false,
    ...callback.messageSeq === undefined ? {} : { messageSeq: callback.messageSeq },
    ...callback.turn === undefined || callback.startSeq === undefined
      ? {}
      : { initialTurn: { turn: callback.turn, startSeq: callback.startSeq } },
    ...terminal === undefined ? {} : { terminal },
  }
}

/** Preserve explicit delivery uncertainty unless a matching Host fact resolves it. */
function unresolved(callback: CompletionReturnCallback, reason: string): CompletionReturnObservation {
  if (callback.phase === 'delivery_unknown') {
    return { status: 'delivery_unknown', record: callback, changed: false, reason: callback.reason ?? reason }
  }
  if (callback.phase === 'delivery_failed') {
    return { status: 'delivery_failed', record: callback, changed: false, reason: callback.reason ?? reason }
  }
  return waiting(callback, reason)
}

/** Construct a normal waiting observation. */
function waiting(
  callback: CompletionReturnCallback,
  reason: string,
  messageSeq?: number,
  previous: CompletionReturnCallback = callback,
): CompletionReturnObservation {
  return {
    status: 'waiting',
    record: callback,
    changed: !sameCallback(callback, previous),
    ...messageSeq === undefined ? {} : { messageSeq },
    reason,
  }
}

/** Find a previously proven running anchor only when the full proof was persisted. */
function runningAnchorOf(callback: CompletionReturnCallback): InitialTurn | undefined {
  if (callback.phase !== 'running') return undefined
  if (!isSequence(callback.messageSeq) || !isTurn(callback.turn) || !isSequence(callback.startSeq)) return undefined
  return { messageSeq: callback.messageSeq, turn: callback.turn, startSeq: callback.startSeq }
}

/** Locate the exact relay's enclosing Host turn, or a later start on older Hosts. */
function locateInitialTurn(messageId: string, events: readonly SessionEventLike[]): InitialTurn | undefined {
  const message = locateMessage(messageId, events)
  if (message === undefined) return undefined
  const enclosing = openTurnAt(message, events)
  if (enclosing !== undefined) return { messageSeq: message.seq, ...enclosing }
  for (const event of events) {
    if (event.seq <= message.seq || event.type !== 'turn/start') continue
    const turn = turnOf(event)
    if (turn === undefined) continue
    return { messageSeq: message.seq, turn, startSeq: event.seq }
  }
  return undefined
}

/** Find the active turn at the exact relay position in the current Host layout. */
function openTurnAt(message: SessionEventLike, events: readonly SessionEventLike[]): CompletionReturnTurn | undefined {
  let current: CompletionReturnTurn | undefined
  for (const event of events) {
    if (event.seq > message.seq) break
    if (event.type === 'turn/start') {
      const turn = turnOf(event)
      if (turn !== undefined) current = { turn, startSeq: event.seq }
    } else if (event.type === 'turn/end' && current !== undefined && turnOf(event) === current.turn) {
      current = undefined
    }
  }
  return current
}

/** Find the exact `user/message`; a content match is never accepted as an id match. */
function locateMessage(messageId: string, events: readonly SessionEventLike[]): SessionEventLike | undefined {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = objectOf(event.data)
    if (nonEmptyString(data?.id) === messageId) return event
  }
  return undefined
}

/** Find the first end of the already-proven initial turn. */
function locateTurnEnd(initial: InitialTurn, events: readonly SessionEventLike[]): SessionEventLike | undefined {
  for (const event of events) {
    if (event.seq <= initial.startSeq || event.type !== 'turn/end') continue
    if (turnOf(event) === initial.turn) return event
  }
  return undefined
}

/** Build the one terminal fact, including public text only from the same turn. */
function terminalOf(
  initial: InitialTurn,
  end: SessionEventLike,
  events: readonly SessionEventLike[],
): CompletionReturnTerminal {
  const data = objectOf(end.data)
  const mapped = outcomeOf(data?.reason)
  const preview = publicPreviewOf(initial, end.seq, events)
  const time = finiteTimeOf(end)
  return {
    seq: end.seq,
    ...time === undefined ? {} : { time },
    outcome: mapped.outcome,
    detail: truncateDetail(mapped.detail),
    ...preview === undefined ? {} : { preview },
  }
}

/**
 * Return the final public text of an assistant message inside the initial turn.
 *
 * A `reasoning` block is intentionally ignored even though it also has a
 * `text` field.  Chunks are excluded by event type before content is read.
 */
function publicPreviewOf(initial: InitialTurn, endSeq: number, events: readonly SessionEventLike[]): string | undefined {
  let preview: string | undefined
  for (const event of events) {
    if (event.seq <= initial.startSeq || event.seq > endSeq || event.type !== 'assistant/message') continue
    if (turnOf(event) !== initial.turn) continue
    const text = publicAssistantText(event)
    if (text.length > 0) preview = truncatePreview(text)
  }
  return preview
}

/** Read only public text blocks from an assembled assistant message. */
function publicAssistantText(event: SessionEventLike): string {
  const data = objectOf(event.data)
  const message = objectOf(data?.message)
  const content = message?.content
  // A legacy host can serialize an already-public message as a string.  It has
  // no distinct reasoning field, so accepting it does not inspect hidden data.
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const value = objectOf(block)
    if (value?.type === 'text' && typeof value.text === 'string') parts.push(value.text)
  }
  return parts.join('\n')
}

/** Build the record once the exact initial turn starts. */
function runningRecord(callback: CompletionReturnCallback, initial: InitialTurn): CompletionReturnCallback {
  const {
    endSeq: _endSeq,
    outcome: _outcome,
    detail: _detail,
    preview: _preview,
    completedAt: _completedAt,
    reason: _reason,
    ...base
  } = callback
  return {
    ...base,
    phase: 'running',
    messageSeq: initial.messageSeq,
    turn: initial.turn,
    startSeq: initial.startSeq,
  }
}

/** Build the immutable record once the exact initial turn ends. */
function returnedRecord(
  callback: CompletionReturnCallback,
  initial: InitialTurn,
  terminal: CompletionReturnTerminal,
): CompletionReturnCallback {
  const {
    endSeq: _endSeq,
    outcome: _outcome,
    detail: _detail,
    preview: _preview,
    completedAt: _completedAt,
    reason: _reason,
    ...base
  } = callback
  const completedAt = isoAt(terminal.time)
  return {
    ...base,
    phase: 'returned',
    messageSeq: initial.messageSeq,
    turn: initial.turn,
    startSeq: initial.startSeq,
    endSeq: terminal.seq,
    outcome: terminal.outcome,
    detail: terminal.detail,
    ...terminal.preview === undefined ? {} : { preview: terminal.preview },
    ...completedAt === undefined ? {} : { completedAt },
  }
}

/**
 * Persist proof that the exact relay reached Host history.
 *
 * Exact matching resolves a prior delivery uncertainty, but does not claim a
 * turn has started.  Clearing an old terminal/result field here prevents a
 * corrupt legacy record from showing a result before Host supplied one.
 */
function armedRecord(callback: CompletionReturnCallback, messageSeq: number): CompletionReturnCallback {
  const {
    turn: _turn,
    startSeq: _startSeq,
    endSeq: _endSeq,
    outcome: _outcome,
    detail: _detail,
    preview: _preview,
    completedAt: _completedAt,
    reason: _reason,
    ...base
  } = callback
  return { ...base, phase: 'armed', messageSeq }
}

/** Stable structural comparison for this small, flat callback record. */
function sameCallback(left: CompletionReturnCallback, right: CompletionReturnCallback): boolean {
  return left.operationId === right.operationId
    && left.bindingId === right.bindingId
    && left.bindingVersion === right.bindingVersion
    && left.messageId === right.messageId
    && left.phase === right.phase
    && left.armedAt === right.armedAt
    && left.messageSeq === right.messageSeq
    && left.turn === right.turn
    && left.startSeq === right.startSeq
    && left.endSeq === right.endSeq
    && left.outcome === right.outcome
    && left.detail === right.detail
    && left.preview === right.preview
    && left.completedAt === right.completedAt
    && left.reason === right.reason
    && left.updatedAt === right.updatedAt
}

/** Copy and order a Host log by its authoritative sequence position. */
function orderBySequence(events: readonly SessionEventLike[]): readonly SessionEventLike[] {
  return [...events].sort((left, right) => left.seq - right.seq)
}

/** Read a non-empty string without coercing unknown Host data. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read an object record without trusting its prototype or shape. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Read one safe, non-negative Host sequence. */
function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Read one valid Host turn number. */
function isTurn(value: unknown): value is number {
  return isSequence(value)
}

/** Read an event's declared turn without falling back to a counter or position. */
function turnOf(event: SessionEventLike): number | undefined {
  const turn = objectOf(event.data)?.turn
  return isTurn(turn) ? turn : undefined
}

/** Read a finite Host timestamp without making one up. */
function finiteTimeOf(event: SessionEventLike): number | undefined {
  return typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : undefined
}

/** Serialize a finite Host timestamp to the durable timestamp representation. */
function isoAt(time: number | undefined): string | undefined {
  if (time === undefined) return undefined
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/** Rehydrate an already-persisted terminal time solely for a read-only observation. */
function timeFromIso(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

/** Bound a public preview while retaining an explicit truncation marker. */
function truncatePreview(value: string): string {
  if (value.length <= COMPLETION_RETURN_PREVIEW_LIMIT) return value
  const marker = '… [truncated]'
  return `${value.slice(0, COMPLETION_RETURN_PREVIEW_LIMIT - marker.length)}${marker}`
}

/** Keep a terminal error readable in a compact card without copying an unbounded Host payload. */
function truncateDetail(value: string): string {
  if (value.length <= COMPLETION_RETURN_DETAIL_LIMIT) return value
  const marker = '… [truncated]'
  return `${value.slice(0, COMPLETION_RETURN_DETAIL_LIMIT - marker.length)}${marker}`
}
