import { describe, expect, it } from 'vitest'
import { registerPanelDetailRoute, registerPanelRoute, type WebRoutePort } from '../src/service/panelapi.ts'

type Route = Parameters<WebRoutePort['register']>[0]
type Request = Parameters<Route['handler']>[0]

const local: Request = {
  method: 'GET', url: '/conductor/panel/task?taskId=task-1',
  headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' },
}

for (const kind of ['list', 'detail'] as const) {
  describe(`${kind} panel transport fence`, () => {
    function capture() {
      let route: Route | undefined
      let reads = 0
      const port: WebRoutePort = { register(value) { route = value; return () => {} } }
      if (kind === 'list') registerPanelRoute(port, () => { reads += 1; return { generatedAt: '', total: 0, tasks: [], notes: [] } })
      else registerPanelDetailRoute(port, () => { reads += 1; return undefined })
      return {
        get reads() { return reads },
        async call(request: Request) {
          const response = {
            statusCode: 0, body: '', headers: {} as Record<string, string>,
            setHeader(name: string, value: string) { this.headers[name] = value },
            end(body?: string) { this.body = body ?? '' },
          }
          await route?.handler(request, response)
          return response
        },
      }
    }

    it('serves a local GET with no Origin or with an exact same origin', async () => {
      const harness = capture()
      for (const host of ['localhost:3080', '127.8.9.10:3080', '[::1]:3080']) {
        const response = await harness.call({ ...local, headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' } })
        expect(response.statusCode).toBe(kind === 'list' ? 200 : 404)
        expect(response.headers['cache-control']).toBe('no-store')
      }
      await harness.call(local)
      expect(harness.reads).toBe(4)
    })

    it('rejects rebinding, foreign origins, remote sockets and malformed authorities before building data', async () => {
      const harness = capture()
      const bad: Request[] = [
        {},
        { ...local, headers: { host: 'evil.test:3080', origin: 'http://evil.test:3080' } },
        { ...local, headers: { host: 'localhost:3080', origin: 'http://evil.test' } },
        { ...local, headers: { host: 'localhost:3080', origin: 'http://localhost:3081' } },
        { ...local, headers: { host: 'localhost:3080', origin: 'null' } },
        { ...local, headers: { host: 'localhost:3080', origin: ['http://localhost:3080', 'http://evil.test'] } },
        { ...local, headers: { host: 'localhost:3080', 'sec-fetch-site': 'cross-site' } },
        { ...local, headers: { host: 'user@localhost:3080' } },
        { ...local, headers: { host: 'localhost:3080/path' } },
        { ...local, socket: { remoteAddress: '192.168.1.8' } },
      ]
      for (const request of bad) {
        expect((await harness.call(request)).statusCode).toBe(request.method === undefined ? 405 : 403)
      }
      expect(harness.reads).toBe(0)
    })

    it('refuses POST, HEAD and OPTIONS without reading data or enabling CORS', async () => {
      const harness = capture()
      for (const method of ['POST', 'HEAD', 'OPTIONS']) {
        const response = await harness.call({ ...local, method })
        expect(response.statusCode).toBe(405)
        expect(response.headers['allow']).toBe('GET')
        expect(response.headers['access-control-allow-origin']).toBeUndefined()
      }
      expect(harness.reads).toBe(0)
    })
  })
}
