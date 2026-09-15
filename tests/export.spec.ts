import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REDACTIONS,
  EXPORT_FORMATS,
  NOT_RESTORABLE_NOTE,
  SHARE_RULES,
  buildExport,
  redactEnvironment,
  redactToolOutput,
  renderJson,
  renderMarkdown,
  shareAvailability,
  type ExportInput,
} from '../src/service/export.ts'

const AT = '2026-09-13T12:00:00.000Z'

/** An export input with the members a test cares about overridden. */
function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    format: 'markdown',
    cutoffAt: AT,
    task: { taskId: 'task-1', title: 'Ship the feature', preparation: 'ready' },
    sessionChain: [
      { bindingId: 'binding-1', sessionId: 'session-1', version: 1, retired: true },
      { bindingId: 'binding-2', sessionId: 'session-2', version: 2 },
    ],
    runStatus: { execution: 'idle', lastTurn: 'completed' },
    artifacts: [
      { artifactId: 'artifact-1', kind: 'file', version: 3, existence: 'present', acceptance: 'pass' },
    ],
    ...over,
  }
}

describe('what an export contains (PRD §二.14.2)', () => {
  it('carries the cutoff, the session chain, the run status and the artifact versions', () => {
    const snapshot = buildExport(input())
    expect(snapshot.cutoffAt).toBe(AT)
    expect(snapshot.sessionChain.map(binding => binding.sessionId)).toEqual(['session-1', 'session-2'])
    expect(snapshot.runStatus.execution).toBe('idle')
    expect(snapshot.artifacts[0]).toMatchObject({ artifactId: 'artifact-1', version: 3, acceptance: 'pass' })
  })

  it('marks the retired half of the chain rather than dropping it', () => {
    // The chain is what shows the task moved between sessions; keeping only the current
    // binding would hide the history the export exists to record.
    const snapshot = buildExport(input())
    expect(snapshot.sessionChain[0]?.retired).toBe(true)
    expect(snapshot.sessionChain[1]?.retired).toBeUndefined()
  })

  it('says it is not a restore package, in the document itself', () => {
    const snapshot = buildExport(input())
    expect(snapshot.notRestorable).toBe(true)
    expect(snapshot.notRestorableNote).toContain('not a restore package')
    expect(snapshot.notRestorableNote).toContain('cannot be replayed')
    expect(renderMarkdown(snapshot)).toContain(NOT_RESTORABLE_NOTE)
  })

  it('reports whether an attachment bundle was included', () => {
    const none = buildExport(input())
    expect(none.attachments.included).toBe(false)
    expect(none.attachments.note).toMatch(/No attachment bundle was requested/)

    const some = buildExport(input({ attachmentIds: ['artifact-1', 'artifact-2'] }))
    expect(some.attachments.included).toBe(true)
    expect(some.attachments.artifactIds).toEqual(['artifact-1', 'artifact-2'])
    // The bundle is a separate set of files; the document says which artifacts it holds.
    expect(some.attachments.note).toMatch(/contents are not embedded/)
  })

  it('supports both formats', () => {
    for (const format of EXPORT_FORMATS) {
      const snapshot = buildExport(input({ format }))
      expect(snapshot.format).toBe(format)
    }
  })
})

