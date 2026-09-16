import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountWorkspaceSurface } from '../src/client-workspace-layout.ts'

class Style {
  display = ''; position = ''; top = ''; bottom = ''; width = ''
  values = new Map<string, [string, string]>()
  setProperty(name: string, value: string, priority = '') { this.values.set(name, [value, priority]) }
  getPropertyValue(name: string) { return this.values.get(name)?.[0] ?? '' }
  getPropertyPriority(name: string) { return this.values.get(name)?.[1] ?? '' }
  removeProperty(name: string) { const value = this.getPropertyValue(name); this.values.delete(name); return value }
}
class Events {
  listeners = new Map<string, Set<(event: never) => void>>()
  addEventListener(type: string, listener: (event: never) => void) {
    const collection = this.listeners.get(type) ?? new Set(); collection.add(listener); this.listeners.set(type, collection)
  }
  removeEventListener(type: string, listener: (event: never) => void) { this.listeners.get(type)?.delete(listener) }
  fire(type: string, props: Record<string, unknown> = {}) {
    const event = { pointerId: 1, isPrimary: true, button: 0, clientX: 0, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...props }
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
    return event
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0) }
}
class Element extends Events {
  parentElement: Element | null = null
  children: Element[] = []
  attrs = new Map<string, string>()
  style = new Style()
  className = ''; textContent = ''; tabIndex = -1
  width = 0; height = 700; top = 36; left = 280
  computed: Record<string, string> = { display: 'block', flexDirection: 'row', position: 'static' }
  pseudo: Record<string, Record<string, string>> = {}
  setPointerCapture = vi.fn(); releasePointerCapture = vi.fn(); focus = vi.fn()
  constructor(readonly tag: string, readonly ownerDocument: DocumentMock) { super() }
  get clientWidth() { return this.width }
  getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height, left: this.left, right: this.left + this.width, width: this.width, height: this.height } }
  setAttribute(name: string, value: string) { this.attrs.set(name, value) }
  getAttribute(name: string) { return this.attrs.get(name) ?? null }
  removeAttribute(name: string) { this.attrs.delete(name) }
  append(...elements: Element[]) {
    for (const element of elements) { element.remove(); this.children.push(element); element.parentElement = this }
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this)
    this.parentElement = null
  }
  closest(selector: string): Element | null {
    if (selector === 'header' && this.tag === 'header' || selector === '#root' && this.getAttribute('id') === 'root') return this
    return this.parentElement?.closest(selector) ?? null
  }
}
class Viewport extends Events {
  innerWidth = 1480; innerHeight = 798
  localStorage = { getItem: vi.fn((_key: string): string | null => null), setItem: vi.fn((_key: string, _value: string) => {}) }
  getComputedStyle(element: Element, pseudo?: string) { return pseudo ? element.pseudo[pseudo] ?? {} : element.computed }
}
class DocumentMock {
  defaultView = new Viewport()
  head = new Element('head', this)
  body = new Element('body', this)
  createElement(tag: string) { return new Element(tag, this) }
}
function fixture(width = 1200, saved: string | null = null) {
  const document = new DocumentMock(), viewport = document.defaultView
  const root = document.createElement('div'), owner = document.createElement('div'), header = document.createElement('header'), anchor = document.createElement('span')
  root.setAttribute('id', 'root'); root.height = 762; root.top = 36
  owner.width = width; owner.top = 36; owner.height = 762
  owner.computed = { display: 'flex', flexDirection: 'column', position: 'relative' }
  header.height = 96; header.top = 36
  document.body.append(root); root.append(owner); owner.append(header); header.append(anchor)
  viewport.localStorage.getItem.mockReturnValue(saved)
  const observed: Element[] = [], disconnect = vi.fn()
  let resize: (() => void) | undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe(element: Element) { observed.push(element) }
    disconnect = disconnect
  })
  const mount = () => mountWorkspaceSurface(anchor as unknown as HTMLElement)
  const surface = mount()!
  const content = surface.content as unknown as Element, pane = content.parentElement!, separator = pane.children[0]!
  return { document, viewport, root, owner, header, anchor, surface, content, pane, separator, observed, disconnect, mount, resize: () => resize?.() }
}
afterEach(() => vi.unstubAllGlobals())

