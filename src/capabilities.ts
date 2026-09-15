/**
 * Host capability probing (PRD §一.5 and §三.6 "版本与迁移").
 *
 * The specification requires three separate versions to be tracked — the
 * plugin protocol, the persisted data schema, and the Host capability set — and
 * requires the probe to run at startup. It also requires the plugin to *disable*
 * a write capability it cannot prove, showing the reason, rather than silently
 * falling back to different semantics.
 *
 * Two capabilities are special: they are the Host API compatibility extensions
 * the specification names in §一.5 (`selectModel.rememberAsDefault` and the
 * `fork` target parameters). The pinned Host builds are not required to ship
 * them, so this module treats "not proven" as "unavailable" and the features
 * that depend on them stay off with a readable reason.
 *
 * @module dsh-session-conductor/capabilities
 */

import { MODEL_SELECTION_WRITER_SERVICE, modelSelectionWriterOf } from './service/modelconfig.ts'

/** Plugin protocol version, bumped when the tool/Remote contract changes incompatibly. */
export const PROTOCOL_VERSION = '1.0'

/** Persisted data schema version; the upgrade chain lives in `store/migrate.ts`. */
export const DATA_SCHEMA_VERSION = 1

/** Service keys the conductor reads, and how badly each one is needed. */
export const REQUIRED_SERVICES = [
  /** Model-facing tool registry; without it no `conductor_*` tool can exist. */
  'tools',
  /** Live Agent inventory and lifecycle; without it no session can be driven. */
  'agents',
  /** Session lookup and observation, used for discovery and history. */
  'sessionQuery',
  /**
   * The plugin's own storage domain facility (PRD §三.5). The Host mounts it
   * only in compositions that include the storage stack, so a minimal
   * composition legitimately lacks it — and then nothing may be persisted.
   */
  'storageDomain',
] as const

/** Service keys that unlock optional behaviour when the Host composes them. */
export const OPTIONAL_SERVICES = [
  /**
   * Callable writer mounted only by the companion model-selection extension.
   *
   * The operator declaration says that an extension was installed; this service
   * proves that the current Host process can actually perform the isolated write.
   */
  MODEL_SELECTION_WRITER_SERVICE,
  /** Callable explicit-target fork supplied by the separate Host compatibility companion. */
  'conductorSessionFork',
  /** Bounded atomic byte writes supplied by the separate baseline-verified filesystem companion. */
  'conductorBinaryFiles',
  /**
   * Workspace registry, needed to register a worktree as a workspace
   * (PRD §二.4). The Host key is `workspaceRegistry`, not `workspaces`.
   */
  'workspaceRegistry',
  /** User settings service, used to expose the conductor's own options in the UI. */
  'settings',
  /** Host web surface; the session-transfer and share features need it. */
  'webServer',
  /** Host scheduling service; the conductor keeps its own scheduler, this is informational. */
  'schedule',
  /** Approval service, used to surface a target's pending approval as an intervention. */
  'approval',
  /** Session user-question service, used to surface a target's open question. */
  'userQuestions',
  /** Session persistence, used to recover history after a Host restart. */
  'sessionPersistence',
  /** Session store, used to observe live sessions and flush them before a handoff. */
  'sessions',
  /** Storage hub, reported alongside the domain facility so a partial stack is visible. */
  'storage',
  /**
   * Subprocess service, the Git adapter's only way to run `git` (PRD §二.4).
   *
   * Optional on purpose. The Host has no git surface of its own, so a composition without this
   * seam cannot prepare a Git starting state at all, and the honest answer there is "the feature
   * is off, here is why" rather than a worktree-shaped claim nothing can back.
   */
  'subprocess',
  /** Host filesystem service, used to copy the untracked paths a snapshot was asked to carry. */
  'fs',
] as const

export type RequiredService = (typeof REQUIRED_SERVICES)[number]
export type OptionalService = (typeof OPTIONAL_SERVICES)[number]

/**
 * Feature ids the rest of the plugin gates on.
 *
 * Every one of these is a *write* or stateful capability: read-only display of
 * already-persisted data stays available even when a Host gap disables the
 * corresponding write (PRD §三.6: "已有可读数据仍可查看").
 */
