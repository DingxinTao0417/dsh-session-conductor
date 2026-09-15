import { describe, expect, it } from 'vitest'
import { buildBrief, digestBrief, renderBrief } from '../src/service/brief.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

/** Build a Host-shaped session event. */
function event(seq: number, type: string, data: unknown = {}): SessionEventLike {
  return { type, seq, time: seq, data }
}

const user = (seq: number, text: string) => event(seq, 'user/message', { content: [{ type: 'text', text }] })
const assistant = (seq: number, text: string) =>
  event(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
const turnEnd = (seq: number, kind: string) => event(seq, 'turn/end', { turn: 1, reason: { kind } })

/**
 * The brief exists so a handoff cannot quietly promote a model's proposal into a
 * human's decision. These tests pin that distinction and the cutoff behaviour.
 */
describe('handoff brief (PRD §二.2.2)', () => {
  it('takes the first human statement as the goal and marks it user-confirmed', () => {
    const brief = buildBrief([user(0, 'Design the payment interface.')], 0, 'session-a')
    expect(brief.goal).toEqual({ text: 'Design the payment interface.', provenance: 'user_confirmed', seq: 0 })
  })

  it('records a model statement as a suggestion, never as a decision', () => {
    const brief = buildBrief([
      user(0, 'Plan the work.'),
      assistant(1, 'We should use a queue.'),
    ], 1, 'session-a')
    expect(brief.decisions).toHaveLength(1)
    expect(brief.decisions[0]?.provenance).toBe('model_suggested')
  })

  it('keeps a human statement after the first as a confirmed decision', () => {
    const brief = buildBrief([
      user(0, 'Plan the work.'),
      assistant(1, 'Use a queue.'),
      user(2, 'Use a database instead.'),
    ], 2, 'session-a')
    const confirmed = brief.decisions.filter(line => line.provenance === 'user_confirmed')
    expect(confirmed.map(line => line.text)).toEqual(['Use a database instead.'])
  })

  it('files a prohibition under constraints and an acceptance rule under acceptance', () => {
    const brief = buildBrief([
      user(0, 'Build it.'),
      user(1, 'Do not touch the production database.'),
      user(2, 'It passes when the end-to-end test is green.'),
    ], 2, 'session-a')
    expect(brief.constraints.map(line => line.text)).toEqual(['Do not touch the production database.'])
    expect(brief.acceptance.map(line => line.text)).toEqual(['It passes when the end-to-end test is green.'])
  })

  it('records a failed tool and an unfinished turn as unverified open items', () => {
    const brief = buildBrief([
      user(0, 'Do it.'),
      event(1, 'tool/result', { message: { content: [{ type: 'text', text: 'ENOENT' }] }, error: { code: 'X', message: 'missing' } }),
      turnEnd(2, 'error'),
    ], 2, 'session-a')
    expect(brief.openItems).toHaveLength(2)
    expect(brief.openItems.every(item => item.provenance === 'unverified')).toBe(true)
    expect(brief.openItems[0]?.text).toMatch(/tool failed: X missing/)
    expect(brief.interruptedTurns).toBe(1)
  })

  it('does not count a cleanly completed turn as unfinished', () => {
    const brief = buildBrief([user(0, 'Do it.'), turnEnd(1, 'completed')], 1, 'session-a')
    expect(brief.interruptedTurns).toBe(0)
    expect(brief.openItems).toEqual([])
  })

  it('reads nothing past the cutoff, so the brief is exact at a stated point', () => {
    const events = [
      user(0, 'Start.'),
      assistant(1, 'A later proposal.'),
      user(2, 'A later decision.'),
    ]
    const early = buildBrief(events, 0, 'session-a')
    expect(early.decisions).toHaveLength(0)
    expect(early.cutoffSeq).toBe(0)

    const full = buildBrief(events, 2, 'session-a')
    expect(full.decisions.length).toBeGreaterThan(0)
  })

  it('collects paths and urls as references', () => {
    const brief = buildBrief([
      user(0, 'Follow https://example.com/spec and edit D:\\work\\src\\index.ts please.'),
    ], 0, 'session-a')
    const values = brief.references.map(reference => reference.value)
    expect(values).toContain('https://example.com/spec')
    expect(values.some(value => value.includes('index.ts'))).toBe(true)
  })

  it('bounds each section and says how many lines it dropped', () => {
    const events = Array.from({ length: 30 }, (_, index) => user(index, `instruction ${String(index)}`))
    const brief = buildBrief(events, 29, 'session-a', { perSection: 5, lineChars: 40 })
    expect(brief.decisions.length).toBeLessThanOrEqual(5)
    expect(brief.omitted).toBeGreaterThan(0)
    expect(renderBrief(brief)).toMatch(/omitted to keep this brief bounded/)
  })

  it('claims no goal when no human statement exists', () => {
    const brief = buildBrief([assistant(0, 'I will start.')], 0, 'session-a')
    expect(brief.goal).toBeUndefined()
    expect(renderBrief(brief)).toMatch(/No human statement was found, so no goal is claimed/)
  })

  it('renders provenance markers so a reader can tell a decision from a proposal', () => {
    const brief = buildBrief([
      user(0, 'Ship it.'),
      assistant(1, 'Perhaps use Postgres.'),
    ], 1, 'session-a')
    const text = renderBrief(brief)
    expect(text).toMatch(/confirmed by the user/)
    expect(text).toMatch(/suggested by the model/)
    expect(text).toMatch(/# Handoff brief/)
    expect(text).toMatch(/Source session: session-a/)
  })

  it('digests the rendered text so a later reader can detect a change', () => {
    const brief = buildBrief([user(0, 'Do it.')], 0, 'session-a')
    const first = digestBrief(renderBrief(brief))
    expect(first).toHaveLength(64)
    const changed = buildBrief([user(0, 'Do it.'), user(1, 'Actually, do that.')], 1, 'session-a')
    expect(digestBrief(renderBrief(changed))).not.toBe(first)
  })
})
