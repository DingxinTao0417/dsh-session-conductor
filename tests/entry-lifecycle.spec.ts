import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { DEFAULTS, IMPLEMENTATION_DEFAULTS } from '../src/domain/defaults.ts'
import { createInMemoryTables } from '../src/store/memory.ts'

afterEach(() => { vi.useRealTimers() })

it('closes a late storage open without resurrecting a disposed plugin or its panel/timer', async () => {
  vi.useFakeTimers()
  const tables = createInMemoryTables()
  let resolveOpen!: (value: unknown) => void
  const pending = new Promise(resolve => { resolveOpen = resolve })
  const close = vi.fn(async () => {})
  const registerRoute = vi.fn(() => () => {})
  const effects: (() => unknown)[] = []
  const services: Record<string, unknown> = {
    tools: { register: () => () => {} }, agents: { list: () => [], get: () => undefined },
    webServer: { register: registerRoute }, storageDomain: { open: () => pending },
  }
  apply({ get: (key: string) => services[key], effect: (fn: () => unknown) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') effects.push(cleanup as () => unknown)
  } } as never, {
    ...DEFAULTS, passIntervalMs: IMPLEMENTATION_DEFAULTS.passIntervalMs,
    hostExtensions: { selectModelRememberAsDefault: false, forkTargetParameters: false },
  })
  for (const cleanup of effects.slice().reverse()) await cleanup()
  resolveOpen({ table: (key: keyof typeof tables) => tables[key], close })
  for (let i = 0; i < 100; i++) await Promise.resolve()
  expect(close).toHaveBeenCalledTimes(1)
  expect(registerRoute).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
