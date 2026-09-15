/**
 * Host-wide plugin turn concurrency (PRD §四.4).
 *
 * Default: at most four plugin-initiated unfinished **target** turns per Host,
 * and waiting-for-user or waiting-for-approval occupies a slot. Controller
 * notices have a separate slot (default one). A native-interface turn does
 * not occupy either, and is not cancelled to make room.
 *
 * Reaching the limit does **not** refuse the request: it stays pending
 * (待派发). User-explicit dispatches go before automatic ones; within a kind,
 * oldest first.
 *
 * @module dsh-session-conductor/service/concurrency
 */

import { DEFAULTS } from '../domain/defaults.ts'
import { lastPromptSource } from './barrier.ts'
import { CONDUCTOR_SOURCE_PLUGIN } from './host.ts'
import {
  initialProjection,
  projectEvents,
  type SessionEventLike,
} from './projection.ts'

/** Who asked for a dispatch: a person, or an automatic writer. */
export type DispatchKind = 'explicit' | 'automatic'

/** Which plugin slot a live session occupies, when it occupies one. */
export type OccupiedSlot = 'target' | 'notice'

/** One pending send, as the flush order reads it. */
export interface PendingDispatchLike {
  readonly operationId: string
  readonly createdAt: string
  readonly attribution?: { readonly kind?: string } | undefined
}

/**
 * Whether a send is a person's explicit instruction or automatic scheduling.
 *
 * Attribution `user` or absent is explicit (`conductor_send` from a controller).
 * Rule, relay and notice writers are automatic, so they yield to a person.
 *
 * @param attribution - the operation's stored cause, when it has one.
 * @returns the kind.
 */
export function dispatchKindOf(attribution: { readonly kind?: string } | undefined): DispatchKind {
  if (attribution === undefined || attribution.kind === 'user') return 'explicit'
  return 'automatic'
}

/**
 * Which plugin slot a message source occupies, if any.
 *
 * Native UI input occupies none. A conductor `notice` occupies the report slot.
 * A conductor `relay` (and any other conductor plugin form that starts target
 * work) occupies a target-turn slot.
 *
 * @param source - the Host source on the opening user-role message.
 * @returns the slot, or `undefined` when the turn is not plugin-initiated.
 */
export function occupiedSlotOf(source: unknown): OccupiedSlot | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as { kind?: unknown; plugin?: unknown; form?: unknown }
  if (record.kind === 'user') return undefined
  if (record.kind !== 'plugin' || record.plugin !== CONDUCTOR_SOURCE_PLUGIN) return undefined
  return record.form === 'notice' ? 'notice' : 'target'
}

/**
 * Whether a live session currently occupies a plugin concurrency slot.
 *
 * Unfinished means the agent is running, or the projection is waiting on a
 * person or an approval — those waits still occupy the quota (PRD §四.4).
 *
 * @param agent - a live Host agent, or `undefined` when it is not.
 * @returns the slot, or `undefined` when this session occupies none.
 */
export function sessionOccupies(agent: {
  readonly status?: string
  readonly session?: { readonly events?: readonly SessionEventLike[] }
} | undefined): OccupiedSlot | undefined {
  if (agent === undefined) return undefined
  const events = agent.session?.events
  const projection = events === undefined
    ? initialProjection()
    : projectEvents(initialProjection(), events).state
  const unfinished = agent.status === 'running'
    || projection.interaction === 'waiting_approval'
    || projection.interaction === 'waiting_input'
  if (!unfinished) return undefined
  return occupiedSlotOf(lastPromptSource(events))
}

/**
 * Count how many observed sessions occupy one kind of slot.
 *
 * @param slots - per-session occupancy.
 * @param kind - which slot to count.
 * @returns the count.
 */
export function countOccupied(slots: readonly (OccupiedSlot | undefined)[], kind: OccupiedSlot): number {
  let count = 0
  for (const slot of slots) {
    if (slot === kind) count += 1
  }
  return count
}

/**
 * Whether another plugin turn of this slot may start now.
 *
 * A refusal here is "keep pending", not "reject the request". Native-interface
 * turns are not in the count and are not stopped to make room.
 *
 * @param args - observed occupancy, configured limits, and the slot wanted.
 * @returns whether to dispatch now, or why to wait.
 */
export function admitPluginTurn(args: {
  readonly occupiedTargets: number
  readonly occupiedNotices: number
  readonly targetLimit?: number
  readonly noticeLimit?: number
  readonly slot: OccupiedSlot
}): { readonly admit: true } | { readonly admit: false; readonly reason: string } {
  const targetLimit = args.targetLimit ?? DEFAULTS.targetTurnConcurrency
  const noticeLimit = args.noticeLimit ?? DEFAULTS.noticeConcurrency
  if (args.slot === 'notice') {
    if (args.occupiedNotices < noticeLimit) return { admit: true }
    return {
      admit: false,
      reason: `this Host already has ${String(args.occupiedNotices)} conductor notice turn(s) unfinished, `
        + `which is the configured limit of ${String(noticeLimit)}; the report is kept pending rather than refused`,
    }
  }
  if (args.occupiedTargets < targetLimit) return { admit: true }
  return {
    admit: false,
    reason: `this Host already has ${String(args.occupiedTargets)} plugin-initiated target turn(s) unfinished, `
      + `which is the configured limit of ${String(targetLimit)}; the request is kept pending rather than refused`,
  }
}

/**
 * Order pending dispatches: explicit first, then automatic; each kind FIFO.
 *
 * @param pending - prepared send operations.
 * @returns a new array in dispatch order.
 */
export function pendingDispatchOrder<T extends PendingDispatchLike>(pending: readonly T[]): T[] {
  return [...pending].sort((left, right) => {
    const leftKind = dispatchKindOf(left.attribution)
    const rightKind = dispatchKindOf(right.attribution)
    if (leftKind !== rightKind) return leftKind === 'explicit' ? -1 : 1
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
    return left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0
  })
}
