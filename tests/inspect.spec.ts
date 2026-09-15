import { describe, expect, it } from 'vitest'
import { describeDefinedConditions, inspectObservationOf } from '../src/service/inspect.ts'

describe('inspect observation (PRD §二.11 已定义条件)', () => {
  it('names the missing target rather than inventing a state', () => {
    expect(inspectObservationOf({})).toBe(
      'no target task is set, so there is no task state or artifact to inspect',
    )
    expect(inspectObservationOf({ taskId: 'task-missing' })).toBe(
      'the target task task-missing is not one the conductor manages',
    )
  })

  it('reports state and artifacts, and zero defined conditions when none are saved', () => {
    const line = inspectObservationOf({
      taskId: 'task-1',
      task: { taskId: 'task-1', preparation: 'ready', preparationPhase: 'ready' },
      sessionId: 'session-1',
      artifacts: [{ existence: 'present', acceptance: 'pending' }],
    })
    expect(line).toBe(
      'task task-1 is ready/ready on session session-1; 1 artifact(s), 1 verified present, 0 检查通过 and 0 用户验收; '
      + '0 defined condition(s)',
    )
  })

  it('reports each defined constraint at the delivery stage this target has reached', () => {
    expect(describeDefinedConditions(
      [
        { constraintId: 'c-b', kind: 'prohibition', version: 1 },
        { constraintId: 'c-a', kind: 'interface', version: 0 },
      ],
      [
        { constraintId: 'c-a', version: 0, stage: 'verified' },
      ],
    )).toBe('2 defined condition(s): c-a@0 interface verified, c-b@1 prohibition unset')
  })

  it('changes the observation when a condition moves from unset to sent', () => {
    const base = {
      taskId: 'task-1',
      task: { taskId: 'task-1', preparation: 'ready', preparationPhase: 'ready' },
      constraints: [{ constraintId: 'c-1', kind: 'acceptance_requirement', version: 2 }],
    }
    const before = inspectObservationOf({ ...base, deliveries: [] })
    const after = inspectObservationOf({
      ...base,
      deliveries: [{ constraintId: 'c-1', version: 2, stage: 'sent' }],
    })
    expect(before).toMatch(/c-1@2 acceptance_requirement unset/)
    expect(after).toMatch(/c-1@2 acceptance_requirement sent/)
    expect(before).not.toBe(after)
  })
})
