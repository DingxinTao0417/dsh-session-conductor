import { describe, expect, it } from 'vitest'
import {
  METERING_QUALITIES,
  budgetBoundary,
  budgetDecision,
  carryLedger,
  describeUsage,
  emptyLedger,
  hardBudgetAllowed,
  inFlightCancelApplies,
  planBudgetTurnCancel,
  type RunLedger,
  type UsageFact,
} from '../src/service/budget.ts'

const T0 = '2026-09-13T12:00:00.000Z'
const T1 = '2026-09-13T13:00:00.000Z'

/** A ledger with the members a test cares about overridden. */
function ledger(over: Partial<RunLedger> = {}): RunLedger {
  return { ...emptyLedger(), ...over }
}

/** A usage figure. */
function usage(over: Partial<UsageFact> = {}): UsageFact {
  return { quality: 'actual_full', value: 100, ...over }
}

describe('the run ledger cannot be zeroed (PRD §二.13.2)', () => {
  it('starts empty and counts each kind of plugin-initiated work', () => {
    let current = emptyLedger()
    current = carryLedger(current, { kind: 'dispatch', at: T0 })
    current = carryLedger(current, { kind: 'attempt' })
    current = carryLedger(current, { kind: 'rework_round' })
    current = carryLedger(current, { kind: 'turn', at: T0 })
    current = carryLedger(current, { kind: 'report_turn' })
    current = carryLedger(current, { kind: 'acceptance' })
    expect(current).toMatchObject({
      dispatches: 1, attempts: 1, reworkRounds: 1, turns: 1, reportTurns: 1, acceptances: 1,
    })
  })

  it('counts acceptances, which §二.13.2 names beside nodes, reports and rework', () => {
    // 所有由插件发起的节点、验收、回报和返工计入关联运行账本 — the acceptance was the only one of the four that the
    // ledger had no way to record, so an action the conductor took on the user's behalf left no trace in the
    // accounting of the run it belongs to.
    const counted = carryLedger(emptyLedger(), { kind: 'acceptance' })
    expect(counted.acceptances).toBe(1)
    // Every acceptance counts, and it is a count for a reader rather than a ceiling: §二.13.2 names no
    // acceptance limit, and `budgetLimitsOf` therefore offers none.
    expect(carryLedger(counted, { kind: 'acceptance' }).acceptances).toBe(2)
    expect(emptyLedger().acceptances).toBe(0)
  })

  it('counts report turns, because reports are plugin-initiated work too', () => {
    // PRD §二.13.2: nodes, acceptance, reports and rework all count into the ledger.
    const counted = carryLedger(emptyLedger(), { kind: 'report_turn' })
    expect(counted.reportTurns).toBe(1)
  })

  it('records the first dispatch instant once and never moves it', () => {
    // The deadline is measured from it, so a later value would silently extend the budget.
    const first = carryLedger(emptyLedger(), { kind: 'turn', at: T0 })
    expect(first.firstDispatchedAt).toBe(T0)
    const later = carryLedger(first, { kind: 'turn', at: T1 })
    expect(later.firstDispatchedAt).toBe(T0)
    expect(later.turns).toBe(2)
  })

  it('anchors the deadline on the first DISPATCH, which is what the rule measures from', () => {
    // PRD §二.13.2 measures the wall-clock deadline from the first dispatch. It used to be anchored
    // on the first *turn* — a different, later fact — which silently extended every deadline by
    // however long the target took to start. A dispatch now carries its instant and anchors the run.
    const dispatched = carryLedger(emptyLedger(), { kind: 'dispatch', at: T0 })
    expect(dispatched.firstDispatchedAt).toBe(T0)
    expect(dispatched.dispatches).toBe(1)
    // A later dispatch or turn cannot move it.
    expect(carryLedger(dispatched, { kind: 'dispatch', at: T1 }).firstDispatchedAt).toBe(T0)
    expect(carryLedger(dispatched, { kind: 'turn', at: T1 }).firstDispatchedAt).toBe(T0)
    // And events that carry no instant leave it unset rather than inventing one.
    expect(carryLedger(emptyLedger(), { kind: 'attempt' }).firstDispatchedAt).toBeUndefined()
  })

  it('refuses another dispatch when the concurrency limit is already reached', () => {
    // PRD §二.12's condition 5 is "并发及预算允许". The concurrency half was a dead field — stored,
    // and read by nothing — so a scope at its concurrency limit still accepted another dispatch.
    const policy = { scope: 'task' as const, maxConcurrent: 2 }
    expect(budgetDecision(policy, { ...emptyLedger(), concurrent: 1 }, T0).within).toBe(true)
    const reached = budgetDecision(policy, { ...emptyLedger(), concurrent: 2 }, T0)
    expect(reached.within).toBe(false)
    expect(reached.limit).toBe('concurrency')
    expect(reached.reason).toMatch(/2 execution\(s\) are already in flight/)
    expect(reached.actions).toEqual(['stop_new_scheduling', 'request_cancel', 'keep_ledger'])
  })

  it('refuses rather than assumes when nothing observed concurrency', () => {
    // A limit that cannot be checked must not read as satisfied: silence is not zero.
    const decision = budgetDecision({ scope: 'task', maxConcurrent: 1 }, emptyLedger(), T0)
    expect(decision.within).toBe(false)
    expect(decision.limit).toBe('concurrency')
    expect(decision.reason).toMatch(/nothing observed how many executions are in flight/)
    expect(decision.reason).toMatch(/not treated as satisfied/)
  })

  it('ignores concurrency entirely when no limit is set', () => {
    expect(budgetDecision({ scope: 'task' }, { ...emptyLedger(), concurrent: 99 }, T0).within).toBe(true)
  })

  it('has no operation that resets a counter', () => {
    // A transfer, a restart and a retry cannot zero the ledger, and the guarantee is that
    // no code exists which could. Every exported transform is applied here and the counts
    // may only grow.
    let current = ledger({ dispatches: 5, attempts: 5, reworkRounds: 2, turns: 5, reportTurns: 3 })
    const before = { ...current }
    current = carryLedger(current, { kind: 'usage', tokens: usage() })
    current = carryLedger(current, { kind: 'usage', cost: usage({ value: 1 }) })
    current = carryLedger(current, { kind: 'dispatch', at: T0 })
    expect(current.dispatches).toBeGreaterThanOrEqual(before.dispatches)
    expect(current.attempts).toBe(before.attempts)
    expect(current.reworkRounds).toBe(before.reworkRounds)
    expect(current.turns).toBe(before.turns)
    expect(current.reportTurns).toBe(before.reportTurns)
  })

  it('supersedes a usage figure rather than accumulating it', () => {
    // Usage is a running total the Host reports, not a delta per event.
    const first = carryLedger(emptyLedger(), { kind: 'usage', tokens: usage({ value: 100 }) })
    const second = carryLedger(first, { kind: 'usage', tokens: usage({ value: 250 }) })
    expect(second.tokens?.value).toBe(250)
  })
})

