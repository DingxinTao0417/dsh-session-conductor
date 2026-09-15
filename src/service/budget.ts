/**
 * Budgets and the run ledger (PRD §二.13.2).
 *
 * Four rules in this section are easy to implement in a way that looks right and is
 * not, and each is a function here:
 *
 * 1. **Unavailable is not zero.** A cost that cannot be metered must display as
 *    unavailable, never as `0` — a zero is a claim that nothing was spent, and it is the
 *    one claim the absence of metering cannot support. {@link describeUsage} is the only
 *    place usage is rendered, so this cannot be answered differently in two places.
 * 2. **A hard budget is a claim with prerequisites.** It requires full metering, a
 *    reliable single-request upper bound, and a concurrency reservation. Usage learned
 *    only *after* a request ends cannot bound a request already in flight, so
 *    {@link hardBudgetAllowed} refuses the claim rather than approximating it.
 * 3. **The ledger survives.** Transfer, restart and retry cannot zero it: every
 *    operation on the ledger adds, and there is no reset. A budget that could be reset
 *    by retrying is not a budget.
 * 4. **A deadline is wall-clock from the first dispatch**, waiting and approvals
 *    included — so it is measured from a recorded instant, not from elapsed *work*.
 *
 * The specification also fixes what reaching a limit does, and it is deliberately
 * three-part: stop new automatic scheduling, request cancellation of the current turn
 * where the saved policy authorises it, and keep the results and the ledger while
 * reporting the *actual* stop state. {@link budgetDecision} returns exactly those;
 * {@link inFlightCancelApplies} and {@link planBudgetTurnCancel} are the second part,
 * so a reached limit is not only named as `request_cancel` but decided as a real
 * cancel-or-skip against the authorised policy and the turn's origin.
 *
 * @module dsh-session-conductor/service/budget
 */

/** What a budget governs. */
export const BUDGET_SCOPES = ['task', 'group', 'workflow'] as const
export type BudgetScope = (typeof BUDGET_SCOPES)[number]

/** How trustworthy a usage figure is. Ordered from best to worst. */
export const METERING_QUALITIES = ['actual_full', 'partial', 'estimated', 'unavailable'] as const
export type MeteringQuality = (typeof METERING_QUALITIES)[number]

/**
 * One usage figure, with the quality that makes it readable.
 *
 * `value` is absent when the quality is `unavailable`: a number there would be read as
 * a measurement, and there is none.
 */
export interface UsageFact {
  readonly quality: MeteringQuality
  readonly value?: number | undefined
  /** For `partial`: what range is missing, so the gap is visible rather than inferred. */
  readonly missingRange?: string | undefined
  /** For `estimated`: the pricing or estimation basis, so the figure can be dated. */
  readonly basis?: string | undefined
}

/** A budget policy. Every limit is optional; an absent one means "not limited here". */
export interface BudgetPolicy {
  readonly scope: BudgetScope
  /** Wall-clock deadline, measured from the first dispatch. */
  readonly deadlineAt?: string | undefined
  readonly maxConcurrent?: number | undefined
  readonly maxDispatches?: number | undefined
  readonly maxAttempts?: number | undefined
  readonly maxReworkRounds?: number | undefined
  readonly maxTokens?: number | undefined
  readonly maxCost?: number | undefined
  /** True when the caller asked for a limit that must not be exceeded. */
  readonly strict?: boolean | undefined
}

/** What the ledger has recorded for one run. */
export interface RunLedger {
  /** Wall-clock instant of the first dispatch, which the deadline is measured from. */
  readonly firstDispatchedAt?: string | undefined
  readonly dispatches: number
  readonly attempts: number
  readonly reworkRounds: number
  readonly turns: number
  /** Plugin-initiated report turns, which count too. */
  readonly reportTurns: number
  /**
   * Plugin-initiated **acceptances** — PRD §二.13.2: 所有由插件发起的节点、验收、回报和返工计入关联运行账本.
   *
   * Nodes, reports and reworks were counted; acceptances were not, so an action the conductor performed on
   * the user's behalf left no trace in the accounting of the run it belongs to. It is a count for a reader
   * rather than a limit: §二.13.2 lists no acceptance ceiling, and inventing one here would be a policy the
   * specification does not state.
   */
  readonly acceptances: number
  /**
   * How many executions the caller observed in flight for this scope, when it observed any.
   *
   * A count rather than a counter: concurrency is a *state*, not an accumulation, so it cannot be
   * carried from one event to the next the way the other figures are. The caller observes it and
   * hands it in, which keeps the decision itself a pure function of what it was told.
   */
  readonly concurrent?: number | undefined
  readonly tokens?: UsageFact | undefined
  readonly cost?: UsageFact | undefined
}

