/** Durable, finite operation dispatch behind the private user-level IPC endpoint. */
import {
  abortReceiptSchema, capabilitiesSchema, enableReceiptSchema, freezeReceiptSchema, MAX_REMOTE_FRAME_BYTES,
  migrationBundleSchema, remoteDigest, remoteRequestSchema, stageReceiptSchema,
  type RemoteHostPort, type RemoteJournal, type RemoteOperation, type RemoteReply, type RemoteRequest,
} from './protocol.ts'
import { taskObservationSchema } from '../service/observation.ts'

export type RemoteDispatch = (request: unknown) => Promise<RemoteReply>

function failure(requestId: string, code: string, unknown = false): RemoteReply {
  return { requestId, ok: false, code, unknown, message: code === 'OPERATION_UNKNOWN'
    ? 'the operation may have taken effect; query this operation identity to reconcile before any retry'
    : 'the remote operation was refused; its identity and supplied parameters must be checked' }
}

function checkedOutcome(request: RemoteRequest, result: unknown): unknown {
  if(request.action==='task.observe'){
    const observation=taskObservationSchema.parse(result)
    if(observation.taskId!==request.payload.taskId || observation.notable.some(entry=>entry.seq<=request.payload.afterSeq))throw Error('invalid observation identity or cursor')
    return observation
  }
  if (request.action === 'capabilities') return capabilitiesSchema.parse(result)
  if (request.action === 'migration.freeze') {
    const receipt = freezeReceiptSchema.parse(result)
    if (receipt.operationId !== request.operationId || receipt.migrationId !== request.payload.migrationId
      || receipt.taskId !== request.payload.taskId || receipt.targetHostId !== request.payload.targetHostId
      || receipt.bindingVersion !== request.payload.expectedBindingVersion || receipt.ownerEpoch !== request.payload.expectedOwnerEpoch) {
      throw new Error('freeze receipt does not describe the requested task and control version')
    }
    return receipt
  }
  if (request.action === 'migration.bundle') {
    const bundle = migrationBundleSchema.parse(result)
    if (bundle.migrationId !== request.payload.receipt.migrationId || bundle.taskId !== request.payload.receipt.taskId
      || bundle.sourceHostId !== request.payload.receipt.sourceHostId || bundle.targetHostId !== request.payload.receipt.targetHostId
      || bundle.historyThroughSeq !== request.payload.historyThroughSeq
      || bundle.artifacts.length !== new Set(request.payload.artifactIds).size
      || bundle.artifacts.some(artifact => !request.payload.artifactIds.includes(artifact.artifactId))) {
      throw new Error('bundle does not match the explicitly selected history and artifact manifest')
    }
    return bundle
  }
  if (request.action === 'migration.stage') {
    const receipt = stageReceiptSchema.parse(result)
    if (receipt.migrationId !== request.payload.receipt.migrationId || receipt.taskId !== request.payload.receipt.taskId
      || receipt.targetHostId !== request.payload.receipt.targetHostId || receipt.bundleDigest !== request.payload.bundleDigest) {
      throw new Error('stage receipt does not match the frozen bundle')
    }
    return receipt
  }
  if (request.action === 'migration.enable') {
    const receipt = enableReceiptSchema.parse(result)
    if (receipt.migrationId !== request.payload.stage.migrationId || receipt.taskId !== request.payload.stage.taskId
      || receipt.targetHostId !== request.payload.stage.targetHostId || receipt.sessionId !== request.payload.stage.sessionId) {
      throw new Error('enable receipt does not match the staged target session')
    }
    return receipt
  }
  if (request.action === 'migration.finalize') {
    const receipt = enableReceiptSchema.parse(result)
    if (remoteDigest(receipt) !== remoteDigest(request.payload.enabled)) throw new Error('finalize result mismatch')
    return receipt
  }
  if (request.action === 'migration.abort') {
    const receipt = abortReceiptSchema.parse(result)
    if (receipt.migrationId !== request.payload.migrationId) throw new Error('abort result mismatch')
    return receipt
  }
  return result
}