describe('what an export leaves out (PRD §二.14.2)', () => {
  it('names every exclusion rather than only the inclusions', () => {
    // A reader who cannot tell whether a credential was omitted or was never there
    // cannot check the export.
    const snapshot = buildExport(input())
    expect(snapshot.redactions.map(redaction => redaction.what)).toEqual([
      'credentials and tokens',
      'environment variable values',
      'full raw tool output',
    ])
    for (const redaction of snapshot.redactions) expect(redaction.why.length).toBeGreaterThan(0)
  })

  it('keeps environment variable NAMES and withholds every value', () => {
    // Names are what a reader needs; values are what leak.
    const redacted = redactEnvironment({ PATH: '/usr/bin', DSH_TOKEN: 'secret-value', UNSET: undefined })
    expect(Object.keys(redacted).sort()).toEqual(['DSH_TOKEN', 'PATH', 'UNSET'])
    expect(redacted['DSH_TOKEN']).toBe('(value withheld)')
    expect(JSON.stringify(redacted)).not.toContain('secret-value')
    expect(JSON.stringify(redacted)).not.toContain('/usr/bin')
  })

  it('distinguishes an unset variable from a withheld one', () => {
    // Collapsing them would tell a reader the opposite of the truth.
    const redacted = redactEnvironment({ A: undefined, B: 'x' })
    expect(redacted['A']).toBe('(not set)')
    expect(redacted['B']).toBe('(value withheld)')
    expect(redacted['A']).not.toBe(redacted['B'])
  })

  it('reduces raw tool output to a summary', () => {
    const raw = 'line one\nSECRET=abc\nline three'
    const summary = redactToolOutput(raw)
    expect(summary).toContain('raw output withheld')
    expect(summary).toContain(String(raw.length))
    expect(summary).not.toContain('line one')
    expect(summary).not.toContain('SECRET=abc')
    expect(summary).not.toContain('line three')
  })

  it('cannot leak a field it was never given', () => {
    // The document is assembled from an allow-list, so an unknown field on the input
    // does not reach the export at all. This is the direction the choice has to go: a
    // deny-list has to anticipate every name a secret might have.
    const snapshot = buildExport({ ...input(), apiKey: 'should-never-appear' } as unknown as ExportInput)
    expect(JSON.stringify(snapshot)).not.toContain('should-never-appear')
  })

  it('withholds secrets even when raw output starts with them', () => {
    expect(redactToolOutput('TOKEN=private-value\n')).not.toContain('private-value')
  })

  it('allow-lists artifact fields instead of spreading stored metadata into JSON', () => {
    const artifact = {
      artifactId: 'a', kind: 'file', version: 1, existence: 'present', acceptance: 'pending',
      credentials: { token: 'artifact-private-value' }, rawOutput: 'private-bytes',
    }
    const snapshot = buildExport(input({ artifacts: [artifact] }))
    expect(Object.keys(snapshot.artifacts[0] ?? {}).sort()).toEqual([
      'acceptance', 'artifactId', 'existence', 'kind', 'version',
    ])
    expect(renderJson(snapshot)).not.toContain('private')
  })

  it('exports no field outside the ones it names', () => {
    const snapshot = buildExport(input({ task: { taskId: 't', title: 'x', preparation: 'ready', secret: 'leak' } as never }))
    expect(Object.keys(snapshot.task)).toEqual(['taskId', 'title', 'preparation'])
    expect(JSON.stringify(snapshot)).not.toContain('leak')
  })

  it('lists the same exclusions in both formats', () => {
    const markdown = renderMarkdown(buildExport(input()))
    for (const redaction of DEFAULT_REDACTIONS) expect(markdown).toContain(redaction.what)
    const json = JSON.parse(renderJson(buildExport(input({ format: 'json' })))) as { redactions: unknown[] }
    expect(json.redactions).toHaveLength(DEFAULT_REDACTIONS.length)
  })
})

describe('rendering an export (PRD §二.14.2)', () => {
  it('renders a Markdown document naming the task, the chain, the artifacts and the exclusions', () => {
    const text = renderMarkdown(buildExport(input({ attachmentIds: ['artifact-1'] })))
    expect(text).toContain('# Export: Ship the feature')
    expect(text).toContain('## Session chain')
    expect(text).toContain('## Artifacts')
    expect(text).toContain('## Excluded from this export')
    expect(text).toContain('## What this is')
    expect(text).toContain('v2 `session-2`')
    expect(text).toContain('任务继续于新会话 session-2（此前 session-1）')
    expect(renderMarkdown(buildExport(input({
      runStatus: { execution: 'idle', lastTurn: 'failed', lastTurnDetail: 'MISSING_CREDENTIAL: no API key' },
    })))).toContain('- Recent progress: MISSING_CREDENTIAL: no API key')
  })

  it('says when nothing is bound or recorded rather than rendering an empty section', () => {
    const text = renderMarkdown(buildExport(input({ sessionChain: [], artifacts: [] })))
    expect(text).toContain('No session is bound to this task.')
    expect(text).toContain('No artifacts are recorded.')
  })

  it('produces JSON that parses back to the snapshot', () => {
    const snapshot = buildExport(input({ format: 'json' }))
    expect(JSON.parse(renderJson(snapshot))).toEqual(snapshot)
  })
})

describe('the share surface is off, with a reason (PRD §二.14.2)', () => {
  it('reports the configured client without treating that as publication or reachability', () => {
    expect(shareAvailability(true, true)).toMatchObject({ available: true })
    expect(shareAvailability(true, true).reason).toMatch(/confirmation/)
    expect(shareAvailability(false, true).available).toBe(false)
  })
  it('is unavailable by default and says what would have to exist', () => {
    const availability = shareAvailability(false)
    expect(availability.available).toBe(false)
    expect(availability.reason).toMatch(/disabled by default/)
    expect(availability.reason).toMatch(/self-hosted HTTPS snapshot service/)
    expect(availability.reason).toMatch(/does not stand in for one/)
  })

  it('is still unavailable when enabled but no service exists, and says nothing was shared', () => {
    // Refusing with a reason is the implementation, not a placeholder for one.
    const availability = shareAvailability(true)
    expect(availability.available).toBe(false)
    expect(availability.reason).toMatch(/nothing has been uploaded/)
    expect(availability.reason).toMatch(/nothing has been shared/)
  })

  it('records the six rules a published snapshot would have to obey', () => {
    expect(SHARE_RULES).toHaveLength(6)
    expect(SHARE_RULES.join(' ')).toMatch(/preview/)
    expect(SHARE_RULES.join(' ')).toMatch(/7 days/)
    expect(SHARE_RULES.join(' ')).toMatch(/cannot recall copies/)
    expect(SHARE_RULES.join(' ')).toMatch(/no way to execute/)
  })
})
