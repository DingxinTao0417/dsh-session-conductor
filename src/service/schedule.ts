/**
 * Schedules: when they run, and what happens after downtime (PRD §二.11).
 *
 * Two parts of the specification drive this module, and both are about refusing
 * to guess.
 *
 * **Wall-clock times in a named zone.** A calendar schedule means a *local* time,
 * so the UTC instant is derived from it rather than stored instead of it. Two
 * cases have no innocent answer and are handled explicitly: a time that does not
 * exist because the clock jumped forward is **rejected**, and a time that occurs
 * twice because the clock jumped back resolves to the **earlier** occurrence,
 * with a note the caller can show in a preview.
 *
 * **Recovery.** The Host being off is not a promise to run anything later. On
 * restart the specification asks for one read-only calibration, missed one-shots
 * marked `missed`, no replay of every missed cycle, and a single catch-up only
 * where the rule explicitly saved a grace window. {@link planRecovery} is that
 * policy and nothing more.
 *
 * The clock is always supplied by the caller, so every rule here is testable at
 * any instant without waiting.
 *
 * @module dsh-session-conductor/service/schedule
 */

import type { ScheduleRecord, ScheduleRun } from '../store/schema.ts'

/** A wall-clock time in a named zone. */
export interface WallClock {
  readonly year: number
  /** 1-12. */
  readonly month: number
  /** 1-31. */
  readonly day: number
  readonly hour: number
  readonly minute: number
}

/** The result of turning a wall-clock time into an instant. */
export type InstantResult =
  | {
      readonly ok: true
      readonly instant: number
      /** Set when the time was ambiguous and the earlier occurrence was chosen. */
      readonly note?: string
    }
  | { readonly ok: false; readonly reason: string }

/** The wall-clock components of an instant in a zone. */
export function wallClockOf(instantMs: number, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs))
  const read = (type: string): number => {
    const part = parts.find(entry => entry.type === type)
    return part === undefined ? 0 : Number.parseInt(part.value, 10)
  }
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // `hour12: false` renders midnight as 24 in some locales; normalise it.
    hour: read('hour') % 24,
    minute: read('minute'),
  }
}

/**
 * The zone's offset from UTC at one instant, in milliseconds.
 * @param instantMs - the instant to measure at.
 * @param timezone - the IANA zone.
 * @returns the offset, such that `localWall = instant + offset`.
 */
export function offsetAt(instantMs: number, timezone: string): number {
  const wall = wallClockOf(instantMs, timezone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  // Seconds are dropped on both sides, so the difference is a whole number of
  // minutes — which every real zone offset is.
  const instantMinute = Math.floor(instantMs / 60_000) * 60_000
  return asUtc - instantMinute
}

/** Whether two wall-clock times are the same minute. */
function sameWall(left: WallClock, right: WallClock): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute
}

/**
 * Resolve a wall-clock time in a zone to an instant.
 *
 * @param wall - the local time the user asked for.
 * @param timezone - the IANA zone.
 * @returns the instant, a rejection for a time that does not exist, or the
 * earlier of two occurrences with a note.
 */
export function instantForWall(wall: WallClock, timezone: string): InstantResult {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  // Two passes: the first estimate uses the offset at the naive instant, the
  // second corrects it with the offset that estimate actually lands in.
  let candidate = asUtc - offsetAt(asUtc, timezone)
  candidate = asUtc - offsetAt(candidate, timezone)

  if (!sameWall(wallClockOf(candidate, timezone), wall)) {
    // A forward jump skipped this local time entirely.
    return {
      ok: false,
      reason: `the local time ${formatWall(wall)} does not exist in ${timezone}: the clock jumps forward `
        + 'across it, so no instant maps to it',
    }
  }

  // A backward jump makes the same local time occur twice. Every plausible shift
  // is probed in both directions rather than only `candidate ± 1h`: which side
  // the two-pass resolution lands on depends on the offset it happened to use,
  // so landing on the earlier occurrence must still be *recognised* as
  // ambiguous — otherwise the preview would present a coincidence as the only
  // answer, which is exactly the kind of quiet guess this module refuses to
  // make. Shifts of 30 minutes (Lord Howe Island) and 2 hours (historic zones)
  // are real, so the probe set covers them too.
  const shifts = [30 * 60_000, 60 * 60_000, 2 * 60 * 60_000]
  const matches = [candidate]
  for (const shift of shifts) {
    matches.push(candidate - shift, candidate + shift)
  }
  const occurrences = [...new Set(matches.filter(instant => sameWall(wallClockOf(instant, timezone), wall)))]
    .sort((left, right) => left - right)
  // `candidate` always maps back to `wall` (checked above), so there is at least
  // one occurrence; more than one means the clock went back across this time.
  if (occurrences.length > 1) {
    return {
      ok: true,
      instant: occurrences[0]!,
      note: `the local time ${formatWall(wall)} occurs twice in ${timezone} because the clock jumps back; `
        + 'the earlier occurrence was chosen',
    }
  }
  return { ok: true, instant: candidate }
}

