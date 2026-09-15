/**
 * Building a handoff brief from a session's own log (PRD §二.2.2).
 *
 * The specification fixes both the content and the honesty requirement:
 *
 * - the brief carries the goal, the confirmed decisions, the constraints, the
 *   references, the unfinished items and the acceptance conditions;
 * - it must **distinguish** a decision the user confirmed, a suggestion the
 *   model made, and something nothing has verified.
 *
 * That last rule is what shapes this module. Nothing here is inferred by asking
 * a model to summarise: every line is derived deterministically from events the
 * Host recorded, and every line carries the provenance that produced it. A model
 * suggestion is labelled as a suggestion because it came from an assistant
 * message; a user statement is labelled confirmed because a human wrote it. When
 * the evidence for a section is absent, the section says so rather than being
 * filled with a plausible guess.
 *
 * @module dsh-session-conductor/service/brief
 */

import { createHash } from 'node:crypto'
import type { SessionEventLike } from './projection.ts'

/** Where one brief line came from, in the vocabulary PRD §二.2.2 requires. */
export type Provenance =
  /** A human wrote it in the session; treated as confirmed. */
  | 'user_confirmed'
  /** A model produced it; a proposal until a human acts on it. */
  | 'model_suggested'
  /** A tool returned it; nothing has verified what it means. */
  | 'unverified'

/** One labelled line of a brief. */
export interface BriefLine {
  readonly text: string
  readonly provenance: Provenance
  /** Event sequence the line came from, so the reader can go and look. */
  readonly seq: number
}

/** A reference to something outside the conversation. */
export interface BriefReference {
  readonly kind: 'path' | 'url'
  readonly value: string
  readonly seq: number
}

/** The whole brief. */
export interface Brief {
  readonly sourceSessionId: string
  readonly cutoffSeq: number
  readonly goal: BriefLine | undefined
  readonly decisions: BriefLine[]
  readonly constraints: BriefLine[]
  readonly openItems: BriefLine[]
  readonly acceptance: BriefLine[]
  readonly references: BriefReference[]
  /** Turns that ended without finishing, which is what "unfinished" is read from. */
  readonly interruptedTurns: number
  /** Lines dropped because the brief hit its size bound. */
  readonly omitted: number
}

/** How large a generated brief may grow before it is trimmed. */
export interface BriefBudget {
  /** Maximum lines kept per section. */
  readonly perSection: number
  /** Maximum characters in one line. */
  readonly lineChars: number
}

/** The default budget: enough to hand work over, small enough to deliver. */
export const DEFAULT_BRIEF_BUDGET: BriefBudget = { perSection: 20, lineChars: 600 }

/** The latest evidence for one section, before trimming. */
interface Section {
  readonly lines: BriefLine[]
  omitted: number
}

/**
 * Build a brief from a session's events.
 *
 * Only events at or below `cutoffSeq` are read, so the brief is exact at a
 * stated point rather than racing the session as it runs.
 *
 * @param events - the session's events in log order.
 * @param cutoffSeq - the last sequence number to include.
 * @param sourceSessionId - the session the brief describes.
 * @param budget - size bounds; defaults to {@link DEFAULT_BRIEF_BUDGET}.
 * @returns the brief.
 */
