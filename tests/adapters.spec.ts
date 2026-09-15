/**
 * The Host-service adapters (PRD §二.4, §一.5).
 *
 * These three functions are the seam between the plugin's ports and whatever a composition
 * mounted, and they carry the rules that are easiest to get silently wrong:
 *
 * - a service that is not mounted returns `undefined`, so the feature is refused with a reason
 *   instead of being approximated;
 * - `git` is run with an argument vector and optional stdin, never a shell string;
 * - a truncated capture is a **failure**, not a short answer;
 * - a workspace registration that the Host refused is reported, never assumed.
 */

import { describe, expect, it } from 'vitest'
import { archivedSessionsOf, hostGitRunner, hostPathOpener, snapshotIoOf, workspacePortOf } from '../src/adapters.ts'
import type { SubprocessPort } from '../src/service/gitrunner.ts'
import { gitRunnerOver } from '../src/service/gitrunner.ts'

/** A context whose services are whatever the test hands it. */
function lookup(services: Record<string, unknown>) {
  return { get: (name: string) => services[name] }
}

/** A subprocess provider that records the spec it was given and answers with fixed output. */
function fakeSubprocess(options: {
  executable?: string | Error
  spawnThrows?: Error
  doneRejects?: Error
  exitCode?: number | null
  stdout?: string
  stderr?: string
  stdoutLossy?: boolean
} = {}) {
  const specs: unknown[] = []
  const port: SubprocessPort = {
    async resolveExecutable(command) {
      if (options.executable instanceof Error) throw options.executable
      return options.executable ?? `/usr/bin/${command}`
    },
    spawn(spec) {
      specs.push(spec)
      if (options.spawnThrows !== undefined) throw options.spawnThrows
      return {
        collected: {
          stdout: { readFrom: () => ({ text: options.stdout ?? '', lossy: options.stdoutLossy ?? false }) },
          stderr: { readFrom: () => ({ text: options.stderr ?? '', lossy: false }) },
        },
        done: options.doneRejects === undefined
          ? Promise.resolve({ exitCode: options.exitCode === undefined ? 0 : options.exitCode, signal: null })
          : Promise.reject(options.doneRejects),
      }
    },
  }
  return { port, specs }
}

