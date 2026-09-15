/** Finite cross-Host protocol, PRD §二.14.1 / T29. No general-purpose RPC or shell action. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalize } from '../domain/operation.ts'

export const REMOTE_PROTOCOL_VERSION = '1'
export const MAX_REMOTE_FRAME_BYTES = 24 * 1024 * 1024
export const MAX_REMOTE_ARTIFACT_BYTES = 8 * 1024 * 1024
const id = z.string().min(1).max(240)
const version = z.number().int().nonnegative()
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const capabilitiesSchema = z.object({
  hostId: id, protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION), pluginVersion: id,
  models: z.array(id).max(10000), workspaceCapable: z.boolean(),
  binaryArtifacts: z.boolean().optional(),
}).strict()
export type RemoteCapabilities = z.infer<typeof capabilitiesSchema>

export const freezeReceiptSchema = z.object({
  migrationId: id, taskId: id, sourceHostId: id, targetHostId: id,
  operationId: id, bindingVersion: version, ownerEpoch: version,
  confirmedStopped: z.literal(true), dispatchFrozen: z.literal(true), freezeToken: id,
}).strict()
export type FreezeReceipt = z.infer<typeof freezeReceiptSchema>

const artifactSchema = z.object({
  artifactId: id, version, sourcePath: z.string().min(1).max(4096),
  relativePath: z.string().min(1).max(4096).refine(path => {
    const parts = path.replace(/\\/g, '/').split('/')
    return !/[\0:]/.test(path) && !path.startsWith('/') && !path.startsWith('\\')
      && parts.every(part => part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  }, 'artifact paths must remain relative to the explicitly selected destination'),
  sha256: digest, bytesBase64: z.string().max(Math.ceil(MAX_REMOTE_ARTIFACT_BYTES / 3) * 4),
}).strict()

export const migrationBundleSchema = z.object({
  migrationId: id, taskId: id, sourceHostId: id, targetHostId: id,
  taskTitle: z.string().max(4096).optional(),
  historyThroughSeq: version,
  // These are completed-context records, not replayable Session events or permissions.
  history: z.array(z.object({
    seq: version, turn: version, role: z.enum(['user', 'assistant', 'tool']),
    source: z.enum(['user', 'relay', 'notice', 'plugin', 'unknown', 'assistant', 'tool']), text: z.string().max(2 * 1024 * 1024),
    completed: z.literal(true),
  }).strict()).max(20000),
  artifacts: z.array(artifactSchema).max(1000),
  requiredModels: z.array(id).max(1000),
}).strict().superRefine((bundle, context) => {
  let previous = -1
  for (const entry of bundle.history) {
    if (entry.seq <= previous || entry.seq > bundle.historyThroughSeq) {
      context.addIssue({ code: 'custom', message: 'history must be an ordered, unique completed prefix at the stated cutoff' })
    }
    previous = entry.seq
  }
  const paths = new Set<string>()
  const identities = new Set<string>()
  for (const artifact of bundle.artifacts) {
    const bytes = Buffer.from(artifact.bytesBase64, 'base64')
    if (bytes.byteLength > MAX_REMOTE_ARTIFACT_BYTES || bytes.toString('base64') !== artifact.bytesBase64
      || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      context.addIssue({ code: 'custom', message: 'artifact bytes must match their full declared digest and size limit' })
    }
    const path = artifact.relativePath.replace(/\\/g, '/').toLowerCase()
    if (paths.has(path) || identities.has(artifact.artifactId)) {
      context.addIssue({ code: 'custom', message: 'duplicate artifact identity or destination path' })
    }
    paths.add(path)
    identities.add(artifact.artifactId)
  }
})
export type MigrationBundle = z.infer<typeof migrationBundleSchema>

export const stageReceiptSchema = z.object({
  migrationId: id, taskId: id, targetHostId: id, stageId: id, sessionId: id,
  bundleDigest: digest, enabled: z.literal(false),
}).strict()
export type StageReceipt = z.infer<typeof stageReceiptSchema>
export const enableReceiptSchema = z.object({
  migrationId: id, taskId: id, targetHostId: id, sessionId: id,
  bindingVersion: version, enabled: z.literal(true),
}).strict()
export type EnableReceipt = z.infer<typeof enableReceiptSchema>
export const abortReceiptSchema = z.object({
  migrationId: id, targetHostId: id, disabled: z.literal(true), abortToken: id,
}).strict()
export type AbortReceipt = z.infer<typeof abortReceiptSchema>

const envelope = { protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION), requestId: id }
const mutation = { ...envelope, operationId: id }
export const remoteRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('capabilities'), payload: z.object({}).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('task.read'), payload: z.object({ taskId: id,
    view: z.enum(['snapshot', 'history']).optional(), afterCursor: z.string().max(8192).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('task.observe'), payload: z.object({taskId:id,afterSeq:z.number().int().min(-1),limit:z.number().int().min(1).max(1000).optional()}).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('operation.read'), payload: z.object({ operationId: id }).strict() }).strict(),
  z.object({ ...mutation, action: z.literal('task.send'), payload: z.object({
    taskId: id, messageId: id, text: z.string().min(1).max(1024 * 1024),
    mode: z.enum(['steer', 'queue']), expectedOwnerEpoch: version, expectedBindingVersion: version,
  }).strict() }).strict(),
  z.object({ ...mutation, action: z.literal('task.stop'), payload: z.object({
    taskId: id, expectedOwnerEpoch: version, expectedBindingVersion: version,
    expectedTurn: version.optional(), expectedStartSeq: version.optional(),
    text: z.string().min(1).max(1024 * 1024).optional(), confirmLimitMs: z.number().int().min(1).max(30000).optional(),
  }).strict() }).strict(),
  z.object({ ...mutation, action: z.literal('task.queue'), payload: z.object({
    taskId: id, action: z.enum(['list', 'edit', 'withdraw']), expectedOwnerEpoch: version, expectedBindingVersion: version,
    messageId: id.optional(), text: z.string().min(1).max(1024 * 1024).optional(),
  }).strict() }).strict(),
  z.object({ ...mutation, action: z.literal('migration.freeze'), payload: z.object({
    migrationId: id, taskId: id, targetHostId: id, expectedOwnerEpoch: version, expectedBindingVersion: version,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('migration.bundle'), payload: z.object({
    receipt: freezeReceiptSchema, historyThroughSeq: version, artifactIds: z.array(id).max(1000),
    targetWorkspace: z.string().min(1).max(4096),
    pathMap: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict()).max(1000),
    requiredModels: z.array(id).max(1000),
  }).strict() }).strict(),
  z.object({ ...mutation, action: z.literal('migration.stage'), payload: z.object({
    receipt: freezeReceiptSchema, bundle: migrationBundleSchema, bundleDigest: digest,
    targetWorkspace: z.string().min(1).max(4096),
  }).strict() }).strict(),
  z.object({ ...mutation, action: z.literal('migration.enable'), payload: z.object({
    receipt: freezeReceiptSchema, stage: stageReceiptSchema, stageOperationId: id,
  }).strict() }).strict(),
  z.object({ ...mutation, action: z.literal('migration.finalize'), payload: z.object({
    receipt: freezeReceiptSchema, enabled: enableReceiptSchema,
  }).strict() }).strict(),
  z.object({ ...mutation, action: z.literal('migration.abort'), payload: z.object({ migrationId: id }).strict() }).strict(),
  z.object({ ...mutation, action: z.literal('migration.resume'), payload: z.object({
    migrationId: id, aborted: abortReceiptSchema,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('migration.status'), payload: z.object({ migrationId: id }).strict() }).strict(),
])
export type RemoteRequest = z.infer<typeof remoteRequestSchema>
export type RemoteAction = RemoteRequest['action']
export type PayloadOf<Action extends RemoteAction> = Extract<RemoteRequest, { action: Action }>['payload']
export type RemoteReply =
  | { readonly requestId: string; readonly ok: true; readonly result: unknown }
  | { readonly requestId: string; readonly ok: false; readonly code: string; readonly message: string; readonly unknown: boolean }

export interface RemoteOperation {
  readonly operationId: string
  /** Original explicit route, retained when the logical task's current binding later moves. */
  readonly hostId?: string
  readonly paramDigest: string
  readonly action: RemoteAction
  readonly state: 'prepared' | 'dispatching' | 'succeeded' | 'unknown'
  readonly request: RemoteRequest
  readonly result?: unknown
  readonly updatedAt: string
}
/** Implement with the plugin's durable storage; put must complete its flush before returning. */
export interface RemoteJournal {
  get(operationId: string): Promise<RemoteOperation | undefined>
  put(record: RemoteOperation): Promise<void>
}

