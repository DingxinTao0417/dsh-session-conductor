import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SubagentsSummary, SubagentsView, subagentDuration } from '../src/client-subagents.ts'
import type { SubagentsPort, SubagentsRead } from '../src/client-subagents-data.ts'

function fixture(read: SubagentsRead): SubagentsPort {
  return { getSnapshot: () => read, subscribe: vi.fn(() => () => {}), refresh: vi.fn(async () => {}), open: vi.fn(async () => {}), close: vi.fn() }
}
const ready: SubagentsRead = { parentId: 'p', state: 'ready', items: [
  { id: 'live', title: '界面检查', mode: 'one-shot', activity: 'running', statusLabel: '运行中', durationMs: 192000 },
  { id: 'idle', title: '<script>不执行</script>', mode: 'continuable', activity: 'inactive', statusLabel: '当前未运行' },
  { id: 'bad', title: '记录损坏', activity: 'unavailable', statusLabel: '记录不可用' },
] }

describe('native subagent overview and sidebar', () => {
  it('keeps running, inactive and unavailable counts separate without declaring success', () => {
    const port = fixture(ready), open = vi.fn()
    const html = renderToStaticMarkup(h(SubagentsSummary, { port, parentId: 'p', open }))
    expect(html).toContain('1 个运行中')
    expect(html).toContain('1 已结束 / 空闲')
    expect(html).toContain('1 个记录不可用')
    expect(html).not.toContain('完成')
    expect(open).not.toHaveBeenCalled()
    expect(port.open).not.toHaveBeenCalled()
    expect(port.refresh).not.toHaveBeenCalled()
  })
  it('groups truthful statuses, escapes names, and only disables diagnostic navigation', () => {
    const html = renderToStaticMarkup(h(SubagentsView, { port: fixture(ready), parentId: 'p' }))
    expect(html.indexOf('运行中 · 1')).toBeLessThan(html.indexOf('已结束 / 空闲 · 1'))
    expect(html).toContain('3m 12s')
    expect(html).toContain('&lt;script&gt;不执行&lt;/script&gt;')
    expect(html).toContain('disabled="" title="记录损坏"')
    expect(html).toContain('不代表成功完成')
  })
  it('bounds the first render and offers another page without silently truncating counts', () => {
    const read: SubagentsRead = { ...ready, items: Array.from({ length: 42 }, (_, i) => ({ ...ready.items[1]!, id: String(i), title: '任务 ' + String(i) })) }
    const html = renderToStaticMarkup(h(SubagentsView, { port: fixture(read), parentId: 'p' }))
    expect(html).toContain('已结束 / 空闲 · 42')
    expect(html.match(/class="conductor-subagent-row"/g)).toHaveLength(10)
    expect(html).toContain('再显示 30 个')
  })
  it('never reports zero as a successful fetch when capability or catalog is unavailable', () => {
    for (const state of ['loading', 'unavailable', 'error'] as const) {
      const html = renderToStaticMarkup(h(SubagentsSummary, { port: fixture({ parentId: 'p', state, items: [] }), parentId: 'p', open: vi.fn() }))
      expect(html).not.toContain('0 个运行中')
      expect(html).not.toContain('0 已结束')
    }
  })
  it('does not substitute another parent’s rows on session changes', () => {
    const read: SubagentsRead = { parentId: 'other', state: 'ready', items: [] }
    const port = fixture(read)
    port.getSnapshot = id => id === 'p' ? ready : read
    expect(renderToStaticMarkup(h(SubagentsView, { port, parentId: 'other' }))).not.toContain('界面检查')
  })
  it('omits missing or invalid timing and formats cumulative execution time', () => {
    for (const value of [undefined, NaN, Infinity, -1]) expect(subagentDuration(value)).toBeUndefined()
    expect(subagentDuration(0)).toBe('0s')
    expect(subagentDuration(3662000)).toBe('1h 1m')
  })
})
