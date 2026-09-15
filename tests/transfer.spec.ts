import { describe, expect, it } from 'vitest'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import {
  buildReference,
  contentDigest,
  patchHandoff,
  snapshotCopy,
  type TransferFsPort,
} from '../src/service/transfer.ts'
import { newArtifactRecord } from '../src/service/artifacts.ts'
import type { ArtifactRecord } from '../src/store/schema.ts'

const NOW = '2026-09-13T00:00:00.000Z'

/** A verified, unchanged artifact pointing at a text file. */
function pinnedArtifact(content: string, over: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    ...newArtifactRecord({
      artifactId: 'artifact-1',
      taskId: 'task-source',
      kind: 'file',
      name: 'report.md',
      hostId: 'local',
      path: 'D:\\src\\report.md',
    }, NOW),
    existence: 'present',
    contentHash: contentDigest(content),
    hashScope: 'full',
    ...over,
  }
}

/** An in-memory filesystem that records writes so a test can prove none happened. */
function fakeFs(files: Map<string, string>): TransferFsPort & { writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    resolve: async (path) => path,
    stat: async (target) => {
      const content = files.get(String(target))
      return content === undefined ? undefined : { size: content.length, version: contentDigest(content) as FsVersion }
    },
    readText: async (target) => {
      const content = files.get(String(target))
      if (content === undefined) throw new Error(`ENOENT: ${String(target)}`)
      return content
    },
    writeText: async (target, content, expected) => {
      const held = files.get(String(target))
      if (expected.kind === 'createIfAbsent' && held !== undefined) throw new Error('FS_NOT_OBSERVED')
      if (expected.kind === 'replaceIfVersion' && (held === undefined || contentDigest(held) !== expected.version)) {
        throw new Error('FS_STALE_VERSION')
      }
      writes.push(String(target))
      files.set(String(target), content)
    },
  }
}

describe('reference handoff (PRD §二.9.2)', () => {
  it('carries identity, location, version and whether it is safe to depend on', () => {
    const artifact = pinnedArtifact('hello')
    const { record, reference } = buildReference({
      transferId: 't1', artifact, toTaskId: 'task-receiver', now: NOW,
    })
    expect(record.provided).toBe(true)
    expect(record.applied).toBe(false)
    expect(reference).toMatch(/artifact-1/)
    expect(reference).toMatch(/content version: 0/)
    expect(reference).toMatch(/content hash/)
    expect(reference).toMatch(/fixed input for an automatic dependency: yes/)
  })

  it('warns the receiver when the artifact is not a usable fixed input', () => {
    const artifact = pinnedArtifact('hello', { existence: 'changed' })
    const { reference } = buildReference({
      transferId: 't1', artifact, toTaskId: 'task-receiver', now: NOW,
    })
    expect(reference).toMatch(/fixed input for an automatic dependency: no/)
    expect(reference).toMatch(/changed since it was verified/)
  })
})