export function createRemoteDispatcher(host: RemoteHostPort, journal: RemoteJournal): RemoteDispatch {
  const inFlight = new Map<string, Promise<RemoteReply>>()

  async function validate(request: RemoteRequest): Promise<void> {
    await host.authorize(request)
    if (request.action === 'migration.stage') {
      const { bundle, bundleDigest, receipt } = request.payload
      const capabilities = capabilitiesSchema.parse(await host.capabilities())
      if (remoteDigest(bundle) !== bundleDigest || bundle.migrationId !== receipt.migrationId
        || bundle.taskId !== receipt.taskId || bundle.sourceHostId !== receipt.sourceHostId
        || bundle.targetHostId !== receipt.targetHostId || capabilities.hostId !== receipt.targetHostId
        || !capabilities.workspaceCapable || bundle.requiredModels.some(model => !capabilities.models.includes(model))) {
        throw new Error('target capabilities or frozen bundle identity do not match')
      }
    }
    if (request.action === 'migration.enable') {
      const { stage, stageOperationId, receipt } = request.payload
      const operation = await journal.get(stageOperationId)
      if (operation?.state !== 'succeeded' || operation.action !== 'migration.stage'
        || operation.request.action !== 'migration.stage'
        || remoteDigest(operation.result) !== remoteDigest(stage)
        || remoteDigest(operation.request.payload.receipt) !== remoteDigest(receipt)
        || stage.taskId !== receipt.taskId || stage.migrationId !== receipt.migrationId
        || stage.targetHostId !== receipt.targetHostId) {
        throw new Error('target cannot enable without its own completed stage and matching source freeze receipt')
      }
    }
  }

  async function invoke(request: RemoteRequest): Promise<unknown> {
    switch (request.action) {
      case 'capabilities': return await host.capabilities()
      case 'task.read': return await host.readTask(request.payload)
      case 'task.observe': {if(!host.observeTask)throw Error('REMOTE_OBSERVATION_UNAVAILABLE');return await host.observeTask(request.payload)}
      case 'task.send': return await host.send(request.payload, request.operationId)
      case 'task.stop': return await host.stop(request.payload, request.operationId)
      case 'task.queue': return await host.queue(request.payload, request.operationId)
      case 'migration.freeze': return await host.freeze(request.payload, request.operationId)
      case 'migration.bundle': return await host.exportBundle(request.payload)
      case 'migration.stage': return await host.stage(request.payload, request.operationId)
      case 'migration.enable': return await host.enable(request.payload, request.operationId)
      case 'migration.finalize': return await host.finalize(request.payload, request.operationId)
      case 'migration.abort': return await host.abort(request.payload, request.operationId)
      case 'migration.resume': return await host.resume(request.payload, request.operationId)
      case 'migration.status': return await host.migrationStatus(request.payload)
      case 'operation.read': {
        const held = await journal.get(request.payload.operationId)
        if (held === undefined) return { state: 'absent', operationId: request.payload.operationId }
        const pendingReceipt = held.action === 'task.send' && (held.result as {delivery?:unknown}|undefined)?.delivery === 'pending'
        if ((held.state === 'dispatching' || held.state === 'unknown' || pendingReceipt) && host.reconcile !== undefined) {
          const reconciled = await host.reconcile(held)
          if (reconciled !== undefined) {
            const result = checkedOutcome(held.request, reconciled.result)
            const settled: RemoteOperation = { ...held, result, state: 'succeeded', updatedAt: new Date().toISOString() }
            await journal.put(settled)
            return { operationId: held.operationId, state: settled.state, result }
          }
        }
        // Requests may contain messages/artifacts. An operation query returns only status and result.
        return { operationId: held.operationId, state: held.state === 'dispatching' ? 'unknown' : held.state,
          ...held.result === undefined ? {} : { result: held.result } }
      }
    }
  }

  async function run(request: RemoteRequest): Promise<RemoteReply> {
    try { await validate(request) } catch { return failure(request.requestId, 'REMOTE_PERMISSION_OR_PRECONDITION') }
    if (!('operationId' in request)) {
      try { return { requestId: request.requestId, ok: true, result: checkedOutcome(request, await invoke(request)) } }
      catch { return failure(request.requestId, 'REMOTE_READ_FAILED') }
    }
    const paramDigest = remoteDigest({ action: request.action, payload: request.payload })
    let held: RemoteOperation | undefined
    try {
      held = await journal.get(request.operationId)
      if (held !== undefined && held.paramDigest !== paramDigest) return failure(request.requestId, 'OPERATION_CONFLICT')
      if (held?.state === 'succeeded') return { requestId: request.requestId, ok: true, result: held.result }
      if (held?.state === 'dispatching' || held?.state === 'unknown') return failure(request.requestId, 'OPERATION_UNKNOWN', true)
      const prepared: RemoteOperation = held ?? {
        operationId: request.operationId, paramDigest, action: request.action, state: 'prepared', request,
        updatedAt: new Date().toISOString(),
      }
      if (held === undefined) await journal.put(prepared)
      held = { ...prepared, state: 'dispatching', updatedAt: new Date().toISOString() }
      await journal.put(held)
      // Recheck ownership, binding and staging after durable acceptance, immediately before the Host effect.
      await validate(request)
      const result = checkedOutcome(request, await invoke(request))
      await journal.put({ ...held, state: 'succeeded', result, updatedAt: new Date().toISOString() })
      return { requestId: request.requestId, ok: true, result }
    } catch {
      if (held?.state === 'dispatching') {
        try { await journal.put({ ...held, state: 'unknown', updatedAt: new Date().toISOString() }) } catch { /* durable dispatching remains uncertain */ }
        return failure(request.requestId, 'OPERATION_UNKNOWN', true)
      }
      return failure(request.requestId, 'REMOTE_STORAGE_UNAVAILABLE')
    }
  }

  return async (raw: unknown): Promise<RemoteReply> => {
    let request: RemoteRequest
    try {
      if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_REMOTE_FRAME_BYTES) throw new Error('oversized')
      request = remoteRequestSchema.parse(raw)
    } catch { return failure('invalid-request', 'BAD_REMOTE_REQUEST') }
    if (!('operationId' in request)) return await run(request)
    // A conflicting concurrent request must re-read its own digest after the first settles.
    const previous = inFlight.get(request.operationId)
    const pending = (previous ?? Promise.resolve()).then(async () => await run(request))
    inFlight.set(request.operationId, pending)
    try { return await pending } finally {
      if (inFlight.get(request.operationId) === pending) inFlight.delete(request.operationId)
    }
  }
}
