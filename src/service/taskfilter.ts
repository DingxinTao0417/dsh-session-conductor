/**
 * Filtering the conductor's task list (PRD §二.5).
 *
 * > 支持按项目、名称、状态、Host、分组、归档状态筛选。
 *
 * ## Why one pure function rather than a predicate where each fact lives
 *
 * The six filters span three different homes:
 *
 * - facts the conductor's own **task record** holds — name (`title`), project (`originRepoPath`), group,
 *   archive state, preparation;
 * - a fact that lives on the **binding** — the Host the task runs on;
 * - a fact that is **derived** — the status badge, which `panelStatusOf` computes from the projection, the
 *   release record and the budget gate that actually refuses dispatches.
 *
 * A filter implemented where each fact happens to live would be three disagreeing ideas of what "filter by
 * status" means, and the badge in particular has to be the **same** badge the panel filters and groups by:
 * otherwise a caller asking the tool and a reader looking at the panel would be looking at different lists
 * and neither would know. So the caller assembles each row once — record, binding and badge together — and
 * the narrowing happens here, purely, where it can be tested without a Host. Sorting (pinned first, then
 * newest) and pagination (offset + limit) are the same: one function each, used by the tool and the panel.
 *
 * ## Matching rules
 *
 * - `name` and `project` are **case-insensitive substrings**, because a person searching a list types part
 *   of a name; everything else is an exact match, because it names a state or an identity.
 * - **An absent filter is no constraint.** A filter set to `undefined` and one nobody set must not mean
 *   different things — the recurring way a list silently narrows.
 * - A row that cannot answer a filter (`hostId` for a task with no binding) does **not** match it. It is
 *   not "unknown, so include it": a caller filtering by Host asked for tasks on that Host.
 *
 * @module dsh-session-conductor/service/taskfilter
 */

import type { PanelTaskStatus } from '../domain/panel-status.ts'

/**
 * One task as the list tool sees it: the stored record, the binding facts and the derived badge.
 *
 * The derived members stay optional because a caller may legitimately be unable to derive them — no store
 * open, a badge the projector cannot reach — and a filter over them must then match nothing rather than
 * match everything.
 */
export interface TaskListRow {
  readonly taskId: string
  readonly title: string
  readonly preparation: string
  readonly archived: boolean
  readonly pinned: boolean
  readonly updatedAt: string
  readonly controllerSessionId: string
  readonly groupId?: string | undefined
  /** The project the task's directory came from (PRD §二.1), when it came from one. */
  readonly project?: string | undefined
  /** The directory the task runs in, as the binding recorded it. */
  readonly cwd?: string | undefined
  /** The Host the task is bound to. */
  readonly hostId?: string | undefined
  /** The Host session carrying the task. */
  readonly sessionId?: string | undefined
  /** The badge `panelStatusOf` derived for this task, when the caller could derive one. */
  readonly status?: PanelTaskStatus | undefined
  readonly statusReason?: string | undefined
  /**
   * Reachability of the bound session (PRD §二.5 失联 / 不可恢复).
   *
   * Not a filter: §二.5's filter set is project, name, status, Host, group and
   * archive. These fields are a view of the same connection dimension discovery
   * and the panel already show, so a list cannot look more live than a card.
   */
  readonly connection?: 'online' | 'reconnecting' | 'unavailable' | undefined
  readonly unrecoverable?: boolean | undefined
  readonly connectionReason?: string | undefined
  /**
   * PRD §二.10.2's 任务继续于新会话 sentence, when this task has a predecessor
   * session. Not a filter: the chain is identity, shown beside the current session.
   */
  readonly continuation?: string | undefined
  /** `older → … → current` when the chain has more than one session. */
  readonly sessionChain?: string | undefined
  /**
   * Last-turn outcome (最近结果) and Host reason (最近进展) (PRD §二.1).
   * Not a filter: the card already shows them, so the list cannot omit them.
   */
  readonly lastTurn?: string | undefined
  readonly lastTurnDetail?: string | undefined
  readonly pendingInteraction?: string | undefined
  readonly unread?: number | undefined
  /**
   * Live execution, kept separate from the status badge (PRD §二.1 / C204).
   * Not a filter: the card already shows it, so the list cannot collapse it into `status`.
   */
  readonly execution?: string | undefined
  /**
   * The Host's last logged request configuration (PRD §二.3 最近实际使用).
   * Not a filter. Omitted when the Host logged none.
   */
  readonly modelLastUsed?: string | undefined
  /**
   * Whether the Host archived this task's bound session outside the conductor (PRD §二.5).
   * Not a filter. Omitted when there is no binding or the archive set could not be read.
   */
  readonly sessionArchivedExternally?: boolean | undefined
}

