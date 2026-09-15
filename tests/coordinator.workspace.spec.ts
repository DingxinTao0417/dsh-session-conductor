/**
 * Git starting states on the create and fork paths (PRD §二.4, T05 and T07).
 *
 * `tests/git.spec.ts` and `tests/git.snapshot.spec.ts` prove the adapter's decisions. This proves
 * the *coordination* rules around them, which is where the specification's sharpest §二.4 rule
 * lives: **a failed preparation must not fall back to the original directory**. That rule is only
 * demonstrated by showing that no session was created in the fallback directory, so every refusal
 * here asserts both the reported reason and the absence of the session that a silent fallback
 * would have produced.
 *
 * The workspace-registry side is here too, because T05 asks for "directory and workspace ownership
 * correct" — which is a claim about what the Host registry was told, not about what the session's
 * `cwd` happens to be.
 */

import { describe, expect, it } from 'vitest'
import { Coordinator, type CoordinatorDeps, type WorkspacePort } from '../src/service/coordinator.ts'
import type { GitResult, GitRunner } from '../src/service/git.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** A source session with one completed turn and one still open. */
const oneAndAHalfTurns: SessionEventLike[] = [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'do it' }] } },
  { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 3, data: { turn: 2 } },
  { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: 'still going' }] } },
]

/**
 * A scripted `git`.
 *
 * Records every invocation so a test can show what was asked of the repository, and answers the
 * read-only queries `planStart` makes. `worktree add` answers from `worktreeAdd` so the failure
 * path is exercised without a real repository.
 */
function scriptedGit(options: { worktreeAdd?: GitResult } = {}) {
  const calls: string[][] = []
  const run: GitRunner['run'] = async (args, _cwd, runOptions) => {
    calls.push([...args])
    const key = args.join(' ')
    if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
    if (key === 'rev-parse HEAD') return { ok: true, stdout: 'a'.repeat(40) + '\n', stderr: '', code: 0 }
    if (key === 'rev-parse --abbrev-ref HEAD') return { ok: true, stdout: 'main\n', stderr: '', code: 0 }
    if (key === 'status --porcelain') return { ok: true, stdout: '', stderr: '', code: 0 }
    if (args[0] === 'worktree' && args[1] === 'add') {
      return options.worktreeAdd ?? { ok: true, stdout: '', stderr: '', code: 0 }
    }
    if (runOptions?.stdin !== undefined) return { ok: true, stdout: '', stderr: '', code: 0 }
    return { ok: true, stdout: '', stderr: '', code: 0 }
  }
  return { run, calls }
}

/** A workspace registry that records what it was told and can refuse either step. */
function scriptedWorkspaces(options: { registerFails?: string; attachFails?: string } = {}) {
  const registrations: { path: string; title: string }[] = []
  const attachments: { workspaceId: string; sessionId: string }[] = []
  const port: WorkspacePort = {
    register: async (path, title) => {
      registrations.push({ path, title })
      if (options.registerFails !== undefined) return { ok: false, reason: options.registerFails }
      return { ok: true, workspaceId: `ws-${String(registrations.length)}` }
    },
    attach: async (workspaceId, sessionId) => {
      attachments.push({ workspaceId, sessionId })
      if (options.attachFails !== undefined) return { ok: false, reason: options.attachFails }
      return { ok: true }
    },
  }
  return { port, registrations, attachments }
}

/** Build a coordinator over in-memory tables, with the Git and workspace ports injected. */
function makeCoordinator(options: {
  git?: GitRunner
  workspaces?: WorkspacePort
} = {}) {
  const tables = createInMemoryTables()
  let tick = Date.parse('2026-09-13T00:00:00.000Z')
  const now = () => new Date((tick += 1000)).toISOString()
  const store = new ConductorStore(tables, now)
  let seq = 0
  const createdOptions: { sessionId: SessionId; seed?: unknown[]; meta?: Record<string, unknown> }[] = []
  const sessions = new Map<string, { header: Record<string, unknown>; events: SessionEventLike[]; seq: number }>()

  const agents = {
    async create(opts: { sessionId: SessionId; seed?: SessionEventLike[]; meta?: Record<string, unknown> }) {
      createdOptions.push(opts as { sessionId: SessionId; seed?: unknown[]; meta?: Record<string, unknown> })
      sessions.set(String(opts.sessionId), {
        header: { id: opts.sessionId, ...opts.meta },
        events: opts.seed ?? [],
        seq: (opts.seed?.length ?? 1) - 1,
      })
      return {
        agent: {
          id: opts.sessionId,
          status: 'idle' as const,
          followup: () => {},
          steer: () => {},
          cancel: () => {},
        },
        dispose: async () => {},
      }
    },
    get: (id: SessionId) => {
      const session = sessions.get(String(id))
      if (session === undefined) return undefined
      return {
        id,
        status: 'idle' as const,
        session,
        followup: () => {},
        steer: () => {},
        cancel: () => {},
      }
    },
    list: () => [],
  }

  const deps: CoordinatorDeps = {
    agents,
    store,
    createMessage: (text, source) => ({ id: `msg-${String(++seq)}`, text, source }),
    newTaskId: () => `task-${String(++seq)}`,
    newSessionId: () => `session-${String(++seq)}`,
    newBindingId: () => `binding-${String(++seq)}`,
    now,
    defaultCwd: () => 'D:\\work',
    ...options.git === undefined ? {} : { git: options.git },
    ...options.workspaces === undefined ? {} : { workspaces: options.workspaces },
  }
  return { coordinator: new Coordinator(deps), store, createdOptions, sessions }
}

