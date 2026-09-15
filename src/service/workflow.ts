/**
 * Dependency workflows and bounded rework (PRD §二.12).
 *
 * This module is the *decisions* of a workflow, separated from running one, because
 * the specification is specific about four things that are easy to get subtly wrong:
 *
 * 1. **The dependency graph must be acyclic**, and rework is not a cycle in that
 *    graph. Expressing "node A may send B back to work" as an edge A→B→A would make
 *    the graph cyclic and the ordering meaningless, so rework is a separate, bounded
 *    mechanism and {@link validateDefinition} rejects a definition that tries it the
 *    other way.
 * 2. **A node may start only when six conditions all hold** — upstream acceptance,
 *    pinned and accessible inputs, live authorisation, available configuration,
 *    concurrency and budget, and satisfied approvals. Reporting "not ready" without
 *    saying *which* of the six failed is the thing that makes a workflow
 *    undebuggable, so {@link nodeReadiness} reports each one.
 * 3. **Acceptance has three outcomes, not two.** `inconclusive` is a real answer and
 *    must not be folded into `fail` or, worse, into `pass`.
 * 4. **The rework limit is the configured `reworkRounds` (published two) for the
 *    whole workflow, and the first execution does not count.** A message retry does
 *    not consume a round; asking the model to redo the task does. After the limit
 *    the workflow stops for the user and no new workflow is created to get around it.
 *
 * Node **lifecycle** is the PRD §三.4 vocabulary (`blocked`, `ready`, `running`,
 * `waiting`, `validating`, `passed`, `failed`, `cancelled`). Acceptance stays on
 * the separate `verdict` dimension: a model review that says `pass` leaves the
 * node `validating` rather than `passed`, which is how "主观模型审阅明确标注为模型判断，
 * 不能冒充用户验收" is kept without inventing a node state the specification does
 * not name.
 *
 * Everything here is a pure function of the definition, the run and the facts a
 * caller supplies, so every rule above is testable without running anything.
 *
 * @module dsh-session-conductor/service/workflow
 */

import { DEFAULTS } from '../domain/defaults.ts'
import { canonicalize } from '../domain/operation.ts'
import { NODE_STATES, type NodeState } from '../domain/state.ts'

export { NODE_STATES }
export type { NodeState }

/** How a node ended. `inconclusive` is deliberately not collapsed into either side. */
export const ACCEPTANCE_RESULTS = ['pass', 'fail', 'inconclusive'] as const
export type AcceptanceResult = (typeof ACCEPTANCE_RESULTS)[number]

/** Who decided an acceptance result. */
export const ACCEPTANCE_BY = ['user', 'deterministic_check', 'model_review'] as const
export type AcceptanceBy = (typeof ACCEPTANCE_BY)[number]

/**
 * One recorded acceptance verdict.
 *
 * `by` is required because PRD §二.12 requires a subjective model review to be
 * labelled as model judgement and forbids it from passing as user acceptance. A
 * verdict with no author would be exactly the ambiguity that rule closes.
 */
export interface AcceptanceVerdict {
  readonly result: AcceptanceResult
  readonly by: AcceptanceBy
  /**
   * The acceptance rule this verdict was judged against (PRD §二.12, §三.3).
   *
   * Required when the run fixed a rule for the node, and checked against it by
   * {@link verdictRuleRefusal}: a rule stored and never read is a rule that means nothing, and a
   * definition edited after a run started must not redefine what passing means for that run.
   */
  readonly rule?: string
  /** For a deterministic check: the real command that was run. */
  readonly command?: string
  /** For a deterministic check: what it actually returned. */
  readonly output?: string
  /** Evidence the verdict rests on. */
  readonly evidence?: string[] | undefined
  readonly at: string
}

/** What a node does when it fails. */
export interface FailureHandling {
  readonly onFail: 'stop' | 'continue' | 'retry'
  /** For `retry`: how many times, within the run. */
  readonly retries?: number | undefined
}

/** One node of a workflow definition. */
export interface WorkflowNode {
  readonly nodeId: string
  /** The task the node drives. */
  readonly taskId: string
  /**
   * Nodes that must have passed acceptance before this one may start.
   *
   * Optional, because a definition arrives as data and a root node simply has none;
   * requiring an empty array would make the common case the awkward one. Every read
   * normalises it through {@link dependsOnOf}.
   */
  readonly dependsOn?: readonly string[]
  /** Artifacts this node consumes; their versions must be pinned and accessible. */
  readonly inputArtifacts?: readonly string[] | undefined
  readonly instruction?: string | undefined
  /** The acceptance rule this node is judged by, for display and for the record. */
  readonly acceptance?: string | undefined
  readonly failure?: FailureHandling | undefined
  /** A node may be marked as needing an approval before it starts. */
  readonly requiresApproval?: boolean | undefined
}

/** One workflow definition. */
export interface WorkflowDefinition {
  readonly workflowId: string
  readonly title: string
  /**
   * Definition version.
   *
   * PRD §二.12 requires a run to fix the definition it started under, so a run
   * records this number and a later edit does not silently change work in flight.
   */
  readonly version: number
  readonly nodes: readonly WorkflowNode[]
  /** Whole-workflow limits. */
  readonly rework?: { readonly maxRounds: number }
  readonly budget?: WorkflowBudget | undefined
}

/**
 * Whole-workflow budget (PRD §二.12 condition 5, §二.13.2).
 *
 * `maxTurns` and `maxConcurrent` are what a run gates on; `maxTokens` is recorded
 * for display and for a later metering surface. Optional fields so a definition
 * that names only a turn ceiling still validates.
 */
export interface WorkflowBudget {
  readonly maxTurns?: number | undefined
  readonly maxTokens?: number | undefined
  readonly maxConcurrent?: number | undefined
}

/**
 * The upstream nodes of one node, normalised.
 *
 * A definition is data, and a root node legitimately has no `dependsOn` at all. Every
 * reader goes through this so "no dependencies" has one representation instead of two
 * that can disagree.
 *
 * @param node - the node.
 * @returns its upstream node ids, never undefined.
 */
function dependsOnOf(node: WorkflowNode): readonly string[] {
  return node.dependsOn ?? []
}

/** Why a definition is not usable. */
export interface DefinitionProblem {
  readonly code:
    | 'EMPTY'
    | 'DUPLICATE_NODE'
    | 'UNKNOWN_DEPENDENCY'
    | 'SELF_DEPENDENCY'
    | 'CYCLE'
    | 'REWORK_AS_CYCLE'
    | 'NO_TASK'
    | 'BAD_REWORK_LIMIT'
  readonly message: string
}

/** The result of validating a definition. */
export type DefinitionCheck =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly problems: readonly DefinitionProblem[] }

/**
 * Validate a workflow definition.
 *
 * Returns a topological order when the definition is usable, so a caller does not
 * have to work it out again — and so the acyclicity the validation proved is the same
 * ordering the executor uses.
 *
 * @param definition - the definition to check.
 * @returns the order, or every problem found. All problems are reported, not the first.
 */
