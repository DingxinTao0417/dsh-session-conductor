/**
 * Git starting states and worktrees (PRD §二.4).
 *
 * The specification requires the conductor to prepare a **real** Git starting state before a
 * coding task begins, and its rules are mostly about what the preparation must not do to the
 * user's repository. Five of them decide the shape of this module:
 *
 * 1. **A worktree, from a pinned commit.** The default strategy resolves the repository's
 *    current HEAD to an exact commit and creates the worktree from that commit, so what the
 *    task starts from is a fact rather than "whatever HEAD is when the session opens".
 * 2. **The source is never modified** — not its working tree, not its branch, not its index.
 *    Nothing here runs anything that could: no commit, no stash, no checkout, no reset.
 * 3. **HEAD and the file state are captured before and after**, and a change between them
 *    aborts the preparation rather than producing a worktree from a state nobody described.
 * 4. **Failure does not fall back to the original directory.** PRD §二.4 says so outright,
 *    and it is the rule that stops a preparation failure from quietly running the task in the
 *    user's own working tree.
 * 5. **A snapshot preserves the staged/unstaged distinction.** "Rebuild the committed content
 *    plus uncommitted modifications" is not one bucket: which changes were staged is part of
 *    the state, and a snapshot that merges them has changed the work it was copying.
 *
 * ## The adapter
 *
 * PRD §二.4 says worktrees are created "by a new Git adapter", and this environment has none:
 * the Host's filesystem service has no git surface and no shell service, so both facts were
 * recorded as gaps in earlier rounds. {@link GitPort} is that adapter — it runs `git` for
 * read-only queries and for the worktree operation itself, and **nothing here is a general
 * shell**: every command is a fixed literal with arguments this module constructs.
 *
 * @module dsh-session-conductor/service/git
 */

import { START_STRATEGIES, type StartStrategy } from '../domain/state.ts'

/**
 * The Git starting states of PRD §二.4, re-exported for this module's callers.
 *
 * Six rows in the specification's table, and all six are reachable: the four strategies that
 * pin a commit, the user's own directory, and a plain task directory for work that has no
 * repository at all. Leaving the last two out would make `target`'s `existing` and
 * `directory` kinds unreachable — a type that promises states no code can produce.
 *
 * The list itself is `src/domain/state.ts`'s, so what the store persists and what this adapter
 * can prepare are the same six names.
 */
export { START_STRATEGIES, type StartStrategy }

/** One command's outcome. */
export interface GitResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  /** Exit code, or undefined when the process could not be started at all. */
  readonly code?: number | undefined
}

/**
 * Runs one `git` invocation.
 *
 * Injected so every decision here is testable without a repository, and so the only place
 * that actually spawns a process is the caller's.
 */
export interface GitRunner {
  /**
   * Run `git` with these arguments in this directory.
   * @param args - the arguments, never a shell string.
   * @param cwd - the directory to run in.
   * @param options - `stdin` feeds the process's standard input, which `git apply -` needs.
   * @returns the outcome.
   */
  run(args: readonly string[], cwd: string, options?: { readonly stdin?: string }): Promise<GitResult>
}

/**
 * The filesystem effects a worktree snapshot needs.
 *
 * A port rather than direct `node:fs`, for the same reason `GitRunner` is one: the plugin's own
 * file access goes through the Host's filesystem service, and the recursion, the refusals and
 * the "never copy this" rules stay here where they can be tested without touching a disk.
 *
 * Deliberately byte-level: `copyFile` moves one file's bytes so an untracked binary survives,
 * and `list` returns `undefined` — rather than an empty array — when the path is not a readable
 * directory, so "an empty directory" and "not a directory" stay different answers.
 */
export interface SnapshotIo {
  /** Inspect a path without following its final symbolic link. */
  pathType(path: string): Promise<'file' | 'directory' | 'symlink' | 'other' | undefined>
  /** Canonical containment in the filesystem provider's execution world. */
  contains(root: string, path: string): Promise<boolean>
  /**
   * List a directory's entry names.
   * @param dir - the directory.
   * @returns the names, or undefined when it is not a readable directory.
   */
  list(dir: string): Promise<readonly string[] | undefined>
  /**
   * Test whether a path exists.
   * @param path - the path.
   * @returns true when something is there.
   */
  exists(path: string): Promise<boolean>
  /**
   * Copy one file's bytes, creating the destination's parent directory.
   * @param from - the source file.
   * @param to - the destination file.
   */
  copyFile(from: string, to: string, roots?: { readonly source: string; readonly target: string }): Promise<void>
}

