import { describe, expect, it } from 'vitest'
import {
  countRuns,
  advanceNextAt,
  draftReason,
  dueDecision,
  instantForWall,
  isKnownTimezone,
  nextCalendarInstant,
  offsetAt,
  onceAfter,
  planRecovery,
  planResume,
  planScheduleSave,
  calibratedInspectRun,
  inspectNoticeDecision,
  lastInspectObservation,
  wallClockOf,
} from '../src/service/schedule.ts'
import type { ScheduleRecord, ScheduleRun } from '../src/store/schema.ts'

const NOW = Date.parse('2026-09-13T12:00:00.000Z')

/** A saved schedule. */
function schedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    scheduleId: 'sched-1',
    title: 'check on the build',
    kind: 'once',
    timezone: 'UTC',
    nextAt: '2026-09-13T13:00:00.000Z',
    action: 'inspect',
    status: 'active',
    authorizedBy: 'session-controller',
    runs: [],
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  }
}

describe('timezone resolution (PRD §二.11)', () => {
  it('reads the wall clock of an instant in a named zone', () => {
    // 12:00 UTC is 08:00 in New York during daylight saving.
    expect(wallClockOf(Date.parse('2026-09-13T12:00:00.000Z'), 'America/New_York'))
      .toMatchObject({ hour: 8, minute: 0, day: 13 })
    expect(wallClockOf(Date.parse('2026-01-15T12:00:00.000Z'), 'America/New_York'))
      .toMatchObject({ hour: 7, minute: 0, day: 15 })
  })

  it('reports a zone offset that changes with daylight saving', () => {
    const summer = offsetAt(Date.parse('2026-07-01T12:00:00.000Z'), 'America/New_York')
    const winter = offsetAt(Date.parse('2026-01-01T12:00:00.000Z'), 'America/New_York')
    expect(summer).toBe(-4 * 60 * 60 * 1000)
    expect(winter).toBe(-5 * 60 * 60 * 1000)
  })

  it('resolves an ordinary local time to the right instant', () => {
    const resolved = instantForWall({ year: 2026, month: 9, day: 13, hour: 8, minute: 0 }, 'America/New_York')
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(new Date(resolved.instant).toISOString()).toBe('2026-09-13T12:00:00.000Z')
  })

  it('REJECTS a local time the clock jumps forward across', () => {
    // 2026-03-08 02:30 does not exist in New York: the clock goes 02:00 → 03:00.
    const resolved = instantForWall({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York')
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toMatch(/does not exist in America\/New_York/)
  })

  it('takes the EARLIER occurrence of a local time that happens twice, and says so', () => {
    // 2026-11-01 01:30 occurs twice in New York: once at 05:30Z, once at 06:30Z.
    const resolved = instantForWall({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York')
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(new Date(resolved.instant).toISOString()).toBe('2026-11-01T05:30:00.000Z')
    expect(resolved.note).toMatch(/occurs twice/)
  })

  it('finds the next occurrence of a daily local time', () => {
    const after = Date.parse('2026-09-13T13:00:00.000Z') // 09:00 in New York
    const next = nextCalendarInstant({ hour: 8, minute: 0 }, 'America/New_York', after)
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(new Date(next.instant).toISOString()).toBe('2026-09-14T12:00:00.000Z')
  })

  it('skips a day whose requested local time does not exist rather than shifting it', () => {
    // 02:30 on 2026-03-08 is skipped, so the next occurrence is 2026-03-09 02:30 EDT.
    const after = Date.parse('2026-03-07T12:00:00.000Z')
    const next = nextCalendarInstant({ hour: 2, minute: 30 }, 'America/New_York', after)
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(new Date(next.instant).toISOString()).toBe('2026-03-09T06:30:00.000Z')
  })
})

describe('when a schedule is due (PRD §二.11)', () => {
  it('is not due before its instant', () => {
    const decision = dueDecision(schedule({ nextAt: '2026-09-13T13:00:00.000Z' }), NOW)
    expect(decision.due).toBe(false)
  })

  it('is due once the instant has passed', () => {
    const decision = dueDecision(schedule({ nextAt: '2026-09-13T11:00:00.000Z' }), NOW)
    expect(decision.due).toBe(true)
    expect(decision.scheduledFor).toBe('2026-09-13T11:00:00.000Z')
  })

  it('never triggers the same scheduled instant twice', () => {
    const runs: ScheduleRun[] = [{ scheduledFor: '2026-09-13T11:00:00.000Z', ranAt: '2026-09-13T11:00:01.000Z', outcome: 'ran' }]
    const decision = dueDecision(schedule({ nextAt: '2026-09-13T11:00:00.000Z', runs }), NOW)
    expect(decision.due).toBe(false)
    expect(decision.reason).toMatch(/already been recorded/)
  })

  it('does not overlap itself while a previous occurrence is unfinished', () => {
    const runs: ScheduleRun[] = [{ scheduledFor: '2026-09-13T10:00:00.000Z', outcome: 'ran' }]
    const decision = dueDecision(schedule({ nextAt: '2026-09-13T11:00:00.000Z', runs }), NOW)
    expect(decision.due).toBe(false)
    expect(decision.reason).toMatch(/does not overlap itself/)
  })

  it('refuses a paused schedule and a draft', () => {
    expect(dueDecision(schedule({ status: 'paused' }), NOW).reason).toMatch(/paused/)
    const draft = dueDecision(schedule({ status: 'draft', draftReason: 'no limits' }), NOW)
    expect(draft.reason).toMatch(/draft: no limits/)
    expect(draft.mayExecute).toBe(false)
  })

  it('stops an execution plan at its limit and at its expiry', () => {
    const runs: ScheduleRun[] = [{ scheduledFor: '2026-09-12T11:00:00.000Z', ranAt: 'x', outcome: 'ran' }]
    const capped = schedule({ action: 'send', nextAt: '2026-09-13T11:00:00.000Z', maxRuns: 1, runs, instruction: 'go', targetTaskId: 't' })
    expect(dueDecision(capped, NOW).reason).toMatch(/its maximum/)

    const expired = schedule({
      action: 'send', nextAt: '2026-09-13T11:00:00.000Z', maxRuns: 5,
      expiresAt: '2026-09-13T00:00:00.000Z', instruction: 'go', targetTaskId: 't',
    })
    expect(dueDecision(expired, NOW).reason).toMatch(/expired/)
  })

  it('does not charge a skipped occurrence against the plan allowance', () => {
    const runs: ScheduleRun[] = [
      { scheduledFor: 'a', outcome: 'skipped_overlap' },
      { scheduledFor: 'b', outcome: 'skipped_duplicate' },
      { scheduledFor: 'c', ranAt: 'y', outcome: 'ran' },
    ]
    expect(countRuns(schedule({ runs }))).toBe(1)
  })

  it('requires an execution plan to state a limit before it may run automatically', () => {
    expect(draftReason('inspect', {})).toBeUndefined()
    expect(draftReason('send', {})).toMatch(/needs a limit/)
    expect(draftReason('send', { maxRuns: 3 })).toBeUndefined()
    expect(draftReason('queue', { expiresAt: '2026-12-01T00:00:00.000Z' })).toBeUndefined()
  })

  it('computes a one-shot instant from a delay', () => {
    expect(onceAfter(NOW, 60_000)).toBe('2026-09-13T12:01:00.000Z')
  })
})

describe('recovery after downtime (PRD §二.11, T22)', () => {
  it('does not grant catch-up for an exhausted, already recorded or unreadably bounded execution', () => {
    const base = schedule({
      action: 'send', targetTaskId: 't', instruction: 'go', maxRuns: 1,
      nextAt: '2026-09-13T11:59:00.000Z', graceMs: 5 * 60_000,
    })
    expect(planRecovery({ ...base, expiresAt: 'unreadable' }, NOW).record?.outcome).not.toBe('ran')
    expect(planRecovery({ ...base, runs: [{ scheduledFor: 'earlier', outcome: 'ran' }] }, NOW).record?.outcome)
      .not.toBe('ran')
    expect(planRecovery({ ...base, runs: [{ scheduledFor: base.nextAt, outcome: 'ran' }] }, NOW).record)
      .toBeUndefined()
  })
  it('retains the earliest future interval when a check settles between scheduled instants', () => {
    const recurring = schedule({
      kind: 'interval', intervalMs: 60_000, nextAt: '2026-09-13T11:59:00.000Z',
    })
    expect(advanceNextAt(recurring, NOW + 1)).toBe('2026-09-13T12:01:00.000Z')
    expect(advanceNextAt(recurring, NOW)).toBe('2026-09-13T12:01:00.000Z')
    expect(advanceNextAt(recurring, NOW - 1)).toBe('2026-09-13T12:00:00.000Z')
  })

  it('calibrates a read-only schedule once and does not replay the missed cycles', () => {
    const decision = planRecovery(schedule({
      kind: 'interval', intervalMs: 60 * 60 * 1000, nextAt: '2026-09-13T06:00:00.000Z',
    }), NOW)

    expect(decision.calibrate).toBe(true)
    expect(decision.record).toBeUndefined()
    // Six hours were missed; the next occurrence is ahead of now, not a backlog.
    expect(Date.parse(decision.nextAt ?? '')).toBeGreaterThan(NOW)
    // The policy sentence is *why* to calibrate; it is not the observation.
    expect(decision.reason).toMatch(/calibrated once after the Host was not running/)
  })

  it('records the inspection, not the policy sentence, as the recovery run', () => {
    const overdue = schedule({
      kind: 'interval', intervalMs: 60 * 60 * 1000, nextAt: '2026-09-13T06:00:00.000Z',
    })
    const decision = planRecovery(overdue, NOW)
    const observation = 'task t1 is ready/ready on session s1; 0 artifact(s), 0 verified present and 0 accepted'
    const recorded = calibratedInspectRun(overdue.nextAt, new Date(NOW).toISOString(), observation)
    expect(recorded.scheduledFor).toBe(overdue.nextAt)
    expect(recorded.outcome).toBe('ran')
    expect(recorded.reason).toBe(observation)
    expect(recorded.reason).not.toBe(decision.reason)
  })

  it('notifies only when a later inspection differs from the last one', () => {
    const first = inspectNoticeDecision(undefined, 'task t1 is ready/ready; 0 artifact(s)')
    expect(first.notify).toBe(false)
    expect(first.reason).toMatch(/baseline/)

    const same = inspectNoticeDecision('task t1 is ready/ready; 0 artifact(s)', 'task t1 is ready/ready; 0 artifact(s)')
    expect(same.notify).toBe(false)
    expect(same.reason).toMatch(/unchanged/)

    const changed = inspectNoticeDecision(
      'task t1 is ready/ready; 0 artifact(s), 0 verified present and 0 accepted',
      'task t1 is ready/ready; 1 artifact(s), 0 verified present and 0 accepted',
    )
    expect(changed.notify).toBe(true)
  })

  it('reads the last ran observation and ignores missed occurrences', () => {
    const runs: ScheduleRun[] = [
      { scheduledFor: '2026-09-13T06:00:00.000Z', outcome: 'ran', reason: 'first look' },
      { scheduledFor: '2026-09-13T07:00:00.000Z', outcome: 'missed', reason: 'the Host was not running' },
    ]
    expect(lastInspectObservation(runs)).toBe('first look')
    expect(lastInspectObservation([])).toBeUndefined()
  })

  it('marks a missed one-shot as missed when no grace window was saved', () => {
    const decision = planRecovery(schedule({
      action: 'send', targetTaskId: 't', instruction: 'go', maxRuns: 5, nextAt: '2026-09-13T06:00:00.000Z',
    }), NOW)
    expect(decision.record?.outcome).toBe('missed')
    expect(decision.record?.scheduledFor).toBe('2026-09-13T06:00:00.000Z')
    expect(decision.reason).toMatch(/not replayed/)
  })

  it('runs once inside a saved grace window, and only once', () => {
    const decision = planRecovery(schedule({
      action: 'send', targetTaskId: 't', instruction: 'go', maxRuns: 5,
      nextAt: '2026-09-13T11:59:00.000Z', graceMs: 5 * 60 * 1000,
    }), NOW)
    expect(decision.record?.outcome).toBe('ran')
    expect(decision.record?.ranAt).toBe(new Date(NOW).toISOString())
  })

  it('marks it missed when the grace window has closed', () => {
    const decision = planRecovery(schedule({
      action: 'send', targetTaskId: 't', instruction: 'go', maxRuns: 5,
      nextAt: '2026-09-13T09:00:00.000Z', graceMs: 60 * 1000,
    }), NOW)
    expect(decision.record?.outcome).toBe('missed')
    expect(decision.record?.reason).toMatch(/grace window has closed/)
  })

  it('does not catch up a plan that has expired', () => {
    const decision = planRecovery(schedule({
      action: 'send', targetTaskId: 't', instruction: 'go', maxRuns: 5,
      nextAt: '2026-09-13T11:59:00.000Z', graceMs: 60 * 60 * 1000,
      expiresAt: '2026-09-13T11:00:00.000Z',
    }), NOW)
    expect(decision.record?.outcome).toBe('missed')
  })

  it('reports nothing missed when the schedule is still ahead', () => {
    const decision = planRecovery(schedule({ nextAt: '2026-09-13T18:00:00.000Z' }), NOW)
    expect(decision.calibrate).toBe(false)
    expect(decision.record).toBeUndefined()
    expect(decision.reason).toMatch(/nothing was missed/)
  })

  it('leaves a paused schedule alone', () => {
    const decision = planRecovery(schedule({ status: 'paused', nextAt: '2026-09-13T06:00:00.000Z' }), NOW)
    expect(decision.record).toBeUndefined()
    expect(decision.calibrate).toBe(false)
  })
})

describe('planning a save (PRD §二.11)', () => {
  /** A save request with the members a test cares about overridden. */
  function request(over: Partial<Parameters<typeof planScheduleSave>[0]> = {}) {
    return {
      scheduleId: 'sched-new',
      kind: 'once' as const,
      timezone: 'UTC',
      action: 'inspect' as const,
      authorizedBy: 'session-controller',
      now: NOW,
      ...over,
    }
  }

  it('turns a delay into an instant and keeps the chosen zone', () => {
    const plan = planScheduleSave(request({ delayMs: 30 * 60 * 1000 }))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.record.nextAt).toBe('2026-09-13T12:30:00.000Z')
    expect(plan.record.timezone).toBe('UTC')
    expect(plan.record.status).toBe('active')
  })

  it('refuses a one-shot instant that is not in the future, because it could never run', () => {
    const plan = planScheduleSave(request({ at: '2026-09-13T11:00:00.000Z' }))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/not in the future/)
  })

  it('refuses a one-shot that states neither an instant nor a delay', () => {
    const plan = planScheduleSave(request())
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/either an instant .* or a delay/)
  })

  it('refuses an unresolvable zone rather than falling back to the machine zone', () => {
    expect(isKnownTimezone('Asia/Shanghai')).toBe(true)
    expect(isKnownTimezone('UTC')).toBe(true)
    expect(isKnownTimezone('Mars/Olympus_Mons')).toBe(false)
    // Measured: this runtime's ICU resolves a bare UTC offset as a fixed-offset
    // zone. It is accepted because a local time in it is exactly well defined —
    // there are no daylight-saving transitions in a fixed offset, so such a plan
    // can never be ambiguous or non-existent.
    expect(isKnownTimezone('+08:00')).toBe(true)
    const fixed = planScheduleSave(request({
      kind: 'calendar', timezone: '+08:00', wall: { hour: 9, minute: 0 },
    }))
    expect(fixed.ok && fixed.record.nextAt).toBe('2026-09-14T01:00:00.000Z')
    expect(fixed.ok && fixed.notes).toEqual([])

    const plan = planScheduleSave(request({ timezone: 'Mars/Olympus_Mons', delayMs: 1000 }))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/not a zone this runtime can resolve/)
  })

  it('refuses an interval schedule with no positive spacing', () => {
    expect(planScheduleSave(request({ kind: 'interval' })).ok).toBe(false)
    expect(planScheduleSave(request({ kind: 'interval', intervalMs: 0 })).ok).toBe(false)
    expect(planScheduleSave(request({ kind: 'interval', intervalMs: -5 })).ok).toBe(false)
    const ok = planScheduleSave(request({ kind: 'interval', intervalMs: 60_000 }))
    expect(ok.ok && ok.record.nextAt).toBe('2026-09-13T12:01:00.000Z')
  })

  it('refuses a calendar schedule with no local time of day', () => {
    const plan = planScheduleSave(request({ kind: 'calendar', timezone: 'Asia/Shanghai' }))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/local time of day/)
  })

  it('computes a calendar occurrence in the chosen zone, not in UTC', () => {
    const plan = planScheduleSave(request({
      kind: 'calendar', timezone: 'Asia/Shanghai', wall: { hour: 9, minute: 0 },
    }))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // 09:00 in Shanghai (UTC+8) is 01:00 UTC, and NOW is already past it, so the
    // next one is the following day.
    expect(plan.record.nextAt).toBe('2026-09-14T01:00:00.000Z')
    expect(wallClockOf(Date.parse(plan.record.nextAt), 'Asia/Shanghai')).toMatchObject({ hour: 9, minute: 0, day: 14 })
  })

  it('explains an ambiguous local time in the preview notes', () => {
    // 01:30 on 2026-11-01 in New York happens twice. NOW is in September, so the
    // next 01:30 is unambiguous; anchoring the search on the transition day makes
    // the ambiguity the next occurrence.
    const plan = planScheduleSave(request({
      kind: 'calendar',
      timezone: 'America/New_York',
      wall: { hour: 1, minute: 30 },
      now: Date.parse('2026-11-01T04:00:00.000Z'),
    }))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.record.nextAt).toBe('2026-11-01T05:30:00.000Z')
    expect(plan.notes.join(' ')).toMatch(/occurs twice/)
    expect(plan.notes.join(' ')).toMatch(/2026-11-01T05:30:00.000Z/)
  })

  it('refuses an execution plan that does not state both its target and its instruction', () => {
    const noTarget = planScheduleSave(request({ action: 'send', delayMs: 1000, instruction: 'go' }))
    expect(noTarget.ok).toBe(false)
    if (!noTarget.ok) expect(noTarget.reason).toMatch(/must state its action/)

    const noInstruction = planScheduleSave(request({ action: 'queue', delayMs: 1000, targetTaskId: 'task-1' }))
    expect(noInstruction.ok).toBe(false)
  })

  it('saves an execution plan with no limit as a draft, and says why', () => {
    const plan = planScheduleSave(request({ action: 'send', delayMs: 1000, targetTaskId: 'task-1', instruction: 'go' }))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.record.status).toBe('draft')
    expect(plan.record.draftReason).toMatch(/needs a limit/)
    expect(plan.notes.join(' ')).toMatch(/saved as a draft/)
  })

  it('starts an execution plan that states a limit', () => {
    for (const limit of [{ maxRuns: 3 }, { expiresAt: '2026-12-01T00:00:00.000Z' }]) {
      const plan = planScheduleSave(request({
        action: 'send', delayMs: 1000, targetTaskId: 'task-1', instruction: 'go', ...limit,
      }))
      expect(plan.ok && plan.record.status).toBe('active')
      expect(plan.ok && plan.record.draftReason).toBeUndefined()
    }
  })

  it('refuses an invalid expiry instead of accepting it as the sole automatic execution limit', () => {
    const plan = planScheduleSave(request({
      kind: 'interval', intervalMs: 60_000, action: 'send',
      targetTaskId: 'task-1', instruction: 'go', expiresAt: 'not-an-instant',
    }))
    expect(plan).toMatchObject({ ok: false, reason: expect.stringMatching(/expiresAt/) })
    expect(dueDecision(schedule({ action: 'send', nextAt: '2026-09-13T11:00:00.000Z', expiresAt: 'not-an-instant' }), NOW).due)
      .toBe(false)
  })

  it('keeps a read-only plan active without any limit, because inspection is not an execution', () => {
    const plan = planScheduleSave(request({ action: 'inspect', delayMs: 1000 }))
    expect(plan.ok && plan.record.status).toBe('active')
  })
})

