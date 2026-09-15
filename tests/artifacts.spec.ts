import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  HASH_BYTE_LIMIT,
  LISTING_ENTRY_LIMIT,
  applyAcceptance,
  applyVerification,
  boundListing,
  decideArtifactOpen,
  decideArtifactRead,
  describeArtifactProvenance,
  isPinnedForDependency,
  artifactConstraintCompatibleWithRun,
  newArtifactRecord,
  stampArtifactProvenance,
  utf8PreviewOf,
  verifyArtifact,
  type ArtifactFsPort,
  type RegisterArtifactRequest,
} from '../src/service/artifacts.ts'
import type { ArtifactRecord } from '../src/store/schema.ts'

const NOW = '2026-09-13T00:00:00.000Z'

/** A registration for a file artifact. */
function registration(over: Partial<RegisterArtifactRequest> = {}): RegisterArtifactRequest {
  return {
    artifactId: 'artifact-1',
    taskId: 'task-1',
    kind: 'file',
    name: 'report.md',
    hostId: 'local',
    path: 'D:\\work\\report.md',
    ...over,
  }
}

/** An in-memory filesystem with per-path content, honouring the read cap like the Host's. */
function fakeFs(
  files: Map<string, Uint8Array>,
  directories: Map<string, readonly { name: string; type: 'file' | 'directory' | 'other' }[]> = new Map(),
): ArtifactFsPort {
  return {
    resolve: async (path) => {
      if (!files.has(path) && !directories.has(path)) throw new Error(`ENOENT: ${path}`)
      return path
    },
    stat: async (target) => {
      const key = String(target)
      if (directories.has(key)) return { type: 'directory' as const, size: 0 }
      const bytes = files.get(key)
      return bytes === undefined ? undefined : { type: 'file' as const, size: bytes.byteLength }
    },
    // The real service reads at most `maxBytes`; a fake that returned everything
    // would hide the truncation the prefix-hash rule exists to record.
    readBytes: async (target, _signal, maxBytes) =>
      (files.get(String(target)) ?? new Uint8Array()).slice(0, maxBytes),
    listDir: async (target) => {
      const entries = directories.get(String(target))
      if (entries === undefined) throw new Error(`ENOTDIR: ${String(target)}`)
      return entries
    },
  }
}

const digestOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex')

describe('artifact registration is a claim (PRD §二.9.1)', () => {
  it('starts claimed with pending acceptance, whatever the producer said', () => {
    const record = newArtifactRecord(registration({ contentHash: digestOf('pretend') }), NOW)
    expect(record.existence).toBe('claimed')
    expect(record.acceptance).toBe('pending')
    expect(record.evidence[0]).toMatch(/nothing has verified it yet/)
  })

  it('records a producer-supplied hash without treating it as verified', () => {
    const record = newArtifactRecord(registration({ contentHash: 'abc' }), NOW)
    // The hash is kept so a later check can compare against it, but the state
    // stays `claimed`: the conductor did not check it.
    expect(record.contentHash).toBe('abc')
    expect(record.existence).toBe('claimed')
  })
})

