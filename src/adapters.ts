/**
 * Host-service adapters: the plugin's ports over what a composition actually mounted.
 *
 * Two rules shape everything here.
 *
 * 1. **Resolve at call time.** Cordis mounts entries concurrently, so a service belonging to a
 *    sibling entry may be published after this plugin mounts. Every adapter takes the live context
 *    and looks the service up when it is used.
 * 2. **Absent is reported, never approximated.** Each adapter returns `undefined` when the service
 *    is not mounted, and the coordinator turns that into a refusal naming the missing service. It
 *    never substitutes a directory, a shell, a same-name file, or a `node:fs` call for the Host's own service —
 *    PRD §一.5 requires a missing ability to disable the feature with a reason, and §二.4 requires
 *    a failed preparation not to fall back to the original directory.
 *
 * @module dsh-session-conductor/adapters
 */

import type { FileSystem, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { createHash } from 'node:crypto'
import type { TransferFsPort } from './service/transfer.ts'
import type { GitRunner, SnapshotIo } from './service/git.ts'
import { gitRunnerOver, type SubprocessPort } from './service/gitrunner.ts'
import type { ArtifactKindPort } from './service/artifacts.ts'
import type { WorkspacePort, WorkspaceRegistration } from './service/coordinator.ts'
import type { ArchiveSetRead } from './service/discovery.ts'

/** The part of a context these adapters need. */
export interface ServiceLookup {
  /**
   * Look a service up by its context key.
   * @param name - the service key.
   * @returns the service, or undefined when this composition does not mount it.
   */
  get(name: string): unknown
}

/** The separately versioned provider extension; no direct filesystem fallback. */
export interface BinaryFilesPort {
  readonly version: 1
  readonly maxBytes: number
  writeBytes(target: FsTarget, bytes: Uint8Array, expected: FsWriteIntent, signal?: AbortSignal): Promise<{
    operation: 'create' | 'update'; version: FsVersion; sizeBytes: number; sha256: string
  }>
}

export function binaryFilesOf(ctx: ServiceLookup): BinaryFilesPort | undefined {
  const candidate = ctx.get('conductorBinaryFiles') as Partial<BinaryFilesPort> | undefined
  return candidate?.version === 1 && typeof candidate.writeBytes === 'function'
    && Number.isSafeInteger(candidate.maxBytes) && candidate.maxBytes! > 0
    ? candidate as BinaryFilesPort : undefined
}

/** Keep the Host's methods bound, and publish bytes only with a compatible writer. */
export function transferFsOf(ctx: ServiceLookup): TransferFsPort | undefined {
  const fs = ctx.get('fs') as FileSystem | undefined
  if (fs === undefined || fs === null) return undefined
  const binary = binaryFilesOf(ctx)
  return {
    resolve: path => fs.resolve(path),
    stat: (target, signal) => fs.stat(target as FsTarget, signal),
    readText: (target, signal) => fs.readText(target as FsTarget, signal),
    writeText: (target, text, expected, signal) => fs.writeText(target as FsTarget, text, expected, signal),
    ...binary === undefined || typeof fs.readBytes !== 'function' ? {} : {
      maxBinaryBytes: Math.min(binary.maxBytes, 64 * 1024 * 1024),
      readBytes: (target: unknown, signal: AbortSignal | undefined, maxBytes: number) =>
        fs.readBytes(target as FsTarget, signal, maxBytes),
      writeBytes: (target: unknown, bytes: Uint8Array, expected: FsWriteIntent, signal?: AbortSignal) =>
        binary.writeBytes(target as FsTarget, bytes, expected, signal),
    },
  }
}

/**
 * The Git adapter over the Host's subprocess service (PRD §二.4).
 *
 * @param ctx - the live plugin context.
 * @returns the runner, or undefined when no subprocess service is mounted.
 */
export function hostGitRunner(ctx: ServiceLookup): GitRunner | undefined {
  const subprocess = ctx.get('subprocess') as SubprocessPort | undefined
  if (subprocess === undefined || subprocess === null) return undefined
  return gitRunnerOver(subprocess)
}

/**
 * Resolve a commit artifact through the Host git runner (PRD §二.9.1 提交引用).
 *
 * Another commit, including HEAD, is never this artifact. A missing repository
 * path is `unchecked` rather than `missing`: we did not look, so we must not
 * claim the object is gone.
 *
 * @param git - the runner, when subprocess is mounted.
 * @returns the kind port, or undefined when git cannot run.
 */
export function gitArtifactKindPort(git: GitRunner | undefined): ArtifactKindPort | undefined {
  if (git === undefined) return undefined
  return {
    async resolveGitRef(gitRef, cwd) {
      if (cwd === undefined || cwd.length === 0) {
        return {
          status: 'unchecked',
          evidence: `git reference ${gitRef} is recorded but has no repository path, so it cannot be resolved; `
            + 'another commit is not this artifact',
        }
      }
      const resolved = await git.run(['rev-parse', '--verify', `${gitRef}^{commit}`], cwd)
      if (!resolved.ok) {
        return {
          status: 'missing',
          evidence: `${gitRef} does not resolve to a commit in ${cwd}; another commit is not this artifact. `
            + `git said: ${resolved.stderr.trim() || 'no such revision'}`,
        }
      }
      const sha = resolved.stdout.trim()
      return {
        status: 'present',
        resolvedSha: sha,
        evidence: `verified present; git object ${sha} at ${gitRef} in ${cwd}`,
      }
    },
  }
}

/**
 * The filesystem port a worktree snapshot copies chosen untracked files through (PRD §二.4).
 *
 * The optional binary companion retains the provider's sandbox, atomic write and exclusive-create
 * semantics. Without it, the existing text primitives reject non-UTF-8 input instead of corrupting it.
 *
 * @param ctx - the live plugin context.
 * @returns the port, or undefined when no filesystem service is mounted.
 */
export function snapshotIoOf(ctx: ServiceLookup): SnapshotIo | undefined {
  const fs = ctx.get('fs') as FileSystem | undefined
  if (fs === undefined || fs === null) return undefined
  return {
    async pathType(path) {
      return (await fs.lstat(path))?.type
    },
    async contains(root, path) {
      return fs.contains(await fs.resolve(root), await fs.resolve(path))
    },
    async list(dir) {
      try {
        const target = await fs.resolve(dir)
        const info = await fs.stat(target)
        if (info?.type !== 'directory') return undefined
        return (await fs.listDir(target)).map(entry => entry.name)
      } catch {
        // "not a readable directory" and "an empty directory" must stay different answers, and
        // only the second one is an empty array.
        return undefined
      }
    },
    async exists(path) {
      try {
        return await fs.stat(await fs.resolve(path)) !== undefined
      } catch {
        return false
      }
    },
    async copyFile(from, to, roots) {
      if ((await fs.lstat(from))?.type !== 'file') throw new Error('snapshot source is not a regular file')
      const source = await fs.resolve(from)
      const destination = await fs.resolve(to)
      const sourceRoot = roots === undefined ? undefined : await fs.resolve(roots.source)
      const targetRoot = roots === undefined ? undefined : await fs.resolve(roots.target)
      if (sourceRoot !== undefined && targetRoot !== undefined && (!fs.contains(sourceRoot, source)
        || !fs.contains(targetRoot, destination))) {
        throw new Error('snapshot copy resolves outside its source or target directory')
      }
      const sameIdentity = (left: FsTarget, right: FsTarget): boolean => fs.contains(left, right) && fs.contains(right, left)
      const recheckTargets = async (): Promise<FsTarget> => {
        const freshSource = await fs.resolve(from)
        const freshDestination = await fs.resolve(to)
        if (!sameIdentity(source, freshSource) || !sameIdentity(destination, freshDestination)) {
          throw new Error('snapshot source or destination identity changed while reading')
        }
        if (roots !== undefined && sourceRoot !== undefined && targetRoot !== undefined) {
          const freshSourceRoot = await fs.resolve(roots.source)
          const freshTargetRoot = await fs.resolve(roots.target)
          if (!sameIdentity(sourceRoot, freshSourceRoot) || !sameIdentity(targetRoot, freshTargetRoot)
            || !fs.contains(freshSourceRoot, freshSource) || !fs.contains(freshTargetRoot, freshDestination)) {
            throw new Error('snapshot source or target directory identity changed while reading')
          }
        }
        return freshDestination
      }
      const before = await fs.stat(source)
      const binary = binaryFilesOf(ctx)
      if (binary !== undefined && typeof fs.readBytes === 'function') {
        const limit = Math.min(binary.maxBytes, 64 * 1024 * 1024)
        if (before?.type !== 'file' || before.size === undefined || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > limit) {
          throw new Error('snapshot source is not a bounded regular file')
        }
        const bytes = await fs.readBytes(source, undefined, before.size + 1)
        if (bytes.byteLength !== before.size || (await fs.stat(source))?.version !== before.version) {
          throw new Error('snapshot source changed while it was being read')
        }
        const currentDestination = await recheckTargets()
        const written = await binary.writeBytes(currentDestination, bytes, { kind: 'createIfAbsent' })
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (written.operation !== 'create' || written.sizeBytes !== bytes.byteLength || written.sha256 !== digest) {
          throw new Error('snapshot write receipt does not match the source bytes')
        }
        const copied = await fs.readBytes(currentDestination, undefined, bytes.byteLength + 1)
        if (createHash('sha256').update(copied).digest('hex') !== digest) {
          throw new Error('snapshot destination does not match the source bytes after writing')
        }
        return
      }
      const text = await fs.readText(source)
      if (before === undefined || (await fs.stat(source))?.version !== before.version) {
        throw new Error('snapshot source changed while it was being read')
      }
      await fs.writeText(await recheckTargets(), text, { kind: 'createIfAbsent' })
    },
  }
}

/**
 * What `ctx.workspaceRegistry` looks like to this plugin.
 *
 * Taken from the Host's own service definition (`@deepseek-ai/dsh-workspace`):
 * `create(path, title?)` canonicalizes the path with `realpath`, rejects a nonexistent path or a
 * non-directory, and returns the existing record for a path already registered; `get(id)` looks a
 * record up; and `Workspace.attachSession(id)` is what puts a session into a workspace's account,
 * re-reading that session's header and comparing its `cwd` against the workspace path.
 *
 * The id is a branded string in the Host's own types and a plain string here, because the
 * coordinator has no business knowing the Host's brand. The adapter reads `.id` and hands back
 * `.id`, and never manufactures one.
 */
interface WorkspaceRecordLike {
  readonly id: string
  readonly path: string
  attachSession(sessionId: string): Promise<void>
}

/** The registry surface this plugin uses. */
interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceRecordLike>
  get(id: string): WorkspaceRecordLike | undefined
}

