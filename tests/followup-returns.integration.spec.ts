import { expect, it, vi } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

it('captures a production send and reconciles its own receipt without any parent execution', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-09-15T12:00:00Z'); vi.setSystemTime(now)
  const events: SessionEventLike[] = []
  const parent = { id: 'owner', status: 'idle', session: { events: [] }, steer: vi.fn(), followup: vi.fn() }
  const child = { id: 'session-1', status: 'idle', session: { events, header: { cwd: 'D:/target' } },
    inbox: { hasPending: false, nextStep: [], nextTurn: [], remove() {}, replace() {} },
    steer: vi.fn(), followup: vi.fn(), cancel: vi.fn() }
  const agents = new Map<string, { id: string }>([[parent.id, parent], [child.id, child]])
  const plugin = await mountedPlugin({
    agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] },
    sessions: { flush: async () => true },
  }, false, undefined, { passIntervalMs: 10 })
  try {
    await plugin.call('conductor_send', { taskId: 'target', text: 'continue the analysis', operationId: 'real-send' })
    const callback = plugin.store.getOperation('real-send')!.completionReturn!
    expect(callback).toMatchObject({ operationId: 'real-send', bindingId: 'binding-1', bindingVersion: 1, phase: 'armed' })
    events.push(
      { seq: 1, time: now, type: 'turn/start', data: { turn: 3 } },
      { seq: 2, time: now, type: 'user/message', data: { id: callback.messageId } },
      { seq: 3, time: now, type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: 'follow-up finished' }] } } },
      { seq: 4, time: now, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(plugin.store.getOperation('real-send')!.completionReturn).toMatchObject({ phase: 'returned', preview: 'follow-up finished' })
    expect(plugin.store.getTask('target')!.completionReturn).toBeUndefined()
    expect(parent.steer).not.toHaveBeenCalled(); expect(parent.followup).not.toHaveBeenCalled()
    expect(plugin.store.listEveryWatch()).toEqual([]); expect(plugin.store.listNotifications()).toEqual([])
  } finally { await plugin.close(); vi.useRealTimers() }
})
