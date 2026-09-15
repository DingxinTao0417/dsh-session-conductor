/** SSH launches this finite bridge under the existing SSH user's account. No HTTP server. */
import { callIpc, readIpcDescriptor } from '../../src/remote/ipc.ts'
import { MAX_REMOTE_FRAME_BYTES, remoteRequestSchema } from '../../src/remote/protocol.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--descriptor' || args[1] === undefined) {
    throw new Error('usage: conductor bridge --descriptor <private profile descriptor>')
  }
  let bytes = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))])
    if (bytes.byteLength > MAX_REMOTE_FRAME_BYTES) throw new Error('request exceeds transport bound')
  }
  const request = remoteRequestSchema.parse(JSON.parse(bytes.toString('utf8')))
  const descriptor = await readIpcDescriptor(args[1])
  const reply = await callIpc(descriptor, request)
  process.stdout.write(`${JSON.stringify(reply)}\n`)
}

void main().catch(() => {
  // Tokens, task contents, environment values and remote exception strings never go to stderr.
  process.stderr.write('conductor bridge refused the request or lost its local endpoint; reconcile mutations by operation identity\n')
  process.exitCode = 1
})