/** A ledger with nothing recorded yet. */
export function emptyLedger(): RunLedger {
  return { dispatches: 0, attempts: 0, reworkRounds: 0, turns: 0, reportTurns: 0, acceptances: 0 }
}

/** What can be added to a ledger. */
export type LedgerEvent =
  /**
   * One dispatch happened, and when.
   *
   * The instant is required because PRD §二.13.2 measures the wall-clock deadline **from the first
   * dispatch**. Carrying no instant made that impossible, so the anchor was taken from the first
   * *turn* instead — a different fact that can arrive later, which silently extended the deadline.
   */
  | { readonly kind: 'dispatch'; readonly at: string }
  | { readonly kind: 'attempt' }
  | { readonly kind: 'rework_round' }
  | { readonly kind: 'turn'; readonly at: string }
  | { readonly kind: 'report_turn' }
  /**
   * One acceptance was recorded (PRD §二.13.2's 验收).
   *
   * Carries no instant: nothing measures a deadline from an acceptance, and a field no caller reads would be
   * invented data. What it carries is the fact — an acceptance happened, and how many have.
   */
  | { readonly kind: 'acceptance' }
  | { readonly kind: 'usage'; readonly tokens?: UsageFact; readonly cost?: UsageFact }

/** Which counter each event moves. */
function counterFor(kind: LedgerEvent['kind']): keyof RunLedger | undefined {
  switch (kind) {
    case 'dispatch': return 'dispatches'
    case 'attempt': return 'attempts'
    case 'rework_round': return 'reworkRounds'
    case 'turn': return 'turns'
    case 'report_turn': return 'reportTurns'
    case 'acceptance': return 'acceptances'
    default: return undefined
  }
}

/**
 * Add one event to the ledger.
 *
 * Every operation **adds**. There is no reset, no decrement and no "start over":
 * PRD §二.13.2 says a transfer, a restart and a retry cannot zero the ledger, and the
 * way to guarantee that is to have no code that could. A caller that wants a fresh
 * ledger for a genuinely new run has to create a new run, which is a different thing
 * with a different identity rather than the same run with its history erased.
 *
 * @param ledger - the ledger as it stands.
 * @param event - what happened.
 * @returns the ledger with the event counted.
 */
export function carryLedger(ledger: RunLedger, event: LedgerEvent): RunLedger {
  if (event.kind === 'usage') {
    return {
      ...ledger,
      // A later figure supersedes an earlier one of the *same* kind, because usage is a
      // running total reported by the Host, not a delta to accumulate.
      ...event.tokens === undefined ? {} : { tokens: event.tokens },
      ...event.cost === undefined ? {} : { cost: event.cost },
    }
  }
  const counter = counterFor(event.kind)
  if (counter === undefined) return ledger
  // The anchor is the first event that carries an instant — a dispatch, or a turn for a run whose
  // first observable event was one. Recorded once and never rewritten, because a later value would
  // silently extend the deadline.
  const at = 'at' in event ? event.at : undefined
  return {
    ...ledger,
    [counter]: (ledger[counter] as number) + 1,
    ...at !== undefined && ledger.firstDispatchedAt === undefined ? { firstDispatchedAt: at } : {},
  }
}

/**
 * Render a usage figure honestly.
 *
 * The rule this exists for: an unavailable figure must never render as `0`. A reader
 * who sees `0 tokens` concludes nothing was spent, and the absence of metering is not
 * evidence of absence of spending.
 *
 * @param fact - the figure, or undefined when nothing is known at all.
 * @param unit - what is being counted.
 * @returns the text to show.
 */
export function describeUsage(fact: UsageFact | undefined, unit: string): string {
  if (fact === undefined || fact.quality === 'unavailable') {
    return `${unit}: unavailable — this deployment cannot meter it, which is not the same as zero`
  }
  if (fact.quality === 'estimated') {
    return `${unit}: ~${String(fact.value ?? 0)} (estimated${fact.basis === undefined ? '' : `, basis ${fact.basis}`})`
  }
  if (fact.quality === 'partial') {
    return `${unit}: ${String(fact.value ?? 0)} recorded, partial — ${fact.missingRange ?? 'an unknown range is missing'}; `
      + 'no complete total is derived from it'
  }
  return `${unit}: ${String(fact.value ?? 0)} (actually metered)`
}