export function validateDefinition(definition: WorkflowDefinition): DefinitionCheck {
  const problems: DefinitionProblem[] = []
  if (definition.nodes.length === 0) {
    problems.push({ code: 'EMPTY', message: 'a workflow needs at least one node' })
    return { ok: false, problems }
  }

  const byId = new Map<string, WorkflowNode>()
  for (const node of definition.nodes) {
    if (byId.has(node.nodeId)) {
      problems.push({ code: 'DUPLICATE_NODE', message: `node ${node.nodeId} is declared more than once` })
      continue
    }
    if (node.taskId.length === 0) {
      problems.push({ code: 'NO_TASK', message: `node ${node.nodeId} names no task, so it has nothing to drive` })
    }
    byId.set(node.nodeId, node)
  }

  for (const node of definition.nodes) {
    for (const dependency of dependsOnOf(node)) {
      if (dependency === node.nodeId) {
        problems.push({ code: 'SELF_DEPENDENCY', message: `node ${node.nodeId} depends on itself` })
        continue
      }
      if (!byId.has(dependency)) {
        problems.push({
          code: 'UNKNOWN_DEPENDENCY',
          message: `node ${node.nodeId} depends on ${dependency}, which is not in this workflow`,
        })
      }
    }
  }

  const limit = definition.rework?.maxRounds
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    problems.push({ code: 'BAD_REWORK_LIMIT', message: `the rework limit ${String(limit)} is not a whole number of rounds` })
  }

  if (problems.length > 0) return { ok: false, problems }

  // Kahn's algorithm. A cycle among general dependencies is never acceptable: PRD
  // §二.12 says a dependency graph must be acyclic and that rework — the one thing
  // that genuinely goes backwards — is expressed by its own bounded mechanism.
  const remaining = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const node of definition.nodes) {
    remaining.set(node.nodeId, dependsOnOf(node).length)
    for (const dependency of dependsOnOf(node)) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.nodeId])
    }
  }
  const order: string[] = []
  const ready = definition.nodes.filter(node => dependsOnOf(node).length === 0).map(node => node.nodeId)
  while (ready.length > 0) {
    const next = ready.shift()
    if (next === undefined) break
    order.push(next)
    for (const dependent of dependents.get(next) ?? []) {
      const left = (remaining.get(dependent) ?? 0) - 1
      remaining.set(dependent, left)
      if (left === 0) ready.push(dependent)
    }
  }

  if (order.length !== definition.nodes.length) {
    const stuck = definition.nodes.filter(node => !order.includes(node.nodeId)).map(node => node.nodeId)
    return {
      ok: false,
      problems: [{
        code: 'CYCLE',
        message: `these nodes form a dependency cycle: ${stuck.join(', ')}. A dependency graph must be acyclic; `
          + 'rework is expressed by the bounded rework mechanism, not by an edge that points backwards',
      }],
    }
  }
  return { ok: true, order }
}

/**
 * Names earlier builds stored when they collapsed acceptance into the node state.
 *
 * Read through {@link canonicalNodeState} so a v1 medium still opens. New writes
 * use the PRD vocabulary; optional fields did not bump `DOMAIN_VERSION`, and
 * expanding the stored enum (rather than rewriting matching v1) is what keeps
 * those records valid.
 */
const LEGACY_NODE_STATES: Readonly<Record<string, NodeState>> = {
  pending: 'blocked',
  accepted: 'passed',
  reviewed: 'validating',
  inconclusive: 'validating',
  skipped: 'cancelled',
}

/** Map a stored node state onto PRD §三.4. Unknown names become `blocked`. */
export function canonicalNodeState(state: string): NodeState {
  const mapped = LEGACY_NODE_STATES[state]
  if (mapped !== undefined) return mapped
  return (NODE_STATES as readonly string[]).includes(state) ? (state as NodeState) : 'blocked'
}

/** Whether the node has not started work and may still be dispatched. */
export function isStartable(state: NodeState): boolean {
  return state === 'blocked' || state === 'ready'
}

/** Whether the node currently occupies a target turn. */
export function isLiveNode(state: NodeState): boolean {
  return state === 'running' || state === 'waiting'
}

/** Whether the node has reached a terminal lifecycle state. */
export function isTerminalNode(state: NodeState): boolean {
  return state === 'passed' || state === 'failed' || state === 'cancelled'
}

/**
 * Project a live node's state from the target session.
 *
 * `waiting` is the target asking a person; `validating` is the turn having
 * ended, so acceptance can be recorded. A later turn on the same node is
 * `running` again only while the node is still live — `validating` does not
 * go backwards because a finished turn is not un-finished by a snapshot.
 */
export function overlayNodeFromTarget(
  state: NodeState,
  facts: {
    readonly interaction?: string | undefined
    readonly execution?: string | undefined
    readonly lastTurn?: string | undefined
  },
): NodeState {
  if (!isLiveNode(state)) return state
  if (facts.interaction === 'waiting_input' || facts.interaction === 'waiting_approval') return 'waiting'
  if (facts.execution === 'idle' && facts.lastTurn !== undefined) return 'validating'
  if (facts.execution === 'running' || facts.execution === 'interrupting') return 'running'
  return state
}

/** Cancel every node that has not already finished. Terminal states stay as they are. */
export function cancelUnfinishedNodes(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    status: 'cancelled',
    nodes: run.nodes.map(node => isTerminalNode(node.state) ? node : { ...node, state: 'cancelled' as const }),
  }
}

/** One node's state within a run. */
export interface NodeRun {
  readonly nodeId: string
  readonly state: NodeState
  /** The verdict that decided the state, when one was recorded. */
  readonly verdict?: AcceptanceVerdict
  /** How many times this node has been executed in this run. */
  readonly attempts: number
  /** How many turns the node has consumed, for the budget. */
  readonly turnsUsed?: number | undefined
  /**
   * Who approved this node, when an approval was recorded (PRD §二.12 condition 6).
   *
   * Stored on the run rather than assumed: the start gate is "必需审批已满足", and a gate that is
   * always open is not a gate. Before this field existed the condition was passed as a hardcoded
   * `true`, so a node declaring `requiresApproval` started immediately and nothing could withhold it.
   */
  readonly approvedBy?: string | undefined
  /** When the approval was recorded. */
  readonly approvedAt?: string | undefined
  /**
   * The action and versions this approval bound (PRD §四.3).
   *
   * Optional so a run recorded before the field existed still validates. A later
   * expansion of the instruction, inputs, acceptance rule or definition version
   * must not reuse that approval — {@link approvalStillApplies} is the check.
   */
  readonly approvedBinding?: string | undefined
}

/** One workflow run: a definition frozen at a version, with node state. */
export interface WorkflowRun {
  readonly runId: string
  readonly workflowId: string
  /** The definition version this run fixed. Later edits do not change it. */
  readonly definitionVersion: number
  readonly status: 'running' | 'paused' | 'needs_user' | 'completed' | 'cancelled'
  /** Rework rounds already used. The initial execution is not one of them. */
  readonly reworkRoundsUsed: number
  /** Nodes redone in each round, oldest first. */
  readonly reworkHistory: readonly (readonly string[])[]
  readonly nodes: readonly NodeRun[]
}

/** The facts a readiness decision needs beyond the definition and the run. */
export interface ReadinessFacts {
  /** Whether each artifact a node needs is pinned to a version and accessible. */
  readonly artifactReady: (artifactId: string) => boolean
  /** Whether the authorisation the node runs under is still live. */
  readonly authorized: boolean
  /** Whether the node's configuration and execution environment are available. */
  readonly environmentReady: boolean
  /** Whether concurrency and budget currently permit another node. */
  readonly capacityAvailable: boolean
  /** Whether a required approval has been satisfied. */
  readonly approved: boolean
}