export function buildBrief(
  events: readonly SessionEventLike[],
  cutoffSeq: number,
  sourceSessionId: string,
  budget: BriefBudget = DEFAULT_BRIEF_BUDGET,
): Brief {
  const usable = events.filter(event => event.seq <= cutoffSeq)
  const goalSection = section()
  const decisions = section()
  const constraints = section()
  const openItems = section()
  const acceptance = section()
  const references: BriefReference[] = []
  let interruptedTurns = 0
  let sawUser = false

  for (const event of usable) {
    const data = (event.data ?? {}) as Record<string, unknown>
    switch (event.type) {
      case 'user/message': {
        const text = contentText(data['content']).trim()
        if (text.length === 0) break
        // The first human statement is the task's goal. Every later one is a
        // decision or a correction, both of which a human confirmed by writing.
        if (!sawUser && goalSection.lines.length === 0) {
          push(goalSection, { text, provenance: 'user_confirmed', seq: event.seq }, budget)
        } else {
          // A later human statement is a decision, a constraint or an acceptance
          // condition, depending on how it is worded.
          const lower = text.toLowerCase()
          const target = /must not|don't|do not|never|prohibited|forbidden|禁止|不要|不得/.test(lower)
            ? constraints
            : /accept|pass|done when|验收|通过标准/.test(lower)
              ? acceptance
              : decisions
          push(target, { text, provenance: 'user_confirmed', seq: event.seq }, budget)
        }
        sawUser = true
        collectReferences(text, event.seq, references)
        break
      }
      case 'assistant/message': {
        const message = data['message'] as { content?: unknown } | undefined
        const text = contentText(message?.content).trim()
        if (text.length === 0) break
        // A model statement is a proposal. It is recorded as such even when it
        // reads like a decision, because no human has acted on it.
        push(decisions, { text, provenance: 'model_suggested', seq: event.seq }, budget)
        collectReferences(text, event.seq, references)
        break
      }
      case 'tool/result': {
        const message = data['message'] as { content?: unknown } | undefined
        const failed = data['error'] !== undefined
        const text = contentText(message?.content).trim()
        if (failed) {
          const error = data['error'] as { code?: unknown; message?: unknown } | undefined
          const code = error?.code === undefined ? '' : `${String(error.code)} `
          const detail = error?.message === undefined ? '' : String(error.message)
          push(openItems, {
            text: `tool failed: ${code}${detail}`.trim() + (text.length === 0 ? '' : ` — ${text}`),
            provenance: 'unverified',
            seq: event.seq,
          }, budget)
        }
        collectReferences(text, event.seq, references)
        break
      }
      case 'turn/end': {
        const reason = data['reason'] as { kind?: unknown } | undefined
        const kind = reason?.kind === undefined ? 'unknown' : String(reason.kind)
        if (kind !== 'completed') {
          interruptedTurns += 1
          push(openItems, {
            text: `a turn ended without finishing (${kind})`,
            provenance: 'unverified',
            seq: event.seq,
          }, budget)
        }
        break
      }
      default:
        break
    }
  }

  return {
    sourceSessionId,
    cutoffSeq,
    goal: goalSection.lines[0],
    decisions: decisions.lines,
    constraints: constraints.lines,
    openItems: openItems.lines,
    acceptance: acceptance.lines,
    references: references.slice(0, budget.perSection),
    interruptedTurns,
    omitted: goalSection.omitted + decisions.omitted + constraints.omitted + openItems.omitted + acceptance.omitted,
  }
}

/** A fresh empty section. */
function section(): Section {
  return { lines: [], omitted: 0 }
}

/**
 * Add a line to a section, honouring the section bound.
 * @param target - the section to add to.
 * @param line - the line to add.
 * @param budget - the size bounds.
 */
function push(target: Section, line: BriefLine | undefined, budget: BriefBudget): void {
  if (line === undefined) return
  if (target.lines.length >= budget.perSection) {
    target.omitted += 1
    return
  }
  target.lines.push({ ...line, text: trim(line.text, budget.lineChars) })
}

/**
 * Extract file paths and URLs mentioned in text.
 * @param text - the text to scan.
 * @param seq - the event sequence.
 * @param into - the reference accumulator.
 */
