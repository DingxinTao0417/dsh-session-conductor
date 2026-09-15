/**
 * The state model of the PRD (§三.4, "状态模型"), expressed as data rather than
 * as a single flattened status.
 *
 * The specification is explicit that these are separate dimensions that must
 * never be collapsed into one another:
 *
 *   environment ready ≠ message accepted ≠ message consumed
 *   ≠ turn ended ≠ acceptance passed ≠ artifact transfer completed
 *
 * Every dimension therefore carries its own field on a task snapshot, and the
 * transitions below are the only legal ones. Keeping the transitions as data
 * (rather than as scattered `if`s) lets the service reject an illegal move with
 * one shared error and lets tests enumerate every edge.
 *
 * @module dsh-session-conductor/domain/state
 */

/** Preparation lifecycle of one logical task's current binding (PRD §三.4 准备). */
export const PREPARATION_STATES = ['accepted', 'preparing', 'ready', 'failed', 'cancelled'] as const
export type PreparationState = (typeof PREPARATION_STATES)[number]

/**
 * The finer-grained preparation phases a create/fork/handoff operation reports
 * while `preparation` is still `preparing` (PRD §二.2.1).
 *
 * `dispatching_initial_message` and `initial_message_accepted` belong to the
 * same operation as the creation itself: the specification requires the first
 * instruction to be correlated with the creating operation so that a retry does
 * not send it twice.
 */
export const PREPARATION_PHASES = [
  'accepted',
  'preparing_workspace',
  'preparing_context',
  'creating_session',
  'ready',
  'dispatching_initial_message',
  'initial_message_accepted',
] as const
export type PreparationPhase = (typeof PREPARATION_PHASES)[number]

/**
 * The Git starting states of PRD §二.4.
 *
 * The vocabulary lives here rather than in the Git adapter so the persisted record of "which
 * starting state this task used" and the code that prepares one cannot drift apart: a strategy
 * the store accepts but the adapter cannot prepare would be a persisted claim nobody can honour.
 */
export const START_STRATEGIES = [
  'current_head',
  'default_branch',
  'specific_rev',
  'worktree_snapshot',
  'existing_directory',
  'task_directory',
] as const
export type StartStrategy = (typeof START_STRATEGIES)[number]

/** Reachability of the target Host or Session (PRD §三.4 连接). */
export const CONNECTION_STATES = ['online', 'reconnecting', 'unavailable'] as const
export type ConnectionState = (typeof CONNECTION_STATES)[number]

/** The two Host facts connection is derived from. */
export interface ConnectionFacts {
  /** Whether the Host currently holds the session in memory. */
  readonly live: boolean
  /**
   * Whether the persistence backend still materialises the session.
   *
   * Omitted when this composition did not read that fact. Absence is not
   * `false`: claiming 不可恢复 without a persistence reading would invent it.
   */
  readonly persisted?: boolean | undefined
}

/** Reachability plus whether the session can still be resumed. */
export interface ConnectionReading {
  readonly connection: ConnectionState
  /** True only when persistence was read and said the session is gone. */
  readonly unrecoverable: boolean
  readonly reason: string
}

/**
 * Project Host liveness onto the connection dimension (PRD §三.4, §二.5).
 *
 * §二.5 asks a reader to see 失联, 不可恢复 and 外部归档. Archive is a separate
 * Host set. These two come from `live` and `persisted`:
 *
 * - live → `online`
 * - not live, still persisted → `unavailable`, 失联, recoverable
 * - not live, not persisted → `unavailable`, 不可恢复
 * - not live, persistence unread → `unavailable`, 失联, not claimed unrecoverable
 *
 * `reconnecting` stays in the vocabulary. This Host publishes no per-session
 * reconnecting signal (`idle` / `running` only), so this function never
 * invents it.
 *
 * @param facts - what the Host said about the session.
 * @returns the connection reading.
 */
