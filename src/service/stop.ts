/**
 * Exact stop, interrupt-and-send, and unconsumed-input management (PRD §二.6).
 *
 * The specification is unusually strict here, and the strictness is the whole
 * point: an approximate stop is worse than a refused one, because it can cancel
 * *someone else's* turn. Its two requirements are:
 *
 * 1. **The turn check and the cancel must happen inside one critical section, with
 *    no asynchronous yield in between** (PRD §二.6). This module therefore keeps
 *    {@link cancelExpectedTurn} a *synchronous* function that never awaits. The
 *    Host's `agent.status` and `agent.session.events` are synchronous projections
 *    and `agent.cancel()` is a synchronous call, so reading the expectation and
 *    acting on it happen in one tick — nothing else can start a turn in between,
 *    because nothing else can run in between.
 * 2. **A build that cannot identify the expected turn must not claim to support a
 *    precise stop** (PRD §二.6, §二.6 note). The PRD names `turnStartSeq`; the
 *    pinned runtime has no such member (measured — see
 *    `docs/host-api-notes.md`). What it *does* expose is the durable event log,
 *    where `turn/start` carries the Host's own turn number. {@link openTurnOf}
 *    derives the open turn and the sequence it started at from that log, which is
 *    the same anchor under a different name. The substitution and its limits are
 *    recorded rather than glossed over: the anchor identifies the turn the way the
 *    Host itself numbers turns, and a stop whose anchor no longer matches the open
 *    turn is **refused**, never retargeted at whatever turn is running now.
 *
 * Nothing here sends anything. The dispatch half lives in the coordinator, so the
 * operation record, the idempotency rule and the delivery states are shared with
 * ordinary sends rather than reimplemented.
 *
 * @module dsh-session-conductor/service/stop
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { outcomeOf, type SessionEventLike } from './projection.ts'
import type { TurnOutcome } from '../domain/state.ts'

/** One open turn, as the Host's own durable events describe it. */
export interface TurnAnchor {
  /** The Host's turn number, read from its `turn/start` event. */
  readonly turn: number
  /** The sequence of the `turn/start` event that opened this turn. */
  readonly startSeq: number
  /** The session's last sequence when the anchor was taken. */
  readonly seq: number
}

/**
 * Read the open turn from a session's event log.
 *
 * The log is folded here rather than trusted from a cached counter, because a
 * stale counter is exactly what would let a stop land on the wrong turn. A turn
 * is open when its `turn/start` has no matching `turn/end`; the Host's turn
 * numbers are its own, so the anchor stays comparable even after a restart.
 *
 * @param events - the session's events, in sequence order.
 * @returns the open turn, or undefined when the session is between turns.
 */
export function openTurnOf(events: readonly SessionEventLike[]): TurnAnchor | undefined {
  let open: { turn: number; startSeq: number } | undefined
  let seq = 0
  for (const event of events) {
    if (typeof event.seq === 'number') seq = Math.max(seq, event.seq)
    const data = event.data
    const turn = typeof data === 'object' && data !== null && typeof (data as { turn?: unknown }).turn === 'number'
      ? (data as { turn: number }).turn
      : undefined
    if (event.type === 'turn/start') {
      open = { turn: turn ?? 0, startSeq: event.seq }
    } else if (event.type === 'turn/end') {
      // Only the matching end closes the turn it opened. An end for a different
      // turn is the Host closing something this fold is not tracking, and
      // treating it as a close would drop a live turn's anchor.
      if (open === undefined || turn === undefined || turn === open.turn) open = undefined
    }
  }
  return open === undefined ? undefined : { ...open, seq }
}

/** The recorded end of one specific turn. */
export interface TurnEnd {
  readonly turn: number
  readonly seq: number
  /** The interpreted outcome, using the same mapping as every other reader. */
  readonly outcome: TurnOutcome
  /** The Host's own reason, verbatim. */
  readonly detail: string
}

/**
 * Find the recorded end of one specific turn.
 *
 * Specific rather than "the next turn end that happens": PRD §二.6 requires the
 * receipt to match the turn that was cancelled, and `whenIdle()` is explicitly
 * not a substitute. A different turn ending must not be read as this one's
 * receipt, or an interrupt-and-send would deliver into a turn it did not stop.
 *
 * The outcome is interpreted through {@link outcomeOf}, the same mapping every
 * other reader uses, so a stop receipt cannot disagree with what observation
 * reports about the same event.
 *
 * @param events - the session's events, in sequence order.
 * @param turn - the turn number to look for.
 * @returns the end record, or undefined while that turn has not ended.
 */
