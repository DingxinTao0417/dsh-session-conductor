import { describe, expect, it } from 'vitest'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { NotificationRecord, ScheduleRecord, TaskRecord, WatchRecord } from '../src/store/schema.ts'

/** Fixed clock so ordering assertions do not depend on wall time. */
function clockFrom(startMs = Date.parse('2026-09-13T00:00:00.000Z')) {
  let current = startMs
  return () => new Date((current += 1000)).toISOString()
}

/** A complete, valid task record with the members a test cares about overridden. */
function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-1',
    title: 'Design the interface',
    pinned: false,
    archived: false,
    controllerSessionId: 'session-controller',
    requestedBy: 'user',
    contextMode: 'brief',
    preparation: 'ready',
    preparationPhase: 'ready',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  }
}

/** A store over fresh in-memory tables with a deterministic clock. */
function makeStore() {
  const tables = createInMemoryTables()
  return { tables, store: new ConductorStore(tables, clockFrom()) }
}

describe('task persistence (PRD §三.5 Task)', () => {
  it('stores and reads a task back unchanged', async () => {
    const { store } = makeStore()
    const record = task()
    await store.createTask(record)
    expect(store.getTask('task-1')).toEqual(record)
  })

  it('refuses to silently replace a task that already exists', async () => {
    const { store } = makeStore()
    await store.createTask(task())
    await expect(store.createTask(task({ title: 'different' }))).rejects.toThrow(/already exists/)
    expect(store.getTask('task-1')?.title).toBe('Design the interface')
  })

  it('filters by the members the store knows about', async () => {
    const { store } = makeStore()
    await store.createTask(task({ taskId: 'a', groupId: 'g1', pinned: true }))
    await store.createTask(task({ taskId: 'b', archived: true, preparation: 'failed' }))
    await store.createTask(task({ taskId: 'c', controllerSessionId: 'other' }))

    expect(store.listTasks().map(t => t.taskId)).toHaveLength(3)
    expect(store.listTasks({ controllerSessionId: 'session-controller' }).map(t => t.taskId).sort()).toEqual(['a', 'b'])
    expect(store.listTasks({ archived: true }).map(t => t.taskId)).toEqual(['b'])
    expect(store.listTasks({ pinned: true }).map(t => t.taskId)).toEqual(['a'])
    expect(store.listTasks({ groupId: 'g1' }).map(t => t.taskId)).toEqual(['a'])
    expect(store.listTasks({ preparation: 'failed' }).map(t => t.taskId)).toEqual(['b'])
  })

  it('lists newest first', async () => {
    const { store } = makeStore()
    await store.createTask(task({ taskId: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }))
    await store.createTask(task({ taskId: 'new', updatedAt: '2026-06-01T00:00:00.000Z' }))
    expect(store.listTasks().map(t => t.taskId)).toEqual(['new', 'old'])
  })

  it('stamps updatedAt from the injected clock on every task update', async () => {
    const { store } = makeStore()
    await store.createTask(task())
    const updated = await store.updateTask('task-1', current => ({ ...current, title: 'renamed' }))
    expect(updated.title).toBe('renamed')
    expect(updated.updatedAt).not.toBe('2026-09-13T00:00:00.000Z')
  })
})

describe('bindings and the session chain (PRD §二.10.2)', () => {
  it('points the task at the new binding and retires the previous one', async () => {
    const { store } = makeStore()
    await store.createTask(task())
    await store.putBinding({
      bindingId: 'b1', taskId: 'task-1', hostId: 'local', sessionId: 'session-1',
      version: 1, createdAt: '2026-09-13T00:01:00.000Z',
    })
    await store.putBinding({
      bindingId: 'b2', taskId: 'task-1', hostId: 'local', sessionId: 'session-2',
      version: 2, predecessorBindingId: 'b1', createdAt: '2026-09-13T00:02:00.000Z',
    })

    expect(store.getTask('task-1')?.currentBindingId).toBe('b2')
    // The chain is retained, and the retired half is marked rather than deleted.
    expect(store.listBindings('task-1').map(b => b.bindingId)).toEqual(['b1', 'b2'])
    expect(store.getBinding('b1')?.retiredAt).toBeDefined()
    expect(store.getBinding('b2')?.retiredAt).toBeUndefined()
  })

  it('refuses a binding whose task does not exist', async () => {
    const { store } = makeStore()
    await expect(store.putBinding({
      bindingId: 'b1', taskId: 'missing', hostId: 'local', sessionId: 's',
      version: 1, createdAt: '2026-09-13T00:01:00.000Z',
    })).rejects.toThrow(/unknown task/)
  })
})

