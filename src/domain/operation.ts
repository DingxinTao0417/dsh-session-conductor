/**
 * Operation identity, idempotency and the persisted delivery pipeline
 * (PRD §四.1 "操作幂等" and §三.5 "Operation").
 *
 * The rules encoded here are the ones the specification states verbatim:
 *
 * - every mutation carries a stable `operationId` and a message id;
 * - the same id with the same parameters returns or safely continues the
 *   original operation, while the same id with different parameters is a
 *   conflict;
 * - two independent sends of identical text are two operations, so identity is
 *   never derived from content;
 * - a withdrawn operation must not be delivered again after a restart;
 * - the persisted order is
 *   `save operation → save dispatching → dedupe and validate → host accepts →
 *   flush → save receipt`, and a dispatch whose receipt cannot be confirmed
 *   lands in `unknown` for reconciliation instead of being resent.
 *
 * @module dsh-session-conductor/domain/operation
 */

import { createHash } from 'node:crypto'
import type { DeliveryState } from './state.ts'

/**
 * The mutating request families from PRD §三.3 that own a persisted operation.
 *
 * Read-only families (`list`, `read`, `capabilities`, `operation` queries) do
 * not create operations; keeping the list closed prevents a new mutation from
 * silently skipping the idempotency record.
 */
export const OPERATION_KINDS = [
  'create',
  'fork',
  'attach',
  'detach',
  'update',
  'send',
  'queue_edit',
  'queue_withdraw',
  'interrupt',
  'watch',
  'access',
  'handoff',
  'artifact_register',
  /**
   * Recording an acceptance (PRD §二.9.1).
   *
   * Added in round 61, after a live probe showed a repeated identical acceptance counting **twice** in the
   * run ledger: the family was missing from this closed list, so the acceptance path could not claim an
   * operation even if a caller passed an id, and §四.1's replay rule had nothing to apply to. The list is
   * closed precisely so a new mutation cannot skip the idempotency record — and this one had.
   */
  'artifact_accept',
  'transfer',
  'schedule',
  'rule',
  'workflow',
  'constraints',
  'budget',
  'export',
  'share',
  'remote',
  'cleanup',
] as const
export type OperationKind = (typeof OPERATION_KINDS)[number]

/**
 * Identity a caller supplies with a mutation request (PRD §三.2).
 *
 * `expectedOwnerEpoch` and `expectedBindingVersion` are checked immediately
 * before the real dispatch, never only at request time: a transfer of control
 * or an environment handoff that lands in between must reject the stale write.
 */
export interface MutationContext {
  /** Stable id the caller reuses when retrying the same mutation. */
  readonly operationId: string
  /** Control epoch the caller believes it holds. */
  readonly expectedOwnerEpoch?: number
  /** Binding version the caller believes is current. */
  readonly expectedBindingVersion?: number
}

/** One persisted operation record. */
export interface OperationRecord {
  readonly operationId: string
  readonly kind: OperationKind
  /** Digest of the canonicalized parameters, used to detect a conflicting reuse. */
  readonly paramDigest: string
  /**
   * The parameters the digest was taken over, when the record kept them.
   *
   * Carried here so a conflict can say **which** kind of difference it is. Two very different situations
   * produce the same digest mismatch, and the refusal used to describe both as "different parameters":
   * a genuinely different request, and a retry of an unchanged request whose operation was claimed by an
   * earlier *revision* that digested a different set of fields. When this is absent the conductor cannot
   * tell them apart and must say so rather than assert the first.
   */
  readonly params?: unknown
  /** Logical task the operation addresses, once known. */
  readonly taskId?: string
  /** Stable id of the message this operation delivers, when it delivers one. */
  readonly messageId?: string
  readonly delivery: DeliveryState
  /** Wall-clock creation time in ISO 8601 UTC. */
  readonly createdAt: string
  /** Wall-clock time of the last persisted change in ISO 8601 UTC. */
  readonly updatedAt: string
  /** Set once the operation is withdrawn; never cleared by recovery. */
  readonly withdrawn: boolean
  /** Free-form phase label the owning operation reports while it runs. */
  readonly phase?: string
}

