import { describe, expect, it } from 'vitest'
import { applyHunks, parseUnifiedDiff } from '../src/service/patch.ts'

const sample = [
  'diff --git a/report.md b/report.md',
  'index 1111111..2222222 100644',
  '--- a/report.md',
  '+++ b/report.md',
  '@@ -1,4 +1,5 @@',
  ' # Title',
  ' ',
  '-old line',
  '+new line',
  '+another new line',
  ' tail',
  '',
].join('\n')

/** The file the sample patch was made against. */
const original = '# Title\n\nold line\ntail\n'

describe('unified diff parsing (PRD §二.9.2)', () => {
  it('reads the file path and hunk ranges', () => {
    const parsed = parseUnifiedDiff(sample)
    expect(parsed.errors).toEqual([])
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0]?.path).toBe('report.md')
    expect(parsed.files[0]?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 })
  })

  it('classifies context, removal and addition lines', () => {
    const hunk = parseUnifiedDiff(sample).files[0]?.hunks[0]
    expect(hunk?.lines.map(line => line.kind)).toEqual([
      'context', 'context', 'remove', 'add', 'add', 'context',
    ])
  })

  it('reports an unreadable hunk header rather than skipping it', () => {
    const parsed = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ nonsense @@\n a\n')
    expect(parsed.errors.join(' ')).toMatch(/unreadable hunk header/)
  })

  it('reports a file with no hunks', () => {
    const parsed = parseUnifiedDiff('--- a/x\n+++ b/x\n')
    expect(parsed.errors.join(' ')).toMatch(/has no hunks/)
  })

  it('ignores the prose a git diff carries before the first file', () => {
    const parsed = parseUnifiedDiff(`commit abc\n\n${sample}`)
    expect(parsed.errors).toEqual([])
    expect(parsed.files).toHaveLength(1)
  })

  it('treats an omitted count as one line', () => {
    const parsed = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -3 +3 @@\n-a\n+b\n')
    expect(parsed.files[0]?.hunks[0]).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 })
  })

  it('refuses hunk counts that do not match the actual diff', () => {
    expect(parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n').errors.join(' ')).toContain('line counts')
  })

  it('reads removed text beginning with two dashes as hunk content', () => {
    const parsed = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- old text\n+++ new text\n')
    expect(parsed.errors).toEqual([])
    expect(applyHunks('-- old text\n', parsed.files[0]?.hunks ?? [])).toMatchObject({ content: '++ new text\n' })
  })

  it('refuses unsupported no-newline and metadata changes instead of silently dropping them', () => {
    expect(parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n').errors.join(' ')).toContain('newline')
    expect(parseUnifiedDiff('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n').errors.join(' ')).toContain('metadata')
  })
})

describe('unified diff application (PRD §二.9.2)', () => {
  it('applies a hunk at the position the diff names', () => {
    const hunk = parseUnifiedDiff(sample).files[0]?.hunks[0]
    const result = applyHunks(original, hunk === undefined ? [] : [hunk])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toBe('# Title\n\nnew line\nanother new line\ntail\n')
  })

  it('never overwrites a receiver modification: it reports a conflict instead', () => {
    const hunk = parseUnifiedDiff(sample).files[0]?.hunks[0]
    // The receiver changed the very line the patch expects to replace.
    const modified = '# Title\n\nreceiver changed this\ntail\n'
    const result = applyHunks(modified, hunk === undefined ? [] : [hunk])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/does not match the target/)
    expect(result.hunkIndex).toBe(0)
  })

  it('refuses a hunk that points past the end of the file', () => {
    const result = applyHunks('one line\n', [{
      oldStart: 50, oldLines: 1, newStart: 50, newLines: 1,
      lines: [{ kind: 'remove', text: 'x' }, { kind: 'add', text: 'y' }],
    }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/past the end of the file/)
  })

  it('leaves the original untouched when any hunk conflicts', () => {
    const parsed = parseUnifiedDiff([
      '--- a/x', '+++ b/x',
      '@@ -1,1 +1,1 @@', '-first', '+FIRST',
      '@@ -3,1 +3,1 @@', '-missing', '+MISSING',
      '',
    ].join('\n'))
    const text = 'first\nsecond\nthird\n'
    const result = applyHunks(text, parsed.files[0]?.hunks ?? [])
    expect(result.ok).toBe(false)
    // The caller still holds the original string; nothing was mutated in place.
    expect(text).toBe('first\nsecond\nthird\n')
  })

  it('applies several hunks with the running offset', () => {
    const parsed = parseUnifiedDiff([
      '--- a/x', '+++ b/x',
      '@@ -1,1 +1,2 @@', '-a', '+A', '+A2',
      '@@ -3,1 +4,1 @@', '-c', '+C',
      '',
    ].join('\n'))
    const result = applyHunks('a\nb\nc\n', parsed.files[0]?.hunks ?? [])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toBe('A\nA2\nb\nC\n')
  })

  it('preserves whether the file ended with a newline', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [
      { kind: 'remove' as const, text: 'a' }, { kind: 'add' as const, text: 'b' },
    ] }
    expect(applyHunks('a\n', [hunk])).toMatchObject({ content: 'b\n' })
    expect(applyHunks('a', [hunk])).toMatchObject({ content: 'b' })
  })

  it('applies a pure addition with no removed lines', () => {
    const hunk = { oldStart: 2, oldLines: 0, newStart: 3, newLines: 1, lines: [{ kind: 'add' as const, text: 'new' }] }
    const result = applyHunks('a\nb\n', [hunk])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toBe('a\nb\nnew\n')
  })

  it('applies a zero-count insertion at the start of an empty file', () => {
    const patch = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -0,0 +1,1 @@\n+new\n')
    expect(applyHunks('', patch.files[0]?.hunks ?? [])).toMatchObject({ ok: true, content: 'new\n' })
  })
})
