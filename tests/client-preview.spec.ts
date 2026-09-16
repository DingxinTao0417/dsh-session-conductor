import { createElement as h, type ComponentType, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreviewController, observePreviewLayout, previewMarkdown, type PreviewClientContext } from '../src/client-preview.ts'
import type { OverviewPort } from '../src/overview-client-data.ts'

const port: OverviewPort = {
  subscribe: () => () => {}, action: async () => ({}), acknowledge: async () => {},
  result: async () => ({ text: '', truncated: false, turn: 1 }), refresh: async () => {}, close: () => {},
  preview: async (_sessionId, input) => ({ path: input.path, text: '', truncated: false, kind: 'text' }),
  openTerminal: async () => ({ id: 'pty', cwd: 'D:/workspace', shell: 'powershell' }),
  writeTerminal: async () => {}, closeTerminal: async () => {}, streamTerminal: async () => {},
}

afterEach(() => vi.unstubAllGlobals())

describe('Desktop preview drawer viewport', () => {
  function geometry() {
    const state = { top: 36, bottom: 798, height: 798, width: 0 }
    const listeners = new Map<string, () => void>(), observed: unknown[] = []
    const disconnect = vi.fn()
    let resized: (() => void) | undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe(element: unknown) { observed.push(element) }
      disconnect = disconnect
    })
    const viewport = { get innerHeight() { return state.height },
      addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
      removeEventListener: (event: string, callback: () => void) => { if (listeners.get(event) === callback) listeners.delete(event) },
    }
    const root = { getBoundingClientRect: () => ({ top: state.top, bottom: state.bottom }) }
    const element = { ownerDocument: { defaultView: viewport }, closest: vi.fn(() => root),
      getBoundingClientRect: () => ({ width: state.width }) } as unknown as HTMLElement
    const publish = vi.fn()
    const stop = observePreviewLayout(element, publish)
    return { state, listeners, observed, root, element, publish, stop, disconnect, resize: () => resized?.() }
  }

  it('keeps the floating toolbar below actual Desktop chrome instead of the page origin', () => {
    const f = geometry()
    expect(f.publish).toHaveBeenLastCalledWith({ floating: true, top: 36, bottom: 0 })
    expect(f.observed).toEqual([f.element, f.root])
    f.state.top = 52; f.state.bottom = 780; f.resize()
    expect(f.publish).toHaveBeenLastCalledWith({ floating: true, top: 52, bottom: 18 })
    f.stop()
  })

  it('returns to the native pane on expansion and recomputes insets on window resize', () => {
    const f = geometry()
    f.state.width = 360; f.resize()
    expect(f.publish).toHaveBeenLastCalledWith({ floating: false, top: 36, bottom: 0 })
    f.state.width = 0; f.state.top = 0; f.state.bottom = 600; f.state.height = 600
    f.listeners.get('resize')?.()
    expect(f.publish).toHaveBeenLastCalledWith({ floating: true, top: 0, bottom: 0 })
    f.stop()
  })

  it('releases both observers and window listeners when the preview closes or switches sessions', () => {
    const f = geometry()
    expect(f.listeners.has('resize')).toBe(true)
    f.stop()
    expect(f.disconnect).toHaveBeenCalledOnce()
    expect(f.listeners.size).toBe(0)
  })
})

function fixture(options: { ready?: boolean; layout?: boolean } = {}) {
  type Entry = { options: { name: string; id?: string; priority?: number }; component: (props: never) => ReactElement | null }
  const entries = new Set<Entry>(), layout = { openDetails: vi.fn(), closeDetails: vi.fn() }
  let activate: (() => (() => void)) | undefined, release: (() => void) | undefined
  const injectionDispose = vi.fn(() => { release?.(); release = undefined })
  const register = vi.fn((registration: Entry['options'], component: Entry['component']) => {
    const entry = { options: registration, component }
    entries.add(entry)
    return () => { entries.delete(entry) }
  })
  const inject = vi.fn((_key: string, effect: () => (() => void)) => {
    activate = effect
    if (options.ready !== false) release = effect()
    return injectionDispose
  })
  const ctx: PreviewClientContext = { slots: { register, inject }, get: name => name === 'layout' && options.layout !== false ? layout : undefined }
  const controller = createPreviewController(ctx, port)
  return {
    controller, entries, layout, inject, register, injectionDispose,
    ready: () => { release = activate?.() },
    unavailable: () => { release?.(); release = undefined },
    render: (sessionId: string) => {
      const entry = [...entries][0]
      return entry ? renderToStaticMarkup(h(entry.component as ComponentType<{ sessionId: string }>, { sessionId })) : ''
    },
  }
}

