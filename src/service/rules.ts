/**
 * One-time rules and their executor (PRD §二.8.2).
 *
 * The specification's one-time rule is a saved authorisation — "when A's design
 * passes, hand it to B and have B start" — and it comes with four rules that
 * shape everything here:
 *
 * - it is executed by an **independent executor**, never by a report model
 *   deciding for itself what to do next;
 * - ordinary task output cannot create one, so nothing in this module can be
 *   reached from a target's own text;
 * - a repeated event corresponds to **one logical dispatch**, which is what
 *   {@link planFire} enforces by keying the dispatch on the rule and the source
 *   event together;
 * - the action is exactly what was saved. There is no free-form action field, so
 *   an executor cannot improvise something the user did not authorise.
 *
 * The executor is pure with respect to its decision: it reads a rule and an
 * event and returns whether to fire and why. The caller performs the dispatch,
 * using the returned operation id so that the existing idempotency layer is what
 * actually guarantees a single dispatch across a crash.
 *
 * @module dsh-session-conductor/service/rules
 */

import type { NotableEvent, ProjectionState } from './projection.ts'
import type { ArtifactRecord, RuleRecord } from '../store/schema.ts'
import { acceptanceCounts } from './artifacts.ts'

/** The kinds of observation that can trigger a rule. */
export type RuleTrigger = RuleRecord['trigger']

/** What the executor decides about one event. */
export type FireDecision =
  | { readonly fire: true; readonly operationId: string; readonly sourceEventId: string; readonly reason: string }
  | { readonly fire: false; readonly reason: string }

/**
 * The identity of one potential dispatch.
 *
 * A repeated event and a replayed log both produce the same id, so the operation
 * layer treats the second attempt as a replay rather than a second dispatch. That
 * is the whole mechanism behind "a repeated event corresponds to one dispatch" —
 * there is no separate deduplication table to drift out of sync with it.
 *
 * @param ruleId - the rule's identity.
 * @param sourceEventId - the identity of the event that triggered it.
 * @returns the stable operation id for that pairing.
 */
export function fireOperationId(ruleId: string, sourceEventId: string): string {
  return `rule-${ruleId}-${sourceEventId}`
}

/**
 * Map an observed event onto the trigger vocabulary.
 *
 * @param event - a notable projection event.
 * @param sourceEventId - the identity of the event.
 * @returns the trigger, or undefined when the event is not a trigger at all.
 */
export function triggerOf(event: NotableEvent, sourceEventId: string): { trigger: RuleTrigger; eventId: string } | undefined {
  if (event.kind === 'turn_ended') {
    if (event.outcome !== 'completed' && event.outcome !== 'failed') return undefined
    return {
      trigger: event.outcome === 'completed' ? 'turn_completed' : 'turn_failed',
      eventId: `turn-${String(event.turn)}-${event.detail}-${sourceEventId}`,
    }
  }
  if (event.kind === 'artifact_accepted') {
    // The identity includes the caller's event id, which for an acceptance carries the instant and
    // the artifact's content version: accepting the same artifact again after a change is a **new**
    // fact and may fire the rule again, while a replayed acceptance keeps its identity and is
    // deduplicated by the firing record exactly as a repeated turn is.
    return { trigger: 'artifact_accepted', eventId: `artifact-${event.artifactId}-${sourceEventId}` }
  }
  return undefined
}

/**
 * Decide whether one rule should fire for one observation.
 *
 * Every refusal names its condition, because a rule that silently does nothing is
 * indistinguishable from one that was never saved.
 *
 * @param rule - the saved rule, read at a single version.
 * @param trigger - the trigger the event produced.
 * @param eventId - the identity of the event.
 * @param artifact - the artifact the rule requires, when it requires one.
 * @param now - the current time as ISO 8601 UTC.
 * @returns the decision.
 */
