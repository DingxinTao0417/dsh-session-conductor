import { describe, expect, it } from 'vitest'
import {
  checkCompatibility,
  enableTargetAllowed,
  planMigration,
  reconcile,
  remoteAvailability,
  translatePath,
  type CompatibilityInput,
  type MigrationManifest,
  type RemoteHost,
} from '../src/service/crosshost.ts'

/** A remote Host with the members a test cares about overridden. */
function remote(over: Partial<RemoteHost> = {}): RemoteHost {
  return { hostId: 'remote-1', label: 'the build box', enabled: true, models: ['deepseek-chat', 'deepseek-reasoner'], workspaceCapable: true, ...over }
}

/** The compatibility input. */
function input(over: Partial<CompatibilityInput> = {}): CompatibilityInput {
  return {
    localProtocolVersion: '1.0',
    localPluginVersion: '0.1.0',
    requiredModels: ['deepseek-chat'],
    workspaceRepresentable: true,
    ...over,
  }
}

/** A manifest. */
function manifest(over: Partial<MigrationManifest> = {}): MigrationManifest {
  return {
    taskId: 'task-1',
    sourceHostId: 'local',
    targetHostId: 'remote-1',
    historyThroughSeq: 42,
    artifactIds: ['artifact-1'],
    pathMap: [{ from: 'D:/work/app', to: '/srv/work/app' }],
    ...over,
  }
}

describe('compatibility before anything moves (PRD §二.14.1)', () => {
  it('accepts a compatible remote', () => {
    const verdict = checkCompatibility(remote({ pluginVersion: '0.1.0', protocolVersion: '1.0' }), input())
    expect(verdict.compatible).toBe(true)
    expect(verdict.checks.every(check => check.satisfied)).toBe(true)
  })

  it('refuses an unverified plugin version mismatch even with a matching protocol', () => {
    expect(checkCompatibility(remote({ pluginVersion: '99.0.0', protocolVersion: '1.0' }), input()).compatible).toBe(false)
  })

  it('reports every aspect, not only the first that fails', () => {
    // A target missing a model and unable to represent the workspace needs both fixed, and
    // discovering them one round trip apart wastes the operator's time.
    const verdict = checkCompatibility(
      remote({ pluginVersion: '0.1.0', protocolVersion: '1.0' }),
      input({ requiredModels: ['deepseek-reasoner', 'gemma'], workspaceRepresentable: false }),
    )
    expect(verdict.compatible).toBe(false)
    expect(verdict.checks.map(check => check.aspect)).toEqual(['plugin', 'protocol', 'model', 'workspace'])
    expect(verdict.checks.filter(check => !check.satisfied).map(check => check.aspect)).toEqual(['model', 'workspace'])
  })

  it('refuses a protocol mismatch rather than negotiating it', () => {
    const verdict = checkCompatibility(remote({ pluginVersion: '0.1.0', protocolVersion: '2.0' }), input())
    expect(verdict.compatible).toBe(false)
    const protocol = verdict.checks.find(check => check.aspect === 'protocol')
    expect(protocol?.reason).toMatch(/refused rather than negotiated/)
  })

  it('refuses when the remote has reported nothing at all', () => {
    // Silence is not agreement: an unreachable remote reports no versions and no models,
    // and that must not read as compatible.
    const verdict = checkCompatibility(
      remote({ pluginVersion: undefined, protocolVersion: undefined, models: undefined }),
      input(),
    )
    expect(verdict.compatible).toBe(false)
    expect(verdict.checks.find(check => check.aspect === 'plugin')?.reason).toMatch(/has not reported/)
    expect(verdict.checks.find(check => check.aspect === 'protocol')?.reason).toMatch(/has not reported/)
    expect(verdict.checks.find(check => check.aspect === 'model')?.reason).toMatch(/has not reported/)
  })

  it('treats an unreported workspace capability as not satisfied, like every other aspect', () => {
    // The live probe surfaced this asymmetry: a fresh registration failed plugin, protocol
    // and model, but PASSED workspace — which reads as "the workspace is fine" about a
    // remote that had said nothing at all. Silence is not agreement for any of the four.
    const verdict = checkCompatibility(
      remote({ pluginVersion: '0.1.0', protocolVersion: '1.0', workspaceCapable: undefined }),
      input(),
    )
    const workspace = verdict.checks.find(check => check.aspect === 'workspace')
    expect(workspace?.satisfied).toBe(false)
    expect(workspace?.reason).toMatch(/has not reported whether it can host/)
  })

  it('refuses a remote that reports it cannot host the workspace', () => {
    const verdict = checkCompatibility(
      remote({ pluginVersion: '0.1.0', protocolVersion: '1.0', workspaceCapable: false }),
      input(),
    )
    expect(verdict.checks.find(check => check.aspect === 'workspace')?.reason).toMatch(/reports that it cannot host/)
  })

  it('names which required models are missing', () => {
    const verdict = checkCompatibility(
      remote({ pluginVersion: '0.1.0', protocolVersion: '1.0' }),
      input({ requiredModels: ['deepseek-chat', 'gemma'] }),
    )
    expect(verdict.checks.find(check => check.aspect === 'model')?.reason).toMatch(/does not offer: gemma/)
  })
})