describe('the Git adapter over the subprocess service (PRD §二.4)', () => {
  it('actually aborts a stuck process at the execution deadline, beyond merely configuring kill grace', async () => {
    let terminated = false
    const port: SubprocessPort = {
      resolveExecutable: async () => 'git',
      spawn(spec) {
        return {
          collected: {},
          done: new Promise(resolve => {
            spec.signal?.addEventListener('abort', () => {
              terminated = true
              resolve({ exitCode: null, signal: 'SIGTERM' })
            }, { once: true })
          }),
        }
      },
    }
    const result = await gitRunnerOver(port, { timeoutMs: 20 }).run(['status'], 'D:/repo')
    expect(terminated).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('execution deadline')
  })
  it('runs an argument vector, never a shell string, and reads collected output', async () => {
    const { port, specs } = fakeSubprocess({ stdout: 'main\n' })
    const git = hostGitRunner(lookup({ subprocess: port }))
    expect(git).toBeDefined()
    const result = await git?.run(['rev-parse', '--abbrev-ref', 'HEAD'], 'D:\\proj')

    expect(result).toEqual({ ok: true, stdout: 'main\n', stderr: '', code: 0 })
    const spec = specs[0] as {
      argv: readonly string[]
      cwd: string
      stdio: { stdin: unknown; stdout: unknown; stderr: unknown }
      graceMs: number
    }
    expect(spec.argv).toEqual(['/usr/bin/git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    expect(spec.cwd).toBe('D:\\proj')
    // stdin is closed when there is nothing to feed, which is what keeps a `git` that unexpectedly
    // wants input from blocking until the grace period expires.
    expect(spec.stdio.stdin).toBe('ignore')
    expect(spec.graceMs).toBeGreaterThan(0)
  })

  it('feeds a patch through stdin in the batch shape the seam defines', async () => {
    const { port, specs } = fakeSubprocess()
    const git = hostGitRunner(lookup({ subprocess: port }))
    await git?.run(['apply', '--index', '--whitespace=nowarn', '-'], 'D:\\wt', { stdin: 'diff --git a/x b/x\n' })
    const spec = specs[0] as { stdio: { stdin: unknown } }
    expect(spec.stdio.stdin).toEqual({ data: 'diff --git a/x b/x\n' })
  })

  it('reports a non-zero exit as a result, because git refusing is not git failing to run', async () => {
    const { port } = fakeSubprocess({ exitCode: 128, stderr: 'fatal: not a git repository\n' })
    const git = hostGitRunner(lookup({ subprocess: port }))
    const result = await git?.run(['rev-parse', 'HEAD'], 'D:\\proj')
    expect(result).toEqual({ ok: false, stdout: '', stderr: 'fatal: not a git repository\n', code: 128 })
  })

  it('treats a truncated capture as a failure rather than a short answer', async () => {
    // A `status --porcelain` whose head was dropped describes fewer changes than the repository
    // has; a truncated diff applies as a partial patch. Neither may be used.
    const { port } = fakeSubprocess({ stdout: 'M  a.txt\n', stdoutLossy: true })
    const git = hostGitRunner(lookup({ subprocess: port }))
    const result = await git?.run(['status', '--porcelain'], 'D:\\proj')
    expect(result?.ok).toBe(false)
    expect(result?.stderr).toMatch(/more output than could be captured/)
  })

  it('reports a missing git, a refused spawn and a rejected run as results, never as throws', async () => {
    const missing = hostGitRunner(lookup({ subprocess: fakeSubprocess({ executable: new Error('not found on PATH') }).port }))
    expect((await missing?.run(['--version'], 'D:\\proj'))?.stderr).toMatch(/could not be resolved/)

    const refused = hostGitRunner(lookup({ subprocess: fakeSubprocess({ spawnThrows: new Error('bad graceMs') }).port }))
    expect((await refused?.run(['--version'], 'D:\\proj'))?.stderr).toMatch(/could not be started/)

    const died = hostGitRunner(lookup({ subprocess: fakeSubprocess({ doneRejects: new Error('tree killed') }).port }))
    expect((await died?.run(['--version'], 'D:\\proj'))?.stderr).toMatch(/did not run to completion/)
  })

  it('is absent when the composition mounts no subprocess service', () => {
    expect(hostGitRunner(lookup({}))).toBeUndefined()
  })
})

describe('the snapshot filesystem port over ctx.fs (PRD §二.4)', () => {
  /** A filesystem service shaped like the Host's, over an in-memory tree. */
  function fakeFs(tree: Record<string, string | Record<string, unknown>>, options: { readFails?: string } = {}) {
    const writes: { path: string; text: string }[] = []
    return {
      writes,
      fs: {
        async lstat(path: string) {
          const entry = tree[path]
          return entry === undefined ? undefined : { type: typeof entry === 'string' ? 'file' : 'directory' }
        },
        contains(parent: { targetKey: string }, child: { targetKey: string }) {
          return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`)
        },
        async resolve(path: string) {
          // Resolution does not require the path to exist — a write targets a file that is not
          // there yet, and the Host's own `resolve` only canonicalizes. Existence is `stat`'s job,
          // which is exactly why the port uses both.
          return { targetKey: path, displayPath: path }
        },
        async stat(target: { targetKey: string }) {
          const entry = tree[target.targetKey]
          if (entry === undefined) return undefined
          return { version: '1', type: typeof entry === 'string' ? 'file' : 'directory' }
        },
        async listDir(target: { targetKey: string }) {
          const entry = tree[target.targetKey]
          if (typeof entry === 'string' || entry === undefined) throw new Error('FS_NOT_DIRECTORY')
          return Object.keys(entry).map(name => ({ name, type: 'file', target: { targetKey: name } }))
        },
        async readText(target: { targetKey: string }) {
          if (options.readFails !== undefined) throw new Error(options.readFails)
          const entry = tree[target.targetKey]
          if (typeof entry !== 'string') throw new Error('FS_NOT_TEXT')
          return entry
        },
        async writeText(target: { targetKey: string }, content: string, intent: { kind: string }) {
          if (intent.kind !== 'createIfAbsent') throw new Error('missing exclusive creation')
          if (tree[target.targetKey] !== undefined) throw new Error('FS_NOT_OBSERVED')
          writes.push({ path: target.targetKey, text: content })
          tree[target.targetKey] = content
          return { operation: 'create', version: '1', before: null, after: content }
        },
      },
    }
  }

  it('lists a directory, and keeps "empty" different from "not a directory"', async () => {
    const { fs } = fakeFs({ 'D:\\wt': { 'a.txt': 'x' }, 'D:\\wt\\a.txt': 'x' })
    const io = snapshotIoOf(lookup({ fs }))
    expect(await io?.list('D:\\wt')).toEqual(['a.txt'])
    expect(await io?.list('D:\\wt\\a.txt')).toBeUndefined()
    expect(await io?.list('D:\\missing')).toBeUndefined()
  })

  it('reports existence and copies a file by composing the two text primitives', async () => {
    // The Host filesystem service has no copy primitive, so this composition is the only route —
    // and its text-only nature is what makes a binary file a refusal rather than a corruption.
    const { fs, writes } = fakeFs({ 'D:\\proj\\notes.md': 'hello\n' })
    const io = snapshotIoOf(lookup({ fs }))
    expect(await io?.exists('D:\\proj\\notes.md')).toBe(true)
    expect(await io?.exists('D:\\proj\\absent.md')).toBe(false)
    await io?.copyFile('D:\\proj\\notes.md', 'D:\\wt\\notes.md')
    expect(writes).toEqual([{ path: 'D:\\wt\\notes.md', text: 'hello\n' }])
  })

  it('propagates a non-text refusal so the snapshot can name the file it could not copy', async () => {
    const { fs } = fakeFs({ 'D:\\proj\\image.png': 'binary' }, { readFails: 'FS_NOT_TEXT: not valid UTF-8' })
    const io = snapshotIoOf(lookup({ fs }))
    await expect(io?.copyFile('D:\\proj\\image.png', 'D:\\wt\\image.png')).rejects.toThrow(/not valid UTF-8/)
  })

  it('uses exclusive creation so copying cannot overwrite a receiver file', async () => {
    const { fs } = fakeFs({ 'D:\\proj\\a': 'source', 'D:\\wt\\a': 'receiver' })
    const io = snapshotIoOf(lookup({ fs }))
    await expect(io?.copyFile('D:\\proj\\a', 'D:\\wt\\a')).rejects.toThrow('FS_NOT_OBSERVED')
  })

  it('is absent when the composition mounts no filesystem service', () => {
    expect(snapshotIoOf(lookup({}))).toBeUndefined()
  })
})

describe('the workspace registry port (PRD §二.4)', () => {
  /** A registry shaped like the Host's, recording what it was asked to do. */
  function registry(options: { createFails?: string; attachFails?: string } = {}) {
    const created: { path: string; title?: string }[] = []
    const attached: { id: string; sessionId: string }[] = []
    return {
      created,
      attached,
      service: {
        async create(path: string, title?: string) {
          created.push({ path, ...title === undefined ? {} : { title } })
          if (options.createFails !== undefined) throw new Error(options.createFails)
          return {
            id: `ws-${String(created.length)}`,
            path,
            async attachSession(sessionId: string) {
              attached.push({ id: `ws-${String(created.length)}`, sessionId })
              if (options.attachFails !== undefined) throw new Error(options.attachFails)
            },
          }
        },
        get: () => undefined,
      },
    }
  }

  it('registers a directory and attaches the session through the Host object it just returned', async () => {
    const { service, created, attached } = registry()
    const port = workspacePortOf(lookup({ workspaceRegistry: service }))
    const registered = await port?.register('D:\\proj.conductor', 'Fix the parser')
    expect(registered).toEqual({ ok: true, workspaceId: 'ws-1' })
    expect(created).toEqual([{ path: 'D:\\proj.conductor', title: 'Fix the parser' }])
    expect(await port?.attach('ws-1', 'session-7')).toEqual({ ok: true })
    expect(attached).toEqual([{ id: 'ws-1', sessionId: 'session-7' }])
  })

  it('carries the Host refusal through instead of claiming a workspace exists', async () => {
    const { service } = registry({ createFails: "cannot create a workspace at 'D:\\x': path is not a directory" })
    const port = workspacePortOf(lookup({ workspaceRegistry: service }))
    const registered = await port?.register('D:\\x', 't')
    expect(registered?.ok).toBe(false)
    if (registered?.ok !== false) return
    expect(registered.reason).toMatch(/path is not a directory/)
  })

  it('reports a refused attachment, which is the Host refusing to file a session it cannot see', async () => {
    const { service } = registry({ attachFails: 'session has no cwd' })
    const port = workspacePortOf(lookup({ workspaceRegistry: service }))
    await port?.register('D:\\proj.conductor', 't')
    const attached = await port?.attach('ws-1', 'session-7')
    expect(attached).toEqual({ ok: false, reason: 'session has no cwd' })
  })

  it('refuses an attach for a workspace it never registered', async () => {
    const { service } = registry()
    const port = workspacePortOf(lookup({ workspaceRegistry: service }))
    const attached = await port?.attach('ws-unknown', 'session-7')
    expect(attached?.ok).toBe(false)
    if (attached?.ok !== false) return
    expect(attached.reason).toMatch(/not readable from ctx.workspaceRegistry/)
  })

  it('reports a registry whose shape it does not recognise rather than assuming success', async () => {
    const port = workspacePortOf(lookup({ workspaceRegistry: {} }))
    const registered = await port?.register('D:\\proj', 't')
    expect(registered?.ok).toBe(false)
    if (registered?.ok !== false) return
    expect(registered.reason).toMatch(/exposes no create/)
  })

  it('is absent when the composition mounts no workspace registry', () => {
    expect(workspacePortOf(lookup({}))).toBeUndefined()
  })
})

describe('the archive-set reader (PRD §二.5)', () => {
  it('reads the Host getter on every call, because the Host replaces the set', () => {
    let installed: readonly string[] = []
    const service = {
      get archivedSessionIds() { return installed },
      archiveSession(sessionId: string) { installed = [...installed, sessionId]; return Promise.resolve() },
    }
    const read = archivedSessionsOf(lookup({ workspaceRegistry: service }))
    expect(read?.()).toEqual({ state: 'published', sessionIds: [] })
    // Exactly what the Host does on archive: a new array installed over the old one.
    void service.archiveSession('session-archived')
    expect(read?.()).toEqual({ state: 'published', sessionIds: ['session-archived'] })
  })

  it('reports the Host still starting as unreadable, with the Host\'s own reason', () => {
    // The measured behaviour of the installed Host: the getter calls requireState() and throws
    // `workspace registry is not started yet` until the registry has started.
    const service = {
      get archivedSessionIds(): readonly string[] {
        throw new Error('workspace registry is not started yet')
      },
    }
    const read = archivedSessionsOf(lookup({ workspaceRegistry: service }))
    const result = read?.()
    expect(result?.state).toBe('unreadable')
    if (result?.state !== 'unreadable') return
    expect(result.reason).toMatch(/workspace registry is not started yet/)
  })

  it('reports a registry with no archive field as absent rather than as an empty set', () => {
    const read = archivedSessionsOf(lookup({ workspaceRegistry: { create: () => undefined } }))
    const result = read?.()
    expect(result?.state).toBe('absent')
    if (result?.state !== 'absent') return
    expect(result.reason).toMatch(/no archivedSessionIds/)
  })

  it('reports a non-array answer as unreadable instead of coercing it', () => {
    const read = archivedSessionsOf(lookup({ workspaceRegistry: { archivedSessionIds: 'session-a,session-b' } }))
    const result = read?.()
    expect(result?.state).toBe('unreadable')
    if (result?.state !== 'unreadable') return
    expect(result.reason).toMatch(/returned string rather than an array/)
  })

  it('normalizes whatever the Host hands back into plain strings', () => {
    // The Host types these as branded `SessionId`s, which are strings at runtime but not something the
    // conductor should have to know about. Anything else that stringifies is carried through as text
    // rather than silently dropped from the set.
    const read = archivedSessionsOf(lookup({ workspaceRegistry: { archivedSessionIds: [{ toString: () => 'session-a' }] } }))
    const result = read?.()
    expect(result).toEqual({ state: 'published', sessionIds: ['session-a'] })
  })

  it('is absent when the composition mounts no workspace registry', () => {
    expect(archivedSessionsOf(lookup({}))).toBeUndefined()
  })
})

describe('the path opener (PRD §三.3 artifacts 打开)', () => {
  it('is absent when this composition mounts no apiProxy', () => {
    expect(hostPathOpener(lookup({}))).toBeUndefined()
  })

  it('hands the recorded path to the Host opener and no other path', async () => {
    const opened: string[] = []
    const opener = hostPathOpener(lookup({
      apiProxy: {
        openPath: async (request: { payload: { path: string } }) => {
          opened.push(request.payload.path)
        },
      },
    }))
    expect(opener).toBeDefined()
    await opener?.openPath('D:\\work\\report.md')
    expect(opened).toEqual(['D:\\work\\report.md'])
  })
})