describe('verification reports what is there (PRD §二.9.1)', () => {
  it('records presence and a whole-file digest on a first successful check', async () => {
    const files = new Map([['D:\\work\\report.md', Buffer.from('hello')]])
    const record = newArtifactRecord(registration(), NOW)
    const outcome = await verifyArtifact(record, fakeFs(files))

    expect(outcome.existence).toBe('present')
    expect(outcome.hashScope).toBe('full')
    expect(outcome.contentHash).toBe(digestOf('hello'))

    const stored = applyVerification(record, outcome, NOW)
    expect(stored.existence).toBe('present')
    expect(stored.contentVersion).toBe(0)
  })

  it('reports a missing file as missing, never as another file of the same name', async () => {
    const record = newArtifactRecord(registration(), NOW)
    const outcome = await verifyArtifact(record, fakeFs(new Map()))
    expect(outcome.existence).toBe('missing')
    expect(outcome.evidence.join(' ')).toMatch(/could not be resolved|not present/)
    // No hash is invented for a file that was not read.
    expect(outcome.contentHash).toBeUndefined()
  })

  it('reports a changed file as changed and keeps the digest of what was verified last', async () => {
    const files = new Map([['D:\\work\\report.md', Buffer.from('first')]])
    const fs = fakeFs(files)
    const record = newArtifactRecord(registration(), NOW)

    const first = applyVerification(record, await verifyArtifact(record, fs), NOW)
    expect(first.existence).toBe('present')
    expect(first.contentHash).toBe(digestOf('first'))

    files.set('D:\\work\\report.md', Buffer.from('second'))
    const outcome = await verifyArtifact(first, fs)
    expect(outcome.existence).toBe('changed')
    expect(outcome.contentChanged).toBe(true)

    const second = applyVerification(first, outcome, NOW)
    expect(second.existence).toBe('changed')
    expect(second.contentVersion).toBe(1)
    // The recorded digest still describes 'first', so the drift stays readable.
    expect(second.contentHash).toBe(digestOf('first'))
  })

  it('confirms an unchanged file without advancing the content version', async () => {
    const files = new Map([['D:\\work\\report.md', Buffer.from('stable')]])
    const fs = fakeFs(files)
    const record = newArtifactRecord(registration(), NOW)
    const first = applyVerification(record, await verifyArtifact(record, fs), NOW)
    const again = applyVerification(first, await verifyArtifact(first, fs), NOW)
    expect(again.existence).toBe('present')
    expect(again.contentVersion).toBe(0)
    expect(again.evidence.at(-1)).toMatch(/unchanged/)
  })

  it('does not certify an old full hash when the latest content read fails', async () => {
    const fs = fakeFs(new Map([['D:\\work\\report.md', Buffer.from('old')]]))
    const first = applyVerification(newArtifactRecord(registration(), NOW), {
      existence: 'present', contentHash: digestOf('old'), hashScope: 'full', contentChanged: false, evidence: [],
    }, NOW)
    const outcome = await verifyArtifact(first, { ...fs, readBytes: async () => { throw new Error('EACCES') } })
    const held = applyVerification(first, outcome, '2026-09-14T00:00:00.000Z')
    expect(isPinnedForDependency(held).pinned).toBe(false)
    expect(held.verifiedAt).toBe(NOW)
    expect(decideArtifactOpen(held, held.existence).nativeOpen).toBe(false)
  })

  it('does not treat a directory name listing as a fixed snapshot of its contents', () => {
    const record = {
      ...newArtifactRecord(registration({ kind: 'directory' }), NOW),
      existence: 'present' as const, contentHash: 'listing-digest', hashScope: 'full' as const,
    }
    expect(isPinnedForDependency(record).pinned).toBe(false)
  })

  it('invalidates acceptance on content drift and does not add a version for each repeat check', async () => {
    const fs = fakeFs(new Map([['D:\\work\\report.md', Buffer.from('changed')]]))
    const first = {
      ...newArtifactRecord(registration({ contentHash: digestOf('old') }), NOW),
      existence: 'present' as const, acceptance: 'pass' as const, acceptedBy: 'user' as const, acceptedAt: NOW,
    }
    const changed = applyVerification(first, await verifyArtifact(first, fs), NOW)
    const again = applyVerification(changed, await verifyArtifact(changed, fs), NOW)
    expect(changed.acceptance).toBe('pending')
    expect(changed.acceptedBy).toBeUndefined()
    expect(again.contentVersion).toBe(changed.contentVersion)
  })

  it('marks a digest taken over a prefix as a prefix', async () => {
    const big = new Uint8Array(HASH_BYTE_LIMIT + 1024)
    const files = new Map([['D:\\work\\report.md', big]])
    const record = newArtifactRecord(registration(), NOW)
    const outcome = await verifyArtifact(record, fakeFs(files))
    expect(outcome.hashScope).toBe('prefix')
    expect(outcome.evidence.join(' ')).toMatch(/first .* byte/)
  })

  it('leaves a link claimed: the recorded URL is hashed, reachability is not probed', async () => {
    const record = newArtifactRecord({
      artifactId: 'artifact-link',
      taskId: 'task-1',
      kind: 'link',
      name: 'spec',
      hostId: 'local',
      url: 'https://example.com/spec',
    }, NOW)
    const outcome = await verifyArtifact(record, fakeFs(new Map()))
    expect(outcome.existence).toBe('claimed')
    expect(outcome.contentHash).toBe(digestOf('https://example.com/spec'))
    expect(outcome.evidence.join(' ')).toMatch(/reachability is not probed/)
    expect(outcome.contentChanged).toBe(false)
  })

  it('does not treat a filesystem path as a link artifact', async () => {
    const path = 'D:\\work\\spec.md'
    const files = new Map([[path, Buffer.from('not the link')]])
    const record = newArtifactRecord({
      artifactId: 'artifact-link-path',
      taskId: 'task-1',
      kind: 'link',
      name: 'spec',
      hostId: 'local',
      path,
    }, NOW)
    const outcome = await verifyArtifact(record, fakeFs(files))
    expect(outcome.existence).toBe('claimed')
    expect(outcome.contentHash).toBeUndefined()
    expect(outcome.evidence.join(' ')).toMatch(/recorded URL/)
    expect(outcome.evidence.join(' ')).toMatch(/not this link/)
  })

  it('does not treat a filesystem path as a commit artifact', async () => {
    const path = 'D:\\work\\repo'
    const files = new Map([[path, Buffer.from('not a commit')]])
    const record = newArtifactRecord({
      artifactId: 'artifact-commit-path',
      taskId: 'task-1',
      kind: 'commit',
      name: 'baseline',
      hostId: 'local',
      path,
    }, NOW)
    const outcome = await verifyArtifact(record, fakeFs(files))
    expect(outcome.existence).toBe('claimed')
    expect(outcome.evidence.join(' ')).toMatch(/git reference/)
    expect(outcome.evidence.join(' ')).toMatch(/not this commit/)
  })

  it('resolves a commit at the recorded git object, not another SHA', async () => {
    const recorded = 'abc123def456abc123def456abc123def456abc1'
    const other = 'ffffffffffffffffffffffffffffffffffffffff'
    const record = newArtifactRecord({
      artifactId: 'artifact-commit',
      taskId: 'task-1',
      kind: 'commit',
      name: 'baseline',
      hostId: 'local',
      path: 'D:\\work\\repo',
      gitRef: 'HEAD',
    }, NOW)
    const kinds = {
      resolveGitRef: async (gitRef: string, cwd: string | undefined) => {
        expect(gitRef).toBe('HEAD')
        expect(cwd).toBe('D:\\work\\repo')
        return {
          status: 'present' as const,
          resolvedSha: recorded,
          evidence: `verified present; git object ${recorded}`,
        }
      },
    }
    const first = await verifyArtifact(record, fakeFs(new Map()), kinds)
    expect(first.existence).toBe('present')
    expect(first.contentHash).toBe(recorded)

    const kindsMoved = {
      resolveGitRef: async () => ({
        status: 'present' as const,
        resolvedSha: other,
        evidence: `verified present; git object ${other}`,
      }),
    }
    const held = applyVerification(record, first, NOW)
    const outcome = await verifyArtifact(held, fakeFs(new Map()), kindsMoved)
    expect(outcome.existence).toBe('changed')
    expect(outcome.contentChanged).toBe(true)
    const second = applyVerification(held, outcome, NOW)
    expect(second.contentHash).toBe(recorded)
    expect(second.evidence.join(' ')).toMatch(/another commit is not this artifact/)
  })

  it('leaves a commit claimed when this composition cannot resolve git objects', async () => {
    const record = newArtifactRecord({
      artifactId: 'artifact-commit-nogit',
      taskId: 'task-1',
      kind: 'commit',
      name: 'baseline',
      hostId: 'local',
      gitRef: 'abc1234',
      path: 'D:\\work\\repo',
    }, NOW)
    const outcome = await verifyArtifact(record, fakeFs(new Map()))
    expect(outcome.existence).toBe('claimed')
    expect(outcome.evidence.join(' ')).toMatch(/cannot resolve a git object/)
  })

  it('reports a missing git object as missing, not as another commit', async () => {
    const record = newArtifactRecord({
      artifactId: 'artifact-commit-missing',
      taskId: 'task-1',
      kind: 'commit',
      name: 'baseline',
      hostId: 'local',
      gitRef: 'deadbeef',
      path: 'D:\\work\\repo',
    }, NOW)
    const outcome = await verifyArtifact(record, fakeFs(new Map()), {
      resolveGitRef: async () => ({
        status: 'missing' as const,
        evidence: 'deadbeef does not resolve to a commit in D:\\work\\repo; another commit is not this artifact',
      }),
    })
    expect(outcome.existence).toBe('missing')
    expect(outcome.evidence.join(' ')).toMatch(/another commit is not this artifact/)
  })

  it('hashes a patch at the recorded path, not another file of the same name', async () => {
    const recorded = 'D:\\work\\change.patch'
    const other = 'D:\\elsewhere\\change.patch'
    const files = new Map([
      [recorded, Buffer.from('diff --git a/a b/a')],
      [other, Buffer.from('some other patch')],
    ])
    const record = newArtifactRecord(registration({
      kind: 'patch',
      name: 'change.patch',
      path: recorded,
    }), NOW)
    const outcome = await verifyArtifact(record, fakeFs(files))
    expect(outcome.existence).toBe('present')
    expect(outcome.contentHash).toBe(digestOf('diff --git a/a b/a'))
    expect(outcome.contentHash).not.toBe(digestOf('some other patch'))
    expect(outcome.evidence.join(' ')).toMatch(/patch /)
  })

  it('hashes a test report at the recorded path', async () => {
    const path = 'D:\\work\\junit.xml'
    const files = new Map([[path, Buffer.from('<testsuite tests="1"/>')]])
    const record = newArtifactRecord(registration({
      kind: 'test_report',
      name: 'junit.xml',
      path,
    }), NOW)
    const outcome = await verifyArtifact(record, fakeFs(files))
    expect(outcome.existence).toBe('present')
    expect(outcome.contentHash).toBe(digestOf('<testsuite tests="1"/>'))
    expect(outcome.evidence.join(' ')).toMatch(/test_report /)
  })

  it('treats a service entry like a link: locator digest, not present, not a path', async () => {
    const record = newArtifactRecord({
      artifactId: 'artifact-svc',
      taskId: 'task-1',
      kind: 'service',
      name: 'preview',
      hostId: 'local',
      url: 'https://example.com/preview',
      path: 'D:\\work\\preview',
    }, NOW)
    const files = new Map([['D:\\work\\preview', Buffer.from('not the service')]])
    const outcome = await verifyArtifact(record, fakeFs(files))
    expect(outcome.existence).toBe('claimed')
    expect(outcome.contentHash).toBe(digestOf('https://example.com/preview'))
    expect(outcome.evidence.join(' ')).toMatch(/service URL/)
  })

  it('hashes the recorded directory\'s children, not another directory of the same name', async () => {
    const recorded = 'D:\\work\\out'
    const other = 'D:\\elsewhere\\out'
    const directories = new Map([
      [recorded, [
        { name: 'a.txt', type: 'file' as const },
        { name: 'nested', type: 'directory' as const },
      ]],
      [other, [{ name: 'stranger.bin', type: 'file' as const }]],
    ])
    const record = newArtifactRecord(registration({
      kind: 'directory',
      name: 'out',
      path: recorded,
    }), NOW)
    const outcome = await verifyArtifact(record, fakeFs(new Map(), directories))
    expect(outcome.existence).toBe('present')
    expect(outcome.hashScope).toBe('full')
    expect(outcome.contentHash).toBe(boundListing(directories.get(recorded) ?? []).digest)
    expect(outcome.contentHash).not.toBe(boundListing(directories.get(other) ?? []).digest)
    expect(outcome.evidence.join(' ')).toMatch(/listing of 2 direct child/)
  })

  it('reports a changed listing as changed and keeps the digest of what was verified last', async () => {
    const path = 'D:\\work\\out'
    const directories = new Map([[path, [{ name: 'a.txt', type: 'file' as const }]]])
    const fs = fakeFs(new Map(), directories)
    const record = newArtifactRecord(registration({ kind: 'directory', name: 'out', path }), NOW)
    const first = applyVerification(record, await verifyArtifact(record, fs), NOW)
    expect(first.existence).toBe('present')

    directories.set(path, [
      { name: 'a.txt', type: 'file' },
      { name: 'b.txt', type: 'file' },
    ])
    const outcome = await verifyArtifact(first, fs)
    expect(outcome.existence).toBe('changed')
    expect(outcome.contentChanged).toBe(true)
    const second = applyVerification(first, outcome, NOW)
    expect(second.contentHash).toBe(first.contentHash)
    expect(second.contentVersion).toBe(1)
  })

  it('does not treat a file at the recorded path as this directory artifact', async () => {
    const path = 'D:\\work\\out'
    const files = new Map([[path, Buffer.from('not a directory')]])
    const record = newArtifactRecord(registration({ kind: 'directory', name: 'out', path }), NOW)
    const outcome = await verifyArtifact(record, fakeFs(files))
    expect(outcome.existence).toBe('claimed')
    expect(outcome.contentHash).toBeUndefined()
    expect(outcome.evidence.join(' ')).toMatch(/not a directory/)
    expect(outcome.evidence.join(' ')).toMatch(/not listed/)
  })

  it('marks a truncated directory listing as a prefix digest', () => {
    const entries = Array.from({ length: LISTING_ENTRY_LIMIT + 3 }, (_, index) => ({
      name: `f${String(index).padStart(4, '0')}.txt`,
      type: 'file' as const,
    }))
    const listing = boundListing(entries)
    expect(listing.truncated).toBe(true)
    expect(listing.entries).toHaveLength(LISTING_ENTRY_LIMIT)
    expect(listing.hashScope).toBe('prefix')
    expect(listing.entries[0]?.name).toBe('f0000.txt')
  })
})

