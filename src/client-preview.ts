import { createElement as h, useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconBranchOutline16, IconCloseOutline16, IconCodeOutline16, IconCopyOutline16, IconFolderOpenOutline16, IconGlobeOutline14, IconLinkOutline16, IconPaperclipOutline16, IconPanelLeftOutline16, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkspaceHome } from './client-workspace.ts'
import { SubagentsView } from './client-subagents.ts'
import type { SubagentsPort } from './client-subagents-data.ts'
import { mountWorkspaceSurface, type WorkspaceSurface } from './client-workspace-layout.ts'
import type { OverviewPreviewTarget } from './client-overview.ts'
import type { OverviewPort } from './overview-client-data.ts'
import { safeWebUrl, resolveWebUrl, webPageTitle } from './overview-client-data.ts'
import { WebPreview } from './client-web-preview.ts'
import { releaseTerminalTab, releaseTerminalTabs, WorkspaceTerminal } from './client-terminal.ts'

export interface PreviewClientContext {
  readonly slots: {
    inject(key: string, effect: () => (() => void)): unknown
    register(options: { name: string; id?: string; priority?: number }, component: (props: never) => ReactElement | null): () => void
  }
  get?(name: string): unknown
}
interface PreviewSessions {
  binding?(id: string): { session: {
    readAttachment(id: string): Promise<{ ok: true; value: { attachment: { mediaType: string }; data: Uint8Array } } | { ok: false; error: { message?: string } }>
  } } | undefined
}
export interface PreviewTab {
  readonly id: string
  readonly owner: string
  readonly target: OverviewPreviewTarget
}
export interface PreviewState {
  readonly owner: string
  readonly target: OverviewPreviewTarget
  readonly revision: number
  readonly tabs: readonly PreviewTab[]
  readonly activeId: string
}
export interface PreviewController {
  open(sessionId: string, target: OverviewPreviewTarget): void
  activate(tabId: string): void
  closeTab(tabId: string): void
  registerSurface(sessionId: string, surface: WorkspaceSurface): () => void
  registerHome(sessionId: string, read: () => OverviewPreviewTarget): () => void
  home(sessionId: string): void
  navigate(url: string): void
  subscribe(listener: () => void): () => void
  getSnapshot(): PreviewState | undefined
  tools(): void
  close(): void
  dispose(): void
}
const CSS = [
  '.conductor-preview-pane.conductor-preview-floating{position:fixed;inset:0 0 0 auto;height:auto;width:min(100vw,420px);z-index:90;box-shadow:-8px 0 28px #0002}',
  '.conductor-preview-pane{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);font:14px/1.65 system-ui,sans-serif;overflow:hidden}',
  '.conductor-preview-pane *{box-sizing:border-box}',
  // One row, bottom-aligned to the host tabs row: the bar ends exactly on the
  // host header divider (published as --conductor-workspace-header-height) and
  // every control shares the same 28px baseline row above it.
  '.conductor-preview-tabs{display:flex;align-items:flex-end;gap:6px;box-sizing:border-box;height:var(--conductor-workspace-header-height,52px);min-height:var(--conductor-workspace-header-height,52px);max-height:var(--conductor-workspace-header-height,52px);padding:0 10px 4px 12px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);flex-shrink:0}',
  '.conductor-preview-tabstrip{display:flex;align-items:center;gap:2px;flex:1;min-width:0;height:28px;overflow:auto hidden;scrollbar-width:none}.conductor-preview-tabstrip::-webkit-scrollbar{display:none}',
  '.conductor-preview-tab{display:inline-flex;align-items:center;gap:0;max-width:200px;min-width:0;height:28px;padding:0 2px 0 2px;border:0;border-radius:8px;background:transparent;color:inherit;flex:0 1 auto}',
  '.conductor-preview-tab[data-active=true]{background:color-mix(in srgb,currentColor 9%,transparent)}',
  '.conductor-preview-tab:not([data-active=true]):hover{background:color-mix(in srgb,currentColor 5%,transparent)}',
  '.conductor-preview-tab-select{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:1;height:100%;padding:0 4px 0 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}.conductor-preview-tab-select>svg{flex-shrink:0;opacity:.75}',
  '.conductor-preview-tab-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;text-align:left}',
  '.conductor-preview-tab-close,.conductor-preview-tab-add{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;flex-shrink:0;opacity:.7}',
  '.conductor-preview-tab-close:hover,.conductor-preview-tab-add:hover{background:color-mix(in srgb,currentColor 10%,transparent);opacity:1}',
  '.conductor-preview-tab-add{margin-left:2px}',
  // Same control as the header sidebar toggle; it moves into the pane while open.
  '.conductor-preview-pane-toggle{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:color-mix(in srgb,currentColor 9%,transparent);color:inherit;cursor:pointer;flex-shrink:0}.conductor-preview-pane-toggle:hover{background:color-mix(in srgb,currentColor 14%,transparent)}.conductor-preview-pane-toggle>svg{transform:scaleX(-1)}',
  '.conductor-preview-pane button,.conductor-preview-pane a{font:inherit;color:inherit}',
  '.conductor-preview-pane button:focus-visible,.conductor-preview-pane a:focus-visible{outline:2px solid #719fff;outline-offset:2px}',
  '.conductor-preview-subbar{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent);font-size:12px;flex-shrink:0}.conductor-preview-subbar span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#777)}',
  '.conductor-preview-subbar button{border:0;border-radius:7px;background:transparent;padding:6px 8px;cursor:pointer}.conductor-preview-subbar button:hover,.conductor-preview-resource:hover{background:color-mix(in srgb,currentColor 9%,transparent)}',
  '.conductor-preview-body{padding:18px 20px;overflow:auto;min-height:0;flex:1}.conductor-preview-body pre{font:12px/1.75 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.conductor-preview-body img{max-width:100%;height:auto;display:block;margin:auto}.conductor-preview-body h1{font-size:24px;line-height:1.35}.conductor-preview-body h2{font-size:20px;line-height:1.4}.conductor-preview-body h3{font-size:17px}.conductor-preview-body p{margin:0 0 14px;overflow-wrap:anywhere}.conductor-preview-body h1,.conductor-preview-body h2,.conductor-preview-body h3{margin:10px 0 16px}.conductor-preview-body code{font:12px/1.7 ui-monospace,Consolas,monospace;background:color-mix(in srgb,currentColor 5%,transparent);padding:2px 4px;border-radius:4px}.conductor-preview-body pre.conductor-preview-code{padding:14px;border-radius:10px;background:color-mix(in srgb,currentColor 5%,transparent);margin:12px 0}.conductor-preview-body ul{padding-left:22px;margin:0 0 16px}.conductor-preview-body li{margin:5px 0}',
  '.conductor-preview-resource{display:flex!important;align-items:center;gap:10px;width:100%;min-width:0;text-align:left;padding:10px!important;border-radius:9px}.conductor-preview-resource svg{flex-shrink:0}.conductor-preview-resource span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.conductor-preview-collection{list-style:none!important;margin:0!important;padding:0!important}.conductor-preview-footer{padding:10px 16px;border-top:1px solid color-mix(in srgb,currentColor 8%,transparent);font-size:12px;color:var(--dsw-alias-label-secondary,#777);flex-shrink:0}.conductor-preview-error{padding:14px;border-radius:10px;background:color-mix(in srgb,#bd872a 12%,transparent);font-size:13px}.conductor-preview-web-body,.conductor-preview-home-body,.conductor-preview-terminal-body{padding:0;display:flex;flex-direction:column}',
].join('')