/** The facts a starting-state decision needs about one repository. */
export interface RepoState {
  readonly repoPath: string
  /** The commit HEAD resolves to, when the directory is a repository. */
  readonly head?: string | undefined
  /** The branch HEAD is on, when it is on one. */
  readonly branch?: string | undefined
  /** Whether the working tree has changes, from `git status --porcelain`. */
  readonly dirty: boolean
  /** Paths changed in the working tree, from the same command. */
  readonly changedPaths: readonly string[]
  /**
   * The changed paths whose **index** differs from HEAD — what a snapshot must stage.
   *
   * Split from `unstagedPaths` because PRD §二.4 requires the snapshot to preserve the
   * distinction, and a snapshot that only had `changedPaths` could not: the two are applied by
   * different `git apply` modes, and collapsing them would silently commit half the user's work
   * into the snapshot's index.
   */
  readonly stagedPaths: readonly string[]
  /** The changed paths whose working tree differs from the index. */
  readonly unstagedPaths: readonly string[]
}

/** What preparation decided. */
export interface StartPlan {
  readonly strategy: StartStrategy
  /** The exact commit the task will start from. */
  readonly commit: string
  readonly sourcePath: string
  /** Where the work will run: a new worktree, the existing directory, or a plain directory. */
  readonly target:
    | { readonly kind: 'worktree'; readonly path: string; readonly branch: string }
    | { readonly kind: 'existing'; readonly path: string }
    | { readonly kind: 'directory'; readonly path: string }
  readonly notes: readonly string[]
}

/** Why preparation could not be planned. */
export type StartPlanResult =
  | { readonly ok: true; readonly plan: StartPlan }
  | { readonly ok: false; readonly reason: string }

/** Read the state of one repository. */
export async function readRepoState(git: GitRunner, repoPath: string): Promise<RepoState | undefined> {
  const inside = await git.run(['rev-parse', '--is-inside-work-tree'], repoPath)
  if (!inside.ok || inside.stdout.trim() !== 'true') return undefined

  const head = await git.run(['rev-parse', 'HEAD'], repoPath)
  const branch = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
  // `--porcelain` is the stable machine format; the human `status` wording changes between
  // versions and would make "dirty" depend on the installed git.
  const status = await git.run(['status', '--porcelain'], repoPath)
  if (!status.ok) return undefined
  // `--porcelain` lines are `XY <path>`: X is the index-versus-HEAD state, Y the
  // working-tree-versus-index state, and a `.` or a space means "unchanged on that side".
  const entries = status.ok
    ? status.stdout.split('\n').filter(line => line.trim().length > 0)
    : []
  const pathOf = (line: string): string => line.slice(3).trim()
  const changedPaths = entries.map(pathOf).filter(line => line.length > 0)
  const stagedPaths = entries
    .filter(line => !' .?'.includes(line[0] ?? ' '))
    .map(pathOf)
    .filter(line => line.length > 0)
  const unstagedPaths = entries
    .filter(line => !' .?'.includes(line[1] ?? ' '))
    .map(pathOf)
    .filter(line => line.length > 0)
  return {
    repoPath,
    ...head.ok ? { head: head.stdout.trim() } : {},
    ...branch.ok && branch.stdout.trim() !== 'HEAD' ? { branch: branch.stdout.trim() } : {},
    dirty: changedPaths.length > 0,
    changedPaths,
    stagedPaths,
    unstagedPaths,
  }
}

/**
 * Whether a handoff target's working tree is a clean git baseline (PRD §二.10.2).
 *
 * The specification requires the target directory to pass a baseline check and an
 * existing-modification check. A dirty tree is a conflict: the handoff must stop
 * rather than automatically clean it. A directory that is not a git working tree
 * has no git baseline to refuse, which is a different fact from "could not check".
 */
export type TargetTreeInspection =
  | { readonly kind: 'not_a_repo' }
  | { readonly kind: 'clean'; readonly head?: string }
  | { readonly kind: 'dirty'; readonly head?: string; readonly changedPaths: readonly string[] }
  | { readonly kind: 'unreadable'; readonly reason: string }

/**
 * Inspect a handoff target's git working tree.
 *
 * @param git - the runner.
 * @param path - the target directory.
 * @returns the inspection, never inventing a clean tree when `status` did not confirm.
 */