/** How an incoming mutation relates to an already-persisted operation. */
export type OperationMatch =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly record: OperationRecord }
  | { readonly kind: 'conflict'; readonly record: OperationRecord; readonly reason: string }

/**
 * Serialize a JSON-compatible value with sorted object keys.
 *
 * Two calls with the same logical parameters must produce the same digest even
 * when the caller wrote the keys in a different order, so ordering is fixed
 * here rather than left to property insertion order. `undefined` members are
 * dropped, matching JSON semantics, and a non-JSON value raises instead of
 * being coerced — a silently coerced digest would make two different requests
 * look identical.
 *
 * @param value - the value to canonicalize.
 * @returns a stable JSON string.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value, '$'))
}

/**
 * Recursively sort object keys, rejecting values JSON cannot represent.
 * @param value - candidate value.
 * @param path - JSON path used in the error message.
 * @returns the value with every object key in ascending order.
 */
function sortValue(value: unknown, path: string): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map((item, index) => sortValue(item, `${path}[${String(index)}]`))
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalize: ${path} is not a finite number`)
      return value
    case 'object': {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      return Object.fromEntries(entries.map(([key, member]) => [key, sortValue(member, `${path}.${key}`)]))
    }
    case 'undefined':
      throw new TypeError(`canonicalize: ${path} is undefined`)
    default:
      throw new TypeError(`canonicalize: ${path} has unsupported type ${typeof value}`)
  }
}

/**
 * Digest the parameters that define one operation.
 *
 * The kind is folded in so that reusing an id across families is a conflict
 * even when the parameter shapes happen to match.
 *
 * @param kind - the operation family.
 * @param params - the operation parameters.
 * @returns a hex digest.
 */
export function paramDigest(kind: OperationKind, params: unknown): string {
  return createHash('sha256').update(`${kind}\u0000${canonicalize(params)}`).digest('hex')
}

/**
 * Decide what an incoming mutation means given the persisted record, if any.
 *
 * A withdrawn record is deliberately reported as a conflict rather than as a
 * replay: reusing the id would resurrect a delivery the user cancelled, which
 * PRD §四.1 forbids across restarts.
 *
 * @param existing - the persisted record for this `operationId`, when present.
 * @param kind - the incoming operation family.
 * @param digest - the incoming parameter digest.
 * @returns the match verdict.
 */
export function classifyOperation(
  existing: OperationRecord | undefined,
  kind: OperationKind,
  digest: string,
): OperationMatch {
  if (existing === undefined) return { kind: 'new' }
  if (existing.kind !== kind) {
    return {
      kind: 'conflict',
      record: existing,
      reason: `operationId ${existing.operationId} already belongs to ${existing.kind}`,
    }
  }
  if (existing.paramDigest !== digest) {
    return {
      kind: 'conflict',
      record: existing,
      // Measured cause of a refusal that used to overstate itself: the create digest gained a `workspace`
      // field in a later revision, so an operation claimed before that change produces a different digest
      // for an identical request. The conductor cannot distinguish "different request" from "same request,
      // different digest scheme" when the original parameters were not kept — so it refuses either way and
      // says which of the two it can rule out.
      reason: existing.params === undefined
        ? `operationId ${existing.operationId} was used with different parameters, and the record kept none of `
          + 'them, so this retry cannot be confirmed as the same request. A plugin revision that changed what the '
          + 'digest covers looks the same from here, so the two are not told apart: the request is refused rather '
          + 'than replayed on a guess.'
        : `operationId ${existing.operationId} was used with different parameters`,
    }
  }
  if (existing.withdrawn) {
    return {
      kind: 'conflict',
      record: existing,
      reason: `operationId ${existing.operationId} was withdrawn and must not be replayed`,
    }
  }
  return { kind: 'replay', record: existing }
}

/**
 * What recovery must do with one persisted operation after a restart.
 *
 * This mirrors the three cases of PRD §四.1: an operation that never entered
 * dispatch may continue, one that can be confirmed as accepted has its receipt
 * backfilled without resending, and one that entered dispatch without a
 * confirmable result stays `unknown`.
 */
export type RecoveryAction = 'continue' | 'backfill_receipt' | 'reconcile' | 'done'

/**
 * Classify one record for recovery.
 *
 * The parameter is the two fields the decision actually reads, not the whole record:
 * a caller that holds a stored operation — whose `kind` is a widened string — or a
 * transfer's minimal view of one can ask the question without casting, and there is
 * no way for either to pass a record whose delivery state means something different.
 *
 * @param record - the operation's delivery state and withdrawal flag.
 * @returns the recovery action the service must take.
 */
export function recoveryAction(record: Pick<OperationRecord, 'delivery' | 'withdrawn'>): RecoveryAction {
  if (record.delivery === 'prepared') return record.withdrawn ? 'done' : 'continue'
  if (record.delivery === 'dispatching' || record.delivery === 'unknown') return 'reconcile'
  return 'done'
}

/**
 * What a restart should do with one unresolved operation (PRD §四.5, §四.1).
 *
 * §四.5 requires a restart to 先校准历史、队列和操作 before resuming monitoring and rules, and §四.1 says what
 * calibration means for a delivery whose result cannot be confirmed: it enters `unknown` and is reconciled,
 * **never resent**. Schedules were calibrated at boot and operations were not — `listRecoverableOperations()`
 * had no caller outside its own test — so an operation left mid-dispatch by a crash stayed in `dispatching`
 * for ever: a stage that can never resolve, on the one surface a caller reads to find out what happened.
 *
 * The restart makes exactly **one** state change on its own — `dispatching → unknown` — and the restraint is
 * the point. A `prepared` operation was claimed and never dispatched, so there is nothing to undo and nothing
 * to finish automatically: resuming a preparation creates a session or a worktree, which is a decision for
 * the controller (`conductor_operation resume`) rather than for a boot, and a retry is likewise the caller's,
 * where reusing the operation id makes it a replay instead of a second action.
 */
export type CalibrationOutcome =
  | { readonly action: 'mark_unknown'; readonly reason: string }
  | { readonly action: 'report'; readonly reason: string }

/** Operation families whose unfinished preparation a controller can continue. */
const RESUMABLE_KINDS: readonly string[] = ['create', 'fork', 'handoff', 'attach']

/**
 * Decide what to do with one operation the restart found unresolved.
 *
 * @param record - the operation's family and persisted delivery state.
 * @returns the one action a restart may take, or a report when it may take none.
 */
export function calibrateOperation(record: {
  readonly kind: string
  readonly delivery: string
}): CalibrationOutcome {
  if (record.delivery === 'dispatching') {
    return {
      action: 'mark_unknown',
      reason: `${record.kind} was mid-dispatch when the process stopped, so whether the Host received it cannot be `
        + 'confirmed from here. It is recorded as unknown for reconciliation and is NOT resent (PRD §四.1).',
    }
  }
  if (record.delivery === 'unknown') {
    return {
      action: 'report',
      reason: `${record.kind} is already unknown, and stays unknown until something outside the conductor confirms `
        + 'what happened to it. Nothing is sent again on the strength of a guess.',
    }
  }
  if (RESUMABLE_KINDS.includes(record.kind)) {
    return {
      action: 'report',
      reason: `${record.kind} was claimed and never dispatched, so nothing was carried out. Its preparation can be `
        + 'continued by the session that controls the task (conductor_operation resume); nothing is resumed '
        + 'automatically, because creating a session or a worktree is not a decision a restart may take.',
    }
  }
  return {
    action: 'report',
    reason: `${record.kind} was claimed and never dispatched, so nothing was carried out. It is not retried here: a `
      + 'retry is the caller\'s decision, and repeating the request under the same operation id makes it a replay '
      + 'rather than a second action (PRD §四.1).',
  }
}