/**
 * Format a wall-clock time for a message.
 * @param wall - the components.
 * @returns the formatted time.
 */
function formatWall(wall: WallClock): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(wall.year)}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`
}

/**
 * The instant a calendar schedule is next due at or after a reference instant.
 *
 * @param wall - the local time of day the schedule repeats at.
 * @param timezone - the IANA zone.
 * @param after - the instant to search forward from.
 * @returns the next due instant, or the reason none could be computed.
 */
export function nextCalendarInstant(wall: { hour: number; minute: number }, timezone: string, after: number): InstantResult {
  const local = wallClockOf(after, timezone)
  // Walk forward day by day from the reference's own local date. A day whose
  // requested time does not exist is skipped, not shifted — running at a
  // different local time than the user chose would be a silent substitution.
  for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset))
    const resolved = instantForWall({
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour: wall.hour,
      minute: wall.minute,
    }, timezone)
    if (!resolved.ok) continue
    if (resolved.instant > after) return resolved
  }
  return { ok: false, reason: `no occurrence of ${String(wall.hour)}:${String(wall.minute)} in ${timezone} was found in the next few days` }
}

/** What one due-check concluded. */
export interface DueDecision {
  readonly due: boolean
  /** The instant the occurrence is for. */
  readonly scheduledFor?: string
  readonly reason: string
  /** True when the run must be performed; false for a plan that may only inspect. */
  readonly mayExecute: boolean
}

/**
 * Decide whether a schedule is due at an instant.
 *
 * `inspect` plans are read-only and always allowed to run. An execution plan is
 * only allowed when it states its limits **and** still has runs left and has not
 * expired — the specification requires a plan without them to be saved as a draft
 * rather than started.
 *
 * @param schedule - the saved schedule.
 * @param now - the current instant.
 * @returns the decision.
 */
export function dueDecision(schedule: ScheduleRecord, now: number): DueDecision {
  if (schedule.status === 'paused') return { due: false, reason: 'the schedule is paused', mayExecute: false }
  if (schedule.status === 'draft') {
    return { due: false, reason: `the schedule is a draft: ${schedule.draftReason ?? 'its limits are incomplete'}`, mayExecute: false }
  }
  if (schedule.status === 'completed') return { due: false, reason: 'the schedule has finished', mayExecute: false }

  const next = Date.parse(schedule.nextAt)
  if (!Number.isFinite(next)) return { due: false, reason: `the schedule has no readable next instant (${schedule.nextAt})`, mayExecute: false }
  const isExecution = schedule.action !== 'inspect'

  if (isExecution && schedule.expiresAt !== undefined) {
    const expiry = Date.parse(schedule.expiresAt)
    if (!Number.isFinite(expiry)) {
      return { due: false, reason: `the plan's expiresAt is unreadable (${schedule.expiresAt}); its validity cannot be confirmed`, mayExecute: false }
    }
    if (now >= expiry) return { due: false, reason: `the plan expired at ${schedule.expiresAt}`, mayExecute: false }
  }
  if (isExecution && schedule.maxRuns !== undefined && countRuns(schedule) >= schedule.maxRuns) {
    return { due: false, reason: `the plan has run ${String(countRuns(schedule))} time(s), its maximum`, mayExecute: false }
  }
  if (next > now) {
    return { due: false, reason: `the next occurrence is at ${schedule.nextAt}`, mayExecute: isExecution }
  }

  // The same scheduled instant never triggers twice: the run log is keyed on it.
  if (schedule.runs.some(run => run.scheduledFor === schedule.nextAt)) {
    return {
      due: false,
      scheduledFor: schedule.nextAt,
      reason: `the occurrence at ${schedule.nextAt} has already been recorded`,
      mayExecute: false,
    }
  }

  // A schedule does not overlap itself: if the previous occurrence never recorded
  // an end, this one is skipped rather than started alongside it.
  const previous = schedule.runs[schedule.runs.length - 1]
  if (previous !== undefined && previous.ranAt === undefined && previous.outcome === 'ran') {
    return {
      due: false,
      scheduledFor: schedule.nextAt,
      reason: 'the previous occurrence has not finished, and a schedule does not overlap itself',
      mayExecute: false,
    }
  }

  return { due: true, scheduledFor: schedule.nextAt, reason: `due at ${schedule.nextAt}`, mayExecute: isExecution }
}

