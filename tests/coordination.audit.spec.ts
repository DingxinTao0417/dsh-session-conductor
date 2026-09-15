import { describe, expect, it } from 'vitest'
import { Coordinator, type CoordinatorDeps } from '../src/service/coordinator.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

async function fixture() {
  const tables = createInMemoryTables()
  const store = new ConductorStore(tables)
  await store.createTask({ taskId: 't', title: 'task', pinned: false, archived: false,
    controllerSessionId: 'owner', requestedBy: 'user', contextMode: 'empty',
    preparation: 'ready', preparationPhase: 'ready', createdAt: 'now', updatedAt: 'now' })
  await store.putAccess({ taskId: 't', ownerSessionId: 'owner', ownerEpoch: 0,
    observerSessionIds: [], updatedAt: 'now' })
  await store.putBinding({ bindingId: 'b', taskId: 't', hostId: 'local', sessionId: 's',
    version: 1, createdAt: 'now' })
  const calls: unknown[] = []
  const events: SessionEventLike[] = []
  const agent = { id: 's' as SessionId, status: 'idle' as 'idle' | 'running', session: { events, seq: 0 },
    inbox: { nextTurn: [], nextStep: [], hasPending: false,
      remove: () => { calls.push('remove'); return true },
      replace: () => { calls.push('replace'); return true } },
    steer: (message: unknown) => { calls.push(message) },
    followup: (message: unknown) => { calls.push(message) }, cancel: () => {} }
  let nextMessage = 0
  const deps: CoordinatorDeps = { store, agents: { get: () => agent, list: () => [agent],
    create: async () => ({ agent, dispose: async () => {} }) }, createMessage: (text, source) => ({ id: `m${++nextMessage}`, text, source }),
    newTaskId: () => 'new-t', newSessionId: () => 'new-s', newBindingId: () => 'new-b',
    now: () => new Date().toISOString(), defaultCwd: () => undefined }
  return { tables, store, calls, agent, deps, coordinator: new Coordinator(deps) }
}

const send = { operationId: 'op', taskId: 't', callerSessionId: 'owner', text: 'work', mode: 'steer' as const }

