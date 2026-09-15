import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_STATES,
  CONNECTION_STATES,
  connectionListFields,
  connectionListNote,
  connectionOf,
  DELIVERY_STATES,
  EXECUTION_STATES,
  INTERACTION_STATES,
  NODE_STATES,
  overlayExecution,
  PREPARATION_PHASES,
  PREPARATION_STATES,
  TURN_OUTCOMES,
  acceptsWrites,
  canTransition,
  requiresReconciliation,
} from '../src/domain/state.ts'

/**
 * The state model is a transcription of PRD §三.4. These assertions exist so a
 * later refactor cannot quietly drop a dimension the specification separates.
 */
describe('state model (PRD §三.4)', () => {
  it('exposes every documented dimension with its documented members', () => {
    expect([...PREPARATION_STATES]).toEqual(['accepted', 'preparing', 'ready', 'failed', 'cancelled'])
    expect([...CONNECTION_STATES]).toEqual(['online', 'reconnecting', 'unavailable'])
    expect([...EXECUTION_STATES]).toEqual(['idle', 'running', 'interrupting', 'reconciling'])
    expect([...INTERACTION_STATES]).toEqual(['none', 'waiting_input', 'waiting_approval'])
    expect([...TURN_OUTCOMES]).toEqual(['completed', 'failed', 'interrupted', 'blocked'])
    expect([...DELIVERY_STATES]).toEqual([
      'prepared',
      'dispatching',
      'accepted',
      'consumed',
      'withdrawn',
      'failed',
      'unknown',
    ])
    expect([...ACCEPTANCE_STATES]).toEqual(['pending', 'pass', 'fail', 'inconclusive'])
    expect([...NODE_STATES]).toEqual([
      'blocked',
      'ready',
      'running',
      'waiting',
      'validating',
      'passed',
      'failed',
      'cancelled',
    ])
  })

  it('projects live/persisted onto 连接 without inventing reconnecting (PRD §三.4, §二.5)', () => {
    expect(connectionOf({ live: true, persisted: true })).toMatchObject({
      connection: 'online', unrecoverable: false,
    })
    expect(connectionOf({ live: false, persisted: true })).toMatchObject({
      connection: 'unavailable', unrecoverable: false,
    })
    expect(connectionOf({ live: false, persisted: true }).reason).toMatch(/失联/)
    expect(connectionOf({ live: false, persisted: false })).toMatchObject({
      connection: 'unavailable', unrecoverable: true,
    })
    expect(connectionOf({ live: false, persisted: false }).reason).toMatch(/不可恢复/)
    expect(connectionOf({ live: false }).unrecoverable).toBe(false)
    expect(connectionOf({ live: false }).reason).toMatch(/was not read/)
    expect(connectionOf({ live: true }).connection).not.toBe('reconnecting')
  })

  it('names 失联 and 不可恢复 on a list line the same way discovery does', () => {
    expect(connectionListFields(undefined)).toEqual({})
    expect(connectionListFields(connectionOf({ live: true }))).toMatchObject({
      connection: 'online', unrecoverable: false,
    })
    expect(connectionListNote({})).toBe('')
    expect(connectionListNote({ connection: 'online' })).toBe(' (online)')
    expect(connectionListNote({ connection: 'unavailable' })).toBe(' (失联)')
    expect(connectionListNote({ connection: 'unavailable', unrecoverable: true })).toBe(' (不可恢复)')
  })

  it('orders the asynchronous preparation phases as the PRD lists them', () => {
    expect([...PREPARATION_PHASES]).toEqual([
      'accepted',
      'preparing_workspace',
      'preparing_context',
      'creating_session',
      'ready',
      'dispatching_initial_message',
      'initial_message_accepted',
    ])
  })

  it('refuses writes before ready, as required by PRD §二.2.1', () => {
    expect(acceptsWrites('ready')).toBe(true)
    for (const state of ['accepted', 'preparing', 'failed', 'cancelled'] as const) {
      expect(acceptsWrites(state)).toBe(false)
    }
  })

  it('walks the delivery pipeline in the persisted order of PRD §四.1', () => {
    expect(canTransition('delivery', 'prepared', 'dispatching')).toBe(true)
    expect(canTransition('delivery', 'dispatching', 'accepted')).toBe(true)
    expect(canTransition('delivery', 'accepted', 'consumed')).toBe(true)
    // The pipeline is one-way: a consumed message is never dispatched again.
    expect(canTransition('delivery', 'consumed', 'dispatching')).toBe(false)
    expect(canTransition('delivery', 'accepted', 'prepared')).toBe(false)
  })

  it('lets a still-prepared message be withdrawn and never re-prepared', () => {
    expect(canTransition('delivery', 'prepared', 'withdrawn')).toBe(true)
    expect(canTransition('delivery', 'withdrawn', 'prepared')).toBe(false)
    expect(canTransition('delivery', 'withdrawn', 'dispatching')).toBe(false)
  })

  it('parks an unconfirmable dispatch in unknown instead of resending it', () => {
    expect(canTransition('delivery', 'dispatching', 'unknown')).toBe(true)
    expect(canTransition('delivery', 'unknown', 'accepted')).toBe(true)
    expect(canTransition('delivery', 'unknown', 'dispatching')).toBe(false)
    expect(requiresReconciliation('unknown')).toBe(true)
    expect(requiresReconciliation('dispatching')).toBe(true)
    expect(requiresReconciliation('prepared')).toBe(false)
    expect(requiresReconciliation('consumed')).toBe(false)
  })

  it('never advances preparation backwards out of a terminal state', () => {
    expect(canTransition('preparation', 'accepted', 'preparing')).toBe(true)
    expect(canTransition('preparation', 'preparing', 'ready')).toBe(true)
    expect(canTransition('preparation', 'ready', 'preparing')).toBe(false)
    expect(canTransition('preparation', 'failed', 'preparing')).toBe(false)
    expect(canTransition('preparation', 'cancelled', 'preparing')).toBe(false)
  })
})

describe('execution overlay (PRD §三.4 interrupting / reconciling)', () => {
  it('marks a still-open cancelled turn interrupting, not a later turn', () => {
    expect(overlayExecution('running', {
      cancelRequestedTurn: 3,
      openTurn: 3,
      unknownDeliveries: false,
    })).toBe('interrupting')
    expect(overlayExecution('running', {
      cancelRequestedTurn: 3,
      openTurn: 4,
      unknownDeliveries: false,
    })).toBe('running')
    expect(overlayExecution('idle', {
      cancelRequestedTurn: 3,
      openTurn: undefined,
      unknownDeliveries: false,
    })).toBe('idle')
  })

  it('marks idle unknown deliveries reconciling, and does not hide a live turn', () => {
    expect(overlayExecution('idle', { unknownDeliveries: true })).toBe('reconciling')
    expect(overlayExecution('running', { unknownDeliveries: true })).toBe('running')
    expect(overlayExecution('running', {
      cancelRequestedTurn: 1,
      openTurn: 1,
      unknownDeliveries: true,
    })).toBe('interrupting')
    expect(overlayExecution('idle', { unknownDeliveries: false })).toBe('idle')
  })
})
