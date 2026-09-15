import { describe, expect, it } from 'vitest'
import {
  NOTICE_TRIGGERED_REFUSAL,
  REPORTABLE_OUTCOMES,
  REPORT_KINDS,
  deliveryFor,
  externalFact,
  factsOf,
  mergeReports,
  needsIntervention,
  notableFactsOf,
  renderReport,
  storedFactsOf,
  type ReportFact,
} from '../src/service/report.ts'
import { turnOriginOf } from '../src/service/barrier.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

const T0 = Date.parse('2026-09-13T12:00:00.000Z')
const TARGET = { taskId: 'task-1', sessionId: 'session-1' }

/** A `turn/end` event. */
function turnEnd(seq: number, outcome: string, at = T0): SessionEventLike {
  return { type: 'turn/end', seq, time: at, data: { turn: 1, outcome, reason: { kind: outcome } } }
}

/** An `approval/asked` event. */
function approvalAsked(seq: number, at = T0): SessionEventLike {
  return { type: 'approval/asked', seq, time: at, data: { id: 'approval-1', toolName: 'write_file' } }
}

/** A fact at a given offset from T0. */
function fact(at: number, over: Partial<ReportFact> = {}): ReportFact {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    eventId: `event-${String(at)}`,
    seq: 1,
    at,
    kind: 'turn_ended',
    outcome: 'completed',
    summary: 'turn ended',
    ...over,
  }
}

describe('choosing what is worth reporting (PRD §二.8.1)', () => {
  it('reports a turn that ended, failed, was interrupted or was blocked', () => {
    for (const outcome of REPORTABLE_OUTCOMES) {
      const facts = factsOf(TARGET, [turnEnd(5, outcome)])
      expect(facts).toHaveLength(1)
      expect(facts[0]?.outcome).toBe(outcome)
      expect(facts[0]?.eventId).toBe('session-1#5')
    }
  })

  it('does not report a turn that merely started, and never a token stream', () => {
    const events: SessionEventLike[] = [
      { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } },
      { type: 'assistant/chunk', seq: 2, time: T0, data: { chunk: { text: 'partial' } } },
      { type: 'assistant/message', seq: 3, time: T0, data: { message: { content: 'done' } } },
    ]
    expect(factsOf(TARGET, events)).toEqual([])
  })

  it('reports a new approval as something needing intervention', () => {
    const facts = factsOf(TARGET, [approvalAsked(3)])
    expect(facts).toHaveLength(1)
    expect(facts[0]?.kind).toBe('needs_intervention')
    expect(needsIntervention(facts[0]!)).toBe(true)
  })

  it('ignores everything at or before the reader’s cursor', () => {
    const events = [turnEnd(2, 'completed'), turnEnd(7, 'failed')]
    expect(factsOf(TARGET, events, 2).map(entry => entry.seq)).toEqual([7])
    expect(factsOf(TARGET, events, 7)).toEqual([])
  })

  it('gives one fact a stable identity across repeated folds of the same log', () => {
    const events = [turnEnd(4, 'completed')]
    const first = factsOf(TARGET, events)
    const second = factsOf(TARGET, events)
    expect(first[0]?.eventId).toBe(second[0]?.eventId)
  })

  it('prefers the projection’s own reading of a turn end over a second one', () => {
    // The projection maps a token ceiling to `blocked`; a report must agree with
    // what every other reader says about the same event.
    const facts = notableFactsOf(TARGET, [
      { event: { kind: 'turn_started', turn: 1 }, seq: 1, at: T0 },
      { event: { kind: 'turn_ended', turn: 1, outcome: 'blocked', detail: 'max-tokens' }, seq: 2, at: T0 },
    ])
    expect(facts).toHaveLength(1)
    expect(facts[0]?.outcome).toBe('blocked')
    expect(facts[0]?.summary).toContain('max-tokens')
  })

  it('does not turn a started turn into a fact, even through the projection', () => {
    expect(notableFactsOf(TARGET, [{ event: { kind: 'turn_started', turn: 1 }, seq: 1, at: T0 }])).toEqual([])
  })

  it('gives an externally observed fact no position in the target’s stream', () => {
    // Inventing a seq would corrupt the reader's cursor, so an external fact
    // carries -1 and is identified by its own event id instead.
    const observed = externalFact({
      taskId: 'task-1', sessionId: 'session-1', eventId: 'artifact-7@v2', at: T0,
      kind: 'artifact_missing', summary: 'artifact 7 is missing',
    })
    expect(observed.seq).toBe(-1)
    expect(observed.eventId).toBe('artifact-7@v2')
    expect(needsIntervention(observed)).toBe(true)
  })
})

