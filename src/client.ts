/**
 * The conductor's browser half (PRD §二.1, §二.12).
 *
 * This module is the *client* entry: it runs inside the web shell, not the Host, and it
 * is bundled separately into `lib/client.js` in the shell's own closure-factory format.
 * Because it runs in a browser it must not import anything from the Host half — the two
 * halves share no code by design, and the platform module table is the only thing they
 * have in common.
 *
 * Two properties shape what is here:
 *
 * 1. **The panel is a view, never an authority.** Everything it shows comes from a
 *    `conductorPanel` service, which the browser half *declares* and the Host-side Remote
 *    is expected to satisfy. When that service is absent the panel says so rather than
 *    rendering an empty task list, because "no tasks" and "no data source" look identical
 *    in a list and mean opposite things.
 * 2. **It registers into an additive seat.** `shell.overlay` is declared as a *list* whose
 *    entries sit beside the shipped ones, so mounting this panel cannot replace the
 *    conversation surface or the sidebar the way registering into a `single` seat would.
 *
 * ## What is and is not verified
 *
 * The shell bundle format and platform imports are checked. Real Edge covers panel
 * interactions; the repaired bundle also renders the current Desktop service's full
 * web UI. Native-window adoption after package installation is recorded separately.
 *
 * @module dsh-session-conductor/client
 */

import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import { PANEL_STATUSES, type PanelTaskStatus } from './domain/panel-status.ts'
import type { PanelTaskDetail } from './domain/panel-detail.ts'
import { describeForkOrigin } from './domain/fork-origin.ts'
import { DEFAULTS } from './domain/defaults.ts'
import { createLatestRequest, createMergedRefresh, createPollingRefresh, type RefreshClock } from './domain/refresh.ts'
import { applyPanelListResult, panelLinkNote, type PanelListView } from './domain/panel-link.ts'
import { PANEL_ACTION_NAMES, type PanelAction, type PanelActionName, type PanelActionResult,
  type PanelAuthorization, type PanelBootstrap, type PanelHistory, type PanelParameters } from './domain/panel-actions.ts'

// Re-exported, not merely used: a shell that builds its own controls beside the panel needs the same
// badge vocabulary, and the alternative is a second copy of the strings in a second place.
export { PANEL_STATUSES, type PanelTaskStatus } from './domain/panel-status.ts'

/** The slot this panel contributes to: an additive, frame-wide list. */
export const PANEL_SLOT = 'shell.overlay'

/** The Host route the panel reads. Must match `PANEL_ROUTE` in `service/panelapi.ts`. */
export const PANEL_ROUTE = '/conductor/panel'

/** The Host route one task's detail is read from. Must match `PANEL_DETAIL_ROUTE` in `service/panelapi.ts`. */
export const PANEL_DETAIL_ROUTE = '/conductor/panel/task'
export const PANEL_BOOTSTRAP_ROUTE = '/conductor/panel/bootstrap'
export const PANEL_ACTION_ROUTE = '/conductor/panel/action'

/**
 * Read the panel's data from the Host's own route.
 *
 * The transport is a same-origin fetch rather than a generated Remote, for the reason
 * recorded in `service/panelapi.ts`: the client's Remote assembly is a Host-owned package
 * that selects its methods at generation time, so a plugin cannot add itself to it. This
 * is the transport a plugin can own.
 *
 * @param fetchImpl - the fetch to use; injectable so a test needs no network.
 * @param options - an injectable clock for the merge window.
 * @returns the tasks the Host reports.
 */
