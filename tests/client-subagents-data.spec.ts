import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSubagentsPort, type NativeSubagentSessions } from '../src/client-subagents-data.ts'

type Catalog = { state: 'loading' | 'ready' | 'error'; parentAvailable: boolean; entries: unknown[]; error?: { message: string } | null }
const child = (id: string, activity = 'inactive', mode = 'one-shot') => ({ kind: 'child', id, activity, mode, hasChildren: false })
const ready = (entries: unknown[] = []): Catalog => ({ state: 'ready', parentAvailable: true, entries })
function fixture(catalog: Catalog | undefined = ready([child('child')]), clock?: () => number) {
  const snapshots = { current: { subagentsByParent: catalog ? { parent: catalog } as Record<string, Catalog> : {}, byId: {} as Record<string, unknown> } }
  const listeners = new Set<() => void>()
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((listener: () => void) => { listeners.add(listener); return () => { unsubscribe(); listeners.delete(listener) } })
  const getSnapshot = vi.fn(() => snapshots.current)
  const refreshSubagents = vi.fn(async (_parent: string) => {})
  const openSubagent = vi.fn(async (_address: { parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' }) => {})
  const forbidden = { setSubagentCatalogOpen: vi.fn(), open: vi.fn(), binding: vi.fn(), readHistory: vi.fn() }
  const sessions = { list: { getSnapshot, subscribe }, refreshSubagents, openSubagent, ...forbidden }
  const port = createSubagentsPort(sessions, clock)
  const notify = () => { snapshots.current = { ...snapshots.current }; for (const listener of listeners) listener() }
  return { snapshots, listeners, subscribe, unsubscribe, getSnapshot, refreshSubagents, openSubagent, forbidden, sessions, port, notify }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('native subagent directory projection', () => {
  it('reads only direct native children and ignores ordinary sessions, grandchildren and completed reminders', () => {
    const f = fixture(ready([child('running', 'running', 'continuable'), child('idle'), { kind: 'diagnostic', id: 'broken', reason: 'corrupt' }]))
    f.snapshots.current.subagentsByParent['running'] = ready([child('grandchild')])
    f.snapshots.current.byId = {
      running: { displayTitle: 'workspace fallback', title: 'Running title', completed: true },
      idle: { title: 'Idle title', completed: true }, ordinary: { title: 'Not a native child', parentId: 'parent', running: true },
    }
    const read = f.port.getSnapshot('parent')
    expect(read).toEqual({ parentId: 'parent', state: 'ready', parentAvailable: true, items: [
      { id: 'running', title: 'Running title', mode: 'continuable', activity: 'running', statusLabel: '进行中' },
      { id: 'idle', title: 'Idle title', mode: 'one-shot', activity: 'inactive', statusLabel: '已结束 / 空闲' },
      { id: 'broken', title: 'broken', activity: 'unavailable', statusLabel: '记录损坏' },
    ] })
    expect(JSON.stringify(read)).not.toMatch(/grandchild|ordinary|已完成|成功/)
    expect(f.port.getSnapshot('parent')).toBe(read)
    expect(f.refreshSubagents).not.toHaveBeenCalled()
    for (const operation of Object.values(f.forbidden)) expect(operation).not.toHaveBeenCalled()
    f.port.close()
  })

  it('uses the creation label and finally exact id when no public display title exists', () => {
    const f = fixture(ready([{ ...child('named'), label: 'Research' }, child('unnamed')]))
    f.snapshots.current.byId['named'] = { displayTitle: 'workspace', title: 'summary title' }
    expect(f.port.getSnapshot('parent').items.map(item => item.title)).toEqual(['Research', 'unnamed'])
    f.port.close()
  })

  it('computes actual projected duration and exposes updatedAt without inventing a completion time', () => {
    const f = fixture(ready([child('running', 'running'), child('idle')]), () => 1800)
    f.snapshots.current.byId = {
      running: { updatedAt: 4000, projectionValues: { subagentTiming: { settledMs: 1200, active: { since: 1000, through: 1800 } } } },
      idle: { updatedAt: 6000, projectionValues: { subagentTiming: { settledMs: 5500 } } },
    }
    expect(f.port.getSnapshot('parent').items).toMatchObject([{ durationMs: 2000, updatedAt: 4000 }, { durationMs: 5500, updatedAt: 6000 }])
    expect(f.port.getSnapshot('parent').items[0]).not.toHaveProperty('completedAt')
    f.port.close()
  })

  it('advances running timing from the current clock while inactive timing stops at through', async () => {
    let now = 5000
    const f = fixture(ready([child('running', 'running'), child('idle')]), () => now)
    const projectionValues = { subagentTiming: { settledMs: 300, active: { since: 1000, through: 2000 } } }
    f.snapshots.current.byId = { running: { projectionValues }, idle: { projectionValues } }
    expect(f.port.getSnapshot('parent').items.map(item => item.durationMs)).toEqual([4300, 1300])
    now = 6000
    await f.port.refresh('parent')
    expect(f.port.getSnapshot('parent').items.map(item => item.durationMs)).toEqual([5300, 1300])
    now = 500
    await f.port.refresh('parent')
    expect(f.port.getSnapshot('parent').items.map(item => item.durationMs)).toEqual([300, 1300])
    now = NaN
    await f.port.refresh('parent')
    expect(f.port.getSnapshot('parent').items.map(item => item.durationMs)).toEqual([undefined, 1300])
    f.port.close()
  })

  it.each([undefined, {}, { settledMs: NaN }, { settledMs: -1 }, { settledMs: Infinity },
    { settledMs: 1, active: { since: 3, through: 2 } }, { settledMs: 1, active: { since: 0, through: Infinity } },
    { settledMs: 1, active: null }, { settledMs: Number.MAX_VALUE, active: { since: 0, through: Number.MAX_VALUE } },
  ])('does not fabricate duration from invalid or absent timing: %j', timing => {
    const f = fixture()
    f.snapshots.current.byId['child'] = { updatedAt: NaN, projectionValues: { subagentTiming: timing } }
    expect(f.port.getSnapshot('parent').items[0]).not.toHaveProperty('durationMs')
    expect(f.port.getSnapshot('parent').items[0]).not.toHaveProperty('updatedAt')
    f.port.close()
  })

  it('keeps an unloaded catalog pending while a confirmed empty cold-parent directory remains a real empty result', () => {
    const f = fixture()
    expect(f.port.getSnapshot('unknown')).toMatchObject({ state: 'loading', items: [] })
    f.snapshots.current.subagentsByParent['parent'] = ready()
    expect(f.port.getSnapshot('parent')).toMatchObject({ state: 'ready', items: [] })
    f.snapshots.current.subagentsByParent['parent'] = { ...ready(), parentAvailable: false }
    expect(f.port.getSnapshot('parent')).toMatchObject({ state: 'ready', parentAvailable: false, error: expect.any(String), items: [] })
    f.port.close()
  })

  it('retains diagnostic and stale directory rows after an error without calling them live or completed', () => {
    const f = fixture({ ...ready([child('old', 'running'), { kind: 'diagnostic', id: 'unsupported', reason: 'unsupported' }]), state: 'error', error: { message: 'transport unavailable' } })
    expect(f.port.getSnapshot('parent')).toMatchObject({ state: 'error', error: 'transport unavailable', items: [
      { id: 'old', activity: 'unavailable', statusLabel: '状态暂不可用' }, { id: 'unsupported', activity: 'unavailable', statusLabel: '版本不支持' },
    ] })
    f.port.close()
  })

  it('refuses malformed or duplicate catalogs rather than reporting a successful empty list', async () => {
    const f = fixture(ready([child('child'), child('child')]))
    expect(f.port.getSnapshot('parent').state).toBe('error')
    await expect(f.port.open('parent', 'child')).rejects.toThrow('尚未就绪')
    f.snapshots.current.subagentsByParent['parent'] = { state: 'ready', entries: [] } as unknown as Catalog
    expect(f.port.getSnapshot('parent').state).toBe('error')
    expect(f.openSubagent).not.toHaveBeenCalled()
    f.port.close()
  })
})

describe('subagent refresh leases', () => {
  it('keeps confirmed directory facts visible during background pulls and marks an actual error unavailable', async () => {
    vi.useFakeTimers()
    const rows = [child('child', 'running')], f = fixture(ready(rows)), listener = vi.fn()
    let finish!: () => void
    f.refreshSubagents.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const stop = f.port.subscribe('parent', listener), pending = f.port.refresh('parent')
    await Promise.resolve(); await Promise.resolve()
    f.snapshots.current.subagentsByParent['parent'] = { ...ready(rows.map(row => ({ ...row }))), state: 'loading' }
    f.notify()
    expect(f.port.getSnapshot('parent')).toMatchObject({ state: 'ready', items: [{ activity: 'running', statusLabel: '进行中' }] })
    expect(listener.mock.calls.every(([read]) => read.state === 'ready')).toBe(true)
    f.snapshots.current.subagentsByParent['parent'] = { ...ready(rows), state: 'error', error: { message: 'pull failed' } }
    f.notify(); finish(); await pending
    expect(f.port.getSnapshot('parent')).toMatchObject({ state: 'error', error: 'pull failed', items: [{ activity: 'unavailable' }] })
    stop(); f.port.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares one five-second lease and list subscription for the same parent, cancelling them on last unmount', async () => {
    vi.useFakeTimers()
    const f = fixture(), listener = vi.fn()
    const first = f.port.subscribe('parent', listener), second = f.port.subscribe('parent', listener)
    await f.port.refresh('parent')
    expect(f.subscribe).toHaveBeenCalledOnce()
    expect(f.refreshSubagents).toHaveBeenCalledOnce()
    first(); await vi.advanceTimersByTimeAsync(5000)
    expect(f.refreshSubagents).toHaveBeenCalledTimes(2)
    second()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(f.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.refreshSubagents).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    for (const operation of Object.values(f.forbidden)) expect(operation).not.toHaveBeenCalled()
    f.port.close()
  })

  it('publishes native list updates to the correct parent without refreshing or opening children', async () => {
    vi.useFakeTimers()
    const f = fixture(), parent = vi.fn(), other = vi.fn()
    f.snapshots.current.subagentsByParent['other'] = ready()
    const removeParent = f.port.subscribe('parent', parent), removeOther = f.port.subscribe('other', other)
    await Promise.all([f.port.refresh('parent'), f.port.refresh('other')])
    parent.mockClear(); other.mockClear()
    f.snapshots.current.byId['child'] = { title: 'Updated title' }; f.notify()
    expect(parent).toHaveBeenCalledOnce()
    expect(parent.mock.calls[0]?.[0].items[0].title).toBe('Updated title')
    expect(other).not.toHaveBeenCalled()
    expect(f.refreshSubagents).toHaveBeenCalledTimes(2)
    expect(f.openSubagent).not.toHaveBeenCalled()
    removeParent(); removeOther(); f.port.close()
  })

  it('ignores a retired refresh rejection after the same parent mounts with a new lease', async () => {
    vi.useFakeTimers()
    const f = fixture(), stale = vi.fn(), fresh = vi.fn()
    let rejectOld!: (error: Error) => void
    f.refreshSubagents.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject }))
    const stopOld = f.port.subscribe('parent', stale)
    await Promise.resolve(); await Promise.resolve()
    stopOld()
    const stopNew = f.port.subscribe('parent', fresh)
    await f.port.refresh('parent')
    fresh.mockClear(); stale.mockClear()
    rejectOld(Error('old request'))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(fresh).not.toHaveBeenCalled()
    expect(stale).not.toHaveBeenCalled()
    expect(f.port.getSnapshot('parent').state).toBe('ready')
    expect(vi.getTimerCount()).toBe(1)
    stopNew(); f.port.close()
  })

  it('does not turn a failed request into ready on an unrelated list change, and recovers after an explicit refresh', async () => {
    const f = fixture()
    f.refreshSubagents.mockRejectedValueOnce(Error('refresh unavailable'))
    await f.port.refresh('parent')
    expect(f.port.getSnapshot('parent')).toMatchObject({ state: 'error', error: 'refresh unavailable', items: [{ activity: 'unavailable' }] })
    f.snapshots.current.byId['unrelated'] = { title: 'unrelated' }; f.notify()
    expect(f.port.getSnapshot('parent').state).toBe('error')
    await expect(f.port.open('parent', 'child')).rejects.toThrow('尚未就绪')
    await f.port.refresh('parent')
    expect(f.port.getSnapshot('parent').state).toBe('ready')
    f.port.close()
  })

  it('keeps hidden tabs quiet and prevents pending work from publishing or restarting timers after close', async () => {
    vi.useFakeTimers(); vi.stubGlobal('document', { visibilityState: 'hidden' })
    const f = fixture(), listener = vi.fn()
    f.port.subscribe('parent', listener)
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.refreshSubagents).not.toHaveBeenCalled()
    let finish!: () => void
    f.refreshSubagents.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = f.port.refresh('parent')
    await Promise.resolve(); await Promise.resolve()
    f.port.close(); listener.mockClear(); finish(); await pending
    expect(listener).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.listeners.size).toBe(0)
    expect(f.port.getSnapshot('parent').state).toBe('unavailable')
  })

  it('reports missing capabilities and snapshot failures explicitly without scheduling unusable work', () => {
    vi.useFakeTimers()
    for (const sessions of [undefined, {}, { list: { getSnapshot: () => ({}) } }] satisfies (NativeSubagentSessions | undefined)[]) {
      const port = createSubagentsPort(sessions), listener = vi.fn()
      const stop = port.subscribe('parent', listener)
      expect(port.getSnapshot('parent')).toMatchObject({ state: 'unavailable', error: expect.any(String), items: [] })
      expect(vi.getTimerCount()).toBe(0)
      stop(); port.close()
    }
    const f = fixture()
    f.getSnapshot.mockImplementation(() => { throw Error('snapshot failed') })
    expect(f.port.getSnapshot('parent')).toMatchObject({ state: 'error', error: 'snapshot failed' })
    f.port.close()
  })

  it('contains a failing subscription even when its follow-up snapshot also throws', async () => {
    vi.useFakeTimers()
    const f = fixture(), listener = vi.fn()
    f.subscribe.mockImplementation(() => {
      f.getSnapshot.mockImplementation(() => { throw Error('snapshot unavailable') })
      throw Error('subscription unavailable')
    })
    let stop: (() => void) | undefined
    expect(() => { stop = f.port.subscribe('parent', listener) }).not.toThrow()
    await f.port.refresh('parent')
    expect(f.port.getSnapshot('parent')).toMatchObject({ state: 'error', error: 'snapshot unavailable' })
    stop?.(); f.port.close()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('explicit native child navigation', () => {
  it('opens only a current exact direct-parent address with the catalog mode, even when the parent is cold', async () => {
    const f = fixture({ ...ready([child('child', 'inactive', 'continuable')]), parentAvailable: false })
    expect(f.port.getSnapshot('parent')).toMatchObject({ state: 'ready', parentAvailable: false, error: expect.any(String) })
    await f.port.open('parent', 'child')
    expect(f.openSubagent).toHaveBeenCalledWith({ parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' })
    expect(f.refreshSubagents).not.toHaveBeenCalled()
    for (const operation of Object.values(f.forbidden)) expect(operation).not.toHaveBeenCalled()
    f.port.close()
  })

  it('rechecks membership and mode at click time instead of retaining an old address', async () => {
    const f = fixture()
    f.port.getSnapshot('parent')
    f.snapshots.current.subagentsByParent['parent'] = ready([child('child', 'inactive', 'continuable')])
    await f.port.open('parent', 'child')
    expect(f.openSubagent).toHaveBeenLastCalledWith({ parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' })
    f.snapshots.current.subagentsByParent['parent'] = ready()
    await expect(f.port.open('parent', 'child')).rejects.toThrow('已不在当前父会话')
    expect(f.openSubagent).toHaveBeenCalledOnce()
    f.port.close()
  })

  it('refuses diagnostic rows, other parents, missing native navigation and use after close', async () => {
    const f = fixture(ready([{ kind: 'diagnostic', id: 'child', reason: 'unavailable' }]))
    await expect(f.port.open('parent', 'child')).rejects.toThrow('已不在当前父会话')
    await expect(f.port.open('other', 'child')).rejects.toThrow('尚未就绪')
    const noOpen = createSubagentsPort({ list: f.sessions.list, refreshSubagents: f.refreshSubagents })
    await expect(noOpen.open('parent', 'child')).rejects.toThrow('未提供子智能体跳转')
    noOpen.close(); f.port.close()
    await expect(f.port.open('parent', 'child')).rejects.toThrow('视图已关闭')
    expect(f.openSubagent).not.toHaveBeenCalled()
  })
})
