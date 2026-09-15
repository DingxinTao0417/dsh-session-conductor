import { describe, expect, it } from 'vitest'
import {
  DELIVERY_STAGES,
  advanceDelivery,
  constraintCompatibility,
  describeDelivery,
  planConstraintChange,
  planConstraintImpact,
  type ConstraintDelivery,
  type ConstraintRecord,
} from '../src/service/constraints.ts'

const AT = '2026-09-13T00:00:00.000Z'
const LATER = '2026-09-14T00:00:00.000Z'

/** A constraint. */
function constraint(over: Partial<ConstraintRecord> = {}): ConstraintRecord {
  return {
    constraintId: 'constraint-1',
    kind: 'interface',
    text: 'all timestamps cross the wire as ISO 8601 UTC',
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  }
}

/** A delivery. */
function delivery(over: Partial<ConstraintDelivery> = {}): ConstraintDelivery {
  return {
    constraintId: 'constraint-1',
    version: 2,
    targetId: 'task-a',
    stage: 'sent',
    updatedAt: AT,
    ...over,
  }
}

describe('versioning a constraint (PRD §二.13.1)', () => {
  it('creates the first version at zero', () => {
    const result = planConstraintChange(undefined, { kind: 'prohibition', text: 'never force-push' }, AT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.version).toBe(0)
    expect(result.record.kind).toBe('prohibition')
  })

  it('produces a new version on every change', () => {
    const result = planConstraintChange(constraint(), { kind: 'interface', text: 'use RFC 3339 instead' }, LATER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.version).toBe(2)
    expect(result.record.text).toBe('use RFC 3339 instead')
    expect(result.record.updatedAt).toBe(LATER)
    // The identity and creation time are kept: a version is the same constraint, newer.
    expect(result.record.constraintId).toBe('constraint-1')
    expect(result.record.createdAt).toBe(AT)
  })

  it('refuses an unchanged statement instead of versioning it', () => {
    // Bumping a version for identical text would invalidate runs in flight for nothing.
    const result = planConstraintChange(constraint(), { kind: 'interface', text: constraint().text }, LATER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/already says exactly this/)
  })

  it('treats a kind change as a change even when the text is the same', () => {
    const result = planConstraintChange(constraint(), { kind: 'prohibition', text: constraint().text }, LATER)
    expect(result.ok && result.record.version).toBe(2)
  })

  it('refuses an empty statement', () => {
    const result = planConstraintChange(undefined, { kind: 'interface', text: '   ' }, AT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/must state something/)
  })
})

describe('scoping a change and computing its impact (PRD §二.13.1)', () => {
  const work = {
    affectedNodes: ['build', 'verify'],
    invalidatedArtifacts: [
      { artifactId: 'artifact-accepted', reason: 'it was built to the old interface', accepted: true },
      { artifactId: 'artifact-pending', reason: 'it was built to the old interface', accepted: false },
    ],
  }

  it('affects only future runs by default, and says so', () => {
    // "默认只影响未来运行": applying to current work is something the user asks for.
    const impact = planConstraintImpact({ constraintId: 'constraint-1', fromVersion: 1, toVersion: 2, scope: 'future', ...work })
    expect(impact.affectedNodes).toEqual([])
    expect(impact.affectedArtifacts).toEqual([])
    expect(impact.caveat).toMatch(/future runs only/)
    expect(impact.caveat).toMatch(/nothing in progress was altered/)
  })

  it('computes the affected nodes and artifacts when the scope is current', () => {
    const impact = planConstraintImpact({ constraintId: 'constraint-1', fromVersion: 1, toVersion: 2, scope: 'current', ...work })
    expect(impact.affectedNodes).toEqual(['build', 'verify'])
    expect(impact.affectedArtifacts.map(artifact => artifact.artifactId)).toEqual(['artifact-accepted', 'artifact-pending'])
  })

  it('marks only artifacts whose acceptance the change contradicts', () => {
    // An artifact that was never accepted is already correct; the flag means "must be
    // re-judged", not "is unaccepted".
    const impact = planConstraintImpact({ constraintId: 'c', fromVersion: 1, toVersion: 2, scope: 'current', ...work })
    expect(impact.affectedArtifacts.find(a => a.artifactId === 'artifact-accepted')?.needsReacceptance).toBe(true)
    expect(impact.affectedArtifacts.find(a => a.artifactId === 'artifact-pending')?.needsReacceptance).toBe(false)
  })

  it('does not claim to have changed an in-flight request', () => {
    const impact = planConstraintImpact({ constraintId: 'c', fromVersion: 1, toVersion: 2, scope: 'current' })
    expect(impact.caveat).toMatch(/next processable boundary/)
    expect(impact.caveat).toMatch(/does not alter a request that has already been committed/)
    expect(impact.caveat).toMatch(/no in-flight turn is claimed to have changed/)
  })
})

