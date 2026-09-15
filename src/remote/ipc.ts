/** Private local IPC between the installed Host plugin and its SSH stdio bridge. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { RemoteDispatch } from './dispatcher.ts'
import { MAX_REMOTE_FRAME_BYTES, type RemoteReply, type RemoteRequest } from './protocol.ts'

const descriptorSchema = z.object({
  version: z.literal(1), profileId: z.string().min(1), endpoint: z.string().min(1),
  token: z.string().regex(/^[a-f0-9]{64}$/), pid: z.number().int().positive(),
}).strict()
export type IpcDescriptor = z.infer<typeof descriptorSchema>

/** Ephemeral local endpoint identity. It is not an SSH/model credential and is removed on shutdown. */
export interface IpcEndpoint {
  readonly descriptorPath: string
  readonly endpoint: string
  close(): Promise<void>
}

async function protectDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('IPC runtime directory must be an ordinary directory')
  if (process.platform !== 'win32') {
    if (process.getuid !== undefined && info.uid !== process.getuid()) throw new Error('IPC directory belongs to another user')
    await chmod(directory, 0o700)
    return
  }
  // Windows mode bits do not establish ACLs. Give the current user's SID the only access rule.
  const script = "$ErrorActionPreference='Stop'; $p=$env:CONDUCTOR_IPC_PRIVATE_DIRECTORY; "
    + "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; "
    + "$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); "
    + "$acl.SetAccessRuleProtection($true,$false); "
    + "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); "
    + '$acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($p,$acl)'
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 15000,
    env: { ...process.env, CONDUCTOR_IPC_PRIVATE_DIRECTORY: directory },
  })
}

export async function readIpcDescriptor(path: string): Promise<IpcDescriptor> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('invalid IPC descriptor file')
  if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0
    || (process.getuid !== undefined && info.uid !== process.getuid()))) {
    throw new Error('IPC descriptor must be readable only by its owning user')
  }
  const descriptor = descriptorSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if (process.platform === 'win32') {
    if (!descriptor.endpoint.startsWith('\\\\.\\pipe\\dsh-conductor-')) throw new Error('IPC bridge only connects to a local named pipe')
  } else if (!descriptor.endpoint.startsWith(`${resolve(path, '..')}/`) || descriptor.endpoint.includes('\0')) {
    throw new Error('IPC socket must belong to the descriptor directory')
  }
  return descriptor
}

export async function callIpc(
  descriptor: IpcDescriptor,
  request: RemoteRequest,
  timeoutMs = 30000,
): Promise<RemoteReply> {
  const frame = `${JSON.stringify({ token: descriptor.token, request })}\n`
  if (Buffer.byteLength(frame) > MAX_REMOTE_FRAME_BYTES) throw new Error('remote frame exceeds the transport bound')
  return await new Promise((resolveResult, reject) => {
    const socket = createConnection(descriptor.endpoint)
    const timer = setTimeout(() => { socket.destroy(new Error('IPC request deadline exceeded; mutation outcome may be unknown')) }, timeoutMs)
    let pending = Buffer.alloc(0)
    let answered = false
    socket.on('connect', () => { socket.write(frame) })
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)])
      if (pending.byteLength > MAX_REMOTE_FRAME_BYTES) { socket.destroy(new Error('oversized IPC response')); return }
      const at = pending.indexOf(10)
      if (at < 0) return
      try {
        const response = JSON.parse(pending.subarray(0, at).toString('utf8')) as RemoteReply
        if (typeof response !== 'object' || response === null || typeof response.ok !== 'boolean'
          || (response.requestId !== request.requestId && response.requestId !== 'invalid-request')) throw new Error('invalid IPC response identity')
        answered = true
        resolveResult(response)
        socket.destroy()
      } catch { socket.destroy(new Error('invalid IPC response')) }
    })
    socket.on('error', reject)
    socket.on('close', () => {
      clearTimeout(timer)
      if (!answered) reject(new Error('IPC closed before its operation receipt; outcome may be unknown'))
    })
  })
}

export async function startIpcEndpoint(options: {
  readonly runtimeRoot: string
  readonly profileId: string
  readonly dispatch: RemoteDispatch
}): Promise<IpcEndpoint> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(options.profileId)) throw new Error('invalid IPC profile id')
  const directory = join(resolve(options.runtimeRoot), `conductor-ipc-${options.profileId}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await protectDirectory(directory)
  const descriptorPath = join(directory, 'endpoint.json')
  const previous = await readIpcDescriptor(descriptorPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (previous !== undefined) {
    const reachable = await new Promise<boolean>(resolveResult => {
      const socket = createConnection(previous.endpoint)
      socket.once('connect', () => { socket.destroy(); resolveResult(true) })
      socket.once('error', () => { socket.destroy(); resolveResult(false) })
    })
    if (reachable) throw new Error('a conductor IPC endpoint is already live for this profile')
    await unlink(descriptorPath)
    // Only the stale socket in this exact dedicated directory may be removed.
    if (process.platform !== 'win32' && previous.endpoint === join(directory, 'host.sock')) {
      await unlink(previous.endpoint).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    }
  }
  const token = randomBytes(32).toString('hex')
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-conductor-${options.profileId}-${randomBytes(16).toString('hex')}`
    : join(directory, 'host.sock')
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    socket.on('error', () => {})
    socket.setTimeout(60000, () => { socket.destroy() })
    let pending = Buffer.alloc(0)
    let received = false
    socket.on('data', bytes => {
      if (received) { socket.destroy(); return }
      pending = Buffer.concat([pending, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)])
      if (pending.byteLength > MAX_REMOTE_FRAME_BYTES) { socket.destroy(); return }
      const at = pending.indexOf(10)
      if (at < 0) return
      received = true
      socket.pause()
      void (async () => {
        try {
          if (at !== pending.length - 1) throw new Error('one frame per IPC connection')
          const envelope = JSON.parse(pending.subarray(0, at).toString('utf8')) as { token?: unknown; request?: unknown }
          if (typeof envelope.token !== 'string' || envelope.token.length !== token.length
            || !timingSafeEqual(Buffer.from(envelope.token), Buffer.from(token))) throw new Error('IPC identity refused')
          const reply = await options.dispatch(envelope.request)
          const response = `${JSON.stringify(reply)}\n`
          if (Buffer.byteLength(response) > MAX_REMOTE_FRAME_BYTES) throw new Error('response exceeds transport bound')
          socket.end(response)
        } catch {
          socket.end(`${JSON.stringify({ requestId: 'invalid-request', ok: false, code: 'IPC_REFUSED', message: 'private endpoint refused this request', unknown: false })}\n`)
        }
      })()
    })
  })
  server.maxConnections = 32
  await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(endpoint, resolveReady) })
  try {
    if (process.platform !== 'win32') await chmod(endpoint, 0o600)
    await writeFile(descriptorPath, JSON.stringify({ version: 1, profileId: options.profileId, endpoint, token, pid: process.pid }), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    await new Promise<void>(resolveClosed => { server.close(() => { resolveClosed() }) })
    throw error
  }
  return {
    descriptorPath, endpoint,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolveClosed, reject) => { server.close(error => { if (error !== undefined) reject(error); else resolveClosed() }) })
      const held = await readIpcDescriptor(descriptorPath).catch(() => undefined)
      if (held?.token === token) await unlink(descriptorPath)
    },
  }
}
