import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import type { ConductorStore } from '../src/store/repository.ts'
import type { StoredOperationRecord } from '../src/store/schema.ts'

const PASS_INTERVAL_MS = 10
const T0 = Date.parse('2026-09-15T12:00:00.000Z')
const opened: Awaited<ReturnType<typeof mountedPlugin>>[] = []

afterEach(async () => {
  for (const plugin of opened.splice(0)) await plugin.close()
  vi.useRealTimers()
})

function event(seq: number, type: string, data: unknown): SessionEventLike {
  return { seq, type, time: T0 + seq * 1_000, data }
}

function terminalHistory(): readonly SessionEventLike[] {
  return [
    event(40, 'turn/start', { turn: 17 }),
    event(41, 'user/message', { id: 'relay-1', content: [{ type: 'text', text: 'Do the focused work.' }] }),
    event(42, 'assistant/message', { turn: 17, message: { content: [{ type: 'text', text: 'Child result.' }] } }),
    event(43, 'turn/end', { turn: 17, reason: { kind: 'completed' } }),
  ]
}

/** Seed the exact durable relation a create with an initial instruction owns. */
async function seedInitialCompletionReturn(
  store: ConductorStore,
  mutateOperation: (operation: StoredOperationRecord) => StoredOperationRecord = operation => operation,
): Promise<void> {
  const stamp = new Date(T0).toISOString()
  await store.createTask({
    taskId: 'target', title: 'Delegated child', controllerSessionId: 'owner', requestedBy: 'user',
    pinned: false, archived: false, contextMode: 'empty', preparation: 'ready', preparationPhase: 'ready',
    completionReturn: {
      operationId: 'create-1', bindingId: 'binding-1', bindingVersion: 1, messageId: 'relay-1',
      phase: 'armed', armedAt: stamp, updatedAt: stamp,
    },
    createdAt: stamp, updatedAt: stamp,
  })
  await store.putAccess({ taskId: 'target', ownerSessionId: 'owner', ownerEpoch: 0, observerSessionIds: [], updatedAt: stamp })
  await store.putBinding({
    bindingId: 'binding-1', taskId: 'target', sessionId: 'session-1', hostId: 'local', version: 1, createdAt: stamp,
  })
  const claimed = await store.beginOperation({
    operationId: 'create-1', kind: 'create', taskId: 'target', messageId: 'relay-1',
    params: { controllerSessionId: 'owner', title: 'Delegated child', instruction: 'Do the focused work.' },
    dispatchGuard: { ownerSessionId: 'owner', ownerEpoch: 0, bindingId: 'binding-1', bindingVersion: 1 },
  })
  if (claimed.kind !== 'accepted') throw new Error('completion-return hardening fixture could not claim create-1')
  await store.markDelivery('create-1', 'accepted', 'initial_message_accepted')
  await store.updateOperation('create-1', mutateOperation)
}

/** Advance one scheduled production pass after plugin mounting has settled. */
async function advanceOnePass(): Promise<void> {
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(PASS_INTERVAL_MS)
  await Promise.resolve()
}

async function settleMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}

