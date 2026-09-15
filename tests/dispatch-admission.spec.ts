import { describe, expect, it } from 'vitest'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import { automaticDispatchRefusal } from '../src/service/dispatch-admission.ts'

const now = '2026-09-14T00:00:00.000Z'
async function fixture() {
  const store = new ConductorStore(createInMemoryTables(), () => now)
  await store.createTask({ taskId: 'source', title: '', preparation: 'ready', preparationPhase: 'ready',
    pinned: false, archived: false, contextMode: 'empty', requestedBy: 'user', controllerSessionId: 'owner', createdAt: now, updatedAt: now })
  await store.putBinding({ bindingId: 'b', taskId: 'source', sessionId: 'session-source', hostId: 'local', version: 1, createdAt: now })
  await store.putAccess({ taskId: 'source', ownerSessionId: 'owner', ownerEpoch: 0, observerSessionIds: [], updatedAt: now })
  await store.putRule({ ruleId: 'rule', grantId: 'grant', sourceTaskId: 'source', targetTaskId: 'target',
    instruction: 'go', action: 'send', trigger: 'turn_completed', title: '', version: 1, maxExecutions: 1,
    authorizedBy: 'owner', active: true, firings: [], createdAt: now, updatedAt: now })
  const claim = await store.beginOperation({ operationId: 'pending', kind: 'send', taskId: 'target',
    params: { text: 'go', mode: 'steer' }, attribution: { kind: 'rule', ruleId: 'rule', grantId: 'grant', sourceEventId: 'turn-1-completed-session-source#7' } })
  if (claim.kind !== 'accepted') throw new Error('fixture')
  return { store, operation: claim.record }
}

describe('last-moment automation admission', () => {
  it('allows a still valid rule and its real session/seq event', async () => {
    const { store, operation } = await fixture()
    expect(automaticDispatchRefusal(store, operation, Date.parse(now))).toBeUndefined()
  })
  it.each(['disabled', 'expired', 'moved', 'limit'] as const)('refuses a queued rule after it becomes %s', async change => {
    const { store, operation } = await fixture()
    if (change === 'disabled') await store.updateRule('rule', rule => ({ ...rule, active: false }))
    if (change === 'expired') await store.updateRule('rule', rule => ({ ...rule, expiresAt: now }))
    if (change === 'moved') await store.putBinding({ bindingId: 'new', taskId: 'source', sessionId: 'other', hostId: 'local', version: 2, createdAt: now })
    if (change === 'limit') await store.updateRule('rule', rule => ({ ...rule, firings: [{ operationId: 'earlier', sourceEventId: 'before', at: now, outcome: 'dispatched' }] }))
    expect(automaticDispatchRefusal(store, operation, Date.parse(now))).toMatch(/AUTOMATION_|STALE_BINDING/)
  })
  it('refuses a pending schedule after its saved plan is paused', async () => {
    const { store, operation } = await fixture()
    await store.putSchedule({ scheduleId: 'later', title: '', kind: 'once', timezone: 'UTC', nextAt: now,
      action: 'send', targetTaskId: 'target', instruction: 'go', maxRuns: 1, authorizedBy: 'owner',
      status: 'paused', runs: [], createdAt: now, updatedAt: now })
    expect(automaticDispatchRefusal(store, { ...operation, attribution: { kind: 'relay', sourceEventId: `schedule-later-${now}` } }, Date.parse(now)))
      .toMatch(/AUTOMATION_REVOKED/)
  })
})
