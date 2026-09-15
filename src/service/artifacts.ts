/**
 * Recording and verifying artifacts (PRD §二.9.1).
 *
 * The specification's central demand here is that four different facts must
 * never be collapsed into one another:
 *
 *   the model claimed it produced this
 *   ≠ the file was verified to exist
 *   ≠ a check passed
 *   ≠ the user accepted it
 *
 * So an artifact carries `existence` and `acceptance` as separate axes, each with
 * its own evidence, and the code below never advances one on the strength of the
 * other. The second demand is about staleness: "a variable path cannot be a fixed
 * input to an automatic dependency", and a changed or missing file must be
 * reported as such rather than silently replaced by another file of the same
 * name. That is what {@link isPinnedForDependency} exists to answer, and it
 * answers "no" for anything that has not been hashed in full and re-checked.
 * {@link decideArtifactRead} and {@link decideArtifactOpen} apply the same
 * identity rule to the 读取 and 打开 family actions: they name the recorded
 * locator, never a same-name substitute. A directory that is present and
 * unchanged is listed at that recorded path (PRD §二.9.1 目录清单); another
 * directory of the same name is never listed. A link or service entry is the
 * recorded URL, not a filesystem path; a commit is the recorded git object, not
 * another commit of the same name; a patch or test report is the recorded file.
 *
 * @module dsh-session-conductor/service/artifacts
 */

import { createHash } from 'node:crypto'
import type { ArtifactRecord, ArtifactKind } from './artifact-types.ts'
// The acceptance vocabulary is the workflow module's, reused rather than re-declared: "who decided"
// is one question with one set of answers (PRD §二.12), and two copies of that union would let the
// artifact side and the node side drift apart.
import type { AcceptanceBy } from './workflow.ts'

/** What a caller supplies when registering an artifact. */
export interface RegisterArtifactRequest {
  readonly artifactId: string
  readonly taskId: string
  readonly kind: ArtifactKind
  readonly name: string
  readonly hostId: string
  readonly sessionId?: string
  readonly turn?: number
  readonly path?: string
  readonly url?: string
  readonly gitRef?: string
  /** Content hash the producer observed, when it took one. */
  readonly contentHash?: string
  readonly constraintVersion?: number
  /**
   * Shared constraints in force when the artifact was produced (PRD §二.9.1).
   *
   * Optional: a registration that names none stores none rather than inventing a
   * version. The register path stamps the live set when the caller does not.
   */
  readonly constraints?: readonly { readonly constraintId: string; readonly version: number }[]
  /** How the producer described it; recorded verbatim as evidence. */
  readonly claimedBy?: string
}

/**
 * Build a fresh record for a newly registered artifact.
 *
 * Registration records a **claim**, never a fact: the artifact starts in
 * `claimed` with `pending` acceptance no matter what the producer said about it,
 * because nothing has looked yet.
 *
 * @param request - the registration.
 * @param now - the current time as ISO 8601 UTC.
 * @returns the record to store.
 */
export function newArtifactRecord(request: RegisterArtifactRequest, now: string): ArtifactRecord {
  return {
    artifactId: request.artifactId,
    taskId: request.taskId,
    kind: request.kind,
    name: request.name,
    hostId: request.hostId,
    contentVersion: 0,
    existence: 'claimed',
    acceptance: 'pending',
    evidence: [
      request.claimedBy === undefined
        ? 'registered as a claim; nothing has verified it yet'
        : `claimed by ${request.claimedBy}`,
    ],
    createdAt: now,
    updatedAt: now,
    ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
    ...request.turn === undefined ? {} : { turn: request.turn },
    ...request.path === undefined ? {} : { path: request.path },
    ...request.url === undefined ? {} : { url: request.url },
    ...request.gitRef === undefined ? {} : { gitRef: request.gitRef },
    // A producer-supplied hash is recorded but NOT treated as verified: this
    // build has not checked it against the file.
    ...request.contentHash === undefined
      ? {}
      : { contentHash: request.contentHash, hashScope: 'full' as const },
    ...request.constraintVersion === undefined ? {} : { constraintVersion: request.constraintVersion },
    ...request.constraints === undefined || request.constraints.length === 0
      ? {}
      : { constraints: request.constraints.map(entry => ({ constraintId: entry.constraintId, version: entry.version })) },
  }
}

/**
 * The Host facts that fill in provenance a caller did not name (PRD §二.9.1).
 *
 * Registration is a claim about a *produced* artifact, so the producing session,
 * the producing turn and the constraints then in force belong on the record even
 * when the caller did not list them. A later edit of a constraint must not
 * rewrite what this artifact was produced under.
 */
export interface ArtifactProvenanceFacts {
  readonly bindingSessionId?: string | undefined
  /** How many turns have started on the live session; 0 means none, so no turn is claimed. */
  readonly liveTurnsStarted?: number | undefined
  readonly constraints: readonly { readonly constraintId: string; readonly version: number }[]
}

/**
 * Fill source session, turn and related constraint versions onto a registration.
 *
 * Caller-supplied values win. Live facts fill only what was omitted. A session
 * that has not started a turn does not get `turn: 0` invented.
 *
 * @param request - what the caller named.
 * @param facts - the binding, the live projection and the constraints in force.
 * @returns the registration to persist.
 */
