/**
 * Specified ceilings that are not budget policy (PRD §四.7).
 *
 * Budget limits live in `service/budget.ts` because they are a run ledger.
 * These are Host- and controller-wide caps the conductor must honour before
 * it creates more work, and they are kept here so a test can assert the
 * counting rule without constructing a coordinator.
 *
 * @module dsh-session-conductor/domain/limits
 */

/** One control record, as the managed-target count reads it. */
export interface ManagedAccessLike {
  readonly taskId: string
  readonly ownerSessionId: string
  readonly detachedAt?: string | undefined
}

/**
 * How many targets a controller session still manages.
 *
 * Released management (`detachedAt`) does not count: the specification's
 * "控制会话管理目标数" is the live set, not the historical one. Identity is
 * the current owner, so a transfer moves the slot to the new controller
 * rather than leaving it billed to the session that created the task.
 *
 * @param records - control records.
 * @param ownerSessionId - the controller session.
 * @returns how many of those records this session currently owns.
 */
export function countManagedTargets(
  records: readonly ManagedAccessLike[],
  ownerSessionId: string,
): number {
  let count = 0
  for (const record of records) {
    if (record.ownerSessionId === ownerSessionId && record.detachedAt === undefined) count += 1
  }
  return count
}

/**
 * Reason to refuse another managed target, or `undefined` when the slot is free.
 *
 * @param count - how many this controller already owns.
 * @param limit - the configured ceiling (PRD §四.7 default 20).
 * @param ownerSessionId - named in the reason so the caller can see who is capped.
 * @returns the refusal, or `undefined` when `count < limit`.
 */
export function managedTargetLimitReason(
  count: number,
  limit: number,
  ownerSessionId: string,
): string | undefined {
  if (count < limit) return undefined
  return `this controller session (${ownerSessionId}) already manages ${String(count)} target(s), `
    + `which is the configured limit of ${String(limit)}; release one before creating, attaching or forking another`
}
