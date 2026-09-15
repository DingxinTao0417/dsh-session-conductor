import { describe, expect, it } from 'vitest'
import {
  START_STRATEGIES,
  createWorktree,
  planStart,
  readRepoState,
  resolveDefaultBranch,
  inspectTargetWorkingTree,
  type GitResult,
  type GitRunner,
  type StartPlan,
} from '../src/service/git.ts'

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

/** A repository at HEAD with a clean tree. */
function cleanRepo(over: Record<string, Partial<GitResult>> = {}) {
  return runner({
    'rev-parse --is-inside-work-tree': { stdout: 'true\n' },
    'rev-parse HEAD': { stdout: 'aaaa1111bbbb2222\n' },
    'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
    'status --porcelain': { stdout: '' },
    ...over,
  })
}

/** A plan, with the members a test cares about. */
function plan(over: Partial<StartPlan> = {}): StartPlan {
  return {
    strategy: 'current_head',
    commit: 'aaaa1111bbbb2222',
    sourcePath: 'D:/work/app',
    target: { kind: 'worktree', path: 'D:/work/app.conductor', branch: 'conductor/aaaa1111bbbb' },
    notes: [],
    ...over,
  }
}

describe('reading a repository (PRD §二.4)', () => {
  it('reads HEAD, the branch and a clean tree', async () => {
    const { git } = cleanRepo()
    const state = await readRepoState(git, 'D:/work/app')
    expect(state).toMatchObject({ head: 'aaaa1111bbbb2222', branch: 'main', dirty: false })
  })

  it('is undefined when the directory is not a working tree', async () => {
    const { git } = runner({ 'rev-parse --is-inside-work-tree': { ok: false, stderr: 'not a git repository' } })
    expect(await readRepoState(git, 'D:/elsewhere')).toBeUndefined()
  })

  it('reports the changed paths from the machine-readable status', async () => {
    // `--porcelain` is stable between git versions; the human wording is not, and "dirty"
    // must not depend on which git is installed.
    const { git } = cleanRepo({ 'status --porcelain': { stdout: ' M src/a.ts\n?? src/new.ts\n' } })
    const state = await readRepoState(git, 'D:/work/app')
    expect(state?.dirty).toBe(true)
    expect(state?.changedPaths).toEqual(['src/a.ts', 'src/new.ts'])
  })

  it('omits the branch when HEAD is detached', async () => {
    const { git } = cleanRepo({ 'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' } })
    expect((await readRepoState(git, 'D:/work/app'))?.branch).toBeUndefined()
  })

  it('does not describe an unreadable status as a clean source', async () => {
    const { git } = cleanRepo({ 'status --porcelain': { ok: false, stderr: 'permission denied', code: 128 } })
    expect(await readRepoState(git, 'D:/work/app')).toBeUndefined()
  })
})

describe('resolving the default branch (PRD §二.4)', () => {
  it('prefers origin/HEAD and strips the remote prefix', async () => {
    const { git } = runner({
      'symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/develop\n' },
    })
    expect(await resolveDefaultBranch(git, 'D:/work/app')).toBe('develop')
  })

  it('falls back to main, then master', async () => {
    const main = runner({ 'show-ref --verify --quiet refs/heads/main': { stdout: '' } })
    expect(await resolveDefaultBranch(main.git, 'D:/work/app')).toBe('main')

    const master = runner({
      'show-ref --verify --quiet refs/heads/main': { ok: false, code: 1 },
      'show-ref --verify --quiet refs/heads/master': { stdout: '' },
    })
    expect(await resolveDefaultBranch(master.git, 'D:/work/app')).toBe('master')
  })

  it('returns undefined rather than guessing when it cannot be determined locally', async () => {
    const none = runner({
      'symbolic-ref --short refs/remotes/origin/HEAD': { ok: false, code: 1 },
      'show-ref --verify --quiet refs/heads/main': { ok: false, code: 1 },
      'show-ref --verify --quiet refs/heads/master': { ok: false, code: 1 },
    })
    expect(await resolveDefaultBranch(none.git, 'D:/work/app')).toBeUndefined()
  })
})

