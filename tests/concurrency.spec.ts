import { describe, expect, it } from 'vitest'
import { relaySource, noticeSource } from '../src/service/host.ts'
import {
  admitPluginTurn,
  countOccupied,
  dispatchKindOf,
  occupiedSlotOf,
  pendingDispatchOrder,
  sessionOccupies,
} from '../src/service/concurrency.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

function event(seq: number, type: string, data: unknown = {}): SessionEventLike {
  return { type, seq, time: seq, data }
}

describe('plugin turn occupancy (PRD §四.4)', () => {
  it('treats a person and an automatic writer as different kinds', () => {
    expect(dispatchKindOf(undefined)).toBe('explicit')
    expect(dispatchKindOf({ kind: 'user' })).toBe('explicit')
    expect(dispatchKindOf({ kind: 'rule' })).toBe('automatic')
    expect(dispatchKindOf({ kind: 'relay' })).toBe('automatic')
  })

  it('gives native UI no plugin slot, relay a target slot and notice the report slot', () => {
    expect(occupiedSlotOf({ kind: 'user' })).toBeUndefined()
    expect(occupiedSlotOf(relaySource())).toBe('target')
    expect(occupiedSlotOf(noticeSource('observed'))).toBe('notice')
    expect(occupiedSlotOf({ kind: 'plugin', plugin: 'other', form: 'relay' })).toBeUndefined()
  })

  it('occupies a target slot while a conductor-relay turn is running', () => {
    const agent = {
      status: 'running',
      session: {
        events: [
          event(0, 'user/message', {
            content: [{ type: 'text', text: 'do it' }],
            source: relaySource(),
          }),
          event(1, 'turn/start', { turn: 1 }),
        ],
      },
    }
    expect(sessionOccupies(agent)).toBe('target')
  })

  it('does not occupy a slot for a native-interface turn, even while running', () => {
    const agent = {
      status: 'running',
      session: {
        events: [
          event(0, 'user/message', {
            content: [{ type: 'text', text: 'typed here' }],
            source: { kind: 'user' },
          }),
          event(1, 'turn/start', { turn: 1 }),
        ],
      },
    }
    expect(sessionOccupies(agent)).toBeUndefined()
  })

  it('keeps occupying while waiting for approval, including after the agent goes idle', () => {
    const agent = {
      status: 'idle',
      session: {
        events: [
          event(0, 'user/message', { content: [], source: relaySource() }),
          event(1, 'turn/start', { turn: 1 }),
          event(2, 'approval/asked', { id: 'a1', toolName: 'write' }),
        ],
      },
    }
    expect(sessionOccupies(agent)).toBe('target')
  })

  it('occupies a target slot while waiting for a person after a user question', () => {
    const agent = {
      status: 'idle',
      session: {
        events: [
          event(0, 'user/message', { content: [], source: relaySource() }),
          event(1, 'turn/start', { turn: 1 }),
          event(2, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' }),
        ],
      },
    }
    expect(sessionOccupies(agent)).toBe('target')
  })

  it('admits a target turn under the limit and keeps one pending at the limit', () => {
    expect(admitPluginTurn({
      occupiedTargets: 3, occupiedNotices: 0, targetLimit: 4, noticeLimit: 1, slot: 'target',
    })).toEqual({ admit: true })
    const refused = admitPluginTurn({
      occupiedTargets: 4, occupiedNotices: 0, targetLimit: 4, noticeLimit: 1, slot: 'target',
    })
    expect(refused.admit).toBe(false)
    if (!refused.admit) expect(refused.reason).toMatch(/kept pending rather than refused/)
  })

  it('counts notice occupancy on its own quota', () => {
    expect(countOccupied(['target', 'notice', 'target', undefined], 'target')).toBe(2)
    expect(countOccupied(['target', 'notice', 'target', undefined], 'notice')).toBe(1)
    const full = admitPluginTurn({
      occupiedTargets: 0, occupiedNotices: 1, targetLimit: 4, noticeLimit: 1, slot: 'notice',
    })
    expect(full.admit).toBe(false)
  })

  it('orders pending dispatches as explicit first, then automatic, each FIFO', () => {
    const ordered = pendingDispatchOrder([
      { operationId: 'auto-old', createdAt: '2026-09-14T00:00:00.000Z', attribution: { kind: 'rule' } },
      { operationId: 'user-new', createdAt: '2026-09-14T00:00:02.000Z' },
      { operationId: 'user-old', createdAt: '2026-09-14T00:00:01.000Z', attribution: { kind: 'user' } },
      { operationId: 'auto-new', createdAt: '2026-09-14T00:00:03.000Z', attribution: { kind: 'relay' } },
    ])
    expect(ordered.map(entry => entry.operationId)).toEqual([
      'user-old',
      'user-new',
      'auto-old',
      'auto-new',
    ])
  })
})
