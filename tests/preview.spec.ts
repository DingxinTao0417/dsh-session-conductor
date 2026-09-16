import { posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FsError, type FsInfo, type FsTarget } from '@deepseek-ai/dsh-fs'
import type { PanelCaller } from '../src/domain/panel-actions.ts'
import type { PanelActionServices, WebRoutePort } from '../src/service/panelapi.ts'
import { registerPreviewRoute, type PreviewContext, type PreviewServices } from '../src/service/preview.ts'

type Route = Parameters<WebRoutePort['register']>[0]
type Request = Parameters<Route['handler']>[0]
const token = 'a'.repeat(43)
const headers = {
  host: 'localhost:43210', origin: 'http://localhost:43210', 'sec-fetch-site': 'same-origin',
  'content-type': 'application/json', authorization: 'Bearer ' + token,
}

/** Backend fixture owns canonical identity; display paths deliberately are not authority. */
function fixture(options: { callerGuard?: boolean } = {}) {
  const aliases = new Map<string, string>()
  const paths = new WeakMap<FsTarget, string>()
  const entries = new Map<string, FsTarget>()
  const control = {
    bytes: Buffer.from('# 预览\n中文及 emoji 🌱\n'),
    caller: { authority: 'local-user', sessionId: 'parent' } as PanelCaller | undefined,
    allowed: true, cwd: '/workspace', identity: 'binding:1',
    info: { type: 'file', version: 'v1' } as FsInfo | undefined,
    onRead: undefined as (() => void | Promise<void>) | undefined,
    onStat: undefined as ((count: number) => void | Promise<void>) | undefined,
  }
  const fs: PreviewContext['fs'] = {
    resolve: vi.fn(async (path, options) => {
      const requested = posix.resolve(options?.cwd ?? '/', path)
      const canonical = aliases.get(requested) ?? requested
      let target = entries.get(canonical)
      if (!target) {
        target = { targetKey: ('opaque-' + entries.size) as FsTarget['targetKey'], displayPath: requested }
        entries.set(canonical, target); paths.set(target, canonical)
      }
      return target
    }),
    contains: vi.fn((parent, child) => {
      const base = paths.get(parent), path = paths.get(child)
      return base !== undefined && path !== undefined && (path === base || path.startsWith(base + '/'))
    }),
    stat: vi.fn(async () => {
      await control.onStat?.(++statCalls)
      return control.info
    }),
    readBytes: vi.fn(async () => {
      await control.onRead?.()
      return control.bytes
    }),
  }
  let statCalls = 0
  let provider = fs
  const context = vi.fn<PreviewServices['context']>((reader: string, target: string): PreviewContext | undefined => {
    if (!control.allowed || reader !== 'parent' || !['parent', 'child'].includes(target)) return undefined
    const { cwd, identity } = control, captured = provider
    return { cwd, identity, fs: captured,
      isCurrent: () => control.allowed && control.cwd === cwd && control.identity === identity && provider === captured }
  })
  const resolveCaller = vi.fn(async (value: string) => value === token ? control.caller : undefined)
  const isCallerCurrent = vi.fn((value: string, caller: PanelCaller) => value === token && control.caller === caller)
  let route: Route | undefined
  const unregister = vi.fn(() => { route = undefined })
  const web: WebRoutePort = { register(value) { route = value; return unregister } }
  const dispose = registerPreviewRoute(web, { resolveCaller,
    ...options.callerGuard === false ? {} : { isCallerCurrent },
  } as unknown as PanelActionServices, { context })!
  async function request(body: unknown = { path: 'report.md' }, override: Partial<Request> = {}) {
    const response = { statusCode: 0, body: '', headers: new Map<string, string>(),
      setHeader(name: string, value: string) { this.headers.set(name, value) },
      end(value?: string) { this.body = value ?? '' },
    }
    await route!.handler({ method: 'POST', url: '/conductor/preview', headers, socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) }, ...override,
    }, response)
    return { status: response.statusCode, data: JSON.parse(response.body) as Record<string, unknown>, headers: response.headers }
  }
  return { request, control, fs, aliases, resolveCaller, isCallerCurrent, context, dispose, unregister,
    changeProvider() { provider = { ...fs } },
  }
}

