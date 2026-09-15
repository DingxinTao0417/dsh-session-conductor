import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import { newArtifactRecord } from '../src/service/artifacts.ts'
import { contentDigest } from '../src/service/transfer.ts'

const opened: Awaited<ReturnType<typeof mountedPlugin>>[] = []
afterEach(async () => { for (const plugin of opened.splice(0)) await plugin.close() })
async function mount(extra: Record<string, unknown> = {}, declared = false) {
  const plugin = await mountedPlugin(extra, declared)
  opened.push(plugin)
  return plugin
}

describe('production read authorization (PRD §一.3, §二.10.1)', () => {
  it.each([
    ['conductor_model', { action: 'show', taskId: 'target' }],
    ['conductor_read', { taskId: 'target', view: 'history' }],
    ['conductor_brief', { taskId: 'target' }],
    ['conductor_export', { action: 'export', taskId: 'target' }],
    ['conductor_operation', { action: 'list', taskId: 'target' }],
  ])('refuses foreign-session reads via %s', async (tool, args) => {
    const plugin = await mount()
    await expect(plugin.call(tool, args, 'stranger')).rejects.toThrow(/NOT_READER/)
  })

  it('allows observers to read model configuration', async () => {
    const plugin = await mount()
    expect((await plugin.call('conductor_model', { action: 'show', taskId: 'target' }, 'observer')).changed).toBe(false)
  })

  it('reads an authorized cold session through the public detached query and never invokes it for a stranger', async () => {
    const readSession = vi.fn(async (sessionId: string) => ({
      session: { id: sessionId },
      events: [
        { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'cold task input' }] } },
        { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'cold task result' }] } } },
      ],
    }))
    const plugin = await mount({
      agents: { get: vi.fn(() => undefined), list: () => [] },
      sessionQuery: { readSession },
    })
    await expect(plugin.call('conductor_read', { taskId: 'target', view: 'history' }, 'stranger')).rejects.toThrow(/NOT_READER/)
    expect(readSession).not.toHaveBeenCalled()

    const result = await plugin.call('conductor_read', { taskId: 'target', view: 'history' }, 'owner')
    expect(result).toMatchObject({
      historyOrigin: 'persisted',
      sessionId: 'session-1',
      history: [{ text: 'cold task input' }, { text: 'cold task result' }],
    })
    expect(result.bindingVersion).toBeUndefined()
    expect(result.ownerEpoch).toBeUndefined()
    const definition = plugin.tools.get('conductor_read')!
    const rendered = definition.output.render({}, result as never)
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    expect(rendered).toContain('cold task result')
    expect(rendered).toContain('detached persisted log; no Agent was restored')
    expect(readSession).toHaveBeenCalledTimes(1)
  })

  it('returns an inaccessible wait target as an error without starting a read', async () => {
    const plugin = await mount()
    const result = await plugin.call('conductor_wait', { targets: [{ taskId: 'target' }], timeoutMs: 0 }, 'stranger')
    expect(result).toMatchObject({
      ending: 'timed_out',
      targets: [{ taskId: 'target', error: expect.stringMatching(/NOT_READER/) }],
    })
  })

  it('does not turn a direct history read into an automatic background watch', async () => {
    const plugin = await mount({
      sessionQuery: { readSession: async (sessionId: string) => ({
        session: { id: sessionId },
        events: [{ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'saved result' }] } } }],
      }) },
    })
    await plugin.call('conductor_read', { taskId: 'target', view: 'history' })
    expect(plugin.store.getWatch('owner::target')).toMatchObject({ historyCursor: '0', watchEnabled: false })
    expect(await plugin.call('conductor_watch', { action: 'list' })).toMatchObject({ watches: [] })

    await plugin.call('conductor_watch', { action: 'start', taskId: 'target' })
    expect(plugin.store.getWatch('owner::target')).toMatchObject({ historyCursor: '0', watchEnabled: true })
  })

  it('rechecks ownership after awaiting the model catalogue and before invoking the writer', async () => {
    let plugin: Awaited<ReturnType<typeof mount>>
    let writes = 0
    plugin = await mount({
      llm: { listProviders: () => [{ id: 'provider' }], listModels: async () => {
        const access = plugin.store.getAccess('target')!
        await plugin.store.putAccess({ ...access, ownerSessionId: 'new-owner', ownerEpoch: 1 })
        return [{ id: 'model' }]
      } },
      conductorSessionModelSelection: { selectForSession: async () => {
        writes++
        return { selected: { provider: 'provider', model: 'model' } }
      } },
    }, true)
    await expect(plugin.call('conductor_model', { action: 'set', taskId: 'target', provider: 'provider', model: 'model' }))
      .rejects.toThrow(/NOT_CONTROLLER|STALE_OWNER_EPOCH/)
    expect(writes).toBe(0)
  })
})

