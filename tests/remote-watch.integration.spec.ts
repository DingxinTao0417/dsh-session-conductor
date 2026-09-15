import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import { initialProjection } from '../src/service/projection.ts'
import { encodeObservationCursor, type TaskObservation } from '../src/service/observation.ts'
import type { RemoteRequest } from '../src/remote/protocol.ts'
import manifest from '../package.json' with { type: 'json' }

const wire = vi.hoisted(() => ({ call: undefined as undefined | ((request: RemoteRequest) => Promise<unknown>) }))
vi.mock('../src/remote/transport.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/remote/transport.ts')>(),
  createSshTransport: () => ({ request: async (request: RemoteRequest) => ({ ok: true, requestId: request.requestId,
    result: await wire.call!(request) }) }),
}))
const opened: Awaited<ReturnType<typeof mountedPlugin>>[] = []
const roots: string[] = []
afterEach(async () => {
  for (const plugin of opened.splice(0)) await plugin.close()
  for (const root of roots.splice(0)) {
    if (resolve(root).startsWith(resolve(tmpdir()) + '\\dsh-watch-') || resolve(root).startsWith(resolve(tmpdir()) + '/dsh-watch-')) {
      await rm(root, { recursive: true, force: true })
    } else throw new Error('unexpected temporary cleanup target')
  }
})

async function fixture() {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'dsh-watch-'))
  roots.push(runtimeRoot)
  const notices: string[] = []
  const owner = { id: 'owner', status: 'idle', session: { events: [], seq: -1 },
    steer: (message: { content: { text: string }[] }) => { notices.push(message.content.map(item => item.text).join('')) },
    followup: vi.fn() }
  let snapshot: TaskObservation = { taskId: 'target', sessionId: 'remote-session', position: 5, throughSeq: 5,
    state: { ...initialProjection(), cursor: 5 }, bindingVersion: 2, ownerEpoch: 0, notable: [], truncated: false }
  let fail = false
  let beforeReply: (() => Promise<void>) | undefined
  const queried: number[] = []
  wire.call = async request => {
    if (request.action === 'capabilities') return { hostId: 'remote', protocolVersion: '1', pluginVersion: manifest.version, models: [], workspaceCapable: true }
    if (request.action !== 'task.observe') throw new Error('unexpected remote action')
    queried.push(request.payload.afterSeq)
    if (fail) throw new Error('injected remote disconnection')
    const response = { ...snapshot, notable: snapshot.notable.filter(entry => entry.seq > request.payload.afterSeq) }
    await beforeReply?.()
    return response
  }
  const plugin = await mountedPlugin({
    agents: { get: (id: string) => id === 'owner' ? owner : undefined, list: () => [owner] },
    sessions: { flush: async () => true },
    fs: { resolve: async (path: string) => path, contains: () => true },
    workspaceRegistry: { create: async (path: string) => ({ id: 'workspace', path, attachSession: async () => {} }) },
  }, false, async store => {
    await store.putRemoteHost({ hostId: 'remote', label: 'remote', enabled: true, createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T00:00:00Z' })
  }, { crossHostEnabled: true, bridge: { hostId: 'source', controllerSessionId: 'owner', profileId: 'watch', runtimeRoot,
    workspaceRoots: [runtimeRoot] }, remoteConnections: [{ hostId: 'remote', sshAlias: 'test-only', nodePath: '/node',
      bridgePath: '/bridge', descriptorPath: '/descriptor' }] })
  opened.push(plugin)
  await plugin.store.putBinding({ bindingId: 'remote-binding', taskId: 'target', hostId: 'remote', sessionId: 'remote-session', version: 2,
    createdAt: '2026-09-15T00:00:00Z' })
  for (let attempt = 0; ; attempt++) {
    const state = await plugin.call('conductor_remote', { action: 'list' })
    if ((state.availability as { available: boolean }).available) break
    if (attempt > 400) throw new Error('test IPC bridge did not start')
    await new Promise(resolveReady => setTimeout(resolveReady, 5))
  }
  return { plugin, notices, queried, snapshot: () => snapshot, update: (value: Partial<TaskObservation>) => { snapshot = { ...snapshot, ...value } },
    fail: () => { fail = true }, beforeReply: (fn: () => Promise<void>) => { beforeReply = fn },
    start: () => plugin.call('conductor_watch', { action: 'start', taskId: 'target' }),
    report: () => plugin.call('conductor_watch', { action: 'report' }),
  }
}

describe('production remote watch through a finite transport', () => {
  it('starts at the current remote position, reports completion once, and persists a session-qualified cursor', async () => {
    const held = await fixture()
    await held.start()
    expect(held.plugin.store.getWatch('owner::target')?.cursor).toBe(encodeObservationCursor('remote-session', 5))
    held.update({ position: 8, throughSeq: 8, state: { ...initialProjection(), cursor: 8, lastTurn: 'completed' },
      notable: [{ seq: 8, at: Date.now(), reportTriggered: false, event: { kind: 'turn_ended', turn: 1, outcome: 'completed', detail: 'finished' } }] })
    await held.report()
    expect(held.notices).toHaveLength(1)
    expect(held.notices[0]).toContain('completed')
    expect(held.plugin.store.getWatch('owner::target')?.cursor).toBe(encodeObservationCursor('remote-session', 8))
    await held.report()
    expect(held.notices).toHaveLength(1)
    expect(held.queried).toEqual([-1, 5, 8])
  })

  it('advances a notice-only page silently and reports a later disconnection only once', async () => {
    const held = await fixture()
    await held.start()
    held.update({ position: 7, throughSeq: 7, state: { ...initialProjection(), cursor: 7 }, notable: [{ seq: 7,
      reportTriggered: true, event: { kind: 'turn_ended', turn: 1, outcome: 'completed', detail: 'notice response' } }] })
    await held.report()
    expect(held.notices).toEqual([])
    expect(held.plugin.store.getWatch('owner::target')?.cursor).toBe(encodeObservationCursor('remote-session', 7))
    held.fail()
    await held.report()
    await held.report()
    expect(held.notices).toHaveLength(1)
    expect(held.notices[0]).toMatch(/could not be observed|unavailable/)
  })

  it('discards late remote observations when permission is revoked during transport', async () => {
    const held = await fixture()
    await held.start()
    held.update({ position: 8, throughSeq: 8, state: { ...initialProjection(), cursor: 8 }, notable: [{ seq: 8,
      reportTriggered: false, event: { kind: 'user_question', callId: 'private', toolName: 'ask' } }] })
    held.beforeReply(async () => { await held.plugin.store.putAccess({ ...held.plugin.store.getAccess('target')!,
      ownerSessionId: 'new-owner', ownerEpoch: 1, observerSessionIds: [] }) })
    const result = await held.report()
    expect(held.notices).toEqual([])
    expect(String(result.refusals)).toMatch(/permission|binding/)
  })
})
