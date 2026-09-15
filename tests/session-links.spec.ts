import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import { registerSessionLinksRoute, sessionLinksOf } from '../src/service/session-links.ts'
import type { CompletionReturnCallback } from '../src/service/completion-return.ts'
import { creationLinkDefinition, httpSessionLinks } from '../src/client-navigation.ts'
import type { WebRoutePort } from '../src/service/panelapi.ts'

afterEach(() => { vi.useRealTimers() })
const CARD_CAPABILITY = 'a'.repeat(43)
const WRONG_CAPABILITY = 'b'.repeat(43)
async function fixture(kind: 'create' | 'fork' | 'attach' = 'create') {
  const tables = createInMemoryTables(), store = new ConductorStore(tables)
  const now = new Date().toISOString()
  await store.createTask({ taskId: 'task', title: '分析任务', controllerSessionId: 'later-controller', requestedBy: 'user', pinned: false, archived: false, contextMode: 'empty', preparation: 'ready', preparationPhase: 'ready', currentBindingId: 'binding', createdAt: now, updatedAt: now })
  await tables.bindings.put('binding', { bindingId: 'binding', taskId: 'task', hostId: 'local', sessionId: 'child', version: 1, createdAt: now })
  await store.putAccess({ taskId: 'task', ownerSessionId: 'parent', ownerEpoch: 0, observerSessionIds: [], updatedAt: now })
  await store.beginOperation({
    operationId: 'create-op', kind, taskId: 'task', messageId: 'relay-1',
    params: { controllerSessionId: 'parent', instruction: 'Complete the delegated task.' },
    dispatchGuard: { ownerSessionId: 'parent', ownerEpoch: 0, bindingVersion: 1 },
    sessionLinkCapability: CARD_CAPABILITY,
  })
  return { store, tables, now }
}

