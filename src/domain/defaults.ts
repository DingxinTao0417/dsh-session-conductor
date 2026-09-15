/**
 * Every default the PRD fixes in §四.7 ("默认配置"), plus the limits quoted
 * elsewhere in the specification.
 *
 * These live in one frozen table so that a test can assert the shipped values
 * against the specification, and so that no call site invents its own fallback.
 *
 * @module dsh-session-conductor/domain/defaults
 */

/** The context mode a new task uses when the user does not choose one (PRD §二.2.2). */
export const DEFAULT_CONTEXT_MODE = 'brief' as const

/**
 * Decisions the specification leaves to the implementation.
 *
 * Kept apart from {@link DEFAULTS} on purpose. `DEFAULTS` is a transcription of the
 * published table, and a test asserts it equals that table value for value — an
 * invariant worth having, because it is what stops a specified default from being
 * quietly changed. Adding an implementation choice to it would break that check for
 * a reason that has nothing to do with the specification, so these live here and are
 * named as what they are.
 */
export const IMPLEMENTATION_DEFAULTS = Object.freeze({
  /**
   * 后台巡检间隔 (ms) — how often the conductor runs its own scheduling and
   * reporting pass.
   *
   * PRD §四.7 has no row for this, and it cannot: how often an implementation looks
   * for due work is not observable behaviour. It is needed all the same, because
   * automatic reporting and scheduled checks cannot happen on demand. The value sits
   * above the 2-second report merge window so ordinary events still merge into one
   * notice, and far below the minute granularity a calendar schedule can express.
   */
  passIntervalMs: 5_000,
})

/** Default values and hard ceilings quoted by the specification. */
export const DEFAULTS = Object.freeze({
  /** 控制会话管理目标数 — managed targets per controller session. */
  managedTargetLimit: 20,
  /** 每 Host 插件目标轮次并发 — plugin-initiated target turns per Host, waiting turns included. */
  targetTurnConcurrency: 4,
  /** 每 Host 自动回报并发 — the separate notification slot (PRD §四.4). */
  noticeConcurrency: 1,
  /** 面板刷新合并间隔 (ms). */
  panelRefreshMergeMs: 250,
  /** 回报合并窗口 (ms) — events from one controller session merge inside this window. */
  noticeMergeWindowMs: 2_000,
  /** 默认读取量 — messages returned when a caller does not ask for a count. */
  defaultReadLimit: 20,
  /** 工具单次文本输出上限 (characters) — truncation must be marked. */
  toolTextLimit: 12_000,
  /** 同步等待上限 (ms) — a single `wait` call may not exceed this (PRD §二.7). */
  waitLimitMs: 60_000,
  /** 打断确认等待上限 (ms) — after this, an interrupt_and_send reports the stop as unconfirmed. */
  interruptConfirmLimitMs: 30_000,
  /** 自动返工 — rework rounds for one workflow run; the initial execution does not count. */
  reworkRounds: 2,
  /** 不确定投递自动重发 — never resend a delivery whose acceptance cannot be established. */
  resendUnknownDelivery: false,
  /** 自动删除资源 — cleanup always requires an explicit selection. */
  autoDeleteResources: false,
  /** 跨 Host — off until a user registers a trusted remote Host explicitly. */
  crossHostEnabled: false,
  /** 在线分享 — unconfigured and disabled; the default lifetime once enabled is 7 days. */
  shareEnabled: false,
  shareLifetimeDays: 7,
} as const)

/**
 * The output budget a tool result must respect before it is truncated.
 *
 * Kept separate from {@link DEFAULTS} because a profile may override it: the
 * value the service actually uses is resolved from configuration and then
 * passed down, and the truncation marker plus the follow-up read instructions
 * are mandatory regardless of the number (PRD §二.7, §四.7).
 */
export interface OutputBudget {
  /** Maximum characters of text returned in one tool result. */
  readonly textLimit: number
}

/**
 * Truncate text to a budget, appending the marker the PRD requires.
 *
 * A truncated result must say that it was truncated and how to continue reading;
 * silently returning a shorter list is what the specification forbids.
 *
 * @param text - the complete text.
 * @param budget - the resolved output budget.
 * @param continueWith - tool call that returns the remainder, named for the reader.
 * @returns the original text, or a marked prefix plus the continuation hint.
 */
export function truncateMarked(text: string, budget: OutputBudget, continueWith: string): string {
  if (text.length <= budget.textLimit) return text
  const marker = `\n… [truncated: showing ${String(budget.textLimit)} of ${String(text.length)} characters; continue with ${continueWith}]`
  const keep = Math.max(0, budget.textLimit - marker.length)
  return text.slice(0, keep) + marker
}