export function connectionOf(facts: ConnectionFacts): ConnectionReading {
  if (facts.live) {
    return {
      connection: 'online',
      unrecoverable: false,
      reason: 'the Host currently holds this session',
    }
  }
  if (facts.persisted === true) {
    return {
      connection: 'unavailable',
      unrecoverable: false,
      reason: 'the session is persisted but not live in this Host (失联)',
    }
  }
  if (facts.persisted === false) {
    return {
      connection: 'unavailable',
      unrecoverable: true,
      reason: 'the session is neither live nor persisted (不可恢复)',
    }
  }
  return {
    connection: 'unavailable',
    unrecoverable: false,
    reason: 'the bound session is not live in this Host (失联); whether it is still persisted was not read',
  }
}

/**
 * The connection fields a managed-task list carries (PRD §二.5).
 *
 * Discovery and the panel already project 失联 / 不可恢复. A list that omitted
 * them would make `conductor_list` look like a different, less honest view of
 * the same tasks. Unbound tasks carry nothing: there is no session to be 失联.
 *
 * @param reading - the reachability of the bound session, when there is one.
 * @returns the three fields, or an empty object.
 */
export function connectionListFields(reading: ConnectionReading | undefined): {
  readonly connection?: ConnectionState
  readonly unrecoverable?: boolean
  readonly connectionReason?: string
} {
  if (reading === undefined) return {}
  return {
    connection: reading.connection,
    unrecoverable: reading.unrecoverable,
    connectionReason: reading.reason,
  }
}

/**
 * The short parenthetical a list line uses for reachability.
 *
 * @param fields - the connection fields on a list row or view.
 * @returns a trailing note, or empty when the task has no bound session.
 */
export function connectionListNote(fields: {
  readonly connection?: string | undefined
  readonly unrecoverable?: boolean | undefined
}): string {
  if (fields.connection === undefined) return ''
  if (fields.unrecoverable === true) return ' (不可恢复)'
  if (fields.connection === 'online') return ' (online)'
  return ' (失联)'
}

/** Whether a turn is executing right now (PRD §三.4 执行). */
export const EXECUTION_STATES = ['idle', 'running', 'interrupting', 'reconciling'] as const
export type ExecutionState = (typeof EXECUTION_STATES)[number]

/**
 * Conductor-side facts the Host log does not carry, used to produce the two
 * execution states this Host's agent never emits.
 *
 * The Host agent is `idle` / `running` only. `interrupting` is "we issued cancel
 * for the still-open turn"; `reconciling` is "a delivery is `unknown` and there
 * is no live turn" (PRD §四.1 parks unconfirmable work for reconciliation).
 * Neither is invented from a cache of "still running": interrupting requires a
 * matching open turn, and reconciling requires a stored unknown delivery.
 */
export interface ExecutionOverlayFacts {
  /** Turn a conductor cancel was issued for, when one was. */
  readonly cancelRequestedTurn?: number | undefined
  /** The Host's currently open turn, when one is open. */
  readonly openTurn?: number | undefined
  /** Whether this task has a delivery parked as `unknown`. */
  readonly unknownDeliveries: boolean
}

/**
 * Overlay interrupting / reconciling onto a Host-derived execution state.
 *
 * A live turn that we have asked to stop is `interrupting` only while that same
 * turn is still open — a later turn is `running`, not a retargeted interrupt.
 * Unknown deliveries make an idle session `reconciling`; they do not hide a
 * live turn.
 *
 * @param projected - what the session log folded to.
 * @param facts - conductor-side cancel and delivery facts.
 * @returns the execution dimension a snapshot should report.
 */
export function overlayExecution(
  projected: ExecutionState,
  facts: ExecutionOverlayFacts,
): ExecutionState {
  if (
    projected === 'running'
    && facts.cancelRequestedTurn !== undefined
    && facts.openTurn === facts.cancelRequestedTurn
  ) {
    return 'interrupting'
  }
  if (facts.unknownDeliveries && projected !== 'running') {
    return 'reconciling'
  }
  return projected
}

/** Whether the task is blocked on a human (PRD §三.4 交互). */
export const INTERACTION_STATES = ['none', 'waiting_input', 'waiting_approval'] as const
export type InteractionState = (typeof INTERACTION_STATES)[number]

