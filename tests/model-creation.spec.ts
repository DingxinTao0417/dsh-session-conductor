import { describe, expect, it } from 'vitest'
import { Coordinator, type CoordinatorDeps } from '../src/service/coordinator.ts'
import type { AgentLike } from '../src/service/host.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import { modelSelectionReaderOf, readSessionSelection, type ModelSelection } from '../src/service/modelconfig.ts'

function fixture() {
  const store = new ConductorStore(createInMemoryTables())
  const live = new Map<string, AgentLike>()
  const applied = new Map<string, ModelSelection>()
  let next = 0
  let defaultModel = 'before'
  let loseAcknowledgement = false
  let writes = 0
  let creates = 0
  const deps: CoordinatorDeps = {
    store, newTaskId: () => `task-${++next}`, newSessionId: () => `session-${++next}`, newBindingId: () => `binding-${++next}`,
    now: () => '2026-09-15T00:00:00.000Z', defaultCwd: () => undefined,
    createMessage: text => ({ id: `message-${++next}`, text }),
    agents: {
      create: async options => {
        creates++
        defaultModel = 'after'
        const agent: AgentLike = { id: options.sessionId, status: 'idle', followup: () => {}, steer: () => {}, cancel: () => {},
          session: { header: options.meta, events: [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'turn/end' }], seq: 1 } }
        live.set(String(options.sessionId), agent)
        return { agent, dispose: async () => {} }
      },
      get: id => live.get(String(id)), list: () => [...live.values()],
    },
    models: {
      defaultSelection: async () => ({ provider: 'controlled', model: defaultModel }),
      resolve: async selection => selection,
      stateForSession: async id => ({ selection: applied.get(id) ?? { provider: 'controlled', model: defaultModel }, persisted: applied.has(id) }),
      apply: async (id, selection) => {
        writes++
        applied.set(id, selection)
        if (loseAcknowledgement) throw new Error('injected lost model acknowledgement')
        return selection
      },
    },
  }
  return { coordinator: new Coordinator(deps), store, applied, counts: () => ({ creates, writes }),
    loseAck: () => { loseAcknowledgement = true } }
}
const create = { operationId: 'create', controllerSessionId: 'controller', title: 'task', contextMode: 'empty' as const }

describe('creation configuration snapshots (PRD 二.3)', () => {
  it('freezes the default before Host creation changes the default', async () => {
    const f = fixture(); const task = await f.coordinator.createTask(create)
    expect(task.preparation).toBe('ready')
    expect(f.applied.get(task.sessionId ?? '')?.model).toBe('before')
    expect(f.store.getTask(task.taskId)?.configurationSnapshot).toMatchObject({ origin: 'host_default', selection: { model: 'before' }, modelApplied: true })
  })
  it('explicit creation config takes precedence and changed id parameters conflict', async () => {
    const f = fixture(); const request = { ...create, selection: { provider: 'controlled', model: 'explicit' } }
    const task = await f.coordinator.createTask(request)
    expect(f.applied.get(task.sessionId ?? '')?.model).toBe('explicit')
    await expect(f.coordinator.createTask({ ...request, selection: { ...request.selection, model: 'other' } })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })
  it('fork inherits the source next override instead of a historical request model', async () => {
    const f = fixture(); const source = await f.coordinator.createTask(create)
    f.applied.set(source.sessionId ?? '', { provider: 'controlled', model: 'pending-source' })
    const child = await f.coordinator.forkTask({ operationId: 'fork', callerSessionId: 'controller', sourceTaskId: source.taskId })
    expect(child.preparation).toBe('ready')
    expect(f.applied.get(child.sessionId ?? '')?.model).toBe('pending-source')
    expect(f.store.getTask(child.taskId)?.configurationSnapshot?.origin).toBe('source_session')
  })
  it('lost model acknowledgement keeps the child binding and is reconciled without another write', async () => {
    const f = fixture(); f.loseAck()
    const failed = await f.coordinator.createTask(create)
    expect(failed.preparation).toBe('failed')
    expect(failed.sessionId).toBeDefined()
    const resumed = await f.coordinator.resumePreparation({ taskId: failed.taskId, callerSessionId: 'controller' })
    expect(resumed.preparation).toBe('ready')
    expect(resumed.sessionId).toBe(failed.sessionId)
    expect(f.counts()).toEqual({ creates: 1, writes: 1 })
  })
  it('unconfirmed earlier write is never blindly repeated', async () => {
    const f = fixture(); f.loseAck()
    const failed = await f.coordinator.createTask(create)
    f.applied.clear()
    const resumed = await f.coordinator.resumePreparation({ taskId: failed.taskId, callerSessionId: 'controller' })
    expect(resumed.preparation).toBe('failed')
    expect(resumed.failureReason).toMatch(/not repeated/)
    expect(f.counts()).toEqual({ creates: 1, writes: 1 })
  })
})

describe('companion reader boundary', () => {
  it('requires callable reader and rejects a mismatched identity', async () => {
    expect(modelSelectionReaderOf({ readForSession: true })).toBeUndefined()
    const reader = { readForSession: async () => ({ sessionId: 'other', next: { provider: 'p', model: 'm' }, source: 'session_override' as const, persisted: true, effectiveAt: 'next_request' as const }) }
    await expect(readSessionSelection(reader, 'target')).rejects.toThrow(/invalid next-request/)
  })
})
