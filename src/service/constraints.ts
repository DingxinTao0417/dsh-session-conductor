/**
 * Shared constraints and impact tracking (PRD §二.13.1).
 *
 * A constraint is a standing statement the work must respect — a technical choice, an
 * interface agreement, a prohibition, a file-ownership boundary, an acceptance
 * requirement. Five rules in the specification shape this module, and the last is the
 * one most implementations collapse:
 *
 * 1. **Every change produces a new version**, and a run fixes the version it started
 *    under. An edit therefore cannot reach work in flight, which is what makes rule 3
 *    true rather than aspirational.
 * 2. **The default scope is future runs.** Applying a change to current work is
 *    something the user asks for, not something an edit does quietly.
 * 3. **When it is applied to current work, the impact is computed**, not guessed: which
 *    nodes are affected and which artifacts must be re-accepted. A constraint that
 *    invalidated an accepted artifact must not leave that acceptance standing.
 * 4. **Delivery happens at the next processable boundary**, and the result must not
 *    claim to have changed an in-flight request — the same honesty rule the send modes
 *    carry in PRD §二.6.
 * 5. **Confirmation is not compliance.** "Sent", "entered context", "target
 *    acknowledged" and "verified compliant" are four separate facts, recorded
 *    separately. {@link DELIVERY_STAGES} is that list, and {@link advanceDelivery}
 *    refuses to skip a stage or to treat acknowledgement as compliance.
 *
 * @module dsh-session-conductor/service/constraints
 */

/** What a constraint is about. */
export const CONSTRAINT_KINDS = [
  'technical_choice',
  'interface',
  'prohibition',
  'file_ownership',
  'acceptance_requirement',
] as const
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number]

