import { createHash, timingSafeEqual } from 'node:crypto'
import { request, createServer, type Server } from 'node:https'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { shareState, type ShareRecord } from '../service/share.ts'
import { commitImmutableFile, readSnapshotFile } from './storage.ts'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)
const recordSchema = z.object({
  shareId: id, snapshotId: z.string().min(1), taskId: z.string().min(1),
  token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/), cutoffAt: z.iso.datetime(),
  publishedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict()
const attachmentSchema = z.object({
  artifactId: id, name: z.string().min(1).max(200), base64: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const uploadSchema = z.object({record: recordSchema, format: z.enum(['markdown', 'json']),
  document: z.string().min(1), attachments: z.array(attachmentSchema).max(100), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type ShareUpload = z.infer<typeof uploadSchema>
export type ShareAttachment = z.infer<typeof attachmentSchema>
export interface ShareReceipt { readonly record: ShareRecord; readonly digest: string }
export interface ShareServicePort {
  readonly baseUrl: string
  publish(upload: ShareUpload): Promise<ShareReceipt>
  status(shareId: string): Promise<ShareReceipt | undefined>
  revoke(shareId: string): Promise<ShareReceipt>
}
export const MAX_SHARE_BYTES = 8 * 1024 * 1024
export function snapshotDigest(format: string, document: string, attachments: readonly ShareAttachment[]): string {
  return createHash('sha256').update(JSON.stringify({format, document, attachments})).digest('hex')
}
function validateUpload(value: unknown): ShareUpload {
  const upload = uploadSchema.parse(value)
  if (snapshotDigest(upload.format, upload.document, upload.attachments) !== upload.digest) throw new Error('snapshot digest mismatch')
  const names = new Set<string>()
  for (const attachment of upload.attachments) {
    const bytes = Buffer.from(attachment.base64, 'base64')
    if (bytes.toString('base64') !== attachment.base64 || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256
      || names.has(attachment.artifactId)) throw new Error('invalid or duplicate attachment')
    names.add(attachment.artifactId)
  }
  const days = (Date.parse(upload.record.expiresAt) - Date.parse(upload.record.publishedAt)) / 86400000
  if (days <= 0 || days > 365 || Date.parse(upload.record.cutoffAt) > Date.parse(upload.record.publishedAt)) throw new Error('invalid lifetime or cutoff')
  return upload
}
function authorized(header: string | undefined, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`)
  const supplied = Buffer.from(header ?? '')
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

/** Standalone HTTPS document service. It has no Host dependency or execution endpoint. */
export async function createSnapshotServer(options: {
  key: string | Buffer; cert: string | Buffer; bearerToken: string; directory: string; now?: () => string
}): Promise<Server> {
  if (options.bearerToken.length < 32) throw new Error('share service requires an externally supplied bearer token of at least 32 characters')
  await mkdir(options.directory, {recursive: true, mode: 0o700})
  const snapshots = new Map<string, ShareUpload>()
  const tokens = new Map<string, string>()
  const revoked = new Map<string, string>()
  for (const entry of await readdir(options.directory)) {
    if (!/^[A-Za-z0-9_-]{1,160}\.json$/.test(entry)) continue
    const upload = validateUpload(JSON.parse(await readSnapshotFile(join(options.directory, entry), MAX_SHARE_BYTES)))
    if (entry !== `${upload.record.shareId}.json` || tokens.has(upload.record.token)) throw new Error('ambiguous snapshot storage')
    snapshots.set(upload.record.shareId, upload); tokens.set(upload.record.token, upload.record.shareId)
    try { revoked.set(upload.record.shareId, z.iso.datetime().parse(await readSnapshotFile(join(options.directory, `${upload.record.shareId}.revoked`), 64))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const now = options.now ?? (() => new Date().toISOString())
  const receipt = (upload: ShareUpload): ShareReceipt => ({record: {...upload.record,
    ...revoked.has(upload.record.shareId) ? {revokedAt: revoked.get(upload.record.shareId)!} : {}}, digest: upload.digest})
  // One write queue makes duplicate PUTs and revocations linearizable within the server.
  let tail: Promise<unknown> = Promise.resolve()
  const server = createServer({key: options.key, cert: options.cert, minVersion: 'TLSv1.2'}, (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
    res.setHeader('Referrer-Policy', 'no-referrer')
    const json = (status: number, body: unknown): void => {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body))}
    const run = async (): Promise<void> => {
      const path = req.url ?? ''
      const publicMatch = /^\/s\/([A-Za-z0-9_-]{32,128})(?:\/attachments\/([A-Za-z0-9_-]{1,160}))?$/.exec(path)
      if (publicMatch && req.method === 'GET') {
        const upload = snapshots.get(tokens.get(publicMatch[1]!) ?? '')
        if (!upload || shareState(receipt(upload).record, now()) !== 'active') {json(404,{error:'not found'});return}
        const artifactId = publicMatch[2]
        if (artifactId) {
          const attachment = upload.attachments.find(item => item.artifactId === artifactId)
          if (!attachment) {json(404,{error:'not found'});return}
          res.writeHead(200, {'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`})
          res.end(Buffer.from(attachment.base64,'base64'));return
        }
        res.writeHead(200, {'Content-Type': upload.format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'})
        res.end(upload.document);return
      }
      const match = /^\/api\/snapshots\/([A-Za-z0-9_-]{1,160})$/.exec(path)
      if (!match || !['GET','PUT','DELETE'].includes(req.method ?? '')) {json(404,{error:'not found'});return}
      if (!authorized(req.headers.authorization, options.bearerToken)) {json(401,{error:'unauthorized'});return}
      const shareId = match[1]!
      if (req.method === 'GET') {const existing = snapshots.get(shareId); json(existing ? 200 : 404, existing ? receipt(existing) : {error:'not found'});return}
      let body: unknown
      if (req.method === 'PUT') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') {json(415,{error:'JSON required'});return}
        let size = 0; const chunks: Buffer[] = []
        for await (const chunk of req) {const bytes = Buffer.from(chunk as Uint8Array);size+=bytes.length;if(size>MAX_SHARE_BYTES){json(413,{error:'snapshot too large'});return}chunks.push(bytes)}
        body = validateUpload(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))))
      }
      const mutation = tail.then(async () => {
        if (req.method === 'DELETE') {
          const existing = snapshots.get(shareId)
          if (!existing) {json(404,{error:'not found'});return}
          if (!revoked.has(shareId)) {const at = z.iso.datetime().parse(now()); await commitImmutableFile(options.directory,`${shareId}.revoked`,at); revoked.set(shareId,at)}
          json(200,receipt(existing));return
        }
        const upload = body as ShareUpload
        if (upload.record.shareId !== shareId) {json(409,{error:'identity conflict'});return}
        const existing = snapshots.get(shareId)
        if (existing) {const same = JSON.stringify(existing) === JSON.stringify(upload);json(same ? 200 : 409,same ? receipt(existing) : {error:'immutable snapshot conflict'});return}
        if (tokens.has(upload.record.token) || shareState(upload.record,now()) !== 'active') {json(409,{error:'token conflict or expired snapshot'});return}
        await commitImmutableFile(options.directory,`${shareId}.json`,JSON.stringify(upload))
        snapshots.set(shareId,upload);tokens.set(upload.record.token,shareId);json(201,receipt(upload))
      })
      tail = mutation.catch(() => undefined); await mutation
    }
    void run().catch(() => {if (!res.headersSent) json(400,{error:'invalid snapshot or unavailable storage'}); else res.end()})
  })
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000
  return server
}

