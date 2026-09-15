import { describe, expect, it } from 'vitest'
import {
  afterStopCheck,
  cancelExpectedTurn,
  interruptPrecondition,
  openTurnOf,
  pendingInputOf,
  unconfirmedStopReport,
  type StopAgentLike,
  type StopInboxLike,
} from '../src/service/stop.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

/** A `turn/start` event. */
function started(seq: number, turn: number): SessionEventLike {
  return { type: 'turn/start', seq, data: { turn } }
}

/** A `turn/end` event. */
function ended(seq: number, turn: number): SessionEventLike {
  return { type: 'turn/end', seq, data: { turn, reason: { kind: 'aborted' } } }
}

/** An agent whose cancel calls are recorded rather than performed. */
function agent(events: SessionEventLike[], over: Partial<StopAgentLike> = {}) {
  const cancels: { cause: unknown; keepInbox: unknown }[] = []
  const value: StopAgentLike = {
    status: 'running',
    session: { events },
    cancel: (cause, options) => { cancels.push({ cause, keepInbox: options?.keepInbox }) },
    ...over,
  }
  return { agent: value, cancels }
}

/** An inbox projection with only the pending lists populated. */
function inbox(
  lists: { nextTurn?: { id: string; text?: string; content?: unknown }[]; nextStep?: { id: string; text?: string }[] } = {},
): StopInboxLike {
  const nextTurn = lists.nextTurn ?? []
  const nextStep = lists.nextStep ?? []
  return {
    nextTurn,
    nextStep,
    hasPending: nextTurn.length > 0 || nextStep.length > 0,
    remove: () => false,
    replace: () => false,
  }
}

describe('reading the open turn (PRD §二.6)', () => {
  it('reports no open turn for an empty or between-turn log', () => {
    expect(openTurnOf([])).toBeUndefined()
    expect(openTurnOf([started(1, 1), ended(2, 1)])).toBeUndefined()
  })

  it('reads the turn number and the sequence it started at', () => {
    expect(openTurnOf([started(1, 1), ended(2, 1), started(5, 2)])).toEqual({ turn: 2, startSeq: 5, seq: 5 })
  })

  it('does not close a live turn because an unrelated turn ended', () => {
    // A `turn/end` for a turn that is not the open one must not drop the anchor:
    // that is how a stop would end up believing the session is idle while a turn
    // is still running.
    const fold = openTurnOf([started(1, 3), ended(2, 2)])
    expect(fold?.turn).toBe(3)
  })

  it('uses the highest sequence seen, not the last event position', () => {
    const fold = openTurnOf([{ type: 'agent/status', seq: 9, data: { status: 'running' } }, started(4, 1)])
    expect(fold).toEqual({ turn: 1, startSeq: 4, seq: 9 })
  })
})

describe('exact stop (PRD §二.6, T09)', () => {
  it('cancels the expected turn when the expectation still matches', () => {
    const { agent: live, cancels } = agent([started(4, 2)])
    const decision = cancelExpectedTurn(live, { turn: 2, startSeq: 4 })
    expect(decision.kind).toBe('requested')
    expect(cancels).toHaveLength(1)
    expect(cancels[0]?.keepInbox).toBe(true)
  })

  it('does not mis-stop a new turn when the expected turn has already ended', () => {
    // This is T09. The caller observed turn 1; the Host finished it and started
    // turn 2 before the stop arrived. Cancelling now would kill a turn nobody
    // asked to stop, so the stop must refuse.
    const { agent: live, cancels } = agent([started(1, 1), ended(2, 1), started(3, 2)])
    const decision = cancelExpectedTurn(live, { turn: 1, startSeq: 1 })
    expect(decision.kind).toBe('stale_turn')
    if (decision.kind !== 'stale_turn') return
    expect(decision.found?.turn).toBe(2)
    expect(cancels).toHaveLength(0)
  })

  it('refuses when the turn number matches but the turn restarted at a different sequence', () => {
    // A Host that reuses turn numbers would otherwise let the stop land on the
    // second turn with the same number. The start sequence disambiguates them.
    const { agent: live, cancels } = agent([started(8, 2)])
    const decision = cancelExpectedTurn(live, { turn: 2, startSeq: 4 })
    expect(decision.kind).toBe('stale_turn')
    expect(cancels).toHaveLength(0)
  })

  it('reports no active turn and cancels nothing when the session is idle', () => {
    const { agent: live, cancels } = agent([started(1, 1), ended(2, 1)])
    const decision = cancelExpectedTurn(live, { turn: 1 })
    expect(decision.kind).toBe('no_active_turn')
    expect(cancels).toHaveLength(0)
  })

  it('reports no active turn when a turn is open but the Host says the agent is idle', () => {
    const { agent: live, cancels } = agent([started(1, 1)], { status: 'idle' })
    const decision = cancelExpectedTurn(live)
    expect(decision.kind).toBe('no_active_turn')
    expect(cancels).toHaveLength(0)
  })

  it('cancels whatever is open when the caller names no expectation', () => {
    const { agent: live, cancels } = agent([started(3, 7)])
    const decision = cancelExpectedTurn(live)
    expect(decision.kind).toBe('requested')
    expect(cancels).toHaveLength(1)
  })

  it('is synchronous and yields nothing between the check and the cancel', () => {
    // The guarantee is that the projection cannot change between validation and
    // `cancel()`. That is only true while the function never awaits, so this
    // asserts the shape of the guarantee rather than trusting the comment: a
    // thenable can only be observed if the function returned one.
    const { agent: live, cancels } = agent([started(1, 1)])
    const decision = cancelExpectedTurn(live, { turn: 1 })
    expect(decision).not.toBeInstanceOf(Promise)
    expect(typeof (decision as { then?: unknown }).then).toBe('undefined')
    expect(cancels).toHaveLength(1)

    // And an agent that changes the log *inside* cancel is not re-validated
    // afterwards: the decision is made once, from one reading.
    const mutating: SessionEventLike[] = [started(1, 1)]
    const live2 = {
      status: 'running' as const,
      session: { events: mutating },
      cancel: () => { mutating.push(ended(2, 1)) },
    }
    expect(cancelExpectedTurn(live2, { turn: 1 }).kind).toBe('requested')
  })

  it('records the supplied cause so a budget cancel is not labelled an exact stop', () => {
    const { agent: live, cancels } = agent([started(1, 1)])
    cancelExpectedTurn(live, {}, { reason: 'conductor budget deadline' })
    expect(cancels[0]).toEqual({
      cause: { kind: 'hook', reason: 'conductor budget deadline' },
      keepInbox: true,
    })
  })
})

