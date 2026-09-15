import { describe, expect, it } from 'vitest'
import {
  afterNodeFailure,
  applyReworkRound,
  approveNode,
  approvalBindingOf,
  approvalStillApplies,
  budgetPolicyText,
  cancelUnfinishedNodes,
  canonicalNodeState,
  consumesRework,
  definitionFromFixed,
  definitionViewOf,
  fixedDrift,
  frozenFailureOf,
  isAcceptance,
  isStartable,
  isUserAcceptance,
  nodeReadiness,
  nodesForPartialRerun,
  openReworkRound,
  overlayNodeFromTarget,
  planPartialRerun,
  recordVerdict,
  runHasSettled,
  runViewOf,
  turnsToStopOnWorkflowCancel,
  validateDefinition,
  verdictRuleRefusal,
  verdictRefusal,
  type AcceptanceVerdict,
  type NodeRun,
  type RunFixed,
  type RunObserved,
  type ReadinessFacts,
  type WorkflowDefinition,
  type WorkflowRun,
} from '../src/service/workflow.ts'
import { DEFAULTS } from '../src/domain/defaults.ts'

const AT = '2026-09-13T00:00:00.000Z'

/** A definition with the members a test cares about overridden. */
function definition(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    workflowId: 'wf-1',
    title: 'ship the feature',
    version: 1,
    nodes: [
      { nodeId: 'design', taskId: 'task-design' },
      { nodeId: 'build', taskId: 'task-build', dependsOn: ['design'] },
      { nodeId: 'verify', taskId: 'task-verify', dependsOn: ['build'] },
    ],
    ...over,
  }
}

/** A node run. */
/**
 * A node in a run.
 *
 * A `passed` node carries the verdict that earned it, because the state alone is no longer
 * enough to open the downstream gate: PRD §二.12's condition 1 asks for acceptance, and a state
 * claiming acceptance with no recorded decision behind it is the claim-without-evidence this
 * fixture must not accidentally model.
 */
function node(nodeId: string, state: NodeRun['state'], over: Partial<NodeRun> = {}): NodeRun {
  const implied = state === 'passed'
    ? { verdict: verdict() }
    : {}
  return { nodeId, state, attempts: 1, ...implied, ...over }
}

/** A run with the given node states. */
function run(nodes: NodeRun[], over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: 'run-1',
    workflowId: 'wf-1',
    definitionVersion: 1,
    status: 'running',
    reworkRoundsUsed: 0,
    reworkHistory: [],
    nodes,
    ...over,
  }
}

/** Facts where everything is fine, with overrides. */
function facts(over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    artifactReady: () => true,
    authorized: true,
    environmentReady: true,
    capacityAvailable: true,
    approved: true,
    ...over,
  }
}

/** A verdict. */
function verdict(over: Partial<AcceptanceVerdict> = {}): AcceptanceVerdict {
  return { result: 'pass', by: 'user', at: AT, ...over }
}

describe('validating a workflow definition (PRD §二.12)', () => {
  it('accepts an acyclic definition and returns a usable order', () => {
    const checked = validateDefinition(definition())
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.order.indexOf('design')).toBeLessThan(checked.order.indexOf('build'))
    expect(checked.order.indexOf('build')).toBeLessThan(checked.order.indexOf('verify'))
  })

  it('refuses a dependency cycle, and says rework is not the way to express going backwards', () => {
    // "A may send B back to work" as an edge A→B→A would make ordering meaningless.
    const checked = validateDefinition(definition({
      nodes: [
        { nodeId: 'a', taskId: 'ta', dependsOn: ['b'] },
        { nodeId: 'b', taskId: 'tb', dependsOn: ['a'] },
      ],
    }))
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.problems[0]?.code).toBe('CYCLE')
    expect(checked.problems[0]?.message).toMatch(/rework is expressed by the bounded rework mechanism/)
  })

  it('reports every problem rather than only the first', () => {
    const checked = validateDefinition(definition({
      nodes: [
        { nodeId: 'a', taskId: '' },
        { nodeId: 'a', taskId: 'ta', dependsOn: ['missing'] },
      ],
    }))
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    const codes = checked.problems.map(problem => problem.code)
    expect(codes).toContain('DUPLICATE_NODE')
    expect(codes).toContain('NO_TASK')
    expect(codes).toContain('UNKNOWN_DEPENDENCY')
  })

  it('refuses an empty definition', () => {
    const checked = validateDefinition(definition({ nodes: [] }))
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.problems[0]?.code).toBe('EMPTY')
  })

  it('refuses a node that depends on itself', () => {
    const checked = validateDefinition(definition({
      nodes: [{ nodeId: 'a', taskId: 'ta', dependsOn: ['a'] }],
    }))
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.problems.map(problem => problem.code)).toContain('SELF_DEPENDENCY')
  })

  it('refuses a rework limit that is not a whole number of rounds', () => {
    for (const maxRounds of [-1, 1.5]) {
      const checked = validateDefinition(definition({ rework: { maxRounds } }))
      expect(checked.ok).toBe(false)
      if (checked.ok) return
      expect(checked.problems.map(problem => problem.code)).toContain('BAD_REWORK_LIMIT')
    }
  })

  it('accepts a diamond, where two nodes share an upstream', () => {
    const checked = validateDefinition(definition({
      nodes: [
        { nodeId: 'a', taskId: 'ta' },
        { nodeId: 'b', taskId: 'tb', dependsOn: ['a'] },
        { nodeId: 'c', taskId: 'tc', dependsOn: ['a'] },
        { nodeId: 'd', taskId: 'td', dependsOn: ['b', 'c'] },
      ],
    }))
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.order[checked.order.length - 1]).toBe('d')
  })
})

