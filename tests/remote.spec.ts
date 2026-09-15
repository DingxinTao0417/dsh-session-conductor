import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRemoteDispatcher } from '../src/remote/dispatcher.ts'
import { callIpc, readIpcDescriptor, startIpcEndpoint, type IpcEndpoint } from '../src/remote/ipc.ts'
import { createProcessTransport, sshArguments, sshEnvironment } from '../src/remote/transport.ts'
import { createHostRouter, type RemoteMigration } from '../src/remote/router.ts'
import { migrationBundleSchema, type MigrationBundle, type RemoteHostPort, type RemoteOperation, type RemoteRequest } from '../src/remote/protocol.ts'

const request = (action: 'capabilities' = 'capabilities'): RemoteRequest => ({ protocolVersion: '1', requestId: randomUUID(), action, payload: {} })
function journal() {
  const rows = new Map<string, RemoteOperation>()
  return { rows, get: async (id: string) => rows.get(id), put: async (record: RemoteOperation) => { rows.set(record.operationId, structuredClone(record)) } }
}
function host(hostId = 'source') {
  let sent = 0
  let phase = 'absent'
  let receipt: unknown
  const port: RemoteHostPort = {
    capabilities: async () => ({ hostId, protocolVersion: '1', pluginVersion: '0.1.0', workspaceCapable: true, models: ['deepseek'] }),
    authorize: async () => {}, readTask: async ({ taskId }) => ({ taskId, hostId }),
    send: async () => ({ accepted: ++sent }),
    stop: async () => ({ outcome: 'confirmed' }), queue: async () => ({ queue: [] }),
    freeze: async (payload, operationId) => {
      const value = { migrationId: payload.migrationId, taskId: payload.taskId, sourceHostId: hostId,
        targetHostId: payload.targetHostId, operationId, bindingVersion: payload.expectedBindingVersion,
        ownerEpoch: payload.expectedOwnerEpoch, confirmedStopped: true as const, dispatchFrozen: true as const, freezeToken: 'freeze-token' }
      receipt = value
      phase = 'frozen'
      return value
    },
    exportBundle: async payload => ({ migrationId: payload.receipt.migrationId, taskId: payload.receipt.taskId, sourceHostId: hostId,
      targetHostId: payload.receipt.targetHostId, historyThroughSeq: payload.historyThroughSeq, history: [], artifacts: [], requiredModels: payload.requiredModels }),
    stage: async (payload, operationId) => { phase = 'staged'; return { migrationId: payload.receipt.migrationId,
      taskId: payload.bundle.taskId, targetHostId: hostId, stageId: operationId, sessionId: 'target-session', bundleDigest: payload.bundleDigest, enabled: false } },
    enable: async payload => { phase = 'enabled'; return { migrationId: payload.stage.migrationId, taskId: payload.stage.taskId,
      targetHostId: hostId, sessionId: payload.stage.sessionId, bindingVersion: payload.receipt.bindingVersion + 1, enabled: true } },
    finalize: async payload => { phase = 'moved'; return payload.enabled },
    abort: async ({ migrationId }) => {
      if (phase === 'enabled') throw new Error('already enabled')
      phase = 'aborted'
      return { migrationId, targetHostId: hostId, disabled: true, abortToken: 'abort-token' }
    },
    resume: async ({ migrationId }) => { phase = 'aborted'; return { migrationId, resumed: true } },
    migrationStatus: async () => ({ phase, sourceStopped: phase === 'frozen', dispatchFrozen: phase === 'frozen', receipt }),
  }
  return { port, sent: () => sent, phase: () => phase }
}
function send(operationId = 'send-op', text = 'work'): RemoteRequest {
  return { protocolVersion: '1', requestId: randomUUID(), action: 'task.send', operationId,
    payload: { taskId: 'task', messageId: 'message', text, mode: 'queue', expectedOwnerEpoch: 0, expectedBindingVersion: 0 } }
}

