import { describe, expect, it } from 'vitest'
import { freezeWorkflowModels, workflowModelRefusal, workflowOperationModelRefusal } from '../src/service/workflow-model.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { ModelSelectionReader } from '../src/service/modelconfig.ts'

async function fixture() {
  const store = new ConductorStore(createInMemoryTables())
  await store.createTask({ taskId: 't', title: 'target', controllerSessionId: 'owner', pinned: false, archived: false, requestedBy: 'user', contextMode: 'empty', preparation: 'ready', preparationPhase: 'ready', createdAt: 'now', updatedAt: 'now' })
  await store.putBinding({ taskId: 't', bindingId: 'b', hostId: 'local', sessionId: 's', version: 1, createdAt: 'now' })
  let model = 'frozen'
  let reads = 0
  const value = () => ({ sessionId: 's', next: { provider: 'p', model }, source: 'session_override' as const, persisted: true, effectiveAt: 'next_request' as const })
  const reader: ModelSelectionReader = { readForSession: async () => { reads++; return value() }, peekForSession: value }
  return { store, reader, change: () => { model = 'changed' }, reads: () => reads }
}

describe('workflow runtime configuration freeze', () => {
  it('captures repeated task nodes once and refuses live model drift at dispatch', async () => {
    const f = await fixture()
    const pins = await freezeWorkflowModels(f.store, [{ nodeId: 'a', taskId: 't' }, { nodeId: 'b', taskId: 't' }], f.reader)
    expect(f.reads()).toBe(1)
    expect(workflowModelRefusal(f.store, pins, 'a', f.reader)).toBeUndefined()
    f.change()
    expect(pins[0]?.selection.model).toBe('frozen')
    expect(workflowModelRefusal(f.store, pins, 'a', f.reader)).toMatch(/model differs/)
  })
  it('queued operation rechecks the same run snapshot when it is flushed', async () => {
    const f = await fixture()
    const pins = await freezeWorkflowModels(f.store, [{ nodeId: 'a', taskId: 't' }], f.reader)
    await f.store.putWorkflowRun({ runId: 'r', workflowId: 'w', definitionVersion: 1, status: 'running', reworkRoundsUsed: 0, reworkHistory: [], nodes: [{ nodeId: 'a', state: 'ready', attempts: 0 }], fixed: { definitionVersion: 1, modelConfigurations: pins, authorisations: [], constraints: [], artifacts: [], acceptance: [] }, startedAt: 'now', updatedAt: 'now' })
    await f.store.beginOperation({ operationId: 'workflow-r-a-1', kind: 'send', taskId: 't', params: {}, attribution: { kind: 'relay', sourceEventId: 'workflow-r-a-1' } })
    const op = f.store.getOperation('workflow-r-a-1')!
    expect(workflowOperationModelRefusal(f.store, op, f.reader)).toBeUndefined()
    f.change()
    expect(workflowOperationModelRefusal(f.store, op, f.reader)).toMatch(/model differs/)
  })
  it('missing legacy snapshots and absent synchronous Host reader fail closed', async () => {
    const f = await fixture()
    await expect(freezeWorkflowModels(f.store, [{ nodeId: 'a', taskId: 't' }], undefined)).rejects.toThrow(/synchronous dispatch guard/)
    expect(workflowModelRefusal(f.store, undefined, 'a', f.reader)).toMatch(/no frozen/)
  })
})
