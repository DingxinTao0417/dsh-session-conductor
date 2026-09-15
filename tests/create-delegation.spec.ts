import { describe, expect, it, vi } from 'vitest'
import {
  artifactRegisterTool,
  artifactVerifyTool,
  createTool,
  forkTool,
  operationTool,
  readTool,
  waitTool,
  watchTool,
  type ConductorToolContext,
} from '../src/tools.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Coordinator, type CoordinatorDeps } from '../src/service/coordinator.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { AgentLike } from '../src/service/host.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

const parentExecution = { agent: { id: 'parent-session' }, callId: 'parent-call' } as never

type DescribedTool = {
  readonly description: string
  readonly parameters: { readonly properties: Record<string, { readonly description?: string }> }
  readonly output: { readonly schema: { readonly properties: Record<string, { readonly description?: string }> } }
}

function described(tool: ToolDefinition): DescribedTool {
  return tool as unknown as DescribedTool
}

function renderedText(tool: ToolDefinition, value: unknown): string {
  return tool.output.render({}, value as never)
    .map((block: ContentBlock) => block.type === 'text' ? block.text : '')
    .join('')
}

/** A context where any non-creation service access fails the test immediately. */
function coordinatorOnlyContext(
  method: 'createTask' | 'forkTask',
  result: Record<string, unknown>,
) {
  const invoke = vi.fn(async () => result)
  const unexpectedAccesses: string[] = []
  const context = new Proxy({
    coordinator: () => ({ [method]: invoke }),
  }, {
    get(target, key, receiver) {
      if (key === 'coordinator') return Reflect.get(target, key, receiver)
      unexpectedAccesses.push(String(key))
      throw new Error(`Unexpected follow-up service access: ${String(key)}`)
    },
  })
  return { context: context as unknown as ConductorToolContext, invoke, unexpectedAccesses }
}

/** A small real coordinator fixture for the durable first-message callback. */
function completionReturnFixture(options: { readonly flushSession?: CoordinatorDeps['flushSession'] } = {}) {
  const tables = createInMemoryTables()
  let tick = Date.parse('2026-09-15T00:00:00.000Z')
  let taskNumber = 0, sessionNumber = 0, bindingNumber = 0, messageNumber = 0
  const store = new ConductorStore(tables, () => new Date((tick += 1_000)).toISOString())
  const live = new Map<string, AgentLike>()
  const events = new Map<string, SessionEventLike[]>()
  const relays: { readonly id: string }[] = []
  const agents: CoordinatorDeps['agents'] = {
    async create(options) {
      const sessionEvents: SessionEventLike[] = []
      const agent: AgentLike = {
        id: options.sessionId,
        status: 'idle',
        session: {
          events: sessionEvents,
          get seq() { return sessionEvents.at(-1)?.seq ?? -1 },
          header: { cwd: 'D:\\work' },
        },
        inbox: { hasPending: false },
        followup(message) { relays.push(message as { readonly id: string }) },
        steer() {},
        cancel() {},
      }
      live.set(String(options.sessionId), agent)
      events.set(String(options.sessionId), sessionEvents)
      return { agent, dispose: async () => {} }
    },
    get: sessionId => live.get(String(sessionId)),
    list: () => [...live.values()],
  }
  const coordinator = new Coordinator({
    agents,
    store,
    createMessage: () => ({ id: `relay-${String(++messageNumber)}` }),
    newTaskId: () => `task-${String(++taskNumber)}`,
    newSessionId: () => `session-${String(++sessionNumber)}`,
    newBindingId: () => `binding-${String(++bindingNumber)}`,
    now: () => new Date((tick += 1_000)).toISOString(),
    defaultCwd: () => 'D:\\work',
    ...options.flushSession === undefined ? {} : { flushSession: options.flushSession },
  })
  return {
    coordinator,
    store,
    relays,
    eventsOf(sessionId: string): SessionEventLike[] { return events.get(sessionId)! },
  }
}

function expectExactInitialCallback(
  fixture: ReturnType<typeof completionReturnFixture>,
  taskId: string,
  operationId: string,
): void {
  const task = fixture.store.getTask(taskId)!
  const binding = fixture.store.getBinding(task.currentBindingId!)!
  const operation = fixture.store.getOperation(operationId)!
  const relay = fixture.relays.at(-1)!
  expect(task.completionReturn).toMatchObject({
    operationId,
    bindingId: binding.bindingId,
    bindingVersion: binding.version,
    messageId: operation.messageId,
    phase: 'armed',
  })
  expect(operation.messageId).toBe(relay.id)
  expect(task.completionReturn?.messageId).toBe(relay.id)
  expect(task.completionReturn?.armedAt).toMatch(/^2026-09-15T/)
}

