/**
 * The management panel's status badge, filter, grouping and data route (PRD §二.1).
 *
 * Three separate claims are pinned here, and they are separate on purpose:
 *
 * 1. **The badge derivation** is pure and total, and its precedence is the documented one. This is
 *    what the Host uses, so the panel and the dispatcher cannot disagree about "budget limited".
 * 2. **The filter and the grouping** are pure functions of the cards the panel already holds, so a
 *    list can be narrowed without asking the Host again.
 * 3. **The route** answers JSON, answers `500` with a reason rather than an empty list when the read
 *    fails, and carries a failing HTTP status into the client's error message instead of reporting a
 *    bare "failed". Row C129 of `docs/compatibility.md` recorded a test for that last part that did
 *    not exist; these are it.
 *
 * @module dsh-session-conductor/tests/panel
 */

import { describe, expect, it } from 'vitest'
import {
  PANEL_STATUSES,
  panelStatusOf,
  type PanelStatusFacts,
  type PanelTaskStatus,
} from '../src/domain/panel-status.ts'
import type { PanelTaskDetail } from '../src/domain/panel-detail.ts'
import { detailTaskIdOf, registerPanelDetailRoute, registerPanelRoute, type PanelPayload } from '../src/service/panelapi.ts'
import { applyPanelListResult, panelLinkNote } from '../src/domain/panel-link.ts'
import { selectionFromHeader } from '../src/service/modelconfig.ts'
import {
  PANEL_DETAIL_ROUTE,
  PANEL_GROUP_KEYS,
  filterTasks,
  groupTasks,
  httpPanelPort,
  sessionNavigationOf,
  statusCounts,
  type PanelTask,
} from '../src/client.ts'

/** One card, with the badge and the fields the filter and grouping read. */
function card(overrides: Partial<PanelTask> & { taskId: string }): PanelTask {
  return { title: overrides.taskId, preparation: 'ready', execution: 'idle', status: 'idle', ...overrides }
}

describe('panel status badge (PRD §二.1)', () => {
  it('derives the special states §二.1 names from facts that are actually checked', () => {
    // 创建中: the preparation state itself, before any session exists.
    expect(panelStatusOf({ preparation: 'accepted' })).toEqual({ status: 'preparing' })
    expect(panelStatusOf({ preparation: 'preparing' })).toEqual({ status: 'preparing' })
    expect(panelStatusOf({ preparation: 'failed' })).toEqual({ status: 'preparation_failed' })
    expect(panelStatusOf({ preparation: 'cancelled' })).toEqual({ status: 'cancelled' })
    // 预算受限: the reason comes from the budget gate rather than being re-derived here, so it is
    // carried through verbatim.
    expect(panelStatusOf({ preparation: 'ready', budgetRefusal: 'task budget t: the deadline passed' }))
      .toEqual({ status: 'budget_limited', reason: 'task budget t: the deadline passed' })
    // Management released: the reason is the one `monitoringAllowed` gives.
    expect(panelStatusOf({ preparation: 'ready', releasedReason: 'released at 2026-01-01T00:00:00.000Z' }))
      .toEqual({ status: 'released', reason: 'released at 2026-01-01T00:00:00.000Z' })
  })

  it('derives the ordinary states, and "none" is not "waiting"', () => {
    expect(panelStatusOf({ preparation: 'ready', execution: 'running' })).toEqual({ status: 'running' })
    expect(panelStatusOf({ preparation: 'ready', execution: 'interrupting' })).toEqual({ status: 'running' })
    expect(panelStatusOf({ preparation: 'ready', execution: 'reconciling' })).toEqual({ status: 'idle' })
    expect(panelStatusOf({ preparation: 'ready', execution: 'idle' })).toEqual({ status: 'idle' })
    expect(panelStatusOf({ preparation: 'ready', interaction: 'waiting_approval' }))
      .toEqual({ status: 'waiting_user', reason: 'waiting_approval' })
    // `none` is the projection's word for "nothing is waiting", so it must not become a badge.
    expect(panelStatusOf({ preparation: 'ready', interaction: 'none' })).toEqual({ status: 'idle' })
    // A task with no live session at all has no projection fields; it is still exactly one badge.
    expect(panelStatusOf({ preparation: 'ready' })).toEqual({ status: 'idle' })
  })

  it('applies the precedence in the documented order', () => {
    const allFacts: PanelStatusFacts = {
      preparation: 'preparing',
      execution: 'running',
      interaction: 'waiting_approval',
      releasedReason: 'released',
      budgetRefusal: 'over budget',
    }
    // Every fact present at once: the earliest in `PANEL_STATUSES` wins, and the order asserted here is
    // the order the list itself declares.
    expect(panelStatusOf(allFacts).status).toBe('preparing')
    expect(panelStatusOf({ ...allFacts, preparation: 'failed' }).status).toBe('preparation_failed')
    expect(panelStatusOf({ ...allFacts, preparation: 'cancelled' }).status).toBe('cancelled')
    expect(panelStatusOf({ ...allFacts, preparation: 'ready' }).status).toBe('released')
    expect(panelStatusOf({ ...allFacts, preparation: 'ready', releasedReason: undefined }).status)
      .toBe('budget_limited')
    expect(panelStatusOf({
      preparation: 'ready',
      execution: 'running',
      interaction: 'waiting_approval',
    }).status).toBe('waiting_user')
  })

  it('is total: every combination of the persisted dimensions yields a badge the filter knows', () => {
    const preparations = ['accepted', 'preparing', 'ready', 'failed', 'cancelled']
    const executions = ['idle', 'running', 'interrupting', 'reconciling']
    const interactions = ['none', 'waiting_input', 'waiting_approval']
    let seen = 0
    for (const preparation of preparations) {
      for (const execution of executions) {
        for (const interaction of interactions) {
          const badge = panelStatusOf({ preparation, execution, interaction })
          expect(PANEL_STATUSES).toContain(badge.status)
          seen += 1
        }
      }
    }
    expect(seen).toBe(preparations.length * executions.length * interactions.length)
  })

  it('does not offer a badge nothing can produce', () => {
    // §二.1 also names "迁移中", and this build refuses every migration: no migration record is ever
    // constructed. A badge for it would be a filter that can never match a row, so it is absent until
    // a migration can be in flight.
    expect(PANEL_STATUSES).not.toContain('migrating' as PanelTaskStatus)
  })
})

