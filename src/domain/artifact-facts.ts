/**
 * The four artifact facts PRD §二.9.1 requires a reader to see separately.
 *
 * The record keeps `existence` and `acceptance` as axes. This module is the
 * *display* projection of those axes, so a list, a compact snapshot or a panel
 * card cannot collapse "the model claimed it" into "a check passed" or treat a
 * model review as user acceptance (AGENTS.md §7).
 *
 * Pure data plus pure functions, importing nothing: the Host half, the client
 * half and the inspect sentence all have to agree on the same four labels.
 *
 * @module dsh-session-conductor/domain/artifact-facts
 */

/** The axes a display projection reads. */
export interface ArtifactFactAxes {
  readonly existence: string
  readonly acceptance: string
  readonly acceptedBy?: string | undefined
}

/**
 * Whether each of the four facts holds.
 *
 * `claimed` is always true for a registered artifact: registration *is* the
 * model's claim. The other three are independent of it and of each other.
 */
export interface ArtifactDisplayFacts {
  readonly claimed: boolean
  readonly verifiedPresent: boolean
  readonly checkPassed: boolean
  readonly userAccepted: boolean
}

/**
 * Project the four facts from the stored axes.
 *
 * @param record - existence, acceptance and who recorded the acceptance.
 * @returns which of the four facts hold.
 */
export function artifactDisplayFacts(record: ArtifactFactAxes): ArtifactDisplayFacts {
  return {
    claimed: true,
    verifiedPresent: record.existence === 'present',
    checkPassed: record.acceptance === 'pass' && record.acceptedBy === 'deterministic_check',
    userAccepted: record.acceptance === 'pass' && record.acceptedBy === 'user',
  }
}

/**
 * Name the facts that hold, in the specification's own vocabulary.
 *
 * Facts that do not hold are omitted rather than listed as "not X", except a
 * model review, which must be named so it cannot be read as acceptance, and a
 * missing or changed verification, which must be named so it cannot be read as
 * present.
 *
 * @param record - the stored axes.
 * @returns a display line such as `模型声称生成 · 已验证存在 · 检查通过`.
 */
export function describeArtifactFacts(record: ArtifactFactAxes): string {
  const facts = artifactDisplayFacts(record)
  const parts: string[] = ['模型声称生成']
  if (facts.verifiedPresent) parts.push('已验证存在')
  else if (record.existence === 'missing') parts.push('verified missing')
  else if (record.existence === 'changed') parts.push('verified changed')
  if (facts.checkPassed) parts.push('检查通过')
  else if (record.acceptedBy === 'deterministic_check') {
    parts.push(`确定性检查 ${record.acceptance}`)
  }
  if (facts.userAccepted) parts.push('用户验收')
  else if (record.acceptedBy === 'user') {
    parts.push(`用户验收 ${record.acceptance}`)
  }
  if (record.acceptedBy === 'model_review') {
    parts.push('模型审阅（不是验收）')
  }
  return parts.join(' · ')
}

/** Counts of the four facts across a set of artifacts. */
export interface ArtifactFactCounts {
  readonly total: number
  readonly present: number
  readonly checkPassed: number
  readonly userAccepted: number
  readonly changed: number
}

/**
 * Count the four facts. A `pass` by a model review is in `total` only.
 *
 * @param records - the artifacts to summarise.
 * @returns the counts a compact snapshot or inspect sentence uses.
 */
export function countArtifactDisplayFacts(
  records: readonly ArtifactFactAxes[],
): ArtifactFactCounts {
  let present = 0
  let checkPassed = 0
  let userAccepted = 0
  let changed = 0
  for (const record of records) {
    const facts = artifactDisplayFacts(record)
    if (facts.verifiedPresent) present += 1
    if (facts.checkPassed) checkPassed += 1
    if (facts.userAccepted) userAccepted += 1
    if (record.existence === 'changed') changed += 1
  }
  return { total: records.length, present, checkPassed, userAccepted, changed }
}

/**
 * One-line summary of the four facts for a compact snapshot or inspect.
 *
 * "accepted" is not a count here: that word is how a model review used to be
 * smuggled in as user acceptance. The two counting acceptances are named.
 *
 * @param counts - {@link countArtifactDisplayFacts}.
 * @returns the summary.
 */
export function describeArtifactFactSummary(counts: ArtifactFactCounts): string {
  return `${String(counts.total)} artifact(s), ${String(counts.present)} verified present`
    + `${counts.changed === 0 ? '' : `, ${String(counts.changed)} changed`}`
    + `, ${String(counts.checkPassed)} 检查通过 and ${String(counts.userAccepted)} 用户验收`
}