export function turnEndOf(events: readonly SessionEventLike[], turn: number): TurnEnd | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'turn/end') continue
    const data = event.data
    const number = typeof data === 'object' && data !== null && typeof (data as { turn?: unknown }).turn === 'number'
      ? (data as { turn: number }).turn
      : undefined
    if (number !== turn) continue
    const { outcome, detail } = outcomeOf((data as { reason?: unknown }).reason)
    return { turn, seq: event.seq, outcome, detail }
  }
  return undefined
}

/** The synchronous agent projection an exact stop needs. */
export interface StopAgentLike {
  /** Current lifecycle state, mirrored synchronously by the Host. */
  readonly status: 'idle' | 'running'
  /** The live session, whose event log is a synchronous projection. */
  readonly session: { readonly events: readonly SessionEventLike[] }
  /** Request cancellation. Synchronous by contract; see this module's header. */
  cancel(cause: { kind: 'hook'; reason: string }, options?: { readonly keepInbox?: boolean }): void
}

/** What an exact-stop attempt decided. */
export type StopDecision =
  | {
      readonly kind: 'no_active_turn'
      /** The turn the caller expected, when it named one. */
      readonly expected?: TurnAnchor
      readonly reason: string
    }
  | {
      readonly kind: 'stale_turn'
      readonly expected: TurnAnchor
      /** The turn actually open, when there is one. */
      readonly found?: TurnAnchor
      readonly reason: string
    }
  | {
      readonly kind: 'requested'
      /** The turn the cancel was requested for. */
      readonly turn: TurnAnchor
      readonly reason: string
    }

/**
 * What the caller expects to be running.
 *
 * Both members are optional, and omitting them is *weaker*, not stronger: with no
 * expectation the stop cancels whatever turn is open. The tool always supplies
 * them from a prior observation, so a stop that raced a new turn refuses.
 */
export interface StopExpectation {
  /** The turn number observed earlier. */
  readonly turn?: number
  /** The sequence the turn started at, observed earlier. */
  readonly startSeq?: number
}

/**
 * Verify the expected turn and cancel it, inside one synchronous critical section.
 *
 * **This function must never await, and must never be made `async`.** Its entire
 * guarantee is that the projection it validates against cannot change between the
 * check and the `cancel()` call. Both run in one tick of the Host's event loop, so
 * a turn that starts, a queue entry that arrives, or a binding that moves can only
 * be observed *before* or *after* this block, never inside it. Making it `async`,
 * or awaiting anything above the `cancel()` call, silently removes the guarantee
 * while leaving the code looking correct — which is why it is stated here and
 * asserted by a test.
 *
 * @param agent - the live agent whose session may have a turn to stop.
 * @param expectation - the turn the caller observed; omit to stop whatever is open.
 * @param options - optional cancel cause; the default names an exact stop so a budget
 *   request can be told apart from a person asking to stop.
 * @returns the decision; on `requested` the cancel has already been issued.
 */
export function cancelExpectedTurn(
  agent: StopAgentLike,
  expectation: StopExpectation = {},
  options: { readonly reason?: string } = {},
): StopDecision {
  const open = openTurnOf(agent.session.events)

  if (open === undefined || agent.status !== 'running') {
    // The table in PRD §二.6: interrupting an idle session reports that there is
    // no active turn. No cancel is issued, so nothing can be cancelled wrongly.
    return {
      kind: 'no_active_turn',
      ...expectation.turn === undefined && expectation.startSeq === undefined
        ? {}
        : { expected: { turn: expectation.turn ?? 0, startSeq: expectation.startSeq ?? 0, seq: 0 } },
      reason: open === undefined
        ? 'the session is between turns, so there is no active turn to stop'
        : `the session's status is ${agent.status}, so there is no active turn to stop`,
    }
  }

  if (expectation.turn !== undefined && expectation.turn !== open.turn) {
    return {
      kind: 'stale_turn',
      expected: { turn: expectation.turn, startSeq: expectation.startSeq ?? 0, seq: 0 },
      found: open,
      reason: `the expected turn ${String(expectation.turn)} is not the open turn (${String(open.turn)}); `
        + 'the expected turn already ended, so nothing was cancelled',
    }
  }
  if (expectation.startSeq !== undefined && expectation.startSeq !== open.startSeq) {
    return {
      kind: 'stale_turn',
      expected: { turn: expectation.turn ?? open.turn, startSeq: expectation.startSeq, seq: 0 },
      found: open,
      reason: `the expected turn start sequence ${String(expectation.startSeq)} is not the open turn's `
        + `(${String(open.startSeq)}); the expected turn already ended, so nothing was cancelled`,
    }
  }

  // `keepInbox` is set deliberately. The default Host behaviour clears queued and
  // steering work along with the turn, and the conductor did not author that
  // input: discarding a user's pending text as a side effect of a stop is exactly
  // the silent deletion PRD §八 forbids. The confirmation step below refuses to
  // send if new queue work appeared, which is the case the drain-order rule cares
  // about.
  agent.cancel(
    { kind: 'hook', reason: options.reason ?? 'conductor exact stop' },
    { keepInbox: true },
  )
  return { kind: 'requested', turn: open, reason: `requested cancellation of turn ${String(open.turn)}` }
}