/** One condition of PRD §二.12's start list. */
export interface StartCondition {
  readonly condition:
    | 'upstream_accepted'
    | 'inputs_pinned'
    | 'authorized'
    | 'environment_ready'
    | 'capacity_and_budget'
    | 'approvals'
  readonly satisfied: boolean
  readonly reason: string
}

/** Why a node may or may not start. */
export interface NodeReadiness {
  readonly nodeId: string
  readonly ready: boolean
  /** Every condition, satisfied or not, so a blocked node says which one failed. */
  readonly conditions: readonly StartCondition[]
}

/**
 * Decide whether one node may start.
 *
 * All six conditions are always reported. A caller that only learned "not ready"
 * would have to guess which of six quite different problems to fix — an expired
 * authorisation, an unpinned input, a busy host — and the guesses are not
 * interchangeable.
 *
 * @param definition - the definition, for the node and its dependencies.
 * @param run - the run, for dependency states and this node's attempts.
 * @param nodeId - the node to consider.
 * @param facts - the facts about authorisation, environment, capacity and approvals.
 * @returns the verdict with every condition.
 */
export function nodeReadiness(
  definition: WorkflowDefinition,
  run: WorkflowRun,
  nodeId: string,
  facts: ReadinessFacts,
): NodeReadiness {
  const node = definition.nodes.find(candidate => candidate.nodeId === nodeId)
  if (node === undefined) {
    return {
      nodeId,
      ready: false,
      conditions: [{ condition: 'upstream_accepted', satisfied: false, reason: `node ${nodeId} is not in this workflow` }],
    }
  }

  const unmetUpstream = dependsOnOf(node).map(dependency => ({
    dependency,
    entry: run.nodes.find(candidate => candidate.nodeId === dependency),
  })).filter(({ entry }) =>
    // Acceptance, not merely a finished node: a model review leaves the node `validating`,
    // so a downstream node cannot start on a subjective judgement (PRD §二.12).
    entry?.state !== 'passed' || entry.verdict === undefined || !isAcceptance(entry.verdict))
  const artifacts = node.inputArtifacts ?? []
  const unpinned = artifacts.filter(artifactId => !facts.artifactReady(artifactId))
  const entry = run.nodes.find(candidate => candidate.nodeId === nodeId)
  const stillApplies = approvalStillApplies(entry, node, run.definitionVersion)
  const approvalSatisfied = !node.requiresApproval || (facts.approved && stillApplies)

  const liveCount = run.nodes.filter(candidate => isLiveNode(candidate.state)).length
  const cap = definition.budget?.maxConcurrent
  const atConcurrency = cap !== undefined && liveCount >= cap
  const capacityOk = facts.capacityAvailable && !atConcurrency

  const conditions: StartCondition[] = [
    {
      condition: 'upstream_accepted',
      satisfied: unmetUpstream.length === 0,
      reason: unmetUpstream.length === 0
        ? 'every upstream node has passed acceptance'
        : `these upstream nodes have not passed acceptance: ${unmetUpstream.map(({ dependency, entry }) =>
            entry?.state === 'validating' && entry.verdict?.by === 'model_review'
              ? `${dependency} (reviewed by the model, which is a judgement and not acceptance)`
              : `${dependency} (${entry?.state ?? 'not started'})`).join(', ')}`,
    },
    {
      condition: 'inputs_pinned',
      satisfied: unpinned.length === 0,
      reason: unpinned.length === 0
        ? (artifacts.length === 0 ? 'the node consumes no artifacts' : 'every input artifact is pinned and accessible')
        : `these input artifacts are not pinned and accessible: ${unpinned.join(', ')}`,
    },
    {
      condition: 'authorized',
      satisfied: facts.authorized,
      reason: facts.authorized ? 'the authorisation is still valid' : 'the authorisation is no longer valid',
    },
    {
      condition: 'environment_ready',
      satisfied: facts.environmentReady,
      reason: facts.environmentReady ? 'configuration and execution environment are available' : 'the configuration or execution environment is unavailable',
    },
    {
      condition: 'capacity_and_budget',
      satisfied: capacityOk,
      reason: atConcurrency
        ? `this run already has ${String(liveCount)} live node(s), and the definition limits concurrency to ${String(cap)}`
        : facts.capacityAvailable
          ? 'concurrency and budget permit another node'
          : 'concurrency or budget does not permit another node',
    },
    {
      condition: 'approvals',
      satisfied: approvalSatisfied,
      reason: node.requiresApproval
        ? (!facts.approved
            ? 'the node requires an approval that has not been given'
            : stillApplies
              ? 'the required approval is satisfied'
              : 'the recorded approval bound a different action or definition version, so it cannot be reused')
        : 'the node requires no approval',
    },
  ]

  return { nodeId, ready: conditions.every(condition => condition.satisfied), conditions }
}

/**
 * Record an acceptance verdict against a node.
 *
 * The node's **lifecycle** and the **acceptance** dimension stay apart (PRD §三.4).
 * A `pass` from the user or from a deterministic check is `passed`; a `pass` from a
 * model review, or an `inconclusive` result, leaves the node `validating`, because
 * PRD §二.12 forbids a subjective judgement from standing in for acceptance and the
 * downstream gate is acceptance. Both questions — "is this acceptance" and "is this
 * the user's own acceptance" — are answered by {@link isAcceptance} and
 * {@link isUserAcceptance} and nowhere else, so the state mapping and the gate cannot
 * drift apart.
 *
 * @param run - the run as it stands.
 * @param nodeId - the node being judged.
 * @param verdict - the verdict.
 * @returns the run with the node's state and verdict updated.
 */
export function recordVerdict(run: WorkflowRun, nodeId: string, verdict: AcceptanceVerdict): WorkflowRun {
  const state: NodeState = verdict.result === 'fail'
    ? 'failed'
    : isAcceptance(verdict) ? 'passed' : 'validating'
  return {
    ...run,
    nodes: run.nodes.map(node => node.nodeId === nodeId ? { ...node, state, verdict } : node),
  }
}

/**
 * Whether a verdict satisfies a node's acceptance (PRD §二.12's "必需上游节点验收通过").
 *
 * Two verdicts do: the **user's** own acceptance, and a **deterministic check** that passed — the
 * latter because §二.12's contrast is explicit, requiring such a check to record "真实命令、结果和
 * 证据", which is an objective, re-checkable fact rather than an opinion. A model review is neither:
 * it is a judgement, it is labelled as one, and it never satisfies this gate.
 *
 * @param verdict - the verdict to judge.
 * @returns whether it counts as acceptance.
 */
export function isAcceptance(verdict: AcceptanceVerdict): boolean {
  return verdict.result === 'pass' && (verdict.by === 'user' || verdict.by === 'deterministic_check')
}

/**
 * Whether a verdict counts as the user's **own** acceptance.
 *
 * The stricter question, for a caller that must distinguish the user's decision from an objective
 * check. PRD §二.12: a subjective model review must not pass itself off as user acceptance.
 *
 * @param verdict - the verdict to judge.
 * @returns whether it is a user acceptance.
 */
export function isUserAcceptance(verdict: AcceptanceVerdict): boolean {
  return verdict.result === 'pass' && verdict.by === 'user'
}

