import { describe, expect, it } from 'vitest'
import {
  cleanupDecision,
  describeCleanupPreview,
  normalizePath,
  planCleanupExecute,
  samePath,
  underPath,
  worktreeResourceId,
  type CleanupPreviewItem,
} from '../src/service/cleanup.ts'
import { DEFAULTS } from '../src/domain/defaults.ts'
import { removeWorktree, type GitResult, type GitRunner } from '../src/service/git.ts'

/** A runner over a fixed answer table, recording what it was asked. */
function runner(answers: Record<string, Partial<GitResult>>) {
  const asked: string[] = []
  const git: GitRunner = {
    async run(args) {
      const key = args.join(' ')
      asked.push(key)
      const answer = answers[key]
      if (answer === undefined) return { ok: false, stdout: '', stderr: `no answer for ${key}`, code: 128 }
      return { ok: answer.ok ?? true, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', code: answer.code ?? 0 }
    },
  }
  return { git, asked }
}

/** One preview row, with the members a test cares about. */
function item(over: Partial<CleanupPreviewItem> = {}): CleanupPreviewItem {
  return {
    resourceId: 'worktree:task-1',
    kind: 'worktree',
    path: 'D:/work/app.conductor',
    taskId: 'task-1',
    createdReason: 'Git starting state current_head created an independent worktree from aaaa',
    status: 'active',
    owned: true,
    referenced: false,
    referencedBy: [],
    retention: 'D:/work/app.conductor',
    tree: 'clean',
    eligible: true,
    condition: 'plugin-owned, unreferenced, and the working tree is clean',
    ...over,
  }
}

describe('path identity (PRD §三.6)', () => {
  it('treats separators, trailing slashes and case as the same directory', () => {
    expect(samePath('D:\\work\\app.conductor', 'd:/work/app.conductor/')).toBe(true)
    expect(normalizePath('D:\\work\\app.conductor\\')).toBe('d:/work/app.conductor')
  })

  it('treats an artifact inside a worktree as under it', () => {
    expect(underPath('D:/work/app.conductor/src/a.ts', 'D:/work/app.conductor')).toBe(true)
    expect(underPath('D:/work/app.conductor', 'D:/work/app.conductor')).toBe(true)
    expect(underPath('D:/work/other/src/a.ts', 'D:/work/app.conductor')).toBe(false)
  })

  it('keys a worktree on the task that created it, so a retry overwrites one row', () => {
    expect(worktreeResourceId('task-1')).toBe('worktree:task-1')
  })

  it('resolves dot segments before checking retained artifact references', () => {
    expect(underPath('D:/work/other/../app.conductor/report.md', 'D:/work/app.conductor')).toBe(true)
    expect(samePath('D:/work/app.conductor/./', 'D:/work/app.conductor')).toBe(true)
    expect(underPath('D:/work/app.conductor/../other/report.md', 'D:/work/app.conductor')).toBe(false)
  })

  it('keeps POSIX case and root path identity intact', () => {
    expect(samePath('/work/App', '/work/app')).toBe(false)
    expect(normalizePath('/')).toBe('/')
    expect(underPath('/work/report.md', '/')).toBe(true)
  })
})

describe('whether one resource may be cleaned (PRD §三.6, T32)', () => {
  it('allows a plugin-owned, unreferenced, clean tree', () => {
    const decision = cleanupDecision({
      owned: true,
      alreadyCleaned: false,
      referencedBy: [],
      tree: 'clean',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toMatch(/plugin-owned, unreferenced, and the working tree is clean/)
  })

  it('refuses a directory the conductor did not create', () => {
    const decision = cleanupDecision({
      owned: false,
      alreadyCleaned: false,
      referencedBy: [],
      tree: 'clean',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/not plugin-owned/)
  })

  it('refuses a directory a task or artifact still references', () => {
    const decision = cleanupDecision({
      owned: true,
      alreadyCleaned: false,
      referencedBy: ['task task-1 (current working directory)'],
      tree: 'clean',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/still referenced/)
    expect(decision.reason).toMatch(/task-1/)
  })

  it('refuses user modifications rather than forcing them', () => {
    const decision = cleanupDecision({
      owned: true,
      alreadyCleaned: false,
      referencedBy: [],
      tree: 'modified',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/user modifications/)
  })

  it('refuses unknown contents rather than deleting what it cannot inspect', () => {
    const decision = cleanupDecision({
      owned: true,
      alreadyCleaned: false,
      referencedBy: [],
      tree: 'unknown',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/unknown/)
  })

  it('allows a missing directory only to mark the record, deleting nothing', () => {
    const decision = cleanupDecision({
      owned: true,
      alreadyCleaned: false,
      referencedBy: [],
      tree: 'missing',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toMatch(/already gone/)
    expect(decision.reason).toMatch(/deletes nothing/)
  })

  it('refuses a resource that was already cleaned, keeping the record', () => {
    const decision = cleanupDecision({
      owned: true,
      alreadyCleaned: true,
      referencedBy: [],
      tree: 'missing',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/already cleaned/)
  })
})

describe('the execute gate (PRD §三.6, §四.7)', () => {
  it('refuses an execute that was not confirmed, and says nothing was deleted', () => {
    const gate = planCleanupExecute({ confirmed: false, selectedIds: ['worktree:task-1'] })
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.reason).toMatch(/not automatic/)
    expect(gate.reason).toMatch(/Nothing was deleted/)
  })

  it('refuses a confirmed execute with no selection', () => {
    const gate = planCleanupExecute({ confirmed: true, selectedIds: [] })
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.reason).toMatch(/explicit selection/)
  })

  it('opens only for a confirmed, named selection', () => {
    expect(planCleanupExecute({ confirmed: true, selectedIds: ['worktree:task-1'] })).toEqual({ ok: true })
  })

  it('ships with automatic deletion off', () => {
    expect(DEFAULTS.autoDeleteResources).toBe(false)
  })
})

describe('the preview text (PRD §三.6)', () => {
  it('says there is nothing to preview when the registry is empty', () => {
    expect(describeCleanupPreview([])).toMatch(/No plugin-owned resource is registered/)
    expect(describeCleanupPreview([])).toMatch(/do not delete/)
  })

  it('names eligibility rather than implying a delete', () => {
    const text = describeCleanupPreview([
      item(),
      item({
        resourceId: 'worktree:task-2',
        eligible: false,
        condition: 'still referenced by task task-2 (current working directory)',
      }),
    ])
    expect(text).toMatch(/2 plugin-owned resource\(s\), 1 eligible/)
    expect(text).toMatch(/worktree:task-1 \(worktree\).*eligible/)
    expect(text).toMatch(/worktree:task-2 \(worktree\).*refused/)
  })
})

describe('removing a worktree (PRD §三.6)', () => {
  it('asks git to remove without --force', async () => {
    const { git, asked } = runner({
      'worktree remove D:/work/app.conductor': { stdout: '' },
    })
    const removed = await removeWorktree(git, 'D:/work/app', 'D:/work/app.conductor')
    expect(removed.ok).toBe(true)
    expect(asked).toEqual(['worktree remove D:/work/app.conductor'])
    expect(asked.some(command => command.includes('--force'))).toBe(false)
  })

  it('reports git\'s refusal rather than forcing a dirty tree', async () => {
    const { git } = runner({
      'worktree remove D:/work/app.conductor': {
        ok: false,
        stderr: 'fatal: \'/work/app.conductor\' contains modified or untracked files, use --force to delete it',
      },
    })
    const removed = await removeWorktree(git, 'D:/work/app', 'D:/work/app.conductor')
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.reason).toMatch(/git refused/)
    expect(removed.reason).toMatch(/Nothing was forced/)
    expect(removed.reason).toMatch(/modified or untracked/)
  })
})