describe('native content preview lifecycle', () => {
  const ownedSurface = () => ({ content: {} as HTMLElement, setOpen: vi.fn(), dispose: vi.fn() })
  it('uses an owned wide workspace and closes the native column instead of registering over it', () => {
    const f = fixture(), surface = ownedSurface()
    const release = f.controller.registerSurface('parent', surface)
    expect(surface.setOpen).not.toHaveBeenCalled()
    f.controller.home('parent')
    expect(surface.setOpen).toHaveBeenLastCalledWith(true)
    expect(f.layout.closeDetails).toHaveBeenCalledOnce()
    expect(f.layout.openDetails).not.toHaveBeenCalled()
    expect(f.register).not.toHaveBeenCalled()
    f.controller.open('parent', { kind: 'subagents', title: '子智能体' })
    expect(f.controller.getSnapshot()?.target.kind).toBe('subagents')
    f.controller.close()
    expect(surface.setOpen).toHaveBeenLastCalledWith(false)
    expect(f.controller.getSnapshot()).toBeUndefined()
    release(); f.controller.dispose()
  })
  it('restores native tools, hides the previous owner on switch, and releases on teardown', () => {
    const f = fixture(), parent = ownedSurface(), child = ownedSurface()
    f.controller.registerSurface('parent', parent)
    const releaseChild = f.controller.registerSurface('child', child)
    f.controller.home('parent'); f.controller.home('child')
    expect(parent.setOpen).toHaveBeenLastCalledWith(false)
    expect(child.setOpen).toHaveBeenLastCalledWith(true)
    f.controller.tools()
    expect(child.setOpen).toHaveBeenLastCalledWith(false)
    expect(f.layout.openDetails).toHaveBeenCalledOnce()
    expect(f.controller.getSnapshot()).toBeUndefined()
    f.controller.home('child'); releaseChild()
    expect(f.controller.getSnapshot()).toBeUndefined()
    f.controller.home('parent'); f.controller.dispose()
    expect(parent.setOpen).toHaveBeenLastCalledWith(false)
    const late = ownedSurface()
    f.controller.registerSurface('parent', late)()
    expect(late.setOpen).not.toHaveBeenCalled()
  })
  it('ignores obsolete surface cleanup after replacement and preserves the active target', () => {
    const f = fixture(), old = ownedSurface(), replacement = ownedSurface()
    const releaseOld = f.controller.registerSurface('parent', old)
    f.controller.home('parent')
    f.controller.registerSurface('parent', replacement)
    expect(old.setOpen).toHaveBeenLastCalledWith(false)
    releaseOld()
    expect(replacement.setOpen).toHaveBeenLastCalledWith(true)
    expect(f.controller.getSnapshot()?.owner).toBe('parent')
    f.controller.dispose()
  })
  it('opens the subagent target on demand and restores native details on close', () => {
    const f = fixture()
    f.controller.open('parent', { kind: 'subagents', title: '子智能体' })
    const markup = f.render('parent')
    expect(markup).toContain('当前宿主未提供子智能体目录')
    expect(markup).toContain('打开工作区首页')
    // The pane carries the same sidebar toggle in its tab row instead of a separate close glyph.
    expect(markup).toContain('class="conductor-preview-pane-toggle"')
    expect(markup).toContain('aria-label="关闭右侧栏"')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).not.toContain('conductor-preview-pane-close')
    expect(markup).toMatch(/role="tablist"[^>]*aria-label="工作区标签"/)
    expect(f.render('other')).toBe('')
    expect(f.entries.size).toBe(1)
    f.controller.close()
    expect(f.entries.size).toBe(0)
    f.controller.dispose()
  })
  it('reads the latest home resources on each explicit home action and isolates the selected owner', () => {
    const f = fixture()
    let outputs = [{ kind: 'file' as const, path: 'first.md', title: 'First', sessionId: 'parent' }]
    const parentHome = vi.fn(() => ({ kind: 'workspace' as const, title: 'Parent workspace', outputs, sources: [] }))
    const childHome = vi.fn(() => ({ kind: 'workspace' as const, title: 'Child workspace', outputs: [], sources: [{ kind: 'url' as const, url: 'https://example.com/', title: 'Child source' }] }))
    f.controller.registerHome('parent', parentHome)
    f.controller.registerHome('child', childHome)
    expect(parentHome).not.toHaveBeenCalled()
    f.controller.home('parent')
    expect(f.controller.getSnapshot()).toMatchObject({ owner: 'parent', target: { kind: 'workspace', outputs: [{ path: 'first.md' }] } })
    expect(childHome).not.toHaveBeenCalled()
    expect(f.render('parent')).toContain('Parent workspace')
    expect(f.render('child')).toBe('')
    outputs = [{ kind: 'file', path: 'latest.md', title: 'Latest', sessionId: 'parent' }]
    f.controller.open('parent', { kind: 'file', path: 'first.md', title: 'First' })
    f.controller.home('parent')
    expect(f.controller.getSnapshot()?.target).toMatchObject({ outputs: [{ path: 'latest.md' }] })
    f.controller.home('child')
    expect(f.controller.getSnapshot()).toMatchObject({ owner: 'child', target: { outputs: [], sources: [{ title: 'Child source' }] } })
    expect(f.entries.size).toBe(1)
    expect(f.render('parent')).toBe('')
    f.controller.dispose()
  })

  it('does not let cleanup from a previous home registration remove its replacement', () => {
    const f = fixture()
    const old = vi.fn(() => ({ kind: 'workspace' as const, title: 'Old', outputs: [], sources: [] }))
    const current = vi.fn(() => ({ kind: 'workspace' as const, title: 'Current', outputs: [], sources: [] }))
    const removeOld = f.controller.registerHome('parent', old)
    const removeCurrent = f.controller.registerHome('parent', current)
    removeOld()
    f.controller.home('parent')
    expect(f.controller.getSnapshot()?.target.title).toBe('Current')
    expect(old).not.toHaveBeenCalled()
    removeCurrent()
    f.controller.home('parent')
    expect(f.controller.getSnapshot()?.target).toEqual({ kind: 'workspace', title: '工作区', outputs: [], sources: [] })
    expect(current).toHaveBeenCalledOnce()
    f.controller.dispose()
  })

  it('refreshes an already open home for its owner without reopening details or replacing a content preview', () => {
    const f = fixture(), listener = vi.fn()
    f.controller.registerHome('parent', () => ({ kind: 'workspace', title: 'Parent', outputs: [], sources: [] }))
    f.controller.home('parent')
    const count = f.layout.openDetails.mock.calls.length
    const unsubscribe = f.controller.subscribe(listener)
    f.controller.registerHome('parent', () => ({ kind: 'workspace', title: 'Parent', outputs: [{ kind: 'file', path: 'new.md', title: 'New' }], sources: [] }))
    expect(f.controller.getSnapshot()).toMatchObject({ owner: 'parent', target: { outputs: [{ path: 'new.md' }] } })
    expect(listener).toHaveBeenCalledOnce()
    expect(f.layout.openDetails).toHaveBeenCalledTimes(count)
    f.controller.registerHome('child', () => ({ kind: 'workspace', title: 'Child', outputs: [], sources: [] }))
    expect(listener).toHaveBeenCalledOnce()
    expect(f.controller.getSnapshot()?.owner).toBe('parent')
    f.controller.open('parent', { kind: 'file', path: 'new.md', title: 'New' })
    listener.mockClear()
    f.controller.registerHome('parent', () => ({ kind: 'workspace', title: 'Latest', outputs: [], sources: [] }))
    expect(listener).toHaveBeenCalledOnce()
    expect(f.controller.getSnapshot()?.target.kind).toBe('file')
    expect(f.controller.getSnapshot()?.tabs.find(tab => tab.target.kind === 'workspace')?.target.title).toBe('Latest')
    unsubscribe()
    f.controller.dispose()
    const readAfterDispose = vi.fn(() => ({ kind: 'workspace' as const, title: 'Disposed', outputs: [], sources: [] }))
    expect(() => f.controller.registerHome('parent', readAfterDispose)()).not.toThrow()
    expect(readAfterDispose).not.toHaveBeenCalled()
    expect(f.controller.getSnapshot()).toBeUndefined()
  })

  it('publishes home and close state, restores native tools without hiding details, and releases listeners', () => {
    const f = fixture(), listener = vi.fn()
    const unsubscribe = f.controller.subscribe(listener)
    expect(f.controller.getSnapshot()).toBeUndefined()
    f.controller.home('parent')
    expect(listener).toHaveBeenCalledOnce()
    f.controller.tools()
    expect(f.controller.getSnapshot()).toBeUndefined()
    expect(f.entries.size).toBe(0)
    expect(f.layout.closeDetails).not.toHaveBeenCalled()
    expect(f.layout.openDetails).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(2)
    f.controller.home('parent')
    f.controller.close()
    expect(f.controller.getSnapshot()).toBeUndefined()
    expect(f.layout.closeDetails).toHaveBeenCalledOnce()
    unsubscribe()
    listener.mockClear()
    f.controller.home('parent')
    expect(listener).not.toHaveBeenCalled()
    f.controller.dispose()
    expect(f.entries.size).toBe(0)
    expect(f.injectionDispose).toHaveBeenCalledOnce()
  })

  it('clears home providers on unload and refuses later workspace or tools navigation', () => {
    const f = fixture()
    const home = vi.fn(() => ({ kind: 'workspace' as const, title: 'Workspace', outputs: [], sources: [] }))
    f.controller.registerHome('parent', home)
    f.controller.home('parent')
    f.controller.dispose()
    const opens = f.layout.openDetails.mock.calls.length
    expect(() => f.controller.home('parent')).toThrow('当前宿主未提供右侧预览区域')
    expect(home).toHaveBeenCalledOnce()
    expect(() => f.controller.tools()).toThrow('当前宿主未提供右侧预览区域')
    expect(f.layout.openDetails).toHaveBeenCalledTimes(opens)
  })

  it('registers only on demand and releases the details override after close or dispose', () => {
    const f = fixture()
    expect(f.inject).toHaveBeenCalledWith('details', expect.any(Function))
    expect(f.register).not.toHaveBeenCalled()
    expect(f.entries.size).toBe(0)
    expect(f.layout.openDetails).not.toHaveBeenCalled()

    f.controller.open('parent', { kind: 'file', path: 'report.md', title: 'Report' })
    expect(f.register).toHaveBeenCalledWith({ name: 'details', id: 'conductor-content-preview', priority: -100 }, expect.any(Function))
    expect(f.entries.size).toBe(1)
    expect(f.layout.openDetails).toHaveBeenCalledTimes(1)
    expect(f.render('parent')).toContain('aria-label="右侧内容预览"')
    expect(f.render('other-session')).toBe('')

    f.controller.close()
    expect(f.entries.size).toBe(0)
    expect(f.layout.closeDetails).toHaveBeenCalledTimes(1)
    expect(f.render('parent')).toBe('')

    f.controller.open('parent', { kind: 'collection', title: 'Outputs', items: [] })
    expect(f.entries.size).toBe(1)
    expect(f.register).toHaveBeenCalledTimes(2)
    f.controller.dispose()
    expect(f.entries.size).toBe(0)
    expect(f.injectionDispose).toHaveBeenCalledTimes(1)
    expect(f.layout.closeDetails).toHaveBeenCalledTimes(1)
    expect(() => f.controller.open('parent', { kind: 'file', path: 'report.md', title: 'Report' })).toThrow('当前宿主未提供右侧预览区域')
  })

  it('keeps distinct preview targets as switchable tabs instead of replacing the previous one', () => {
    const f = fixture()
    f.controller.open('parent', { kind: 'collection', title: 'First collection', items: [
      { kind: 'file', path: 'first.md', title: 'First file' },
    ] })
    expect(f.render('parent')).toContain('First file')
    f.controller.open('parent', { kind: 'collection', title: 'Next collection', items: [
      { kind: 'url', url: 'https://example.com/docs', title: 'Official docs' },
    ] })
    expect(f.entries.size).toBe(1)
    expect(f.register).toHaveBeenCalledTimes(1)
    expect(f.controller.getSnapshot()?.tabs).toHaveLength(2)
    expect(f.render('parent')).toContain('Official docs')
    expect(f.render('parent')).toContain('First collection')
    const first = f.controller.getSnapshot()!.tabs[0]!
    f.controller.activate(first.id)
    expect(f.render('parent')).toContain('First file')
    f.controller.open('child', { kind: 'collection', title: 'Child sources', items: [] })
    expect(f.entries.size).toBe(1)
    expect(f.register).toHaveBeenCalledTimes(1)
    expect(f.render('parent')).toBe('')
    expect(f.render('child')).toContain('Child sources')
    f.controller.dispose()
  })

  it('reuses an identical target tab, closes one tab without dismissing the pane, and closes the pane with the last tab', () => {
    const f = fixture()
    f.controller.open('parent', { kind: 'file', path: 'a.md', title: 'A' })
    f.controller.open('parent', { kind: 'file', path: 'a.md', title: 'A' })
    expect(f.controller.getSnapshot()?.tabs).toHaveLength(1)
    f.controller.open('parent', { kind: 'file', path: 'b.md', title: 'B' })
    expect(f.controller.getSnapshot()?.tabs).toHaveLength(2)
    const [first, second] = f.controller.getSnapshot()!.tabs
    f.controller.closeTab(second!.id)
    expect(f.controller.getSnapshot()?.tabs).toEqual([expect.objectContaining({ id: first!.id })])
    expect(f.controller.getSnapshot()?.target).toMatchObject({ path: 'a.md' })
    f.controller.closeTab(first!.id)
    expect(f.controller.getSnapshot()).toBeUndefined()
    expect(f.layout.closeDetails).toHaveBeenCalled()
    f.controller.dispose()
  })

  it('keeps tabs across pane close and restores the previous active tab on reopen', () => {
    const f = fixture()
    f.controller.home('parent')
    f.controller.open('parent', { kind: 'file', path: 'a.md', title: 'A' })
    f.controller.open('parent', { kind: 'file', path: 'b.md', title: 'B' })
    const before = f.controller.getSnapshot()!
    expect(before.tabs.map(tab => tab.target)).toEqual([
      expect.objectContaining({ kind: 'workspace', title: '工作区' }),
      expect.objectContaining({ path: 'a.md' }),
      expect.objectContaining({ path: 'b.md' }),
    ])
    f.controller.close()
    expect(f.controller.getSnapshot()).toBeUndefined()
    f.controller.home('parent')
    const restored = f.controller.getSnapshot()!
    expect(restored.tabs.map(tab => tab.target)).toEqual(before.tabs.map(tab => tab.target))
    expect(restored.target).toMatchObject({ path: 'b.md' })
    f.controller.activate(restored.tabs[0]!.id)
    f.controller.close()
    f.controller.open('parent', { kind: 'file', path: 'c.md', title: 'C' })
    expect(f.controller.getSnapshot()?.tabs.map(tab => tab.target)).toEqual([
      expect.objectContaining({ kind: 'workspace' }),
      expect.objectContaining({ path: 'a.md' }),
      expect.objectContaining({ path: 'b.md' }),
      expect.objectContaining({ path: 'c.md' }),
    ])
    expect(f.controller.getSnapshot()?.target).toMatchObject({ path: 'c.md' })
    f.controller.home('child')
    expect(f.controller.getSnapshot()).toMatchObject({ owner: 'child', target: { kind: 'workspace' } })
    expect(f.controller.getSnapshot()?.tabs).toHaveLength(1)
    f.controller.close()
    f.controller.home('parent')
    expect(f.controller.getSnapshot()?.owner).toBe('parent')
    expect(f.controller.getSnapshot()?.target).toMatchObject({ path: 'c.md' })
    const remaining = [...f.controller.getSnapshot()!.tabs]
    for (const tab of remaining) f.controller.closeTab(tab.id)
    expect(f.controller.getSnapshot()).toBeUndefined()
    f.controller.home('parent')
    expect(f.controller.getSnapshot()?.tabs).toHaveLength(1)
    expect(f.controller.getSnapshot()?.target.kind).toBe('workspace')
    f.controller.dispose()
  })

  it('renders an embedded web chrome and navigates the current url tab in place', () => {
    const f = fixture()
    f.controller.open('parent', { kind: 'url', url: 'https://example.com/', title: 'example.com' })
    const markup = f.render('parent')
    expect(markup).toContain('aria-label="内嵌网页预览"')
    expect(markup).toContain('src="https://example.com/"')
    expect(markup).toContain('aria-label="浏览器打开"')
    expect(markup).toContain('内嵌预览 · 站点禁止嵌入时请用外部浏览器打开')
    f.controller.navigate('https://example.org/docs')
    expect(f.controller.getSnapshot()?.tabs).toHaveLength(1)
    expect(f.controller.getSnapshot()?.target).toMatchObject({ kind: 'url', url: 'https://example.org/docs', title: 'example.org' })
    f.controller.navigate('javascript:alert(1)')
    expect(f.controller.getSnapshot()?.target).toMatchObject({ url: 'https://example.org/docs' })
    f.controller.dispose()
  })

  it('refuses a missing details capability without reserving a blank panel, then recovers when available', () => {
    const f = fixture({ ready: false })
    const open = () => f.controller.open('parent', { kind: 'collection', title: 'Outputs', items: [] })
    expect(open).toThrow('当前宿主未提供右侧预览区域')
    expect(f.register).not.toHaveBeenCalled()
    expect(f.layout.openDetails).not.toHaveBeenCalled()
    f.ready()
    open()
    expect(f.entries.size).toBe(1)
    f.unavailable()
    expect(f.entries.size).toBe(0)
    expect(f.layout.closeDetails).not.toHaveBeenCalled()
    expect(open).toThrow('当前宿主未提供右侧预览区域')
    f.controller.dispose()
  })

  it('refuses a missing layout capability explicitly before adding a details override', () => {
    const f = fixture({ layout: false })
    expect(() => f.controller.open('parent', { kind: 'file', path: 'report.md', title: 'Report' })).toThrow('当前宿主未提供右侧预览区域')
    expect(f.register).not.toHaveBeenCalled()
    expect(f.entries.size).toBe(0)
    f.controller.dispose()
  })
})