describe('read actions during report-triggered turns', () => {
  it('starts an empty-session watch before sequence zero', async () => {
    const plugin = await mount({ agents: { list: () => [], get: () => ({ session: { events: [], seq: -1 } }) } })
    await plugin.call('conductor_watch', { action: 'start', taskId: 'target' })
    expect(plugin.store.getWatch('owner::target')?.cursor).toBe('-1')
  })
  it('permits model show and operation list while refusing model set', async () => {
    const plugin = await mount({ agents: { list: () => [], get: (id: string) => id !== 'owner' ? undefined : {
      session: { events: [{ seq: 1, type: 'user/message', data: { source: {
        kind: 'plugin', plugin: 'dsh-session-conductor', form: 'notice', summary: 'result',
      } } }] },
    } } })
    await expect(plugin.call('conductor_model', { action: 'show', taskId: 'target' })).resolves.toMatchObject({ changed: false })
    await expect(plugin.call('conductor_operation', { action: 'list', taskId: 'target' })).resolves.toMatchObject({ found: true })
    await expect(plugin.call('conductor_model', { action: 'set', taskId: 'target', provider: 'p', model: 'm' }))
      .rejects.toThrow(/REPORT|report|notice/)
  })
})

async function transferFixture(onRead?: () => Promise<void>) {
  const writes: unknown[][] = []
  const files = new Map([['D:/source/input.txt', 'source']])
  const plugin = await mount({ fs: {
    resolve: async (path: string) => path,
    contains: (parent: unknown, child: unknown) => parent === child || String(child).startsWith(`${String(parent)}/`),
    stat: async (path: unknown) => files.has(String(path)) ? { version: 'v1' } : undefined,
    readText: async (path: unknown) => { await onRead?.(); return files.get(String(path))! },
    writeText: async (...args: unknown[]) => { writes.push(args); files.set(String(args[0]), String(args[1])) },
  } })
  await plugin.store.createTask({ ...plugin.store.getTask('target')!, taskId: 'source', currentBindingId: undefined } as never)
  await plugin.store.putAccess({ ...plugin.store.getAccess('target')!, taskId: 'source' })
  await plugin.store.putArtifact({
    ...newArtifactRecord({artifactId: 'input', taskId: 'source', kind: 'file', name: 'input.txt', hostId: 'local', path: 'D:/source/input.txt'}, '2026-09-14T00:00:00Z'),
    existence: 'present', hashScope: 'full', contentHash: contentDigest('source'),
  })
  return { plugin, writes }
}
const transfer = { mode: 'snapshot_copy', artifactId: 'input', toTaskId: 'target', destination: 'D:/target/input.txt' }

describe('production artifact transfer boundaries', () => {
  it('refuses an export bundle that names an artifact from another task', async () => {
    const { plugin, writes } = await transferFixture()
    await expect(plugin.call('conductor_export', { action: 'export', taskId: 'target', attachmentIds: ['input'], bundleDirectory: 'D:/bundle' }))
      .rejects.toThrow(/ATTACHMENT_OUT_OF_SCOPE/)
    expect(writes).toEqual([])
  })
  it('allows observer export reads but refuses observer attachment writes', async () => {
    const { plugin, writes } = await transferFixture()
    await expect(plugin.call('conductor_export', { action: 'export', taskId: 'source', attachmentIds: ['input'], bundleDirectory: 'D:/bundle' }, 'observer'))
      .rejects.toThrow(/NOT_CONTROLLER/)
    expect(writes).toEqual([])
  })
  it('requires control of the destination as well as the source', async () => {
    const { plugin, writes } = await transferFixture()
    await plugin.store.putAccess({ ...plugin.store.getAccess('target')!, ownerSessionId: 'someone-else', ownerEpoch: 1 })
    await expect(plugin.call('conductor_transfer', transfer)).rejects.toThrow(/NOT_CONTROLLER/)
    expect(writes).toEqual([])
  })
  it('refuses a destination outside the receiving task directory', async () => {
    const { plugin, writes } = await transferFixture()
    await expect(plugin.call('conductor_transfer', { ...transfer, destination: 'D:/unrelated/input.txt' }))
      .rejects.toThrow(/OUTSIDE|DESTINATION/)
    expect(writes).toEqual([])
  })
  it('passes the atomic create condition in the Host API expected argument', async () => {
    const { plugin, writes } = await transferFixture()
    await expect(plugin.call('conductor_transfer', transfer)).resolves.toMatchObject({ applied: true, verified: true })
    expect(writes[0]?.[2]).toEqual({ kind: 'createIfAbsent' })
  })
  it('replays a completed transfer without rewriting its files or its success record', async () => {
    const { plugin, writes } = await transferFixture()
    const [first, retry] = await Promise.all([
      plugin.call('conductor_transfer', transfer), plugin.call('conductor_transfer', transfer),
    ])
    expect(first).toEqual(retry)
    expect(first.applied).toBe(true)
    expect(writes).toHaveLength(1)
    await expect(plugin.call('conductor_transfer', { ...transfer, destination: 'D:/target/different.txt' }))
      .rejects.toThrow(/OPERATION_CONFLICT/)
    expect(writes).toHaveLength(1)
  })
  it('rechecks destination ownership immediately before the actual write', async () => {
    let plugin: Awaited<ReturnType<typeof mount>>
    const fixture = await transferFixture(async () => {
      await plugin.store.putAccess({ ...plugin.store.getAccess('target')!, ownerSessionId: 'new-owner', ownerEpoch: 1 })
    })
    plugin = fixture.plugin
    await expect(plugin.call('conductor_transfer', transfer)).resolves.toMatchObject({ applied: false })
    expect(fixture.writes).toEqual([])
  })
})
