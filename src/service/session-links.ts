import type { ConductorStore } from '../store/repository.ts'
import type { StoredOperationRecord, TaskRecord } from '../store/schema.ts'
import { timingSafeEqual } from 'node:crypto'
import { SESSION_LINKS_ROUTE, type SessionLink, type SessionLinks } from '../domain/session-links.ts'
import { acceptPanelRequest, type WebRoutePort } from './panelapi.ts'
import { mayRead } from './access.ts'
import { COMPLETION_RETURN_DETAIL_LIMIT, COMPLETION_RETURN_PREVIEW_LIMIT } from './completion-return.ts'

/** A 32-byte base64url bearer issued to one native creation card. */
const SESSION_LINK_CAPABILITY = /^[A-Za-z0-9_-]{43}$/
const SESSION_LINK_CAPABILITY_HEADER = 'x-dsh-conductor-link-capability'
const COMPLETION_RETURN_REASON_LIMIT = COMPLETION_RETURN_DETAIL_LIMIT
const TRUNCATION_MARKER = '… [truncated]'

/** Bound legacy/corrupt persisted text again at the HTTP projection boundary. */
function truncateLinkText(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`
}

/**
 * Compare only well-formed, fixed-size capabilities.  A bad or omitted value
 * is deliberately indistinguishable from an old operation with no capability:
 * both callers retain the pre-existing navigation projection and no return.
 */
function hasSessionLinkCapability(expected: string | undefined, supplied: string | undefined): boolean {
  if (expected === undefined || supplied === undefined
    || !SESSION_LINK_CAPABILITY.test(expected) || !SESSION_LINK_CAPABILITY.test(supplied)) return false
  return timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(supplied, 'ascii'))
}

/** Only terminal delivery records are useful as an asynchronous card return. */
function isVisibleCompletion(task: TaskRecord): boolean {
  return task.completionReturn?.phase === 'returned' || task.completionReturn?.phase === 'delivery_failed'
}

/**
 * A card capability authorizes one exact initial relay, not an arbitrary
 * completion-shaped field on the task.  This repeats the durable relation
 * checks at the HTTP projection boundary so a damaged or legacy record cannot
 * turn the capability of operation A into a reader for operation B's result.
 */
export function completionBelongsToOperation(
  store: ConductorStore,
  task: TaskRecord,
  operation: StoredOperationRecord,
): boolean {
  const completion = task.completionReturn
  if (completion === undefined
    || completion.operationId !== operation.operationId
    || operation.taskId !== task.taskId
    || operation.messageId !== completion.messageId) return false
  const params = operation.params
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return false
  const instruction = (params as { readonly instruction?: unknown }).instruction
  if (typeof instruction !== 'string' || instruction.length === 0) return false
  const guard = operation.dispatchGuard
  if (guard === undefined || guard.bindingVersion !== completion.bindingVersion
    || typeof guard.ownerSessionId !== 'string' || guard.ownerSessionId.length === 0) return false
  const binding = store.getBinding(completion.bindingId)
  return binding !== undefined && binding.taskId === task.taskId && binding.version === completion.bindingVersion
}

/**
 * A failed initial delivery is terminal information, not child output.  Keep
 * its reason useful to the card but never surface stale output-shaped fields
 * if a malformed or future record happens to contain them.
 */
function completionLinkOf(task: TaskRecord): SessionLink['completion'] | undefined {
  const completion = task.completionReturn
  if (completion === undefined) return undefined
  if (completion.phase === 'delivery_failed') {
    return {
      phase: completion.phase,
      ...completion.reason === undefined ? {} : { reason: truncateLinkText(completion.reason, COMPLETION_RETURN_REASON_LIMIT) },
    }
  }
  if (completion.phase !== 'returned') return undefined
  return {
    phase: completion.phase,
    ...completion.outcome === undefined ? {} : { outcome: completion.outcome },
    ...completion.detail === undefined ? {} : { detail: truncateLinkText(completion.detail, COMPLETION_RETURN_DETAIL_LIMIT) },
    ...completion.preview === undefined ? {} : { preview: truncateLinkText(completion.preview, COMPLETION_RETURN_PREVIEW_LIMIT) },
    ...completion.completedAt === undefined ? {} : { completedAt: completion.completedAt },
    ...completion.reason === undefined ? {} : { reason: truncateLinkText(completion.reason, COMPLETION_RETURN_REASON_LIMIT) },
  }
}

/** Creation authority stays the origin even after control changes. */
function originOf(operation: StoredOperationRecord, task: TaskRecord): string {
  if (operation.dispatchGuard !== undefined) return operation.dispatchGuard.ownerSessionId
  const params = operation.params as { controllerSessionId?: unknown } | undefined
  return typeof params?.controllerSessionId === 'string' ? params.controllerSessionId : task.controllerSessionId
}

export function sessionLinksOf(
  store: ConductorStore,
  sessionId: string,
  localHostId = 'local',
  sessionLinkCapability?: string,
): SessionLinks {
  const created: SessionLink[] = []
  let origin: SessionLink | undefined
  for (const operation of store.listOperations()) {
    if (!['create', 'fork'].includes(operation.kind) || operation.taskId === undefined) continue
    const task = store.getTask(operation.taskId)
    if (task === undefined) continue
    const originSessionId = originOf(operation, task)
    const binding = task.currentBindingId === undefined ? undefined : store.getBinding(task.currentBindingId)
    // A creation relationship survives control transfer for navigation, but it
    // does not grant the former controller a new right to read the child's
    // result. The one-shot return is omitted if that original parent no longer
    // holds read access; the card remains a navigation record only.
    const exposeCompletion = originSessionId === sessionId
      && isVisibleCompletion(task)
      && completionBelongsToOperation(store, task, operation)
      && hasSessionLinkCapability(operation.sessionLinkCapability, sessionLinkCapability)
      && (() => {
        const access = store.getAccess(task.taskId)
        return access !== undefined && mayRead(access, originSessionId)
      })()
    const completion = exposeCompletion ? completionLinkOf(task) : undefined
    const link: SessionLink = {
      taskId: task.taskId, operationId: operation.operationId, title: task.title,
      originSessionId, preparation: task.preparation,
      local: binding === undefined || binding.hostId === 'local' || binding.hostId === localHostId,
      ...binding === undefined ? {} : { targetSessionId: binding.sessionId, targetHostId: binding.hostId },
      ...task.failureReason === undefined ? {} : { failureReason: task.failureReason },
      ...completion === undefined ? {} : { completion },
    }
    if (originSessionId === sessionId) created.push(link)
    // A retired local session retains its original provenance after a handoff.
    if (origin === undefined && store.listBindings(task.taskId).some(value =>
      value.sessionId === sessionId && (value.hostId === 'local' || value.hostId === localHostId))) origin = link
  }
  return { sessionId, created, ...origin === undefined ? {} : { origin } }
}

function sessionLinkCapabilityFromRequest(request: {
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>> | undefined
}): string | undefined {
  const values = Object.entries(request.headers ?? {})
    .filter(([name]) => name.toLowerCase() === SESSION_LINK_CAPABILITY_HEADER)
    .map(([, value]) => value)
  // Node normally lowercases names, but headers are case-insensitive on the
  // wire. Multiple spellings (or an array) are ambiguous and never authorize.
  const value = values.length === 1 ? values[0] : undefined
  return typeof value === 'string' && SESSION_LINK_CAPABILITY.test(value) ? value : undefined
}

export function registerSessionLinksRoute(
  webServer: WebRoutePort | undefined,
  build: (sessionId: string, sessionLinkCapability?: string) => SessionLinks,
): (() => void) | undefined {
  if (webServer === undefined) return undefined
  return webServer.register({
    name: 'dsh-session-conductor.session-links', kind: 'exact', path: SESSION_LINKS_ROUTE,
    handler(request, response) {
      if (!acceptPanelRequest(request, response)) return
      let url: URL
      try { url = new URL(request.url ?? '/', 'http://x') } catch {
        response.statusCode = 400; response.end(JSON.stringify({ error: 'INVALID_SESSION_ID' })); return
      }
      const ids = url.searchParams.getAll('sessionId')
      if (ids.length !== 1 || !ids[0]?.trim() || ids[0].length > 256 || Array.from(ids[0]).some(character => character.charCodeAt(0) <= 31)) {
        response.statusCode = 400
        response.end(JSON.stringify({ error: 'INVALID_SESSION_ID' }))
        return
      }
      try {
        response.statusCode = 200
        response.end(JSON.stringify(build(ids[0], sessionLinkCapabilityFromRequest(request))))
      } catch {
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'SESSION_LINKS_UNAVAILABLE' }))
      }
    },
  })
}