export async function inspectTargetWorkingTree(
  git: GitRunner,
  path: string,
): Promise<TargetTreeInspection> {
  const inside = await git.run(['rev-parse', '--is-inside-work-tree'], path)
  if (!inside.ok) {
    return /not a git repository/i.test(inside.stderr)
      ? { kind: 'not_a_repo' }
      : { kind: 'unreadable', reason: inside.stderr.trim() || 'the repository probe did not confirm' }
  }
  if (inside.stdout.trim() !== 'true') return { kind: 'not_a_repo' }
  const head = await git.run(['rev-parse', 'HEAD'], path)
  const status = await git.run(['status', '--porcelain'], path)
  if (!status.ok) {
    return { kind: 'unreadable', reason: status.stderr.trim() || 'git status did not confirm' }
  }
  const changedPaths = status.stdout
    .split('\n')
    .map(line => line.slice(3).trim())
    .filter(entry => entry.length > 0)
  const pinned = head.ok ? { head: head.stdout.trim() } : {}
  if (changedPaths.length > 0) {
    return { kind: 'dirty', ...pinned, changedPaths }
  }
  return { kind: 'clean', ...pinned }
}

/**
 * Resolve the repository's default branch, if it can be determined locally.
 *
 * PRD §二.4: "解析并固定本地已知默认分支提交；**无法确定时要求选择**" — resolve it when it is
 * locally knowable, and ask when it is not. The candidates are checked in that order and the
 * absence of all of them is a refusal, not a guess: picking `main` because it is the common
 * name is exactly the silent substitution the rule forbids.
 *
 * @param git - the runner.
 * @param repoPath - the repository.
 * @returns the default branch name, or undefined when it cannot be determined.
 */
