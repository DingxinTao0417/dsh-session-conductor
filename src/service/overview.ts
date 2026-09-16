import type { ConductorStore } from '../store/repository.ts'
import { OVERVIEW_ROUTE, type DelegationReceipt, type SessionOverview } from '../domain/overview.ts'
import { acceptPanelRequest, panelJson, type PanelActionServices, type PanelTaskView, type WebRoutePort } from './panelapi.ts'
import { mayRead } from './access.ts'
import { followupReturnRelation } from './followup-returns.ts'
import { completionBelongsToOperation } from './session-links.ts'
import type { SessionEventLike } from './projection.ts'

const bounded = (value: string | undefined, limit: number): string | undefined => value === undefined
  ? undefined : value.length > limit ? `${value.slice(0, limit - 14)}… [truncated]` : value
export const terminalReceipt = (receipt: { phase: string }): boolean => ['returned', 'delivery_failed'].includes(receipt.phase)

/** Authenticated local-user projection; reads neither target history nor model cursors. */
export function overviewOf(store: ConductorStore, sessionId: string, views: readonly PanelTaskView[], localHostId = 'local'): SessionOverview {
  const allowed = new Set(store.listTasks().filter(task => {
    const access = store.getAccess(task.taskId)
    return access !== undefined && mayRead(access, sessionId)
  }).map(task => task.taskId))
  const relevant = new Set<string>()
  for (const task of store.listTasks()) {
    if (allowed.has(task.taskId) && store.getAccess(task.taskId)?.ownerSessionId === sessionId) relevant.add(task.taskId)
  }
  const receipts: DelegationReceipt[] = []
  for (const operation of store.listOperations()) {
    if (operation.taskId === undefined || !allowed.has(operation.taskId) || operation.dispatchGuard?.ownerSessionId !== sessionId
      || !['create', 'fork', 'send'].includes(operation.kind)) continue
    const task = store.getTask(operation.taskId)
    if (task === undefined) continue
    relevant.add(task.taskId)
    const callback = operation.kind === 'send' ? followupReturnRelation(store, operation)?.callback : task.completionReturn
    if (callback === undefined || callback.operationId !== operation.operationId || callback.messageId !== operation.messageId) continue
    if (operation.kind !== 'send' && !completionBelongsToOperation(store, task, operation)) continue
    const binding = store.getBinding(callback.bindingId)
    if (binding?.taskId !== task.taskId || binding.version !== callback.bindingVersion) continue
    const preview = callback.phase === 'returned' ? bounded(callback.preview, 480) : undefined
    const detail = bounded(callback.detail ?? callback.reason, 240)
    receipts.push({
      operationId: operation.operationId, taskId: task.taskId, title: task.title,
      kind: operation.kind as DelegationReceipt['kind'], sessionId: binding.sessionId,
      local: ['local', localHostId].includes(binding.hostId), phase: callback.phase, delivery: operation.delivery,
      read: operation.overviewReadAt !== undefined,
      ...callback.outcome === undefined ? {} : { outcome: callback.outcome },
      ...preview === undefined ? {} : { preview }, ...detail === undefined ? {} : { detail },
      ...callback.turn === undefined ? {} : { turn: callback.turn },
      ...callback.startSeq === undefined ? {} : { startSeq: callback.startSeq },
      ...callback.messageSeq === undefined ? {} : { messageSeq: callback.messageSeq },
      ...callback.endSeq === undefined ? {} : { endSeq: callback.endSeq },
      ...callback.completedAt === undefined ? {} : { completedAt: callback.completedAt },
    })
  }
  const tasks = views.filter(task => relevant.has(task.taskId))
  const owned = new Set(store.listTasks().flatMap(task => store.listBindings(task.taskId)).filter(binding => binding.sessionId === sessionId && ['local', localHostId].includes(binding.hostId)).map(binding => binding.taskId))
  const outputs = store.listArtifacts().filter(artifact => relevant.has(artifact.taskId) || owned.has(artifact.taskId)).map(artifact => {
    const task = store.getTask(artifact.taskId)
    const binding = task?.currentBindingId === undefined ? undefined : store.getBinding(task.currentBindingId)
    const session = artifact.sessionId ?? binding?.sessionId
    return { id: artifact.artifactId, title: artifact.name, taskId: artifact.taskId, local: ['local', localHostId].includes(artifact.hostId),
      existence: artifact.existence, acceptance: artifact.acceptance,
      ...session === undefined || !['local', localHostId].includes(artifact.hostId) ? {} : { sessionId: session },
      ...artifact.path === undefined ? {} : { path: artifact.path },
      ...artifact.url === undefined ? {} : { url: artifact.url },
    }
  })
  const directories = new Map<string, { cwd: string; taskIds: string[] }>()
  for (const task of tasks) {
    if (!task.cwd || task.execution !== 'running') continue
    const normalized = task.cwd.replaceAll('\\', '/').replace(/\/+$/, '')
    const key = /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
    const group = directories.get(key) ?? { cwd: task.cwd, taskIds: [] }
    group.taskIds.push(task.taskId); directories.set(key, group)
  }
  receipts.sort((a, b) => Number(terminalReceipt(b) && !b.read) - Number(terminalReceipt(a) && !a.read)
    || (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
  return { sessionId, generatedAt: new Date().toISOString(), tasks: tasks.slice(0, 200), receipts: receipts.slice(0, 100), outputs: outputs.slice(0, 100),
    unread: receipts.filter(receipt => terminalReceipt(receipt) && !receipt.read).length,
    needsAttention: tasks.filter(task => task.pendingInteraction && task.pendingInteraction !== 'none' || ['preparation_failed', 'budget_limited', 'waiting_user'].includes(task.status)).length,
    watchingTaskIds: tasks.filter(task => {
      const watch = store.getWatch(sessionId + '::' + task.taskId)
      return watch !== undefined && watch.watchEnabled !== false
    }).map(task => task.taskId),
    sharedDirectories: [...directories.values()].filter(group => group.taskIds.length > 1),
    truncated: tasks.length > 200 || receipts.length > 100 || outputs.length > 100,
  }
}

export function registerOverviewResultRoute(web: WebRoutePort | undefined, services: PanelActionServices,
  build: (sessionId: string) => SessionOverview, readEvents: (sessionId: string) => Promise<readonly SessionEventLike[]>): (() => void) | undefined {
  return web?.register({ name: 'dsh-session-conductor.overview-result', path: OVERVIEW_ROUTE + '/result', kind: 'exact',
    async handler(request, response) {
      if (!acceptPanelRequest(request, response)) return
      try {
        const header = request.headers?.['authorization']
        const token = typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(header) ? header.slice(7) : undefined
        const caller = token === undefined ? undefined : await services.resolveCaller(token)
        if (caller?.authority !== 'local-user') { response.statusCode = 401; response.end(JSON.stringify({ error: 'UNAUTHORIZED' })); return }
        const ids = new URL(request.url ?? '/', 'http://x').searchParams.getAll('operationId')
        const receipt = ids.length === 1 ? build(caller.sessionId).receipts.find(value => value.operationId === ids[0]) : undefined
        if (!receipt?.local || receipt.phase !== 'returned' || receipt.turn === undefined || receipt.startSeq === undefined || receipt.messageSeq === undefined || receipt.endSeq === undefined) throw Error('UNAVAILABLE')
        const events = await readEvents(receipt.sessionId)
        const freshCaller = await services.resolveCaller(token!)
        const fresh = freshCaller?.sessionId === caller.sessionId ? build(caller.sessionId).receipts.find(value => value.operationId === ids[0]) : undefined
        if (!fresh || fresh.sessionId !== receipt.sessionId || fresh.turn !== receipt.turn || fresh.startSeq !== receipt.startSeq || fresh.messageSeq !== receipt.messageSeq || fresh.endSeq !== receipt.endSeq) throw Error('UNAVAILABLE')
        let text = ''
        for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
          if (event.type !== 'assistant/message' || event.seq <= Math.max(receipt.startSeq, receipt.messageSeq) || event.seq > receipt.endSeq) continue
          const data = event.data as { turn?: unknown; message?: { content?: unknown } } | undefined
          if (data?.turn !== receipt.turn || !Array.isArray(data.message?.content)) continue
          const candidate = (data.message.content as { type?: string; text?: string }[]).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
          if (candidate) text = candidate
        }
        response.statusCode = 200
        response.end(JSON.stringify({ text: text.slice(0, 24_000), truncated: text.length > 24_000, turn: receipt.turn }))
      } catch { response.statusCode = 403; response.end(JSON.stringify({ error: 'RESULT_UNAVAILABLE' })) }
    },
  })
}

export function registerOverviewRoute(web: WebRoutePort | undefined, services: PanelActionServices, store: ConductorStore,
  build: (sessionId: string) => SessionOverview): (() => void) | undefined {
  return web?.register({ name: 'dsh-session-conductor.overview', path: OVERVIEW_ROUTE, kind: 'exact',
    async handler(request, response) {
      if (!acceptPanelRequest(request, response, request.method === 'POST' ? 'POST' : 'GET')) return
      try {
        const header = request.headers?.['authorization']
        const caller = typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(header)
          ? await services.resolveCaller(header.slice(7)) : undefined
        if (caller?.authority !== 'local-user') { response.statusCode = 401; response.end(JSON.stringify({ error: 'UNAUTHORIZED' })); return }
        if (request.method === 'POST') {
          const input = await panelJson(request) as { operationIds?: unknown }
          if (input === null || typeof input !== 'object' || Object.keys(input).some(key => key !== 'operationIds')
            || !Array.isArray(input.operationIds) || input.operationIds.length > 100 || input.operationIds.some(id => typeof id !== 'string')) throw Error('BAD_REQUEST')
          const readable = new Set(build(caller.sessionId).receipts.filter(terminalReceipt).map(receipt => receipt.operationId))
          for (const id of input.operationIds as string[]) {
            if (!readable.has(id)) continue
            const operation = store.getOperation(id)
            if (operation?.taskId === undefined) continue
            await store.withExclusive(`control-commit:${operation.taskId}`, async () => {
              const freshCaller = await services.resolveCaller((header as string).slice(7))
              if (freshCaller?.authority !== 'local-user' || freshCaller.sessionId !== caller.sessionId) return
              const access = store.getAccess(operation.taskId!)
              if (access === undefined || !mayRead(access, caller.sessionId)) return
              await store.updateOperation(id, row => row.dispatchGuard?.ownerSessionId !== caller.sessionId || row.overviewReadAt !== undefined
                ? row : { ...row, overviewReadAt: new Date().toISOString() })
            })
          }
        }
        response.statusCode = 200; response.end(JSON.stringify(build(caller.sessionId)))
      } catch {
        response.statusCode = 400; response.end(JSON.stringify({ error: 'OVERVIEW_REQUEST_REFUSED' }))
      }
    },
  })
}
