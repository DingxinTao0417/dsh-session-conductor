/**
 * Full-text search of sessions the caller may read (PRD §二.5).
 *
 * > 全文搜索仅限调用者有权读取的会话。未加入的候选会话默认只返回用于选择的元信息。
 *
 * Matching uses the same readable history `conductor_read` projects (`historyOf`):
 * public messages and tool results, never raw token streams. A hit names the task
 * and the location (`seq` + `kind`); it never carries the matching text. The body
 * is still only available through `conductor_read`.
 *
 * Access is the same rule `mayRead` uses (controller or observer) plus the
 * release check the observer already applies: a caller that is not a reader of a
 * session cannot match it, and a released task is not searched. The existing
 * `callerEvents` path is the write-barrier's unauthenticated read of the
 * *caller's own* session and is not used here — a search built on it would be a
 * second, unchecked read beside `conductor_read`.
 *
 * @module dsh-session-conductor/service/search
 */

import { mayRead } from './access.ts'
import type { AccessRecord } from '../store/schema.ts'
import type { HistoryEntry } from './projection.ts'

/** Where a query matched, without the matching text. */
export interface SessionSearchHit {
  readonly seq: number
  readonly kind: HistoryEntry['kind']
}

/** One task the query matched, with every location it hit. */
export interface TaskSearchMatch {
  readonly taskId: string
  readonly hits: readonly SessionSearchHit[]
}

/** A task the caller may read but that could not be searched. */
export interface TaskSearchUnreadable {
  readonly taskId: string
  readonly reason: string
}

/** The outcome of one search over a set of tasks. */
export interface SessionSearchResult {
  readonly matches: readonly TaskSearchMatch[]
  readonly unreadable: readonly TaskSearchUnreadable[]
}

/**
 * Whether this caller may have a session's history searched at all.
 *
 * Two different silences, kept apart because they mean different things to the
 * caller of {@link TaskObserver.search}:
 *
 * - `not_reader` — omit the task entirely. Reporting it would leak that a
 *   session the caller cannot read exists and has (or has not) matching text.
 * - `released` — the caller *is* a reader, so the release can be named; the
 *   session is not searched.
 *
 * An absent control record is `not_reader`: there is no relationship that would
 * make this caller a reader, and inventing one would be a different rule from
 * `mayRead`.
 *
 * @param access - the task's control record, when it has one.
 * @param readerSessionId - the calling session, from the Host context.
 * @returns whether to search, omit, or report as unreadable.
 */
export function searchAccessOf(
  access: AccessRecord | undefined,
  readerSessionId: string,
): { readonly kind: 'search' } | { readonly kind: 'omit' } | { readonly kind: 'unreadable'; readonly reason: string } {
  if (access === undefined) return { kind: 'omit' }
  if (!mayRead(access, readerSessionId)) return { kind: 'omit' }
  if (access.detachedAt !== undefined) {
    return {
      kind: 'unreadable',
      reason: `management of task ${access.taskId} was released at ${access.detachedAt}, so the conductor no longer `
        + 'searches its session. Anything already accepted is untouched; rejoin the task to search it again.',
    }
  }
  return { kind: 'search' }
}

/**
 * Find every readable-history line that contains the query.
 *
 * Case-insensitive substring, matching the name and project filters on the same
 * list. An empty or whitespace-only query matches nothing rather than everything:
 * a content search that matched every line would be a body dump.
 *
 * Each hit is `{ seq, kind }` only. Copying `entry.text` onto the hit would make
 * this function a read of the body, which PRD §二.5 keeps on `conductor_read`.
 *
 * @param entries - the readable history of one session, already projected.
 * @param query - the text to look for.
 * @returns the matching locations, in the order the entries arrived.
 */
export function hitsInHistory(
  entries: readonly HistoryEntry[],
  query: string,
): SessionSearchHit[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  const hits: SessionSearchHit[] = []
  for (const entry of entries) {
    if (entry.text.toLowerCase().includes(needle)) {
      hits.push({ seq: entry.seq, kind: entry.kind })
    }
  }
  return hits
}
