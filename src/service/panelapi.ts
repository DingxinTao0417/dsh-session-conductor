/**
 * The panel's read-only data route (PRD §二.1, §三.2).
 *
 * ## Why a route rather than a Remote
 *
 * PRD §三.2 says the front end uses "corresponding Remote methods", and that was the plan
 * until the Host's own gateway documentation settled the question the other way:
 *
 * > The Host methods visible to any Client assembly are **limited to the Remote methods
 * > selected at generation time**. … Adding a Host Remote package is an explicit choice by
 * > the **Client composition owner**.
 *
 * The client assembly is `@deepseek-ai/dsh-api-remotes`, a **Host-owned package**. A
 * third-party plugin cannot add itself to the set that assembly selects, and making it
 * happen would mean editing the installed Harness — which the working rules forbid. So a
 * Remote registered here would exist on the Host and be **unreachable from the browser**,
 * which is worse than no Remote at all because it looks like one.
 *
 * What a plugin *can* own is a route on the Host's own web server: `ctx.webServer` is "a
 * node:http server plus the webServer service (HTTP and upgrade route registries …)",
 * explicitly built for composing applications to register routes on. The panel fetches
 * this same-origin, and the transport is the plugin's own responsibility rather than
 * something it hopes a Host package will expose.
 *
 * ## What this route is and is not
 *
 * - It serves card/detail data, including progress and report summaries. These summaries
 *   can contain task text; this is not a public metadata endpoint.
 * - It is **not authenticated**. The Host's `/api` fence does not cover these separately
 *   registered routes. They therefore enforce their own loopback socket and Host fence,
 *   same-origin browser markers and GET-only access. This limits them to the local single-user
 *   deployment; it does not establish a caller's identity or authorize a remote browser.
 * - It only **reads**. Every mutation stays behind the `conductor_*` tools, where the
 *   caller identity comes from the Host's own execution context (PRD §三.2). The panel is
 *   a view; it is not given a way to change anything.
 *
 * ## The detail route, and the one thing it refuses
 *
 * §二.1's 任务详情 shows 聊天、成果、操作记录、配置与权限. Three of those four are metadata this
 * route can serve honestly. **Chat is not**: history is read through `conductor_read`, which
 * keeps a per-reader cursor, marks truncation and decides what a reader may see — and a second
 * read path here would have none of that. The detail payload therefore carries the other three
 * and a `refusals` entry naming where chat lives, so a view built on it can say so rather than
 * render an empty panel that looks like "no conversation".
 *
 * Both routes read `request.url`, which is what the Host's own route matcher uses
 * (`new URL(req.url ?? '/', 'http://x').pathname`), and both are matched on the **pathname**
 * only — so the detail route is an exact route at `/conductor/panel/task` that takes its
 * subject from `?taskId=`, rather than a path shape this plugin would have to parse.
 *
 * @module dsh-session-conductor/service/panelapi
 */

import { isIP } from 'node:net'
import { parsePanelAction, type PanelAction, type PanelActionResult, type PanelAuthorization,
  type PanelBootstrap, type PanelCaller } from '../domain/panel-actions.ts'

// The status vocabulary is shared with the browser half, so it lives in `domain/` and is re-exported
// here for the Host's own callers. Both halves filter on the same strings because there is exactly one
// definition of them (see `domain/panel-status.ts`).
export {
  PANEL_STATUSES,
  panelStatusOf,
  type PanelStatus,
  type PanelStatusFacts,
  type PanelTaskStatus,
} from '../domain/panel-status.ts'
import type { PanelTaskStatus } from '../domain/panel-status.ts'
// The detail view's shape is shared with the browser half for the same reason. It is imported for this
// module's own signatures and re-exported so a Host-side caller of this module does not have to reach
// into `domain/` for it.
import type { PanelDetailPayload, PanelTaskDetail } from '../domain/panel-detail.ts'
export type {
  PanelAccessFact,
  PanelArtifactFact,
  PanelBudgetFact,
  PanelConfiguration,
  PanelDetailPayload,
  PanelOperationFact,
  PanelTaskDetail,
} from '../domain/panel-detail.ts'

