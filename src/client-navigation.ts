/** Native-chat links and the opt-in compact conversation overview. */
import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ConversationNodeDefinition, ChatConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client'
import { SESSION_LINKS_ROUTE, type SessionLink, type SessionLinks } from './domain/session-links.ts'
import { SessionOverviewCard, type OverviewProps } from './client-overview.ts'
import { httpOverview } from './overview-client-data.ts'
import { createPreviewController, WorkspacePreview } from './client-preview.ts'
import { SidebarButton } from './client-sidebar.ts'
import { createSubagentsPort, type NativeSubagentSessions } from './client-subagents-data.ts'

export const name = 'dsh-session-conductor-client'
export const inject = ['slots', 'sessions', 'conversationEvents']
export const LINK_NODE_KIND = 'conductor-created-session'
interface CreationState { readonly operationId: string; readonly title: string; readonly failed: boolean; readonly seq: number; readonly capability?: string }

function capabilityFromMeta(meta: unknown, operationId: string): string | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const container = (meta as { readonly dshSessionConductor?: unknown }).dshSessionConductor
  if (container === null || typeof container !== 'object') return undefined
  const record = container as { readonly operationId?: unknown; readonly capability?: unknown }
  if (record.operationId !== operationId || typeof record.capability !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(record.capability)) return undefined
  return record.capability
}

/** Projects existing Host events without writing custom Session events. */
export const creationLinkDefinition: ConversationNodeDefinition<CreationState> = {
  kind: LINK_NODE_KIND, target: 'chat',
  match(event) {
    if (event.type === 'tool/call' && ['conductor_create', 'conductor_fork'].includes(event.data.name)) return { id: String(event.data.callId), role: 'start' }
    if (event.type === 'tool/result') return { id: String(event.data.message.source.callId), role: 'update' }
    return null
  },
  start(_context, match) {
    if (match.event.type !== 'tool/call') throw new Error('Invalid creation anchor')
    let args: { operationId?: unknown; title?: unknown } = {}
    try { args = JSON.parse(match.event.data.arguments) as typeof args } catch { /* Invalid arguments are reported by Host. */ }
    return { operationId: typeof args?.operationId === 'string' && args.operationId ? args.operationId : String(match.event.data.callId), title: typeof args?.title === 'string' ? args.title : '新会话', failed: false, seq: match.event.seq }
  },
  update(context, match) {
    if (match.event.type !== 'tool/result') return context.state
    const capability = capabilityFromMeta(match.event.data.meta, context.state.operationId)
    return {
      ...context.state,
      seq: match.event.seq,
      failed: match.event.data.message.content[0]?.isError === true,
      ...capability === undefined ? {} : { capability },
    }
  },
  buildViewNode(context): ChatConversationViewNode | null {
    if (context.start === undefined || context.state === undefined) return null
    return { key: context.key, id: context.id, kind: LINK_NODE_KIND, target: 'chat', anchorSeq: context.state.seq + 0.01, location: context.start.location, visibility: 'visible', data: context.state }
  },
}

export interface LinkRead { readonly sessionId: string; readonly payload?: SessionLinks; readonly error?: string }
export interface SessionLinksPort { subscribe(sessionId: string, capability: string | undefined, listener: (read: LinkRead) => void): () => void; close(): void }

function parseLinks(value: unknown, sessionId: string): SessionLinks {
  const payload = value as Partial<SessionLinks> | null
  const validCompletion = (completion: SessionLink['completion']): boolean => completion === undefined || (
    completion !== null && typeof completion === 'object' && typeof completion.phase === 'string'
      && (completion.outcome === undefined || typeof completion.outcome === 'string')
      && (completion.detail === undefined || typeof completion.detail === 'string')
      && (completion.preview === undefined || typeof completion.preview === 'string')
      && (completion.completedAt === undefined || typeof completion.completedAt === 'string')
      && (completion.reason === undefined || typeof completion.reason === 'string')
  )
  const valid = (link: SessionLink): boolean => link !== null && typeof link === 'object' && typeof link.taskId === 'string' && typeof link.operationId === 'string' && typeof link.title === 'string' && typeof link.originSessionId === 'string' && typeof link.local === 'boolean' && typeof link.preparation === 'string' && (link.targetSessionId === undefined || typeof link.targetSessionId === 'string') && validCompletion(link.completion)
  if (payload?.sessionId !== sessionId || !Array.isArray(payload.created) || !payload.created.every(valid) || (payload.origin !== undefined && !valid(payload.origin))) throw new Error('会话跳转记录无效')
  return payload as SessionLinks
}

