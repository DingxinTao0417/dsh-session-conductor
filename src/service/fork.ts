/**
 * Choosing what a fork copies (PRD §二.2.2).
 *
 * The specification's fork rules are all about the boundary, so the boundary is
 * computed here as a pure function over a session log and tested directly:
 *
 * - only a fixed prefix of **completed turns** is copied;
 * - content still being generated, unconsumed messages, pending approvals and
 *   background processes are not copied;
 * - the source task's control authority, timers and workflow runs are not
 *   inherited.
 *
 * The first two are properties of the cut. The third is a property of what the
 * caller does with it: a fork creates a *new* logical task with its own control
 * record, so nothing about authority travels with the history.
 *
 * The cut is computed from the source log as a completed-turn prefix: back to
 * the last `turn/end` at or before the requested point. The seed **stops at
 * that end**. Walking forward to the next `turn/start` would copy the gap
 * between turns — which is where unconsumed inbox splices, pending approvals
 * and still-running commands show up — and T04 forbids copying those. A
 * differently-placed boundary that included the unfinished turn would also
 * produce a session the Host itself would not have forked.
 *
 * @module dsh-session-conductor/service/fork
 */

import type { SessionEventLike } from './projection.ts'

/** Where a fork's copy of history stops. */
export interface ForkCut {
  /** Sequence of the `turn/end` the fork is anchored to. */
  readonly boundarySeq: number
  /** Number of leading events copied; also the seed length. */
  readonly seedLength: number
}

/** Why a fork could not be cut. */
export interface ForkCutRefusal {
  readonly error: string
}

/**
 * Compute the cut for a fork.
 *
 * @param events - the source session's events, in log order.
 * @param atSeq - copy only up to the completed turn containing this event. When
 * omitted, the last completed turn is used.
 * @returns the cut, or the reason there is none.
 */
export function computeForkCut(
  events: readonly SessionEventLike[],
  atSeq?: number,
): ForkCut | ForkCutRefusal {
  const lastIndex = events.length - 1
  const lastSeq = lastIndex < 0 ? -1 : events[lastIndex]?.seq ?? -1

  // The anchor is the first turn end at or after the requested point, or the
  // last turn end in the log when the caller named no point (or named one past
  // the end).
  const anchored = atSeq === undefined
    ? undefined
    : events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
  const boundary = anchored
    ?? (atSeq === undefined || atSeq > lastSeq
      ? findLastTurnEnd(events)
      : undefined)

  if (boundary === undefined) {
    return {
      error: atSeq !== undefined && atSeq <= lastSeq
        ? `the source session has not completed the turn containing event ${String(atSeq)}, so there is nothing finished to fork`
        : 'the source session has no completed turn to fork from',
    }
  }

  // A fork copies whole completed turns and nothing after that turn's end.
  // Extending the seed through the gap before the next `turn/start` is how
  // unconsumed inbox splices, pending approvals and background commands would
  // travel with the child (T04 / PRD §二.2.2).
  const boundaryIndex = events.findIndex(event => event.seq === boundary.seq)
  return { boundarySeq: boundary.seq, seedLength: boundaryIndex + 1 }
}

/**
 * Find the last turn end in a log.
 * @param events - the session's events.
 * @returns the event, or undefined when no turn has ended.
 */
function findLastTurnEnd(events: readonly SessionEventLike[]): SessionEventLike | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') return event
  }
  return undefined
}
