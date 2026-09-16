import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { SessionOverviewCard } from '../src/client-overview.ts'
import type { OverviewPort } from '../src/overview-client-data.ts'

afterEach(() => vi.unstubAllGlobals())

const port: OverviewPort = {
  subscribe: () => () => {}, action: async () => ({}), acknowledge: async () => {},
  result: async () => ({ text: '', truncated: false, turn: 1 }), refresh: async () => {}, close: () => {},
  preview: async (_sessionId, input) => ({ path: input.path, text: '', truncated: false, kind: 'text' }),
  openTerminal: async () => ({ id: 'pty', cwd: '/', shell: 'bash' }),
  writeTerminal: async () => {}, closeTerminal: async () => {}, streamTerminal: async () => {},
}
const snapshot = { nodes: [
  { kind: 'tool-result', seq: 1, callView: { card: 'generic', kind: 'edit', locations: [{ path: 'docs/report.md' }] } },
  { kind: 'tool-result', seq: 2, resultView: { card: 'read', path: 'docs/source.md' } },
  { kind: 'user', seq: 3, content: [{ type: 'text', text: 'https://example.com/docs' }, { type: 'image', attachment: { attachmentId: 'attachment-1', name: 'reference.png' } }] },
], hasMore: false } as unknown as ConversationSnapshot
function render() {
  return renderToStaticMarkup(h(SessionOverviewCard, {
    sessionId: 'parent', port, sessions: { open: async () => {}, list: { getSnapshot: () => ({ ids: ['parent'] }) } },
    useSession: selector => selector(snapshot), onPreview: () => {},
  }))
}

describe('persistent conversation overview card', () => {
  it('is visible despite an old closed preference and provides no card close control', () => {
    const getItem = vi.fn(() => 'closed'), setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem, setItem })
    const markup = render()
    expect(markup).toContain('<aside class="conductor-overview"')
    expect(markup).toContain('aria-label="当前会话概览"')
    expect(markup).not.toMatch(/conductor-overview-trigger|收起会话概览|关闭会话概览/)
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('puts each resource icon, title and remaining row area inside one preview button', () => {
    const markup = render()
    const rowButtons = [...markup.matchAll(/<button[^>]*class="conductor-overview-item"[^>]*>(.*?)<\/button>/g)].map(match => match[1]!)
    expect(rowButtons).toHaveLength(4)
    for (const title of ['report.md', 'source.md', 'example.com/docs', 'reference.png']) {
      const row = rowButtons.find(value => value.includes(title))
      expect(row).toContain('<svg')
      expect(row).toContain('class="conductor-overview-item-label"')
      expect(row).not.toContain('<button')
    }
    expect(markup).not.toContain('target="_blank"')
  })

  it('provides distinct output and source collection previews while retaining task creation', () => {
    const markup = render()
    expect(markup).toContain('title="在右侧查看输出内容"')
    expect(markup).toContain('title="在右侧查看来源"')
    expect(markup).toContain('新建任务')
    expect(markup).toContain('<details class="conductor-overview-section" open=""')
  })

  it('collapses wide dock height and hides the overview below the wide breakpoint', () => {
    const markup = render()
    const style = (markup.match(/<style>(.*?)<\/style>/)?.[1] ?? '').replace(/&gt;/g, '>').replace(/\\u003e/gi, '>')
    const wide = style.match(/\.conductor-overview-dock\[data-layout=wide\]\{[^}]+\}/)?.[0] ?? ''
    const wideCard = style.match(/\.conductor-overview-dock\[data-layout=wide\]>\.conductor-overview\{[^}]+\}/)?.[0] ?? ''
    const hidden = style.match(/\.conductor-overview-dock\[data-layout=hidden\]\{[^}]+\}/)?.[0] ?? ''
    expect(wide).toMatch(/height:0/)
    expect(wide).toMatch(/min-height:0/)
    expect(wide).toMatch(/max-height:0/)
    expect(wide).toMatch(/flex:0 0 0/)
    expect(wide).toMatch(/overflow:visible/)
    expect(wide).toMatch(/align-self:stretch/)
    expect(wide).toMatch(/z-index:30/)
    expect(wideCard).toMatch(/position:absolute/)
    expect(wideCard).toMatch(/right:16px/)
    expect(wideCard).toMatch(/pointer-events:auto/)
    expect(hidden).toMatch(/display:none/)
    expect(style).not.toMatch(/\.conductor-overview-dock\[data-layout=compact\]/)
    expect(style).not.toMatch(/padding-right:354px|padding-right:\s*330px/)
  })
})