describe('finite remote dispatcher', () => {
  it('persists receipt, replays identical concurrent IDs, refuses parameter drift', async () => {
    const fixture = host(); const records = journal(); const dispatch = createRemoteDispatcher(fixture.port, records)
    const replies = await Promise.all([dispatch(send()), dispatch(send())])
    expect(replies.every(reply => reply.ok)).toBe(true)
    expect(fixture.sent()).toBe(1)
    expect(await dispatch(send('send-op', 'different'))).toMatchObject({ ok: false, code: 'OPERATION_CONFLICT' })
    expect(await createRemoteDispatcher(fixture.port, records)(send())).toMatchObject({ ok: true })
    expect(fixture.sent()).toBe(1)
  })
  it('keeps an uncertain Host result unknown and never blindly sends again', async () => {
    const fixture = host(); const records = journal()
    fixture.port.send = async () => { throw new Error('private model key may be in Host error') }
    const dispatch = createRemoteDispatcher(fixture.port, records)
    expect(await dispatch(send())).toMatchObject({ ok: false, unknown: true })
    const retry = await dispatch(send())
    expect(retry).toMatchObject({ code: 'OPERATION_UNKNOWN' })
    expect(JSON.stringify(retry)).not.toContain('private model key')
    expect(await dispatch({ ...request(), action: 'operation.read', payload: { operationId: 'send-op' } })).toMatchObject({ result: { state: 'unknown' } })
  })
  it('does not dispatch when durable preparation fails', async () => {
    const fixture = host()
    const dispatch = createRemoteDispatcher(fixture.port, { get: async () => undefined, put: async () => { throw new Error('disk full') } })
    expect(await dispatch(send())).toMatchObject({ ok: false })
    expect(fixture.sent()).toBe(0)
  })
  it('does not let guessed stage receipts enable a target', async () => {
    const fixture = host('target'); const records = journal(); const dispatch = createRemoteDispatcher(fixture.port, records)
    const freeze = await host().port.freeze({ migrationId: 'm', taskId: 'task', targetHostId: 'target', expectedBindingVersion: 0, expectedOwnerEpoch: 0 }, 'freeze')
    const reply = await dispatch({ ...request(), action: 'migration.enable', operationId: 'enable', payload: {
      receipt: freeze, stageOperationId: 'missing-stage', stage: { migrationId: 'm', taskId: 'task', targetHostId: 'target',
        stageId: 'fake', sessionId: 'fake', bundleDigest: 'a'.repeat(64), enabled: false } } })
    expect(reply).toMatchObject({ ok: false, unknown: false })
    expect(fixture.phase()).toBe('absent')
  })
  it('rejects arbitrary actions and controller impersonation fields', async () => {
    const dispatch = createRemoteDispatcher(host().port, journal())
    expect(await dispatch({ ...send(), callerSessionId: 'administrator' })).toMatchObject({ code: 'BAD_REMOTE_REQUEST' })
    expect(await dispatch({ ...request(), action: 'shell.exec', payload: { cmd: 'whoami' } })).toMatchObject({ code: 'BAD_REMOTE_REQUEST' })
  })
  it('validates complete bytes, relative destinations and history cutoffs', () => {
    const base: MigrationBundle = { migrationId: 'm', taskId: 't', sourceHostId: 's', targetHostId: 'd', historyThroughSeq: 3,
      history: [], artifacts: [], requiredModels: [] }
    expect(migrationBundleSchema.safeParse({ ...base, artifacts: [{ artifactId: 'a', version: 1, sourcePath: '/s/a',
      relativePath: '../escape', sha256: 'a'.repeat(64), bytesBase64: 'YQ==' }] }).success).toBe(false)
    expect(migrationBundleSchema.safeParse({ ...base, history: [{ seq: 4, turn: 1, role: 'user', source: 'user', text: 'x', completed: true }] }).success).toBe(false)
  })
})

