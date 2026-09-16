import { describe, expect, it, vi } from 'vitest'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import { overviewOf, registerOverviewRoute, registerOverviewResultRoute } from '../src/service/overview.ts'
import { reconcileFollowupReturns } from '../src/service/followup-returns.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import type { PanelActionServices, PanelTaskView, WebRoutePort } from '../src/service/panelapi.ts'

const stamp = '2026-09-15T00:00:00Z'
const token = 'a'.repeat(43)
type Route = Parameters<WebRoutePort['register']>[0]
type Request = Parameters<Route['handler']>[0]
const events: SessionEventLike[] = [
  { seq: 1, time: Date.parse(stamp), type: 'turn/start', data: { turn: 1 } },
  { seq: 2, time: Date.parse(stamp), type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'before steering' }] } } },
  { seq: 3, time: Date.parse(stamp), type: 'user/message', data: { id: 'send-message', content: [{ type: 'text', text: 'new instruction' }] } },
  { seq: 4, time: Date.parse(stamp), type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'new result' }] } } },
  { seq: 5, time: Date.parse(stamp), type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { seq: 6, time: Date.parse(stamp), type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'later unrelated result' }] } } },
]

async function fixture() {
  const store = new ConductorStore(createInMemoryTables(), () => stamp)
  await store.createTask({ taskId: 'task', title: '子任务', controllerSessionId: 'parent', requestedBy: 'user',
    pinned: false, archived: false, contextMode: 'empty', preparation: 'ready', preparationPhase: 'ready', createdAt: stamp, updatedAt: stamp,
    completionReturn: { operationId: 'create', bindingId: 'binding', bindingVersion: 1, messageId: 'initial',
      phase: 'returned', armedAt: stamp, updatedAt: stamp, preview: 'first result', turn: 0, startSeq: -2, messageSeq: -1, endSeq: 0 },
  })
  await store.putBinding({ bindingId: 'binding', taskId: 'task', sessionId: 'child', hostId: 'local', version: 1, createdAt: stamp })
  await store.putAccess({ taskId: 'task', ownerSessionId: 'parent', ownerEpoch: 0, observerSessionIds: ['observer'], updatedAt: stamp })
  for (const kind of ['create', 'send'] as const) {
    await store.beginOperation({ operationId: kind, taskId: 'task', kind, messageId: kind === 'send' ? 'send-message' : 'initial',
      params: kind === 'send' ? { text: 'new instruction' } : { instruction: 'initial instruction' },
      dispatchGuard: { ownerSessionId: 'parent', ownerEpoch: 0, bindingId: 'binding', bindingVersion: 1 },
    })
  }
  await store.updateOperation('send', row => ({ ...row, completionReturn: { operationId: 'send', bindingId: 'binding', bindingVersion: 1,
    messageId: 'send-message', phase: 'armed', armedAt: stamp, updatedAt: stamp } }))
  const views: PanelTaskView[] = [{ taskId: 'task', title: '子任务', sessionId: 'child', preparation: 'ready', execution: 'idle', status: 'idle', pinned: false, updatedAt: stamp }]
  const build = (sessionId: string) => overviewOf(store, sessionId, views)
  const readEvents = vi.fn(async () => events)
  const reconcile = () => reconcileFollowupReturns({ store, active: () => true, localHostId: 'local', readEvents })
  return { store, build, views, readEvents, reconcile }
}