export interface PreviewLayout { readonly floating: boolean; readonly top: number; readonly bottom: number }

const tabIcon = (target: OverviewPreviewTarget): typeof IconFolderOpenOutline16 =>
  target.kind === 'url' ? IconGlobeOutline14
    : target.kind === 'attachment' ? IconPaperclipOutline16
    : target.kind === 'subagents' ? IconBranchOutline16
    : target.kind === 'workspace' ? IconPanelLeftOutline16
    : target.kind === 'terminal' ? IconCodeOutline16
    : target.kind === 'collection' && target.title === '来源' ? IconLinkOutline16
    : IconFolderOpenOutline16

/** Stable identity for reusing an open preview tab. */
export function samePreviewTarget(left: OverviewPreviewTarget, right: OverviewPreviewTarget): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'workspace' && right.kind === 'workspace') return true
  if (left.kind === 'terminal' && right.kind === 'terminal') return true
  if (left.kind === 'subagents' && right.kind === 'subagents') return true
  if (left.kind === 'file' && right.kind === 'file') return left.path === right.path && left.sessionId === right.sessionId
  if (left.kind === 'url' && right.kind === 'url') return left.url === right.url
  if (left.kind === 'attachment' && right.kind === 'attachment') return left.attachmentId === right.attachmentId
  if (left.kind === 'collection' && right.kind === 'collection') return left.title === right.title
  return false
}

