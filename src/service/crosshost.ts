/**
 * Cross-Host migration (PRD §二.14.1).
 *
 * Cross-Host work is a **phase-C, default-off** capability, and the specification is
 * precise about why it is not simply "a transfer with extra steps". Six rules decide the
 * design, and every one of them exists because the naive version loses data:
 *
 * 1. **The two Hosts must be compatible before anything moves** — plugin, protocol, model
 *    and workspace capability. A target that cannot host the work is discovered *before*
 *    the source is disturbed, not after.
 * 2. **What travels is stated, not implied.** The manifest names the history range and the
 *    artifacts, so "it migrated" cannot mean four different things.
 * 3. **Source paths are translated**, because a path that exists on one machine is a
 *    different path or no path at all on the other.
 * 4. **The source must confirm a stop and freeze dispatch before the target binding is
 *    enabled.** This is the ordering rule, and it is the one that matters: enabling the
 *    target first gives two live copies of one task, both writing.
 * 5. **If the source state cannot be confirmed, the target copy does not start.** "Cannot
 *    tell" resolves to *don't*, never to *assume it stopped*.
 * 6. **After a network recovery, reconcile by operation id** rather than resending. The
 *    same rule the local crash-window recovery follows, applied across a link that can
 *    fail in the middle of the handshake.
 *
 * The finite Host Router, SSH stdio Companion Bridge and private local IPC live in
 * `src/remote`. These pure decisions remain usable when transport is disabled.
 *
 * @module dsh-session-conductor/service/crosshost
 */

import { recoveryAction, type OperationRecord } from '../domain/operation.ts'
import { posix, win32 } from 'node:path'
import { normalizePath } from './cleanup.ts'

/** A remote Host a user has registered by hand. */
export interface RemoteHost {
  readonly hostId: string
  /** A label for the interface; never a credential. */
  readonly label: string
  /** Whether the user turned this registration on. */
  readonly enabled: boolean
  // ── What the remote reported about itself ────────────────────────────────
  // These live on the remote rather than on the request because they are *its* answers.
  // Putting them on the request would let a caller supply the target's capabilities, which
  // is the same as not checking them.
  /** The protocol version the remote reports, when it has been reached. */
  readonly protocolVersion?: string | undefined
  /** Plugin version the remote reports. */
  readonly pluginVersion?: string | undefined
  /** The models the remote offers, when it has been asked. */
  readonly models?: readonly string[] | undefined
  /** Whether the remote can host the workspace the work needs. */
  readonly workspaceCapable?: boolean | undefined
}

/** What the work requires, as opposed to what the remote offers. */
export interface CompatibilityInput {
  /** The protocol version this build speaks. */
  readonly localProtocolVersion: string
  /** The plugin version this build is. */
  readonly localPluginVersion: string
  /** The models the work needs; the remote must offer them. */
  readonly requiredModels: readonly string[]
  /** Whether the source workspace can be represented at the target path. */
  readonly workspaceRepresentable: boolean
}

/** One compatibility finding. */
export interface CompatibilityCheck {
  readonly aspect: 'plugin' | 'protocol' | 'model' | 'workspace'
  readonly satisfied: boolean
  readonly reason: string
}

/** Whether a migration may proceed, and every check behind the answer. */
export interface CompatibilityVerdict {
  readonly compatible: boolean
  /** Every check, satisfied or not, because "incompatible" alone is not actionable. */
  readonly checks: readonly CompatibilityCheck[]
}

/**
 * Check the four compatibility aspects of PRD §二.14.1.
 *
 * All four are reported, not the first failure: a target that is missing a model *and*
 * cannot represent the workspace needs both fixed, and discovering them one round trip
 * apart wastes the operator's time.
 *
 * @param remote - the registered remote Host.
 * @param input - what the work requires and what the remote offers.
 * @returns the verdict.
 */
