import { describe, expect, it } from 'vitest'
import {
  addObserver,
  applyTransfer,
  mayRead,
  monitoringAllowed,
  observationContinues,
  planTransfer,
  removeObserver,
  snapshotDeliveryPlan,
  writeControlRefusal,
  mutationPinRefusal,
} from '../src/service/access.ts'
import type { OperationRecord } from '../src/domain/operation.ts'
import type { AccessRecord } from '../src/store/schema.ts'
import { accessTool, type AccessToolRequest, type ConductorToolContext } from '../src/tools.ts'

/** An access record with the members a test cares about overridden. */
function access(over: Partial<AccessRecord> = {}): AccessRecord {
  return {
    taskId: 'task-1',
    ownerSessionId: 'controller-a',
    ownerEpoch: 3,
    observerSessionIds: [],
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  }
}

/** A persisted operation. */
function operation(over: Partial<OperationRecord> = {}): OperationRecord {
  return {
    operationId: 'op-1',
    kind: 'send',
    paramDigest: 'digest',
    delivery: 'prepared',
    withdrawn: false,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  }
}

/** Plan a transfer with the given operations. */
function plan(operations: OperationRecord[], over: Partial<AccessRecord> = {}) {
  return planTransfer({
    access: access(over),
    operations,
    to: 'controller-b',
    describeTask: () => 'task task-1 is ready/ready with 2 artifact(s)',
  })
}

describe('planning a control transfer (PRD §二.10.1)', () => {
  it('increments the epoch and names both sides', () => {
    const result = plan([])
    expect(result.nextEpoch).toBe(4)
    expect(result.from).toBe('controller-a')
    expect(result.to).toBe('controller-b')
  })

  it('refuses a transfer to the session that already holds control', () => {
    // Not a no-op refresh: it would still bump the epoch and invalidate the
    // controller's own in-flight requests, which is a surprising way to change
    // nothing.
    expect(() => planTransfer({
      access: access(), operations: [], to: 'controller-a', describeTask: () => '',
    })).toThrow(/already holds write control/)
  })

  it('refuses a transfer to no session at all', () => {
    expect(() => planTransfer({
      access: access(), operations: [], to: '', describeTask: () => '',
    })).toThrow(/must be a named session/)
  })

  it('carries an undispatched operation over under its original id', () => {
    const result = plan([operation({ operationId: 'op-unsent', delivery: 'prepared' })])
    expect(result.operations).toEqual([{
      operationId: 'op-unsent',
      kind: 'send',
      delivery: 'prepared',
      action: 'continue',
      reason: 'it never entered dispatch, so the new controller may proceed with the same operation id',
    }])
  })

  it('keeps an uncertain operation uncertain rather than inventing a delivery', () => {
    const result = plan([
      operation({ operationId: 'op-unknown', delivery: 'unknown' }),
      operation({ operationId: 'op-dispatching', delivery: 'dispatching' }),
    ])
    expect(result.uncertain).toEqual(['op-unknown', 'op-dispatching'])
    for (const entry of result.operations) {
      expect(entry.action).toBe('reconcile')
      expect(entry.reason).toMatch(/never be resent/)
    }
    expect(result.snapshot).toContain('UNCERTAIN, do not resend: op-unknown, op-dispatching')
  })

  it('reports a settled operation as settled rather than as work to take over', () => {
    const result = plan([operation({ operationId: 'op-done', delivery: 'accepted' })])
    expect(result.operations[0]?.action).toBe('done')
    expect(result.uncertain).toEqual([])
  })

  it('does not take over a withdrawn operation', () => {
    const result = plan([operation({ operationId: 'op-withdrawn', delivery: 'prepared', withdrawn: true })])
    expect(result.operations[0]?.action).toBe('done')
    expect(result.operations[0]?.reason).toMatch(/withdrawn/)
  })

  it('says so plainly when nothing is in flight, and distinguishes that from never having recorded one', () => {
    expect(plan([]).snapshot).toContain('In-flight operations: none.')
  })

  it('promises that authorisations and budgets are not reset, and counts what carried over', () => {
    const result = plan([
      operation({ operationId: 'op-1', delivery: 'prepared' }),
      operation({ operationId: 'op-2', delivery: 'prepared' }),
      operation({ operationId: 'op-3', delivery: 'accepted' }),
    ])
    expect(result.snapshot).toContain('2 operation(s) carry over under their original ids')
    expect(result.snapshot).toContain('no rule, grant, schedule or counter was reset')
  })

  it('states that historical reports are not replayed to the new controller', () => {
    expect(plan([]).snapshot).toContain('Reports already delivered to the previous controller are not replayed here')
  })

  it('carries the task description and the observers into the snapshot', () => {
    const result = plan([], { observerSessionIds: ['watcher-1', 'watcher-2'] })
    expect(result.snapshot).toContain('task task-1 is ready/ready with 2 artifact(s)')
    expect(result.snapshot).toContain('Read-only observers: watcher-1, watcher-2.')
    expect(plan([]).snapshot).toContain('Read-only observers: none.')
  })
})