describe('what a run fixed (PRD §三.3)', () => {
  /** What a run fixed, with one run's worth of each entry. */
  const fixed: RunFixed = {
    definitionVersion: 3,
    authorisations: [{ taskId: 'task-design', ownerSessionId: 'session-a', ownerEpoch: 1 }],
    constraints: [{ constraintId: 'c-1', version: 4 }],
    artifacts: [{ artifactId: 'a-1', contentVersion: 2 }],
    acceptance: [{ nodeId: 'design', rule: 'the interface document passes' }],
    budget: 'maxTurns=6',
  }
  /** The same world, unchanged. */
  const same: RunObserved = {
    definitionVersion: 3,
    authorisations: [{ taskId: 'task-design', ownerSessionId: 'session-a', ownerEpoch: 1 }],
    constraints: [{ constraintId: 'c-1', version: 4 }],
    artifacts: [{ artifactId: 'a-1', contentVersion: 2 }],
    budget: 'maxTurns=6',
  }

  it('refuses a verdict judged against a rule the run did not fix', () => {
    // The stored rule used to be display-only, so an edited definition silently redefined what
    // passing meant for a run already in flight.
    expect(verdictRuleRefusal('the interface document passes', 'the interface document passes')).toBeUndefined()
    // Whitespace is not a difference; a different rule is.
    expect(verdictRuleRefusal(' the same ', 'the same')).toBeUndefined()

    const unnamed = verdictRuleRefusal('the interface document passes', undefined)
    expect(unnamed).toMatch(/does not say which rule it was judged against/)
    expect(unnamed).toMatch(/cannot be checked against the one the run fixed/)

    const changed = verdictRuleRefusal('the interface document passes', 'looks good to me')
    expect(changed).toMatch(/judged against "looks good to me", and this run fixed "the interface document passes"/)
    expect(changed).toMatch(/start a new run to judge by a new rule/)

    // A node the run fixed no rule for is unconstrained: refusing there would invent a requirement.
    expect(verdictRuleRefusal('', undefined)).toBeUndefined()
  })

  it('reports no drift when everything the run fixed still holds', () => {
    expect(fixedDrift(fixed, same)).toBeUndefined()
  })

  it('stops the run when the live definition is no longer the version it fixed', () => {
    // The store overwrites the definition body. Dispatching after a save would send
    // the later instruction under a run that claimed to have fixed the earlier one.
    const moved = fixedDrift(fixed, { ...same, definitionVersion: 4 })
    expect(moved).toMatch(/workflow definition moved from version 3 to 4/)
    expect(moved).toMatch(/definition they never fixed/)
  })

  it('stops the run when control of a node\'s task moved after it started', () => {
    const moved = fixedDrift(fixed, {
      ...same,
      authorisations: [{ taskId: 'task-design', ownerSessionId: 'session-b', ownerEpoch: 2 }],
    })
    expect(moved).toMatch(/control of task task-design moved from session-a@1 to session-b@2/)
    expect(moved).toMatch(/no longer the one it started under/)
  })

  it('stops the run when a shared constraint moved version', () => {
    // This is the constraint-compatibility check PRD §二.13.1 asks for before an automatic
    // downstream start: it had no caller at all until the run started fixing its terms.
    const moved = fixedDrift(fixed, { ...same, constraints: [{ constraintId: 'c-1', version: 5 }] })
    expect(moved).toMatch(/constraint c-1 moved from version 4 to 5/)
    expect(moved).toMatch(/judged against a statement it never fixed/)
  })

  it('stops the run when an input artifact is no longer the input it fixed', () => {
    const changed = fixedDrift(fixed, { ...same, artifacts: [{ artifactId: 'a-1', contentVersion: 3 }] })
    expect(changed).toMatch(/input artifact a-1 moved from content version 2 to 3/)
    // And a removed input or a removed constraint is drift too, not silence.
    expect(fixedDrift(fixed, { ...same, artifacts: [] })).toMatch(/no longer recorded/)
    expect(fixedDrift(fixed, { ...same, constraints: [] })).toMatch(/was removed/)
    expect(fixedDrift(fixed, { ...same, authorisations: [] })).toMatch(/no longer has a control record/)
  })

  it('stops the run when the live budget policy is no longer the one it fixed', () => {
    expect(budgetPolicyText({ maxTurns: 6 })).toBe('maxTurns=6')
    expect(budgetPolicyText(undefined)).toBeUndefined()
    const moved = fixedDrift(fixed, { ...same, budget: 'maxTurns=1' })
    expect(moved).toMatch(/budget policy moved from maxTurns=6 to maxTurns=1/)
    expect(moved).toMatch(/gated by a limit it never fixed/)
    expect(fixedDrift(fixed, { ...same, budget: undefined })).toMatch(/no longer has a budget policy/)
    expect(fixedDrift({ ...fixed, budget: undefined }, { ...same, budget: 'maxTurns=6' }))
      .toMatch(/fixed no budget policy/)
  })

  it('rebuilds the definition a run executes from the graph it snapshotted', () => {
    const snapshotted = definitionFromFixed('wf-design', {
      ...fixed,
      graph: [{
        nodeId: 'design',
        taskId: 'task-design',
        dependsOn: [],
        instruction: 'draft the interface',
        acceptance: 'the interface document passes',
        requiresApproval: true,
      }],
      title: 'Design then build',
      rework: { maxRounds: 2 },
      budgetLimit: { maxTurns: 6 },
    }, 'fallback')
    expect(snapshotted).toEqual({
      workflowId: 'wf-design',
      title: 'Design then build',
      version: 3,
      nodes: [{
        nodeId: 'design',
        taskId: 'task-design',
        dependsOn: [],
        instruction: 'draft the interface',
        acceptance: 'the interface document passes',
        requiresApproval: true,
      }],
      rework: { maxRounds: 2 },
      budget: { maxTurns: 6 },
    })
    expect(definitionFromFixed('wf-design', fixed, 'fallback')).toBeUndefined()
  })

  it('does not stop a snapshotted run when the live definition version or budget moves', () => {
    // The snapshot *is* the body this run executes. Stopping it would hand the
    // user a run that can no longer dispatch the instruction it already fixed.
    const snapshotted: RunFixed = {
      ...fixed,
      graph: [{ nodeId: 'design', taskId: 'task-design', instruction: 'draft the interface' }],
    }
    expect(fixedDrift(snapshotted, { ...same, definitionVersion: 4 })).toBeUndefined()
    expect(fixedDrift(snapshotted, { ...same, budget: 'maxTurns=1' })).toBeUndefined()
    // Auth, constraints and artifacts still stop it: those are not in the graph.
    expect(fixedDrift(snapshotted, { ...same, constraints: [{ constraintId: 'c-1', version: 5 }] }))
      .toMatch(/constraint c-1 moved from version 4 to 5/)
  })
})