export function checkCompatibility(remote: RemoteHost, input: CompatibilityInput): CompatibilityVerdict {
  const checks: CompatibilityCheck[] = [
    {
      aspect: 'plugin',
      satisfied: remote.pluginVersion !== undefined && remote.pluginVersion === input.localPluginVersion,
      reason: remote.pluginVersion === undefined
        ? 'the remote has not reported a conductor plugin version, so it cannot be known to run a compatible one'
        : remote.pluginVersion === input.localPluginVersion
          ? `both sides report conductor plugin ${remote.pluginVersion}`
          : `the remote reports conductor plugin ${remote.pluginVersion}, this build is ${input.localPluginVersion}; compatibility has not been established`,
    },
    {
      aspect: 'protocol',
      satisfied: remote.protocolVersion === input.localProtocolVersion,
      reason: remote.protocolVersion === undefined
        ? 'the remote has not reported a protocol version'
        : remote.protocolVersion === input.localProtocolVersion
          ? `both sides speak protocol ${input.localProtocolVersion}`
          : `the remote speaks protocol ${remote.protocolVersion}, this build speaks `
            + `${input.localProtocolVersion}; a mismatch is refused rather than negotiated`,
    },
    {
      aspect: 'model',
      satisfied: remote.models !== undefined && input.requiredModels.every(model => remote.models?.includes(model) === true),
      reason: remote.models === undefined
        ? 'the remote has not reported which models it offers'
        : input.requiredModels.every(model => remote.models?.includes(model) === true)
          ? `the remote offers every required model (${input.requiredModels.join(', ')})`
          : `the remote does not offer: `
            + `${input.requiredModels.filter(model => remote.models?.includes(model) !== true).join(', ')}`,
    },
    {
      aspect: 'workspace',
      // Silence is not agreement here either. The other three aspects reject an unreported
      // answer, and a workspace check that accepted one would be the exception — the
      // asymmetry the live probe surfaced: a fresh registration passed `workspace` while
      // failing the other three, which would read as "the workspace is fine" about a remote
      // that had said nothing at all.
      satisfied: input.workspaceRepresentable && remote.workspaceCapable === true,
      reason: !input.workspaceRepresentable
        ? 'the source workspace cannot be represented at the target path, so the work would arrive without its files'
        : remote.workspaceCapable === undefined
          ? 'the remote has not reported whether it can host this workspace'
          : remote.workspaceCapable
            ? 'the remote reports that it can host this workspace'
            : 'the remote reports that it cannot host this workspace',
    },
  ]
  return { compatible: checks.every(check => check.satisfied), checks }
}

/** What a migration would move. */
export interface MigrationManifest {
  readonly taskId: string
  readonly sourceHostId: string
  readonly targetHostId: string
  /** The completed-turn prefix that travels, expressed as a sequence range. */
  readonly historyThroughSeq: number
  readonly artifactIds: readonly string[]
  /** Source path to target path, for every path the work depends on. */
  readonly pathMap: readonly { readonly from: string; readonly to: string }[]
}

/**
 * Translate one source path to its target path.
 *
 * An unmapped path is returned unchanged *and* reported, rather than guessed at: a
 * plausible-looking translation of an unmapped path is how work arrives pointing at a
 * directory that happens to exist and is not the right one.
 *
 * @param manifest - the manifest holding the mapping.
 * @param path - the source path.
 * @returns the target path and whether it was mapped.
 */
export function translatePath(manifest: MigrationManifest, path: string): { readonly path: string; readonly mapped: boolean } {
  const canonical = (value: string): string | undefined => {
    const provider = /^[a-z]:/i.test(value) || value.startsWith('\\\\') || value.startsWith('//') ? win32 : posix
    if (!provider.isAbsolute(value) || value.includes('\0')) return undefined
    const normalized = provider.normalize(value).replace(/\\/g, '/')
    return normalized.length > provider.parse(value).root.length ? normalized.replace(/\/+$/, '') : normalized
  }
  const source = canonical(path)
  if (source === undefined) return { path, mapped: false }
  const compared = normalizePath(source)
  const candidates = manifest.pathMap.flatMap(entry => {
    const from = canonical(entry.from)
    const to = canonical(entry.to)
    if (from === undefined || to === undefined) return []
    const root = normalizePath(from)
    return compared === root || compared.startsWith(root.endsWith('/') ? root : `${root}/`)
      ? [{ from, to }] : []
  }).sort((left, right) => right.from.length - left.from.length)
  const entry = candidates[0]
  if (entry === undefined) return { path, mapped: false }
  const suffix = source.slice(entry.from.length).replace(/^\/+/, '')
  return { path: suffix.length === 0 ? entry.to : `${entry.to.replace(/\/+$/, '')}/${suffix}`, mapped: true }
}