describe('dispatch race regressions (T16/T27)', () => {
  it('does not dispatch twice when separate coordinators flush the same operation concurrently', async () => {
    const f = await fixture()
    const blocked = new Coordinator({ ...f.deps, targetTurnConcurrency: 0 })
    await blocked.send(send)
    await Promise.all([f.coordinator.flushPendingDispatches(), new Coordinator(f.deps).flushPendingDispatches()])
    expect(f.calls).toHaveLength(1)
  })

  it.each(['transfer', 'detach', 'binding'] as const)('pins implicit authority before a pending send: %s', async change => {
    const f = await fixture()
    await new Coordinator({ ...f.deps, targetTurnConcurrency: 0 }).send(send)
    if (change === 'binding') {
      await f.store.putBinding({ ...f.store.getBinding('b')!, bindingId: 'b2', version: 2, sessionId: 's2' })
    } else {
      await f.store.putAccess({ ...f.store.getAccess('t')!,
        ...(change === 'transfer' ? { ownerSessionId: 'new-owner', ownerEpoch: 1 } : { detachedAt: 'later' }) })
    }
    await f.coordinator.flushPendingDispatches()
    expect(f.calls).toHaveLength(0)
    expect(f.store.getOperation('op')?.delivery).toBe('failed')
  })

  it('rechecks control after the dispatching record has been persisted', async () => {
    const f = await fixture()
    const original = f.tables.operations.update.bind(f.tables.operations)
    f.tables.operations.update = async (key, transform) => {
      const result = await original(key, transform)
      if (result.delivery === 'dispatching') {
        await f.store.putAccess({ ...f.store.getAccess('t')!, ownerSessionId: 'new-owner', ownerEpoch: 1 })
      }
      return result
    }
    await expect(f.coordinator.send(send)).rejects.toThrow(/control changed/)
    expect(f.calls).toHaveLength(0)
    expect(f.store.getOperation('op')?.delivery).toBe('failed')
  })

  it.each(['edit', 'withdraw'] as const)('rechecks control before a queue %s after recording its operation', async action => {
    const f = await fixture()
    const original = f.tables.operations.put.bind(f.tables.operations)
    f.tables.operations.put = async (key, record) => {
      await original(key, record)
      await f.store.putAccess({ ...f.store.getAccess('t')!, ownerSessionId: 'new-owner', ownerEpoch: 1 })
    }
    await expect(f.coordinator.queue({ operationId: 'q', taskId: 't', callerSessionId: 'owner', action,
      messageId: 'old-message', text: 'replacement' })).rejects.toThrow(/control changed/)
    expect(f.calls).toHaveLength(0)
  })

  it('keeps interrupt-and-send text if a new turn starts while the send is being persisted', async () => {
    const f = await fixture()
    const original = f.tables.operations.put.bind(f.tables.operations)
    f.tables.operations.put = async (key, record) => {
      await original(key, record)
      f.agent.session.events.push({ type: 'turn/start', seq: 1, data: { turn: 2 } })
    }
    const result = await f.coordinator.stop({ operationId: 'op', taskId: 't', callerSessionId: 'owner', text: 'new work' })
    expect(result.sent).toBe(false)
    expect(result.keptText).toBe(true)
    expect(f.calls).toHaveLength(0)
  })

  it('keeps an uncertain Host dispatch unknown and does not retry it', async () => {
    const f = await fixture()
    f.agent.steer = message => { f.calls.push(message); throw new Error('Host receipt lost') }
    await expect(f.coordinator.send(send)).rejects.toThrow(/unknown|confirm/i)
    expect(f.store.getOperation('op')?.delivery).toBe('unknown')
    await expect(f.coordinator.send(send)).rejects.toThrow(/unknown|confirm/i)
    expect(f.calls).toHaveLength(1)
  })

  it('does not replace an existing session that is currently offline during preparation recovery', async () => {
    const f = await fixture()
    await f.store.beginOperation({ operationId: 'origin', kind: 'create', taskId: 't', params: { title: 'task' } })
    await f.store.updateTask('t', current => ({ ...current, preparation: 'failed' }))
    let created = 0
    const coordinator = new Coordinator({ ...f.deps, agents: { ...f.deps.agents, get: () => undefined,
      create: async () => { created += 1; return { agent: f.agent, dispose: async () => {} } } } })
    const result = await coordinator.resumePreparation({ taskId: 't', callerSessionId: 'owner' })
    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/restore that session/)
    expect(created).toBe(0)
    expect(f.store.getTask('t')?.currentBindingId).toBe('b')
  })
})

