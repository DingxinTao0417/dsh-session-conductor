import { describe, expect, it } from 'vitest'
import {
  COMPLETION_RETURN_DETAIL_LIMIT,
  COMPLETION_RETURN_PREVIEW_LIMIT,
  resolveCompletionReturn,
  type CompletionReturnCallback,
} from '../src/service/completion-return.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

const T0 = Date.parse('2026-09-15T12:00:00.000Z')

function callback(over: Partial<CompletionReturnCallback> = {}): CompletionReturnCallback {
  return {
    operationId: 'create-1',
    bindingId: 'binding-1',
    bindingVersion: 1,
    messageId: 'relay-1',
    phase: 'armed',
    armedAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...over,
  }
}

function event(seq: number, type: string, data: unknown = {}, time = T0 + seq): SessionEventLike {
  return { seq, type, data, time }
}

function relay(seq: number, id = 'relay-1'): SessionEventLike {
  return event(seq, 'user/message', { id, role: 'user', content: [{ type: 'text', text: 'do the delegated work' }] })
}

function start(seq: number, turn: number): SessionEventLike {
  return event(seq, 'turn/start', { turn })
}

function assistant(seq: number, turn: number, content: unknown): SessionEventLike {
  return event(seq, 'assistant/message', { turn, step: 1, message: { content } })
}

function end(seq: number, turn: number, kind = 'completed'): SessionEventLike {
  return event(seq, 'turn/end', { turn, reason: { kind } })
}