describe('durable native conversation links', () => {
  it('keeps the initial origin after control transfer and store reconstruction', async () => {
    const { store, tables } = await fixture()
    expect(sessionLinksOf(store, 'parent').created[0]).toMatchObject({ operationId: 'create-op', targetSessionId: 'child', originSessionId: 'parent' })
    expect(sessionLinksOf(new ConductorStore(tables), 'child').origin?.originSessionId).toBe('parent')
    expect(sessionLinksOf(store, 'later-controller').created).toEqual([])
  })
  it('follows a successor binding while retired sessions retain provenance', async () => {
    const { store, tables, now } = await fixture('fork')
    await tables.bindings.put('successor', { bindingId: 'successor', taskId: 'task', hostId: 'local', sessionId: 'new-child', version: 2, createdAt: now })
    await store.updateTask('task', task => ({ ...task, currentBindingId: 'successor' }))
    expect(sessionLinksOf(store, 'parent').created[0]?.targetSessionId).toBe('new-child')
    expect(sessionLinksOf(store, 'child').origin?.originSessionId).toBe('parent')
    expect(sessionLinksOf(store, 'new-child').origin?.originSessionId).toBe('parent')
  })
  it('does not claim attachment or a remote session ID as a local creation', async () => {
    const attached = await fixture('attach')
    expect(sessionLinksOf(attached.store, 'parent').created).toEqual([])
    const remote = await fixture()
    await remote.tables.bindings.update('binding', row => ({ ...row!, hostId: 'remote' }))
    expect(sessionLinksOf(remote.store, 'parent').created[0]?.local).toBe(false)
    expect(sessionLinksOf(remote.store, 'child').origin).toBeUndefined()
  })
  it('returns the one-shot result only to the original card with its capability while it still may read', async () => {
    const { store } = await fixture()
    await store.updateTask('task', task => ({
      ...task,
      completionReturn: {
        operationId: 'create-op', bindingId: 'binding', bindingVersion: 1, messageId: 'relay-1',
        phase: 'returned', armedAt: '2026-09-15T00:00:00.000Z', messageSeq: 4, turn: 7, startSeq: 5,
        endSeq: 9, outcome: 'completed', detail: 'finished', preview: 'Only the parent may see this result.',
        completedAt: '2026-09-15T00:01:00.000Z', updatedAt: '2026-09-15T00:01:00.000Z',
      },
    }))

    // The session id remains a navigation subject, not a credential.  A route
    // request that has only it gets the historical base link and no return.
    expect(sessionLinksOf(store, 'parent').created[0]?.completion).toBeUndefined()
    expect(sessionLinksOf(store, 'parent', 'local', WRONG_CAPABILITY).created[0]?.completion).toBeUndefined()
    expect(sessionLinksOf(store, 'parent', 'local', CARD_CAPABILITY).created[0]?.completion).toEqual({
      phase: 'returned', outcome: 'completed', detail: 'finished',
      preview: 'Only the parent may see this result.', completedAt: '2026-09-15T00:01:00.000Z',
    })
    // The child retains a navigational origin link, but it is not a channel for
    // the parent-facing result preview. A third session receives no link at all.
    expect(sessionLinksOf(store, 'child', 'local', CARD_CAPABILITY).origin?.completion).toBeUndefined()
    expect(sessionLinksOf(store, 'stranger')).toEqual({ sessionId: 'stranger', created: [] })

    // A control transfer revokes the original parent's read right. Its creation
    // card remains usable for navigation, while the result fields disappear.
    const access = store.getAccess('task')!
    await store.putAccess({ ...access, ownerSessionId: 'later-controller', ownerEpoch: 1, updatedAt: '2026-09-15T00:02:00.000Z' })
    expect(sessionLinksOf(store, 'parent').created[0]).toMatchObject({ taskId: 'task', targetSessionId: 'child' })
    expect(sessionLinksOf(store, 'parent', 'local', CARD_CAPABILITY).created[0]?.completion).toBeUndefined()
  })
  it('does not project in-progress callbacks and limits delivery failure to its terminal reason', async () => {
    const { store } = await fixture()
    const base = {
      operationId: 'create-op', bindingId: 'binding', bindingVersion: 1, messageId: 'relay-1',
      armedAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    } as const
    for (const phase of ['armed', 'running', 'delivery_unknown'] as const) {
      await store.updateTask('task', task => ({ ...task, completionReturn: { ...base, phase } }))
      expect(sessionLinksOf(store, 'parent', 'local', CARD_CAPABILITY).created[0]?.completion).toBeUndefined()
    }
    await store.updateTask('task', task => ({
      ...task,
      completionReturn: {
        ...base, phase: 'delivery_failed', reason: 'initial relay was not accepted',
        // These must never be treated as a result preview for a failed delivery.
        detail: 'stale detail', preview: 'stale preview', completedAt: '2026-09-15T00:01:00.000Z',
      },
    }))
    expect(sessionLinksOf(store, 'parent', 'local', CARD_CAPABILITY).created[0]?.completion).toEqual({
      phase: 'delivery_failed', reason: 'initial relay was not accepted',
    })
  })
  it('fails closed for a damaged callback or operation relation while retaining its navigation link', async () => {
    const completion: CompletionReturnCallback = {
      operationId: 'create-op', bindingId: 'binding', bindingVersion: 1, messageId: 'relay-1',
      phase: 'returned', armedAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:01:00.000Z',
      detail: 'the only return', preview: 'private result', outcome: 'completed',
    }
    const variants: ReadonlyArray<{
      readonly name: string
      readonly corrupt: (store: ConductorStore, tables: ReturnType<typeof createInMemoryTables>) => Promise<void>
    }> = [
      {
        name: 'another operation',
        corrupt: store => store.updateTask('task', task => ({
          ...task, completionReturn: { ...completion, operationId: 'other-operation' },
        })).then(() => undefined),
      },
      {
        name: 'another relay message',
        corrupt: store => store.updateTask('task', task => ({
          ...task, completionReturn: { ...completion, messageId: 'other-relay' },
        })).then(() => undefined),
      },
      {
        name: 'an empty initial instruction',
        corrupt: store => store.updateOperation('create-op', operation => ({
          ...operation, params: { ...operation.params as Record<string, unknown>, instruction: '' },
        })).then(() => undefined),
      },
      {
        name: 'a different dispatch binding version',
        corrupt: store => store.updateOperation('create-op', operation => ({
          ...operation, dispatchGuard: { ...operation.dispatchGuard!, bindingVersion: 2 },
        })).then(() => undefined),
      },
      {
        name: 'a callback binding that does not belong to this task',
        corrupt: store => store.updateTask('task', task => ({
          ...task, completionReturn: { ...completion, bindingId: 'other-binding' },
        })).then(() => undefined),
      },
      {
        name: 'a task identity different from the operation task',
        corrupt: async (store, tables) => {
          await store.updateTask('task', task => ({ ...task, taskId: 'other-task', completionReturn: completion }))
          await tables.bindings.update('binding', binding => ({ ...binding!, taskId: 'other-task' }))
        },
      },
    ]
    for (const variant of variants) {
      const { store, tables } = await fixture()
      await store.updateTask('task', task => ({ ...task, completionReturn: completion }))
      await variant.corrupt(store, tables)
      const link = sessionLinksOf(store, 'parent', 'local', CARD_CAPABILITY).created.find(value => value.operationId === 'create-op')
      expect(link, variant.name).toBeDefined()
      expect(link?.completion, variant.name).toBeUndefined()
    }
  })
  it('bounds text from legacy or damaged completion records at the link projection boundary', async () => {
    const { store } = await fixture()
    await store.updateTask('task', task => ({
      ...task,
      completionReturn: {
        operationId: 'create-op', bindingId: 'binding', bindingVersion: 1, messageId: 'relay-1',
        phase: 'returned', armedAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:01:00.000Z',
        detail: 'd'.repeat(1_000), preview: 'p'.repeat(1_000), reason: 'r'.repeat(1_000),
      },
    }))
    const completion = sessionLinksOf(store, 'parent', 'local', CARD_CAPABILITY).created[0]?.completion
    expect(completion?.detail).toHaveLength(240)
    expect(completion?.preview).toHaveLength(480)
    expect(completion?.reason).toHaveLength(240)
    expect(completion?.detail).toMatch(/… \[truncated\]$/)
    expect(completion?.preview).toMatch(/… \[truncated\]$/)
    expect(completion?.reason).toMatch(/… \[truncated\]$/)
  })
  it('fences reads and rejects ambiguous IDs without exposing internal failures', () => {
    let route: Parameters<WebRoutePort['register']>[0] | undefined
    registerSessionLinksRoute({ register(value) { route = value; return () => {} } }, id => { if (id === 'broken') throw new Error('private location'); return { sessionId: id, created: [] } })
    const invoke = (
      url: string,
      method = 'GET',
      origin = 'http://127.0.0.1:43120',
      extraHeaders: Readonly<Record<string, string | readonly string[]>> = {},
    ) => {
      const response = { statusCode: 200, body: '', setHeader: vi.fn(), end(body?: string) { this.body = body ?? '' } }
      route!.handler({ url, method, headers: { host: '127.0.0.1:43120', origin, 'sec-fetch-site': 'same-origin', ...extraHeaders }, socket: { remoteAddress: '127.0.0.1' } }, response)
      return response
    }
    expect(invoke('/conductor/session-links?sessionId=parent').body).toContain('parent')
    expect(invoke('/conductor/session-links?sessionId=a&sessionId=b').statusCode).toBe(400)
    expect(invoke('/conductor/session-links?sessionId=a', 'POST').statusCode).toBe(405)
    expect(invoke('/conductor/session-links?sessionId=a', 'GET', 'https://evil.test').statusCode).toBe(403)
    expect(invoke('/conductor/session-links?sessionId=broken')).toMatchObject({ statusCode: 503, body: '{"error":"SESSION_LINKS_UNAVAILABLE"}' })
  })
  it('passes only a valid card capability to the completion projection', async () => {
    const { store } = await fixture()
    await store.updateTask('task', task => ({
      ...task,
      completionReturn: {
        operationId: 'create-op', bindingId: 'binding', bindingVersion: 1, messageId: 'relay-1',
        phase: 'returned', armedAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:01:00.000Z',
        detail: 'done', preview: 'private child result', completedAt: '2026-09-15T00:01:00.000Z', outcome: 'completed',
      },
    }))
    let route: Parameters<WebRoutePort['register']>[0] | undefined
    registerSessionLinksRoute({ register(value) { route = value; return () => {} } },
      (sessionId, capability) => sessionLinksOf(store, sessionId, 'local', capability))
    const invoke = (sessionId: string, capability?: string | readonly string[]) => {
      const response = { statusCode: 200, body: '', setHeader: vi.fn(), end(body?: string) { this.body = body ?? '' } }
      route!.handler({
        url: `/conductor/session-links?sessionId=${encodeURIComponent(sessionId)}`,
        method: 'GET',
        headers: {
          host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120', 'sec-fetch-site': 'same-origin',
          ...capability === undefined ? {} : { 'x-dsh-conductor-link-capability': capability },
        },
        socket: { remoteAddress: '127.0.0.1' },
      }, response)
      return JSON.parse(response.body) as { created: Array<{ completion?: unknown }>; origin?: { completion?: unknown } }
    }
    expect(invoke('parent').created[0]?.completion).toBeUndefined()
    expect(invoke('parent', WRONG_CAPABILITY).created[0]?.completion).toBeUndefined()
    expect(invoke('parent', ['one', CARD_CAPABILITY]).created[0]?.completion).toBeUndefined()
    expect(invoke('parent', CARD_CAPABILITY).created[0]?.completion).toMatchObject({ phase: 'returned', preview: 'private child result' })
    // Even a copied header cannot use the child origin route as a return channel.
    expect(invoke('child', CARD_CAPABILITY).origin?.completion).toBeUndefined()
  })
  it('scopes a capability to its own create operation, not every card in the parent session', async () => {
    const { store, tables, now } = await fixture()
    await store.createTask({
      taskId: 'second-task', title: 'Second child', controllerSessionId: 'parent', requestedBy: 'user',
      pinned: false, archived: false, contextMode: 'empty', preparation: 'ready', preparationPhase: 'ready',
      currentBindingId: 'second-binding',
      completionReturn: {
        operationId: 'second-op', bindingId: 'second-binding', bindingVersion: 1, messageId: 'relay-2',
        phase: 'returned', armedAt: now, updatedAt: now, detail: 'second return', preview: 'second private result',
      },
      createdAt: now, updatedAt: now,
    })
    await tables.bindings.put('second-binding', {
      bindingId: 'second-binding', taskId: 'second-task', hostId: 'local', sessionId: 'second-child', version: 1, createdAt: now,
    })
    await store.putAccess({ taskId: 'second-task', ownerSessionId: 'parent', ownerEpoch: 0, observerSessionIds: [], updatedAt: now })
    await store.beginOperation({
      operationId: 'second-op', kind: 'create', taskId: 'second-task', params: { controllerSessionId: 'parent' },
      dispatchGuard: { ownerSessionId: 'parent', ownerEpoch: 0, bindingVersion: 1 }, sessionLinkCapability: WRONG_CAPABILITY,
    })
    const links = sessionLinksOf(store, 'parent', 'local', CARD_CAPABILITY).created
    expect(links.find(link => link.operationId === 'create-op')?.completion).toBeUndefined()
    expect(links.find(link => link.operationId === 'second-op')?.completion).toBeUndefined()
    // Give the first task a return as well, then prove the second card stays redacted.
    await store.updateTask('task', task => ({
      ...task,
      completionReturn: {
        operationId: 'create-op', bindingId: 'binding', bindingVersion: 1, messageId: 'relay-1',
        phase: 'returned', armedAt: now, updatedAt: now, detail: 'first return', preview: 'first private result',
      },
    }))
    const withFirstCard = sessionLinksOf(store, 'parent', 'local', CARD_CAPABILITY).created
    expect(withFirstCard.find(link => link.operationId === 'create-op')?.completion?.preview).toBe('first private result')
    expect(withFirstCard.find(link => link.operationId === 'second-op')?.completion).toBeUndefined()
  })
})

