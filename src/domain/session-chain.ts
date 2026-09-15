/**
 * The session chain a handoff must show (PRD §二.10.2).
 *
 * A session's working directory cannot be changed in place, so a move creates a
 * successor session and keeps the predecessor. The store already records that
 * chain (`predecessorBindingId`, `retiredAt`). This module is the *display*
 * projection, so a panel card, a list line, a detail view or an export cannot
 * show only the current `sessionId` and look as though the task never moved.
 *
 * Pure data plus pure functions, importing nothing: the Host half and the
 * client half have to agree on the same sentence.
 *
 * @module dsh-session-conductor/domain/session-chain
 */

/** One stored binding as the chain projection reads it. */
export interface SessionChainBinding {
  readonly bindingId: string
  readonly sessionId: string
  readonly version: number
  readonly predecessorBindingId?: string | undefined
  readonly retiredAt?: string | undefined
}

/** One link in display order (oldest first). */
export interface SessionChainLink {
  readonly sessionId: string
  readonly current: boolean
  readonly retired: boolean
}

/**
 * Order the bindings by version and mark which session currently carries the task.
 *
 * `currentBindingId` wins when it is present. Otherwise the last non-retired
 * binding is current, and a fully retired chain treats the last version as
 * current rather than inventing a live session.
 *
 * @param bindings - every binding recorded for the task.
 * @param currentBindingId - the task's current binding, when it has one.
 * @returns the chain in version order.
 */
export function sessionChainOf(
  bindings: readonly SessionChainBinding[],
  currentBindingId?: string | undefined,
): readonly SessionChainLink[] {
  const ordered = [...bindings].sort((left, right) => left.version - right.version)
  const live = ordered.filter(binding => binding.retiredAt === undefined)
  const fallbackId = currentBindingId
    ?? (live.length > 0 ? live[live.length - 1]?.bindingId : ordered[ordered.length - 1]?.bindingId)
  return ordered.map(binding => ({
    sessionId: binding.sessionId,
    current: fallbackId !== undefined && binding.bindingId === fallbackId,
    retired: binding.retiredAt !== undefined,
  }))
}

/**
 * The sentence PRD §二.10.2 requires the interface to show.
 *
 * A single session is not a continuation. Two or more are: the current session
 * is named, then the predecessors in the order they ran.
 *
 * @param chain - {@link sessionChainOf}'s result.
 * @returns `任务继续于新会话 <current>（此前 <older> → …）`, or `undefined`.
 */
export function describeSessionContinuation(chain: readonly SessionChainLink[]): string | undefined {
  if (chain.length < 2) return undefined
  const current = chain.find(link => link.current) ?? chain[chain.length - 1]
  if (current === undefined) return undefined
  const previous = chain.filter(link => link.sessionId !== current.sessionId).map(link => link.sessionId)
  if (previous.length === 0) return undefined
  return `任务继续于新会话 ${current.sessionId}（此前 ${previous.join(' → ')}）`
}

/**
 * Identity-only arrow line of the whole chain, oldest first.
 *
 * Omitted for a single session so it cannot duplicate `sessionId` on a card
 * that already names the current one.
 *
 * @param chain - {@link sessionChainOf}'s result.
 * @returns `session-a → session-b`, or `undefined`.
 */
export function describeSessionChain(chain: readonly SessionChainLink[]): string | undefined {
  if (chain.length < 2) return undefined
  return chain.map(link => link.sessionId).join(' → ')
}

/**
 * Optional display fields a list, card or detail can spread.
 *
 * @param bindings - every binding recorded for the task.
 * @param currentBindingId - the task's current binding, when it has one.
 * @returns `continuation` and `sessionChain` only when they apply.
 */
export function sessionContinuationFields(
  bindings: readonly SessionChainBinding[],
  currentBindingId?: string | undefined,
): { readonly continuation?: string | undefined; readonly sessionChain?: string | undefined } {
  const chain = sessionChainOf(bindings, currentBindingId)
  const continuation = describeSessionContinuation(chain)
  const sessionChain = describeSessionChain(chain)
  return {
    ...continuation === undefined ? {} : { continuation },
    ...sessionChain === undefined ? {} : { sessionChain },
  }
}