export function httpPanelPort(
  fetchImpl: typeof fetch = fetch,
  options: { readonly clock?: RefreshClock } = {},
): ConductorPanelPort {
  let authorization: PanelAuthorization | undefined
  let authorizationGeneration = 0
  /** Read one JSON route, carrying the HTTP status into the failure. */
  const read = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(path, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      // The status is carried into the message: "500" and "404" mean very different
      // things here, and a panel that said only "failed" would hide which one happened.
      throw new Error(`the host answered ${String(response.status)} ${response.statusText}`)
    }
    return await response.json() as Record<string, unknown>
  }
  const post = async (path: string, value: unknown, token?: string): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json',
        ...token === undefined ? {} : { authorization: `Bearer ${token}` } },
      body: JSON.stringify(value),
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Host response ${String(response.status)}`)
    return payload
  }
  // First paint runs immediately. The Host's configured window (or the published
  // 250 ms default until the first payload arrives) then coalesces overlapping
  // refreshes into one round-trip rather than delaying the first one.
  let mergeMs: number = DEFAULTS.panelRefreshMergeMs
  const refresh = createMergedRefresh<readonly PanelTask[]>({
    mergeMs: () => mergeMs,
    ...options.clock === undefined ? {} : { clock: options.clock },
  })
  return {
    async bootstrap() {
      const payload = await read(PANEL_BOOTSTRAP_ROUTE)
      if (payload.authority !== 'local-user' || !Array.isArray(payload.controllers) || !Array.isArray(payload.actions)) {
        throw new Error('Host did not publish a valid local-user coordination capability')
      }
      return payload as unknown as PanelBootstrap
    },
    async authorize(controllerSessionId) {
      const generation = ++authorizationGeneration
      authorization = undefined
      const payload = await post(PANEL_BOOTSTRAP_ROUTE, { controllerSessionId }) as unknown as PanelAuthorization
      if (payload.authority !== 'local-user' || payload.controller?.sessionId !== controllerSessionId
        || typeof payload.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(payload.token)
        || !Number.isFinite(Date.parse(payload.expiresAt)) || !Array.isArray(payload.actions)) {
        throw new Error('Host returned invalid controller authorization')
      }
      if (generation !== authorizationGeneration) throw new Error('Controller selection was replaced')
      authorization = payload
      return payload
    },
    disconnect() { authorizationGeneration += 1; authorization = undefined },
    async action(action) {
      const current = authorization
      if (current === undefined || Date.parse(current.expiresAt) <= Date.now()) throw new Error('UNAUTHORIZED: select the controller again')
      if (!current.actions.includes(action.action)) throw new Error('UNAVAILABLE: this action is not supported by the Host')
      const result = await post(PANEL_ACTION_ROUTE, action, current.token) as unknown as PanelActionResult
      if (result.action !== action.action || result.operationId !== action.operationId
        || result.result === null || typeof result.result !== 'object' || Array.isArray(result.result)) {
        throw new Error('Host returned a mismatched action receipt; keep the operation id for reconciliation')
      }
      return result
    },
    async list() {
      return refresh.request(async () => {
        const payload = await read(PANEL_ROUTE)
        if (typeof payload.refreshMergeMs === 'number' && Number.isFinite(payload.refreshMergeMs)) {
          mergeMs = Math.max(0, payload.refreshMergeMs)
        }
        if (!Array.isArray(payload.tasks)) throw new Error('the host returned no readable task list')
        return payload.tasks as readonly PanelTask[]
      })
    },
    async detail(taskId: string) {
      // The id is a query parameter rather than a path segment because the Host's route matcher resolves
      // routes on the **pathname**; encoding it keeps an id that contains a separator from changing which
      // route is asked for.
      const payload = await read(`${PANEL_DETAIL_ROUTE}?taskId=${encodeURIComponent(taskId)}`)
      const task = payload.task as PanelTaskDetail | undefined
      if (task === undefined || task === null || task.taskId !== taskId) {
        throw new Error('the host returned a detail for a different or unreadable task')
      }
      return task
    },
  }
}

/** One task as the panel shows it (the card fields of PRD §二.1). */
export interface PanelTask {
  readonly taskId: string
  readonly title: string
  /** The logical project or workspace label, when the Host reports one. */
  readonly project?: string | undefined
  /** The directory the task actually runs in. */
  readonly cwd?: string | undefined
  /** The Host the task is bound to (PRD §二.1, §二.5). */
  readonly hostId?: string | undefined
  /**
   * The Host session carrying the task, so the panel can open it (PRD §二.1's 打开原会话).
   *
   * An identity, not content: what the panel needs to ask the shell to bring that session to the front.
   */
  readonly sessionId?: string | undefined
  /**
   * PRD §二.10.2's 任务继续于新会话 sentence, when this task has a predecessor
   * session. Identity only.
   */
  readonly continuation?: string | undefined
  /** `older → … → current` when the chain has more than one session. */
  readonly sessionChain?: string | undefined
  readonly preparation: string
  /** What is happening, in the projection's own words. */
  readonly execution: string
  /**
   * The badge the list filters and groups by (PRD §二.1).
   *
   * Derived on the Host, not here: the panel shows the same badge every reader sees, and a badge
   * computed in the browser from the prose fields could disagree with the card beside it.
   */
  readonly status: PanelTaskStatus
  /** Why the badge says that, for the badges whose name alone is not enough to act on. */
  readonly statusReason?: string | undefined
  /** The most recent turn outcome, when there has been one (PRD §二.1 最近结果). */
  readonly lastTurn?: string | undefined
  /**
   * PRD §二.1's 最近进展: the Host's own reason for that last turn, kept
   * verbatim. Separate from `lastTurn`. Absent before the first turn ends.
   */
  readonly lastTurnDetail?: string | undefined
  /** Anything waiting on a human, verbatim. */
  readonly pendingInteraction?: string | undefined
  /** The configuration the next request will use, and what the last one used. */
  readonly modelForNextRequest?: string | undefined
  readonly modelLastUsed?: string | undefined
  /**
   * Whether the Host's own registry has this task's session archived **outside** the conductor (PRD §二.5).
   *
   * Two archives exist and the panel must not let them be confused: the conductor's own archive is a plugin
   * record, while this one is the user's, in the Harness sidebar, and is one-way in this build. Absent means
   * the Host's set could not be read — the payload's `notes` say so — so the row renders nothing rather than
   * claiming the session is not archived.
   */
  readonly sessionArchivedExternally?: boolean | undefined
  /**
   * Reachability of the bound session (PRD §三.4 连接).
   *
   * Present when the task has a session. `unavailable` is 失联; `unrecoverable`
   * is 不可恢复 only when persistence was read and said the session is gone.
   */
  readonly connection?: string | undefined
  readonly unrecoverable?: boolean | undefined
  readonly connectionReason?: string | undefined
  /** How many reported facts the reader has not acknowledged. */
  readonly unread?: number | undefined
  readonly updatedAt?: string | undefined
  /** Conductor-side pin (PRD §二.5 置顶). Absent on an older payload means unpinned. */
  readonly pinned?: boolean | undefined
}

/** What the panel asks the Host half for. */
export interface ConductorPanelPort {
  /** Every task the reader can see. */
  list(): Promise<readonly PanelTask[]>
  /**
   * One task's detail (PRD §二.1's 任务详情).
   *
   * Optional, and its absence is reported rather than papered over: a shell that supplies its own port may
   * have no detail transport, and a view that fetched nothing would look exactly like a task with no
   * artifacts, no operations and no conversation.
   */
  detail?(taskId: string): Promise<PanelTaskDetail>
  bootstrap?(): Promise<PanelBootstrap>
  authorize?(controllerSessionId: string): Promise<PanelAuthorization>
  action?(action: PanelAction): Promise<PanelActionResult>
  disconnect?(): void
}

/**
 * How a group of tasks is labelled.
 *
 * `undefined` is a real key, not a missing one: "this task reports no project" is a group a reader
 * needs to see, and folding those tasks into the first project would be a claim about where they run
 * that the Host never made.
 */
export interface PanelGroup {
  readonly key: string | undefined
  readonly tasks: readonly PanelTask[]
}

/** How the list may be grouped (PRD §二.1's "分组"). */
export type PanelGroupKey = 'none' | 'status' | 'project'

/** The grouping options, in the order the control offers them. */
export const PANEL_GROUP_KEYS: readonly PanelGroupKey[] = ['none', 'status', 'project']

/**
 * How many tasks carry each badge.
 *
 * Every badge is returned, including the ones nothing carries, so the filter control is a **stable**
 * set of buttons: one that appeared and disappeared as tasks changed state would move under the
 * reader's cursor, and a zero beside a badge is information rather than noise.
 *
 * @param tasks - the tasks to count.
 * @returns the counts, in badge precedence order.
 */
export function statusCounts(tasks: readonly PanelTask[]): readonly { status: PanelTaskStatus; count: number }[] {
  return PANEL_STATUSES.map(status => ({
    status,
    count: tasks.filter(task => task.status === status).length,
  }))
}

/**
 * The tasks one badge selects.
 *
 * @param tasks - the tasks to filter.
 * @param status - the badge to keep, or `undefined` for every task.
 * @returns the matching tasks, in the order they were given.
 */
export function filterTasks(
  tasks: readonly PanelTask[],
  status: PanelTaskStatus | undefined,
): readonly PanelTask[] {
  return status === undefined ? tasks : tasks.filter(task => task.status === status)
}

/**
 * Group tasks for display.
 *
 * `status` groups in badge precedence order, because that order is the one a reader is scanning for.
 * `project` groups by name in ascending order and puts the tasks that report **no** project last,
 * under a key of `undefined`, so the unnamed group cannot be mistaken for a project called
 * something. `none` is one unnamed group, so the caller renders the list the same way either way.
 *
 * @param tasks - the tasks to group.
 * @param key - which grouping to apply.
 * @returns the groups, in display order.
 */
export function groupTasks(tasks: readonly PanelTask[], key: PanelGroupKey): readonly PanelGroup[] {
  if (key === 'none') return [{ key: undefined, tasks }]
  if (key === 'status') {
    return PANEL_STATUSES
      .map(status => ({ key: status, tasks: tasks.filter(task => task.status === status) }))
  }
  const named = new Map<string, PanelTask[]>()
  const unnamed: PanelTask[] = []
  for (const task of tasks) {
    if (task.project === undefined) {
      unnamed.push(task)
      continue
    }
    const bucket = named.get(task.project)
    if (bucket === undefined) named.set(task.project, [task])
    else bucket.push(task)
  }
  const groups: PanelGroup[] = [...named.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map(project => ({ key: project, tasks: named.get(project) ?? [] }))
  return unnamed.length === 0 ? groups : [...groups, { key: undefined, tasks: unnamed }]
}

/**
 * The shell's own session navigation (PRD §二.1's 打开原会话).
 *
 * A plugin does not own navigation, and it must not fake it: the shell does. The installed Shell exposes
 * a `sessions` service on the client context whose `open(sessionId)` brings a session to the front — the
 * same call its own conversation plugin makes ("The caller owns navigation: take the returned id to
 * `sessions.open`", and `inject: () => ({ openSession: (id) => { ctx.sessions.open(id) } })` in
 * `ui-workflow-run`). This is that service, narrowed to the one method this panel uses.
 *
 * Read through `ctx.get` rather than declared in `inject`: an unmet injection keeps an entry pending, so the
 * whole panel would vanish in a shell without session navigation instead of existing and saying what it
 * cannot do. It is read at call time, like every Host service this plugin uses.
 */
export interface SessionNavigationPort {
  /** Bring one Host session to the front. */
  open(sessionId: string): void
  openNewTab?(sessionId: string): void
}

/**
 * Read the shell's session navigation, or report that there is none.
 *
 * @param ctx - the client context.
 * @returns the navigation, or undefined when this shell has none.
 */
export function sessionNavigationOf(ctx: ClientContext): SessionNavigationPort | undefined {
  const sessions = clientService(ctx, 'sessions')
  if (sessions === undefined || typeof sessions.open !== 'function') return undefined
  return {
    // Bound rather than passed by reference: `sessions.open` is a service method, and calling it
    // detached from its service is how a method that reads `this` breaks in a browser and nowhere else.
    open: (sessionId: string) => { sessions.open?.(sessionId) },
    openNewTab: (sessionId: string) => {
      const browser = globalThis as unknown as { location?: { href: string }; open?: (url: string, target: string, features: string) => unknown }
      if (browser.location === undefined || browser.open === undefined) return
      const url = new URL(browser.location.href)
      url.searchParams.set('conductorSession', sessionId)
      browser.open(url.href, '_blank', 'noopener,noreferrer')
    },
  }
}

/** The cordis context this entry needs, declared structurally. */
interface ClientContext {
  readonly get?: (name: string) => unknown
  readonly slots?: {
    inject?: (key: string, callback: () => (() => void)) => unknown
    register?: (options: { name: string; id: string; order: number }, component: () => ReactElement) => () => void
  }
  readonly conductorPanel?: ConductorPanelPort
  /** The shell's session navigation, when this shell has one. */
  readonly sessions?: {
    open?: ((sessionId: string) => unknown) | undefined
    list?: { getSnapshot(): { current?: string | undefined; ids: readonly string[] }; subscribe?(listener: () => void): () => void } | undefined
  } | undefined
}

/** Optional services use Cordis's supported probe; property reads require inject. */
function clientService<K extends 'sessions' | 'conductorPanel'>(ctx: ClientContext, key: K): ClientContext[K] {
  return (ctx.get === undefined ? ctx[key] : ctx.get(key)) as ClientContext[K]
}

/** Cordis plugin name; must match the row the bundle patch inserts. */
export const name = 'dsh-session-conductor-client'

/**
 * Services the client entry needs before it activates.
 *
 * The slot registry is required. Optional navigation and custom panel ports are
 * read through ctx.get(), rather than undeclared context properties.
 */
export const inject: readonly string[] = ['slots']

/**
 * One task row.
 *
 * The row is a button when something can be opened from it, because §二.1's detail view is reached from
 * the list. When no detail port exists the row stays inert rather than offering a control that would
 * silently do nothing.
 *
 * @param props - the task, and the open handler when one exists.
 * @returns the rendered row.
 */
export function TaskRow({ task, onOpen, onOpenSession }: {
  readonly task: PanelTask
  readonly onOpen?: (() => void) | undefined
  readonly onOpenSession?: (() => void) | undefined
}): ReactElement {
  const waiting = task.pendingInteraction === undefined ? undefined : `waiting: ${task.pendingInteraction}`
  const parts: (ReactElement | null)[] = [
    createElement('span', { key: 'title', className: 'conductor-task-title' }, task.title),
    task.pinned === true
      ? createElement('span', { key: 'pinned', className: 'conductor-task-pinned' }, 'pinned')
      : null,
    // The badge is rendered with its key as a data attribute as well as its text, so a stylesheet or an
    // end-to-end test can select a state without matching translated wording.
    createElement('span', {
      key: 'badge',
      className: 'conductor-task-badge',
      'data-status': task.status,
      ...task.statusReason === undefined ? {} : { title: task.statusReason },
    }, task.status),
    createElement('span', {
      key: 'state',
      className: 'conductor-task-state',
    }, [task.preparation, task.execution, task.lastTurn].filter(part => part !== undefined).join(' · ')),
    // PRD §二.1: the card shows the project, the actual directory and the Host. They were declared on
    // the view and never rendered, so a reader could not tell whose work a task was or where it ran.
    task.project === undefined
      ? null
      : createElement('span', { key: 'project', className: 'conductor-task-project', title: task.project },
          `project: ${task.project}`),
    task.cwd === undefined
      ? null
      : createElement('span', { key: 'cwd', className: 'conductor-task-cwd', title: task.cwd }, `dir: ${task.cwd}`),
    task.hostId === undefined
      ? null
      : createElement('span', { key: 'host', className: 'conductor-task-host' }, `host: ${task.hostId}`),
    task.connection === undefined
      ? null
      : createElement('span', {
          key: 'connection',
          className: 'conductor-task-connection',
          'data-connection': task.connection,
          ...task.connectionReason === undefined ? {} : { title: task.connectionReason },
        }, task.unrecoverable === true ? '不可恢复' : task.connection === 'online' ? 'online' : '失联'),
    task.hostId === undefined || task.hostId === 'local' || task.connectionReason === undefined ? null
      : createElement('span', { key: 'remote-observation', className: 'conductor-task-progress' }, task.connectionReason),
    // §二.5's 外部归档, on the card as well as the detail: a reader scanning the list is exactly the person
    // who would otherwise read the conductor's own archive flag as the Host's. Only rendered when true — a
    // `false` here would be the reader's to interpret anyway, and the absence of the field means "unknown".
    task.sessionArchivedExternally === true
      ? createElement('span', {
          key: 'host-archive',
          className: 'conductor-task-host-archive',
          title: 'The Harness has this session archived. The conductor did not do that and cannot undo it.',
        }, 'archived outside this plugin')
      : null,
    waiting === undefined ? null : createElement('span', { key: 'waiting', className: 'conductor-task-waiting' }, waiting),
    // PRD §二.1: 最近进展 is a different fact from 最近结果 (`lastTurn` in the state span).
    task.lastTurnDetail === undefined
      ? null
      : createElement('span', {
          key: 'progress',
          className: 'conductor-task-progress',
          title: task.lastTurnDetail,
        }, `progress: ${task.lastTurnDetail}`),
    // §二.3 requires 最近实际使用 and 下次请求配置 to be shown separately. Collapsing them into one
    // span hid the last-used fact whenever a next-request value existed.
    task.modelLastUsed === undefined
      ? null
      : createElement('span', { key: 'last-used', className: 'conductor-task-model' },
          `last used: ${task.modelLastUsed}`),
    task.modelForNextRequest === undefined
      ? null
      : createElement('span', { key: 'next-model', className: 'conductor-task-model-next' },
          `next request: ${task.modelForNextRequest}`),
    // PRD §二.1: the card shows 更新时间. The payload already carried it for sort order and never rendered it.
    task.updatedAt === undefined
      ? null
      : createElement('span', { key: 'updated', className: 'conductor-task-updated' }, `updated ${task.updatedAt}`),
    // PRD §二.10.2: 任务继续于新会话, with the predecessor/successor chain as the tooltip.
    task.continuation === undefined
      ? null
      : createElement('span', {
          key: 'continuation',
          className: 'conductor-task-continuation',
          ...task.sessionChain === undefined ? {} : { title: task.sessionChain },
        }, task.continuation),
    task.unread === undefined || task.unread === 0
      ? null
      : createElement('span', { key: 'unread', className: 'conductor-task-unread' }, String(task.unread)),
    onOpen === undefined
      ? null
      : createElement('button', {
          key: 'open',
          type: 'button',
          className: 'conductor-task-open',
          'data-task-id': task.taskId,
          onClick: onOpen,
        }, 'details'),
    // §二.1's 打开原会话. Rendered only when the shell can actually navigate: a control that silently did
    // nothing would be worse than no control, and the panel says separately why it is absent.
    onOpenSession === undefined
      ? null
      : createElement('button', {
          key: 'open-session',
          type: 'button',
          className: 'conductor-task-open-session',
          'data-session-id': task.sessionId,
          onClick: onOpenSession,
        }, 'open session'),
  ]
  return createElement('li', { className: 'conductor-task', 'data-task-id': task.taskId },
    parts.filter(part => part !== null))
}

/**
 * One task's detail: 成果, 操作记录, 配置 and 权限 (PRD §二.1).
 *
 * The conversation is **not** here, and the component says so instead of leaving the area blank: §二.7's
 * read path owns history, and a detail view that rendered nothing for it would read as "there was no
 * conversation" — the one misreading worth designing against.
 *
 * @param props - the loaded detail.
 * @returns the rendered detail.
 */
export function TaskDetail({ detail, onOpenSession }: {
  readonly detail: PanelTaskDetail
  readonly onOpenSession?: (() => void) | undefined
}): ReactElement {
  const { configuration, access } = detail
  return createElement('section', {
    className: 'conductor-detail',
    'data-task-id': detail.taskId,
    'data-status': detail.status,
  }, [
    createElement('h3', { key: 'title', className: 'conductor-detail-title' }, detail.title),
    // §二.1's 打开原会话, from the detail view as well as from the card: the reader who has opened a task
    // is the one most likely to want to go and look at its conversation.
    onOpenSession === undefined
      ? null
      : createElement('button', {
          key: 'open-session',
          type: 'button',
          className: 'conductor-detail-open-session',
          'data-session-id': detail.sessionId,
          onClick: onOpenSession,
        }, `open session ${detail.sessionId ?? ''}`.trim()),
    createElement('p', { key: 'identity', className: 'conductor-detail-identity' },
      [
        `status: ${detail.status}`,
        `preparation: ${detail.preparation} (${detail.preparationPhase})`,
        `execution: ${detail.execution}`,
        detail.lastTurn === undefined ? undefined : `last turn: ${detail.lastTurn}`,
        detail.lastTurnDetail === undefined ? undefined : `progress: ${detail.lastTurnDetail}`,
        detail.project === undefined ? undefined : `project: ${detail.project}`,
        detail.cwd === undefined ? undefined : `dir: ${detail.cwd}`,
        detail.hostId === undefined ? undefined : `host: ${detail.hostId}`,
        detail.sessionId === undefined ? undefined : `session: ${detail.sessionId}`,
        detail.continuation === undefined ? undefined : detail.continuation,
        detail.sessionChain === undefined ? undefined : `chain: ${detail.sessionChain}`,
        detail.connection === undefined
          ? undefined
          : `connection: ${detail.unrecoverable === true ? 'unavailable (不可恢复)' : detail.connection}`
            + (detail.connectionReason === undefined ? '' : ` (${detail.connectionReason})`),
        // §二.5: the Host's own archive of this session is a different fact from the conductor's archive of
        // the task, so it is stated in words here rather than folded into the badge. Rendered only when the
        // Host's set was readable at all; the refusals below say which case applies when it was not.
        detail.sessionArchivedExternally === undefined
          ? undefined
          : `session archived outside this plugin: ${String(detail.sessionArchivedExternally)}`,
      ].filter(part => part !== undefined).join(' · ')),
    // The badge's reason is shown in full here, where there is room for it, rather than only as a tooltip.
    detail.statusReason === undefined
      ? null
      : createElement('p', { key: 'reason', className: 'conductor-detail-reason' }, detail.statusReason),
    createElement('h4', { key: 'h-artifacts', className: 'conductor-detail-heading' }, `Artifacts (${String(detail.artifacts.length)})`),
    detail.artifacts.length === 0
      ? createElement('p', { key: 'no-artifacts', className: 'conductor-detail-note' }, 'No artifact is registered for this task.')
      : createElement('ul', { key: 'artifacts', className: 'conductor-detail-artifacts' },
          detail.artifacts.map(artifact => createElement('li', {
            key: artifact.artifactId,
            className: 'conductor-detail-artifact',
            'data-artifact-id': artifact.artifactId,
            'data-acceptance': artifact.acceptance,
          }, [
            createElement('span', { key: 'name', className: 'conductor-detail-artifact-name' }, artifact.name),
            // The four facts of PRD §二.9.1, never collapsed into one status word.
            createElement('span', { key: 'state', className: 'conductor-detail-artifact-state' },
              `${artifact.kind} · ${artifact.facts} · v${String(artifact.contentVersion)}`
              + (artifact.location === undefined ? '' : ` · ${artifact.location}`)
              + (artifact.constraints === undefined ? '' : ` · ${artifact.constraints}`)),
            artifact.acceptedBy === undefined
              ? null
              : createElement('span', { key: 'accepted', className: 'conductor-detail-artifact-accepted' },
                  `accepted by ${artifact.acceptedBy}`),
          ].filter(part => part !== null)))),
    createElement('h4', { key: 'h-unread', className: 'conductor-detail-heading' },
      `Unread (${String(detail.unreadCount ?? detail.unreadItems?.length ?? 0)})`),
    (detail.unreadItems === undefined || detail.unreadItems.length === 0)
      ? createElement('p', { key: 'no-unread', className: 'conductor-detail-note' },
          'No unacknowledged report. Opening this view does not mark reports read.')
      : createElement('ul', { key: 'unread', className: 'conductor-detail-unread' },
          detail.unreadItems.map(item => createElement('li', {
            key: item.notificationId,
            className: 'conductor-detail-unread-item',
            'data-notification-id': item.notificationId,
          }, [
            createElement('span', { key: 'when', className: 'conductor-detail-unread-at' }, item.createdAt),
            createElement('span', { key: 'text', className: 'conductor-detail-unread-summary' }, item.summary),
          ]))),
    createElement('h4', { key: 'h-operations', className: 'conductor-detail-heading' }, `Operations (${String(detail.operations.length)})`),
    detail.operations.length === 0
      ? createElement('p', { key: 'no-operations', className: 'conductor-detail-note' }, 'No operation is recorded for this task.')
      : createElement('ul', { key: 'operations', className: 'conductor-detail-operations' },
          detail.operations.map(operation => createElement('li', {
            key: operation.operationId,
            className: 'conductor-detail-operation',
            'data-delivery': operation.delivery,
          }, [
            createElement('span', { key: 'id', className: 'conductor-detail-operation-id' }, operation.operationId),
            createElement('span', { key: 'state', className: 'conductor-detail-operation-state' },
              `${operation.kind} · delivery: ${operation.delivery}${operation.withdrawn ? ' · withdrawn' : ''}`),
            // PRD §四.2: a dispatch a rule caused must be traceable to the authorisation behind it.
            operation.source === undefined
              ? null
              : createElement('span', { key: 'source', className: 'conductor-detail-operation-source' },
                  `source: ${operation.source}${operation.ruleId === undefined ? '' : ` · rule ${operation.ruleId}`}${operation.grantId === undefined ? '' : ` · grant ${operation.grantId}`}`),
          ].filter(part => part !== null)))),
    createElement('h4', { key: 'h-config', className: 'conductor-detail-heading' }, 'Configuration'),
    createElement('ul', { key: 'config', className: 'conductor-detail-config' }, [
      createElement('li', { key: 'context' },
        `context asked for: ${configuration.contextMode}`
        + (configuration.contextReceived === undefined ? '' : ` · received: ${configuration.contextReceived}`)),
      configuration.start === undefined
        ? null
        : createElement('li', { key: 'start' },
            `git start: ${configuration.start.strategy} at ${configuration.start.commit}`
            + (configuration.start.created ? ' (worktree created)' : '')),
      configuration.workspaceId === undefined
        ? null
        : createElement('li', { key: 'workspace' }, `workspace: ${configuration.workspaceId}`),
      // PRD §二.3's 宿主 preset, shown as part of the configuration. It is a fact about how the session was
      // assembled, not a setting: §二.3 allows the choice only at create or fork.
      configuration.preset === undefined
        ? null
        : createElement('li', { key: 'preset' }, `host preset: ${configuration.preset}`),
      configuration.forkSourceSessionId === undefined || configuration.forkCutoffSeq === undefined
        ? null
        : createElement('li', { key: 'fork-origin' }, describeForkOrigin({
            sourceSessionId: configuration.forkSourceSessionId,
            cutoffSeq: configuration.forkCutoffSeq,
            ...configuration.forkSourceTaskId === undefined
              ? {}
              : { sourceTaskId: configuration.forkSourceTaskId },
          })),
      // §二.3's "最近实际使用", from the Host's own record. Shown with the label rather than as a bare value,
      // because §二.3 requires it to be distinguishable from the next request's configuration — which this
      // build cannot report, and the payload's refusals say so.
      configuration.modelLastUsed === undefined
        ? null
        : createElement('li', { key: 'last-used' }, `model last actually used: ${configuration.modelLastUsed}`),
      configuration.budgets.length === 0
        ? createElement('li', { key: 'no-budget' }, 'no budget governs this task')
        : createElement('li', { key: 'budgets' }, configuration.budgets.map(budget =>
            `${budget.policyKey}${budget.strict ? ' (strict)' : ''}: ${budget.limits.join(', ') || 'no limits'}`
            + ` · dispatched ${String(budget.dispatches)}, attempts ${String(budget.attempts)}, rework ${String(budget.reworkRounds)}`
            + ` · tokens ${budget.tokens} · cost ${budget.cost}`).join(' | ')),
    ].filter(part => part !== null)),
    createElement('h4', { key: 'h-access', className: 'conductor-detail-heading' }, 'Access'),
    access === undefined
      ? createElement('p', { key: 'no-access', className: 'conductor-detail-note' },
          'This task has no control record, so no session owns it and none observes it.')
      : createElement('ul', { key: 'access', className: 'conductor-detail-access' }, [
          createElement('li', { key: 'owner' }, `owner: ${access.ownerSessionId} (epoch ${String(access.ownerEpoch)})`),
          createElement('li', { key: 'observers' }, access.observerSessionIds.length === 0
            ? 'no observers'
            : `observers: ${access.observerSessionIds.join(', ')}`),
          access.detachedAt === undefined
            ? null
            : createElement('li', { key: 'detached' }, `management released at ${access.detachedAt}`),
        ].filter(part => part !== null)),
    // Not an error and not hidden: this is where the conversation is.
    createElement('ul', { key: 'refusals', className: 'conductor-detail-refusals' },
      detail.refusals.map((refusal, index) => createElement('li', { key: `r${String(index)}` }, refusal))),
  ].filter(part => part !== null))
}

/**
 * The coordination panel.
 *
 * A view over whatever `conductorPanel` answers. The states are kept apart on purpose: no data
 * source, still loading, a source that failed, no tasks at all, and no tasks **matching the current
 * filter** are five different situations, and collapsing any two of them would make the panel lie
 * about which one happened. "Nothing is being coordinated" and "nothing waiting on you" look
 * identical in a list and mean opposite things.
 *
 * The filter and the grouping are the two controls PRD §二.1 asks for. Both are applied here rather
 * than by re-asking the Host, because the panel already holds every card's badge: a filter that
 * round-tripped would show the previous answer's buttons while the new one loaded.
 *
 * @param props - the slot's props; the panel ignores them and reads its own port.
 * @returns the rendered panel.
 */
export function ConductorPanel(props: {
  readonly port?: ConductorPanelPort | undefined
  readonly navigation?: SessionNavigationPort | undefined
}): ReactElement {
  const port = props.port
  const navigation = props.navigation
  const [listView, setListView] = useState<PanelListView<PanelTask>>({ items: undefined, link: 'live' })
  const { items: tasks, error, link } = listView
  const [filter, setFilter] = useState<PanelTaskStatus | undefined>(undefined)
  const [group, setGroup] = useState<PanelGroupKey>('none')
  const [opened, setOpened] = useState<PanelTaskDetail | undefined>(undefined)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [detailRequests] = useState(createLatestRequest)
  const [collapsed, setCollapsed] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>()

  useEffect(() => {
    if (selectedTaskId === undefined || port?.detail === undefined) return
    const polling = createPollingRefresh({
      read: () => port.detail!(selectedTaskId), intervalMs: 1_000,
      accept: result => {
        if (result.ok) { setOpened(result.value); setDetailError(undefined) }
        else setDetailError(result.error instanceof Error ? result.error.message : String(result.error))
      },
    })
    void polling.refresh()
    return () => { polling.stop() }
  }, [port, selectedTaskId])

  useEffect(() => {
    setListView({ items: undefined, link: 'live' })
    setOpened(undefined)
    setDetailError(undefined)
    detailRequests.invalidate()
    if (port === undefined) return
    const polling = createPollingRefresh({
      read: () => port.list(),
      intervalMs: 500,
      accept: (result) => {
        setListView(current => applyPanelListResult(current, result.ok
          ? { ok: true, items: result.value }
          : { ok: false, error: result.error instanceof Error ? result.error.message : String(result.error) }))
      },
    })
    const load = (): void => { void polling.refresh() }
    load()
    const onOffline = (): void => {
      polling.pause()
      setListView(current => applyPanelListResult(current,
        { ok: false, error: 'the browser reported the network as offline' }))
    }
    const browser = globalThis as typeof globalThis & {
      addEventListener?(type: string, listener: () => void): void
      removeEventListener?(type: string, listener: () => void): void
    }
    if (typeof browser.addEventListener === 'function') {
      browser.addEventListener('online', load)
      browser.addEventListener('offline', onOffline)
    }
    return () => {
      polling.stop()
      detailRequests.invalidate()
      if (typeof browser.removeEventListener === 'function') {
        browser.removeEventListener('online', load)
        browser.removeEventListener('offline', onOffline)
      }
    }
  }, [port, detailRequests])

  /**
   * Open one task's detail, or report why it could not be opened.
   *
   * The failure is kept as its own state rather than surfacing through the list's error: a detail that
   * could not be read says nothing about whether the list is stale, and merging the two would make a
   * single unreadable task look like a broken panel.
   */
  const openDetail = (taskId: string): void => {
    setSelectedTaskId(taskId)
    detailRequests.invalidate()
    setOpened(undefined)
    const detail = port?.detail
    if (detail === undefined) {
      setDetailError('this shell\'s coordination source cannot read a task\'s detail, so nothing was opened')
      return
    }
    setDetailError(undefined)
    void detailRequests.run(
      () => detail.call(port, taskId),
      (loaded) => { setOpened(loaded) },
      (thrown: unknown) => {
        setOpened(undefined)
        setDetailError(thrown instanceof Error ? thrown.message : String(thrown))
      },
    )
  }

  const body = ((): ReactElement => {
    if (port === undefined) {
      return createElement('p', { className: 'conductor-panel-note' },
        'No coordination data source is registered in this shell, so the panel cannot list anything. '
        + 'This is not the same as having no tasks.')
    }
    if (error !== undefined && (tasks === undefined || link === 'unavailable')) {
      return createElement('p', { className: 'conductor-panel-error' }, `The panel could not read its data: ${error}`)
    }
    if (tasks === undefined) {
      return createElement('p', { className: 'conductor-panel-note' }, 'Loading…')
    }
    const disconnect = panelLinkNote({ items: tasks, error, link })
    if (tasks.length === 0) {
      return createElement('div', { className: 'conductor-panel-view' }, [
        disconnect === undefined
          ? null
          : createElement('p', { key: 'disconnected', className: 'conductor-panel-error' }, disconnect),
        createElement('p', { key: 'empty', className: 'conductor-panel-note' }, 'No tasks are being coordinated.'),
      ])
    }
    return createElement('div', { className: 'conductor-panel-view' }, [
      disconnect === undefined
        ? null
        : createElement('p', { key: 'disconnected', className: 'conductor-panel-error' }, disconnect),
      createElement(FilterRow, { key: 'filter', tasks, filter, onFilter: setFilter }),
      createElement(GroupRow, { key: 'group', group, onGroup: setGroup }),
      // Said once, above the list, rather than on every card: this shell has no session navigation, so the
      // 打开原会话 control §二.1 asks for cannot be offered — and a reader who looked for it and found
      // nothing would not know whether it was missing or merely absent from that task.
      navigation !== undefined || !tasks.some(task => task.sessionId !== undefined)
        ? null
        : createElement('p', { key: 'no-navigation', className: 'conductor-panel-note' },
            'This shell exposes no session navigation, so the panel cannot open a task\'s session here. '
            + 'The session ids are shown so they can be found in the Host another way.'),
      createElement('div', { key: 'groups', className: 'conductor-groups' },
        renderGroups(groupTasks(filterTasks(tasks, filter), group), filter, openDetail, navigation)),
      createElement(DetailArea, {
        key: 'detail',
        detail: opened,
        error: detailError,
        ...navigation === undefined ? {} : { navigation },
      }),
    ])
  })()

  return createElement('section', { className: 'conductor-panel', 'aria-label': 'Coordination panel' }, [
    createElement('style', { key: 'style' }, PANEL_CSS),
    createElement('button', { key: 'toggle', type: 'button', className: 'conductor-toggle', 'aria-expanded': !collapsed,
      onClick: () => { setCollapsed(value => !value) } }, collapsed ? '展开协调面板' : '收起协调面板'),
    createElement('div', { key: 'surface', hidden: collapsed, className: 'conductor-surface' }, [
    createElement('h2', { key: 'heading', className: 'conductor-panel-title' }, 'DSH Session Conductor'),
    createElement(InteractivePanel, { key: 'controls', port, detail: opened, navigation, onOpenTask: openDetail }),
    // Keyed because these are array children: React requires a key on each, and a missing
    // one is a real defect rather than a lint preference — it makes reconciliation depend
    // on position alone, which is wrong the moment the heading and body ever reorder.
    createElement('div', { key: 'body', className: 'conductor-panel-body' }, body),
    ]),
  ])
}

const PANEL_CSS = `.conductor-panel{position:fixed;right:16px;bottom:16px;z-index:40;color:#182234;font:14px/1.5 system-ui,sans-serif;pointer-events:auto}.conductor-toggle{float:right}.conductor-surface{clear:both;width:min(620px,calc(100vw - 32px));max-height:85vh;overflow:auto;background:#fff;border:1px solid #abb7c8;border-radius:12px;padding:18px;box-shadow:0 12px 50px #14223b33}.conductor-panel [hidden]{display:none}.conductor-panel button,.conductor-panel input,.conductor-panel select,.conductor-panel textarea{font:inherit;color:inherit}.conductor-panel button{border:1px solid #a7b4c8;border-radius:6px;background:#f2f6fc;padding:6px 10px;cursor:pointer;margin:3px}.conductor-panel button:disabled{opacity:.5;cursor:not-allowed}.conductor-panel button:focus-visible,.conductor-panel input:focus-visible,.conductor-panel textarea:focus-visible,.conductor-panel select:focus-visible{outline:3px solid #648eff;outline-offset:2px}.conductor-panel h2{font-size:20px}.conductor-panel h3{font-size:16px}.conductor-panel p{margin:8px 0}.conductor-field{display:flex;flex-direction:column;gap:4px;margin:10px 0}.conductor-field input,.conductor-field textarea,.conductor-field select{border:1px solid #a7b4c8;border-radius:5px;padding:7px;max-width:100%;box-sizing:border-box;background:#fff}.conductor-panel fieldset{border:0;margin:0;padding:0}.conductor-panel details{margin:12px 0;padding:10px;background:#f7f9fc;border-radius:7px}.conductor-panel summary{cursor:pointer;font-weight:600}.conductor-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:5px}.conductor-chat{border-top:2px solid #ccdbef;margin-top:16px}.conductor-target{background:#e8f0ff;padding:8px;font-weight:600;overflow-wrap:anywhere}.conductor-chat-log{max-height:330px;overflow:auto;padding:8px 8px 8px 25px;background:#f7f9fc}.conductor-chat-log li{margin-bottom:12px}.conductor-panel pre{font:12px/1.55 ui-monospace,monospace;overflow-wrap:anywhere;white-space:pre-wrap}.conductor-task{display:flex;flex-wrap:wrap;gap:6px;border:1px solid #d9e0eb;border-radius:8px;padding:10px;margin:8px 0}.conductor-task-title{font-weight:700}.conductor-task-list{list-style:none;padding:0}.conductor-task-state,.conductor-task-cwd,.conductor-task-progress{flex-basis:100%;overflow-wrap:anywhere}.conductor-task-badge{background:#e8f0ff;border-radius:4px;padding:0 5px}.conductor-panel [role=alert],.conductor-panel-error,.conductor-detail-error{color:#a12722}.conductor-detail{border-top:1px solid #d9e0eb;margin-top:15px}.conductor-detail li{overflow-wrap:anywhere}@media(max-width:700px){.conductor-panel{right:8px;bottom:8px}.conductor-surface{width:calc(100vw - 48px);max-height:80vh;padding:14px}}`

function newPanelOperation(): string { return `panel-${globalThis.crypto.randomUUID()}` }
function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value) }
function resultSummary(value: Readonly<Record<string, unknown>>): string {
  return typeof value.summary === 'string' ? value.summary : JSON.stringify(value, null, 2)
}
function field(label: string, value: string, change: (value: string) => void, multiline = false): ReactElement {
  return createElement('label', { className: 'conductor-field', key: label }, [
    createElement('span', { key: 'label' }, label),
    createElement(multiline ? 'textarea' : 'input', {
      key: 'input', 'aria-label': label, value,
      onChange: (event: unknown) => { change((event as { currentTarget: { value: string } }).currentTarget.value) },
      ...multiline ? { rows: 4 } : { type: 'text' },
    }),
  ])
}
function choice(label: string, value: string, choices: readonly string[], change: (value: string) => void): ReactElement {
  return createElement('label', { className: 'conductor-field', key: label }, [
    createElement('span', { key: 'label' }, label),
    createElement('select', { key: 'input', 'aria-label': label, value,
      onChange: (event: unknown) => { change((event as { currentTarget: { value: string } }).currentTarget.value) },
    }, choices.map(item => createElement('option', { key: item, value: item }, item || '—'))),
  ])
}
type PanelExecute = (action: PanelActionName, parameters: PanelParameters) => Promise<Readonly<Record<string, unknown>> | undefined>