describe('panel filter and grouping (PRD §二.1)', () => {
  const tasks = [
    card({ taskId: 'task-a', status: 'running', project: 'D:\\projects\\parser' }),
    card({ taskId: 'task-b', status: 'waiting_user', project: 'D:\\projects\\parser' }),
    card({ taskId: 'task-c', status: 'idle', project: 'D:\\projects\\web' }),
    card({ taskId: 'task-d', status: 'budget_limited' }),
  ]

  it('counts every badge, including the ones nothing carries, so the control is stable', () => {
    const counts = statusCounts(tasks)
    expect(counts.map(entry => entry.status)).toEqual([...PANEL_STATUSES])
    const byStatus = new Map(counts.map(entry => [entry.status, entry.count]))
    expect(byStatus.get('running')).toBe(1)
    expect(byStatus.get('waiting_user')).toBe(1)
    expect(byStatus.get('budget_limited')).toBe(1)
    expect(byStatus.get('preparing')).toBe(0)
    expect(byStatus.get('released')).toBe(0)
  })

  it('filters to one badge, and to nothing at all when asked', () => {
    expect(filterTasks(tasks, undefined).map(task => task.taskId))
      .toEqual(['task-a', 'task-b', 'task-c', 'task-d'])
    expect(filterTasks(tasks, 'running').map(task => task.taskId)).toEqual(['task-a'])
    expect(filterTasks(tasks, 'preparing')).toEqual([])
    // The order the Host gave is preserved: a filter re-sorts nothing.
    expect(filterTasks(tasks, 'idle').map(task => task.taskId)).toEqual(['task-c'])
  })

  it('groups by status in badge precedence order', () => {
    const groups = groupTasks(tasks, 'status')
    expect(groups.map(entry => entry.key)).toEqual([...PANEL_STATUSES])
    const budget = groups.find(entry => entry.key === 'budget_limited')
    expect(budget?.tasks.map(task => task.taskId)).toEqual(['task-d'])
  })

  it('groups by project, keeps the tasks that report none separate, and puts them last', () => {
    const groups = groupTasks(tasks, 'project')
    expect(groups.map(entry => entry.key)).toEqual(['D:\\projects\\parser', 'D:\\projects\\web', undefined])
    expect(groups[0]?.tasks.map(task => task.taskId)).toEqual(['task-a', 'task-b'])
    // The unnamed group is keyed `undefined` rather than by an invented project name, so it cannot be
    // mistaken for a project actually called something.
    expect(groups[2]?.tasks.map(task => task.taskId)).toEqual(['task-d'])
    // With nothing unnamed, no trailing empty group is produced.
    expect(groupTasks(tasks.slice(0, 3), 'project').map(entry => entry.key))
      .toEqual(['D:\\projects\\parser', 'D:\\projects\\web'])
  })

  it('groups nothing into one unnamed group, so the caller renders the list either way', () => {
    expect(groupTasks(tasks, 'none')).toEqual([{ key: undefined, tasks }])
    expect(PANEL_GROUP_KEYS).toEqual(['none', 'status', 'project'])
  })
})