describe('real stdio processes and private local IPC', () => {
  it('kills an in-flight carrier on the caller abort signal instead of waiting for its transport deadline',async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),50)
    const transport=createProcessTransport(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:45000})
    const started=Date.now()
    try{await expect(transport.request(request(),controller.signal)).rejects.toThrow('cancelled');expect(Date.now()-started).toBeLessThan(2000)}finally{clearTimeout(timer)}
  })
  const endpoints: IpcEndpoint[] = []; const directories: string[] = []
  afterEach(async () => {
    for (const endpoint of endpoints.splice(0)) await endpoint.close()
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  })
  async function endpoint(hostId: string) {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-integration-')); directories.push(directory)
    const fixture = host(hostId)
    const endpoint = await startIpcEndpoint({ runtimeRoot: directory, profileId: hostId, dispatch: createRemoteDispatcher(fixture.port, journal()) })
    endpoints.push(endpoint)
    const transport = createProcessTransport(process.execPath, ['--no-warnings', '--experimental-strip-types',
      resolve('companions/bridge/stdio.ts'), '--descriptor', endpoint.descriptorPath], { timeoutMs: 15000 })
    return { fixture, endpoint, transport }
  }
  it('crosses two isolated named-pipe/socket endpoints via actual bridge child processes, then migrates in order', async () => {
    const source = await endpoint('source'); const target = await endpoint('target')
    expect(source.endpoint.endpoint).not.toBe(target.endpoint.endpoint)
    expect(await source.transport.request(request())).toMatchObject({ result: { hostId: 'source' } })
    expect(await target.transport.request(request())).toMatchObject({ result: { hostId: 'target' } })
    const migrations = new Map<string, RemoteMigration>()
    const router = createHostRouter({ enabled: () => true, pluginVersion: '0.1.0', operations: journal(),
      migrations: { get: async id => migrations.get(id), put: async record => { migrations.set(record.migrationId, structuredClone(record)) } },
      route: id => ({ enabled: true, transport: id === 'source' ? source.transport : target.transport }) })
    const moved = await router.migrate({ migrationId: 'migration', taskId: 'task', sourceHostId: 'source', targetHostId: 'target',
      expectedBindingVersion: 0, expectedOwnerEpoch: 0, targetWorkspace: '/target', historyThroughSeq: 1, artifactIds: [], pathMap: [], requiredModels: ['deepseek'] })
    expect(moved.phase).toBe('succeeded')
    expect(source.fixture.phase()).toBe('moved')
    expect(target.fixture.phase()).toBe('enabled')
    expect((await router.migrate(moved.request)).result).toEqual(moved.result)
  }, 30000)
  it('rejects a stolen endpoint address without its ephemeral identity and removes the descriptor on close', async () => {
    const fixture = await endpoint('private')
    const descriptor = await readIpcDescriptor(fixture.endpoint.descriptorPath)
    expect(await callIpc({ ...descriptor, token: '0'.repeat(64) }, request())).toMatchObject({ ok: false, code: 'IPC_REFUSED' })
    expect(await callIpc(descriptor, request())).toMatchObject({ ok: true })
    await expect(startIpcEndpoint({ runtimeRoot: directories[0] as string, profileId: 'private', dispatch: createRemoteDispatcher(host().port, journal()) })).rejects.toThrow('already live')
    await fixture.endpoint.close(); endpoints.splice(endpoints.indexOf(fixture.endpoint), 1)
    await expect(readFile(fixture.endpoint.descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 20000)
  it('terminates a real carrier that never answers within the configured deadline', async () => {
    const started = Date.now()
    const transport = createProcessTransport(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 75 })
    await expect(transport.request(request())).rejects.toThrow('deadline')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('SSH and router boundaries', () => {
  it('uses existing alias, strict host keys, POSIX token quoting and no model credential environment', () => {
    const argv = sshArguments('trusted-host', ['node', "/opt/odd' path/bridge.js", '--descriptor', '/run/user/1000/endpoint.json'])
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('BatchMode=yes')
    expect(argv.at(-1)).toContain("'\"'\"'")
    expect(() => sshArguments('-oProxyCommand=evil', ['node'])).toThrow()
    expect(sshEnvironment({ PATH: '/bin', DEEPSEEK_API_KEY: 'secret', OPENAI_API_KEY: 'secret', SSH_AUTH_SOCK: '/agent' })).toEqual({ PATH: '/bin', SSH_AUTH_SOCK: '/agent' })
  })
  it('remains default-off and does not route to unregistered identities', async () => {
    const router = createHostRouter({ enabled: () => false, pluginVersion: '0.1.0', route: () => undefined,
      operations: journal(), migrations: { get: async () => undefined, put: async () => {} } })
    await expect(router.capabilities('missing')).rejects.toThrow('CROSS_HOST_DISABLED')
  })
  it('reconciles a lost mutation response by operation.read without sending a second mutation', async () => {
    const fixture = host(); const dispatch = createRemoteDispatcher(fixture.port, journal()); const localJournal = journal()
    let loseReceipt = true
    const actions: string[] = []
    const router = createHostRouter({ enabled: () => true, pluginVersion: '0.1.0', operations: localJournal,
      migrations: { get: async () => undefined, put: async () => {} }, route: () => ({ enabled: true, transport: { request: async req => {
        actions.push(req.action); const reply = await dispatch(req)
        if (req.action === 'task.send' && loseReceipt) { loseReceipt = false; throw new Error('link dropped after acceptance') }
        return reply
      } } }) })
    const input = send() as Extract<RemoteRequest, { action: 'task.send' }>
    await expect(router.request('source', input.action, input.payload, input.operationId)).rejects.toThrow('UNCONFIRMED')
    expect(await router.request('source', input.action, input.payload, input.operationId)).toEqual({ accepted: 1 })
    expect(actions.filter(action => action === 'task.send')).toHaveLength(1)
    expect(actions).toContain('operation.read')
    expect(fixture.sent()).toBe(1)
  })
  it('detects capability identity mismatch before invoking any write', async () => {
    const router = createHostRouter({ enabled: () => true, pluginVersion: '0.1.0', operations: journal(),
      migrations: { get: async () => undefined, put: async () => {} },
      route: () => ({ enabled: true, transport: { request: createRemoteDispatcher(host('other-host').port, journal()) } }) })
    await expect(router.capabilities('source')).rejects.toThrow('IDENTITY_OR_VERSION')
  })
})
