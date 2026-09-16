import { createElement as h, useId, useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react'
import { IconChevronLeftOutline14, IconChevronRightOutline14, IconRefreshOutline16, IconRightUpOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolveWebUrl, safeWebUrl } from './overview-client-data.ts'

export const WEB_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-downloads'

export interface WebHistory {
  readonly pages: readonly string[]
  readonly index: number
}

const CSS = [
  '.conductor-web-preview{display:flex;flex-direction:column;height:100%;min-height:0;flex:1}',
  '.conductor-web-chrome{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent);flex-shrink:0}',
  '.conductor-web-chrome button,.conductor-web-chrome a{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:inherit;flex-shrink:0;cursor:pointer}',
  '.conductor-web-chrome button:hover:not(:disabled),.conductor-web-chrome a:hover{background:color-mix(in srgb,currentColor 9%,transparent)}',
  '.conductor-web-chrome button:disabled{opacity:.35;cursor:default}',
  '.conductor-web-address{flex:1;min-width:0}',
  '.conductor-web-address input{width:100%;height:28px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:8px;padding:0 10px;background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;font:12px/28px ui-monospace,Consolas,monospace}',
  '.conductor-web-error{margin:0;padding:6px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#777);flex-shrink:0}',
  '.conductor-web-frame{flex:1;min-height:0;width:100%;border:0;background:#fff}',
].join('')

export function commitWebNavigation(history: WebHistory, input: string): { history: WebHistory; url: string; mode: 'reload' | 'push' } | undefined {
  const url = resolveWebUrl(input)
  if (!url) return
  if (history.pages[history.index] === url) return { history, url, mode: 'reload' }
  const pages = [...history.pages.slice(0, history.index + 1), url]
  return { history: { pages, index: pages.length - 1 }, url, mode: 'push' }
}

export function stepWebHistory(history: WebHistory, delta: -1 | 1): { history: WebHistory; url: string } | undefined {
  const index = history.index + delta
  const url = history.pages[index]
  if (!url) return
  return { history: { pages: history.pages, index }, url }
}

/** Restricted iframe chrome: address bar, in-tab history, reload, and an external exit. */
export function WebPreview(props: { tabId: string; url: string; title: string; navigate(url: string): void }): ReactElement {
  const start = safeWebUrl(props.url) ?? ''
  const addressId = useId()
  const [tabId, setTabId] = useState(props.tabId)
  const [history, setHistory] = useState<WebHistory>({ pages: start ? [start] : [], index: 0 })
  const [generation, setGeneration] = useState(0)
  const [draft, setDraft] = useState(start)
  const [error, setError] = useState(start ? '' : '请输入有效的 HTTP 或 HTTPS 网址，且不要在网址中包含账号或密码。')
  if (tabId !== props.tabId) {
    const next = safeWebUrl(props.url) ?? ''
    setTabId(props.tabId)
    setHistory({ pages: next ? [next] : [], index: 0 })
    setGeneration(0)
    setDraft(next)
    setError(next ? '' : '请输入有效的 HTTP 或 HTTPS 网址，且不要在网址中包含账号或密码。')
  }
  const current = history.pages[history.index] ?? start
  const apply = (next: WebHistory, url: string, reload = false): void => {
    setHistory(next)
    setDraft(url)
    setError('')
    if (reload) setGeneration(value => value + 1)
    props.navigate(url)
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const committed = commitWebNavigation(history, draft)
    if (!committed) {
      setError('请输入有效的 HTTP 或 HTTPS 网址，且不要在网址中包含账号或密码。')
      return
    }
    apply(committed.history, committed.url, committed.mode === 'reload')
  }
  const step = (delta: -1 | 1): void => {
    const moved = stepWebHistory(history, delta)
    if (moved) apply(moved.history, moved.url)
  }
  return h('div', { className: 'conductor-web-preview' }, [
    h('style', { key: 'style' }, CSS),
    h('form', { key: 'chrome', className: 'conductor-web-chrome', onSubmit: submit, 'aria-label': '内嵌网页预览' }, [
      h('button', { key: 'back', type: 'button', title: '后退', 'aria-label': '后退', disabled: history.index <= 0, onClick: () => step(-1) }, h(IconChevronLeftOutline14)),
      h('button', { key: 'forward', type: 'button', title: '前进', 'aria-label': '前进', disabled: history.index >= history.pages.length - 1, onClick: () => step(1) }, h(IconChevronRightOutline14)),
      h('button', { key: 'reload', type: 'button', title: '刷新', 'aria-label': '刷新', disabled: !current, onClick: () => { if (current) apply(history, current, true) } }, h(IconRefreshOutline16)),
      h('div', { key: 'address', className: 'conductor-web-address' }, h('input', {
        id: addressId, type: 'url', inputMode: 'url', value: draft, autoComplete: 'off', spellCheck: false,
        'aria-label': '网页地址', title: current || draft, placeholder: 'https://example.com',
        onChange: (event: ChangeEvent<HTMLInputElement>) => { setDraft(event.currentTarget.value); setError('') },
      })),
      current ? h('a', { key: 'external', href: current, target: '_blank', rel: 'noreferrer', title: '浏览器打开', 'aria-label': '浏览器打开' }, h(IconRightUpOutline16)) : null,
    ]),
    error ? h('p', { key: 'error', role: 'status', className: 'conductor-web-error' }, error) : null,
    current ? h('iframe', {
      key: current + ':' + String(generation), className: 'conductor-web-frame', src: current, title: props.title,
      sandbox: WEB_PREVIEW_SANDBOX, referrerPolicy: 'strict-origin-when-cross-origin',
    }) : h('p', { key: 'empty', className: 'conductor-web-error' }, '当前没有可预览的网页。'),
  ])
}
