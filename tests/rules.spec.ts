import { describe, expect, it } from 'vitest'
import {
  controlCycleRefusal,
  evaluateRules,
  fireOperationId,
  planEnable,
  planFire,
  recordFiring,
  satisfiesRequirement,
  triggerOf,
} from '../src/service/rules.ts'
import { newArtifactRecord } from '../src/service/artifacts.ts'
import type { ArtifactRecord, RuleRecord } from '../src/store/schema.ts'

const NOW = '2026-09-13T00:00:00.000Z'

/** A saved rule authorising one dispatch. */
function rule(over: Partial<RuleRecord> = {}): RuleRecord {
  return {
    ruleId: 'rule-1',
    version: 0,
    title: 'hand the design to the front end',
    trigger: 'turn_completed',
    sourceTaskId: 'task-design',
    targetTaskId: 'task-frontend',
    action: 'send',
    instruction: 'start integrating against the accepted interface',
    maxExecutions: 1,
    authorizedBy: 'session-controller',
    active: true,
    firings: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

/** An accepted artifact, as a rule's input requirement expects. */
function acceptedArtifact(over: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    ...newArtifactRecord({
      artifactId: 'artifact-1', taskId: 'task-design', kind: 'file', name: 'interface.md', hostId: 'local',
    }, NOW),
    existence: 'present',
    acceptance: 'pass',
    // Attributed, because an acceptance that says nothing about who decided may not gate an
    // automatic dispatch — the helper must not model a state the gate deliberately refuses.
    acceptedBy: 'user',
    acceptedAt: NOW,
    ...over,
  }
}

const completion = { kind: 'turn_ended' as const, turn: 1, outcome: 'completed' as const, detail: 'completed' }
const failure = { kind: 'turn_ended' as const, turn: 1, outcome: 'failed' as const, detail: 'boom' }

describe('trigger mapping (PRD §二.8.2)', () => {
  it('maps a completed turn and a failed turn to their triggers', () => {
    expect(triggerOf(completion, 'evt-1')?.trigger).toBe('turn_completed')
    expect(triggerOf(failure, 'evt-1')?.trigger).toBe('turn_failed')
  })

  it('ignores events that are not triggers', () => {
    expect(triggerOf({ kind: 'turn_started', turn: 1 }, 'evt-1')).toBeUndefined()
    expect(triggerOf({ kind: 'approval_asked', approvalId: 'a' }, 'evt-1')).toBeUndefined()
  })

  it('does not treat an intentional stop or budget block as authorisation to react to failure', () => {
    expect(triggerOf({ ...completion, outcome: 'interrupted' }, 'stopped')).toBeUndefined()
    expect(triggerOf({ ...completion, outcome: 'blocked' }, 'budget-limit')).toBeUndefined()
  })
})

describe('the guard on the dispatch identity', () => {
  it('derives one stable operation id from a rule and an event', () => {
    // The id is what makes a repeated event a replay rather than a second
    // dispatch, so it must be a function of the pair and nothing else.
    expect(fireOperationId('rule-1', 'evt-9')).toBe(fireOperationId('rule-1', 'evt-9'))
    expect(fireOperationId('rule-1', 'evt-9')).not.toBe(fireOperationId('rule-2', 'evt-9'))
    expect(fireOperationId('rule-1', 'evt-9')).not.toBe(fireOperationId('rule-1', 'evt-10'))
  })
})

describe('firing decisions (PRD §二.8.2, T21)', () => {
  it('fires once for a completed turn when it has never fired', () => {
    const decision = planFire(rule(), 'turn_completed', 'evt-1', undefined, NOW)
    expect(decision.fire).toBe(true)
    if (!decision.fire) return
    expect(decision.operationId).toBe(fireOperationId('rule-1', 'evt-1'))
  })

  it('never fires twice for the same event', () => {
    const fired = recordFiring(rule(), {
      rule: rule(), operationId: fireOperationId('rule-1', 'evt-1'), sourceEventId: 'evt-1', reason: 'first',
    }, 'accepted', NOW)

    const second = planFire(fired, 'turn_completed', 'evt-1', undefined, NOW)
    expect(second.fire).toBe(false)
    if (second.fire) return
    expect(second.reason).toMatch(/already fired for event evt-1/)
  })

  it('respects the maximum execution count', () => {
    const twoMax = rule({ maxExecutions: 2 })
    const once = recordFiring(twoMax, {
      rule: twoMax, operationId: 'op-1', sourceEventId: 'evt-1', reason: 'first',
    }, 'accepted', NOW)
    expect(planFire(once, 'turn_completed', 'evt-2', undefined, NOW).fire).toBe(true)

    const twice = recordFiring(once, {
      rule: once, operationId: 'op-2', sourceEventId: 'evt-2', reason: 'second',
    }, 'accepted', NOW)
    const third = planFire(twice, 'turn_completed', 'evt-3', undefined, NOW)
    expect(third.fire).toBe(false)
    if (third.fire) return
    expect(third.reason).toMatch(/maximum/)
  })

  it('refuses an inactive rule, an expired rule and a mismatched trigger', () => {
    expect(planFire(rule({ active: false }), 'turn_completed', 'e', undefined, NOW).fire).toBe(false)
    expect(planFire(rule({ expiresAt: '2026-01-01T00:00:00.000Z' }), 'turn_completed', 'e', undefined, NOW).fire).toBe(false)
    expect(planFire(rule(), 'turn_failed', 'e', undefined, NOW).fire).toBe(false)
  })

  it('compares rule expiry as an instant and refuses an unreadable expiry', () => {
    // This offset timestamp is one hour before NOW, although its text sorts later.
    expect(planFire(rule({ expiresAt: '2026-09-13T01:00:00+02:00' }), 'turn_completed', 'e', undefined, NOW).fire)
      .toBe(false)
    expect(planFire(rule({ expiresAt: 'not-an-instant' }), 'turn_completed', 'e', undefined, NOW).fire)
      .toBe(false)
  })

  it('requires the input artifact to be ACCEPTED, not merely present', () => {
    const gated = rule({ requiredArtifactId: 'artifact-1' })

    const present = planFire(gated, 'turn_completed', 'e', acceptedArtifact({ acceptance: 'pending' }), NOW)
    expect(present.fire).toBe(false)
    if (present.fire) return
    expect(present.reason).toMatch(/requires artifact artifact-1 to be accepted, and its acceptance is "pending"/)

    expect(planFire(gated, 'turn_completed', 'e', acceptedArtifact(), NOW).fire).toBe(true)
  })

  it('refuses an acceptance that does not say who accepted, or that only the model gave', () => {
    // PRD §二.9.1 keeps "检查通过" and "用户验收" apart from the model's own judgement, and §二.12
    // forbids a subjective review from standing in for acceptance. An automatic dispatch is exactly
    // what that rule protects, so the gate refuses both.
    const gated = rule({ requiredArtifactId: 'artifact-1' })

    const unattributed = planFire(gated, 'turn_completed', 'e', acceptedArtifact({ acceptedBy: undefined }), NOW)
    expect(unattributed.fire).toBe(false)
    if (unattributed.fire) return
    expect(unattributed.reason).toMatch(/no attribution, so nothing says who accepted it/)

    const reviewed = planFire(gated, 'turn_completed', 'e', acceptedArtifact({ acceptedBy: 'model_review' }), NOW)
    expect(reviewed.fire).toBe(false)
    if (reviewed.fire) return
    expect(reviewed.reason).toMatch(/reviewed by the model, which is a judgement and not acceptance/)

    // A deterministic check that recorded its command and result does count: it is objective
    // evidence rather than an opinion.
    expect(planFire(gated, 'turn_completed', 'e', acceptedArtifact({ acceptedBy: 'deterministic_check' }), NOW).fire)
      .toBe(true)
  })

  it('records the grant each firing ran under, not the rule\'s current one', () => {
    // PRD §四.2 requires a rule execution to be associated with its grant, rule and source event.
    // The grant is copied into the firing: a re-save would change the rule's grant, and reading it
    // back later would then attribute this dispatch to an authorisation that did not issue it.
    const granted = rule({ grantId: 'grant-1' })
    const dispatch = {
      rule: granted,
      operationId: 'rule-rule-1-evt-1',
      sourceEventId: 'evt-1',
      reason: 'it fires',
    }
    const fired = recordFiring(granted, dispatch, 'dispatched', NOW)
    expect(fired.firings[0]).toEqual({
      sourceEventId: 'evt-1',
      operationId: 'rule-rule-1-evt-1',
      at: NOW,
      outcome: 'dispatched',
      grantId: 'grant-1',
    })
    // And a rule with no grant identity records none, rather than inventing one.
    const ungranted = recordFiring(rule(), dispatch, 'dispatched', NOW)
    expect(ungranted.firings[0]?.grantId).toBeUndefined()
  })

  it('maps an artifact acceptance onto its own trigger', () => {
    // The trigger was declared in the schema and produced nowhere until the acceptance path existed,
    // so this pins the mapping that makes a rule able to listen for one.
    expect(triggerOf({ kind: 'artifact_accepted', artifactId: 'artifact-1', by: 'user' }, 'v0-at'))
      .toEqual({ trigger: 'artifact_accepted', eventId: 'artifact-artifact-1-v0-at' })
  })

  it('refuses when the required artifact is not recorded at all', () => {
    const decision = planFire(rule({ requiredArtifactId: 'missing' }), 'turn_completed', 'e', undefined, NOW)
    expect(decision.fire).toBe(false)
    if (decision.fire) return
    expect(decision.reason).toMatch(/which is not recorded/)
  })

  it('treats only an accepted artifact as satisfying the requirement', () => {
    expect(satisfiesRequirement(acceptedArtifact())).toBe(true)
    expect(satisfiesRequirement(acceptedArtifact({ acceptance: 'inconclusive' }))).toBe(false)
    expect(satisfiesRequirement(acceptedArtifact({ acceptance: 'fail' }))).toBe(false)
    expect(satisfiesRequirement(acceptedArtifact({ acceptedBy: 'model_review' }))).toBe(false)
  })
})

describe('the control relation must be acyclic (PRD §三.6, AGENTS.md §6)', () => {
  const edge = (ruleId: string, from: string, to: string) => ({ ruleId, sourceTaskId: from, targetTaskId: to })

  it('accepts an edge that closes nothing', () => {
    expect(controlCycleRefusal([], edge('r1', 'a', 'b'))).toBeUndefined()
    // A chain a → b → c is not a cycle: c has no way back.
    expect(controlCycleRefusal([edge('r1', 'a', 'b')], edge('r2', 'b', 'c'))).toBeUndefined()
    // Two rules out of one source are a fan, not a loop.
    expect(controlCycleRefusal([edge('r1', 'a', 'b')], edge('r2', 'a', 'c'))).toBeUndefined()
  })

  it('refuses the two-rule loop that would make two controllers wake each other', () => {
    const refusal = controlCycleRefusal([edge('r1', 'a', 'b')], edge('r2', 'b', 'a'))
    expect(refusal).toMatch(/would close a control cycle/)
    expect(refusal).toMatch(/wake each other/)
    // It names the tasks a reader has to go and look at, not just the rule that was refused.
    expect(refusal).toMatch(/a/)
    expect(refusal).toMatch(/b/)
  })

  it('refuses a longer loop, and one that runs back through several rules', () => {
    expect(controlCycleRefusal(
      [edge('r1', 'a', 'b'), edge('r2', 'b', 'c')],
      edge('r3', 'c', 'a'),
    )).toMatch(/would close a control cycle/)
    // A diamond is fine; only the path that returns to the source is refused.
    expect(controlCycleRefusal(
      [edge('r1', 'a', 'b'), edge('r2', 'a', 'c'), edge('r3', 'b', 'd')],
      edge('r4', 'c', 'd'),
    )).toBeUndefined()
  })

  it('refuses a rule that instructs its own source, which is a one-node loop', () => {
    const refusal = controlCycleRefusal([], edge('r1', 'a', 'a'))
    expect(refusal).toMatch(/instruct a from its own events/)
    expect(refusal).toMatch(/refused rather than saved/)
  })

  it('does not let a stored loop make the check hang', () => {
    // The guard may be asked to judge an edge while a loop already exists in the store — a rule saved before
    // this check existed, or by an older build. It must answer rather than walk forever.
    const stored = [edge('r1', 'a', 'b'), edge('r2', 'b', 'a')]
    expect(controlCycleRefusal(stored, edge('r3', 'x', 'y'))).toBeUndefined()
    expect(controlCycleRefusal(stored, edge('r3', 'y', 'x'))).toBeUndefined()
  })

  it('ignores the candidate’s own stored edge, so re-judging one rule is stable', () => {
    // The save path filters to active rules and then adds the candidate; a rule already in that list under the
    // same id must not count as its own predecessor.
    expect(controlCycleRefusal([edge('r1', 'a', 'b')], edge('r1', 'a', 'b'))).toBeUndefined()
  })
})

describe('enabling a saved rule (PRD §三.3 启用)', () => {
  const edge = (ruleId: string, from: string, to: string) => ({ ruleId, sourceTaskId: from, targetTaskId: to })
  it('resumes a disabled rule under the same grant and does not reset firings', () => {
    const saved = rule({
      active: false,
      grantId: 'grant-1',
      firings: [{
        sourceEventId: 'evt-1',
        operationId: 'rule-rule-1-evt-1',
        at: NOW,
        outcome: 'dispatched',
        grantId: 'grant-1',
      }],
      maxExecutions: 2,
    })
    const decision = planEnable(saved, [])
    expect(decision.enable).toBe(true)
    if (!decision.enable) return
    expect(decision.already).toBe(false)
    expect(decision.reason).toMatch(/same grant/)
    expect(decision.reason).toMatch(/1\/2/)
  })

  it('reports an already-enabled rule rather than rewriting it', () => {
    const decision = planEnable(rule({ active: true, grantId: 'grant-1' }), [])
    expect(decision.enable).toBe(true)
    if (!decision.enable) return
    expect(decision.already).toBe(true)
    expect(decision.reason).toMatch(/already enabled/)
  })

  it('refuses to enable when that would close a control cycle', () => {
    const saved = rule({
      ruleId: 'r2',
      active: false,
      sourceTaskId: 'b',
      targetTaskId: 'a',
    })
    const decision = planEnable(saved, [edge('r1', 'a', 'b')])
    expect(decision.enable).toBe(false)
    if (decision.enable) return
    expect(decision.reason).toMatch(/would close a control cycle/)
  })
})

describe('a whole evaluation pass (T21, repeated events)', () => {
  it('produces one dispatch for a repeated event within a single batch', () => {
    // Two observations of the same completion, as an overlapping watcher or a
    // replayed window would produce.
    const result = evaluateRules([rule({ maxExecutions: 5 })], {
      events: [
        { event: completion, eventId: 'evt-1' },
        { event: completion, eventId: 'evt-1' },
      ],
      artifact: () => undefined,
      now: NOW,
    })
    expect(result.dispatches).toHaveLength(1)
  })

  it('does not let two events in one batch exceed the rule maximum', () => {
    const result = evaluateRules([rule({ maxExecutions: 1 })], {
      events: [
        { event: completion, eventId: 'evt-1' },
        { event: completion, eventId: 'evt-2' },
      ],
      artifact: () => undefined,
      now: NOW,
    })
    // The firing recorded in the working copy during the pass is what stops the
    // second event from also firing.
    expect(result.dispatches).toHaveLength(1)
  })

  it('keeps two different rules independent', () => {
    const result = evaluateRules([
      rule({ ruleId: 'rule-a' }),
      rule({ ruleId: 'rule-b', targetTaskId: 'task-other' }),
    ], {
      events: [{ event: completion, eventId: 'evt-1' }],
      artifact: () => undefined,
      now: NOW,
    })
    expect(result.dispatches.map(d => d.rule.ruleId).sort()).toEqual(['rule-a', 'rule-b'])
  })

  it('reports a refusal worth seeing, so a quiet rule is not mistaken for an absent one', () => {
    const result = evaluateRules([rule({ requiredArtifactId: 'artifact-1' })], {
      events: [{ event: completion, eventId: 'evt-1' }],
      artifact: () => acceptedArtifact({ acceptance: 'pending' }),
      now: NOW,
    })
    expect(result.dispatches).toHaveLength(0)
    expect(result.refusals[0]?.reason).toMatch(/to be accepted/)
  })

  it('ignores a rule that simply listens for something else', () => {
    const result = evaluateRules([rule()], {
      events: [{ event: failure, eventId: 'evt-1' }],
      artifact: () => undefined,
      now: NOW,
    })
    expect(result.dispatches).toHaveLength(0)
    expect(result.refusals).toHaveLength(0)
  })
})