describe('create with a Git starting state (PRD §二.4, T07)', () => {
  it('runs the session in the worktree and records the project and the pinned commit', async () => {
    const git = scriptedGit()
    const workspaces = scriptedWorkspaces()
    const made = makeCoordinator({ git, workspaces: workspaces.port })

    const result = await made.coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Fix the parser',
      workspace: { strategy: 'current_head', repoPath: 'D:\\proj', worktreePath: 'D:\\proj.conductor' },
    })

    expect(result.preparation, result.failureReason ?? '').toBe('ready')
    // The session's directory is the worktree, not the project.
    const meta = made.createdOptions[0]?.meta as { cwd?: string } | undefined
    expect(meta?.cwd).toBe('D:\\proj.conductor')
    const binding = made.store.getBinding(made.store.getTask(result.taskId)?.currentBindingId ?? '')
    expect(binding?.cwd).toBe('D:\\proj.conductor')

    // The plugin's own record of where it came from, and what it pinned.
    const task = made.store.getTask(result.taskId)
    expect(task?.originRepoPath).toBe('D:\\proj')
    expect(task?.start).toEqual({ strategy: 'current_head', commit: 'a'.repeat(40), created: true })

    // And the directory was registered as a workspace, with the session attached to it.
    expect(workspaces.registrations).toEqual([{ path: 'D:\\proj.conductor', title: 'Fix the parser' }])
    expect(workspaces.attachments).toEqual([{ workspaceId: 'ws-1', sessionId: result.sessionId }])
    expect(made.store.getTask(result.taskId)?.workspaceId).toBe('ws-1')
    expect(made.store.getTask(result.taskId)?.workspaceFailure).toBeUndefined()

    const resource = made.store.getResource(`worktree:${result.taskId}`)
    expect(resource?.path).toBe('D:\\proj.conductor')
    expect(resource?.owned).toBe(true)
    expect(resource?.status).toBe('active')
    expect(resource?.originRepoPath).toBe('D:\\proj')
    expect(resource?.createdReason).toMatch(/independent worktree/)
  })

  it('does not run the task in the source directory when the worktree cannot be created', async () => {
    // The rule PRD §二.4 states outright. Asserted three ways, because any one of them alone
    // could hold while the task still quietly ran in the user's tree.
    const git = scriptedGit({
      worktreeAdd: { ok: false, stdout: '', stderr: 'fatal: already exists', code: 128 },
    })
    const made = makeCoordinator({ git })

    const result = await made.coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Fix the parser',
      workspace: { strategy: 'current_head', repoPath: 'D:\\proj', worktreePath: 'D:\\proj.conductor' },
    })

    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/NOT run in the source directory instead/)
    // (1) No session exists at all.
    expect(made.createdOptions).toHaveLength(0)
    expect(result.sessionId).toBeUndefined()
    // (2) No binding claims a directory.
    expect(made.store.getTask(result.taskId)?.currentBindingId).toBeUndefined()
    // (3) The failure is recorded on the task record, not only returned.
    expect(made.store.getTask(result.taskId)?.failureReason).toMatch(/NOT run in the source directory instead/)
  })

  it('registers a leftover worktree when preparation refuses after git created it', async () => {
    let added = false
    const git: GitRunner = {
      async run(args) {
        const key = args.join(' ')
        if (key === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', code: 0 }
        if (key === 'rev-parse HEAD') {
          return { ok: true, stdout: `${added ? 'b' : 'a'}`.repeat(40) + '\n', stderr: '', code: 0 }
        }
        if (key === 'rev-parse --abbrev-ref HEAD') return { ok: true, stdout: 'main\n', stderr: '', code: 0 }
        if (key === 'status --porcelain') return { ok: true, stdout: '', stderr: '', code: 0 }
        if (args[0] === 'worktree' && args[1] === 'add') {
          added = true
          return { ok: true, stdout: '', stderr: '', code: 0 }
        }
        return { ok: true, stdout: '', stderr: '', code: 0 }
      },
    }
    const made = makeCoordinator({ git })
    const result = await made.coordinator.createTask({
      operationId: 'op-leftover',
      controllerSessionId: 'controller',
      title: 'leftover worktree',
      workspace: { strategy: 'current_head', repoPath: 'D:\\proj', worktreePath: 'D:\\proj.conductor' },
    })
    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/changed while the worktree was being created/)
    const resource = made.store.getResource(`worktree:${result.taskId}`)
    expect(resource?.path).toBe('D:\\proj.conductor')
    expect(resource?.owned).toBe(true)
    expect(resource?.status).toBe('active')
    expect(resource?.createdReason).toMatch(/refused/)
    expect(made.createdOptions).toHaveLength(0)
  })

  it('does not borrow the caller directory when the starting state cannot be planned', async () => {
    // A directory that is not a working tree: planning refuses, and the refusal must not become
    // "then use the default directory".
    const git: GitRunner = { run: async () => ({ ok: false, stdout: '', stderr: 'not a git repository', code: 128 }) }
    const made = makeCoordinator({ git })

    const result = await made.coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Fix the parser',
      workspace: { strategy: 'current_head', repoPath: 'D:\\not-a-repo' },
    })

    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/is not a Git working tree/)
    expect(made.createdOptions).toHaveLength(0)
  })

  it('refuses a Git starting state when the composition mounts no subprocess service', async () => {
    const made = makeCoordinator()
    const result = await made.coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Fix the parser',
      workspace: { strategy: 'current_head', repoPath: 'D:\\proj' },
    })

    expect(result.preparation).toBe('failed')
    expect(result.failureReason).toMatch(/mounts no subprocess service/)
    expect(result.failureReason).toMatch(/not run in the current directory instead/)
    expect(made.createdOptions).toHaveLength(0)
  })

  it('still prepares the task when no workspace registry is mounted, and says so', async () => {
    // Available-but-unregistered and never-attempted must not look the same.
    const git = scriptedGit()
    const made = makeCoordinator({ git })
    const result = await made.coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Fix the parser',
      workspace: { strategy: 'current_head', repoPath: 'D:\\proj', worktreePath: 'D:\\proj.conductor' },
    })

    expect(result.preparation, result.failureReason ?? '').toBe('ready')
    const task = made.store.getTask(result.taskId)
    expect(task?.workspaceId).toBeUndefined()
    expect(task?.workspaceFailure).toMatch(/mounts no workspace registry/)
    expect(task?.originRepoPath).toBe('D:\\proj')
  })

  it('reports a refused registration rather than claiming the workspace exists', async () => {
    const git = scriptedGit()
    const workspaces = scriptedWorkspaces({ registerFails: 'the path is not a directory' })
    const made = makeCoordinator({ git, workspaces: workspaces.port })
    const result = await made.coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Fix the parser',
      workspace: { strategy: 'current_head', repoPath: 'D:\\proj', worktreePath: 'D:\\proj.conductor' },
    })

    // The task is usable — the session is real and so is the directory — but the gap is recorded.
    expect(result.preparation).toBe('ready')
    const task = made.store.getTask(result.taskId)
    expect(task?.workspaceId).toBeUndefined()
    expect(task?.workspaceFailure).toBe('the path is not a directory')
    expect(workspaces.attachments).toHaveLength(0)
  })

  it('reports a refused attachment while keeping the registration it did get', async () => {
    const git = scriptedGit()
    const workspaces = scriptedWorkspaces({ attachFails: 'the session header has no cwd' })
    const made = makeCoordinator({ git, workspaces: workspaces.port })
    const result = await made.coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Fix the parser',
      workspace: { strategy: 'current_head', repoPath: 'D:\\proj', worktreePath: 'D:\\proj.conductor' },
    })

    expect(result.preparation).toBe('ready')
    const task = made.store.getTask(result.taskId)
    expect(task?.workspaceId).toBe('ws-1')
    expect(task?.workspaceFailure).toMatch(/could not be attached to it: the session header has no cwd/)
  })

  it('runs a task in a plain directory without inventing a worktree', async () => {
    const git = scriptedGit()
    const made = makeCoordinator({ git })
    const result = await made.coordinator.createTask({
      operationId: 'op-1',
      controllerSessionId: 'controller',
      title: 'Scratch work',
      workspace: { strategy: 'existing_directory', existingPath: 'D:\\scratch' },
    })

    expect(result.preparation).toBe('ready')
    const meta = made.createdOptions[0]?.meta as { cwd?: string } | undefined
    expect(meta?.cwd).toBe('D:\\scratch')
    const task = made.store.getTask(result.taskId)
    expect(task?.start).toEqual({ strategy: 'existing_directory', commit: '', created: false })
    // The user's own directory is not derived from a project, so there is no project to record,
    // and no workspace registration is attempted for a directory the user already had.
    expect(task?.originRepoPath).toBeUndefined()
    expect(task?.workspaceFailure).toBeUndefined()
    expect(git.calls.some(call => call[0] === 'worktree')).toBe(false)
  })
})