/** A local user's controller selection is separate from the main conversation's input. */
function InteractivePanel(props: {
  readonly port: ConductorPanelPort | undefined
  readonly detail: PanelTaskDetail | undefined
  readonly navigation: SessionNavigationPort | undefined
  readonly onOpenTask: (taskId: string) => void
}): ReactElement {
  const { port, detail } = props
  const [catalog, setCatalog] = useState<PanelBootstrap>()
  const [controller, setController] = useState('')
  const [authorization, setAuthorization] = useState<PanelAuthorization>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<PanelActionResult>()
  const [retry, setRetry] = useState<PanelAction>()
  const [tracked, setTracked] = useState<{ operationId: string; taskId: string }>()
  const [completedRequest, setCompletedRequest] = useState<PanelAction>()
  const drafts = useRef(new Map<string, string>())
  const clearedDrafts = useRef(new Set<string>())
  const inFlight = useRef(false)
  const lifetime = useRef(0)
  useEffect(() => {
    const generation = ++lifetime.current
    setAuthorization(undefined); setCatalog(undefined); setError(undefined)
    if (port?.bootstrap !== undefined) void port.bootstrap().then(
      value => { if (lifetime.current === generation) setCatalog(value) },
      reason => { if (lifetime.current === generation) setError(messageOf(reason)) },
    )
    return () => { lifetime.current += 1; port?.disconnect?.() }
  }, [port])
  const connect = async (): Promise<void> => {
    if (port?.authorize === undefined || controller === '' || inFlight.current) return
    inFlight.current = true; setBusy(true); setAuthorization(undefined); setRetry(undefined); setReceipt(undefined); setTracked(undefined)
    const generation = lifetime.current
    try {
      const value = await port.authorize(controller)
      if (generation === lifetime.current) { setAuthorization(value); setError(undefined) }
    } catch (reason) { if (generation === lifetime.current) setError(messageOf(reason)) }
    finally { inFlight.current = false; if (generation === lifetime.current) setBusy(false) }
  }
  const perform = async (request: PanelAction): Promise<Readonly<Record<string, unknown>> | undefined> => {
    if (port?.action === undefined || authorization === undefined || inFlight.current) return undefined
    inFlight.current = true; setBusy(true); setError(undefined)
    const generation = lifetime.current
    try {
      const value = await port.action(request)
      if (generation !== lifetime.current) return undefined
      setReceipt(value); setRetry(undefined)
      if (value.action === 'send' && ['accepted', 'pending', 'consumed'].includes(String(value.result.delivery))) setCompletedRequest(request)
      if (['create', 'fork', 'handoff'].includes(value.action) && typeof value.result.operationId === 'string' && typeof value.result.taskId === 'string') {
        setTracked({ operationId: value.result.operationId, taskId: value.result.taskId })
      }
      return value.result
    } catch (reason) {
      if (generation === lifetime.current) { setError(messageOf(reason)); setRetry(request) }
      return undefined
    } finally { inFlight.current = false; if (generation === lifetime.current) setBusy(false) }
  }
  const execute: PanelExecute = (action, parameters) => perform({ action, parameters, operationId: newPanelOperation() })
  if (port?.action === undefined) return createElement('p', { className: 'conductor-panel-note' }, '此宿主未提供交互控制入口。列表仍可读取。')
  return createElement('section', { className: 'conductor-interactive', 'aria-label': 'Task controls' }, [
    createElement('p', { key: 'scope' }, '主聊天输入框始终发送到主会话；这里的操作只发送到下面明确显示的任务。关闭面板不会停止任务。'),
    catalog === undefined ? null : createElement('div', { key: 'controller', className: 'conductor-toolbar' }, [
      createElement('label', { key: 'choose' }, [
        createElement('span', { key: 'label' }, '控制会话'),
        createElement('select', { key: 'select', 'aria-label': '控制会话', value: controller, disabled: busy,
          onChange: (event: unknown) => {
            setController((event as { currentTarget: { value: string } }).currentTarget.value)
            setAuthorization(undefined); setRetry(undefined); setReceipt(undefined); setTracked(undefined); port.disconnect?.()
          },
        }, [createElement('option', { key: 'none', value: '' }, '选择此标签页使用的控制会话'),
          ...catalog.controllers.map(item => createElement('option', { key: item.sessionId, value: item.sessionId },
            `${item.title} · ${item.cwd ?? item.sessionId}`))]),
      ]),
      createElement('button', { key: 'connect', type: 'button', disabled: busy || controller === '', onClick: () => { void connect() } }, '使用此控制会话'),
      createElement('span', { key: 'authority' }, authorization === undefined ? '尚未连接控制会话' : `本机用户 · ${authorization.controller.title} · 授权至 ${authorization.expiresAt}`),
      catalog.reason === undefined ? null : createElement('p', { key: 'reason' }, catalog.reason),
    ]),
    error === undefined ? null : createElement('p', { key: 'error', role: 'alert' }, error),
    retry === undefined ? null : createElement('button', { key: 'retry', type: 'button', disabled: busy,
      onClick: () => { void perform(retry) } }, `重试同一操作 ${retry.operationId}`),
    receipt === undefined ? null : createElement('section', { key: 'receipt', role: 'status', 'aria-label': '操作回执' }, [
      createElement('strong', { key: 'id' }, `${receipt.action} · ${receipt.operationId}`),
      createElement('pre', { key: 'summary', style: { whiteSpace: 'pre-wrap' } }, resultSummary(receipt.result)),
    ]),
    tracked === undefined || authorization === undefined ? null
      : createElement(OperationProgress, { key: `operation-${tracked.operationId}`, port,
        operationId: tracked.operationId, taskId: tracked.taskId, authorization, execute, busy }),
    authorization === undefined ? null : createElement('div', { key: authorization.controller.sessionId }, [
      createElement(CreateTaskForm, { key: 'create', execute, busy, actions: authorization.actions, onOpenTask: props.onOpenTask }),
      detail === undefined ? null : createElement(TaskControls, {
        key: detail.taskId, port, authorization, detail, execute, busy, navigation: props.navigation,
        completedRequest, drafts: drafts.current, clearedDrafts: clearedDrafts.current,
      }),
      createElement(AdvancedControls, { key: 'advanced', actions: authorization.actions, execute, busy, taskId: detail?.taskId }),
    ]),
  ])
}

