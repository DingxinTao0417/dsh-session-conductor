/**
 * Control transfer and read-only observers (PRD §二.10.1, §三.3 `access`).
 *
 * A logical task has exactly one plugin write controller and any number of
 * read-only observers (PRD §一.3). Transferring control is not "change a field":
 * the specification gives it a sequence, and every step of that sequence exists
 * because of a failure it prevents:
 *
 * `冻结旧控制者新写入 → 对账在途操作 → 保存阶段 → 切换控制者并增加 ownerEpoch → 新控制者恢复`
 *
 * The enforcement of "freeze the old controller" is the **owner field**, not a flag:
 * every write path asks {@link writeControlRefusal}, so changing `ownerSessionId`
 * makes a late request from the previous controller stale by construction. The epoch
 * still increments in the same write, because two writes would leave a window in
 * which the new owner holds control at the old epoch and a caller that passed
 * `expectedOwnerEpoch` would still pass.
 *
 * Three of the specification's requirements are about what must **not** happen, and
 * they are the ones a naive implementation gets wrong:
 *
 * - **Uncertain operations keep their uncertainty.** An operation that entered
 *   dispatch without a confirmable result stays `unknown` across the transfer. The
 *   new controller inherits a question, not an answer — clearing it would invent a
 *   delivery nobody observed.
 * - **Historical notifications are not replayed.** The new controller gets a snapshot
 *   of the task's *state*, and the previous controller's report history is explicitly
 *   not part of it. Replaying it would wake the new controller for things that were
 *   already reported to someone else.
 * - **Authorisations and budgets are not reset.** Nothing in the transfer touches
 *   rules, grants, schedules or counters. This module therefore never writes them; the
 *   test that matters asserts the absence of that write rather than a value.
 *
 * @module dsh-session-conductor/service/access
 */

import { recoveryAction, type OperationRecord } from '../domain/operation.ts'
import type { AccessRecord } from '../store/schema.ts'

/** What one in-flight operation becomes under the new controller. */
export interface HandoverOperation {
  readonly operationId: string
  readonly kind: string
  readonly delivery: OperationRecord['delivery']
  /**
   * What the new controller must do about it.
   * `continue` — never dispatched, so it may proceed under the same id.
   * `reconcile` — its result is unknown, so it must be confirmed, never resent.
   * `done` — nothing left to do.
   */
  readonly action: 'continue' | 'reconcile' | 'done'
  readonly reason: string
}

/** The plan for one transfer, before anything is written. */
export interface TransferPlan {
  readonly taskId: string
  readonly from: string
  readonly to: string
  /** The epoch the record will carry after the switch. */
  readonly nextEpoch: number
  readonly operations: readonly HandoverOperation[]
  /** The snapshot text the new controller receives. */
  readonly snapshot: string
  /** Operations left in an uncertain state, which the caller must reconcile. */
  readonly uncertain: readonly string[]
}

/**
 * The operation facts a transfer needs.
 *
 * Declared as its own shape rather than reusing the persisted record: a transfer
 * reads only identity, kind, delivery and the withdrawal flag, and the persisted
 * record's `kind` is a widened string while the domain's is a closed union. Asking
 * for exactly what is used keeps both honest and needs no cast between them.
 */
export interface TransferableOperation {
  readonly operationId: string
  readonly kind: string
  readonly delivery: OperationRecord['delivery']
  readonly withdrawn: boolean
}

/** What a transfer request needs in order to be planned. */
export interface TransferInput {
  readonly access: AccessRecord
  /** Every operation recorded against the task, in any state. */
  readonly operations: readonly TransferableOperation[]
  readonly to: string
  /** Called to render the task's own state into the snapshot. */
  readonly describeTask: () => string
}

/**
 * Plan a control transfer without writing anything.
 *
 * Pure so that the sequence's *decisions* are testable on their own: which
 * operations continue under their original id, which stay uncertain, and what epoch
 * results. The caller performs the single write this returns.
 *
 * @param input - the current access record, the task's operations and the new owner.
 * @returns the plan, including the snapshot and the uncertain operations.
 * @throws {Error} when the transfer would be a no-op or has no valid target.
 */