describe('resuming a paused schedule (PRD §二.11)', () => {
  it('reactivates a schedule whose next occurrence is still ahead, and records nothing', () => {
    const decision = planResume(schedule({ status: 'paused', nextAt: '2026-09-13T18:00:00.000Z' }), NOW)
    expect(decision.status).toBe('active')
    expect(decision.record).toBeUndefined()
    expect(decision.nextAt).toBe('2026-09-13T18:00:00.000Z')
  })

  it('marks the skipped occurrence missed and moves a recurring schedule on instead of replaying it', () => {
    const decision = planResume(schedule({
      status: 'paused', kind: 'interval', intervalMs: 60 * 60 * 1000,
      nextAt: '2026-09-13T06:00:00.000Z',
    }), NOW)
    expect(decision.status).toBe('active')
    expect(decision.record?.outcome).toBe('missed')
    expect(decision.record?.scheduledFor).toBe('2026-09-13T06:00:00.000Z')
    // One hour spacing, NOW is 12:00, so the next is 13:00 — not the six missed hours.
    expect(decision.nextAt).toBe('2026-09-13T13:00:00.000Z')
  })

  it('finishes a one-shot whose instant passed while it was paused, rather than firing it late', () => {
    const decision = planResume(schedule({ status: 'paused', nextAt: '2026-09-13T06:00:00.000Z' }), NOW)
    expect(decision.status).toBe('completed')
    expect(decision.record?.outcome).toBe('missed')
    expect(decision.note).toMatch(/finished/)
  })

  it('reactivates a one-shot that is still ahead', () => {
    const decision = planResume(schedule({ status: 'paused', nextAt: '2026-09-13T18:00:00.000Z' }), NOW)
    expect(decision.status).toBe('active')
    expect(decision.record).toBeUndefined()
  })
})
