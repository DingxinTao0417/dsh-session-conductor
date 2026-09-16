import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { acceptPanelRequest, panelJson, type PanelActionServices, type WebRoutePort } from './panelapi.ts'
import type { PreviewServices } from './preview.ts'

export const TERMINAL_ROUTE = '/conductor/terminal'
export const TERMINAL_OUTPUT_ROUTE = '/conductor/terminal/output'
export const TERMINAL_MAX_PER_READER = 4
const TERMINAL_ID = /^[A-Za-z0-9_-]{8,64}$/
const MAX_INPUT = 16_384
const MAX_BACKLOG = 256_000

interface TerminalHandle {
  readonly pid: number
  readonly output: Readable
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>
  write(data: string): Promise<void>
  terminate(): Promise<void>
}

export interface TerminalSubprocess {
  resolveExecutable(command: string): Promise<string>
  spawnTerminal(spec: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly rows: number
    readonly cols: number
    readonly graceMs: number
  }): Promise<TerminalHandle>
}

interface LiveSession {
  readonly id: string
  readonly readerSessionId: string
  readonly cwd: string
  readonly shell: string
  readonly handle: TerminalHandle
  backlog: Buffer[]
  backlogBytes: number
  ended: boolean
  stream?: { abort(): void; push(chunk: Buffer): void }
}

class TerminalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) { super(message) }
}

type RouteHandler = Parameters<WebRoutePort['register']>[0]['handler']
type RouteRequest = Parameters<RouteHandler>[0]
type RouteResponse = Parameters<RouteHandler>[1] & {
  write?(chunk: string | Uint8Array): boolean
  flushHeaders?(): void
}

function bearer(request: RouteRequest): string | undefined {
  const authorization = request.headers?.['authorization']
  return typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization) ? authorization.slice(7) : undefined
}

function dimension(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TerminalError('BAD_REQUEST', '终端尺寸无效。', 400)
  }
  return value
}

/** Resolve the interactive shell the Host can actually spawn in this execution world. */
export async function resolveWorkspaceShell(subprocess: Pick<TerminalSubprocess, 'resolveExecutable'>): Promise<string> {
  const names = process.platform === 'win32' ? ['powershell', 'pwsh'] : ['bash', 'sh']
  const errors: string[] = []
  for (const name of names) {
    try { return await subprocess.resolveExecutable(name) } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new TerminalError('NO_SHELL', '当前 Host 找不到可用的 PowerShell 或 bash。' + (errors[0] ? ' ' + errors[0] : ''), 503)
}

function fail(response: RouteResponse, error: unknown): void {
  const mapped = error instanceof TerminalError ? error : new TerminalError('TERMINAL_FAILED', error instanceof Error ? error.message : '无法打开终端。', 400)
  response.statusCode = mapped.status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify({ error: mapped.code, message: mapped.message }))
}

function appendBacklog(session: LiveSession, chunk: Buffer): void {
  session.backlog.push(chunk)
  session.backlogBytes += chunk.byteLength
  while (session.backlogBytes > MAX_BACKLOG && session.backlog.length > 1) {
    const dropped = session.backlog.shift()
    if (dropped) session.backlogBytes -= dropped.byteLength
  }
}

