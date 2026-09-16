import { createElement as h, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { IconBranchOutline16, IconChevronDownOutline14, IconFolderOpenOutline16, IconLinkOutline16, IconPaperclipOutline16, IconPlusOutline16, IconPanelLeftOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { NavigationSessions } from './client-navigation.ts'
import { conversationResources, safeWebUrl, type OverviewPort, type OverviewRead } from './overview-client-data.ts'
import type { DelegationReceipt } from './domain/overview.ts'
import { SubagentsSummary } from './client-subagents.ts'
import type { SubagentsPort } from './client-subagents-data.ts'
import { observeNativePane } from './client-native-pane.ts'

const CSS = [
  '[data-conductor-workspace-open]>.conductor-overview-dock,[data-conductor-native-pane-open]>.conductor-overview-dock{display:none!important}[data-conductor-native-pane-open]:not([data-conductor-workspace-open]){padding-right:0!important}',
  '.conductor-overview-sidebar-open{display:none!important}[data-conductor-sidebar-fallback] .conductor-overview-sidebar-open{display:inline-flex!important;align-items:center;justify-content:center;width:32px;height:32px}.conductor-overview-sidebar-open>svg{transform:scaleX(-1)}[data-conductor-sidebar-fallback] .conductor-sidebar-control{visibility:hidden}',
  '.conductor-overview-count{font-size:11px;border-radius:9px;background:color-mix(in srgb,#5285ff 24%,transparent);padding:1px 6px}',
  '.conductor-overview-anchor{width:0;height:0}.conductor-overview{position:relative;width:330px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 150px);overflow:auto;box-sizing:border-box;padding:18px 20px;border-radius:22px;background:var(--dsw-alias-bg-layer-2,#2d2d2d);color:var(--dsw-alias-label-primary,#e3e3e3);border:1px solid color-mix(in srgb,currentColor 9%,transparent);box-shadow:0 10px 28px #0002;font:400 14px/1.55 system-ui,sans-serif;text-align:left;color-scheme:light dark}',
  '.conductor-overview *{box-sizing:border-box}.conductor-overview button,.conductor-overview input,.conductor-overview textarea,.conductor-overview select{font:inherit;color:inherit}',
  '.conductor-overview button{cursor:pointer;background:transparent;border:0;border-radius:7px;padding:5px 7px}.conductor-overview button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.conductor-overview button:disabled{opacity:.4;cursor:default}',
  '.conductor-overview button:focus-visible,.conductor-overview a:focus-visible,.conductor-overview summary:focus-visible{outline:2px solid #719fff;outline-offset:3px}',
  '.conductor-overview-header,.conductor-overview-title,.conductor-overview-actions{display:flex;align-items:center;gap:8px}.conductor-overview-header{justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-secondary,#aaa);margin-bottom:10px}',
  '.conductor-overview-section{padding:15px 0;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent)}.conductor-overview-section:first-of-type{border-top:0;padding-top:3px}.conductor-overview-section>summary{list-style:none;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:15px;font-weight:550;color:var(--dsw-alias-label-secondary,#b0b0b0)}.conductor-overview-section>summary::-webkit-details-marker{display:none}',
  '.conductor-overview-section>summary>.conductor-overview-section-label{flex:1;min-width:0;text-align:left}.conductor-overview-section>summary>button.conductor-overview-section-label{font-weight:inherit;padding:4px 8px;margin-left:-8px}.conductor-overview-section[open]>summary .conductor-chevron{transform:rotate(180deg)}.conductor-chevron{transition:transform .16s}',
  '.conductor-overview-list{margin:10px 0 0;padding:0;list-style:none;display:grid;gap:3px}.conductor-overview-row{display:flex;align-items:center;gap:4px;min-width:0;margin:0 -8px;border-radius:8px}.conductor-overview-row:has(.conductor-overview-item:not(:disabled)):hover,.conductor-overview-row:focus-within{background:color-mix(in srgb,currentColor 9%,transparent)}.conductor-overview-row svg{flex-shrink:0}.conductor-overview-row .conductor-overview-item{display:flex;align-items:center;gap:9px;flex:1;width:100%;min-width:0;min-height:34px;padding:6px 8px;text-align:left;color:inherit;text-decoration:none;background:transparent}.conductor-overview-row .conductor-overview-item:hover{background:transparent}.conductor-overview-item-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.conductor-overview-row .conductor-overview-origin{flex-shrink:0;font-size:11px;padding:4px 6px;margin-right:4px}.conductor-overview-row .conductor-overview-status{flex-shrink:0}',
  '.conductor-overview-muted{font-size:12px;color:var(--dsw-alias-label-secondary,#aaa);margin:6px 0}.conductor-overview-empty{font-size:13px;color:var(--dsw-alias-label-secondary,#aaa);margin:10px 0 2px}.conductor-overview-list>li{min-width:0}.conductor-overview-task{padding:8px 0;min-width:0}.conductor-overview-task>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;min-height:34px;padding:6px 8px;margin:0 -8px;border-radius:8px}.conductor-overview-task>summary:hover,.conductor-overview-task>summary:focus-visible{background:color-mix(in srgb,currentColor 9%,transparent)}.conductor-overview-task>summary>span:nth-child(2){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.conductor-overview-status{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary,#aaa)}.conductor-overview-actions{flex-wrap:wrap;margin-top:7px;font-size:12px}.conductor-overview-actions button{border:1px solid color-mix(in srgb,currentColor 12%,transparent)}',
  '.conductor-overview-preview{margin:8px 0;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}.conductor-overview-receipt{border-top:1px solid color-mix(in srgb,currentColor 8%,transparent);padding:8px 0}.conductor-overview-result{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.65;max-height:45vh;overflow:auto;margin:12px 0}',
  '.conductor-overview form{display:grid;gap:8px;margin-top:12px}.conductor-overview label{display:grid;gap:4px;font-size:12px}.conductor-overview input,.conductor-overview textarea,.conductor-overview select{width:100%;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;padding:8px;background:color-mix(in srgb,currentColor 3%,transparent)}.conductor-overview textarea{resize:vertical;min-height:90px}.conductor-overview form button[type=submit]{background:var(--dsw-alias-label-primary,#e3e3e3);color:var(--dsw-alias-bg-layer-2,#2d2d2d);padding:8px 12px}',
  '.conductor-overview-notice{padding:9px;border-radius:9px;background:color-mix(in srgb,#bd872a 13%,transparent);font-size:12px;overflow-wrap:anywhere;margin:9px 0}.conductor-overview-message{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.conductor-overview-muted{overflow-wrap:anywhere}',
  '@media(prefers-color-scheme:light){.conductor-overview{background:var(--dsw-alias-bg-layer-2,#f8f8f8);color:var(--dsw-alias-label-primary,#252525)}.conductor-overview-muted,.conductor-overview-empty,.conductor-overview-header,.conductor-overview-status,.conductor-overview-section>summary{color:var(--dsw-alias-label-secondary,#666)}}',
  // Wide: zero-height in-flow dock after the header; card is absolutely placed
  // on the right. Below 1080 CSS px hide the overview entirely instead of
  // stacking a compact card above chat. The dock sits above the chat body's
  // sticky code-block headers and scroll affordances (host uses z-index 8).
  '[data-conductor-overview-layout]{position:relative;box-sizing:border-box}.conductor-overview-dock{min-width:0}.conductor-overview-dock[data-layout=wide]{position:relative;align-self:stretch;flex:0 0 0;width:auto;height:0;min-height:0;max-height:0;margin:0;overflow:visible;pointer-events:none;z-index:30}.conductor-overview-dock[data-layout=wide]>.conductor-overview{position:absolute;top:8px;right:16px;width:330px;margin:0;pointer-events:auto;z-index:2}.conductor-overview-dock[data-layout=hidden]{display:none!important}.conductor-overview-compact{width:100%;max-width:none;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 22px;max-height:clamp(144px,28dvh,220px);padding:12px 18px;border-radius:16px;box-shadow:0 4px 16px #0001}.conductor-overview-compact .conductor-overview-header,.conductor-overview-compact>form,.conductor-overview-compact>section,.conductor-overview-compact>.conductor-overview-notice,.conductor-overview-compact>.conductor-overview-message{grid-column:1/-1}.conductor-overview-compact>.conductor-overview-section{border-top:0;padding:0;min-width:0}.conductor-overview-compact .conductor-overview-muted{font-size:11px}.conductor-overview-compact .conductor-overview-list{margin-top:6px}.conductor-overview-compact .conductor-overview-header{margin-bottom:5px}.conductor-overview-dock[data-columns=four] .conductor-overview-compact{grid-template-columns:repeat(4,minmax(0,1fr))}.conductor-overview-dock[data-columns=single] .conductor-overview-compact{grid-template-columns:1fr;gap:12px}.conductor-overview-dock[data-columns=single] .conductor-overview-compact>.conductor-overview-section{border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);padding-top:8px}@media(prefers-reduced-motion:reduce){.conductor-chevron{transition:none}}',
].join('')

export const DELEGATION_TEMPLATES = [
  { id: 'research', title: '只读调研', instruction: '围绕以下问题开展只读调研，给出结论、依据和来源。无需为了汇报进度额外写文件；不要修改项目。\n\n问题：' },
  { id: 'implement', title: '实现功能', instruction: '在当前工作区实现以下功能，保护已有修改。完成后说明改动、相关验证和剩余问题；不要提交、推送或发布。\n\n功能：' },
  { id: 'review', title: '检查变更', instruction: '只读检查以下范围的变更，优先报告可复现的问题并给出文件位置。不修改代码，不重复实现。\n\n检查范围：' },
] as const

export type OverviewPreviewItem =
  | { readonly kind: 'file'; readonly path: string; readonly title: string; readonly sessionId?: string }
  | { readonly kind: 'url'; readonly url: string; readonly title: string }
  | { readonly kind: 'attachment'; readonly attachmentId: string; readonly title: string }
export type OverviewPreviewTarget = OverviewPreviewItem
  | { readonly kind: 'subagents'; readonly title: string }
  | { readonly kind: 'collection'; readonly title: string; readonly items: readonly OverviewPreviewItem[] }
  | { readonly kind: 'workspace'; readonly title: string; readonly outputs: readonly OverviewPreviewItem[]; readonly sources: readonly OverviewPreviewItem[] }
  | { readonly kind: 'terminal'; readonly title: string }
export interface OverviewProps {
  readonly sessionId: string
  readonly port: OverviewPort
  readonly sessions: NavigationSessions
  readonly useSession?: <T>(selector: (snapshot: ConversationSnapshot) => T) => T
  readonly openFile?: (path: string) => Promise<void>
  readonly onPreview?: (target: OverviewPreviewTarget) => void | Promise<void>
  readonly onOpenSidebar?: () => void
  readonly subagents?: SubagentsPort
}
const noSession = (): undefined => undefined
const statusLabel: Readonly<Record<string, string>> = { running: '进行中', idle: '空闲', preparing: '准备中', preparation_failed: '创建失败', cancelled: '已取消', released: '已释放', budget_limited: '预算受限', waiting_user: '需要处理' }
const receiptLabel = (receipt: DelegationReceipt): string => {
  if (receipt.phase === 'returned') return ({ completed: '本次已完成', failed: '本次失败', interrupted: '本次已中断', blocked: '需要处理' } as Record<string, string>)[receipt.outcome ?? ''] ?? '本次已结束'
  return ({ running: '执行中', armed: '等待执行', delivery_unknown: '送达待确认', delivery_failed: '未送达' } as Record<string, string>)[receipt.phase] ?? receipt.phase
}

/** Persistent current-conversation card; resource previews are handled by the workspace pane. */
export function SessionOverviewCard(props: OverviewProps): ReactElement {
  const [read, setRead] = useState<OverviewRead>({ sessionId: props.sessionId })
  const [dock, setDock] = useState<HTMLDivElement>()
  const [compact, setCompact] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [compose, setCompose] = useState<string>()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [mode, setMode] = useState('steer')
  const [directoryMode, setDirectoryMode] = useState('inherit')
  const [allSources, setAllSources] = useState(false)
  const [result, setResult] = useState<{ operationId: string; title: string; text: string; truncated: boolean; turn: number }>()
  const root = useRef<HTMLDivElement>(null)
  const form = useRef<HTMLFormElement>(null), resultSection = useRef<HTMLElement>(null)
  const snapshot = (props.useSession ?? noSession)((value: ConversationSnapshot) => value)
  const resources = conversationResources(snapshot)
  const data = read.sessionId === props.sessionId ? read.data : undefined
  const currentRef = useRef(props.sessionId)
  const submitRef = useRef<{ signature: string; operationId: string }>()
  useEffect(() => { currentRef.current = props.sessionId; return () => { currentRef.current = '' } }, [props.sessionId])
  useEffect(() => props.port.subscribe(props.sessionId, setRead), [props.port, props.sessionId])
  useEffect(() => { if (result && !data?.receipts.some(receipt => receipt.operationId === result.operationId)) setResult(undefined) }, [data, result])
  useEffect(() => {
    if (compose === undefined) return
    form.current?.scrollIntoView({ block: 'nearest' })
    form.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')?.focus({ preventScroll: true })
  }, [compose])
  useEffect(() => {
    if (!result) return
    resultSection.current?.scrollIntoView({ block: 'nearest' })
    resultSection.current?.focus({ preventScroll: true })
  }, [result])
  useEffect(() => {
    const header = root.current?.closest('header')
    // The public header slot establishes ownership. Add only our own sibling dock
    // after the header branch. Wide layout collapses dock height; narrow hides
    // the overview instead of stacking it above chat.
    let container = header?.parentElement
    while (container && container !== document.body && !(getComputedStyle(container).display === 'flex' && getComputedStyle(container).flexDirection === 'column' && container.getBoundingClientRect().height > 200)) container = container.parentElement
    if (!header || !container || container === document.body) return
    const owner = container
    let headerBranch: HTMLElement = header
    while (headerBranch.parentElement !== owner && headerBranch.parentElement) headerBranch = headerBranch.parentElement
    const mount = document.createElement('div')
    mount.className = 'conductor-overview-dock'
    owner.insertBefore(mount, headerBranch.nextSibling)
    const stopNativePane = observeNativePane(root.current!, visible => owner.toggleAttribute('data-conductor-native-pane-open', visible))
    const reposition = (): void => {
      const narrow = owner.clientWidth < 1080
      owner.setAttribute('data-conductor-overview-layout', narrow ? 'hidden' : 'wide')
      mount.dataset['layout'] = narrow ? 'hidden' : 'wide'
      mount.dataset['columns'] = owner.clientWidth < 620 ? 'single' : owner.clientWidth >= 900 ? 'four' : 'multiple'
      // Layout is CSS-driven; clear any leftover absolute offset from older builds
      // or a transformed host container after resize.
      mount.style.removeProperty('top')
      setCompact(false)
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(reposition)
    observer?.observe(owner); observer?.observe(header)
    reposition(); setDock(mount); window.addEventListener('resize', reposition)
    return () => { window.removeEventListener('resize', reposition); observer?.disconnect(); stopNativePane(); mount.remove(); owner.removeAttribute('data-conductor-overview-layout'); owner.removeAttribute('data-conductor-native-pane-open') }
  }, [])
  const run = (work: () => Promise<void>): void => {
    if (busy) return
    const owner = props.sessionId
    setBusy(true); setMessage('')
    void work().catch(error => { if (currentRef.current === owner) setMessage(error instanceof Error ? error.message : '操作未完成') })
      .finally(() => { if (currentRef.current === owner) setBusy(false) })
  }
  const openSession = (id: string | undefined): void => { if (id && props.sessions.list.getSnapshot().ids.includes(id)) run(async () => { await props.sessions.open(id) }) }
  const preview = (target: OverviewPreviewTarget): void => run(async () => {
    if (props.onPreview) { await props.onPreview(target); return }
    if (target.kind === 'file') {
      if (props.openFile) await props.openFile(target.path)
      else { await navigator.clipboard.writeText(target.path); setMessage('已复制路径') }
    } else setMessage('当前宿主未提供此预览入口')
  })
  const canOpen = (id: string | undefined): boolean => id !== undefined && props.sessions.list.getSnapshot().ids.includes(id)
  const button = (label: string, onClick: () => void, disabled = false): ReactElement => h('button', { key: label, type: 'button', disabled: busy || disabled, onClick }, label)
  const newTask = (): void => { submitRef.current = undefined; setCompose('new'); setTitle(''); setText(''); setDirectoryMode('inherit'); setResult(undefined) }
  const showResult = (receipt: DelegationReceipt): void => run(async () => {
    const value = await props.port.result(props.sessionId, receipt.operationId)
    if (currentRef.current === props.sessionId) setResult({ operationId: receipt.operationId, title: receipt.title, ...value })
  })
  const section = (label: string, count: number, body: ReactElement[], key: string, items?: readonly OverviewPreviewItem[]): ReactElement => h('details', { className: 'conductor-overview-section', key, open: true }, [
    h('summary', { key: 'summary' }, [items && props.onPreview ? h('button', { key: 'label', type: 'button', className: 'conductor-overview-section-label', title: '在右侧查看' + label,
      onClick: (event: { preventDefault(): void; stopPropagation(): void }) => { event.preventDefault(); event.stopPropagation(); preview({ kind: 'collection', title: label, items }) },
    }, label) : h('span', { key: 'label', className: 'conductor-overview-section-label' }, label), h('span', { key: 'count', className: 'conductor-overview-status' }, String(count)), h(IconChevronDownOutline14, { key: 'chevron', className: 'conductor-chevron' })]), ...body,
  ])
  const outputItems: OverviewPreviewItem[] = []
  const outputs = resources.outputs.map(resource => {
    const target: OverviewPreviewItem = { kind: 'file', path: resource.path!, title: resource.title, sessionId: props.sessionId }
    outputItems.push(target)
    return h('li', { key: resource.id, className: 'conductor-overview-row' }, h('button', { type: 'button', className: 'conductor-overview-item', title: resource.path, onClick: () => preview(target) }, [
      h(IconFolderOpenOutline16, { key: 'icon' }), h('span', { key: 'name', className: 'conductor-overview-item-label' }, resource.title),
    ]))
  })
  for (const output of data?.outputs ?? []) {
    if (resources.outputs.some(resource => resource.path && resource.path === output.path)) continue
    const url = output.url === undefined ? undefined : safeWebUrl(output.url)
    const target: OverviewPreviewItem | undefined = url ? { kind: 'url', url, title: output.title }
      : output.path && output.local ? { kind: 'file', path: output.path, title: output.title, ...output.sessionId ? { sessionId: output.sessionId } : {} } : undefined
    if (target) outputItems.push(target)
    outputs.push(h('li', { key: output.id, className: 'conductor-overview-row' }, [
      h('button', { key: 'name', type: 'button', className: 'conductor-overview-item', title: output.path ?? url, disabled: !target && !canOpen(output.sessionId), onClick: () => target ? preview(target) : openSession(output.sessionId) }, [
        h(IconFolderOpenOutline16, { key: 'icon' }), h('span', { key: 'title', className: 'conductor-overview-item-label' }, output.title),
        h('span', { key: 'state', className: 'conductor-overview-status' }, output.existence === 'present' ? '已记录' : '待确认'),
      ]),
      canOpen(output.sessionId) ? h('button', { key: 'origin', type: 'button', className: 'conductor-overview-origin', title: '打开产出会话', onClick: () => openSession(output.sessionId) }, '来源') : null,
    ]))
  }
  const taskRows = (data?.tasks ?? []).map(task => {
    const receipts = data?.receipts.filter(receipt => receipt.taskId === task.taskId) ?? []
    const watching = data?.watchingTaskIds.includes(task.taskId) === true
    const completed = task.status === 'idle' && task.lastTurn === 'completed'
    const dot = task.execution === 'running' ? 'ongoing' : task.status === 'waiting_user' ? 'warning' : task.status === 'preparation_failed' || task.lastTurn === 'failed' ? 'error' : completed ? 'done' : undefined
    return h('li', { key: task.taskId }, h('details', { className: 'conductor-overview-task' }, [
      h('summary', { key: 'name' }, [dot ? h(StateDot, { key: 'dot', state: dot }) : h(IconBranchOutline16, { key: 'dot' }), h('span', { key: 'title', title: task.title }, task.title), h('span', { key: 'state', className: 'conductor-overview-status' }, completed ? '本轮完成' : statusLabel[task.status] ?? task.status)]),
      h('p', { key: 'cwd', className: 'conductor-overview-muted' }, task.cwd ?? '工作目录尚未就绪'),
      task.pendingInteraction && task.pendingInteraction !== 'none' ? h('p', { key: 'pending', className: 'conductor-overview-notice' }, '子会话需要你处理：' + task.pendingInteraction) : null,
      h('div', { key: 'actions', className: 'conductor-overview-actions' }, [
        button('打开会话', () => openSession(task.sessionId), !canOpen(task.sessionId)),
        button('补充指令', () => { setCompose(task.taskId); setText(''); setMode('steer'); setResult(undefined) }, task.preparation !== 'ready'),
        button(watching ? '停止监控' : '持续监控', () => run(async () => {
          await props.port.action(props.sessionId, 'watch', { action: watching ? 'stop' : 'start', taskId: task.taskId })
          setMessage(watching ? '已停止监控，任务继续运行。' : '已启用持续监控；有重要变化时会唤醒主会话，可能使用模型额度。')
        })),
        button('停止本轮', () => run(async () => {
          const state = await props.port.action(props.sessionId, 'read', { taskId: task.taskId, view: 'snapshot' })
          if (typeof state.expectedTurn !== 'number' || typeof state.expectedStartSeq !== 'number') throw Error('当前没有可精确停止的运行轮次')
          const value = await props.port.action(props.sessionId, 'stop', { taskId: task.taskId, expectedTurn: state.expectedTurn, expectedStartSeq: state.expectedStartSeq,
            ...typeof state.bindingVersion === 'number' ? { expectedBindingVersion: state.bindingVersion } : {},
            ...typeof state.ownerEpoch === 'number' ? { expectedOwnerEpoch: state.ownerEpoch } : {} })
          setMessage(String(value.summary ?? '停止请求已处理'))
        }), task.execution !== 'running'),
      ]),
      ...receipts.map(receipt => h('div', { key: receipt.operationId, className: 'conductor-overview-receipt' }, [
        h('div', { key: 'status', className: 'conductor-overview-muted' }, (receipt.kind === 'send' ? '追加委派 · ' : '首次委派 · ') + receiptLabel(receipt) + (!receipt.read && ['returned', 'delivery_failed'].includes(receipt.phase) ? ' · 未读' : '')),
        receipt.preview ? h('p', { key: 'preview', className: 'conductor-overview-preview' }, receipt.preview) : null,
        receipt.detail && receipt.outcome !== 'completed' ? h('p', { key: 'detail', className: 'conductor-overview-muted' }, receipt.detail) : null,
        h('div', { key: 'actions', className: 'conductor-overview-actions' }, [
          receipt.phase === 'returned' ? button('查看本次结果', () => showResult(receipt), !receipt.local) : null,
          !receipt.read && ['returned', 'delivery_failed'].includes(receipt.phase) ? button('标记已读', () => run(async () => { await props.port.acknowledge(props.sessionId, [receipt.operationId]) })) : null,
        ]),
      ])),
    ]))
  })
  const sourceItems: OverviewPreviewItem[] = resources.sources.flatMap<OverviewPreviewItem>(resource => resource.url ? [{ kind: 'url' as const, url: resource.url, title: resource.title }]
    : resource.path ? [{ kind: 'file' as const, path: resource.path, title: resource.title, sessionId: props.sessionId }]
      : resource.kind === 'attachment' ? [{ kind: 'attachment' as const, attachmentId: resource.id.replace(/^attachment:/, ''), title: resource.title }] : [])
  const sourceRows = (allSources ? sourceItems : sourceItems.slice(0, 4)).map(target => h('li', { key: target.kind === 'url' ? target.url : target.kind === 'file' ? target.path : target.attachmentId, className: 'conductor-overview-row' },
    h('button', { type: 'button', className: 'conductor-overview-item', title: target.kind === 'url' ? target.url : target.kind === 'file' ? target.path : target.title, onClick: () => preview(target) }, [
      h(target.kind === 'url' ? IconLinkOutline16 : IconPaperclipOutline16, { key: 'icon' }), h('span', { key: 'name', className: 'conductor-overview-item-label' }, target.title),
    ])))
  const card = h('aside', { key: 'card', className: 'conductor-overview' + (compact ? ' conductor-overview-compact' : ''), 'aria-label': '当前会话概览' }, [
      h('div', { key: 'header', className: 'conductor-overview-header' }, [h('span', { key: 'title' }, '当前会话'),
        props.onOpenSidebar ? h('button', { key: 'sidebar', type: 'button', className: 'conductor-overview-sidebar-open', title: '打开右侧栏', 'aria-label': '打开右侧栏', onClick: () => { try { props.onOpenSidebar?.() } catch (error) { setMessage(error instanceof Error ? error.message : '右侧栏暂不可用。') } } }, h(IconPanelLeftOutline16)) : null,
        (data?.unread ?? 0) + (data?.needsAttention ?? 0) > 0 ? h('span', { key: 'count', className: 'conductor-overview-count', title: '未读回执与待处理事项' }, String((data?.unread ?? 0) + (data?.needsAttention ?? 0))) : null,
      ]),
      read.error ? h('p', { key: 'error', role: 'status', className: 'conductor-overview-notice' }, read.error) : null,
      section('输出内容', outputs.length, [outputs.length ? h('ul', { key: 'list', className: 'conductor-overview-list' }, outputs) : h('p', { key: 'empty', className: 'conductor-overview-empty' }, '完成的文件和已登记成果会显示在这里')], 'outputs', outputItems),
      props.subagents ? h(SubagentsSummary, { key: 'subagents', port: props.subagents, parentId: props.sessionId, open: () => preview({ kind: 'subagents', title: '子智能体' }) }) : null,
      section('委派任务', data?.tasks.length ?? 0, [
        h('div', { key: 'actions', className: 'conductor-overview-actions' }, [h('button', { key: 'new', type: 'button', onClick: newTask }, [h(IconPlusOutline16, { key: 'icon' }), ' 新建任务']),
          (data?.unread ?? 0) > 0 ? button(data?.truncated ? '标记本页已读' : '全部标记已读', () => run(async () => { await props.port.acknowledge(props.sessionId, data!.receipts.filter(receipt => !receipt.read && ['returned', 'delivery_failed'].includes(receipt.phase)).map(receipt => receipt.operationId)) })) : null]),
        taskRows.length ? h('ul', { key: 'list', className: 'conductor-overview-list' }, taskRows) : h('p', { key: 'empty', className: 'conductor-overview-empty' }, '从这个会话发起的任务会显示在这里'),
        ...(data?.sharedDirectories ?? []).map(group => h('p', { key: group.cwd, className: 'conductor-overview-notice' }, String(group.taskIds.length) + ' 个运行中的任务共享目录。可分配不同文件，或明确选择 worktree 隔离。\n' + group.cwd)),
      ], 'tasks'),
      section('来源', resources.sources.length, [
        sourceRows.length ? h('ul', { key: 'list', className: 'conductor-overview-list' }, sourceRows) : h('p', { key: 'empty', className: 'conductor-overview-empty' }, '当前已加载记录中暂无文件或链接来源'),
        resources.sources.length > 4 ? button(allSources ? '收起来源' : '查看全部来源', () => setAllSources(!allSources)) : null,
        h('p', { key: 'scope', className: 'conductor-overview-muted' }, resources.partial ? '仅展示已加载的历史；加载更早消息后更新。' : '来自用户消息与工具读取记录；链接不代表已核验。'),
      ].filter((value): value is ReactElement => value !== null), 'sources', sourceItems),
      compose === undefined ? null : h('form', { key: 'compose', ref: form, onSubmit: (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!text.trim() || compose === 'new' && !title.trim()) return
        const signature = JSON.stringify({ compose, title, text, mode, directoryMode })
        if (submitRef.current?.signature !== signature) submitRef.current = { signature, operationId: crypto.randomUUID() }
        const operationId = submitRef.current.operationId
        run(async () => {
          const cwd = props.sessions.list.getSnapshot().byId?.[props.sessionId]?.cwd
          if (compose === 'new' && directoryMode === 'worktree' && !cwd) throw Error('当前工作目录不可用，无法创建隔离工作区')
          const value = compose === 'new'
            ? await props.port.action(props.sessionId, 'create', { title: title.trim(), instruction: text, contextMode: 'empty',
              ...directoryMode === 'worktree' ? { gitStrategy: 'current_head', repoPath: cwd } : {} }, operationId)
            : await props.port.action(props.sessionId, 'send', { taskId: compose, text, mode }, operationId)
          setMessage(compose === 'new' ? '创建请求已受理，准备状态会显示在任务列表。' : '指令状态：' + String(value.delivery ?? '已受理'))
          setCompose(undefined); setText(''); submitRef.current = undefined
        })
      } }, [
        h('strong', { key: 'title' }, compose === 'new' ? '新建委派任务' : '补充指令'),
        compose === 'new' ? h('label', { key: 'template' }, ['任务模板', h('select', { key: 'input', defaultValue: '', onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          const template = DELEGATION_TEMPLATES.find(value => value.id === event.currentTarget.value)
          if (template) { setTitle(template.title); setText(template.instruction) }
        } }, [h('option', { key: 'empty', value: '' }, '自定义任务'), ...DELEGATION_TEMPLATES.map(template => h('option', { key: template.id, value: template.id }, template.title))])]) : null,
        compose === 'new' ? h('label', { key: 'name' }, ['会话名称', h('input', { key: 'input', required: true, maxLength: 160, value: title, onChange: (event: ChangeEvent<HTMLInputElement>) => setTitle(event.currentTarget.value) })]) : null,
        compose === 'new' ? h('label', { key: 'directory' }, ['工作目录', h('select', { key: 'input', value: directoryMode, onChange: (event: ChangeEvent<HTMLSelectElement>) => setDirectoryMode(event.currentTarget.value) }, [
          h('option', { key: 'inherit', value: 'inherit' }, '沿用主会话工作区（默认）'),
          h('option', { key: 'worktree', value: 'worktree' }, '从当前提交创建 Git worktree'),
        ])]) : null,
        h('label', { key: 'instruction' }, ['任务要求', h('textarea', { key: 'input', required: true, maxLength: 20_000, value: text, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setText(event.currentTarget.value) })]),
        compose !== 'new' ? h('label', { key: 'mode' }, ['发送方式', h('select', { key: 'input', value: mode, onChange: (event: ChangeEvent<HTMLSelectElement>) => setMode(event.currentTarget.value) }, [h('option', { key: 'steer', value: 'steer' }, '补充到当前工作'), h('option', { key: 'queue', value: 'queue' }, '排到下一轮')])]) : null,
        h('p', { key: 'default', className: 'conductor-overview-muted' }, (compose === 'new' && directoryMode === 'worktree' ? '独立目录从当前提交开始，不带未提交修改；准备失败时停止。' : '默认继承当前工作区。') + '完成后回执，不唤醒主会话。'),
        h('button', { key: 'submit', type: 'submit', disabled: busy }, busy ? '正在提交…' : compose === 'new' ? '创建任务' : '发送指令'),
        button('取消', () => { submitRef.current = undefined; setCompose(undefined) }),
      ]),
      result ? h('section', { key: 'result', ref: resultSection, tabIndex: -1 }, [h('strong', { key: 'title' }, result.title + ' · 第 ' + String(result.turn) + ' 轮结果'), h('div', { key: 'text', className: 'conductor-overview-result' }, result.text || '这一轮没有公开文字结果。'), result.truncated ? h('p', { key: 'truncated', className: 'conductor-overview-muted' }, '结果较长，已截断。打开子会话可查看完整记录。') : null, button('收起结果', () => setResult(undefined))]) : null,
      message ? h('p', { key: 'message', role: 'status', className: 'conductor-overview-message' }, message) : null,
      data?.truncated ? h('p', { key: 'truncated', className: 'conductor-overview-muted' }, '概览已达到显示上限；更早记录可通过会话历史和协调工具查看。') : null,
    ])
  return h('div', { ref: root, className: 'conductor-overview-anchor' }, [
    h('style', { key: 'style' }, CSS), dock ? createPortal(card, dock) : h('div', { key: 'pending', hidden: true }, card),
  ])
}
