import { createElement as h, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactElement } from 'react'

const CSS = [
  '.conductor-terminal{flex:1;min-height:0;display:flex;flex-direction:column;background:#1e1e1e;color:#d4d4d4}',
  '.conductor-terminal-screen{flex:1;min-height:0;margin:0;padding:16px 18px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;outline:none;cursor:text;font:13px/1.45 ui-monospace,Consolas,monospace!important}',
  '.conductor-terminal-error{margin:16px 18px;padding:14px;border-radius:10px;background:#3d2a12;color:#f0d9b5;font-size:13px}',
].join('')

const ptyByTab = new Map<string, string>()

export function releaseTerminalTab(tabId: string, close: (id: string) => void): void {
  const id = ptyByTab.get(tabId)
  if (!id) return
  ptyByTab.delete(tabId)
  close(id)
}

export function releaseTerminalTabs(tabIds: readonly string[], close: (id: string) => void): void {
  for (const tabId of tabIds) releaseTerminalTab(tabId, close)
}

/** Map a workspace key event onto PTY bytes. Browser shortcuts are left to the page. */
export function encodeTerminalKey(event: Pick<KeyboardEvent<HTMLElement>, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): string | undefined {
  if (event.altKey || event.metaKey) return
  if (event.ctrlKey) {
    if (event.key === 'v' || event.key === 'V') return
    if (event.key.length === 1) {
      const code = event.key.toUpperCase().charCodeAt(0)
      if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
    }
    return
  }
  if (event.key === 'Enter') return '\r'
  if (event.key === 'Backspace') return '\x7f'
  if (event.key === 'Tab') return '\t'
  if (event.key === 'Escape') return '\x1b'
  if (event.key === 'ArrowUp') return '\x1b[A'
  if (event.key === 'ArrowDown') return '\x1b[B'
  if (event.key === 'ArrowRight') return '\x1b[C'
  if (event.key === 'ArrowLeft') return '\x1b[D'
  if (event.key === 'Home') return '\x1b[H'
  if (event.key === 'End') return '\x1b[F'
  if (event.key === 'Delete') return '\x1b[3~'
  if (event.key.length === 1) return event.key
}

/** Keep a bounded visible buffer; OSC/CSI are stripped so a shell banner stays readable. */
export function appendTerminalOutput(current: string, chunk: string, limit = 200_000): string {
  // oxlint-disable-next-line eslint/no-control-regex -- PTY OSC/CSI bytes, not user regex
  const cleaned = chunk.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?=]*[ -/]*[@-~]/g, '')
  let text = current
  for (const unit of cleaned) {
    if (unit === '\b') text = text.slice(0, -1)
    else if (unit === '\r') {
      const line = text.lastIndexOf('\n')
      text = text.slice(0, line + 1)
    } else text += unit
  }
  return text.length > limit ? text.slice(text.length - limit) : text
}

export interface WorkspaceTerminalPort {
  openTerminal(sessionId: string, size: { cols: number; rows: number }): Promise<{ id: string; cwd: string; shell: string }>
  writeTerminal(sessionId: string, id: string, data: string): Promise<void>
  closeTerminal(sessionId: string, id: string): Promise<void>
  streamTerminal(sessionId: string, id: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void>
}

/** Session-cwd PTY view. The Host owns the process; this surface only streams text. */
export function WorkspaceTerminal(props: { tabId: string; sessionId: string; port: WorkspaceTerminalPort }): ReactElement {
  const screen = useRef<HTMLPreElement>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const start = async (): Promise<void> => {
      let id = ptyByTab.get(props.tabId)
      if (!id) {
        const opened = await props.port.openTerminal(props.sessionId, { cols: 120, rows: 32 })
        if (!active) {
          await props.port.closeTerminal(props.sessionId, opened.id).catch(() => undefined)
          return
        }
        id = opened.id
        ptyByTab.set(props.tabId, id)
      }
      await props.port.streamTerminal(props.sessionId, id, chunk => {
        if (!active) return
        setText(current => appendTerminalOutput(current, chunk))
      }, controller.signal)
    }
    void start().catch(cause => {
      if (active && cause instanceof Error && cause.name !== 'AbortError') setError(cause.message)
    })
    return () => { active = false; controller.abort() }
  }, [props.port, props.sessionId, props.tabId])
  useEffect(() => {
    const node = screen.current
    if (node) node.scrollTop = node.scrollHeight
  }, [text])
  useEffect(() => { if (!error) screen.current?.focus({ preventScroll: true }) }, [error])
  const send = (data: string): void => {
    const id = ptyByTab.get(props.tabId)
    if (!id) return
    void props.port.writeTerminal(props.sessionId, id, data).catch(cause => {
      setError(cause instanceof Error ? cause.message : '无法向终端写入。')
    })
  }
  return h('div', { className: 'conductor-terminal', 'aria-label': '工作区终端' }, [
    h('style', { key: 'style' }, CSS),
    error ? h('p', { key: 'error', role: 'status', className: 'conductor-terminal-error' }, error)
      : h('pre', {
        key: 'screen', ref: screen, className: 'conductor-terminal-screen', tabIndex: 0,
        onClick: () => screen.current?.focus(),
        onPaste: (event: ClipboardEvent<HTMLPreElement>) => {
          const pasted = event.clipboardData?.getData('text')
          if (!pasted) return
          event.preventDefault()
          send(pasted.replace(/\r?\n/g, '\r'))
        },
        onKeyDown: (event: KeyboardEvent<HTMLPreElement>) => {
          const data = encodeTerminalKey(event)
          if (!data) return
          event.preventDefault()
          send(data)
        },
      }, text || '正在连接工作区终端…'),
  ])
}