describe('completion-return hardening at the production pass boundary', () => {
  it.each([
    ['a non-create/fork operation', (operation: StoredOperationRecord) => ({ ...operation, kind: 'send' })],
    ['an operation for another task', (operation: StoredOperationRecord) => ({ ...operation, taskId: 'other-task' })],
    ['an operation for another relay', (operation: StoredOperationRecord) => ({ ...operation, messageId: 'other-relay' })],
    ['an operation with no initial instruction', (operation: StoredOperationRecord) => ({
      ...operation,
      params: { controllerSessionId: 'owner', title: 'Delegated child', instruction: '' },
    })],
  ] as const)('does not read child history for %s', async (_caseName, mutateOperation) => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const get = vi.fn(() => undefined)
    const readSession = vi.fn(async (sessionId: string) => ({ session: { id: sessionId }, events: terminalHistory() }))
    const plugin = await mountedPlugin({
      agents: { get, list: () => [] },
      sessionQuery: { readSession },
    }, false, store => seedInitialCompletionReturn(store, mutateOperation), { passIntervalMs: PASS_INTERVAL_MS })
    opened.push(plugin)
    get.mockClear()
    readSession.mockClear()

    await advanceOnePass()

    expect(get).not.toHaveBeenCalledWith('session-1')
    expect(readSession).not.toHaveBeenCalled()
    expect(plugin.store.getTask('target')?.completionReturn?.phase).toBe('armed')
  })

  it('does not read child history after the original parent loses read access', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const get = vi.fn(() => undefined)
    const readSession = vi.fn(async (sessionId: string) => ({ session: { id: sessionId }, events: terminalHistory() }))
    const plugin = await mountedPlugin({
      agents: { get, list: () => [] },
      sessionQuery: { readSession },
    }, false, seedInitialCompletionReturn, { passIntervalMs: PASS_INTERVAL_MS })
    opened.push(plugin)
    const access = plugin.store.getAccess('target')!
    await plugin.store.putAccess({
      ...access,
      ownerSessionId: 'later-controller',
      ownerEpoch: access.ownerEpoch + 1,
      observerSessionIds: [],
      updatedAt: new Date(T0 + 1_000).toISOString(),
    })
    get.mockClear()
    readSession.mockClear()

    await advanceOnePass()

    expect(get).not.toHaveBeenCalledWith('session-1')
    expect(readSession).not.toHaveBeenCalled()
    expect(plugin.store.getTask('target')?.completionReturn?.phase).toBe('armed')
  })

  it('does not read child history after management is released while the owner still may read', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const get = vi.fn(() => undefined)
    const readSession = vi.fn(async (sessionId: string) => ({ session: { id: sessionId }, events: terminalHistory() }))
    const plugin = await mountedPlugin({
      agents: { get, list: () => [] },
      sessionQuery: { readSession },
    }, false, seedInitialCompletionReturn, { passIntervalMs: PASS_INTERVAL_MS })
    opened.push(plugin)
    const access = plugin.store.getAccess('target')!
    await plugin.store.putAccess({
      ...access,
      detachedAt: new Date(T0 + 1_000).toISOString(),
      updatedAt: new Date(T0 + 1_000).toISOString(),
    })
    get.mockClear()
    readSession.mockClear()

    await advanceOnePass()

    expect(get).not.toHaveBeenCalledWith('session-1')
    expect(readSession).not.toHaveBeenCalled()
    expect(plugin.store.getTask('target')?.completionReturn?.phase).toBe('armed')
  })

  it('does not persist a cold result that resolves after the plugin is disabled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    let resolveRead: ((value: { session: { id: string }, events: readonly SessionEventLike[] }) => void) | undefined
    const readSession = vi.fn(() => new Promise<{ session: { id: string }, events: readonly SessionEventLike[] }>(resolve => {
      resolveRead = resolve
    }))
    const plugin = await mountedPlugin({
      agents: { get: () => undefined, list: () => [] },
      sessionQuery: { readSession },
    }, false, seedInitialCompletionReturn, { passIntervalMs: PASS_INTERVAL_MS })
    opened.push(plugin)
    readSession.mockClear()

    // The timer starts an async pass but does not await the cold Host reader.
    vi.advanceTimersByTime(PASS_INTERVAL_MS)
    await settleMicrotasks()
    expect(readSession).toHaveBeenCalledWith('session-1')
    const beforeDisable = structuredClone(plugin.store.getTask('target')?.completionReturn)

    await plugin.close()
    opened.splice(opened.indexOf(plugin), 1)
    resolveRead?.({ session: { id: 'session-1' }, events: terminalHistory() })
    await settleMicrotasks()

    expect(plugin.store.getTask('target')?.completionReturn).toEqual(beforeDisable)
  })
})