describe('unavailable is not zero (PRD §二.13.2)', () => {
  it('never renders an unavailable figure as a number', () => {
    const text = describeUsage({ quality: 'unavailable' }, 'cost')
    expect(text).toMatch(/unavailable/)
    expect(text).toMatch(/not the same as zero/)
    expect(text).not.toMatch(/\b0\b/)
  })

  it('renders an absent figure the same way as an unavailable one', () => {
    expect(describeUsage(undefined, 'tokens')).toBe(describeUsage({ quality: 'unavailable' }, 'tokens'))
  })

  it('marks an estimate as an estimate and names its basis', () => {
    const text = describeUsage({ quality: 'estimated', value: 42, basis: 'pricing-2026-09' }, 'cost')
    expect(text).toMatch(/estimated/)
    expect(text).toMatch(/pricing-2026-09/)
  })

  it('shows what a partial figure is missing rather than deriving a total', () => {
    const text = describeUsage({ quality: 'partial', value: 10, missingRange: 'turns 3-5 of 7' }, 'tokens')
    expect(text).toMatch(/partial/)
    expect(text).toMatch(/turns 3-5 of 7/)
    expect(text).toMatch(/no complete total is derived/)
  })

  it('marks a fully metered figure as actually metered', () => {
    expect(describeUsage(usage({ value: 12 }), 'tokens')).toMatch(/12 \(actually metered\)/)
  })

  it('covers every declared quality', () => {
    for (const quality of METERING_QUALITIES) {
      expect(describeUsage({ quality }, 'tokens').length).toBeGreaterThan(0)
    }
  })
})