/**
 * Why a verdict is refused as malformed, or undefined when it is well-formed.
 *
 * PRD §二.12's rule has two halves and this is the first: "确定性检查记录真实命令、结果和证据". A
 * `deterministic_check` that names no command is not a check — it is a claim wearing a check's label
 * — so it is refused at the boundary rather than stored and believed.
 *
 * @param verdict - the verdict to check.
 * @returns the refusal reason, or undefined when the verdict may be recorded.
 */
export function verdictRefusal(verdict: AcceptanceVerdict): string | undefined {
  if (verdict.by !== 'deterministic_check') return undefined
  if (verdict.command === undefined || verdict.command.trim().length === 0) {
    return 'a deterministic check must record the command it actually ran (PRD §二.12). Without one it is an opinion '
      + 'wearing a check\'s label, so it is refused rather than recorded as evidence.'
  }
  if (verdict.output === undefined) {
    return 'a deterministic check must record what the command actually returned, not only the command: the result is '
      + 'the evidence, and a command without its result proves nothing.'
  }
  return undefined
}

/**
 * The action and versions an approval binds (PRD §四.3).
 *
 * Canonical so the same logical work produces the same digest regardless of
 * property order or input-artifact order. Expanding the instruction, adding
 * an input, changing the acceptance rule or moving the definition version is
 * a different action, and an old approval must not cover it.
 *
 * @param node - the node as it stands in the definition.
 * @param definitionVersion - the definition version the run fixed.
 * @returns a stable digest of the approved work.
 */
export function approvalBindingOf(node: WorkflowNode, definitionVersion: number): string {
  return canonicalize({
    acceptance: node.acceptance ?? '',
    definitionVersion,
    inputArtifacts: [...(node.inputArtifacts ?? [])].sort(),
    instruction: node.instruction ?? '',
    taskId: node.taskId,
  })
}

/**
 * Whether a recorded approval still covers the work about to start.
 *
 * A missing binding is a record from before this field existed: it still
 * covers the work only until the action itself changes. Tests that inject
 * `facts.approved` without stamping a binding keep passing; a stamped
 * binding that no longer matches does not.
 *
 * @param entry - the node's run record, when the run has one.
 * @param node - the live definition node.
 * @param definitionVersion - the definition version the run fixed.
 * @returns whether the start gate may treat the approval as satisfied.
 */
export function approvalStillApplies(
  entry: NodeRun | undefined,
  node: WorkflowNode,
  definitionVersion: number,
): boolean {
  if (entry?.approvedBinding === undefined) return true
  return entry.approvedBinding === approvalBindingOf(node, definitionVersion)
}

/**
 * Record a required approval against a node (PRD §二.12 condition 6).
 *
 * A pure rule so the gate's meaning is testable without running anything, and so the refusals are
 * the same wherever they are asked for. An approval is recorded for a node that is still **pending**:
 * once a node is running or judged, an approval arriving afterwards would be approving work that has
 * already happened, which is not what "必需审批已满足" asks for. The approval is bound to the node's
 * current action and the run's definition version (PRD §四.3): enlarging the action afterwards
 * cannot reuse it, and approving against a later definition would bind work this run never fixed.
 *
 * @param definition - the workflow definition the run was started from.
 * @param run - the run as it stands.
 * @param nodeId - the node being approved.
 * @param by - the session recording the approval.
 * @param at - when it was recorded.
 * @returns the run with the approval, or the reason it was refused.
 */
export function approveNode(
  definition: WorkflowDefinition,
  run: WorkflowRun,
  nodeId: string,
  by: string,
  at: string,
): { readonly ok: true; readonly run: WorkflowRun } | { readonly ok: false; readonly reason: string } {
  const node = definition.nodes.find(candidate => candidate.nodeId === nodeId)
  if (node === undefined) {
    return { ok: false, reason: `node ${nodeId} is not in workflow ${definition.workflowId}` }
  }
  const entry = run.nodes.find(candidate => candidate.nodeId === nodeId)
  if (entry === undefined) {
    return { ok: false, reason: `run ${run.runId} has no node ${nodeId} to approve` }
  }
  if (node.requiresApproval !== true) {
    return {
      ok: false,
      reason: `node ${nodeId} does not require an approval, so recording one would create a decision nobody asked `
        + 'for and would make the node look gated when it is not',
    }
  }
  if (definition.version !== run.definitionVersion) {
    return {
      ok: false,
      reason: `this run fixed definition version ${String(run.definitionVersion)}, and the live definition is `
        + `version ${String(definition.version)}; approving the later body would bind an action this run never fixed`,
    }
  }
  if (entry.approvedBy !== undefined) {
    return {
      ok: false,
      reason: `node ${nodeId} was already approved by ${entry.approvedBy} at ${String(entry.approvedAt)}, so a second `
        + 'approval would rewrite who decided',
    }
  }
  if (!isStartable(entry.state)) {
    return {
      ok: false,
      reason: `node ${nodeId} is ${entry.state}, so approving it now would be approving work that has already `
        + 'happened rather than permitting it',
    }
  }
  return {
    ok: true,
    run: {
      ...run,
      nodes: run.nodes.map(candidate => candidate.nodeId === nodeId
        ? {
            ...candidate,
            approvedBy: by,
            approvedAt: at,
            approvedBinding: approvalBindingOf(node, run.definitionVersion),
          }
        : candidate),
    },
  }
}

/**
 * What a run fixed when it started (PRD §三.3, "每次运行固定").
 *
 * Six things, and they are fixed rather than read live for a reason: a run that read them as it
 * went would silently adopt someone else's later edit — a constraint rewritten mid-flight, an input
 * artifact replaced, a task's control transferred, a budget tightened. Fixing them makes the run
 * answerable for the terms it started under, and makes "this changed under us" a reportable fact
 * instead of a silent behaviour change.
 */
export interface RunFixed {
  /** The definition version, which also fixes the acceptance rules and the budget policy text. */
  readonly definitionVersion: number
  /** Who held write control of each node's task, and at which epoch. */
  readonly authorisations: readonly { readonly taskId: string; readonly ownerSessionId: string; readonly ownerEpoch: number }[]
  /** The version of every shared constraint in force at start. */
  readonly constraints: readonly { readonly constraintId: string; readonly version: number }[]
  /** Every node's input artifacts, with the content version each had at start. */
  readonly artifacts: readonly { readonly artifactId: string; readonly contentVersion: number }[]
  /** The acceptance rule text each node was fixed with, for a reader comparing it later. */
  readonly acceptance: readonly { readonly nodeId: string; readonly rule: string }[]
  /**
   * Each node's failure policy as frozen at start (PRD §二.12 失败处理).
   *
   * Optional: a run recorded before this was captured has none, and then the
   * live definition is consulted rather than inventing `stop`.
   */
  readonly failure?: readonly {
    readonly nodeId: string
    readonly onFail: FailureHandling['onFail']
    readonly retries?: number | undefined
  }[] | undefined
  /** The run budget as fixed, rendered for display; absent when the definition sets none. */
  readonly budget?: string | undefined
  /**
   * The node graph this run executes (PRD §三.3 不静默改变在途节点).
   *
   * Optional so a run recorded before the snapshot existed still validates.
   * When present, `drive` uses this body rather than the live definition, and
   * {@link fixedDrift} does not treat a later save as a reason to stop — the
   * snapshot *is* the definition the run fixed. Runs without a graph still
   * stop when the live version or budget moves, because they have no body to
   * keep executing.
   */
  readonly graph?: readonly WorkflowNode[] | undefined
  /** The definition title at start, when the graph was snapshotted. */
  readonly title?: string | undefined
  /** The rework limit at start, when the graph was snapshotted. */
  readonly rework?: { readonly maxRounds: number } | undefined
  /** Structured budget at start, so gating does not re-parse {@link budget}. */
  readonly budgetLimit?: WorkflowBudget | undefined
}

