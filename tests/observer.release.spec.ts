import { describe, expect, it } from 'vitest'
import { TaskObserver } from '../src/service/observer.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { TaskRecord } from '../src/store/schema.ts'

/**
 * A released task is a **per-target error**, not an ordinary read (PRD §二.5, §二.7).
 *
 * §二.7 requires a target that is unavailable to come back as that target's own error, and §二.5 says
 * releasing a task stops the relationship the conductor's monitoring depends on. The resolver did
 * not consult the access record at all, so a released task's history was served as though the
 * relationship still existed — the same defect the watch path had, fixed here for `read` and `wait`,
 * which both go through this resolver.
 *
 * `tests/observer.spec.ts` covers the resolver's other answers; this covers the release, and the
 * control that a task which was never released is unaffected — because an absent control record is
 * not a release, and treating it as one would invent a rule the specification does not state.
 */

/** A task with a live session and, when asked for, a control record. */
async function observerFor(options: { access: boolean; detachedAt?: string }) {
  const tables = createInMemoryTables()
  let tick = Date.parse('2026-09-13T00:00:00.000Z')
  const store = new ConductorStore(tables, () => new Date((tick += 1000)).toISOString())
  const task: TaskRecord = {
    taskId: 'task-1', title: 't', pinned: false, archived: false,
    controllerSessionId: 'controller', requestedBy: 'user', contextMode: 'brief',
    preparation: 'ready', preparationPhase: 'ready', currentBindingId: 'b1',
    createdAt: 'now', updatedAt: 'now',
  }
  await store.createTask(task)
  await store.putBinding({
    bindingId: 'b1', taskId: 'task-1', hostId: 'local', sessionId: 'session-1',
    version: 1, createdAt: 'now',
  })
  if (options.access) {
    await store.putAccess({
      taskId: 'task-1',
      ownerSessionId: 'controller',
      ownerEpoch: 0,
      observerSessionIds: [],
      ...options.detachedAt === undefined ? {} : { detachedAt: options.detachedAt },
      updatedAt: 'now',
    })
  }
  const events: SessionEventLike[] = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const agents = {
    get: (id: unknown) => ({ id, session: { events, seq: events.length - 1 } }),
  }
  return new TaskObserver({ agents, store })
}

describe('observe and wait on a released task (PRD §二.5, §二.7)', () => {
  it('reports the release as this target\'s error, naming when it happened', async () => {
    const observer = await observerFor({ access: true, detachedAt: '2026-09-13T01:00:00.000Z' })
    const snapshot = observer.snapshot('task-1')
    expect(snapshot.error).toMatch(/management of task task-1 was released at 2026-09-13T01:00:00.000Z/)
    expect(snapshot.error).toMatch(/no longer reads its session/)
    expect(snapshot.error).toMatch(/Anything already accepted is untouched/)
  })

  it('reads a task that is still managed, and one that was never given a control record', async () => {
    // The control: only a **release** changes the answer. A task the observer has no relationship
    // record for is not a released task, and refusing to read it would invent a rule.
    const managed = await observerFor({ access: true })
    expect(managed.snapshot('task-1').error).toBeUndefined()

    const unattributed = await observerFor({ access: false })
    expect(unattributed.snapshot('task-1').error).toBeUndefined()
  })

  it('reports the release through a wait as well, because both go through the resolver', async () => {
    const observer = await observerFor({ access: true, detachedAt: '2026-09-13T02:00:00.000Z' })
    const waited = await observer.wait([{ taskId: 'task-1' }], 'reader', 0)
    expect(waited.timedOut).toBe(true)
    expect(waited.targets[0]?.taskId).toBe('task-1')
    expect(waited.targets[0]?.error).toMatch(/was released at 2026-09-13T02:00:00.000Z/)
    // No state is served for a released task: the per-target error is the answer.
    expect(waited.targets[0]?.state).toBeUndefined()
  })
})
