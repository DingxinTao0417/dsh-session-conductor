import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, inject, LINK_NODE_KIND, creationLinkDefinition } from '../src/client-navigation.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })

function harness(withRegistry = true) {
  const root = new Context()
  roots.push(root)
  const entries: { options: { name: string; id?: string; key?: string; order?: number }; component: (props: never) => ReactElement | null }[] = []
  const remove = vi.fn()
  const registerNode = vi.fn()
  root.provide('sessions', { open: vi.fn(), list: { getSnapshot: () => ({ ids: ['parent', 'child'] }) } })
  if (withRegistry) root.provide('conversationEvents', { register: registerNode })
  class Slots extends Service {
    constructor() { super(root, 'slots') }
    inject(key: string, callback: () => () => void) {
      expect(key).not.toBe('shell.overlay')
      // Same zero-argument effect contract as the installed SlotRegistry.
      return this.ctx.effect(callback)
    }
    register(options: { name: string; id?: string; key?: string; order?: number }, component: (props: never) => ReactElement | null) {
      expect(options.name).not.toBe('shell.overlay')
      expect(typeof component).toBe('function')
      entries.push({ options, component })
      return this.ctx.effect(() => remove)
    }
  }
  new Slots()
  const load = () => root.plugin({
    inject: [...inject],
    apply(ctx) { apply(ctx as unknown as Parameters<typeof apply>[0]) },
  })
  return { root, entries, remove, registerNode, load }
}

describe('client entry in actual Cordis service contexts', () => {
  it('uses the Host selector-hook contract when rendering the persistent overview', async () => {
    const fixture = harness()
    await fixture.load()
    const hook = vi.fn((selector: (value: unknown) => unknown) => selector({ nodes: [], hasMore: false }))
    const entry = fixture.entries.find(value => value.options.id === 'conductor-session-overview')!
    const element = entry.component({ sessionId: 'parent', useSession: hook } as never)
    expect(renderToStaticMarkup(element)).toContain('aria-label="当前会话概览"')
    expect(renderToStaticMarkup(element)).not.toContain('收起会话概览')
    expect(hook).toHaveBeenCalledWith(expect.any(Function))
  })
  it('loads with strict property access and the real slot call signatures', async () => {
    const fixture = harness()
    const fiber = await fixture.load()
    expect(fiber.state).toBe(2)
    expect(fixture.entries).toHaveLength(5)
    expect(fixture.entries[0]!.options).toEqual({ name: 'conversation.chat.node', key: LINK_NODE_KIND })
    expect(fixture.entries[1]!.options.name).toBe('conversation.session.header.actions')
    expect(fixture.entries.find(value => value.options.id === 'conductor-workspace-anchor')!.options).toMatchObject({ name: 'conversation.session.header.actions', order: 100 })
    expect(fixture.registerNode).toHaveBeenCalledWith(creationLinkDefinition)
  })

  it('registers a visible accessible right-sidebar entry in the native header', async () => {
    const fixture = harness()
    await fixture.load()
    const entry = fixture.entries.find(value => value.options.id === 'conductor-sidebar-toggle')!
    expect(entry.options).toMatchObject({ name: 'conversation.session.header.utilities', order: 100 })
    const hook = vi.fn((selector: (value: unknown) => unknown) => selector({ nodes: [], hasMore: false }))
    const markup = renderToStaticMarkup(entry.component({ sessionId: 'parent', useSession: hook } as never))
    expect(markup).toContain('aria-label="打开右侧栏"')
    expect(markup).toContain('title="打开右侧栏"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('<svg')
    expect(markup).not.toContain('hidden')
    expect(hook).toHaveBeenCalledWith(expect.any(Function))
  })

  it('waits for the declared native registry before applying', async () => {
    const fixture = harness(false)
    const fiber = await fixture.load()
    expect(fixture.entries).toHaveLength(0)
    fixture.root.provide('conversationEvents', { register: fixture.registerNode })
    await fiber
    expect(fixture.entries).toHaveLength(5)
  })

  it('unregisters all native contributions when the owning plugin unloads', async () => {
    const fixture = harness()
    const fiber = await fixture.load()
    await fiber.dispose()
    expect(fixture.remove).toHaveBeenCalledTimes(5)
  })
})
