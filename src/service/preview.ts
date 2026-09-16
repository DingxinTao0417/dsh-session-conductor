import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { acceptPanelRequest, panelJson, type PanelActionServices, type WebRoutePort } from './panelapi.ts'

export const PREVIEW_ROUTE = '/conductor/preview'
export const PREVIEW_MAX_BYTES = 524_288
export const PREVIEW_MAX_CHARS = 200_000
export interface PreviewContext {
  readonly cwd: string
  readonly identity: string
  readonly fs: Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'readBytes'>
  /** Checks the captured binding/provider lease without yielding after asynchronous metadata reads. */
  readonly isCurrent?: () => boolean
}
export interface PreviewServices {
  /** Re-evaluates the local reader's current access and target binding. */
  context(readerSessionId: string, targetSessionId: string): PreviewContext | undefined | Promise<PreviewContext | undefined>
}
class PreviewError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) { super(message) }
}

/** Explicit user file preview: no tool execution, model turns, or history cursor changes. */
export function registerPreviewRoute(web: WebRoutePort | undefined, callers: PanelActionServices,
  services: PreviewServices): (() => void) | undefined {
  return web?.register({ name: 'dsh-session-conductor.preview', path: PREVIEW_ROUTE, kind: 'exact',
    async handler(request, response) {
      if (!acceptPanelRequest(request, response, 'POST')) return
      try {
        const authorization = request.headers?.['authorization']
        const token = typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization) ? authorization.slice(7) : undefined
        const caller = token === undefined ? undefined : await callers.resolveCaller(token)
        if (caller?.authority !== 'local-user') throw new PreviewError('UNAUTHORIZED', '当前会话身份已失效，请重新打开会话。', 401)
        const input = await panelJson(request) as { path?: unknown; sessionId?: unknown } | null
        if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['path', 'sessionId'].includes(key))
          || typeof input.path !== 'string' || !input.path.trim() || input.path.length > 4096 || input.path.includes('\0')
          || input.sessionId !== undefined && (typeof input.sessionId !== 'string' || input.sessionId.length > 256)) {
          throw new PreviewError('BAD_REQUEST', '文件预览参数无效。', 400)
        }
        const targetSessionId = input.sessionId as string | undefined ?? caller.sessionId
        const readContext = async (): Promise<PreviewContext | undefined> => {
          const pending = services.context(caller.sessionId, targetSessionId)
          const asynchronous = pending !== undefined && typeof (pending as Promise<unknown>).then === 'function'
          const value = await pending
          // A metadata-backed context must carry a synchronous lease guard. Repeating awaited
          // metadata reads alone always leaves a window for revocation at the final await.
          if (asynchronous && value && (!value.isCurrent || !callers.isCallerCurrent)) {
            throw new PreviewError('PREVIEW_UNAVAILABLE', '当前宿主无法安全校验这个会话的文件读取权限。')
          }
          return value
        }
        const context = await readContext()
        if (!context) throw new PreviewError('PREVIEW_UNAVAILABLE', '这个会话的工作区或读取权限当前不可用。')
        if (context.isCurrent?.() === false || callers.isCallerCurrent?.(token!, caller) === false) {
          throw new PreviewError('PREVIEW_ACCESS_CHANGED', '会话权限或工作区已变更，请重新选择文件。')
        }
        const { fs, cwd } = context
        const root = await fs.resolve(cwd)
        const target = await fs.resolve(input.path, { cwd })
        if (!fs.contains(root, target)) throw new PreviewError('OUTSIDE_WORKSPACE', '该文件位于会话工作区之外，无法在这里预览。')
        const info = await fs.stat(target)
        if (!info) throw new PreviewError('FILE_NOT_FOUND', '文件已移动或不存在。', 404)
        if (info.type !== 'file') throw new PreviewError('NOT_A_FILE', '请选择普通文件进行预览。', 415)
        if (info.size !== undefined && info.size > PREVIEW_MAX_BYTES) throw new PreviewError('FILE_TOO_LARGE', '文件超过 512 KiB，请使用外部应用打开。', 413)
        const bytes = await fs.readBytes(target, undefined, PREVIEW_MAX_BYTES)
        if (bytes.byteLength > PREVIEW_MAX_BYTES) throw new PreviewError('FILE_TOO_LARGE', '文件超过 512 KiB，请使用外部应用打开。', 413)
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          if (text.includes('\0')) throw Error('binary')
        } catch { throw new PreviewError('UNSUPPORTED_FILE', '目前支持 UTF-8 文本、Markdown 和代码文件；此文件需用外部应用打开。', 415) }
        // Authority, workspace and canonical file identity can all change across the read.
        const freshCaller = await callers.resolveCaller(token!)
        const fresh = await readContext()
        if (freshCaller?.authority !== 'local-user' || freshCaller.sessionId !== caller.sessionId
          || !fresh || fresh.identity !== context.identity || fresh.cwd !== cwd || fresh.fs !== fs
          || fresh.isCurrent?.() === false || callers.isCallerCurrent?.(token!, freshCaller) === false) {
          throw new PreviewError('PREVIEW_ACCESS_CHANGED', '会话权限或工作区已变更，请重新选择文件。')
        }
        const freshRoot = await fs.resolve(cwd), freshTarget = await fs.resolve(input.path, { cwd })
        const freshInfo = await fs.stat(freshTarget)
        if (!fs.contains(root, freshRoot) || !fs.contains(freshRoot, root) || !fs.contains(freshRoot, freshTarget)
          || !fs.contains(target, freshTarget) || !fs.contains(freshTarget, target)
          || freshInfo?.type !== 'file' || freshInfo.version !== info.version) {
          throw new PreviewError('FILE_CHANGED', '文件在读取期间发生变化，请重新打开预览。', 409)
        }
        const finalCaller = await callers.resolveCaller(token!)
        const finalContext = await readContext()
        if (finalCaller?.authority !== 'local-user' || finalCaller.sessionId !== caller.sessionId
          || !finalContext || finalContext.identity !== context.identity || finalContext.cwd !== cwd || finalContext.fs !== fs
          || finalContext.isCurrent?.() === false || callers.isCallerCurrent?.(token!, finalCaller) === false) {
          throw new PreviewError('PREVIEW_ACCESS_CHANGED', '会话权限或工作区已变更，请重新选择文件。')
        }
        response.statusCode = 200
        response.end(JSON.stringify({ kind: 'text', path: target.displayPath, text: text.slice(0, PREVIEW_MAX_CHARS), truncated: text.length > PREVIEW_MAX_CHARS }))
      } catch (error) {
        const mapped = error && typeof error === 'object' && 'code' in error && error.code === 'FS_TOO_LARGE'
          ? new PreviewError('FILE_TOO_LARGE', '文件超过 512 KiB，请使用外部应用打开。', 413) : error
        response.statusCode = mapped instanceof PreviewError ? mapped.status : 400
        response.end(JSON.stringify({ error: mapped instanceof PreviewError ? mapped.code : 'PREVIEW_FAILED',
          message: mapped instanceof PreviewError ? mapped.message : '无法读取文件，请确认文件仍可访问。' }))
      }
    },
  })
}