describe('the fixed-input rule (PRD §二.9.1)', () => {
  it('refuses a claim, a missing file, a changed file, a hashless record and a prefix digest', () => {
    const base = newArtifactRecord(registration(), NOW)
    expect(isPinnedForDependency(base).pinned).toBe(false)
    expect(isPinnedForDependency({ ...base, existence: 'missing' }).reason).toMatch(/not present/)
    expect(isPinnedForDependency({ ...base, existence: 'changed' }).reason).toMatch(/changed since/)
    expect(isPinnedForDependency({ ...base, existence: 'present' }).reason).toMatch(/no content hash/)
    expect(isPinnedForDependency({
      ...base, existence: 'present', contentHash: 'x', hashScope: 'prefix',
    }).reason).toMatch(/only part of the content/)
  })

  it('accepts a present artifact with a whole-content hash', () => {
    const base = newArtifactRecord(registration(), NOW)
    const pinned = isPinnedForDependency({
      ...base, existence: 'present', contentHash: 'x', hashScope: 'full',
    })
    expect(pinned.pinned).toBe(true)
    expect(pinned.reason).toMatch(/whole-content hash/)
  })

  it('refuses an artifact produced under a different constraint version than the run fixed (PRD §二.13.1)', () => {
    const base = newArtifactRecord(registration(), NOW)
    const produced = {
      ...base,
      existence: 'present' as const,
      contentHash: 'x',
      hashScope: 'full' as const,
      constraints: [{ constraintId: 'c-api', version: 1 }],
    }
    const run = [{ constraintId: 'c-api', version: 2 }]
    const mismatch = artifactConstraintCompatibleWithRun(produced, run)
    expect(mismatch.compatible).toBe(false)
    expect(mismatch.reason).toMatch(/produced under constraint c-api version 1/)
    expect(mismatch.reason).toMatch(/this run fixed version 2/)

    expect(artifactConstraintCompatibleWithRun(produced, [{ constraintId: 'c-api', version: 1 }]).compatible).toBe(true)
    // A constraint the run did not fix is not a conflict; a record with no provenance is not a mismatch.
    expect(artifactConstraintCompatibleWithRun(produced, [{ constraintId: 'c-other', version: 9 }]).compatible).toBe(true)
    expect(artifactConstraintCompatibleWithRun(base, run).compatible).toBe(true)
  })
})

