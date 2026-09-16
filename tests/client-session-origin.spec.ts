import { describe, expect, it, vi } from 'vitest'
import { fitSessionOrigin, headerObstacles } from '../src/client-navigation.ts'

function element(scrollWidth: number, clientWidth: number, left = 0, width = clientWidth) {
  const attrs = new Map<string, string>()
  return {
    scrollWidth, clientWidth, children: [] as { scrollWidth: number; clientWidth: number }[],
    getBoundingClientRect: () => ({ left, right: left + width, top: 0, bottom: 20, width, height: 20 }),
    setAttribute: (name: string, value: string) => { attrs.set(name, value) },
    removeAttribute: (name: string) => { attrs.delete(name) },
    has: (name: string) => attrs.has(name),
  }
}

describe('fitSessionOrigin', () => {
  it('keeps the full origin when content and bounds fit', () => {
    const node = element(120, 200, 40, 120)
    expect(fitSessionOrigin(node as never, { left: 0, right: 400 }, 800)).toBe('full')
    expect(node.has('data-conductor-origin-compact')).toBe(false)
    expect(node.has('data-conductor-origin-clip')).toBe(false)
  })

  it('hides only the long title when content overflows the max width', () => {
    const node = element(360, 200, 40, 200)
    const widths = [360, 160]
    vi.spyOn(node, 'scrollWidth', 'get').mockImplementation(() => widths.shift() ?? 160)
    expect(fitSessionOrigin(node as never, { left: 0, right: 400 }, 800)).toBe('compact')
    expect(node.has('data-conductor-origin-compact')).toBe(true)
    expect(node.has('data-conductor-origin-clip')).toBe(false)
  })

  it('treats a silently clipped title as not fitting', () => {
    const node = element(200, 200, 40, 200)
    node.children.push({ scrollWidth: 300, clientWidth: 120 })
    expect(fitSessionOrigin(node as never, { left: 0, right: 400 }, 800)).toBe('hidden')
  })

  it('hides the whole origin when it still overflows or leaves the session area', () => {
    const overflow = element(360, 120, 40, 120)
    expect(fitSessionOrigin(overflow as never, { left: 0, right: 400 }, 800)).toBe('hidden')
    expect(overflow.has('data-conductor-origin-clip')).toBe(true)

    const clipped = element(100, 200, 350, 100)
    expect(fitSessionOrigin(clipped as never, { left: 0, right: 400 }, 800)).toBe('hidden')
    expect(clipped.has('data-conductor-origin-clip')).toBe(true)
  })

  it('collapses when it overlaps other header items even while inside the header bounds', () => {
    const node = element(200, 200, 40, 200)
    const obstacle = { left: 180, right: 260, top: 0, bottom: 20 }
    const obstacles = () => node.has('data-conductor-origin-compact') ? [{ left: 300, right: 360, top: 0, bottom: 20 }] : [obstacle]
    expect(fitSessionOrigin(node as never, { left: 0, right: 400 }, 800, obstacles)).toBe('compact')

    const stuck = element(200, 200, 40, 200)
    expect(fitSessionOrigin(stuck as never, { left: 0, right: 400 }, 800, () => [obstacle])).toBe('hidden')

    const rowBelow = element(200, 200, 40, 200)
    expect(fitSessionOrigin(rowBelow as never, { left: 0, right: 400 }, 800, () => [{ left: 180, right: 260, top: 24, bottom: 44 }])).toBe('full')
  })
})

describe('headerObstacles', () => {
  function box(left: number, width: number, height = 20) {
    return { left, right: left + width, top: 0, bottom: height, width, height }
  }
  function fake(rect: ReturnType<typeof box>, children: unknown[] = []) {
    const node = { children, parentElement: null as unknown, getBoundingClientRect: () => rect }
    for (const child of children as { parentElement: unknown }[]) child.parentElement = node
    return node
  }

  it('collects visible sibling boxes up to the header and skips zero-size anchors', () => {
    const origin = fake(box(40, 200))
    const anchor = fake(box(0, 0, 0))
    const title = fake(box(0, 40))
    const actions = fake(box(0, 240), [title, origin, anchor])
    const utilities = fake(box(300, 60))
    const header = fake(box(0, 400), [actions, utilities])
    expect(headerObstacles(origin as never, header as never)).toEqual([title.getBoundingClientRect(), utilities.getBoundingClientRect()])
  })

  it('stays within the immediate parent when no header is present', () => {
    const origin = fake(box(40, 200))
    const sibling = fake(box(260, 40))
    const group = fake(box(0, 300), [origin, sibling])
    fake(box(0, 800), [group, fake(box(500, 100))])
    expect(headerObstacles(origin as never, null)).toEqual([sibling.getBoundingClientRect()])
  })
})