export async function resolveDefaultBranch(git: GitRunner, repoPath: string): Promise<string | undefined> {
  const symbolic = await git.run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath)
  if (symbolic.ok && symbolic.stdout.trim().length > 0) {
    // `origin/HEAD` points at the remote's default branch; strip the remote prefix.
    return symbolic.stdout.trim().replace(/^[^/]+\//, '')
  }
  for (const candidate of ['main', 'master']) {
    const exists = await git.run(['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], repoPath)
    if (exists.ok) return candidate
  }
  return undefined
}

/** What the caller asked for. */
export interface StartRequest {
  readonly strategy: StartStrategy
  /** The repository the task starts from, for the strategies that need one. */
  readonly repoPath?: string | undefined
  /** A user-given ref, for `specific_rev`. */
  readonly rev?: string | undefined
  /** An existing directory the user explicitly chose. */
  readonly existingPath?: string | undefined
  /** Where a worktree would be created. */
  readonly worktreePath?: string | undefined
  /** The branch name for a new worktree. */
  readonly branch?: string | undefined
  /**
   * Untracked paths the user explicitly chose to carry into a snapshot.
   *
   * Empty by default, because PRD §二.4 says untracked files are copied only when the user
   * chooses them — and credentials and ignored files are never copied.
   */
  readonly untrackedPaths?: readonly string[] | undefined
}

/**
 * Plan a Git starting state.
 *
 * Read-only apart from the planning: nothing here creates a worktree, and every path that
 * decides *whether* one may be created is a query.
 *
 * @param git - the runner.
 * @param request - what the caller asked for.
 * @returns the plan, or the reason preparation is refused.
 */
export async function planStart(git: GitRunner, request: StartRequest): Promise<StartPlanResult> {
  if (request.strategy === 'specific_rev') {
    if (request.repoPath === undefined) return { ok: false, reason: 'a specific revision needs the repository it is in' }
    const state = await readRepoState(git, request.repoPath)
    if (state === undefined) {
      return { ok: false, reason: `${request.repoPath} is not a Git working tree, so it has no revisions to pin` }
    }
    if (request.rev === undefined || request.rev.trim().length === 0) {
      return { ok: false, reason: 'the specific-revision strategy needs the reference to pin' }
    }
    // The user's reference is validated and the **actual commit** is pinned: a branch name
    // moves, and a task that recorded "main" has recorded nothing it can be held to.
    const resolved = await git.run(['rev-parse', '--verify', `${request.rev}^{commit}`], request.repoPath)
    if (!resolved.ok) {
      return {
        ok: false,
        reason: `${request.rev} does not resolve to a commit in ${request.repoPath}, so the starting state is not `
          + `a fact and nothing was prepared. git said: ${resolved.stderr.trim() || 'no such revision'}`,
      }
    }
    return { ok: true, plan: await worktreePlan(request, resolved.stdout.trim(), state) }
  }

  if (request.strategy === 'default_branch') {
    if (request.repoPath === undefined) return { ok: false, reason: 'the default-branch strategy needs the repository' }
    const state = await readRepoState(git, request.repoPath)
    if (state === undefined) return { ok: false, reason: `${request.repoPath} is not a Git working tree` }
    const branch = await resolveDefaultBranch(git, request.repoPath)
    if (branch === undefined) {
      return {
        ok: false,
        reason: `the default branch of ${request.repoPath} cannot be determined locally: there is no origin/HEAD and `
          + 'neither main nor master exists. The specification requires a choice here rather than a guess, because '
          + 'picking the common name would silently start the task from the wrong commit.',
      }
    }
    const resolved = await git.run(['rev-parse', '--verify', `${branch}^{commit}`], request.repoPath)
    if (!resolved.ok) {
      return { ok: false, reason: `the default branch ${branch} does not resolve to a commit in ${request.repoPath}` }
    }
    return {
      ok: true,
      plan: await worktreePlan(request, resolved.stdout.trim(), state, [`the default branch ${branch} was resolved locally and pinned to a commit`]),
    }
  }

  if (request.strategy === 'worktree_snapshot') {
    if (request.repoPath === undefined) return { ok: false, reason: 'a worktree snapshot needs the source repository' }
    const before = await readRepoState(git, request.repoPath)
    if (before === undefined) return { ok: false, reason: `${request.repoPath} is not a Git working tree` }
    if (before.head === undefined) {
      return { ok: false, reason: `${request.repoPath} has no commit, so there is no committed content to rebuild` }
    }
    return {
      ok: true,
      plan: {
        strategy: 'worktree_snapshot',
        commit: before.head,
        sourcePath: request.repoPath,
        target: {
          kind: 'worktree',
          path: request.worktreePath ?? `${request.repoPath}.snapshot`,
          branch: request.branch ?? 'conductor/snapshot',
        },
        notes: [
          `the snapshot rebuilds the committed content at ${before.head} in a private directory and then replays `
          + `the working tree's own changes: ${String(before.stagedPaths.length)} staged and `
          + `${String(before.unstagedPaths.length)} unstaged path(s)`,
          'the staged changes are applied to the snapshot index and the unstaged ones only to its working tree, so '
          + 'the snapshot preserves the distinction the source had',
          'the source directory, its branch and its index are not modified: the snapshot is built in a separate '
          + 'directory, and nothing here commits, stashes, checks out or resets',
          `untracked paths are copied only when the user chose them: ${(request.untrackedPaths ?? []).length === 0
            ? 'none were chosen' : (request.untrackedPaths ?? []).join(', ')}`,
          'ignored files, credentials and nested repositories are never copied: a chosen path that is one of those '
          + 'is refused by name rather than copied',
        ],
      },
    }
  }

  if (request.strategy === 'current_head') {
    if (request.repoPath === undefined) return { ok: false, reason: 'the current-HEAD strategy needs the repository' }
    const state = await readRepoState(git, request.repoPath)
    if (state === undefined) return { ok: false, reason: `${request.repoPath} is not a Git working tree` }
    if (state.head === undefined) {
      return {
        ok: false,
        reason: `${request.repoPath} has no commit yet, so there is no HEAD to start from. An empty repository has no `
          + 'starting state to pin, and preparing one anyway would mean inventing it.',
      }
    }
    const notes: string[] = []
    if (state.dirty) {
      notes.push(
        `the working tree has ${String(state.changedPaths.length)} uncommitted change(s). The worktree is created `
        + `from the commit ${state.head}, so those changes are NOT carried into the task — this is stated rather than `
        + 'left to be discovered, and the source is not cleaned to make the two match',
      )
    }
    return { ok: true, plan: await worktreePlan(request, state.head, state, notes) }
  }

  if (request.strategy === 'existing_directory') {
    if (request.existingPath === undefined) {
      return {
        ok: false,
        reason: 'this strategy needs the directory the user explicitly chose. Without one there is no starting state, '
          + 'and the conductor does not substitute a new directory for a choice the user did not make.',
      }
    }
    return {
      ok: true,
      plan: {
        strategy: 'existing_directory',
        commit: '',
        sourcePath: request.existingPath,
        target: { kind: 'existing', path: request.existingPath },
        notes: ['the user explicitly chose this directory, so no worktree was created and nothing was copied'],
      },
    }
  }

  // `task_directory`: no repository and no directory chosen, so the work gets its own.
  const path = request.existingPath ?? request.worktreePath
  if (path === undefined) {
    return {
      ok: false,
      reason: 'a task directory needs a path to create; the caller supplies one and the conductor does not invent a '
        + 'location the user will not know about',
    }
  }
  return {
    ok: true,
    plan: {
      strategy: 'task_directory',
      commit: '',
      sourcePath: path,
      target: { kind: 'directory', path },
      notes: [
        'this task has no Git repository, so it starts in its own directory with no starting commit',
        'creating the directory is the caller\'s step: nothing here writes to the filesystem',
      ],
    },
  }
}

/**
 * Build a worktree plan from a pinned commit.
 *
 * @param request - the caller's request.
 * @param commit - the commit to start from.
 * @param state - the source repository's state.
 * @param notes - notes gathered so far.
 * @returns the plan.
 */
async function worktreePlan(
  request: StartRequest,
  commit: string,
  state: RepoState,
  notes: readonly string[] = [],
): Promise<StartPlan> {
  const path = request.worktreePath ?? `${state.repoPath}.conductor`
  return {
    strategy: request.strategy,
    commit,
    sourcePath: state.repoPath,
    target: { kind: 'worktree', path, branch: request.branch ?? `conductor/${commit.slice(0, 12)}` },
    notes: [
      ...notes,
      `the task starts from the pinned commit ${commit}, not from the branch name`,
      `the source directory ${state.repoPath} is left exactly as it is: its working tree, branch and index are not touched`,
    ],
  }
}

/** What creating a worktree produced. */
export type WorktreeResult =
  | {
    readonly ok: true
    readonly path: string
    readonly commit: string
    /** What a snapshot replayed; absent for the strategies that only check out a commit. */
    readonly snapshot?: {
      readonly stagedPaths: number
      readonly unstagedPaths: number
      readonly untrackedPaths: readonly string[]
    }
  }
  | {
    readonly ok: false
    readonly reason: string
    /**
     * Set when `git worktree add` succeeded and a later check refused the result.
     *
     * The directory is on disk and was not removed (PRD §二.4, §三.6). Cleanup is
     * how it leaves; the path is here so the registry can record it.
     */
    readonly leftoverPath?: string
  }

/**
 * Path fragments that are never copied into a snapshot, whatever the user chose.
 *
 * PRD §二.4 rules out credentials categorically, and a rule the user cannot override upward is
 * exactly the shape needed here: choosing a path cannot be consent to copy a private key, so the
 * refusal names the file and the user renames it or copies it deliberately.
 */
const CREDENTIAL_PATH_PATTERN =
  /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.git-credentials|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|pfx|p12|keystore|jks))$/i

