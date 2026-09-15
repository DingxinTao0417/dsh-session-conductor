import { describe, expect, it } from 'vitest'
import {
  applyTaskListFilter,
  describeTaskListFilter,
  pageOf,
  sortTaskList,
  type TaskListRow,
} from '../src/service/taskfilter.ts'

/** A row with the fields every filter can ask about. */
function row(over: Partial<TaskListRow> = {}): TaskListRow {
  return {
    taskId: 'task-1',
    title: 'Fix the parser',
    preparation: 'ready',
    archived: false,
    pinned: false,
    updatedAt: '2026-09-13T00:00:00.000Z',
    controllerSessionId: 'session-controller',
    ...over,
  }
}

describe('the task-list filters of PRD §二.5', () => {
  it('constrains nothing when the filter says nothing', () => {
    const rows = [row({ taskId: 'task-1' }), row({ taskId: 'task-2', archived: true })]
    // An absent filter and a filter nobody set must not mean different things — the recurring way a list
    // silently narrows.
    expect(applyTaskListFilter(rows)).toHaveLength(2)
    expect(applyTaskListFilter(rows, {})).toHaveLength(2)
  })

  it('narrows by project and name, case-insensitively and as substrings', () => {
    const rows = [
      row({ taskId: 'task-1', title: 'Fix the Parser', project: 'D:\\work\\Alpha' }),
      row({ taskId: 'task-2', title: 'Write the docs', project: 'D:\\work\\beta' }),
      row({ taskId: 'task-3', title: 'Fix the lexer', project: 'D:\\work\\alpha-tools' }),
      row({ taskId: 'task-4', title: 'No project at all' }),
    ]
    expect(applyTaskListFilter(rows, { name: 'fix' }).map(r => r.taskId)).toEqual(['task-1', 'task-3'])
    expect(applyTaskListFilter(rows, { project: 'alpha' }).map(r => r.taskId)).toEqual(['task-1', 'task-3'])
    expect(applyTaskListFilter(rows, { project: 'ALPHA', name: 'LEXER' }).map(r => r.taskId)).toEqual(['task-3'])
    // A row that cannot answer the filter does not match it: a caller filtering by project asked for tasks
    // in a project, and an absent project is not "unknown, so include it".
    expect(applyTaskListFilter(rows, { project: '' }).map(r => r.taskId)).not.toContain('task-4')
  })

  it('narrows by Host and status, which the task record alone cannot answer', () => {
    const rows = [
      row({ taskId: 'task-1', hostId: 'host-a', status: 'running' }),
      row({ taskId: 'task-2', hostId: 'host-a', status: 'idle' }),
      row({ taskId: 'task-3', hostId: 'host-b', status: 'waiting_user' }),
      // No binding means no Host and no badge: this row can satisfy neither filter.
      row({ taskId: 'task-4' }),
    ]
    expect(applyTaskListFilter(rows, { hostId: 'host-a' }).map(r => r.taskId)).toEqual(['task-1', 'task-2'])
    expect(applyTaskListFilter(rows, { status: 'idle' }).map(r => r.taskId)).toEqual(['task-2'])
    expect(applyTaskListFilter(rows, { hostId: 'host-a', status: 'running' }).map(r => r.taskId)).toEqual(['task-1'])
    expect(applyTaskListFilter(rows, { status: 'released' })).toEqual([])
  })

  it('keeps the filters it already had, and combines them with the new ones', () => {
    const rows = [
      row({ taskId: 'task-1', preparation: 'ready', archived: false, pinned: true, groupId: 'g1' }),
      row({ taskId: 'task-2', preparation: 'failed', archived: false, pinned: true, groupId: 'g1' }),
      row({ taskId: 'task-3', preparation: 'ready', archived: true, pinned: false, groupId: 'g2' }),
      row({ taskId: 'task-4', preparation: 'ready', controllerSessionId: 'session-other', title: 'Other' }),
    ]
    expect(applyTaskListFilter(rows, { controllerSessionId: 'session-controller' }).map(r => r.taskId))
      .toEqual(['task-1', 'task-2', 'task-3'])
    // task-4 is 'ready' and unarchived too — a different controller is not what this filter asks about — so
    // it belongs in this answer, and writing the expectation without it is how a test quietly narrows.
    expect(applyTaskListFilter(rows, { preparation: 'ready', archived: false }).map(r => r.taskId))
      .toEqual(['task-1', 'task-4'])
    expect(applyTaskListFilter(rows, { groupId: 'g1', pinned: true }).map(r => r.taskId)).toEqual(['task-1', 'task-2'])
    // A value the caller supplies is compared exactly, including the empty string: "group is the empty
    // string" is a filter a caller can ask for, and it must not be silently treated as "no filter".
    expect(applyTaskListFilter(rows, { groupId: '' })).toEqual([])
  })

  it('preserves the order it was given, so the caller keeps its newest-first ordering', () => {
    const rows = [row({ taskId: 'task-3' }), row({ taskId: 'task-1' }), row({ taskId: 'task-2' })]
    expect(applyTaskListFilter(rows, { preparation: 'ready' }).map(r => r.taskId))
      .toEqual(['task-3', 'task-1', 'task-2'])
  })

  it('names the filters in force, so a narrowed total cannot be read as the whole list', () => {
    expect(describeTaskListFilter({})).toBe('')
    expect(describeTaskListFilter({ project: 'alpha', status: 'idle' }))
      .toBe('project contains "alpha", status = idle')
    expect(describeTaskListFilter({ archived: false, name: 'parser', hostId: 'host-a' }))
      .toBe('archived = false, name contains "parser", host = host-a')
  })
})