/**
 * In-memory record of conductor-issued cancels (PRD §三.4 `interrupting`).
 *
 * Not persisted: after a restart the Host log is the fact, and if the turn is
 * still running we do not claim we asked to stop it. A stale entry for a turn
 * that has already ended does not overlay — {@link overlayExecution} requires
 * the open turn to match.
 */
export class CancelTracker {
  private readonly bySession = new Map<string, number>()

  /**
   * Record that cancel was issued for this session's open turn.
   * @param sessionId - the bound Host session.
   * @param turn - the Host turn number that was cancelled.
   */
  note(sessionId: string, turn: number): void {
    this.bySession.set(sessionId, turn)
  }

  /**
   * The turn a cancel was issued for, if any.
   * @param sessionId - the bound Host session.
   * @returns the turn number, or undefined.
   */
  requestedTurn(sessionId: string): number | undefined {
    return this.bySession.get(sessionId)
  }
}

/** The unconsumed input a session is holding. */
export interface PendingInput {
  /** Prompts awaiting their own turns — the queue of PRD §二.6. */
  readonly queue: readonly PendingMessage[]
  /** Input awaiting the next step boundary — steering. */
  readonly steering: readonly PendingMessage[]
}

/** One unconsumed message, as far as the conductor may show it. */
export interface PendingMessage {
  readonly messageId: string
  readonly text: string
}

/** One pending inbox entry, as far as this module needs to read it. */
export interface PendingInboxEntry {
  readonly id: unknown
  /** Present on the unit-test fakes; the live Host UserMessage has none. */
  readonly text?: unknown
  /** The live Host UserMessage stores its body here as content blocks. */
  readonly content?: unknown
}

/** The synchronous inbox projection, including its mutation surface. */
export interface StopInboxLike {
  readonly nextTurn: readonly PendingInboxEntry[]
  readonly nextStep: readonly PendingInboxEntry[]
  /** Whether either pending list contains work. */
  readonly hasPending: boolean
  /**
   * Remove one unconsumed message and durably record its cancellation.
   *
   * Typed against the Host's own message identity rather than a local stand-in:
   * withdrawing the wrong pending message is not something a structural
   * reimplementation should be trusted with.
   *
   * @param messageId - identity of the pending message to withdraw.
   * @returns whether it was still pending.
   */
  remove(messageId: MessageId): boolean
  /**
   * Replace one unconsumed message in place, possibly changing its identity.
   * @param messageId - identity of the pending message to replace.
   * @param message - the replacement message.
   * @returns whether it was still pending; `false` means it had been consumed.
   */
  replace(messageId: MessageId, message: UserMessage): boolean
}

/**
 * Read what a session has not consumed yet.
 *
 * Read from the Host's inbox projection rather than from the conductor's own
 * records, so it cannot disagree with what the Host will actually consume. The
 * live Host stores a user message as `{ id, content: [{ type: 'text', text }] }`
 * with no `.text` field; the unit-test fakes keep a plain `text` string. Both
 * are flattened. A message that has neither is reported with empty text rather
 * than guessed at.
 *
 * @param inbox - the agent's inbox projection.
 * @returns the queue and the steering, each in the order the Host will consume it.
 */
export function pendingInputOf(inbox: StopInboxLike): PendingInput {
  const read = (list: readonly PendingInboxEntry[]): PendingMessage[] =>
    list.map(message => ({
      messageId: String(message.id),
      text: pendingTextOf(message),
    }))
  return { queue: read(inbox.nextTurn), steering: read(inbox.nextStep) }
}

/**
 * Flatten one pending message's body into text.
 *
 * A non-empty string `.text` wins, because that is what the in-process fakes
 * write and what a Host might expose as a convenience getter. Otherwise the
 * Host's `content` blocks are joined, which is the shape `createUserMessage`
 * actually produces. Anything else is empty rather than a guessed serialisation.
 *
 * @param message - one inbox entry.
 * @returns the readable text, or the empty string.
 */
