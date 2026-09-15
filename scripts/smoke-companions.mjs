/** Exercise the advertised built entries and their emitted shared chunks. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { startIpcEndpoint } from '../src/remote/ipc.ts'
import { createProcessTransport } from '../src/remote/transport.ts'

const share = spawnSync(process.execPath, [resolve('lib/share-service.js')], {
  windowsHide: true, encoding: 'utf8', timeout: 5000,
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_SHARE_'))),
})
assert.equal(share.status, 1)
assert.match(share.stderr, /Usage: node share-service\.js/)
assert.doesNotMatch(share.stderr, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/)

const root = await mkdtemp(join(tmpdir(), 'dsh-companion-smoke-'))
let endpoint
try {
  endpoint = await startIpcEndpoint({ runtimeRoot: root, profileId: 'smoke', dispatch: async request => ({
    ok: true, requestId: request.requestId, result: { hostId: 'smoke', protocolVersion: '1', pluginVersion: '0.1.0', models: [], workspaceCapable: false },
  }) })
  const transport = createProcessTransport(process.execPath, [resolve('lib/bridge/stdio.js'), '--descriptor', endpoint.descriptorPath])
  const reply = await transport.request({ protocolVersion: '1', requestId: 'built-entry-smoke', action: 'capabilities', payload: {} })
  assert.equal(reply.ok, true)
  assert.equal(reply.result.hostId, 'smoke')
  console.log('companion smoke: OK (built HTTPS entry loaded; built stdio bridge exchanged a real private IPC frame)')
} finally {
  await endpoint?.close()
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'dsh-companion-smoke-'))
  await rm(root, { recursive: true, force: true })
}
