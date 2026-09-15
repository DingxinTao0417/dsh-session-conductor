import { describe, expect, it } from 'vitest'
import { historyOf, type SessionEventLike } from '../src/service/projection.ts'
import { TaskObserver, watchKey } from '../src/service/observer.ts'
import { hitsInHistory, searchAccessOf } from '../src/service/search.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { AccessRecord } from '../src/store/schema.ts'
import type { TaskRecord } from '../src/store/schema.ts'

/** Build a Host-shaped session event. */
function event(seq: number, type: string, data: unknown = {}): SessionEventLike {
  return { type, seq, time: seq, data }
}

/** An access record with the members a test cares about overridden. */
function access(over: Partial<AccessRecord> = {}): AccessRecord {
  return {
    taskId: 'task-1',
    ownerSessionId: 'controller',
    ownerEpoch: 0,
    observerSessionIds: [],
    updatedAt: 'now',
    ...over,
  }
}

describe('hitsInHistory (PRD §二.5 full-text search)', () => {
  const entries = [
    historyOf(event(0, 'user/message', { content: [{ type: 'text', text: 'Please inspect the Alpha parser' }] }))!,
    historyOf(event(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'Looking at beta next' }] } }))!,
    historyOf(event(2, 'tool/call', { name: 'read', arguments: '{"path":"alpha.ts"}' }))!,
  ]

  it('matches case-insensitively as a substring, and returns only seq and kind', () => {
    const hits = hitsInHistory(entries, 'ALPHA')
    expect(hits).toEqual([
      { seq: 0, kind: 'user' },
      { seq: 2, kind: 'tool_call' },
    ])
    for (const hit of hits) {
      expect(Object.keys(hit).sort()).toEqual(['kind', 'seq'])
      expect(JSON.stringify(hit)).not.toMatch(/alpha/i)
      expect(JSON.stringify(hit)).not.toMatch(/parser/i)
    }
  })

  it('matches nothing for an empty or whitespace-only query, rather than everything', () => {
    expect(hitsInHistory(entries, '')).toEqual([])
    expect(hitsInHistory(entries, '   ')).toEqual([])
  })

  it('does not match a token stream, because historyOf never projects one', () => {
    const raw = [
      event(0, 'assistant/chunk', { chunk: { type: 'text-delta', text: 'secret-needle-in-the-stream' } }),
      event(1, 'user/message', { content: [{ type: 'text', text: 'ordinary' }] }),
    ]
    const readable = raw.map(historyOf).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    expect(hitsInHistory(readable, 'secret-needle-in-the-stream')).toEqual([])
    expect(hitsInHistory(readable, 'ordinary')).toEqual([{ seq: 1, kind: 'user' }])
  })
})

describe('searchAccessOf (owner / observer / release)', () => {
  it('lets the controller and an observer search, and omits everyone else', () => {
    const record = access({ observerSessionIds: ['auditor'] })
    expect(searchAccessOf(record, 'controller')).toEqual({ kind: 'search' })
    expect(searchAccessOf(record, 'auditor')).toEqual({ kind: 'search' })
    expect(searchAccessOf(record, 'stranger')).toEqual({ kind: 'omit' })
    // No control record means there is no relationship that would make this caller a reader.
    expect(searchAccessOf(undefined, 'controller')).toEqual({ kind: 'omit' })
  })

  it('names a release to a caller who may still read, and omits a stranger', () => {
    const released = access({ detachedAt: '2026-09-13T01:00:00.000Z', observerSessionIds: ['auditor'] })
    const owner = searchAccessOf(released, 'controller')
    expect(owner.kind).toBe('unreadable')
    if (owner.kind === 'unreadable') {
      expect(owner.reason).toMatch(/released at 2026-09-13T01:00:00.000Z/)
      expect(owner.reason).toMatch(/no longer searches/)
    }
    expect(searchAccessOf(released, 'auditor').kind).toBe('unreadable')
    expect(searchAccessOf(released, 'stranger')).toEqual({ kind: 'omit' })
  })
})

