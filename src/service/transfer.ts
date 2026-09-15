/**
 * Handing an artifact to another task (PRD §二.9.2).
 *
 * Three modes, and the specification's rules for each:
 *
 * - **reference** sends a pointer carrying permission and version information,
 *   and moves nothing;
 * - **snapshot copy** writes the artifact's content into the receiver's own
 *   input directory, so the receiver depends on a copy rather than on a path
 *   that may change underneath it;
 * - **patch** offers or applies a change against a stated baseline.
 *
 * A patch is the mode with rules, and they are all refusals: verify the
 * receiver's baseline, check on an isolated copy first, name the files and
 * existing modifications involved, stop on a conflict, and never overwrite the
 * receiver's changes. The implementation below therefore refuses rather than
 * negotiates — there is no partial application and no fuzzy hunk matching,
 * because either would land a change on top of somebody else's edit.
 *
 * A transfer also never implies commit, merge, push or publish authority; it
 * moves content and records what happened, and nothing else.
 *
 * @module dsh-session-conductor/service/transfer
 */

import { createHash } from 'node:crypto'
import type { FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { applyHunks, parseUnifiedDiff, type Hunk } from './patch.ts'
import { isPinnedForDependency } from './artifacts.ts'
import type { ArtifactRecord, TransferRecord } from '../store/schema.ts'

/** The filesystem surface a transfer uses. */
export interface TransferFsPort {
  /** Resolve a path to whatever the provider needs. */
  resolve(path: string): Promise<unknown>
  /** Stat a resolved target. */
  stat(target: unknown, signal?: AbortSignal): Promise<{ size?: number; version?: FsVersion } | undefined>
  /** Read a target as text. */
  readText(target: unknown, signal?: AbortSignal): Promise<string>
  /** Write text to a resolved target. */
  writeText(target: unknown, content: string, expected: FsWriteIntent, signal?: AbortSignal): Promise<unknown>
  /** Available only when the separately verified Host binary provider is mounted. */
  readonly maxBinaryBytes?: number
  readBytes?(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  writeBytes?(target: unknown, content: Uint8Array, expected: FsWriteIntent, signal?: AbortSignal): Promise<unknown>
}

/** Request for a reference handoff. */
export interface ReferenceRequest {
  readonly transferId: string
  readonly artifact: ArtifactRecord
  readonly toTaskId: string
  readonly now: string
}

/** Request for a snapshot copy. */
export interface SnapshotCopyRequest {
  readonly transferId: string
  readonly artifact: ArtifactRecord
  readonly toTaskId: string
  /** Absolute destination path in the receiver's input directory. */
  readonly destination: string
  readonly now: string
}

/** Request for a patch handoff. */
export interface PatchRequest {
  readonly transferId: string
  readonly artifact: ArtifactRecord
  readonly toTaskId: string
  /** Absolute path of the file the patch modifies. */
  readonly target: string
  /** The unified diff. */
  readonly diff: string
  /**
   * Content hash the patch was generated against.
   *
   * Defaults to the artifact's recorded hash. When it does not match the
   * target's current content, the patch was made against a different revision
   * and is refused before anything is applied.
   */
  readonly expectedBaselineHash?: string
  /** Apply the patch. When false it is only checked, and nothing is written. */
  readonly apply: boolean
  readonly now: string
}

/** Result of a transfer. */
export interface TransferOutcome {
  readonly record: TransferRecord
  /** The reference text, when the mode produced one. */
  readonly reference?: string
}

/**
 * Build a reference handoff.
 *
 * A reference carries what the receiver needs in order to know **what** it is
 * being pointed at and whether it is safe to depend on: identity, location,
 * version, the verification facts, and whether the artifact is currently usable
 * as a fixed input. Nothing is copied, so a reference is always "provided" and
 * never "applied".
 *
 * @param request - the reference request.
 * @returns the transfer record and the rendered reference.
 */
export function buildReference(request: ReferenceRequest): TransferOutcome {
  const { artifact } = request
  const pin = isPinnedForDependency(artifact)
  const location = artifact.path ?? artifact.url ?? artifact.gitRef ?? '(no location recorded)'
  const reference = [
    `artifact ${artifact.artifactId} (${artifact.kind}: ${artifact.name})`,
    `location: ${location}`,
    `content version: ${String(artifact.contentVersion)}`,
    artifact.contentHash === undefined
      ? 'content hash: not recorded'
      : `content hash: ${artifact.contentHash}${artifact.hashScope === 'prefix' ? ' (over part of the content only)' : ''}`,
    `existence: ${artifact.existence}; acceptance: ${artifact.acceptance}`,
    `fixed input for an automatic dependency: ${pin.pinned ? 'yes' : `no — ${pin.reason}`}`,
  ].join('\n')

  return {
    record: {
      transferId: request.transferId,
      mode: 'reference',
      artifactId: artifact.artifactId,
      fromTaskId: artifact.taskId,
      toTaskId: request.toTaskId,
      provided: true,
      applied: false,
      verified: false,
      conflicts: [],
      evidence: [
        'reference handed over; no content was copied',
        pin.pinned
          ? 'the referenced artifact is currently usable as a fixed input'
          : `the receiver should not treat this as a fixed input: ${pin.reason}`,
      ],
      createdAt: request.now,
      updatedAt: request.now,
      ...artifact.contentHash === undefined ? {} : { baselineHash: artifact.contentHash },
    },
    reference,
  }
}

/**
 * Copy an artifact's content into a receiver's directory.
 *
 * The source must be pinned first. Copying an artifact whose existence was never
 * verified, or whose content changed since it was, would hand the receiver a file
 * of unknown provenance while calling it a snapshot — so it is refused with the
 * reason instead.
 *
 * @param request - the copy request.
 * @param fs - the Host filesystem service.
 * @param signal - cancellation.
 * @returns the transfer record.
 */
export async function snapshotCopy(
  request: SnapshotCopyRequest,
  fs: TransferFsPort,
  signal?: AbortSignal,
): Promise<TransferOutcome> {
  const base = emptyRecord(request.transferId, 'snapshot_copy', request.artifact, request.toTaskId, request.now, request.destination)
  const pin = isPinnedForDependency(request.artifact)
  if (!pin.pinned || request.artifact.path === undefined) {
    return refuse(base, pin.pinned
      ? 'the artifact records no path to copy from'
      : `the source is not a verified, unchanged artifact: ${pin.reason}`)
  }

  const binary = typeof fs.readBytes === 'function' && typeof fs.writeBytes === 'function'
  const readContent = async (path: string): Promise<string | Uint8Array> => {
    const target = await fs.resolve(path)
    if (!binary) return await fs.readText(target, signal)
    const before = await fs.stat(target, signal)
    const limit = Math.min(fs.maxBinaryBytes ?? 64 * 1024 * 1024, 64 * 1024 * 1024)
    if (before?.size === undefined || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > limit) {
      throw new Error('binary source has no bounded size or exceeds the Host byte limit')
    }
    const bytes = await fs.readBytes!(target, signal, before.size + 1)
    const after = await fs.stat(target, signal)
    if (bytes.byteLength !== before.size || after?.size !== before.size || after?.version !== before.version) {
      throw new Error('binary source changed or the Host returned truncated bytes')
    }
    return bytes
  }
  let content: string | Uint8Array
  try {
    content = await readContent(request.artifact.path)
  } catch (error) {
    return refuse(base, `the source could not be read: ${message(error)}`)
  }

  const sourceHash = digest(content)
  if (sourceHash !== request.artifact.contentHash) {
    // Re-checked at copy time: an artifact verified a moment ago may have
    // changed since, and copying it would silently propagate the change.
    return refuse(base, 'the source changed between verification and the copy, so nothing was written')
  }

  try {
    const destination = await fs.resolve(request.destination)
    if (await fs.stat(destination, signal) !== undefined) {
      return refuse(base, 'the destination already exists; snapshot copy does not overwrite receiver content')
    }
    if (typeof content === 'string') await fs.writeText(destination, content, { kind: 'createIfAbsent' }, signal)
    else await fs.writeBytes!(destination, content, { kind: 'createIfAbsent' }, signal)
  } catch (error) {
    return refuse(base, `the destination could not be written: ${message(error)}`)
  }

  let resultHash: string | undefined
  try {
    resultHash = digest(await readContent(request.destination))
  } catch (error) {
    return {
      record: {
        ...base,
        provided: true,
        applied: true,
        conflicts: [`the copy was written but could not be read back to verify it: ${message(error)}`],
        evidence: [...base.evidence, `copied ${String(typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength)} byte(s) to ${request.destination}`],
        updatedAt: request.now,
      },
    }
  }

  const verified = resultHash === sourceHash
  return {
    record: {
      ...base,
      provided: true,
      applied: true,
      verified,
      resultHash,
      conflicts: verified ? [] : ['the copy does not match the source after writing'],
      evidence: [
        ...base.evidence,
        `copied ${String(typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength)} byte(s) to ${request.destination}`,
        verified ? 'read back and confirmed identical to the source' : 'read back and found DIFFERENT from the source',
      ],
      updatedAt: request.now,
    },
  }
}

/**
 * Check, and optionally apply, a patch handoff.
 *
 * The order is the specification's: baseline first, then the check on an
 * isolated copy, then — only if everything matched — the write. A conflict at any
 * step stops the whole patch and leaves the receiver's file exactly as it was.
 *
 * @param request - the patch request.
 * @param fs - the Host filesystem service.
 * @param signal - cancellation.
 * @returns the transfer record.
 */
export async function patchHandoff(
  request: PatchRequest,
  fs: TransferFsPort,
  signal?: AbortSignal,
): Promise<TransferOutcome> {
  const base = emptyRecord(request.transferId, 'patch', request.artifact, request.toTaskId, request.now, request.target)
  const expected = request.expectedBaselineHash ?? request.artifact.contentHash
  if (expected === undefined) {
    return refuse(base, 'no baseline hash is recorded, so the patch cannot be checked against a known revision')
  }

  let current: string
  let target: unknown
  let version: FsVersion | undefined
  try {
    target = await fs.resolve(request.target)
    version = (await fs.stat(target, signal))?.version
    current = await fs.readText(target, signal)
  } catch (error) {
    return refuse(base, `the target could not be read: ${message(error)}`)
  }

  if (request.apply && version === undefined) {
    return refuse(base, 'the target has no filesystem version for guarded replacement; the patch may be checked but cannot be applied safely')
  }

  const currentHash = digest(current)
  if (currentHash !== expected) {
    // The receiver's file is not the revision the patch was made against. This is
    // the conflict the specification says must stop the handoff rather than
    // overwrite the receiver's work.
    return refuse(
      { ...base, baselineHash: expected, resultHash: currentHash },
      `the target does not match the patch baseline (expected ${expected.slice(0, 12)}…, found ${currentHash.slice(0, 12)}…); `
      + 'the receiver has different content and nothing was written',
    )
  }

  const parsed = parseUnifiedDiff(request.diff)
  if (parsed.errors.length > 0) {
    return refuse({ ...base, baselineHash: expected }, `the patch could not be read: ${parsed.errors.join('; ')}`)
  }
  const file = parsed.files[0]
  if (file === undefined) {
    return refuse({ ...base, baselineHash: expected }, 'the patch changes no files')
  }
  // A handover patches **one** file, and a patch that changes more is refused rather than
  // half-applied. PRD §二.9.2 requires the handover to state which files it involves and to apply
  // the change or refuse it — never some of it. This used to take `parsed.files[0]`, so a multi-file
  // diff applied its first file, reported `applied`/`verified` for "the patch", and left the rest
  // silently unapplied: a partial application that read as a complete one.
  const involved = parsed.files.map(entry => entry.path)
  if (parsed.files.length > 1) {
    return refuse(
      { ...base, baselineHash: expected },
      `the patch changes ${String(parsed.files.length)} files (${involved.join(', ')}), and a handover applies exactly `
      + 'one. It was refused rather than applied in part: handing over each file separately, or splitting the diff, '
      + 'keeps every change accounted for, while applying only the first would report a complete handover of a '
      + 'partial one.',
    )
  }

  // The isolated copy: the hunks are applied to a value in memory, so the file
  // on disk is untouched until every hunk has been checked.
  const applied = applyHunks(current, file.hunks as readonly Hunk[])
  if (!applied.ok) {
    return refuse(
      { ...base, baselineHash: expected },
      `${file.path}: ${applied.reason}`,
    )
  }

  const touched = summarizeHunks(file.hunks as readonly Hunk[])
  const filesLine = `the patch involves ${String(involved.length)} file(s): ${involved.join(', ')}`
  if (!request.apply) {
    return {
      record: {
        ...base,
        provided: true,
        applied: false,
        verified: false,
        baselineHash: expected,
        resultHash: digest(applied.content),
        evidence: [
          ...base.evidence,
          filesLine,
          `checked against the baseline on an isolated copy: all hunks apply`,
          touched,
          'apply was not requested, so nothing was written',
        ],
        updatedAt: request.now,
      },
    }
  }

  try {
    // The Host checks this opaque version in the same critical section as publication.
    // A second read before an unconditional write would still lose a concurrent edit.
    await fs.writeText(target, applied.content, { kind: 'replaceIfVersion', version: version as FsVersion }, signal)
  } catch (error) {
    return refuse({ ...base, baselineHash: expected }, `the patched content could not be written: ${message(error)}`)
  }

  const resultHash = digest(applied.content)
  let verified = false
  try {
    verified = digest(await fs.readText(target, signal)) === resultHash
  } catch {
    verified = false
  }

  return {
    record: {
      ...base,
      provided: true,
      applied: true,
      verified,
      baselineHash: expected,
      resultHash,
      conflicts: verified ? [] : ['the patched file could not be read back to confirm the result'],
      evidence: [
        ...base.evidence,
        filesLine,
        'checked against the baseline on an isolated copy: all hunks apply',
        touched,
        verified ? 'applied and read back to confirm the result' : 'applied but NOT confirmed by a read-back',
      ],
      updatedAt: request.now,
    },
  }
}

/**
 * Describe which lines a patch touches, so the receiver knows what is involved.
 * @param hunks - the patch's hunks.
 * @returns a one-line description.
 */
function summarizeHunks(hunks: readonly Hunk[]): string {
  let removed = 0
  let added = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'remove') removed += 1
      if (line.kind === 'add') added += 1
    }
  }
  return `${String(hunks.length)} hunk(s) touching ${String(removed)} existing line(s) and adding ${String(added)}`
}