describe('facts the store already holds (PRD §二.8.1)', () => {
  /** One stored artifact, `present` unless a test says otherwise. */
  function artifact(over: Partial<Parameters<typeof storedFactsOf>[1]['artifacts'][number]> = {}) {
    return {
      artifactId: 'artifact-1',
      name: 'report.md',
      kind: 'file',
      existence: 'present',
      contentVersion: 0,
      observedAt: '2026-09-13T12:00:00.000Z',
      ...over,
    }
  }

  /** One stored transfer with no conflicts unless a test says otherwise. */
  function transfer(over: Partial<Parameters<typeof storedFactsOf>[1]['transfers'][number]> = {}) {
    return {
      transferId: 'transfer-1',
      artifactId: 'artifact-1',
      fromTaskId: 'task-1',
      toTaskId: 'task-2',
      conflicts: [] as readonly string[],
      applied: false,
      updatedAt: '2026-09-13T12:00:00.000Z',
      ...over,
    }
  }

  const call = (input: Partial<Parameters<typeof storedFactsOf>[1]>) =>
    storedFactsOf(TARGET, { artifacts: [], transfers: [], budgets: [], workflows: [], nowMs: T0, ...input })

  it('reports an artifact that was verified missing or changed, and stays quiet about the rest', () => {
    const facts = call({
      artifacts: [
        artifact({ artifactId: 'a-present', existence: 'present' }),
        // A claim is not a fact: reporting it would turn "someone said this exists" into news.
        artifact({ artifactId: 'a-claimed', existence: 'claimed' }),
        artifact({ artifactId: 'a-missing', existence: 'missing' }),
        artifact({ artifactId: 'a-changed', existence: 'changed', contentVersion: 3 }),
      ],
    })
    expect(facts.map(entry => entry.kind)).toEqual(['artifact_missing', 'artifact_changed'])
    expect(facts.every(entry => entry.seq === -1)).toBe(true)
    expect(facts.every(entry => entry.taskId === 'task-1')).toBe(true)
    // The id is a function of the record, so a re-read recognises the same fact...
    expect(facts[0]?.eventId).toBe('a-missing:missing:v0')
    // ...and a *new* problem is not mistaken for the old one, because the version moved.
    expect(facts[1]?.eventId).toBe('a-changed:changed:v3')
    expect(facts.every(entry => needsIntervention(entry))).toBe(true)
    expect(facts[0]?.summary).toMatch(/recorded as missing/)
  })

  it('reports a transfer that recorded conflicts, on either side of the handoff', () => {
    const facts = call({
      transfers: [
        transfer({ transferId: 't-clean' }),
        transfer({ transferId: 't-applied', conflicts: ['the receiver changed the file'], applied: true }),
        transfer({ transferId: 't-stopped', conflicts: ['baseline differs', 'and another'], applied: false }),
      ],
    })
    expect(facts.map(entry => entry.eventId)).toEqual([
      't-applied:conflict:2026-09-13T12:00:00.000Z',
      't-stopped:conflict:2026-09-13T12:00:00.000Z',
    ])
    expect(facts[0]?.kind).toBe('handoff_conflict')
    // "Applied anyway" and "not applied" are different situations and the summary says which.
    expect(facts[0]?.summary).toMatch(/applied anyway/)
    expect(facts[1]?.summary).toMatch(/not applied/)
    expect(facts[1]?.summary).toMatch(/baseline differs/)
    expect(facts[1]?.summary).toMatch(/2 conflict\(s\)/)
    expect(facts.every(entry => entry.seq === -1)).toBe(true)
  })

  it('places a fact at the instant the record was observed, not at the instant it was read', () => {
    const facts = call({ artifacts: [artifact({ existence: 'missing', observedAt: '2026-09-13T12:00:05.000Z' })] })
    expect(facts[0]?.at).toBe(Date.parse('2026-09-13T12:00:05.000Z'))

    // An unparseable timestamp falls back to the observation instant rather than to epoch zero, which
    // would form its own merge window and read as ancient history.
    const unparseable = call({
      nowMs: T0 + 7000,
      artifacts: [artifact({ existence: 'missing', observedAt: 'not a timestamp' })],
    })
    expect(unparseable[0]?.at).toBe(T0 + 7000)
  })

  it('says nothing when the store holds nothing worth reporting', () => {
    expect(call({})).toEqual([])
    expect(call({ artifacts: [artifact()], transfers: [transfer()] })).toEqual([])
  })

  it('reports a governing budget that refuses, with the run anchor in its identity', () => {
    // The decision is handed in rather than recomputed: `budgetDecision` is the one implementation of what
    // a limit means, so a notice cannot disagree with the gate that actually stops dispatches.
    const refused = call({
      budgets: [{
        policyKey: 'task budget task-1',
        limit: 'dispatches',
        reason: 'the run has dispatched 1 time(s), its maximum',
        firstDispatchedAt: '2026-09-13T11:00:00.000Z',
      }],
    })
    expect(refused).toHaveLength(1)
    expect(refused[0]?.kind).toBe('budget_limited')
    expect(refused[0]?.eventId).toBe('task budget task-1:budget:dispatches:2026-09-13T11:00:00.000Z')
    expect(refused[0]?.summary).toMatch(/no longer permits automatic work/)
    // A counter limit records no instant, so the observation time is used rather than an invented one.
    expect(refused[0]?.at).toBe(T0)
    expect(needsIntervention(refused[0] as ReportFact)).toBe(true)

    // A deadline *does* fix the instant the limit was reached, and that is the one the fact carries.
    const deadline = call({
      budgets: [{
        policyKey: 'task budget task-1',
        limit: 'deadline',
        reason: 'the wall-clock deadline has passed',
        reachedAt: '2026-09-13T11:30:00.000Z',
      }],
    })
    expect(deadline[0]?.at).toBe(Date.parse('2026-09-13T11:30:00.000Z'))
    // A different run on the same policy is a different fact, because the ledger anchor moved.
    const nextRun = call({
      budgets: [{
        policyKey: 'task budget task-1',
        limit: 'dispatches',
        reason: 'the run has dispatched 2 time(s), its maximum',
        firstDispatchedAt: '2026-09-13T13:00:00.000Z',
      }],
    })
    expect(nextRun[0]?.eventId).not.toBe(refused[0]?.eventId)
  })

  it('reports a workflow run that stopped for the user, and one that holds a failed node', () => {
    const stuck = call({
      workflows: [{
        runId: 'run-1',
        workflowId: 'workflow-1',
        status: 'needs_user',
        blockedNodeIds: ['build', 'ship'],
        updatedAt: '2026-09-13T12:00:00.000Z',
      }],
    })
    expect(stuck).toHaveLength(1)
    expect(stuck[0]?.kind).toBe('workflow_blocked')
    expect(stuck[0]?.eventId).toBe('run-1:workflow:needs_user:build+ship')
    expect(stuck[0]?.summary).toMatch(/stopped for the user/)
    expect(needsIntervention(stuck[0] as ReportFact)).toBe(true)

    const failed = call({
      workflows: [{
        runId: 'run-2',
        workflowId: 'workflow-1',
        status: 'running',
        blockedNodeIds: ['verify'],
        updatedAt: '2026-09-13T12:05:00.000Z',
      }],
    })
    expect(failed[0]?.summary).toMatch(/holds stuck nodes/)
    // The identity names the status and the nodes, so a different node getting stuck later is a new fact
    // while a re-read of the same stuck run is the same one.
    expect(failed[0]?.eventId).toBe('run-2:workflow:running:verify')
  })

  it('tells the three new kinds apart from the ones that already existed', () => {
    // Every kind is its own fact rather than a severity: a caller filtering the notice needs to see a
    // question, a stuck workflow and a spent budget as three different things.
    expect(REPORT_KINDS).toContain('user_question')
    expect(REPORT_KINDS).toContain('workflow_blocked')
    expect(REPORT_KINDS).toContain('budget_limited')
    expect(new Set(REPORT_KINDS).size).toBe(REPORT_KINDS.length)
  })
})