describe('constraint compatibility before an automatic downstream start (PRD §二.13.1)', () => {
  it('allows a start when the versions agree', () => {
    const check = constraintCompatibility(3, 3)
    expect(check.compatible).toBe(true)
  })

  it('refuses a start when the constraints have moved on', () => {
    // A node built to a superseded interface is exactly what the constraint prevented.
    const check = constraintCompatibility(2, 3)
    expect(check.compatible).toBe(false)
    expect(check.reason).toMatch(/will not start automatically on the older terms/)
    expect(check.reason).toMatch(/needs the user to decide/)
  })

  it('refuses a run whose recorded version is newer than what is in force', () => {
    const check = constraintCompatibility(4, 3)
    expect(check.compatible).toBe(false)
    expect(check.reason).toMatch(/no longer in force/)
  })
})

describe('delivery facts are four, not one (PRD §二.13.1)', () => {
  it('lists the stages in order', () => {
    expect([...DELIVERY_STAGES]).toEqual(['sent', 'in_context', 'acknowledged', 'verified'])
  })

  it('advances one stage at a time', () => {
    const first = advanceDelivery(delivery(), 'in_context', undefined, LATER)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.delivery.stage).toBe('in_context')

    const second = advanceDelivery(first.delivery, 'acknowledged', undefined, LATER)
    expect(second.ok && second.delivery.stage).toBe('acknowledged')
  })

  it('refuses to skip a stage', () => {
    // Going straight from `sent` to `verified` would assert a check that never happened.
    const skipped = advanceDelivery(delivery({ stage: 'sent' }), 'verified', { command: 'x', output: 'y' }, LATER)
    expect(skipped.ok).toBe(false)
    if (skipped.ok) return
    expect(skipped.reason).toMatch(/cannot jump to verified/)
  })

  it('refuses to go backwards', () => {
    const back = advanceDelivery(delivery({ stage: 'acknowledged' }), 'sent', undefined, LATER)
    expect(back.ok).toBe(false)
    if (back.ok) return
    expect(back.reason).toMatch(/do not go backwards/)
  })

  it('refuses to re-record the stage it is already at', () => {
    expect(advanceDelivery(delivery({ stage: 'sent' }), 'sent', undefined, LATER).ok).toBe(false)
  })

  it('will not verify compliance without the check that established it', () => {
    const unverified = advanceDelivery(delivery({ stage: 'acknowledged' }), 'verified', undefined, LATER)
    expect(unverified.ok).toBe(false)
    if (unverified.ok) return
    expect(unverified.reason).toMatch(/would record an opinion as a verification/)
  })

  it('records the command and output when compliance is verified', () => {
    const verified = advanceDelivery(
      delivery({ stage: 'acknowledged' }), 'verified', { command: 'pnpm test', output: 'all passed' }, LATER,
    )
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.delivery.checkCommand).toBe('pnpm test')
    expect(verified.delivery.checkOutput).toBe('all passed')
  })

  it('describes acknowledgement as acknowledgement, not as compliance', () => {
    // The whole point of the four stages is that this sentence is not "it complies".
    expect(describeDelivery(delivery({ stage: 'acknowledged' }))).toMatch(/Acknowledgement is not compliance/)
    expect(describeDelivery(delivery({ stage: 'sent' }))).toMatch(/has not yet entered its context/)
    expect(describeDelivery(delivery({ stage: 'in_context' }))).toMatch(/whether it will be followed is not yet known/)
    expect(describeDelivery(delivery({ stage: 'verified' }))).toMatch(/verified compliant/)
  })
})
