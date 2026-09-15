/**
 * Local export and the share surface (PRD §二.14.2).
 *
 * An export is a **fixed snapshot** of a task, and three requirements decide its shape:
 *
 * 1. **It excludes credentials, environment-variable values and full raw tool output.**
 *    This is done by building the document from an explicit allow-list of fields rather
 *    than by stripping a deny-list from something already assembled. A deny-list has to
 *    anticipate every name a secret might have — and the one it misses is the one that
 *    leaks — while an allow-list cannot leak a field nobody chose to include.
 * 2. **It reports what it left out**, not only what it kept. An export whose reader
 *    cannot tell whether a credential was omitted or was never there is an export that
 *    cannot be checked, so {@link ExportSnapshot.redactions} names each exclusion.
 * 3. **It is not a restore package.** The document carries that statement itself rather
 *    than relying on documentation beside it, because a JSON file with a session chain
 *    in it looks like something that could be replayed.
 *
 * The share half is a *surface that is off*: PRD §二.14.2 makes online sharing a separate
 * self-hosted service that is unconfigured and disabled by default, so
 * {@link shareAvailability} reports why it is unavailable and what would have to exist
 * for it to be otherwise. Refusing with a reason is the implementation, not a
 * placeholder for one.
 *
 * @module dsh-session-conductor/service/export
 */

import { describeSessionContinuation } from '../domain/session-chain.ts'

/** The formats a local export supports. */
export const EXPORT_FORMATS = ['markdown', 'json'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** What a caller supplies to build an export. */
export interface ExportInput {
  readonly format: ExportFormat
  /** The instant the snapshot is exact at; later changes are not reflected. */
  readonly cutoffAt: string
  readonly task: {
    readonly taskId: string
    readonly title: string
    readonly preparation: string
    readonly groupId?: string | undefined
    readonly pinned?: boolean | undefined
    readonly archived?: boolean | undefined
  }
  /** The session chain, oldest first, with the current binding last. */
  readonly sessionChain: readonly {
    readonly bindingId: string
    readonly sessionId: string
    readonly version: number
    readonly retired?: boolean | undefined
  }[]
  /** The run status a reader would need: what is happening, and what needs a human. */
  readonly runStatus: {
    readonly execution: string
    readonly lastTurn?: string | undefined
    /** PRD §二.1 / §二.7 最近进展; the Host's own reason for that last turn. */
    readonly lastTurnDetail?: string | undefined
    readonly pendingInteraction?: string | undefined
  }
  readonly artifacts: readonly {
    readonly artifactId: string
    readonly kind: string
    readonly version: number
    readonly existence: string
    readonly acceptance: string
  }[]
  /** Artifact ids the caller asked to include as an attachment bundle. */
  readonly attachmentIds?: readonly string[] | undefined
}

/** One thing the export left out, and why. */
export interface Redaction {
  readonly what: string
  readonly why: string
}

/** A built snapshot. */
export interface ExportSnapshot {
  readonly format: ExportFormat
  readonly cutoffAt: string
  /** Always true, and stated so a reader does not have to infer it from the schema. */
  readonly notRestorable: true
  readonly notRestorableNote: string
  readonly task: ExportInput['task']
  readonly sessionChain: ExportInput['sessionChain']
  readonly runStatus: ExportInput['runStatus']
  readonly artifacts: ExportInput['artifacts']
  readonly attachments: {
    readonly included: boolean
    readonly artifactIds: readonly string[]
    readonly note: string
  }
  readonly redactions: readonly Redaction[]
}

/**
 * The exclusions every export carries.
 *
 * Written as a constant so the note beside the document and the document's own list
 * cannot drift, and so a reader sees the same three exclusions in every format.
 */
export const DEFAULT_REDACTIONS: readonly Redaction[] = [
  { what: 'credentials and tokens', why: 'an export is a file that leaves the Host, and a credential in it cannot be recalled' },
  { what: 'environment variable values', why: 'only the names are exported; a value may be a secret and is not needed to read the snapshot' },
  { what: 'full raw tool output', why: 'raw output can carry file contents and secrets; the snapshot records what a tool was and what it produced in summary, not the verbatim bytes' },
]

/** The statement that keeps an export from being mistaken for a restore package. */
export const NOT_RESTORABLE_NOTE =
  'This is a snapshot for reading, not a restore package. It records what the task looked like at the cutoff; it '
  + 'cannot be replayed into a working session, and replaying it would not restore the files, credentials or '
  + 'in-flight state the task had.'

/**
 * Redact an environment map, keeping the names.
 *
 * Names are what a reader needs to understand a snapshot; values are what leak. A value
 * that is absent stays absent, so "not set" and "set to something withheld" remain
 * distinguishable — collapsing them would tell a reader the opposite of the truth.
 *
 * @param environment - the environment as the caller holds it.
 * @returns the names, with every value replaced by a marker.
 */
export function redactEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const redacted: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    redacted[name] = value === undefined ? '(not set)' : '(value withheld)'
  }
  return redacted
}