describe('pinned-first sort and pagination (PRD §二.5 置顶及排序, §三.3 分页)', () => {
  it('puts pinned tasks first, then newest, and breaks ties by id', () => {
    const rows = [
      row({ taskId: 'task-old-unpinned', pinned: false, updatedAt: '2026-09-01T00:00:00.000Z' }),
      row({ taskId: 'task-new-unpinned', pinned: false, updatedAt: '2026-09-13T00:00:00.000Z' }),
      row({ taskId: 'task-old-pinned', pinned: true, updatedAt: '2026-08-01T00:00:00.000Z' }),
      row({ taskId: 'task-new-pinned', pinned: true, updatedAt: '2026-09-12T00:00:00.000Z' }),
      row({ taskId: 'task-same-a', pinned: true, updatedAt: '2026-09-12T00:00:00.000Z' }),
    ]
    expect(sortTaskList(rows).map(r => r.taskId)).toEqual([
      'task-new-pinned',
      'task-same-a',
      'task-old-pinned',
      'task-new-unpinned',
      'task-old-unpinned',
    ])
  })

  it('does not mutate the input', () => {
    const rows = [
      row({ taskId: 'b', pinned: false, updatedAt: '2026-09-13T00:00:00.000Z' }),
      row({ taskId: 'a', pinned: true, updatedAt: '2026-09-01T00:00:00.000Z' }),
    ]
    const sorted = sortTaskList(rows)
    expect(sorted.map(r => r.taskId)).toEqual(['a', 'b'])
    expect(rows.map(r => r.taskId)).toEqual(['b', 'a'])
  })

  it('pages by offset and limit, and treats a negative offset as the start', () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    expect(pageOf(items, 0, 2)).toEqual({ items: ['a', 'b'], offset: 0, limit: 2, total: 5, returned: 2 })
    expect(pageOf(items, 2, 2)).toEqual({ items: ['c', 'd'], offset: 2, limit: 2, total: 5, returned: 2 })
    expect(pageOf(items, 4, 2)).toEqual({ items: ['e'], offset: 4, limit: 2, total: 5, returned: 1 })
    expect(pageOf(items, 20, 2)).toEqual({ items: [], offset: 20, limit: 2, total: 5, returned: 0 })
    expect(pageOf(items, -3, 2).offset).toBe(0)
    expect(pageOf(items, 0, -1)).toEqual({ items: [], offset: 0, limit: 0, total: 5, returned: 0 })
  })
})