/** What a budget check concluded. */
/**
 * The limits one policy configures, in the order PRD §二.13.2 lists them.
 *
 * Extracted so the tool that reports a policy and the panel that describes a task's configuration render
 * the same list from one implementation: two orderings of the same limits is exactly how a reader ends up
 * checking a limit the other surface does not show. Concurrency is included like every other limit — one
 * that is enforced but not displayed is one an operator cannot check.
 *
 * @param policy - the policy.
 * @returns one phrase per configured limit; empty when the policy configures none.
 */
export function budgetLimitsOf(policy: BudgetPolicy): readonly string[] {
  return [
    ...policy.deadlineAt === undefined ? [] : [`deadline ${policy.deadlineAt}`],
    ...policy.maxDispatches === undefined ? [] : [`${String(policy.maxDispatches)} dispatches`],
    ...policy.maxAttempts === undefined ? [] : [`${String(policy.maxAttempts)} attempts`],
    ...policy.maxReworkRounds === undefined ? [] : [`${String(policy.maxReworkRounds)} rework rounds`],
    ...policy.maxConcurrent === undefined ? [] : [`${String(policy.maxConcurrent)} concurrent`],
    ...policy.maxTokens === undefined ? [] : [`${String(policy.maxTokens)} tokens`],
    ...policy.maxCost === undefined ? [] : [`${String(policy.maxCost)} cost`],
  ]
}

export interface BudgetDecision {
  readonly within: boolean
  /** Which limit was reached, when one was. */
  readonly limit?: 'deadline' | 'dispatches' | 'attempts' | 'rework_rounds' | 'concurrency' | 'tokens' | 'cost' | undefined
  readonly reason: string
  /** The three-part response PRD §二.13.2 requires, in order. */
  readonly actions: readonly ('stop_new_scheduling' | 'request_cancel' | 'keep_ledger')[]
}

/**
 * Decide whether a run is still within its budget.
 *
 * The deadline is measured from the ledger's first dispatch, so waiting and approvals
 * count against it — the specification says so explicitly, and measuring elapsed *work*
 * instead would let a run wait indefinitely for free.
 *
 * A limit whose usage cannot be metered is **not** treated as satisfied: an unmeterable
 * token ceiling cannot be enforced, and reporting "within budget" would claim an
 * enforcement that does not exist. It is reported as a limit the deployment cannot
 * check, and a `strict` policy refuses to continue on that basis.
 *
 * @param policy - the budget.
 * @param ledger - the run's ledger.
 * @param now - the current instant, as an ISO 8601 UTC string.
 * @returns the decision, including the actions to take when a limit is reached.
 */