/** Outcome of the most recent turn (PRD §三.4 最近轮次). */
export const TURN_OUTCOMES = ['completed', 'failed', 'interrupted', 'blocked'] as const
export type TurnOutcome = (typeof TURN_OUTCOMES)[number]

/**
 * Delivery state of one operation's message (PRD §三.4 投递).
 *
 * `unknown` is a first-class outcome, not an error to paper over: the PRD
 * requires an unconfirmable delivery to be parked there for reconciliation
 * instead of being resent (PRD §四.1).
 */
export const DELIVERY_STATES = [
  'prepared',
  'dispatching',
  'accepted',
  'consumed',
  'withdrawn',
  'failed',
  'unknown',
] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** Acceptance verdict of an artifact or workflow node (PRD §三.4 验收). */
export const ACCEPTANCE_STATES = ['pending', 'pass', 'fail', 'inconclusive'] as const
export type AcceptanceState = (typeof ACCEPTANCE_STATES)[number]

/** Workflow node status (PRD §三.4 工作流节点). */
export const NODE_STATES = [
  'blocked',
  'ready',
  'running',
  'waiting',
  'validating',
  'passed',
  'failed',
  'cancelled',
] as const
export type NodeState = (typeof NODE_STATES)[number]

/**
 * Legal successor sets for the delivery dimension.
 *
 * The pipeline the PRD mandates is
 * `保存操作 → 保存投递中 → 查重与状态校验 → 宿主受理 → flush → 保存回执`
 * (PRD §四.1), so `prepared → dispatching → accepted` is the only forward path
 * into a host acknowledgement. A message may be withdrawn while it is still
 * `prepared` (never consumed), and an unconfirmable dispatch settles into
 * `unknown` for reconciliation rather than falling back to `prepared`.
 */
const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = Object.freeze({
  prepared: ['dispatching', 'withdrawn', 'failed'],
  dispatching: ['accepted', 'unknown', 'failed'],
  accepted: ['consumed', 'withdrawn', 'unknown'],
  consumed: [],
  withdrawn: [],
  failed: ['prepared'],
  unknown: ['accepted', 'failed'],
})

/** Legal successor sets for the preparation dimension. */
const PREPARATION_TRANSITIONS: Readonly<Record<PreparationState, readonly PreparationState[]>> = Object.freeze({
  accepted: ['preparing', 'cancelled', 'failed'],
  preparing: ['ready', 'failed', 'cancelled'],
  ready: ['failed'],
  failed: [],
  cancelled: [],
})

/**
 * Whether a state move is legal in one dimension.
 * @param dimension - the dimension whose transition table applies.
 * @param from - current state.
 * @param to - requested state.
 * @returns true when `to` is reachable from `from` in one step.
 */
export function canTransition(
  dimension: 'preparation' | 'delivery',
  from: PreparationState | DeliveryState,
  to: PreparationState | DeliveryState,
): boolean {
  const table = dimension === 'preparation'
    ? (PREPARATION_TRANSITIONS as Readonly<Record<string, readonly string[]>>)
    : (DELIVERY_TRANSITIONS as Readonly<Record<string, readonly string[]>>)
  return table[from]?.includes(to) ?? false
}

/**
 * The reason a delivery can never be resent automatically.
 *
 * Kept as a named predicate rather than an inline comparison so the "no blind
 * resend" rule of PRD §四.1 has exactly one implementation to test.
 * @param state - the persisted delivery state after a crash or restart.
 * @returns true when recovery must reconcile instead of resending.
 */
export function requiresReconciliation(state: DeliveryState): boolean {
  return state === 'unknown' || state === 'dispatching'
}

/**
 * Whether the environment is usable for `send`/`interrupt` (PRD §二.2.1).
 *
 * `ready` before independent send/stop requests are accepted; a pre-allocated
 * session id does not by itself make a task operable.
 * @param state - the task's preparation state.
 * @returns true when the specification allows sends and stops.
 */
export function acceptsWrites(state: PreparationState): boolean {
  return state === 'ready'
}