export function planTransfer(input: TransferInput): TransferPlan {
  const { access, to } = input
  if (to.length === 0) throw new Error('the new controller must be a named session')
  if (to === access.ownerSessionId) {
    // Refused rather than treated as a refresh: re-transferring to the same session
    // would still bump the epoch and invalidate the controller's own in-flight
    // requests, which is a surprising thing to do for no change in ownership.
    throw new Error(`${to} already holds write control of task ${access.taskId}, so there is nothing to transfer`)
  }

  const operations: HandoverOperation[] = input.operations.map(record => {
    // Withdrawal is checked first because it is a reason *not* to take the operation
    // over, whichever recovery branch the record also falls into. Left to the branch
    // below, a withdrawn undispatched operation would be described as "already
    // prepared", which is true and beside the point.
    if (record.withdrawn) {
      return {
        operationId: record.operationId,
        kind: record.kind,
        delivery: record.delivery,
        action: 'done' as const,
        reason: 'it was withdrawn, so it is not taken over and must not be delivered later',
      }
    }
    const action = recoveryAction(record)
    if (action === 'continue') {
      return {
        operationId: record.operationId,
        kind: record.kind,
        delivery: record.delivery,
        action: 'continue' as const,
        reason: 'it never entered dispatch, so the new controller may proceed with the same operation id',
      }
    }
    if (action === 'reconcile') {
      return {
        operationId: record.operationId,
        kind: record.kind,
        delivery: record.delivery,
        action: 'reconcile' as const,
        reason: 'it entered dispatch without a confirmable result, so it stays uncertain and must never be resent',
      }
    }
    return {
      operationId: record.operationId,
      kind: record.kind,
      delivery: record.delivery,
      action: 'done' as const,
      reason: `it is already ${record.delivery}, so there is nothing to take over`,
    }
  })

  const uncertain = operations.filter(entry => entry.action === 'reconcile').map(entry => entry.operationId)
  // Counted from the records rather than from the rendered reasons: a count derived
  // by parsing the text it will be printed beside is a count that changes meaning
  // when the wording does.
  const carriedOver = operations.filter(entry => entry.action === 'continue').length

  const lines = [
    `Handover snapshot for task ${access.taskId}.`,
    '',
    input.describeTask(),
    '',
    `Write control moves from ${access.ownerSessionId} to ${to} (epoch ${String(access.ownerEpoch)} → ${String(access.ownerEpoch + 1)}).`,
    `Read-only observers: ${access.observerSessionIds.length === 0 ? 'none' : access.observerSessionIds.join(', ')}.`,
    '',
    operations.length === 0
      ? 'In-flight operations: none.'
      : `In-flight operations:\n${operations.map(entry =>
          `- ${entry.operationId} [${entry.kind}] ${entry.delivery}: ${entry.action} — ${entry.reason}`).join('\n')}`,
    '',
    uncertain.length === 0
      ? 'No operation is in an uncertain state.'
      : `UNCERTAIN, do not resend: ${uncertain.join(', ')}. Their delivery was never confirmed, so the only correct `
        + 'next step is to establish what happened, not to send again.',
    '',
    `Authorisations, schedules and budgets are unchanged by this transfer: ${String(carriedOver)} operation(s) `
      + 'carry over under their original ids, and no rule, grant, schedule or counter was reset.',
    'Reports already delivered to the previous controller are not replayed here. This snapshot is the state of the '
      + 'task, not a history of the notifications it produced.',
  ]

  return {
    taskId: access.taskId,
    from: access.ownerSessionId,
    to,
    nextEpoch: access.ownerEpoch + 1,
    operations,
    snapshot: lines.join('\n'),
    uncertain,
  }
}

/**
 * Apply a plan to an access record.
 *
 * The owner and the epoch change in the **same** object, which is what makes the
 * freeze instantaneous: a reader can never see the new owner at the old epoch.
 *
 * The observer list is carried over deliberately. An observer relationship is a
 * read permission granted to a third party, not part of the outgoing controller's
 * authority, so a transfer does not silently revoke it — and the new controller can
 * revoke it explicitly if it should.
 *
 * @param access - the record as it stands.
 * @param plan - the plan to apply.
 * @param now - the current instant as ISO 8601 UTC.
 * @returns the record to store.
 */
export function applyTransfer(access: AccessRecord, plan: TransferPlan, now: string): AccessRecord {
  return {
    ...access,
    ownerSessionId: plan.to,
    ownerEpoch: plan.nextEpoch,
    updatedAt: now,
  }
}

/**
 * Add one read-only observer.
 *
 * Idempotent on purpose: observing twice is the same permission, and reporting an
 * error for it would make a retried request look like a conflict when nothing is
 * wrong. The controller is never added as an observer — it already has strictly more
 * than an observer has, so listing it would misdescribe the relationship.
 *
 * @param access - the record as it stands.
 * @param sessionId - the session to add.
 * @param now - the current instant as ISO 8601 UTC.
 * @returns the record to store, and whether anything changed.
 */
