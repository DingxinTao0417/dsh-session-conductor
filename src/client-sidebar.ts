import { createElement as h, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { OverviewProps, OverviewPreviewItem, OverviewPreviewTarget } from './client-overview.ts'
import type { PreviewController } from './client-preview.ts'
import { conversationResources, safeWebUrl, type OverviewRead } from './overview-client-data.ts'

export function sidebarHome(sessionId: string, snapshot: Pick<ConversationSnapshot, 'nodes' | 'hasMore'> | undefined, read: OverviewRead): OverviewPreviewTarget {
  const resources = conversationResources(snapshot)
  const outputs: OverviewPreviewItem[] = resources.outputs.map(item => ({ kind: 'file', path: item.path!, title: item.title, sessionId }))
  for (const item of read.sessionId === sessionId && read.data?.sessionId === sessionId ? read.data.outputs : []) {
    const url = item.url && safeWebUrl(item.url)
    if (url) outputs.push({ kind: 'url', url, title: item.title })
    else if (item.local && item.path && !outputs.some(output => output.kind === 'file' && output.path === item.path && output.sessionId === item.sessionId)) {
      outputs.push({ kind: 'file', path: item.path, title: item.title, ...item.sessionId ? { sessionId: item.sessionId } : {} })
    }
  }
  const sources = resources.sources.flatMap<OverviewPreviewItem>(item => item.url ? [{ kind: 'url', url: item.url, title: item.title }]
    : item.path ? [{ kind: 'file', path: item.path, title: item.title, sessionId }]
      : item.kind === 'attachment' ? [{ kind: 'attachment', attachmentId: item.id.replace(/^attachment:/, ''), title: item.title }] : [])
  return { kind: 'workspace', title: '工作区', outputs, sources }
}

const noSession = (): undefined => undefined
export function SidebarButton(props: Pick<OverviewProps, 'sessionId' | 'useSession' | 'port'> & { controller: PreviewController }): ReactElement {
  const snapshot = (props.useSession ?? noSession)(value => value)
  const [read, setRead] = useState<OverviewRead>({ sessionId: props.sessionId })
  const [error, setError] = useState('')
  const anchor = useRef<HTMLSpanElement>(null)
  const current = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot)
  useEffect(() => props.port.subscribe(props.sessionId, setRead), [props.port, props.sessionId])
  useEffect(() => props.controller.registerHome(props.sessionId, () => sidebarHome(props.sessionId, snapshot, read)), [props.controller, props.sessionId, snapshot, read])
  useEffect(() => {
    let owner: HTMLElement | null = null, observer: ResizeObserver | undefined
    const update = (): void => {
      const bounds = anchor.current?.getBoundingClientRect(), area = owner?.getBoundingClientRect()
      if (!bounds || !area || !owner) return
      // While the workspace pane is open the toggle lives in the pane and this
      // control is display:none; a zero box is not a clipped box.
      if (bounds.width === 0 && bounds.height === 0) return
      const clipped = bounds.right > Math.min(area.right, window.innerWidth) || bounds.left < Math.max(0, area.left)
      owner.toggleAttribute('data-conductor-sidebar-fallback', clipped)
    }
    // The sibling overview creates its owned dock after the header commits.
    const frame = requestAnimationFrame(() => {
      owner = anchor.current?.closest<HTMLElement>('[data-conductor-overview-layout]') ?? null
      observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
      if (owner) observer?.observe(owner)
      if (anchor.current) observer?.observe(anchor.current)
      const header = anchor.current?.closest('header'); if (header) observer?.observe(header)
      update()
    })
    window.addEventListener('resize', update)
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', update); owner?.removeAttribute('data-conductor-sidebar-fallback') }
  }, [props.sessionId])
  const expanded = current?.owner === props.sessionId
  return h('span', { ref: anchor, className: 'conductor-sidebar-control' }, [
    h('style', { key: 'style' }, '.conductor-sidebar-control{display:inline-flex;align-items:center;flex-shrink:0}[data-conductor-workspace-open="true"] .conductor-sidebar-control{display:none}.conductor-sidebar-toggle{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:7px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.conductor-sidebar-toggle:hover,.conductor-sidebar-toggle[aria-expanded=true]{background:color-mix(in srgb,currentColor 9%,transparent)}.conductor-sidebar-toggle:focus-visible{outline:2px solid #719fff;outline-offset:2px}.conductor-sidebar-toggle>svg{transform:scaleX(-1)}.conductor-sidebar-error{font-size:12px;max-width:180px;overflow-wrap:anywhere}'),
    h('button', { key: 'button', type: 'button', className: 'conductor-sidebar-toggle', 'aria-label': expanded ? '关闭右侧栏' : '打开右侧栏', 'aria-expanded': expanded,
      title: expanded ? '关闭右侧栏' : '打开右侧栏', onClick: () => {
        try { setError(''); if (expanded) props.controller.close(); else props.controller.home(props.sessionId) }
        catch (cause) { setError(cause instanceof Error ? cause.message : '右侧栏暂不可用。') }
      } }, h(IconPanelLeftOutline16)),
    error ? h('span', { key: 'error', role: 'status', className: 'conductor-sidebar-error' }, error) : null,
  ])
}