describe('operation idempotency (PRD §四.1)', () => {
  it('accepts a fresh operation and persists it before anything is dispatched', async () => {
    const { store } = makeStore()
    const result = await store.beginOperation({ operationId: 'op-1', kind: 'send', params: { text: 'go' } })
    expect(result.kind).toBe('accepted')
    expect(store.getOperation('op-1')?.delivery).toBe('prepared')
  })

  it('replays the same id with the same parameters instead of operating twice', async () => {
    const { store } = makeStore()
    const first = await store.beginOperation({ operationId: 'op-1', kind: 'send', params: { text: 'go' } })
    const second = await store.beginOperation({ operationId: 'op-1', kind: 'send', params: { text: 'go' } })
    expect(first.kind).toBe('accepted')
    expect(second.kind).toBe('replay')
    if (first.kind !== 'accepted' || second.kind !== 'replay') throw new Error('unreachable')
    expect(second.record.createdAt).toBe(first.record.createdAt)
  })

  it('reports a conflict when one id is reused for different parameters', async () => {
    const { store } = makeStore()
    await store.beginOperation({ operationId: 'op-1', kind: 'send', params: { text: 'go' } })
    const conflict = await store.beginOperation({ operationId: 'op-1', kind: 'send', params: { text: 'stop' } })
    expect(conflict.kind).toBe('conflict')
    if (conflict.kind !== 'conflict') throw new Error('unreachable')
    expect(conflict.reason).toMatch(/different parameters/)
  })

  it('treats two sends of identical text under different ids as two operations', async () => {
    const { store } = makeStore()
    const first = await store.beginOperation({ operationId: 'op-1', kind: 'send', params: { text: 'go' } })
    const second = await store.beginOperation({ operationId: 'op-2', kind: 'send', params: { text: 'go' } })
    expect(first.kind).toBe('accepted')
    expect(second.kind).toBe('accepted')
  })

  it('never replays a withdrawn operation, so a restart cannot resurrect it', async () => {
    const { store } = makeStore()
    await store.beginOperation({ operationId: 'op-1', kind: 'send', params: { text: 'go' } })
    await store.withdrawOperation('op-1')
    const again = await store.beginOperation({ operationId: 'op-1', kind: 'send', params: { text: 'go' } })
    expect(again.kind).toBe('conflict')
    expect(store.getOperation('op-1')?.withdrawn).toBe(true)
  })

  it('walks the delivery pipeline the way the PRD orders it', async () => {
    const { store } = makeStore()
    await store.beginOperation({ operationId: 'op-1', kind: 'send', params: {} })
    await store.markDelivery('op-1', 'dispatching')
    await store.markDelivery('op-1', 'accepted', 'host_accepted')
    await store.markDelivery('op-1', 'consumed')
    const record = store.getOperation('op-1')
    expect(record?.delivery).toBe('consumed')
    expect(record?.phase).toBe('host_accepted')
  })
})

describe('recovery classification (PRD §四.1 crash windows)', () => {
  it('continues what never dispatched, reconciles the unconfirmed, ignores the settled', async () => {
    const { store } = makeStore()
    await store.beginOperation({ operationId: 'prepared', kind: 'send', params: {} })
    await store.beginOperation({ operationId: 'inflight', kind: 'send', params: {} })
    await store.markDelivery('inflight', 'dispatching')
    await store.beginOperation({ operationId: 'unknown', kind: 'send', params: {} })
    await store.markDelivery('unknown', 'dispatching')
    await store.markDelivery('unknown', 'unknown')
    await store.beginOperation({ operationId: 'done', kind: 'send', params: {} })
    await store.markDelivery('done', 'dispatching')
    await store.markDelivery('done', 'accepted')

    const recoverable = store.listRecoverableOperations()
    expect(recoverable.map(entry => [entry.record.operationId, entry.action])).toEqual([
      ['prepared', 'continue'],
      ['inflight', 'reconcile'],
      ['unknown', 'reconcile'],
    ])
    expect(store.unresolvedOperationCount).toBe(3)
  })

  it('keeps creation order so recovery replays the queue in the order it was built', async () => {
    const { store } = makeStore()
    await store.beginOperation({ operationId: 'first', kind: 'send', params: {} })
    await store.beginOperation({ operationId: 'second', kind: 'send', params: {} })
    await store.beginOperation({ operationId: 'third', kind: 'send', params: {} })
    expect(store.listRecoverableOperations().map(e => e.record.operationId)).toEqual(['first', 'second', 'third'])
  })
})

