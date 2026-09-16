import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeNativePane } from '../src/client-native-pane.ts'

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  type Element = { parentElement: Element | null; children: Element[]; namespaceURI: string; isConnected: boolean; hidden: boolean;
    style: { display: string; visibility: string; gridTemplateColumns: string }; attributes: Set<string>; width: number; height: number;
    contains(node: unknown): boolean; hasAttribute(name: string): boolean; getBoundingClientRect(): { width: number; height: number } }
  const node = (): Element => ({ parentElement: null, children: [], namespaceURI: 'http://www.w3.org/1999/xhtml', isConnected: true, hidden: false,
    style: { display: 'block', visibility: 'visible', gridTemplateColumns: 'none' }, attributes: new Set(), width: 0, height: 760,
    contains(target) { return target === this || this.children.some(child => child.contains(target)) },
    hasAttribute(name) { return this.attributes.has(name) }, getBoundingClientRect() { return { width: this.width, height: this.height } },
  })
  const frame = node(), sidebar = node(), center = node(), details = node(), overlay = node(), anchor = node()
  frame.style = { display: 'grid', visibility: 'visible', gridTemplateColumns: '280px 640px 360px' }
  frame.children = [sidebar, center, details, overlay]
  for (const child of frame.children) child.parentElement = frame
  center.children = [anchor]; anchor.parentElement = center; details.width = 360
  overlay.attributes.add('data-shell-overlay')
  const listeners = new Map<string, () => void>(), resizeTargets: unknown[] = [], mutationTargets: unknown[] = []
  const resizeDisconnect = vi.fn(), mutationDisconnect = vi.fn()
  let resized: (() => void) | undefined, mutated: (() => void) | undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe(element: unknown) { resizeTargets.push(element) }
    disconnect = resizeDisconnect
  })
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { mutated = callback }
    observe(element: unknown) { mutationTargets.push(element) }
    disconnect = mutationDisconnect
  })
  const viewport = { getComputedStyle: (element: Element) => element.style,
    addEventListener: (name: string, listener: () => void) => { listeners.set(name, listener) },
    removeEventListener: (name: string, listener: () => void) => { if (listeners.get(name) === listener) listeners.delete(name) },
  }
  const element = Object.assign(anchor, { ownerDocument: { defaultView: viewport } }) as unknown as HTMLElement
  const publish = vi.fn()
  return { frame, sidebar, center, details, overlay, anchor, element, publish, listeners, resizeTargets, mutationTargets, resizeDisconnect, mutationDisconnect,
    start: () => observeNativePane(element, publish), resize: () => resized?.(), mutate: () => mutated?.() }
}

describe('read-only native details geometry compatibility', () => {
  it('recognizes the verified three-track frame and observes its actual right column', () => {
    const f = fixture(), stop = f.start()
    expect(f.publish).toHaveBeenLastCalledWith(true)
    expect(f.resizeTargets).toEqual([f.anchor, f.center, f.frame, f.details])
    expect(f.mutationTargets).toEqual(f.resizeTargets)
    f.resize(); expect(f.publish).toHaveBeenCalledTimes(1)
    stop()
  })

  it('treats a collapsed, hidden, or at-most-80px native track as not visible', () => {
    const f = fixture(), stop = f.start()
    for (const width of [0, 80]) { f.details.width = width; f.resize(); expect(f.publish).toHaveBeenLastCalledWith(false) }
    f.details.width = 81; f.resize(); expect(f.publish).toHaveBeenLastCalledWith(true)
    f.frame.attributes.add('data-details-collapsed'); f.mutate(); expect(f.publish).toHaveBeenLastCalledWith(false)
    f.frame.attributes.delete('data-details-collapsed'); f.mutate(); expect(f.publish).toHaveBeenLastCalledWith(true)
    f.details.style.visibility = 'hidden'; f.mutate(); expect(f.publish).toHaveBeenLastCalledWith(false)
    f.details.style.visibility = 'visible'; f.details.hidden = true; f.mutate(); expect(f.publish).toHaveBeenLastCalledWith(false)
    f.details.hidden = false; f.details.height = 0; f.resize(); expect(f.publish).toHaveBeenLastCalledWith(false)
    stop()
  })

  it('fails closed for changed tracks, absent overlay carrier, or a header outside the center column', () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.frame.style.gridTemplateColumns = '280px 1000px' },
      (f: ReturnType<typeof fixture>) => { f.overlay.attributes.clear() },
      (f: ReturnType<typeof fixture>) => { f.center.children = []; f.sidebar.children = [f.anchor]; f.anchor.parentElement = f.sidebar },
      (f: ReturnType<typeof fixture>) => { f.anchor.isConnected = false },
    ]) {
      const f = fixture(); change(f); const stop = f.start()
      expect(f.publish).toHaveBeenCalledExactlyOnceWith(false)
      stop()
    }
  })

  it('rechecks column replacement without reading a stale detached pane', () => {
    const f = fixture(), stop = f.start()
    const replacement = { ...f.details, width: 0 }
    f.frame.children[2] = replacement; f.mutate()
    expect(f.publish).toHaveBeenLastCalledWith(false)
    expect(f.resizeTargets).toContain(replacement)
    stop()
  })

  it('disconnects every observer and listener and ignores already queued callbacks', () => {
    const f = fixture(), stop = f.start()
    f.resizeDisconnect.mockClear(); f.mutationDisconnect.mockClear(); f.publish.mockClear()
    stop(); stop()
    expect(f.resizeDisconnect).toHaveBeenCalledOnce()
    expect(f.mutationDisconnect).toHaveBeenCalledOnce()
    expect(f.listeners.size).toBe(0)
    f.details.width = 0; f.resize(); f.mutate()
    expect(f.publish).not.toHaveBeenCalled()
  })

  it('reports unsupported document contexts without attaching listeners', () => {
    const publish = vi.fn(), stop = observeNativePane({ ownerDocument: { defaultView: null } } as unknown as HTMLElement, publish)
    expect(publish).toHaveBeenCalledExactlyOnceWith(false)
    expect(stop).not.toThrow()
  })
})
