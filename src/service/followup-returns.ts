/** Independent receipts for subsequent delegated messages; never wakes a model. */
import type { ConductorStore } from '../store/repository.ts'
import type { StoredOperationRecord } from '../store/schema.ts'
import type { SessionEventLike } from './projection.ts'
import { mayRead, monitoringAllowed } from './access.ts'
import { resolveCompletionReturn } from './completion-return.ts'

export function followupReturnRelation(store: ConductorStore, operation: StoredOperationRecord) {
  const callback = operation.completionReturn
  const guard = operation.dispatchGuard
  if (operation.kind !== 'send' || operation.taskId === undefined || callback === undefined || guard === undefined
    || callback.operationId !== operation.operationId || callback.messageId !== operation.messageId
    || callback.bindingId !== guard.bindingId || callback.bindingVersion !== guard.bindingVersion) return undefined
  const parameters = operation.params as { text?: unknown } | undefined
  if (typeof parameters?.text !== 'string' || parameters.text.length === 0) return undefined
  const task = store.getTask(operation.taskId)
  const binding = store.getBinding(callback.bindingId)
  const access = store.getAccess(operation.taskId)
  if (task === undefined || binding?.taskId !== task.taskId || binding.version !== callback.bindingVersion
    || access === undefined || !mayRead(access, guard.ownerSessionId)) return undefined
  return { task, binding, access, callback, originSessionId: guard.ownerSessionId }
}

export async function reconcileFollowupReturns(options: {
  readonly store: ConductorStore
  readonly active: () => boolean
  readonly localHostId: string
  readonly readEvents: (sessionId: string) => Promise<readonly SessionEventLike[]>
}): Promise<string> {
  const { store } = options
  let changed = 0
  for (const candidate of store.listOperations()) {
    if (!options.active()) break
    if (candidate.completionReturn === undefined || ['returned', 'delivery_failed'].includes(candidate.completionReturn.phase)) continue
    await store.withExclusive(`followup-return:${candidate.operationId}`, async () => {
      const operation = store.getOperation(candidate.operationId)
      const relation = operation === undefined ? undefined : followupReturnRelation(store, operation)
      if (operation === undefined || relation === undefined || !monitoringAllowed(relation.access).allowed
        || !['local', options.localHostId].includes(relation.binding.hostId)) return
      const before = JSON.stringify(relation.callback)
      let events: readonly SessionEventLike[]
      try { events = await options.readEvents(relation.binding.sessionId) } catch { return }
      await store.withExclusive(`control-commit:${relation.task.taskId}`, async () => {
        if (!options.active()) return
        const latest = store.getOperation(operation.operationId)
        const current = latest === undefined ? undefined : followupReturnRelation(store, latest)
        if (latest === undefined || current === undefined || !monitoringAllowed(current.access).allowed
          || current.originSessionId !== relation.originSessionId || JSON.stringify(current.callback) !== before
          || current.binding.sessionId !== relation.binding.sessionId || current.binding.hostId !== relation.binding.hostId) return
        const observation = resolveCompletionReturn(current.callback, events)
        let next = observation.record
        if (observation.messageSeq === undefined && observation.initialTurn === undefined) {
          if (latest.withdrawn || latest.delivery === 'withdrawn' || latest.delivery === 'failed') {
            next = { ...next, phase: 'delivery_failed', reason: latest.phase ?? 'The delegated message was not delivered.' }
          } else if (latest.delivery === 'unknown') {
            next = { ...next, phase: 'delivery_unknown', reason: latest.phase ?? 'Delivery could not be confirmed.' }
          }
        }
        if (JSON.stringify(next) === before) return
        await store.updateOperation(latest.operationId, row => JSON.stringify(row.completionReturn) !== before ? row : {
          ...row, completionReturn: { ...next, updatedAt: new Date().toISOString() },
        })
        changed++
      })
    })
  }
  return `follow-up returns: ${String(changed)} updated`
}