/**
 * Count occurrences that actually consumed the plan's allowance.
 *
 * A skipped overlap or a duplicate does not count: the plan did not act, so it
 * must not be charged for the run.
 *
 * @param schedule - the saved schedule.
 * @returns the number of runs charged.
 */
export function countRuns(schedule: ScheduleRecord): number {
  return schedule.runs.filter(run => run.outcome === 'ran' || run.outcome === 'failed').length
}

/** What recovery decided for one schedule. */
export interface RecoveryDecision {
  readonly scheduleId: string
  /** The run to record, if any. */
  readonly record?: ScheduleRun
  /** The calibration to perform, if any. */
  readonly calibrate: boolean
  /** The instant to set as next, when the schedule continues. */
  readonly nextAt?: string
  readonly reason: string
}

/**
 * The run-log entry a recovery calibration writes.
 *
 * {@link planRecovery} decides *whether* to calibrate and explains the policy;
 * the inspection is what the calibration *is*. Recording the policy sentence as
 * `reason` would tell a later reader a check happened that did not.
 *
 * @param scheduledFor - the occurrence that was due while the Host was down.
 * @param nowIso - when the calibration ran.
 * @param observation - what the read-only inspection actually saw.
 * @returns a `ran` entry whose reason is the observation, not the policy.
 */
export function calibratedInspectRun(
  scheduledFor: string,
  nowIso: string,
  observation: string,
): ScheduleRun {
  return { scheduledFor, ranAt: nowIso, outcome: 'ran', reason: observation }
}

/**
 * The last inspection observation a schedule recorded.
 *
 * Only `ran` entries count: a missed or refused occurrence did not inspect, and
 * treating its reason as a baseline would notify (or suppress) for the wrong fact.
 *
 * @param runs - the schedule's run log, oldest first.
 * @returns the latest observation, or undefined when none exists.
 */
export function lastInspectObservation(runs: readonly ScheduleRun[]): string | undefined {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const entry = runs[index]
    if (entry?.outcome === 'ran' && entry.reason !== undefined && entry.reason.length > 0) {
      return entry.reason
    }
  }
  return undefined
}

/**
 * Whether a new inspection is a change worth notifying (PRD §二.11 有变化时通知).
 *
 * The first observation is a baseline, not a change: there is nothing to compare
 * it with. Equality is exact — the observation is one line of conductor facts,
 * so a different line is a different fact.
 *
 * @param previous - the last recorded observation, when there is one.
 * @param observation - what this occurrence saw.
 * @returns whether to notify, and why.
 */
export function inspectNoticeDecision(
  previous: string | undefined,
  observation: string,
): { readonly notify: boolean; readonly reason: string } {
  if (previous === undefined) {
    return {
      notify: false,
      reason: 'the first inspection establishes a baseline; there is no earlier observation to compare',
    }
  }
  if (previous === observation) {
    return { notify: false, reason: 'the observation is unchanged' }
  }
  return { notify: true, reason: 'the inspection saw a change' }
}

/**
 * Decide what a schedule needs after the Host was not running.
 *
 * The specification's rules, in order:
 *
 * - a read-only inspection is calibrated **once**, not replayed;
 * - a missed one-shot becomes `missed` unless the rule saved a grace window, in
 *   which case it may run once — and only if the window has not closed;
 * - a recurring schedule skips the cycles it missed and moves to its next
 *   occurrence; it never runs the backlog.
 *
 * @param schedule - the saved schedule.
 * @param now - the current instant.
 * @returns the decision, with the run to record when there is one.
 */