describe('reading a workflow (PRD §二.12, §三.3)', () => {
  it('returns the structured definition, not a node count', () => {
    const view = definitionViewOf(definition({
      nodes: [{
        nodeId: 'design',
        taskId: 'task-design',
        instruction: 'draft the interface',
        acceptance: 'the interface document passes',
        requiresApproval: true,
      }],
      rework: { maxRounds: 2 },
      budget: { maxTurns: 6 },
    }), 'active')
    expect(view.nodes).toEqual([{
      nodeId: 'design',
      taskId: 'task-design',
      instruction: 'draft the interface',
      acceptance: 'the interface document passes',
      requiresApproval: true,
    }])
    expect(view.rework).toEqual({ maxRounds: 2 })
    expect(view.budget).toEqual({ maxTurns: 6 })
    expect(view.status).toBe('active')
  })

  it('shows the snapshotted instruction on a frozen run, not a later live body', () => {
    const started = definition({
      version: 3,
      nodes: [{ nodeId: 'design', taskId: 'task-design', instruction: 'draft the interface' }],
    })
    const later = definition({
      version: 4,
      nodes: [{ nodeId: 'design', taskId: 'task-design', instruction: 'rewrite the interface' }],
    })
    const frozen = runViewOf(run([node('design', 'blocked')]), started, { frozen: true })
    expect(frozen.frozen).toBe(true)
    expect(frozen.nodes[0]?.instruction).toBe('draft the interface')
    expect(frozen.nodes[0]?.taskId).toBe('task-design')
    // Overlaying the later save would be the silent change `read` must not perform.
    const live = runViewOf(run([node('design', 'blocked')]), later, { frozen: false })
    expect(live.frozen).toBe(false)
    expect(live.nodes[0]?.instruction).toBeUndefined()
    expect(live.nodes[0]?.taskId).toBeUndefined()
  })

  it('carries the verdict and approval on the node that recorded them', () => {
    const view = runViewOf(
      run([node('design', 'validating', {
        verdict: verdict({ result: 'inconclusive', by: 'model_review' }),
        approvedBy: 'session-a',
      })]),
      undefined,
      { frozen: false },
    )
    expect(view.nodes[0]?.verdict).toEqual({ result: 'inconclusive', by: 'model_review', at: AT })
    expect(view.nodes[0]?.approvedBy).toBe('session-a')
  })
})