describe('budget limits (PRD §二.13.2)', () => {
  it('is within budget when no limit is reached', () => {
    const decision = budgetDecision({ scope: 'task' }, ledger(), T0)
    expect(decision.within).toBe(true)
    expect(decision.actions).toEqual([])
  })

  it('measures the deadline in wall-clock time from the first dispatch', () => {
    // Waiting and approvals count against it, so a run cannot wait for free.
    const decision = budgetDecision(
      { scope: 'task', deadlineAt: T1 },
      ledger({ firstDispatchedAt: T1 }),
      T1,
    )
    expect(decision.within).toBe(false)
    expect(decision.limit).toBe('deadline')
    expect(decision.reason).toMatch(/wall-clock deadline/)
    expect(decision.reason).toMatch(/waiting and approvals count against it/)
  })

  it('reaches each counting limit independently', () => {
    const cases: [Parameters<typeof budgetDecision>[0], Partial<RunLedger>, string][] = [
      [{ scope: 'task', maxDispatches: 3 }, { dispatches: 3 }, 'dispatches'],
      [{ scope: 'task', maxAttempts: 2 }, { attempts: 2 }, 'attempts'],
      [{ scope: 'task', maxReworkRounds: 2 }, { reworkRounds: 2 }, 'rework_rounds'],
    ]
    for (const [policy, counts, limit] of cases) {
      const decision = budgetDecision(policy, ledger(counts), T0)
      expect(decision.within).toBe(false)
      expect(decision.limit).toBe(limit)
    }
  })

  it('reaching a limit stops new scheduling, requests a cancel and keeps the ledger', () => {
    // The three-part response, in order, and never a fourth part that deletes anything.
    const decision = budgetDecision({ scope: 'task', maxDispatches: 1 }, ledger({ dispatches: 1 }), T0)
    expect(decision.actions).toEqual(['stop_new_scheduling', 'request_cancel', 'keep_ledger'])
  })

  it('refuses a strict token ceiling when tokens cannot be metered', () => {
    const decision = budgetDecision(
      { scope: 'task', maxTokens: 1000, strict: true },
      ledger({ tokens: { quality: 'unavailable' } }),
      T0,
    )
    expect(decision.within).toBe(false)
    expect(decision.limit).toBe('tokens')
    expect(decision.actions).toEqual(['stop_new_scheduling', 'keep_ledger'])
    expect(decision.reason).toMatch(/limit that cannot be measured cannot be guaranteed/)
  })

  it('refuses a strict ceiling on a partial or estimated figure too', () => {
    for (const quality of ['partial', 'estimated'] as const) {
      const decision = budgetDecision({ scope: 'task', maxCost: 10, strict: true }, ledger({ cost: { quality, value: 1 } }), T0)
      expect(decision.within).toBe(false)
      expect(decision.reason).toMatch(/needs full metering/)
    }
  })

  it('continues on an unenforceable limit when the caller did not ask for strictness, and says it is not enforced', () => {
    const decision = budgetDecision({ scope: 'task', maxTokens: 1000 }, ledger(), T0)
    expect(decision.within).toBe(true)
    expect(decision.reason).toMatch(/NOT being enforced/)
    expect(decision.reason).toMatch(/do not treat it as a ceiling/)
  })

  it('enforces a metered ceiling once the figure is real', () => {
    const reached = budgetDecision(
      { scope: 'workflow', maxTokens: 100, strict: true },
      ledger({ tokens: usage({ value: 120 }) }),
      T0,
    )
    expect(reached.within).toBe(false)
    expect(reached.limit).toBe('tokens')
    const within = budgetDecision(
      { scope: 'workflow', maxTokens: 100, strict: true },
      ledger({ tokens: usage({ value: 99 }) }),
      T0,
    )
    expect(within.within).toBe(true)
  })
})