export function planRecovery(schedule: ScheduleRecord, now: number): RecoveryDecision {
  if (schedule.status !== 'active') {
    return { scheduleId: schedule.scheduleId, calibrate: false, reason: `the schedule is ${schedule.status}` }
  }
  const next = Date.parse(schedule.nextAt)
  if (!Number.isFinite(next) || next > now) {
    return { scheduleId: schedule.scheduleId, calibrate: false, reason: 'nothing was missed' }
  }

  const missedAt = schedule.nextAt
  const isExecution = schedule.action !== 'inspect'

  if (schedule.runs.some(run => run.scheduledFor === missedAt)) {
    return { scheduleId: schedule.scheduleId, calibrate: false, reason: `the occurrence at ${missedAt} has already been recorded` }
  }

  if (!isExecution) {
    // One calibration, then move on. The check is read-only, so performing it
    // once after restart is the compensation the specification asks for; running
    // it for every missed cycle is exactly what it forbids.
    return {
      scheduleId: schedule.scheduleId,
      calibrate: true,
      nextAt: advanceNextAt(schedule, now),
      reason: 'a read-only schedule is calibrated once after the Host was not running; missed cycles are not replayed',
    }
  }

  const admissible = dueDecision(schedule, now)
  if (!admissible.due) {
    return {
      scheduleId: schedule.scheduleId,
      calibrate: false,
      record: {
        scheduledFor: missedAt,
        outcome: schedule.expiresAt !== undefined && now >= Date.parse(schedule.expiresAt) ? 'missed' : 'refused',
        reason: admissible.reason,
      },
      nextAt: advanceNextAt(schedule, now),
      reason: admissible.reason,
    }
  }
  const grace = schedule.graceMs
  const allowed = grace !== undefined && now - next <= grace
  if (allowed) {
    return {
      scheduleId: schedule.scheduleId,
      calibrate: false,
      record: { scheduledFor: missedAt, ranAt: new Date(now).toISOString(), outcome: 'ran', reason: 'a caught-up run within the saved grace window' },
      nextAt: advanceNextAt(schedule, now),
      reason: `the plan saved a ${String(grace)} ms grace window and this occurrence is inside it, so it runs once`,
    }
  }

  return {
    scheduleId: schedule.scheduleId,
    calibrate: false,
    record: {
      scheduledFor: missedAt,
      outcome: 'missed',
      reason: grace === undefined
        ? 'the Host was not running and the plan saved no grace window, so the occurrence is missed'
        : 'the Host was not running and the saved grace window has closed',
    },
    nextAt: advanceNextAt(schedule, now),
    reason: 'a missed execution is recorded as missed and is not replayed',
  }
}

/**
 * The instant a recurring schedule is next due after a reference instant.
 *
 * Only the **next** occurrence is computed, never the backlog: this is the single
 * place that decides a recurring schedule moves on rather than catching up, and
 * both recovery and resume go through it so they cannot disagree.
 *
 * @param schedule - the saved schedule.
 * @param after - the reference instant.
 * @returns the next instant as an ISO string, or the stored one when it cannot advance.
 */
export function advanceNextAt(schedule: ScheduleRecord, after: number): string {
  if (schedule.kind === 'once') return schedule.nextAt
  if (schedule.kind === 'interval' && schedule.intervalMs !== undefined) {
    let next = Date.parse(schedule.nextAt)
    if (!Number.isFinite(next)) return schedule.nextAt
    // Step forward past the reference without replaying the missed cycles.
    const steps = Math.max(1, Math.floor((after - next) / schedule.intervalMs) + 1)
    next += steps * schedule.intervalMs
    return new Date(next).toISOString()
  }
  if (schedule.kind === 'calendar' && schedule.wall !== undefined) {
    const resolved = nextCalendarInstant(schedule.wall, schedule.timezone, after)
    return resolved.ok ? new Date(resolved.instant).toISOString() : schedule.nextAt
  }
  return schedule.nextAt
}

/**
 * Whether a plan must be saved as a draft rather than started.
 *
 * PRD §二.11: an execution plan must state its action **and** a validity, count
 * or budget limit. Without them it is saved as a draft and does not run
 * automatically, so a plan cannot quietly become an unbounded loop.
 *
 * @param action - what the plan would do.
 * @param limits - the limits the caller supplied.
 * @returns the draft reason, or undefined when the plan may be active.
 */
export function draftReason(
  action: ScheduleRecord['action'],
  limits: { maxRuns?: number; expiresAt?: string; graceMs?: number },
): string | undefined {
  if (action === 'inspect') return undefined
  const hasLimit = limits.maxRuns !== undefined || limits.expiresAt !== undefined
  if (hasLimit) return undefined
  return 'an execution plan needs a limit — maxRuns or expiresAt — before it may run automatically'
}