/** One shared polling lease per visible session; closing all its views aborts reads. */
export function httpSessionLinks(fetchImpl: typeof fetch = fetch): SessionLinksPort {
  type Entry = { listeners: Set<(read: LinkRead) => void>; read: LinkRead; timer?: ReturnType<typeof setInterval>; controller?: AbortController; stopped: boolean }
  const entries = new Map<string, Entry>()
  const stop = (entry: Entry): void => { entry.stopped = true; clearInterval(entry.timer); entry.controller?.abort(); entry.listeners.clear() }
  const refresh = async (sessionId: string, capability: string | undefined, entry: Entry): Promise<void> => {
    if (entry.controller !== undefined || entry.stopped) return
    const controller = new AbortController()
    entry.controller = controller
    try {
      const response = await fetchImpl(`${SESSION_LINKS_ROUTE}?${new URLSearchParams({ sessionId }).toString()}`, {
        credentials: 'same-origin', cache: 'no-store',
        headers: { accept: 'application/json', ...capability === undefined ? {} : { 'x-dsh-conductor-link-capability': capability } },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`无法读取会话跳转（HTTP ${String(response.status)}）`)
      const payload = parseLinks(await response.json(), sessionId)
      if (!entry.stopped) entry.read = { sessionId, payload }
    } catch (error) {
      if (!entry.stopped) entry.read = { sessionId, error: error instanceof Error ? error.message : '会话跳转暂不可用' }
    } finally {
      delete entry.controller
      if (!entry.stopped) for (const listener of entry.listeners) listener(entry.read)
    }
  }
  return {
    subscribe(sessionId, capability, listener) {
      const key = `${sessionId}\u0000${capability ?? ''}`
      let entry = entries.get(key)
      if (entry === undefined) {
        entry = { listeners: new Set(), read: { sessionId }, stopped: false }
        entries.set(key, entry)
        const active = entry
        entry.timer = setInterval(() => { void refresh(sessionId, capability, active) }, 1000)
      }
      const active = entry
      active.listeners.add(listener); listener(active.read); void refresh(sessionId, capability, active)
      return () => { active.listeners.delete(listener); if (active.listeners.size === 0) { stop(active); if (entries.get(key) === active) entries.delete(key) } }
    },
    close() { for (const entry of entries.values()) stop(entry); entries.clear() },
  }
}

function useLinks(port: SessionLinksPort, sessionId: string, capability?: string): LinkRead {
  const [read, setRead] = useState<LinkRead>({ sessionId })
  useEffect(() => port.subscribe(sessionId, capability, setRead), [port, sessionId, capability])
  return read.sessionId === sessionId ? read : { sessionId }
}
export interface NavigationSessions { open(sessionId: string): unknown; readonly list: { getSnapshot(): { ids: readonly string[]; byId?: Readonly<Record<string, { displayTitle?: string; title?: string; cwd?: string }>> } } }
export interface LinkProps { readonly sessionId: string; readonly port: SessionLinksPort; readonly sessions: NavigationSessions }
const CSS = `.conductor-session-card{display:flex;align-items:center;gap:12px;border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:12px;padding:13px 14px;margin:10px 0;width:100%;box-sizing:border-box;font:inherit;color:inherit;background:transparent}.conductor-session-copy{flex:1;min-width:0}.conductor-session-label{font-weight:600}.conductor-session-title{font-size:12px;opacity:.65;overflow-wrap:anywhere;margin-top:2px}.conductor-session-return{font-size:12px;line-height:1.45;margin-top:5px;overflow-wrap:anywhere}.conductor-session-preview{font-size:12px;line-height:1.45;opacity:.76;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.conductor-session-icon{width:22px;height:22px;flex-shrink:0;opacity:.7}.conductor-session-card button,.conductor-session-origin button{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:9px;padding:5px 10px;cursor:pointer;white-space:nowrap}.conductor-session-card button:disabled,.conductor-session-origin button:disabled{opacity:.45;cursor:default}.conductor-session-card button:focus-visible,.conductor-session-origin button:focus-visible{outline:2px solid #648eff;outline-offset:3px}.conductor-session-origin{display:inline-flex;flex-wrap:nowrap;align-items:center;gap:7px;min-width:0;max-width:min(100%,28rem);overflow:hidden;font-size:12px;line-height:1.5;color:inherit}.conductor-session-origin>span{opacity:.65;white-space:nowrap}.conductor-session-origin-title{min-width:0;overflow:hidden;text-overflow:ellipsis}.conductor-session-origin[data-conductor-origin-compact] .conductor-session-origin-title{display:none}.conductor-session-origin[data-conductor-origin-clip]{display:none!important}.conductor-session-origin button{border:0;padding:2px;text-decoration:underline;text-underline-offset:3px;flex-shrink:0}.conductor-session-error{font-size:12px;opacity:.65}@media(max-width:480px){.conductor-session-card{gap:8px;padding:11px}.conductor-session-card button{padding:5px 7px}}`

export interface OriginBox { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
const boxesIntersect = (a: OriginBox, b: OriginBox): boolean => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 4 && a.bottom > b.top + 4

/**
 * Boxes of the header row's other visible items, walking sibling subtrees up to
 * the header. When the host row runs out of room its groups overlap instead of
 * shrinking, so any intersection with our control means it no longer fits.
 */
export function headerObstacles(element: Element, boundary: Element | null): OriginBox[] {
  const boxes: OriginBox[] = []
  const stop = boundary ?? element.parentElement
  let node: Element = element
  while (node !== stop && node.parentElement) {
    const parent: Element = node.parentElement
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue
      const rect = sibling.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) boxes.push(rect)
    }
    node = parent
  }
  return boxes
}

