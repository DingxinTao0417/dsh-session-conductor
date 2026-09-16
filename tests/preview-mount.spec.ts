import { posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WebRoutePort } from '../src/service/panelapi.ts'
import { mountedPlugin } from './helpers/mounted-plugin.ts'

type Route = Parameters<WebRoutePort['register']>[0]
const tick = async () => { for (let index = 0; index < 30; index++) await Promise.resolve() }

async function fixture(cold = false) {
  const routes = new Map<string, Route>()
  const owner = { id: 'owner', status: 'idle', session: { header: { cwd: '/workspace', createdAt: 1 }, events: [] } }
  const headers = new Map([['owner', { id: 'owner', cwd: '/workspace', createdAt: 1 }]])
  const readSession = vi.fn(() => { throw Error('overview must not read histories') })
  const agents = new Map(cold ? [] : [['owner', owner]])
  const plugin = await mountedPlugin({
    agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] },
    sessionQuery: { listSessions: async () => [...headers.values()].map(header => ({ header, live: !cold, persisted: true })), readSession },
    webServer: { register(route: Route) { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
  })
  async function request(path: string, body?: unknown, token?: string) {
    const response = { statusCode: 0, body: '', setHeader() {}, end(value?: string) { this.body = value ?? '' } }
    await routes.get(path)!.handler({ method: body === undefined ? 'GET' : 'POST', url: path,
      headers: { host: 'localhost:43210', origin: 'http://localhost:43210', 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json', ...token ? { authorization: 'Bearer ' + token } : {} },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }, response)
    return { status: response.statusCode, data: JSON.parse(response.body) as Record<string, unknown> }
  }
  const authorized = await request('/conductor/panel/bootstrap', { controllerSessionId: 'owner' })
  expect(authorized.status).toBe(200)
  const readBytes = vi.fn(async (): Promise<Buffer> => Buffer.from('# Mounted preview'))
  const fs = {
    resolve: async (path: string, options?: { cwd?: string }) => {
      const canonical = posix.resolve(options?.cwd ?? '/', path)
      return { targetKey: canonical, displayPath: canonical }
    },
    contains: (parent: { targetKey: string }, child: { targetKey: string }) => child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey + '/'),
    stat: async () => ({ type: 'file', version: '1' }), readBytes,
  }
  return { plugin, routes, fs, readBytes, request, headers, agents, readSession, token: authorized.data.token as string }
}

describe('production preview provider injection', () => {
  it('reads a cold session overview and its workspace file without restoring an Agent or reading history', async () => {
    const f = await fixture(true)
    try {
      f.plugin.context.provide('fs', f.fs)
      await tick()
      expect(await f.request('/conductor/overview', undefined, f.token)).toMatchObject({ status: 200, data: { sessionId: 'owner' } })
      expect(await f.request('/conductor/preview', { path: 'report.md' }, f.token)).toMatchObject({ status: 200, data: { text: '# Mounted preview', path: '/workspace/report.md' } })
      expect(await f.request('/conductor/panel/action', { action: 'list', operationId: 'cold-action', parameters: {} }, f.token)).toMatchObject({ status: 409, data: { error: expect.stringContaining('CONTROLLER_INACTIVE') } })
      expect(f.agents.size).toBe(0)
      expect(f.readSession).not.toHaveBeenCalled()
    } finally { await f.plugin.close() }
  })

  it('does not return a cold workspace file after the persisted identity disappears during reading', async () => {
    const f = await fixture(true)
    f.readBytes.mockImplementation(async () => { f.headers.delete('owner'); return Buffer.from('must remain private') })
    try {
      f.plugin.context.provide('fs', f.fs)
      await tick()
      const result = await f.request('/conductor/preview', { path: 'report.md' }, f.token)
      expect(result).toMatchObject({ status: 403, data: { error: 'PREVIEW_ACCESS_CHANGED' } })
      expect(JSON.stringify(result)).not.toContain('must remain private')
      expect(f.readSession).not.toHaveBeenCalled()
    } finally { await f.plugin.close() }
  })

  it('waits for an optional filesystem, uses its native scope, and releases its route with the provider', async () => {
    const f = await fixture()
    try {
      expect(f.routes.has('/conductor/overview')).toBe(true)
      expect(f.routes.has('/conductor/preview')).toBe(false)
      await expect(f.plugin.call('conductor_model', { action: 'show', taskId: 'target' })).resolves.toMatchObject({ changed: false })

      const removeProvider = f.plugin.context.provide('fs', f.fs)
      await tick()
      expect(f.routes.has('/conductor/preview')).toBe(true)
      expect(await f.request('/conductor/preview', { path: 'report.md' }, f.token)).toMatchObject({
        status: 200, data: { kind: 'text', path: '/workspace/report.md', text: '# Mounted preview' },
      })
      expect(f.readBytes).toHaveBeenCalledTimes(1)
      await removeProvider()
      await tick()
      expect(f.routes.has('/conductor/preview')).toBe(false)
      expect(f.routes.has('/conductor/overview')).toBe(true)
      f.plugin.context.provide('fs', { ...f.fs })
      await tick()
      expect(f.routes.has('/conductor/preview')).toBe(true)
    } finally { await f.plugin.close() }
    expect(f.routes.size).toBe(0)
  })

  it('invalidates an in-flight preview when its filesystem provider is removed', async () => {
    const f = await fixture()
    let release!: (value: Buffer) => void, reading!: () => void
    const started = new Promise<void>(resolve => { reading = resolve })
    const pending = new Promise<Buffer>(resolve => { release = resolve })
    f.readBytes.mockImplementation(async () => { reading(); return await pending })
    try {
      const removeProvider = f.plugin.context.provide('fs', f.fs)
      await tick()
      const result = f.request('/conductor/preview', { path: 'report.md' }, f.token)
      await started
      await removeProvider()
      await tick()
      release(Buffer.from('must not be disclosed'))
      expect(await result).toMatchObject({ status: 403, data: { error: 'PREVIEW_ACCESS_CHANGED' } })
      expect(f.routes.has('/conductor/preview')).toBe(false)
    } finally { release(Buffer.from('')); await f.plugin.close() }
  })
})