/** One task as the panel shows it. Selection metadata only. */
export interface PanelTaskView {
  readonly taskId: string
  readonly title: string
  readonly preparation: string
  readonly execution: string
  readonly lastTurn?: string | undefined
  /**
   * PRD §二.1's 最近进展: the Host's own reason for that last turn, kept
   * verbatim. Separate from `lastTurn` (最近结果). Absent before the first
   * turn ends.
   */
  readonly lastTurnDetail?: string | undefined
  readonly pendingInteraction?: string | undefined
  readonly modelForNextRequest?: string | undefined
  readonly modelLastUsed?: string | undefined
  readonly cwd?: string | undefined
  /**
   * The badge the list filters and groups by (PRD §二.1).
   *
   * Derived on the Host from the same facts the card shows, so the badge and the dimensions beside it
   * cannot disagree — a badge computed in the browser from prose could.
   */
  readonly status: PanelTaskStatus
  /** Why the badge says that, for the badges whose name is not enough to act on. */
  readonly statusReason?: string | undefined
  /**
   * The project the task's directory came from, when it came from one (PRD §二.1).
   *
   * §二.1 requires a card to show "名称、项目、实际目录及 Host". The project is the source repository
   * a task's worktree was created from — a different fact from the directory it runs in, and the one
   * that tells a reader whose work this is when several tasks share a repository.
   */
  readonly project?: string | undefined
  /** The Host the task is bound to (PRD §二.1, §二.5). */
  readonly hostId?: string | undefined
  /**
   * The Host session carrying the task, so the panel can open it (PRD §二.1's 打开原会话).
   *
   * An identity rather than content: the panel needs it to ask the shell to bring that session to the
   * front, and without it the card cannot offer the one action §二.1 requires of it.
   */
  readonly sessionId?: string | undefined
  /**
   * PRD §二.10.2's 任务继续于新会话 sentence, when this task has a predecessor
   * session. Identity only — no message content.
   */
  readonly continuation?: string | undefined
  /** `older → … → current` when the chain has more than one session. */
  readonly sessionChain?: string | undefined
  /**
   * Whether the Host's own registry has this task's session archived outside the conductor (PRD §二.5).
   *
   * Present only when the Host's set could be read; absent means "cannot tell", and the payload's `notes`
   * say which case applies to the whole list. The card shows it so a reader can distinguish the conductor's
   * own archive — which never touches the Host's one-way interface — from the user's.
   */
  readonly sessionArchivedExternally?: boolean | undefined
  /**
   * Reachability of the bound session (PRD §三.4 连接, §二.5 失联 / 不可恢复).
   *
   * Present when the task has a session to reach. `online` means the Host holds it;
   * `unavailable` is 失联, and `unrecoverable` distinguishes 不可恢复 when persistence
   * was actually read. `reconnecting` is not produced here: this Host publishes no
   * per-session reconnecting signal.
   */
  readonly connection?: string | undefined
  readonly unrecoverable?: boolean | undefined
  readonly connectionReason?: string | undefined
  readonly unread?: number | undefined
  readonly updatedAt: string
  /**
   * Conductor-side pin (PRD §二.5 置顶及排序).
   *
   * The list is pinned first, then newest. Always present on this route.
   */
  readonly pinned: boolean
}

/** What the route answers with. */
export interface PanelPayload {
  readonly generatedAt: string
  /** How many tasks this view covers, so a truncated list is visible as truncated. */
  readonly total: number
  readonly tasks: readonly PanelTaskView[]
  /**
   * Panel refresh coalescing interval (PRD §四.7), in milliseconds.
   *
   * Optional so an older payload without the field still lists; the client then
   * uses the published default rather than inventing a second number.
   */
  readonly refreshMergeMs?: number | undefined
  /** Facts the reader needs in order not to misread the list. */
  readonly notes: readonly string[]
}