/** Templates that look like credential files but exist to be committed. */
const CREDENTIAL_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template'])

/** Why a chosen untracked path will not be copied. */
type UntrackedRefusal = { readonly ok: false; readonly reason: string }
/** A chosen untracked path that will be copied. */
type UntrackedAcceptance = { readonly ok: true; readonly files: readonly string[] }

interface SnapshotSource {
  readonly staged: string
  readonly unstaged: string
  readonly untracked: readonly { readonly path: string; readonly hash: string }[]
}

/** Capture the actual content, because status paths alone do not identify a snapshot. */
async function captureSnapshotSource(
  git: GitRunner,
  plan: StartPlan,
  io: SnapshotIo | undefined,
  paths: readonly string[],
): Promise<SnapshotSource> {
  const staged = await git.run(['diff', '--cached', '--binary', '--no-color', 'HEAD'], plan.sourcePath)
  const unstaged = await git.run(['diff', '--binary', '--no-color'], plan.sourcePath)
  if (!staged.ok || !unstaged.ok) throw new Error('the source working-tree changes could not be read')
  if (paths.length > 0 && io === undefined) throw new Error('untracked paths were chosen but no filesystem port was supplied')
  const files = new Set<string>()
  for (const path of paths) {
    const accepted = await acceptUntracked(git, io as SnapshotIo, plan.sourcePath, path)
    if (!accepted.ok) throw new Error(accepted.reason)
    for (const file of accepted.files) files.add(file)
  }
  const untracked: { path: string; hash: string }[] = []
  for (const file of [...files].sort()) {
    const hashed = await git.run(['hash-object', '--', file], plan.sourcePath)
    if (!hashed.ok || !/^[0-9a-f]{40,64}$/i.test(hashed.stdout.trim())) {
      throw new Error(`the selected untracked file ${file} could not be hashed`)
    }
    untracked.push({ path: file, hash: hashed.stdout.trim() })
  }
  return { staged: staged.stdout, unstaged: unstaged.stdout, untracked }
}

/**
 * Decide whether one explicitly chosen untracked path may be copied.
 *
 * The checks are the three categorical ones from PRD §二.4 — ignored, credential-shaped, nested
 * repository — plus "is it actually untracked", because copying a tracked path would overwrite
 * the snapshot's own checkout of that path with the source's edited copy and quietly defeat the
 * committed baseline.
 *
 * @param git - the runner.
 * @param io - the filesystem port.
 * @param sourcePath - the source repository.
 * @param relative - the caller-chosen path, relative to the source root.
 * @returns the files to copy, or the reason this path is refused.
 */