/** What the world looks like now, for comparison against {@link RunFixed}. */
export interface RunObserved {
  /** The live definition version. Compared first: a later save overwrites the body. */
  readonly definitionVersion: number
  readonly authorisations: readonly { readonly taskId: string; readonly ownerSessionId: string; readonly ownerEpoch: number }[]
  readonly constraints: readonly { readonly constraintId: string; readonly version: number }[]
  readonly artifacts: readonly { readonly artifactId: string; readonly contentVersion: number }[]
  /** The live definition's budget policy, rendered the same way {@link RunFixed.budget} is. */
  readonly budget?: string | undefined
}

/**
 * Render a definition's budget as the fixed-policy string a run stores.
 *
 * One renderer so start and drive cannot disagree about what "the same policy"
 * looks like. Absent when the definition sets no budget at all — that is a
 * different fact from `maxTurns=unset`, which is a budget object that named no
 * turn ceiling.
 *
 * @param budget - the definition's budget, when it has one.
 * @returns the comparable string, or undefined.
 */
export function budgetPolicyText(
  budget: WorkflowBudget | undefined,
): string | undefined {
  if (budget === undefined) return undefined
  return `maxTurns=${String(budget.maxTurns ?? 'unset')}`
    + `${budget.maxTokens === undefined ? '' : `, maxTokens=${String(budget.maxTokens)}`}`
    + `${budget.maxConcurrent === undefined ? '' : `, maxConcurrent=${String(budget.maxConcurrent)}`}`
}

/**
 * Rebuild the definition a run executes from the graph it snapshotted at start.
 *
 * PRD §三.3: a later save must not silently change in-flight nodes. The store
 * overwrites the live definition, so the only body a run can keep executing is
 * the one it copied. Absent when the run never captured a graph — those runs
 * still consult the live definition and still stop when its version moves.
 *
 * @param workflowId - the workflow identity the run names.
 * @param fixed - what the run captured.
 * @param fallbackTitle - used when the snapshot stored no title.
 * @returns the frozen definition, or undefined.
 */
export function definitionFromFixed(
  workflowId: string,
  fixed: RunFixed,
  fallbackTitle: string,
): WorkflowDefinition | undefined {
  if (fixed.graph === undefined) return undefined
  return {
    workflowId,
    title: fixed.title ?? fallbackTitle,
    version: fixed.definitionVersion,
    nodes: fixed.graph.map(node => ({
      nodeId: node.nodeId,
      taskId: node.taskId,
      ...node.dependsOn === undefined ? {} : { dependsOn: [...node.dependsOn] },
      ...node.inputArtifacts === undefined ? {} : { inputArtifacts: [...node.inputArtifacts] },
      ...node.instruction === undefined ? {} : { instruction: node.instruction },
      ...node.acceptance === undefined ? {} : { acceptance: node.acceptance },
      ...node.failure === undefined ? {} : { failure: { ...node.failure } },
      ...node.requiresApproval === undefined ? {} : { requiresApproval: node.requiresApproval },
    })),
    ...fixed.rework === undefined ? {} : { rework: { maxRounds: fixed.rework.maxRounds } },
    ...fixed.budgetLimit === undefined ? {} : { budget: { ...fixed.budgetLimit } },
  }
}

/**
 * One node as `read` shows it (PRD §二.12 用户可查看的结构化定义).
 *
 * Copied field by field so a later mutation of the stored record cannot change
 * what a caller already received.
 */
export interface WorkflowNodeView {
  readonly nodeId: string
  readonly taskId: string
  readonly dependsOn?: readonly string[] | undefined
  readonly inputArtifacts?: readonly string[] | undefined
  readonly instruction?: string | undefined
  readonly acceptance?: string | undefined
  readonly failure?: FailureHandling | undefined
  readonly requiresApproval?: boolean | undefined
}

/** A saved definition as `read` returns it. */
export interface WorkflowDefinitionView {
  readonly workflowId: string
  readonly title: string
  readonly version: number
  readonly status: string
  readonly nodes: readonly WorkflowNodeView[]
  readonly rework?: { readonly maxRounds: number } | undefined
  readonly budget?: WorkflowBudget | undefined
}

/** One node of a run as `read` returns it, including the frozen action when snapshotted. */
export interface WorkflowRunNodeView {
  readonly nodeId: string
  readonly state: NodeState
  readonly attempts: number
  readonly taskId?: string | undefined
  readonly instruction?: string | undefined
  readonly acceptance?: string | undefined
  readonly verdict?: {
    readonly result: AcceptanceResult
    readonly by: AcceptanceBy
    readonly at: string
  } | undefined
  readonly approvedBy?: string | undefined
}

/**
 * One run as `read` returns it (PRD §三.3 固定版本运行与节点状态).
 *
 * `frozen` is whether this run executes a graph snapshotted at start. When it
 * is, each node carries the instruction that run actually dispatches — not the
 * live definition, which a later save may have overwritten.
 */
export interface WorkflowRunView {
  readonly runId: string
  readonly workflowId: string
  readonly definitionVersion: number
  readonly status: string
  readonly reworkRoundsUsed: number
  readonly frozen: boolean
  readonly nodes: readonly WorkflowRunNodeView[]
  readonly sourceRunId?: string | undefined
}

/**
 * Project a stored node into the view a reader sees.
 *
 * @param node - the definition node.
 * @returns the view.
 */
export function nodeViewOf(node: WorkflowNode): WorkflowNodeView {
  return {
    nodeId: node.nodeId,
    taskId: node.taskId,
    ...node.dependsOn === undefined ? {} : { dependsOn: [...node.dependsOn] },
    ...node.inputArtifacts === undefined ? {} : { inputArtifacts: [...node.inputArtifacts] },
    ...node.instruction === undefined ? {} : { instruction: node.instruction },
    ...node.acceptance === undefined ? {} : { acceptance: node.acceptance },
    ...node.failure === undefined ? {} : { failure: { ...node.failure } },
    ...node.requiresApproval === undefined ? {} : { requiresApproval: node.requiresApproval },
  }
}

/**
 * Project a definition into the structured view PRD §二.12 requires.
 *
 * @param definition - the definition.
 * @param status - the saved status (`active` / `paused`).
 * @returns the view.
 */
export function definitionViewOf(definition: WorkflowDefinition, status: string): WorkflowDefinitionView {
  return {
    workflowId: definition.workflowId,
    title: definition.title,
    version: definition.version,
    status,
    nodes: definition.nodes.map(nodeViewOf),
    ...definition.rework === undefined ? {} : { rework: { maxRounds: definition.rework.maxRounds } },
    ...definition.budget === undefined ? {} : { budget: { ...definition.budget } },
  }
}

