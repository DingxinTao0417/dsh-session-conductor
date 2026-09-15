/**
 * The fork provenance PRD §二.2.2 requires to be recorded and shown:
 * source task, source session, and the history cutoff.
 *
 * The store already keeps those facts on a `contexts` snapshot. This module is
 * the *display* projection so the fork result, the panel detail and a later
 * reader cannot each invent a different sentence for the same record.
 *
 * Pure data plus a pure function, importing nothing: the Host half and the
 * client half have to agree on the same line.
 *
 * @module dsh-session-conductor/domain/fork-origin
 */

/** The three facts a fork must name (PRD §二.2.2). */
export interface ForkOrigin {
  /** Logical task the history was copied from, when the source is a managed task. */
  readonly sourceTaskId?: string | undefined
  /** Host session the completed-turn prefix was taken from. */
  readonly sourceSessionId: string
  /** Last event sequence included; the seed stops here. */
  readonly cutoffSeq: number
}

/**
 * Project a stored context snapshot into the fork-origin shape.
 *
 * @param snapshot - the `fork-<taskId>` context record, when one exists.
 * @returns the origin, or undefined when nothing was recorded.
 */
export function forkOriginOf(snapshot: {
  readonly sourceTaskId?: string | undefined
  readonly sourceSessionId: string
  readonly cutoffSeq: number
} | undefined): ForkOrigin | undefined {
  if (snapshot === undefined) return undefined
  return {
    ...snapshot.sourceTaskId === undefined ? {} : { sourceTaskId: snapshot.sourceTaskId },
    sourceSessionId: snapshot.sourceSessionId,
    cutoffSeq: snapshot.cutoffSeq,
  }
}

/**
 * The sentence a result, a panel row or a model-facing summary shows.
 *
 * @param origin - {@link forkOriginOf}'s result.
 * @returns `forked from task <id> (session <sid>) through event seq <n>`.
 */
export function describeForkOrigin(origin: ForkOrigin): string {
  const from = origin.sourceTaskId === undefined
    ? `session ${origin.sourceSessionId}`
    : `task ${origin.sourceTaskId} (session ${origin.sourceSessionId})`
  return `forked from ${from} through event seq ${String(origin.cutoffSeq)}`
}

/**
 * Flatten an origin into optional result fields so a create/attach without one
 * does not invent empty strings.
 *
 * @param origin - {@link forkOriginOf}'s result.
 * @returns fields to spread, or an empty object.
 */
export function forkOriginFieldsOf(origin: ForkOrigin | undefined): {
  sourceTaskId?: string
  sourceSessionId?: string
  cutoffSeq?: number
} {
  if (origin === undefined) return {}
  return {
    ...origin.sourceTaskId === undefined ? {} : { sourceTaskId: origin.sourceTaskId },
    sourceSessionId: origin.sourceSessionId,
    cutoffSeq: origin.cutoffSeq,
  }
}