export function planFire(
  rule: RuleRecord,
  trigger: RuleTrigger,
  eventId: string,
  artifact: ArtifactRecord | undefined,
  now: string,
): FireDecision {
  if (!rule.active) return { fire: false, reason: `rule ${rule.ruleId} is not active` }
  if (rule.expiresAt !== undefined) {
    const expiry = Date.parse(rule.expiresAt)
    const instant = Date.parse(now)
    if (!Number.isFinite(expiry) || !Number.isFinite(instant)) {
      return { fire: false, reason: `rule ${rule.ruleId} has an unreadable expiry or evaluation instant; its validity cannot be confirmed` }
    }
    if (instant >= expiry) return { fire: false, reason: `rule ${rule.ruleId} expired at ${rule.expiresAt}` }
  }
  if (rule.trigger !== trigger) {
    return { fire: false, reason: `rule ${rule.ruleId} listens for ${rule.trigger}, not ${trigger}` }
  }
  if (rule.firings.some(firing => firing.sourceEventId === eventId)) {
    // The deduplication rule, checked before the execution count so that a
    // repeated event is reported as a repeat rather than as an exhausted rule.
    // This exact event has already produced its one dispatch, so a replay, an
    // overlapping watcher or a second read of the same window does not produce
    // another.
    return { fire: false, reason: `rule ${rule.ruleId} already fired for event ${eventId}` }
  }
  if (rule.firings.length >= rule.maxExecutions) {
    return {
      fire: false,
      reason: `rule ${rule.ruleId} has already fired ${String(rule.firings.length)} time(s), its maximum`,
    }
  }
  if (rule.requiredArtifactId !== undefined) {
    if (artifact === undefined) {
      return { fire: false, reason: `rule ${rule.ruleId} requires artifact ${rule.requiredArtifactId}, which is not recorded` }
    }
    // The input requirement is an acceptance gate, not a presence check: the specification's example
    // is "after the interface document PASSES". And the acceptance has to be one that **counts** —
    // a model review is a judgement and an unattributed acceptance says nothing, neither of which
    // may open an automatic dispatch (PRD §二.9.1, §二.12).
    const counted = acceptanceCounts(artifact)
    if (!counted.counts) {
      return {
        fire: false,
        reason: `rule ${rule.ruleId} requires artifact ${artifact.artifactId} to be accepted, and ${counted.reason}`,
      }
    }
  }
  return {
    fire: true,
    operationId: fireOperationId(rule.ruleId, eventId),
    sourceEventId: eventId,
    reason: `rule ${rule.ruleId} fired for ${trigger} (${eventId})`,
  }
}

/** The observation one evaluation pass works from. */
export interface EvaluationInput {
  /** Events observed since the last pass, with their stable identities. */
  readonly events: readonly { readonly event: NotableEvent; readonly eventId: string }[]
  /** Look up an artifact the rule requires. */
  readonly artifact: (artifactId: string) => ArtifactRecord | undefined
  readonly now: string
}

/** One dispatch the executor says should happen. */
export interface PlannedDispatch {
  readonly rule: RuleRecord
  readonly operationId: string
  readonly sourceEventId: string
  readonly reason: string
}

/** A refusal worth reporting, so a quiet rule is not mistaken for an absent one. */
export interface PlannedRefusal {
  readonly ruleId: string
  readonly reason: string
}

/** What one evaluation pass produced. */
export interface EvaluationResult {
  readonly dispatches: PlannedDispatch[]
  readonly refusals: PlannedRefusal[]
}

/**
 * Evaluate every active rule against one batch of observations.
 *
 * A single pass may produce at most one dispatch **per rule**, even when several
 * events would trigger it: the rule's own maximum-execution and deduplication
 * checks run against a working copy whose firings accumulate as the pass
 * proceeds. Without that, two events in one batch would both pass the check and
 * the rule would exceed its stated limit.
 *
 * @param rules - the rules to evaluate.
 * @param input - the observed events, artifact lookup and clock.
 * @returns the dispatches to perform and the refusals worth reporting.
 */