describe('snapshot copy (PRD §二.9.2)', () => {
  it('guards creation when a receiver creates the destination after the absence check', async () => {
    const files = new Map([['D:\\src\\report.md', 'hello']])
    const fs = fakeFs(files)
    const racing: TransferFsPort = {
      ...fs,
      writeText: async (target, text, expected, signal) => {
        files.set(String(target), 'receiver won')
        return await fs.writeText(target, text, expected, signal)
      },
    }
    const { record } = await snapshotCopy({
      transferId: 't1', artifact: pinnedArtifact('hello'), toTaskId: 'task-receiver',
      destination: 'D:\\dst\\report.md', now: NOW,
    }, racing)
    expect(record.applied).toBe(false)
    expect(files.get('D:\\dst\\report.md')).toBe('receiver won')
  })
  it('refuses to overwrite receiver content already at the destination', async () => {
    const files = new Map([['D:\\src\\report.md', 'hello'], ['D:\\dst\\report.md', 'receiver work']])
    const fs = fakeFs(files)
    const { record } = await snapshotCopy({
      transferId: 't1', artifact: pinnedArtifact('hello'), toTaskId: 'task-receiver',
      destination: 'D:\\dst\\report.md', now: NOW,
    }, fs)
    expect(record.applied).toBe(false)
    expect(fs.writes).toEqual([])
    expect(files.get('D:\\dst\\report.md')).toBe('receiver work')
  })

  it('copies verified content and confirms it by reading back', async () => {
    const files = new Map([['D:\\src\\report.md', 'hello']])
    const fs = fakeFs(files)
    const { record } = await snapshotCopy({
      transferId: 't1',
      artifact: pinnedArtifact('hello'),
      toTaskId: 'task-receiver',
      destination: 'D:\\dst\\report.md',
      now: NOW,
    }, fs)

    expect(record.provided).toBe(true)
    expect(record.applied).toBe(true)
    expect(record.verified).toBe(true)
    expect(record.conflicts).toEqual([])
    expect(files.get('D:\\dst\\report.md')).toBe('hello')
  })

  it('refuses to copy an artifact nothing has verified', async () => {
    const fs = fakeFs(new Map([['D:\\src\\report.md', 'hello']]))
    const unverified: ArtifactRecord = {
      ...newArtifactRecord({
        artifactId: 'a', taskId: 'task-source', kind: 'file', name: 'r', hostId: 'local', path: 'D:\\src\\report.md',
      }, NOW),
    }
    const { record } = await snapshotCopy({
      transferId: 't1', artifact: unverified, toTaskId: 'task-receiver', destination: 'D:\\dst\\r', now: NOW,
    }, fs)

    expect(record.provided).toBe(false)
    expect(record.applied).toBe(false)
    expect(fs.writes).toEqual([])
    expect(record.conflicts[0]).toMatch(/nothing has verified that this artifact exists/)
  })

  it('refuses when the source changed between verification and the copy', async () => {
    const files = new Map([['D:\\src\\report.md', 'changed since verification']])
    const fs = fakeFs(files)
    const { record } = await snapshotCopy({
      transferId: 't1',
      artifact: pinnedArtifact('what it was when verified'),
      toTaskId: 'task-receiver',
      destination: 'D:\\dst\\report.md',
      now: NOW,
    }, fs)

    expect(record.applied).toBe(false)
    expect(fs.writes).toEqual([])
    expect(record.conflicts[0]).toMatch(/changed between verification and the copy/)
  })

  it('reports a copy that does not match the source rather than calling it verified', async () => {
    const files = new Map([['D:\\src\\report.md', 'hello']])
    const fs = fakeFs(files)
    // A destination that silently mangles what it stores.
    const mangling: TransferFsPort = {
      ...fs,
      writeText: async (target, content) => { files.set(String(target), `${content}!`) },
    }
    const { record } = await snapshotCopy({
      transferId: 't1', artifact: pinnedArtifact('hello'), toTaskId: 'task-receiver', destination: 'D:\\dst\\r', now: NOW,
    }, mangling)

    expect(record.applied).toBe(true)
    expect(record.verified).toBe(false)
    expect(record.conflicts.join(' ')).toMatch(/does not match the source/)
  })
})