/** The body portal must respect the actual Host content viewport below Desktop chrome. */
export function observePreviewLayout(element: HTMLElement, publish: (layout: PreviewLayout) => void): () => void {
  const viewport = element.ownerDocument.defaultView
  if (!viewport) return () => {}
  const application = element.closest('#root')
  const update = (): void => {
    const bounds = application?.getBoundingClientRect()
    const height = viewport.innerHeight
    const top = bounds && bounds.bottom > bounds.top ? Math.min(height, Math.max(0, bounds.top)) : 0
    const bottom = bounds && bounds.bottom > bounds.top ? Math.min(height - top, Math.max(0, height - bounds.bottom)) : 0
    publish({ floating: element.getBoundingClientRect().width < 80, top, bottom })
  }
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
  observer?.observe(element)
  if (application) observer?.observe(application)
  viewport.addEventListener('resize', update)
  update()
  return () => { observer?.disconnect(); viewport.removeEventListener('resize', update) }
}

/** A conservative React-only Markdown subset. Raw HTML is always text. */
export function previewMarkdown(text: string): ReactElement[] {
  const inline = (value: string): ReactNode[] => value.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return h('strong', { key: index }, part.slice(2, -2))
    if (part.startsWith('`') && part.endsWith('`')) return h('code', { key: index }, part.slice(1, -1))
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part)
    const url = link ? safeWebUrl(link[2]!) : undefined
    return url && link ? h('a', { key: index, href: url, target: '_blank', rel: 'noreferrer' }, link[1]) : part
  })
  const result: ReactElement[] = [], lines = text.replaceAll('\r\n', '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (!line.trim()) { index++; continue }
    if (line.startsWith('```')) {
      const code: string[] = []; index++
      while (index < lines.length && !lines[index]!.startsWith('```')) code.push(lines[index++]!)
      index++; result.push(h('pre', { key: result.length, className: 'conductor-preview-code' }, code.join('\n'))); continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) { result.push(h('h' + String(heading[1]!.length), { key: result.length }, inline(heading[2]!))); index++; continue }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactElement[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index]!)) items.push(h('li', { key: items.length }, inline(lines[index++]!.replace(/^\s*[-*]\s+/, ''))))
      result.push(h('ul', { key: result.length }, items)); continue
    }
    // A rejected block marker is still text; always consume its first line.
    const paragraph: string[] = [lines[index++]!]
    while (index < lines.length && lines[index]!.trim() && !/^(#{1,3}\s|```|\s*[-*]\s)/.test(lines[index]!)) paragraph.push(lines[index++]!)
    result.push(h('p', { key: result.length, style: { whiteSpace: 'pre-wrap' } }, inline(paragraph.join('\n'))))
  }
  return result
}