/** The filters PRD §二.5 names, plus the ones this list already had. */
export interface TaskListFilter {
  /** Only tasks coordinated by this Host session. */
  readonly controllerSessionId?: string | undefined
  readonly preparation?: string | undefined
  readonly groupId?: string | undefined
  readonly archived?: boolean | undefined
  readonly pinned?: boolean | undefined
  /** Case-insensitive substring of the task's project (the directory it was created from). */
  readonly project?: string | undefined
  /** Case-insensitive substring of the task's name (its conductor-side title). */
  readonly name?: string | undefined
  /** The Host the task is bound to, exactly as the binding records it. */
  readonly hostId?: string | undefined
  /** The derived status badge, from the same vocabulary the panel filters by. */
  readonly status?: PanelTaskStatus | undefined
}

/**
 * Narrow a row set to what a filter names.
 *
 * @param rows - every row the caller may see, already assembled.
 * @param filter - the narrowing; omitted members do not constrain.
 * @returns the matching rows, in the order they arrived.
 */
export function applyTaskListFilter(
  rows: readonly TaskListRow[],
  filter: TaskListFilter = {},
): TaskListRow[] {
  const name = filter.name?.toLowerCase()
  const project = filter.project?.toLowerCase()
  return rows.filter((row) => {
    if (filter.controllerSessionId !== undefined && row.controllerSessionId !== filter.controllerSessionId) return false
    if (filter.preparation !== undefined && row.preparation !== filter.preparation) return false
    if (filter.groupId !== undefined && row.groupId !== filter.groupId) return false
    if (filter.archived !== undefined && row.archived !== filter.archived) return false
    if (filter.pinned !== undefined && row.pinned !== filter.pinned) return false
    // An absent project on the row cannot satisfy a project filter, and an unreadable status cannot satisfy
    // a status filter: both are reported as "does not match" rather than silently passed through.
    if (project !== undefined && !row.project?.toLowerCase().includes(project)) return false
    if (name !== undefined && !row.title.toLowerCase().includes(name)) return false
    if (filter.hostId !== undefined && row.hostId !== filter.hostId) return false
    if (filter.status !== undefined && row.status !== filter.status) return false
    return true
  })
}

/**
 * Say which filters are active, so a narrowed list cannot be read as the whole list.
 *
 * The tool reports `total` as the count **after** filtering, which is right — but a reader who is not told
 * that a filter was applied will read that number as "how many tasks exist". Naming the active filters is
 * the difference, and it costs one line.
 *
 * @param filter - the filter as the caller supplied it.
 * @returns a comma-separated description, or an empty string when nothing was filtered.
 */
export function describeTaskListFilter(filter: TaskListFilter): string {
  const parts: string[] = []
  if (filter.controllerSessionId !== undefined) parts.push(`controller session = ${filter.controllerSessionId}`)
  if (filter.preparation !== undefined) parts.push(`preparation = ${filter.preparation}`)
  if (filter.groupId !== undefined) parts.push(`group = ${filter.groupId}`)
  if (filter.archived !== undefined) parts.push(`archived = ${String(filter.archived)}`)
  if (filter.pinned !== undefined) parts.push(`pinned = ${String(filter.pinned)}`)
  if (filter.project !== undefined) parts.push(`project contains "${filter.project}"`)
  if (filter.name !== undefined) parts.push(`name contains "${filter.name}"`)
  if (filter.hostId !== undefined) parts.push(`host = ${filter.hostId}`)
  if (filter.status !== undefined) parts.push(`status = ${filter.status}`)
  return parts.join(', ')
}

/**
 * The list order PRD §二.5 names: 置顶 first, then newest `updatedAt`.
 *
 * Pinning that is only a filter is not sorting. A pinned task that is older than
 * an unpinned neighbour would sink under recency and the pin would not be a
 * ranking, which is what "置顶及排序" asks for. Ties on the same instant break
 * by `taskId` so a page is reproducible.
 *
 * @param rows - the rows after filtering, in any order.
 * @returns a new array, pinned first then newest.
 */
export function sortTaskList<T extends { readonly pinned: boolean; readonly updatedAt: string; readonly taskId: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1
    return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0
  })
}

/** One page of a filtered list (PRD §三.3 分页). */
export interface ListPage<T> {
  readonly items: readonly T[]
  readonly offset: number
  readonly limit: number
  readonly total: number
  readonly returned: number
}

/**
 * Slice a sorted list into one page.
 *
 * `limit` without an offset is a cap, not pagination: the rest of a long list
 * would be unreachable except by raising the cap. A negative or non-finite
 * offset is 0; a negative limit is an empty page.
 *
 * @param items - the sorted full match set.
 * @param offset - how many matching items to skip.
 * @param limit - the page size.
 * @returns the page, with the totals a caller needs to continue.
 */
export function pageOf<T>(items: readonly T[], offset: number, limit: number): ListPage<T> {
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 0
  const sliced = items.slice(start, start + cap)
  return {
    items: sliced,
    offset: start,
    limit: cap,
    total: items.length,
    returned: sliced.length,
  }
}
