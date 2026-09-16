import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { httpOverview, type OverviewRead } from '../src/overview-client-data.ts'
import { registerPanelActionRoutes, type PanelActionServices, type WebRoutePort } from '../src/service/panelapi.ts'
import { overviewOf, registerOverviewRoute } from '../src/service/overview.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'

describe('Desktop client and Host upgrade transport', () => {
  it('diagnoses fresh client assets with old Host routes, and recovers when the new Host routes become available', async () => {
    type Route = Parameters<WebRoutePort['register']>[0]
    const routes = new Map<string, Route>()
    const web: WebRoutePort = { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path) } } }
    const token = 'a'.repeat(43)
    const execute = vi.fn()
    const services: PanelActionServices = {
      catalog: vi.fn(),
      authorize: async controllerSessionId => ({ authority: 'local-user', token, controller: { sessionId: controllerSessionId }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) as Awaited<ReturnType<PanelActionServices['authorize']>>,
      resolveCaller: async value => value === token ? { authority: 'local-user', sessionId: 'parent' } : undefined,
      execute,
    }
    const disposeActions = registerPanelActionRoutes(web, services)
    const calls: { path: string; method?: string }[] = []
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://local').pathname
      calls.push({ path, ...(request.method === undefined ? {} : { method: request.method }) })
      const route = routes.get(path)
      if (route === undefined) { response.statusCode = 404; response.end('not found'); return }
      void Promise.resolve(route.handler(request, response)).catch(() => { response.statusCode = 500; response.end() })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw Error('expected a local TCP server')
    const origin = 'http://127.0.0.1:' + String(address.port)
    const fetcher: typeof fetch = (input, init) => fetch(new URL(String(input), origin), {
      ...init, headers: { ...init?.headers, origin, 'sec-fetch-site': 'same-origin' },
    })
    const port = httpOverview(fetcher)
    let latest: OverviewRead | undefined
    const stop = port.subscribe('parent', value => { latest = value })
    try {
      await port.refresh('parent')
      expect(latest?.error).toContain('Host 尚未提供此功能（HTTP 404）')
      expect(latest?.error).toContain('完全退出 DSH Desktop（含托盘）')
      expect(latest?.data).toBeUndefined()
      expect(calls.map(value => value.path)).toEqual(['/conductor/panel/bootstrap', '/conductor/overview'])
      expect(execute).not.toHaveBeenCalled()

      const store = new ConductorStore(createInMemoryTables())
      const disposeOverview = registerOverviewRoute(web, services, store, sessionId => overviewOf(store, sessionId, []))
      try {
        await port.refresh('parent')
        expect(latest?.error).toBeUndefined()
        expect(latest?.data).toMatchObject({ sessionId: 'parent', tasks: [], receipts: [], outputs: [] })
        expect(execute).not.toHaveBeenCalled()
      } finally { disposeOverview?.() }
    } finally {
      stop(); port.close(); disposeActions?.()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
    }
  })

  it('distinguishes an entirely missing Host plugin from a missing new feature route', async () => {
    const request = vi.fn(async () => new Response('not found', { status: 404 }))
    const port = httpOverview(request)
    let latest: OverviewRead | undefined
    const stop = port.subscribe('parent', value => { latest = value })
    try {
      await port.refresh('parent')
      expect(latest?.error).toContain('协调插件服务尚未加载（HTTP 404）')
      expect(request).toHaveBeenCalledTimes(1)
      expect(latest?.data).toBeUndefined()
    } finally { stop(); port.close() }
  })
})
