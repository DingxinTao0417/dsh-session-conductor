import { describe, expect, it } from 'vitest'
import {
  describeCompactSnapshot,
  describeProjection,
  historyOf,
  historySourceOf,
  initialProjection,
  interactionFromPending,
  interruptAnchorFieldsOf,
  lastTurnFieldsOf,
  outcomeOf,
  pendingInterventionFromWatches,
  pendingInterventionOf,
  projectEvents,
  readSnapshotFieldsOf,
} from '../src/service/projection.ts'
import { TaskObserver, isWake, watchKey } from '../src/service/observer.ts'
import type { SessionEventLike } from '../src/service/projection.ts'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import type { TaskRecord } from '../src/store/schema.ts'
import { newArtifactRecord } from '../src/service/artifacts.ts'

/** Build a Host-shaped session event. */
function event(seq: number, type: string, data: unknown = {}): SessionEventLike {
  return { type, seq, time: seq, data }
}

const start = (seq: number, turn: number) => event(seq, 'turn/start', { turn })
const end = (seq: number, turn: number, reason: unknown) => event(seq, 'turn/end', { turn, reason })

describe('turn outcome mapping (PRD §三.4)', () => {
  it('maps the Host reason kinds onto the documented outcomes', () => {
    expect(outcomeOf({ kind: 'completed' }).outcome).toBe('completed')
    expect(outcomeOf({ kind: 'blocked' }).outcome).toBe('blocked')
    expect(outcomeOf({ kind: 'aborted' }).outcome).toBe('interrupted')
    expect(outcomeOf({ kind: 'interrupted' }).outcome).toBe('interrupted')
    expect(outcomeOf({ kind: 'error', error: { code: 'X', message: 'boom' } })).toEqual({
      outcome: 'failed',
      detail: 'X: boom',
    })
  })

  it('reports a max-tokens stop as blocked, never as completed', () => {
    // A turn that stopped at a limit did not finish. Reporting it as completed
    // is the one answer the notification rules exist to prevent.
    expect(outcomeOf({ kind: 'max-tokens' }).outcome).toBe('blocked')
  })

  it('surfaces an unrecognized reason instead of assuming success', () => {
    const { outcome, detail } = outcomeOf({ kind: 'something-new' })
    expect(outcome).toBe('blocked')
    expect(detail).toMatch(/something-new/)
  })
})