describe('the configuration the Host logged (PRD §二.3)', () => {
  it('reads the provider, model and reasoning effort from the Host\'s own request header', () => {
    // The installed Host answers "what did the last request use" from exactly this field
    // (`agent.session.requestHeader()?.config`), so the conductor reading it cannot disagree with it.
    expect(selectionFromHeader({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(selectionFromHeader({
      config: { provider: 'p', model: 'm', reasoningEffort: 'high' },
      system: 'ignored',
      tools: [],
    })).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('reports no selection rather than inventing one', () => {
    // "No request has been assembled" and "the configuration is unknown" are both different facts from a
    // model name, and each of these would be a fabricated configuration if it fell back to a default.
    expect(selectionFromHeader(undefined)).toBeUndefined()
    expect(selectionFromHeader(null)).toBeUndefined()
    expect(selectionFromHeader({})).toBeUndefined()
    expect(selectionFromHeader({ config: undefined })).toBeUndefined()
    expect(selectionFromHeader({ config: 'deepseek-official' })).toBeUndefined()
    expect(selectionFromHeader({ config: { provider: '', model: 'm' } })).toBeUndefined()
    expect(selectionFromHeader({ config: { provider: 'p', model: '' } })).toBeUndefined()
    expect(selectionFromHeader({ config: { provider: 'p' } })).toBeUndefined()
    expect(selectionFromHeader({ config: { model: 'm' } })).toBeUndefined()
    // A blank effort is dropped rather than carried: an empty string is not an effort name.
    expect(selectionFromHeader({ config: { provider: 'p', model: 'm', reasoningEffort: '' } }))
      .toEqual({ provider: 'p', model: 'm' })
  })
})

describe('opening a task\'s original session (PRD §二.1)', () => {
  it('narrows the shell\'s own navigation to the one call the panel makes', () => {
    // The shell owns navigation; the plugin must not fake it. The installed Shell exposes
    // `sessions.open(sessionId)` and uses it for exactly this ("take the returned id to `sessions.open`").
    const opened: string[] = []
    const navigation = sessionNavigationOf({ sessions: { open: (id: string) => { opened.push(id) } } })
    expect(navigation).toBeDefined()
    navigation?.open('session-1')
    navigation?.open('session-2')
    expect(opened).toEqual(['session-1', 'session-2'])
  })

  it('calls the service method bound to its service, not detached from it', () => {
    // A method that reads `this` would work here and break in the browser, which is the one place this
    // cannot be tested. The port calls it as a member, so the distinction cannot be lost by accident.
    const service = {
      calls: [] as string[],
      open(id: string) { this.calls.push(id) },
    }
    const navigation = sessionNavigationOf({ sessions: service })
    navigation?.open('session-9')
    expect(service.calls).toEqual(['session-9'])
  })

  it('reports no navigation when the shell has none, and does not invent one', () => {
    expect(sessionNavigationOf({})).toBeUndefined()
    expect(sessionNavigationOf({ sessions: {} })).toBeUndefined()
    // A non-callable member is not navigation either: calling it would throw in the reader's face.
    expect(sessionNavigationOf({ sessions: { open: 'yes' as unknown as (id: string) => void } })).toBeUndefined()
  })
})

describe('the panel data route and its client port', () => {
  /** A response object standing in for the Host's own, capturing what the handler wrote. */
  function fakeResponse(): {
    statusCode: number
    headers: Record<string, string>
    body: string
    setHeader(name: string, value: string): void
    end(body?: string): void
  } {
    return {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(name, value) { this.headers[name] = value },
      end(body) { this.body = body ?? '' },
    }
  }

  it('registers an exact route and serves JSON with no-store', () => {
    const registered: { path: string; kind: string }[] = []
    let handler: ((request: unknown, response: ReturnType<typeof fakeResponse>) => void) | undefined
    const payload: PanelPayload = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      total: 0,
      tasks: [],
      notes: ['a note'],
    }
    const unregister = registerPanelRoute({
      register(route) {
        registered.push({ path: route.path, kind: route.kind })
        handler = route.handler as typeof handler
        return () => {}
      },
    }, () => payload)
    expect(registered).toEqual([{ path: '/conductor/panel', kind: 'exact' }])
    expect(typeof unregister).toBe('function')

    const response = fakeResponse()
    handler?.({ method: 'GET', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }, response)
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    // A stale panel is a panel that lies about what is running.
    expect(response.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(response.body)).toEqual(payload)
  })

  it('answers a failed read as a failure, never as an empty list', () => {
    let handler: ((request: unknown, response: ReturnType<typeof fakeResponse>) => void) | undefined
    registerPanelRoute({
      register(route) {
        handler = route.handler as typeof handler
        return () => {}
      },
    }, () => { throw new Error('the store is not open') })

    const response = fakeResponse()
    handler?.({ method: 'GET', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' } }, response)
    expect(response.statusCode).toBe(500)
    // The distinction the whole route exists to preserve: `{tasks: []}` here would read as "no work".
    expect(JSON.parse(response.body)).toEqual({ error: 'PANEL_READ_FAILED: panel data is temporarily unavailable' })
    expect(response.body).not.toContain('tasks')
  })

  it('registers nothing when this composition has no web server, and says so by returning undefined', () => {
    expect(registerPanelRoute(undefined, () => ({ generatedAt: '', total: 0, tasks: [], notes: [] })))
      .toBeUndefined()
  })

  it('carries the HTTP status into the client error, because 404 and 500 mean different things', async () => {
    const notFound = httpPanelPort(async () => new Response('', { status: 404, statusText: 'Not Found' }))
    await expect(notFound.list()).rejects.toThrow(/404 Not Found/)

    const broken = httpPanelPort(async () => new Response('', { status: 500, statusText: 'Internal Server Error' }))
    await expect(broken.list()).rejects.toThrow(/500 Internal Server Error/)

    const good = httpPanelPort(async () => Response.json({ tasks: [card({ taskId: 'task-a' })] }))
    await expect(good.list()).resolves.toHaveLength(1)

    // A response from the wrong route must not erase existing cards and claim no work exists.
    const odd = httpPanelPort(async () => Response.json({ notes: ['something else'] }))
    await expect(odd.list()).rejects.toThrow(/no readable task list/)
  })

  it('lists a payload that omits refreshMergeMs, using the published default on the client', async () => {
    const port = httpPanelPort(async () => Response.json({ tasks: [card({ taskId: 'task-a' })] }))
    await expect(port.list()).resolves.toHaveLength(1)
  })

  it('merges overlapping list() calls into one Host round-trip (PRD §四.7)', async () => {
    let fetches = 0
    let resolveFetch: ((value: Response) => void) | undefined
    const port = httpPanelPort(() => {
      fetches += 1
      return new Promise<Response>(resolve => { resolveFetch = resolve })
    })
    const first = port.list()
    const second = port.list()
    resolveFetch?.(Response.json({ tasks: [card({ taskId: 'task-a' })], refreshMergeMs: 250 }))
    const [a, b] = await Promise.all([first, second])
    expect(a).toHaveLength(1)
    expect(b).toBe(a)
    expect(fetches).toBe(1)
  })

  it('keeps the merge window after the first list so a burst is still one fetch', async () => {
    let fetches = 0
    const delayed: (() => void)[] = []
    const port = httpPanelPort(
      async () => {
        fetches += 1
        return Response.json({
          tasks: [card({ taskId: `t${String(fetches)}` })],
          refreshMergeMs: 250,
        })
      },
      {
        clock: {
          delay: (fn) => { delayed.push(fn); return delayed.length },
          cancel: () => {},
        },
      },
    )
    await port.list()
    expect(fetches).toBe(1)
    await port.list()
    expect(fetches).toBe(1)
    delayed[0]?.()
    await port.list()
    expect(fetches).toBe(2)
  })
})

describe('the task detail route (PRD §二.1 任务详情)', () => {
  /** A minimal detail, so a test says only what it is about. */
  function detail(taskId: string): PanelTaskDetail {
    return {
      taskId,
      title: taskId,
      status: 'idle',
      preparation: 'ready',
      preparationPhase: 'ready',
      execution: 'idle',
      artifacts: [],
      operations: [],
      configuration: { contextMode: 'empty', budgets: [] },
      refusals: ['the conversation is read through conductor_read'],
    }
  }

  /** A response object standing in for the Host's own, capturing what the handler wrote. */
  function fakeResponse(): {
    statusCode: number
    headers: Record<string, string>
    body: string
    setHeader(name: string, value: string): void
    end(body?: string): void
  } {
    return {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(name, value) { this.headers[name] = value },
      end(body) { this.body = body ?? '' },
    }
  }

  /** Register the detail route against a capture, and answer the handler it registered. */
  function harness(build: (taskId: string) => PanelTaskDetail | undefined): {
    call(request: { url?: string }): ReturnType<typeof fakeResponse>
    path: string
    kind: string
    name: string
  } {
    let handler: ((request: { url?: string }, response: ReturnType<typeof fakeResponse>) => void) | undefined
    let path = ''
    let kind = ''
    let name = ''
    registerPanelDetailRoute({
      register(route) {
        path = route.path
        kind = route.kind
        name = route.name
        handler = route.handler as typeof handler
        return () => {}
      },
    }, build)
    return {
      path,
      kind,
      name,
      call(request) {
        const response = fakeResponse()
        handler?.({ method: 'GET', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' }, ...request } as { url?: string }, response)
        return response
      },
    }
  }

  it('resolves routes on the pathname, so the subject travels as a query parameter', () => {
    // The Host's own matcher parses `new URL(req.url ?? '/', 'http://x').pathname`, so a query string is
    // not part of the path — the route itself must therefore be an exact path with a parameter.
    expect(PANEL_DETAIL_ROUTE).toBe('/conductor/panel/task')
    const registered = harness(() => undefined)
    expect(registered.path).toBe('/conductor/panel/task')
    expect(registered.kind).toBe('exact')
    expect(registered.name).toBe('dsh-session-conductor.panel-detail')

    expect(detailTaskIdOf({ url: '/conductor/panel/task?taskId=task-1' })).toBe('task-1')
    expect(detailTaskIdOf({ url: '/conductor/panel/task?taskId=task-1&other=2' })).toBe('task-1')
    // Percent-encoded ids survive; they are decoded by the same parser the Host uses.
    expect(detailTaskIdOf({ url: '/conductor/panel/task?taskId=task%2F1' })).toBe('task/1')
    // A blank parameter is "no subject named", not a task called "".
    expect(detailTaskIdOf({ url: '/conductor/panel/task?taskId=' })).toBeUndefined()
    expect(detailTaskIdOf({ url: '/conductor/panel/task?taskId=%20%20' })).toBeUndefined()
    expect(detailTaskIdOf({ url: '/conductor/panel/task' })).toBeUndefined()
    expect(detailTaskIdOf({ url: '' })).toBeUndefined()
    expect(detailTaskIdOf(undefined)).toBeUndefined()
  })

  it('keeps "no subject", "no such task" and "the read failed" apart', () => {
    const missing = harness(() => undefined)
    const unnamed = missing.call({ url: '/conductor/panel/task' })
    expect(unnamed.statusCode).toBe(400)
    expect(JSON.parse(unnamed.body).error).toMatch(/BAD_REQUEST: .*needs a "taskId" query parameter/)

    const unknown = missing.call({ url: '/conductor/panel/task?taskId=task-nope' })
    expect(unknown.statusCode).toBe(404)
    // The body carries the id it was given, so a typo is visible as a typo.
    expect(JSON.parse(unknown.body).error).toMatch(/NOT_FOUND: no task "task-nope" is recorded/)

    const failing = harness(() => { throw new Error('the store is not open') })
    const broken = failing.call({ url: '/conductor/panel/task?taskId=task-1' })
    expect(broken.statusCode).toBe(500)
    expect(JSON.parse(broken.body)).toEqual({ error: 'PANEL_READ_FAILED: panel data is temporarily unavailable' })

    // A failure is never an empty detail: the three answers above are what a view needs to tell apart.
    expect(JSON.parse(unnamed.body)).not.toHaveProperty('task')
    expect(JSON.parse(unknown.body)).not.toHaveProperty('task')
  })

  it('serves the detail with no-store, and it is the task that was asked for', () => {
    const asked: string[] = []
    const found = harness((taskId) => {
      asked.push(taskId)
      return detail(taskId)
    })
    const response = found.call({ url: '/conductor/panel/task?taskId=task-7' })
    expect(asked).toEqual(['task-7'])
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store')
    const payload = JSON.parse(response.body) as { generatedAt: string; task: PanelTaskDetail }
    expect(payload.task.taskId).toBe('task-7')
    expect(typeof payload.generatedAt).toBe('string')
  })

  it('keeps fork origin on the configuration so a later reader can see the cutoff (PRD §二.2.2)', () => {
    const found = harness((taskId) => ({
      ...detail(taskId),
      configuration: {
        contextMode: 'fork',
        budgets: [],
        forkSourceTaskId: 'task-src',
        forkSourceSessionId: 'session-src',
        forkCutoffSeq: 2,
      },
    }))
    const response = found.call({ url: '/conductor/panel/task?taskId=task-child' })
    const payload = JSON.parse(response.body) as { task: PanelTaskDetail }
    expect(payload.task.configuration.forkSourceTaskId).toBe('task-src')
    expect(payload.task.configuration.forkSourceSessionId).toBe('session-src')
    expect(payload.task.configuration.forkCutoffSeq).toBe(2)
  })

  it('registers nothing when this composition has no web server', () => {
    expect(registerPanelDetailRoute(undefined, () => undefined)).toBeUndefined()
  })

  it('reaches the detail route from the client port, encoding the id', async () => {
    const seen: string[] = []
    const port = httpPanelPort(async (input) => {
      seen.push(String(input))
      return Response.json({ generatedAt: 'x', task: detail(new URL(String(input), 'http://host').searchParams.get('taskId') ?? '') })
    })
    const loaded = await port.detail?.('task-1')
    expect(loaded?.taskId).toBe('task-1')
    expect(seen).toEqual(['/conductor/panel/task?taskId=task-1'])

    await port.detail?.('a/b c')
    // An id with a separator cannot change which route is asked for.
    expect(seen[1]).toBe('/conductor/panel/task?taskId=a%2Fb%20c')

    // The detail's failures carry the status too, so a 404 reads as "no such task" rather than "failed".
    const gone = httpPanelPort(async () => new Response('', { status: 404, statusText: 'Not Found' }))
    await expect(gone.detail?.('task-nope')).rejects.toThrow(/404 Not Found/)
    const mismatched = httpPanelPort(async () => Response.json({ task: detail('task-other') }))
    await expect(mismatched.detail?.('task-1')).rejects.toThrow(/different or unreadable task/)
  })
})

describe('a disconnected panel keeps the last snapshot labelled (PRD §四.5)', () => {
  it('keeps the last cards and marks them disconnected when a later fetch fails', () => {
    const cards = [card({ taskId: 'task-a' })]
    const live = applyPanelListResult({ items: undefined }, { ok: true, items: cards })
    expect(live.link).toBe('live')
    expect(live.items).toBe(cards)

    const lost = applyPanelListResult({ items: live.items }, { ok: false, error: 'the host answered 500' })
    expect(lost.link).toBe('disconnected')
    expect(lost.items).toBe(cards)
    expect(panelLinkNote(lost)).toMatch(/last snapshot, not a live reading/)
    expect(panelLinkNote(lost)).toMatch(/500/)
  })

  it('does not invent a snapshot when the first fetch fails', () => {
    const first = applyPanelListResult({ items: undefined }, { ok: false, error: 'the host answered 404' })
    expect(first.link).toBe('unavailable')
    expect(first.items).toBeUndefined()
    expect(panelLinkNote(first)).toBeUndefined()
  })

  it('clears the disconnected mark when a later fetch succeeds', () => {
    const cards = [card({ taskId: 'task-a' })]
    const lost = applyPanelListResult({ items: cards }, { ok: false, error: 'offline' })
    const recovered = applyPanelListResult({ items: lost.items }, { ok: true, items: [card({ taskId: 'task-b' })] })
    expect(recovered.link).toBe('live')
    expect(recovered.error).toBeUndefined()
    expect(recovered.items?.[0]?.taskId).toBe('task-b')
    expect(panelLinkNote(recovered)).toBeUndefined()
  })
})
