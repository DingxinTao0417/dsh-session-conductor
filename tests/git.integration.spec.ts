/**
 * The Git adapter against a **real** repository (PRD §二.4, T07).
 *
 * `tests/git.spec.ts` drives an injected runner, so it proves the *decisions*. This proves
 * the adapter's actual `git` invocations work: that `--porcelain` parses, that
 * `worktree add --detach` creates what was planned, and above all that the source repository
 * is unchanged by a preparation.
 *
 * It builds its own scratch repository under the system temporary directory and creates its
 * own worktree there, so no user repository is involved and nothing outside the scratch tree
 * is written. Every run removes the tree it made.
 *
 * **It skips itself when `git` is not on the PATH**, so the suite does not depend on a build
 * tool being installed — a skip is reported as a skip, not as a pass.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createWorktree,
  planStart,
  readRepoState,
  resolveDefaultBranch,
  type GitRunner,
  type WorktreeResult,
} from '../src/service/git.ts'

const run = promisify(execFile)

/** The adapter under test: real git, fixed arguments, no shell. */
const git: GitRunner = {
  async run(args, cwd) {
    try {
      const { stdout, stderr } = await run('git', [...args], { cwd, windowsHide: true })
      return { ok: true, stdout, stderr, code: 0 }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number }
      return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error), code: failure.code }
    }
  },
}

/** Whether a real git is available; a skip is honest, a failure would not be. */
const available = await git.run(['--version'], process.cwd()).then(result => result.ok).catch(() => false)

describe.skipIf(!available)('the Git adapter against a real repository (PRD §二.4)', () => {
  let root = ''
  let repo = ''
  let worktree = ''

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'conductor-git-'))
    repo = join(root, 'repo')
    worktree = join(root, 'repo.conductor')
    await mkdir(repo, { recursive: true })
    await git.run(['init', '--initial-branch=main'], repo)
    await git.run(['config', 'user.email', 'verify@example.invalid'], repo)
    await git.run(['config', 'user.name', 'verify'], repo)
    await writeFile(join(repo, 'tracked.txt'), 'committed\n', 'utf8')
    await git.run(['add', 'tracked.txt'], repo)
    await git.run(['commit', '-m', 'initial'], repo)
  })

  afterAll(async () => {
    if (root.length > 0) await rm(root, { recursive: true, force: true })
  })

  it('reads the branch, the resolved HEAD and a clean tree', async () => {
    const state = await readRepoState(git, repo)
    expect(state?.branch).toBe('main')
    expect(state?.dirty).toBe(false)
    expect(state?.head).toMatch(/^[0-9a-f]{40}$/)
  })

  it('sees uncommitted changes and names them', async () => {
    await writeFile(join(repo, 'tracked.txt'), 'modified\n', 'utf8')
    await writeFile(join(repo, 'untracked.txt'), 'new\n', 'utf8')
    const state = await readRepoState(git, repo)
    expect(state?.dirty).toBe(true)
    expect([...(state?.changedPaths ?? [])].sort()).toEqual(['tracked.txt', 'untracked.txt'])
  })

  it('resolves the default branch locally', async () => {
    // No origin/HEAD in a fresh local repository, so this exercises the fallback.
    expect(await resolveDefaultBranch(git, repo)).toBe('main')
  })

  it('pins the commit and says uncommitted work is not carried', async () => {
    const head = (await git.run(['rev-parse', 'HEAD'], repo)).stdout.trim()
    const planned = await planStart(git, { strategy: 'current_head', repoPath: repo, worktreePath: worktree })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.commit).toBe(head)
    expect(planned.plan.notes.join(' ')).toMatch(/NOT carried into the task/)
  })

  it('creates the worktree without modifying the source', async () => {
    const before = {
      head: (await git.run(['rev-parse', 'HEAD'], repo)).stdout.trim(),
      status: (await git.run(['status', '--porcelain'], repo)).stdout,
      content: await readFile(join(repo, 'tracked.txt'), 'utf8'),
      branch: (await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).stdout.trim(),
    }
    const planned = await planStart(git, { strategy: 'current_head', repoPath: repo, worktreePath: worktree })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const created = await createWorktree(git, planned.plan)
    expect(created.ok, created.ok ? '' : created.reason).toBe(true)
    if (!created.ok) return

    // "Untouched" is a comparison here, not an assurance.
    expect((await git.run(['rev-parse', 'HEAD'], repo)).stdout.trim()).toBe(before.head)
    expect((await git.run(['status', '--porcelain'], repo)).stdout).toBe(before.status)
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe(before.content)
    expect((await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).stdout.trim()).toBe(before.branch)

    // And the worktree holds the committed content, detached at the pinned commit — which is
    // exactly what the plan said would happen, uncommitted changes deliberately absent.
    //
    // Compared against the *committed blob* rather than the bytes this test wrote: on Windows
    // `core.autocrlf` rewrites line endings on checkout, so the worktree file legitimately
    // reads `committed\r\n` where the source working file reads `committed\n`. Comparing raw
    // bytes would conflate "git checked out the commit" with "no normalisation happened", and
    // the discriminator that matters here is committed-content versus uncommitted-change.
    const committedBlob = (await git.run(['show', `${before.head}:tracked.txt`], repo)).stdout
    const inWorktree = await readFile(join(worktree, 'tracked.txt'), 'utf8')
    expect(inWorktree.replace(/\r\n/g, '\n')).toBe(committedBlob.replace(/\r\n/g, '\n'))
    expect(inWorktree).not.toContain('modified')
    const state = await readRepoState(git, worktree)
    expect(state?.head).toBe(before.head)
  })

  it('refuses a worktree path that already exists, without falling back to the source', async () => {
    // The rule that stops a preparation failure from quietly running the task in the user's
    // own working tree.
    const planned = await planStart(git, { strategy: 'current_head', repoPath: repo, worktreePath: worktree })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const created: WorktreeResult = await createWorktree(git, planned.plan)
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toMatch(/NOT run in the source directory instead/)
  })
})
