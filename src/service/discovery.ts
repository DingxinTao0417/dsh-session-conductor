/**
 * Discovering Host sessions the conductor could manage (PRD §二.5).
 *
 * The specification is specific about what discovery may reveal: a candidate the
 * caller has not joined returns **only the metadata needed to choose it**. So
 * this module deliberately projects a narrow shape — id, title, directory, age,
 * liveness — and never message content, tool output, or anything else from a
 * session's log.
 *
 * It also distinguishes the three states a session can be in, because they lead
 * to different decisions: a session the Host currently holds, one only the
 * persistence backend can materialise, and one already managed by the conductor.
 *
 * @module dsh-session-conductor/service/discovery
 */

import { connectionOf, type ConnectionState } from '../domain/state.ts'

/** The subset of the Host's session record this module reads. */
export interface SessionRecordLike {
  readonly header: {
    readonly id: unknown
    readonly createdAt?: number
    readonly cwd?: string
    readonly parentSession?: unknown
    readonly origin?: string
  }
  /** Whether the id currently exists as a live session. */
  readonly live: boolean
  /** Whether the active persistence backend currently materialises the id. */
  readonly persisted: boolean
}

/** The session-query surface discovery uses. */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly SessionRecordLike[]>
}

/** What a caller may narrow a candidate list by. */
export interface CandidateFilter {
  /** Case-insensitive substring of the session id or title. */
  readonly query?: string
  /** Only sessions whose directory contains this substring, case-insensitively. */
  readonly directory?: string
  /** Only sessions the Host currently holds. */
  readonly liveOnly?: boolean
  /** Include sessions the conductor already manages. Defaults to false. */
  readonly includeManaged?: boolean
}

/** One candidate session, with selection metadata only. */
export interface CandidateSession {
  readonly sessionId: string
  readonly title?: string
  readonly directory?: string
  readonly createdAt?: string
  readonly live: boolean
  readonly persisted: boolean
  /**
   * Reachability (PRD §三.4 连接), derived from `live` and `persisted`.
   *
   * `online` is the Host currently holding the session. `unavailable` is 失联
   * when the session is still persisted, and 不可恢复 when it is not.
   */
  readonly connection: ConnectionState
  /** True only when the Host said the session is neither live nor persisted. */
  readonly unrecoverable: boolean
  readonly connectionReason: string
  /** True when the conductor already manages this session. */
  readonly managed: boolean
  /** Task currently bound to this session, when the conductor manages it. */
  readonly taskId?: string
  /** Session this one was forked from. */
  readonly parentSessionId?: string
  /** Set for a session the Host classifies as a subagent child. */
  readonly origin?: string
  /**
   * Whether the Host's own registry has this session **archived** (PRD §二.5's 外部归档).
   *
   * The Host keeps a registry-level global archive set — `ctx.workspaceRegistry.archivedSessionIds`, which
   * its own `workspace.list` serves as a full snapshot — and §二.5 asks the conductor to let a reader see
   * sessions archived **outside** it. Reading is the whole of the requirement: the sentence beside it says
   * the plugin's own archiving must not call the Host's archive interface, so this is a fact to display and
   * never a button.
   *
   * **Absent means "the Host does not publish the set", not "not archived".** Those are different answers and
   * the caller says which case the whole list is in, so a reader is never shown a `false` this code invented.
   */
  readonly externallyArchived?: boolean
}

/**
 * What the Host's registry-global archive set says, as read for one discovery call (PRD §二.5).
 *
 * Three answers are kept apart on purpose, because they mean different things to a reader:
 *
 * - `published` — here is the set, in the Host's own archive order.
 * - `absent` — this Host composition publishes no archive set at all (`ctx.workspaceRegistry` is
 *   mounted without it, or nothing is mounted), so no session can be described either way.
 * - `unreadable` — the set exists but could not be read right now, with the Host's own reason. The
 *   Host's getter calls `requireState()` and throws `workspace registry is not started yet` while the
 *   registry is mounted but still starting, which is a boot window this plugin can really observe.
 *
 * Collapsing any of these into an empty list would turn "cannot tell" into "nothing is archived",
 * a fact this code would have invented.
 */
export type ArchiveSetRead =
  | { readonly state: 'published'; readonly sessionIds: readonly string[] }
  | { readonly state: 'absent'; readonly reason: string }
  | { readonly state: 'unreadable'; readonly reason: string }

/** One discovery call: the candidates, plus what could not be answered about it. */
export interface CandidateList {
  /** The candidates, newest first. */
  readonly candidates: readonly CandidateSession[]
  /**
   * How the Host's archive set was read, or `undefined` when this composition exposes no registry to
   * read it through.
   */
  readonly archive?: ArchiveSetRead | undefined
  /**
   * Why there is no candidate list at all, when the Host offers no session query to build one from.
   * Distinct from an empty list: this one is a capability gap, not a search that matched nothing.
   */
  readonly unavailable?: string | undefined
}

/** How the conductor learns which sessions are already managed. */
export interface ManagedSessionIndex {
  /**
   * Look one session up among the conductor's bindings.
   * @param sessionId - the Host session id.
   * @returns the managing task id, when one exists.
   */
  managedBy(sessionId: string): string | undefined
}