describe('the six start conditions (PRD §二.12)', () => {
  it('reports every condition, not only the failing one', () => {
    const readiness = nodeReadiness(definition(), run([node('design', 'passed'), node('build', 'blocked')]), 'build', facts())
    expect(readiness.ready).toBe(true)
    expect(readiness.conditions.map(condition => condition.condition)).toEqual([
      'upstream_accepted', 'inputs_pinned', 'authorized', 'environment_ready', 'capacity_and_budget', 'approvals',
    ])
  })

  it('refuses to start a node whose upstream has not passed acceptance', () => {
    const readiness = nodeReadiness(definition(), run([node('design', 'running'), node('build', 'blocked')]), 'build', facts())
    expect(readiness.ready).toBe(false)
    const upstream = readiness.conditions.find(condition => condition.condition === 'upstream_accepted')
    expect(upstream?.satisfied).toBe(false)
    expect(upstream?.reason).toMatch(/design/)
  })

  it('treats a failed upstream as not accepted, so the node waits', () => {
    const readiness = nodeReadiness(definition(), run([node('design', 'failed'), node('build', 'blocked')]), 'build', facts())
    expect(readiness.ready).toBe(false)
  })

  it('does not let a model review stand in for acceptance', () => {
    // PRD §二.12: "主观模型审阅明确标注为模型判断，不能冒充用户验收". A review that says pass is
    // recorded as `validating` — so the downstream node stays stopped, and the reason says why.
    const reviewed = recordVerdict(run([node('design', 'running'), node('build', 'blocked')]), 'design', verdict({ by: 'model_review' }))
    expect(reviewed.nodes.find(entry => entry.nodeId === 'design')?.state).toBe('validating')

    const readiness = nodeReadiness(definition(), reviewed, 'build', facts())
    expect(readiness.ready).toBe(false)
    const upstream = readiness.conditions.find(condition => condition.condition === 'upstream_accepted')
    expect(upstream?.satisfied).toBe(false)
    expect(upstream?.reason).toMatch(/reviewed by the model, which is a judgement and not acceptance/)
  })

  it('lets the user, or a deterministic check with its command and result, open the gate', () => {
    const userAccepted = recordVerdict(run([node('design', 'running'), node('build', 'blocked')]), 'design', verdict())
    expect(userAccepted.nodes.find(entry => entry.nodeId === 'design')?.state).toBe('passed')
    expect(nodeReadiness(definition(), userAccepted, 'build', facts()).ready).toBe(true)

    const checked = recordVerdict(
      run([node('design', 'running'), node('build', 'blocked')]),
      'design',
      verdict({ by: 'deterministic_check', command: 'npm test', output: 'passing' }),
    )
    expect(checked.nodes.find(entry => entry.nodeId === 'design')?.state).toBe('passed')
    expect(nodeReadiness(definition(), checked, 'build', facts()).ready).toBe(true)
  })

  it('refuses a deterministic check that names no command or no result', () => {
    // The other half of the same sentence: a check must record "真实命令、结果和证据". Without them
    // it is an opinion wearing a check's label, so it is refused at the boundary.
    expect(verdictRefusal(verdict({ by: 'deterministic_check' }))).toMatch(/must record the command it actually ran/)
    expect(verdictRefusal(verdict({ by: 'deterministic_check', command: 'npm test' })))
      .toMatch(/must record what the command actually returned/)
    expect(verdictRefusal(verdict({ by: 'deterministic_check', command: 'npm test', output: 'ok' }))).toBeUndefined()
    // A user's own verdict needs no command: it is a decision, not a measurement.
    expect(verdictRefusal(verdict())).toBeUndefined()
    expect(verdictRefusal(verdict({ by: 'model_review' }))).toBeUndefined()
  })

  it('refuses to start a node whose recorded approval is missing', () => {
    // Condition 6 is read from the run. Before this, the gate was handed a hardcoded `true`, so the
    // condition could never fail and a node declaring `requiresApproval` started immediately.
    const gated = definition({
      nodes: [
        { nodeId: 'design', taskId: 'ta' },
        { nodeId: 'ship', taskId: 'tb', dependsOn: ['design'], requiresApproval: true },
      ],
    })
    const states = run([node('design', 'passed'), node('ship', 'blocked')])
    const withoutApproval = nodeReadiness(gated, states, 'ship', facts({ approved: false }))
    expect(withoutApproval.ready).toBe(false)
    const approvals = withoutApproval.conditions.find(condition => condition.condition === 'approvals')
    expect(approvals?.reason).toMatch(/requires an approval that has not been given/)
    expect(nodeReadiness(gated, states, 'ship', facts({ approved: true })).ready).toBe(true)
  })

  it('records an approval only for a blocked or ready node that asked for one, and only once', () => {
    const gated = definition({
      nodes: [
        { nodeId: 'design', taskId: 'ta' },
        { nodeId: 'ship', taskId: 'tb', dependsOn: ['design'], requiresApproval: true },
      ],
    })
    const states = run([node('design', 'passed'), node('ship', 'blocked')])

    const approved = approveNode(gated, states, 'ship', 'controller', AT)
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    const entry = approved.run.nodes.find(candidate => candidate.nodeId === 'ship')
    expect(entry?.approvedBy).toBe('controller')
    expect(entry?.approvedAt).toBe(AT)
    const ship = gated.nodes.find(candidate => candidate.nodeId === 'ship')
    expect(ship).toBeDefined()
    if (ship === undefined) return
    expect(entry?.approvedBinding).toBe(approvalBindingOf(ship, 1))
    // Approving a second time would rewrite who decided.
    const again = approveNode(gated, approved.run, 'ship', 'someone-else', AT)
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.reason).toMatch(/already approved by controller/)

    // A node that asks for no approval must not accumulate one: a decision nobody asked for would
    // make an ungated node look gated.
    const ungated = approveNode(gated, states, 'design', 'controller', AT)
    expect(ungated.ok).toBe(false)
    if (ungated.ok) return
    expect(ungated.reason).toMatch(/does not require an approval/)

    // Approving work that already happened is not "必需审批已满足".
    const running = approveNode(gated, run([node('design', 'passed'), { nodeId: 'ship', state: 'running', attempts: 1 }]), 'ship', 'controller', AT)
    expect(running.ok).toBe(false)
    if (running.ok) return
    expect(running.reason).toMatch(/already happened rather than permitting it/)

    const unknown = approveNode(gated, states, 'nope', 'controller', AT)
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.reason).toMatch(/is not in workflow wf-1/)
  })

  it('refuses an approval against a later definition than the run fixed', () => {
    const gated = definition({
      version: 2,
      nodes: [
        { nodeId: 'design', taskId: 'ta' },
        { nodeId: 'ship', taskId: 'tb', dependsOn: ['design'], requiresApproval: true },
      ],
    })
    const decision = approveNode(
      gated,
      run([node('design', 'passed'), node('ship', 'blocked')]),
      'ship',
      'controller',
      AT,
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).toMatch(/fixed definition version 1/)
    expect(decision.reason).toMatch(/live definition is version 2/)
  })

  it('does not reuse an approval after the approved action is expanded (PRD §四.3)', () => {
    const original = definition({
      nodes: [
        { nodeId: 'design', taskId: 'ta' },
        {
          nodeId: 'ship',
          taskId: 'tb',
          dependsOn: ['design'],
          requiresApproval: true,
          instruction: 'deploy to staging',
        },
      ],
    })
    const states = run([node('design', 'passed'), node('ship', 'blocked')])
    const approved = approveNode(original, states, 'ship', 'controller', AT)
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    const ship = original.nodes.find(candidate => candidate.nodeId === 'ship')
    expect(ship).toBeDefined()
    if (ship === undefined) return
    const entry = approved.run.nodes.find(candidate => candidate.nodeId === 'ship')
    expect(approvalStillApplies(entry, ship, 1)).toBe(true)

    const expanded = definition({
      nodes: [
        { nodeId: 'design', taskId: 'ta' },
        {
          nodeId: 'ship',
          taskId: 'tb',
          dependsOn: ['design'],
          requiresApproval: true,
          instruction: 'deploy to production',
        },
      ],
    })
    const expandedShip = expanded.nodes.find(candidate => candidate.nodeId === 'ship')
    expect(expandedShip).toBeDefined()
    if (expandedShip === undefined) return
    expect(approvalStillApplies(entry, expandedShip, 1)).toBe(false)

    const readiness = nodeReadiness(expanded, approved.run, 'ship', facts({ approved: true }))
    expect(readiness.ready).toBe(false)
    const approvals = readiness.conditions.find(condition => condition.condition === 'approvals')
    expect(approvals?.satisfied).toBe(false)
    expect(approvals?.reason).toMatch(/cannot be reused/)
  })

  it('refuses a node whose input artifacts are not pinned and accessible', () => {
    const withInputs = definition({
      nodes: [
        { nodeId: 'design', taskId: 'ta' },
        { nodeId: 'build', taskId: 'tb', dependsOn: ['design'], inputArtifacts: ['artifact-1', 'artifact-2'] },
      ],
    })
    const readiness = nodeReadiness(withInputs, run([node('design', 'passed'), node('build', 'blocked')]), 'build', facts({
      artifactReady: artifactId => artifactId === 'artifact-1',
    }))
    expect(readiness.ready).toBe(false)
    const inputs = readiness.conditions.find(condition => condition.condition === 'inputs_pinned')
    expect(inputs?.reason).toMatch(/artifact-2/)
    expect(inputs?.reason).not.toMatch(/artifact-1/)
  })

  it('refuses on an expired authorisation, an unavailable environment, no capacity, or a missing approval', () => {
    const upstreamOk = run([node('design', 'passed'), node('build', 'blocked')])
    const cases: [Partial<ReadinessFacts>, string][] = [
      [{ authorized: false }, 'authorized'],
      [{ environmentReady: false }, 'environment_ready'],
      [{ capacityAvailable: false }, 'capacity_and_budget'],
    ]
    for (const [override, expected] of cases) {
      // PRD §二.12's start list has six quite different reasons for "not ready", and
      // they are not interchangeable: an expired authorisation and a busy host call
      // for opposite responses.
      const readiness = nodeReadiness(definition(), upstreamOk, 'build', facts(override))
      expect(readiness.ready).toBe(false)
      expect(readiness.conditions.find(condition => condition.condition === expected)?.satisfied).toBe(false)
    }

    const approvalNeeded = definition({
      nodes: [
        { nodeId: 'design', taskId: 'ta' },
        { nodeId: 'build', taskId: 'tb', dependsOn: ['design'], requiresApproval: true },
      ],
    })
    const blocked = nodeReadiness(approvalNeeded, upstreamOk, 'build', facts({ approved: false }))
    expect(blocked.ready).toBe(false)
    expect(blocked.conditions.find(condition => condition.condition === 'approvals')?.reason).toMatch(/has not been given/)
    // And it is satisfied once the approval arrives.
    expect(nodeReadiness(approvalNeeded, upstreamOk, 'build', facts()).ready).toBe(true)
  })

  it('stops another node of this run when the definition\'s maxConcurrent is already occupied', () => {
    const parallel = definition({
      budget: { maxConcurrent: 1 },
      nodes: [
        { nodeId: 'a', taskId: 'ta' },
        { nodeId: 'b', taskId: 'tb' },
      ],
    })
    const oneLive = run([node('a', 'running'), node('b', 'blocked')])
    const blocked = nodeReadiness(parallel, oneLive, 'b', facts())
    expect(blocked.ready).toBe(false)
    const capacity = blocked.conditions.find(condition => condition.condition === 'capacity_and_budget')
    expect(capacity?.reason).toMatch(/already has 1 live node/)
    expect(capacity?.reason).toMatch(/limits concurrency to 1/)
    // A finished node does not occupy the slot.
    const afterPass = run([node('a', 'passed'), node('b', 'blocked')])
    expect(nodeReadiness(parallel, afterPass, 'b', facts()).ready).toBe(true)
    // Absent cap does not invent one.
    expect(nodeReadiness(definition({
      nodes: [
        { nodeId: 'a', taskId: 'ta' },
        { nodeId: 'b', taskId: 'tb' },
      ],
    }), oneLive, 'b', facts()).ready).toBe(true)
    expect(budgetPolicyText({ maxTurns: 6, maxConcurrent: 1 })).toBe('maxTurns=6, maxConcurrent=1')
    expect(budgetPolicyText({ maxTurns: 6 })).toBe('maxTurns=6')
  })

  it('says a node with no inputs consumes no artifacts, rather than reporting an empty success', () => {
    const readiness = nodeReadiness(definition(), run([node('design', 'passed'), node('build', 'blocked')]), 'build', facts())
    expect(readiness.conditions.find(condition => condition.condition === 'inputs_pinned')?.reason)
      .toBe('the node consumes no artifacts')
  })

  it('refuses an unknown node instead of answering about it', () => {
    const readiness = nodeReadiness(definition(), run([]), 'not-a-node', facts())
    expect(readiness.ready).toBe(false)
    expect(readiness.conditions[0]?.reason).toMatch(/not in this workflow/)
  })
})