describe('the facts a session log carries about a question (PRD §二.8.1)', () => {
  it('reports the call to the tool that asks the user, and nothing else a target calls', () => {
    // The installed Host's vocabulary has no question event (it was read to establish that, not assumed),
    // so the signal is the call to the tool that asks one.
    const asked = notableFactsOf(TARGET, [{
      seq: 7,
      at: T0,
      event: { kind: 'user_question', callId: 'call-9', toolName: 'ask_user_question' },
    }])
    expect(asked).toHaveLength(1)
    expect(asked[0]?.kind).toBe('user_question')
    expect(asked[0]?.summary).toMatch(/asked its user a question \(ask_user_question call call-9\)/)
    expect(asked[0]?.eventId).toBe('session-1#7')
    expect(needsIntervention(asked[0] as ReportFact)).toBe(true)

    // A turn that started is still not a fact, and the new kind did not loosen that.
    const started = notableFactsOf(TARGET, [{ seq: 8, at: T0, event: { kind: 'turn_started', turn: 1 } }])
    expect(started).toEqual([])
  })
})

describe('merging reports per controller (PRD §二.8.1)', () => {
  it('merges events within the window into one report', () => {
    const reports = mergeReports(new Map([['controller', [fact(T0), fact(T0 + 1500)]]]), 2000)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.facts).toHaveLength(2)
    expect(reports[0]?.from).toBe(T0)
    expect(reports[0]?.until).toBe(T0 + 1500)
  })

  it('does not merge an event that falls outside the window', () => {
    const reports = mergeReports(new Map([['controller', [fact(T0), fact(T0 + 5000)]]]), 2000)
    expect(reports).toHaveLength(2)
  })

  it('merges across tasks, because the window is about the session being woken', () => {
    const reports = mergeReports(new Map([['controller', [
      fact(T0, { taskId: 'task-a' }),
      fact(T0 + 500, { taskId: 'task-b', eventId: 'other' }),
    ]]]), 2000)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.taskIds).toEqual(['task-a', 'task-b'])
  })

  it('keeps separate controllers separate', () => {
    const reports = mergeReports(new Map([
      ['alice', [fact(T0)]],
      ['bob', [fact(T0)]],
    ]), 2000)
    expect(reports.map(report => report.controllerSessionId).sort()).toEqual(['alice', 'bob'])
  })

  it('marks a window as needing a decision when any fact in it does', () => {
    const reports = mergeReports(new Map([['controller', [
      fact(T0),
      fact(T0 + 100, { kind: 'handoff_conflict', eventId: 'conflict', summary: 'the patch conflicted' }),
    ]]]), 2000)
    expect(reports[0]?.intervention).toBe(true)
  })

  it('orders the facts inside a window by time, whatever order they arrived in', () => {
    const reports = mergeReports(new Map([['controller', [fact(T0 + 900), fact(T0)]]]), 2000)
    expect(reports[0]?.facts.map(entry => entry.at)).toEqual([T0, T0 + 900])
  })
})