/** The state the source reports when asked whether it has stopped. */
export type SourceStopState = 'stopped' | 'running' | 'unknown'

/** Whether the target binding may be enabled. */
export interface EnableVerdict {
  readonly allowed: boolean
  readonly reason: string
}

/**
 * Decide whether the target binding may be enabled.
 *
 * PRD §二.14.1's ordering rule, and the reason it is a function rather than a step in a
 * procedure: the answer depends on the source's *reported* state, and an unconfirmable
 * source must not be read as a stopped one. `unknown` is refused explicitly, because that
 * is the state a link failure produces and the state most likely to be treated as success.
 *
 * @param state - what the source reported when asked to stop.
 * @param dispatchFrozen - whether the source confirmed it has stopped dispatching.
 * @returns whether enabling is allowed, and why not when it is not.
 */
export function enableTargetAllowed(state: SourceStopState, dispatchFrozen: boolean): EnableVerdict {
  if (state === 'unknown') {
    return {
      allowed: false,
      reason: 'the source Host did not confirm that it stopped, so the target copy is not started. A source that '
        + 'cannot be confirmed is not a source that has stopped, and starting the target anyway would leave two live '
        + 'copies of one task.',
    }
  }
  if (state === 'running') {
    return {
      allowed: false,
      reason: 'the source Host reports that the task is still running, so the target binding stays disabled until it '
        + 'confirms a stop',
    }
  }
  if (!dispatchFrozen) {
    return {
      allowed: false,
      reason: 'the source stopped its active turns but has not confirmed that dispatch is frozen; enabling the target '
        + 'now would let the source start new work after the copy was taken',
    }
  }
  return { allowed: true, reason: 'the source confirmed a stop and a frozen dispatch, so the target may be bound' }
}

/** The facts a migration plan is built from. */
export interface MigrationPlanInput {
  readonly taskId: string
  readonly sourceHostId: string
  readonly targetHostId: string
  readonly historyThroughSeq: number
  readonly artifactIds: readonly string[]
  /** Explicit source→target mappings the caller supplied. */
  readonly pathMap: readonly { readonly from: string; readonly to: string }[]
  /** Paths the work depends on, each run through {@link translatePath}. */
  readonly sourcePaths: readonly string[]
  readonly sourceStop: SourceStopState
  readonly dispatchFrozen: boolean
}

/** One planned path translation. */
export interface PlannedPath {
  readonly from: string
  readonly to: string
  readonly mapped: boolean
}

/** The constructed plan: what would move, how paths map, and whether the target may bind. */
export interface MigrationPlan {
  readonly manifest: MigrationManifest
  readonly translations: readonly PlannedPath[]
  readonly enable: EnableVerdict
}

/**
 * Construct what a migration would move, translate its paths, and apply the ordering gate.
 *
 * This is the construction site {@link MigrationManifest} did not have: a type with no
 * caller cannot be shown to name the history range or the artifacts. The plan is still
 * not a transfer — {@link enableTargetAllowed} must pass and a transport must exist
 * before anything is sent — so building it on a Host with no wire still refuses to move
 * work, which is the specification's own "cannot tell → don't" rule rather than a no-op.
 *
 * @param input - the task, the two Hosts, the history cut, the artifacts and the paths.
 * @returns the manifest, every path translation, and whether the target may be enabled.
 */
export function planMigration(input: MigrationPlanInput): MigrationPlan {
  const manifest: MigrationManifest = {
    taskId: input.taskId,
    sourceHostId: input.sourceHostId,
    targetHostId: input.targetHostId,
    historyThroughSeq: input.historyThroughSeq,
    artifactIds: [...input.artifactIds],
    pathMap: input.pathMap.map(entry => ({ from: entry.from, to: entry.to })),
  }
  const translations = input.sourcePaths.map(path => {
    const translated = translatePath(manifest, path)
    return { from: path, to: translated.path, mapped: translated.mapped }
  })
  const enable = enableTargetAllowed(input.sourceStop, input.dispatchFrozen)
  return {
    manifest,
    translations,
    enable: enable.allowed && translations.some(entry => !entry.mapped)
      ? { allowed: false, reason: 'required source paths remain unmapped, so the target binding cannot be enabled' }
      : enable,
  }
}