describe('applying a transfer (PRD §二.10.1)', () => {
  it('changes the owner and the epoch in one record, so the freeze is instantaneous', () => {
    // Two writes would leave a window in which the new owner holds control at the
    // old epoch, and the old controller's requests would still pass.
    const before = access()
    const applied = applyTransfer(before, plan([]), '2026-09-13T01:00:00.000Z')
    expect(applied.ownerSessionId).toBe('controller-b')
    expect(applied.ownerEpoch).toBe(4)
    expect(applied.updatedAt).toBe('2026-09-13T01:00:00.000Z')
    // The original record is untouched: this is a pure transform.
    expect(before.ownerSessionId).toBe('controller-a')
    expect(before.ownerEpoch).toBe(3)
  })

  it('keeps the observers, because a read grant to a third party is not the outgoing controller’s to lose', () => {
    const applied = applyTransfer(
      access({ observerSessionIds: ['watcher-1'] }),
      plan([], { observerSessionIds: ['watcher-1'] }),
      '2026-09-13T01:00:00.000Z',
    )
    expect(applied.observerSessionIds).toEqual(['watcher-1'])
  })
})

describe('observers (PRD §一.3, §三.3 `access`)', () => {
  it('adds an observer and reports that something changed', () => {
    const result = addObserver(access(), 'watcher-1', 'now')
    expect(result.changed).toBe(true)
    expect(result.access.observerSessionIds).toEqual(['watcher-1'])
    expect(result.access.updatedAt).toBe('now')
  })

  it('treats adding the same observer twice as the same permission, not a conflict', () => {
    const once = addObserver(access(), 'watcher-1', 'now')
    const twice = addObserver(once.access, 'watcher-1', 'later')
    expect(twice.changed).toBe(false)
    expect(twice.access.observerSessionIds).toEqual(['watcher-1'])
  })

  it('never lists the controller as an observer, because it has strictly more than that', () => {
    const result = addObserver(access(), 'controller-a', 'now')
    expect(result.changed).toBe(false)
    expect(result.access.observerSessionIds).toEqual([])
  })

  it('revokes an observer and treats revoking an absent one as already done', () => {
    const withObserver = addObserver(access(), 'watcher-1', 'now').access
    const revoked = removeObserver(withObserver, 'watcher-1', 'later')
    expect(revoked.changed).toBe(true)
    expect(revoked.access.observerSessionIds).toEqual([])
    expect(removeObserver(revoked.access, 'watcher-1', 'later').changed).toBe(false)
  })

  it('lets the controller and observers read, and nobody else', () => {
    const record = access({ observerSessionIds: ['watcher-1'] })
    expect(mayRead(record, 'controller-a')).toBe(true)
    expect(mayRead(record, 'watcher-1')).toBe(true)
    expect(mayRead(record, 'stranger')).toBe(false)
  })
})

describe('releasing a task stops its monitoring (PRD §二.5)', () => {
  it('allows monitoring while the task is managed', () => {
    expect(monitoringAllowed(access()).allowed).toBe(true)
  })

  it('stops monitoring once management is released, and says when', () => {
    // The record was marked and nothing asked whether monitoring should continue, so a released
    // task's watch kept reporting while the doc comment claimed it had stopped.
    const released = monitoringAllowed(access({ detachedAt: '2026-09-13T01:00:00.000Z' }))
    expect(released.allowed).toBe(false)
    expect(released.reason).toMatch(/management of task .* was released at 2026-09-13T01:00:00.000Z/)
    expect(released.reason).toMatch(/Anything already accepted is untouched/)
  })

  it('refuses to monitor a task with no control record at all', () => {
    // No relationship is not the same as a live one: there is nothing to monitor.
    expect(monitoringAllowed(undefined).allowed).toBe(false)
    expect(monitoringAllowed(undefined).reason).toMatch(/no control record/)
  })

  it('keeps monitoring an archived task (PRD §二.5 / T15)', () => {
    // Archive is organisation. Treating it like release would silence the notices
    // the specification says still enter the notice centre.
    const continued = observationContinues(access(), true)
    expect(continued.allowed).toBe(true)
    expect(continued.reason).toMatch(/organisation only/)
    expect(continued.reason).toMatch(/notice centre/)
    expect(observationContinues(access(), false).allowed).toBe(true)
    expect(observationContinues(access({ detachedAt: '2026-09-13T01:00:00.000Z' }), true).allowed).toBe(false)
  })
})