describe('deciding whether to speak (PRD §二.8.1)', () => {
  it('stays silent when there is nothing to report', () => {
    expect(deliveryFor('idle', undefined)).toBe('silent')
    expect(deliveryFor('running', undefined)).toBe('silent')
    expect(deliveryFor('idle', {
      controllerSessionId: 'c', facts: [], from: T0, until: T0, taskIds: [], intervention: false,
    })).toBe('silent')
  })

  it('wakes an idle controller and queues for a running one without interrupting it', () => {
    const report = { controllerSessionId: 'c', facts: [fact(T0)], from: T0, until: T0, taskIds: ['task-1'], intervention: false }
    expect(deliveryFor('idle', report)).toBe('wake')
    expect(deliveryFor('running', report)).toBe('queue')
  })
})

describe('rendering a report (PRD §二.8.1)', () => {
  it('names the tasks, lists the facts and says whether a decision is needed', () => {
    const reports = mergeReports(new Map([['controller', [fact(T0), fact(T0 + 100, { kind: 'turn_ended', outcome: 'failed' })]]]), 2000)
    const text = renderReport(reports[0]!)
    expect(text).toContain('task task-1')
    expect(text).toContain('[turn_ended]')
    expect(text).toContain('No decision is needed')
  })

  it('says a decision is needed when one is', () => {
    const reports = mergeReports(new Map([['controller', [
      fact(T0, { kind: 'target_unavailable', summary: 'the target session is gone' }),
    ]]]), 2000)
    expect(renderReport(reports[0]!)).toContain('needs a decision')
  })

  it('states that a report is an observation and not an authorisation', () => {
    const reports = mergeReports(new Map([['controller', [fact(T0)]]]), 2000)
    const text = renderReport(reports[0]!)
    expect(text).toContain('observation, not an instruction')
    expect(text).toContain('refused by the server')
  })

  it('counts several tasks rather than naming only the first', () => {
    const reports = mergeReports(new Map([['controller', [
      fact(T0, { taskId: 'task-a' }),
      fact(T0 + 10, { taskId: 'task-b', eventId: 'b' }),
    ]]]), 2000)
    expect(renderReport(reports[0]!)).toContain('2 tasks')
  })
})

