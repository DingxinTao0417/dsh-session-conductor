/**
 * The panel's status badge vocabulary, shared by both halves (PRD §二.1).
 *
 * ## Why this lives in `domain/`
 *
 * The browser half and the Host half deliberately share no *behaviour*: the client bundle is built
 * separately and must not reach into the Host. But they do have to agree on **one** vocabulary, and
 * the badge names are exactly that — the Host derives the badge and the panel filters and groups by
 * it. Two copies of a string union in two files is how a filter silently stops matching rows.
 *
 * So this module is the shared *vocabulary*: pure data plus one pure function, importing nothing at
 * all. `domain/` is already the layer the Host keeps its state model in (`domain/state.ts`), and the
 * client can reach it without pulling in a single Host dependency.
 *
 * ## What the badge is not
 *
 * The state model of PRD §三.4 keeps preparation, delivery, execution, interaction, the last turn and
 * acceptance as **separate dimensions that must never be collapsed into one another**. A single
 * `status` field would be exactly that collapse if it replaced them, so it does not: every dimension
 * stays on the card, and this badge is an *additional* derived key whose only job is to give the
 * list's filter and grouping something stable to key on. When a badge and a dimension disagree, the
 * dimension is the fact.
 *
 * ## `migrating` is absent, on purpose
 *
 * §二.1 also names "迁移中" among the special states a card shows. This build **refuses** every
 * migration — `remote.migrate` has no transport, and no migration record is ever constructed — so a
 * `migrating` badge would be an enum member with no producer: a filter that can never match a row.
 * It is left out until a migration can actually be in flight, rather than offered as a state the
 * panel cannot be in.
 *
 * @module dsh-session-conductor/domain/panel-status
 */

/**
 * The badges, in **precedence order**.
 *
 * The order is the precedence and it is deliberate: the earliest entries are the facts that make the
 * task unusable or that need a person, which is what a reader filtering a list is looking for. It is
 * a list rather than nested `if`s so the precedence is visible in one place and testable as data.
 */
export const PANEL_STATUSES = [
  /** 创建中: the environment is still being created (PRD §二.2.1). */
  'preparing',
  /** Preparation ended in failure; the task has no usable environment. */
  'preparation_failed',
  /** Preparation was cancelled, so the task is not going to run. */
  'cancelled',
  /** Management was released (PRD §二.5), so this reader is no longer monitoring it. */
  'released',
  /** 预算受限: a governing budget refuses the next automatic dispatch (PRD §二.13.2). */
  'budget_limited',
  /** Something is waiting on a person (PRD §二.8, §三.4 交互). */
  'waiting_user',
  /** A turn is executing right now (PRD §三.4 执行). `interrupting` is still a live turn. `reconciling` is not. */
  'running',
  /** Ready and between turns. */
  'idle',
] as const
export type PanelTaskStatus = (typeof PANEL_STATUSES)[number]

/**
 * The facts a badge is derived from.
 *
 * Plain strings rather than store records, so the derivation is a pure function of the record fields
 * it reads: the Host builds it from the store, and a test builds it from literals with no store at
 * all.
 */
export interface PanelStatusFacts {
  /** The persisted preparation state (`domain/state.ts`). */
  readonly preparation: string
  /** The projected execution state, when the session is live. */
  readonly execution?: string | undefined
  /** The projected interaction state, when the session is live. */
  readonly interaction?: string | undefined
  /** Why monitoring is not allowed, set only when management was released. */
  readonly releasedReason?: string | undefined
  /** Why the next automatic dispatch is refused by a budget, when one refuses it. */
  readonly budgetRefusal?: string | undefined
}

/** The badge, plus why it says what it says when the name alone is not enough to act on. */
export interface PanelStatus {
  readonly status: PanelTaskStatus
  readonly reason?: string | undefined
}

/**
 * Derive one task's badge from the facts the card holds.
 *
 * Pure and total: every input maps to exactly one badge, so the filter can never be missing a row. A
 * reason is attached only for the badges whose *name* is not enough to act on — a reader who sees
 * `budget_limited` needs to know which limit refused, and a reader who sees `released` needs to know
 * when it happened.
 *
 * @param facts - the task's preparation, projection, release and budget facts.
 * @returns the badge and, where it helps, the reason.
 */
export function panelStatusOf(facts: PanelStatusFacts): PanelStatus {
  if (facts.preparation === 'accepted' || facts.preparation === 'preparing') {
    return { status: 'preparing' }
  }
  if (facts.preparation === 'failed') return { status: 'preparation_failed' }
  if (facts.preparation === 'cancelled') return { status: 'cancelled' }
  if (facts.releasedReason !== undefined) {
    return { status: 'released', reason: facts.releasedReason }
  }
  if (facts.budgetRefusal !== undefined) {
    return { status: 'budget_limited', reason: facts.budgetRefusal }
  }
  if (facts.interaction !== undefined && facts.interaction !== 'none') {
    return { status: 'waiting_user', reason: facts.interaction }
  }
  if (facts.execution === 'running' || facts.execution === 'interrupting') {
    return { status: 'running' }
  }
  return { status: 'idle' }
}
