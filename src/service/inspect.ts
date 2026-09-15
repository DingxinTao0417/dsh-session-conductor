/**
 * Read-only inspection observations (PRD §二.11).
 *
 * A scheduled inspect checks 状态、成果或已定义条件. The observation is drawn
 * from durable conductor facts — the task record, artifact records, and the
 * shared constraints that apply to that target — never from a claim about a
 * live session.
 *
 * @module dsh-session-conductor/service/inspect
 */

import {
  countArtifactDisplayFacts,
  describeArtifactFactSummary,
} from '../domain/artifact-facts.ts'

/** One artifact fact an inspection can see. */
export interface InspectArtifactFact {
  readonly acceptance?: string | undefined
  readonly existence?: string | undefined
  readonly acceptedBy?: string | undefined
}

/** One defined condition (a shared constraint) an inspection can see. */
export interface InspectConstraintFact {
  readonly constraintId: string
  readonly kind: string
  readonly version: number
}

/** Where one constraint version stands for the inspected target. */
export interface InspectDeliveryFact {
  readonly constraintId: string
  readonly version: number
  readonly stage: string
}

/** Inputs for one inspection observation. */
export interface InspectObservationInput {
  readonly taskId?: string | undefined
  readonly task?: {
    readonly taskId: string
    readonly preparation: string
    readonly preparationPhase: string
  } | undefined
  readonly sessionId?: string | undefined
  readonly artifacts?: readonly InspectArtifactFact[] | undefined
  readonly constraints?: readonly InspectConstraintFact[] | undefined
  readonly deliveries?: readonly InspectDeliveryFact[] | undefined
}

/**
 * Render the defined-condition half of an inspection.
 *
 * Each saved constraint is a condition. A target that has not received the
 * current version is `unset`, which is different from `sent` and from
 * `verified` — acknowledgement is not compliance, and the observation keeps
 * the delivery stage the store recorded.
 *
 * @param constraints - every currently defined constraint.
 * @param deliveries - deliveries of those constraints to this target.
 * @returns a stable one-line account.
 */
export function describeDefinedConditions(
  constraints: readonly InspectConstraintFact[],
  deliveries: readonly InspectDeliveryFact[],
): string {
  if (constraints.length === 0) return '0 defined condition(s)'
  const ordered = [...constraints].sort((left, right) =>
    left.constraintId < right.constraintId ? -1 : left.constraintId > right.constraintId ? 1 : 0)
  const parts = ordered.map(constraint => {
    const delivery = deliveries.find(entry =>
      entry.constraintId === constraint.constraintId && entry.version === constraint.version)
    const stage = delivery?.stage ?? 'unset'
    return `${constraint.constraintId}@${String(constraint.version)} ${constraint.kind} ${stage}`
  })
  return `${String(constraints.length)} defined condition(s): ${parts.join(', ')}`
}

/**
 * One-line observation a read-only inspect records and later compares.
 *
 * The sentence is stable for the same facts so an unchanged inspection stays
 * silent, and it names each half so a change in state, artifacts or defined
 * conditions is distinguishable.
 *
 * @param input - durable facts about the target.
 * @returns the observation line.
 */
export function inspectObservationOf(input: InspectObservationInput): string {
  if (input.taskId === undefined) {
    return 'no target task is set, so there is no task state or artifact to inspect'
  }
  const task = input.task
  if (task === undefined) {
    return `the target task ${input.taskId} is not one the conductor manages`
  }
  const artifacts = input.artifacts ?? []
  const summary = describeArtifactFactSummary(countArtifactDisplayFacts(
    artifacts.map(artifact => ({
      existence: artifact.existence ?? 'claimed',
      acceptance: artifact.acceptance ?? 'pending',
      ...artifact.acceptedBy === undefined ? {} : { acceptedBy: artifact.acceptedBy },
    })),
  ))
  const constraints = input.constraints ?? []
  const deliveries = input.deliveries ?? []
  return `task ${task.taskId} is ${task.preparation}/${task.preparationPhase}`
    + `${input.sessionId === undefined ? ' with no live binding' : ` on session ${input.sessionId}`}; `
    + `${summary}; `
    + describeDefinedConditions(constraints, deliveries)
}