/**
 * Start a record with nothing claimed as done.
 * @param transferId - transfer identity.
 * @param mode - the transfer mode.
 * @param artifact - the artifact being handed over.
 * @param toTaskId - the receiving task.
 * @param now - the current time.
 * @param destination - where the result goes, when it goes anywhere.
 * @returns the record skeleton.
 */
function emptyRecord(
  transferId: string,
  mode: TransferRecord['mode'],
  artifact: ArtifactRecord,
  toTaskId: string,
  now: string,
  destination?: string,
): TransferRecord {
  return {
    transferId,
    mode,
    artifactId: artifact.artifactId,
    fromTaskId: artifact.taskId,
    toTaskId,
    provided: false,
    applied: false,
    verified: false,
    conflicts: [],
    evidence: [],
    createdAt: now,
    updatedAt: now,
    ...destination === undefined ? {} : { destination },
  }
}

/**
 * Mark a transfer as stopped, with its reason.
 * @param base - the record so far.
 * @param reason - why it stopped.
 * @returns the refused outcome.
 */
function refuse(base: TransferRecord, reason: string): TransferOutcome {
  return {
    record: {
      ...base,
      conflicts: [reason],
      // A refused transfer provided nothing usable and changed nothing; saying
      // otherwise is how a conflict gets read as a success.
      provided: false,
      applied: false,
      verified: false,
      evidence: [...base.evidence, reason],
      updatedAt: base.createdAt,
    },
  }
}

/**
 * Digest text the way artifact verification does.
 * @param content - the text.
 * @returns the hex digest.
 */
function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Render one thrown value as a short message.
 * @param error - the thrown value.
 * @returns the message.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Digest helper exported for callers that need to state a baseline themselves.
 * @param content - the text to digest.
 * @returns the hex digest.
 */
export function contentDigest(content: string): string {
  return digest(content)
}