export function evaluateRules(rules: readonly RuleRecord[], input: EvaluationInput): EvaluationResult {
  const dispatches: PlannedDispatch[] = []
  const refusals: PlannedRefusal[] = []
  const working = new Map(rules.map(rule => [rule.ruleId, { ...rule, firings: [...rule.firings] }]))

  for (const { event, eventId } of input.events) {
    const mapped = triggerOf(event, eventId)
    if (mapped === undefined) continue
    for (const rule of rules) {
      const candidate = working.get(rule.ruleId)
      if (candidate === undefined) continue
      const decision = planFire(
        candidate,
        mapped.trigger,
        mapped.eventId,
        candidate.requiredArtifactId === undefined ? undefined : input.artifact(candidate.requiredArtifactId),
        input.now,
      )
      if (!decision.fire) {
        // Only refusals that say something new are reported; a rule that is
        // simply inactive is not worth a line per event.
        if (!/is not active|listens for/.test(decision.reason)) {
          refusals.push({ ruleId: rule.ruleId, reason: decision.reason })
        }
        continue
      }
      // Record the firing against the working copy so a second event in the same
      // pass cannot also fire this rule.
      candidate.firings = [...candidate.firings, {
        sourceEventId: decision.sourceEventId,
        operationId: decision.operationId,
        at: input.now,
        outcome: 'planned',
      }]
      dispatches.push({
        rule,
        operationId: decision.operationId,
        sourceEventId: decision.sourceEventId,
        reason: decision.reason,
      })
    }
  }

  return { dispatches, refusals }
}

/**
 * Whether an artifact satisfies a rule's input requirement.
 *
 * Exported so the acceptance gate has one implementation: the specification
 * distinguishes "the artifact exists" from "the artifact passed", and a rule that
 * requires the latter must not fire on the former.
 *
 * @param artifact - the artifact, when one is recorded.
 * @returns whether it satisfies the requirement.
 */
export function satisfiesRequirement(artifact: ArtifactRecord | undefined): boolean {
  return artifact !== undefined && acceptanceCounts(artifact).counts
}

/**
 * The control edges a set of rules describes.
 *
 * One rule is one directed edge: an event on its **source** causes work on its **target**, so following the
 * edges forward is following "what this work causes". AGENTS.md §6 and PRD §三.6 require that relation to be
 * **acyclic** — 控制关系无环，防止跨控制者相互唤醒 — because two rules pointing at each other's sources are
 * two controllers waking each other for as long as they have firings left.
 */
export interface ControlEdge {
  readonly ruleId: string
  readonly sourceTaskId: string
  readonly targetTaskId: string
}

/**
 * Why an edge would close a cycle among the rules that already exist, or undefined when it is safe.
 *
 * Checked **before** the rule is saved, not when it fires: a loop is an authorisation problem, and refusing
 * the authorisation is the only place where the whole picture is available. The mistake it prevents is
 * specific and reachable — a rule from A to B and a rule from B back to A with more than one execution each
 * will hand work back and forth until their counts run out, spending real model work on both tasks to make no
 * progress. (`maxExecutions` defaults to 1, which is what keeps the *default* case safe; the guard is for the
 * case where someone raises it.)
 *
 * A rule that names the **same** task as source and target is refused too: that is a one-node cycle, and it
 * means "when this task's turn ends, instruct it again", which is precisely a loop that never needs a second
 * rule to close.
 *
 * @param existing - the stored rules that are still active.
 * @param candidate - the rule about to be saved.
 * @returns the refusal reason, or undefined when the edge introduces no cycle.
 */
