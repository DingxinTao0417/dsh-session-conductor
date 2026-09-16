import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { FsInfo } from '@deepseek-ai/dsh-fs'
import type { PanelCaller } from '../src/domain/panel-actions.ts'
import type { PanelActionServices, WebRoutePort } from '../src/service/panelapi.ts'
import type { PreviewContext, PreviewServices } from '../src/service/preview.ts'
import { registerTerminalRoutes, resolveWorkspaceShell, type TerminalSubprocess } from '../src/service/terminal.ts'

type Route = Parameters<WebRoutePort['register']>[0]
type Request = Parameters<Route['handler']>[0]
const token = 'a'.repeat(43)
const headers = {
  host: 'localhost:43210', origin: 'http://localhost:43210', 'sec-fetch-site': 'same-origin',
  'content-type': 'application/json', authorization: 'Bearer ' + token,
}

class MockOutput extends EventEmitter {
  override off(event: string, listener: (...args: unknown[]) => void): this { return this.removeListener(event, listener) }
}

function fixture(options: { subprocess?: boolean } = {}) {
  const output = new MockOutput()
  const writes: string[] = []
  const spawned: unknown[] = []
  const terminate = vi.fn(async () => { output.emit('end'); output.emit('close') })
  const subprocess: TerminalSubprocess = {
    resolveExecutable: async (command) => command === 'missing' ? Promise.reject(new Error('not on PATH')) : `/shell/${command}`,
    spawnTerminal: async (spec) => {
      spawned.push(spec)
      return {
        pid: 11,
        output: output as unknown as Awaited<ReturnType<TerminalSubprocess['spawnTerminal']>>['output'],
        done: new Promise(() => {}),
        write: async (data) => { writes.push(data) },
        terminate,
      }
    },
  }
  const control = {
    caller: { authority: 'local-user', sessionId: 'parent' } as PanelCaller | undefined,
    allowed: true, cwd: '/workspace', identity: 'binding:1',
    info: { type: 'directory', version: 'v1' } as FsInfo,
  }
  const fs: PreviewContext['fs'] = {
    resolve: vi.fn(async (path) => ({ targetKey: 'root' as never, displayPath: path })),
    contains: vi.fn(() => true),
    stat: vi.fn(async () => control.info),
    readBytes: vi.fn(async () => new Uint8Array()),
  }
  const context = vi.fn<PreviewServices['context']>((reader, target) => {
    if (!control.allowed || reader !== 'parent' || target !== 'parent') return undefined
    return { cwd: control.cwd, identity: control.identity, fs, isCurrent: () => control.allowed }
  })
  const routes = new Map<string, Route>()
  const web: WebRoutePort = {
    register(value: Route) {
      routes.set(value.path, value)
      return () => { routes.delete(value.path) }
    },
  }
  const dispose = registerTerminalRoutes(web, {
    resolveCaller: async (value: string) => value === token ? control.caller : undefined,
    isCallerCurrent: () => true,
  } as unknown as PanelActionServices, {
    context,
    subprocess: () => options.subprocess === false ? undefined : subprocess,
  })!
  async function post(body: unknown, override: Partial<Request> = {}) {
    const response = { statusCode: 0, body: '', chunks: [] as string[], headers: new Map<string, string>(),
      setHeader(name: string, value: string) { this.headers.set(name, value) },
      write(value?: string | Uint8Array) { this.chunks.push(typeof value === 'string' ? value : Buffer.from(value ?? []).toString('utf8')); return true },
      end(value?: string) { this.body += value ?? '' },
    }
    await routes.get('/conductor/terminal')!.handler({ method: 'POST', url: '/conductor/terminal', headers, socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) }, ...override,
    }, response)
    return { status: response.statusCode, data: response.body ? JSON.parse(response.body) as Record<string, unknown> : {}, headers: response.headers, response }
  }
  async function stream(id: string) {
    const response = { statusCode: 0, body: '', chunks: [] as string[], headers: new Map<string, string>(),
      setHeader(name: string, value: string) { this.headers.set(name, value) },
      write(value?: string | Uint8Array) { this.chunks.push(typeof value === 'string' ? value : Buffer.from(value ?? []).toString('utf8')); return true },
      end(value?: string) { this.body += value ?? '' },
    }
    await routes.get('/conductor/terminal/output')!.handler({
      method: 'GET', url: '/conductor/terminal/output?id=' + id, headers, socket: { remoteAddress: '127.0.0.1' },
    } as Request, response)
    return { status: response.statusCode, chunks: response.chunks, data: response.body ? JSON.parse(response.body) as Record<string, unknown> : undefined, response }
  }
  return { post, stream, output, writes, spawned, terminate, control, dispose }
}

describe('workspace terminal PTY', () => {
  it('spawns the resolved shell in the current session cwd', async () => {
    const f = fixture()
    const opened = await f.post({ action: 'open', cols: 80, rows: 24 })
    expect(opened.status).toBe(200)
    expect(opened.data.cwd).toBe('/workspace')
    expect(typeof opened.data.id).toBe('string')
    expect(f.spawned).toEqual([expect.objectContaining({ cwd: '/workspace', cols: 80, rows: 24, argv: [expect.stringMatching(/\/shell\//)] })])
    f.dispose()
    expect(f.terminate).toHaveBeenCalled()
  })

  it('replays banner bytes that arrived before the output stream attached', async () => {
    const f = fixture()
    const opened = await f.post({ action: 'open' })
    f.output.emit('data', Buffer.from('PS /workspace> '))
    const stream = await f.stream(String(opened.data.id))
    expect(stream.status).toBe(200)
    expect(stream.chunks.join('')).toBe('PS /workspace> ')
    f.output.emit('data', Buffer.from('dir\r'))
    expect(stream.chunks.join('')).toBe('PS /workspace> dir\r')
  })

  it('writes keystrokes to the live handle', async () => {
    const f = fixture()
    const opened = await f.post({ action: 'open' })
    const sent = await f.post({ action: 'input', id: opened.data.id, data: 'Get-ChildItem\r' })
    expect(sent.status).toBe(200)
    expect(f.writes).toEqual(['Get-ChildItem\r'])
  })

  it('names a missing PTY instead of opening a fake shell', async () => {
    const f = fixture({ subprocess: false })
    const opened = await f.post({ action: 'open' })
    expect(opened.status).toBe(503)
    expect(opened.data.error).toBe('NO_PTY')
    expect(opened.data.message).toMatch(/spawnTerminal/)
  })
})

describe('workspace shell resolution', () => {
  it('prefers the platform interactive shell the Host can resolve', async () => {
    const seen: string[] = []
    const path = await resolveWorkspaceShell({
      resolveExecutable: async (command) => { seen.push(command); return '/bin/' + command },
    })
    expect(path.startsWith('/bin/')).toBe(true)
    expect(seen[0]).toMatch(/powershell|bash/)
  })
})
