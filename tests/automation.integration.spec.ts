import { describe, expect, it, vi } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import type { ConductorStore } from '../src/store/repository.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

async function seedTask(store: ConductorStore, taskId: string, sessionId: string): Promise<void> {
  const at = new Date().toISOString()
  await store.createTask({
    taskId, title: taskId, controllerSessionId: 'owner', requestedBy: 'user', pinned: false,
    archived: false, contextMode: 'empty', preparation: 'ready', preparationPhase: 'ready', createdAt: at, updatedAt: at,
  })
  await store.putAccess({ taskId, ownerSessionId: 'owner', ownerEpoch: 0, observerSessionIds: [], updatedAt: at })
  await store.putBinding({ bindingId: `binding-${taskId}`, taskId, sessionId, hostId: 'local', version: 1, createdAt: at })
}

function hostAgent(id: string, events: SessionEventLike[] = []) {
  return {
    id, status: 'idle', session: { events, seq: events.length - 1 },
    inbox: { hasPending: false, nextTurn: [], nextStep: [], remove: () => undefined, replace: () => undefined },
    steer: vi.fn(), followup: vi.fn(), cancel: vi.fn(),
  }
}

describe('production automation entry', () => {
  it('actually delivers a missed occurrence inside its saved grace window and records it once', async () => {
    const target = hostAgent('session-1')
    const stamp = new Date(Date.now() - 1000).toISOString()
    const plugin = await mountedPlugin({ sessions: { flush: async () => true }, agents: { get: () => target, list: () => [target] } }, false, async store => {
      await seedTask(store, 'target', 'session-1')
      await store.putSchedule({
        scheduleId: 'catch-up', title: 'catch up once', kind: 'once', timezone: 'UTC', action: 'send',
        targetTaskId: 'target', instruction: 'run the saved check', authorizedBy: 'owner', status: 'active',
        nextAt: stamp, maxRuns: 1, graceMs: 60_000, runs: [], createdAt: stamp, updatedAt: stamp,
      })
    })
    try {
      for (let step = 0; step < 100; step += 1) await Promise.resolve()
      expect(target.steer).toHaveBeenCalledTimes(1)
      expect(plugin.store.getSchedule('catch-up')?.runs).toEqual([
        expect.objectContaining({ scheduledFor: stamp, outcome: 'ran', reason: expect.stringMatching(/dispatched as/) }),
      ])
      await plugin.call('conductor_schedule', { action: 'tick', scheduleId: 'catch-up' })
      expect(target.steer).toHaveBeenCalledTimes(1)
      expect(plugin.store.getSchedule('catch-up')?.runs).toHaveLength(1)
    } finally { await plugin.close() }
  })

  it('does not execute a new rule from old completed history and pins later events to their session sequence', async () => {
    const events: SessionEventLike[] = [
      { seq: 0, type: 'turn/start', time: Date.now() - 20_000, data: { turn: 1 } },
      { seq: 1, type: 'turn/end', time: Date.now() - 10_000, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const source = hostAgent('session-1', events)
    const target = hostAgent('session-2')
    const agents = new Map([[source.id, source], [target.id, target]])
    const plugin = await mountedPlugin({ sessions: { flush: async () => true }, agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] } })
    try {
      await seedTask(plugin.store, 'destination', 'session-2')
      await plugin.call('conductor_rule', {
        action: 'save', ruleId: 'future-rule', sourceTaskId: 'target', targetTaskId: 'destination',
        trigger: 'turn_completed', delivery: 'send', instruction: 'continue after the next completion',
      })
      await plugin.call('conductor_rule', { action: 'evaluate', ruleId: 'future-rule' })
      expect(target.steer).not.toHaveBeenCalled()
      events.push(
        { seq: 20, type: 'turn/start', time: Date.now() + 1, data: { turn: 2 } },
        { seq: 30, type: 'turn/end', time: Date.now() + 2, data: { turn: 2, reason: { kind: 'completed' } } },
      )
      const result = await plugin.call('conductor_rule', { action: 'evaluate', ruleId: 'future-rule' })
      expect(result.refusals).toEqual([])
      expect(target.steer).toHaveBeenCalledTimes(1)
      expect(plugin.store.getRule('future-rule')?.firings[0]?.sourceEventId).toContain('session-1#30')
      await plugin.call('conductor_rule', { action: 'evaluate', ruleId: 'future-rule' })
      expect(target.steer).toHaveBeenCalledTimes(1)
    } finally { await plugin.close() }
  })

  it('never turns a report-only completion into an automatic rule dispatch', async () => {
    const events: SessionEventLike[] = []
    const source = hostAgent('session-1', events)
    const target = hostAgent('session-2')
    const agents = new Map([[source.id, source], [target.id, target]])
    const plugin = await mountedPlugin({ sessions: { flush: async () => true }, agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] } })
    try {
      await seedTask(plugin.store, 'destination', 'session-2')
      await plugin.call('conductor_rule', {
        action: 'save', ruleId: 'report-rule', sourceTaskId: 'target', targetTaskId: 'destination',
        trigger: 'turn_completed', delivery: 'send', instruction: 'continue on completion',
      })
      const at = Date.now() + 10
      events.push(
        { seq: 0, type: 'user/message', time: at, data: { source: { kind: 'plugin', form: 'notice', plugin: 'dsh-session-conductor' } } },
        { seq: 1, type: 'turn/start', time: at, data: { turn: 1 } },
        { seq: 2, type: 'turn/end', time: at + 1, data: { turn: 1, reason: { kind: 'completed' } } },
      )
      await plugin.call('conductor_rule', { action: 'evaluate', ruleId: 'report-rule' })
      expect(target.steer).not.toHaveBeenCalled()
    } finally { await plugin.close() }
  })

  it('keeps an uncertain Host acceptance paused for reconciliation instead of recording a failed task', async () => {
    const target = hostAgent('session-1')
    const plugin = await mountedPlugin({ sessions: { flush: async () => false }, agents: { get: () => target, list: () => [target] } })
    try {
      const stamp = new Date(Date.now() - 1000).toISOString()
      await plugin.store.putSchedule({
        scheduleId: 'uncertain', title: 'uncertain', kind: 'once', timezone: 'UTC', action: 'send',
        targetTaskId: 'target', instruction: 'run the check', authorizedBy: 'owner', status: 'active',
        nextAt: stamp, maxRuns: 1, runs: [], createdAt: stamp, updatedAt: stamp,
      })
      await plugin.call('conductor_schedule', { action: 'tick', scheduleId: 'uncertain' })
      expect(target.steer).toHaveBeenCalledTimes(1)
      expect(plugin.store.getSchedule('uncertain')).toMatchObject({ status: 'paused', runs: [
        expect.objectContaining({ outcome: 'refused', reason: expect.stringMatching(/unknown.*reconcil/i) }),
      ] })
      await plugin.call('conductor_schedule', { action: 'tick', scheduleId: 'uncertain' })
      expect(target.steer).toHaveBeenCalledTimes(1)
    } finally { await plugin.close() }
  })

  it('suppresses report-only completions so reciprocal watches cannot wake each other', async () => {
    const events: SessionEventLike[] = []
    const target = hostAgent('session-1', events)
    const controller = hostAgent('owner')
    const agents = new Map([[target.id, target], [controller.id, controller]])
    const plugin = await mountedPlugin({ agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] } })
    try {
      await plugin.call('conductor_watch', { action: 'start', taskId: 'target' })
      events.push(
        { seq: 0, type: 'user/message', time: Date.now(), data: { source: { kind: 'plugin', form: 'notice', plugin: 'dsh-session-conductor' } } },
        { seq: 1, type: 'turn/start', time: Date.now(), data: { turn: 1 } },
        { seq: 2, type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
      )
      await plugin.call('conductor_watch', { action: 'report' })
      expect(controller.steer).not.toHaveBeenCalled()
    } finally { await plugin.close() }
  })

  it('reports one unchanged disconnect once across later monitoring passes', async () => {
    vi.useFakeTimers()
    const controller = hostAgent('owner')
    const plugin = await mountedPlugin({ agents: { get: (id: string) => id === 'owner' ? controller : undefined, list: () => [controller] } })
    try {
      await plugin.call('conductor_watch', { action: 'start', taskId: 'target' })
      await plugin.call('conductor_watch', { action: 'report' })
      expect(controller.steer).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 5000)
      await plugin.call('conductor_watch', { action: 'report' })
      expect(controller.steer).toHaveBeenCalledTimes(1)
    } finally { await plugin.close(); vi.useRealTimers() }
  })

  it('keeps undelivered facts unread while the controller is offline and reports them after it reconnects', async () => {
    const events: SessionEventLike[] = []
    const target = hostAgent('session-1', events)
    const agents = new Map([[target.id, target]])
    const plugin = await mountedPlugin({ agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] } })
    try {
      await plugin.call('conductor_watch', { action: 'start', taskId: 'target' })
      const before = plugin.store.getWatch('owner::target')?.cursor
      events.push({ seq: 0, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      await plugin.call('conductor_watch', { action: 'report' })
      expect(plugin.store.getWatch('owner::target')?.cursor).toBe(before)
      expect(plugin.store.getWatch('owner::target')?.deliveredEventIds).toEqual([])
      const controller = hostAgent('owner')
      agents.set(controller.id, controller)
      await plugin.call('conductor_watch', { action: 'report' })
      expect(controller.steer).toHaveBeenCalledTimes(1)
    } finally { await plugin.close() }
  })
})
