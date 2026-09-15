/**
 * Session-chain display (PRD §二.10.2 任务继续于新会话).
 *
 * @module dsh-session-conductor/tests/session-chain
 */

import { describe, expect, it } from 'vitest'
import {
  describeSessionChain,
  describeSessionContinuation,
  sessionChainOf,
  sessionContinuationFields,
  type SessionChainBinding,
} from '../src/domain/session-chain.ts'

function binding(over: Partial<SessionChainBinding> & { bindingId: string; sessionId: string; version: number }): SessionChainBinding {
  return over
}

describe('session chain display (PRD §二.10.2)', () => {
  it('does not call a single binding a continuation', () => {
    const chain = sessionChainOf([
      binding({ bindingId: 'b1', sessionId: 'session-1', version: 1 }),
    ], 'b1')
    expect(chain).toEqual([{ sessionId: 'session-1', current: true, retired: false }])
    expect(describeSessionContinuation(chain)).toBeUndefined()
    expect(describeSessionChain(chain)).toBeUndefined()
    expect(sessionContinuationFields([
      binding({ bindingId: 'b1', sessionId: 'session-1', version: 1 }),
    ], 'b1')).toEqual({})
  })

  it('names the successor and keeps the predecessor when a task moved', () => {
    const bindings = [
      binding({ bindingId: 'b1', sessionId: 'session-old', version: 1, retiredAt: 'then' }),
      binding({
        bindingId: 'b2', sessionId: 'session-new', version: 2, predecessorBindingId: 'b1',
      }),
    ]
    const chain = sessionChainOf(bindings, 'b2')
    expect(chain.map(link => link.sessionId)).toEqual(['session-old', 'session-new'])
    expect(chain[0]).toMatchObject({ current: false, retired: true })
    expect(chain[1]).toMatchObject({ current: true, retired: false })
    expect(describeSessionContinuation(chain)).toBe(
      '任务继续于新会话 session-new（此前 session-old）',
    )
    expect(describeSessionChain(chain)).toBe('session-old → session-new')
  })

  it('keeps a three-session chain in version order, not insertion order', () => {
    const bindings = [
      binding({ bindingId: 'b3', sessionId: 'session-c', version: 3 }),
      binding({ bindingId: 'b1', sessionId: 'session-a', version: 1, retiredAt: 't1' }),
      binding({ bindingId: 'b2', sessionId: 'session-b', version: 2, retiredAt: 't2', predecessorBindingId: 'b1' }),
    ]
    const chain = sessionChainOf(bindings, 'b3')
    expect(describeSessionContinuation(chain)).toBe(
      '任务继续于新会话 session-c（此前 session-a → session-b）',
    )
    expect(describeSessionChain(chain)).toBe('session-a → session-b → session-c')
  })

  it('treats the last live binding as current when the task does not name one', () => {
    const chain = sessionChainOf([
      binding({ bindingId: 'b1', sessionId: 'session-old', version: 1, retiredAt: 'then' }),
      binding({ bindingId: 'b2', sessionId: 'session-new', version: 2 }),
    ])
    expect(chain.find(link => link.current)?.sessionId).toBe('session-new')
    expect(describeSessionContinuation(chain)).toMatch(/session-new/)
  })

  it('omits the fields when there is nothing to show', () => {
    expect(sessionContinuationFields([])).toEqual({})
    expect(sessionContinuationFields([
      binding({ bindingId: 'b1', sessionId: 'session-1', version: 1 }),
    ])).toEqual({})
  })
})