function OperationProgress(props: {
  readonly port: ConductorPanelPort; readonly operationId: string; readonly taskId: string; readonly authorization: PanelAuthorization
  readonly execute: PanelExecute; readonly busy: boolean
}): ReactElement {
  const [state, setState] = useState<Readonly<Record<string, unknown>>>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    const polling = createPollingRefresh({ intervalMs: 1_000,
      read: () => props.port.action!({ action: 'operation', operationId: newPanelOperation(), parameters: { action: 'status', operationId: props.operationId } }),
      accept: result => {
        if (result.ok) { setState(result.value.result); setError(undefined) }
        else setError(messageOf(result.error))
      },
    })
    void polling.refresh()
    return () => { polling.stop() }
  }, [props.port, props.operationId, props.authorization])
  return createElement('section', { 'aria-label': '准备操作进度' }, [
    createElement('p', { key: 'state', role: 'status' }, state === undefined ? '正在读取操作进度…'
      : `${props.operationId} · ${String(state.preparation ?? '—')} · ${String(state.preparationPhase ?? '—')} · delivery ${String(state.delivery ?? '—')}`),
    error === undefined ? null : createElement('p', { key: 'error', role: 'alert' }, error),
    createElement('button', { key: 'cancel', type: 'button', disabled: props.busy || state?.cancellable !== true,
      onClick: () => { void props.execute('operation', { action: 'cancel', operationId: props.operationId }) } }, '取消准备（保留已创建资源）'),
    createElement('button', { key: 'resume', type: 'button', disabled: props.busy || !['failed', 'cancelled'].includes(String(state?.preparation)),
      onClick: () => { void props.execute('operation', { action: 'resume', taskId: props.taskId }) } }, '恢复此准备操作'),
  ])
}