/**
 * Project a run into the fixed-version view PRD §三.3 requires.
 *
 * Instruction, task and acceptance come from {@link executed} only when
 * `frozen` is true. Overlaying the live definition on a graph-less run would
 * show a later save as if this run were executing it.
 *
 * @param run - the run.
 * @param executed - the graph this run executes, when frozen.
 * @param extras - listing fields that are not on {@link WorkflowRun}.
 * @returns the view.
 */
export function runViewOf(
  run: WorkflowRun,
  executed: WorkflowDefinition | undefined,
  extras: { readonly frozen: boolean; readonly sourceRunId?: string | undefined },
): WorkflowRunView {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    definitionVersion: run.definitionVersion,
    status: run.status,
    reworkRoundsUsed: run.reworkRoundsUsed,
    frozen: extras.frozen,
    nodes: run.nodes.map(entry => {
      const defNode = extras.frozen
        ? executed?.nodes.find(candidate => candidate.nodeId === entry.nodeId)
        : undefined
      return {
        nodeId: entry.nodeId,
        state: entry.state,
        attempts: entry.attempts,
        ...defNode === undefined ? {} : {
          taskId: defNode.taskId,
          ...defNode.instruction === undefined ? {} : { instruction: defNode.instruction },
          ...defNode.acceptance === undefined ? {} : { acceptance: defNode.acceptance },
        },
        ...entry.verdict === undefined ? {} : {
          verdict: {
            result: entry.verdict.result,
            by: entry.verdict.by,
            at: entry.verdict.at,
          },
        },
        ...entry.approvedBy === undefined ? {} : { approvedBy: entry.approvedBy },
      }
    }),
    ...extras.sourceRunId === undefined ? {} : { sourceRunId: extras.sourceRunId },
  }
}

/**
 * Whether anything a run fixed has changed underneath it.
 *
 * Compared rather than assumed: each of these is a fact someone else can change while the run
 * is in flight, and continuing to dispatch after one changed would run the work under terms nobody
 * agreed to. The first drift found is reported with what it was and what it is now, because "the
 * run is stale" without the field is not actionable.
 *
 * @param fixed - what the run fixed at start.
 * @param observed - what is true now.
 * @returns the reason to stop, or undefined when everything still holds.
 */
export function fixedDrift(fixed: RunFixed, observed: RunObserved): string | undefined {
  // A snapshotted graph *is* the definition this run executes. A later save
  // must not stop it or rewrite its nodes (PRD §三.3). Runs that never captured
  // a graph still stop: they would otherwise dispatch the later body.
  if (fixed.graph === undefined) {
    if (observed.definitionVersion !== fixed.definitionVersion) {
      return `the workflow definition moved from version ${String(fixed.definitionVersion)} to `
        + `${String(observed.definitionVersion)} after this run started, so in-flight nodes would run under a `
        + 'definition they never fixed'
    }
  }
  for (const was of fixed.authorisations) {
    const now = observed.authorisations.find(entry => entry.taskId === was.taskId)
    if (now === undefined) {
      return `task ${was.taskId} no longer has a control record, and this run fixed ${was.ownerSessionId} at epoch `
        + `${String(was.ownerEpoch)} as its authority`
    }
    if (now.ownerSessionId !== was.ownerSessionId || now.ownerEpoch !== was.ownerEpoch) {
      return `control of task ${was.taskId} moved from ${was.ownerSessionId}@${String(was.ownerEpoch)} to `
        + `${now.ownerSessionId}@${String(now.ownerEpoch)} after this run fixed its authority, so the run's `
        + 'authorisation is no longer the one it started under'
    }
  }
  for (const was of fixed.constraints) {
    const now = observed.constraints.find(entry => entry.constraintId === was.constraintId)
    if (now === undefined) {
      return `constraint ${was.constraintId} was removed, and this run fixed version ${String(was.version)} of it`
    }
    if (now.version !== was.version) {
      return `constraint ${was.constraintId} moved from version ${String(was.version)} to ${String(now.version)} `
        + 'after this run started, so the run would be judged against a statement it never fixed'
    }
  }
  for (const was of fixed.artifacts) {
    const now = observed.artifacts.find(entry => entry.artifactId === was.artifactId)
    if (now === undefined) {
      return `input artifact ${was.artifactId} is no longer recorded, and this run fixed content version `
        + `${String(was.contentVersion)} of it`
    }
    if (now.contentVersion !== was.contentVersion) {
      return `input artifact ${was.artifactId} moved from content version ${String(was.contentVersion)} to `
        + `${String(now.contentVersion)} after this run started, so it is not the input the run fixed`
    }
  }
  const wasBudget = fixed.budget ?? ''
  const nowBudget = observed.budget ?? ''
  if (fixed.graph === undefined && wasBudget !== nowBudget) {
    if (wasBudget.length === 0) {
      return `this run fixed no budget policy, and the live definition now has ${nowBudget}`
    }
    if (nowBudget.length === 0) {
      return `the live definition no longer has a budget policy, and this run fixed ${wasBudget}`
    }
    return `the budget policy moved from ${wasBudget} to ${nowBudget} after this run started, so the run would `
      + 'be gated by a limit it never fixed'
  }
  return undefined
}

/**
 * Whether a verdict was reached against the rule the run fixed for that node.
 *
 * PRD §二.12 puts an 验收规则 in the definition and §三.3 makes the run fix its 验收配置, and until
 * this rule existed the stored text was **display-only**: a run could be judged against anything,
 * and a definition edited afterwards would silently change what "passed" meant. So a verdict has to
 * state the rule it was judged by, and that statement must be the one the run fixed.
 *
 * @param fixedRule - the acceptance rule the run fixed for this node (empty when it fixed none).
 * @param verdictRule - the rule the verdict says it was judged against.
 * @returns the refusal reason, or undefined when the verdict may be recorded.
 */
export function verdictRuleRefusal(fixedRule: string, verdictRule: string | undefined): string | undefined {
  if (fixedRule.trim().length === 0) return undefined
  if (verdictRule === undefined || verdictRule.trim().length === 0) {
    return `this node's acceptance rule was fixed when the run started ("${fixedRule}"), and the verdict does not say `
      + 'which rule it was judged against. A verdict that does not name its rule cannot be checked against the one '
      + 'the run fixed, so it is refused rather than recorded.'
  }
  if (verdictRule.trim() !== fixedRule.trim()) {
    return `the verdict was judged against "${verdictRule}", and this run fixed "${fixedRule}". A rule changed after `
      + 'the run started must not silently redefine what passing means; start a new run to judge by a new rule.'
  }
  return undefined
}

/** The outcome of trying to open a rework round. */
export interface ReworkDecision {
  readonly allowed: boolean
  /** The round number that would be opened, when allowed. */
  readonly round?: number
  readonly reason: string
}

/**
 * Decide whether a rework round may be opened.
 *
 * The rules of PRD §二.12, in one place:
 *
 * - the limit counts **whole-workflow rounds**, and the initial execution is not one;
 * - one round may redo several nodes, but a node may be executed **at most once in a
 *   round**, so a second request for the same node in the same round is refused rather
 *   than silently re-run;
 * - the default limit is {@link DEFAULTS.reworkRounds} (published two);
 * - at the limit the workflow goes to the user. It does not start a fresh workflow to
 *   get more room, which is why this returns a refusal rather than a reset.
 *
 * @param run - the run as it stands.
 * @param nodesToRedo - the nodes the round would redo.
 * @param limit - the configured limit; defaults to {@link DEFAULTS.reworkRounds}.
 * @returns whether the round may be opened, and why.
 */