/** Hide the long origin title first, then the whole control, when the header cannot fit it. */
export function fitSessionOrigin(element: HTMLElement, area?: Pick<DOMRectReadOnly, 'left' | 'right'> | null, viewportWidth = Number.POSITIVE_INFINITY, obstacles: () => Iterable<OriginBox> = () => []): 'full' | 'compact' | 'hidden' {
  element.removeAttribute('data-conductor-origin-compact')
  element.removeAttribute('data-conductor-origin-clip')
  const overflowed = (): boolean => element.scrollWidth > element.clientWidth + 1
    || Array.from(element.children).some(child => child.scrollWidth > child.clientWidth + 1)
  const misplaced = (): boolean => {
    const bounds = element.getBoundingClientRect()
    if (area && (bounds.right > Math.min(area.right, viewportWidth) + 1 || bounds.left < Math.max(0, area.left) - 1)) return true
    for (const box of obstacles()) if (boxesIntersect(bounds, box)) return true
    return false
  }
  if (!overflowed() && !misplaced()) return 'full'
  element.setAttribute('data-conductor-origin-compact', '')
  if (!overflowed() && !misplaced()) return 'compact'
  element.setAttribute('data-conductor-origin-clip', '')
  return 'hidden'
}
function available(sessions: NavigationSessions, sessionId: string | undefined): boolean { return sessionId !== undefined && sessions.list.getSnapshot().ids.includes(sessionId) }

function completionLabel(link: SessionLink | undefined): string | undefined {
  const completion = link?.completion
  if (completion === undefined) return undefined
  if (completion.phase === 'returned') {
    if (completion.outcome === 'completed') return '子会话已完成本次委派并回传结果'
    if (completion.outcome === 'blocked') return '子会话本次委派已结束，需要处理'
    if (completion.outcome === 'interrupted') return '子会话本次委派已中断'
    return '子会话本次委派未能完成'
  }
  if (completion.phase === 'running') return '子会话正在执行本次委派'
  if (completion.phase === 'delivery_unknown') return '子会话初始指令送达待确认'
  if (completion.phase === 'delivery_failed') return '子会话初始指令未送达'
  return '等待子会话开始本次委派'
}