export function budgetDecision(policy: BudgetPolicy, ledger: RunLedger, now: string): BudgetDecision {
  const reached = (limit: BudgetDecision['limit'], reason: string): BudgetDecision => ({
    within: false,
    limit,
    reason,
    actions: ['stop_new_scheduling', 'request_cancel', 'keep_ledger'],
  })

  if (policy.deadlineAt !== undefined) {
    const deadline = Date.parse(policy.deadlineAt)
    if (Number.isFinite(deadline) && Date.parse(now) >= deadline) {
      return reached('deadline', `the wall-clock deadline ${policy.deadlineAt} has passed, measured from the first `
        + `dispatch at ${ledger.firstDispatchedAt ?? '(never dispatched)'}; waiting and approvals count against it`)
    }
  }
  if (policy.maxDispatches !== undefined && ledger.dispatches >= policy.maxDispatches) {
    return reached('dispatches', `the run has dispatched ${String(ledger.dispatches)} time(s), its maximum`)
  }
  if (policy.maxAttempts !== undefined && ledger.attempts >= policy.maxAttempts) {
    return reached('attempts', `the run has made ${String(ledger.attempts)} attempt(s), its maximum`)
  }
  if (policy.maxReworkRounds !== undefined && ledger.reworkRounds >= policy.maxReworkRounds) {
    return reached('rework_rounds', `the run has used ${String(ledger.reworkRounds)} rework round(s), its maximum`)
  }
  // Concurrency is checked before anything is dispatched, because that is the only moment at which
  // starting one more can be refused. The count is what the caller observed in flight for this
  // scope; when it observed nothing the limit cannot be enforced and is not silently treated as
  // satisfied — the refusal says so instead.
  if (policy.maxConcurrent !== undefined) {
    const concurrent = ledger.concurrent
    if (concurrent === undefined) {
      return {
        within: false,
        limit: 'concurrency',
        reason: `this policy sets a concurrency limit of ${String(policy.maxConcurrent)}, and nothing observed how many `
          + 'executions are in flight for it, so the limit cannot be checked. It is not treated as satisfied.',
        actions: ['stop_new_scheduling', 'request_cancel', 'keep_ledger'],
      }
    }
    if (concurrent >= policy.maxConcurrent) {
      return reached(
        'concurrency',
        `${String(concurrent)} execution(s) are already in flight for this scope, and its limit is `
        + `${String(policy.maxConcurrent)}`,
      )
    }
  }
  if (policy.maxTokens !== undefined) {
    const tokens = ledger.tokens
    if (tokens === undefined || tokens.quality === 'unavailable') {
      return strictRefusal(policy, 'tokens', 'a token ceiling cannot be enforced because this deployment cannot meter tokens')
    }
    if (tokens.quality !== 'actual_full') {
      return strictRefusal(policy, 'tokens',
        `a token ceiling needs full metering, and this deployment reports tokens as ${tokens.quality}`)
    }
    if ((tokens.value ?? 0) >= policy.maxTokens) {
      return reached('tokens', `the run has used ${String(tokens.value ?? 0)} tokens, its maximum`)
    }
  }
  if (policy.maxCost !== undefined) {
    const cost = ledger.cost
    if (cost === undefined || cost.quality === 'unavailable') {
      return strictRefusal(policy, 'cost', 'a cost ceiling cannot be enforced because this deployment cannot meter cost')
    }
    if (cost.quality !== 'actual_full') {
      return strictRefusal(policy, 'cost',
        `a cost ceiling needs full metering, and this deployment reports cost as ${cost.quality}`)
    }
    if ((cost.value ?? 0) >= policy.maxCost) {
      return reached('cost', `the run has spent ${String(cost.value ?? 0)}, its maximum`)
    }
  }
  return { within: true, reason: 'the run is within every limit this policy sets', actions: [] }
}

/**
 * Whether a reached budget may request cancellation of an in-flight turn.
 *
 * The decision always *names* `request_cancel` when a countable limit is reached, but
 * two cases must not actually abort work: a concurrency ceiling is a gate on starting
 * more, not a reason to kill what is already running; and a strict refusal on an
 * unmeterable figure already omits `request_cancel` because there is no authorised
 * enforcement, only a stop of new automatic scheduling.
 *
 * @param decision - the budget decision.
 * @returns true when the second of PRD §二.13.2's three actions applies.
 */
export function inFlightCancelApplies(decision: BudgetDecision): boolean {
  if (decision.within) return false
  if (!decision.actions.includes('request_cancel')) return false
  return decision.limit !== 'concurrency'
}

/** What the authorised policy decided to do about one governed task's open turn. */
export interface BudgetCancelPlan {
  readonly taskId: string
  readonly intent: 'request' | 'skip'
  readonly reason: string
}

/**
 * Decide whether to request cancellation of one task's current turn.
 *
 * A budget "按已授权策略请求取消当前轮次" and "不宣称控制插件无法观测的原界面". So:
 *
 * - an idle session is still *requested*, so the actual stop state (`no_active_turn`)
 *   is reported rather than assumed;
 * - a turn opened by a conductor plugin message may be cancelled;
 * - a turn opened from the native `{kind:'user'}` interface is skipped;
 * - a running turn whose origin cannot be attributed is skipped rather than guessed.
 *
 * @param decision - the budget decision for the governing policy.
 * @param target - the governed task and what is known about its open turn.
 * @returns the plan for that task.
 */