describe('acceptance verdicts (PRD §二.12)', () => {
  it('records pass as passed, fail as failed, and inconclusive as still validating', () => {
    for (const [result, state] of [['pass', 'passed'], ['fail', 'failed'], ['inconclusive', 'validating']] as const) {
      const updated = recordVerdict(run([node('build', 'running')]), 'build', verdict({ result }))
      expect(updated.nodes[0]?.state).toBe(state)
      expect(updated.nodes[0]?.verdict?.result).toBe(result)
    }
  })

  it('never lets a model review count as user acceptance', () => {
    // PRD §二.12: a subjective model review is labelled model judgement and must not
    // pass itself off as the user's acceptance.
    expect(isUserAcceptance(verdict({ by: 'model_review' }))).toBe(false)
    expect(isUserAcceptance(verdict({ by: 'deterministic_check' }))).toBe(false)
    expect(isUserAcceptance(verdict({ by: 'user' }))).toBe(true)
    // And a model review that failed is not acceptance however it is read.
    expect(isUserAcceptance(verdict({ by: 'user', result: 'fail' }))).toBe(false)
  })

  it('separates "counts as acceptance" from "the user accepted it"', () => {
    // Two different questions with two different answers, kept apart on purpose: a deterministic
    // check is objective evidence and satisfies the upstream gate, while only the user's own verdict
    // is user acceptance. Collapsing them is what the specification's wording forbids.
    const checked = verdict({ by: 'deterministic_check', command: 'pnpm test', output: 'all passing' })
    expect(isAcceptance(checked)).toBe(true)
    expect(isUserAcceptance(checked)).toBe(false)
    expect(isAcceptance(verdict({ by: 'model_review' }))).toBe(false)
    expect(isAcceptance(verdict({ by: 'user', result: 'inconclusive' }))).toBe(false)
  })

  it('keeps the evidence a deterministic check recorded', () => {
    const updated = recordVerdict(run([node('verify', 'running')]), 'verify', verdict({
      result: 'fail', by: 'deterministic_check', command: 'pnpm test', output: '1 failed', evidence: ['report.xml'],
    }))
    const recorded = updated.nodes[0]?.verdict
    expect(recorded?.command).toBe('pnpm test')
    expect(recorded?.output).toBe('1 failed')
    expect(recorded?.evidence).toEqual(['report.xml'])
  })
})