describe('workspace file preview', () => {
  it('previews current-session UTF-8 content through a bounded read without caching it', async () => {
    const f = fixture()
    const result = await f.request()
    expect(result.status).toBe(200)
    expect(result.data).toEqual({ kind: 'text', path: '/workspace/report.md', text: '# 预览\n中文及 emoji 🌱\n', truncated: false })
    expect(f.context).toHaveBeenCalledWith('parent', 'parent')
    expect(f.fs.readBytes).toHaveBeenCalledWith(expect.any(Object), undefined, 524_288)
    expect(result.headers.get('cache-control')).toBe('no-store')
    f.dispose()
    expect(f.unregister).toHaveBeenCalledOnce()
  })

  it('allows an explicitly authorized child using the server reader identity', async () => {
    const f = fixture()
    expect((await f.request({ path: 'report.md', sessionId: 'child' })).status).toBe(200)
    expect(f.context).toHaveBeenCalledWith('parent', 'child')
  })

  it('accepts exactly 512 KiB, then reports the 200,000-character display limit', async () => {
    const f = fixture()
    f.control.bytes = Buffer.from('x'.repeat(524_288))
    f.control.info = { ...f.control.info!, size: 524_288 }
    const result = await f.request()
    expect(result.status).toBe(200)
    expect(result.data.text).toBe('x'.repeat(200_000))
    expect(result.data.truncated).toBe(true)
  })

  it('does not call the reader for a file already larger than 512 KiB', async () => {
    const f = fixture()
    f.control.info = { ...f.control.info!, size: 524_289 }
    expect((await f.request()).status).toBe(413)
    expect(f.fs.readBytes).not.toHaveBeenCalled()
  })

  it('rejects excess bytes even if the initial stat had no size', async () => {
    const f = fixture()
    f.control.bytes = Buffer.from('x'.repeat(524_289))
    const result = await f.request()
    expect(result.status).toBe(413)
    expect(result.data.text).toBeUndefined()
  })

  it('reports the byte limit when the bounded backend rejects a file that grew during reading', async () => {
    const f = fixture()
    f.control.onRead = () => { throw new FsError('fixture exceeds read cap', 'FS_TOO_LARGE') }
    const result = await f.request()
    expect(result.status).toBe(413)
    expect(result.data.error).toBe('FILE_TOO_LARGE')
    expect(result.data.text).toBeUndefined()
  })

  it('does not mark exactly 200,000 characters as truncated', async () => {
    const f = fixture()
    f.control.bytes = Buffer.from('a'.repeat(200_000))
    expect((await f.request()).data.truncated).toBe(false)
  })

  it.each(['../secret.txt', '/workspace-other/secret.txt', '/secret.txt'])('rejects path escape %s before reading', async path => {
    const f = fixture()
    expect((await f.request({ path })).data.error).toBe('OUTSIDE_WORKSPACE')
    expect(f.fs.stat).not.toHaveBeenCalled()
    expect(f.fs.readBytes).not.toHaveBeenCalled()
  })

  it('rejects a workspace-looking symlink whose canonical target is outside', async () => {
    const f = fixture()
    f.aliases.set('/workspace/report.md', '/secrets/token.txt')
    expect((await f.request()).data.error).toBe('OUTSIDE_WORKSPACE')
    expect(f.fs.readBytes).not.toHaveBeenCalled()
  })

  it.each(['directory', 'other'] as const)('rejects %s targets without reading', async type => {
    const f = fixture()
    f.control.info = { ...f.control.info!, type }
    expect((await f.request()).status).toBe(415)
    expect(f.fs.readBytes).not.toHaveBeenCalled()
  })

  it('reports a missing file without returning content', async () => {
    const f = fixture(); f.control.info = undefined
    const result = await f.request()
    expect(result.status).toBe(404)
    expect(result.data.error).toBe('FILE_NOT_FOUND')
    expect(f.fs.readBytes).not.toHaveBeenCalled()
  })

  it.each([Buffer.from([0x61, 0x00, 0x62]), Buffer.from([0xc3, 0x28])])('rejects binary or invalid UTF-8 bytes', async bytes => {
    const f = fixture(); f.control.bytes = bytes
    const result = await f.request()
    expect(result.status).toBe(415)
    expect(result.data.error).toBe('UNSUPPORTED_FILE')
    expect(result.data.text).toBeUndefined()
  })
})