function PreviewPane(props: {
  state: PreviewState
  port: OverviewPort
  subagents?: SubagentsPort
  managed?: boolean
  sessions: PreviewSessions
  close(): void
  closeTab(tabId: string): void
  activate(tabId: string): void
  home(): void
  tools(): void
  open(target: OverviewPreviewTarget): void
  navigate(url: string): void
}): ReactElement {
  const { state } = props, target = state.target
  const anchor = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<PreviewLayout>({ floating: false, top: 0, bottom: 0 })
  const { floating } = layout
  useEffect(() => {
    const element = anchor.current
    if (!element || props.managed) return
    return observePreviewLayout(element, setLayout)
  }, [props.managed])
  const [content, setContent] = useState<{ text?: string; path?: string; image?: string; truncated?: boolean }>()
  const [error, setError] = useState(''), [raw, setRaw] = useState(false), [copied, setCopied] = useState(false)
  useEffect(() => {
    let active = true, objectUrl: string | undefined
    setContent(undefined); setError(''); setRaw(false); setCopied(false)
    const load = async (): Promise<void> => {
      if (target.kind === 'file') {
        const result = await props.port.preview(state.owner, { path: target.path, ...target.sessionId ? { sessionId: target.sessionId } : {} })
        if (active) setContent(result)
      } else if (target.kind === 'attachment') {
        const session = props.sessions.binding?.(state.owner)?.session
        if (!session) throw Error('当前会话的附件读取能力不可用。')
        const result = await session.readAttachment(target.attachmentId)
        if (!result.ok) throw Error(result.error.message ?? '附件无法读取。')
        if (!active) return
        const type = result.value.attachment.mediaType
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(type)) throw Error('此附件格式不能在图片预览中显示。')
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(result.value.data)], { type }))
        setContent({ image: objectUrl })
      }
    }
    void load().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '预览暂不可用。') })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [props.port, props.sessions, state.owner, target, state.activeId])
  const markdown = target.kind === 'file' && /\.(?:md|markdown)$/i.test(target.path)
  const body = target.kind === 'subagents'
    ? props.subagents ? h(SubagentsView, { port: props.subagents, parentId: state.owner }) : h('p', {}, '当前宿主未提供子智能体目录。')
    : target.kind === 'workspace'
    ? h(WorkspaceHome, { outputs: target.outputs, sources: target.sources, open: props.open, tools: props.tools })
    : target.kind === 'collection'
    ? h('ul', { className: 'conductor-preview-collection' }, target.items.length ? target.items.map((item, index) => h('li', { key: index }, h('button', { type: 'button', className: 'conductor-preview-resource', onClick: () => props.open(item) }, [
      h(item.kind === 'file' ? IconFolderOpenOutline16 : item.kind === 'url' ? IconLinkOutline16 : IconPaperclipOutline16, { key: 'icon' }), h('span', { key: 'title' }, item.title),
    ]))) : h('li', {}, '当前没有可预览项目。'))
    : target.kind === 'url'
    ? h(WebPreview, { tabId: state.activeId, url: target.url, title: target.title, navigate: props.navigate })
    : target.kind === 'terminal' ? null
    : error ? h('p', { role: 'status', className: 'conductor-preview-error' }, error)
      : content?.image ? h('img', { src: content.image, alt: target.title })
        : content?.text !== undefined ? markdown && !raw ? h('article', {}, previewMarkdown(content.text)) : h('pre', {}, content.text)
          : h('p', { role: 'status' }, '正在读取…')
  const terminals = state.tabs.filter(tab => tab.target.kind === 'terminal').map(tab => h('div', {
    key: tab.id, hidden: tab.id !== state.activeId,
    style: { display: tab.id === state.activeId ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' },
  }, h(WorkspaceTerminal, { tabId: tab.id, sessionId: state.owner, port: props.port })))
  const pane = h('section', { className: 'conductor-preview-pane' + (floating ? ' conductor-preview-floating' : ''),
    style: floating ? { top: layout.top, bottom: layout.bottom } : undefined, 'aria-label': '右侧内容预览' }, [
    h('style', { key: 'style' }, CSS),
    h('header', { key: 'tabs', className: 'conductor-preview-tabs' }, [
      h('div', { key: 'strip', className: 'conductor-preview-tabstrip', role: 'tablist', 'aria-label': '工作区标签' }, [
        ...state.tabs.map(tab => h('div', {
          key: tab.id, className: 'conductor-preview-tab', 'data-active': tab.id === state.activeId ? 'true' : 'false',
        }, [
          h('button', {
            key: 'select', type: 'button', role: 'tab', className: 'conductor-preview-tab-select',
            'aria-selected': tab.id === state.activeId, title: tab.target.title, onClick: () => props.activate(tab.id),
          }, [h(tabIcon(tab.target), { key: 'icon' }), h('span', { key: 'title', className: 'conductor-preview-tab-title' }, tab.target.title)]),
          h('button', {
            key: 'close', type: 'button', className: 'conductor-preview-tab-close', title: '关闭标签',
            'aria-label': '关闭 ' + tab.target.title, onClick: () => props.closeTab(tab.id),
          }, h(IconCloseOutline16)),
        ])),
        h('button', { key: 'add', type: 'button', className: 'conductor-preview-tab-add', title: '打开工作区首页', 'aria-label': '打开工作区首页', onClick: props.home }, h(IconPlusOutline16)),
      ]),
      h('button', { key: 'pane-toggle', type: 'button', className: 'conductor-preview-pane-toggle', title: '关闭右侧栏', 'aria-label': '关闭右侧栏', 'aria-expanded': true, onClick: props.close }, h(IconPanelLeftOutline16)),
    ]),
    target.kind === 'workspace' || target.kind === 'subagents' || target.kind === 'url' || target.kind === 'terminal' ? null : h('div', { key: 'subbar', className: 'conductor-preview-subbar' }, [h('span', { key: 'location', title: content?.path ?? (target.kind === 'file' ? target.path : undefined) }, content?.path ?? (target.kind === 'file' ? target.path : target.kind === 'collection' ? String(target.items.length) + ' 个项目' : '会话附件')),
      markdown && content?.text !== undefined ? h('button', { key: 'raw', type: 'button', onClick: () => setRaw(!raw) }, raw ? '预览' : '原文') : null,
      content?.text !== undefined ? h('button', { key: 'copy', type: 'button', title: copied ? '已复制' : '复制内容', 'aria-label': '复制内容', onClick: () => { void navigator.clipboard.writeText(content.text!).then(() => setCopied(true)).catch(() => setError('复制失败，请手动选择文字复制。')) } }, h(IconCopyOutline16)) : null]),
    h('div', { key: 'body', className: 'conductor-preview-body' + (target.kind === 'url' ? ' conductor-preview-web-body' : target.kind === 'workspace' ? ' conductor-preview-home-body' : target.kind === 'terminal' ? ' conductor-preview-terminal-body' : ''), style: target.kind === 'workspace' || target.kind === 'url' || target.kind === 'terminal' ? { display: 'flex' } : undefined }, [...terminals, body]),
    target.kind === 'workspace' || target.kind === 'terminal' ? null : h('footer', { key: 'footer', className: 'conductor-preview-footer' }, content?.truncated ? '内容已截断；完整内容请查看原文件。' : target.kind === 'file' ? '只读预览 · 不会启动模型任务' : target.kind === 'url' ? '内嵌预览 · 站点禁止嵌入时请用外部浏览器打开' : '当前会话 · 内容预览'),
  ])
  // The host automatically hides details below its narrow-window breakpoint.
  // Keep explicit previews reachable using a temporary drawer, without changing host settings.
  return h('div', { ref: anchor, style: { height: '100%', minHeight: 0 } }, floating ? createPortal(pane, document.body) : pane)
}

