/** Host Router with durable request receipts and ordered source-freeze/target-enable migration. */
import { randomUUID } from 'node:crypto'
import { normalizePath } from '../service/cleanup.ts'
import { translatePath } from '../service/crosshost.ts'
import {
  abortReceiptSchema, capabilitiesSchema, enableReceiptSchema, freezeReceiptSchema, migrationBundleSchema,
  REMOTE_PROTOCOL_VERSION, remoteDigest, remoteRequestSchema, stageReceiptSchema,
  type EnableReceipt, type FreezeReceipt, type MigrationBundle, type PayloadOf,
  type RemoteAction, type RemoteCapabilities, type RemoteJournal,
  type RemoteReply, type RemoteRequest, type StageReceipt,
} from './protocol.ts'
import type { RemoteTransport } from './transport.ts'

export interface HostRoute {
  readonly enabled: boolean
  readonly transport: RemoteTransport
}
export interface MigrationRequest {
  readonly migrationId: string
  readonly taskId: string
  readonly sourceHostId: string
  readonly targetHostId: string
  readonly expectedOwnerEpoch: number
  readonly expectedBindingVersion: number
  readonly targetWorkspace: string
  readonly historyThroughSeq: number
  readonly artifactIds: readonly string[]
  readonly pathMap: readonly { readonly from: string; readonly to: string }[]
  readonly requiredModels: readonly string[]
}
export interface RemoteMigration {
  readonly migrationId: string
  readonly paramDigest: string
  readonly phase: 'checking' | 'freezing' | 'exporting' | 'staging' | 'enabling' | 'finalizing' | 'succeeded' | 'aborted' | 'unknown'
  readonly request: MigrationRequest
  readonly freeze?: FreezeReceipt
  readonly bundle?: MigrationBundle
  readonly stage?: StageReceipt
  readonly result?: EnableReceipt
  readonly updatedAt: string
}
export interface MigrationJournal {
  get(migrationId: string): Promise<RemoteMigration | undefined>
  put(record: RemoteMigration): Promise<void>
}

export class RemoteRouterError extends Error {
  readonly code: string
  readonly outcomeUnknown: boolean
  constructor(code: string, outcomeUnknown = false) {
    super(code)
    this.code = code
    this.outcomeUnknown = outcomeUnknown
  }
}

function unwrap(reply: RemoteReply): unknown {
  if (!reply.ok) throw new RemoteRouterError(reply.code, reply.unknown)
  return reply.result
}