describe('translating source paths to target paths (PRD §二.14.1)', () => {
  it('maps a path and everything beneath it', () => {
    expect(translatePath(manifest(), 'D:/work/app/src/index.ts')).toEqual({
      path: '/srv/work/app/src/index.ts', mapped: true,
    })
    expect(translatePath(manifest(), 'D:/work/app')).toEqual({ path: '/srv/work/app', mapped: true })
  })

  it('returns an unmapped path unchanged AND reports that it was unmapped', () => {
    // A plausible-looking translation of an unmapped path is how work arrives pointing at
    // a directory that happens to exist and is not the right one.
    expect(translatePath(manifest(), 'C:/elsewhere/file.ts')).toEqual({ path: 'C:/elsewhere/file.ts', mapped: false })
  })

  it('does not map a path that merely shares a prefix string', () => {
    expect(translatePath(manifest(), 'D:/work/application/x.ts').mapped).toBe(false)
  })

  it('uses the longest explicit source root and refuses paths escaping it', () => {
    const mapped = manifest({ pathMap: [
      { from: 'D:/work/app', to: '/srv/app' },
      { from: 'D:/work/app/input', to: '/srv/input' },
    ] })
    expect(translatePath(mapped, 'd:\\work\\app\\input\\README.md')).toEqual({ path: '/srv/input/README.md', mapped: true })
    expect(translatePath(mapped, 'D:/work/app/../../private').mapped).toBe(false)
  })
})

describe('the ordering rule (PRD §二.14.1)', () => {
  it('allows the target only after a confirmed stop and a frozen dispatch', () => {
    const verdict = enableTargetAllowed('stopped', true)
    expect(verdict.allowed).toBe(true)
    expect(verdict.reason).toMatch(/may be bound/)
  })

  it('refuses when the source cannot be confirmed, rather than assuming it stopped', () => {
    // `unknown` is what a link failure produces and the state most likely to be treated as
    // success — so it is refused explicitly.
    const verdict = enableTargetAllowed('unknown', true)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toMatch(/cannot be confirmed is not a source that has stopped/)
    expect(verdict.reason).toMatch(/two live copies/)
  })

  it('refuses while the source still reports running', () => {
    expect(enableTargetAllowed('running', true).reason).toMatch(/still running/)
  })

  it('refuses a stop without a frozen dispatch', () => {
    // Otherwise the source can start new work after the copy was taken.
    const verdict = enableTargetAllowed('stopped', false)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toMatch(/has not confirmed that dispatch is frozen/)
  })
})