export function pendingTextOf(message: PendingInboxEntry): string {
  if (typeof message.text === 'string' && message.text.length > 0) return message.text
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return typeof message.text === 'string' ? message.text : ''
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

/** Why an interrupt-and-send stopped short of sending. */
export interface InterruptPrecondition {
  readonly ok: boolean
  readonly code?: 'QUEUE_CONFLICT' | 'NO_ACTIVE_TURN'
  readonly reason: string
}

/**
 * Decide whether an interrupt-and-send may proceed to the cancel.
 *
 * Step 2 of PRD §二.6 is the only precondition that is checked *before* the
 * cancel: an unconsumed queue means the session already has work waiting, and the
 * specification requires `QUEUE_CONFLICT` with the caller's text kept. The
 * remaining checks happen after the turn has actually ended, because they are
 * about what changed while the stop was in flight.
 *
 * @param pending - the unconsumed input, read synchronously.
 * @returns whether to proceed, and why not when not.
 */
export function interruptPrecondition(pending: PendingInput): InterruptPrecondition {
  if (pending.queue.length > 0) {
    return {
      ok: false,
      code: 'QUEUE_CONFLICT',
      reason: `the session has ${String(pending.queue.length)} unconsumed queued message(s) `
        + `(first: ${pending.queue[0]?.messageId ?? 'unknown'}); the instruction was kept and nothing was cancelled`,
    }
  }
  return { ok: true, reason: 'the queue is empty, so the stop may proceed' }
}

/** What changed while a stop was in flight. */
export interface PostStopCheck {
  readonly ok: boolean
  readonly reason: string
}

/**
 * Decide whether the instruction may still be sent after the turn ended.
 *
 * Steps 5 and 6 of PRD §二.6. The send is abandoned — and the text reported as
 * kept, never dropped — if a new turn opened, new queue work appeared, or the
 * binding moved underneath. Each is checked against the value taken *before* the
 * cancel, so the comparison is against the caller's own observation rather than
 * against a later reading of the same mutable state.
 *
 * A value that could not be read *after* the stop is treated as a refusal, not as
 * a change: sending into a control state the caller could not verify is the risk
 * the rule exists to avoid. The two cases are still reported differently, because
 * "the binding moved" and "the binding could not be read" are different facts and
 * only one of them is evidence.
 *
 * @param before - the state captured before the cancel.
 * @param after - the state read after the matching turn end.
 * @returns whether to send, and the reason either way.
 */
export function afterStopCheck(
  before: { readonly turn: number; readonly queueLength: number; readonly bindingVersion?: number; readonly ownerEpoch?: number },
  after: {
    readonly openTurn?: TurnAnchor | undefined
    readonly queueLength: number
    readonly bindingVersion?: number | undefined
    readonly ownerEpoch?: number | undefined
  },
): PostStopCheck {
  if (after.openTurn !== undefined && after.openTurn.turn !== before.turn) {
    return {
      ok: false,
      reason: `turn ${String(after.openTurn.turn)} started while the stop was in flight, so the instruction was kept `
        + 'rather than delivered into a turn the caller did not expect',
    }
  }
  if (after.queueLength > before.queueLength) {
    return {
      ok: false,
      reason: `the queue grew from ${String(before.queueLength)} to ${String(after.queueLength)} while the stop was in `
        + 'flight, so the instruction was kept',
    }
  }
  const binding = compareControl('binding version', before.bindingVersion, after.bindingVersion)
  if (binding !== undefined) return binding
  const epoch = compareControl('write-control epoch', before.ownerEpoch, after.ownerEpoch)
  if (epoch !== undefined) return epoch
  return { ok: true, reason: 'the expected turn ended and nothing else changed, so the instruction may be sent' }
}

/**
 * Compare one control value taken before and after the stop.
 *
 * @param name - what is being compared, for the reason text.
 * @param before - the value captured before the cancel.
 * @param after - the value read after the matching turn end.
 * @returns the refusal, or undefined when the value is unchanged or was never read.
 */
function compareControl(name: string, before: number | undefined, after: number | undefined): PostStopCheck | undefined {
  if (before === undefined) return undefined
  if (after === undefined) {
    return { ok: false, reason: `the ${name} could not be read after the stop, so the instruction was kept rather than sent into a control state that could not be verified` }
  }
  if (after !== before) {
    return {
      ok: false,
      reason: `the ${name} moved from ${String(before)} to ${String(after)} while the stop was in flight, so the instruction was kept`,
    }
  }
  return undefined
}

/**
 * The message a caller sees when the stop was never confirmed.
 *
 * PRD §二.6 step 7 requires the exact wording "stop not confirmed, instruction
 * not sent" to be reported rather than an ambiguous timeout, because the caller's
 * next decision depends on knowing the instruction was *not* delivered.
 *
 * @param limitMs - the configured confirmation ceiling.
 * @param turn - the turn the cancel was requested for.
 * @returns the report text.
 */
export function unconfirmedStopReport(limitMs: number, turn: TurnAnchor): string {
  return `stop not confirmed, instruction not sent: turn ${String(turn.turn)} did not report an end within `
    + `${String(limitMs)} ms of the cancellation request`
}
