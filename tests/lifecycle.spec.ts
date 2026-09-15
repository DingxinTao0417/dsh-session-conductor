import { describe, expect, it } from 'vitest'
import { PLUGIN_DISABLED_ACCOUNT, PluginLifecycle } from '../src/service/lifecycle.ts'

describe('plugin disable (PRD §四.5 插件停用)', () => {
  it('allows automatic work until disable, then refuses it and keeps that decision', () => {
    const life = new PluginLifecycle()
    expect(life.active).toBe(true)
    expect(life.refusal('a scheduled occurrence')).toBeUndefined()

    life.disable()
    expect(life.active).toBe(false)
    expect(life.refusal('a scheduled occurrence')).toMatch(/plugin is disabled/)
    expect(life.refusal('a scheduled occurrence')).toMatch(/tasks, artifacts and data are kept/)
    expect(life.refusal('a background report')).toMatch(/background report is not started/)

    life.disable()
    expect(life.active).toBe(false)
  })

  it('names the stopped-pass account without claiming data was deleted', () => {
    expect(PLUGIN_DISABLED_ACCOUNT).toMatch(/plugin disabled/)
    expect(PLUGIN_DISABLED_ACCOUNT).toMatch(/data are kept/)
    expect(PLUGIN_DISABLED_ACCOUNT).not.toMatch(/deleted|removed|cleared/)
  })
})