export function stampArtifactProvenance(
  request: RegisterArtifactRequest,
  facts: ArtifactProvenanceFacts,
): RegisterArtifactRequest {
  const sessionId = request.sessionId ?? facts.bindingSessionId
  const turn = request.turn ?? (
    facts.liveTurnsStarted !== undefined && facts.liveTurnsStarted > 0 ? facts.liveTurnsStarted : undefined
  )
  const constraints = request.constraints ?? facts.constraints
  return {
    ...request,
    ...sessionId === undefined ? {} : { sessionId },
    ...turn === undefined ? {} : { turn },
    ...constraints.length === 0 ? {} : { constraints: constraints.map(entry => ({
      constraintId: entry.constraintId,
      version: entry.version,
    })) },
  }
}

/**
 * Render the provenance PRD §二.9.1 requires a reader to see.
 *
 * @param record - the stored artifact.
 * @returns a one-line account, or undefined when nothing was recorded.
 */
export function describeArtifactProvenance(record: {
  readonly sessionId?: string | undefined
  readonly turn?: number | undefined
  readonly constraintVersion?: number | undefined
  readonly constraints?: readonly { readonly constraintId: string; readonly version: number }[] | undefined
}): string | undefined {
  const parts: string[] = []
  if (record.sessionId !== undefined) parts.push(`session ${record.sessionId}`)
  if (record.turn !== undefined) parts.push(`turn ${String(record.turn)}`)
  if (record.constraints !== undefined && record.constraints.length > 0) {
    parts.push(`constraints ${record.constraints.map(entry => `${entry.constraintId}@${String(entry.version)}`).join(', ')}`)
  } else if (record.constraintVersion !== undefined) {
    parts.push(`constraint v${String(record.constraintVersion)}`)
  }
  return parts.length === 0 ? undefined : parts.join(', ')
}

/** One direct child of a recorded directory. Names only; never file contents. */
export interface ArtifactDirEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
}

/**
 * How many direct children of a directory are hashed and returned.
 *
 * An unbounded listing is not something a coordination plugin should hold.
 * Exceeding the cap is recorded: a prefix digest is never presented as the
 * whole listing, so a later reader cannot mistake a changed directory for
 * an unchanged one.
 */
export const LISTING_ENTRY_LIMIT = 500

