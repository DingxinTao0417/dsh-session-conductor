import { describe, expect, it } from 'vitest'
import { UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  TABLE_NAMES,
  conductorDomain,
  taskRecord,
  bindingRecord,
  accessRecord,
  operationRecord,
  watchRecord,
  notificationRecord,
} from '../src/store/schema.ts'

/**
 * The domain declaration is validated by the Host at open time, and a rejected
 * record takes the whole assembly down with `invalid-record`. These assertions
 * pin the parts of the contract a schema mistake would break, before a Host
 * ever sees them.
 */
describe('storage domain declaration (PRD §三.5)', () => {
  it('uses a name the storage layer accepts as a unit name and file name', () => {
    expect(UNIT_NAME_RE.test(DOMAIN_NAME)).toBe(true)
    expect(conductorDomain.name).toBe(DOMAIN_NAME)
  })

  it('declares a non-negative integer format version', () => {
    expect(Number.isInteger(DOMAIN_VERSION)).toBe(true)
    expect(DOMAIN_VERSION).toBeGreaterThanOrEqual(0)
    expect(conductorDomain.version).toBe(DOMAIN_VERSION)
  })

  it('declares every table the store operates on, and no others', () => {
    expect(Object.keys(conductorDomain.tables).sort()).toEqual([...TABLE_NAMES].sort())
  })

  it('rejects a global that could be confused with the never-written sentinel', () => {
    // A nullable global would round-trip a stored null back to `initial`, so the
    // domain layer refuses it outright. Imported above, this would have thrown
    // at module load; assert the schema agrees so the guard stays visible.
    expect(() => conductorDomain.global?.schema.parse(null)).toThrow()
    expect(conductorDomain.global?.initial).toEqual({ schemaVersion: DOMAIN_VERSION })
  })
})

describe('record schemas', () => {
  it('accepts a complete task and rejects one missing its identity', () => {
    expect(taskRecord.safeParse({
      taskId: 't1', title: 'x', pinned: false, archived: false,
      controllerSessionId: 's1', requestedBy: 'user', contextMode: 'brief',
      preparation: 'ready', preparationPhase: 'ready',
      createdAt: 'now', updatedAt: 'now',
    }).success).toBe(true)
    expect(taskRecord.safeParse({ title: 'x' }).success).toBe(false)
  })

  it('rejects a preparation state outside the documented set', () => {
    const base = {
      taskId: 't1', title: 'x', pinned: false, archived: false,
      controllerSessionId: 's1', requestedBy: 'user', contextMode: 'brief',
      preparation: 'almost-ready', preparationPhase: 'ready',
      createdAt: 'now', updatedAt: 'now',
    }
    expect(taskRecord.safeParse(base).success).toBe(false)
  })

  it('rejects a delivery state outside the documented set', () => {
    const base = {
      operationId: 'o1', kind: 'send', paramDigest: 'd', delivery: 'maybe',
      withdrawn: false, createdAt: 'now', updatedAt: 'now',
    }
    expect(operationRecord.safeParse(base).success).toBe(false)
    expect(operationRecord.safeParse({ ...base, delivery: 'unknown' }).success).toBe(true)
  })

  it('accepts a binding stored before frozenThroughSeq existed', () => {
    expect(bindingRecord.safeParse({
      bindingId: 'b',
      taskId: 't',
      hostId: 'local',
      sessionId: 's',
      version: 1,
      createdAt: 'now',
    }).success).toBe(true)
    expect(bindingRecord.safeParse({
      bindingId: 'b',
      taskId: 't',
      hostId: 'local',
      sessionId: 's',
      version: 2,
      predecessorBindingId: 'prev',
      frozenThroughSeq: 11,
      createdAt: 'now',
    }).success).toBe(true)
  })

  it('requires the identity fields of every table', () => {
    expect(bindingRecord.safeParse({ bindingId: 'b', taskId: 't' }).success).toBe(false)
    expect(accessRecord.safeParse({ taskId: 't', ownerSessionId: 's', ownerEpoch: 0 }).success).toBe(false)
    expect(watchRecord.safeParse({ taskId: 't' }).success).toBe(false)
    expect(notificationRecord.safeParse({ notificationId: 'n' }).success).toBe(false)
  })

  it('accepts a notification stored before acknowledgedAt existed', () => {
    expect(notificationRecord.safeParse({
      notificationId: 'n1',
      controllerSessionId: 's',
      taskId: 't',
      sourceEventId: 'e',
      summary: 'turn ended',
      delivery: 'accepted',
      withdrawn: false,
      createdAt: 'now',
      updatedAt: 'now',
    }).success).toBe(true)
  })

  it('accepts a full access record with an explicit epoch and observer list', () => {
    expect(accessRecord.safeParse({
      taskId: 't', ownerSessionId: 's', ownerEpoch: 3, observerSessionIds: ['o1'], updatedAt: 'now',
    }).success).toBe(true)
  })
})
