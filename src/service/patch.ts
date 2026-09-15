/**
 * Parsing and applying unified diffs (PRD §二.9.2, "Patch 交接").
 *
 * The specification's rules for a patch handoff are all about refusing to guess:
 *
 * - verify the receiver's baseline and current state;
 * - check it on an isolated copy **first**;
 * - state which files and which existing modifications are involved;
 * - **stop on a conflict and never overwrite the receiver's changes**.
 *
 * So this module never applies a hunk "approximately". A hunk that does not match
 * the target exactly, at the position the diff claims, is a conflict — the whole
 * patch is refused and the caller is told which file and which hunk failed. There
 * is no fuzz factor, because a fuzzy match is precisely how a patch lands on top
 * of someone else's edit without anyone noticing.
 *
 * Applying in memory *is* the isolated copy: the caller gets a new string and the
 * original file is untouched until the whole patch has been checked.
 *
 * @module dsh-session-conductor/service/patch
 */

/** One line of a hunk, with the role its prefix denotes. */
export interface PatchLine {
  readonly kind: 'context' | 'remove' | 'add'
  readonly text: string
}

/** One hunk of a unified diff. */
export interface Hunk {
  /** 1-based first line of the range in the original file. */
  readonly oldStart: number
  readonly oldLines: number
  /** 1-based first line of the range in the patched file. */
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly PatchLine[]
}

/** One file's worth of hunks. */
export interface PatchFile {
  /** Path as written in the diff, with a leading `a/` or `b/` stripped. */
  readonly path: string
  readonly hunks: readonly Hunk[]
}

/** Result of parsing a diff. */
export interface ParseResult {
  readonly files: PatchFile[]
  /** Lines the parser could not make sense of; a non-empty list means the patch is not usable. */
  readonly errors: string[]
}

/**
 * Parse a unified diff.
 *
 * Only the `@@ -old +new @@` form is understood, which is what `git diff` and
 * `diff -u` emit. Anything else is reported as an error rather than skipped:
 * silently ignoring the parts of a patch this build cannot read would apply a
 * partial change while reporting success.
 *
 * @param text - the diff.
 * @returns the parsed files and any errors.
 */
export function parseUnifiedDiff(text: string): ParseResult {
  const files: PatchFile[] = []
  const errors: string[] = []
  const lines = text.split('\n')
  let current: { path: string; hunks: Hunk[] } | undefined
  let hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: PatchLine[] } | undefined
  let pendingOldPath: string | undefined
  let oldSeen = 0
  let newSeen = 0

  const flushHunk = (): void => {
    if (hunk === undefined) return
    if (oldSeen !== hunk.oldLines || newSeen !== hunk.newLines) {
      errors.push('hunk line counts do not match its declared old/new ranges')
    }
    if (current === undefined) {
      errors.push('a hunk appeared before any file header')
      hunk = undefined
      return
    }
    current.hunks.push({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines,
    })
    hunk = undefined
  }

  const flushFile = (): void => {
    flushHunk()
    if (current === undefined) return
    if (current.hunks.length === 0) errors.push(`file ${current.path} has no hunks`)
    else files.push({ path: current.path, hunks: current.hunks })
    current = undefined
  }

  for (const [index, line] of lines.entries()) {
    // The split of a diff that ends with a newline yields one empty trailing
    // element. It is an artefact of the split, not a context line, and counting
    // it would make every hunk's line count wrong.
    if (index === lines.length - 1 && line === '') continue
    if (line.startsWith('\\')) {
      errors.push('patches with explicit no-newline markers are unsupported; newline changes are not silently discarded')
      continue
    }
    if (/^(old mode |new mode |new file mode |deleted file mode |rename from |rename to |copy from |copy to |GIT binary patch|Binary files )/.test(line)) {
      errors.push(`unsupported file metadata or binary change: ${line}`)
      continue
    }
    if (line.startsWith('diff --git ')) {
      flushFile()
      pendingOldPath = undefined
      continue
    }
    const bodyPending = hunk !== undefined && (oldSeen < hunk.oldLines || newSeen < hunk.newLines)
    if (line.startsWith('--- ') && !bodyPending) {
      flushFile()
      pendingOldPath = stripPrefix(line.slice(4).trim())
      if (pendingOldPath === '/dev/null') errors.push('creating files through a patch is unsupported; provide a snapshot copy')
      continue
    }
    if (line.startsWith('+++ ') && !bodyPending) {
      const newPath = stripPrefix(line.slice(4).trim())
      if (pendingOldPath === undefined) errors.push('new file header has no matching old file header')
      if (newPath === '/dev/null') errors.push('deleting files through a patch is unsupported')
      current = { path: newPath === '/dev/null' ? pendingOldPath ?? newPath : newPath, hunks: [] }
      continue
    }
    if (line.startsWith('@@')) {
      flushHunk()
      const parsed = parseHunkHeader(line)
      if (parsed === undefined) {
        errors.push(`unreadable hunk header: ${line}`)
        continue
      }
      hunk = { ...parsed, lines: [] }
      oldSeen = 0
      newSeen = 0
      continue
    }
    if (hunk === undefined) {
      // Prose before the first hunk is legal in a git diff (commit message,
      // index line, diff --git). Anything unrecognised here is not an error.
      continue
    }
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1) })
      newSeen += 1
      continue
    }
    if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'remove', text: line.slice(1) })
      oldSeen += 1
      continue
    }
    if (line.startsWith(' ') || line.length === 0) {
      // A fully empty line inside a hunk is a context line whose single leading
      // space some tools trim.
      hunk.lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line })
      oldSeen += 1
      newSeen += 1
      continue
    }
    errors.push(`unreadable hunk line: ${line}`)
  }
  flushFile()
  return { files, errors }
}