/**
 * Reduce a tool's raw output to something an export may carry.
 *
 * Only the length survives: even the first line can contain credentials, so a preview
 * of arbitrary raw output cannot be described as redacted.
 *
 * @param output - the raw output.
 * @returns the summary an export carries.
 */
export function redactToolOutput(output: string): string {
  return `(raw output withheld: ${String(output.length)} characters)`
}

/**
 * Build a fixed snapshot from the fields an export may carry.
 *
 * The document is assembled from this function's own list of fields, so a field the
 * caller passes that is not named here is not exported — which is the direction the
 * choice has to go for a credential never to leave by accident.
 *
 * @param input - what to export.
 * @returns the snapshot.
 */
export function buildExport(input: ExportInput): ExportSnapshot {
  const attachmentIds = [...(input.attachmentIds ?? [])]
  const included = attachmentIds.length > 0
  return {
    format: input.format,
    cutoffAt: input.cutoffAt,
    notRestorable: true,
    notRestorableNote: NOT_RESTORABLE_NOTE,
    task: {
      taskId: input.task.taskId,
      title: input.task.title,
      preparation: input.task.preparation,
      ...input.task.groupId === undefined ? {} : { groupId: input.task.groupId },
      ...input.task.pinned === undefined ? {} : { pinned: input.task.pinned },
      ...input.task.archived === undefined ? {} : { archived: input.task.archived },
    },
    sessionChain: input.sessionChain.map(binding => ({
      bindingId: binding.bindingId,
      sessionId: binding.sessionId,
      version: binding.version,
      ...binding.retired === undefined ? {} : { retired: binding.retired },
    })),
    runStatus: {
      execution: input.runStatus.execution,
      ...input.runStatus.lastTurn === undefined ? {} : { lastTurn: input.runStatus.lastTurn },
      ...input.runStatus.lastTurnDetail === undefined ? {} : { lastTurnDetail: input.runStatus.lastTurnDetail },
      ...input.runStatus.pendingInteraction === undefined ? {} : { pendingInteraction: input.runStatus.pendingInteraction },
    },
    artifacts: input.artifacts.map(artifact => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      version: artifact.version,
      existence: artifact.existence,
      acceptance: artifact.acceptance,
    })),
    attachments: {
      included,
      artifactIds: attachmentIds,
      note: included
        ? `${String(attachmentIds.length)} artifact(s) are named as the attachment bundle. Their contents are not `
          + 'embedded in this document: the bundle is a separate set of files, and what is listed here is which '
          + 'artifacts it contains.'
        : 'No attachment bundle was requested, so this export contains no artifact contents.',
    },
    redactions: DEFAULT_REDACTIONS.map(redaction => ({ ...redaction })),
  }
}

/**
 * Render a snapshot as Markdown.
 *
 * @param snapshot - the snapshot.
 * @returns the document.
 */