function completionNote(link: SessionLink | undefined): string | undefined {
  const completion = link?.completion
  if (completion === undefined) return undefined
  if (completion.phase === 'returned') return completion.detail ?? (completion.completedAt === undefined ? undefined : `已于 ${completion.completedAt} 回传`)
  return completion.reason
}

export function CreatedSessionCard(props: LinkProps & { readonly node: { data: CreationState } }): ReactElement {
  const read = useLinks(props.port, props.sessionId, props.node.data.capability)
  const state = props.node.data
  const link = read.payload?.created.find(value => value.operationId === state.operationId)
  const failed = state.failed || link?.preparation === 'failed' || link?.preparation === 'cancelled'
  const ready = !failed && read.error === undefined && link?.preparation === 'ready' && link.local && available(props.sessions, link.targetSessionId)
  const returned = completionLabel(link)
  const label = read.error !== undefined ? '会话跳转暂不可用' : failed ? '会话创建未完成' : returned ?? (link?.preparation === 'ready' ? '已创建会话' : '正在创建会话')
  const note = read.error ?? link?.failureReason ?? (link !== undefined && !link.local ? '此会话位于其他 Host' : undefined)
  const completionNoteText = completionNote(link)
  const preview = link?.completion?.phase === 'returned' ? link.completion.preview : undefined
  const [openError, setOpenError] = useState<string>()
  return createElement('section', { className: 'conductor-session-card', 'aria-label': label, 'data-conductor-operation': state.operationId }, [
    createElement('style', { key: 'style' }, CSS),
    createElement('svg', { key: 'icon', className: 'conductor-session-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true }, createElement('path', { d: 'M14 4H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-8M11 13l1-4 7-7 3 3-7 7-4 1Z' })),
    createElement('div', { key: 'copy', className: 'conductor-session-copy' }, [
      createElement('div', { key: 'label', className: 'conductor-session-label', 'aria-live': 'polite' }, label),
      createElement('div', { key: 'title', className: 'conductor-session-title' }, link?.title ?? state.title),
      completionNoteText === undefined ? null : createElement('div', { key: 'return', className: 'conductor-session-return', role: 'status' }, completionNoteText),
      preview === undefined || preview.length === 0 ? null : createElement('div', { key: 'preview', className: 'conductor-session-preview', title: preview }, preview),
      note === undefined && openError === undefined ? null : createElement('div', { key: 'error', role: 'status', className: 'conductor-session-error' }, note ?? openError),
    ]),
    createElement('button', { key: 'open', type: 'button', disabled: !ready, onClick: () => {
      const target = link?.targetSessionId
      if (!ready || !available(props.sessions, target) || target === undefined) return
      void Promise.resolve().then(() => props.sessions.open(target)).catch(error => { setOpenError(error instanceof Error ? error.message : '无法打开会话') })
    } }, '打开会话'),
  ])
}

export function SessionOrigin(props: LinkProps): ReactElement | null {
  const read = useLinks(props.port, props.sessionId)
  const origin = read.payload?.origin
  const [openError, setOpenError] = useState<string>()
  const root = useRef<HTMLDivElement>(null)
  const enabled = origin !== undefined && available(props.sessions, origin.originSessionId)
  const row = origin === undefined ? undefined : props.sessions.list.getSnapshot().byId?.[origin.originSessionId]
  const title = row?.displayTitle ?? row?.title
  useEffect(() => {
    const element = root.current
    if (!element) return
    const update = (): void => {
      // The header is inside the owner's content box, so its rect already excludes
      // the area covered by an open workspace pane; the owner rect does not.
      const header = element.closest('header')
      const owner = element.closest<HTMLElement>('[data-conductor-overview-layout]')
      const area = (header ?? owner)?.getBoundingClientRect() ?? null
      fitSessionOrigin(element, area, window.innerWidth, () => headerObstacles(element, header))
    }
    const frame = requestAnimationFrame(update)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    const owner = element.closest('[data-conductor-overview-layout]'); if (owner) observer?.observe(owner)
    const header = element.closest('header')
    if (header) { observer?.observe(header); for (const child of Array.from(header.children)) observer?.observe(child) }
    window.addEventListener('resize', update)
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', update) }
  }, [props.sessionId, title, origin?.originSessionId])
  if (origin === undefined) return null
  return createElement('div', { ref: root, className: 'conductor-session-origin', 'aria-label': '会话来源' }, [createElement('style', { key: 'style' }, CSS), createElement('span', { key: 'source' }, '由另一会话发起'), title ? createElement('span', { key: 'title', className: 'conductor-session-origin-title', title }, `· ${title}`) : null,
    createElement('button', { key: 'return', type: 'button', disabled: !enabled, title: enabled ? '返回发起会话' : '发起会话当前不可用', onClick: () => {
      if (!available(props.sessions, origin.originSessionId)) return
      void Promise.resolve().then(() => props.sessions.open(origin.originSessionId)).catch(error => { setOpenError(error instanceof Error ? error.message : '无法返回发起会话') })
    } }, '返回发起会话'), openError ? createElement('span', { key: 'error', role: 'status' }, openError) : null])
}

interface ClientContext {
  readonly slots: { inject(key: string, callback: () => (() => void)): unknown; register(options: { name: string; key?: string; id?: string; order?: number; priority?: number }, component: (props: never) => ReactElement | null): () => void }
  readonly sessions: NavigationSessions
  readonly conversationEvents: { register(definition: ConversationNodeDefinition<CreationState>): unknown }
  effect(callback: () => (() => void)): unknown
  get?(name: string): unknown
}
export function apply(ctx: ClientContext): void {
  const port = httpSessionLinks()
  const overview = httpOverview()
  const subagents = createSubagentsPort(ctx.sessions as NativeSubagentSessions)
  const preview = createPreviewController(ctx, overview, subagents)
  ctx.effect(() => () => { port.close(); overview.close(); preview.dispose(); subagents.close() })
  ctx.conversationEvents.register(creationLinkDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: LINK_NODE_KIND }, (props: Omit<Parameters<typeof CreatedSessionCard>[0], 'port' | 'sessions'>) => createElement(CreatedSessionCard, { ...props, port, sessions: ctx.sessions })))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'conductor-session-origin', order: -20 }, (props: { sessionId: string }) => createElement(SessionOrigin, { ...props, port, sessions: ctx.sessions })))
  // Keep the zero-sized workspace anchor in the actions slot. The visible control
  // belongs in the utilities slot so it follows the host's Session log button.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'conductor-workspace-anchor', order: 100 }, (props: { sessionId: string }) => createElement(WorkspacePreview, { key: props.sessionId + ':workspace', sessionId: props.sessionId, controller: preview, port: overview, subagents,
    sessions: ctx.get?.('sessions') as Parameters<typeof WorkspacePreview>[0]['sessions'] ?? {} })))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'conductor-sidebar-toggle', order: 100 }, (props: Pick<OverviewProps, 'sessionId' | 'useSession'>) => createElement(SidebarButton, { ...props, port: overview, controller: preview })))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'conductor-session-overview', order: 30 }, (props: Pick<OverviewProps, 'sessionId' | 'useSession'>) => {
    const workspaces = ctx.get?.('workspaces') as { openPath?(path: string): Promise<void> } | undefined
    const connection = ctx.get?.('connection') as { isLoopback?: boolean } | undefined
    return createElement(SessionOverviewCard, { ...props, key: props.sessionId, port: overview, sessions: ctx.sessions, subagents,
      onPreview: target => preview.open(props.sessionId, target),
      onOpenSidebar: () => preview.home(props.sessionId),
      ...workspaces?.openPath === undefined || connection?.isLoopback !== true ? {} : { openFile: async (path: string) => {
        const cwd = ctx.sessions.list.getSnapshot().byId?.[props.sessionId]?.cwd
        if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(path) && !cwd) throw Error('当前工作目录不可用')
        await workspaces.openPath!(/^(?:[A-Za-z]:[\\/]|\/)/.test(path) ? path : cwd + '/' + path)
      } },
    })
  }))
}