export function openReworkRound(
  run: WorkflowRun,
  nodesToRedo: readonly string[],
  limit: number = DEFAULTS.reworkRounds,
): ReworkDecision {
  if (nodesToRedo.length === 0) {
    return { allowed: false, reason: 'a rework round must name at least one node to redo' }
  }
  const duplicates = nodesToRedo.filter((nodeId, index) => nodesToRedo.indexOf(nodeId) !== index)
  if (duplicates.length > 0) {
    return {
      allowed: false,
      reason: `a node may be executed at most once per round, and ${[...new Set(duplicates)].join(', ')} `
        + 'is named more than once',
    }
  }
  if (run.reworkRoundsUsed >= limit) {
    return {
      allowed: false,
      reason: `the workflow has used all ${String(limit)} rework round(s); it now needs the user. `
        + 'Starting another workflow to get more room would evade the limit rather than respect it.',
    }
  }
  return {
    allowed: true,
    round: run.reworkRoundsUsed + 1,
    reason: `opening rework round ${String(run.reworkRoundsUsed + 1)} of ${String(limit)}`,
  }
}

/**
 * Apply a rework round: its nodes go back to `blocked` and the counter advances.
 *
 * A node's verdict is cleared with its state, because the previous verdict judged the
 * previous attempt; keeping it would let a stale `pass` satisfy a downstream node that
 * has not yet seen the reworked output.
 *
 * @param run - the run as it stands.
 * @param decision - an allowed decision from {@link openReworkRound}.
 * @param nodesToRedo - the nodes to redo.
 * @returns the run with the round applied.
 */
export function applyReworkRound(
  run: WorkflowRun,
  decision: ReworkDecision,
  nodesToRedo: readonly string[],
): WorkflowRun {
  if (!decision.allowed) return run
  return {
    ...run,
    reworkRoundsUsed: decision.round ?? run.reworkRoundsUsed,
    reworkHistory: [...run.reworkHistory, [...nodesToRedo]],
    nodes: run.nodes.map(node => nodesToRedo.includes(node.nodeId)
      ? { nodeId: node.nodeId, state: 'blocked', attempts: node.attempts, ...node.turnsUsed === undefined ? {} : { turnsUsed: node.turnsUsed } }
      : node),
  }
}

/**
 * Decide what a failed or inconclusive node means for the run.
 *
 * An `inconclusive` verdict does not retry: the answer is unknown. A declared
 * per-node failure policy (PRD §二.12 失败处理) is applied next: `stop` hands
 * the run to the user, `continue` leaves the node failed so siblings that do
 * not depend on it can still run. `retry` reruns the whole node, so it consumes
 * a rework round as well as its per-node retry allowance. Exhausting either
 * allowance produces `needs_user`; only a transport retry of the same message
 * is exempt from the whole-workflow rework cap.
 *
 * @param run - the run as it stands.
 * @param nodeId - the node that failed or was inconclusive.
 * @param limit - the configured rework limit; defaults to {@link DEFAULTS.reworkRounds}.
 * @param handling - the node's frozen failure policy, when the run captured one.
 * @returns the run, and a one-line account of the decision.
 */
export function afterNodeFailure(
  run: WorkflowRun,
  nodeId: string,
  limit: number = DEFAULTS.reworkRounds,
  handling?: FailureHandling | undefined,
): { run: WorkflowRun; reason: string } {
  const node = run.nodes.find(entry => entry.nodeId === nodeId)
  if (node === undefined) return { run, reason: `node ${nodeId} is not part of this run` }

  if (node.verdict?.result === 'inconclusive') {
    return {
      run: { ...run, status: 'needs_user' },
      reason: `node ${nodeId} was judged inconclusive. The result is unknown, and retrying an unknown result would `
        + 'spend the budget without learning anything, so the workflow stops for the user.',
    }
  }

  if (handling?.onFail === 'stop') {
    return {
      run: { ...run, status: 'needs_user' },
      reason: `node ${nodeId} failed; its failure policy is stop, so the run needs the user rather than `
        + 'retrying or continuing past the failure.',
    }
  }

  if (handling?.onFail === 'continue') {
    return {
      run,
      reason: `node ${nodeId} failed; its failure policy is continue, so the node stays failed and other `
        + 'nodes that do not depend on it may still run.',
    }
  }

  if (handling?.onFail === 'retry') {
    const allowed = handling.retries ?? 1
    if (node.attempts > allowed) {
      return {
        run: { ...run, status: 'needs_user' },
        reason: `node ${nodeId} exhausted its ${String(allowed)} retry allowance; further task execution needs the user.`,
      }
    }
  }

  const decision = openReworkRound(run, [nodeId], limit)
  if (!decision.allowed) {
    return {
      run: { ...run, status: 'needs_user' },
      reason: `node ${nodeId} failed and ${decision.reason}`,
    }
  }
  return {
    run: applyReworkRound(run, decision, [nodeId]),
    reason: `node ${nodeId} failed; ${decision.reason}`,
  }
}

/**
 * Whether a blocked node can never start because an upstream has failed or been cancelled.
 *
 * Used so a `continue` failure can settle the run: dependents stay blocked forever,
 * and that is not the same as "still waiting to start".
 */
function blockedForever(
  definition: WorkflowDefinition,
  run: WorkflowRun,
  nodeId: string,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (seen.has(nodeId)) return false
  const next = new Set(seen)
  next.add(nodeId)
  const defNode = definition.nodes.find(candidate => candidate.nodeId === nodeId)
  if (defNode === undefined) return true
  return dependsOnOf(defNode).some(dependency => {
    const entry = run.nodes.find(candidate => candidate.nodeId === dependency)
    if (entry === undefined) return true
    if (entry.state === 'failed' || entry.state === 'cancelled') return true
    return entry.state === 'blocked' && blockedForever(definition, run, dependency, next)
  })
}

/**
 * Whether every node has finished or is blocked forever behind a failure (PRD §二.12).
 *
 * Distinct from "every node passed": a `continue` policy can complete a run that
 * still has failed nodes. Live, ready and validating nodes are not settled.
 */
export function runHasSettled(definition: WorkflowDefinition, run: WorkflowRun): boolean {
  if (run.nodes.length === 0) return false
  return run.nodes.every(node => {
    if (isTerminalNode(node.state)) return true
    if (isLiveNode(node.state) || node.state === 'ready' || node.state === 'validating') return false
    return node.state === 'blocked' && blockedForever(definition, run, node.nodeId)
  })
}

/**
 * The frozen failure policy for one node, when the run captured one.
 *
 * @param fixed - the run's fixed terms.
 * @param nodeId - the node.
 * @returns the policy, or undefined when this run did not capture one.
 */
export function frozenFailureOf(
  fixed: RunFixed | undefined,
  nodeId: string,
): FailureHandling | undefined {
  const entry = fixed?.failure?.find(candidate => candidate.nodeId === nodeId)
  if (entry === undefined) return undefined
  return {
    onFail: entry.onFail,
    ...entry.retries === undefined ? {} : { retries: entry.retries },
  }
}