/** How the conductor resolves a title for a candidate. */
export interface TitleLookup {
  /**
   * Read the current title of one session.
   * @param sessionId - the Host session id.
   * @returns the title, or undefined when unset or unreadable.
   */
  titleOf(sessionId: string): Promise<string | undefined>
}

/** Everything discovery needs from its environment. */
export interface DiscoveryDeps {
  readonly sessionQuery: SessionQueryLike
  readonly managed: ManagedSessionIndex
  readonly titles?: TitleLookup
  /** How many titles to resolve at most, to keep one call bounded. */
  readonly titleBudget?: number
  /**
   * The Host's registry-level archive set, read when the caller can reach it (PRD §二.5).
   *
   * Optional, and read through a function rather than passed as an array: the set changes while the
   * process runs (the Host emits `host/archived-sessions-changed` when it does, and replaces the array
   * rather than mutating it), so a snapshot captured at mount would report the answer from mount time.
   * `undefined` means this composition hands discovery no way to read a set.
   */
  readonly archivedSessions?: (() => ArchiveSetRead) | undefined
}

/**
 * List candidate sessions.
 *
 * A session that cannot be read at all is skipped rather than reported as
 * absent: discovery is a convenience, and a Host whose persistence is
 * unavailable should still let the conductor manage what it can see.
 *
 * @param deps - the Host surfaces discovery reads.
 * @param filter - optional narrowing.
 * @param signal - cancellation for the host query.
 * @returns the candidates, newest first, with the archive read attached.
 */
export async function listCandidates(
  deps: DiscoveryDeps,
  filter: CandidateFilter = {},
  signal?: AbortSignal,
): Promise<CandidateList> {
  const records = await deps.sessionQuery.listSessions(signal)
  // Read once per call, and through the caller's accessor: the Host replaces the set when its membership
  // changes, so re-reading per candidate would be pointless and caching it here would be wrong.
  const archive = deps.archivedSessions?.()
  // Rows carry a boolean only for a set that was actually read; the other two states leave the field off
  // entirely, so a reader never sees a `false` this code invented.
  const published = archive?.state === 'published' ? archive.sessionIds : undefined
  const candidates: CandidateSession[] = []
  for (const record of records) {
    const sessionId = String(record.header.id)
    const taskId = deps.managed.managedBy(sessionId)
    if (taskId !== undefined && filter.includeManaged !== true) continue
    if (filter.liveOnly === true && !record.live) continue
    const directory = record.header.cwd
    if (filter.directory !== undefined
      && (directory === undefined || !directory.toLowerCase().includes(filter.directory.toLowerCase()))) {
      continue
    }
    const reach = connectionOf({ live: record.live, persisted: record.persisted })
    candidates.push({
      sessionId,
      live: record.live,
      persisted: record.persisted,
      connection: reach.connection,
      unrecoverable: reach.unrecoverable,
      connectionReason: reach.reason,
      managed: taskId !== undefined,
      ...directory === undefined ? {} : { directory },
      ...record.header.createdAt === undefined ? {} : { createdAt: new Date(record.header.createdAt).toISOString() },
      ...record.header.parentSession === undefined ? {} : { parentSessionId: String(record.header.parentSession) },
      ...record.header.origin === undefined ? {} : { origin: record.header.origin },
      ...taskId === undefined ? {} : { taskId },
      // Present only when the set could be read: "the Host does not publish an archive set" and "this session
      // is not archived in it" are different answers, and a `false` this code invented would be the second
      // masquerading as knowledge.
      ...published === undefined ? {} : { externallyArchived: published.includes(sessionId) },
    })
  }

  // Newest first, with the session id as a tiebreaker so the order is total and
  // stable. Comparing only the timestamp would return an arbitrary order for
  // sessions created in the same millisecond — and a list that reshuffles
  // between identical calls is one a caller cannot act on.
  candidates.sort((left, right) => {
    const leftAt = left.createdAt ?? ''
    const rightAt = right.createdAt ?? ''
    if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1
    return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
  })

  const narrowed = filter.query === undefined
    ? candidates
    : candidates.filter((candidate) => {
        const needle = filter.query?.toLowerCase() ?? ''
        return candidate.sessionId.toLowerCase().includes(needle)
          || (candidate.title?.toLowerCase().includes(needle) ?? false)
      })

  // Titles are resolved last and only for what is actually returned, because
  // each one is a separate read. A caller that asked for a text search may need
  // a title to match, so the budget is applied to the narrowed list.
  const budget = deps.titleBudget ?? 50
  if (deps.titles !== undefined) {
    const visible = narrowed.slice(0, budget)
    await Promise.all(visible.map(async (candidate) => {
      const title = await deps.titles?.titleOf(candidate.sessionId)
      if (title !== undefined) (candidate as { title?: string }).title = title
    }))
    return { candidates: visible, ...archive === undefined ? {} : { archive } }
  }
  return { candidates: narrowed.slice(0, budget), ...archive === undefined ? {} : { archive } }
}