/** The Host's route registry, as this plugin uses it. */
export interface WebRoutePort {
  register(route: {
    readonly name: string
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (request: {
      /** The request target, as `node:http` gives it: path **and** query string. */
      readonly url?: string | undefined
      readonly method?: string | undefined
      readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>> | undefined
      readonly socket?: { readonly remoteAddress?: string | undefined; readonly encrypted?: boolean | undefined } | undefined
      [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array | string>
    }, response: {
      statusCode: number
      setHeader(name: string, value: string): void
      end(body?: string): void
    }) => void | Promise<void>
  }): () => void
}

type PanelRequest = Parameters<Parameters<WebRoutePort['register']>[0]['handler']>[0]
type PanelResponse = Parameters<Parameters<WebRoutePort['register']>[0]['handler']>[1]

/** DNS-rebinding and cross-site fence; local access remains unauthenticated. */
export function acceptPanelRequest(request: PanelRequest, response: PanelResponse, method: 'GET' | 'POST' = 'GET'): boolean {
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('cross-origin-resource-policy', 'same-origin')
  if (request.method !== method) {
    response.statusCode = 405
    response.setHeader('allow', method)
    response.end(JSON.stringify({ error: `METHOD_NOT_ALLOWED: this panel route accepts ${method} only` }))
    return false
  }
  const loopback = (address: string): boolean => {
    const plain = address.startsWith('::ffff:') ? address.slice(7) : address
    return plain === '::1' || (isIP(plain) === 4 && plain.startsWith('127.'))
  }
  let trusted = false
  const host = request.headers?.['host']
  const origin = request.headers?.['origin']
  const site = request.headers?.['sec-fetch-site']
  if (typeof host === 'string' && !/[\s/@?#\\]/.test(host)
    && (origin === undefined || typeof origin === 'string')
    && (site === undefined || site === 'same-origin' || site === 'none')
    && loopback(request.socket?.remoteAddress ?? '')) {
    try {
      const protocol = request.socket?.encrypted === true ? 'https:' : 'http:'
      const authority = new URL(`${protocol}//${host}`)
      const hostname = authority.hostname.replace(/^\[|\]$/g, '')
      trusted = hostname.toLowerCase() === 'localhost' || loopback(hostname)
      if (origin !== undefined) {
        const initiator = new URL(origin)
        trusted = trusted && initiator.origin === authority.origin && initiator.href === `${initiator.origin}/`
      }
    } catch {
      trusted = false
    }
  }
  if (!trusted) {
    response.statusCode = 403
    response.end(JSON.stringify({ error: 'FORBIDDEN: panel routes require a loopback connection and same-origin browser access', code: 'ORIGIN_FORBIDDEN' }))
  }
  return trusted
}

/** The route the panel reads. */
export const PANEL_ROUTE = '/conductor/panel'

/** The route one task's detail is read from. Matched on the pathname, so the subject is a query parameter. */
export const PANEL_DETAIL_ROUTE = '/conductor/panel/task'

/**
 * Register the panel's read-only data route.
 *
 * @param webServer - the Host's route registry, or undefined when this composition has none.
 * @param build - produces the payload; called per request so the panel never reads a cache.
 * @returns a disposer, or undefined when there was no registry to register into.
 */
export function registerPanelRoute(
  webServer: WebRoutePort | undefined,
  build: () => PanelPayload,
): (() => void) | undefined {
  if (webServer === undefined || typeof webServer.register !== 'function') return undefined
  return webServer.register({
    name: 'dsh-session-conductor.panel',
    kind: 'exact',
    path: PANEL_ROUTE,
    handler: (request, response) => {
      if (!acceptPanelRequest(request, response)) return
      let payload: PanelPayload
      try {
        payload = build()
      } catch {
        // A failing read is reported as a failure, never as an empty list: the panel
        // distinguishes "no tasks" from "could not read", and collapsing them here would
        // throw that distinction away at the last step.
        response.statusCode = 500
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({
          error: 'PANEL_READ_FAILED: panel data is temporarily unavailable',
        }))
        return
      }
      response.statusCode = 200
      response.setHeader('content-type', 'application/json; charset=utf-8')
      // The payload is per-request state and must never be cached by a proxy or the
      // browser: a stale panel is a panel that lies about what is running.
      response.setHeader('cache-control', 'no-store')
      response.end(JSON.stringify(payload))
    },
  })
}

/**
 * Read the task a detail request names.
 *
 * The plugin parses the request target exactly the way the Host's own route matcher does —
 * `new URL(url, 'http://x')`, against a dummy base because a request target is a path, not an absolute
 * URL. Parsing it differently here would be a second, disagreeing idea of what the request was.
 *
 * A blank or absent parameter is `undefined` rather than an error: "no subject named" and "a subject
 * that does not exist" are different answers, and the route answers them with different statuses.
 *
 * @param request - the request, as `node:http` gives it.
 * @returns the task id, or undefined when the request names none.
 */
export function detailTaskIdOf(request: { readonly url?: string | undefined } | undefined): string | undefined {
  const url = request?.url
  if (typeof url !== 'string' || url.length === 0) return undefined
  let value: string | null
  try {
    value = new URL(url, 'http://x').searchParams.get('taskId')
  } catch {
    // An unparseable request target names no task. It is not guessed at.
    return undefined
  }
  return value === null || value.trim().length === 0 ? undefined : value
}

/**
 * Register the read-only route serving one task's detail (PRD §二.1).
 *
 * Three answers are kept apart, because a view built on this route has to tell them apart:
 * `400` when the request names no task, `404` when it names one that is not recorded, and `500` when
 * the read itself failed. The `404` body carries the id it was given, so a typo is visible as a typo.
 *
 * @param webServer - the Host's route registry, or undefined when this composition has none.
 * @param build - produces one task's detail; called per request, so nothing is cached.
 * @returns a disposer, or undefined when there was no registry to register into.
 */
export function registerPanelDetailRoute(
  webServer: WebRoutePort | undefined,
  build: (taskId: string) => PanelTaskDetail | undefined,
): (() => void) | undefined {
  if (webServer === undefined || typeof webServer.register !== 'function') return undefined
  return webServer.register({
    name: 'dsh-session-conductor.panel-detail',
    kind: 'exact',
    path: PANEL_DETAIL_ROUTE,
    handler: (request, response) => {
      if (!acceptPanelRequest(request, response)) return
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      const taskId = detailTaskIdOf(request)
      if (taskId === undefined) {
        response.statusCode = 400
        response.end(JSON.stringify({
          error: 'BAD_REQUEST: the task detail route needs a "taskId" query parameter naming the task to '
            + 'describe. Nothing is served without one, because an unnamed request has no subject.',
        }))
        return
      }
      let task: PanelTaskDetail | undefined
      try {
        task = build(taskId)
      } catch {
        response.statusCode = 500
        response.end(JSON.stringify({ error: 'PANEL_READ_FAILED: panel data is temporarily unavailable' }))
        return
      }
      if (task === undefined) {
        response.statusCode = 404
        response.end(JSON.stringify({
          error: `NOT_FOUND: no task "${taskId}" is recorded, so there is no detail to serve.`,
        }))
        return
      }
      response.statusCode = 200
      response.end(JSON.stringify({ generatedAt: new Date().toISOString(), task } satisfies PanelDetailPayload))
    },
  })
}

export const PANEL_BOOTSTRAP_ROUTE = '/conductor/panel/bootstrap'
export const PANEL_ACTION_ROUTE = '/conductor/panel/action'

/** Binds local UI reads to an existing Host Session; tool dispatch additionally needs a live Agent. */
export interface PanelActionServices {
  catalog(): Promise<PanelBootstrap>
  authorize(controllerSessionId: string): Promise<PanelAuthorization>
  resolveCaller(token: string): Promise<PanelCaller | undefined>
  /** Final synchronous lease check after asynchronous metadata/content reads. */
  isCallerCurrent?(token: string, caller: PanelCaller): boolean
  execute(action: PanelAction, caller: PanelCaller): Promise<Readonly<Record<string, unknown>>>
}

export async function panelJson(request: PanelRequest): Promise<unknown> {
  const contentType = request.headers?.['content-type']
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new Error('UNSUPPORTED_MEDIA_TYPE')
  }
  const length = request.headers?.['content-length']
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > 65_536)) {
    throw new Error('PAYLOAD_TOO_LARGE')
  }
  const iterator = request[Symbol.asyncIterator]?.()
  if (iterator === undefined) throw new Error('BAD_REQUEST')
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('REQUEST_TIMEOUT')) }, 5_000)
    })
    while (true) {
      const item = await Promise.race([iterator.next(), deadline])
      if (item.done === true) break
      const chunk = typeof item.value === 'string' ? Buffer.from(item.value, 'utf8') : item.value
      size += chunk.byteLength
      if (size > 65_536) throw new Error('PAYLOAD_TOO_LARGE')
      chunks.push(chunk)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The read-only fallback remains usable; interactive entry points exist only with this trusted adapter. */
export function registerPanelActionRoutes(
  webServer: WebRoutePort | undefined,
  services: PanelActionServices,
): (() => void) | undefined {
  if (webServer === undefined || typeof webServer.register !== 'function') return undefined
  const errorResponse = (response: PanelResponse, error: unknown): void => {
    const code = error instanceof Error ? error.message.split(':')[0] : ''
    const status: Readonly<Record<string, number>> = {
      BAD_REQUEST: 400, FORBIDDEN: 403, UNAUTHORIZED: 401, CONTROLLER_UNAVAILABLE: 403, AUTHORIZATION_LIMIT: 429,
      PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415, REQUEST_TIMEOUT: 408,
    }
    response.statusCode = status[code ?? ''] ?? 409
    response.end(JSON.stringify({ error: status[code ?? ''] === undefined
      ? `${typeof code === 'string' && /^[A-Z][A-Z_]{2,60}$/.test(code) ? code : 'ACTION_REFUSED'}: the shared coordination service refused this request; refresh the task and inspect its operation record`
      : `${code}: panel request refused` }))
  }
  const bootstrap = webServer.register({
    name: 'dsh-session-conductor.panel-bootstrap', kind: 'exact', path: PANEL_BOOTSTRAP_ROUTE,
    handler: async (request, response) => {
      if (!acceptPanelRequest(request, response, request.method === 'POST' ? 'POST' : 'GET')) return
      try {
        if (request.method === 'GET') {
          response.statusCode = 200
          response.end(JSON.stringify(await services.catalog()))
          return
        }
        const value = await panelJson(request)
        if (value === null || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== 1 || !('controllerSessionId' in value)
          || typeof value.controllerSessionId !== 'string' || value.controllerSessionId.length === 0
          || value.controllerSessionId.length > 256) throw new Error('BAD_REQUEST')
        const authorization = await services.authorize(value.controllerSessionId)
        response.statusCode = 200
        response.end(JSON.stringify(authorization))
      } catch (error) { errorResponse(response, error) }
    },
  })
  const action = webServer.register({
    name: 'dsh-session-conductor.panel-action', kind: 'exact', path: PANEL_ACTION_ROUTE,
    handler: async (request, response) => {
      if (!acceptPanelRequest(request, response, 'POST')) return
      try {
        const header = request.headers?.['authorization']
        if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(header)) throw new Error('UNAUTHORIZED')
        const caller = await services.resolveCaller(header.slice(7))
        if (caller === undefined || caller.authority !== 'local-user') throw new Error('UNAUTHORIZED')
        const requestAction = parsePanelAction(await panelJson(request))
        const result = await services.execute(requestAction, caller)
        response.statusCode = 200
        response.end(JSON.stringify({ action: requestAction.action, operationId: requestAction.operationId, result } satisfies PanelActionResult))
      } catch (error) { errorResponse(response, error) }
    },
  })
  return () => { action(); bootstrap() }
}