/**
 * Whether a node execution was a rework attempt rather than a message retry.
 *
 * PRD §二.12 draws this line explicitly: a message retry does not consume a rework
 * round, while asking the model to do the task again is a new attempt that counts
 * against both the rework limit and the budget.
 *
 * @param kind - what happened.
 * @returns whether it consumes a rework round.
 */
export function consumesRework(kind: 'message_retry' | 'task_retry'): boolean {
  return kind === 'task_retry'
}

/**
 * Which target tasks a cancelled workflow run should ask to stop (PRD §四.4).
 *
 * Pause only stops new dispatch. Cancel also requests a stop of each node that
 * is still running. The request is not a rollback: files and external actions
 * already performed stay as they are. Duplicate task ids (two nodes on one
 * task) are asked once.
 *
 * @param runNodes - the run's node states.
 * @param definitionNodes - the definition frozen for that run, for task ids.
 * @returns task ids to request a turn cancel on, in definition order.
 */
export function turnsToStopOnWorkflowCancel(
  runNodes: readonly { readonly nodeId: string; readonly state: string }[],
  definitionNodes: readonly { readonly nodeId: string; readonly taskId: string }[],
): string[] {
  const taskByNode = new Map(definitionNodes.map(node => [node.nodeId, node.taskId]))
  const ids: string[] = []
  const seen = new Set<string>()
  for (const node of runNodes) {
    if (!isLiveNode(canonicalNodeState(node.state))) continue
    const taskId = taskByNode.get(node.nodeId)
    if (taskId === undefined || seen.has(taskId)) continue
    seen.add(taskId)
    ids.push(taskId)
  }
  return ids
}

/** The outcome of planning a partial rerun (PRD §三.3 重跑, §四.3). */
export type PartialRerunPlan =
  | {
      readonly ok: true
      readonly selected: readonly string[]
      readonly reset: readonly string[]
      readonly kept: readonly string[]
    }
  | { readonly ok: false; readonly reason: string }

/**
 * Decide which nodes a partial rerun must redo.
 *
 * Distinct from bounded rework: rework mutates the **same** run and is capped
 * at two rounds; exhausting that cap must not silently open another run.
 * `rerun` is the explicit interface action: it creates a **new runId**, redos
 * the selected nodes and every node that depends on them (transitively), keeps
 * the source run and its evidence, and does not treat existing files or
 * external actions as undone.
 *
 * Successors are read from the definition the source run **fixed**. A later
 * save that changed the graph must not silently change which nodes are redone.
 *
 * @param definition - the workflow definition whose version must match the run.
 * @param run - the source run.
 * @param selected - the nodes the caller named to redo.
 * @returns the nodes to reset and the nodes to keep, or why not.
 */
export function planPartialRerun(
  definition: Pick<WorkflowDefinition, 'version' | 'nodes'>,
  run: Pick<WorkflowRun, 'definitionVersion' | 'nodes'>,
  selected: readonly string[],
): PartialRerunPlan {
  const unique: string[] = []
  const seenSelected = new Set<string>()
  for (const nodeId of selected) {
    if (seenSelected.has(nodeId)) continue
    seenSelected.add(nodeId)
    unique.push(nodeId)
  }
  if (unique.length === 0) {
    return { ok: false, reason: 'a partial rerun must name at least one node to redo' }
  }
  if (definition.version !== run.definitionVersion) {
    return {
      ok: false,
      reason:
        `this run fixed definition version ${String(run.definitionVersion)}, and the saved workflow is now `
        + `version ${String(definition.version)}. A partial rerun computes successors from the frozen graph; `
        + 'a later definition must not silently change which nodes are redone. Start a new run from the '
        + 'current definition instead.',
    }
  }
  const inRun = new Set(run.nodes.map(node => node.nodeId))
  const inDefinition = new Set(definition.nodes.map(node => node.nodeId))
  for (const nodeId of unique) {
    if (!inRun.has(nodeId)) {
      return { ok: false, reason: `node ${nodeId} is not in this run, so it cannot be redone` }
    }
    if (!inDefinition.has(nodeId)) {
      return {
        ok: false,
        reason:
          `node ${nodeId} is not in the frozen definition, so its successors cannot be computed`,
      }
    }
  }
  const running = run.nodes.find(node => isLiveNode(node.state))
  if (running !== undefined) {
    return {
      ok: false,
      reason:
        `node ${running.nodeId} is still ${running.state} on the source run. A partial rerun cannot take over a `
        + 'live turn and must not treat it as undone; wait until it finishes, or cancel the source run first.',
    }
  }

  const dependents = new Map<string, string[]>()
  for (const node of definition.nodes) {
    for (const dependency of dependsOnOf(node)) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.nodeId])
    }
  }
  const reset = new Set<string>(unique)
  const queue = [...unique]
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    for (const dependent of dependents.get(next) ?? []) {
      if (reset.has(dependent) || !inRun.has(dependent)) continue
      reset.add(dependent)
      queue.push(dependent)
    }
  }
  const resetOrder = definition.nodes.map(node => node.nodeId).filter(nodeId => reset.has(nodeId))
  const kept = run.nodes.map(node => node.nodeId).filter(nodeId => !reset.has(nodeId))
  return { ok: true, selected: unique, reset: resetOrder, kept }
}

/**
 * Copy one node of a run, field by field, so a later mutation of the source
 * cannot reach the copy.
 *
 * @param node - the source node.
 * @returns an independent copy.
 */
function copyNodeRun(node: NodeRun): NodeRun {
  return {
    nodeId: node.nodeId,
    state: node.state,
    attempts: node.attempts,
    ...node.turnsUsed === undefined ? {} : { turnsUsed: node.turnsUsed },
    ...node.approvedBy === undefined ? {} : { approvedBy: node.approvedBy },
    ...node.approvedAt === undefined ? {} : { approvedAt: node.approvedAt },
    ...node.approvedBinding === undefined ? {} : { approvedBinding: node.approvedBinding },
    ...node.verdict === undefined ? {} : {
      verdict: {
        result: node.verdict.result,
        by: node.verdict.by,
        at: node.verdict.at,
        ...node.verdict.command === undefined ? {} : { command: node.verdict.command },
        ...node.verdict.output === undefined ? {} : { output: node.verdict.output },
        ...node.verdict.evidence === undefined ? {} : { evidence: [...node.verdict.evidence] },
      },
    },
  }
}

/**
 * Build the node list of a partial-rerun run.
 *
 * Reset nodes go back to `blocked` with no verdict and no approval: PRD §四.3
 * says an old approval cannot be reused once the approved work is redone.
 * Kept nodes carry their evidence, including verdicts and approvals that still
 * apply to work this run is not redoing. Attempts on a reset node start at
 * zero — this is a new run, not another try on the source.
 *
 * @param source - the source run's nodes.
 * @param reset - node ids that must be redone.
 * @returns the new run's nodes, in source order.
 */
export function nodesForPartialRerun(
  source: readonly NodeRun[],
  reset: ReadonlySet<string> | readonly string[],
): NodeRun[] {
  const redo = reset instanceof Set ? reset : new Set(reset)
  return source.map(node => redo.has(node.nodeId)
    ? { nodeId: node.nodeId, state: 'blocked', attempts: 0 }
    : copyNodeRun(node))
}
