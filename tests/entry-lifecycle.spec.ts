import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { DEFAULTS, IMPLEMENTATION_DEFAULTS } from '../src/domain/defaults.ts'
import { createInMemoryTables } from '../src/store/memory.ts'
import { Context } from '@deepseek-ai/cordis'

afterEach(() => { vi.useRealTimers() })

it('closes a late storage open without resurrecting a disposed plugin or its panel/timer', async () => {
  vi.useFakeTimers()
  const tables = createInMemoryTables()
  let resolveOpen!: (value: unknown) => void
  const pending = new Promise(resolve => { resolveOpen = resolve })
  const close = vi.fn(async () => {})
  const registerRoute = vi.fn(() => () => {})
  const services: Record<string, unknown> = {
    tools: { register: () => () => {} }, agents: { list: () => [], get: () => undefined },
    webServer: { register: registerRoute }, storageDomain: { open: () => pending },
  }
  const context = new Context()
  for (const [name, service] of Object.entries(services)) context.provide(name, service)
  apply(context, {
    ...DEFAULTS, passIntervalMs: IMPLEMENTATION_DEFAULTS.passIntervalMs,
    hostExtensions: { selectModelRememberAsDefault: false, forkTargetParameters: false },
  })
  await context.fiber.dispose()
  resolveOpen({ table: (key: keyof typeof tables) => tables[key], close })
  for (let i = 0; i < 100; i++) await Promise.resolve()
  expect(close).toHaveBeenCalledTimes(1)
  expect(registerRoute).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