/** The public header slot owns this mount; no Host root or layout methods are replaced. */
export function WorkspacePreview(props: { sessionId: string; controller: PreviewController; port: OverviewPort; sessions: PreviewSessions; subagents: SubagentsPort }): ReactElement {
  const anchor = useRef<HTMLSpanElement>(null)
  const [surface, setSurface] = useState<WorkspaceSurface>()
  const current = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot)
  useEffect(() => {
    if (!anchor.current) return
    const mounted = mountWorkspaceSurface(anchor.current)
    if (!mounted) return
    const release = props.controller.registerSurface(props.sessionId, mounted)
    setSurface(mounted)
    return () => { release(); mounted.dispose() }
  }, [props.controller, props.sessionId])
  const active = current?.owner === props.sessionId ? current : undefined
  return h('span', { ref: anchor, style: { width: 0, height: 0 } }, surface && active ? createPortal(h(PreviewPane, {
    key: active.owner + ':pane',
    state: active, port: props.port, sessions: props.sessions, subagents: props.subagents, managed: true,
    close: props.controller.close, closeTab: id => props.controller.closeTab(id), activate: id => props.controller.activate(id),
    home: () => props.controller.home(props.sessionId), tools: props.controller.tools,
    open: target => props.controller.open(props.sessionId, target),
    navigate: url => props.controller.navigate(url),
  }), surface.content) : null)
}