async function acceptUntracked(
  git: GitRunner,
  io: SnapshotIo,
  sourcePath: string,
  relative: string,
): Promise<UntrackedRefusal | UntrackedAcceptance> {
  relative = relative.replace(/\\/g, '/')
  const segments = relative.split('/')
  if (relative.trim().length === 0 || relative.startsWith('/') || relative.includes(':') || relative.includes('\0')
    || segments.some(part => part === '..' || part === '.' || part === '' || part.toLowerCase() === '.git')) {
    return { ok: false, reason: `${relative} is not a repository-relative path, so it is not copied` }
  }
  const absolute = `${sourcePath}/${relative}`
  for (let count = 1; count <= segments.length; count += 1) {
    const prefix = `${sourcePath}/${segments.slice(0, count).join('/')}`
    if (await io.pathType(prefix) === 'symlink') {
      return { ok: false, reason: `${relative} passes through a symbolic link, so snapshot copying is refused` }
    }
  }
  if (!await io.contains(sourcePath, absolute)) {
    return { ok: false, reason: `${relative} resolves outside the source repository, so it is not copied` }
  }
  if (!await io.exists(absolute)) {
    return { ok: false, reason: `${relative} does not exist in ${sourcePath}, so there is nothing to copy` }
  }
  const ignored = await git.run(['check-ignore', '--quiet', '--', relative], sourcePath)
  if (ignored.ok) {
    return {
      ok: false,
      reason: `${relative} is ignored by this repository's rules, and PRD §二.4 never copies ignored files: `
        + 'they routinely hold local state and secrets, so it is refused rather than copied',
    }
  }
  if (ignored.code !== 1) {
    return { ok: false, reason: `${relative}: Git could not establish whether this path is ignored, so it is not copied` }
  }
  const base = relative.split('/').pop() ?? relative
  if (CREDENTIAL_PATH_PATTERN.test(relative) && !CREDENTIAL_TEMPLATES.has(base)) {
    return {
      ok: false,
      reason: `${relative} is credential-shaped, and PRD §二.4 never copies credentials. Choosing a path is not `
        + 'consent to copy a private key or an environment file; copy it yourself if it is genuinely needed',
    }
  }
  const tracked = await git.run(['ls-files', '--error-unmatch', '--', relative], sourcePath)
  if (tracked.ok) {
    return {
      ok: false,
      reason: `${relative} is tracked by Git, so the snapshot already holds the committed version of it; copying the `
        + 'source copy over it would replace the pinned baseline with uncommitted content',
    }
  }
  const entries = await io.list(absolute)
  if (entries === undefined) {
    return { ok: true, files: [relative] }
  }
  if (entries.includes('.git')) {
    return {
      ok: false,
      reason: `${relative} contains a nested Git repository, and PRD §二.4 does not copy nested repository contents: `
        + 'its history, remotes and credentials belong to that repository, not to this task',
    }
  }
  const files: string[] = []
  const stack = [relative]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const currentPath = `${sourcePath}/${current}`
    const type = await io.pathType(currentPath)
    if (type === 'symlink' || !await io.contains(sourcePath, currentPath)) {
      return { ok: false, reason: `${current} is a symbolic link or leaves the source repository, so the copy is refused` }
    }
    const ignoredChild = await git.run(['check-ignore', '--quiet', '--', current], sourcePath)
    if (ignoredChild.ok || ignoredChild.code !== 1) {
      return { ok: false, reason: `${current} is ignored or its ignore status could not be checked, so the copy is refused` }
    }
    const children = await io.list(`${sourcePath}/${current}`)
    if (children === undefined) {
      if (type !== 'file') return { ok: false, reason: `${current} is not a readable regular file, so the copy is refused` }
      if (CREDENTIAL_PATH_PATTERN.test(current) && !CREDENTIAL_TEMPLATES.has(current.split('/').pop() ?? current)) {
        return { ok: false, reason: `${current} inside the chosen path is credential-shaped, so the copy is refused` }
      }
      files.push(current)
      continue
    }
    if (children.includes('.git')) {
      return {
        ok: false,
        reason: `${current} contains a nested Git repository, so the copy of ${relative} is refused rather than `
          + 'half-done',
      }
    }
    for (const child of children) {
      if (child === '.' || child === '..' || /[\\/:\0]/.test(child) || child.length === 0) {
        return { ok: false, reason: `${current} returned an unsafe directory entry, so the copy is refused` }
      }
      stack.push(`${current}/${child}`)
    }
  }
  return { ok: true, files }
}