/** One versioned constraint. */
export interface ConstraintRecord {
  readonly constraintId: string
  readonly kind: ConstraintKind
  /** The statement itself. */
  readonly text: string
  /** Increments on every change; a run fixes the number it started under. */
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** How a change to a constraint is scoped. */
export type ConstraintScope = 'future' | 'current'

/** The four delivery facts, in order. Never collapsed into one another. */
export const DELIVERY_STAGES = ['sent', 'in_context', 'acknowledged', 'verified'] as const
export type DeliveryStage = (typeof DELIVERY_STAGES)[number]

/** Where one target stands in receiving one constraint version. */
export interface ConstraintDelivery {
  readonly constraintId: string
  readonly version: number
  readonly targetId: string
  readonly stage: DeliveryStage
  /** Set once a check has been run, so `verified` is never asserted without one. */
  readonly checkCommand?: string | undefined
  readonly checkOutput?: string | undefined
  readonly updatedAt: string
}

/** One artifact that a constraint change affects. */
export interface AffectedArtifact {
  readonly artifactId: string
  /** Why it is affected. */
  readonly reason: string
  /** True when the artifact's acceptance no longer stands. */
  readonly needsReacceptance: boolean
}

/** The impact of applying a constraint change to work in flight. */
export interface ConstraintImpact {
  readonly constraintId: string
  readonly fromVersion: number
  readonly toVersion: number
  /** Nodes whose work the change touches. */
  readonly affectedNodes: readonly string[]
  readonly affectedArtifacts: readonly AffectedArtifact[]
  /** What the caller must not claim. */
  readonly caveat: string
}

/** Why a change was refused. */
export type ConstraintChangeResult =
  | { readonly ok: true; readonly record: ConstraintRecord; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string }

/**
 * Apply a change to a constraint, producing a new version.
 *
 * An unchanged statement is refused rather than versioned: "every change produces a new
 * version" is a statement about *changes*, and bumping a version for identical text
 * would invalidate runs in flight for nothing.
 *
 * @param existing - the constraint as it stands, or undefined for a new one.
 * @param change - the new kind and text.
 * @param now - the current instant as ISO 8601 UTC.
 * @returns the new record, or the reason the change was refused.
 */
export function planConstraintChange(
  existing: ConstraintRecord | undefined,
  change: { readonly kind: ConstraintKind; readonly text: string },
  now: string,
): ConstraintChangeResult {
  if (change.text.trim().length === 0) {
    return { ok: false, reason: 'a constraint must state something; the text is empty' }
  }
  if (existing === undefined) {
    return {
      ok: true,
      changed: true,
      record: {
        constraintId: `constraint-${now}`,
        kind: change.kind,
        text: change.text,
        version: 0,
        createdAt: now,
        updatedAt: now,
      },
    }
  }
  if (existing.kind === change.kind && existing.text === change.text) {
    return { ok: false, reason: 'the constraint already says exactly this, so no new version was created' }
  }
  return {
    ok: true,
    changed: true,
    record: { ...existing, kind: change.kind, text: change.text, version: existing.version + 1, updatedAt: now },
  }
}

/**
 * Decide what a constraint change means for work already in flight.
 *
 * The default answer is **nothing**: PRD §二.13.1 says a change affects future runs
 * unless the user asks otherwise. When the scope *is* `current`, the impact is computed
 * from the work the caller reports — the affected nodes, and every artifact whose
 * acceptance the new statement invalidates.
 *
 * @param input - the change and the work it might touch.
 * @returns the impact, including the caveat the caller must pass on.
 */
export function planConstraintImpact(input: {
  readonly constraintId: string
  readonly fromVersion: number
  readonly toVersion: number
  readonly scope: ConstraintScope
  /** Nodes that are affected, as identified by the caller's own analysis. */
  readonly affectedNodes?: readonly string[]
  /** Artifacts that the change invalidates, with why. */
  readonly invalidatedArtifacts?: readonly { readonly artifactId: string; readonly reason: string; readonly accepted: boolean }[]
}): ConstraintImpact {
  const future = input.scope === 'future'
  const artifacts = (input.invalidatedArtifacts ?? []).map(artifact => ({
    artifactId: artifact.artifactId,
    reason: artifact.reason,
    // An acceptance that the new statement contradicts cannot stand. One that was never
    // given is already correct and is not marked, so the flag means "must be re-judged"
    // rather than "is unaccepted".
    needsReacceptance: artifact.accepted,
  }))
  return {
    constraintId: input.constraintId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    affectedNodes: future ? [] : [...(input.affectedNodes ?? [])],
    affectedArtifacts: future ? [] : artifacts,
    caveat: future
      ? 'This change applies to future runs only. Work already in flight keeps the version it started under, so '
        + 'nothing in progress was altered.'
      : 'This change applies at the next processable boundary. It does not alter a request that has already been '
        + 'committed, and no in-flight turn is claimed to have changed. Requirements already accepted whose '
        + 'acceptance this contradicts are marked for re-acceptance rather than silently kept.',
  }
}

/**
 * Whether a downstream node may start automatically under a constraint version.
 *
 * PRD §二.13.1 requires this check before automatically starting downstream work. An
 * incompatible version blocks the automatic start rather than proceeding on the older
 * terms — a node built to a superseded interface is exactly what the constraint existed
 * to prevent.
 *
 * @param runVersion - the version the run fixed when it started.
 * @param currentNodeVersion - the version in force now.
 * @returns whether automatic downstream start is allowed, and why.
 */
export function constraintCompatibility(
  runVersion: number,
  currentNodeVersion: number,
): { readonly compatible: boolean; readonly reason: string } {
  if (runVersion === currentNodeVersion) {
    return { compatible: true, reason: `the run and the current constraints agree at version ${String(runVersion)}` }
  }
  if (currentNodeVersion > runVersion) {
    return {
      compatible: false,
      reason: `the constraints have moved from version ${String(runVersion)} to ${String(currentNodeVersion)}; `
        + 'downstream work will not start automatically on the older terms, and the run needs the user to decide '
        + 'whether to adopt the new version or finish under the old one',
    }
  }
  return {
    compatible: false,
    reason: `the run records version ${String(runVersion)} but the current constraints are version `
      + `${String(currentNodeVersion)}, which is older; the run cannot be evaluated against a version that is no `
      + 'longer in force',
  }
}

/** The order of a stage. */
function stageIndex(stage: DeliveryStage): number {
  return DELIVERY_STAGES.indexOf(stage)
}

/**
 * Advance one delivery by one stage.
 *
 * Stages are one-way and may not be skipped: a target cannot "verify compliance" with a
 * constraint it was never sent, and moving straight from `sent` to `verified` would
 * assert a check that never happened. `verified` additionally requires the check that
 * established it, because compliance is a claim about evidence.
 *
 * @param delivery - the delivery as it stands.
 * @param to - the stage to move to.
 * @param evidence - for `verified`: the command and its output.
 * @param now - the current instant as ISO 8601 UTC.
 * @returns the updated delivery, or the reason the move was refused.
 */
export function advanceDelivery(
  delivery: ConstraintDelivery,
  to: DeliveryStage,
  evidence: { readonly command: string; readonly output: string } | undefined,
  now: string,
): { readonly ok: true; readonly delivery: ConstraintDelivery } | { readonly ok: false; readonly reason: string } {
  const from = stageIndex(delivery.stage)
  const target = stageIndex(to)
  if (target === from) {
    return { ok: false, reason: `this target is already at ${to}, so nothing was recorded` }
  }
  if (target < from) {
    return { ok: false, reason: `delivery stages do not go backwards: ${delivery.stage} cannot become ${to}` }
  }
  if (target > from + 1) {
    return {
      ok: false,
      reason: `delivery stages are recorded one at a time: ${delivery.stage} cannot jump to ${to}, because the `
        + `stage in between would be asserted without having happened`,
    }
  }
  if (to === 'verified' && evidence === undefined) {
    return {
      ok: false,
      reason: 'verifying compliance needs the check that established it; without a command and its output this '
        + 'would record an opinion as a verification',
    }
  }
  return {
    ok: true,
    delivery: {
      ...delivery,
      stage: to,
      ...evidence === undefined ? {} : { checkCommand: evidence.command, checkOutput: evidence.output },
      updatedAt: now,
    },
  }
}

/**
 * Describe one delivery honestly, which means not implying more than happened.
 *
 * @param delivery - the delivery to describe.
 * @returns a one-line account.
 */
export function describeDelivery(delivery: ConstraintDelivery): string {
  switch (delivery.stage) {
    case 'sent':
      return `${delivery.targetId} has been sent constraint ${delivery.constraintId} v${String(delivery.version)}; it has not yet entered its context`
    case 'in_context':
      return `${delivery.targetId} has constraint ${delivery.constraintId} v${String(delivery.version)} in context; whether it will be followed is not yet known`
    case 'acknowledged':
      return `${delivery.targetId} acknowledged constraint ${delivery.constraintId} v${String(delivery.version)}. `
        + 'Acknowledgement is not compliance'
    case 'verified':
      return `${delivery.targetId} was verified compliant with constraint ${delivery.constraintId} `
        + `v${String(delivery.version)} by \`${delivery.checkCommand ?? '(no command recorded)'}\``
  }
}
