import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import { createRemoteHostAdapter, remoteSessionDispatchBlocked, remoteTaskFrozen, type RemoteHostAdapterOptions } from '../src/remote/host-adapter.ts'
import { createRemoteDispatcher } from '../src/remote/dispatcher.ts'
import { createHostRouter, type RemoteMigration } from '../src/remote/router.ts'
import { startIpcEndpoint, type IpcEndpoint } from '../src/remote/ipc.ts'
import { createProcessTransport, type RemoteTransport } from '../src/remote/transport.ts'
import { remoteDigest, type RemoteOperation, type RemoteRequest } from '../src/remote/protocol.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

const directories: string[] = []
const endpoints: IpcEndpoint[] = []
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function journal() {
  const rows = new Map<string, RemoteOperation>()
  return { rows, get: async (id: string) => rows.get(id), put: async (record: RemoteOperation) => { rows.set(record.operationId, structuredClone(record)) } }
}
function agent(id: string) {
  const events: SessionEventLike[] = []
  const injections: unknown[] = []
  const value = { id: SessionId(id), status: 'idle' as 'idle' | 'running',
    session: { events, get seq() { return events.at(-1)?.seq ?? 0 } },
    inbox: { hasPending: false, nextTurn: [], nextStep: [], remove: () => false, replace: () => false },
    followup: () => {}, steer: () => {},
    cancel: () => {
      value.status = 'idle'
      const turn = (events.findLast(event => event.type === 'turn/start')?.data as { turn?: number } | undefined)?.turn ?? 0
      events.push({ type: 'turn/end', seq: value.session.seq + 1, data: { turn, reason: 'cancelled' } })
    },
    inject: (message: unknown) => {
      injections.push(message)
      events.push({ type: 'user/message', seq: value.session.seq + 1, data: message })
    }, injections,
  }
  return value
}
async function fixture(hostId: string) {
  const directory = await mkdtemp(join(tmpdir(), `dsh-remote-host-${hostId}-`)); directories.push(directory)
  const workspace = join(directory, 'workspace'); await mkdir(workspace)
  const tables = createInMemoryTables(); const store = new ConductorStore(tables)
  const live = new Map<string, ReturnType<typeof agent>>(); live.set('controller', agent('controller'))
  let writes = 0; let sent = 0
  const fs: RemoteHostAdapterOptions['fs'] = {
    async resolve(path) {
      const normalized = resolve(path)
      let canonical: string
      try { canonical = await realpath(normalized) } catch { canonical = join(await realpath(dirname(normalized)), normalized.slice(dirname(normalized).length + 1)) }
      return { targetKey: canonical as never, displayPath: canonical }
    },
    contains(parent, child) { const part = relative(parent.displayPath, child.displayPath); return part === '' || (!part.startsWith('..') && !isAbsolute(part)) },
    processPath: target => target.displayPath,
    async stat(target) {
      try {
        const info = await stat(target.displayPath)
        return { version: `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` as never, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    },
    async lstat(path) {
      try {
        const info = await lstat(path)
        return { version: `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` as never,
          type: info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    },
    async readBytes(target, _signal, maxBytes) { const bytes = await readFile(target.displayPath); if (bytes.byteLength > maxBytes) throw new Error('too large'); return bytes },
    async writeText(target, text, expected) {
      expect(expected).toEqual({ kind: 'createIfAbsent' })
      await writeFile(target.displayPath, text, { flag: 'wx' }); writes++
      return { operation: 'create', version: 'written' as never, before: null, after: text }
    },
  }
  const options: RemoteHostAdapterOptions = {
    hostId, pluginVersion: '0.1.0', store,
    agents: { get: id => live.get(id), list: () => [...live.values()], create: async opts => {
      const value = agent(opts.sessionId); live.set(value.id, value)
      return { agent: value, dispose: async () => { live.delete(value.id) } }
    } },
    coordinator: { send: async input => { sent++; return { taskId: input.taskId, mode: input.mode, delivery: 'accepted', messageId: randomUUID() } },
      stop: async input => ({ taskId: input.taskId, outcome: 'confirmed', sent: false, keptText: false, reason: 'test stop receipt' }),
      queue: async input => ({ taskId: input.taskId, action: input.action, queue: [], outcome: 'listed' } as never) },
    controllerSessionId: () => 'controller', capabilities: async () => ({ models: ['deepseek'], workspaceCapable: true }),
    dispatchGuardReady: () => true,
    fs, workspaces: { register: async () => ({ ok: true, workspaceId: 'workspace-id' }), attach: async () => ({ ok: true }) }, workspaceRoots: [workspace],
    createMessage: (text, source) => ({ id: randomUUID(), content: text, source }), flushSession: async () => {}, stopTimeoutMs: 40,
  }
  const port = createRemoteHostAdapter(options); const operations = journal()
  const dispatch = createRemoteDispatcher(port, operations)
  async function seed(text = 'artifact content') {
    const source = agent('source-session')
    source.session.events.push({ type: 'turn/start', seq: 0, data: { turn: 0 } },
      { type: 'user/message', seq: 1, data: { content: 'original request', source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, data: { message: { content: 'x'.repeat(1500) } } },
      { type: 'turn/end', seq: 3, data: { turn: 0 } })
    live.set(source.id, source)
    const now = new Date().toISOString()
    await store.createTask({ taskId: 'task', title: 'Original task', pinned: false, archived: false, controllerSessionId: 'controller', requestedBy: 'user',
      contextMode: 'empty', preparation: 'ready', preparationPhase: 'ready', createdAt: now, updatedAt: now })
    await store.putBinding({ taskId: 'task', bindingId: 'source-binding', hostId: 'local', sessionId: source.id, version: 0, cwd: workspace, createdAt: now })
    await store.putAccess({ taskId: 'task', ownerSessionId: 'controller', ownerEpoch: 0, observerSessionIds: [], updatedAt: now })
    await writeFile(join(workspace, 'result.txt'), text)
    await store.putArtifact({ artifactId: 'artifact', taskId: 'task', sessionId: source.id, name: 'result.txt', hostId: 'local', path: join(workspace, 'result.txt'),
      kind: 'file', contentVersion: 2, existence: 'present', contentHash: sha(text), hashScope: 'full', acceptance: 'pass', acceptedBy: 'user',
      evidence: [], createdAt: now, updatedAt: now })
    return source
  }
  const transport: RemoteTransport = { request: dispatch }
  async function bridge() {
    const endpoint = await startIpcEndpoint({ runtimeRoot: directory, profileId: hostId, dispatch }); endpoints.push(endpoint)
    return createProcessTransport(process.execPath, ['--no-warnings', '--experimental-strip-types', resolve('companions/bridge/stdio.ts'), '--descriptor', endpoint.descriptorPath], { timeoutMs: 15000 })
  }
  return { directory, workspace, options, port, operations, dispatch, transport, bridge, seed, store, tables, live, writes: () => writes, sent: () => sent }
}
function setupRouter(source: Awaited<ReturnType<typeof fixture>>, target: Awaited<ReturnType<typeof fixture>>) {
  const migrations = new Map<string, RemoteMigration>()
  return createHostRouter({ enabled: () => true, pluginVersion: '0.1.0', operations: journal(),
    migrations: { get: async id => migrations.get(id), put: async value => { migrations.set(value.migrationId, structuredClone(value)) } },
    route: id => ({ enabled: true, transport: id === 'source' ? source.transport : target.transport }) })
}
function migration(source: Awaited<ReturnType<typeof fixture>>, target: Awaited<ReturnType<typeof fixture>>) {
  return { migrationId: 'migration', taskId: 'task', sourceHostId: 'source', targetHostId: 'target', expectedBindingVersion: 0, expectedOwnerEpoch: 0,
    targetWorkspace: target.workspace, historyThroughSeq: 3, artifactIds: ['artifact'], pathMap: [{ from: source.workspace, to: target.workspace }], requiredModels: ['deepseek'] }
}

describe('Host-service migration adapter with real temporary files', () => {
  it('transfers full completed text and selected hashes across actual IPC bridge processes; enables once and switches source binding', async () => {
    const source = await fixture('source'); const target = await fixture('target'); const original = await source.seed()
    source.transport.request = (await source.bridge()).request; target.transport.request = (await target.bridge()).request
    const router = setupRouter(source, target); const input = migration(source, target)
    const outcome = await router.migrate(input)
    expect(outcome.phase).toBe('succeeded')
    expect(await readFile(join(target.workspace, 'result.txt'), 'utf8')).toBe('artifact content')
    expect(target.writes()).toBe(1)
    expect(target.store.getTask('task')?.preparation).toBe('ready')
    expect(target.store.getAccess('task')?.ownerSessionId).toBe('controller')
    expect(target.store.getArtifact('artifact')).toMatchObject({ contentVersion: 2, contentHash: sha('artifact content'), acceptance: 'pending' })
    const binding = source.store.getBinding(source.store.getTask('task')?.currentBindingId as string)
    expect(binding).toMatchObject({ hostId: 'target', version: 1 })
    expect(source.store.getBinding('source-binding')?.retiredAt).toBeDefined()
    expect(original.status).toBe('idle')
    expect(remoteSessionDispatchBlocked(source.store, original.id)).toBe(true)
    expect(remoteSessionDispatchBlocked(target.store, outcome.result?.sessionId as string)).toBe(false)
    const moved = target.live.get(outcome.result?.sessionId as string)
    expect(JSON.stringify(moved?.injections)).toContain('x'.repeat(1500))
    expect(moved?.status).toBe('idle')
    await router.migrate(input)
    expect(target.writes()).toBe(1)
    await expect(router.abort(input.migrationId)).rejects.toThrow('ALREADY_ENABLED')
  }, 30000)
  it('keeps the source frozen and target absent if the exact turn never confirms; explicit abort restores source', async () => {
    const source = await fixture('source'); const target = await fixture('target'); const live = await source.seed()
    live.status = 'running'; live.session.events.push({ type: 'turn/start', seq: 4, data: { turn: 1 } }); live.cancel = () => {}
    const router = setupRouter(source, target)
    await expect(router.migrate(migration(source, target))).rejects.toThrow('UNKNOWN')
    expect(remoteTaskFrozen(source.store, 'task')).toBe(true)
    expect(source.store.getTask('task')?.preparation).toBe('preparing')
    expect(target.store.getTask('task')).toBeUndefined()
    expect((await router.abort('migration')).phase).toBe('aborted')
    expect(remoteTaskFrozen(source.store, 'task')).toBe(false)
    expect(source.store.getTask('task')?.preparation).toBe('ready')
    expect(remoteSessionDispatchBlocked(source.store, live.id)).toBe(false)
    await expect(router.migrate(migration(source, target))).rejects.toThrow('ABORTED')
  })
  it('never overwrites a destination and abort leaves the existing file intact', async () => {
    const source = await fixture('source'); const target = await fixture('target'); await source.seed()
    await writeFile(join(target.workspace, 'result.txt'), 'user owned')
    const router = setupRouter(source, target)
    await expect(router.migrate(migration(source, target))).rejects.toThrow()
    expect(await readFile(join(target.workspace, 'result.txt'), 'utf8')).toBe('user owned')
    expect(target.writes()).toBe(0)
    expect((await router.abort('migration')).phase).toBe('aborted')
  })
  it('refuses unpinned/drifting artifacts and does not stage', async () => {
    const source = await fixture('source'); const target = await fixture('target'); await source.seed()
    await writeFile(join(source.workspace, 'result.txt'), 'changed later')
    await expect(setupRouter(source, target).migrate(migration(source, target))).rejects.toThrow()
    expect(target.writes()).toBe(0)
    expect(target.store.getTask('task')).toBeUndefined()
  })
  it('refuses binary artifact bytes before target creation instead of corrupting them through writeText', async () => {
    const source = await fixture('source'); const target = await fixture('target'); await source.seed('\0binary')
    const router = setupRouter(source, target)
    await expect(router.migrate(migration(source, target))).rejects.toThrow()
    expect(target.store.getTask('task')).toBeUndefined()
    expect(target.writes()).toBe(0)
    await router.abort('migration')
  })
  it('uses the optional Host byte capability for lossless non-UTF8 cross-Host artifacts', async () => {
    const source = await fixture('source'); const target = await fixture('target'); await source.seed()
    const bytes = new Uint8Array([0, 255, 128, 13, 10])
    await writeFile(join(source.workspace, 'result.txt'), bytes)
    await source.store.putArtifact({ ...source.store.getArtifact('artifact')!, contentHash: sha(bytes) })
    const calls: unknown[] = []
    Object.assign(target.port, createRemoteHostAdapter({ ...target.options, binaryFiles: {
      version: 1, maxBytes: 64 * 1024 * 1024,
      async writeBytes(destination, content, expected) {
        calls.push(expected)
        await writeFile(destination.displayPath, content, { flag: 'wx' })
        return { operation: 'create', version: 'binary-created' as never, sizeBytes: content.byteLength, sha256: sha(content) }
      },
    } }))
    expect(await target.port.capabilities()).toMatchObject({ binaryArtifacts: true })
    expect((await setupRouter(source, target).migrate(migration(source, target))).phase).toBe('succeeded')
    expect(await readFile(join(target.workspace, 'result.txt'))).toEqual(Buffer.from(bytes))
    expect(calls).toEqual([{ kind: 'createIfAbsent' }])
    expect(target.writes()).toBe(0)
  })
  it('checks actual target model/workspace capability and operator roots before stage', async () => {
    const source = await fixture('source'); const target = await fixture('target'); await source.seed()
    const router = setupRouter(source, target)
    await expect(router.migrate({ ...migration(source, target), requiredModels: ['unavailable'] })).rejects.toThrow('INCOMPATIBLE')
    expect(remoteTaskFrozen(source.store, 'task')).toBe(false)
    const outside = join(target.directory, 'outside'); await mkdir(outside)
    await expect(router.migrate({ ...migration(source, target), migrationId: 'outside', targetWorkspace: outside,
      pathMap: [{ from: source.workspace, to: outside }] })).rejects.toThrow()
    expect(target.writes()).toBe(0)
  })
  it('refuses source symlink components even when selected explicitly', async () => {
    const source = await fixture('source'); const target = await fixture('target'); await source.seed()
    const outside = join(source.directory, 'other'); await mkdir(outside); await writeFile(join(outside, 'result.txt'), 'artifact content')
    await symlink(outside, join(source.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const artifact = source.store.getArtifact('artifact')!
    await source.store.putArtifact({ ...artifact, path: join(source.workspace, 'linked', 'result.txt') })
    await expect(setupRouter(source, target).migrate(migration(source, target))).rejects.toThrow()
    expect(target.writes()).toBe(0)
  })
  it('rechecks source idle/sequence immediately before enabling a staged target', async () => {
    const source = await fixture('source'); const target = await fixture('target'); const live = await source.seed()
    const stage = target.port.stage
    target.port.stage = async (...args) => {
      const result = await stage(...args)
      live.session.events.push({ type: 'turn/start', seq: 4, data: { turn: 1 } }); live.status = 'running'
      return result
    }
    const router = setupRouter(source, target)
    await expect(router.migrate(migration(source, target))).rejects.toThrow('SOURCE_FREEZE_UNCONFIRMED')
    expect(target.store.getTask('task')?.preparation).toBe('preparing')
    expect(target.store.getTask('task')?.currentBindingId).toBeUndefined()
    expect((await router.abort('migration')).phase).toBe('aborted')
  })
  it('refuses stale owners, bindings and frozen sends through the real adapter gate', async () => {
    const source = await fixture('source'); const target = await fixture('target'); await source.seed()
    const base = { taskId: 'task', messageId: 'm', text: 'continue', mode: 'queue' as const, expectedOwnerEpoch: 0, expectedBindingVersion: 0 }
    await expect(source.port.send({ ...base, expectedOwnerEpoch: 1 }, 'send-1')).rejects.toThrow('STALE')
    await source.port.freeze({ migrationId: 'm', taskId: 'task', targetHostId: 'target', expectedOwnerEpoch: 0, expectedBindingVersion: 0 }, 'freeze')
    await expect(source.port.send(base, 'send-2')).rejects.toThrow('FROZEN')
    expect(source.sent()).toBe(0)
    const aborted = await target.port.abort({ migrationId: 'm' }, 'abort')
    await source.port.resume({ migrationId: 'm', aborted }, 'resume')
    expect(await source.port.send(base, 'send-3')).toMatchObject({ delivery: 'accepted' })
  })
  it('routes stop/queue with the configured local controller and preserves operation idempotency', async () => {
    const source = await fixture('source'); await source.seed()
    const stops: unknown[] = []; const queues: unknown[] = []
    source.options.coordinator.stop = async input => { stops.push(input); return { taskId: input.taskId, outcome: 'confirmed', sent: false, keptText: false, reason: 'confirmed' } }
    source.options.coordinator.queue = async input => { queues.push(input); return { taskId: input.taskId, action: input.action } as never }
    const stop: RemoteRequest = { protocolVersion: '1', requestId: 'stop-request', action: 'task.stop', operationId: 'stop',
      payload: { taskId: 'task', expectedOwnerEpoch: 0, expectedBindingVersion: 0, expectedTurn: 4, expectedStartSeq: 18 } }
    expect(await source.dispatch(stop)).toMatchObject({ ok: true })
    expect(await source.dispatch({ ...stop, requestId: 'retry' })).toMatchObject({ ok: true })
    expect(stops).toHaveLength(1)
    expect(stops[0]).toMatchObject({ callerSessionId: 'controller', expectedTurn: 4, expectedStartSeq: 18 })
    expect(await source.dispatch({ protocolVersion: '1', requestId: 'queue-request', action: 'task.queue', operationId: 'queue',
      payload: { taskId: 'task', action: 'withdraw', messageId: 'message', expectedOwnerEpoch: 0, expectedBindingVersion: 0 } })).toMatchObject({ ok: true })
    expect(queues[0]).toMatchObject({ callerSessionId: 'controller', action: 'withdraw', messageId: 'message' })
  })
  it('refuses staged artifact drift before enable and can safely abort the disabled target', async () => {
    const source = await fixture('source'); const target = await fixture('target'); await source.seed()
    const stage = target.port.stage
    target.port.stage = async (...args) => { const result = await stage(...args); await writeFile(join(target.workspace, 'result.txt'), 'changed after staging'); return result }
    const router = setupRouter(source, target)
    await expect(router.migrate(migration(source, target))).rejects.toThrow()
    expect(target.store.getTask('task')?.preparation).toBe('preparing')
    expect(target.store.getTask('task')?.currentBindingId).toBeUndefined()
    await router.abort('migration')
    expect(source.store.getTask('task')?.preparation).toBe('ready')
  })
  it('reconciles a crash after the source binding switched but before its moved receipt persisted', async () => {
    const source = await fixture('source'); const target = await fixture('target'); await source.seed()
    const update = source.store.updateOperation.bind(source.store)
    let fail = true
    source.store.updateOperation = async (id, transform) => {
      const next = transform(source.store.getOperation(id)!)
      if (next.phase === 'remote_moved' && fail) { fail = false; throw new Error('crash after binding commit') }
      return await update(id, transform)
    }
    const router = setupRouter(source, target); const input = migration(source, target)
    await expect(router.migrate(input)).rejects.toThrow()
    expect(target.store.getTask('task')?.preparation).toBe('ready')
    expect((await router.migrate(input)).phase).toBe('succeeded')
    expect(source.store.getTask('task')?.preparation).toBe('ready')
    expect(target.writes()).toBe(1)
  })
  it('recovers enabled receipts after durable ready-write failure without enabling another session', async () => {
    const source = await fixture('source'); const target = await fixture('target'); await source.seed()
    const freeze = await source.port.freeze({ migrationId: 'm', taskId: 'task', targetHostId: 'target', expectedOwnerEpoch: 0, expectedBindingVersion: 0 }, 'freeze')
    const bundle = await source.port.exportBundle({ receipt: freeze, historyThroughSeq: 3, targetWorkspace: target.workspace,
      artifactIds: ['artifact'], pathMap: [{ from: source.workspace, to: target.workspace }], requiredModels: [] })
    const stageRequest: RemoteRequest = { protocolVersion: '1', requestId: 'stage-request', action: 'migration.stage', operationId: 'stage',
      payload: { receipt: freeze, bundle, bundleDigest: remoteDigest(bundle), targetWorkspace: target.workspace } }
    const staged = await target.dispatch(stageRequest)
    expect(staged.ok).toBe(true)
    if (!staged.ok) return
    const update = target.store.updateTask.bind(target.store)
    target.store.updateTask = async (id, fn) => {
      const next = fn(target.store.getTask(id)!)
      if (next.preparation === 'ready') throw new Error('crash before ready persisted')
      return await update(id, fn)
    }
    const enabling = await target.dispatch({ protocolVersion: '1', requestId: 'enable-request', action: 'migration.enable', operationId: 'enable',
      payload: { receipt: freeze, stage: staged.result, stageOperationId: 'stage' } })
    expect(enabling).toMatchObject({ unknown: true })
    target.store.updateTask = update
    const recovered = await createRemoteDispatcher(createRemoteHostAdapter(target.options), target.operations)({
      protocolVersion: '1', requestId: 'reconcile', action: 'operation.read', payload: { operationId: 'enable' } })
    expect(recovered).toMatchObject({ ok: true, result: { state: 'succeeded' } })
    expect(target.store.getTask('task')?.preparation).toBe('ready')
    expect(target.live.size).toBe(2)
  })
})