/** The filesystem surface verification uses. */
export interface ArtifactFsPort {
  /**
   * Resolve a path to whatever the provider needs.
   * @param path - the artifact path.
   * @returns the resolved target.
   */
  resolve(path: string): Promise<unknown>
  /**
   * Stat a resolved target.
   * @param target - the resolved target.
   * @param signal - cancellation.
   * @returns size and type information, or undefined when nothing is there.
   */
  stat(
    target: unknown,
    signal?: AbortSignal,
  ): Promise<{ size?: number; type?: 'file' | 'directory' | 'symlink' | 'other' } | undefined>
  /**
   * Read up to `maxBytes` of a target's bytes.
   * @param target - the resolved target.
   * @param signal - cancellation.
   * @param maxBytes - the read cap.
   * @returns the bytes actually read.
   */
  readBytes(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  /**
   * List direct children of a directory. Metadata only; never file contents.
   *
   * Optional because a composition may mount a filesystem that can stat and
   * read but not list. A missing lister does not invent children.
   *
   * @param target - the resolved directory.
   * @param signal - cancellation.
   * @returns one entry per direct child.
   */
  listDir?(target: unknown, signal?: AbortSignal): Promise<readonly ArtifactDirEntry[]>
}

/**
 * Kind-specific checks that are not filesystem reads (PRD §二.9.1).
 *
 * A link or service entry is a URL; a commit is a git object. Neither is a
 * file to hash. Reachability of a URL is **not** probed here: fetching a
 * caller-supplied address would be a side channel, and "the locator is
 * well-formed" is not "the resource exists". A missing git resolver leaves a
 * commit claimed rather than inventing presence from the reference text.
 */
export interface ArtifactKindPort {
  /**
   * Resolve a git reference in the recorded repository.
   *
   * @param gitRef - the recorded reference.
   * @param cwd - the repository path, when one was recorded.
   * @param signal - cancellation.
   * @returns whether that object is present, missing, or could not be checked.
   */
  resolveGitRef?(
    gitRef: string,
    cwd: string | undefined,
    signal?: AbortSignal,
  ): Promise<GitRefObservation>
}

/** What resolving a commit artifact found. */
export interface GitRefObservation {
  readonly status: 'present' | 'missing' | 'unchecked'
  readonly resolvedSha?: string | undefined
  readonly evidence: string
}

/**
 * Bound, sort and hash a directory listing.
 *
 * Sort is by name so two listings of the same children agree even when the
 * backend's order differs. Truncation happens after that sort, so the prefix
 * is the first {@link LISTING_ENTRY_LIMIT} names, not an arbitrary slice.
 *
 * @param entries - the children the recorded path listed.
 * @returns the bounded listing, its digest, and whether it was truncated.
 */
export function boundListing(entries: readonly ArtifactDirEntry[]): {
  readonly entries: ArtifactDirEntry[]
  readonly truncated: boolean
  readonly digest: string
  readonly hashScope: 'full' | 'prefix'
} {
  const normalised: ArtifactDirEntry[] = entries.map(entry => ({
    name: entry.name,
    type: entry.type === 'file' || entry.type === 'directory' ? entry.type : 'other',
  }))
  normalised.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const truncated = normalised.length > LISTING_ENTRY_LIMIT
  const bounded = truncated ? normalised.slice(0, LISTING_ENTRY_LIMIT) : normalised
  const lines = bounded.map(entry => `${entry.type}\t${entry.name}`).join('\n')
  return {
    entries: bounded,
    truncated,
    digest: createHash('sha256').update(lines, 'utf8').digest('hex'),
    hashScope: truncated ? 'prefix' : 'full',
  }
}

/** What one verification pass concluded. */
export interface ArtifactVerification {
  readonly existence: ArtifactRecord['existence']
  readonly contentHash?: string
  readonly hashScope?: 'full' | 'prefix'
  readonly sizeBytes?: number
  /** Human-readable evidence lines to append. */
  readonly evidence: string[]
  /** True when the recorded content version must advance. */
  readonly contentChanged: boolean
}

/**
 * How many bytes of a file are hashed before the digest is declared a prefix.
 *
 * The cap exists because reading an unbounded file into memory is not something a
 * coordination plugin should do. What matters is that exceeding it is *recorded*:
 * a prefix digest is never presented as a whole-file digest, so a later reader
 * cannot mistake a changed file for an unchanged one.
 */
export const HASH_BYTE_LIMIT = 8 * 1024 * 1024

/**
 * Verify one artifact by its kind (PRD §二.9.1).
 *
 * The result is a statement about what was observed, and never a fallback: a
 * missing file is `missing`, not "we looked somewhere else"; a file whose digest
 * differs from the recorded one is `changed`, not "the new file is the
 * artifact now". A link is the recorded URL, a commit is the recorded git
 * object, a directory is listed at the recorded path. Both leave the recorded
 * `contentHash` describing what was actually verified last, so the drift stays
 * visible.
 *
 * @param record - the artifact to verify.
 * @param fs - the Host filesystem service, when one is mounted.
 * @param kinds - non-filesystem checks (git objects). Optional.
 * @param signal - cancellation.
 * @returns the verification outcome.
 */
export async function verifyArtifact(
  record: ArtifactRecord,
  fs: ArtifactFsPort | undefined,
  kinds?: ArtifactKindPort,
  signal?: AbortSignal,
): Promise<ArtifactVerification> {
  if (record.kind === 'link' || record.kind === 'service') {
    return verifyUrlLocator(record)
  }
  if (record.kind === 'commit') {
    return verifyCommit(record, kinds, signal)
  }
  return verifyFilesystemArtifact(record, fs, signal)
}

/**
 * Verify a link or service entry at its recorded URL.
 *
 * The URL is the identity. A filesystem path of the same name is not this
 * artifact. Reachability is not probed: a well-formed locator is not proof the
 * resource exists, so existence is not advanced to `present`. A locator digest
 * is recorded so a later change of the URL is `changed` rather than a silent
 * substitute.
 *
 * @param record - the link or service artifact.
 * @returns the verification outcome.
 */
function verifyUrlLocator(record: ArtifactRecord): ArtifactVerification {
  const kind = record.kind
  if (record.url === undefined) {
    return {
      existence: record.existence,
      evidence: [
        `a ${kind} artifact is verified at its recorded URL, not at a filesystem path; `
        + (record.path === undefined
          ? 'no URL is recorded'
          : `the path ${record.path} is not this ${kind}`),
      ],
      contentChanged: false,
    }
  }
  const parsed = parseRecordedUrl(record.url, kind)
  if (!parsed.ok) {
    return { existence: record.existence, evidence: [parsed.reason], contentChanged: false }
  }
  const digest = createHash('sha256').update(parsed.canonical).digest('hex')
  if (record.contentHash === undefined) {
    return {
      existence: record.existence,
      contentHash: digest,
      hashScope: 'full',
      contentChanged: false,
      evidence: [
        `recorded ${kind} URL ${parsed.canonical}; reachability is not probed in this build, `
        + `so existence stays ${record.existence} rather than claimed present. Digest of the locator recorded.`,
      ],
    }
  }
  if (record.contentHash === digest) {
    return {
      existence: record.existence,
      contentHash: digest,
      hashScope: 'full',
      contentChanged: false,
      evidence: [
        `recorded ${kind} URL ${parsed.canonical} is unchanged; reachability is not probed, `
        + `so existence stays ${record.existence}`,
      ],
    }
  }
  return {
    existence: 'changed',
    contentHash: digest,
    hashScope: 'full',
    contentChanged: true,
    evidence: [
      `recorded ${kind} URL changed: locator digest ${record.contentHash.slice(0, 12)}… became `
      + `${digest.slice(0, 12)}… — another URL is not this ${kind}; the recorded hash still describes `
      + 'what was verified last',
    ],
  }
}

/**
 * Parse a recorded link/service URL.
 *
 * Only http(s) locators are accepted. A `file:` URL is a path artifact, and
 * fetching an arbitrary scheme would be a side channel this plugin does not
 * open.
 *
 * @param url - the recorded URL.
 * @param kind - link or service, for the refusal text.
 * @returns the canonical href, or why it is not this kind of locator.
 */
function parseRecordedUrl(
  url: string,
  kind: string,
): { ok: true; canonical: string } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: `the recorded ${kind} URL is not parseable: ${url}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `a ${kind} URL must be http(s); ${parsed.protocol} is not probed and is not a filesystem path`,
    }
  }
  return { ok: true, canonical: parsed.href }
}

/**
 * Verify a commit artifact at its recorded git object.
 *
 * The object is the identity. Another commit (including HEAD) is never this
 * artifact. Without a git resolver the reference stays claimed: the text of a
 * SHA is not proof the object exists.
 *
 * @param record - the commit artifact.
 * @param kinds - the git resolver, when one is mounted.
 * @param signal - cancellation.
 * @returns the verification outcome.
 */
async function verifyCommit(
  record: ArtifactRecord,
  kinds: ArtifactKindPort | undefined,
  signal?: AbortSignal,
): Promise<ArtifactVerification> {
  if (record.gitRef === undefined) {
    return {
      existence: record.existence,
      evidence: [
        'a commit artifact is verified at its recorded git reference, not at a filesystem path; '
        + (record.path === undefined
          ? 'no git reference is recorded'
          : `the path ${record.path} is not this commit`),
      ],
      contentChanged: false,
    }
  }
  const resolve = kinds?.resolveGitRef
  if (resolve === undefined) {
    return {
      existence: record.existence,
      evidence: [
        `git reference ${record.gitRef} is recorded; this composition cannot resolve a git object, `
        + 'so existence is not advanced. Another commit is not this artifact.',
      ],
      contentChanged: false,
    }
  }
  const observation = await resolve(record.gitRef, record.path, signal)
  if (observation.status === 'unchecked') {
    return {
      existence: record.existence,
      evidence: [observation.evidence],
      contentChanged: false,
    }
  }
  if (observation.status === 'missing') {
    return {
      existence: 'missing',
      evidence: [observation.evidence],
      contentChanged: record.existence === 'present',
    }
  }
  const sha = observation.resolvedSha
  if (sha === undefined) {
    return {
      existence: 'present',
      evidence: [observation.evidence],
      contentChanged: false,
    }
  }
  if (record.contentHash === undefined) {
    return {
      existence: 'present',
      contentHash: sha,
      hashScope: 'full',
      contentChanged: false,
      evidence: [observation.evidence],
    }
  }
  if (record.contentHash === sha) {
    return {
      existence: 'present',
      contentHash: sha,
      hashScope: 'full',
      contentChanged: false,
      evidence: ['verified present and unchanged since the last check'],
    }
  }
  return {
    existence: 'changed',
    contentHash: sha,
    hashScope: 'full',
    contentChanged: true,
    evidence: [
      `git object changed: recorded ${record.contentHash.slice(0, 12)}…, found ${sha.slice(0, 12)}… — `
      + 'another commit is not this artifact; the recorded hash still describes what was verified last',
    ],
  }
}

/**
 * Verify a file, directory, patch or test report at the recorded path.
 *
 * @param record - the artifact.
 * @param fs - the filesystem port, when mounted.
 * @param signal - cancellation.
 * @returns the verification outcome.
 */
async function verifyFilesystemArtifact(
  record: ArtifactRecord,
  fs: ArtifactFsPort | undefined,
  signal?: AbortSignal,
): Promise<ArtifactVerification> {
  if (fs === undefined) {
    return {
      existence: record.existence === 'present' ? 'claimed' : record.existence,
      evidence: ['no filesystem service is mounted, so nothing could be checked on disk'],
      contentChanged: false,
    }
  }
  if (record.path === undefined) {
    return {
      existence: record.existence,
      evidence: [
        record.url === undefined && record.gitRef === undefined
          ? `a ${record.kind} artifact needs the recorded path to check; no path, url or git reference is recorded`
          : `a ${record.kind} artifact is verified at its recorded path, not at a URL or git reference`,
      ],
      contentChanged: false,
    }
  }

  let target: unknown
  try {
    target = await fs.resolve(record.path)
  } catch (error) {
    return {
      existence: 'missing',
      evidence: [`the path could not be resolved: ${message(error)}`],
      contentChanged: false,
    }
  }

  let info: Awaited<ReturnType<ArtifactFsPort['stat']>>
  try {
    info = await fs.stat(target, signal)
  } catch (error) {
    return {
      existence: record.existence === 'present' ? 'claimed' : record.existence,
      evidence: [`the recorded path could not be inspected: ${message(error)}`],
      contentChanged: false,
    }
  }
  if (info === undefined) {
    return {
      existence: 'missing',
      evidence: [`${record.path} is not present at the recorded path`],
      contentChanged: false,
    }
  }

  if (record.kind === 'directory') {
    return verifyDirectoryListing(record, fs, target, info, signal)
  }

  if (info.type !== undefined && info.type !== 'file') {
    return {
      existence: 'changed', contentChanged: record.existence !== 'changed',
      evidence: [`${record.path} is a ${info.type}, not the recorded regular file`],
    }
  }

  let bytes: Uint8Array
  try {
    bytes = await fs.readBytes(target, signal, HASH_BYTE_LIMIT)
  } catch (error) {
    return {
      existence: record.existence === 'changed' ? 'changed' : 'claimed',
      evidence: [`${record.path} exists but its content could not be read: ${message(error)}`],
      contentChanged: false,
      ...info.size === undefined ? {} : { sizeBytes: info.size },
    }
  }

  const digest = createHash('sha256').update(bytes).digest('hex')
  const truncated = info.size !== undefined && info.size > bytes.byteLength
  const hashScope = truncated ? 'prefix' as const : 'full' as const

  const evidence: string[] = []
  let existence: ArtifactRecord['existence'] = 'present'
  let contentChanged = false
  const kindNote = record.kind === 'file' ? '' : `${record.kind} `

  if (record.contentHash === undefined) {
    evidence.push(
      `verified present; ${kindNote}sha256 ${truncated ? 'over the first ' : ''}${String(bytes.byteLength)} byte(s) recorded`,
    )
  } else if (record.contentHash === digest && record.hashScope === hashScope) {
    evidence.push('verified present and unchanged since the last check')
  } else if (record.contentHash === digest) {
    evidence.push('verified present; the digest matches but was taken over a different range than before')
  } else {
    existence = 'changed'
    contentChanged = true
    evidence.push(
      `content changed at ${record.path}: recorded ${record.contentHash.slice(0, 12)}…, `
      + `found ${digest.slice(0, 12)}… — the recorded hash still describes what was verified last`,
    )
  }

  return {
    existence,
    contentHash: digest,
    hashScope,
    contentChanged,
    evidence,
    ...info.size === undefined ? {} : { sizeBytes: info.size },
  }
}

/**
 * Verify a directory artifact by hashing its recorded path's children.
 *
 * The listing is of that path only. A file sitting there, a failed listing, or
 * a composition that cannot list, is reported as such — another directory of
 * the same name is not consulted.
 *
 * @param record - the directory artifact.
 * @param fs - the filesystem port.
 * @param target - the already-resolved recorded path.
 * @param info - the stat of that path.
 * @param signal - cancellation.
 * @returns the verification outcome.
 */
async function verifyDirectoryListing(
  record: ArtifactRecord,
  fs: ArtifactFsPort,
  target: unknown,
  info: { size?: number; type?: 'file' | 'directory' | 'symlink' | 'other' },
  signal?: AbortSignal,
): Promise<ArtifactVerification> {
  const size = info.size === undefined ? {} : { sizeBytes: info.size }
  if (info.type !== undefined && info.type !== 'directory') {
    return {
      existence: record.existence === 'present' || record.existence === 'changed' ? 'changed' : record.existence,
      evidence: [
        `${record.path} is a ${info.type}, not a directory; another directory of the same name is not listed`,
      ],
      contentChanged: record.existence === 'present',
      ...size,
    }
  }
  if (typeof fs.listDir !== 'function') {
    return {
      existence: record.existence,
      evidence: [
        `${record.path} exists but this composition cannot list a directory, so its children are not hashed`,
      ],
      contentChanged: false,
      ...size,
    }
  }
  let entries: readonly ArtifactDirEntry[]
  try {
    entries = await fs.listDir(target, signal)
  } catch (error) {
    return {
      existence: record.existence === 'present' || record.existence === 'changed' ? 'changed' : record.existence,
      evidence: [
        `${record.path} could not be listed: ${message(error)}; another directory of the same name is not listed`,
      ],
      contentChanged: record.existence === 'present',
      ...size,
    }
  }

  const listing = boundListing(entries)
  const evidence: string[] = []
  let existence: ArtifactRecord['existence'] = 'present'
  let contentChanged = false
  const truncatedNote = listing.truncated
    ? `first ${String(listing.entries.length)} of more`
    : `${String(listing.entries.length)}`

  if (record.contentHash === undefined) {
    evidence.push(
      `verified present; listing of ${truncatedNote} direct child(ren) hashed`
      + (listing.truncated ? ' (prefix)' : ''),
    )
  } else if (record.contentHash === listing.digest && record.hashScope === listing.hashScope) {
    evidence.push('verified present and unchanged since the last check')
  } else if (record.contentHash === listing.digest) {
    evidence.push('verified present; the listing digest matches but was taken over a different range than before')
  } else {
    existence = 'changed'
    contentChanged = true
    evidence.push(
      `listing changed at ${record.path}: recorded ${record.contentHash.slice(0, 12)}…, `
        + `found ${listing.digest.slice(0, 12)}… — the recorded hash still describes what was verified last`,
    )
  }

  return {
    existence,
    contentHash: listing.digest,
    hashScope: listing.hashScope,
    contentChanged,
    evidence,
    ...size,
  }
}

/**
 * Apply a verification outcome to a record.
 *
 * @param record - the artifact as stored.
 * @param outcome - what the check found.
 * @param now - the current time as ISO 8601 UTC.
 * @returns the next record.
 */
export function applyVerification(
  record: ArtifactRecord,
  outcome: ArtifactVerification,
  now: string,
): ArtifactRecord {
  const evidence = [...record.evidence, ...outcome.evidence].slice(-20)
  const keepRecordedHash = outcome.existence === 'changed'
  return {
    ...record,
    existence: outcome.existence,
    evidence,
    ...outcome.contentHash === undefined ? {} : { verifiedAt: now },
    updatedAt: now,
    contentVersion: outcome.contentChanged && record.existence !== 'changed' ? record.contentVersion + 1 : record.contentVersion,
    ...outcome.contentChanged ? { acceptance: 'pending' as const, acceptedBy: undefined, acceptedAt: undefined } : {},
    // On a change, the recorded hash keeps describing what was verified last, so
    // the drift between the record and the file stays readable. On a match or a
    // first check, the fresh digest becomes the record.
    ...outcome.contentHash === undefined
      ? { hashScope: undefined }
      : keepRecordedHash
        ? {}
        : { contentHash: outcome.contentHash, hashScope: outcome.hashScope },
    ...outcome.sizeBytes === undefined ? {} : { sizeBytes: outcome.sizeBytes },
  }
}

/**
 * Record an acceptance verdict.
 *
 * Kept separate from existence on purpose: a check passing is not the user
 * accepting, and the specification requires the two to be told apart.
 *
 * @param record - the artifact as stored.
 * @param verdict - the verdict being recorded.
 * @param evidence - why that verdict was reached.
 * @param now - the current time as ISO 8601 UTC.
 * @param by - who decided it, and when; see {@link acceptanceCounts}.
 * @returns the next record.
 */
export function applyAcceptance(
  record: ArtifactRecord,
  verdict: ArtifactRecord['acceptance'],
  evidence: string,
  now: string,
  by?: { readonly by: AcceptanceBy; readonly at: string },
): ArtifactRecord {
  return {
    ...record,
    acceptance: verdict,
    evidence: [...record.evidence, evidence].slice(-20),
    ...by === undefined ? {} : { acceptedBy: by.by, acceptedAt: by.at },
    updatedAt: now,
  }
}

/**
 * Whether an artifact's recorded acceptance is one that may gate automatic work.
 *
 * PRD §二.9.1 keeps "检查通过" and "用户验收" apart from what the model merely says, and §二.12
 * forbids a subjective model review from passing itself off as acceptance. So an artifact counts as
 * accepted only when the **user** accepted it or a **deterministic check** did — and an acceptance
 * recorded before this distinction existed (no `acceptedBy`) does not count either, because nothing
 * attributes it and an unattributed acceptance is exactly the claim the rule refuses.
 *
 * @param record - the artifact to judge.
 * @returns whether its acceptance counts, and the reason when it does not.
 */
export function acceptanceCounts(record: ArtifactRecord): { counts: boolean; reason: string } {
  if (record.acceptance !== 'pass') {
    return { counts: false, reason: `its acceptance is "${record.acceptance}"` }
  }
  if (record.acceptedBy === 'user' || record.acceptedBy === 'deterministic_check') {
    return { counts: true, reason: `accepted by ${record.acceptedBy}` }
  }
  if (record.acceptedBy === 'model_review') {
    return {
      counts: false,
      reason: 'it was reviewed by the model, which is a judgement and not acceptance',
    }
  }
  return {
    counts: false,
    reason: 'its acceptance is recorded with no attribution, so nothing says who accepted it',
  }
}

/**
 * Whether an artifact may be used as a fixed input to an automatic dependency.
 *
 * PRD §二.9.1: a variable path cannot be that input, and a downstream execution
 * must not start until an immutable snapshot exists or the version is verified
 * unchanged. So the answer is yes only when the artifact was found present, was
 * hashed **in full**, and has not changed since — a prefix digest, a claim, a
 * missing file and a changed file all answer no.
 *
 * @param record - the artifact to test.
 * @returns the decision and, when it is no, the reason.
 */
export function isPinnedForDependency(record: ArtifactRecord): { pinned: boolean; reason: string } {
  if (record.kind === 'directory') {
    return { pinned: false, reason: 'a directory listing hashes names only, not file contents; register and verify the individual files before using them as fixed inputs' }
  }
  if (record.existence === 'claimed') {
    return { pinned: false, reason: 'nothing has verified that this artifact exists' }
  }
  if (record.existence === 'missing') {
    return { pinned: false, reason: 'the artifact was not present at its recorded path' }
  }
  if (record.existence === 'changed') {
    return { pinned: false, reason: 'the artifact changed since it was verified, so it is not a fixed input' }
  }
  if (record.contentHash === undefined) {
    return { pinned: false, reason: 'no content hash was recorded, so the version cannot be compared' }
  }
  if (record.hashScope !== 'full') {
    return {
      pinned: false,
      reason: 'the recorded hash covers only part of the content, so a change beyond that range would go unnoticed',
    }
  }
  return { pinned: true, reason: 'verified present with a whole-content hash' }
}

/**
 * Whether an artifact was produced under constraint versions this run fixed.
 *
 * PRD §二.13.1 requires a compatibility check before automatically starting
 * downstream work. C176 compares the *live* constraint table against the run;
 * this compares the *artifact's recorded provenance* against the same freeze.
 * An artifact produced under a different version of a constraint the run
 * fixed is not a fixed input — the downstream node would be built to terms
 * nobody agreed this run would use. An artifact that recorded no provenance
 * (a record from before the field existed) is not evidence of a mismatch,
 * so it does not block.
 *
 * @param artifact - the candidate input.
 * @param runConstraints - the constraint versions the run fixed at start.
 * @returns whether the artifact may be used, and why.
 */
export function artifactConstraintCompatibleWithRun(
  artifact: Pick<ArtifactRecord, 'constraints'>,
  runConstraints: readonly { readonly constraintId: string; readonly version: number }[],
): { readonly compatible: boolean; readonly reason: string } {
  const stamped = artifact.constraints ?? []
  if (stamped.length === 0) {
    return { compatible: true, reason: 'the artifact recorded no constraint provenance, so there is no mismatch to refuse' }
  }
  for (const produced of stamped) {
    const fixed = runConstraints.find(entry => entry.constraintId === produced.constraintId)
    if (fixed === undefined) continue
    if (produced.version !== fixed.version) {
      return {
        compatible: false,
        reason: `the artifact was produced under constraint ${produced.constraintId} version `
          + `${String(produced.version)}, and this run fixed version ${String(fixed.version)}; `
          + 'downstream work will not start automatically on terms the run never fixed',
      }
    }
  }
  return { compatible: true, reason: 'the artifact\'s recorded constraint versions match the ones this run fixed' }
}

/**
 * How many characters of a verified file may cross the read tool.
 *
 * Unbounded file bodies are not a coordination concern. The cap is recorded as
 * truncation rather than silently shortened, matching PRD §二.7's history rule.
 */
export const ARTIFACT_PREVIEW_CHAR_LIMIT = 4_096

/** Bytes read to produce {@link ARTIFACT_PREVIEW_CHAR_LIMIT} of UTF-8. */
export const ARTIFACT_PREVIEW_BYTE_LIMIT = 16_384

/** The locator this artifact actually recorded — never a same-name substitute. */
export type ArtifactLocator =
  | { readonly kind: 'path'; readonly value: string }
  | { readonly kind: 'url'; readonly value: string }
  | { readonly kind: 'git'; readonly value: string }
  | { readonly kind: 'none' }

/**
 * The locator the record itself names.
 *
 * Identity is the recorded path, URL or git reference. A file that happens to
 * share the artifact's `name` elsewhere is not this artifact (PRD §二.9.1, T17).
 *
 * @param record - the stored artifact.
 * @returns the recorded locator.
 */
export function recordedLocator(record: Pick<ArtifactRecord, 'path' | 'url' | 'gitRef'>): ArtifactLocator {
  if (record.path !== undefined) return { kind: 'path', value: record.path }
  if (record.url !== undefined) return { kind: 'url', value: record.url }
  if (record.gitRef !== undefined) return { kind: 'git', value: record.gitRef }
  return { kind: 'none' }
}

/** Whether native-open may target the recorded filesystem path. */
export interface ArtifactOpenDecision {
  readonly nativeOpen: boolean
  readonly reason: string
  readonly locator: ArtifactLocator
  readonly existence: ArtifactRecord['existence']
}

/**
 * Decide whether the recorded path may be handed to the OS default application.
 *
 * Missing and changed files are refused. The decision never names a different
 * path, so a same-name file elsewhere cannot be opened in the artifact's place
 * (PRD §二.9.1: 文件不存在或内容已变更时，不静默打开另一个同名文件).
 *
 * A URL or git reference is returned as the recorded locator; it is not a
 * filesystem path, so the OS opener is not invoked.
 *
 * @param record - the stored artifact (identity).
 * @param liveExistence - what a just-run check of the *recorded* path found.
 * @returns whether native open is allowed, and always the recorded locator.
 */
export function decideArtifactOpen(
  record: Pick<ArtifactRecord, 'path' | 'url' | 'gitRef' | 'kind'>,
  liveExistence: ArtifactRecord['existence'],
): ArtifactOpenDecision {
  const locator = recordedLocator(record)
  if (locator.kind !== 'path') {
    return {
      nativeOpen: false,
      reason: locator.kind === 'none'
        ? 'this artifact records no filesystem path, URL or git reference to open'
        : `this artifact is a ${locator.kind === 'url' ? 'URL' : 'git reference'} (${locator.value}), `
          + 'not a filesystem path; the recorded locator is returned and the OS default application is not invoked',
      locator,
      existence: liveExistence,
    }
  }
  if (liveExistence === 'missing') {
    return {
      nativeOpen: false,
      reason: `the recorded path ${locator.value} is not present; another file of the same name is not opened in its place`,
      locator,
      existence: liveExistence,
    }
  }
  if (liveExistence === 'changed') {
    return {
      nativeOpen: false,
      reason: `content at the recorded path ${locator.value} has changed since it was verified; `
        + 'it is not opened as this artifact, and another file of the same name is not opened in its place',
      locator,
      existence: liveExistence,
    }
  }
  if (liveExistence !== 'present') {
    return {
      nativeOpen: false,
      reason: `the recorded path has not been verified present, so it is not opened (${liveExistence})`,
      locator,
      existence: liveExistence,
    }
  }
  return {
    nativeOpen: true,
    reason: `the recorded path ${locator.value} is present and unchanged`,
    locator,
    existence: liveExistence,
  }
}

/** Whether a filesystem preview or directory listing of the recorded path may be returned. */
export interface ArtifactReadDecision {
  readonly includePreview: boolean
  readonly includeListing: boolean
  readonly reason: string
  readonly locator: ArtifactLocator
  readonly existence: ArtifactRecord['existence']
}

/**
 * Decide whether the recorded path's bytes or children may be returned as this artifact.
 *
 * A missing or changed file is reported as such; the new bytes are not the
 * artifact, and a file of the same name elsewhere is not read. A directory
 * that is present and unchanged is listed at that recorded path (PRD §二.9.1
 * 目录清单); another directory of the same name is not listed. A URL or git
 * reference has no filesystem preview.
 *
 * @param record - the stored artifact.
 * @param liveExistence - what a just-run check of the *recorded* path found.
 * @returns whether a text preview or a listing of the recorded path may be included.
 */
export function decideArtifactRead(
  record: Pick<ArtifactRecord, 'path' | 'url' | 'gitRef' | 'kind'>,
  liveExistence: ArtifactRecord['existence'],
): ArtifactReadDecision {
  const locator = recordedLocator(record)
  const isDirectory = record.kind === 'directory'
  const substitute = isDirectory
    ? 'another directory of the same name is not listed'
    : 'a file of the same name elsewhere is not read'
  if (locator.kind !== 'path') {
    return {
      includePreview: false,
      includeListing: false,
      reason: locator.kind === 'none'
        ? 'this artifact records no filesystem path to read'
        : `the recorded ${locator.kind === 'url' ? 'URL' : 'git reference'} is ${locator.value}; `
          + 'a filesystem preview is not taken from a file of the same name',
      locator,
      existence: liveExistence,
    }
  }
  if (liveExistence === 'missing') {
    return {
      includePreview: false,
      includeListing: false,
      reason: `the recorded path ${locator.value} is not present; ${substitute}`,
      locator,
      existence: liveExistence,
    }
  }
  if (liveExistence === 'changed') {
    return {
      includePreview: false,
      includeListing: false,
      reason: `content at the recorded path ${locator.value} has changed since it was verified; `
        + `the new ${isDirectory ? 'listing is' : 'bytes are'} not returned as this artifact, and ${substitute}`,
      locator,
      existence: liveExistence,
    }
  }
  if (liveExistence !== 'present') {
    return {
      includePreview: false,
      includeListing: false,
      reason: `the recorded path has not been verified present, so its content is not returned as this artifact (${liveExistence})`,
      locator,
      existence: liveExistence,
    }
  }
  if (isDirectory) {
    return {
      includePreview: false,
      includeListing: true,
      reason: `the recorded path ${locator.value} is a directory, present and unchanged; `
        + 'the listing is of that path, not another directory of the same name',
      locator,
      existence: liveExistence,
    }
  }
  return {
    includePreview: true,
    includeListing: false,
    reason: `the recorded path ${locator.value} is present and unchanged`,
    locator,
    existence: liveExistence,
  }
}

/**
 * Decode a bounded UTF-8 preview, or report the bytes as binary.
 *
 * A NUL or a failed UTF-8 decode is binary: those bytes are not returned as
 * the artifact's text. Truncation is marked, never silent.
 *
 * @param bytes - bytes read from the *recorded* path.
 * @param maxChars - the character cap.
 * @returns the preview, or a binary refusal.
 */
export function utf8PreviewOf(
  bytes: Uint8Array,
  maxChars: number,
): { readonly text?: string; readonly truncated: boolean; readonly binary: boolean } {
  if (bytes.length === 0) return { text: '', truncated: false, binary: false }
  for (const octet of bytes) {
    if (octet === 0) return { truncated: false, binary: true }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { truncated: false, binary: true }
  }
  if (text.length > maxChars) {
    return { text: text.slice(0, maxChars), truncated: true, binary: false }
  }
  return { text, truncated: false, binary: false }
}

/** What `conductor_artifact_read` returns. */
export interface ArtifactReadResult {
  readonly artifactId: string
  readonly taskId: string
  readonly kind: ArtifactKind
  readonly name: string
  readonly existence: ArtifactRecord['existence']
  readonly storedExistence: ArtifactRecord['existence']
  readonly acceptance: ArtifactRecord['acceptance']
  readonly contentVersion: number
  readonly locatorKind: ArtifactLocator['kind']
  readonly location?: string
  readonly previewIncluded: boolean
  readonly listingIncluded?: boolean
  readonly entries?: readonly ArtifactDirEntry[]
  readonly content?: string
  readonly truncated: boolean
  readonly binary: boolean
  readonly reason: string
}

/** What `conductor_artifact_open` returns. */
export interface ArtifactOpenResult {
  readonly artifactId: string
  readonly existence: ArtifactRecord['existence']
  readonly opened: boolean
  readonly locatorKind: ArtifactLocator['kind']
  readonly location?: string
  readonly reason: string
}

/**
 * Render one thrown value as a short message.
 * @param error - the thrown value.
 * @returns the message.
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