export function renderMarkdown(snapshot: ExportSnapshot): string {
  const lines = [
    `# Export: ${snapshot.task.title}`,
    '',
    `- Task: \`${snapshot.task.taskId}\``,
    `- Preparation: ${snapshot.task.preparation}`,
    `- Snapshot exact at: ${snapshot.cutoffAt}`,
    ...snapshot.task.groupId === undefined ? [] : [`- Group: ${snapshot.task.groupId}`],
    `- Pinned: ${String(snapshot.task.pinned ?? false)}; archived: ${String(snapshot.task.archived ?? false)}`,
    '',
    '## Run status',
    '',
    `- Execution: ${snapshot.runStatus.execution}`,
    ...snapshot.runStatus.lastTurn === undefined ? [] : [`- Last turn: ${snapshot.runStatus.lastTurn}`],
    ...snapshot.runStatus.lastTurnDetail === undefined ? [] : [`- Recent progress: ${snapshot.runStatus.lastTurnDetail}`],
    ...snapshot.runStatus.pendingInteraction === undefined ? [] : [`- Waiting on: ${snapshot.runStatus.pendingInteraction}`],
    '',
    '## Session chain',
    '',
    ...(() => {
      if (snapshot.sessionChain.length === 0) return ['No session is bound to this task.']
      const continuation = describeSessionContinuation(snapshot.sessionChain.map(binding => ({
        sessionId: binding.sessionId,
        current: binding.retired !== true,
        retired: binding.retired === true,
      })))
      return [
        ...continuation === undefined ? [] : [`- ${continuation}`],
        ...snapshot.sessionChain.map(binding =>
          `- v${String(binding.version)} \`${binding.sessionId}\` (binding ${binding.bindingId})`
          + (binding.retired === true ? ' — retired' : ' — current')),
      ]
    })(),
    '',
    '## Artifacts',
    '',
    ...snapshot.artifacts.length === 0
      ? ['No artifacts are recorded.']
      : snapshot.artifacts.map(artifact =>
          `- \`${artifact.artifactId}\` [${artifact.kind}] v${String(artifact.version)} — `
          + `existence ${artifact.existence}, acceptance ${artifact.acceptance}`),
    '',
    '## Attachments',
    '',
    snapshot.attachments.note,
    ...snapshot.attachments.artifactIds.map(id => `- ${id}`),
    '',
    '## Excluded from this export',
    '',
    ...snapshot.redactions.map(redaction => `- **${redaction.what}** — ${redaction.why}`),
    '',
    '## What this is',
    '',
    snapshot.notRestorableNote,
  ]
  return lines.join('\n')
}

/**
 * Render a snapshot as JSON.
 *
 * @param snapshot - the snapshot.
 * @returns the document.
 */
export function renderJson(snapshot: ExportSnapshot): string {
  return JSON.stringify(snapshot, null, 2)
}

/**
 * Whether the online share surface is available.
 *
 * PRD §二.14.2 uses a separate self-hosted HTTPS snapshot service. Configuration alone
 * does not prove a client exists, and a configured client is not a network-health assertion.
 *
 * @param enabled - whether the configuration turns sharing on.
 * @returns whether sharing is available, and why not when it is not.
 */
export function shareAvailability(enabled: boolean, clientConfigured = false): { readonly available: boolean; readonly reason: string } {
  if (!enabled) {
    return {
      available: false,
      reason: 'online sharing is disabled by default. Enabling it needs a separate self-hosted HTTPS snapshot '
        + 'service: the conductor will not upload a snapshot without one, and '
        + 'it does not stand in for one with a locally served copy.',
    }
  }
  if (clientConfigured) return {
    available: true,
    reason: 'sharing is enabled and an HTTPS snapshot client is configured; preview and explicit confirmation are required before publication',
  }
  return {
    available: false,
    reason: 'online sharing is switched on in configuration, but no snapshot service is registered in this Host. '
      + 'A concrete service would have to be provided before any snapshot could be published; until then no address '
      + 'exists, nothing has been uploaded, and nothing has been shared.',
  }
}

/**
 * The rules a published snapshot would have to obey.
 *
 * Recorded here so the preview a user would see can state them, and so the requirements
 * are not rediscovered when the service exists. PRD §二.14.2 fixes all six.
 */
export const SHARE_RULES: readonly string[] = [
  'a preview is shown before anything is published',
  'the snapshot is uploaded only after an explicit publish, and is fixed at that point',
  'the address uses an unguessable identifier and expires after 7 days by default',
  'the status can be queried and the share can be revoked',
  'later changes to the session are not reflected in the snapshot',
  'revoking stops future access but cannot recall copies that were already downloaded, and the service serves the '
    + 'snapshot only — it exposes no way to execute anything',
]