/**
 * The instant a one-shot schedule is due, from a delay.
 * @param now - the current instant.
 * @param delayMs - the delay.
 * @returns the due instant as an ISO string.
 */
export function onceAfter(now: number, delayMs: number): string {
  return new Date(now + delayMs).toISOString()
}

/**
 * Whether a string names a zone this runtime can actually resolve.
 *
 * A typo must not be accepted: an unknown zone would otherwise fall back to the
 * machine's local zone, and a calendar schedule would then run at a local time
 * the user never chose. The specification requires the chosen IANA zone to be
 * saved, so an unresolvable one is refused rather than repaired.
 *
 * @param timezone - the candidate zone name.
 * @returns whether it resolves.
 */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
}

/** Everything a caller must state to save a schedule. */
export interface SchedulePlanInput {
  readonly scheduleId: string
  readonly title?: string
  readonly kind: ScheduleRecord['kind']
  /** IANA zone the user chose. */
  readonly timezone: string
  /** For `once`: the instant. For the recurring kinds: the first/baseline instant. */
  readonly at?: string
  /** For `once`: a delay instead of an instant. */
  readonly delayMs?: number
  /** For `interval`: the spacing. */
  readonly intervalMs?: number
  /** For `calendar`: the local time of day. */
  readonly wall?: { hour: number; minute: number }
  readonly action: ScheduleRecord['action']
  readonly targetTaskId?: string
  readonly instruction?: string
  readonly maxRuns?: number
  readonly expiresAt?: string
  readonly graceMs?: number
  /** The controller session whose authorisation this plan records. */
  readonly authorizedBy: string
  /** The current instant. */
  readonly now: number
}

/** The outcome of planning a save. */
export type SchedulePlan =
  | {
      readonly ok: true
      readonly record: ScheduleRecord
      /** Explanations to show in the preview, such as an ambiguous local time. */
      readonly notes: string[]
    }
  | { readonly ok: false; readonly reason: string }

/**
 * Turn a save request into the record to persist, or refuse it.
 *
 * Every refusal here is a case where guessing would silently change what the
 * user asked for: an unresolvable zone, a one-shot in the past that can never
 * run, a recurring plan with no spacing, a calendar plan with no local time, or
 * an execution plan with no stated action. A plan that states its action but no
 * limit is not refused — it is saved as a **draft**, which is what the
 * specification asks for.
 *
 * @param input - the caller's request plus the current instant.
 * @returns the record and any preview notes, or the reason it cannot be saved.
 */
export function planScheduleSave(input: SchedulePlanInput): SchedulePlan {
  const notes: string[] = []
  const timezone = input.timezone

  if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
    return { ok: false, reason: 'expiresAt must be a readable expiry instant; an invalid value cannot bound automatic execution' }
  }

  if (!isKnownTimezone(timezone)) {
    return {
      ok: false,
      reason: `${timezone} is not a zone this runtime can resolve, so a local time in it cannot be honoured`,
    }
  }

  let nextAt: string | undefined
  let wall: ScheduleRecord['wall']

  if (input.kind === 'once') {
    const instant = input.at !== undefined
      ? Date.parse(input.at)
      : input.delayMs !== undefined ? input.now + input.delayMs : Number.NaN
    if (!Number.isFinite(instant)) {
      return { ok: false, reason: 'a one-shot schedule needs either an instant (`at`) or a delay (`delayMs`)' }
    }
    if (instant <= input.now) {
      return {
        ok: false,
        reason: `the one-shot instant ${new Date(instant).toISOString()} is not in the future, so it could never run`,
      }
    }
    nextAt = new Date(instant).toISOString()
  } else if (input.kind === 'interval') {
    if (input.intervalMs === undefined || !Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
      return { ok: false, reason: 'an interval schedule needs a positive `intervalMs`' }
    }
    const baseline = input.at !== undefined ? Date.parse(input.at) : Number.NaN
    nextAt = Number.isFinite(baseline)
      ? new Date(baseline).toISOString()
      : new Date(input.now + input.intervalMs).toISOString()
  } else {
    if (input.wall === undefined
      || !Number.isInteger(input.wall.hour) || input.wall.hour < 0 || input.wall.hour > 23
      || !Number.isInteger(input.wall.minute) || input.wall.minute < 0 || input.wall.minute > 59) {
      return { ok: false, reason: 'a calendar schedule needs a local time of day (`hour` and `minute`)' }
    }
    wall = { hour: input.wall.hour, minute: input.wall.minute }
    const resolved = nextCalendarInstant(wall, timezone, input.now)
    if (!resolved.ok) return { ok: false, reason: resolved.reason }
    nextAt = new Date(resolved.instant).toISOString()
    // The specification asks for an ambiguous local time to be resolved to the
    // earlier occurrence **and** explained in the preview.
    if (resolved.note !== undefined) {
      notes.push(`${resolved.note}; the next occurrence is ${nextAt}`)
    }
  }

  if (input.action !== 'inspect' && (input.targetTaskId === undefined || input.instruction === undefined)) {
    return {
      ok: false,
      reason: 'an execution plan must state its action: it needs both a target task and the exact instruction',
    }
  }

  const draft = draftReason(input.action, {
    ...input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns },
    ...input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt },
    ...input.graceMs === undefined ? {} : { graceMs: input.graceMs },
  })
  if (draft !== undefined) notes.push(`saved as a draft: ${draft}`)

  const now = new Date(input.now).toISOString()
  return {
    ok: true,
    notes,
    record: {
      scheduleId: input.scheduleId,
      title: input.title ?? defaultTitle(input),
      kind: input.kind,
      timezone,
      nextAt,
      action: input.action,
      status: draft === undefined ? 'active' : 'draft',
      authorizedBy: input.authorizedBy,
      runs: [],
      createdAt: now,
      updatedAt: now,
      ...input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs },
      ...wall === undefined ? {} : { wall },
      ...input.targetTaskId === undefined ? {} : { targetTaskId: input.targetTaskId },
      ...input.instruction === undefined ? {} : { instruction: input.instruction },
      ...input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns },
      ...input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt },
      ...input.graceMs === undefined ? {} : { graceMs: input.graceMs },
      ...draft === undefined ? {} : { draftReason: draft },
    },
  }
}