/** One operation as the reconciliation compares it. */
export interface ReconcilableOperation {
  readonly operationId: string
  readonly delivery: OperationRecord['delivery']
  readonly withdrawn: boolean
  /** What the target Host reported for this operation id, when it has been asked. */
  readonly remoteDelivery?: OperationRecord['delivery'] | undefined
}

/** What reconciliation decided for one operation. */
export interface Reconciliation {
  readonly operationId: string
  readonly action: 'adopt' | 'reconcile' | 'ignore'
  readonly reason: string
}

/**
 * Reconcile operations across a recovered link, by operation id.
 *
 * PRD §二.14.1: "网络恢复后按操作 ID 对账，不盲目重发" — after a network recovery, reconcile
 * by operation id rather than blindly resending. The rule is the same one the local
 * crash-window recovery already follows, so this reuses {@link recoveryAction} rather than
 * inventing a second classification that could disagree with it.
 *
 * An operation the remote reports as accepted is **adopted** — the local record is
 * backfilled from the remote's answer, and nothing is sent. One that entered dispatch
 * without a confirmable result stays uncertain. Nothing here resends.
 *
 * @param operations - the operations to reconcile.
 * @returns one decision per operation, in the order given.
 */
export function reconcile(operations: readonly ReconcilableOperation[]): Reconciliation[] {
  return operations.map(operation => {
    if (operation.withdrawn) {
      return {
        operationId: operation.operationId,
        action: 'ignore' as const,
        reason: 'it was withdrawn, so it is not delivered to the target either',
      }
    }
    if (operation.remoteDelivery === 'accepted' || operation.remoteDelivery === 'consumed') {
      return {
        operationId: operation.operationId,
        action: 'adopt' as const,
        reason: `the remote reports it as ${operation.remoteDelivery}, so the local record is backfilled from the `
          + 'remote and nothing is sent',
      }
    }
    const action = recoveryAction(operation)
    if (action === 'continue') {
      return {
        operationId: operation.operationId,
        action: 'reconcile' as const,
        reason: 'it never entered dispatch locally and the remote does not report it, so it needs the user to decide '
          + 'whether it should be sent — it is not resent automatically',
      }
    }
    if (action === 'reconcile') {
      return {
        operationId: operation.operationId,
        action: 'reconcile' as const,
        reason: `it entered dispatch locally as ${operation.delivery} and the remote does not report it, so its `
          + 'delivery is unknown across the link and must be established, never resent',
      }
    }
    return {
      operationId: operation.operationId,
      action: 'ignore' as const,
      reason: `it is settled locally as ${operation.delivery} and needs nothing`,
    }
  })
}

/**
 * Whether cross-Host migration is available at all.
 *
 * PRD §二.14.1 makes it phase C and **default off**, and the transport it specifies — a
 * Host Router, a remote Companion Bridge reached over the user's existing SSH
 * configuration, and private local IPC — must also be explicitly configured. Saved
 * registry metadata alone does not establish an operational transport.
 *
 * @param enabled - whether configuration turns cross-Host on.
 * @param registered - the remote Hosts the user has registered by hand.
 * @returns whether migration is available, and why not when it is not.
 */
export function remoteAvailability(
  enabled: boolean,
  registered: readonly RemoteHost[],
  transportReady = false,
): { readonly available: boolean; readonly reason: string } {
  if (!enabled) {
    return {
      available: false,
      reason: 'cross-Host work is disabled by default. It requires explicit Host Router and Companion Bridge '
        + 'configuration over existing SSH and private local IPC; nothing has been sent.',
    }
  }
  if (registered.length === 0) {
    return {
      available: false,
      reason: 'cross-Host is switched on in configuration, but no remote Host has been registered. A remote must be '
        + 'registered by hand — work is never sent to a Host the user has not named.',
    }
  }
  if (!transportReady || !registered.some(host => host.enabled)) return {
    available: false, reason: 'saved Host metadata does not establish a configured and enabled SSH Companion Bridge route',
  }
  return { available: true, reason: 'an explicit enabled route is configured; each operation still requires live identity, version, model and workspace capability checks' }
}