/**
 * The workspace registry port (PRD §二.4).
 *
 * `attachSession` is the Host's own validation and not a formality: it re-reads the session's
 * header and refuses when the recorded `cwd` is absent, unresolvable, or not the workspace
 * directory. So a session created somewhere else cannot be filed under this workspace by asking
 * nicely — which is exactly the guarantee T05's "workspace ownership correct" is about.
 *
 * @param ctx - the live plugin context.
 * @returns the port, or undefined when no workspace registry is mounted.
 */
export function workspacePortOf(ctx: ServiceLookup): WorkspacePort | undefined {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  if (registry === undefined || registry === null) return undefined
  if (typeof registry.create !== 'function') {
    return {
      register: async () => ({
        ok: false,
        reason: 'the mounted ctx.workspaceRegistry exposes no create(path, title) method, so this plugin cannot '
          + 'register a directory as a workspace in this build of the Host',
      }),
      attach: async () => ({ ok: false, reason: 'no workspace could be registered, so there is nothing to attach to' }),
    }
  }

  /** The records `register` returned, so `attach` uses the Host's own object for that id. */
  const known = new Map<string, WorkspaceRecordLike>()

  return {
    async register(path, title): Promise<WorkspaceRegistration> {
      try {
        const workspace = await registry.create(path, title)
        if (workspace === undefined || workspace === null || typeof workspace.id !== 'string') {
          return {
            ok: false,
            reason: `ctx.workspaceRegistry.create(${path}) returned no usable workspace, so the directory is `
              + 'reported as unregistered rather than assumed registered',
          }
        }
        known.set(workspace.id, workspace)
        return { ok: true, workspaceId: workspace.id }
      } catch (error) {
        // The Host refuses a nonexistent path, a non-directory, and a write failure by throwing;
        // the message is the reason the operator needs, so it is carried through rather than
        // replaced with a generic one.
        return {
          ok: false,
          reason: `ctx.workspaceRegistry could not register ${path}: `
            + `${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
    async attach(workspaceId, sessionId) {
      const workspace = known.get(workspaceId)
        ?? (typeof registry.get === 'function' ? registry.get(workspaceId) : undefined)
      if (workspace === undefined) {
        return {
          ok: false,
          reason: `workspace ${workspaceId} is not readable from ctx.workspaceRegistry, so session ${sessionId} was `
            + 'not attached to it',
        }
      }
      try {
        await workspace.attachSession(sessionId)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

/**
 * The reader for the Host's registry-global archive set (PRD §二.5).
 *
 * §二.5 asks the conductor to *show* the sessions archived outside it, and the sentence beside that
 * requirement forbids the plugin's own archiving from calling the Host's archive interface. So this is
 * a read and only a read: the conductor never archives, never unarchives, and never writes the set.
 *
 * Three details come from reading the installed Host rather than assuming them:
 *
 * - `archivedSessionIds` is a **getter** on the registry, returning `requireState().archivedSessionIds` —
 *   the ids in archive order. Each mutation installs a **new array**, so it must be read per call, which
 *   is why this returns a function rather than a snapshot.
 * - The getter **throws** while the registry is mounted but not started (`workspace registry is not
 *   started yet`). That is a real boot window here, and it is reported as `unreadable` with the Host's
 *   own message instead of being flattened into "nothing is archived".
 * - The archive set is **one-way in this build**: `dsh-workspace` exposes `archiveSession` and no
 *   unarchive counterpart, so a session marked archived stays that way through this interface.
 *
 * The Host also validates on its side: `archiveSession` requires the session to exist (live or in
 * session persistence) and throws otherwise. Nothing here depends on that, but it is why a successfully
 * archived id in the set is always a session the conductor can also see in a query.
 *
 * @param ctx - the live plugin context.
 * @returns the reader, or undefined when no workspace registry is mounted.
 */
export function archivedSessionsOf(ctx: ServiceLookup): (() => ArchiveSetRead) | undefined {
  const registry = ctx.get('workspaceRegistry') as { readonly archivedSessionIds?: unknown } | undefined
  if (registry === undefined || registry === null) return undefined
  return () => {
    try {
      // Member access on an object literal: reading the property *is* the getter call.
      const ids = (registry as { readonly archivedSessionIds?: unknown }).archivedSessionIds
      if (ids === undefined) {
        return {
          state: 'absent',
          reason: 'the mounted ctx.workspaceRegistry exposes no archivedSessionIds, so this build of the Host '
            + 'publishes no registry-global archive set to read',
        }
      }
      if (!Array.isArray(ids)) {
        return {
          state: 'unreadable',
          reason: `ctx.workspaceRegistry.archivedSessionIds returned ${typeof ids} rather than an array of session `
            + 'ids, so this plugin cannot tell which sessions are archived',
        }
      }
      return { state: 'published', sessionIds: (ids as readonly unknown[]).map(id => String(id)) }
    } catch (error) {
      return {
        state: 'unreadable',
        reason: `ctx.workspaceRegistry.archivedSessionIds could not be read: `
          + `${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
}

/** The Host native-open surface, when a composition actually mounted one. */
export interface PathOpener {
  /**
   * Hand `path` to the OS default application.
   * @param path - the recorded filesystem path, already identity-checked.
   * @param signal - cancellation.
   */
  openPath(path: string, signal?: AbortSignal): Promise<void>
}

/**
 * Resolve the Host's path opener at call time (PRD §三.3 `artifacts` 打开).
 *
 * The conductor does not shell-out itself and does not search by file name.
 * A missing opener is reported; a missing or changed artifact is still refused
 * before this port is asked.
 *
 * @param ctx - the live plugin context.
 * @returns the opener, or undefined when this composition has none.
 */
export function hostPathOpener(ctx: ServiceLookup): PathOpener | undefined {
  const proxy = ctx.get('apiProxy') as { openPath?: unknown } | undefined
  if (proxy === undefined || typeof proxy.openPath !== 'function') return undefined
  const open = (proxy.openPath as (first: unknown, second?: unknown) => Promise<unknown>).bind(proxy)
  return {
    async openPath(path, signal) {
      await open({ payload: { path } }, signal)
    },
  }
}