/**
 * A short title that describes the plan without the caller having to write one.
 * @param input - the save request.
 * @returns the title.
 */
function defaultTitle(input: SchedulePlanInput): string {
  const where = input.targetTaskId === undefined ? '' : ` → ${input.targetTaskId}`
  if (input.kind === 'calendar' && input.wall !== undefined) {
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${input.action} at ${pad(input.wall.hour)}:${pad(input.wall.minute)} ${input.timezone}${where}`
  }
  return `${input.action} ${input.kind}${where}`
}

/** What resuming decided for one schedule. */
export interface ResumeDecision {
  readonly status: ScheduleRecord['status']
  readonly nextAt: string
  /** The occurrence to record as missed, when resuming skipped one. */
  readonly record?: ScheduleRun
  readonly note: string
}

/**
 * Decide what resuming a paused schedule means.
 *
 * A pause is not a promise to run everything that came due while it was paused.
 * The same policy as recovery applies: a recurring schedule moves on to its next
 * occurrence and the skipped one is recorded as `missed`; a one-shot whose
 * instant has passed has nothing left to resume, so it is recorded as `missed`
 * and the schedule finishes rather than firing late and unannounced.
 *
 * @param schedule - the paused schedule.
 * @param now - the current instant.
 * @returns the status and next instant to store, with the run to record if any.
 */
export function planResume(schedule: ScheduleRecord, now: number): ResumeDecision {
  const next = Date.parse(schedule.nextAt)
  const missedAt = schedule.nextAt
  const stillAhead = Number.isFinite(next) && next > now

  if (schedule.kind === 'once') {
    if (stillAhead) return { status: 'active', nextAt: schedule.nextAt, note: 'the one-shot is still ahead and is active again' }
    return {
      status: 'completed',
      nextAt: schedule.nextAt,
      record: {
        scheduledFor: missedAt,
        outcome: 'missed',
        reason: 'the schedule was paused across its one-shot instant, so it is missed rather than fired late',
      },
      note: 'the one-shot instant passed while the schedule was paused; it is recorded as missed and the schedule is finished',
    }
  }

  if (stillAhead) return { status: 'active', nextAt: schedule.nextAt, note: 'the next occurrence is still ahead and the schedule is active again' }
  return {
    status: 'active',
    nextAt: advanceNextAt(schedule, now),
    record: {
      scheduledFor: missedAt,
      outcome: 'missed',
      reason: 'the schedule was paused across this occurrence, and a pause does not replay what it skipped',
    },
    note: 'the occurrence that came due while paused is recorded as missed; the schedule resumes at its next occurrence',
  }
}