function transport(build: (id: string) => ReturnType<typeof overviewOf>, store: ConductorStore, readEvents: () => Promise<readonly SessionEventLike[]>) {
  const routes = new Map<string, Route>()
  let currentCaller: string | undefined = 'parent'
  const services = { resolveCaller: vi.fn(async (value: string) => value === token && currentCaller ? { authority: 'local-user', sessionId: currentCaller } : undefined) } as unknown as PanelActionServices
  const web: WebRoutePort = { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } }
  const disposers = [registerOverviewRoute(web, services, store, build), registerOverviewResultRoute(web, services, build, readEvents)]
  const request = async (path: string, body?: unknown, override?: Partial<Request>) => {
    const response = { statusCode: 0, body: '', setHeader() {}, end(value?: string) { this.body = value ?? '' } }
    await routes.get(path.split('?')[0]!)!.handler({
      method: body === undefined ? 'GET' : 'POST', url: path,
      headers: { host: 'localhost:43210', origin: 'http://localhost:43210', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', authorization: 'Bearer ' + token },
      socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) }, ...override,
    }, response)
    return { status: response.statusCode, data: JSON.parse(response.body) }
  }
  return { request, services, setCaller(id: string | undefined) { currentCaller = id }, close() { disposers.forEach(dispose => dispose?.()) } }
}

describe('independent delegation receipts', () => {
  it('observes a send without overwriting initial results, waking parent, or creating cursors', async () => {
    const f = await fixture()
    const first = structuredClone(f.store.getTask('task')!.completionReturn)
    await f.reconcile()
    expect(f.store.getOperation('send')!.completionReturn).toMatchObject({ phase: 'returned', messageSeq: 3, startSeq: 1, endSeq: 5, preview: 'new result' })
    expect(f.store.getTask('task')!.completionReturn).toEqual(first)
    const data = f.build('parent')
    expect(data.unread).toBe(2)
    expect(data.receipts.map(item => item.preview).sort()).toEqual(['first result', 'new result'])
    expect(f.store.listEveryWatch()).toEqual([])
    expect(f.store.listNotifications()).toEqual([])
    f.readEvents.mockClear()
    await f.reconcile()
    expect(f.readEvents).not.toHaveBeenCalled()
  })

  it('does not mistake pre-steering output for this instruction result', async () => {
    const f = await fixture()
    f.readEvents.mockResolvedValue(events.filter(event => event.seq !== 4))
    await f.reconcile()
    expect(f.store.getOperation('send')!.completionReturn?.preview).toBeUndefined()
  })

  it('rechecks access and binding after asynchronous public history reads', async () => {
    const f = await fixture()
    f.readEvents.mockImplementation(async () => {
      await f.store.putAccess({ ...f.store.getAccess('task')!, ownerSessionId: 'new-owner', observerSessionIds: [], ownerEpoch: 1 })
      return events
    })
    await f.reconcile()
    expect(f.store.getOperation('send')!.completionReturn?.phase).toBe('armed')
    expect(f.build('parent').receipts).toEqual([])
  })

  it('ignores damaged relationships and remote receipts instead of guessing', async () => {
    const f = await fixture()
    await f.store.updateOperation('send', row => ({ ...row, dispatchGuard: { ...row.dispatchGuard!, bindingVersion: 2 } }))
    await f.reconcile()
    expect(f.readEvents).not.toHaveBeenCalled()
    expect(f.build('parent').receipts.map(receipt => receipt.operationId)).toEqual(['create'])
  })

  it('marks a proven withdrawn message undelivered and preserves unknown deliveries', async () => {
    const f = await fixture()
    f.readEvents.mockResolvedValue([])
    await f.store.updateOperation('send', row => ({ ...row, delivery: 'unknown' }))
    await f.reconcile()
    expect(f.store.getOperation('send')!.completionReturn?.phase).toBe('delivery_unknown')
    await f.store.updateOperation('send', row => ({ ...row, withdrawn: true, delivery: 'withdrawn' }))
    await f.reconcile()
    expect(f.store.getOperation('send')!.completionReturn?.phase).toBe('delivery_failed')
  })

  it('does not conflate Linux case-sensitive workspaces', async () => {
    const f = await fixture()
    await f.store.createTask({ ...f.store.getTask('task')!, taskId: 'task-2', completionReturn: undefined })
    await f.store.putAccess({ ...f.store.getAccess('task')!, taskId: 'task-2' })
    const views = [{ ...f.views[0]!, execution: 'running', cwd: '/project/A' }, { ...f.views[0]!, taskId: 'task-2', execution: 'running', cwd: '/project/a' }]
    expect(overviewOf(f.store, 'parent', views).sharedDirectories).toEqual([])
    views[0]!.cwd = 'D:/Project'
    views[1]!.cwd = 'd:\\project\\'
    expect(overviewOf(f.store, 'parent', views).sharedDirectories).toHaveLength(1)
  })
})

