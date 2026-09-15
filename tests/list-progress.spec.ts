import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/domain/defaults.ts'
import { listTool, type ConductorToolContext } from '../src/tools.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { TaskRecord } from '../src/store/schema.ts'

/** A complete, valid task record with the members a test cares about overridden. */
function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-1',
    title: 'Fix the parser',
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

describe('conductor_list card progress (PRD §二.1 最近进展)', () => {
  it('carries execution, last-used model, last-turn outcome, progress, pending intervention and unread from the same derivation as the card', async () => {
    const store = new ConductorStore(createInMemoryTables(), () => '2026-09-13T00:00:00.000Z')
    await store.createTask(task())
    const tool = listTool({
      store: () => store,
      defaultReadLimit: () => DEFAULTS.defaultReadLimit,
      taskStatusOf: () => ({
        status: 'idle',
        execution: 'running',
        lastTurn: 'failed',
        lastTurnDetail: 'MISSING_CREDENTIAL: no API key',
        modelLastUsed: 'probe/model at high reasoning',
        pendingInteraction: 'waiting_input',
        unread: 2,
        sessionArchivedExternally: true,
      }),
    } as unknown as ConductorToolContext)
    const page = await tool.execute({}, {} as never) as {
      tasks: readonly {
        execution?: string
        lastTurn?: string
        lastTurnDetail?: string
        modelLastUsed?: string
        pendingInteraction?: string
        unread?: number
        sessionArchivedExternally?: boolean
      }[]
    }
    expect(page.tasks[0]).toMatchObject({
      execution: 'running',
      lastTurn: 'failed',
      lastTurnDetail: 'MISSING_CREDENTIAL: no API key',
      modelLastUsed: 'probe/model at high reasoning',
      pendingInteraction: 'waiting_input',
      unread: 2,
      sessionArchivedExternally: true,
    })
    const rendered = tool.output.render({}, page as never)
    const text = rendered.map(block => ('text' in block ? block.text : '')).join('')
    expect(text).toContain('execution running')
    expect(text).toContain('last turn failed')
    expect(text).toContain('progress: MISSING_CREDENTIAL: no API key')
    expect(text).toContain('last used probe/model at high reasoning')
    expect(text).toContain('pending waiting_input')
    expect(text).toContain('unread 2')
    expect(text).toContain('archived outside the conductor')
  })

  it('omits last-turn progress, execution and last-used model when the derivation supplied none, so an idle list cannot invent them', async () => {
    const store = new ConductorStore(createInMemoryTables(), () => '2026-09-13T00:00:00.000Z')
    await store.createTask(task())
    const tool = listTool({
      store: () => store,
      defaultReadLimit: () => DEFAULTS.defaultReadLimit,
      taskStatusOf: () => ({ status: 'idle' }),
    } as unknown as ConductorToolContext)
    const page = await tool.execute({}, {} as never) as {
      tasks: readonly {
        execution?: string
        lastTurn?: string
        lastTurnDetail?: string
        modelLastUsed?: string
        pendingInteraction?: string
        unread?: number
        sessionArchivedExternally?: boolean
      }[]
    }
    expect(page.tasks[0]?.execution).toBeUndefined()
    expect(page.tasks[0]?.lastTurn).toBeUndefined()
    expect(page.tasks[0]?.lastTurnDetail).toBeUndefined()
    expect(page.tasks[0]?.modelLastUsed).toBeUndefined()
    expect(page.tasks[0]?.pendingInteraction).toBeUndefined()
    expect(page.tasks[0]?.unread).toBeUndefined()
    expect(page.tasks[0]?.sessionArchivedExternally).toBeUndefined()
    const rendered = tool.output.render({}, page as never)
    const text = rendered.map(block => ('text' in block ? block.text : '')).join('')
    expect(text).not.toContain('execution ')
    expect(text).not.toContain('last turn')
    expect(text).not.toContain('progress:')
    expect(text).not.toContain('last used ')
    expect(text).not.toContain('pending ')
    expect(text).not.toContain('unread ')
    expect(text).not.toContain('archived outside the conductor')
  })

  it('carries sessionArchivedExternally=false when the Host archive set was read and the session is not in it', async () => {
    const store = new ConductorStore(createInMemoryTables(), () => '2026-09-13T00:00:00.000Z')
    await store.createTask(task())
    const tool = listTool({
      store: () => store,
      defaultReadLimit: () => DEFAULTS.defaultReadLimit,
      taskStatusOf: () => ({ status: 'idle', sessionArchivedExternally: false }),
    } as unknown as ConductorToolContext)
    const page = await tool.execute({}, {} as never) as {
      tasks: readonly { sessionArchivedExternally?: boolean }[]
    }
    expect(page.tasks[0]?.sessionArchivedExternally).toBe(false)
    const rendered = tool.output.render({}, page as never)
    const text = rendered.map(block => ('text' in block ? block.text : '')).join('')
    expect(text).not.toContain('archived outside the conductor')
  })
})
