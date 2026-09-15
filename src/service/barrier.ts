/**
 * The report-triggered write barrier (PRD §二.8.1).
 *
 * > 仅由回报触发的执行禁止调用协调写接口；服务端执行此限制，提示词只作为辅助。
 *
 * A report is an *observation*. If a turn that a report opened could then create
 * tasks, send instructions, stop turns or schedule work, the report would have
 * become an authorisation — and the thing that produced the report would be
 * deciding the next step, which PRD §二.8.2 and AGENTS.md both forbid. A prompt
 * telling the model not to do it is advice; this module is the guarantee.
 *
 * **Why the session log is the right place to look.** The Host records each
 * message's `source` in the durable log — `{kind:'plugin', plugin, form:'notice',
 * summary}` for our reports, `{kind:'user'}` for a person, `{kind:'plugin',
 * form:'relay'}` for a forwarded instruction. So the question "was this turn
 * opened by a report?" is answerable from Host facts that no tool argument can
 * forge, which is exactly the property PRD §三.2 requires of caller identity.
 *
 * **Why the *last* message wins.** Scanning backwards for the most recent
 * user-role message means a person who speaks after a report has re-authorised the
 * work: their message is now the last one, and the barrier lifts. That is the
 * behaviour the rule is for — it stops a report from *being* an authorisation, not
 * from ever being followed by one.
 *
 * @module dsh-session-conductor/service/barrier
 */

import type { SessionEventLike } from './projection.ts'

/** What the caller's own session says about how its current turn began. */
export interface TurnOrigin {
  /** True when the turn was opened by a conductor report. */
  readonly reportTriggered: boolean
  /** The source of the message that opened the turn, when one could be read. */
  readonly source?: unknown
  /** Why the answer is what it is, for the refusal text and for tests. */
  readonly reason: string
}

/** The plugin name a conductor notice carries. */
const CONDUCTOR_PLUGIN = 'dsh-session-conductor'

/**
 * Context forms that ride along with whatever turn runs.
 *
 * The Host's own `ContextForm` vocabulary separates these from `notice` on purpose:
 * a `notice` is "a one-off account of something that just happened", while a
 * `snapshot` is "current state, where a later snapshot from the same producer
 * supersedes an earlier one" and a `catalog` is a republished list. So a snapshot is
 * not a prompt — it is context attached to a turn that something else opened.
 *
 * This distinction is the whole answer, and it was measured rather than reasoned:
 * on a live Host the system-prompt `snapshot` is appended *before* `turn/start`, so
 * a turn boundary cannot separate it from the message that opened the turn. Reading
 * "the last user message" concluded "not a report" and let the barrier lift.
 */
const CONTEXT_FORMS: readonly string[] = ['snapshot', 'catalog', 'instructions', 'recall']

/** The source of one user-role message. */
function sourceOf(event: SessionEventLike): unknown {
  const data = event.data
  return typeof data === 'object' && data !== null ? (data as { source?: unknown }).source : undefined
}

/** Whether a source is Host-injected context rather than something that opens a turn. */
function isContextInjection(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const form = (source as { form?: unknown }).form
  return typeof form === 'string' && CONTEXT_FORMS.includes(form)
}

/**
 * Decide whether the calling session's current turn was opened by a report.
 *
 * The opening message is the most recent user-role message that is *not*
 * Host-injected context. From there, in order:
 *
 * 1. If a **person** spoke at or after that message — opening the turn or steering
 *    into it — the barrier does not apply. That is the behaviour the rule is for: it
 *    stops a report from *being* an authorisation, not from ever being followed by
 *    one.
 * 2. Otherwise, if the opening message is a plugin `notice`, the barrier applies. Any
 *    plugin's notice counts, not only this plugin's: §二.8.1 is about reports, and
 *    another plugin's report is no more an authorisation than ours.
 * 3. A relay is not a report. It is a message a controller deliberately addressed to
 *    this session, so it carries that controller's authorisation.
 *
 * Deliberately conservative in one direction only: an unreadable or unrecognised
 * source is **not** treated as report-triggered, because refusing every write for a
 * Host whose log this code cannot read would break ordinary use. The cost of that
 * choice is stated in the docs rather than hidden: on such a Host the barrier does
 * not apply, and the prompt-level instruction is all that remains.
 *
 * @param events - the calling session's events; undefined when they cannot be read.
 * @returns the origin, never throwing.
 */
export function turnOriginOf(events: readonly SessionEventLike[] | undefined): TurnOrigin {
  if (events === undefined) {
    return { reportTriggered: false, reason: 'the calling session\'s log could not be read, so its turn origin is unknown' }
  }

  const prompts: { readonly seq: number; readonly source: unknown }[] = []
  let sawContextOnly = false
  for (const event of events) {
    // Only `user/message` is a prompt. A tool result is `tool/result`, so it is a
    // different type and cannot be mistaken for one — which matters, because a tool
    // result sits between the prompt and the tool call it produced.
    if (event.type !== 'user/message') continue
    const source = sourceOf(event)
    if (isContextInjection(source)) {
      sawContextOnly = true
      continue
    }
    prompts.push({ seq: typeof event.seq === 'number' ? event.seq : 0, source })
  }
  if (prompts.length === 0) {
    return {
      reportTriggered: false,
      reason: sawContextOnly
        ? 'the log holds only Host-injected context, which opens no turn, so the turn origin is unknown'
        : 'no user-role message could be read, so the turn origin is unknown',
    }
  }

  const opening = prompts[prompts.length - 1]
  const spokenAfter = prompts.some(entry =>
    entry.seq >= (opening?.seq ?? 0)
    && typeof entry.source === 'object' && entry.source !== null
    && (entry.source as { kind?: unknown }).kind === 'user')
  if (spokenAfter) {
    return {
      reportTriggered: false,
      source: opening?.source,
      reason: 'a person spoke in this turn, so it is not a report-triggered turn',
    }
  }

  const source = opening?.source
  if (typeof source !== 'object' || source === null) {
    return { reportTriggered: false, source, reason: `the opening message's source is ${JSON.stringify(source)}` }
  }
  const record = source as { kind?: unknown; plugin?: unknown; form?: unknown }
  if (record.kind === 'plugin' && record.form === 'notice') {
    const fromConductor = record.plugin === CONDUCTOR_PLUGIN
    return {
      reportTriggered: true,
      source,
      reason: `the turn was opened by a ${fromConductor ? 'conductor' : 'plugin'} notice report`,
    }
  }
  return {
    reportTriggered: false,
    source,
    reason: `the turn was opened by a ${String(record.kind)} message, which is not a report`,
  }
}

/**
 * The source of the message that opened the current turn, when the log can name one.
 *
 * Same reading {@link turnOriginOf} uses: the last user-role prompt that is not
 * Host-injected context. A budget cancel uses this to refuse native-interface turns
 * rather than guessing.
 *
 * @param events - the session's events; undefined when they cannot be read.
 * @returns the source, or undefined when none could be attributed.
 */
export function lastPromptSource(events: readonly SessionEventLike[] | undefined): unknown {
  return turnOriginOf(events).source
}