describe('plugin workspace bounds', () => {
  it('uses conversation width rather than the viewport including navigation and opens without saving a default', () => {
    const f = fixture()
    expect(f.pane.style.display).toBe('none')
    expect(f.owner.getAttribute('data-conductor-workspace-open')).toBeNull()
    f.surface.setOpen(true)
    expect(f.pane.style.width).toBe('840px')
    expect(f.owner.style.getPropertyValue('--conductor-workspace-width')).toBe('840px')
    expect(f.separator.getAttribute('aria-valuenow')).toBe('70')
    expect(f.viewport.localStorage.setItem).not.toHaveBeenCalled()
    expect(f.observed).toEqual([f.owner, f.header, f.root])
    expect(f.pane.style.top).toBe('0px')
    expect(f.owner.style.getPropertyValue('--conductor-workspace-header-height')).toBe('96px')
    expect(f.pane.style.getPropertyValue('--conductor-workspace-header-height')).toBe('96px')
    f.surface.dispose()
  })

  it.each([[740, 420], [800, 480], [1200, 840], [2000, 1400]])('preserves at least 320px of chat at conversation width %i', (width, expected) => {
    const f = fixture(width)
    f.surface.setOpen(true)
    expect(parseFloat(f.pane.style.width)).toBe(expected)
    expect(width - parseFloat(f.pane.style.width)).toBeGreaterThanOrEqual(320)
    expect(f.pane.parentElement).toBe(f.owner)
    f.surface.dispose()
  })

  it('enforces the pane minimum and clamps remembered user preferences without changing them on resize', () => {
    const f = fixture(1000, '.2')
    f.surface.setOpen(true)
    expect(f.pane.style.width).toBe('300px')
    expect(f.separator.getAttribute('aria-valuemin')).toBe('30')
    f.owner.width = 2000; f.resize()
    expect(f.pane.style.width).toBe('400px')
    expect(f.viewport.localStorage.setItem).not.toHaveBeenCalled()
    f.surface.dispose()
  })

  it('moves the same content to a full viewport drawer below actual Desktop chrome and returns on expansion', () => {
    const f = fixture(739)
    f.surface.setOpen(true)
    expect(f.pane.parentElement).toBe(f.document.body)
    expect(f.pane.style).toMatchObject({ position: 'fixed', top: '36px', bottom: '0px', width: '1480px' })
    expect(f.owner.style.getPropertyValue('--conductor-workspace-width')).toBe('0px')
    expect(f.pane.style.getPropertyValue('--conductor-workspace-header-height')).toBe('44px')
    expect(f.separator.style.display).toBe('none')
    f.root.top = 52; f.root.height = 728; f.viewport.innerWidth = 390
    f.viewport.fire('resize')
    expect(f.pane.style).toMatchObject({ top: '52px', bottom: '18px', width: '390px' })
    f.owner.width = 1200; f.resize()
    expect(f.pane.parentElement).toBe(f.owner)
    expect(f.pane.style).toMatchObject({ position: 'absolute', top: '0px', bottom: '0px', width: '840px' })
    expect(f.content.parentElement).toBe(f.pane)
    f.surface.dispose()
  })

  it('publishes the host header height so the workspace toolbar divider can align', () => {
    const f = fixture()
    f.surface.setOpen(true)
    expect(f.owner.style.getPropertyValue('--conductor-workspace-header-height')).toBe('96px')
    f.header.height = 120
    f.resize()
    expect(f.owner.style.getPropertyValue('--conductor-workspace-header-height')).toBe('120px')
    expect(f.pane.style.getPropertyValue('--conductor-workspace-header-height')).toBe('120px')
    expect(f.pane.style.top).toBe('0px')
    f.header.top = 60
    f.header.height = 80
    f.resize()
    // Title rows above the header still count: owner top 36 → header bottom 140.
    expect(f.owner.style.getPropertyValue('--conductor-workspace-header-height')).toBe('104px')
    f.surface.dispose()
  })

  it('aligns to the host divider drawn by header::after instead of the transparent box edge', () => {
    const f = fixture()
    // Desktop 2.0.3: header 36→111.67 with a transparent 0.67px border; the visible
    // 1px line is an absolutely positioned ::after resolved at top:73px.
    f.header.top = 36; f.header.height = 75.67
    f.header.computed = { ...f.header.computed, borderTopWidth: '0px' }
    f.header.pseudo['::after'] = { content: '""', position: 'absolute', height: '1px', top: '73px', backgroundColor: 'rgba(255, 255, 255, 0.12)' }
    f.surface.setOpen(true)
    expect(f.owner.style.getPropertyValue('--conductor-workspace-header-height')).toBe('74px')
    // An unpainted or non-line pseudo-element falls back to the box bottom.
    f.header.pseudo['::after'] = { content: '""', position: 'absolute', height: '1px', top: '73px', backgroundColor: 'rgba(0, 0, 0, 0)' }
    f.resize()
    expect(f.owner.style.getPropertyValue('--conductor-workspace-header-height')).toBe('75.67px')
    f.header.pseudo['::after'] = { content: '""', position: 'absolute', height: '40px', top: '10px', backgroundColor: 'rgb(0, 0, 0)' }
    f.resize()
    expect(f.owner.style.getPropertyValue('--conductor-workspace-header-height')).toBe('75.67px')
    f.surface.dispose()
  })
})

