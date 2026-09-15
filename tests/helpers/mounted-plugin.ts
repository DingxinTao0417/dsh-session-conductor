import { apply } from '../../src/index.ts'
import type { ConductorConfig } from '../../src/config.ts'
import { DEFAULTS, IMPLEMENTATION_DEFAULTS } from '../../src/domain/defaults.ts'
import { createInMemoryTables } from '../../src/store/memory.ts'
import { ConductorStore } from '../../src/store/repository.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Mount the actual production entry and registered tools; only Host services are doubles. */
export async function mountedPlugin(extra: Record<string, unknown> = {}, declared = false,
  beforeMount?: (store: ConductorStore) => Promise<void>, configOverrides: Partial<ConductorConfig> = {}) {
  const tables = createInMemoryTables()
  const store = new ConductorStore(tables, () => new Date().toISOString())
  const tools = new Map<string, ToolDefinition>()
  const effects: (() => unknown)[] = []
  const services: Record<string, unknown> = {
    agents: { get: () => undefined, list: () => [] },
    tools: { register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    } },
    storageDomain: { open: async () => ({
      table: (name: keyof typeof tables) => tables[name], close: async () => {},
    }) },
    ...extra,
  }
  const config: ConductorConfig = {
    ...DEFAULTS, passIntervalMs: IMPLEMENTATION_DEFAULTS.passIntervalMs,
    hostExtensions: { selectModelRememberAsDefault: declared, forkTargetParameters: false },
    ...configOverrides,
  }
  await beforeMount?.(store)
  apply({ get: (name: string) => services[name], effect: (callback: () => unknown) => {
    const dispose = callback()
    if (typeof dispose === 'function') effects.push(dispose as () => unknown)
  } } as never, config)
  // Storage mount and recovery use asynchronous steps, but no elapsed-time delay is needed.
  for (let i = 0; i < 20; i++) await Promise.resolve()
  if (store.getTask('target') === undefined) {
  await store.createTask({
    taskId: 'target', title: 'private task', controllerSessionId: 'owner', requestedBy: 'user',
    pinned: false, archived: false, contextMode: 'empty', preparation: 'ready', preparationPhase: 'ready',
    createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z',
  })
  await store.putAccess({taskId: 'target', ownerSessionId: 'owner', ownerEpoch: 0,
    observerSessionIds: ['observer'], updatedAt: '2026-09-14T00:00:00Z'})
  await store.putBinding({bindingId: 'binding-1', taskId: 'target', sessionId: 'session-1', hostId: 'local',
    version: 1, cwd: 'D:/target', createdAt: '2026-09-14T00:00:00Z'})
  }
  return {
    store, services, tools,
    call: async (name: string, args: object, caller = 'owner') => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`Missing tool ${name}`)
      return await tool.execute(args as never, { agent: { id: caller }, callId: `${name}-test` } as never) as Record<string, unknown>
    },
    close: async () => { for (const dispose of effects.reverse()) await dispose() },
  }
}