export function addObserver(access: AccessRecord, sessionId: string, now: string): { access: AccessRecord; changed: boolean } {
  if (sessionId === access.ownerSessionId) {
    return { access, changed: false }
  }
  if (access.observerSessionIds.includes(sessionId)) {
    return { access, changed: false }
  }
  return {
    access: { ...access, observerSessionIds: [...access.observerSessionIds, sessionId], updatedAt: now },
    changed: true,
  }
}

/**
 * Revoke one read-only observer.
 *
 * @param access - the record as it stands.
 * @param sessionId - the session to remove.
 * @param now - the current instant as ISO 8601 UTC.
 * @returns the record to store, and whether anything changed.
 */
export function removeObserver(access: AccessRecord, sessionId: string, now: string): { access: AccessRecord; changed: boolean } {
  if (!access.observerSessionIds.includes(sessionId)) {
    return { access, changed: false }
  }
  return {
    access: {
      ...access,
      observerSessionIds: access.observerSessionIds.filter(id => id !== sessionId),
      updatedAt: now,
    },
    changed: true,
  }
}

/**
 * Whether a session may read a task.
 *
 * The controller and every observer may read; nobody else may. Used to keep the
 * read paths honest about the relationship rather than relying on a task simply
 * being listed.
 *
 * @param access - the record as it stands.
 * @param sessionId - the session asking.
 * @returns whether it may read.
 */
export function mayRead(access: AccessRecord, sessionId: string): boolean {
  return sessionId === access.ownerSessionId || access.observerSessionIds.includes(sessionId)
}

/**
 * Whether a session may still write through a task's control relationship.
 *
 * PRD §二.10.1: after a transfer, a late request from the previous controller is
 * refused. That freeze is this predicate, not a per-path flag: send, stop, queue,
 * rule save, schedule save, artifact register/verify/transfer, handoff and workflow
 * start all ask the same question, so a surface that forgot to freeze cannot exist
 * beside one that remembered.
 *
 * @param access - the task's control record, when it has one.
 * @param taskId - the logical task being written.
 * @param callerSessionId - the session asking, taken from the Host's trusted context.
 * @returns a refusal, or `undefined` when the caller still holds write control.
 */
export function writeControlRefusal(
  access: Pick<AccessRecord, 'ownerSessionId' | 'detachedAt'> | undefined,
  taskId: string,
  callerSessionId: string,
): { readonly code: 'NOT_CONTROLLER' | 'NOT_MANAGED'; readonly reason: string } | undefined {
  if (access === undefined || access.ownerSessionId !== callerSessionId) {
    return {
      code: 'NOT_CONTROLLER',
      reason: `session ${callerSessionId} does not hold write control of task ${taskId}`,
    }
  }
  if (access.detachedAt !== undefined) {
    return {
      code: 'NOT_MANAGED',
      reason: `task ${taskId} was released from management at ${access.detachedAt}`,
    }
  }
  return undefined
}

/**
 * Refuse a write that still names a retired control epoch or binding version
 * (PRD §三.2 `MutationContext`).
 *
 * Separate from {@link writeControlRefusal}: the owner field freezes a *previous*
 * controller, while these pins freeze a *current* controller that observed an
 * older epoch or binding. A late `conductor_access` transfer after another
 * transfer or a directory handoff is the case that needs both.
 *
 * Omitted pins are not a match for zero — they mean "write as the current
 * controller on the current binding".
 *
 * @param access - the task's control record.
 * @param binding - the current binding, when the task has one.
 * @param pins - the epoch and binding version the caller observed.
 * @param taskId - the logical task being written.
 * @returns a refusal, or `undefined` when the pins are omitted or still current.
 */
export function mutationPinRefusal(
  access: Pick<AccessRecord, 'ownerEpoch'>,
  binding: { readonly version: number } | undefined,
  pins: {
    readonly expectedOwnerEpoch?: number | undefined
    readonly expectedBindingVersion?: number | undefined
  },
  taskId: string,
): { readonly code: 'STALE_OWNER_EPOCH' | 'STALE_BINDING' | 'NO_BINDING'; readonly reason: string } | undefined {
  if (pins.expectedOwnerEpoch !== undefined && access.ownerEpoch !== pins.expectedOwnerEpoch) {
    return {
      code: 'STALE_OWNER_EPOCH',
      reason:
        `control of task ${taskId} is at epoch ${String(access.ownerEpoch)}, not ${String(pins.expectedOwnerEpoch)}`,
    }
  }
  if (pins.expectedBindingVersion !== undefined) {
    if (binding === undefined) {
      return { code: 'NO_BINDING', reason: `task ${taskId} has no session bound to it` }
    }
    if (binding.version !== pins.expectedBindingVersion) {
      return {
        code: 'STALE_BINDING',
        reason:
          `task ${taskId} is bound at version ${String(binding.version)}, not ${String(pins.expectedBindingVersion)}`,
      }
    }
  }
  return undefined
}