/** Interactive workspace PTY: session cwd only, Host spawnTerminal, no model turn. */
export function registerTerminalRoutes(web: WebRoutePort | undefined, callers: PanelActionServices,
  services: PreviewServices & { subprocess(): TerminalSubprocess | undefined }): (() => void) | undefined {
  if (web === undefined || typeof web.register !== 'function') return undefined
  const live = new Map<string, LiveSession>()
  const disposeSession = async (session: LiveSession): Promise<void> => {
    live.delete(session.id)
    session.stream?.abort()
    try { await session.handle.terminate() } catch { /* already gone */ }
  }
  const callerOf = async (request: RouteRequest): Promise<NonNullable<Awaited<ReturnType<PanelActionServices['resolveCaller']>>>> => {
    const token = bearer(request)
    const caller = token === undefined ? undefined : await callers.resolveCaller(token)
    if (caller?.authority !== 'local-user') throw new TerminalError('UNAUTHORIZED', '当前会话身份已失效，请重新打开会话。', 401)
    if (callers.isCallerCurrent?.(token!, caller) === false) throw new TerminalError('PREVIEW_ACCESS_CHANGED', '会话权限或工作区已变更，请重新打开终端。')
    return caller
  }
  const sessionOf = (caller: { sessionId: string }, id: unknown): LiveSession => {
    if (typeof id !== 'string' || !TERMINAL_ID.test(id)) throw new TerminalError('BAD_REQUEST', '终端会话无效。', 400)
    const session = live.get(id)
    if (!session || session.readerSessionId !== caller.sessionId) throw new TerminalError('TERMINAL_NOT_FOUND', '这个终端已经关闭。', 404)
    return session
  }
  const open = web.register({ name: 'dsh-session-conductor.terminal', path: TERMINAL_ROUTE, kind: 'exact',
    async handler(request, response) {
      if (!acceptPanelRequest(request, response, 'POST')) return
      try {
        const caller = await callerOf(request)
        const input = await panelJson(request) as { action?: unknown; id?: unknown; data?: unknown; cols?: unknown; rows?: unknown } | null
        if (!input || typeof input !== 'object') throw new TerminalError('BAD_REQUEST', '终端请求无效。', 400)
        if (input.action === 'close') {
          await disposeSession(sessionOf(caller, input.id))
          response.statusCode = 200
          response.end(JSON.stringify({ closed: true }))
          return
        }
        if (input.action === 'input') {
          if (typeof input.data !== 'string' || input.data.length === 0 || input.data.length > MAX_INPUT) {
            throw new TerminalError('BAD_REQUEST', '终端输入无效。', 400)
          }
          await sessionOf(caller, input.id).handle.write(input.data)
          response.statusCode = 200
          response.end(JSON.stringify({ ok: true }))
          return
        }
        if (input.action !== 'open' || Object.keys(input).some(key => !['action', 'cols', 'rows'].includes(key))) {
          throw new TerminalError('BAD_REQUEST', '终端请求无效。', 400)
        }
        const subprocess = services.subprocess()
        if (typeof subprocess?.spawnTerminal !== 'function' || typeof subprocess.resolveExecutable !== 'function') {
          throw new TerminalError('NO_PTY', '当前 Host 未提供交互式终端（ctx.subprocess.spawnTerminal）。', 503)
        }
        if ([...live.values()].filter(session => session.readerSessionId === caller.sessionId).length >= TERMINAL_MAX_PER_READER) {
          throw new TerminalError('TERMINAL_LIMIT', '当前会话打开的终端过多，请先关闭其中一个。', 429)
        }
        const context = await services.context(caller.sessionId, caller.sessionId)
        if (!context) throw new TerminalError('PREVIEW_UNAVAILABLE', '这个会话的工作区当前不可用。')
        if (context.isCurrent?.() === false) throw new TerminalError('PREVIEW_ACCESS_CHANGED', '会话权限或工作区已变更，请重新打开终端。')
        const root = await context.fs.resolve(context.cwd)
        const info = await context.fs.stat(root)
        if (!info) throw new TerminalError('NOT_A_DIRECTORY', '当前会话工作区不存在。', 404)
        if (info.type !== 'directory') throw new TerminalError('NOT_A_DIRECTORY', '当前会话工作区不是可进入的目录。', 415)
        const token = bearer(request)!
        if (context.isCurrent?.() === false || callers.isCallerCurrent?.(token, caller) === false) {
          throw new TerminalError('PREVIEW_ACCESS_CHANGED', '会话权限或工作区已变更，请重新打开终端。')
        }
        const cols = dimension(input.cols, 120, 20, 300)
        const rows = dimension(input.rows, 32, 8, 120)
        const shell = await resolveWorkspaceShell(subprocess)
        const handle = await subprocess.spawnTerminal({ argv: [shell], cwd: context.cwd, cols, rows, graceMs: 5_000 })
        if (context.isCurrent?.() === false || callers.isCallerCurrent?.(token, caller) === false) {
          try { await handle.terminate() } catch { /* allocation must not outlive a revoked reader */ }
          throw new TerminalError('PREVIEW_ACCESS_CHANGED', '会话权限或工作区已变更，请重新打开终端。')
        }
        const session: LiveSession = {
          id: randomUUID(), readerSessionId: caller.sessionId, cwd: context.cwd, shell, handle,
          backlog: [], backlogBytes: 0, ended: false,
        }
        handle.output.on('data', (chunk: string | Uint8Array) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
          if (session.stream) session.stream.push(buffer)
          else appendBacklog(session, buffer)
        })
        handle.output.on('end', () => { session.ended = true })
        live.set(session.id, session)
        void handle.done.finally(() => { if (live.get(session.id) === session) live.delete(session.id) })
        response.statusCode = 200
        response.end(JSON.stringify({ id: session.id, cwd: context.cwd, shell }))
      } catch (error) { fail(response, error) }
    },
  })
  const output = web.register({ name: 'dsh-session-conductor.terminal-output', path: TERMINAL_OUTPUT_ROUTE, kind: 'exact',
    async handler(request, response) {
      if (!acceptPanelRequest(request, response, 'GET')) return
      try {
        const caller = await callerOf(request)
        const id = new URL(request.url ?? '/', 'http://conductor.local').searchParams.get('id')
        const session = sessionOf(caller, id)
        session.stream?.abort()
        const streamResponse = response as RouteResponse
        streamResponse.setHeader('content-type', 'application/octet-stream')
        streamResponse.setHeader('cache-control', 'no-store')
        streamResponse.statusCode = 200
        streamResponse.flushHeaders?.()
        let closed = false
        const write = (chunk: string | Uint8Array): void => {
          if (closed) return
          try { streamResponse.write?.(chunk) } catch { closed = true }
        }
        const abort = (): void => { closed = true }
        const finish = (): void => {
          if (closed) return
          closed = true
          if (session.stream?.abort === abort) delete session.stream
          try { response.end() } catch { /* already ended */ }
        }
        const onData = (chunk: Buffer): void => write(chunk)
        for (const chunk of session.backlog) write(chunk)
        session.backlog = []
        session.backlogBytes = 0
        if (closed) return
        if (session.ended) { finish(); return }
        session.stream = { abort, push: onData }
        session.handle.output.once('end', finish)
        session.handle.output.once('close', finish)
        const incoming = request as RouteRequest & { once?(event: string, listener: () => void): void }
        incoming.once?.('close', () => {
          abort()
          if (session.stream?.abort === abort) delete session.stream
        })
      } catch (error) { fail(response, error) }
    },
  })
  return () => {
    open()
    output()
    const sessions = Array.from(live.values())
    for (const session of sessions) void disposeSession(session)
  }
}