function CreateTaskForm(props: {
  readonly execute: PanelExecute; readonly busy: boolean; readonly actions: readonly PanelActionName[]
  readonly onOpenTask: (taskId: string) => void
}): ReactElement {
  const [title, setTitle] = useState('')
  const [instruction, setInstruction] = useState('')
  const [cwd, setCwd] = useState('')
  const [preset, setPreset] = useState('')
  const [context, setContext] = useState('brief')
  const [strategy, setStrategy] = useState('')
  const [rev, setRev] = useState('')
  const [destination, setDestination] = useState('')
  const [session, setSession] = useState('')
  const submit = async (): Promise<void> => {
    const result = await props.execute('create', {
      title, contextMode: context, ...instruction === '' ? {} : { instruction }, ...cwd === '' ? {} : { cwd },
      ...preset === '' ? {} : { preset }, ...strategy === '' ? {} : { gitStrategy: strategy },
      ...cwd === '' || ['', 'existing_directory', 'task_directory'].includes(strategy) ? {} : { repoPath: cwd },
      ...rev === '' ? {} : { gitRev: rev }, ...destination === '' ? {} : { worktreePath: destination },
    })
    if (typeof result?.taskId === 'string') { props.onOpenTask(result.taskId); setTitle(''); setInstruction('') }
  }
  return createElement('details', { className: 'conductor-create' }, [
    createElement('summary', { key: 'heading' }, '新建任务 / 加入已有会话'),
    createElement('fieldset', { key: 'form', disabled: props.busy }, [
      field('任务名称', title, setTitle), field('首次指令', instruction, setInstruction, true),
      field('工作目录 / 源仓库', cwd, setCwd), field('宿主 preset（可选）', preset, setPreset),
      choice('初始上下文', context, ['brief', 'empty'], setContext),
      choice('Git 起点', strategy, ['', 'current_head', 'default_branch', 'specific_rev', 'worktree_snapshot', 'existing_directory', 'task_directory'], setStrategy),
      field('分支 / Commit（specific_rev）', rev, setRev), field('新 worktree / 任务目录（可选）', destination, setDestination),
      createElement('button', { key: 'create', type: 'button', disabled: title.trim() === '' || !props.actions.includes('create'), onClick: () => { void submit() } }, '创建任务'),
      field('加入的 Session ID', session, setSession),
      createElement('button', { key: 'attach', type: 'button', disabled: session.trim() === '' || !props.actions.includes('attach'),
        onClick: () => { void props.execute('attach', { sessionId: session }).then(value => { if (typeof value?.taskId === 'string') props.onOpenTask(value.taskId) }) },
      }, '加入已有会话'),
      createElement('button', { key: 'discover', type: 'button', disabled: !props.actions.includes('discover'),
        onClick: () => { void props.execute('discover', {}) } }, '查找可加入会话'),
    ]),
  ])
}

