import { describe, expect, it } from 'vitest'
import { createLiveConfig } from '../src/service/liveconfig.ts'
import type { ConductorConfig } from '../src/config.ts'
import { DEFAULTS, IMPLEMENTATION_DEFAULTS } from '../src/domain/defaults.ts'

function entry(over: Partial<ConductorConfig> = {}): ConductorConfig {
  return {
    managedTargetLimit: DEFAULTS.managedTargetLimit,
    targetTurnConcurrency: DEFAULTS.targetTurnConcurrency,
    noticeConcurrency: DEFAULTS.noticeConcurrency,
    panelRefreshMergeMs: DEFAULTS.panelRefreshMergeMs,
    noticeMergeWindowMs: DEFAULTS.noticeMergeWindowMs,
    defaultReadLimit: DEFAULTS.defaultReadLimit,
    toolTextLimit: DEFAULTS.toolTextLimit,
    waitLimitMs: DEFAULTS.waitLimitMs,
    interruptConfirmLimitMs: DEFAULTS.interruptConfirmLimitMs,
    passIntervalMs: IMPLEMENTATION_DEFAULTS.passIntervalMs,
    reworkRounds: DEFAULTS.reworkRounds,
    crossHostEnabled: DEFAULTS.crossHostEnabled,
    shareEnabled: DEFAULTS.shareEnabled,
    shareLifetimeDays: DEFAULTS.shareLifetimeDays,
    hostExtensions: { selectModelRememberAsDefault: false, forkTargetParameters: false },
    ...over,
  }
}

describe('live conductor config (PRD §四.4)', () => {
  it('reads the composition entry until a settings thunk is attached', () => {
    const base = entry({ targetTurnConcurrency: 4 })
    const live = createLiveConfig(base)
    expect(live.current().targetTurnConcurrency).toBe(4)
    live.setSource(() => entry({ targetTurnConcurrency: 2 }))
    expect(live.current().targetTurnConcurrency).toBe(2)
    live.setSource(() => base)
    expect(live.current().targetTurnConcurrency).toBe(4)
  })

  it('refuses a settings write that would rewrite Host-extension declarations', () => {
    const live = createLiveConfig(entry())
    expect(() => live.validate(entry({
      hostExtensions: { selectModelRememberAsDefault: true, forkTargetParameters: false },
    }))).toThrow(/cannot be changed from user settings/)
    expect(() => live.validate(entry({ targetTurnConcurrency: 1 }))).not.toThrow()
  })
})
