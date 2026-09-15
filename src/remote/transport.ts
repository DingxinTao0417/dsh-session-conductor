/** One-request stdio carriers. SSH uses existing aliases and never installs keys or services. */
import { spawn } from 'node:child_process'
import { callIpc, readIpcDescriptor } from './ipc.ts'
import { MAX_REMOTE_FRAME_BYTES, type RemoteReply, type RemoteRequest } from './protocol.ts'

export interface RemoteTransport {
  request(request: RemoteRequest, signal?:AbortSignal): Promise<RemoteReply>
}

export class RemoteTransportError extends Error {
  readonly outcomeUnknown = true
}

/** Only process essentials and the user's existing SSH agent are passed to the carrier. */
export function sshEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    /^(PATH|SystemRoot|WINDIR|HOME|USERPROFILE|SSH_AUTH_SOCK|SSH_AGENT_PID|TEMP|TMP|TMPDIR|LANG|LC_[A-Z_]+|XDG_CONFIG_HOME)$/i.test(name)))
}

export function sshArguments(alias: string, bridgeCommand: readonly string[]): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,239}$/.test(alias)) throw new Error('SSH target must be one explicit existing configuration alias')
  if (bridgeCommand.length === 0 || bridgeCommand.some(argument => argument.length === 0 || /[\r\n\0]/.test(argument))) {
    throw new Error('SSH bridge command must be an explicit finite argv without control characters')
  }
  // SSH joins its remote command for the target POSIX shell. Quote every token, including paths.
  const quote = (argument: string): string => `'${argument.replace(/'/g, `'"'"'`)}'`
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
    '--', alias, bridgeCommand.map(quote).join(' ')]
}

export function createProcessTransport(
  executable: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv } = {},
): RemoteTransport {
  const timeoutMs = options.timeoutMs ?? 45000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('remote timeout must be 1..60000 ms')
  return {
    async request(request,signal): Promise<RemoteReply> {
      signal?.throwIfAborted()
      const frame = `${JSON.stringify(request)}\n`
      if (Buffer.byteLength(frame) > MAX_REMOTE_FRAME_BYTES) throw new Error('remote request exceeds the transport bound')
      return await new Promise((resolveResult, reject) => {
        const child = spawn(executable, [...args], { windowsHide: true, shell: false,
          stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? sshEnvironment() })
        let stdout = Buffer.alloc(0)
        let failure: Error | undefined
        const timer = setTimeout(() => {
          failure = new RemoteTransportError('remote carrier deadline exceeded; query the operation identity before retrying')
          child.kill('SIGKILL')
        }, timeoutMs)
        const abort=():void=>{failure=new RemoteTransportError('remote read was cancelled');child.kill('SIGKILL')}
        signal?.addEventListener('abort',abort,{once:true})
        if(signal?.aborted)abort()
        child.on('error', () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort',abort)
          reject(new RemoteTransportError('remote carrier could not be started'))
        })
        child.stdin.on('error', () => {})
        child.stdout.on('data', bytes => {
          stdout = Buffer.concat([stdout, bytes])
          if (stdout.byteLength > MAX_REMOTE_FRAME_BYTES) {
            failure = new RemoteTransportError('remote carrier returned an oversized frame')
            child.kill('SIGKILL')
          }
        })
        // Drain stderr without reflecting arbitrary remote text or credentials into tool output.
        child.stderr.resume()
        child.on('close', code => {
          clearTimeout(timer)
          signal?.removeEventListener('abort',abort)
          if (failure !== undefined) { reject(failure); return }
          if (code !== 0) { reject(new RemoteTransportError('remote carrier exited without a confirmed operation receipt')); return }
          try {
            const response = JSON.parse(stdout.toString('utf8')) as RemoteReply
            if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean'
              || response.requestId !== request.requestId) throw new Error('invalid identity')
            resolveResult(response)
          } catch { reject(new RemoteTransportError('remote carrier returned no valid matching operation receipt')) }
        })
        child.stdin.end(frame)
      })
    },
  }
}

export function createSshTransport(options: {
  readonly alias: string
  readonly bridgeCommand: readonly string[]
  readonly sshExecutable?: string
  readonly timeoutMs?: number
}): RemoteTransport {
  return createProcessTransport(options.sshExecutable ?? 'ssh', sshArguments(options.alias, options.bridgeCommand), {
    env: sshEnvironment(), ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  })
}

export function createIpcTransport(descriptorPath: string): RemoteTransport {
  return { request: async request => await callIpc(await readIpcDescriptor(descriptorPath), request) }
}