function TaskControls(props: {
  readonly port: ConductorPanelPort; readonly authorization: PanelAuthorization; readonly detail: PanelTaskDetail
  readonly execute: PanelExecute; readonly busy: boolean; readonly navigation: SessionNavigationPort | undefined
  readonly completedRequest: PanelAction | undefined; readonly drafts: Map<string, string>
  readonly clearedDrafts: Set<string>
}): ReactElement {
  const { detail, authorization, port } = props
  const [snapshot, setSnapshot] = useState<PanelHistory>()
  const [history, setHistory] = useState<PanelHistory['history']>([])
  const [historyError, setHistoryError] = useState<string>()
  const draftKey = `${authorization.controller.sessionId}:${detail.taskId}`
  const [text, setTextState] = useState(() => props.drafts.get(draftKey) ?? '')
  const setText = (value: string): void => { props.drafts.set(draftKey, value); setTextState(value) }
  const [mode, setMode] = useState('steer')
  const [queue, setQueue] = useState<readonly { messageId: string; list: string; text: string }[]>()
  const [queueText, setQueueText] = useState<Record<string, string>>({})
  const [rename, setRename] = useState(detail.title)
  const [observer, setObserver] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const cursor = useRef('-1')
  const session = useRef<string>()
  useEffect(() => {
    const request = props.completedRequest
    if (request?.action === 'send' && request.parameters.taskId === detail.taskId && !props.clearedDrafts.has(request.operationId)) {
      props.clearedDrafts.add(request.operationId)
      if (request.parameters.text === props.drafts.get(draftKey)) { props.drafts.set(draftKey, ''); setTextState('') }
    }
  }, [props.completedRequest, props.drafts, props.clearedDrafts, detail.taskId, draftKey])
  useEffect(() => {
    cursor.current = '-1'; session.current = undefined
    const polling = createPollingRefresh({
      intervalMs: 1_000,
      read: async () => {
        const response = await port.action!({ action: 'read', operationId: newPanelOperation(),
          parameters: { taskId: detail.taskId, view: 'history', afterCursor: cursor.current, limit: 100 } })
        const value = response.result as unknown as PanelHistory
        if (value.taskId !== detail.taskId || !Array.isArray(value.history) || typeof value.cursor !== 'string') throw new Error('Host returned unreadable task history')
        if (value.error !== undefined) throw new Error(value.error)
        return value
      },
      accept: result => {
        if (!result.ok) { setHistoryError(messageOf(result.error)); return }
        const value = result.value
        if (session.current !== undefined && value.sessionId !== session.current) {
          session.current = value.sessionId; cursor.current = '-1'; setHistory([]); setSnapshot(undefined)
          return
        }
        session.current = value.sessionId; cursor.current = value.cursor
        setSnapshot(value); setHistoryError(undefined)
        setHistory(current => {
          const rows = new Map(current.map(row => [row.seq, row]))
          for (const row of value.history) rows.set(row.seq, row)
          return [...rows.values()].sort((a, b) => a.seq - b.seq).slice(-1_000)
        })
      },
    })
    void polling.refresh()
    return () => { polling.stop() }
  }, [port, detail.taskId, authorization])
  const pins = { expectedBindingVersion: snapshot?.bindingVersion, expectedOwnerEpoch: snapshot?.ownerEpoch }
  const owns = detail.access?.ownerSessionId === authorization.controller.sessionId && detail.access.detachedAt === undefined
  const remoteBinding = detail.hostId !== undefined && detail.hostId !== 'local'
  const ready = detail.preparation === 'ready' && snapshot?.bindingVersion !== undefined && snapshot.ownerEpoch !== undefined
    && historyError === undefined && (remoteBinding || (detail.connection !== 'unavailable' && detail.connection !== 'unrecoverable'))
  const disabled = props.busy || !owns || !ready
  const turnPins = { ...pins, expectedTurn: snapshot?.expectedTurn, expectedStartSeq: snapshot?.expectedStartSeq }
  const readQueue = async (): Promise<void> => {
    const result = await props.execute('queue', { action: 'list', taskId: detail.taskId })
    if (Array.isArray(result?.messages)) setQueue(result.messages as unknown as NonNullable<typeof queue>)
  }
  return createElement('section', { className: 'conductor-chat', 'aria-label': '任务聊天与控制', 'data-chat-task-id': detail.taskId }, [
    createElement('h3', { key: 'heading' }, `发送目标：${detail.title}`),
    createElement('p', { key: 'directory', className: 'conductor-target' }, `任务 ${detail.taskId} · 目录 ${detail.cwd ?? '尚未准备'} · ${detail.sessionId ?? '尚无会话'}`),
    createElement('div', { key: 'navigation', className: 'conductor-toolbar' }, [
      createElement('button', { key: 'open', type: 'button', disabled: props.navigation === undefined || detail.sessionId === undefined,
        onClick: () => { if (detail.sessionId !== undefined) props.navigation?.open(detail.sessionId) } }, '打开原会话'),
      createElement('button', { key: 'new-tab', type: 'button', disabled: props.navigation?.openNewTab === undefined || detail.sessionId === undefined,
        onClick: () => { if (detail.sessionId !== undefined) props.navigation?.openNewTab?.(detail.sessionId) } }, '新标签页打开'),
    ]),
    createElement('p', { key: 'phase', role: 'status' }, `环境：${detail.preparation} / ${detail.preparationPhase} · 执行：${snapshot?.execution ?? detail.execution}`),
    !owns ? createElement('p', { key: 'access-reason' }, '当前控制会话没有此任务的写入控制权。') : null,
    historyError === undefined ? null : createElement('p', { key: 'read-error', role: 'alert' }, `聊天读取失败：${historyError}`),
    detail.pendingInteraction === undefined ? null : createElement('p', { key: 'pending', role: 'status' }, `等待人工处理：${detail.pendingInteraction}。请打开原会话处理。`),
    createElement('ol', { key: 'history', role: 'log', 'aria-label': '任务聊天记录', className: 'conductor-chat-log' }, history.map(row =>
      createElement('li', { key: `${detail.sessionId ?? ''}-${String(row.seq)}` }, [
        createElement('strong', { key: 'who' }, `${row.kind} · ${row.source ?? 'host'} · #${String(row.seq)}`),
        createElement('pre', { key: 'text', style: { whiteSpace: 'pre-wrap' } }, row.text),
      ]))),
    createElement('p', { key: 'history-limit' }, `显示最近 ${String(history.length)} 条已读取记录（窗口上限 1000）；${snapshot?.truncated === true ? '还有记录，正在继续读取。' : '不包含原始 token 流。'}`),
    field(`给 ${detail.title} 的指令`, text, setText, true),
    choice('发送方式', mode, ['steer', 'queue', 'interrupt_and_send'], setMode),
    createElement('p', { key: 'send-semantics' }, 'steer：下一步边界补充；queue：单独后续轮次；interrupt_and_send：确认指定轮次停止后再发送。受理不代表消费或完成。'),
    createElement('div', { key: 'send-controls', className: 'conductor-toolbar' }, [
      createElement('button', { key: 'send', type: 'button', disabled: disabled || text.trim() === '' || !authorization.actions.includes('send')
        || (mode === 'interrupt_and_send' && snapshot?.expectedTurn === undefined),
        onClick: () => {
          const sending = text
          void props.execute('send', { taskId: detail.taskId, text: sending, mode, ...turnPins })
        },
      }, '发送到此任务'),
      createElement('button', { key: 'stop', type: 'button', disabled: disabled || snapshot?.expectedTurn === undefined || !authorization.actions.includes('stop'),
        onClick: () => { void props.execute('stop', { taskId: detail.taskId, ...turnPins }) } }, `停止观察到的轮次 ${String(snapshot?.expectedTurn ?? '—')}`),
      createElement('button', { key: 'queue', type: 'button', disabled: props.busy || !authorization.actions.includes('queue'), onClick: () => { void readQueue() } }, '查看待消费队列'),
      createElement('button', { key: 'ack', type: 'button', disabled: props.busy || !authorization.actions.includes('watch'),
        onClick: () => { void props.execute('watch', { taskId: detail.taskId, action: 'ack' }) } }, '标记报告已读'),
    ]),
    queue === undefined ? null : createElement('ul', { key: 'queue-list', 'aria-label': '待消费队列' }, queue.map(item =>
      createElement('li', { key: item.messageId }, [
        createElement('span', { key: 'id' }, `${item.list} · ${item.messageId}`),
        field(`队列消息 ${item.messageId}`, queueText[item.messageId] ?? item.text, value => { setQueueText(current => ({ ...current, [item.messageId]: value })) }, true),
        ...(['edit', 'withdraw'] as const).map(action => createElement('button', { key: action, type: 'button', disabled,
          onClick: () => { void props.execute('queue', { action, taskId: detail.taskId, messageId: item.messageId, ...pins,
            ...action === 'edit' ? { text: queueText[item.messageId] ?? item.text } : {},
          }).then(result => { if (Array.isArray(result?.messages)) setQueue(result.messages as unknown as NonNullable<typeof queue>) }) },
        }, action === 'edit' ? '保存队列修改' : '撤回此消息')),
      ]))),
    createElement('details', { key: 'management' }, [
      createElement('summary', { key: 'title' }, '配置、权限与任务管理'),
      createElement('fieldset', { key: 'fields', disabled: props.busy || !owns }, [
        field('任务新名称', rename, setRename),
        createElement('button', { key: 'rename', type: 'button', disabled: !ready, onClick: () => { void props.execute('update', { taskId: detail.taskId, title: rename, ...pins }) } }, '重命名'),
        ...[true, false].map(archived => createElement('button', { key: `archive-${String(archived)}`, type: 'button', disabled: !ready,
          onClick: () => { void props.execute('update', { taskId: detail.taskId, archived, ...pins }) } }, archived ? '归档任务' : '恢复任务')),
        createElement('button', { key: 'model-show', type: 'button', onClick: () => { void props.execute('model', { taskId: detail.taskId, action: 'show' }) } }, '读取可用模型及配置'),
        field('Provider', provider, setProvider), field('Model', model, setModel), field('Reasoning effort（可选）', effort, setEffort),
        createElement('button', { key: 'model-set', type: 'button', disabled: !ready || provider === '' || model === '',
          onClick: () => { void props.execute('model', { taskId: detail.taskId, action: 'set', provider, model,
            ...effort === '' ? {} : { reasoningEffort: effort } }) } }, '设置下次请求模型'),
        field('观察者 / 新控制者 Session ID', observer, setObserver),
        ...(['observe', 'unobserve', 'transfer', 'release'] as const).map(action => createElement('button', {
          key: action, type: 'button', disabled: !ready || (action !== 'release' && observer === ''),
          onClick: () => { void props.execute('access', { taskId: detail.taskId, action, ...pins, ...action === 'release' ? {} : { sessionId: observer } }) },
        }, { observe: '添加观察者', unobserve: '移除观察者', transfer: '转交控制权', release: '释放管理' }[action])),
        ...(['start', 'stop'] as const).map(action => createElement('button', { key: `watch-${action}`, type: 'button',
          onClick: () => { void props.execute('watch', { taskId: detail.taskId, action }) } }, action === 'start' ? '开始监控' : '停止监控')),
      ]),
    ]),
  ])
}