describe('TaskObserver.search (PRD §二.5, T15)', () => {
  /** Two ready tasks, each with its own session and control record. */
  async function setup() {
    const tables = createInMemoryTables()
    let tick = Date.parse('2026-09-13T00:00:00.000Z')
    const store = new ConductorStore(tables, () => new Date((tick += 1000)).toISOString())
    const sessions = new Map<string, { events: SessionEventLike[]; seq: number }>()
    const agents = {
      get: (id: unknown) => {
        const session = sessions.get(String(id))
        return session === undefined ? undefined : { id, session }
      },
    }
    const seed = async (
      taskId: string,
      sessionId: string,
      owner: string,
      events: SessionEventLike[],
      over: { observers?: string[]; detachedAt?: string } = {},
    ) => {
      const task: TaskRecord = {
        taskId, title: taskId, pinned: false, archived: false,
        controllerSessionId: owner, requestedBy: 'user', contextMode: 'empty',
        preparation: 'ready', preparationPhase: 'ready', currentBindingId: `b-${taskId}`,
        createdAt: 'now', updatedAt: 'now',
      }
      await store.createTask(task)
      await store.putBinding({
        bindingId: `b-${taskId}`, taskId, hostId: 'local', sessionId,
        version: 1, createdAt: 'now',
      })
      await store.putAccess({
        taskId,
        ownerSessionId: owner,
        ownerEpoch: 0,
        observerSessionIds: over.observers ?? [],
        ...over.detachedAt === undefined ? {} : { detachedAt: over.detachedAt },
        updatedAt: 'now',
      })
      sessions.set(sessionId, { events, seq: events.length - 1 })
    }
    await seed('task-mine', 'session-mine', 'controller', [
      event(0, 'user/message', { content: [{ type: 'text', text: 'unique-needle-alpha lives here' }] }),
      event(1, 'assistant/chunk', { chunk: { type: 'text-delta', text: 'unique-needle-alpha in the stream' } }),
    ])
    await seed('task-theirs', 'session-theirs', 'other-controller', [
      event(0, 'user/message', { content: [{ type: 'text', text: 'unique-needle-alpha is a secret of theirs' }] }),
    ], { observers: ['auditor'] })
    return { store, agents, sessions }
  }

  it('returns locations for the controller, never the matching text, and does not move a cursor', async () => {
    const { store, agents } = await setup()
    const observer = new TaskObserver({ agents, store })
    const result = observer.search('controller', 'UNIQUE-NEEDLE-ALPHA')
    expect(result.matches).toEqual([
      { taskId: 'task-mine', hits: [{ seq: 0, kind: 'user' }] },
    ])
    expect(JSON.stringify(result)).not.toMatch(/lives here/)
    expect(JSON.stringify(result.matches[0]?.hits)).not.toMatch(/unique-needle-alpha/i)
    expect(store.getWatch(watchKey('controller', 'task-mine'))).toBeUndefined()
    // The other controller's session matched the needle too, and must not appear.
    expect(result.matches.map(entry => entry.taskId)).not.toContain('task-theirs')
  })

  it('lets an observer match, and omits a stranger entirely — including from unreadable', async () => {
    const { store, agents } = await setup()
    const observer = new TaskObserver({ agents, store })
    const asAuditor = observer.search('auditor', 'unique-needle-alpha')
    expect(asAuditor.matches.map(entry => entry.taskId)).toEqual(['task-theirs'])
    expect(asAuditor.unreadable).toEqual([])

    const asStranger = observer.search('session-that-does-not-control-it', 'unique-needle-alpha')
    expect(asStranger.matches).toEqual([])
    expect(asStranger.unreadable).toEqual([])
  })

  it('reports a released task the caller used to read, and still omits a stranger', async () => {
    const { store, agents } = await setup()
    await store.putAccess({
      ...store.getAccess('task-mine')!,
      detachedAt: '2026-09-13T02:00:00.000Z',
      updatedAt: 'now',
    })
    const observer = new TaskObserver({ agents, store })
    const asOwner = observer.search('controller', 'unique-needle-alpha')
    expect(asOwner.matches).toEqual([])
    expect(asOwner.unreadable).toHaveLength(1)
    expect(asOwner.unreadable[0]?.taskId).toBe('task-mine')
    expect(asOwner.unreadable[0]?.reason).toMatch(/released at 2026-09-13T02:00:00.000Z/)

    const asStranger = observer.search('stranger', 'unique-needle-alpha')
    expect(asStranger.unreadable).toEqual([])
    expect(asStranger.matches).toEqual([])
  })

  it('restricts the search to the task ids it was given, in that order', async () => {
    const { store, agents } = await setup()
    await store.putAccess({
      ...store.getAccess('task-theirs')!,
      observerSessionIds: ['controller'],
      updatedAt: 'now',
    })
    const observer = new TaskObserver({ agents, store })
    const both = observer.search('controller', 'unique-needle-alpha', ['task-theirs', 'task-mine'])
    expect(both.matches.map(entry => entry.taskId)).toEqual(['task-theirs', 'task-mine'])
    const one = observer.search('controller', 'unique-needle-alpha', ['task-mine'])
    expect(one.matches.map(entry => entry.taskId)).toEqual(['task-mine'])
  })
})