describe('visible session polling leases', () => {
  it('shares reads per session and aborts stale responses on the final unsubscribe', async () => {
    vi.useFakeTimers()
    const pending: ((value: Response) => void)[] = [], signals: AbortSignal[] = []
    const fetcher = vi.fn((_url: string | URL | Request, options?: RequestInit) => { signals.push(options!.signal!); return new Promise<Response>(resolve => pending.push(resolve)) })
    const port = httpSessionLinks(fetcher), parent = vi.fn(), second = vi.fn(), child = vi.fn()
    const stopParent = port.subscribe('parent', undefined, parent), stopSecond = port.subscribe('parent', undefined, second)
    port.subscribe('child', undefined, child)
    expect(fetcher).toHaveBeenCalledTimes(2)
    stopParent(); expect(signals[0]!.aborted).toBe(false)
    stopSecond(); expect(signals[0]!.aborted).toBe(true)
    pending[0]!(new Response(JSON.stringify({ sessionId: 'parent', created: [] })))
    pending[1]!(new Response(JSON.stringify({ sessionId: 'child', created: [] })))
    await vi.advanceTimersByTimeAsync(0)
    expect(parent).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(child).toHaveBeenLastCalledWith({ sessionId: 'child', payload: { sessionId: 'child', created: [] } })
    port.close(); expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects a reply for another session rather than navigating using it', async () => {
    vi.useFakeTimers()
    const listener = vi.fn(), port = httpSessionLinks(vi.fn(async () => new Response(JSON.stringify({ sessionId: 'wrong', created: [] }))))
    port.subscribe('parent', undefined, listener)
    await vi.advanceTimersByTimeAsync(0)
    expect(listener).toHaveBeenLastCalledWith({ sessionId: 'parent', error: '会话跳转记录无效' })
    port.close()
  })
  it('anchors only owned creation calls, never prose or another tool', () => {
    type Event = Parameters<typeof creationLinkDefinition.match>[0]
    const event = (type: string, data: unknown) => ({ type, data, seq: 1, time: 0 }) as Event
    expect(creationLinkDefinition.match(event('tool/call', { name: 'conductor_create', callId: 'call' }))).toEqual({ id: 'call', role: 'start' })
    expect(creationLinkDefinition.match(event('tool/call', { name: 'read_file', callId: 'call' }))).toBeNull()
    expect(creationLinkDefinition.match(event('user/message', { content: [{ type: 'text', text: '已创建会话 child' }] }))).toBeNull()
  })
  it('keeps a native-card capability out of URLs and isolates its polling lease', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ sessionId: 'parent', created: [] }))))
    const port = httpSessionLinks(fetcher), withCard = vi.fn(), withoutCard = vi.fn()
    const stopWithCard = port.subscribe('parent', CARD_CAPABILITY, withCard)
    const stopWithoutCard = port.subscribe('parent', undefined, withoutCard)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [privilegedUrl, privilegedInit] = fetcher.mock.calls[0] as unknown as [string | URL | Request, RequestInit]
    const [basicUrl, basicInit] = fetcher.mock.calls[1] as unknown as [string | URL | Request, RequestInit]
    expect(String(privilegedUrl)).not.toContain(CARD_CAPABILITY)
    expect(String(basicUrl)).not.toContain(CARD_CAPABILITY)
    expect(privilegedInit.headers).toMatchObject({ 'x-dsh-conductor-link-capability': CARD_CAPABILITY })
    expect((basicInit.headers as Record<string, unknown>)['x-dsh-conductor-link-capability']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    stopWithCard(); stopWithoutCard(); port.close()
  })
  it('recovers a matching card capability only from the matching private result metadata', () => {
    const start = { event: { type: 'tool/call', data: { name: 'conductor_create', callId: 'call', arguments: JSON.stringify({ operationId: 'operation', title: 'Child' }) }, seq: 1, time: 0 }, role: 'start', location: { kind: 'session' } }
    const state = creationLinkDefinition.start({} as never, start as never, {} as never)
    const matching = {
      event: {
        type: 'tool/result', seq: 2, time: 0,
        data: { message: { source: { callId: 'call' }, content: [{ isError: false }] }, meta: { dshSessionConductor: { operationId: 'operation', capability: CARD_CAPABILITY } } },
      },
      role: 'update', location: { kind: 'session' },
    }
    expect(creationLinkDefinition.update({ state } as never, matching as never).capability).toBe(CARD_CAPABILITY)
    const mismatch = {
      ...matching,
      event: { ...matching.event, data: { ...matching.event.data, meta: { dshSessionConductor: { operationId: 'other-operation', capability: CARD_CAPABILITY } } } },
    }
    expect(creationLinkDefinition.update({ state } as never, mismatch as never).capability).toBeUndefined()
  })
})
