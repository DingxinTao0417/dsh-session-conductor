import { describe, expect, it } from 'vitest'
import { MODEL_SELECTION_WRITER_SERVICE } from '../src/service/modelconfig.ts'
import { OPTIONAL_SERVICES, probeCapabilities, type ProbeContext } from '../src/capabilities.ts'

function snapshot(extensions: boolean, services: Record<string, unknown> = {}) {
  const context: ProbeContext = { get: (name) => services[name] }
  return probeCapabilities(context, {
    pluginVersion: 'test',
    declared: { selectModelRememberAsDefault: extensions, forkTargetParameters: false },
    store: { available: true },
  })
}

describe('isolated model-selection capability', () => {
  it('stays disabled when the Host extension was not declared', () => {
    const feature = snapshot(false).features.model_selection_isolated
    expect(feature.available).toBe(false)
    expect(feature.reason).toMatch(/machine-readable declaration/)
  })

  it('does not treat an operator declaration as proof that a callable writer exists', () => {
    const feature = snapshot(true).features.model_selection_isolated
    expect(feature.available).toBe(false)
    expect(feature.reason).toMatch(/callable session-model writer/)
  })

  it('does not enable the feature for a mounted object that has no callable writer', () => {
    const feature = snapshot(true, {
      [MODEL_SELECTION_WRITER_SERVICE]: { selectForSession: 'not-a-function' },
    }).features.model_selection_isolated
    expect(feature.available).toBe(false)
    expect(feature.reason).toMatch(/callable session-model writer/)
  })

  it('enables the feature only when the declared extension also mounts its writer', () => {
    const feature = snapshot(true, {
      [MODEL_SELECTION_WRITER_SERVICE]: { selectForSession: async () => ({ selected: { provider: 'p', model: 'm' } }) },
    }).features.model_selection_isolated
    expect(feature.available).toBe(true)
  })
})

describe('explicit Host fork target capability', () => {
  const forkSnapshot = (enabled: boolean, get: ProbeContext['get']) => probeCapabilities({ get }, {
    pluginVersion: 'test', declared: { selectModelRememberAsDefault: false, forkTargetParameters: enabled }, store: { available: true },
  })

  it('requires the operator declaration even when a callable fork is present', () => {
    const result = forkSnapshot(false, name => name === 'conductorSessionFork' ? { fork: async () => ({ sessionId: 'child' }) } : undefined)
    expect(result.features.fork_target_control.available).toBe(false)
  })

  it.each([undefined, null, {}, { fork: true }])('refuses a declared extension without a callable fork: %s', service => {
    const result = forkSnapshot(true, name => name === 'conductorSessionFork' ? service : undefined)
    expect(result.features.fork_target_control.available).toBe(false)
    expect(result.features.fork_target_control.reason).toMatch(/callable.*fork/)
  })

  it('reports an inaccessible fork service as unavailable instead of throwing or enabling it', () => {
    const result = forkSnapshot(true, name => { if (name === 'conductorSessionFork') throw new Error('disposed'); return undefined })
    expect(result.features.fork_target_control.available).toBe(false)
    expect(result.features.fork_target_control.reason).toMatch(/could not be read/)
  })

  it('enables explicit target control only when the declared Host extension mounts its fork', () => {
    const result = forkSnapshot(true, name => name === 'conductorSessionFork' ? { fork: async () => ({ sessionId: 'child' }) } : undefined)
    expect(result.features.fork_target_control.available).toBe(true)
    expect(result.services['conductorSessionFork']?.present).toBe(true)
  })

  it('includes both independent companions in the optional service inventory', () => {
    expect(OPTIONAL_SERVICES).toContain('conductorSessionFork')
    expect(OPTIONAL_SERVICES).toContain('conductorBinaryFiles')
  })
})