describe('fault injection (PRD §五.2 crash windows)', () => {
  it('leaves memory untouched when a write is rejected, so reads never diverge from the medium', async () => {
    const { store, tables } = makeStore()
    await store.createTask(task())
    tables.tasks.failNextWrites(1)

    await expect(store.updateTask('task-1', current => ({ ...current, title: 'should not land' }))).rejects.toThrow(/injected/)
    expect(store.getTask('task-1')?.title).toBe('Design the interface')
  })

  it('does not leave a half-claimed operation behind when the claim write fails', async () => {
    const { store, tables } = makeStore()
    tables.operations.failNextWrites(1)
    await expect(store.beginOperation({ operationId: 'op-1', kind: 'send', params: {} })).rejects.toThrow(/injected/)
    expect(store.getOperation('op-1')).toBeUndefined()

    // A retry after the transient failure behaves like a first attempt.
    const retried = await store.beginOperation({ operationId: 'op-1', kind: 'send', params: {} })
    expect(retried.kind).toBe('accepted')
  })

  it('reports how many writes a table attempted, so a test can prove the ordering it claims', async () => {
    const { store, tables } = makeStore()
    await store.createTask(task())
    await store.putBinding({
      bindingId: 'b1', taskId: 'task-1', hostId: 'local', sessionId: 's',
      version: 1, createdAt: '2026-09-13T00:01:00.000Z',
    })
    // One task write for create, one binding write, then the task pointer update.
    expect(tables.tasks.writeAttempts).toBe(2)
    expect(tables.bindings.writeAttempts).toBe(1)
  })
})

describe('schedule persistence (PRD §二.11)', () => {
  /** A complete, valid schedule record. */
  function schedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
    return {
      scheduleId: 'schedule-1',
      title: 'Nightly review',
      kind: 'calendar',
      timezone: 'Asia/Shanghai',
      nextAt: '2026-09-14T01:00:00.000Z',
      wall: { hour: 9, minute: 0 },
      action: 'inspect',
      status: 'active',
      authorizedBy: 'user',
      runs: [],
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
      ...over,
    }
  }

  it('round-trips a schedule, keeping the zone beside the UTC instant', async () => {
    const { store } = makeStore()
    await store.putSchedule(schedule())
    const read = store.getSchedule('schedule-1')
    expect(read?.timezone).toBe('Asia/Shanghai')
    expect(read?.wall).toEqual({ hour: 9, minute: 0 })
    expect(read?.nextAt).toBe('2026-09-14T01:00:00.000Z')
  })

  it('lists newest first and breaks equal timestamps by id, so a preview is reproducible', async () => {
    const { store } = makeStore()
    const same = '2026-09-13T00:00:00.000Z'
    await store.putSchedule(schedule({ scheduleId: 'b', createdAt: same }))
    await store.putSchedule(schedule({ scheduleId: 'a', createdAt: same }))
    await store.putSchedule(schedule({ scheduleId: 'new', createdAt: '2026-09-20T00:00:00.000Z' }))
    expect(store.listSchedules().map(s => s.scheduleId)).toEqual(['new', 'a', 'b'])
  })

  it('filters by status and target task', async () => {
    const { store } = makeStore()
    await store.putSchedule(schedule({ scheduleId: 'active' }))
    await store.putSchedule(schedule({ scheduleId: 'draft', status: 'draft' }))
    await store.putSchedule(schedule({ scheduleId: 'bound', targetTaskId: 'task-9' }))
    expect(store.listSchedules({ status: 'draft' }).map(s => s.scheduleId)).toEqual(['draft'])
    expect(store.listSchedules({ targetTaskId: 'task-9' }).map(s => s.scheduleId)).toEqual(['bound'])
  })

  it('records the run and advances the instant in one write, leaving no window where a firing is unrecorded', async () => {
    const { store, tables } = makeStore()
    await store.putSchedule(schedule())
    const before = tables.schedules.writeAttempts

    const next = await store.updateSchedule('schedule-1', current => ({
      ...current,
      nextAt: '2026-09-15T01:00:00.000Z',
      runs: [...current.runs, { scheduledFor: current.nextAt, ranAt: '2026-09-14T01:00:00.000Z', outcome: 'ran' }],
    }))

    expect(tables.schedules.writeAttempts - before).toBe(1)
    expect(next.runs).toHaveLength(1)
    expect(next.nextAt).toBe('2026-09-15T01:00:00.000Z')
    expect(next.updatedAt).not.toBe('2026-09-13T00:00:00.000Z')
  })

  it('stays put when the update write is rejected, so a failed firing is not silently counted', async () => {
    const { store, tables } = makeStore()
    await store.putSchedule(schedule())
    tables.schedules.failNextWrites(1)

    await expect(store.updateSchedule('schedule-1', current => ({
      ...current,
      runs: [...current.runs, { scheduledFor: current.nextAt, outcome: 'ran' }],
    }))).rejects.toThrow(/injected/)
    expect(store.getSchedule('schedule-1')?.runs).toEqual([])
  })
})

