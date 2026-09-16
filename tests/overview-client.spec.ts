import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationResources, httpOverview, safeWebUrl, resolveWebUrl } from '../src/overview-client-data.ts'
import type { SessionOverview } from '../src/domain/overview.ts'

afterEach(() => { vi.useRealTimers() })
describe('overview resource projection', () => {
  it('uses public structured source views and completed edits without exposing thoughts or raw tool output', () => {
    const value = conversationResources({ hasMore: true, nodes: [
      { kind: 'user', seq: 1, content: [{ type: 'text', text: 'Read https://example.com/docs.' }, { type: 'image', attachment: { attachmentId: 'a', name: 'capture.png' } }] },
      { kind: 'assistant', seq: 2, blocks: [{ type: 'reasoning', text: 'https://private.test' }] },
      { kind: 'tool-result', seq: 3, callView: { card: 'generic', kind: 'edit', locations: [{ path: 'src/main.ts' }] }, resultView: null },
      { kind: 'tool-result', seq: 4, isError: true, callView: { card: 'diff', locations: [{ path: 'failed.txt' }] } },
      { kind: 'tool-result', seq: 5, callView: null, resultView: { card: 'read', path: 'README.md' }, content: [{ type: 'text', text: 'https://private-tool.test' }] },
      { kind: 'tool-result', seq: 6, callView: null, resultView: { card: 'web', kind: 'search', sources: [{ url: 'https://official.example/docs', title: 'Official docs' }, { url: 'javascript:alert(1)' }] } },
      { kind: 'tool-result', seq: 7, callView: null, resultView: { card: 'web', kind: 'fetch', url: 'https://example.com/docs' } },
    ] } as never)
    expect(value.partial).toBe(true)
    expect(value.outputs.map(item => item.path)).toEqual(['src/main.ts'])
    expect(value.sources.map(item => item.title)).toEqual(['example.com/docs', 'capture.png', 'README.md', 'Official docs'])
    expect(JSON.stringify(value)).not.toMatch(/private|failed|javascript/)
  })

  it('refuses executable links and credentials in URLs', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///c:/x', 'https://secret@example.com/', 'https://name:pass@example.com']) expect(safeWebUrl(url)).toBeUndefined()
    expect(safeWebUrl('https://example.com/')).toBe('https://example.com/')
    expect(resolveWebUrl('example.com/docs')).toBe('https://example.com/docs')
    expect(resolveWebUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(resolveWebUrl('javascript:alert(1)')).toBeUndefined()
    expect(resolveWebUrl('https://secret@example.com/')).toBeUndefined()
  })
})