/** Uses platform TLS trust (or an explicit private CA); never follows redirects or retries writes. */
export function createShareClient(options: {baseUrl: string; bearerToken: string; ca?: string | Buffer; timeoutMs?: number}): ShareServicePort {
  const endpoint = new URL(options.baseUrl)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('share endpoint must be an HTTPS origin')
  if (options.bearerToken.length < 32) throw new Error('share publishing credential is unavailable')
  const call = async (method: string, shareId: string, body?: ShareUpload): Promise<ShareReceipt | undefined> => {
    id.parse(shareId)
    return await new Promise((resolve,reject) => {
      const bytes = body ? Buffer.from(JSON.stringify(body)) : undefined
      if (bytes && bytes.length > MAX_SHARE_BYTES) {reject(new Error('snapshot exceeds service limit'));return}
      const req = request(new URL(`/api/snapshots/${shareId}`,endpoint), {method,ca:options.ca,
        headers:{Authorization:`Bearer ${options.bearerToken}`,...bytes ? {'Content-Type':'application/json','Content-Length':bytes.length}:{}},
      },res => {
        const chunks: Buffer[]=[];let size=0
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){res.destroy(new Error('oversized share response'));return}chunks.push(chunk)})
        res.on('error',reject);res.on('end',()=>{
          if (res.statusCode===404 && method==='GET') {resolve(undefined);return}
          if (!res.statusCode || res.statusCode<200 || res.statusCode>=300) {reject(new Error(`share service returned ${String(res.statusCode)}`));return}
          try {const value = z.object({record:recordSchema.extend({revokedAt:z.iso.datetime().optional()}),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));if(value.record.shareId!==shareId)throw new Error('wrong share receipt');resolve(value)}catch{reject(new Error('invalid share receipt'))}
        })
      })
      const timer = setTimeout(()=>req.destroy(new Error('share request outcome unknown: deadline exceeded')),options.timeoutMs??10000)
      req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(new Error('share request outcome unknown: transport failed')))
      req.end(bytes)
    })
  }
  return {baseUrl:endpoint.origin,publish:async upload => (await call('PUT',upload.record.shareId,upload))!,
    status:async shareId => await call('GET',shareId),revoke:async shareId => (await call('DELETE',shareId))!}
}
