import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Coordinator, type CoordinatorDeps } from '../src/service/coordinator.ts'
import { parentEnvironmentOf, setCreatedSessionTitle, type ParentEnvironment } from '../src/service/creation-environment.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { AgentLike } from '../src/service/host.ts'

function fixture() {
  const tables = createInMemoryTables(), store = new ConductorStore(tables)
  const live = new Map<string, AgentLike>(), calls: string[] = []
  let environment: ParentEnvironment = { cwd: 'D:/parent-project', workspaceId: 'parent-workspace' }
  let id = 0, failAttach = false
  const lookup = vi.fn(() => environment)
  const deps: CoordinatorDeps = {
    store, now: () => new Date().toISOString(), newTaskId: () => `task-${++id}`, newSessionId: () => `session-${++id}`, newBindingId: () => `binding-${++id}`,
    createMessage: () => ({ id: 'message' }), defaultCwd: () => 'D:/wrong-global-directory', parentEnvironment: lookup,
    agents: {
      get: session => live.get(String(session)), list: () => [...live.values()],
      async create(options) {
        const agent: AgentLike = { id: options.sessionId, status: 'idle', session: { events: [], seq: 0, header: { cwd: options.meta?.cwd } }, followup() { calls.push('send') }, steer() { calls.push('send') }, inject() {}, cancel() {} }
        live.set(String(agent.id), agent); calls.push('create'); return { agent, dispose: async () => {} }
      },
    },
    workspaces: { register: async () => ({ ok: false, reason: 'should reuse parent workspace' }), attach: async (workspace, session) => { calls.push(`attach:${workspace}:${session}`); return failAttach ? { ok: false, reason: 'workspace removed' } : { ok: true } } },
    setSessionTitle: async (_agent, title) => { calls.push(`title:${title.trim()}`); return title.trim() },
  }
  return { store, deps, live, calls, lookup, coordinator: new Coordinator(deps), moveParent() { environment = { cwd: 'D:/changed', workspaceId: 'different-workspace' } }, breakAttach() { failAttach = true }, restoreAttach() { failAttach = false } }
}

describe('initiating workspace and chosen native title', () => {
  it('inherits the initiating directory and workspace, naming before the first instruction', async () => {
    const f = fixture()
    const result = await f.coordinator.createTask({ operationId: 'create', controllerSessionId: 'parent', title: '  主窗口命名  ', contextMode: 'empty', instruction: 'read only' })
    expect(result.preparation).toBe('ready')
    expect(result.workspace).toMatchObject({ path: 'D:/parent-project', workspaceId: 'parent-workspace', created: false })
    expect(f.live.get(result.sessionId!)?.session?.header).toEqual({ cwd: 'D:/parent-project' })
    expect(f.store.getTask(result.taskId)?.title).toBe('主窗口命名')
    expect(f.calls.indexOf('title:主窗口命名')).toBeLessThan(f.calls.indexOf('send'))
    expect(f.calls.some(call => call.startsWith('attach:parent-workspace:'))).toBe(true)
    f.moveParent()
    expect((await f.coordinator.createTask({ operationId: 'create', controllerSessionId: 'parent', title: '  主窗口命名  ', contextMode: 'empty', instruction: 'read only' })).sessionId).toBe(result.sessionId)
    expect(f.lookup).toHaveBeenCalledTimes(1)
  })
  it('keeps the captured workspace when a failed attachment is resumed after the parent moves', async () => {
    const f = fixture(); f.breakAttach()
    const result = await f.coordinator.createTask({ operationId: 'create', controllerSessionId: 'parent', title: 'Chosen', contextMode: 'empty' })
    expect(result.preparation).toBe('failed')
    expect(f.calls).not.toContain('send')
    f.moveParent(); f.restoreAttach()
    const resumed = await f.coordinator.resumePreparation({ taskId: result.taskId, operationId: 'create', callerSessionId: 'parent' })
    expect(resumed.preparation).toBe('ready')
    expect(f.calls.filter(call => call === 'create')).toHaveLength(1)
    expect(f.calls.filter(call => call.startsWith('title:'))).toHaveLength(1)
    expect(f.calls.at(-1)).toBe(`attach:parent-workspace:${result.sessionId}`)
  })
  it('respects an explicit directory and does not reassign it to the parent workspace', async () => {
    const f = fixture()
    const result = await f.coordinator.createTask({ operationId: 'create', controllerSessionId: 'parent', title: 'Explicit', contextMode: 'empty', cwd: 'D:/explicit-project' })
    expect(result.preparation).toBe('ready')
    expect(f.lookup).not.toHaveBeenCalled()
    expect(f.calls.some(call => call.startsWith('attach:'))).toBe(false)
    expect(f.live.get(result.sessionId!)?.session?.header).toEqual({ cwd: 'D:/explicit-project' })
  })
  it('changes both titles only after checking the controller', async () => {
    const f = fixture(), task = await f.coordinator.createTask({ operationId: 'create', controllerSessionId: 'parent', title: 'First', contextMode: 'empty' })
    await expect(f.coordinator.updateTask({ taskId: task.taskId, callerSessionId: 'other', title: 'Wrong' })).rejects.toThrow()
    expect(f.calls).not.toContain('title:Wrong')
    await f.coordinator.updateTask({ taskId: task.taskId, callerSessionId: 'parent', title: 'Second' })
    expect(f.calls).toContain('title:Second')
    expect(f.store.getTask(task.taskId)?.title).toBe('Second')
  })
  it('reads membership by session ID, including when another workspace has the same-looking directory', () => {
    const services: Record<string, unknown> = { agents: { get: () => ({ session: { header: { cwd: 'D:/actual' } } }) }, workspaceRegistry: { list: () => [{ id: 'wrong', path: 'D:/actual', sessionIds: ['other'] }, { id: 'correct', path: 'D:/actual', sessionIds: ['parent'] }] } }
    expect(parentEnvironmentOf({ get: name => services[name] }, 'parent')).toEqual({ cwd: 'D:/actual', workspaceId: 'correct' })
    services['agents'] = { get: () => undefined }
    expect(() => parentEnvironmentOf({ get: name => services[name] }, 'parent')).toThrow('PARENT_DIRECTORY_UNAVAILABLE')
  })
  it('flushes a title accepted by the public Host naming service', async () => {
    const f = fixture(), task = await f.coordinator.createTask({ operationId: 'create', controllerSessionId: 'parent', title: 'First', contextMode: 'empty' })
    const rename = vi.fn(() => ({ title: 'Accepted' })), flush = vi.fn(async () => {})
    const services: Record<string, unknown> = { sessionTitle: { rename }, sessions: { flush } }
    const agent = f.deps.agents.get(SessionId(task.sessionId!))!
    expect(await setCreatedSessionTitle({ get: name => services[name] }, agent, 'Requested')).toBe('Accepted')
    expect(rename).toHaveBeenCalledWith(agent.session, 'Requested')
    expect(flush).toHaveBeenCalledWith(agent.session)
  })
})