describe('a hard budget is a claim with prerequisites (PRD §二.13.2)', () => {
  it('allows the claim only when all three capabilities are present', () => {
    const allowed = hardBudgetAllowed({
      fullMetering: true, singleRequestUpperBound: true, concurrencyReservation: true,
    })
    expect(allowed.allowed).toBe(true)
  })

  it('refuses it when any one is missing, and names them', () => {
    const cases = [
      { fullMetering: false, singleRequestUpperBound: true, concurrencyReservation: true },
      { fullMetering: true, singleRequestUpperBound: false, concurrencyReservation: true },
      { fullMetering: true, singleRequestUpperBound: true, concurrencyReservation: false },
    ]
    for (const capabilities of cases) {
      const verdict = hardBudgetAllowed(capabilities)
      expect(verdict.allowed).toBe(false)
      expect(verdict.reason).toMatch(/cannot be claimed without/)
    }
  })

  it('explains why accounting alone is not enough', () => {
    // Usage learned only after a request ends cannot bound a request already in flight.
    const verdict = hardBudgetAllowed({
      fullMetering: true, singleRequestUpperBound: true, concurrencyReservation: false,
    })
    expect(verdict.reason).toMatch(/already in flight/)
    expect(verdict.reason).toMatch(/soft limit/)
  })
})

describe('the boundary a budget does not cross (PRD §二.13.2)', () => {
  it('states that it governs only what the conductor initiates', () => {
    const text = budgetBoundary()
    expect(text).toMatch(/only what the conductor itself initiates/)
    expect(text).toMatch(/native interface/)
    expect(text).toMatch(/external operations/)
  })
})

describe('requesting cancellation of the current turn (PRD §二.13.2)', () => {
  const reached = budgetDecision({ scope: 'task', maxDispatches: 1 }, ledger({ dispatches: 1 }), T0)
  const concurrent = budgetDecision(
    { scope: 'task', maxConcurrent: 1 },
    { ...emptyLedger(), concurrent: 1 },
    T0,
  )
  const unmeterable = budgetDecision(
    { scope: 'task', maxTokens: 10, strict: true },
    ledger({ tokens: { quality: 'unavailable' } }),
    T0,
  )

  it('applies to a reached countable limit, not to concurrency or an unmeterable strict refusal', () => {
    expect(inFlightCancelApplies(reached)).toBe(true)
    expect(inFlightCancelApplies(concurrent)).toBe(false)
    expect(inFlightCancelApplies(unmeterable)).toBe(false)
    expect(inFlightCancelApplies(budgetDecision({ scope: 'task' }, emptyLedger(), T0))).toBe(false)
  })

  it('requests cancel of an idle session so the actual stop state is reported', () => {
    const plan = planBudgetTurnCancel(reached, { taskId: 'task-a', running: false })
    expect(plan.intent).toBe('request')
    expect(plan.reason).toMatch(/no turn is in flight/)
  })

  it('requests cancel of a turn the conductor itself opened', () => {
    const plan = planBudgetTurnCancel(reached, {
      taskId: 'task-a',
      running: true,
      openingSource: { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'relay' },
    })
    expect(plan.intent).toBe('request')
    expect(plan.reason).toMatch(/conductor dispatch/)
  })

  it('does not cancel a native-interface turn', () => {
    const plan = planBudgetTurnCancel(reached, {
      taskId: 'task-a',
      running: true,
      openingSource: { kind: 'user' },
    })
    expect(plan.intent).toBe('skip')
    expect(plan.reason).toMatch(/native interface/)
  })

  it('does not cancel a running turn whose origin cannot be attributed', () => {
    const plan = planBudgetTurnCancel(reached, { taskId: 'task-a', running: true })
    expect(plan.intent).toBe('skip')
    expect(plan.reason).toMatch(/cannot be attributed/)
  })

  it('does not abort in-flight work for a concurrency ceiling', () => {
    const plan = planBudgetTurnCancel(concurrent, {
      taskId: 'task-a',
      running: true,
      openingSource: { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'relay' },
    })
    expect(plan.intent).toBe('skip')
    expect(plan.reason).toMatch(/does not abort work already in flight/)
  })
})