export const FEATURES = [
  /** Registering the `conductor_*` model tools. */
  'model_tools',
  /** Creating, forking and driving ordinary sessions. */
  'session_driving',
  /** Persisting tasks, bindings and operations. */
  'durable_state',
  /** Selecting a model for a target without touching the Host's global default. */
  'model_selection_isolated',
  /** Creating a fork at an explicit session id and working directory. */
  'fork_target_control',
  /** Registering a worktree as a workspace. */
  'workspace_registration',
  /**
   * Preparing a Git starting state and creating a worktree (PRD §二.4).
   *
   * Gated on the subprocess seam rather than on `git` itself, because the probe is synchronous
   * and resolving an executable is not. A composition that mounts no subprocess service cannot
   * run `git` at all; one that mounts it may still fail to find `git`, and that is reported by
   * the create call, with the same "no fallback to the original directory" rule either way.
   */
  'git_start_states',
  /** Persisting conductor options through the Host settings service. */
  'settings_surface',
] as const
export type FeatureId = (typeof FEATURES)[number]

/** Availability of one probed service. */
export interface ServiceAvailability {
  /** Whether the service object was found on the context. */
  readonly present: boolean
  /** Reason the capability is unavailable; always set when `present` is false. */
  readonly reason?: string
}

/** Availability of one gated feature. */
export interface FeatureAvailability {
  readonly available: boolean
  /** Reason the feature is disabled; always set when `available` is false. */
  readonly reason?: string
}

/**
 * Whether the conductor's own storage domain actually opened.
 *
 * This is deliberately separate from the `durable_state` feature: that feature
 * reports whether the Host *offers* a domain facility, while this reports
 * whether *this plugin's* medium opened. The two can disagree — a Host with the
 * storage stack mounted still refuses a domain whose stamped version differs, or
 * whose stored records no longer match the schema — and an operator needs to
 * see that difference rather than a single "enabled".
 */
export interface StoreStatus {
  readonly available: boolean
  /** Reason the conductor has no durable state; always set when unavailable. */
  readonly reason?: string
  /**
   * How many operations the restart could not resolve (PRD §四.5).
   *
   * The calibration announces what it did at mount, but a mount log is not something a caller can ask; the
   * snapshot is the surface the PRD designates for the state of the environment, so the count belongs here.
   * It is what makes "was anything left mid-dispatch?" answerable after the fact rather than only in a log
   * line someone had to be watching for.
   */
  readonly unresolvedOperations?: number | undefined
  /** What is unresolved and why, when anything is. Never a resend: these are awaiting reconciliation. */
  readonly unresolvedNote?: string | undefined
}

/** The Host compatibility extensions the specification names (PRD §一.5). */
export interface HostExtensionReport {
  /** `selectModel` accepting `rememberAsDefault`. */
  readonly selectModelRememberAsDefault: FeatureAvailability
  /** `fork` accepting `newSessionId`, `workspaceId` and `cwd`. */
  readonly forkTargetParameters: FeatureAvailability
}

/** The complete capability snapshot returned by `conductor_capabilities`. */
export interface CapabilitySnapshot {
  readonly protocolVersion: string
  readonly dataSchemaVersion: number
  readonly pluginVersion: string
  readonly host: {
    readonly nodeVersion: string
    readonly platform: string
    readonly arch: string
  }
  readonly services: Readonly<Record<string, ServiceAvailability>>
  readonly extensions: HostExtensionReport
  readonly features: Readonly<Record<FeatureId, FeatureAvailability>>
  /** Whether this plugin's own storage domain opened, and why not when it did not. */
  readonly store: StoreStatus
  /** When the probe ran, ISO 8601 UTC. */
  readonly probedAt: string
}

/** Minimal context surface the probe needs, so it can be unit tested. */
export interface ProbeContext {
  /**
   * Look up a service by its `ctx` key.
   * @param name - the service key.
   * @returns the service, or undefined when this composition does not provide it.
   */
  get(name: string): unknown
}

/** Description of one feature's requirements, used to build the report. */
interface FeatureRule {
  readonly feature: FeatureId
  /** The probe decides availability; the reason string is returned when unavailable. */
  readonly evaluate: (input: FeatureInput) => string | undefined
}

/** Everything a feature rule may inspect. */
interface FeatureInput {
  readonly services: Readonly<Record<string, ServiceAvailability>>
  readonly extensions: HostExtensionReport
  /** Raw service lookup verifies that a declared companion actually mounts its callable surface. */
  readonly context: ProbeContext
}