describe('the report-triggered write barrier (PRD §二.8.1)', () => {
  /** A `user/message` event carrying a source. */
  function prompt(seq: number, source: unknown): SessionEventLike {
    return { type: 'user/message', seq, data: { id: `msg-${String(seq)}`, role: 'user', content: [], source } }
  }

  it('refuses an execution opened by a conductor report', () => {
    const origin = turnOriginOf([
      prompt(1, { kind: 'user' }),
      turnEnd(2, 'completed'),
      prompt(3, { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'notice', summary: 'turn 1 ended' }),
    ])
    expect(origin.reportTriggered).toBe(true)
    expect(origin.reason).toMatch(/conductor notice report/)
  })

  it('refuses it for another plugin’s notice too, because a report is a report', () => {
    const origin = turnOriginOf([prompt(1, { kind: 'plugin', plugin: 'some-other-plugin', form: 'notice', summary: 'x' })])
    expect(origin.reportTriggered).toBe(true)
    expect(origin.reason).toMatch(/plugin notice report/)
  })

  it('lifts the barrier once a person speaks, because they have re-authorised it', () => {
    const origin = turnOriginOf([
      prompt(1, { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'notice', summary: 'turn 1 ended' }),
      prompt(2, { kind: 'user' }),
    ])
    expect(origin.reportTriggered).toBe(false)
    expect(origin.reason).toMatch(/not a report/)
  })

  it('does not treat a forwarded relay as a report', () => {
    // A relay is an instruction a controller deliberately sent to this session,
    // which is an authorisation rather than an observation.
    const origin = turnOriginOf([
      prompt(1, { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'relay' }),
    ])
    expect(origin.reportTriggered).toBe(false)
  })

  it('looks past tool results, which sit between a prompt and its tool call', () => {
    const origin = turnOriginOf([
      prompt(1, { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'notice', summary: 'x' }),
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
      { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'conductor_list' } },
      { type: 'tool/result', seq: 4, data: { callId: 'c1', content: [] } },
    ])
    expect(origin.reportTriggered).toBe(true)
  })

  it('is not lifted by the Host injecting its own context into the log', () => {
    // Measured on a live Host: after a notice wakes a session, the Host appends its
    // system-prompt `snapshot` as a user-role message — and it lands *before*
    // `turn/start`, so a turn boundary cannot separate the two. Reading "the last
    // user message" therefore concluded "not a report" and let the barrier lift,
    // which is the exact hole the rule exists to close. A context form is not a
    // prompt: `snapshot` means "current state that supersedes the last one", not
    // "something a person said".
    const origin = turnOriginOf([
      prompt(1, { kind: 'user' }),
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
      { type: 'turn/end', seq: 3, data: { turn: 1, outcome: 'failed' } },
      prompt(4, { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'notice', summary: 'turn 1 ended: failed' }),
      prompt(5, {
        kind: 'plugin',
        plugin: '@deepseek-ai/dsh-system-prompt',
        form: 'snapshot',
        sections: [{ name: 'sandbox:policy', text: 'Current DSH file policy: workspace-write.' }],
      }),
      { type: 'turn/start', seq: 6, data: { turn: 2 } },
    ])
    expect(origin.reportTriggered).toBe(true)
    expect(origin.reason).toMatch(/conductor notice report/)
  })

  it('ignores every context form, not just snapshots', () => {
    for (const form of ['snapshot', 'catalog', 'instructions', 'recall']) {
      const origin = turnOriginOf([
        prompt(1, { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'notice', summary: 'x' }),
        prompt(2, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form }),
      ])
      expect(origin.reportTriggered).toBe(true)
    }
  })

  it('is lifted by a person speaking inside the report-opened turn', () => {
    // The rule stops a report from *being* an authorisation; it must not stop a
    // person from supplying one afterwards.
    const origin = turnOriginOf([
      prompt(1, { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'notice', summary: 'x' }),
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
      prompt(3, { kind: 'user' }),
    ])
    expect(origin.reportTriggered).toBe(false)
    expect(origin.reason).toMatch(/a person spoke/)
  })

  it('is neither triggered nor lifted by Host-injected context on its own', () => {
    const origin = turnOriginOf([
      prompt(1, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [] }),
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
    ])
    expect(origin.reportTriggered).toBe(false)
    expect(origin.reason).toMatch(/only Host-injected context/)
  })

  it('does not refuse when the log or the source cannot be read, and says so', () => {
    expect(turnOriginOf(undefined).reportTriggered).toBe(false)
    expect(turnOriginOf(undefined).reason).toMatch(/could not be read/)
    expect(turnOriginOf([]).reportTriggered).toBe(false)
    expect(turnOriginOf([{ type: 'user/message', seq: 1, data: null }]).reportTriggered).toBe(false)
  })

  it('carries a refusal that explains itself in full', () => {
    expect(NOTICE_TRIGGERED_REFUSAL).toContain('REPORT_TRIGGERED')
    expect(NOTICE_TRIGGERED_REFUSAL).toContain('A notice exists to inform a controller')
    expect(NOTICE_TRIGGERED_REFUSAL).toContain('Ask the user')
  })
})
