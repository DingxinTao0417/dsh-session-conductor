/**
 * Panel unread counts (PRD §二.1 未读数量 / 未读事项).
 *
 * Opening a detail view must not consume another reader's session-history
 * cursor (PRD §二.7), and it also must not mark these reports as read. Unread
 * falls only when a controller **acknowledges** the reports that were delivered
 * to them. Withdrawn reports are not a mailbox.
 *
 * @module dsh-session-conductor/service/unread
 */

/** The fields unread counting needs. */
export interface UnreadNotification {
  readonly withdrawn: boolean
  readonly acknowledgedAt?: string | undefined
}

/** How many unread reports the detail view lists. */
export const UNREAD_ITEM_LIMIT = 20

/** One unacknowledged report as the panel lists it. */
export interface UnreadItem {
  readonly notificationId: string
  readonly summary: string
  readonly createdAt: string
}

/**
 * How many reports still count as unread.
 *
 * @param notifications - reports already narrowed to the card's task (or to one controller).
 * @returns the count; never negative.
 */
export function unreadCountOf(notifications: readonly UnreadNotification[]): number {
  let count = 0
  for (const record of notifications) {
    if (record.withdrawn) continue
    if (record.acknowledgedAt !== undefined) continue
    count += 1
  }
  return count
}

/**
 * The newest unacknowledged reports, for the panel's 未读事项 list.
 *
 * Opening the list does not mark them read. Truncation is the caller's to
 * notice: compare {@link unreadCountOf} with the returned length.
 *
 * @param notifications - newest-first reports already narrowed to the task.
 * @returns at most {@link UNREAD_ITEM_LIMIT} items.
 */
export function unreadItemsOf(
  notifications: readonly (UnreadNotification & {
    readonly notificationId: string
    readonly summary: string
    readonly createdAt: string
  })[],
): UnreadItem[] {
  const items: UnreadItem[] = []
  for (const record of notifications) {
    if (record.withdrawn) continue
    if (record.acknowledgedAt !== undefined) continue
    items.push({
      notificationId: record.notificationId,
      summary: record.summary,
      createdAt: record.createdAt,
    })
    if (items.length >= UNREAD_ITEM_LIMIT) break
  }
  return items
}