describe('bounded rework (PRD §二.12)', () => {
  it('allows two rounds by default and refuses the third', () => {
    expect(DEFAULTS.reworkRounds).toBe(2)
    const first = openReworkRound(run([node('build', 'failed')]), ['build'])
    expect(first.allowed).toBe(true)
    expect(first.round).toBe(1)

    const second = openReworkRound(
      run([node('build', 'failed')], { reworkRoundsUsed: DEFAULTS.reworkRounds - 1 }),
      ['build'],
    )
    expect(second.allowed).toBe(true)
    expect(second.round).toBe(DEFAULTS.reworkRounds)

    const third = openReworkRound(
      run([node('build', 'failed')], { reworkRoundsUsed: DEFAULTS.reworkRounds }),
      ['build'],
    )
    expect(third.allowed).toBe(false)
    expect(third.reason).toMatch(/Starting another workflow to get more room would evade the limit/)
  })

  it('honours an explicit limit instead of the published default', () => {
    const first = openReworkRound(run([node('build', 'failed')]), ['build'], 1)
    expect(first.allowed).toBe(true)
    expect(first.round).toBe(1)

    const second = openReworkRound(run([node('build', 'failed')], { reworkRoundsUsed: 1 }), ['build'], 1)
    expect(second.allowed).toBe(false)
    expect(second.reason).toMatch(/used all 1 rework round/)
  })

  it('does not count the initial execution as a round', () => {
    // The counter starts at zero for a run that has executed once.
    expect(run([node('build', 'failed')]).reworkRoundsUsed).toBe(0)
    expect(openReworkRound(run([node('build', 'failed')]), ['build']).round).toBe(1)
  })

  it('refuses a round that names the same node twice', () => {
    // One round may redo several nodes, but each node at most once within the round.
    const decision = openReworkRound(run([node('build', 'failed')]), ['build', 'build'])
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/at most once per round/)
  })

  it('allows several different nodes in one round', () => {
    const decision = openReworkRound(run([node('build', 'failed'), node('verify', 'failed')]), ['build', 'verify'])
    expect(decision.allowed).toBe(true)
    expect(decision.round).toBe(1)
  })

  it('refuses a round with nothing to redo', () => {
    expect(openReworkRound(run([]), []).allowed).toBe(false)
  })

  it('sends the nodes back to blocked and clears the stale verdict', () => {
    // Keeping the old verdict would let a stale `pass` satisfy a downstream node that
    // has not yet seen the reworked output.
    const before = run([node('build', 'failed', { verdict: verdict({ result: 'fail' }) })])
    const decision = openReworkRound(before, ['build'])
    const after = applyReworkRound(before, decision, ['build'])
    expect(after.nodes[0]?.state).toBe('blocked')
    expect(after.nodes[0]?.verdict).toBeUndefined()
    expect(after.reworkRoundsUsed).toBe(1)
    expect(after.reworkHistory).toEqual([['build']])
    // Attempts are kept: the node was tried, and forgetting that would lose the count
    // the budget needs.
    expect(after.nodes[0]?.attempts).toBe(1)
  })

  it('does nothing when handed a refused decision', () => {
    const before = run([node('build', 'failed')], { reworkRoundsUsed: 2 })
    const after = applyReworkRound(before, openReworkRound(before, ['build']), ['build'])
    expect(after).toBe(before)
  })
})