function collectReferences(text: string, seq: number, into: BriefReference[]): void {
  for (const match of text.matchAll(/https?:\/\/[^\s)"'<>]+/g)) {
    into.push({ kind: 'url', value: match[0], seq })
  }
  // Windows and POSIX absolute paths, kept narrow so prose is not mistaken for
  // a file reference.
  for (const match of text.matchAll(/[A-Za-z]:\\[^\s"'<>|]+|\/(?:[\w.-]+\/)+[\w.-]+/g)) {
    into.push({ kind: 'path', value: match[0], seq })
  }
}

/**
 * Flatten a message content field into text.
 * @param content - the content blocks, however shaped.
 * @returns the joined text.
 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block === 'object' && block !== null && 'text' in block) {
      parts.push(String((block as { text: unknown }).text))
    }
  }
  return parts.join('\n')
}

/**
 * Bound one line, marking that it was cut.
 * @param text - the line.
 * @param limit - the maximum length.
 * @returns the line, marked when shortened.
 */
function trim(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [truncated]`
}

/**
 * Render a brief as the text handed to another session.
 *
 * Every line keeps its provenance marker. The reader is told which statements a
 * human confirmed and which are only proposals, because the specification
 * requires the distinction to survive into the handoff rather than being lost at
 * the point it matters most.
 *
 * @param brief - the brief to render.
 * @returns the model-facing text.
 */
export function renderBrief(brief: Brief): string {
  const lines: string[] = [
    '# Handoff brief',
    '',
    `Source session: ${brief.sourceSessionId}`,
    `Exact through event seq ${String(brief.cutoffSeq)}.`,
    '',
    '## Goal',
  ]
  lines.push(brief.goal === undefined
    ? '_No human statement was found, so no goal is claimed._'
    : `- ${brief.goal.text} _(confirmed by the user; seq ${String(brief.goal.seq)})_`)

  appendSection(lines, 'Confirmed decisions and instructions', brief.decisions)
  appendSection(lines, 'Constraints', brief.constraints)
  appendSection(lines, 'Acceptance conditions', brief.acceptance)
  appendSection(lines, 'Unfinished items', brief.openItems)

  lines.push('', '## References')
  if (brief.references.length === 0) {
    lines.push('_None found in the conversation._')
  } else {
    for (const reference of brief.references) {
      lines.push(`- ${reference.value} (${reference.kind}, seq ${String(reference.seq)})`)
    }
  }

  lines.push(
    '',
    '## Provenance',
    '- `confirmed by the user` — a human wrote it in the source session.',
    '- `suggested by the model` — a proposal nothing has acted on.',
    '- `unverified` — observed from a tool or a turn outcome, with no confirmation.',
  )
  if (brief.omitted > 0) {
    lines.push('', `_${String(brief.omitted)} further line(s) were omitted to keep this brief bounded._`)
  }
  return lines.join('\n')
}

/**
 * Render one brief as a task's **starting context** (PRD §二.2.2).
 *
 * The body is {@link renderBrief}'s, so a brief delivered at creation and one read later say the
 * same thing about the same cutoff. The framing above it is what delivery needs and the handoff
 * rendering does not:
 *
 * - the text is generated by the plugin and is **not a user message**, which matters because it is
 *   injected as a plugin-sourced message and must not be readable as something the human said;
 * - an empty brief is stated as empty rather than left as a bare heading, so a task whose source
 *   had no completed turn can tell "nothing to carry" from "the brief failed".
 *
 * @param brief - the built brief.
 * @param sourceSessionId - the session it was taken from.
 * @returns the text to inject.
 */
export function renderStartingContext(brief: Brief, sourceSessionId: string): string {
  const cutoff = brief.cutoffSeq < 0
    ? 'The source session has not completed a turn yet, so this starting context is empty on purpose: nothing is '
      + 'claimed about goals, decisions or constraints.'
    : `It is exact through event seq ${String(brief.cutoffSeq)} of session ${sourceSessionId}.`
  return [
    '[dsh-session-conductor] Starting context for this task, generated from a previous session.',
    cutoff,
    'Items marked "confirmed by the user" were written by a human; the other provenance labels were not. '
    + 'This text was produced by the plugin, not sent by the user.',
    '',
    renderBrief(brief),
  ].join('\n')
}

/** The provenance label shown for each kind. */
const PROVENANCE_LABEL: Record<Provenance, string> = {
  user_confirmed: 'confirmed by the user',
  model_suggested: 'suggested by the model',
  unverified: 'unverified',
}

/**
 * Append one rendered section.
 * @param lines - the output accumulator.
 * @param heading - the section heading.
 * @param entries - the section's lines.
 */
function appendSection(lines: string[], heading: string, entries: readonly BriefLine[]): void {
  lines.push('', `## ${heading}`)
  if (entries.length === 0) {
    lines.push('_Nothing recorded._')
    return
  }
  for (const entry of entries) {
    lines.push(`- ${entry.text} _(${PROVENANCE_LABEL[entry.provenance]}; seq ${String(entry.seq)})_`)
  }
}

/**
 * Digest a rendered brief, so a later reader can tell whether it changed.
 * @param rendered - the rendered text.
 * @returns a hex digest.
 */
export function digestBrief(rendered: string): string {
  return createHash('sha256').update(rendered).digest('hex')
}
