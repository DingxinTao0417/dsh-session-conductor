import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { OVERVIEW_ROUTE, type SessionOverview } from './domain/overview.ts'
import type { PanelActionName, PanelAuthorization } from './domain/panel-actions.ts'

export interface ConversationResource { readonly id: string; readonly title: string; readonly kind: 'file' | 'link' | 'attachment'; readonly path?: string; readonly url?: string; readonly seq: number }
export function safeWebUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}

/** Address-bar input: keep the same HTTP(S) rules, and allow a missing scheme. */
export function resolveWebUrl(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return
  const direct = safeWebUrl(trimmed)
  if (direct) return direct
  if (trimmed.includes('://')) return
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[\w.-]+:\d{1,5}([/?#]|$)/i.test(trimmed)) return
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/i.test(trimmed)
  return safeWebUrl((local ? 'http://' : 'https://') + trimmed)
}

export function webPageTitle(url: string): string {
  try { return new URL(url).hostname || url } catch { return url }
}
export function conversationResources(snapshot: Pick<ConversationSnapshot, 'nodes' | 'hasMore'> | undefined) {
  const outputs = new Map<string, ConversationResource>(), sources = new Map<string, ConversationResource>()
  for (const node of snapshot?.nodes ?? []) {
    if (node.kind === 'user' || node.kind === 'steering') {
      for (const block of node.content) {
        if (block.type === 'text') {
          for (const match of block.text.matchAll(/https?:\/\/[^\s<>"\])]+/g)) {
            const url = safeWebUrl(match[0].replace(/[.,;，。；]+$/, ''))
            if (url !== undefined) sources.set(url, { id: url, title: url.replace(/^https?:\/\//, ''), kind: 'link', url, seq: node.seq })
          }
        } else if (block.type === 'image') {
          const attachment = block.attachment
          const id = attachment.attachmentId
          sources.set('attachment:' + id, { id: 'attachment:' + id, title: attachment.name ?? '会话图片 · 消息 ' + String(node.seq), kind: 'attachment', seq: node.seq })
        }
      }
    }
    if (node.kind !== 'tool-result' || node.isError) continue
    const view = node.callView
    const mutation = view?.card === 'diff' || view?.card === 'generic' && view.kind === 'edit'
    const locations = view && 'locations' in view && Array.isArray(view.locations) ? view.locations : []
    for (const location of locations) {
      if (typeof location.path !== 'string' || !location.path) continue
      const path = location.path, resource: ConversationResource = {
        id: path, title: path.split(/[\\/]/).at(-1) ?? path, path, seq: node.seq, kind: 'file',
      }
      if (mutation) outputs.set(path, resource)
    }
    const result = node.resultView
    if (result?.card === 'read') {
      const path = result.path
      sources.set(path, { id: path, title: path.split(/[\\/]/).at(-1) ?? path, kind: 'file', path, seq: node.seq })
    } else if (result?.card === 'web') {
      for (const source of result.kind === 'search' ? result.sources : [{ url: result.url, title: undefined }]) {
        const url = safeWebUrl(source.url)
        if (url !== undefined) sources.set(url, { id: url, title: source.title || url.replace(/^https?:\/\//, ''), kind: 'link', url, seq: node.seq })
      }
    }
  }
  return { outputs: [...outputs.values()], sources: [...sources.values()], partial: snapshot?.hasMore === true }
}

export interface OverviewRead { readonly sessionId: string; readonly data?: SessionOverview; readonly error?: string }
export interface OverviewPreviewRequest { readonly path: string; readonly sessionId?: string }
export interface OverviewPreview { readonly path: string; readonly text: string; readonly truncated: boolean; readonly kind: 'text' }
export interface OverviewPort {
  subscribe(sessionId: string, listener: (state: OverviewRead) => void): () => void
  action(sessionId: string, action: PanelActionName, parameters: Record<string, unknown>, operationId?: string): Promise<Record<string, unknown>>
  acknowledge(sessionId: string, operationIds: readonly string[]): Promise<void>
  result(sessionId: string, operationId: string): Promise<{ text: string; truncated: boolean; turn: number }>
  preview(sessionId: string, request: OverviewPreviewRequest): Promise<OverviewPreview>
  openTerminal(sessionId: string, size: { cols: number; rows: number }): Promise<{ id: string; cwd: string; shell: string }>
  writeTerminal(sessionId: string, id: string, data: string): Promise<void>
  closeTerminal(sessionId: string, id: string): Promise<void>
  streamTerminal(sessionId: string, id: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void>
  refresh(sessionId: string): Promise<void>
  close(): void
}
/** One lease and ephemeral UserUI credential per mounted session, never persisted. */
export function httpOverview(fetchImpl: typeof fetch = fetch): OverviewPort {
  interface Entry { sessionId: string; state: OverviewRead; listeners: Set<(value: OverviewRead) => void>; authorization?: PanelAuthorization; authorizing?: Promise<PanelAuthorization>; controller: AbortController; timer?: ReturnType<typeof setTimeout>; loading?: Promise<void>; closed: boolean }
  const entries = new Map<string, Entry>()
  const entryOf = (sessionId: string): Entry => {
    let entry = entries.get(sessionId)
    if (entry === undefined) { entry = { sessionId, state: { sessionId }, listeners: new Set(), controller: new AbortController(), closed: false }; entries.set(sessionId, entry) }
    return entry
  }
  const json = async (path: string, options: RequestInit, signal: AbortSignal): Promise<unknown> => {
    const response = await fetchImpl(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal })
    let detail: string | undefined
    let errorCode: string | undefined
    if (!response.ok) {
      try {
        const failure = await response.json() as { message?: unknown; error?: unknown; code?: unknown } | null
        if ((path === '/conductor/preview' || path.startsWith('/conductor/terminal')) && typeof failure?.message === 'string' && failure.message.trim()) detail = failure.message.slice(0, 240)
        if (typeof failure?.code === 'string') errorCode = failure.code
        else if (typeof failure?.error === 'string') errorCode = failure.error.split(':', 1)[0]
      } catch { /* A proxy may return HTML or no body; never render it as an error detail. */ }
    }
    // A structured file-not-found response proves the preview service did run.
    if (detail !== undefined) throw Error(detail)
    // Desktop can reload fresh client assets while its tray-owned Host still runs the
    // previous plugin. A missing route is a runtime mismatch, not an empty task list.
    // Keep transport same-origin; never probe other origins or retry a mutation.
    if (response.status === 404) throw Error(path === '/conductor/panel/bootstrap'
      ? '协调插件服务尚未加载（HTTP 404）。请完全退出 DSH Desktop（含托盘）后重新打开。'
      : '正在运行的 Host 尚未提供此功能（HTTP 404），可能仍是升级前版本。请完全退出 DSH Desktop（含托盘）后重新打开。')
    if (errorCode === 'CONTROLLER_INACTIVE') throw Error('当前历史会话仅支持查看；请在该会话恢复运行后再执行协调操作。')
    if (response.status === 403 && errorCode === 'CONTROLLER_UNAVAILABLE') throw Error('当前会话身份暂不可用（HTTP 403）。Host 未能确认其会话记录，请重新打开该会话后重试。')
    if (response.status === 403 && errorCode === 'ORIGIN_FORBIDDEN') throw Error('概览访问被拒绝（HTTP 403）。请从 DSH Desktop 本机窗口打开，外部来源不能访问概览接口。')
    if (response.status === 403) throw Error('概览访问被拒绝（HTTP 403），请重新打开当前会话后重试。')
    if (response.status === 429 && errorCode === 'AUTHORIZATION_LIMIT') throw Error('打开的概览身份过多，请稍后重试或重启 DSH Desktop。')
    if (!response.ok) throw Error('请求未完成（HTTP ' + String(response.status) + '）')
    return await response.json()
  }
  const authorize = async (entry: Entry): Promise<PanelAuthorization> => {
    if (entry.authorization && Date.parse(entry.authorization.expiresAt) > Date.now() + 60_000) return entry.authorization
    if (entry.authorizing) return await entry.authorizing
    entry.authorizing = (async () => {
      const value = await json('/conductor/panel/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ controllerSessionId: entry.sessionId }) }, entry.controller.signal) as PanelAuthorization
      if (value.authority !== 'local-user' || value.controller?.sessionId !== entry.sessionId || typeof value.token !== 'string') throw Error('会话身份不可用')
      entry.authorization = value
      return value
    })()
    try { return await entry.authorizing } finally { delete entry.authorizing }
  }
  const request = async (entry: Entry, path: string, body?: unknown): Promise<unknown> => {
    const authorization = await authorize(entry)
    return await json(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', authorization: 'Bearer ' + authorization.token, ...body === undefined ? {} : { 'content-type': 'application/json' } },
      ...body === undefined ? {} : { body: JSON.stringify(body) } }, entry.controller.signal)
  }
  const publish = (entry: Entry, data: unknown): void => {
    const value = data as SessionOverview
    if (value?.sessionId !== entry.sessionId || !Array.isArray(value.tasks) || !Array.isArray(value.receipts) || !Array.isArray(value.outputs)) throw Error('会话概览数据无效')
    if (entry.closed) return
    entry.state = { sessionId: entry.sessionId, data: value }
    for (const listener of entry.listeners) listener(entry.state)
  }
  const refresh = async (sessionId: string): Promise<void> => {
    const entry = entryOf(sessionId)
    if (entry.loading) return await entry.loading
    entry.loading = (async () => {
      try { publish(entry, await request(entry, OVERVIEW_ROUTE)) } catch (error) {
        delete entry.authorization
        if (!entry.closed) {
          entry.state = { sessionId, error: error instanceof Error ? error.message : '概览暂不可用' }
          for (const listener of entry.listeners) listener(entry.state)
        }
      }
    })()
    try { await entry.loading } finally { delete entry.loading }
  }
  const stop = (entry: Entry): void => { entry.closed = true; clearTimeout(entry.timer); entry.controller.abort(); entry.listeners.clear(); entries.delete(entry.sessionId) }
  return {
    subscribe(sessionId, listener) {
      const entry = entryOf(sessionId)
      entry.listeners.add(listener); listener(entry.state)
      const tick = async (): Promise<void> => {
        if (entry.closed) return
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') await refresh(sessionId)
        if (!entry.closed) entry.timer = setTimeout(() => { void tick() }, entry.state.error ? 15_000 : 5_000)
      }
      if (entry.listeners.size === 1) void tick()
      return () => { entry.listeners.delete(listener); if (entry.listeners.size === 0) stop(entry) }
    },
    async action(sessionId, action, parameters, operationId = crypto.randomUUID()) {
      const entry = entryOf(sessionId)
      // An explicit click may occur after the Host resumes a formerly cold session.
      // Obtain fresh authority before dispatch; this never retries a sent mutation.
      if (entry.authorization?.actions?.length === 0) delete entry.authorization
      const value = await request(entry, '/conductor/panel/action', { action, parameters, operationId }) as { result?: Record<string, unknown> }
      if (!value.result) throw Error('操作没有返回回执；请先核对状态')
      await refresh(sessionId)
      return value.result
    },
    async acknowledge(sessionId, operationIds) { const entry = entryOf(sessionId); publish(entry, await request(entry, OVERVIEW_ROUTE, { operationIds })) },
    async result(sessionId, operationId) { return await request(entryOf(sessionId), OVERVIEW_ROUTE + '/result?' + new URLSearchParams({ operationId })) as { text: string; truncated: boolean; turn: number } },
    async preview(sessionId, input) {
      const value = await request(entryOf(sessionId), '/conductor/preview', input) as Partial<OverviewPreview> | null
      if (value?.kind !== 'text' || typeof value.path !== 'string' || typeof value.text !== 'string' || typeof value.truncated !== 'boolean') throw Error('文件预览数据无效')
      return value as OverviewPreview
    },
    async openTerminal(sessionId, size) {
      const value = await request(entryOf(sessionId), '/conductor/terminal', { action: 'open', cols: size.cols, rows: size.rows }) as { id?: unknown; cwd?: unknown; shell?: unknown }
      if (typeof value?.id !== 'string' || typeof value.cwd !== 'string' || typeof value.shell !== 'string') throw Error('终端会话无效')
      return { id: value.id, cwd: value.cwd, shell: value.shell }
    },
    async writeTerminal(sessionId, id, data) {
      await request(entryOf(sessionId), '/conductor/terminal', { action: 'input', id, data })
    },
    async closeTerminal(sessionId, id) {
      if (!id) return
      try { await request(entryOf(sessionId), '/conductor/terminal', { action: 'close', id }) } catch { /* already closed */ }
    },
    async streamTerminal(sessionId, id, onChunk, signal) {
      const entry = entryOf(sessionId)
      const authorization = await authorize(entry)
      const response = await fetchImpl('/conductor/terminal/output?' + new URLSearchParams({ id }), {
        credentials: 'same-origin', cache: 'no-store',
        headers: { authorization: 'Bearer ' + authorization.token, accept: 'application/octet-stream' },
        signal,
      })
      if (response.status === 404) throw Error('正在运行的 Host 尚未提供此功能（HTTP 404），可能仍是升级前版本。请完全退出 DSH Desktop（含托盘）后重新打开。')
      if (!response.ok) {
        let detail = '无法连接终端（HTTP ' + String(response.status) + '）'
        try {
          const failure = await response.json() as { message?: unknown }
          if (typeof failure?.message === 'string' && failure.message.trim()) detail = failure.message.slice(0, 240)
        } catch { /* non-JSON */ }
        throw Error(detail)
      }
      const reader = response.body?.getReader()
      if (!reader) throw Error('当前窗口无法读取终端输出。')
      const decoder = new TextDecoder()
      while (true) {
        const result = await reader.read()
        if (result.done) break
        if (result.value) onChunk(decoder.decode(result.value, { stream: true }))
      }
    },
    refresh,
    close() { for (const entry of entries.values()) stop(entry) },
  }
}