/**
 * The extension is only ever *proven* by an operator declaration or a
 * machine-readable Host declaration; nothing else may turn it on.
 *
 * A guess would be worse than a refusal here: the specification's whole point in
 * §一.5 is that a Host without the extension must not be driven with the
 * different semantics the un-extended call would produce (writing the global
 * default model, or forking into the source directory).
 */
const EXTENSION_UNVERIFIED_REASON =
  'the installed Host exposes no machine-readable declaration for this parameter; '
  + 'install the companion Host extension for the pinned baseline (see docs/host-extension.md) '
  + 'and declare it in the conductor config to enable this feature'

/** Feature gating rules, in report order. */
const FEATURE_RULES: readonly FeatureRule[] = [
  {
    feature: 'model_tools',
    evaluate: ({ services }) => services['tools']?.present === true
      ? undefined
      : 'this Host composition mounts no tool registry (ctx.tools)',
  },
  {
    feature: 'session_driving',
    evaluate: ({ services }) => services['agents']?.present === true
      ? undefined
      : 'this Host composition mounts no agent registry (ctx.agents)',
  },
  {
    feature: 'durable_state',
    evaluate: ({ services }) => services['storageDomain']?.present === true
      ? undefined
      : 'this Host composition mounts no plugin storage domain facility (ctx.storageDomain); '
        + 'tasks, bindings and operations would be lost on restart, so managed writes stay disabled',
  },
  {
    feature: 'model_selection_isolated',
    evaluate: ({ extensions, context }) => {
      if (!extensions.selectModelRememberAsDefault.available) return EXTENSION_UNVERIFIED_REASON
      try {
        return modelSelectionWriterOf(context.get(MODEL_SELECTION_WRITER_SERVICE)) === undefined
          ? 'the companion Host extension is declared, but it mounts no callable session-model writer '
            + '(ctx.conductorSessionModelSelection) in this process; model changes stay disabled rather than '
            + 'being reported as applied.'
          : undefined
      } catch {
        return 'the companion Host extension is declared, but its session-model writer could not be read from '
          + 'ctx.conductorSessionModelSelection; model changes stay disabled rather than being reported as applied.'
      }
    },
  },
  {
    feature: 'fork_target_control',
    evaluate: ({ extensions, context }) => {
      if (!extensions.forkTargetParameters.available) {
        return 'the Host\'s own fork command takes no target session id, workspace or working directory. '
          + 'This does not gate the conductor\'s fork: it assembles the child through the Host agent '
          + 'factory and the Host preset service, so it chooses the child\'s identity and directory itself. '
          + `What stays unavailable is the Host command's own target control: ${EXTENSION_UNVERIFIED_REASON}`
      }
      try {
        const service = context.get('conductorSessionFork') as { fork?: unknown } | null | undefined
        return typeof service?.fork === 'function'
          ? undefined
          : 'the companion Host extension is declared, but it mounts no callable explicit-target fork '
            + '(ctx.conductorSessionFork.fork) in this process; the Host command\'s target control stays disabled.'
      } catch {
        return 'the companion Host extension is declared, but its explicit-target fork could not be read from '
          + 'ctx.conductorSessionFork; the Host command\'s target control stays disabled.'
      }
    },
  },
  {
    feature: 'workspace_registration',
    evaluate: ({ services }) => services['workspaceRegistry']?.present === true
      ? undefined
      : 'this Host composition mounts no workspace registry (ctx.workspaceRegistry)',
  },
  {
    feature: 'git_start_states',
    evaluate: ({ services }) => services['subprocess']?.present === true
      ? undefined
      : 'this Host composition mounts no subprocess service (ctx.subprocess), which is the only way to run `git` '
        + 'here. Creating a task from a Git starting state and creating a worktree are therefore unavailable; a task '
        + 'can still be created in an existing or plain directory.',
  },
  {
    feature: 'settings_surface',
    evaluate: ({ services }) => services['settings']?.present === true
      ? undefined
      : 'this Host composition mounts no settings service (ctx.settings)',
  },
]

/** How the operator has declared the two Host extensions in the plugin config. */
export interface ExtensionDeclaration {
  /**
   * `selectModel` accepts `rememberAsDefault`.
   *
   * `true` means the operator confirms the companion Host extension is
   * installed; the plugin then passes `rememberAsDefault: false` so a target's
   * model change never rewrites the Host's global default (PRD §一.5, T06).
   */
  readonly selectModelRememberAsDefault: boolean
  /** `fork` accepts `newSessionId`, `workspaceId` and `cwd`. */
  readonly forkTargetParameters: boolean
}