function AdvancedControls(props: {
  readonly actions: readonly PanelActionName[]; readonly execute: PanelExecute; readonly busy: boolean; readonly taskId: string | undefined
}): ReactElement {
  const [action, setAction] = useState<PanelActionName>('operation')
  const [parameters, setParameters] = useState('{"action":"list"}')
  const [error, setError] = useState<string>()
  const run = (): void => {
    try {
      const value: unknown = JSON.parse(parameters)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数需要 JSON 对象')
      setError(undefined); void props.execute(action, value as PanelParameters)
    } catch (reason) { setError(messageOf(reason)) }
  }
  return createElement('details', { className: 'conductor-advanced' }, [
    createElement('summary', { key: 'heading' }, '高级控制：分叉、迁移、成果、规则、计划、工作流、预算与分享'),
    createElement('p', { key: 'hint' }, `每个动作使用对应 conductor 工具的参数与权限。当前详情任务：${props.taskId ?? '未选择'}。JSON 中须明确填写目标；服务端逐次检查授权。`),
    choice('高级动作', action, PANEL_ACTION_NAMES.filter(name => props.actions.includes(name)), value => { setAction(value as PanelActionName) }),
    field('动作参数 JSON', parameters, setParameters, true),
    error === undefined ? null : createElement('p', { key: 'error', role: 'alert' }, error),
    createElement('button', { key: 'run', type: 'button', disabled: props.busy || !props.actions.includes(action), onClick: run }, '执行明确指定的动作'),
    createElement('p', { key: 'operations' }, '操作进度：operation + {"action":"status","operationId":"返回的操作 ID"}。cancel / resume 沿用该目标 ID；取消准备保留已创建资源。'),
  ])
}