/**
 * Replay the source's own changes into a freshly created snapshot worktree.
 *
 * The two patches are applied by different modes on purpose: `--index` writes the staged patch
 * into both the snapshot's index and working tree, while the unstaged patch is applied to the
 * working tree alone. That is what makes the snapshot's `git status` read like the source's.
 *
 * @param git - the runner.
 * @param plan - the snapshot plan.
 * @returns what was replayed, or the reason it could not be.
 */
async function materialiseSnapshot(
  git: GitRunner,
  plan: StartPlan,
  io: SnapshotIo | undefined,
  untrackedPaths: readonly string[],
  captured: SnapshotSource,
): Promise<
  | { readonly ok: true; readonly stagedPaths: number; readonly unstagedPaths: number; readonly untrackedPaths: readonly string[] }
  | { readonly ok: false; readonly reason: string }
> {
  const stagedText = captured.staged
  const unstagedText = captured.unstaged
  if (stagedText.trim().length > 0) {
    const applied = await git.run(
      ['apply', '--index', '--whitespace=nowarn', '-'],
      plan.target.path,
      { stdin: stagedText },
    )
    if (!applied.ok) {
      return {
        ok: false,
        reason: `staged changes could not be replayed into the snapshot: ${applied.stderr.trim() || 'git refused'}. `
          + 'The snapshot is NOT used as the task directory, because it would silently miss work the user had staged.',
      }
    }
  }
  if (unstagedText.trim().length > 0) {
    const applied = await git.run(
      ['apply', '--whitespace=nowarn', '-'],
      plan.target.path,
      { stdin: unstagedText },
    )
    if (!applied.ok) {
      return {
        ok: false,
        reason: `unstaged changes could not be replayed into the snapshot: ${applied.stderr.trim() || 'git refused'}. `
          + 'The snapshot is NOT used as the task directory, because it would silently miss uncommitted work.',
      }
    }
  }
  if (untrackedPaths.length === 0) {
    return {
      ok: true,
      stagedPaths: countPatched(stagedText),
      unstagedPaths: countPatched(unstagedText),
      untrackedPaths: [],
    }
  }
  if (io === undefined) {
    return {
      ok: false,
      reason: `${String(untrackedPaths.length)} untracked path(s) were chosen but no filesystem port was supplied, so `
        + 'they cannot be copied. Nothing was copied rather than some of it.',
    }
  }
  const copied: string[] = []
  for (const relative of untrackedPaths) {
    const accepted = await acceptUntracked(git, io, plan.sourcePath, relative)
    if (!accepted.ok) return { ok: false, reason: accepted.reason }
    for (const file of accepted.files) {
      try {
        await io.copyFile(`${plan.sourcePath}/${file}`, `${plan.target.path}/${file}`, {
          source: plan.sourcePath, target: plan.target.path,
        })
      } catch (error) {
        // The Host's filesystem service has no byte-write primitive, so a copy is text-only: a
        // binary file is refused by name here rather than copied as mojibake or truncated.
        return {
          ok: false,
          reason: `${file} could not be copied into the snapshot: `
            + `${error instanceof Error ? error.message : String(error)}. The snapshot is NOT used as the task `
            + 'directory, because using it would silently omit a file the user asked to carry.',
        }
      }
      copied.push(file)
    }
  }
  return {
    ok: true,
    stagedPaths: countPatched(stagedText),
    unstagedPaths: countPatched(unstagedText),
    untrackedPaths: copied,
  }
}

/**
 * Count the files a unified diff touches.
 * @param patch - the diff text.
 * @returns how many `diff --git` headers it has.
 */
function countPatched(patch: string): number {
  return patch.split('\n').filter(line => line.startsWith('diff --git ')).length
}

/**
 * Create the worktree a plan describes, and confirm the source did not move.
 *
 * The before/after check is PRD §二.4's: HEAD and the file state are captured around the
 * operation, and a change between them means the worktree describes a state nobody was told
 * about — so it is reported as a conflict instead of being used.
 *
 * @param git - the runner.
 * @param plan - the plan.
 * @param options - the filesystem port a snapshot needs, and the untracked paths the user chose.
 * @returns the created worktree's path and commit, or the reason nothing was created.
 */
