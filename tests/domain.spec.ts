import { describe, expect, it } from 'vitest'
import {
  calibrateOperation,
  canonicalize,
  classifyOperation,
  paramDigest,
  recoveryAction,
  type OperationRecord,
} from '../src/domain/operation.ts'
import { DEFAULTS, DEFAULT_CONTEXT_MODE, truncateMarked } from '../src/domain/defaults.ts'
import { countManagedTargets, managedTargetLimitReason } from '../src/domain/limits.ts'
import { canTransition } from '../src/domain/state.ts'

/** Build a persisted record with the fields a test cares about. */
function record(over: Partial<OperationRecord> = {}): OperationRecord {
  return {
    operationId: 'op-1',
    kind: 'send',
    paramDigest: paramDigest('send', { text: 'hello' }),
    delivery: 'prepared',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    withdrawn: false,
    ...over,
  }
}

describe('parameter identity (PRD §四.1)', () => {
  it('digests two spellings of the same parameters identically', () => {
    const left = paramDigest('send', { taskId: 't1', text: 'go', mode: 'steer' })
    const right = paramDigest('send', { mode: 'steer', text: 'go', taskId: 't1' })
    expect(left).toBe(right)
  })

  it('treats different text as different parameters, so two sends are two operations', () => {
    expect(paramDigest('send', { text: 'go' })).not.toBe(paramDigest('send', { text: 'go ' }))
  })

  it('folds the operation family into the digest', () => {
    expect(paramDigest('send', { text: 'go' })).not.toBe(paramDigest('queue_edit', { text: 'go' }))
  })

  it('orders nested object keys and preserves array order', () => {
    expect(canonicalize({ b: 1, a: { d: [2, 1], c: 3 } })).toBe('{"a":{"c":3,"d":[2,1]},"b":1}')
  })

  it('drops undefined members but refuses values JSON cannot carry', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(() => canonicalize({ a: Number.NaN })).toThrow(/finite number/)
    expect(() => canonicalize({ a: new Date() })).not.toThrow()
  })
})

describe('operation matching (PRD §四.1)', () => {
  it('treats an unseen id as a new operation', () => {
    expect(classifyOperation(undefined, 'send', paramDigest('send', { text: 'hi' }))).toEqual({ kind: 'new' })
  })

  it('replays the same id with the same parameters', () => {
    const existing = record()
    expect(classifyOperation(existing, 'send', existing.paramDigest)).toEqual({ kind: 'replay', record: existing })
  })

  it('reports a conflict for the same id with different parameters', () => {
    const existing = record()
    const match = classifyOperation(existing, 'send', paramDigest('send', { text: 'different' }))
    expect(match.kind).toBe('conflict')
  })

  it('says when a digest mismatch cannot be told apart from a changed digest scheme', () => {
    // Two situations produce the same mismatch, and the refusal used to describe both as "different
    // parameters" — which is false for the second one. Measured: the create digest gained a `workspace`
    // member in a later revision, and an operation claimed before that change now mismatches an identical
    // request (see the round-52 note in docs/compatibility.md). The record's own parameters are the only
    // evidence that separates them, so a record without them must say so.
    const noParams = classifyOperation(record(), 'send', paramDigest('send', { text: 'other' }))
    expect(noParams.kind).toBe('conflict')
    if (noParams.kind !== 'conflict') throw new Error('unreachable')
    expect(noParams.reason).toMatch(/kept none of them, so this retry cannot be confirmed as the same request/)
    expect(noParams.reason).toMatch(/digest covers/)

    const withParams = classifyOperation(
      record({ params: { text: 'hello' } }),
      'send',
      paramDigest('send', { text: 'other' }),
    )
    if (withParams.kind !== 'conflict') throw new Error('unreachable')
    // When the original parameters *are* known, the plain statement is the accurate one and is kept.
    expect(withParams.reason).toBe('operationId op-1 was used with different parameters')
  })

  it('reports a conflict when an id is reused across operation families', () => {
    const existing = record()
    expect(classifyOperation(existing, 'interrupt', existing.paramDigest).kind).toBe('conflict')
  })

  it('never replays a withdrawn operation, so a restart cannot resurrect it', () => {
    const withdrawn = record({ withdrawn: true, delivery: 'withdrawn' })
    const match = classifyOperation(withdrawn, 'send', withdrawn.paramDigest)
    expect(match.kind).toBe('conflict')
    expect(match.kind === 'conflict' ? match.reason : '').toMatch(/withdrawn/)
  })
})

describe('recovery classification (PRD §四.1)', () => {
  it('continues an operation that never entered dispatch', () => {
    expect(recoveryAction(record({ delivery: 'prepared' }))).toBe('continue')
  })

  it('does nothing for a withdrawn operation that never dispatched', () => {
    expect(recoveryAction(record({ delivery: 'prepared', withdrawn: true }))).toBe('done')
  })

  it('reconciles an operation whose dispatch result is unconfirmed', () => {
    expect(recoveryAction(record({ delivery: 'dispatching' }))).toBe('reconcile')
    expect(recoveryAction(record({ delivery: 'unknown' }))).toBe('reconcile')
  })

  it('leaves settled operations alone', () => {
    expect(recoveryAction(record({ delivery: 'accepted' }))).toBe('done')
    expect(recoveryAction(record({ delivery: 'consumed' }))).toBe('done')
    expect(recoveryAction(record({ delivery: 'withdrawn' }))).toBe('done')
  })
})