describe('authenticated overview and exact result routes', () => {
  it('keeps an artifact producing session after migration and never navigates remote IDs locally', async () => {
    const f = await fixture()
    const base = { artifactId: 'local-file', taskId: 'task', sessionId: 'original-producing-session', kind: 'file' as const, name: 'out.md',
      hostId: 'local', path: 'D:/output/out.md', contentVersion: 1, existence: 'claimed' as const, acceptance: 'pending' as const,
      evidence: [], createdAt: stamp, updatedAt: stamp }
    await f.store.putArtifact(base)
    await f.store.putArtifact({ ...base, artifactId: 'remote-file', hostId: 'another-host' })
    expect(f.build('parent').outputs).toEqual([
      expect.objectContaining({ id: 'local-file', local: true, sessionId: 'original-producing-session' }),
      expect.objectContaining({ id: 'remote-file', local: false }),
    ])
    expect(f.build('parent').outputs[1]?.sessionId).toBeUndefined()
  })
  it('acknowledges only the originating reader; reads do not acknowledge or move cursors', async () => {
    const f = await fixture(); await f.reconcile()
    const api = transport(f.build, f.store, f.readEvents)
    expect((await api.request('/conductor/overview')).data.unread).toBe(2)
    expect((await api.request('/conductor/overview')).data.unread).toBe(2)
    api.setCaller('observer')
    expect((await api.request('/conductor/overview', { operationIds: ['send'] })).data.receipts).toEqual([])
    expect(f.store.getOperation('send')!.overviewReadAt).toBeUndefined()
    api.setCaller('parent')
    expect((await api.request('/conductor/overview', { operationIds: ['send'] })).data.unread).toBe(1)
    expect(f.store.getOperation('create')!.overviewReadAt).toBeUndefined()
    expect(f.store.listEveryWatch()).toEqual([])
    api.close()
  })

  it('fences network, origin, authentication and malformed acknowledgement requests', async () => {
    const f = await fixture()
    const api = transport(f.build, f.store, f.readEvents)
    expect((await api.request('/conductor/overview', undefined, { socket: { remoteAddress: '192.168.0.2' } })).status).toBe(403)
    expect((await api.request('/conductor/overview', undefined, { headers: { host: 'localhost:43210', origin: 'https://evil.test' } })).status).toBe(403)
    expect((await api.request('/conductor/overview', { operationIds: ['create'], sessionId: 'parent' })).status).toBe(400)
    api.setCaller(undefined)
    expect((await api.request('/conductor/overview')).status).toBe(401)
  })

  it('reads only the matched post-message public answer and rechecks permission after I/O', async () => {
    const f = await fixture(); await f.reconcile()
    const api = transport(f.build, f.store, f.readEvents)
    expect((await api.request('/conductor/overview/result?operationId=send')).data).toEqual({ text: 'new result', truncated: false, turn: 1 })
    f.readEvents.mockImplementation(async () => {
      await f.store.putAccess({ ...f.store.getAccess('task')!, ownerSessionId: 'new-owner', observerSessionIds: [] })
      return events
    })
    expect((await api.request('/conductor/overview/result?operationId=send')).status).toBe(403)
  })

  it('rejects token expiry during I/O and never falls back to earlier answers', async () => {
    const f = await fixture(); await f.reconcile()
    const api = transport(f.build, f.store, f.readEvents)
    f.readEvents.mockResolvedValue(events.filter(event => event.seq !== 4))
    expect((await api.request('/conductor/overview/result?operationId=send')).data.text).toBe('')
    f.readEvents.mockImplementation(async () => { api.setCaller(undefined); return events })
    expect((await api.request('/conductor/overview/result?operationId=send')).status).toBe(403)
  })
})