describe('what a failed node means for the run (PRD §二.12)', () => {
  it('opens a rework round for a failed node while rounds remain', () => {
    const outcome = afterNodeFailure(run([node('build', 'failed')]), 'build')
    expect(outcome.run.status).toBe('running')
    expect(outcome.run.reworkRoundsUsed).toBe(1)
    expect(outcome.run.nodes[0]?.state).toBe('blocked')
  })

  it('hands a failed node to the user once the rounds are spent', () => {
    const outcome = afterNodeFailure(
      run([node('build', 'failed')], { reworkRoundsUsed: DEFAULTS.reworkRounds }),
      'build',
    )
    expect(outcome.run.status).toBe('needs_user')
    expect(outcome.reason).toMatch(new RegExp(`used all ${String(DEFAULTS.reworkRounds)} rework round`))
  })

  it('hands a failed node to the user at an explicit limit below the published default', () => {
    const outcome = afterNodeFailure(run([node('build', 'failed')], { reworkRoundsUsed: 1 }), 'build', 1)
    expect(outcome.run.status).toBe('needs_user')
    expect(outcome.reason).toMatch(/used all 1 rework round/)
  })

  it('never retries an inconclusive verdict, because retrying an unknown learns nothing', () => {
    const outcome = afterNodeFailure(run([node('verify', 'validating', { verdict: verdict({ result: 'inconclusive' }) })]), 'verify')
    expect(outcome.run.status).toBe('needs_user')
    expect(outcome.run.reworkRoundsUsed).toBe(0)
    expect(outcome.reason).toMatch(/retrying an unknown result/)
  })

  it('does not open a round for a node that is not part of the run', () => {
    const outcome = afterNodeFailure(run([]), 'ghost')
    expect(outcome.reason).toMatch(/not part of this run/)
  })

  it('counts a task retry against rework but not a message retry', () => {
    expect(consumesRework('task_retry')).toBe(true)
    expect(consumesRework('message_retry')).toBe(false)
  })

  it('honours stop without opening a rework round', () => {
    const outcome = afterNodeFailure(run([node('build', 'failed')]), 'build', 2, { onFail: 'stop' })
    expect(outcome.run.status).toBe('needs_user')
    expect(outcome.run.reworkRoundsUsed).toBe(0)
    expect(outcome.run.nodes[0]?.state).toBe('failed')
    expect(outcome.reason).toMatch(/failure policy is stop/)
  })

  it('honours continue without consuming a rework round or clearing the failure', () => {
    const outcome = afterNodeFailure(run([node('build', 'failed')]), 'build', 2, { onFail: 'continue' })
    expect(outcome.run.status).toBe('running')
    expect(outcome.run.reworkRoundsUsed).toBe(0)
    expect(outcome.run.nodes[0]?.state).toBe('failed')
    expect(outcome.reason).toMatch(/failure policy is continue/)
  })

  it('counts a node retry as rework and stops at the node\'s own retry allowance', () => {
    const once = afterNodeFailure(
      run([node('build', 'failed', { attempts: 1 })]),
      'build',
      2,
      { onFail: 'retry', retries: 1 },
    )
    expect(once.run.status).toBe('running')
    expect(once.run.reworkRoundsUsed).toBe(1)
    expect(once.run.nodes[0]?.state).toBe('blocked')
    expect(once.run.nodes[0]?.verdict).toBeUndefined()

    const spent = afterNodeFailure(
      run([node('build', 'failed', { attempts: 2 })], { reworkRoundsUsed: 1 }),
      'build',
      2,
      { onFail: 'retry', retries: 1 },
    )
    expect(spent.run.reworkRoundsUsed).toBe(1)
    expect(spent.run.nodes[0]?.state).toBe('failed')
    expect(spent.run.status).toBe('needs_user')
  })

  it('never uses a high node retry setting to bypass the whole-workflow rework ceiling', () => {
    const exhausted = afterNodeFailure(
      run([node('build', 'failed', { attempts: 3 })], { reworkRoundsUsed: 2 }),
      'build', 2, { onFail: 'retry', retries: 100 },
    )
    expect(exhausted.run.status).toBe('needs_user')
    expect(exhausted.run.reworkRoundsUsed).toBe(2)
    expect(exhausted.run.nodes[0]?.state).toBe('failed')
  })

  it('does not silently open rework when a node explicitly authorises zero retries', () => {
    const stopped = afterNodeFailure(run([node('build', 'failed')]), 'build', 2, { onFail: 'retry', retries: 0 })
    expect(stopped.run.status).toBe('needs_user')
    expect(stopped.run.reworkRoundsUsed).toBe(0)
  })

  it('still treats inconclusive as needs_user even when onFail is retry', () => {
    const outcome = afterNodeFailure(
      run([node('verify', 'validating', { verdict: verdict({ result: 'inconclusive' }) })]),
      'verify',
      2,
      { onFail: 'retry', retries: 3 },
    )
    expect(outcome.run.status).toBe('needs_user')
    expect(outcome.run.reworkRoundsUsed).toBe(0)
  })

  it('reads the frozen failure policy for that node only', () => {
    const fixed: RunFixed = {
      definitionVersion: 1,
      authorisations: [],
      constraints: [],
      artifacts: [],
      acceptance: [],
      failure: [
        { nodeId: 'build', onFail: 'stop' },
        { nodeId: 'verify', onFail: 'retry', retries: 2 },
      ],
    }
    expect(frozenFailureOf(fixed, 'build')).toEqual({ onFail: 'stop' })
    expect(frozenFailureOf(fixed, 'verify')).toEqual({ onFail: 'retry', retries: 2 })
    expect(frozenFailureOf(fixed, 'design')).toBeUndefined()
    expect(frozenFailureOf(undefined, 'build')).toBeUndefined()
  })
})

describe('whether a run has settled after continue (PRD §二.12)', () => {
  it('is settled when remaining nodes are blocked behind a failure', () => {
    expect(runHasSettled(definition(), run([
      node('design', 'passed'),
      node('build', 'failed'),
      node('verify', 'blocked', { attempts: 0 }),
    ]))).toBe(true)
  })

  it('is not settled while an independent sibling can still start', () => {
    const parallel = definition({
      nodes: [
        { nodeId: 'a', taskId: 'task-a' },
        { nodeId: 'b', taskId: 'task-b' },
      ],
    })
    expect(runHasSettled(parallel, run([
      node('a', 'failed'),
      node('b', 'blocked', { attempts: 0 }),
    ]))).toBe(false)
  })

  it('is not settled while a node is still live', () => {
    expect(runHasSettled(definition(), run([
      node('design', 'passed'),
      node('build', 'running'),
      node('verify', 'blocked', { attempts: 0 }),
    ]))).toBe(false)
  })
})

describe('workflow cancel stops associated running turns (PRD §四.4)', () => {
  it('names each running node\'s task once, in definition order', () => {
    expect(turnsToStopOnWorkflowCancel(
      [
        { nodeId: 'design', state: 'passed' },
        { nodeId: 'build', state: 'running' },
        { nodeId: 'verify', state: 'running' },
        { nodeId: 'also-build', state: 'running' },
      ],
      [
        { nodeId: 'design', taskId: 'task-design' },
        { nodeId: 'build', taskId: 'task-build' },
        { nodeId: 'verify', taskId: 'task-verify' },
        { nodeId: 'also-build', taskId: 'task-build' },
      ],
    )).toEqual(['task-build', 'task-verify'])
  })

  it('asks for no stop when nothing is running — pause must not invent one', () => {
    expect(turnsToStopOnWorkflowCancel(
      [{ nodeId: 'build', state: 'blocked' }, { nodeId: 'verify', state: 'passed' }],
      [{ nodeId: 'build', taskId: 'tb' }, { nodeId: 'verify', taskId: 'tv' }],
    )).toEqual([])
  })
})