/** Callbacks operate through real Host services; the transport never fabricates caller identity. */
export interface RemoteHostPort {
  capabilities(): Promise<RemoteCapabilities>
  authorize(request: RemoteRequest): Promise<void>
  readTask(payload: PayloadOf<'task.read'>): Promise<unknown>
  observeTask?(payload: PayloadOf<'task.observe'>): Promise<unknown>
  send(payload: PayloadOf<'task.send'>, operationId: string): Promise<unknown>
  stop(payload: PayloadOf<'task.stop'>, operationId: string): Promise<unknown>
  queue(payload: PayloadOf<'task.queue'>, operationId: string): Promise<unknown>
  freeze(payload: PayloadOf<'migration.freeze'>, operationId: string): Promise<FreezeReceipt>
  exportBundle(payload: PayloadOf<'migration.bundle'>): Promise<MigrationBundle>
  stage(payload: PayloadOf<'migration.stage'>, operationId: string): Promise<StageReceipt>
  enable(payload: PayloadOf<'migration.enable'>, operationId: string): Promise<EnableReceipt>
  finalize(payload: PayloadOf<'migration.finalize'>, operationId: string): Promise<EnableReceipt>
  abort(payload: PayloadOf<'migration.abort'>, operationId: string): Promise<AbortReceipt>
  resume(payload: PayloadOf<'migration.resume'>, operationId: string): Promise<{ resumed: true; migrationId: string }>
  migrationStatus(payload: PayloadOf<'migration.status'>): Promise<unknown>
  /** Resolve uncertain operations from actual Host facts; undefined keeps them uncertain. */
  reconcile?(operation: RemoteOperation): Promise<{ readonly result: unknown } | undefined>
}

export function remoteDigest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}
