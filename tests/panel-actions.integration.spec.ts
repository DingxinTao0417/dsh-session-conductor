import { describe, expect, it, vi } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import { parsePanelAction } from '../src/domain/panel-actions.ts'
import { createPanelController } from '../src/service/panel-controller.ts'
import type { WebRoutePort } from '../src/service/panelapi.ts'

type Route = Parameters<WebRoutePort['register']>[0]
type Request = Parameters<Route['handler']>[0]

async function panelHost(notice = false) {
  const routes = new Map<string, Route>()
  const owner = { id: 'owner', status: 'idle', session: { events: notice ? [
    { seq: 0, type: 'user/message', time: 1, data: { source: { kind: 'plugin', form: 'notice', plugin: 'dsh-session-conductor' } } },
    { seq: 1, type: 'turn/start', time: 2, data: { turn: 1 } },
    { seq: 2, type: 'turn/end', time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ] : [] } }
  const observer = { id: 'observer', status: 'idle', session: { events: [] } }
  const target = { id: 'session-1', status: 'idle', session: { events: [], header: { cwd: 'D:/target' } },
    inbox: { hasPending: false, nextTurn: [], nextStep: [], remove: () => undefined, replace: () => undefined },
    steer: vi.fn(), followup: vi.fn(), cancel: vi.fn() }
  const agents = new Map<string, { id: string }>([[owner.id, owner], [observer.id, observer], [target.id, target]])
  const plugin = await mountedPlugin({
    agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] },
    sessions: { flush: async () => true },
    webServer: { register(route: Route) { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
  })
  const request = async (path: string, value?: unknown, token?: string, override?: Partial<Request>) => {
    const response = { statusCode: 0, body: '', headers: {} as Record<string, string>,
      setHeader(name: string, value: string) { this.headers[name] = value }, end(body?: string) { this.body = body ?? '' } }
    const route = routes.get(path)
    expect(route, `mounted route ${path}`).toBeDefined()
    await route!.handler({
      method: value === undefined ? 'GET' : 'POST', url: path,
      headers: { host: 'localhost:43120', origin: 'http://localhost:43120', 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json', ...token === undefined ? {} : { authorization: `Bearer ${token}` } },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(value)) },
      ...override,
    }, response)
    return { ...response, data: JSON.parse(response.body) as Record<string, unknown> }
  }
  const authorize = async (id = 'owner') => {
    const response = await request('/conductor/panel/bootstrap', { controllerSessionId: id })
    expect(response.statusCode).toBe(200)
    return response.data.token as string
  }
  return { plugin, routes, request, authorize, agents, target }
}

describe('production panel action transport and shared tools', () => {
  it('lists Host controllers and authorizes a separate ephemeral token for each tab', async () => {
    const host = await panelHost()
    try {
      const catalog = await host.request('/conductor/panel/bootstrap')
      expect(catalog.data).toMatchObject({ authority: 'local-user', controllers: [
        expect.objectContaining({ sessionId: 'owner' }), expect.objectContaining({ sessionId: 'observer' }), expect.objectContaining({ sessionId: 'session-1' }),
      ] })
      expect(await host.authorize()).not.toBe(await host.authorize())
      expect((await host.request('/conductor/panel/bootstrap', { controllerSessionId: 'invented' })).statusCode).toBe(403)
      expect((await host.request('/conductor/panel/bootstrap', { controllerSessionId: 'owner', ownerSessionId: 'owner' })).statusCode).toBe(400)
    } finally { await host.plugin.close() }
  })

  it('refuses network, identity, token and schema violations before dispatch', async () => {
    const host = await panelHost()
    try {
      const token = await host.authorize()
      const value = { action: 'send', parameters: { taskId: 'target', text: 'hi' }, operationId: 'panel-one' }
      expect((await host.request('/conductor/panel/action', value)).statusCode).toBe(401)
      expect((await host.request('/conductor/panel/action', value, token, { socket: { remoteAddress: '10.0.0.1' } })).statusCode).toBe(403)
      expect((await host.request('/conductor/panel/action', { ...value, parameters: { ...value.parameters, callerSessionId: 'owner' } }, token)).statusCode).toBe(400)
      expect((await host.request('/conductor/panel/action', { ...value, parameters: { ...value.parameters, mode: 'invented' } }, token)).statusCode).toBe(400)
      expect((await host.request('/conductor/panel/action', { ...value, action: 'bash' }, token)).statusCode).toBe(400)
      expect(host.target.steer).not.toHaveBeenCalled()
    } finally { await host.plugin.close() }
  })

  it('uses shared owner authorization, preserves stable receipts, and rejects changed retries', async () => {
    const host = await panelHost()
    try {
      const token = await host.authorize()
      const value = { action: 'send', parameters: { taskId: 'target', text: 'check', mode: 'steer', expectedBindingVersion: 1, expectedOwnerEpoch: 0 }, operationId: 'panel-send' }
      const [first, retry] = await Promise.all([
        host.request('/conductor/panel/action', value, token), host.request('/conductor/panel/action', value, token),
      ])
      expect(first.statusCode).toBe(200); expect(retry.data).toEqual(first.data)
      expect(host.target.steer).toHaveBeenCalledTimes(1)
      expect((await host.request('/conductor/panel/action', { ...value, parameters: { ...value.parameters, text: 'different' } }, token)).data.error).toMatch(/IDEMPOTENCY_CONFLICT/)
      const outsider = await host.authorize('observer')
      expect((await host.request('/conductor/panel/action', { ...value, operationId: 'observer-send' }, outsider)).statusCode).toBe(409)
      expect(host.target.steer).toHaveBeenCalledTimes(1)
    } finally { await host.plugin.close() }
  })

  it('allows an explicit local user click while keeping a notice-triggered model write forbidden', async () => {
    const host = await panelHost(true)
    try {
      const args = { taskId: 'target', text: 'human instruction', expectedBindingVersion: 1, expectedOwnerEpoch: 0 }
      await expect(host.plugin.call('conductor_send', args)).rejects.toThrow(/REPORT_TRIGGERED/)
      const token = await host.authorize()
      expect((await host.request('/conductor/panel/action', { action: 'send', parameters: args, operationId: 'human-click' }, token)).statusCode).toBe(200)
      expect(host.target.steer).toHaveBeenCalledTimes(1)
      await expect(host.plugin.call('conductor_send', { ...args, explicitLocalUserInvocation: true })).rejects.toThrow(/REPORT_TRIGGERED/)
    } finally { await host.plugin.close() }
  })

  it('invalidates tokens when the Agent identity is replaced or plugin is unloaded', async () => {
    const host = await panelHost()
    const token = await host.authorize()
    host.agents.set('owner', { id: 'owner' })
    expect((await host.request('/conductor/panel/action', { action: 'read', parameters: { taskId: 'target' }, operationId: 'old-actor' }, token)).statusCode).toBe(401)
    await host.plugin.close()
    expect(host.routes.size).toBe(0)
  })

  it('enforces UTF-8 JSON and bounded bodies', async () => {
    const host = await panelHost()
    try {
      const token = await host.authorize()
      const value = { action: 'send', parameters: { taskId: 'target', text: 'x'.repeat(65_536) }, operationId: 'large-body' }
      expect((await host.request('/conductor/panel/action', value, token)).statusCode).toBe(413)
      expect((await host.request('/conductor/panel/action', {}, token, {
        async *[Symbol.asyncIterator]() { yield Buffer.from([0xff]) },
      })).statusCode).not.toBe(200)
      expect(host.target.steer).not.toHaveBeenCalled()
    } finally { await host.plugin.close() }
  })
})

it('expires capabilities after thirty minutes and never accepts a model-reported caller', async () => {
  const actor = { id: 'real-controller' }; let now = 1000
  const service = createPanelController({ agents: () => ({ get: () => actor, list: () => [actor] }), definitions: new Map(), active: () => true, now: () => now })
  const authorization = await service.authorize(actor.id)
  expect(await service.resolveCaller(authorization.token)).toEqual({ sessionId: actor.id, authority: 'local-user' })
  now += 30 * 60_000
  expect(await service.resolveCaller(authorization.token)).toBeUndefined()
  service.dispose()
  expect(() => parsePanelAction({ action: 'send', operationId: 'test', parameters: { ownerSessionId: actor.id } })).toThrow(/server-owned/)
})