describe('delegation-only create and fork contract', () => {
  it('puts the parent-stop rule in every relevant model-facing description', () => {
    const tools = [
      createTool({} as ConductorToolContext),
      forkTool({} as ConductorToolContext),
      readTool({} as ConductorToolContext),
      waitTool({} as ConductorToolContext),
      watchTool({} as ConductorToolContext),
      operationTool({} as ConductorToolContext),
      artifactVerifyTool({} as ConductorToolContext),
    ]
    for (const tool of tools) {
      const definition = described(tool)
      expect(definition.description).toContain('A successful create or fork is delegation-only by default')
      expect(definition.description).toContain('Do not repeat the delegated business work')
      expect(definition.description).toContain('does not restrict otherwise-authorized Host tools')
      expect(definition.description).toContain('one-shot completion return')
      expect(definition.description).toContain('does not wake the parent model or begin monitoring')
    }
    expect(described(readTool({} as ConductorToolContext)).description)
      .toContain('user explicitly asks the parent conversation to inspect')
    expect(described(waitTool({} as ConductorToolContext)).description)
      .toContain('user explicitly asks the parent conversation to monitor or wait')
    expect(described(watchTool({} as ConductorToolContext)).description)
      .toContain('user explicitly asks the parent conversation to monitor a task')
    expect(described(operationTool({} as ConductorToolContext)).description)
      .toContain('user explicitly asks the parent to do so')
    expect(described(artifactVerifyTool({} as ConductorToolContext)).description)
      .toContain('user explicitly asks the parent conversation to verify or review an artifact')
    expect(described(artifactRegisterTool({} as ConductorToolContext)).description)
      .toContain('creating or forking a task never implies an automatic check')
  })

  it('arms create and fork returns for the exact initial relay message and binding', async () => {
    const fixture = completionReturnFixture()
    const created = await fixture.coordinator.createTask({
      operationId: 'create-instructed', controllerSessionId: 'parent', title: 'Created child',
      contextMode: 'empty', instruction: 'Implement the parser.',
    })
    expectExactInitialCallback(fixture, created.taskId, 'create-instructed')

    const source = await fixture.coordinator.createTask({
      operationId: 'source', controllerSessionId: 'parent', title: 'Source', contextMode: 'empty',
    })
    fixture.eventsOf(source.sessionId!).push(
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    )
    const forked = await fixture.coordinator.forkTask({
      operationId: 'fork-instructed', callerSessionId: 'parent', sourceTaskId: source.taskId,
      title: 'Forked child', instruction: 'Continue from the completed turn.',
    })
    expectExactInitialCallback(fixture, forked.taskId, 'fork-instructed')
  })

  it('does not arm a completion return when create or fork has no nonempty initial instruction', async () => {
    const fixture = completionReturnFixture()
    const created = await fixture.coordinator.createTask({
      operationId: 'create-idle', controllerSessionId: 'parent', title: 'Idle child', contextMode: 'empty',
    })
    expect(fixture.store.getTask(created.taskId)?.completionReturn).toBeUndefined()
    expect(fixture.store.getOperation('create-idle')?.messageId).toBeUndefined()

    fixture.eventsOf(created.sessionId!).push(
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    )
    const forked = await fixture.coordinator.forkTask({
      operationId: 'fork-idle', callerSessionId: 'parent', sourceTaskId: created.taskId, title: 'Idle fork',
    })
    expect(fixture.store.getTask(forked.taskId)?.completionReturn).toBeUndefined()
    expect(fixture.store.getOperation('fork-idle')?.messageId).toBeUndefined()
    expect(fixture.relays).toEqual([])

    const empty = await fixture.coordinator.createTask({
      operationId: 'create-empty', controllerSessionId: 'parent', title: 'Empty child', contextMode: 'empty', instruction: '',
    })
    expect(fixture.store.getTask(empty.taskId)?.completionReturn).toBeUndefined()
    expect(fixture.store.getOperation('create-empty')).toMatchObject({ delivery: 'accepted', phase: 'ready' })
    expect(fixture.store.getOperation('create-empty')?.messageId).toBeUndefined()
    expect(fixture.relays).toEqual([])
    const emptyReplay = await fixture.coordinator.createTask({
      operationId: 'create-empty', controllerSessionId: 'parent', title: 'Empty child', contextMode: 'empty',
    })
    expect(emptyReplay).toMatchObject({ taskId: empty.taskId, replayed: true })

    const emptyFork = await fixture.coordinator.forkTask({
      operationId: 'fork-empty', callerSessionId: 'parent', sourceTaskId: created.taskId, title: 'Empty fork', instruction: '',
    })
    expect(fixture.store.getTask(emptyFork.taskId)?.completionReturn).toBeUndefined()
    expect(fixture.store.getOperation('fork-empty')).toMatchObject({ delivery: 'accepted', phase: 'ready' })
    const emptyForkReplay = await fixture.coordinator.forkTask({
      operationId: 'fork-empty', callerSessionId: 'parent', sourceTaskId: created.taskId, title: 'Empty fork',
    })
    expect(emptyForkReplay).toMatchObject({ taskId: emptyFork.taskId, replayed: true })
  })

  it('never lets a late flush failure overwrite an exact callback already returned by the Host', async () => {
    let store: ConductorStore | undefined
    const fixture = completionReturnFixture({
      flushSession: async () => {
        const task = store?.listTasks().at(-1)
        if (task?.completionReturn === undefined) throw new Error('test fixture did not arm the callback')
        await store!.updateTask(task.taskId, current => ({
          ...current,
          completionReturn: {
            ...current.completionReturn!, phase: 'returned', outcome: 'completed',
            detail: 'Host turn completed before flush rejected.',
            completedAt: '2026-09-15T00:10:00.000Z', updatedAt: '2026-09-15T00:10:00.000Z',
          },
        }))
        throw new Error('flush rejected after the Host completed the relay')
      },
    })
    store = fixture.store

    const created = await fixture.coordinator.createTask({
      operationId: 'flush-race', controllerSessionId: 'parent', title: 'Race child', contextMode: 'empty', instruction: 'Do the work.',
    })
    expect(fixture.store.getOperation('flush-race')).toMatchObject({ delivery: 'unknown' })
    expect(fixture.store.getTask(created.taskId)?.completionReturn).toMatchObject({
      operationId: 'flush-race', phase: 'returned', outcome: 'completed',
      detail: 'Host turn completed before flush rejected.',
    })
  })

  it('persists a card capability outside the idempotent request and replays the original bearer', async () => {
    const fixture = completionReturnFixture()
    const first = await fixture.coordinator.createTask({
      operationId: 'capability-replay', controllerSessionId: 'parent', title: 'Card child', contextMode: 'empty',
      sessionLinkCapability: 'a'.repeat(43),
    })
    const stored = fixture.store.getOperation('capability-replay')!
    expect(stored.sessionLinkCapability).toBe('a'.repeat(43))
    expect((stored.params as Record<string, unknown>).sessionLinkCapability).toBeUndefined()
    const replay = await fixture.coordinator.createTask({
      operationId: 'capability-replay', controllerSessionId: 'parent', title: 'Card child', contextMode: 'empty',
      // A retry must not replace the already-rendered card's capability.
      sessionLinkCapability: 'b'.repeat(43),
    })
    expect(replay).toMatchObject({ taskId: first.taskId, replayed: true, sessionLinkCapability: 'a'.repeat(43) })
  })

  it('makes create operation IDs opt-in for a later explicitly requested preparation action', () => {
    const definition = described(createTool({} as ConductorToolContext))
    expect(definition.parameters.properties.operationId?.description).toContain('does not ask the parent to inspect, wait for, or validate the child')
    expect(definition.output.schema.properties.operationId?.description)
      .toContain('Do not call status merely to validate a successful create')
  })

  it('invokes only creation and renders a front-loaded success boundary', async () => {
    const fixture = coordinatorOnlyContext('createTask', {
      taskId: 'child-task', operationId: 'parent-call', preparation: 'ready', preparationPhase: 'initial_message_accepted',
      sessionId: 'child-session', replayed: false,
    })
    const tool = createTool(fixture.context)
    const result = await tool.execute({ title: 'Delegate parser', instruction: 'Implement the parser change.' }, parentExecution) as {
      taskId: string
      operationId: string
      summary: string
    }

    expect(fixture.invoke).toHaveBeenCalledOnce()
    expect(fixture.invoke).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'parent-call', controllerSessionId: 'parent-session', title: 'Delegate parser',
      instruction: 'Implement the parser change.',
      sessionLinkCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    }))
    expect(fixture.unexpectedAccesses).toEqual([])
    expect(result.taskId).toBe('child-task')
    expect(result.operationId).toBe('parent-call')
    expect(result.summary).toMatch(/^Delegated task child-task created\. Default delegation is complete:/)
    expect(result.summary.indexOf('Default delegation is complete')).toBeLessThan(80)
    expect(result.summary).toContain('Do not repeat the delegated work')
    expect(renderedText(tool, result)).toBe(result.summary)
  })

  it('keeps a card capability in presentation metadata rather than its model-facing render', async () => {
    const capability = 'a'.repeat(43)
    const fixture = coordinatorOnlyContext('createTask', {
      taskId: 'child-task', operationId: 'parent-call', preparation: 'ready', preparationPhase: 'ready',
      sessionId: 'child-session', replayed: false, sessionLinkCapability: capability,
    })
    const tool = createTool(fixture.context)
    const result = await tool.execute({ title: 'Delegate parser' }, parentExecution) as { summary: string; sessionLinkCapability?: string }
    expect(result.sessionLinkCapability).toBe(capability)
    expect(renderedText(tool, result)).not.toContain(capability)
    expect(tool.output.presentationMeta?.({}, result as never)).toEqual({
      dshSessionConductor: { operationId: 'parent-call', capability },
    })
  })

  it('reports a create failure without treating it as a completed delegation or running follow-ups', async () => {
    const fixture = coordinatorOnlyContext('createTask', {
      taskId: 'failed-task', operationId: 'parent-call', preparation: 'failed', preparationPhase: 'workspace',
      failureReason: 'workspace creation was refused', replayed: false,
    })
    const tool = createTool(fixture.context)
    const result = await tool.execute({ title: 'Delegate parser' }, parentExecution) as { summary: string }

    expect(fixture.invoke).toHaveBeenCalledOnce()
    expect(fixture.unexpectedAccesses).toEqual([])
    expect(result.summary).toMatch(/^Delegation failed for task failed-task \(reached workspace\):/)
    expect(result.summary).toContain('No automatic parent work, status read, wait, watch, send, stop, or artifact verification was performed')
    expect(result.summary).not.toContain('Default delegation is complete')
    expect(renderedText(tool, result)).toBe(result.summary)
  })

  it('keeps fork creation-only, makes its operation ID opt-in, and front-loads the stop rule', async () => {
    const fixture = coordinatorOnlyContext('forkTask', {
      taskId: 'fork-task', operationId: 'parent-call', preparation: 'ready', preparationPhase: 'ready',
      sessionId: 'fork-session', replayed: false, sourceTaskId: 'source-task', sourceSessionId: 'source-session', cutoffSeq: 12,
    })
    const tool = forkTool(fixture.context)
    const definition = described(tool)
    const result = await tool.execute({ sourceTaskId: 'source-task', title: 'Fork parser' }, parentExecution) as { summary: string }

    expect(fixture.invoke).toHaveBeenCalledOnce()
    expect(fixture.invoke).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'parent-call', callerSessionId: 'parent-session', sourceTaskId: 'source-task', title: 'Fork parser',
      sessionLinkCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    }))
    expect(fixture.unexpectedAccesses).toEqual([])
    expect(definition.parameters.properties.operationId?.description).toContain('does not ask the parent to inspect, wait for, or validate the child')
    expect(definition.output.schema.properties.operationId?.description)
      .toContain('Do not call status merely to validate a successful fork')
    expect(result.summary).toMatch(/^Forked source-task into delegated task fork-task \(session fork-session\)\. Default delegation is complete:/)
    expect(result.summary.indexOf('Default delegation is complete')).toBeLessThan(100)
    expect(result.summary).toContain('forked from task source-task (session source-session) through event seq 12')
    expect(renderedText(tool, result)).toBe(result.summary)
  })

  it('reports a fork failure without treating it as a completed delegation or running follow-ups', async () => {
    const fixture = coordinatorOnlyContext('forkTask', {
      taskId: 'failed-fork', operationId: 'parent-call', preparation: 'failed', preparationPhase: 'copying_history',
      failureReason: 'source session is unavailable', replayed: false,
    })
    const tool = forkTool(fixture.context)
    const result = await tool.execute({ sourceTaskId: 'source-task' }, parentExecution) as { summary: string }

    expect(fixture.invoke).toHaveBeenCalledOnce()
    expect(fixture.unexpectedAccesses).toEqual([])
    expect(result.summary).toMatch(/^Delegated fork of source-task failed: source session is unavailable\./)
    expect(result.summary).toContain('No automatic parent work, status read, wait, watch, send, stop, or artifact verification was performed')
    expect(result.summary).not.toContain('Default delegation is complete')
    expect(renderedText(tool, result)).toBe(result.summary)
  })
})