export async function createWorktree(
  git: GitRunner,
  plan: StartPlan,
  options: { readonly io?: SnapshotIo | undefined; readonly untrackedPaths?: readonly string[] | undefined } = {},
): Promise<WorktreeResult> {
  if (plan.target.kind !== 'worktree') {
    return { ok: false, reason: `this plan does not create a worktree (${plan.target.kind})` }
  }
  const before = await readRepoState(git, plan.sourcePath)
  if (before === undefined) return { ok: false, reason: `${plan.sourcePath} is no longer a Git working tree` }
  let sourceSnapshot: SnapshotSource | undefined
  if (plan.strategy === 'worktree_snapshot') {
    try {
      sourceSnapshot = await captureSnapshotSource(git, plan, options.io, options.untrackedPaths ?? [])
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // `--detach` is deliberate: the worktree is pinned to the commit, so no branch is created,
  // moved, or left checked out on the user's behalf.
  const created = await git.run(
    ['worktree', 'add', '--detach', plan.target.path, plan.commit],
    plan.sourcePath,
  )
  if (!created.ok) {
    return {
      ok: false,
      reason: `creating the worktree failed, so the task does not run anywhere: ${created.stderr.trim() || 'git refused'}. `
        + 'It is NOT run in the source directory instead.',
    }
  }

  // The snapshot is materialised **inside** the before/after window, so a source that changed
  // while its changes were being replayed is caught by the same comparison.
  let snapshot: { stagedPaths: number; unstagedPaths: number; untrackedPaths: readonly string[] } | undefined
  if (sourceSnapshot !== undefined) {
    const materialised = await materialiseSnapshot(git, plan, options.io, options.untrackedPaths ?? [], sourceSnapshot)
    if (!materialised.ok) {
      return { ok: false, reason: materialised.reason, leftoverPath: plan.target.path }
    }
    snapshot = materialised
    try {
      const afterSnapshot = await captureSnapshotSource(git, plan, options.io, options.untrackedPaths ?? [])
      if (JSON.stringify(sourceSnapshot) !== JSON.stringify(afterSnapshot)
        || [...materialised.untrackedPaths].sort().join('\0') !== sourceSnapshot.untracked.map(file => file.path).join('\0')) {
        return {
          ok: false,
          reason: 'the source content changed while the snapshot was being created, even if Git status lists the same paths; the snapshot is not used',
          leftoverPath: plan.target.path,
        }
      }
    } catch (error) {
      return {
        ok: false, reason: `the source content could not be rechecked: ${error instanceof Error ? error.message : String(error)}`,
        leftoverPath: plan.target.path,
      }
    }
  }

  const after = await readRepoState(git, plan.sourcePath)
  if (after === undefined || after.head !== before.head || after.dirty !== before.dirty
    || after.changedPaths.join('\n') !== before.changedPaths.join('\n')
    || after.stagedPaths.join('\n') !== before.stagedPaths.join('\n')
    || after.unstagedPaths.join('\n') !== before.unstagedPaths.join('\n')) {
    // A conflict rather than a cleanup: the worktree may be perfectly good, but the source
    // moved while it was being made, so nothing downstream can claim what it was made from.
    return {
      ok: false,
      reason: `the source repository changed while the worktree was being created (HEAD ${String(before.head)} → `
        + `${String(after?.head)}, ${String(before.changedPaths.length)} → ${String(after?.changedPaths.length)} `
        + 'changed path(s)), so the preparation is reported as a conflict. The worktree was not removed and nothing '
        + 'was prepared from it.',
      leftoverPath: plan.target.path,
    }
  }
  return {
    ok: true,
    path: plan.target.path,
    commit: plan.commit,
    ...snapshot === undefined ? {} : { snapshot },
  }
}

/**
 * Remove a worktree this conductor created (PRD §三.6, T32).
 *
 * `--force` is deliberately absent: a dirty tree is a user modification, and
 * the specification refuses to delete those. Git's own refusal is the signal
 * that the directory is not clean enough to go, and forcing past it would be
 * the automatic delete the default exists to prevent.
 *
 * @param git - the runner.
 * @param sourcePath - the repository the worktree was added to.
 * @param worktreePath - the worktree directory.
 * @returns ok when git removed it, or the reason nothing was forced.
 */
export async function removeWorktree(
  git: GitRunner,
  sourcePath: string,
  worktreePath: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const removed = await git.run(['worktree', 'remove', worktreePath], sourcePath)
  if (!removed.ok) {
    return {
      ok: false,
      reason: `git refused to remove the worktree at ${worktreePath}: ${removed.stderr.trim() || 'git refused'}. `
        + 'Nothing was forced and nothing else was deleted.',
    }
  }
  return { ok: true }
}