/**
 * Render the groups, distinguishing "nothing matches" from "nothing at all".
 *
 * @param groups - the grouped tasks.
 * @param filter - the badge being filtered on, when there is one.
 * @param onOpen - opens one task's detail, when the shell can.
 * @returns the rendered groups.
 */
function renderGroups(
  groups: readonly PanelGroup[],
  filter: PanelTaskStatus | undefined,
  onOpen?: ((taskId: string) => void) | undefined,
  navigation?: SessionNavigationPort | undefined,
): ReactElement[] {
  const rendered: ReactElement[] = []
  let total = 0
  for (const entry of groups) {
    total += entry.tasks.length
    // An empty group is skipped: a heading with nothing under it would read as a group whose tasks
    // failed to load, and the counts on the filter row already say how many there are.
    if (entry.tasks.length === 0) continue
    rendered.push(createElement('section', { key: entry.key ?? '(ungrouped)', className: 'conductor-group' }, [
      entry.key === undefined
        ? null
        : createElement('h3', { key: 'label', className: 'conductor-group-label' }, entry.key),
      createElement('ul', { key: 'list', className: 'conductor-task-list' },
        entry.tasks.map(task => {
          // Built as a local so each handler closes over the row's **own** id, and so the session id is
          // captured already-known rather than re-narrowed inside a callback TypeScript widens again.
          const props: {
            key: string
            task: PanelTask
            onOpen?: () => void
            onOpenSession?: () => void
          } = { key: task.taskId, task }
          if (onOpen !== undefined) props.onOpen = () => { onOpen(task.taskId) }
          const sessionId = task.sessionId
          if (navigation !== undefined && sessionId !== undefined) {
            props.onOpenSession = () => { navigation.open(sessionId) }
          }
          return createElement(TaskRow, props)
        })),
    ].filter(part => part !== null)))
  }
  if (total === 0) {
    rendered.push(createElement('p', { key: '(empty)', className: 'conductor-panel-note' },
      filter === undefined
        ? 'The Host reported tasks, but none of them have a status this panel knows. '
          + 'That means the panel and the Host disagree about the status vocabulary, not that there is no work.'
        : `No task currently has the status "${filter}". This is not the same as having no tasks: `
          + 'clear the filter to see the rest.'))
  }
  return rendered
}

/**
 * The area one task's detail appears in.
 *
 * Four states, kept apart for the same reason the list keeps its own apart: nothing opened yet, a read
 * that failed, a read that named no coordination source, and a loaded detail are different situations,
 * and a blank area would read as the fourth when it is one of the first three.
 *
 * @param props - the loaded detail, or the reason there is none.
 * @returns the rendered area.
 */
function DetailArea(props: {
  readonly detail: PanelTaskDetail | undefined
  readonly error: string | undefined
  readonly navigation?: SessionNavigationPort | undefined
}): ReactElement | null {
  if (props.error !== undefined) {
    return createElement('p', { className: 'conductor-detail-error' },
      `The task's detail could not be read: ${props.error}`)
  }
  if (props.detail === undefined) return null
  const detail = props.detail
  const sessionId = detail.sessionId
  const navigation = props.navigation
  if (navigation === undefined || sessionId === undefined) return createElement(TaskDetail, { detail })
  return createElement(TaskDetail, {
    detail,
    onOpenSession: () => { navigation.open(sessionId) },
  })
}

/** The status filter: one button per badge, with its count, plus "all". */
function FilterRow(props: {
  readonly tasks: readonly PanelTask[]
  readonly filter: PanelTaskStatus | undefined
  readonly onFilter: (status: PanelTaskStatus | undefined) => void
}): ReactElement {
  const counts = statusCounts(props.tasks)
  return createElement('div', { className: 'conductor-filter', role: 'group', 'aria-label': 'Filter by status' }, [
    createElement('button', {
      key: 'all',
      type: 'button',
      className: 'conductor-filter-button',
      'data-status': 'all',
      'aria-pressed': props.filter === undefined,
      onClick: () => { props.onFilter(undefined) },
    }, `all (${String(props.tasks.length)})`),
    ...counts.map(entry => createElement('button', {
      key: entry.status,
      type: 'button',
      className: 'conductor-filter-button',
      'data-status': entry.status,
      'aria-pressed': props.filter === entry.status,
      onClick: () => { props.onFilter(props.filter === entry.status ? undefined : entry.status) },
    }, `${entry.status} (${String(entry.count)})`)),
  ])
}

/** The grouping control. */
function GroupRow(props: {
  readonly group: PanelGroupKey
  readonly onGroup: (group: PanelGroupKey) => void
}): ReactElement {
  return createElement('div', { className: 'conductor-grouping', role: 'group', 'aria-label': 'Group tasks' }, [
    createElement('span', { key: 'label', className: 'conductor-grouping-label' }, 'group by:'),
    ...PANEL_GROUP_KEYS.map(key => createElement('button', {
      key,
      type: 'button',
      className: 'conductor-grouping-button',
      'data-group': key,
      'aria-pressed': props.group === key,
      onClick: () => { props.onGroup(key) },
    }, key)),
  ])
}

/**
 * Mount the panel into the shell's additive seat.
 *
 * Registered through `slots.inject` rather than a bare `register`, because the seat is
 * declared by another plugin: injecting waits for the declaration and is cancelled if the
 * contributor unloads, where a direct registration into an undeclared slot throws.
 *
 * @param ctx - the client context.
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.slots
  if (slots?.inject === undefined) {
    // Reported rather than silently skipped: a panel that never registered and a panel
    // that registered and rendered nothing are indistinguishable from outside.
    // eslint-disable-next-line no-console
    console.warn('[dsh-session-conductor] this shell exposes no slot registry, so the panel was not mounted')
    return
  }
  slots.inject(PANEL_SLOT, () => {
    const registry = slots
    if (registry?.register === undefined) return () => {}
    const port = clientService(ctx, 'conductorPanel') ?? httpPanelPort()
    const sessions = clientService(ctx, 'sessions')
    let stopNavigation: (() => void) | undefined
    const browser = globalThis as unknown as { location?: { href: string }; history?: { replaceState(data: unknown, unused: string, url: string): void } }
    if (sessions?.list !== undefined && browser.location !== undefined) {
      const url = new URL(browser.location.href)
      const requested = url.searchParams.get('conductorSession')
      if (requested !== null) {
        const navigate = (): void => {
          if (!sessions.list?.getSnapshot().ids.includes(requested)) return
          sessions.open?.(requested)
          url.searchParams.delete('conductorSession')
          browser.history?.replaceState(null, '', url.href)
          stopNavigation?.()
        }
        stopNavigation = sessions.list.subscribe?.(navigate)
        navigate()
      }
    }
    const unregister = registry.register({
      name: PANEL_SLOT,
      id: 'dsh-session-conductor.panel',
      order: 100,
      // Optional custom ports and the HTTP port use the same authorized Host actions.
    }, () => createElement(ConductorPanel, {
      port,
      navigation: sessionNavigationOf(ctx),
    }))
    return () => { stopNavigation?.(); port.disconnect?.(); unregister() }
  })
}