export function controlCycleRefusal(
  existing: readonly ControlEdge[],
  candidate: ControlEdge,
): string | undefined {
  if (candidate.sourceTaskId === candidate.targetTaskId) {
    return `rule ${candidate.ruleId} would instruct ${candidate.targetTaskId} from its own events: a rule whose `
      + 'source and target are the same task tells that task to carry on every time it stops. It was refused '
      + 'rather than saved, because the loop is an authorisation rather than an accident (PRD §三.6).'
  }
  // Walk forward from the candidate's target: if that path reaches the candidate's source, the new edge
  // closes a loop. Breadth-first over the stored edges, visited-set bounded so a cycle that already exists
  // cannot make this hang.
  const outgoing = new Map<string, string[]>()
  for (const edge of existing) {
    if (edge.ruleId === candidate.ruleId) continue
    const list = outgoing.get(edge.sourceTaskId)
    if (list === undefined) outgoing.set(edge.sourceTaskId, [edge.targetTaskId])
    else list.push(edge.targetTaskId)
  }
  const seen = new Set<string>([candidate.targetTaskId])
  const queue = [candidate.targetTaskId]
  const path = new Map<string, string>([[candidate.targetTaskId, candidate.targetTaskId]])
  while (queue.length > 0) {
    const at = queue.shift() as string
    if (at === candidate.sourceTaskId) {
      // Reconstruct the chain so the refusal names the tasks a reader has to look at, not just the id.
      const chain: string[] = []
      let cursor: string | undefined = at
      while (cursor !== undefined && chain.length < 32) {
        chain.push(cursor)
        cursor = path.get(cursor) === cursor ? undefined : path.get(cursor)
      }
      return `rule ${candidate.ruleId} would close a control cycle: ${candidate.sourceTaskId} → `
        + `${candidate.targetTaskId}${chain.length > 1 ? ` → ${[...chain].reverse().slice(1).join(' → ')}` : ''}. `
        + 'Rules that instruct each other\'s sources wake each other for as long as they have firings left, so '
        + 'this one was refused (PRD §三.6, AGENTS.md §6).'
    }
    for (const next of outgoing.get(at) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      path.set(next, at)
      queue.push(next)
    }
  }
  return undefined
}

/** Whether a disabled rule may be turned back on. */
export type EnableDecision =
  | { readonly enable: true; readonly already: boolean; readonly reason: string }
  | { readonly enable: false; readonly reason: string }

/**
 * Decide whether a saved rule may be enabled.
 *
 * PRD §三.3 names 启用 as its own action, distinct from save: save mints the
 * authorisation, disable pauses it, enable resumes the **same** grant. Firings,
 * the instruction and the expiry are not rewritten. A rule that is already
 * active is reported as such rather than version-bumped. Enabling is checked
 * against the currently active control graph, because a disabled edge was not
 * in that graph and turning it on can close a cycle the save-time check never
 * saw (the other half of the loop may have been saved later).
 *
 * @param rule - the stored rule.
 * @param active - the other currently active rules, as control edges.
 * @returns whether to enable, and why.
 */
export function planEnable(
  rule: RuleRecord,
  active: readonly ControlEdge[],
): EnableDecision {
  if (rule.active) {
    return {
      enable: true,
      already: true,
      reason: `rule ${rule.ruleId} is already enabled`,
    }
  }
  const cycle = controlCycleRefusal(active, {
    ruleId: rule.ruleId,
    sourceTaskId: rule.sourceTaskId,
    targetTaskId: rule.targetTaskId,
  })
  if (cycle !== undefined) {
    return { enable: false, reason: cycle }
  }
  return {
    enable: true,
    already: false,
    reason: `rule ${rule.ruleId} is enabled; it may fire again under the same grant, `
      + `and its ${String(rule.firings.length)}/${String(rule.maxExecutions)} firing(s) are unchanged`,
  }
}

/**
 * Apply an executor result's firing record to a rule.
 *
 * @param rule - the stored rule.
 * @param dispatch - the dispatch that was performed.
 * @param outcome - what the dispatch produced.
 * @param now - the current time as ISO 8601 UTC.
 * @returns the next rule record.
 */
export function recordFiring(
  rule: RuleRecord,
  dispatch: PlannedDispatch,
  outcome: string,
  now: string,
): RuleRecord {
  return {
    ...rule,
    firings: [...rule.firings, {
      sourceEventId: dispatch.sourceEventId,
      operationId: dispatch.operationId,
      at: now,
      outcome,
      // Recorded per firing: the rule's own grant changes if it is re-saved, so reading it back
      // later would attribute this dispatch to an authorisation that did not issue it.
      ...rule.grantId === undefined ? {} : { grantId: rule.grantId },
    }],
    updatedAt: now,
  }
}

/**
 * The projection a rule watches, for callers that need to feed events in.
 * @param state - a task's projection.
 * @returns nothing; the type exists so the trigger vocabulary stays tied to it.
 */
export function watchedDimensions(state: ProjectionState): string[] {
  return [state.execution, state.interaction, state.lastTurn ?? 'none']
}