export function createHostRouter(options: {
  readonly enabled: () => boolean
  readonly pluginVersion: string
  /** Resolve from the current explicitly saved host registry on every request. */
  readonly route: (hostId: string) => HostRoute | undefined
  readonly operations: RemoteJournal
  readonly migrations: MigrationJournal
}) {
  const ongoing = new Map<string, Promise<unknown>>()

  function transport(hostId: string): RemoteTransport {
    if (!options.enabled()) throw new RemoteRouterError('CROSS_HOST_DISABLED')
    const route = options.route(hostId)
    if (route === undefined || !route.enabled) throw new RemoteRouterError('REMOTE_HOST_NOT_REGISTERED_OR_DISABLED')
    return route.transport
  }

  async function capabilities(hostId: string, signal?:AbortSignal): Promise<RemoteCapabilities> {
    signal?.throwIfAborted()
    const result = capabilitiesSchema.parse(unwrap(await transport(hostId).request({
      protocolVersion: REMOTE_PROTOCOL_VERSION, requestId: randomUUID(), action: 'capabilities', payload: {},
    },signal)))
    if (result.hostId !== hostId || result.pluginVersion !== options.pluginVersion) {
      throw new RemoteRouterError('REMOTE_HOST_IDENTITY_OR_VERSION_MISMATCH')
    }
    return result
  }

  async function perform(hostId: string, request: RemoteRequest, beforeDispatch?: () => void,signal?:AbortSignal): Promise<unknown> {
    await capabilities(hostId,signal)
    signal?.throwIfAborted()
    if (!('operationId' in request)) return unwrap(await transport(hostId).request(request,signal))
    const operationId = `router:${remoteDigest({ hostId, operationId: request.operationId })}`
    const paramDigest = remoteDigest({ hostId, action: request.action, payload: request.payload })
    let held = await options.operations.get(operationId)
    if (held !== undefined && held.paramDigest !== paramDigest) throw new RemoteRouterError('OPERATION_CONFLICT')
    const pendingReceipt = held?.action === 'task.send' && (held.result as {delivery?:unknown}|undefined)?.delivery === 'pending'
    if (held?.state === 'succeeded' && !pendingReceipt) return held.result
    if (held && (held.state === 'dispatching' || held.state === 'unknown' || pendingReceipt)) {
      // Link recovery performs a read, not another mutation. No response is never interpreted as not sent.
      const remote = unwrap(await transport(hostId).request({
        protocolVersion: REMOTE_PROTOCOL_VERSION, requestId: randomUUID(), action: 'operation.read',
        payload: { operationId: request.operationId },
      })) as { operationId?: unknown; state?: unknown; result?: unknown }
      if (remote.operationId !== request.operationId || remote.state !== 'succeeded') {
        throw new RemoteRouterError('REMOTE_OPERATION_UNCONFIRMED', true)
      }
      await options.operations.put({ ...held, state: 'succeeded', result: remote.result, updatedAt: new Date().toISOString() })
      return remote.result
    }
    held = held ?? { operationId, hostId, action: request.action, paramDigest, state: 'prepared', request, updatedAt: new Date().toISOString() }
    await options.operations.put(held)
    held = { ...held, state: 'dispatching', updatedAt: new Date().toISOString() }
    await options.operations.put(held)
    try { beforeDispatch?.() } catch {
      await options.operations.put({ ...held, state: 'prepared', updatedAt: new Date().toISOString() })
      throw new RemoteRouterError('REMOTE_SOURCE_ADMISSION_REFUSED')
    }
    try {
      const result = unwrap(await transport(hostId).request(request))
      await options.operations.put({ ...held, state: 'succeeded', result, updatedAt: new Date().toISOString() })
      return result
    } catch (error) {
      try { await options.operations.put({ ...held, state: 'unknown', updatedAt: new Date().toISOString() }) } catch { /* dispatching already requires reconciliation */ }
      if (error instanceof RemoteRouterError) throw error
      throw new RemoteRouterError('REMOTE_OPERATION_UNCONFIRMED', true)
    }
  }

  async function request<Action extends RemoteAction>(
    hostId: string, action: Action, payload: PayloadOf<Action>, operationId?: string, beforeDispatch?: () => void,signal?:AbortSignal,
  ): Promise<unknown> {
    const parsed = remoteRequestSchema.parse({
      protocolVersion: REMOTE_PROTOCOL_VERSION, requestId: randomUUID(), action, payload,
      ...operationId === undefined ? {} : { operationId },
    })
    if (!('operationId' in parsed)) return await perform(hostId, parsed, beforeDispatch,signal)
    const key = `${hostId}:${parsed.operationId}`
    const previous = ongoing.get(key)
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(async () => await perform(hostId, parsed, beforeDispatch))
    ongoing.set(key, pending)
    try { return await pending } finally { if (ongoing.get(key) === pending) ongoing.delete(key) }
  }

  async function migrate(input: MigrationRequest): Promise<RemoteMigration> {
    const key = `migration:${input.migrationId}`
    const previous = ongoing.get(key)
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(async (): Promise<RemoteMigration> => {
      const paramDigest = remoteDigest(input)
      let migration = await options.migrations.get(input.migrationId)
      if (migration !== undefined && migration.paramDigest !== paramDigest) throw new RemoteRouterError('MIGRATION_CONFLICT')
      if (migration?.phase === 'succeeded') return migration
      if (migration?.phase === 'aborted') throw new RemoteRouterError('MIGRATION_ABORTED')
      migration = migration ?? { migrationId: input.migrationId, paramDigest, phase: 'checking', request: structuredClone(input), updatedAt: new Date().toISOString() }
      await options.migrations.put(migration)
      const save = async (update: Partial<RemoteMigration>): Promise<void> => {
        migration = { ...migration as RemoteMigration, ...update, updatedAt: new Date().toISOString() }
        await options.migrations.put(migration)
      }
      const childId = (phase: string): string => `migration:${remoteDigest({ migrationId: input.migrationId, phase })}`
      try {
        if (input.sourceHostId === input.targetHostId) throw new RemoteRouterError('MIGRATION_REQUIRES_DISTINCT_HOSTS')
        const source = await capabilities(input.sourceHostId)
        const target = await capabilities(input.targetHostId)
        if (!source.workspaceCapable || !target.workspaceCapable || input.requiredModels.some(model => !target.models.includes(model))) {
          throw new RemoteRouterError('REMOTE_WORKSPACE_OR_MODELS_INCOMPATIBLE')
        }
        if (migration.freeze === undefined) {
          await save({ phase: 'freezing' })
          const freeze = freezeReceiptSchema.parse(await request(input.sourceHostId, 'migration.freeze', {
            migrationId: input.migrationId, taskId: input.taskId, targetHostId: input.targetHostId,
            expectedOwnerEpoch: input.expectedOwnerEpoch, expectedBindingVersion: input.expectedBindingVersion,
          }, childId('freeze')))
          if (freeze.sourceHostId !== input.sourceHostId) throw new RemoteRouterError('SOURCE_FREEZE_IDENTITY_MISMATCH')
          await save({ freeze })
        }
        if (migration.bundle === undefined) {
          await save({ phase: 'exporting' })
          const bundle = migrationBundleSchema.parse(await request(input.sourceHostId, 'migration.bundle', {
            receipt: migration.freeze as FreezeReceipt, historyThroughSeq: input.historyThroughSeq, targetWorkspace: input.targetWorkspace,
            artifactIds: [...input.artifactIds], pathMap: input.pathMap.map(entry => ({ ...entry })), requiredModels: [...input.requiredModels],
          }))
          for (const artifact of bundle.artifacts) {
            const translated = translatePath({
              taskId: input.taskId, sourceHostId: input.sourceHostId, targetHostId: input.targetHostId,
              historyThroughSeq: input.historyThroughSeq, artifactIds: input.artifactIds, pathMap: input.pathMap,
            }, artifact.sourcePath)
            const actual = normalizePath(`${input.targetWorkspace}/${artifact.relativePath}`)
            if (!translated.mapped || normalizePath(translated.path) !== actual) throw new RemoteRouterError('ARTIFACT_PATH_MAPPING_MISMATCH')
          }
          await save({ bundle })
        }
        if (migration.stage === undefined) {
          await save({ phase: 'staging' })
          const stage = stageReceiptSchema.parse(await request(input.targetHostId, 'migration.stage', {
            receipt: migration.freeze as FreezeReceipt, bundle: migration.bundle as MigrationBundle,
            bundleDigest: remoteDigest(migration.bundle), targetWorkspace: input.targetWorkspace,
          }, childId('stage')))
          await save({ stage })
        }
        if (migration.result === undefined) {
        // A persisted receipt is not a fresh source reading. A resumed migration must
        // prove that the source still has its freeze and has not started new work.
        const sourceStatus = await request(input.sourceHostId, 'migration.status', { migrationId: input.migrationId }) as {
          sourceStopped?: boolean; dispatchFrozen?: boolean; receipt?: unknown
        } | null
        if (sourceStatus?.sourceStopped !== true || sourceStatus.dispatchFrozen !== true
          || remoteDigest(sourceStatus.receipt) !== remoteDigest(migration.freeze)) {
          throw new RemoteRouterError('SOURCE_FREEZE_UNCONFIRMED', true)
        }
        await save({ phase: 'enabling' })
        const result = enableReceiptSchema.parse(await request(input.targetHostId, 'migration.enable', {
          receipt: migration.freeze as FreezeReceipt, stage: migration.stage as StageReceipt, stageOperationId: childId('stage'),
        }, childId('enable')))
        await save({ phase: 'finalizing', result })
        }
        await request(input.sourceHostId, 'migration.finalize', {
          receipt: migration.freeze as FreezeReceipt, enabled: migration.result as EnableReceipt,
        }, childId('finalize'))
        await save({ phase: 'succeeded' })
        return migration
      } catch (error) {
        await save({ phase: 'unknown' })
        if (error instanceof RemoteRouterError) throw error
        throw new RemoteRouterError('MIGRATION_UNCONFIRMED', true)
      }
    })
    ongoing.set(key, pending)
    try { return await pending } finally { if (ongoing.get(key) === pending) ongoing.delete(key) }
  }

  async function abort(migrationId: string): Promise<RemoteMigration> {
    const key = `migration:${migrationId}`
    const previous = ongoing.get(key)
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(async (): Promise<RemoteMigration> => {
      const migration = await options.migrations.get(migrationId)
      if (migration === undefined) throw new RemoteRouterError('MIGRATION_NOT_FOUND')
      if (migration.phase === 'aborted') return migration
      if (migration.phase === 'succeeded' || migration.result !== undefined) throw new RemoteRouterError('MIGRATION_ALREADY_ENABLED')
      // A durable target tombstone closes the enable path before the source can resume.
      const aborted = abortReceiptSchema.parse(await request(migration.request.targetHostId, 'migration.abort',
        { migrationId }, `migration:${remoteDigest({ migrationId, phase: 'abort' })}`))
      if (aborted.targetHostId !== migration.request.targetHostId) throw new RemoteRouterError('ABORT_HOST_IDENTITY_MISMATCH')
      await request(migration.request.sourceHostId, 'migration.resume', { migrationId, aborted },
        `migration:${remoteDigest({ migrationId, phase: 'resume' })}`)
      const result: RemoteMigration = { ...migration, phase: 'aborted', updatedAt: new Date().toISOString() }
      await options.migrations.put(result)
      return result
    })
    ongoing.set(key, pending)
    try { return await pending } finally { if (ongoing.get(key) === pending) ongoing.delete(key) }
  }

  return { capabilities, request, migrate, abort }
}
