import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionOverview, OverviewOutput } from '../src/domain/overview.ts'
import { sidebarHome, SidebarButton } from '../src/client-sidebar.ts'
import type { OverviewPort } from '../src/overview-client-data.ts'
import type { PreviewController, PreviewState } from '../src/client-preview.ts'

function data(sessionId: string, outputs: readonly OverviewOutput[] = []): SessionOverview {
  return { sessionId, generatedAt: '', outputs, tasks: [], receipts: [], unread: 0, needsAttention: 0, watchingTaskIds: [], sharedDirectories: [], truncated: false }
}
const output = (value: Partial<OverviewOutput>): OverviewOutput => ({ id: 'artifact', taskId: 'task', title: 'Artifact', existence: 'unverified', acceptance: 'unreviewed', local: true, ...value })
const snapshot = { nodes: [
  { kind: 'tool-result', seq: 1, callView: { card: 'generic', kind: 'edit', locations: [{ path: 'report.md' }] } },
  { kind: 'tool-result', seq: 2, resultView: { card: 'read', path: 'reference.md' } },
  { kind: 'user', seq: 3, content: [{ type: 'text', text: 'https://example.com/docs' }, { type: 'image', attachment: { attachmentId: 'image-1', name: 'Reference image' } }] },
  { kind: 'tool-result', seq: 4, resultView: { card: 'web', kind: 'search', sources: [{ url: 'javascript:alert(1)', title: 'unsafe' }, { url: 'https://user:secret@example.com', title: 'credentialed' }] } },
  { kind: 'assistant', seq: 5, blocks: [{ type: 'reasoning', text: 'https://private.example/' }] },
] } as unknown as ConversationSnapshot

describe('current-session sidebar resource projection', () => {
  it('projects public current-session resources and authorized local artifacts without copying remote paths', () => {
    const target = sidebarHome('parent', snapshot, { sessionId: 'parent', data: data('parent', [
      output({ id: 'duplicate', path: 'report.md', sessionId: 'parent' }),
      output({ id: 'child', path: 'child.md', sessionId: 'child' }),
      output({ id: 'remote', local: false, path: '/private/remote.txt', sessionId: 'remote' }),
      output({ id: 'web', local: false, url: 'https://example.com/result', title: 'Public result' }),
      output({ id: 'invalid', local: false, url: 'javascript:alert(1)' }),
    ]) })
    expect(target).toEqual({ kind: 'workspace', title: '工作区', outputs: [
      { kind: 'file', path: 'report.md', title: 'report.md', sessionId: 'parent' },
      { kind: 'file', path: 'child.md', title: 'Artifact', sessionId: 'child' },
      { kind: 'url', url: 'https://example.com/result', title: 'Public result' },
    ], sources: [
      { kind: 'file', path: 'reference.md', title: 'reference.md', sessionId: 'parent' },
      { kind: 'url', url: 'https://example.com/docs', title: 'example.com/docs' },
      { kind: 'attachment', attachmentId: 'image-1', title: 'Reference image' },
    ] })
    expect(JSON.stringify(target)).not.toMatch(/private|secret|javascript|remote.txt/)
  })

  it('discards another session response including a mismatched inner payload', () => {
    for (const read of [
      { sessionId: 'other', data: data('other', [output({ path: 'private.md' })]) },
      { sessionId: 'parent', data: data('other', [output({ path: 'private.md' })]) },
    ]) {
      const target = sidebarHome('parent', snapshot, read)
      expect(JSON.stringify(target)).not.toContain('private.md')
      expect(target).toMatchObject({ outputs: [{ path: 'report.md', sessionId: 'parent' }] })
    }
  })

  it('uses empty resource lists when the current conversation has no public resources', () => {
    expect(sidebarHome('parent', undefined, { sessionId: 'parent' })).toEqual({ kind: 'workspace', title: '工作区', outputs: [], sources: [] })
  })
})

describe('native sidebar header button', () => {
  function render(owner?: string) {
    const target = { kind: 'workspace' as const, title: '工作区', outputs: [], sources: [] }
    const state: PreviewState | undefined = owner ? { owner, revision: 1, target, tabs: [{ id: 'tab-1', owner, target }], activeId: 'tab-1' } : undefined
    const controller: PreviewController = { registerSurface: vi.fn(() => () => {}), registerHome: vi.fn(() => () => {}), home: vi.fn(), subscribe: vi.fn(() => () => {}),
      getSnapshot: () => state, tools: vi.fn(), open: vi.fn(), activate: vi.fn(), closeTab: vi.fn(), close: vi.fn(), navigate: vi.fn(), dispose: vi.fn() }
    const port = { subscribe: vi.fn(() => () => {}) } as unknown as OverviewPort
    const useSession = vi.fn()
    const hook = <T,>(selector: (value: ConversationSnapshot) => T): T => { useSession(selector); return selector(snapshot) }
    const markup = renderToStaticMarkup(h(SidebarButton, { sessionId: 'parent', controller, port, useSession: hook }))
    return { markup, controller, port, useSession }
  }

  it('is visible, keyboard accessible and does not query resources or open anything during render', () => {
    const f = render()
    expect(f.markup).toContain('type="button"')
    expect(f.markup).toContain('aria-label="打开右侧栏"')
    expect(f.markup).toContain('title="打开右侧栏"')
    expect(f.markup).toContain('aria-expanded="false"')
    expect(f.markup).toContain('<svg')
    expect(f.markup).not.toMatch(/hidden|disabled|<iframe/)
    expect(f.port.subscribe).not.toHaveBeenCalled()
    expect(f.controller.home).not.toHaveBeenCalled()
    expect(f.controller.open).not.toHaveBeenCalled()
    expect(f.useSession).toHaveBeenCalledWith(expect.any(Function))
  })

  it('shows the close state only for the pane owned by this session', () => {
    expect(render('parent').markup).toContain('aria-label="关闭右侧栏"')
    expect(render('parent').markup).toContain('aria-expanded="true"')
    expect(render('other').markup).toContain('aria-label="打开右侧栏"')
    expect(render('other').markup).toContain('aria-expanded="false"')
  })

  it('yields the header slot to the pane toggle while the owned workspace is open', () => {
    const style = (render().markup.match(/<style>(.*?)<\/style>/)?.[1] ?? '').replace(/&quot;/g, '"')
    expect(style).toContain('[data-conductor-workspace-open="true"] .conductor-sidebar-control{display:none}')
  })
})