describe('acceptance is a separate fact (PRD §二.9.1, §三.4)', () => {
  it('records a verdict without touching existence', () => {
    const base: ArtifactRecord = {
      ...newArtifactRecord(registration(), NOW),
      existence: 'present',
      contentHash: 'x',
      hashScope: 'full',
    }
    const accepted = applyAcceptance(base, 'pass', 'reviewed by the user', NOW)
    expect(accepted.acceptance).toBe('pass')
    // Verification and acceptance are independent axes; accepting does not
    // re-verify, and verifying does not accept.
    expect(accepted.existence).toBe('present')
    expect(accepted.evidence.at(-1)).toBe('reviewed by the user')
  })

  it('keeps existence unchanged when acceptance fails', () => {
    const base = newArtifactRecord(registration(), NOW)
    const rejected = applyAcceptance(base, 'fail', 'the report is incomplete', NOW)
    expect(rejected.existence).toBe('claimed')
    expect(rejected.acceptance).toBe('fail')
  })
})

describe('read and open use the recorded locator (PRD §二.9.1, T17)', () => {
  it('allows a preview and native open only for the recorded path when it is present and unchanged', () => {
    const record = {
      ...newArtifactRecord(registration(), NOW),
      existence: 'present' as const,
      contentHash: digestOf('hello'),
      hashScope: 'full' as const,
    }
    const read = decideArtifactRead(record, 'present')
    expect(read.includePreview).toBe(true)
    expect(read.locator).toEqual({ kind: 'path', value: 'D:\\work\\report.md' })

    const open = decideArtifactOpen(record, 'present')
    expect(open.nativeOpen).toBe(true)
    expect(open.locator).toEqual({ kind: 'path', value: 'D:\\work\\report.md' })
  })

  it('refuses a missing recorded path rather than reading or opening a same-name file', () => {
    const record = newArtifactRecord(registration(), NOW)
    const read = decideArtifactRead(record, 'missing')
    expect(read.includePreview).toBe(false)
    expect(read.reason).toMatch(/not present/)
    expect(read.reason).toMatch(/same name/)
    expect(read.locator).toEqual({ kind: 'path', value: 'D:\\work\\report.md' })

    const open = decideArtifactOpen(record, 'missing')
    expect(open.nativeOpen).toBe(false)
    expect(open.reason).toMatch(/not present/)
    expect(open.reason).toMatch(/same name/)
    expect(open.locator).toEqual({ kind: 'path', value: 'D:\\work\\report.md' })
  })

  it('refuses a changed recorded path rather than returning or opening the new bytes as the artifact', () => {
    const record = {
      ...newArtifactRecord(registration(), NOW),
      existence: 'present' as const,
      contentHash: digestOf('hello'),
      hashScope: 'full' as const,
    }
    const read = decideArtifactRead(record, 'changed')
    expect(read.includePreview).toBe(false)
    expect(read.reason).toMatch(/changed/)
    expect(read.reason).toMatch(/same name/)

    const open = decideArtifactOpen(record, 'changed')
    expect(open.nativeOpen).toBe(false)
    expect(open.reason).toMatch(/changed/)
    expect(open.reason).toMatch(/same name/)
  })

  it('does not take a filesystem preview of a URL or open it with the OS default application', () => {
    const record = newArtifactRecord({
      artifactId: 'artifact-1',
      taskId: 'task-1',
      kind: 'link',
      name: 'report.md',
      hostId: 'local',
      url: 'https://example.invalid/report',
    }, NOW)
    const read = decideArtifactRead(record, 'claimed')
    expect(read.includePreview).toBe(false)
    expect(read.locator).toEqual({ kind: 'url', value: 'https://example.invalid/report' })
    expect(read.reason).toMatch(/https:\/\/example\.invalid\/report/)

    const open = decideArtifactOpen(record, 'claimed')
    expect(open.nativeOpen).toBe(false)
    expect(open.locator.kind).toBe('url')
  })

  it('lists a present directory at the recorded path, not another directory of the same name', () => {
    const record = {
      ...newArtifactRecord(registration({ kind: 'directory', name: 'out', path: 'D:\\work\\out' }), NOW),
      existence: 'present' as const,
    }
    const read = decideArtifactRead(record, 'present')
    expect(read.includePreview).toBe(false)
    expect(read.includeListing).toBe(true)
    expect(read.locator).toEqual({ kind: 'path', value: 'D:\\work\\out' })
    expect(read.reason).toMatch(/D:\\work\\out/)
    expect(read.reason).toMatch(/not another directory of the same name/)
  })

  it('does not list a missing or changed directory of the same name', () => {
    const record = {
      ...newArtifactRecord(registration({ kind: 'directory', name: 'out', path: 'D:\\work\\out' }), NOW),
      existence: 'present' as const,
    }
    const missing = decideArtifactRead(record, 'missing')
    expect(missing.includeListing).toBe(false)
    expect(missing.includePreview).toBe(false)
    expect(missing.reason).toMatch(/D:\\work\\out/)
    expect(missing.reason).toMatch(/not listed/)

    const changed = decideArtifactRead(record, 'changed')
    expect(changed.includeListing).toBe(false)
    expect(changed.reason).toMatch(/not listed/)
  })

  it('marks a truncated UTF-8 preview and refuses binary bytes', () => {
    const long = 'abcdefghij'
    const preview = utf8PreviewOf(Buffer.from(long), 4)
    expect(preview.text).toBe('abcd')
    expect(preview.truncated).toBe(true)
    expect(preview.binary).toBe(false)

    const binary = utf8PreviewOf(new Uint8Array([0x00, 0x01, 0x02]), 100)
    expect(binary.binary).toBe(true)
    expect(binary.text).toBeUndefined()
  })
})