describe('partial rerun creates a new node list, not a mutated source (PRD §三.3 重跑, §四.3)', () => {
  const settled = run([
    node('design', 'passed', { approvedBy: 'session-lead', approvedAt: AT }),
    node('build', 'failed', { verdict: verdict({ result: 'fail' }) }),
    node('verify', 'blocked', { attempts: 0 }),
  ], { status: 'needs_user', reworkRoundsUsed: 2 })

  it('redoes the selected node and every node that depends on it', () => {
    const plan = planPartialRerun(definition(), settled, ['build'])
    expect(plan).toMatchObject({ ok: true, selected: ['build'], reset: ['build', 'verify'], kept: ['design'] })
  })

  it('redoes a root and every successor, including transitive ones', () => {
    const plan = planPartialRerun(definition(), settled, ['design'])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.reset).toEqual(['design', 'build', 'verify'])
    expect(plan.kept).toEqual([])
  })

  it('in a diamond, redoes only the named branch and the join', () => {
    const diamond = definition({
      nodes: [
        { nodeId: 'a', taskId: 'ta' },
        { nodeId: 'b', taskId: 'tb', dependsOn: ['a'] },
        { nodeId: 'c', taskId: 'tc', dependsOn: ['a'] },
        { nodeId: 'd', taskId: 'td', dependsOn: ['b', 'c'] },
      ],
    })
    const diamondRun = run([
      node('a', 'passed'),
      node('b', 'passed'),
      node('c', 'passed'),
      node('d', 'failed', { verdict: verdict({ result: 'fail' }) }),
    ], { status: 'needs_user' })
    const plan = planPartialRerun(diamond, diamondRun, ['b'])
    expect(plan).toMatchObject({ ok: true, selected: ['b'], reset: ['b', 'd'], kept: ['a', 'c'] })
  })

  it('refuses an empty selection, an unknown node, a later definition, and a live turn', () => {
    expect(planPartialRerun(definition(), settled, [])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/at least one node/),
    })
    expect(planPartialRerun(definition(), settled, ['ghost'])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/is not in this run/),
    })
    expect(planPartialRerun(definition({ version: 2 }), settled, ['build'])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/fixed definition version 1/),
    })
    expect(planPartialRerun(
      definition(),
      run([node('design', 'passed'), node('build', 'running'), node('verify', 'blocked')]),
      ['design'],
    )).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/still running on the source run/),
    })
  })

  it('refuses partial rerun while a source node waits for user input or approval', () => {
    expect(planPartialRerun(
      definition(),
      run([node('design', 'passed'), node('build', 'waiting'), node('verify', 'blocked')]),
      ['design'],
    )).toMatchObject({ ok: false, reason: expect.stringMatching(/still .* on the source run/) })
  })

  it('keeps source evidence on nodes that are not redone, and drops verdicts and approvals on those that are', () => {
    const plan = planPartialRerun(definition(), settled, ['build'])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const next = nodesForPartialRerun(settled.nodes, plan.reset)
    expect(settled.nodes[1]?.state).toBe('failed')
    expect(settled.nodes[1]?.verdict?.result).toBe('fail')
    expect(next).toEqual([
      expect.objectContaining({
        nodeId: 'design',
        state: 'passed',
        approvedBy: 'session-lead',
        approvedAt: AT,
      }),
      { nodeId: 'build', state: 'blocked', attempts: 0 },
      { nodeId: 'verify', state: 'blocked', attempts: 0 },
    ])
    expect(next[0]?.verdict).toEqual(settled.nodes[0]?.verdict)
    expect(next[1]?.verdict).toBeUndefined()
    expect(next[1]?.approvedBy).toBeUndefined()
  })

  it('deduplicates a repeated selection without inventing extra resets', () => {
    const plan = planPartialRerun(definition(), settled, ['build', 'build', 'verify'])
    expect(plan).toMatchObject({ ok: true, selected: ['build', 'verify'], reset: ['build', 'verify'] })
  })
})

describe('PRD §三.4 workflow node lifecycle', () => {
  it('maps earlier stored names onto the specification vocabulary', () => {
    expect(canonicalNodeState('pending')).toBe('blocked')
    expect(canonicalNodeState('accepted')).toBe('passed')
    expect(canonicalNodeState('reviewed')).toBe('validating')
    expect(canonicalNodeState('inconclusive')).toBe('validating')
    expect(canonicalNodeState('skipped')).toBe('cancelled')
    expect(canonicalNodeState('running')).toBe('running')
    expect(canonicalNodeState('blocked')).toBe('blocked')
    expect(canonicalNodeState('unknown-name')).toBe('blocked')
    expect(isStartable('blocked')).toBe(true)
    expect(isStartable('ready')).toBe(true)
    expect(isStartable('running')).toBe(false)
    expect(isStartable('validating')).toBe(false)
  })

  it('projects waiting and validating from the target session, and does not un-finish a validating node', () => {
    expect(overlayNodeFromTarget('running', { interaction: 'waiting_input', execution: 'running' })).toBe('waiting')
    expect(overlayNodeFromTarget('running', { interaction: 'waiting_approval', execution: 'running' })).toBe('waiting')
    expect(overlayNodeFromTarget('waiting', { interaction: 'none', execution: 'idle', lastTurn: 'completed' })).toBe('validating')
    expect(overlayNodeFromTarget('running', { interaction: 'none', execution: 'idle', lastTurn: 'completed' })).toBe('validating')
    expect(overlayNodeFromTarget('waiting', { interaction: 'none', execution: 'running' })).toBe('running')
    expect(overlayNodeFromTarget('validating', { interaction: 'none', execution: 'running' })).toBe('validating')
    expect(overlayNodeFromTarget('passed', { interaction: 'waiting_input' })).toBe('passed')
  })

  it('cancels unfinished nodes and leaves passed and failed ones as they are', () => {
    const cancelled = cancelUnfinishedNodes(run([
      node('design', 'passed'),
      node('build', 'running'),
      node('verify', 'blocked'),
      node('ship', 'failed', { verdict: verdict({ result: 'fail' }) }),
    ]))
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.nodes.map(entry => entry.state)).toEqual(['passed', 'cancelled', 'cancelled', 'failed'])
  })

  it('asks to stop a waiting node as well as a running one', () => {
    expect(turnsToStopOnWorkflowCancel(
      [{ nodeId: 'build', state: 'waiting' }, { nodeId: 'verify', state: 'validating' }],
      [{ nodeId: 'build', taskId: 'task-build' }, { nodeId: 'verify', taskId: 'task-verify' }],
    )).toEqual(['task-build'])
  })
})