/** A delivered report for unread tests. */
function notice(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    notificationId: 'n1',
    controllerSessionId: 'session-controller',
    taskId: 'task-1',
    sourceEventId: 'evt-1',
    summary: 'turn ended',
    delivery: 'accepted',
    withdrawn: false,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  }
}

describe('acknowledging unread reports (PRD §二.1 未读数量)', () => {
  it('marks only this controller\'s unacked reports and leaves the watch cursor alone', async () => {
    const { store } = makeStore()
    await store.putNotification(notice())
    await store.putNotification(notice({
      notificationId: 'n-other',
      controllerSessionId: 'session-other',
      sourceEventId: 'evt-other',
    }))
    await store.putNotification(notice({
      notificationId: 'n-withdrawn',
      sourceEventId: 'evt-w',
      withdrawn: true,
    }))
    const watch: WatchRecord = {
      controllerSessionId: 'session-controller',
      taskId: 'task-1',
      cursor: '42',
      deliveredEventIds: ['evt-1'],
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    }
    await store.putWatch('session-controller::task-1', watch)

    const marked = await store.acknowledgeNotifications(
      'session-controller',
      'task-1',
      '2026-09-13T02:00:00.000Z',
    )
    expect(marked).toBe(1)
    expect(store.getNotification('n1')?.acknowledgedAt).toBe('2026-09-13T02:00:00.000Z')
    expect(store.getNotification('n-other')?.acknowledgedAt).toBeUndefined()
    expect(store.getNotification('n-withdrawn')?.acknowledgedAt).toBeUndefined()
    expect(store.getWatch('session-controller::task-1')).toEqual(watch)

    const again = await store.acknowledgeNotifications(
      'session-controller',
      'task-1',
      '2026-09-13T03:00:00.000Z',
    )
    expect(again).toBe(0)
    expect(store.getNotification('n1')?.acknowledgedAt).toBe('2026-09-13T02:00:00.000Z')
  })
})

describe('watch pending intervention (PRD §三.5 Watch)', () => {
  it('round-trips pendingIntervention and still parses a watch that has none', async () => {
    const { store } = makeStore()
    const base: WatchRecord = {
      controllerSessionId: 'session-controller',
      taskId: 'task-1',
      cursor: '7',
      deliveredEventIds: [],
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    }
    await store.putWatch('session-controller::task-1', base)
    expect(store.getWatch('session-controller::task-1')?.pendingIntervention).toBeUndefined()

    await store.putWatch('session-controller::task-1', {
      ...base,
      pendingIntervention: 'waiting_input',
      updatedAt: '2026-09-13T01:00:00.000Z',
    })
    expect(store.getWatch('session-controller::task-1')?.pendingIntervention).toBe('waiting_input')
  })
})