/**
 * Strip a diff's `a/` or `b/` prefix and any trailing timestamp.
 * @param path - the raw header value.
 * @returns the path.
 */
function stripPrefix(path: string): string {
  const withoutTimestamp = path.split('\t')[0] ?? path
  if (withoutTimestamp.startsWith('a/') || withoutTimestamp.startsWith('b/')) {
    return withoutTimestamp.slice(2)
  }
  return withoutTimestamp
}

/**
 * Parse a `@@ -old,count +new,count @@` header.
 * @param line - the header line.
 * @returns the ranges, or undefined when the header is not that shape.
 */
function parseHunkHeader(line: string): Omit<Hunk, 'lines'> | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (match === null) return undefined
  return {
    oldStart: Number.parseInt(match[1] ?? '0', 10),
    // An omitted count means one line, per the unified diff format.
    oldLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3] ?? '0', 10),
    newLines: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
  }
}

/** What applying one file's hunks produced. */
export type ApplyResult =
  | { readonly ok: true; readonly content: string; readonly hunksApplied: number }
  | { readonly ok: false; readonly reason: string; readonly hunkIndex: number }

/**
 * Apply one file's hunks to its current content.
 *
 * @param original - the file's current text.
 * @param hunks - the hunks to apply, in file order.
 * @returns the patched text, or the first conflict and where it was.
 */
export function applyHunks(original: string, hunks: readonly Hunk[]): ApplyResult {
  const trailingNewline = original.length === 0 || original.endsWith('\n')
  const lines = original.length === 0 ? [] : original.split('\n')
  if (original.endsWith('\n')) lines.pop()

  let offset = 0
  for (const [index, hunk] of hunks.entries()) {
    const oldSequence = hunk.lines.filter(line => line.kind !== 'add').map(line => line.text)
    const newSequence = hunk.lines.filter(line => line.kind !== 'remove').map(line => line.text)
    const at = hunk.oldStart - (hunk.oldLines === 0 ? 0 : 1) + offset
    if (oldSequence.length !== hunk.oldLines || newSequence.length !== hunk.newLines) {
      return { ok: false, reason: 'hunk line counts do not match its declared old/new ranges', hunkIndex: index }
    }

    if (at < 0 || at > lines.length) {
      return { ok: false, reason: `hunk ${String(index + 1)} starts at line ${String(hunk.oldStart)}, past the end of the file`, hunkIndex: index }
    }
    if (!matchesAt(lines, at, oldSequence)) {
      return {
        ok: false,
        reason: `hunk ${String(index + 1)} does not match the target at line ${String(hunk.oldStart)}: `
          + `the file does not contain the lines this hunk expects to replace`,
        hunkIndex: index,
      }
    }
    lines.splice(at, oldSequence.length, ...newSequence)
    offset += newSequence.length - oldSequence.length
  }

  return {
    ok: true,
    content: lines.length > 0 && trailingNewline ? `${lines.join('\n')}\n` : lines.join('\n'),
    hunksApplied: hunks.length,
  }
}

/**
 * Whether a sequence sits at a position.
 * @param lines - the file's lines.
 * @param at - the index to test.
 * @param expected - the lines expected there.
 * @returns true when every line matches.
 */
function matchesAt(lines: readonly string[], at: number, expected: readonly string[]): boolean {
  if (at + expected.length > lines.length) return false
  for (const [index, line] of expected.entries()) {
    if (lines[at + index] !== line) return false
  }
  return true
}