describe('patch handoff (PRD §二.9.2, T18)', () => {
  const original = 'line one\nline two\nline three\n'
  const diff = [
    '--- a/target.txt', '+++ b/target.txt',
    '@@ -1,3 +1,3 @@',
    ' line one',
    '-line two',
    '+line TWO',
    ' line three',
    '',
  ].join('\n')

  /** A request over the given target content. */
  function request(files: Map<string, string>, over: Partial<Parameters<typeof patchHandoff>[0]> = {}) {
    return {
      transferId: 't1',
      artifact: pinnedArtifact(original, { path: 'D:\\src\\target.txt' }),
      toTaskId: 'task-receiver',
      target: 'D:\\dst\\target.txt',
      diff,
      apply: true,
      now: NOW,
      ...over,
    }
  }

  it('refuses a multi-file patch instead of applying only its first file', async () => {
    // PRD §二.9.2: the handover states which files it involves and applies the change **or refuses
    // it**, never some of it. This used to take `parsed.files[0]`, so a two-file diff applied its
    // first file and reported `applied`/`verified` for "the patch" — a partial application reading as
    // a complete one.
    const twoFiles = [
      '--- a/target.txt',
      '+++ b/target.txt',
      '@@ -1,2 +1,2 @@',
      ' alpha',
      '-bravo',
      '+BETA',
      '--- a/other.txt',
      '+++ b/other.txt',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
    ].join('\n')
    const files = new Map([['D:\\dst\\target.txt', original]])
    const fs = fakeFs(files)
    const { record } = await patchHandoff(request(files, { diff: twoFiles }), fs)

    expect(record.applied).toBe(false)
    expect(record.verified).toBe(false)
    // Nothing was written at all — not even the file the patch did describe correctly.
    expect(fs.writes).toEqual([])
    expect(files.get('D:\\dst\\target.txt')).toBe(original)
    // And the refusal names every file involved, so the caller can split the patch itself.
    expect(record.conflicts.join(' ')).toMatch(/changes 2 files \(target\.txt, other\.txt\)/)
    expect(record.conflicts.join(' ')).toMatch(/refused rather than applied in part/)
  })

  it('names the files a patch involves, so "what does this touch" is answerable', async () => {
    const files = new Map([['D:\\dst\\target.txt', original]])
    const fs = fakeFs(files)
    const { record } = await patchHandoff(request(files, { apply: false }), fs)
    expect(record.evidence.join(' ')).toMatch(/the patch involves 1 file\(s\): target\.txt/)
  })

  it('checks the baseline on an isolated copy before writing anything', async () => {
    const files = new Map([['D:\\dst\\target.txt', original]])
    const fs = fakeFs(files)
    const { record } = await patchHandoff(request(files, { apply: false }), fs)

    expect(record.provided).toBe(true)
    expect(record.applied).toBe(false)
    expect(fs.writes).toEqual([])
    expect(record.evidence.join(' ')).toMatch(/isolated copy/)
    expect(record.evidence.join(' ')).toMatch(/nothing was written/)
  })

  it('applies the patch and confirms the result by reading back', async () => {
    const files = new Map([['D:\\dst\\target.txt', original]])
    const fs = fakeFs(files)
    const { record } = await patchHandoff(request(files), fs)

    expect(record.applied).toBe(true)
    expect(record.verified).toBe(true)
    expect(files.get('D:\\dst\\target.txt')).toBe('line one\nline TWO\nline three\n')
    expect(record.resultHash).toBe(contentDigest('line one\nline TWO\nline three\n'))
  })

  it('guards the write against edits after its baseline was read', async () => {
    const files = new Map([['D:\\dst\\target.txt', original]])
    const fs = fakeFs(files)
    const racing: TransferFsPort = {
      ...fs,
      writeText: async (target, content, expected, signal) => {
        files.set(String(target), 'receiver edit after read')
        return await fs.writeText(target, content, expected, signal)
      },
    }
    const { record } = await patchHandoff(request(files), racing)
    expect(record.applied).toBe(false)
    expect(record.conflicts.join(' ')).toContain('FS_STALE_VERSION')
    expect(files.get('D:\\dst\\target.txt')).toBe('receiver edit after read')
  })

  it('refuses applying when the filesystem supplies no version for a guarded write', async () => {
    const files = new Map([['D:\\dst\\target.txt', original]])
    const fs = fakeFs(files)
    const { record } = await patchHandoff(request(files), { ...fs, stat: async () => ({ size: original.length }) })
    expect(record.applied).toBe(false)
    expect(record.conflicts.join(' ')).toContain('no filesystem version')
    expect(fs.writes).toEqual([])
  })

  it('stops on a baseline mismatch and never overwrites the receiver', async () => {
    // The receiver edited the file the patch was made against.
    const files = new Map([['D:\\dst\\target.txt', 'line one\nRECEIVER EDIT\nline three\n']])
    const fs = fakeFs(files)
    const { record } = await patchHandoff(request(files), fs)

    expect(record.provided).toBe(false)
    expect(record.applied).toBe(false)
    expect(fs.writes).toEqual([])
    expect(files.get('D:\\dst\\target.txt')).toBe('line one\nRECEIVER EDIT\nline three\n')
    expect(record.conflicts[0]).toMatch(/does not match the patch baseline/)
    expect(record.conflicts[0]).toMatch(/the receiver has different content/)
  })

  it('stops on a hunk conflict even when the baseline matches', async () => {
    const files = new Map([['D:\\dst\\target.txt', original]])
    const fs = fakeFs(files)
    const wrong = [
      '--- a/target.txt', '+++ b/target.txt',
      '@@ -1,3 +1,2 @@',
      ' line one',
      '-a line that is not there',
      ' line three',
      '',
    ].join('\n')
    const { record } = await patchHandoff(request(files, { diff: wrong }), fs)

    expect(record.applied).toBe(false)
    expect(fs.writes).toEqual([])
    expect(record.conflicts[0]).toMatch(/does not match the target/)
  })

  it('refuses a patch it cannot parse instead of applying part of it', async () => {
    const files = new Map([['D:\\dst\\target.txt', original]])
    const fs = fakeFs(files)
    const { record } = await patchHandoff(request(files, {
      diff: '--- a/x\n+++ b/x\n@@ nonsense @@\n a\n',
    }), fs)

    expect(record.applied).toBe(false)
    expect(fs.writes).toEqual([])
    expect(record.conflicts[0]).toMatch(/could not be read/)
  })

  it('refuses when no baseline hash is recorded', async () => {
    const files = new Map([['D:\\dst\\target.txt', original]])
    const fs = fakeFs(files)
    const { record } = await patchHandoff(request(files, {
      artifact: { ...pinnedArtifact(original), contentHash: undefined, hashScope: undefined },
    }), fs)

    expect(record.applied).toBe(false)
    expect(record.conflicts[0]).toMatch(/no baseline hash is recorded/)
  })

  it('names what the patch touches so the receiver knows what is involved', async () => {
    const files = new Map([['D:\\dst\\target.txt', original]])
    const fs = fakeFs(files)
    const { record } = await patchHandoff(request(files, { apply: false }), fs)
    expect(record.evidence.join(' ')).toMatch(/1 hunk\(s\) touching 1 existing line\(s\) and adding 1/)
  })
})