describe('planning a starting state (PRD §二.4)', () => {
  it('pins the exact commit for the current-HEAD strategy', async () => {
    const { git } = cleanRepo()
    const result = await planStart(git, { strategy: 'current_head', repoPath: 'D:/work/app' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.commit).toBe('aaaa1111bbbb2222')
    expect(result.plan.target).toMatchObject({ kind: 'worktree', path: 'D:/work/app.conductor' })
    expect(result.plan.notes.join(' ')).toMatch(/not from the branch name/)
    expect(result.plan.notes.join(' ')).toMatch(/working tree, branch and index are not touched/)
  })

  it('states that uncommitted changes are NOT carried into the worktree', async () => {
    // Stated rather than left to be discovered, and the source is not cleaned to make the two
    // match.
    const { git } = cleanRepo({ 'status --porcelain': { stdout: ' M src/a.ts\n' } })
    const result = await planStart(git, { strategy: 'current_head', repoPath: 'D:/work/app' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.notes.join(' ')).toMatch(/those changes are NOT carried into the task/)
    expect(result.plan.notes.join(' ')).toMatch(/the source is not cleaned/)
  })

  it('refuses an empty repository, which has no starting state to pin', async () => {
    const { git } = cleanRepo({ 'rev-parse HEAD': { ok: false, stderr: 'unknown revision' } })
    const result = await planStart(git, { strategy: 'current_head', repoPath: 'D:/work/app' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/no commit yet/)
    expect(result.reason).toMatch(/would mean inventing it/)
  })

  it('refuses the default-branch strategy when it cannot be determined, rather than guessing', async () => {
    const { git } = cleanRepo({
      'symbolic-ref --short refs/remotes/origin/HEAD': { ok: false, code: 1 },
      'show-ref --verify --quiet refs/heads/main': { ok: false, code: 1 },
      'show-ref --verify --quiet refs/heads/master': { ok: false, code: 1 },
    })
    const result = await planStart(git, { strategy: 'default_branch', repoPath: 'D:/work/app' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/cannot be determined locally/)
    expect(result.reason).toMatch(/rather than a guess/)
  })

  it('pins the resolved commit for the default-branch strategy and says what it resolved', async () => {
    const { git } = cleanRepo({
      'symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/develop\n' },
      'rev-parse --verify develop^{commit}': { stdout: 'cccc3333\n' },
    })
    const result = await planStart(git, { strategy: 'default_branch', repoPath: 'D:/work/app' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.commit).toBe('cccc3333')
    expect(result.plan.notes.join(' ')).toMatch(/default branch develop was resolved locally and pinned to a commit/)
  })

  it('validates a user-given reference and pins the actual commit', async () => {
    // A branch name moves; a task that recorded "feature/x" has recorded nothing it can be
    // held to.
    const { git } = cleanRepo({ 'rev-parse --verify feature/x^{commit}': { stdout: 'dddd4444\n' } })
    const result = await planStart(git, { strategy: 'specific_rev', repoPath: 'D:/work/app', rev: 'feature/x' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.commit).toBe('dddd4444')
  })

  it('refuses a reference that does not resolve, quoting git', async () => {
    const { git } = cleanRepo({
      'rev-parse --verify nope^{commit}': { ok: false, stderr: 'fatal: Needed a single revision' },
    })
    const result = await planStart(git, { strategy: 'specific_rev', repoPath: 'D:/work/app', rev: 'nope' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/does not resolve to a commit/)
    expect(result.reason).toMatch(/fatal: Needed a single revision/)
  })

  it('refuses a specific revision with no reference to pin', async () => {
    const { git } = cleanRepo()
    expect((await planStart(git, { strategy: 'specific_rev', repoPath: 'D:/work/app' })).ok).toBe(false)
  })

  it('describes a worktree snapshot without touching the source', async () => {
    const { git } = cleanRepo({ 'status --porcelain': { stdout: ' M a.ts\n' } })
    const result = await planStart(git, { strategy: 'worktree_snapshot', repoPath: 'D:/work/app' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const notes = result.plan.notes.join(' ')
    // The plan's notes are a promise the creation step has to keep, so they name the mechanism:
    // the staged side goes to the snapshot's index and the unstaged side to its working tree.
    expect(notes).toMatch(/preserves the distinction the source had/)
    expect(notes).toMatch(/applied to the snapshot index and the unstaged ones only to its working tree/)
    // And they count what will be replayed, from the porcelain's two status columns.
    expect(notes).toMatch(/0 staged and 1 unstaged path\(s\)/)
    expect(notes).toMatch(/nothing here commits, stashes, checks out or resets/)
    expect(notes).toMatch(/none were chosen/)
    expect(notes).toMatch(/ignored files, credentials and nested repositories are never copied/)
  })

  it('copies untracked paths only when the user chose them', async () => {
    const { git } = cleanRepo()
    const result = await planStart(git, {
      strategy: 'worktree_snapshot', repoPath: 'D:/work/app', untrackedPaths: ['notes.md'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.notes.join(' ')).toMatch(/notes\.md/)
  })

  it('uses the explicitly chosen directory without creating a worktree', async () => {
    const { git } = cleanRepo()
    const result = await planStart(git, { strategy: 'existing_directory', existingPath: 'D:/work/other' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.target).toEqual({ kind: 'existing', path: 'D:/work/other' })
  })

  it('refuses an existing-directory request that names no directory', async () => {
    const { git } = cleanRepo()
    const result = await planStart(git, { strategy: 'existing_directory' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/does not substitute a new directory for a choice the user did not make/)
  })

  it('plans a plain task directory for work with no repository', async () => {
    const { git } = cleanRepo()
    const result = await planStart(git, { strategy: 'task_directory', existingPath: 'D:/work/task-1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.target.kind).toBe('directory')
    expect(result.plan.commit).toBe('')
    expect(result.plan.notes.join(' ')).toMatch(/nothing here writes to the filesystem/)
  })

  it('makes every declared strategy reachable', async () => {
    // A type that promises states no code can produce is a type that lies. All six rows of
    // PRD §二.4's table are planned here.
    const { git } = cleanRepo({
      'symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/main\n' },
      'rev-parse --verify main^{commit}': { stdout: 'aaaa1111bbbb2222\n' },
      'rev-parse --verify HEAD^{commit}': { stdout: 'aaaa1111bbbb2222\n' },
    })
    for (const strategy of START_STRATEGIES) {
      const result = await planStart(git, {
        strategy,
        repoPath: 'D:/work/app',
        rev: 'HEAD',
        existingPath: 'D:/work/app',
      })
      expect(result.ok, `${strategy} must be plannable`).toBe(true)
    }
  })
})

describe('creating a worktree (PRD §二.4)', () => {
  it('detaches at the pinned commit, so no branch is created on the user’s behalf', async () => {
    const { git, asked } = cleanRepo({
      'worktree add --detach D:/work/app.conductor aaaa1111bbbb2222': { stdout: '' },
    })
    const created = await createWorktree(git, plan())
    expect(created.ok).toBe(true)
    expect(asked).toContain('worktree add --detach D:/work/app.conductor aaaa1111bbbb2222')
    // Nothing that could move the user's repository appears in the commands run.
    expect(asked.some(command => /commit|stash|checkout|reset|clean|push/.test(command))).toBe(false)
  })

  it('does NOT fall back to the source directory when creation fails', async () => {
    // The rule that stops a preparation failure from quietly running the task in the user's
    // own working tree.
    const { git } = cleanRepo({
      'worktree add --detach D:/work/app.conductor aaaa1111bbbb2222': { ok: false, stderr: 'fatal: already exists' },
    })
    const created = await createWorktree(git, plan())
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toMatch(/fatal: already exists/)
    expect(created.reason).toMatch(/It is NOT run in the source directory instead/)
  })

  it('reports a conflict when the source moved while the worktree was being made', async () => {
    // The worktree may be perfectly good, but the source moved, so nothing downstream can
    // claim what it was made from.
    let calls = 0
    const git: GitRunner = {
      async run(args) {
        const key = args.join(' ')
        if (key === 'worktree add --detach D:/work/app.conductor aaaa1111bbbb2222') {
          calls += 1
          return { ok: true, stdout: '', stderr: '', code: 0 }
        }
        if (key === 'rev-parse HEAD') {
          calls += 1
          // The second read sees a different HEAD than the first.
          return { ok: true, stdout: calls === 1 ? 'aaaa1111bbbb2222\n' : 'eeee5555\n', stderr: '', code: 0 }
        }
        if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
        if (key === 'rev-parse --abbrev-ref HEAD') return { ok: true, stdout: 'main\n', stderr: '', code: 0 }
        return { ok: true, stdout: '', stderr: '', code: 0 }
      },
    }
    const created = await createWorktree(git, plan())
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toMatch(/changed while the worktree was being created/)
    expect(created.reason).toMatch(/reported as a conflict/)
    expect(created.reason).toMatch(/The worktree was not removed/)
    expect(created.leftoverPath).toBe('D:/work/app.conductor')
  })

  it('refuses a plan that creates no worktree', async () => {
    const { git } = cleanRepo()
    const created = await createWorktree(git, plan({ target: { kind: 'existing', path: 'D:/work/other' } }))
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toMatch(/does not create a worktree/)
  })
})

describe('inspectTargetWorkingTree (PRD §二.10.2 handoff baseline)', () => {
  it('keeps failed repository probes distinct from a confirmed non-repository', async () => {
    const { git } = runner({ 'rev-parse --is-inside-work-tree': { ok: false, stderr: 'permission denied', code: 128 } })
    expect(await inspectTargetWorkingTree(git, 'D:/target')).toEqual({ kind: 'unreadable', reason: 'permission denied' })
  })
  it('reports a clean tree at HEAD', async () => {
    const { git } = cleanRepo()
    await expect(inspectTargetWorkingTree(git, 'D:/target')).resolves.toEqual({
      kind: 'clean',
      head: 'aaaa1111bbbb2222',
    })
  })

  it('reports dirty paths rather than inventing a clean tree', async () => {
    const { git } = cleanRepo({
      'status --porcelain': { stdout: ' M src/a.ts\n?? new.txt\n' },
    })
    const inspection = await inspectTargetWorkingTree(git, 'D:/target')
    expect(inspection).toEqual({
      kind: 'dirty',
      head: 'aaaa1111bbbb2222',
      changedPaths: ['src/a.ts', 'new.txt'],
    })
  })

  it('treats a directory that is not a git working tree as not_a_repo, not as unreadable', async () => {
    const { git } = runner({
      'rev-parse --is-inside-work-tree': { ok: false, stderr: 'not a git repository', code: 128 },
    })
    await expect(inspectTargetWorkingTree(git, 'D:/plain')).resolves.toEqual({ kind: 'not_a_repo' })
  })

  it('does not invent a clean tree when status does not confirm', async () => {
    const { git } = cleanRepo({
      'status --porcelain': { ok: false, stderr: 'index.lock', code: 128 },
    })
    await expect(inspectTargetWorkingTree(git, 'D:/target')).resolves.toEqual({
      kind: 'unreadable',
      reason: 'index.lock',
    })
  })
})