/**
 * How a handover snapshot should reach the new controller (PRD §二.10.1).
 *
 * The snapshot is a plugin `notice`, not a user message and not a replay of reports
 * already delivered to the previous controller. An idle session is woken with
 * `steer`; a busy one is queued with `followup` and is not interrupted — the same
 * delivery rule background reports already use.
 */
export type SnapshotDeliveryPlan =
  | { readonly kind: 'wake' }
  | { readonly kind: 'queue' }
  | { readonly kind: 'not_live'; readonly reason: string }
  | { readonly kind: 'no_channel'; readonly reason: string }

/** The live-agent facts snapshot delivery needs. */
export interface SnapshotDeliveryAgent {
  readonly status?: 'idle' | 'running'
  readonly steer?: (message: unknown) => void
  readonly followup?: (message: unknown) => void
}

/**
 * Decide how to deliver a handover snapshot, without sending it.
 *
 * @param agent - the new controller's live agent, when this Host has one.
 * @param sessionId - the session that should receive the snapshot.
 * @returns wake, queue, or why it cannot be delivered.
 */
export function snapshotDeliveryPlan(
  agent: SnapshotDeliveryAgent | undefined,
  sessionId: string,
): SnapshotDeliveryPlan {
  if (agent === undefined) {
    return {
      kind: 'not_live',
      reason: `session ${sessionId} is not live in this Host, so the handover snapshot could not be delivered`,
    }
  }
  if ((agent.status ?? 'idle') === 'idle') {
    if (typeof agent.steer !== 'function') {
      return {
        kind: 'no_channel',
        reason: `session ${sessionId} is idle but this Host exposes no steer, so the handover snapshot could not be delivered`,
      }
    }
    return { kind: 'wake' }
  }
  if (typeof agent.followup !== 'function') {
    return {
      kind: 'no_channel',
      reason: `session ${sessionId} is busy but this Host exposes no followup, so the handover snapshot could not be delivered`,
    }
  }
  return { kind: 'queue' }
}

/**
 * Whether the conductor may still act on a task's monitoring relationship.
 *
 * PRD §二.5: releasing a task stops the monitoring that depends on that relationship and blocks new
 * automatic actions through it — while already accepted input is **not** withdrawn. The record was
 * marked and this question was never asked, so a released task's watch kept reporting: the comment
 * promised one behaviour and the code did another. It is one predicate rather than an inline check
 * so every read path answers it the same way.
 *
 * @param access - the task's control record, when it has one.
 * @returns whether monitoring may continue, and why not when it may not.
 */
export function monitoringAllowed(access: AccessRecord | undefined): { allowed: boolean; reason: string } {
  if (access === undefined) {
    return { allowed: false, reason: 'the task has no control record, so there is no relationship to monitor' }
  }
  if (access.detachedAt !== undefined) {
    return {
      allowed: false,
      reason: `management of task ${access.taskId} was released at ${access.detachedAt}, so the monitoring that `
        + 'depended on that relationship has stopped. Anything already accepted is untouched; rejoin the task to '
        + 'monitor it again.',
    }
  }
  return { allowed: true, reason: 'the task is still managed' }
}

/**
 * Whether an archived task still receives necessary notices (PRD §二.5 / T15).
 *
 * Archive is organisation of the conductor collection: it does not stop execution,
 * cancel authorised plans, delete data, or silence notices. Release
 * ({@link monitoringAllowed}) is the thing that stops monitoring. Folding `archived`
 * into that question would be the opposite of the specification.
 *
 * @param access - the task's control record, when it has one.
 * @param archived - the conductor-side archive flag.
 * @returns whether observation may continue, and why.
 */
export function observationContinues(
  access: AccessRecord | undefined,
  archived: boolean,
): { allowed: boolean; reason: string } {
  const monitoring = monitoringAllowed(access)
  if (!monitoring.allowed) return monitoring
  if (!archived) return monitoring
  return {
    allowed: true,
    reason: `task ${access?.taskId ?? 'unknown'} is archived in the conductor collection; archive is `
      + 'organisation only, so monitoring continues and necessary notices still reach the notice centre',
  }
}
