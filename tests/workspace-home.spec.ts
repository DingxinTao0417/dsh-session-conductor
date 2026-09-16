import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceHome } from '../src/client-workspace.ts'

describe('workspace navigation home', () => {
  it('renders the supplied resource counts and only available workspace destinations', () => {
    const open = vi.fn(), tools = vi.fn()
    const markup = renderToStaticMarkup(h(WorkspaceHome, {
      outputs: [{ kind: 'file', path: 'report.md', title: 'Report' }],
      sources: [{ kind: 'url', url: 'https://example.com/docs', title: 'Docs' }, { kind: 'attachment', attachmentId: 'image-1', title: 'Reference' }],
      open, tools,
    }))
    expect(markup).toContain('aria-label="1 项"')
    expect(markup).toContain('aria-label="2 项"')
    for (const label of ['输出文件', '来源', '网页预览', '终端', '工具详情']) expect(markup).toContain(label)
    expect(markup).not.toMatch(/侧边聊天|审查|<iframe|<form|<a /)
    expect(markup).not.toContain('只读查看当前会话的文件与来源。')
    expect(open).not.toHaveBeenCalled()
    expect(tools).not.toHaveBeenCalled()
  })

  it('keeps zero-resource collections available and makes the whole row a focusable button', () => {
    const markup = renderToStaticMarkup(h(WorkspaceHome, { outputs: [], sources: [], open() {}, tools() {} }))
    const buttons = [...markup.matchAll(/<button[^>]*class="conductor-workspace-entry"[^>]*>(.*?)<\/button>/g)]
    expect(buttons).toHaveLength(5)
    expect(markup.match(/aria-label="0 项"/g)).toHaveLength(2)
    expect(markup).not.toContain('disabled')
    for (const button of buttons) {
      expect(button[0]).toContain('type="button"')
      expect(button[1]).toContain('<svg')
      expect(button[1]).toContain('conductor-workspace-entry-label')
      expect(button[1]).not.toContain('<button')
    }
    expect(markup).not.toContain('只读查看当前会话的文件与来源。')
    const style = markup.match(/<style>(.*?)<\/style>/)?.[1] ?? ''
    expect(style).toContain('height:44px')
    expect(style).toContain('width:min(100%,420px)')
  })
})
