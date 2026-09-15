/**
 * The worktree snapshot against a **real** repository (PRD §二.4, T07).
 *
 * The snapshot is the one starting state that has to *reproduce* something rather than merely
 * check something out, and its rules are mostly prohibitions: the source directory, its branch
 * and its index are untouched; staged and unstaged changes stay distinguishable; ignored files,
 * credentials and nested repositories are never copied; nothing is committed or stashed on the
 * user's behalf.
 *
 * A prohibition is only tested by showing the thing did not happen, so this builds a repository
 * that contains one of each forbidden thing and then compares the source before and after, and
 * the snapshot's own `git status` against the source's.
 *
 * **It skips itself when `git` is not on the PATH.** A skip is reported as a skip, not a pass.
 */

import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createWorktree,
  planStart,
  readRepoState,
  type GitResult,
  type GitRunner,
  type SnapshotIo,
} from '../src/service/git.ts'

/**
 * A runner that supports `stdin`, which `git apply -` needs.
 *
 * `execFile` cannot feed a patch in, and shelling out to `sh -c` would put a shell between the
 * arguments and git — the exact thing the adapter forbids.
 */
const git: GitRunner = {
  run(args, cwd, options): Promise<GitResult> {
    return new Promise(resolve => {
      const child = spawn('git', [...args], { cwd, windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', error => { resolve({ ok: false, stdout, stderr: String(error) }) })
      child.on('close', code => { resolve({ ok: code === 0, stdout, stderr, code: code ?? undefined }) })
      if (options?.stdin !== undefined) child.stdin.end(options.stdin)
      else child.stdin.end()
    })
  },
}

/** The real filesystem, adapted to the port the snapshot uses. */
const io: SnapshotIo = {
  async pathType(path) {
    const info = await lstat(path).catch(() => undefined)
    return info === undefined ? undefined : info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
  },
  async contains(root, path) {
    const rel = relative(await realpath(root), await realpath(path))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  },
  async list(dir) {
    const { readdir, stat } = await import('node:fs/promises')
    try {
      const stats = await stat(dir)
      if (!stats.isDirectory()) return undefined
      return await readdir(dir)
    } catch {
      return undefined
    }
  },
  async exists(path) {
    const { stat } = await import('node:fs/promises')
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
  async copyFile(from, to) {
    const { copyFile, mkdir } = await import('node:fs/promises')
    await mkdir(to.slice(0, Math.max(to.lastIndexOf('/'), to.lastIndexOf('\\'))), { recursive: true })
    await copyFile(from, to)
  },
}

/** Whether a real git is available; a skip is honest, a failure would not be. */
const available = await git.run(['--version'], process.cwd()).then(result => result.ok).catch(() => false)

describe.skipIf(!available)('the worktree snapshot (PRD §二.4)', () => {
  let root = ''
  let repo = ''

  /** A reading of the source that any snapshot must leave byte-identical. */
  const sourceReading = async (): Promise<{ head: string; status: string; contents: string }> => ({
    head: (await git.run(['rev-parse', 'HEAD'], repo)).stdout.trim(),
    status: (await git.run(['status', '--porcelain'], repo)).stdout,
    contents: (await Promise.all(
      ['a.txt', 'b.txt', 'c.txt', 'chosen.txt'].map(async name =>
        `${name}=${await readFile(join(repo, name), 'utf8').catch(() => '<absent>')}`),
    )).join('|'),
  })

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'conductor-snapshot-'))
    repo = join(root, 'repo')
    await mkdir(repo, { recursive: true })
    await git.run(['init', '--initial-branch=main'], repo)
    await git.run(['config', 'user.email', 'verify@example.invalid'], repo)
    await git.run(['config', 'user.name', 'verify'], repo)
    await git.run(['config', 'core.autocrlf', 'false'], repo)
    await writeFile(join(repo, 'a.txt'), 'one\n', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'two\n', 'utf8')
    await writeFile(join(repo, 'c.txt'), 'three\n', 'utf8')
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n', 'utf8')
    await git.run(['add', '.'], repo)
    await git.run(['commit', '-m', 'initial'], repo)

    // One of each kind of change, so the split has something real to preserve:
    // a.txt staged only, b.txt unstaged only, c.txt staged and then unstaged again.
    await writeFile(join(repo, 'a.txt'), 'one staged\n', 'utf8')
    await git.run(['add', 'a.txt'], repo)
    await writeFile(join(repo, 'b.txt'), 'two unstaged\n', 'utf8')
    await writeFile(join(repo, 'c.txt'), 'three staged\n', 'utf8')
    await git.run(['add', 'c.txt'], repo)
    await writeFile(join(repo, 'c.txt'), 'three staged then unstaged\n', 'utf8')

    // And one of each forbidden untracked thing.
    await writeFile(join(repo, 'chosen.txt'), 'new\n', 'utf8')
    await writeFile(join(repo, 'ignored.txt'), 'secret local state\n', 'utf8')
    await writeFile(join(repo, '.env'), 'TOKEN=hunter2\n', 'utf8')
    await mkdir(join(repo, 'nested'), { recursive: true })
    await git.run(['init', '--initial-branch=main'], join(repo, 'nested'))
  })

  afterAll(async () => {
    if (root.length > 0) await rm(root, { recursive: true, force: true })
  })

  it('keeps the staged and unstaged sides apart in the reading', async () => {
    const state = await readRepoState(git, repo)
    expect([...(state?.stagedPaths ?? [])].sort()).toEqual(['a.txt', 'c.txt'])
    expect([...(state?.unstagedPaths ?? [])].sort()).toEqual(['b.txt', 'c.txt'])
  })

  it('replays the changes, preserving the split, without touching the source', async () => {
    const target = join(root, 'snapshot')
    const before = await sourceReading()

    const planned = await planStart(git, {
      strategy: 'worktree_snapshot',
      repoPath: repo,
      worktreePath: target,
      untrackedPaths: ['chosen.txt'],
    })
    expect(planned.ok, planned.ok ? '' : planned.reason).toBe(true)
    if (!planned.ok) return

    const created = await createWorktree(git, planned.plan, { io, untrackedPaths: ['chosen.txt'] })
    expect(created.ok, created.ok ? '' : created.reason).toBe(true)
    if (!created.ok) return
    expect(created.snapshot?.stagedPaths).toBe(2)
    expect(created.snapshot?.unstagedPaths).toBe(2)
    expect(created.snapshot?.untrackedPaths).toEqual(['chosen.txt'])

    // The baseline is the pinned commit, and the replayed changes sit on top of it exactly the
    // way they did in the source: same tracked porcelain, therefore same split.
    //
    // Compared on tracked lines only, because the untracked lines are *supposed* to differ: the
    // source has `.env`, `ignored.txt` and `nested/` sitting untracked, and the whole point is
    // that the snapshot does not.
    const trackedLines = (porcelain: string): string =>
      porcelain.split('\n').filter(line => line.startsWith('M') || line.startsWith('A') || line.startsWith('D')).join('\n')
    const snapshotStatus = (await git.run(['status', '--porcelain'], target)).stdout
    expect(trackedLines(snapshotStatus)).toBe(trackedLines(before.status))
    expect(snapshotStatus.split('\n').filter(line => line.startsWith('??')))
      .toEqual(['?? chosen.txt'])
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('one staged\n')
    expect(await readFile(join(target, 'b.txt'), 'utf8')).toBe('two unstaged\n')
    expect(await readFile(join(target, 'c.txt'), 'utf8')).toBe('three staged then unstaged\n')

    // The distinction itself, not just the aggregate: b.txt is unstaged, so its *index* still
    // holds the committed text while its working tree holds the edit.
    expect((await git.run(['show', ':b.txt'], target)).stdout).toBe('two\n')
    expect((await git.run(['show', ':a.txt'], target)).stdout).toBe('one staged\n')
    expect((await git.run(['show', ':c.txt'], target)).stdout).toBe('three staged\n')

    // The chosen untracked file came across; the forbidden ones did not.
    expect(await readFile(join(target, 'chosen.txt'), 'utf8')).toBe('new\n')
    expect(await readFile(join(target, 'ignored.txt'), 'utf8').then(() => 'present', () => 'absent'))
      .toBe('absent')
    expect(await readFile(join(target, '.env'), 'utf8').then(() => 'present', () => 'absent'))
      .toBe('absent')

    // Nothing was committed or stashed on the user's behalf, in either directory.
    expect((await git.run(['rev-parse', 'HEAD'], target)).stdout.trim()).toBe(before.head)
    expect((await git.run(['stash', 'list'], repo)).stdout.trim()).toBe('')
    expect(await sourceReading()).toEqual(before)
  })

  it('refuses an ignored path rather than copying it', async () => {
    const target = join(root, 'snapshot-ignored')
    const planned = await planStart(git, {
      strategy: 'worktree_snapshot',
      repoPath: repo,
      worktreePath: target,
      untrackedPaths: ['ignored.txt'],
    })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const created = await createWorktree(git, planned.plan, { io, untrackedPaths: ['ignored.txt'] })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toMatch(/ignored by this repository/)
  })

  it('refuses a credential-shaped path rather than copying it', async () => {
    const target = join(root, 'snapshot-env')
    const planned = await planStart(git, {
      strategy: 'worktree_snapshot',
      repoPath: repo,
      worktreePath: target,
      untrackedPaths: ['.env'],
    })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const created = await createWorktree(git, planned.plan, { io, untrackedPaths: ['.env'] })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toMatch(/credential-shaped/)
  })

  it('refuses a nested repository rather than copying its contents', async () => {
    const target = join(root, 'snapshot-nested')
    const planned = await planStart(git, {
      strategy: 'worktree_snapshot',
      repoPath: repo,
      worktreePath: target,
      untrackedPaths: ['nested'],
    })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const created = await createWorktree(git, planned.plan, { io, untrackedPaths: ['nested'] })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toMatch(/nested Git repository/)
  })

  it('refuses a tracked path, whose committed copy the snapshot already holds', async () => {
    const target = join(root, 'snapshot-tracked')
    const planned = await planStart(git, {
      strategy: 'worktree_snapshot',
      repoPath: repo,
      worktreePath: target,
      untrackedPaths: ['a.txt'],
    })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const created = await createWorktree(git, planned.plan, { io, untrackedPaths: ['a.txt'] })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toMatch(/is tracked by Git/)
  })

  it('refuses to copy chosen untracked paths when no filesystem port was supplied', async () => {
    // Absent is not the same as empty: the snapshot must not report success having copied
    // nothing, which is what skipping the copy silently would do.
    const target = join(root, 'snapshot-noport')
    const planned = await planStart(git, {
      strategy: 'worktree_snapshot',
      repoPath: repo,
      worktreePath: target,
      untrackedPaths: ['chosen.txt'],
    })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const created = await createWorktree(git, planned.plan, { untrackedPaths: ['chosen.txt'] })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toMatch(/no filesystem port was supplied/)
  })

  it('rejects ignored descendants of an explicitly chosen directory', async () => {
    await mkdir(join(repo, 'bundle'), { recursive: true })
    await writeFile(join(repo, 'bundle', 'ignored.txt'), 'private local state\n')
    const target = join(root, 'snapshot-descendant-ignore')
    const planned = await planStart(git, { strategy: 'worktree_snapshot', repoPath: repo, worktreePath: target })
    if (!planned.ok) throw new Error(planned.reason)
    const created = await createWorktree(git, planned.plan, { io, untrackedPaths: ['bundle'] })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toContain('ignored')
    expect(await readFile(join(target, 'bundle', 'ignored.txt')).then(() => true, () => false)).toBe(false)
  })

  it('rejects a chosen directory link before following it out of the repository', async () => {
    const external = join(root, 'external')
    await mkdir(external)
    await writeFile(join(external, 'private.txt'), 'private external data')
    await symlink(external, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const target = join(root, 'snapshot-symlink')
    const planned = await planStart(git, { strategy: 'worktree_snapshot', repoPath: repo, worktreePath: target })
    if (!planned.ok) throw new Error(planned.reason)
    const created = await createWorktree(git, planned.plan, { io, untrackedPaths: ['linked'] })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toContain('symbolic link')
    expect(await readFile(join(target, 'linked', 'private.txt')).then(() => true, () => false)).toBe(false)
  })

  it('detects byte changes in an already-dirty tracked path even when porcelain is identical', async () => {
    const target = join(root, 'snapshot-content-race')
    const original = await readFile(join(repo, 'b.txt'), 'utf8')
    const racing: GitRunner = {
      async run(args, cwd, options) {
        const result = await git.run(args, cwd, options)
        if (args[0] === 'worktree' && args[1] === 'add' && result.ok) {
          await writeFile(join(repo, 'b.txt'), 'same dirty path, different bytes\n')
        }
        return result
      },
    }
    try {
      const planned = await planStart(racing, { strategy: 'worktree_snapshot', repoPath: repo, worktreePath: target })
      if (!planned.ok) throw new Error(planned.reason)
      const created = await createWorktree(racing, planned.plan, { io })
      expect(created.ok).toBe(false)
      if (created.ok) return
      expect(created.reason).toContain('source content changed')
      expect(created.leftoverPath).toBe(target)
    } finally {
      await writeFile(join(repo, 'b.txt'), original)
    }
  })

  it('detects changes to a selected untracked file after it was copied', async () => {
    const target = join(root, 'snapshot-untracked-content-race')
    const original = await readFile(join(repo, 'chosen.txt'), 'utf8')
    const racingIo: SnapshotIo = {
      ...io,
      async copyFile(from, to, roots) {
        await io.copyFile(from, to, roots)
        await writeFile(from, 'untracked source changed after copy\n')
      },
    }
    try {
      const planned = await planStart(git, { strategy: 'worktree_snapshot', repoPath: repo, worktreePath: target })
      if (!planned.ok) throw new Error(planned.reason)
      const created = await createWorktree(git, planned.plan, { io: racingIo, untrackedPaths: ['chosen.txt'] })
      expect(created.ok).toBe(false)
      if (created.ok) return
      expect(created.reason).toContain('source content changed')
    } finally {
      await writeFile(join(repo, 'chosen.txt'), original)
    }
  })
})
