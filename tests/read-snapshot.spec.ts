import { describe, expect, it, vi } from 'vitest'
import { handoffTool, readTool, sendTool, waitTool, type ConductorToolContext } from '../src/tools.ts'
import { initialProjection, projectEvents } from '../src/service/projection.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

/** Build a Host-shaped session event. */
function event(seq: number, type: string, data: unknown = {}): SessionEventLike {
  return { type, seq, time: seq, data }
}

describe('conductor_read compact snapshot (PRD §二.6 / §二.7)', () => {
  it('returns expectedTurn and expectedStartSeq for an open turn, ready to pass to stop', async () => {
    const running = projectEvents(initialProjection(), [
      event(0, 'turn/start', { turn: 2 }),
    ]).state
    const tool = readTool({
      observer: () => ({
        read: async () => ({
          taskId: 'task-1',
          sessionId: 'session-1',
          bindingVersion: 3,
          ownerEpoch: 4,
          state: running,
          cursor: '0',
          history: [],
          truncated: false,
        }),
      }),
    } as unknown as ConductorToolContext)
    const out = await tool.execute({ taskId: 'task-1', view: 'snapshot' }, { agent: { id: 'controller' }, callId: 'c1' } as never) as {
      execution?: string
      expectedTurn?: number
      expectedStartSeq?: number
      lastTurn?: string
      state: string
      sessionId?: string
      bindingVersion?: number
      ownerEpoch?: number
      summary?: string
    }
    expect(out.execution).toBe('running')
    expect(out.expectedTurn).toBe(2)
    expect(out.expectedStartSeq).toBe(0)
    expect(out.lastTurn).toBeUndefined()
    expect(out.state).toMatch(/open turn=2 at seq 0/)
    expect(out.sessionId).toBe('session-1')
    expect(out.bindingVersion).toBe(3)
    expect(out.ownerEpoch).toBe(4)
    expect(out.summary).toContain('control epoch 4')
  })

  it('omits the interrupt anchor between turns and keeps 最近进展 structured', async () => {
    const idle = projectEvents(initialProjection(), [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key' } } }),
    ]).state
    const tool = readTool({
      observer: () => ({
        read: async () => ({
          taskId: 'task-1',
          sessionId: 'session-1',
          state: idle,
          cursor: '1',
          history: [],
          truncated: false,
        }),
      }),
    } as unknown as ConductorToolContext)
    const out = await tool.execute({ taskId: 'task-1', view: 'snapshot' }, { agent: { id: 'controller' }, callId: 'c1' } as never) as {
      execution?: string
      lastTurn?: string
      lastTurnDetail?: string
      expectedTurn?: number
      expectedStartSeq?: number
    }
    expect(out.execution).toBe('idle')
    expect(out.lastTurn).toBe('failed')
    expect(out.lastTurnDetail).toBe('MISSING_CREDENTIAL: no API key')
    expect(out.expectedTurn).toBeUndefined()
    expect(out.expectedStartSeq).toBeUndefined()
  })

  it('renders direct public history, instead of only a count summary', async () => {
    const read = vi.fn().mockResolvedValue({
      taskId: 'task-1',
      sessionId: 'session-1',
      state: initialProjection(),
      cursor: '9',
      history: [
        { seq: 7, kind: 'user', source: 'relay', text: 'Please check parser progress.' },
        { seq: 8, kind: 'tool_call', text: 'read({"path":"src/parser.ts"})' },
        { seq: 9, kind: 'assistant', text: 'The parser change is ready for review.' },
      ],
      truncated: true,
    })
    const tool = readTool({ observer: () => ({ read }) } as unknown as ConductorToolContext)

    const out = await tool.execute(
      { taskId: 'task-1', view: 'history' },
      { agent: { id: 'controller' }, callId: 'history-default' } as never,
    ) as { history: readonly { text: string }[]; summary: string; cursor: string; truncated: boolean }
    const rendered = tool.output.render({}, out as never)
      .map(block => block.type === 'text' ? block.text : '')
      .join('')

    expect(read).toHaveBeenCalledWith('task-1', 'controller', { view: 'history', limit: 18 })
    expect(out.history.map(entry => entry.text)).toEqual([
      'Please check parser progress.',
      'read({"path":"src/parser.ts"})',
      'The parser change is ready for review.',
    ])
    expect(rendered).toContain('Public persisted records from the target session')
    expect(rendered).toContain('[7|user|relay]')
    expect(rendered).toContain('Please check parser progress.')
    expect(rendered).toContain('read({"path":"src/parser.ts"})')
    expect(rendered).toContain('The parser change is ready for review.')
    expect(rendered).toContain('More records remain after cursor 9')
  })

  it('caps history before reading so every rendered record and its cursor remain visible', async () => {
    const entries = Array.from({ length: 20 }, (_, seq) => ({
      seq,
      kind: 'assistant',
      text: `entry-${String(seq)} ${'x'.repeat(460)}`,
    }))
    const read = vi.fn(async (_task: string, _reader: string, options: {
      view?: 'snapshot' | 'history'
      afterCursor?: string
      limit?: number
    }) => {
      const after = Number(options.afterCursor ?? '-1')
      const remaining = entries.filter(entry => entry.seq > after)
      const history = options.view === 'history' ? remaining.slice(0, options.limit ?? 20) : []
      const cursor = history.at(-1)?.seq ?? after
      return {
        taskId: 'task-1', sessionId: 'session-1', state: initialProjection(), cursor: String(cursor),
        history, truncated: remaining.length > history.length,
      }
    })
    const tool = readTool({
      observer: () => ({ read }),
      textLimit: () => 12_000,
      defaultReadLimit: () => 20,
    } as unknown as ConductorToolContext)

    const first = await tool.execute(
      { taskId: 'task-1', view: 'history' },
      { agent: { id: 'controller' }, callId: 'budget-first' } as never,
    ) as { cursor: string; history: readonly { seq: number }[]; truncated: boolean; summary: string }
    const firstText = tool.output.render({}, first as never)
      .map(block => block.type === 'text' ? block.text : '')
      .join('')

    expect(read).toHaveBeenLastCalledWith('task-1', 'controller', { view: 'history', limit: 18 })
    expect(first.history).toHaveLength(18)
    expect(first.cursor).toBe('17')
    expect(first.truncated).toBe(true)
    expect(firstText.length).toBeLessThanOrEqual(12_000)
    expect(firstText).toContain('entry-17')
    expect(firstText).toContain('after cursor 17')

    const second = await tool.execute(
      { taskId: 'task-1', view: 'history', afterCursor: first.cursor },
      { agent: { id: 'controller' }, callId: 'budget-second' } as never,
    ) as { cursor: string; history: readonly { seq: number }[]; truncated: boolean }
    expect(second.history.map(entry => entry.seq)).toEqual([18, 19])
    expect(second.cursor).toBe('19')
    expect(second.truncated).toBe(false)
  })

  it('does not consume history when the configured output budget cannot fit one complete record', async () => {
    const read = vi.fn().mockResolvedValue({
      taskId: 'task-1', sessionId: 'session-1', state: initialProjection(), cursor: '-1', history: [], truncated: false,
    })
    const tool = readTool({
      observer: () => ({ read }),
      textLimit: () => 1_000,
      defaultReadLimit: () => 20,
    } as unknown as ConductorToolContext)
    const out = await tool.execute(
      { taskId: 'task-1', view: 'history' },
      { agent: { id: 'controller' }, callId: 'budget-none' } as never,
    ) as { history: readonly unknown[]; truncated: boolean; summary: string }

    expect(read).toHaveBeenCalledWith('task-1', 'controller', { view: 'snapshot' })
    expect(out.history).toEqual([])
    expect(out.truncated).toBe(true)
    expect(out.summary).toContain('history cursor was not advanced')
  })

  it('wait targets carry the same interrupt anchor as a snapshot', async () => {
    const running = projectEvents(initialProjection(), [
      event(5, 'turn/start', { turn: 4 }),
    ]).state
    const tool = waitTool({
      waitLimitMs: () => 60_000,
      userInputWatch: () => undefined,
      observer: () => ({
        wait: async () => ({
          timedOut: true,
          ending: 'timed_out',
          targets: [{
            taskId: 'task-1',
            cursor: '5',
            state: running,
            sessionId: 'session-1',
            bindingVersion: 2,
            ownerEpoch: 7,
          }],
        }),
      }),
    } as unknown as ConductorToolContext)
    const out = await tool.execute(
      { targets: [{ taskId: 'task-1' }], timeoutMs: 0 },
      { agent: { id: 'controller' }, callId: 'c1' } as never,
    ) as {
      targets: readonly {
        expectedTurn?: number
        expectedStartSeq?: number
        execution?: string
        sessionId?: string
        bindingVersion?: number
        ownerEpoch?: number
      }[]
    }
    expect(out.targets[0]?.expectedTurn).toBe(4)
    expect(out.targets[0]?.expectedStartSeq).toBe(5)
    expect(out.targets[0]?.execution).toBe('running')
    expect(out.targets[0]?.sessionId).toBe('session-1')
    expect(out.targets[0]?.bindingVersion).toBe(2)
    expect(out.targets[0]?.ownerEpoch).toBe(7)
  })

  it('passes expectedBindingVersion through conductor_send so a retired binding can be refused', async () => {
    const sent: unknown[] = []
    const tool = sendTool({
      interruptLimitMs: () => 30_000,
      coordinator: () => ({
        send: async (request: unknown) => {
          sent.push(request)
          return { taskId: 'task-1', mode: 'steer', delivery: 'accepted' }
        },
      }),
    } as unknown as ConductorToolContext)
    await tool.execute(
      { taskId: 'task-1', text: 'hi', expectedBindingVersion: 1 },
      { agent: { id: 'controller' }, callId: 'c1' } as never,
    )
    expect(sent[0]).toMatchObject({
      taskId: 'task-1',
      text: 'hi',
      expectedBindingVersion: 1,
      callerSessionId: 'controller',
    })
  })

  it('passes expectedOwnerEpoch through conductor_send so a retired epoch can be refused', async () => {
    const sent: unknown[] = []
    const tool = sendTool({
      interruptLimitMs: () => 30_000,
      coordinator: () => ({
        send: async (request: unknown) => {
          sent.push(request)
          return { taskId: 'task-1', mode: 'steer', delivery: 'accepted' }
        },
      }),
    } as unknown as ConductorToolContext)
    await tool.execute(
      { taskId: 'task-1', text: 'hi', expectedOwnerEpoch: 2 },
      { agent: { id: 'controller' }, callId: 'c1' } as never,
    )
    expect(sent[0]).toMatchObject({
      taskId: 'task-1',
      expectedOwnerEpoch: 2,
      callerSessionId: 'controller',
    })
  })

  it('passes expectedBindingVersion and expectedOwnerEpoch through conductor_handoff', async () => {
    const sent: unknown[] = []
    const tool = handoffTool({
      interruptLimitMs: () => 30_000,
      handoff: async (request: unknown) => {
        sent.push(request)
        return {
          taskId: 'task-1',
          succeeded: true,
          reached: 'switching_binding',
          preconditions: { checked: [], unchecked: [] },
        }
      },
    } as unknown as ConductorToolContext)
    await tool.execute(
      { taskId: 'task-1', targetPath: 'D:\\target', expectedBindingVersion: 1, expectedOwnerEpoch: 0 },
      { agent: { id: 'controller' }, callId: 'c1' } as never,
    )
    expect(sent[0]).toMatchObject({
      taskId: 'task-1',
      targetPath: 'D:\\target',
      expectedBindingVersion: 1,
      expectedOwnerEpoch: 0,
      callerSessionId: 'controller',
    })
  })
})