/** Own surfaces provide the wide workspace; details remains a capability fallback. */
export function createPreviewController(ctx: PreviewClientContext, port: OverviewPort, subagents?: SubagentsPort): PreviewController {
  let state: PreviewState | undefined, revision = 0, sequence = 0, unregister: (() => void) | undefined, ready = false, disposed = false
  const listeners = new Set<() => void>()
  const homes = new Map<string, () => OverviewPreviewTarget>()
  const surfaces = new Map<string, WorkspaceSurface>()
  const stashed = new Map<string, { tabs: readonly PreviewTab[]; activeId: string }>()
  const publish = (): void => { for (const listener of listeners) listener() }
  const layout = (): { openDetails(): void; closeDetails(): void } | undefined => ctx.get?.('layout') as ReturnType<typeof layout>
  const snapshot = (owner: string, tabs: readonly PreviewTab[], activeId: string): PreviewState => {
    const active = tabs.find(tab => tab.id === activeId) ?? tabs[0]!
    return { owner, tabs, activeId: active.id, target: active.target, revision: ++revision }
  }
  const requireDetails = (): void => {
    if (disposed || !ready || typeof layout()?.openDetails !== 'function') throw Error('当前宿主未提供右侧预览区域。')
  }
  const stashOwner = (current: PreviewState): void => {
    if (current.tabs.length) stashed.set(current.owner, { tabs: current.tabs, activeId: current.activeId })
  }
  const hideOwner = (owner: string): void => { surfaces.get(owner)?.setOpen(false) }
  const dropTerminals = (tabs: readonly PreviewTab[], owner: string): void => {
    releaseTerminalTabs(tabs.filter(tab => tab.target.kind === 'terminal').map(tab => tab.id), id => { void port.closeTerminal(owner, id) })
  }
  const close = (hide = true, remember = true): void => {
    if (state) {
      if (remember) stashOwner(state)
      else {
        stashed.delete(state.owner)
        dropTerminals(state.tabs, state.owner)
      }
      hideOwner(state.owner)
    }
    state = undefined; const remove = unregister; unregister = undefined; remove?.(); publish()
    if (hide) layout()?.closeDetails()
  }
  const restore = (sessionId: string, stored: { tabs: readonly PreviewTab[]; activeId: string }): void => {
    requireDetails()
    if (state && state.owner !== sessionId) {
      stashOwner(state)
      hideOwner(state.owner)
    }
    stashed.delete(sessionId)
    state = snapshot(sessionId, stored.tabs, stored.activeId)
    show(sessionId)
  }
  const applyHome = (tabs: readonly PreviewTab[], target: OverviewPreviewTarget): readonly PreviewTab[] =>
    tabs.map(tab => tab.target.kind === 'workspace' ? { ...tab, target } : tab)
  const show = (sessionId: string): void => {
    const surface = surfaces.get(sessionId)
    if (surface) {
      unregister?.(); unregister = undefined
      layout()!.closeDetails(); surface.setOpen(true); publish(); return
    }
    if (!unregister) unregister = ctx.slots.register({ name: 'details', id: 'conductor-content-preview', priority: -100 }, (props: { sessionId?: string }) => {
      const current = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state, () => state)
      useEffect(() => { if (current && props.sessionId !== current.owner) close(false) }, [current, props.sessionId])
      if (!current || props.sessionId !== current.owner) return null
      return h(PreviewPane, {
        key: current.owner + ':details', state: current, port, sessions: ctx.get?.('sessions') as PreviewSessions ?? {},
        ...subagents ? { subagents } : {},
        close: () => close(), closeTab: id => controller.closeTab(id), activate: id => controller.activate(id),
        home: () => controller.home(current.owner), tools: () => controller.tools(), open: item => controller.open(current.owner, item),
        navigate: url => controller.navigate(url),
      })
    })
    publish(); layout()!.openDetails()
  }
  const wait = ctx.slots.inject('details', () => { ready = true; return () => { ready = false; close(false) } })
  const controller: PreviewController = {
    registerSurface(sessionId, surface) {
      if (disposed) return () => {}
      surfaces.get(sessionId)?.setOpen(false)
      surfaces.set(sessionId, surface)
      if (state?.owner === sessionId) {
        unregister?.(); unregister = undefined
        layout()?.closeDetails(); surface.setOpen(true)
      }
      return () => {
        if (surfaces.get(sessionId) !== surface) return
        if (state?.owner === sessionId) close(false)
        surface.setOpen(false); surfaces.delete(sessionId)
      }
    },
    registerHome(sessionId, read) {
      if (disposed) return () => {}
      homes.set(sessionId, read)
      const refresh = (tabs: readonly PreviewTab[]): readonly PreviewTab[] | undefined => {
        if (!tabs.some(tab => tab.target.kind === 'workspace')) return
        return applyHome(tabs, read())
      }
      if (state?.owner === sessionId) {
        const tabs = refresh(state.tabs)
        if (tabs) {
          state = snapshot(sessionId, tabs, state.activeId)
          publish()
        }
      }
      const stored = stashed.get(sessionId)
      if (stored) {
        const tabs = refresh(stored.tabs)
        if (tabs) stashed.set(sessionId, { tabs, activeId: stored.activeId })
      }
      return () => { if (homes.get(sessionId) === read) homes.delete(sessionId) }
    },
    home(sessionId) {
      if (!state || state.owner !== sessionId) {
        const stored = stashed.get(sessionId)
        if (stored?.tabs.length) { restore(sessionId, stored); return }
      }
      controller.open(sessionId, homes.get(sessionId)?.() ?? { kind: 'workspace', title: '工作区', outputs: [], sources: [] })
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => state,
    activate(tabId) {
      if (!state || state.activeId === tabId) return
      if (!state.tabs.some(tab => tab.id === tabId)) return
      state = snapshot(state.owner, state.tabs, tabId)
      publish()
    },
    closeTab(tabId) {
      if (!state) return
      const index = state.tabs.findIndex(tab => tab.id === tabId)
      if (index < 0) return
      const closing = state.tabs[index]!
      if (closing.target.kind === 'terminal') releaseTerminalTab(tabId, id => { void port.closeTerminal(state!.owner, id) })
      const tabs = state.tabs.filter(tab => tab.id !== tabId)
      if (tabs.length === 0) { close(true, false); return }
      const activeId = state.activeId === tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? tabs[0]!.id) : state.activeId
      state = snapshot(state.owner, tabs, activeId)
      publish()
    },
    tools() {
      requireDetails()
      close(false); layout()!.openDetails()
    },
    open(sessionId, target) {
      requireDetails()
      if (state && state.owner !== sessionId) {
        stashOwner(state)
        hideOwner(state.owner)
      }
      const previous = state?.owner === sessionId ? state : stashed.get(sessionId)
      stashed.delete(sessionId)
      const tabs = previous?.tabs ?? []
      const existing = tabs.find(tab => samePreviewTarget(tab.target, target))
      if (existing) {
        const next = existing.target.kind === 'workspace' || existing.target.kind === 'collection'
          ? tabs.map(tab => tab.id === existing.id ? { ...tab, target } : tab)
          : tabs
        state = snapshot(sessionId, next, existing.id)
      } else {
        const tab = { id: 'tab-' + String(++sequence), owner: sessionId, target }
        state = snapshot(sessionId, [...tabs, tab], tab.id)
      }
      show(sessionId)
    },
    navigate(url) {
      const current = state
      if (!current || current.target.kind !== 'url') return
      const safe = resolveWebUrl(url)
      if (!safe || current.target.url === safe) return
      const target = { kind: 'url' as const, url: safe, title: webPageTitle(safe) }
      const tabs = current.tabs.map(tab => tab.id === current.activeId ? { ...tab, target } : tab)
      state = snapshot(current.owner, tabs, current.activeId)
      publish()
    },
    close: () => close(),
    dispose() {
      disposed = true
      if (state) dropTerminals(state.tabs, state.owner)
      for (const [owner, stored] of stashed) dropTerminals(stored.tabs, owner)
      close(false, false); stashed.clear(); if (typeof wait === 'function') wait(); listeners.clear(); homes.clear(); surfaces.clear()
    },
  }
  return controller
}
