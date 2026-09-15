/**
 * Plugin configuration, with the PRD §四.7 defaults as schema defaults.
 *
 * The cordis Loader validates a row's `config` against this schema, so a
 * profile that overrides the conductor row sees a named field error instead of
 * a silently ignored typo. Every field carries a default, because the shipped
 * `cordis.patch.yml` row deliberately sets none.
 *
 * @module dsh-session-conductor/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULTS, IMPLEMENTATION_DEFAULTS } from './domain/defaults.ts'

/**
 * The two Host API compatibility extensions of PRD §一.5.
 *
 * Both default to `false` and both must be declared by the operator after the
 * companion Host extension is installed. Nothing in the conductor may infer
 * them: the un-extended Host calls would produce *different* semantics — a
 * global default-model write, and a fork into the source directory — which is
 * exactly the silent fallback the specification forbids.
 */
export interface HostExtensionConfig {
  /**
   * `selectModel` accepts `rememberAsDefault` and the plugin passes `false`.
   *
   * This is a declaration only: the current Host process must also mount the
   * callable `ctx.conductorSessionModelSelection` writer before a change is enabled.
   */
  readonly selectModelRememberAsDefault: boolean
  /** `fork` accepts `newSessionId`, `workspaceId` and `cwd`. */
  readonly forkTargetParameters: boolean
}

/** Everything a profile may configure on the conductor. */
export interface ConductorConfig {
  /** Operator-owned SSH routes; model tool parameters cannot introduce shell commands or credentials. */
  readonly remoteConnections?: {hostId:string;sshAlias:string;nodePath:string;bridgePath:string;descriptorPath:string}[]
  readonly bridge?: {hostId:string;controllerSessionId:string;runtimeRoot:string;profileId:string;workspaceRoots:string[]}
  /** Maximum number of targets one controller session may manage. */
  readonly managedTargetLimit: number
  /** Plugin-initiated target turns per Host, waiting-on-human turns included. */
  readonly targetTurnConcurrency: number
  /** Notification turns per Host, held separate from the target budget. */
  readonly noticeConcurrency: number
  /** Panel refresh coalescing interval in milliseconds. */
  readonly panelRefreshMergeMs: number
  /** Window in which events for one controller session merge into one notice. */
  readonly noticeMergeWindowMs: number
  /** Messages returned by a read when the caller does not ask for a count. */
  readonly defaultReadLimit: number
  /** Maximum characters in one tool result before the truncation marker. */
  readonly toolTextLimit: number
  /** Ceiling for a single synchronous `wait`, in milliseconds. */
  readonly waitLimitMs: number
  /** How long an `interrupt_and_send` waits for a confirmed stop, in milliseconds. */
  readonly interruptConfirmLimitMs: number
  /**
   * How long the conductor waits between its own background passes, in milliseconds.
   *
   * Not one of the specification's defaults — the defaults table has no row for it,
   * because it is an implementation interval rather than specified behaviour. It is
   * documented as such rather than presented as a PRD figure: without a pass of its
   * own the conductor has no automatic reporting and no scheduled checks at all, and
   * this is the interval that provides them. The default sits above the 2-second
   * report merge window so ordinary events still merge, and far below the minute
   * granularity a calendar schedule can express.
   */
  readonly passIntervalMs: number
  /** Automatic rework rounds per workflow run; the initial execution does not count. */
  readonly reworkRounds: number
  /** Whether a trusted remote Host may be registered at all. */
  readonly crossHostEnabled: boolean
  /** Whether the online snapshot share surface is enabled. */
  readonly shareEnabled: boolean
  readonly shareServiceUrl?: string
  readonly shareTokenEnv?: string
  readonly shareCaFile?: string
  /**
   * How long a published share lives, in days (PRD §四.7: 7 by default).
   *
   * A share has no login on the far end — its unguessable address is the whole of the
   * access control — so the lifetime is the second half of that control and is a
   * configuration value rather than a constant buried in the publish path.
   */
  readonly shareLifetimeDays: number
  /** Host extension declarations; see {@link HostExtensionConfig}. */
  readonly hostExtensions: HostExtensionConfig
}

/** Schema for {@link HostExtensionConfig}. */
const HostExtensions: z<HostExtensionConfig> = z.object({
  selectModelRememberAsDefault: z.boolean().default(false),
  forkTargetParameters: z.boolean().default(false),
})

/** Schema for {@link ConductorConfig}. */
export const Config: z<ConductorConfig> = z.object({
  remoteConnections: z.array(z.object({hostId:z.string(),sshAlias:z.string(),nodePath:z.string(),bridgePath:z.string(),descriptorPath:z.string()})),
  bridge: z.object({hostId:z.string(),controllerSessionId:z.string(),runtimeRoot:z.string(),profileId:z.string(),workspaceRoots:z.array(z.string())}),
  managedTargetLimit: z.natural().default(DEFAULTS.managedTargetLimit),
  targetTurnConcurrency: z.natural().default(DEFAULTS.targetTurnConcurrency),
  noticeConcurrency: z.natural().default(DEFAULTS.noticeConcurrency),
  panelRefreshMergeMs: z.natural().default(DEFAULTS.panelRefreshMergeMs),
  noticeMergeWindowMs: z.natural().default(DEFAULTS.noticeMergeWindowMs),
  defaultReadLimit: z.natural().default(DEFAULTS.defaultReadLimit),
  toolTextLimit: z.natural().default(DEFAULTS.toolTextLimit),
  waitLimitMs: z.natural().default(DEFAULTS.waitLimitMs),
  interruptConfirmLimitMs: z.natural().default(DEFAULTS.interruptConfirmLimitMs),
  passIntervalMs: z.natural().default(IMPLEMENTATION_DEFAULTS.passIntervalMs),
  reworkRounds: z.natural().default(DEFAULTS.reworkRounds),
  crossHostEnabled: z.boolean().default(DEFAULTS.crossHostEnabled),
  shareEnabled: z.boolean().default(DEFAULTS.shareEnabled),
  shareServiceUrl: z.string(),
  shareTokenEnv: z.string(),
  shareCaFile: z.string(),
  shareLifetimeDays: z.natural().default(DEFAULTS.shareLifetimeDays),
  hostExtensions: HostExtensions,
})