describe('preview authority and filesystem races', () => {
  it('previews a cold session through asynchronous metadata contexts and current leases', async () => {
    const f = fixture(), read = f.context.getMockImplementation()!
    f.context.mockImplementation(async (reader, target) => {
      await Promise.resolve()
      return await read(reader, target)
    })
    expect(await f.request()).toMatchObject({ status: 200, data: { text: '# 预览\n中文及 emoji 🌱\n' } })
    expect(f.context).toHaveBeenCalledTimes(3)
    expect(f.isCallerCurrent).toHaveBeenCalledTimes(3)
  })

  it('refuses asynchronous metadata contexts without a synchronous lease guard', async () => {
    const f = fixture(), read = f.context.getMockImplementation()!
    f.context.mockImplementation(async (reader, target) => {
      const value = await read(reader, target)
      return value && { cwd: value.cwd, identity: value.identity, fs: value.fs }
    })
    expect(await f.request()).toMatchObject({ status: 403, data: { error: 'PREVIEW_UNAVAILABLE' } })
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })

  it('refuses asynchronous metadata contexts without a synchronous caller guard', async () => {
    const f = fixture({ callerGuard: false }), read = f.context.getMockImplementation()!
    f.context.mockImplementation(async (reader, target) => await read(reader, target))
    expect(await f.request()).toMatchObject({ status: 403, data: { error: 'PREVIEW_UNAVAILABLE' } })
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })

  it.each(['expired', 'revoked', 'rebound', 'cwd-changed', 'provider-changed'] as const)(
    'withholds content when %s happens inside the last cold metadata read', async change => {
      const f = fixture(), read = f.context.getMockImplementation()!
      let contexts = 0
      f.context.mockImplementation(async (reader, target) => {
        const value = await read(reader, target)
        if (++contexts === 3) {
          if (change === 'expired') f.control.caller = undefined
          if (change === 'revoked') f.control.allowed = false
          if (change === 'rebound') f.control.identity = 'binding:2'
          if (change === 'cwd-changed') f.control.cwd = '/different-workspace'
          if (change === 'provider-changed') f.changeProvider()
        }
        return value
      })
      const result = await f.request()
      expect(result.status).toBe(403)
      expect(result.data.error).toBe('PREVIEW_ACCESS_CHANGED')
      expect(result.data.text).toBeUndefined()
    })

  it('refuses filesystem reads if the token expires during initial cold context resolution', async () => {
    const f = fixture(), read = f.context.getMockImplementation()!
    f.context.mockImplementation(async (reader, target) => {
      const value = await read(reader, target)
      f.control.caller = undefined
      return value
    })
    expect(await f.request()).toMatchObject({ status: 403, data: { error: 'PREVIEW_ACCESS_CHANGED' } })
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })

  it('withholds content if a versionless file disappears during reading', async () => {
    const f = fixture()
    f.control.info = { type: 'file' } as FsInfo
    f.control.onRead = () => { f.control.info = undefined }
    const result = await f.request()
    expect(result.status).toBe(409)
    expect(result.data.error).toBe('FILE_CHANGED')
    expect(result.data.text).toBeUndefined()
  })

  it.each(['expired', 'changed-reader', 'revoked', 'rebound', 'cwd-changed'] as const)('withholds content after %s during the read', async change => {
    const f = fixture()
    f.control.onRead = () => {
      if (change === 'expired') f.control.caller = undefined
      if (change === 'changed-reader') f.control.caller = { authority: 'local-user', sessionId: 'other-reader' }
      if (change === 'revoked') f.control.allowed = false
      if (change === 'rebound') f.control.identity = 'binding:2'
      if (change === 'cwd-changed') f.control.cwd = '/different-workspace'
    }
    const result = await f.request({ path: 'report.md', sessionId: 'child' })
    expect(result.status).toBe(403)
    expect(result.data.error).toBe('PREVIEW_ACCESS_CHANGED')
    expect(result.data.text).toBeUndefined()
  })

  it.each(['target', 'root', 'version'] as const)('withholds content when canonical %s changes during reading', async change => {
    const f = fixture()
    f.control.onRead = () => {
      if (change === 'target') f.aliases.set('/workspace/report.md', '/workspace/other.md')
      if (change === 'root') f.aliases.set('/workspace', '/moved-workspace')
      if (change === 'version') f.control.info = { ...f.control.info!, version: 'v2' as FsInfo['version'] }
    }
    const result = await f.request()
    expect(result.status).toBe(409)
    expect(result.data.error).toBe('FILE_CHANGED')
    expect(result.data.text).toBeUndefined()
  })

  it('withholds content when access is revoked during the final metadata check', async () => {
    const f = fixture()
    f.control.onStat = count => { if (count === 2) f.control.allowed = false }
    const result = await f.request()
    expect(result.status).toBe(403)
    expect(result.data.text).toBeUndefined()
  })

  it('withholds content when the filesystem provider changes during reading', async () => {
    const f = fixture(); f.control.onRead = f.changeProvider
    const result = await f.request()
    expect(result.status).toBe(403)
    expect(result.data.text).toBeUndefined()
  })
})

describe('preview request boundary', () => {
  it.each([
    { authorization: '' }, { authorization: 'Bearer wrong-token' }, { authorization: ['Bearer ' + token] },
  ])('rejects absent or malformed authorization before resolving a file', async authorization => {
    const f = fixture()
    expect((await f.request(undefined, { headers: { ...headers, ...authorization } })).status).toBe(401)
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })

  it('rejects a revoked caller and an unauthorized target before filesystem access', async () => {
    const f = fixture()
    expect((await f.request({ path: 'report.md', sessionId: 'unrelated-session' })).status).toBe(403)
    f.control.caller = undefined
    expect((await f.request()).status).toBe(401)
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })

  it.each([
    { socket: { remoteAddress: '192.168.0.2' } },
    { headers: { ...headers, host: 'rebinding.example:43210' } },
    { headers: { ...headers, origin: 'https://evil.example' } },
    { headers: { ...headers, 'sec-fetch-site': 'cross-site' } },
  ])('rejects requests outside the local same-origin boundary', async override => {
    const f = fixture()
    expect((await f.request(undefined, override)).status).toBe(403)
    expect(f.resolveCaller).not.toHaveBeenCalled()
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })

  it.each([null, {}, { path: '' }, { path: 'a\0b' }, { path: 'x'.repeat(4097) },
    { path: 'report.md', caller: 'admin' }, { path: 'report.md', sessionId: 1 }])('rejects malformed file requests', async body => {
    const f = fixture()
    expect((await f.request(body)).status).toBe(400)
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })

  it('rejects GET so file requests cannot be triggered by passive resource loading', async () => {
    const f = fixture()
    const result = await f.request(undefined, { method: 'GET' })
    expect(result.status).toBe(405)
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })
})