describe('artifact provenance (PRD §二.9.1 来源 Session／轮次／相关约束版本)', () => {
  it('stamps the producing session, turn and constraints the caller omitted', () => {
    const stamped = stampArtifactProvenance(registration(), {
      bindingSessionId: 'session-1',
      liveTurnsStarted: 3,
      constraints: [{ constraintId: 'c-api', version: 2 }],
    })
    expect(stamped.sessionId).toBe('session-1')
    expect(stamped.turn).toBe(3)
    expect(stamped.constraints).toEqual([{ constraintId: 'c-api', version: 2 }])
    const record = newArtifactRecord(stamped, NOW)
    expect(record.sessionId).toBe('session-1')
    expect(record.turn).toBe(3)
    expect(record.constraints).toEqual([{ constraintId: 'c-api', version: 2 }])
    expect(describeArtifactProvenance(record)).toBe('session session-1, turn 3, constraints c-api@2')
  })

  it('lets the caller win over live facts, and does not invent turn 0', () => {
    const named = stampArtifactProvenance(
      registration({ sessionId: 'session-named', turn: 7 }),
      { bindingSessionId: 'session-bound', liveTurnsStarted: 3, constraints: [] },
    )
    expect(named.sessionId).toBe('session-named')
    expect(named.turn).toBe(7)
    expect(named.constraints).toBeUndefined()

    const noTurn = stampArtifactProvenance(registration(), {
      bindingSessionId: 'session-1',
      liveTurnsStarted: 0,
      constraints: [],
    })
    expect(noTurn.sessionId).toBe('session-1')
    expect(noTurn.turn).toBeUndefined()
  })

  it('still describes a v1 record that only stored a singular constraintVersion', () => {
    expect(describeArtifactProvenance({ constraintVersion: 4 })).toBe('constraint v4')
    expect(describeArtifactProvenance({})).toBeUndefined()
  })
})