export function planBudgetTurnCancel(
  decision: BudgetDecision,
  target: {
    readonly taskId: string
    readonly running: boolean
    readonly openingSource?: unknown
  },
): BudgetCancelPlan {
  if (!inFlightCancelApplies(decision)) {
    return {
      taskId: target.taskId,
      intent: 'skip',
      reason: decision.within
        ? 'the run is within budget, so no turn is cancelled'
        : decision.limit === 'concurrency'
          ? 'a concurrency limit stops new automatic dispatch; it does not abort work already in flight'
          : `this decision does not authorise cancelling the current turn (${decision.actions.join(', ') || 'no actions'})`,
    }
  }
  if (target.running) {
    if (isNativeUserSource(target.openingSource)) {
      return {
        taskId: target.taskId,
        intent: 'skip',
        reason: 'the open turn was opened from the native interface, which this budget does not govern',
      }
    }
    if (isConductorPluginSource(target.openingSource)) {
      return {
        taskId: target.taskId,
        intent: 'request',
        reason: 'the open turn was opened by a conductor dispatch, which the authorised policy may cancel',
      }
    }
    return {
      taskId: target.taskId,
      intent: 'skip',
      reason: 'the open turn cannot be attributed to plugin-initiated work, so it is not cancelled',
    }
  }
  return {
    taskId: target.taskId,
    intent: 'request',
    reason: 'no turn is in flight; the actual stop state is reported rather than assumed',
  }
}

/** Whether a message source is a person typing in the Host UI. */
function isNativeUserSource(source: unknown): boolean {
  return typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind === 'user'
}

/** Whether a message source is this plugin's own dispatch. */
function isConductorPluginSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const record = source as { kind?: unknown; plugin?: unknown }
  return record.kind === 'plugin' && record.plugin === 'dsh-session-conductor'
}

/**
 * What to do when a policy sets a limit the deployment cannot check.
 *
 * A strict policy stops; a non-strict one continues but says that the limit is not being
 * enforced, because silently continuing would let a caller believe a ceiling applies.
 *
 * @param policy - the budget.
 * @param limit - which limit is unenforceable.
 * @param reason - why it cannot be enforced.
 * @returns the decision.
 */
function strictRefusal(policy: BudgetPolicy, limit: BudgetDecision['limit'], reason: string): BudgetDecision {
  if (policy.strict === true) {
    return {
      within: false,
      limit,
      reason: `${reason}. This policy asked for a strict limit, so the automatic execution does not start: `
        + 'a limit that cannot be measured cannot be guaranteed, and claiming it would be worse than refusing it.',
      actions: ['stop_new_scheduling', 'keep_ledger'],
    }
  }
  return {
    within: true,
    reason: `${reason}. The run continues, and the limit is NOT being enforced — do not treat it as a ceiling.`,
    actions: [],
  }
}

/** The capabilities a hard budget needs. */
export interface MeteringCapabilities {
  /** Whether per-request usage is reported completely. */
  readonly fullMetering: boolean
  /** Whether a reliable upper bound for one request is known before it starts. */
  readonly singleRequestUpperBound: boolean
  /** Whether concurrency is reserved rather than merely counted afterwards. */
  readonly concurrencyReservation: boolean
}

/**
 * Whether a hard budget may be claimed.
 *
 * All three capabilities are required, and the reason for the third is the one worth
 * stating: usage learned only *after* a request ends cannot bound a request already in
 * flight, so no amount of accurate accounting turns a concurrent run into a hard-capped
 * one without a reservation.
 *
 * @param capabilities - what the deployment can do.
 * @returns whether the claim is allowed, and why not when it is not.
 */
export function hardBudgetAllowed(capabilities: MeteringCapabilities): { readonly allowed: boolean; readonly reason: string } {
  const missing: string[] = []
  if (!capabilities.fullMetering) missing.push('full metering')
  if (!capabilities.singleRequestUpperBound) missing.push('a reliable single-request upper bound')
  if (!capabilities.concurrencyReservation) missing.push('a concurrency reservation')
  if (missing.length === 0) {
    return { allowed: true, reason: 'full metering, a single-request upper bound and a concurrency reservation are all available' }
  }
  return {
    allowed: false,
    reason: `a hard budget cannot be claimed without ${missing.join(', ')}. Usage obtained only after a request ends `
      + 'cannot guarantee that a request already in flight stays inside the limit, so this is reported as a soft '
      + 'limit that is displayed and alerted on rather than enforced.',
  }
}

/**
 * Describe what a budget does and does not govern.
 *
 * PRD §二.13.2 is explicit that a budget must not claim to control the native interface
 * or external operations the plugin cannot observe. This text states that boundary
 * beside every budget decision, so a reader does not infer a wider reach.
 *
 * @returns the boundary statement.
 */
export function budgetBoundary(): string {
  return 'This budget governs only what the conductor itself initiates: the nodes, turns, reports and rework it '
    + 'dispatches. It does not meter or limit work started from the native interface, and it cannot observe or '
    + 'stop external operations such as network calls a task performs on its own.'
}
