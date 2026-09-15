import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import type { ConductorStore } from '../src/store/repository.ts'

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

function hostAgent(id: string, events: SessionEventLike[] = []) {
  return {
    id,
    status: 'idle' as const,
    session: {
      events,
      get seq() { return events.at(-1)?.seq ?? -1 },
    },
    steer: vi.fn(),
    followup: vi.fn(),
  }
}

/** Seed the durable state a completed instructed create leaves behind. */
async function seedInitialCompletionReturn(store: ConductorStore): Promise<void> {
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
  if (claimed.kind !== 'accepted') throw new Error('completion-return fixture could not claim create-1')
  await store.markDelivery('create-1', 'dispatching', 'initial_message_dispatching')
  await store.markDelivery('create-1', 'accepted', 'initial_message_accepted')
}

/** Run exactly the next scheduled production pass without waiting in real time. */
async function advanceOnePass(): Promise<void> {
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(PASS_INTERVAL_MS)
  await Promise.resolve()
}

describe('one-shot completion return through the mounted production pass', () => {
  it('returns the exact initial turn once without waking, steering, following up, or watching the parent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const events: SessionEventLike[] = []
    const parent = hostAgent('owner')
    const child = hostAgent('session-1', events)
    const agents = new Map([[parent.id, parent], [child.id, child]])
    const plugin = await mountedPlugin({
      agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] },
    }, false, seedInitialCompletionReturn, { passIntervalMs: PASS_INTERVAL_MS })
    opened.push(plugin)

    // This is the actual Host order for an initial agent turn: the Host opens
    // the turn, then commits the relay message, then records its public answer.
    events.push(
      event(40, 'turn/start', { turn: 17 }),
      event(41, 'user/message', { id: 'relay-1', content: [{ type: 'text', text: 'Do the focused work.' }] }),
      event(42, 'assistant/message', { turn: 17, message: { content: [
        { type: 'reasoning', text: 'This must never become the card preview.' },
        { type: 'text', text: 'The initial delegated result is ready.' },
      ] } }),
      event(43, 'turn/end', { turn: 17, reason: { kind: 'completed' } }),
    )

    await advanceOnePass()
    const first = structuredClone(plugin.store.getTask('target')!.completionReturn!)
    expect(first).toMatchObject({
      operationId: 'create-1', bindingId: 'binding-1', bindingVersion: 1, messageId: 'relay-1',
      phase: 'returned', messageSeq: 41, turn: 17, startSeq: 40, endSeq: 43,
      outcome: 'completed', preview: 'The initial delegated result is ready.',
      completedAt: new Date(T0 + 43_000).toISOString(),
    })
    expect(first.preview).not.toContain('never become')
    expect(parent.steer).not.toHaveBeenCalled()
    expect(parent.followup).not.toHaveBeenCalled()
    expect(plugin.store.listEveryWatch()).toEqual([])
    expect(plugin.store.listNotifications()).toEqual([])

    // A later normal child turn is not part of the original delegation. The
    // durable first result is immutable and the pass must not revisit it.
    events.push(
      event(44, 'user/message', { id: 'later-user-message', content: [{ type: 'text', text: 'Do something else.' }] }),
      event(45, 'turn/start', { turn: 18 }),
      event(46, 'assistant/message', { turn: 18, message: { content: [{ type: 'text', text: 'A later result.' }] } }),
      event(47, 'turn/end', { turn: 18, reason: { kind: 'completed' } }),
    )
    await advanceOnePass()
    expect(plugin.store.getTask('target')!.completionReturn).toEqual(first)
    expect(parent.steer).not.toHaveBeenCalled()
    expect(parent.followup).not.toHaveBeenCalled()
    expect(plugin.store.listEveryWatch()).toEqual([])
  })

  it('uses only the official cold public session query when the child is not live', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const parent = hostAgent('owner')
    const restore = vi.fn()
    const get = vi.fn((id: string) => id === parent.id ? parent : undefined)
    const readSession = vi.fn(async (sessionId: string) => ({
      session: { id: sessionId },
      events: [
        event(60, 'turn/start', { turn: 23 }),
        event(61, 'user/message', { id: 'relay-1', content: [{ type: 'text', text: 'Do the focused work.' }] }),
        event(62, 'assistant/message', { turn: 23, message: { content: [{ type: 'text', text: 'Cold public result.' }] } }),
        event(63, 'turn/end', { turn: 23, reason: { kind: 'completed' } }),
      ],
    }))
    const plugin = await mountedPlugin({
      agents: { get, list: () => [parent], create: restore },
      sessionQuery: { readSession },
    }, false, seedInitialCompletionReturn, { passIntervalMs: PASS_INTERVAL_MS })
    opened.push(plugin)
    get.mockClear()
    restore.mockClear()
    readSession.mockClear()

    await advanceOnePass()
    expect(readSession).toHaveBeenCalledOnce()
    expect(readSession).toHaveBeenCalledWith('session-1')
    expect(restore).not.toHaveBeenCalled()
    expect(plugin.store.getTask('target')!.completionReturn).toMatchObject({
      phase: 'returned', messageSeq: 61, turn: 23, startSeq: 60, endSeq: 63,
      preview: 'Cold public result.',
    })
    expect(parent.steer).not.toHaveBeenCalled()
    expect(parent.followup).not.toHaveBeenCalled()
    expect(plugin.store.listEveryWatch()).toEqual([])
  })

  it('does not inspect child history after the original parent loses read access', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const parent = hostAgent('owner')
    const child = hostAgent('session-1', [
      event(70, 'turn/start', { turn: 31 }),
      event(71, 'user/message', { id: 'relay-1', content: [{ type: 'text', text: 'Do the focused work.' }] }),
      event(72, 'turn/end', { turn: 31, reason: { kind: 'completed' } }),
    ])
    const get = vi.fn((id: string) => id === child.id ? child : id === parent.id ? parent : undefined)
    const readSession = vi.fn()
    const plugin = await mountedPlugin({
      agents: { get, list: () => [parent, child] },
      sessionQuery: { readSession },
    }, false, seedInitialCompletionReturn, { passIntervalMs: PASS_INTERVAL_MS })
    opened.push(plugin)
    const access = plugin.store.getAccess('target')!
    await plugin.store.putAccess({ ...access, ownerSessionId: 'new-owner', ownerEpoch: 1, updatedAt: new Date(T0 + 1_000).toISOString() })
    get.mockClear()

    await advanceOnePass()

    expect(get).not.toHaveBeenCalledWith('session-1')
    expect(readSession).not.toHaveBeenCalled()
    expect(plugin.store.getTask('target')!.completionReturn?.phase).toBe('armed')
    expect(parent.steer).not.toHaveBeenCalled()
    expect(parent.followup).not.toHaveBeenCalled()
  })
})