/**
 * Probe the context and build the snapshot.
 *
 * @param ctx - the live plugin context (or a test double).
 * @param options - plugin version, the operator's extension declaration, and the
 * current storage-domain outcome.
 * @returns the capability snapshot, with a reason on every disabled feature.
 */
export function probeCapabilities(
  ctx: ProbeContext,
  options: { pluginVersion: string; declared: ExtensionDeclaration; store: StoreStatus },
): CapabilitySnapshot {
  const services: Record<string, ServiceAvailability> = {}
  for (const name of [...REQUIRED_SERVICES, ...OPTIONAL_SERVICES]) {
    services[name] = probeService(ctx, name)
  }
  const extensions: HostExtensionReport = {
    selectModelRememberAsDefault: declared(options.declared.selectModelRememberAsDefault),
    forkTargetParameters: declared(options.declared.forkTargetParameters),
  }
  const features = {} as Record<FeatureId, FeatureAvailability>
  for (const rule of FEATURE_RULES) {
    const reason = rule.evaluate({ services, extensions, context: ctx })
    features[rule.feature] = reason === undefined ? { available: true } : { available: false, reason }
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    dataSchemaVersion: DATA_SCHEMA_VERSION,
    pluginVersion: options.pluginVersion,
    host: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    services,
    extensions,
    features,
    store: options.store,
    probedAt: new Date().toISOString(),
  }
}

/**
 * Build one extension availability entry from the operator's declaration.
 * @param enabled - whether the operator declared the extension installed.
 * @returns the availability record.
 */
function declared(enabled: boolean): FeatureAvailability {
  return enabled ? { available: true } : { available: false, reason: EXTENSION_UNVERIFIED_REASON }
}

/**
 * Look one service up defensively.
 *
 * A `get` that throws is reported as absent with the thrown message, because a
 * half-disposed registry must not take the conductor down with it.
 *
 * @param ctx - the probe context.
 * @param name - the service key.
 * @returns the availability record.
 */
function probeService(ctx: ProbeContext, name: string): ServiceAvailability {
  try {
    const service = ctx.get(name)
    if (service === undefined || service === null) {
      return { present: false, reason: `service "${name}" is not mounted in this composition` }
    }
    return { present: true }
  } catch (error) {
    return {
      present: false,
      reason: `probing service "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Render a snapshot for the model, listing every disabled feature with its reason.
 *
 * The PRD requires unavailable capabilities to be *shown* with a reason rather
 * than silently omitted, so the renderer never hides a `false`.
 *
 * @param snapshot - a probe result.
 * @returns the model-facing text.
 */
export function describeCapabilities(snapshot: CapabilitySnapshot): string {
  const lines: string[] = [
    `dsh-session-conductor ${snapshot.pluginVersion} (protocol ${snapshot.protocolVersion}, data schema v${String(snapshot.dataSchemaVersion)})`,
    `Host runtime: node ${snapshot.host.nodeVersion} on ${snapshot.host.platform}/${snapshot.host.arch}`,
    '',
    'Services:',
  ]
  for (const [name, state] of Object.entries(snapshot.services)) {
    lines.push(`  - ${name}: ${state.present ? 'present' : `absent — ${state.reason ?? 'unknown reason'}`}`)
  }
  lines.push('', 'Features:')
  for (const [name, state] of Object.entries(snapshot.features)) {
    lines.push(`  - ${name}: ${state.available ? 'enabled' : `disabled — ${state.reason ?? 'unknown reason'}`}`)
  }
  lines.push(
    '',
    snapshot.store.available
      ? 'Durable state: open (the conductor storage domain is mounted).'
      : `Durable state: not open — ${snapshot.store.reason ?? 'unknown reason'}`,
  )
  // A restart's account, made readable on demand. Reported only when there is something to report: a line
  // saying "0 unresolved" on every snapshot would train a reader to skip the one that matters.
  if (snapshot.store.available === true && (snapshot.store.unresolvedOperations ?? 0) > 0) {
    lines.push(
      `Unresolved operations: ${String(snapshot.store.unresolvedOperations ?? 0)}. `
      + `${snapshot.store.unresolvedNote ?? ''}`.trim(),
    )
  }
  return lines.join('\n')
}
