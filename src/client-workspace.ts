import { createElement as h, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react'
import { IconCodeOutline16, IconFolderOpenOutline16, IconGlobeOutline14, IconLinkOutline16, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OverviewPreviewItem, OverviewPreviewTarget } from './client-overview.ts'
import { resolveWebUrl } from './overview-client-data.ts'

interface WorkspaceHomeProps {
  readonly outputs: readonly OverviewPreviewItem[]
  readonly sources: readonly OverviewPreviewItem[]
  open(target: OverviewPreviewTarget): void
  tools(): void
}

const CSS = [
  '.conductor-workspace-home{display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100%;width:100%;padding:32px 24px;box-sizing:border-box}',
  '.conductor-workspace-menu,.conductor-workspace-url-form{display:flex;flex-direction:column;gap:6px;width:min(100%,420px)}',
  '.conductor-workspace-home .conductor-workspace-entry{display:flex;align-items:center;gap:12px;width:100%;height:44px;min-height:44px;padding:0 16px;text-align:left;border:0;border-radius:10px;background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:13px/1.4 inherit;cursor:pointer}',
  '.conductor-workspace-entry svg{flex-shrink:0;opacity:.72}.conductor-workspace-entry-label{flex:1;min-width:0}.conductor-workspace-entry-count{flex-shrink:0;margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8a8a);font-variant-numeric:tabular-nums}',
  '.conductor-workspace-home .conductor-workspace-entry:hover,.conductor-workspace-home .conductor-workspace-entry:focus-visible{background:color-mix(in srgb,currentColor 9%,transparent)}.conductor-workspace-home button:focus-visible,.conductor-workspace-home input:focus-visible{outline:2px solid #719fff;outline-offset:2px}',
  '.conductor-workspace-note{margin:12px 0 0;text-align:center;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#777)}.conductor-workspace-url-form{gap:12px}.conductor-workspace-url-form label{font-size:13px}.conductor-workspace-home .conductor-workspace-url{width:100%;min-width:0;height:44px;box-sizing:border-box;border:0;border-radius:10px;padding:0 16px;background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:inherit}.conductor-workspace-form-actions{display:flex;justify-content:space-between;gap:12px}.conductor-workspace-home .conductor-workspace-submit{height:36px;padding:0 14px;border:0;border-radius:10px;background:color-mix(in srgb,currentColor 9%,transparent);color:inherit}.conductor-workspace-error{font-size:12px;line-height:1.6;margin:12px 0 0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#777);width:min(100%,420px)}',
].join('')

/** A local navigation home: resources are supplied by the current conversation, never queried here. */
export function WorkspaceHome(props: WorkspaceHomeProps): ReactElement {
  const [web, setWeb] = useState(false), [url, setUrl] = useState(''), [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null), inputId = useId()
  useEffect(() => { if (web) input.current?.focus({ preventScroll: true }) }, [web])
  const invoke = (action: () => void): void => {
    setError('')
    try { action() } catch (cause) { setError(cause instanceof Error ? cause.message : '暂时无法打开，请重试。') }
  }
  const entry = (label: string, icon: typeof IconFolderOpenOutline16, action: () => void, count?: number): ReactElement =>
    h('button', { key: label, type: 'button', className: 'conductor-workspace-entry', onClick: () => invoke(action) }, [
      h(icon, { key: 'icon' }), h('span', { key: 'label', className: 'conductor-workspace-entry-label' }, label),
      count === undefined ? null : h('span', { key: 'count', className: 'conductor-workspace-entry-count', 'aria-label': String(count) + ' 项' }, String(count)),
    ])
  return h('div', { className: 'conductor-workspace-home' }, [
    h('style', { key: 'style' }, CSS),
    web ? h('form', { key: 'url-form', className: 'conductor-workspace-url-form', noValidate: true, onSubmit: (event: FormEvent) => {
      event.preventDefault()
      const target = resolveWebUrl(url.trim())
      if (!target) { setError('请输入有效的 HTTP 或 HTTPS 网址，且不要在网址中包含账号或密码。'); input.current?.focus(); return }
      invoke(() => props.open({ kind: 'url', url: target, title: new URL(target).hostname }))
    } }, [
      h('label', { key: 'label', htmlFor: inputId }, '网页地址'),
      h('input', { key: 'url', id: inputId, ref: input, type: 'url', inputMode: 'url', className: 'conductor-workspace-url',
        placeholder: 'https://example.com', value: url, autoComplete: 'off', spellCheck: false,
        onChange: (event: ChangeEvent<HTMLInputElement>) => { setUrl(event.currentTarget.value); setError('') } }),
      h('div', { key: 'actions', className: 'conductor-workspace-form-actions' }, [
        h('button', { key: 'back', type: 'button', onClick: () => { setWeb(false); setError('') } }, '返回'),
        h('button', { key: 'submit', type: 'submit', className: 'conductor-workspace-submit' }, '打开预览'),
      ]),
      h('p', { key: 'hint', className: 'conductor-workspace-note' }, '部分网站不允许嵌入，可在预览中选择浏览器打开。'),
    ]) : h('div', { key: 'menu', className: 'conductor-workspace-menu' }, [
      entry('输出文件', IconFolderOpenOutline16, () => props.open({ kind: 'collection', title: '输出文件', items: props.outputs }), props.outputs.length),
      entry('来源', IconLinkOutline16, () => props.open({ kind: 'collection', title: '来源', items: props.sources }), props.sources.length),
      entry('网页预览', IconGlobeOutline14, () => setWeb(true)),
      entry('终端', IconCodeOutline16, () => props.open({ kind: 'terminal', title: '终端' })),
      entry('工具详情', IconPanelLeftOutline16, () => props.tools()),
    ]),
    error ? h('p', { key: 'error', role: 'alert', className: 'conductor-workspace-error' }, error) : null,
  ])
}