describe('projection (PRD §三.5, state from Host facts)', () => {
  it('starts idle with no turn outcome', () => {
    const state = initialProjection()
    expect(state.execution).toBe('idle')
    expect(state.interaction).toBe('none')
    expect(state.lastTurn).toBeUndefined()
    expect(state.cursor).toBe(-1)
  })

  it('follows a whole turn', () => {
    const first = projectEvents(initialProjection(), [start(0, 1)])
    expect(first.state.execution).toBe('running')
    expect(first.state.turnsStarted).toBe(1)
    expect(first.state.openTurn).toBe(1)
    expect(first.state.openTurnStartSeq).toBe(0)
    expect(first.notable.map(n => n.kind)).toEqual(['turn_started'])

    const second = projectEvents(first.state, [end(1, 1, { kind: 'completed' })])
    expect(second.state.execution).toBe('idle')
    expect(second.state.lastTurn).toBe('completed')
    expect(second.state.openTurn).toBeUndefined()
    expect(second.state.openTurnStartSeq).toBeUndefined()
    expect(second.notable[0]).toMatchObject({ kind: 'turn_ended', outcome: 'completed' })
  })

  it('records a failed turn with its verbatim detail', () => {
    const { state } = projectEvents(initialProjection(), [
      start(0, 1),
      end(1, 1, { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key' } }),
    ])
    expect(state.lastTurn).toBe('failed')
    expect(state.lastTurnDetail).toBe('MISSING_CREDENTIAL: no API key')
    expect(lastTurnFieldsOf(state)).toEqual({
      lastTurn: 'failed',
      lastTurnDetail: 'MISSING_CREDENTIAL: no API key',
    })
    expect(lastTurnFieldsOf(initialProjection())).toEqual({})
    expect(interruptAnchorFieldsOf(initialProjection())).toEqual({})
    expect(readSnapshotFieldsOf(initialProjection())).toEqual({ execution: 'idle' })
  })

  it('is idempotent: re-folding the same window changes nothing', () => {
    const events = [start(0, 1), end(1, 1, { kind: 'completed' })]
    const once = projectEvents(initialProjection(), events)
    const twice = projectEvents(once.state, events)
    expect(twice.state).toEqual(once.state)
    expect(twice.notable).toEqual([])
  })

  it('counts each turn once when a reader replays from a persisted cursor', () => {
    const events = [start(0, 1), end(1, 1, { kind: 'completed' }), start(2, 2)]
    const resumed = projectEvents({ ...initialProjection(), cursor: 1 }, events)
    expect(resumed.state.turnsStarted).toBe(1)
    expect(resumed.state.execution).toBe('running')
    expect(resumed.state.openTurn).toBe(2)
    expect(resumed.state.openTurnStartSeq).toBe(2)
  })

  it('raises interaction on an approval request and clears it when decided', () => {
    const asked = projectEvents(initialProjection(), [event(0, 'approval/asked', { id: 'a1', toolName: 'bash' })])
    expect(asked.state.interaction).toBe('waiting_approval')
    expect(asked.notable[0]).toEqual({ kind: 'approval_asked', approvalId: 'a1', toolName: 'bash' })

    const decided = projectEvents(asked.state, [event(1, 'approval/decided', { id: 'a1', outcome: 'allowed-once' })])
    expect(decided.state.interaction).toBe('none')
  })

  it('reads a question from the call to the tool that asks one, and ignores every other call', () => {
    // The installed Host's SessionEventMap has no question event and its TurnEndReasonMap no "waiting"
    // reason — both were read to establish that. What the log does carry is the tool call.
    const asked = projectEvents(initialProjection(), [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' }),
    ])
    expect(asked.notable.map(entry => entry.kind)).toEqual(['turn_started', 'user_question'])
    expect(asked.notable[1]).toEqual({ kind: 'user_question', callId: 'c1', toolName: 'ask_user_question' })
    // A question does not change the execution dimension: the turn is still running while it waits.
    expect(asked.state.execution).toBe('running')
    expect(asked.state.interaction).toBe('waiting_input')
    expect(asked.state.waitingCallId).toBe('c1')

    const answered = projectEvents(asked.state, [
      event(2, 'tool/result', { callId: 'c1', message: { content: [{ type: 'text', text: 'yes' }] } }),
    ])
    expect(answered.state.interaction).toBe('none')
    expect(answered.state.waitingCallId).toBeUndefined()
    expect(answered.state.execution).toBe('running')

    const otherResult = projectEvents(asked.state, [
      event(2, 'tool/result', { callId: 'other', message: { content: [{ type: 'text', text: 'not the answer' }] } }),
    ])
    expect(otherResult.state.interaction).toBe('waiting_input')
    expect(otherResult.state.waitingCallId).toBe('c1')

    // Every other tool call is the target's own business. A notice per call would bury the controller.
    const ordinary = projectEvents(initialProjection(), [
      event(0, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{}' }),
      // A name that merely contains the word is not a question either.
      event(1, 'tool/call', { turn: 1, step: 1, callId: 'c3', name: 'ask_about_files', arguments: '{}' }),
    ])
    expect(ordinary.notable).toEqual([])
  })

  it('only turn ends, approval requests and questions wake a waiting reader', () => {
    expect(isWake({ kind: 'turn_ended', turn: 1, outcome: 'completed', detail: 'completed' })).toBe(true)
    expect(isWake({ kind: 'approval_asked', approvalId: 'a' })).toBe(true)
    // A target blocked on an answer will not proceed without one, so a wait that ignored this would keep
    // waiting while the work is stopped.
    expect(isWake({ kind: 'user_question', callId: 'c1', toolName: 'ask_user_question' })).toBe(true)
    // A turn starting is progress, not something the specification wakes for.
    expect(isWake({ kind: 'turn_started', turn: 1 })).toBe(false)
  })
})

describe('readable history (PRD §二.7, §四.2, T11)', () => {
  it('projects user, assistant and tool activity', () => {
    expect(historyOf(event(0, 'user/message', { content: [{ type: 'text', text: 'do the thing' }] })))
      .toEqual({ seq: 0, kind: 'user', text: 'do the thing', source: 'unknown' })
    expect(historyOf(event(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } })))
      .toEqual({ seq: 1, kind: 'assistant', text: 'done' })
    expect(historyOf(event(2, 'tool/call', { name: 'read', arguments: '{}' }))?.kind).toBe('tool_call')
    expect(historyOf(event(3, 'tool/result', { message: { content: [{ type: 'text', text: 'ok' }] } }))?.kind).toBe('tool_result')
  })

  it('keeps native-interface, relay and notice input distinguishable', () => {
    expect(historySourceOf({ kind: 'user' })).toBe('user')
    expect(historySourceOf({ kind: 'plugin', plugin: 'dsh-session-conductor', form: 'relay' })).toBe('relay')
    expect(historySourceOf({ kind: 'plugin', plugin: 'dsh-session-conductor', form: 'notice', summary: 'ok' })).toBe('notice')
    expect(historySourceOf({ kind: 'plugin', plugin: 'other', form: 'snapshot' })).toBe('plugin')
    expect(historySourceOf(undefined)).toBe('unknown')
    const native = historyOf(event(0, 'user/message', {
      content: [{ type: 'text', text: 'typed in the original session' }],
      source: { kind: 'user' },
    }))
    const relay = historyOf(event(1, 'user/message', {
      content: [{ type: 'text', text: 'forwarded from the controller' }],
      source: { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'relay' },
    }))
    const notice = historyOf(event(2, 'user/message', {
      content: [{ type: 'text', text: 'observed on 1 task' }],
      source: { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'notice', summary: 'observed' },
    }))
    expect(native).toMatchObject({ kind: 'user', source: 'user' })
    expect(relay).toMatchObject({ kind: 'user', source: 'relay' })
    expect(notice).toMatchObject({ kind: 'user', source: 'notice' })
    expect(native?.text).toBe('typed in the original session')
    expect(relay?.text).toBe('forwarded from the controller')
  })

  it('never projects the raw token stream', () => {
    // PRD §二.7: raw token streams must not trigger a report to the controller.
    expect(historyOf(event(0, 'assistant/chunk', { chunk: { type: 'text-delta', text: 'par' } }))).toBeUndefined()
    expect(historyOf(event(1, 'step/start', { turn: 1, step: 1 }))).toBeUndefined()
  })

  it('marks a shortened history entry rather than silently cutting it', () => {
    const long = 'x'.repeat(1000)
    const entry = historyOf(event(0, 'user/message', { content: [{ type: 'text', text: long }] }))
    expect(entry?.text).toMatch(/\[truncated\]/)
  })

  it('names the open turn as the interrupt anchor, and omits it once that turn ends', () => {
    const running = projectEvents(initialProjection(), [start(3, 2)]).state
    expect(describeProjection(running)).toMatch(/open turn=2 at seq 3/)
    expect(readSnapshotFieldsOf(running)).toEqual({
      execution: 'running',
      expectedTurn: 2,
      expectedStartSeq: 3,
    })
    const idle = projectEvents(running, [end(4, 2, { kind: 'completed' })]).state
    expect(describeProjection(idle)).not.toMatch(/open turn=/)
    expect(readSnapshotFieldsOf(idle)).toEqual({
      execution: 'idle',
      lastTurn: 'completed',
      lastTurnDetail: 'completed',
    })
  })

  it('renders a compact snapshot naming every dimension', () => {
    const { state } = projectEvents(initialProjection(), [end(0, 1, { kind: 'completed' })])
    const text = describeProjection(state)
    expect(text).toMatch(/execution=idle/)
    expect(text).toMatch(/interaction=none/)
    expect(text).toMatch(/last turn=completed/)
  })

  it('adds pending intervention and an artifact summary to the compact snapshot (PRD §二.7)', () => {
    const { state } = projectEvents(initialProjection(), [end(0, 1, { kind: 'completed' })])
    expect(describeCompactSnapshot(state, { total: 0, present: 0, checkPassed: 0, userAccepted: 0, changed: 0 }))
      .toMatch(/pending=nothing waiting on a person/)
    expect(describeCompactSnapshot(state, { total: 0, present: 0, checkPassed: 0, userAccepted: 0, changed: 0 }))
      .toMatch(/0 artifact\(s\), 0 verified present, 0 检查通过 and 0 用户验收/)
    expect(describeCompactSnapshot(
      { ...state, interaction: 'waiting_approval' },
      { total: 2, present: 1, checkPassed: 0, userAccepted: 1, changed: 1 },
    )).toMatch(/pending=waiting: waiting_approval/)
    expect(describeCompactSnapshot(
      { ...state, interaction: 'waiting_approval' },
      { total: 2, present: 1, checkPassed: 0, userAccepted: 1, changed: 1 },
    )).toMatch(/2 artifact\(s\), 1 verified present, 1 changed, 0 检查通过 and 1 用户验收/)
    expect(describeCompactSnapshot(state)).toMatch(/artifact summary unavailable/)
  })

  it('stores waiting_input and waiting_approval as Watch 待介入事项, and omits none', () => {
    expect(pendingInterventionOf('none')).toBeUndefined()
    expect(pendingInterventionOf('waiting_input')).toBe('waiting_input')
    expect(pendingInterventionOf('waiting_approval')).toBe('waiting_approval')
  })

  it('restores only the two named waits from a stored watch field', () => {
    expect(interactionFromPending(undefined)).toBe('none')
    expect(interactionFromPending('waiting_input')).toBe('waiting_input')
    expect(interactionFromPending('waiting_approval')).toBe('waiting_approval')
    expect(interactionFromPending('something-else')).toBe('none')
  })

  it('reads a stored pending intervention from any watch on that task', () => {
    expect(pendingInterventionFromWatches([
      { taskId: 'other', pendingIntervention: 'waiting_approval' },
      { taskId: 'task-1' },
      { taskId: 'task-1', pendingIntervention: 'waiting_input' },
    ], 'task-1')).toBe('waiting_input')
    expect(pendingInterventionFromWatches([{ taskId: 'task-1' }], 'task-1')).toBeUndefined()
  })
})

describe('observer cursors and waiting', () => {
  /** A store with one ready task bound to a live fake session. */
  function setup() {
    const tables = createInMemoryTables()
    let tick = Date.parse('2026-09-13T00:00:00.000Z')
    const store = new ConductorStore(tables, () => new Date((tick += 1000)).toISOString())
    const task: TaskRecord = {
      taskId: 'task-1', title: 't', pinned: false, archived: false,
      controllerSessionId: 'controller', requestedBy: 'user', contextMode: 'brief',
      preparation: 'ready', preparationPhase: 'ready', currentBindingId: 'b1',
      createdAt: 'now', updatedAt: 'now',
    }
    const sessions = new Map<string, { events: SessionEventLike[]; seq: number }>()
    const agents = { get: (id: unknown) => { const session = sessions.get(String(id)); return session === undefined ? undefined : { id, session } } }
    return {
      store,
      tables,
      agents,
      sessions,
      /** Seed the task and its live session together. */
      async seed(events: SessionEventLike[] = []) {
        await store.createTask(task)
        await store.putBinding({
          bindingId: 'b1', taskId: 'task-1', hostId: 'local', sessionId: 'session-1',
          version: 1, createdAt: 'now',
        })
        await store.putAccess({
          taskId: 'task-1',
          ownerSessionId: 'controller',
          ownerEpoch: 0,
          observerSessionIds: [],
          updatedAt: 'now',
        })
        sessions.set('session-1', { events, seq: events.length - 1 })
      },
    }
  }

  it('reports a task with no binding yet instead of failing', () => {
    const { store, agents } = setup()
    const observer = new TaskObserver({ agents, store })
    const snapshot = observer.snapshot('task-1')
    expect(snapshot.error).toMatch(/no managed task/)
  })

  it('reads a live session and advances only the reader that asked for history', async () => {
    const { store, agents, seed } = setup()
    await seed([event(0, 'user/message', { content: [{ type: 'text', text: 'hello' }] })])
    const observer = new TaskObserver({ agents, store })

    const first = await observer.read('task-1', 'controller', { view: 'history', limit: 10 })
    expect(first.history.map(h => h.text)).toEqual(['hello'])
    expect(first.cursor).toBe('0')
    expect(first.sessionId).toBe('session-1')
    expect(first.bindingVersion).toBe(1)
    expect(first.ownerEpoch).toBe(0)

    // A snapshot read reports state and consumes nothing, even for the reader
    // that already has a cursor: opening a panel must not swallow unread work.
    const snapshot = await observer.read('task-1', 'observer-1', { view: 'snapshot' })
    expect(snapshot.history).toEqual([])
    expect(store.getWatch(watchKey('observer-1', 'task-1'))).toBeUndefined()
    expect(snapshot.cursor).toBe('-1')
    expect(snapshot.artifacts).toEqual({ total: 0, present: 0, checkPassed: 0, userAccepted: 0, changed: 0 })

    // Another reader with its own history cursor still sees the message.
    const other = await observer.read('task-1', 'observer-2', { view: 'history' })
    expect(other.history.map(h => h.text)).toEqual(['hello'])
    expect(store.getWatch(watchKey('controller', 'task-1'))?.historyCursor).toBe('0')
    expect(store.getWatch(watchKey('controller', 'task-1'))?.watchEnabled).toBe(false)

    // Re-reading history for the same reader reports nothing new.
    const again = await observer.read('task-1', 'controller', { view: 'history' })
    expect(again.history).toEqual([])
  })

  it('fills the compact snapshot\'s artifact summary from durable records', async () => {
    const { store, agents, seed } = setup()
    await seed([])
    await store.putArtifact({
      ...newArtifactRecord({
        artifactId: 'a-present', taskId: 'task-1', kind: 'file', name: 'ok.md', hostId: 'local', path: 'ok.md',
      }, 'now'),
      existence: 'present',
      acceptance: 'pass',
      acceptedBy: 'user',
    })
    await store.putArtifact({
      ...newArtifactRecord({
        artifactId: 'a-changed', taskId: 'task-1', kind: 'file', name: 'old.md', hostId: 'local', path: 'old.md',
      }, 'now'),
      existence: 'changed',
      acceptance: 'pending',
    })
    await store.putArtifact({
      ...newArtifactRecord({
        artifactId: 'a-review', taskId: 'task-1', kind: 'file', name: 'review.md', hostId: 'local', path: 'review.md',
      }, 'now'),
      existence: 'present',
      acceptance: 'pass',
      acceptedBy: 'model_review',
    })
    const observer = new TaskObserver({ agents, store })
    const snapshot = await observer.read('task-1', 'controller', { view: 'snapshot' })
    expect(snapshot.artifacts).toEqual({
      total: 3, present: 2, checkPassed: 0, userAccepted: 1, changed: 1,
    })
  })

  it('marks a truncated history window and does not skip the remainder', async () => {
    const { store, agents, seed } = setup()
    await seed([
      event(0, 'user/message', { content: [{ type: 'text', text: 'one' }] }),
      event(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'two' }] } }),
      event(2, 'user/message', { content: [{ type: 'text', text: 'three' }] }),
    ])
    const observer = new TaskObserver({ agents, store })
    const first = await observer.read('task-1', 'controller', { view: 'history', limit: 2 })
    expect(first.history.map(h => h.text)).toEqual(['one', 'two'])
    expect(first.truncated).toBe(true)

    const second = await observer.read('task-1', 'controller', { view: 'history', limit: 2 })
    expect(second.history.map(h => h.text)).toEqual(['three'])
    expect(second.truncated).toBe(false)
  })

  it('uses the configured default read amount when the caller does not pass a limit', async () => {
    const { store, agents, seed } = setup()
    await seed([
      event(0, 'user/message', { content: [{ type: 'text', text: 'one' }] }),
      event(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'two' }] } }),
      event(2, 'user/message', { content: [{ type: 'text', text: 'three' }] }),
    ])
    const observer = new TaskObserver({ agents, store, defaultReadLimit: 2 })
    const first = await observer.read('task-1', 'controller', { view: 'history' })
    expect(first.history.map(h => h.text)).toEqual(['one', 'two'])
    expect(first.truncated).toBe(true)

    const explicit = new TaskObserver({ agents, store, defaultReadLimit: 2 })
    const one = await explicit.read('task-1', 'other', { view: 'history', limit: 1 })
    expect(one.history.map(h => h.text)).toEqual(['one'])
    expect(one.truncated).toBe(true)

    const published = new TaskObserver({ agents, store })
    const all = await published.read('task-1', 'third', { view: 'history' })
    expect(all.history).toHaveLength(3)
    expect(all.truncated).toBe(false)
  })

  it('keeps native-interface and controller input distinguishable on a history read', async () => {
    const { store, agents, seed } = setup()
    await seed([
      event(0, 'user/message', {
        content: [{ type: 'text', text: 'typed in the original session' }],
        source: { kind: 'user' },
      }),
      event(1, 'user/message', {
        content: [{ type: 'text', text: 'forwarded from the controller' }],
        source: { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'relay' },
      }),
      event(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }),
    ])
    const observer = new TaskObserver({ agents, store })
    const first = await observer.read('task-1', 'controller', { view: 'history' })
    expect(first.history.map(entry => ({ kind: entry.kind, source: entry.source, text: entry.text }))).toEqual([
      { kind: 'user', source: 'user', text: 'typed in the original session' },
      { kind: 'user', source: 'relay', text: 'forwarded from the controller' },
      { kind: 'assistant', source: undefined, text: 'done' },
    ])
  })

  it('returns an immediate snapshot for a zero timeout', async () => {
    const { store, agents, seed } = setup()
    await seed([start(0, 1)])
    const observer = new TaskObserver({ agents, store })
    const result = await observer.wait([{ taskId: 'task-1' }], 'controller', 0)
    // Nothing has ended a turn, so there is nothing to wake for: the call
    // answers with the state it can see right now.
    expect(result.timedOut).toBe(true)
    expect(result.targets[0]?.state?.execution).toBe('running')
  })

  it('returns as soon as one target ends a turn, and reports the others as unchanged', async () => {
    const { store, agents, seed } = setup()
    await seed([start(0, 1)])
    // A second task on its own session, already finished.
    await store.createTask({
      taskId: 'task-2', title: 't2', pinned: false, archived: false,
      controllerSessionId: 'controller', requestedBy: 'user', contextMode: 'brief',
      preparation: 'ready', preparationPhase: 'ready', currentBindingId: 'b2',
      createdAt: 'now', updatedAt: 'now',
    })
    await store.putBinding({
      bindingId: 'b2', taskId: 'task-2', hostId: 'local', sessionId: 'session-2', version: 1, createdAt: 'now',
    })
    const observer = new TaskObserver({ agents, store })
    // Session 2 has already completed a turn before the wait begins.
    const sessions = new Map<string, { events: unknown[]; seq: number }>()
    void sessions
    agents.get = (id: unknown) => ({ id, session: id === 'session-2'
      ? { events: [start(0, 1), end(1, 1, { kind: 'completed' })], seq: 1 }
      : { events: [start(0, 1)], seq: 0 } })

    const result = await observer.wait([{ taskId: 'task-1' }, { taskId: 'task-2' }], 'controller', 5000)
    expect(result.timedOut).toBe(false)
    expect(result.ending).toBe('woke')
    const woken = result.targets.find(t => t.wake !== undefined)
    expect(woken?.taskId).toBe('task-2')
    expect(result.targets.find(t => t.taskId === 'task-1')?.wake).toBeUndefined()
  })

  it('preserves a resumed target\'s running facts when another target wakes the wait', async () => {
    const { store, agents, seed } = setup()
    await seed([start(0, 7), event(1, 'tool/call', { name: 'ask_user_question', callId: 'question-1' })])
    const observer = new TaskObserver({ agents, store })
    // task-1's approval/question event was already seen; a distinct target now completes.
    await store.createTask({
      taskId: 'task-2', title: 't2', pinned: false, archived: false,
      controllerSessionId: 'controller', requestedBy: 'user', contextMode: 'brief',
      preparation: 'ready', preparationPhase: 'ready', currentBindingId: 'b2',
      createdAt: 'now', updatedAt: 'now',
    })
    await store.putBinding({
      bindingId: 'b2', taskId: 'task-2', hostId: 'local', sessionId: 'session-2', version: 1, createdAt: 'now',
    })
    const originalGet = agents.get
    agents.get = (id: unknown) => id === 'session-2'
      ? { id, session: { events: [start(0, 1), end(1, 1, { kind: 'completed' })], seq: 1 } }
      : originalGet(id)
    const result = await observer.wait([
      { taskId: 'task-1', afterCursor: '1' }, { taskId: 'task-2' },
    ], 'controller', 0)
    expect(result.ending).toBe('woke')
    expect(result.targets[0]?.wake).toBeUndefined()
    expect(result.targets[0]?.state).toMatchObject({
      execution: 'running', interaction: 'waiting_input', openTurn: 7, openTurnStartSeq: 0, turnsStarted: 1,
    })
  })

  it('ends when a person speaks, and says so rather than reporting a quiet system', async () => {
    // PRD §二.7's 用户新输入可结束等待. The ending is its own fact: "nothing happened for 60 seconds" and
    // "the user took the wheel" are opposite things to tell a reader.
    const { store, agents, seed } = setup()
    await seed([start(0, 1)])
    // A driven clock, because the point is that the wait ends **long before** its deadline: with the real
    // clock and an instant sleep the loop would spin for a minute and then time out, which is the failure
    // this test would be unable to distinguish from a working interruption.
    let ticks = 0
    const observer = new TaskObserver({
      agents,
      store,
      now: () => ticks * 1000,
      sleep: async () => { ticks += 1 },
    })
    const result = await observer.wait([{ taskId: 'task-1' }], 'controller', 60_000, {
      // The person speaks after three polls, far inside the 60-second deadline.
      userSpoke: () => ticks >= 3,
    })
    expect(result.ending).toBe('user_spoke')
    expect(result.timedOut).toBe(false)
    // It still reports where every target got to, and advances the cursor, so continuing costs nothing.
    expect(result.targets[0]?.state?.execution).toBe('running')
    expect(result.targets[0]?.cursor).toBe('0')
  })

  it('ends when the Host cancels the call, and keeps that apart from the user speaking', async () => {
    const { store, agents, seed } = setup()
    await seed([start(0, 1)])
    const observer = new TaskObserver({ agents, store, sleep: async () => { await Promise.resolve() } })
    const controller = new AbortController()
    controller.abort()
    const result = await observer.wait([{ taskId: 'task-1' }], 'controller', 60_000, {
      signal: controller.signal,
    })
    expect(result.ending).toBe('cancelled')
    expect(result.timedOut).toBe(false)
    expect(result.targets[0]?.cursor).toBe('0')
  })

  it('reports a wake in preference to an interruption that arrived at the same moment', async () => {
    // The interruption decides whether to keep *waiting*, not whether to discard what has already been
    // observed: a turn that ended in the same instant a person spoke is a fact with content.
    const { store, agents, seed } = setup()
    await seed([start(0, 1), end(1, 1, { kind: 'completed' })])
    const observer = new TaskObserver({ agents, store, sleep: async () => { await Promise.resolve() } })
    const controller = new AbortController()
    controller.abort()
    const result = await observer.wait([{ taskId: 'task-1' }], 'controller', 60_000, {
      signal: controller.signal,
      userSpoke: () => true,
    })
    expect(result.ending).toBe('woke')
    expect(result.targets[0]?.wake?.kind).toBe('turn_ended')
  })

  it('cannot be ended by an interruption the caller cannot supply', async () => {
    // No signal and no predicate means nobody can cancel the call, and the wait must still time out on its
    // own deadline rather than returning early with an ending it did not observe.
    const { store, agents, seed } = setup()
    await seed([start(0, 1)])
    const observer = new TaskObserver({ agents, store, sleep: async () => { await Promise.resolve() } })
    const result = await observer.wait([{ taskId: 'task-1' }], 'controller', 0)
    expect(result.ending).toBe('timed_out')
    expect(result.timedOut).toBe(true)
  })

  it('does not re-report an event the reader already consumed', async () => {
    const { store, agents, seed } = setup()
    await seed([start(0, 1), end(1, 1, { kind: 'completed' })])
    const observer = new TaskObserver({ agents, store })

    // The reader has seen nothing, so the finished turn is reported once.
    const first = await observer.wait([{ taskId: 'task-1' }], 'controller', 0)
    expect(first.timedOut).toBe(false)
    expect(first.targets[0]?.wake).toMatchObject({ kind: 'turn_ended', outcome: 'completed' })
    expect(store.getWatch(watchKey('controller', 'task-1'))?.waitCursor).toBe('1')

    // The second wait must not re-announce the same turn end; it reports the
    // state and reaches its deadline instead.
    const second = await observer.wait([{ taskId: 'task-1' }], 'controller', 0)
    expect(second.timedOut).toBe(true)
    expect(second.targets[0]?.wake).toBeUndefined()
    expect(second.targets[0]?.state?.lastTurn).toBe('completed')
  })

  it('keeps the completed public result available after wait has consumed its own wake cursor', async () => {
    const { store, agents, seed } = setup()
    await seed([
      event(0, 'user/message', { content: [{ type: 'text', text: 'check the implementation' }] }),
      event(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'the implementation is complete' }] } }),
      start(2, 1),
      end(3, 1, { kind: 'completed' }),
    ])
    const observer = new TaskObserver({ agents, store })

    const waited = await observer.wait([{ taskId: 'task-1' }], 'controller', 0)
    expect(waited.ending).toBe('woke')
    expect(store.getWatch(watchKey('controller', 'task-1'))?.waitCursor).toBe('3')
    expect(store.getWatch(watchKey('controller', 'task-1'))?.historyCursor).toBeUndefined()

    const history = await observer.read('task-1', 'controller', { view: 'history' })
    expect(history.history.map(entry => entry.text)).toEqual([
      'check the implementation',
      'the implementation is complete',
    ])
    expect(store.getWatch(watchKey('controller', 'task-1'))?.historyCursor).toBe('1')
    expect((await observer.read('task-1', 'controller', { view: 'history' })).history).toEqual([])
  })

  it('replays direct history from a legacy shared-cursor watch instead of treating reports as history reads', async () => {
    const { store, agents, seed } = setup()
    await seed([event(0, 'assistant/message', { message: { content: [{ type: 'text', text: 'legacy result' }] } })])
    await store.putWatch(watchKey('controller', 'task-1'), {
      controllerSessionId: 'controller', taskId: 'task-1', cursor: '0', deliveredEventIds: [],
      createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
    })
    const observer = new TaskObserver({ agents, store })
    const history = await observer.read('task-1', 'controller', { view: 'history' })
    expect(history.history.map(entry => entry.text)).toEqual(['legacy result'])
    expect(store.getWatch(watchKey('controller', 'task-1'))?.historyCursor).toBe('0')
  })

  it('reports one unreadable target as that target’s own error', async () => {
    const { store, agents, seed } = setup()
    await seed([])
    const observer = new TaskObserver({ agents, store })
    const result = await observer.wait([{ taskId: 'task-1' }, { taskId: 'missing' }], 'controller', 0)
    expect(result.targets[0]?.error).toBeUndefined()
    expect(result.targets[1]?.error).toMatch(/no managed task/)
  })

  it('reports a target whose session is no longer live', async () => {
    const { store, seed } = setup()
    await seed([])
    const observer = new TaskObserver({ agents: { get: () => undefined }, store })
    const snapshot = observer.snapshot('task-1')
    expect(snapshot.error).toMatch(/not live in this Host/)
  })

  it('reads a cold task through the detached persisted-history reader without making it live', async () => {
    const { store, seed } = setup()
    await seed([])
    let reads = 0
    const observer = new TaskObserver({
      agents: { get: () => undefined },
      store,
      readPersistedSession: async (sessionId) => {
        reads += 1
        return {
          session: { id: sessionId },
          events: [
            event(0, 'user/message', { content: [{ type: 'text', text: 'cold request' }] }),
            event(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'cold result' }] } }),
            start(2, 1), end(3, 1, { kind: 'completed' }),
          ],
        }
      },
    })

    const history = await observer.read('task-1', 'controller', { view: 'history' })
    expect(history.history.map(entry => entry.text)).toEqual(['cold request', 'cold result'])
    expect(history.historyOrigin).toBe('persisted')
    expect(history.bindingVersion).toBeUndefined()
    expect(history.ownerEpoch).toBeUndefined()
    expect(store.getWatch(watchKey('controller', 'task-1'))?.historyCursor).toBe('1')
    expect(reads).toBe(1)

    const snapshot = await observer.read('task-1', 'controller', { view: 'snapshot' })
    expect(snapshot.error).toMatch(/not live in this Host/)
    const waited = await observer.wait([{ taskId: 'task-1' }], 'controller', 0)
    expect(waited.targets[0]?.error).toMatch(/not live in this Host/)
    expect(reads).toBe(1)
  })

  it('does not advance a cold-history cursor when its binding changes while the persisted log is loading', async () => {
    const { store, seed } = setup()
    await seed([])
    let release!: () => void
    const loaded = new Promise<void>(resolve => { release = resolve })
    const observer = new TaskObserver({
      agents: { get: () => undefined },
      store,
      readPersistedSession: async (sessionId) => {
        await loaded
        return {
          session: { id: sessionId },
          events: [event(0, 'assistant/message', { message: { content: [{ type: 'text', text: 'do not leak' }] } })],
        }
      },
    })
    const pending = observer.read('task-1', 'controller', { view: 'history' })
    await Promise.resolve()
    await store.putBinding({ ...store.getBinding('b1')!, version: 2 })
    release()
    const result = await pending
    expect(result.error).toMatch(/STALE_BINDING/)
    expect(result.history).toEqual([])
    expect(store.getWatch(watchKey('controller', 'task-1'))).toBeUndefined()
  })

  it('still shows a stored 待介入事项 when the session is not live (T14)', async () => {
    const { store, seed } = setup()
    await seed([])
    await store.putWatch(watchKey('controller', 'task-1'), {
      controllerSessionId: 'controller',
      taskId: 'task-1',
      cursor: '0',
      deliveredEventIds: [],
      pendingIntervention: 'waiting_input',
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    })
    const observer = new TaskObserver({ agents: { get: () => undefined }, store })
    expect(observer.snapshot('task-1').state.interaction).toBe('waiting_input')
    const reading = await observer.read('task-1', 'controller')
    expect(reading.error).toMatch(/not live in this Host/)
    expect(reading.state.interaction).toBe('waiting_input')
    const other = await observer.read('task-1', 'someone-else')
    expect(other.state.interaction).toBe('none')
  })

  it('wait still shows a stored 待介入 alongside the not-live error (T14)', async () => {
    const { store, seed } = setup()
    await seed([])
    await store.putWatch(watchKey('controller', 'task-1'), {
      controllerSessionId: 'controller',
      taskId: 'task-1',
      cursor: '0',
      deliveredEventIds: [],
      pendingIntervention: 'waiting_approval',
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    })
    const observer = new TaskObserver({ agents: { get: () => undefined }, store })
    const result = await observer.wait([{ taskId: 'task-1' }], 'controller', 0)
    expect(result.targets[0]?.error).toMatch(/not live in this Host/)
    expect(result.targets[0]?.state?.interaction).toBe('waiting_approval')
    expect(result.targets[0]?.wake).toBeUndefined()
    const missing = await observer.wait([{ taskId: 'missing' }], 'controller', 0)
    expect(missing.targets[0]?.error).toMatch(/no managed task/)
    expect(missing.targets[0]?.state).toBeUndefined()
  })
})