describe('the migration plan (PRD §二.14.1)', () => {
  it('constructs a manifest, translates mapped paths and leaves unmapped ones unchanged', () => {
    const plan = planMigration({
      taskId: 'task-1',
      sourceHostId: 'local',
      targetHostId: 'remote-1',
      historyThroughSeq: 42,
      artifactIds: ['artifact-1'],
      pathMap: [{ from: 'D:/work/app', to: '/srv/work/app' }],
      sourcePaths: ['D:/work/app/src/index.ts', 'C:/elsewhere/file.ts'],
      sourceStop: 'stopped',
      dispatchFrozen: true,
    })
    expect(plan.manifest.historyThroughSeq).toBe(42)
    expect(plan.manifest.artifactIds).toEqual(['artifact-1'])
    expect(plan.translations).toEqual([
      { from: 'D:/work/app/src/index.ts', to: '/srv/work/app/src/index.ts', mapped: true },
      { from: 'C:/elsewhere/file.ts', to: 'C:/elsewhere/file.ts', mapped: false },
    ])
    expect(plan.enable.allowed).toBe(false)
    expect(plan.enable.reason).toContain('unmapped')
  })

  it('refuses to enable the target when the source stop cannot be confirmed', () => {
    // The live Host has no transport, so the source's stop is `unknown`. Treating that
    // as stopped is how two live copies of one task get created.
    const plan = planMigration({
      taskId: 'task-1',
      sourceHostId: 'local',
      targetHostId: 'remote-1',
      historyThroughSeq: 0,
      artifactIds: [],
      pathMap: [],
      sourcePaths: ['D:/work/app'],
      sourceStop: 'unknown',
      dispatchFrozen: false,
    })
    expect(plan.enable.allowed).toBe(false)
    expect(plan.enable.reason).toMatch(/did not confirm that it stopped/)
    expect(plan.translations[0]).toEqual({ from: 'D:/work/app', to: 'D:/work/app', mapped: false })
  })
})

describe('reconciliation by operation id (PRD §二.14.1)', () => {
  it('adopts what the remote reports as accepted, without sending anything', () => {
    const [decision] = reconcile([
      { operationId: 'op-1', delivery: 'dispatching', withdrawn: false, remoteDelivery: 'accepted' },
    ])
    expect(decision?.action).toBe('adopt')
    expect(decision?.reason).toMatch(/backfilled from the remote and nothing is sent/)
  })

  it('leaves an unknown delivery unknown across the link', () => {
    const [decision] = reconcile([
      { operationId: 'op-2', delivery: 'dispatching', withdrawn: false },
    ])
    expect(decision?.action).toBe('reconcile')
    expect(decision?.reason).toMatch(/must be established, never resent/)
  })

  it('asks a human about an operation the remote never saw, rather than resending it', () => {
    const [decision] = reconcile([{ operationId: 'op-3', delivery: 'prepared', withdrawn: false }])
    expect(decision?.action).toBe('reconcile')
    expect(decision?.reason).toMatch(/not resent automatically/)
  })

  it('ignores a withdrawn operation and a settled one', () => {
    const decisions = reconcile([
      { operationId: 'op-withdrawn', delivery: 'withdrawn', withdrawn: true },
      { operationId: 'op-done', delivery: 'accepted', withdrawn: false },
    ])
    expect(decisions.map(decision => decision.action)).toEqual(['ignore', 'ignore'])
  })

  it('never produces a resend', () => {
    // The rule is the whole point of the function.
    const decisions = reconcile([
      { operationId: 'a', delivery: 'prepared', withdrawn: false },
      { operationId: 'b', delivery: 'dispatching', withdrawn: false },
      { operationId: 'c', delivery: 'unknown', withdrawn: false },
      { operationId: 'd', delivery: 'accepted', withdrawn: false },
      { operationId: 'e', delivery: 'prepared', withdrawn: true },
      { operationId: 'f', delivery: 'dispatching', withdrawn: false, remoteDelivery: 'accepted' },
    ])
    expect(decisions.map(decision => decision.action)).not.toContain('resend')
    expect(new Set(decisions.map(decision => decision.action))).toEqual(new Set(['adopt', 'reconcile', 'ignore']))
  })
})

describe('cross-Host is off, with a reason (PRD §二.14.1)', () => {
  it('is unavailable by default and names what would have to exist', () => {
    const availability = remoteAvailability(false, [])
    expect(availability.available).toBe(false)
    expect(availability.reason).toMatch(/disabled by default/)
    expect(availability.reason).toMatch(/Companion Bridge/)
    expect(availability.reason).toMatch(/nothing has been sent/)
  })

  it('is still unavailable when enabled with no registered Host', () => {
    const availability = remoteAvailability(true, [])
    expect(availability.available).toBe(false)
    expect(availability.reason).toMatch(/registered by hand/)
    expect(availability.reason).toMatch(/never sent to a Host the user has not named/)
  })

  it('requires explicitly configured transport as well as saved Host metadata', () => {
    const availability = remoteAvailability(true, [remote()])
    expect(availability.available).toBe(false)
    expect(availability.reason).toMatch(/does not establish a configured/)
    expect(remoteAvailability(true, [remote()], true).available).toBe(true)
    expect(remoteAvailability(true, [{ ...remote(), enabled: false }], true).available).toBe(false)
  })
})
