/**
 * The real `git` adapter: {@link GitRunner} over the Host's subprocess service.
 *
 * PRD §二.4 says worktrees are created "by a new Git adapter". This is that adapter's bottom
 * half: it turns the fixed argument lists `git.ts` constructs into actual processes, and turns
 * the processes' outcomes back into {@link GitResult}. The decisions stay in `git.ts`; nothing
 * here decides anything.
 *
 * ## Why a structural port instead of importing the service's types
 *
 * The subprocess service is a *seam*: a composition may mount `subprocess-local`, a sandboxed
 * provider, or a remote one, and the seam deliberately does not declare whether the child runs
 * on this machine. The plugin only ever needs three of its members, so it declares those three
 * and takes whatever the composition mounted — the same reasoning as `AgentLike` in
 * `src/service/host.ts`. It also means this module adds no peer dependency, so the plugin still
 * loads in a composition that has no subprocess provider at all; it reports the gap instead,
 * which is the behaviour PRD §一.5 asks for.
 *
 * @module dsh-session-conductor/service/gitrunner
 */

import type { GitResult, GitRunner } from './git.ts'

/** One collected stream's reader, as the subprocess seam exposes it. */
interface CollectedReader {
  readFrom(fromByte: number): { readonly text: string; readonly lossy: boolean }
}

/** The live process handle, as far as this plugin uses it. */
interface SpawnedProcess {
  readonly collected: { readonly stdout?: CollectedReader; readonly stderr?: CollectedReader }
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>
}

/** The subprocess service, as far as this plugin uses it. */
export interface SubprocessPort {
  /**
   * Resolve a bare executable name in the provider's execution world.
   * @param command - the program name, e.g. `git`.
   * @returns its canonical path.
   */
  resolveExecutable(command: string): Promise<string>
  /**
   * Start one process. This seam applies no defaults, so every disposition is explicit.
   * @param spec - argv, directory, stdio, and grace.
   * @returns the live handle.
   */
  spawn(spec: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly stdio: {
      readonly stdin: 'ignore' | { readonly data: string }
      readonly stdout: { readonly maxBytes: number }
      readonly stderr: { readonly maxBytes: number }
    }
    readonly graceMs: number
    readonly signal?: AbortSignal
    readonly env?: Readonly<Record<string, string | undefined>>
  }): SpawnedProcess
}

/** Knobs the caller may set; the defaults are deliberately small and finite. */
export interface GitRunnerOptions {
  /**
   * Grace before a stuck `git` is escalated to a kill.
   *
   * Finite on purpose: `git` can block on a credential prompt or a lock held by another process,
   * and a preparation that never returns would leave a task stuck in `preparing` forever with
   * nothing to report.
   */
  readonly graceMs?: number
  /** Execution deadline; graceMs alone does not start termination. */
  readonly timeoutMs?: number
  /** Per-stream capture cap in bytes. Output beyond it is reported as `lossy`, never silently used. */
  readonly maxBytes?: number
}

/** Default grace: long enough for a real `git worktree add`, short enough to be a useful bound. */
const DEFAULT_GIT_GRACE_MS = 30_000

/** Default capture cap: far more than any `git status` needs, small enough not to be a leak. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Describe an unknown throwable without inventing a shape for it. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build a `GitRunner` over a subprocess provider.
 *
 * Every failure mode is returned as a {@link GitResult} rather than thrown, because the adapter
 * above it distinguishes "git ran and refused" from "git could not run" by inspecting the result,
 * and an exception would collapse the two.
 *
 * @param subprocess - the mounted subprocess service.
 * @param options - grace and capture bounds.
 * @returns the runner.
 */
export function gitRunnerOver(subprocess: SubprocessPort, options: GitRunnerOptions = {}): GitRunner {
  const graceMs = options.graceMs ?? DEFAULT_GIT_GRACE_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('Git timeoutMs must be a positive timer-safe integer')
  }
  return {
    async run(args, cwd, runOptions): Promise<GitResult> {
      let executable: string
      try {
        executable = await subprocess.resolveExecutable('git')
      } catch (error) {
        return {
          ok: false,
          stdout: '',
          stderr: `git could not be resolved in this execution world: ${describe(error)}`,
        }
      }

      let handle: SpawnedProcess
      const deadline = AbortSignal.timeout(timeoutMs)
      try {
        handle = subprocess.spawn({
          // `argv` is never shell-interpreted by the seam, which is what keeps a branch name or a
          // path containing a space from becoming two arguments or a command.
          argv: [executable, ...args],
          cwd,
          stdio: {
            stdin: runOptions?.stdin === undefined ? 'ignore' : { data: runOptions.stdin },
            stdout: { maxBytes },
            stderr: { maxBytes },
          },
          graceMs,
          signal: deadline,
        })
      } catch (error) {
        return { ok: false, stdout: '', stderr: `git could not be started: ${describe(error)}` }
      }

      let outcome: { readonly exitCode: number | null; readonly signal: string | null }
      try {
        outcome = await handle.done
      } catch (error) {
        return { ok: false, stdout: '', stderr: `git did not run to completion: ${describe(error)}` }
      }

      const read = (reader: CollectedReader | undefined): { text: string; lossy: boolean } => {
        const read = reader?.readFrom(0)
        return { text: read?.text ?? '', lossy: read?.lossy ?? false }
      }
      const stdout = read(handle.collected.stdout)
      const stderr = read(handle.collected.stderr)
      if (deadline.aborted) {
        return { ok: false, stdout: stdout.text, stderr: `git exceeded its ${String(timeoutMs)} ms execution deadline; process-tree termination was requested and its outcome has settled` }
      }
      // A stream whose head was dropped cannot be parsed: a truncated `status --porcelain` would
      // look like a repository with fewer changes than it has, and a truncated diff would apply
      // as a partial patch. Reported as a failure instead of being used.
      if (stdout.lossy || stderr.lossy) {
        return {
          ok: false,
          stdout: stdout.text,
          stderr: `git produced more output than could be captured (${String(maxBytes)} bytes per stream), so the `
            + 'result is incomplete and is not used',
        }
      }
      return {
        ok: outcome.exitCode === 0,
        stdout: stdout.text,
        stderr: stderr.text,
        ...outcome.exitCode === null ? {} : { code: outcome.exitCode },
      }
    },
  }
}

/**
 * Whether `git` can be run at all in this execution world.
 *
 * Reported as a capability rather than assumed: PRD §一.5 requires a missing ability to disable
 * the feature with a reason instead of failing later with a different symptom.
 *
 * @param subprocess - the mounted subprocess service, when there is one.
 * @returns the resolved path, or the reason there is none.
 */
export async function probeGit(
  subprocess: SubprocessPort | undefined,
): Promise<{ readonly available: true; readonly path: string } | { readonly available: false; readonly reason: string }> {
  if (subprocess === undefined) {
    return {
      available: false,
      reason: 'no subprocess service is mounted, so the Git adapter cannot run: Git starting states and worktrees '
        + 'are unavailable in this composition',
    }
  }
  try {
    return { available: true, path: await subprocess.resolveExecutable('git') }
  } catch (error) {
    return { available: false, reason: `git is not available in this execution world: ${describe(error)}` }
  }
}
