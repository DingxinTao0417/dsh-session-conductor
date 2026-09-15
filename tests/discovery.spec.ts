import { describe, expect, it } from 'vitest'
import { listCandidates, type SessionRecordLike } from '../src/service/discovery.ts'
import { Coordinator, type CoordinatorDeps } from '../src/service/coordinator.ts'
import { dueDecision } from '../src/service/schedule.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** A Host session record with the fields discovery reads. */
function record(id: string, over: Partial<SessionRecordLike['header']> = {}, live = true, persisted = true): SessionRecordLike {
  return { header: { id, createdAt: Date.parse('2026-09-13T00:00:00.000Z'), ...over }, live, persisted }
}

describe('candidate discovery (PRD §二.5)', () => {
  it('returns selection metadata and nothing from a session log', async () => {
    const listed = await listCandidates({
      sessionQuery: { listSessions: async () => [record('session-a', { cwd: 'D:\\work' })] },
      managed: { managedBy: () => undefined },
    })
    const found = listed.candidates
    expect(found).toHaveLength(1)
    expect(Object.keys(found[0] ?? {}).sort()).toEqual([
      'connection', 'connectionReason', 'createdAt', 'directory', 'live', 'managed',
      'persisted', 'sessionId', 'unrecoverable',
    ])
    // No registry was reachable, so no row claims to know whether the session is archived.
    expect(listed.archive).toBeUndefined()
  })

  it('marks a session the Host archived outside the conductor', async () => {
    const listed = await listCandidates({
      sessionQuery: { listSessions: async () => [record('session-a'), record('session-b')] },
      managed: { managedBy: () => undefined },
      archivedSessions: () => ({ state: 'published', sessionIds: ['session-b'] }),
    })
    expect(listed.archive).toEqual({ state: 'published', sessionIds: ['session-b'] })
    // The list keeps its own order (newest first, id as tiebreaker) — the archive set is a fact about a
    // session, not a sort key.
    expect(listed.candidates.map(c => [c.sessionId, c.externallyArchived])).toEqual([
      ['session-a', false],
      ['session-b', true],
    ])
  })

  it('leaves the archive flag off entirely when the set could not be read', async () => {
    const listed = await listCandidates({
      sessionQuery: { listSessions: async () => [record('session-a')] },
      managed: { managedBy: () => undefined },
      archivedSessions: () => ({
        state: 'unreadable',
        reason: 'workspace registry is not started yet',
      }),
    })
    // "Cannot tell" must not be rendered as "not archived": the row has no field at all, and the
    // caller gets the Host's own reason to show.
    expect(listed.candidates[0]?.externallyArchived).toBeUndefined()
    expect(Object.keys(listed.candidates[0] ?? {})).not.toContain('externallyArchived')
    expect(listed.archive).toEqual({ state: 'unreadable', reason: 'workspace registry is not started yet' })
  })

  it('reports the absent case as absent rather than as an empty archive set', async () => {
    const listed = await listCandidates({
      sessionQuery: { listSessions: async () => [record('session-a')] },
      managed: { managedBy: () => undefined },
      archivedSessions: () => ({ state: 'absent', reason: 'no archivedSessionIds on this registry' }),
    })
    expect(listed.archive?.state).toBe('absent')
    expect(listed.candidates[0]?.externallyArchived).toBeUndefined()
  })

  it('reads the archive set once per call, not once per candidate', async () => {
    let reads = 0
    await listCandidates({
      sessionQuery: { listSessions: async () => [record('a'), record('b'), record('c')] },
      managed: { managedBy: () => undefined },
      archivedSessions: () => { reads += 1; return { state: 'published', sessionIds: [] } },
    })
    // The Host installs a new array on every change, so a per-row read would be both pointless and
    // able to answer differently inside one list.
    expect(reads).toBe(1)
  })

  it('hides sessions the conductor already manages unless asked', async () => {
    const deps = {
      sessionQuery: { listSessions: async () => [record('session-a'), record('session-b')] },
      managed: { managedBy: (id: string) => (id === 'session-a' ? 'task-1' : undefined) },
    }
    expect((await listCandidates(deps)).candidates.map(c => c.sessionId)).toEqual(['session-b'])

    const included = (await listCandidates(deps, { includeManaged: true })).candidates
    expect(included.map(c => c.sessionId).sort()).toEqual(['session-a', 'session-b'])
    expect(included.find(c => c.sessionId === 'session-a')?.taskId).toBe('task-1')
  })

  it('narrows by directory, liveness and a text query', async () => {
    const deps = {
      sessionQuery: {
        listSessions: async () => [
          record('session-alpha', { cwd: 'D:\\work\\alpha' }),
          record('session-beta', { cwd: 'D:\\other' }, false),
          record('session-gamma'),
        ],
      },
      managed: { managedBy: () => undefined },
    }
    expect((await listCandidates(deps, { directory: 'alpha' })).candidates.map(c => c.sessionId)).toEqual(['session-alpha'])
    expect((await listCandidates(deps, { liveOnly: true })).candidates.map(c => c.sessionId))
      .toEqual(['session-alpha', 'session-gamma'])
    expect((await listCandidates(deps, { query: 'BETA' })).candidates.map(c => c.sessionId)).toEqual(['session-beta'])
  })

  it('marks a session the Host no longer holds and one that is persisted', async () => {
    const found = (await listCandidates({
      sessionQuery: { listSessions: async () => [record('gone', {}, false, false)] },
      managed: { managedBy: () => undefined },
    })).candidates
    // A session that is neither live nor persisted is still reported, with both
    // flags false, so the caller can tell "unknown" from "unavailable".
    expect(found[0]).toMatchObject({ live: false, persisted: false })
    expect(found[0]?.connection).toBe('unavailable')
    expect(found[0]?.unrecoverable).toBe(true)
    expect(found[0]?.connectionReason).toMatch(/不可恢复/)
  })

  it('labels a persisted-but-not-live session as 失联, not 不可恢复 (PRD §二.5)', async () => {
    const found = (await listCandidates({
      sessionQuery: { listSessions: async () => [record('cold', {}, false, true)] },
      managed: { managedBy: () => undefined },
    })).candidates
    expect(found[0]).toMatchObject({
      live: false, persisted: true, connection: 'unavailable', unrecoverable: false,
    })
    expect(found[0]?.connectionReason).toMatch(/失联/)
  })

  it('labels a live session online', async () => {
    const found = (await listCandidates({
      sessionQuery: { listSessions: async () => [record('hot')] },
      managed: { managedBy: () => undefined },
    })).candidates
    expect(found[0]).toMatchObject({ live: true, persisted: true, connection: 'online', unrecoverable: false })
  })

  it('resolves titles last and only within the budget', async () => {
    const asked: string[] = []
    const found = (await listCandidates({
      sessionQuery: { listSessions: async () => [record('a'), record('b'), record('c')] },
      managed: { managedBy: () => undefined },
      titles: { titleOf: async (id) => { asked.push(id); return `title-${id}` } },
      titleBudget: 2,
    })).candidates
    expect(found).toHaveLength(2)
    expect(asked).toHaveLength(2)
    expect(found[0]?.title).toBeDefined()
  })
})

