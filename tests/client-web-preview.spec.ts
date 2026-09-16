import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { commitWebNavigation, stepWebHistory, WEB_PREVIEW_SANDBOX, WebPreview } from '../src/client-web-preview.ts'

describe('embedded web preview navigation', () => {
  it('pushes a safe address, reloads the current page, and steps through history', () => {
    const first = { pages: ['https://example.com/'], index: 0 }
    const pushed = commitWebNavigation(first, 'example.org/docs')
    expect(pushed).toEqual({
      history: { pages: ['https://example.com/', 'https://example.org/docs'], index: 1 },
      url: 'https://example.org/docs',
      mode: 'push',
    })
    expect(commitWebNavigation(pushed!.history, 'https://example.org/docs')).toMatchObject({ mode: 'reload', url: 'https://example.org/docs' })
    expect(stepWebHistory(pushed!.history, -1)).toEqual({ history: { pages: pushed!.history.pages, index: 0 }, url: 'https://example.com/' })
    expect(stepWebHistory(first, -1)).toBeUndefined()
    expect(stepWebHistory(first, 1)).toBeUndefined()
    expect(commitWebNavigation(first, 'javascript:alert(1)')).toBeUndefined()
    expect(commitWebNavigation(first, 'https://user:secret@example.com/')).toBeUndefined()
  })

  it('renders a chrome bar and sandboxed iframe without executing the address as a document', () => {
    const markup = renderToStaticMarkup(h(WebPreview, {
      tabId: 'tab-1', url: 'https://example.com/docs', title: 'example.com', navigate: vi.fn(),
    }))
    expect(markup).toContain('aria-label="内嵌网页预览"')
    expect(markup).toContain('aria-label="后退"')
    expect(markup).toContain('aria-label="前进"')
    expect(markup).toContain('aria-label="刷新"')
    expect(markup).toContain('aria-label="网页地址"')
    expect(markup).toContain('aria-label="浏览器打开"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('src="https://example.com/docs"')
    expect(markup).toContain('sandbox="' + WEB_PREVIEW_SANDBOX + '"')
    expect(markup).toContain('referrerPolicy="strict-origin-when-cross-origin"')
    expect(markup).not.toContain('javascript:')
  })
})