describe('flush and stop boundary (T10/T27)', () => {
  it('rechecks an automatic grant after persisting dispatch state', async () => {
    const f = await fixture()
    let enabled = true
    const original = f.tables.operations.update.bind(f.tables.operations)
    f.tables.operations.update = async (key, transform) => {
      const record = await original(key, transform)
      if (record.delivery === 'dispatching') enabled = false
      return record
    }
    const coordinator = new Coordinator({ ...f.deps, dispatchAdmission: () => enabled ? undefined : 'GRANT_REVOKED: rule was disabled' })
    await expect(coordinator.send(send)).rejects.toThrow(/GRANT_REVOKED/)
    expect(f.calls).toHaveLength(0)
  })

  it('keeps accepted-but-unflushed delivery unknown', async () => {
    const f = await fixture()
    const coordinator = new Coordinator({ ...f.deps, flushSession: async () => { throw new Error('flush failed') } })
    await expect(coordinator.send(send)).rejects.toThrow(/unknown|confirm/i)
    expect(f.store.getOperation('op')?.delivery).toBe('unknown')
    expect(f.calls).toHaveLength(1)
  })

  it('detects the current binding moving while waiting for an expected turn to end', async () => {
    const f = await fixture()
    f.agent.status = 'running'
    f.agent.session.events.push({ type: 'turn/start', seq: 1, data: { turn: 1 } })
    const coordinator = new Coordinator({ ...f.deps, sleep: async () => {
      await f.store.putBinding({ ...f.store.getBinding('b')!, bindingId: 'b2', version: 2, sessionId: 's2' })
      f.agent.session.events.push({ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
      f.agent.status = 'idle'
    } })
    const result = await coordinator.stop({ operationId: 'op', taskId: 't', callerSessionId: 'owner', text: 'continue' })
    expect(result.outcome).toBe('kept')
    expect(result.reason).toMatch(/binding version moved/)
    expect(f.calls).toHaveLength(0)
  })
})

describe('store durability races (T27)', () => {
  it('does not commit two different owners at the same next epoch', async () => {
    const f = await fixture()
    const previous = f.store.getAccess('t')!
    const results = await Promise.allSettled([
      f.store.putAccess({ ...previous, ownerSessionId: 'owner-two', ownerEpoch: 1 }),
      f.store.putAccess({ ...previous, ownerSessionId: 'owner-three', ownerEpoch: 1 }),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(f.store.getAccess('t')?.ownerSessionId).toBe('owner-two')
  })

  it('claims an operation once even when persistence yields before becoming visible', async () => {
    const f = await fixture()
    const original = f.tables.operations.put.bind(f.tables.operations)
    f.tables.operations.put = async (key, record) => { await Promise.resolve(); await original(key, record) }
    const results = await Promise.all([f.store.beginOperation({ operationId: 'op', kind: 'send', params: { text: 'a' } }),
      new ConductorStore(f.tables).beginOperation({ operationId: 'op', kind: 'send', params: { text: 'b' } })])
    expect(results.map(result => result.kind)).toEqual(['accepted', 'conflict'])
    expect(f.store.getOperation('op')?.params).toEqual({ text: 'a' })
  })

  it('keeps the current binding active if persisting the new task pointer fails', async () => {
    const f = await fixture()
    f.tables.tasks.failNextWrites(1)
    await expect(f.store.putBinding({ ...f.store.getBinding('b')!, bindingId: 'b2', version: 2 })).rejects.toThrow()
    expect(f.store.getTask('t')?.currentBindingId).toBe('b')
    expect(f.store.getBinding('b')?.retiredAt).toBeUndefined()
  })

  it('preserves task changes made while a new binding is being stored', async () => {
    const f = await fixture()
    const original = f.tables.bindings.put.bind(f.tables.bindings)
    f.tables.bindings.put = async (key, record) => {
      await original(key, record)
      if (key === 'b2') await f.store.updateTask('t', current => ({ ...current, title: 'renamed' }))
    }
    await f.store.putBinding({ ...f.store.getBinding('b')!, bindingId: 'b2', version: 2 })
    expect(f.store.getTask('t')?.title).toBe('renamed')
  })
})

describe('preparation recovery identity (T02/T27)', () => {
  it.each(['create', 'fork'] as const)('resumes an existing %s binding with its original operation identity', async kind => {
    const f = await fixture()
    await f.store.beginOperation({ operationId: 'origin', kind, taskId: 't',
      params: { controllerSessionId: 'owner', sourceTaskId: 'source', title: 'task' },
      dispatchGuard: { ownerSessionId: 'owner', ownerEpoch: 0, bindingVersion: 1 } })
    await f.store.markDelivery('origin', 'failed', 'preparation_failed')
    await f.store.updateTask('t', current => ({ ...current, preparation: 'failed' }))
    const result = await f.coordinator.resumePreparation({ taskId: 't', callerSessionId: 'owner' })
    expect(result.preparation, result.failureReason).toBe('ready')
    expect(result.taskId).toBe('t')
    expect(result.sessionId).toBe('s')
    expect(result.operationId).toBe('origin')
    expect(f.store.listTasks()).toHaveLength(1)
    expect(f.store.getOperation('origin')?.delivery).toBe('accepted')
  })
})
