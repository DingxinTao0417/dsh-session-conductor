import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/domain/defaults.ts'
import { discoverTool, listTool, type ConductorToolContext } from '../src/tools.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { CandidateSession } from '../src/service/discovery.ts'
import type { TaskRecord } from '../src/store/schema.ts'

/** A complete, valid task record with the members a test cares about overridden. */
function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-1',
    title: 't',
    pinned: false,
    archived: false,
    controllerSessionId: 'controller',
    requestedBy: 'user',
    contextMode: 'brief',
    preparation: 'ready',
    preparationPhase: 'ready',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  }
}

/** A discoverable session with the fields the page actually returns. */
function candidate(id: string): CandidateSession {
  return {
    sessionId: id,
    live: true,
    persisted: true,
    connection: 'online',
    unrecoverable: false,
    connectionReason: 'the Host currently holds this session',
    managed: false,
  }
}

describe('list and discover page size (PRD §四.7 默认读取量)', () => {
  it('uses the configured default when conductor_list omits limit', async () => {
    const store = new ConductorStore(createInMemoryTables(), () => '2026-09-13T00:00:00.000Z')
    await store.createTask(task({ taskId: 'task-a', title: 'a' }))
    await store.createTask(task({ taskId: 'task-b', title: 'b' }))
    await store.createTask(task({ taskId: 'task-c', title: 'c' }))
    const tool = listTool({
      store: () => store,
      taskStatusOf: () => undefined,
      defaultReadLimit: () => 2,
    } as unknown as ConductorToolContext)
    const page = await tool.execute({}, {} as never) as {
      total: number
      returned: number
      limit: number
      tasks: readonly { taskId: string }[]
    }
    expect(page.total).toBe(3)
    expect(page.returned).toBe(2)
    expect(page.limit).toBe(2)
    expect(page.tasks).toHaveLength(2)
  })

  it('lets an explicit list limit beat the configured default', async () => {
    const store = new ConductorStore(createInMemoryTables(), () => '2026-09-13T00:00:00.000Z')
    await store.createTask(task({ taskId: 'task-a', title: 'a' }))
    await store.createTask(task({ taskId: 'task-b', title: 'b' }))
    await store.createTask(task({ taskId: 'task-c', title: 'c' }))
    const tool = listTool({
      store: () => store,
      taskStatusOf: () => undefined,
      defaultReadLimit: () => 2,
    } as unknown as ConductorToolContext)
    const page = await tool.execute({ limit: 1 }, {} as never) as { returned: number; limit: number }
    expect(page.returned).toBe(1)
    expect(page.limit).toBe(1)
  })

  it('falls back to the published 20 for a list that names no limit', async () => {
    const store = new ConductorStore(createInMemoryTables(), () => '2026-09-13T00:00:00.000Z')
    await store.createTask(task({ taskId: 'task-a', title: 'a' }))
    await store.createTask(task({ taskId: 'task-b', title: 'b' }))
    await store.createTask(task({ taskId: 'task-c', title: 'c' }))
    const tool = listTool({
      store: () => store,
      taskStatusOf: () => undefined,
      defaultReadLimit: () => DEFAULTS.defaultReadLimit,
    } as unknown as ConductorToolContext)
    const page = await tool.execute({}, {} as never) as { returned: number; limit: number; total: number }
    expect(page.total).toBe(3)
    expect(page.returned).toBe(3)
    expect(page.limit).toBe(20)
  })

  it('uses the configured default when conductor_discover omits limit', async () => {
    const tool = discoverTool({
      candidates: async () => ({
        candidates: [candidate('s-a'), candidate('s-b'), candidate('s-c')],
      }),
      defaultReadLimit: () => 2,
    } as unknown as ConductorToolContext)
    const page = await tool.execute({}, {} as never) as {
      total: number
      returned: number
      limit: number
      candidates: readonly { sessionId: string }[]
    }
    expect(page.total).toBe(3)
    expect(page.returned).toBe(2)
    expect(page.limit).toBe(2)
    expect(page.candidates).toHaveLength(2)
  })
})