describe('unconsumed input (PRD §二.6)', () => {
  it('reads the queue and the steering in the order the Host will consume them', () => {
    const pending = pendingInputOf(inbox({
      nextTurn: [{ id: 'm-2', text: 'second' }, { id: 'm-3', text: 'third' }],
      nextStep: [{ id: 'm-1', text: 'first' }],
    }))
    expect(pending.queue.map(m => m.messageId)).toEqual(['m-2', 'm-3'])
    expect(pending.steering.map(m => m.messageId)).toEqual(['m-1'])
  })

  it('reads the Host UserMessage content blocks rather than reporting empty text', () => {
    // Live Host inbox entries are `UserMessage`s: `{ id, content: [{ type: 'text', text }] }`,
    // with no `.text`. Treating that shape as unreadable made edit/list look empty on a
    // real queue even though the Host held the body.
    const pending = pendingInputOf(inbox({
      nextTurn: [{ id: 'm-live', content: [{ type: 'text', text: 'queued through followup' }] }],
    }))
    expect(pending.queue[0]).toEqual({ messageId: 'm-live', text: 'queued through followup' })
  })

  it('reports an unreadable text as empty rather than guessing at it', () => {
    const pending = pendingInputOf(inbox({ nextTurn: [{ id: 'm-1' }] }))
    expect(pending.queue[0]).toEqual({ messageId: 'm-1', text: '' })
  })

  it('refuses an interrupt-and-send while the queue holds unconsumed work', () => {
    const precondition = interruptPrecondition({
      queue: [{ messageId: 'm-1', text: 'waiting' }],
      steering: [],
    })
    expect(precondition.ok).toBe(false)
    expect(precondition.code).toBe('QUEUE_CONFLICT')
    expect(precondition.reason).toMatch(/kept and nothing was cancelled/)
  })

  it('proceeds when only steering is pending, because steering is not a queued turn', () => {
    const precondition = interruptPrecondition({ queue: [], steering: [{ messageId: 'm-1', text: 'steer' }] })
    expect(precondition.ok).toBe(true)
  })
})

describe('what changed while the stop was in flight (PRD §二.6, T10)', () => {
  const before = { turn: 1, queueLength: 0, bindingVersion: 2, ownerEpoch: 0 }

  it('allows the send when the expected turn ended and nothing else moved', () => {
    expect(afterStopCheck(before, { openTurn: undefined, queueLength: 0, bindingVersion: 2, ownerEpoch: 0 }).ok).toBe(true)
  })

  it('refuses when a new turn started, keeping the text', () => {
    const check = afterStopCheck(before, {
      openTurn: { turn: 2, startSeq: 9, seq: 9 }, queueLength: 0, bindingVersion: 2, ownerEpoch: 0,
    })
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/turn 2 started/)
  })

  it('refuses when new queue work appeared', () => {
    const check = afterStopCheck(before, { openTurn: undefined, queueLength: 1, bindingVersion: 2, ownerEpoch: 0 })
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/queue grew from 0 to 1/)
  })

  it('refuses when the binding moved', () => {
    const check = afterStopCheck(before, { openTurn: undefined, queueLength: 0, bindingVersion: 3, ownerEpoch: 0 })
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/binding version moved/)
  })

  it('refuses when write control moved', () => {
    const check = afterStopCheck(before, { openTurn: undefined, queueLength: 0, bindingVersion: 2, ownerEpoch: 1 })
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/write-control epoch moved/)
  })

  it('refuses when a control value could not be read, without claiming it changed', () => {
    // Sending into a control state that could not be verified is the risk the
    // rule exists to avoid, so an unreadable value refuses. But it is a different
    // fact from a change, and the reason must not assert one that was never seen.
    const check = afterStopCheck(before, { openTurn: undefined, queueLength: 0, ownerEpoch: 0 })
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/could not be read/)
    expect(check.reason).not.toMatch(/moved/)
  })

  it('does not refuse a shrink in the queue, which is the stop succeeding', () => {
    expect(afterStopCheck(
      { ...before, queueLength: 2 },
      { openTurn: undefined, queueLength: 1, bindingVersion: 2, ownerEpoch: 0 },
    ).ok).toBe(true)
  })
})

describe('reporting an unconfirmed stop (PRD §二.6 step 7)', () => {
  it('says the stop was unconfirmed and the instruction was not sent', () => {
    const report = unconfirmedStopReport(30_000, { turn: 4, startSeq: 11, seq: 20 })
    expect(report).toContain('stop not confirmed, instruction not sent')
    expect(report).toContain('turn 4')
    expect(report).toContain('30000 ms')
  })
})