describe('restart calibration of operations (PRD §四.5, §四.1)', () => {
  it('moves a mid-dispatch operation to unknown, and never resends it', () => {
    // §四.1: an operation that entered dispatch without a confirmable result stays unknown. The restart
    // cannot know whether the Host received it, and guessing either way is worse than saying so.
    const outcome = calibrateOperation({ kind: 'send', delivery: 'dispatching' })
    expect(outcome.action).toBe('mark_unknown')
    expect(outcome.reason).toMatch(/mid-dispatch when the process stopped/)
    expect(outcome.reason).toMatch(/NOT resent/)
    // And the move is legal in the delivery model — the calibration asks the same table every other writer
    // does rather than writing a state it decided on its own.
    expect(canTransition('delivery', 'dispatching', 'unknown')).toBe(true)
  })

  it('leaves an already-unknown operation alone and says so', () => {
    const outcome = calibrateOperation({ kind: 'transfer', delivery: 'unknown' })
    expect(outcome.action).toBe('report')
    expect(outcome.reason).toMatch(/already unknown/)
    expect(outcome.reason).toMatch(/Nothing is sent again/)
  })

  it('reports a claimed-but-undispatched request without finishing it', () => {
    // A `prepared` operation was claimed and nothing was carried out. Finishing it automatically would mean a
    // restart creating sessions or worktrees, which is the controller's decision, not the boot's.
    const send = calibrateOperation({ kind: 'send', delivery: 'prepared' })
    expect(send.action).toBe('report')
    expect(send.reason).toMatch(/claimed and never dispatched/)
    expect(send.reason).toMatch(/replay rather than a second action/)

    const create = calibrateOperation({ kind: 'create', delivery: 'prepared' })
    expect(create.action).toBe('report')
    expect(create.reason).toMatch(/conductor_operation resume/)
    expect(create.reason).toMatch(/nothing is resumed\s+automatically/)
  })

  it('makes a state change for exactly one of the cases it is asked about', () => {
    // The restraint is the property worth pinning: every other input is reported, not written.
    const states = ['prepared', 'dispatching', 'unknown', 'accepted', 'consumed', 'withdrawn', 'failed']
    const changing = states.filter(state => calibrateOperation({ kind: 'send', delivery: state }).action === 'mark_unknown')
    expect(changing).toEqual(['dispatching'])
    // And an operation that never left `prepared` is never moved to `unknown`: that would claim a dispatch
    // that provably did not happen.
    expect(canTransition('delivery', 'prepared', 'unknown')).toBe(false)
  })
})

describe('defaults (PRD §四.7)', () => {
  it('matches the published default table', () => {
    expect(DEFAULTS).toEqual({
      managedTargetLimit: 20,
      targetTurnConcurrency: 4,
      noticeConcurrency: 1,
      panelRefreshMergeMs: 250,
      noticeMergeWindowMs: 2000,
      defaultReadLimit: 20,
      toolTextLimit: 12000,
      waitLimitMs: 60000,
      interruptConfirmLimitMs: 30000,
      reworkRounds: 2,
      resendUnknownDelivery: false,
      autoDeleteResources: false,
      crossHostEnabled: false,
      shareEnabled: false,
      shareLifetimeDays: 7,
    })
  })

  it('pins the published new-task context mode so no call site invents a fallback', () => {
    expect(DEFAULT_CONTEXT_MODE).toBe('brief')
  })

  it('counts current ownership and ignores released management', () => {
    expect(countManagedTargets([
      { taskId: 'a', ownerSessionId: 'controller' },
      { taskId: 'b', ownerSessionId: 'controller', detachedAt: 'now' },
      { taskId: 'c', ownerSessionId: 'other' },
    ], 'controller')).toBe(1)
    expect(managedTargetLimitReason(19, 20, 'controller')).toBeUndefined()
    expect(managedTargetLimitReason(20, 20, 'controller')).toMatch(/limit of 20/)
    expect(managedTargetLimitReason(20, 20, 'controller')).toMatch(/controller/)
  })
})

describe('truncation marker (PRD §二.7)', () => {
  it('returns short text unchanged', () => {
    expect(truncateMarked('short', { textLimit: 100 }, 'read more')).toBe('short')
  })

  it('marks a truncated result and names the continuation, staying inside the budget', () => {
    const out = truncateMarked('x'.repeat(500), { textLimit: 100 }, 'conductor_read')
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out).toContain('truncated')
    expect(out).toContain('conductor_read')
    expect(out).toContain('500')
  })
})