describe('workspace width interaction and lifetime', () => {
  it('resizes only from the explicit separator pointer capture and persists only a completed drag', () => {
    const f = fixture()
    f.surface.setOpen(true)
    const ignored = f.separator.fire('pointerdown', { button: 2 })
    expect(ignored.preventDefault).not.toHaveBeenCalled()
    f.separator.fire('pointerdown', { pointerId: 7 })
    expect(f.separator.setPointerCapture).toHaveBeenCalledWith(7)
    f.separator.fire('pointermove', { pointerId: 9, clientX: 600 })
    expect(f.pane.style.width).toBe('840px')
    f.separator.fire('pointermove', { pointerId: 7, clientX: 760 })
    expect(f.pane.style.width).toBe('720px')
    expect(f.viewport.localStorage.setItem).not.toHaveBeenCalled()
    f.separator.fire('pointerup', { pointerId: 7 })
    expect(f.viewport.localStorage.setItem).toHaveBeenCalledWith('dsh-session-conductor:workspace:ratio', '0.6')
    expect(f.separator.releasePointerCapture).toHaveBeenCalledWith(7)
    f.separator.fire('pointerdown', { pointerId: 8 })
    f.separator.fire('pointermove', { pointerId: 8, clientX: 2000 })
    expect(f.pane.style.width).toBe('300px')
    f.separator.fire('pointercancel', { pointerId: 8 })
    expect(f.pane.style.width).toBe('720px')
    expect(f.viewport.localStorage.setItem).toHaveBeenCalledOnce()
    f.surface.dispose()
  })

  it('supports keyboard steps and default reset without consuming unrelated keys', () => {
    const f = fixture()
    f.surface.setOpen(true)
    expect(f.separator.fire('keydown', { key: 'Enter' }).preventDefault).not.toHaveBeenCalled()
    expect(f.separator.fire('keydown', { key: 'ArrowRight' }).preventDefault).toHaveBeenCalledOnce()
    expect(parseFloat(f.pane.style.width)).toBeCloseTo(816)
    f.separator.fire('keydown', { key: 'ArrowLeft' })
    expect(parseFloat(f.pane.style.width)).toBeCloseTo(840)
    f.separator.fire('keydown', { key: 'Home' })
    expect(f.separator.getAttribute('aria-valuenow')).toBe('70')
    expect(f.viewport.localStorage.setItem).toHaveBeenLastCalledWith('dsh-session-conductor:workspace:ratio', '0.7')
    f.surface.dispose()
  })

  it('restores owner state on close, releases pointer capture and all owned resources on dispose', () => {
    const f = fixture()
    expect(f.mount()).toBeUndefined()
    f.surface.setOpen(true)
    f.separator.fire('pointerdown', { pointerId: 8 })
    f.surface.setOpen(false)
    expect(f.pane.style.display).toBe('none')
    expect(f.owner.getAttribute('data-conductor-workspace-open')).toBeNull()
    expect(f.owner.style.getPropertyValue('--conductor-workspace-width')).toBe('')
    expect(f.separator.releasePointerCapture).toHaveBeenCalledWith(8)
    f.surface.setOpen(true); f.surface.dispose(); f.surface.dispose()
    expect(f.pane.parentElement).toBeNull()
    expect(f.document.head.children).toHaveLength(0)
    expect(f.separator.listenerCount()).toBe(0)
    expect(f.viewport.listenerCount()).toBe(0)
    expect(f.disconnect).toHaveBeenCalledOnce()
    f.surface.setOpen(true); f.resize()
    expect(f.owner.getAttribute('data-conductor-workspace-open')).toBeNull()
    const replacement = f.mount()
    expect(replacement).toBeDefined()
    replacement?.dispose()
  })

  it('falls back safely when optional preference storage is invalid or unavailable', () => {
    const f = fixture(1200, 'Infinity')
    f.viewport.localStorage.setItem.mockImplementation(() => { throw Error('blocked') })
    f.surface.setOpen(true)
    expect(f.pane.style.width).toBe('840px')
    expect(() => f.separator.fire('keydown', { key: 'Home' })).not.toThrow()
    f.surface.dispose()
    f.viewport.localStorage.getItem.mockImplementation(() => { throw Error('blocked') })
    const replacement = f.mount()!
    expect(() => replacement.setOpen(true)).not.toThrow()
    replacement.dispose()
  })

  it('does not mount into an unrelated page when the public header has no conversation owner', () => {
    const f = fixture()
    f.surface.dispose(); f.owner.computed.display = 'block'
    expect(f.mount()).toBeUndefined()
    f.anchor.remove()
    expect(f.mount()).toBeUndefined()
    expect(f.document.head.children).toHaveLength(0)
  })
})