describe('write-control freeze (PRD §二.10.1)', () => {
  it('refuses a session that is not the owner', () => {
    const refusal = writeControlRefusal(access(), 'task-1', 'controller-b')
    expect(refusal?.code).toBe('NOT_CONTROLLER')
    expect(refusal?.reason).toMatch(/controller-b does not hold write control of task task-1/)
  })

  it('refuses a write after management was released', () => {
    const refusal = writeControlRefusal(
      access({ detachedAt: '2026-09-13T01:00:00.000Z' }),
      'task-1',
      'controller-a',
    )
    expect(refusal?.code).toBe('NOT_MANAGED')
    expect(refusal?.reason).toMatch(/released from management at 2026-09-13T01:00:00.000Z/)
  })

  it('refuses a write when there is no control record', () => {
    const refusal = writeControlRefusal(undefined, 'task-1', 'controller-a')
    expect(refusal?.code).toBe('NOT_CONTROLLER')
  })

  it('lets the live owner through', () => {
    expect(writeControlRefusal(access(), 'task-1', 'controller-a')).toBeUndefined()
  })
})

describe('mutation pins (PRD §三.2)', () => {
  it('omits a refusal when the caller named no pin', () => {
    expect(mutationPinRefusal(access(), { version: 1 }, {}, 'task-1')).toBeUndefined()
  })

  it('lets matching epoch and binding pins through', () => {
    expect(mutationPinRefusal(
      access({ ownerEpoch: 3 }),
      { version: 2 },
      { expectedOwnerEpoch: 3, expectedBindingVersion: 2 },
      'task-1',
    )).toBeUndefined()
  })

  it('refuses a write that names a retired control epoch', () => {
    const refusal = mutationPinRefusal(
      access({ ownerEpoch: 4 }),
      { version: 1 },
      { expectedOwnerEpoch: 3 },
      'task-1',
    )
    expect(refusal?.code).toBe('STALE_OWNER_EPOCH')
    expect(refusal?.reason).toMatch(/epoch 4, not 3/)
  })

  it('refuses a write that names a retired binding version', () => {
    const refusal = mutationPinRefusal(
      access(),
      { version: 2 },
      { expectedBindingVersion: 1 },
      'task-1',
    )
    expect(refusal?.code).toBe('STALE_BINDING')
    expect(refusal?.reason).toMatch(/version 2, not 1/)
  })

  it('refuses a binding pin when the task has no binding', () => {
    const refusal = mutationPinRefusal(
      access(),
      undefined,
      { expectedBindingVersion: 1 },
      'task-1',
    )
    expect(refusal?.code).toBe('NO_BINDING')
  })
})

describe('handover snapshot delivery (PRD §二.10.1)', () => {
  it('wakes an idle live session', () => {
    expect(snapshotDeliveryPlan({ status: 'idle', steer: () => {}, followup: () => {} }, 'session-b'))
      .toEqual({ kind: 'wake' })
  })

  it('queues for a busy live session rather than interrupting it', () => {
    expect(snapshotDeliveryPlan({ status: 'running', steer: () => {}, followup: () => {} }, 'session-b'))
      .toEqual({ kind: 'queue' })
  })

  it('names a missing session instead of inventing a delivery', () => {
    const plan = snapshotDeliveryPlan(undefined, 'session-b')
    expect(plan.kind).toBe('not_live')
    if (plan.kind === 'not_live') expect(plan.reason).toMatch(/session-b is not live/)
  })

  it('names a missing channel instead of falling back to the other verb', () => {
    const idle = snapshotDeliveryPlan({ status: 'idle' }, 'session-b')
    expect(idle.kind).toBe('no_channel')
    const busy = snapshotDeliveryPlan({ status: 'running' }, 'session-b')
    expect(busy.kind).toBe('no_channel')
  })
})

describe('conductor_access pins (PRD §三.2)', () => {
  it('forwards expectedOwnerEpoch and expectedBindingVersion on a transfer', async () => {
    const seen: AccessToolRequest[] = []
    const tool = accessTool({
      access: async (request: AccessToolRequest) => {
        seen.push(request)
        return {
          taskId: request.taskId,
          ownerSessionId: 'controller-b',
          ownerEpoch: 1,
          observers: [],
          uncertain: [],
          snapshot: 'handover',
          changed: true,
          summary: 'moved',
        }
      },
    } as unknown as ConductorToolContext)
    await tool.execute(
      {
        action: 'transfer',
        taskId: 'task-1',
        sessionId: 'controller-b',
        expectedOwnerEpoch: 0,
        expectedBindingVersion: 1,
      },
      { agent: { id: 'controller-a' }, callId: 'c1' } as never,
    )
    expect(seen[0]?.callerSessionId).toBe('controller-a')
    expect(seen[0]?.expectedOwnerEpoch).toBe(0)
    expect(seen[0]?.expectedBindingVersion).toBe(1)
  })
})