describe('resolveCompletionReturn', () => {
  it('waits when the exact initial relay has not reached Host history', () => {
    const result = resolveCompletionReturn(callback(), [relay(2, 'another-message')])

    expect(result.status).toBe('waiting')
    expect(result.changed).toBe(false)
    expect(result.messageSeq).toBeUndefined()
    expect(result.initialTurn).toBeUndefined()
    expect(result.record.phase).toBe('armed')
  })

  it('records the exact relay position but waits until its later turn/start appears', () => {
    const result = resolveCompletionReturn(callback(), [relay(8)])

    expect(result.status).toBe('waiting')
    expect(result.changed).toBe(true)
    expect(result.messageSeq).toBe(8)
    expect(result.record).toMatchObject({ phase: 'armed', messageSeq: 8 })
  })

  it('marks the first subsequent turn as running and never reads a stream chunk', () => {
    const result = resolveCompletionReturn(callback(), [
      relay(4),
      start(5, 17),
      event(6, 'assistant/chunk', { turn: 17, chunk: { text: 'not a public result' } }),
    ])

    expect(result.status).toBe('running')
    expect(result.record).toMatchObject({ phase: 'running', messageSeq: 4, turn: 17, startSeq: 5 })
    expect(result.initialTurn).toEqual({ turn: 17, startSeq: 5 })
    expect(result.terminal).toBeUndefined()
  })

  it('returns the completed initial turn with its last same-turn public assistant text', () => {
    const result = resolveCompletionReturn(callback(), [
      relay(10),
      start(11, 3),
      assistant(12, 3, [
        { type: 'reasoning', text: 'private chain of thought' },
        { type: 'text', text: 'first public update' },
      ]),
      event(13, 'assistant/chunk', { turn: 3, chunk: { text: 'stream-only text' } }),
      assistant(14, 3, [{ type: 'text', text: 'final public result' }]),
      end(15, 3, 'completed'),
    ])

    expect(result.status).toBe('terminal')
    expect(result.terminal).toEqual({
      seq: 15,
      time: T0 + 15,
      outcome: 'completed',
      detail: 'completed',
      preview: 'final public result',
    })
    expect(result.record).toMatchObject({
      phase: 'returned', messageSeq: 10, turn: 3, startSeq: 11, endSeq: 15,
      outcome: 'completed', detail: 'completed', preview: 'final public result',
      completedAt: new Date(T0 + 15).toISOString(),
    })
  })

  it('supports the current Host order where turn/start precedes the claimed relay message', () => {
    const result = resolveCompletionReturn(callback(), [
      start(20, 9),
      relay(21),
      assistant(22, 9, [{ type: 'text', text: 'current Host layout result' }]),
      end(23, 9, 'completed'),
    ])

    expect(result.status).toBe('terminal')
    expect(result.record).toMatchObject({
      phase: 'returned', messageSeq: 21, turn: 9, startSeq: 20, endSeq: 23,
      preview: 'current Host layout result',
    })
  })

  it('maps a Host error terminal to failed and retains its Host detail', () => {
    const result = resolveCompletionReturn(callback(), [
      relay(1),
      start(2, 8),
      end(3, 8, 'error'),
    ])

    expect(result.status).toBe('terminal')
    expect(result.terminal).toMatchObject({ outcome: 'failed', detail: 'error' })
    expect(result.record).toMatchObject({ phase: 'returned', outcome: 'failed', endSeq: 3 })
  })

  it('bounds an untrusted Host error detail before it reaches the creation card', () => {
    const message = 'x'.repeat(COMPLETION_RETURN_DETAIL_LIMIT + 100)
    const result = resolveCompletionReturn(callback(), [
      relay(1), start(2, 8), event(3, 'turn/end', { turn: 8, reason: { kind: 'error', error: { code: 'HOST', message } } }),
    ])

    expect(result.record.detail).toHaveLength(COMPLETION_RETURN_DETAIL_LIMIT)
    expect(result.record.detail?.endsWith('… [truncated]')).toBe(true)
  })

  it('keeps the full terminal vocabulary aligned with the Host outcome mapper', () => {
    const cases = [
      ['aborted', 'interrupted'],
      ['interrupted', 'interrupted'],
      ['blocked', 'blocked'],
      ['max-tokens', 'blocked'],
    ] as const

    for (const [kind, outcome] of cases) {
      const result = resolveCompletionReturn(callback(), [relay(1), start(2, 8), end(3, 8, kind)])
      expect(result.terminal?.outcome).toBe(outcome)
    }
  })

  it('does not let a later turn overwrite the completed initial delegation', () => {
    const result = resolveCompletionReturn(callback(), [
      relay(10),
      start(11, 4),
      assistant(12, 4, [{ type: 'text', text: 'initial result' }]),
      end(13, 4, 'completed'),
      start(14, 5),
      assistant(15, 5, [{ type: 'text', text: 'later request result' }]),
      end(16, 5, 'error'),
    ])

    expect(result.terminal).toMatchObject({ seq: 13, outcome: 'completed', preview: 'initial result' })
    expect(result.record).toMatchObject({ turn: 4, endSeq: 13, outcome: 'completed' })
  })

  it('does not guess from a user message without its direct Host id', () => {
    const result = resolveCompletionReturn(callback(), [
      event(1, 'user/message', { message: { id: 'relay-1' }, content: [{ type: 'text', text: 'lookalike' }] }),
      start(2, 1),
      end(3, 1, 'completed'),
    ])

    expect(result.status).toBe('waiting')
    expect(result.record.phase).toBe('armed')
    expect(result.initialTurn).toBeUndefined()
  })

  it('does not infer a turn when the callback itself has no usable message id', () => {
    const result = resolveCompletionReturn(callback({ messageId: '' }), [start(1, 1), end(2, 1, 'completed')])

    expect(result.status).toBe('waiting')
    expect(result.changed).toBe(false)
    expect(result.record.phase).toBe('armed')
    expect(result.reason).toMatch(/no readable message id/)
  })

  it('bounds a public completion preview to 480 characters with an explicit marker', () => {
    const text = 'x'.repeat(COMPLETION_RETURN_PREVIEW_LIMIT + 100)
    const result = resolveCompletionReturn(callback(), [
      relay(1), start(2, 1), assistant(3, 1, [{ type: 'text', text }]), end(4, 1),
    ])

    expect(result.terminal?.preview).toHaveLength(COMPLETION_RETURN_PREVIEW_LIMIT)
    expect(result.terminal?.preview?.endsWith('… [truncated]')).toBe(true)
    expect(result.record.preview).toBe(result.terminal?.preview)
  })

  it('can finish an already-proven running turn after history compaction drops the relay message', () => {
    const result = resolveCompletionReturn(callback({
      phase: 'running', messageSeq: 10, turn: 4, startSeq: 11,
    }), [assistant(12, 4, [{ type: 'text', text: 'still public' }]), end(13, 4)])

    expect(result.status).toBe('terminal')
    expect(result.terminal).toMatchObject({ seq: 13, outcome: 'completed', preview: 'still public' })
  })
})