describe('safe Markdown preview', () => {
  const render = (text: string) => renderToStaticMarkup(h('article', {}, previewMarkdown(text)))

  it('consumes empty headings and preserves following content without getting stuck', () => {
    const markup = render('# \n##\t\n### \t\n\nAfter empty headings')
    expect(markup).toContain('<h1></h1><h2></h2><h3></h3>')
    expect(markup).toContain('After empty headings</p>')
    expect(previewMarkdown('# ')).toHaveLength(1)
  })

  it('consumes unmatched block-like text even when a Unicode separator prevents a heading match', () => {
    const markup = render('## before\u2028after\nNext line\n\n#')
    expect(markup).toContain('## before\u2028after\nNext line</p>')
    expect(markup).toContain('>#</p>')
  })

  it('renders the supported formatting while escaping HTML and rejecting active or credentialed links', () => {
    const markup = render([
      '# Heading', '', '<script>alert(1)</script><img src=x onerror=alert(1)>', '',
      '[Bad](javascript:alert(1)) [Data](data:text/html,x) [Private](https://user:secret@example.com/)',
      '**Bold** and `inline <code>` with [Safe](https://example.com/docs)', '', '- First', '- Second',
    ].join('\n'))
    expect(markup).toContain('<h1>Heading</h1>')
    expect(markup).toContain('<strong>Bold</strong>')
    expect(markup).toContain('<code>inline &lt;code&gt;</code>')
    expect(markup).toContain('<ul><li>First</li><li>Second</li></ul>')
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(markup).not.toMatch(/<script|<img|href="(?:javascript:|data:|https:\/\/user:)/)
    expect(markup).toContain('href="https://example.com/docs" target="_blank" rel="noreferrer"')
  })

  it('preserves fenced code and inline code as text without rendering embedded markup or links', () => {
    const markup = render([
      '```html', '<script>alert("x")</script>', '**not bold** [not a link](https://example.com/)', '```',
      '', '`[inline](https://example.com/) <img>`',
    ].join('\r\n'))
    expect(markup).toContain('<pre class="conductor-preview-code">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\n**not bold** [not a link](https://example.com/)</pre>')
    expect(markup).toContain('<code>[inline](https://example.com/) &lt;img&gt;</code>')
    expect(markup).not.toMatch(/<script|<img|<a |<strong>/)
  })
})