describe('fork into a new worktree (PRD §二.4, T05)', () => {
  it('gives the child its own worktree and leaves the source directory alone', async () => {
    const git = scriptedGit()
    const workspaces = scriptedWorkspaces()
    const made = makeCoordinator({ git, workspaces: workspaces.port })

    const source = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'source',
    })
    made.sessions.set(source.sessionId ?? '', {
      header: { id: source.sessionId, cwd: 'D:\\work' },
      events: oneAndAHalfTurns,
      seq: oneAndAHalfTurns.length - 1,
    })

    const forked = await made.coordinator.forkTask({
      operationId: 'fork-1',
      callerSessionId: 'controller',
      sourceTaskId: source.taskId,
      title: 'try another way',
      workspace: { strategy: 'current_head', repoPath: 'D:\\proj', worktreePath: 'D:\\proj.try' },
    })

    expect(forked.preparation, forked.failureReason ?? '').toBe('ready')
    // History is inherited, and the child's directory is the new worktree rather than the source's.
    const options = made.createdOptions.at(-1) as {
      seed?: unknown[]
      meta?: { cwd?: string; parentSession?: string }
    }
    expect(options.seed).toHaveLength(3)
    expect(options.meta?.parentSession).toBe(source.sessionId)
    expect(options.meta?.cwd).toBe('D:\\proj.try')

    const child = made.store.getTask(forked.taskId)
    expect(child?.sourceTaskId).toBe(source.taskId)
    expect(child?.originRepoPath).toBe('D:\\proj')
    expect(child?.start).toEqual({ strategy: 'current_head', commit: 'a'.repeat(40), created: true })
    expect(child?.workspaceId).toBe('ws-1')

    // Two distinct directories and two distinct sessions: the source was not moved and no
    // second binding was written onto it.
    const sourceBinding = made.store.getBinding(made.store.getTask(source.taskId)?.currentBindingId ?? '')
    const childBinding = made.store.getBinding(child?.currentBindingId ?? '')
    expect(sourceBinding?.cwd).toBe('D:\\work')
    expect(childBinding?.cwd).toBe('D:\\proj.try')
    expect(childBinding?.sessionId).not.toBe(sourceBinding?.sessionId)

    // T05's "workspace ownership correct": the child's own directory is what got registered.
    expect(workspaces.registrations).toEqual([{ path: 'D:\\proj.try', title: 'try another way' }])
    expect(workspaces.attachments).toEqual([{ workspaceId: 'ws-1', sessionId: forked.sessionId }])
  })

  it('fails the fork rather than starting the child in the source directory', async () => {
    const git = scriptedGit({
      worktreeAdd: { ok: false, stdout: '', stderr: 'fatal: could not create', code: 128 },
    })
    const made = makeCoordinator({ git })

    const source = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'source',
    })
    made.sessions.set(source.sessionId ?? '', {
      header: { id: source.sessionId, cwd: 'D:\\work' },
      events: oneAndAHalfTurns,
      seq: oneAndAHalfTurns.length - 1,
    })
    const before = made.createdOptions.length

    const forked = await made.coordinator.forkTask({
      operationId: 'fork-1',
      callerSessionId: 'controller',
      sourceTaskId: source.taskId,
      workspace: { strategy: 'current_head', repoPath: 'D:\\proj', worktreePath: 'D:\\proj.try' },
    })

    expect(forked.preparation).toBe('failed')
    expect(forked.failureReason).toMatch(/NOT run in the source directory instead/)
    expect(made.createdOptions).toHaveLength(before)
    expect(made.store.getTask(forked.taskId)?.failureReason).toMatch(/NOT run in the source directory instead/)
  })

  it('inherits the source directory when no starting state was asked for', async () => {
    // The ordinary fork must keep behaving as before: the worktree is opt-in.
    const git = scriptedGit()
    const made = makeCoordinator({ git })
    const source = await made.coordinator.createTask({
      operationId: 'create-1', controllerSessionId: 'controller', title: 'source',
    })
    made.sessions.set(source.sessionId ?? '', {
      header: { id: source.sessionId, cwd: 'D:\\work' },
      events: oneAndAHalfTurns,
      seq: oneAndAHalfTurns.length - 1,
    })

    const forked = await made.coordinator.forkTask({
      operationId: 'fork-1', callerSessionId: 'controller', sourceTaskId: source.taskId,
    })

    expect(forked.preparation, forked.failureReason ?? '').toBe('ready')
    const options = made.createdOptions.at(-1) as { meta?: { cwd?: string } }
    expect(options.meta?.cwd).toBe('D:\\work')
    expect(git.calls.some(call => call[0] === 'worktree')).toBe(false)
  })
})