describe('attach, update and detach (PRD §二.1, §二.5)', () => {
  function makeCoordinator(options: { managedTargetLimit?: number } = {}) {
    const tables = createInMemoryTables()
    let tick = Date.parse('2026-09-13T00:00:00.000Z')
    const store = new ConductorStore(tables, () => new Date((tick += 1000)).toISOString())
    let seq = 0
    const deps: CoordinatorDeps = {
      agents: {
        // The joined session is live, so the coordinator can address it.
        create: async () => { throw new Error('not used') },
        get: (id: SessionId) => ({ id, status: 'idle' as const, followup: () => {}, steer: () => {}, cancel: () => {} }),
        list: () => [],
      },
      store,
      createMessage: (text, source) => ({ id: `msg-${String(++seq)}`, text, source }),
      newTaskId: () => `task-${String(++seq)}`,
      newSessionId: () => `session-${String(seq)}`,
      newBindingId: () => `binding-${String(seq)}`,
      now: () => new Date((tick += 1000)).toISOString(),
      defaultCwd: () => undefined,
      ...options.managedTargetLimit === undefined ? {} : { managedTargetLimit: options.managedTargetLimit },
    }
    return { coordinator: new Coordinator(deps), store }
  }

  it('joins an existing session without touching it', async () => {
    const { coordinator, store } = makeCoordinator()
    const result = await coordinator.attachTask({
      operationId: 'op-1', controllerSessionId: 'controller', sessionId: 'session-existing', title: 'Existing work',
    })
    expect(result.preparation).toBe('ready')
    expect(result.sessionId).toBe('session-existing')

    const task = store.getTask(result.taskId)
    expect(task?.title).toBe('Existing work')
    const binding = store.getBinding(task?.currentBindingId ?? '')
    expect(binding?.sessionId).toBe('session-existing')
    // No message was dispatched by joining.
    expect(store.getOperation('op-1')?.phase).toBe('joined_existing_session')
  })

  it('refuses to manage one session twice', async () => {
    const { coordinator } = makeCoordinator()
    await coordinator.attachTask({ operationId: 'op-1', controllerSessionId: 'controller', sessionId: 'session-x' })
    await expect(coordinator.attachTask({
      operationId: 'op-2', controllerSessionId: 'controller', sessionId: 'session-x',
    })).rejects.toMatchObject({ code: 'ALREADY_MANAGED' })
  })

  it('refuses to attach another session when the controller is at the ceiling', async () => {
    const { coordinator } = makeCoordinator({ managedTargetLimit: 1 })
    await coordinator.attachTask({
      operationId: 'op-1', controllerSessionId: 'controller', sessionId: 'session-a',
    })
    await expect(coordinator.attachTask({
      operationId: 'op-2', controllerSessionId: 'controller', sessionId: 'session-b',
    })).rejects.toMatchObject({ code: 'MANAGED_TARGET_LIMIT' })
  })

  it('organises a task without touching its session', async () => {
    const { coordinator, store } = makeCoordinator()
    const attached = await coordinator.attachTask({
      operationId: 'op-1', controllerSessionId: 'controller', sessionId: 'session-x',
    })
    const updated = await coordinator.updateTask({
      taskId: attached.taskId, callerSessionId: 'controller', title: 'Renamed', groupId: 'g1', pinned: true,
    })
    expect(updated).toMatchObject({ title: 'Renamed', groupId: 'g1', pinned: true, archived: false })

    // T15: authorised plans exist *before* archive, so a later skip would be a cancel.
    await store.putSchedule({
      scheduleId: 'sched-archive',
      title: 'keep checking',
      kind: 'once',
      timezone: 'UTC',
      nextAt: '2026-09-13T00:00:01.000Z',
      action: 'inspect',
      status: 'active',
      authorizedBy: 'controller',
      targetTaskId: attached.taskId,
      runs: [],
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    })
    await store.putRule({
      ruleId: 'rule-archive',
      version: 0,
      title: 'hand on',
      trigger: 'turn_completed',
      sourceTaskId: attached.taskId,
      targetTaskId: attached.taskId,
      action: 'send',
      instruction: 'continue',
      maxExecutions: 1,
      authorizedBy: 'controller',
      active: true,
      firings: [],
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    })

    const archived = await coordinator.updateTask({
      taskId: attached.taskId, callerSessionId: 'controller', archived: true,
    })
    expect(archived.archived).toBe(true)
    // Archiving is conductor bookkeeping: the binding and its session survive.
    expect(store.listBindings(attached.taskId)).toHaveLength(1)
    expect(store.getTask(attached.taskId)?.preparation).toBe('ready')
    expect(store.getAccess(attached.taskId)?.detachedAt).toBeUndefined()
    // T15: archive does not cancel authorised plans — the schedule stays active and still due.
    expect(store.getSchedule('sched-archive')).toMatchObject({
      status: 'active', targetTaskId: attached.taskId,
    })
    expect(dueDecision(store.getSchedule('sched-archive')!, Date.parse('2026-09-13T00:01:00.000Z')).due)
      .toBe(true)
    expect(store.getRule('rule-archive')).toMatchObject({ active: true, sourceTaskId: attached.taskId })
    // T15: archive does not stop execution — a send after archive is still accepted.
    const sent = await coordinator.send({
      operationId: 'send-archived',
      taskId: attached.taskId,
      text: 'still running',
      mode: 'steer',
      callerSessionId: 'controller',
    })
    expect(sent.delivery).toBe('accepted')
    expect(store.getOperation('send-archived')?.delivery).toBe('accepted')

    const restored = await coordinator.updateTask({
      taskId: attached.taskId, callerSessionId: 'controller', archived: false, clearGroup: true,
    })
    expect(restored.archived).toBe(false)
    expect(restored.groupId).toBeUndefined()
  })

  it('reports a session already managed by another task', async () => {
    const { coordinator } = makeCoordinator()
    const attached = await coordinator.attachTask({
      operationId: 'op-1', controllerSessionId: 'controller', sessionId: 'session-x',
    })
    expect(coordinator.taskForSession('session-x')).toBe(attached.taskId)
    expect(coordinator.taskForSession('session-other')).toBeUndefined()
  })

  it('releasing management blocks new sends but keeps what was accepted', async () => {
    const { coordinator, store } = makeCoordinator()
    const attached = await coordinator.attachTask({
      operationId: 'op-1', controllerSessionId: 'controller', sessionId: 'session-x',
    })
    await coordinator.send({
      operationId: 'send-1', taskId: attached.taskId, text: 'before release', mode: 'steer', callerSessionId: 'controller',
    })

    const released = await coordinator.detachTask(attached.taskId, 'controller')
    expect(released.detachedAt).toBeDefined()

    await expect(coordinator.send({
      operationId: 'send-2', taskId: attached.taskId, text: 'after release', mode: 'steer', callerSessionId: 'controller',
    })).rejects.toMatchObject({ code: 'NOT_MANAGED' })

    // The earlier, already-accepted operation is untouched: PRD §二.5 says
    // already accepted input is not withdrawn.
    expect(store.getOperation('send-1')?.delivery).toBe('accepted')
    expect(store.getTask(attached.taskId)).toBeDefined()
  })

  it('refuses organisation from a session that does not control the task', async () => {
    const { coordinator } = makeCoordinator()
    const attached = await coordinator.attachTask({
      operationId: 'op-1', controllerSessionId: 'controller', sessionId: 'session-x',
    })
    await expect(coordinator.updateTask({
      taskId: attached.taskId, callerSessionId: 'someone-else', title: 'nope',
    })).rejects.toMatchObject({ code: 'NOT_CONTROLLER' })
  })

  it('refuses organisation that names a retired control epoch', async () => {
    const { coordinator, store } = makeCoordinator()
    const attached = await coordinator.attachTask({
      operationId: 'op-1', controllerSessionId: 'controller', sessionId: 'session-x',
    })
    const access = store.getAccess(attached.taskId)
    await store.putAccess({ ...access!, ownerEpoch: (access?.ownerEpoch ?? 0) + 1 })
    await expect(coordinator.updateTask({
      taskId: attached.taskId, callerSessionId: 'controller', title: 'nope',
      expectedOwnerEpoch: access?.ownerEpoch ?? 0,
    })).rejects.toMatchObject({ code: 'STALE_OWNER_EPOCH' })
    expect(store.getTask(attached.taskId)?.title).not.toBe('nope')
  })

  it('refuses organisation that names a retired binding version', async () => {
    const { coordinator, store } = makeCoordinator()
    const attached = await coordinator.attachTask({
      operationId: 'op-1', controllerSessionId: 'controller', sessionId: 'session-x',
    })
    const task = store.getTask(attached.taskId)
    const binding = store.getBinding(task?.currentBindingId ?? '')
    await store.putBinding({ ...binding!, version: (binding?.version ?? 1) + 1 })
    await expect(coordinator.updateTask({
      taskId: attached.taskId, callerSessionId: 'controller', title: 'nope',
      expectedBindingVersion: binding?.version ?? 1,
    })).rejects.toMatchObject({ code: 'STALE_BINDING' })
    expect(store.getTask(attached.taskId)?.title).not.toBe('nope')
  })

  it('organises when the caller still holds the pinned epoch and binding', async () => {
    const { coordinator, store } = makeCoordinator()
    const attached = await coordinator.attachTask({
      operationId: 'op-1', controllerSessionId: 'controller', sessionId: 'session-x',
    })
    const access = store.getAccess(attached.taskId)
    const binding = store.getBinding(store.getTask(attached.taskId)?.currentBindingId ?? '')
    const updated = await coordinator.updateTask({
      taskId: attached.taskId, callerSessionId: 'controller', title: 'Pinned rename',
      ...access?.ownerEpoch === undefined ? {} : { expectedOwnerEpoch: access.ownerEpoch },
      ...binding?.version === undefined ? {} : { expectedBindingVersion: binding.version },
    })
    expect(updated.title).toBe('Pinned rename')
  })
})