describe('overview HTTP lease', () => {
  const overview: SessionOverview = { sessionId: 'parent', generatedAt: '', tasks: [], receipts: [], outputs: [],
    unread: 0, needsAttention: 0, watchingTaskIds: [], sharedDirectories: [], truncated: false }
  function fixture() {
    const calls: { path: string; init: RequestInit }[] = []
    const fetcher = vi.fn(async (path: unknown, init: RequestInit = {}) => {
      calls.push({ path: String(path), init })
      const value = String(path).endsWith('bootstrap') ? {
        authority: 'local-user', token: 'a'.repeat(43), controller: { sessionId: 'parent' }, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      } : String(path).endsWith('action') ? { result: { accepted: true } } : overview
      return { ok: true, status: 200, json: async () => value } as Response
    })
    return { calls, fetcher, port: httpOverview(fetcher as typeof fetch) }
  }
  it('shares one authorization and poll per session, then aborts and stops on final unmount', async () => {
    vi.useFakeTimers()
    const f = fixture(), first = vi.fn(), second = vi.fn()
    const stop1 = f.port.subscribe('parent', first), stop2 = f.port.subscribe('parent', second)
    await f.port.refresh('parent')
    expect(f.calls.filter(call => call.path.endsWith('bootstrap'))).toHaveLength(1)
    expect(f.calls.filter(call => call.path === '/conductor/overview')).toHaveLength(1)
    expect(first.mock.calls.at(-1)?.[0].data).toEqual(overview)
    stop1(); await vi.advanceTimersByTimeAsync(5_000)
    expect(f.calls.filter(call => call.path === '/conductor/overview')).toHaveLength(2)
    stop2(); const count = f.calls.length
    expect(f.calls.at(-1)?.init.signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.calls).toHaveLength(count)
    expect(vi.getTimerCount()).toBe(0)
    f.port.close()
  })
  it('keeps action identity on explicit retry and never automatically retries a write', async () => {
    const f = fixture()
    await f.port.action('parent', 'send', { taskId: 'task', text: 'hello' }, 'stable-id')
    await f.port.action('parent', 'send', { taskId: 'task', text: 'hello' }, 'stable-id')
    const actions = f.calls.filter(call => call.path.endsWith('action'))
    expect(actions).toHaveLength(2)
    expect(JSON.parse(String(actions[0]!.init.body)).operationId).toBe('stable-id')
    expect(actions[1]!.init.body).toEqual(actions[0]!.init.body)
    expect(actions[0]!.path).not.toContain('token')
    f.port.close()
  })
  it('obtains fresh authority on an explicit click after a read-only session resumes, before dispatching once', async () => {
    const calls: string[] = []
    let authorizations = 0
    const fetcher = vi.fn(async (path: unknown) => {
      calls.push(String(path))
      return new Response(JSON.stringify(String(path).endsWith('bootstrap') ? {
        authority: 'local-user', token: (++authorizations).toString().repeat(43), controller: { sessionId: 'parent' },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), actions: authorizations === 1 ? [] : ['send'],
      } : String(path).endsWith('action') ? { result: { accepted: true } } : overview), { status: 200 })
    })
    const port = httpOverview(fetcher)
    await port.refresh('parent')
    await port.action('parent', 'send', { taskId: 'child', text: 'continue' }, 'explicit-send')
    expect(calls).toEqual(['/conductor/panel/bootstrap', '/conductor/overview', '/conductor/panel/bootstrap', '/conductor/panel/action', '/conductor/overview'])
    port.close()
  })
  it('clears visible data after authorization loss rather than keeping a stale preview', async () => {
    vi.useFakeTimers()
    const f = fixture(), listener = vi.fn()
    f.port.subscribe('parent', listener); await f.port.refresh('parent')
    f.fetcher.mockResolvedValue({ ok: false, status: 401 } as Response)
    await f.port.refresh('parent')
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ error: expect.stringContaining('401') })
    expect(listener.mock.calls.at(-1)?.[0].data).toBeUndefined()
    f.port.close()
  })
  it('distinguishes a missing session identity from an origin rejection and a cold write refusal', async () => {
    vi.useFakeTimers()
    const f = fixture(), listener = vi.fn()
    f.port.subscribe('parent', listener); await f.port.refresh('parent')
    f.fetcher.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'CONTROLLER_UNAVAILABLE: panel request refused' }) } as Response)
    await f.port.refresh('parent')
    expect(listener.mock.calls.at(-1)?.[0].error).toContain('Host 未能确认其会话记录')
    f.fetcher.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'FORBIDDEN: rejected', code: 'ORIGIN_FORBIDDEN' }) } as Response)
    await f.port.refresh('parent')
    expect(listener.mock.calls.at(-1)?.[0].error).toContain('外部来源不能访问概览接口')
    f.fetcher.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'CONTROLLER_INACTIVE: refused' }) } as Response)
    await expect(f.port.action('parent', 'list', {})).rejects.toThrow('历史会话仅支持查看')
    f.port.close()
  })
  it('uses the authenticated preview route without moving paths or tokens into the URL', async () => {
    const f = fixture()
    await f.port.refresh('parent')
    const preview = { path: 'D:/workspace/report.md', text: '# Result', truncated: false, kind: 'text' }
    f.fetcher.mockResolvedValue({ ok: true, status: 200, json: async () => preview } as Response)
    const input = { path: 'report.md', sessionId: 'child' }
    expect(await f.port.preview('parent', input)).toEqual(preview)
    const call = f.calls.find(value => value.path === '/conductor/panel/bootstrap')
    expect(call).toBeDefined()
    const [path, init] = f.fetcher.mock.calls.at(-1)!
    expect(path).toBe('/conductor/preview')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: JSON.stringify(input), headers: { authorization: 'Bearer ' + 'a'.repeat(43) } })
    f.port.close()
  })
  it('refuses a malformed preview response rather than treating it as a readable file', async () => {
    const f = fixture()
    await f.port.refresh('parent')
    f.fetcher.mockResolvedValue({ ok: true, status: 200, json: async () => ({ kind: 'text', path: 'report.md' }) } as Response)
    await expect(f.port.preview('parent', { path: 'report.md' })).rejects.toThrow('文件预览数据无效')
    f.port.close()
  })
  it('shows only a bounded structured preview refusal and safely handles a non-JSON failure', async () => {
    const f = fixture()
    await f.port.refresh('parent')
    f.fetcher.mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: '文件超出当前会话工作区。'.repeat(30) }) } as Response)
    await expect(f.port.preview('parent', { path: '../outside.txt' })).rejects.toThrow('文件超出当前会话工作区。'.repeat(30).slice(0, 240))
    f.fetcher.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'FILE_NOT_FOUND', message: '文件不存在。' }) } as Response)
    await expect(f.port.preview('parent', { path: 'missing.md' })).rejects.toThrow('文件不存在。')
    f.fetcher.mockResolvedValue({ ok: false, status: 503, json: async () => { throw Error('HTML response') } } as unknown as Response)
    await expect(f.port.preview('parent', { path: 'report.md' })).rejects.toThrow('请求未完成（HTTP 503）')
    f.port.close()
  })
})
