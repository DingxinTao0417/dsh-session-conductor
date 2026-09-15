import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountedPlugin } from './helpers/mounted-plugin.ts'
import type { SessionEventLike } from '../src/service/projection.ts'

const opened: Awaited<ReturnType<typeof mountedPlugin>>[] = []
afterEach(async () => { for (const plugin of opened.splice(0)) await plugin.close() })

async function fixture() {
  const events: SessionEventLike[] = []
  const owner = { id: 'owner', status: 'idle', session: { events: [] }, steer: vi.fn(), followup: vi.fn() }
  const target = { id: 'session-1', status: 'idle', session: { events, get seq() { return events.at(-1)?.seq ?? -1 } } }
  const plugin = await mountedPlugin({ agents: { get: (id: string) => id === owner.id ? owner : id === target.id ? target : undefined,
    list: () => [owner, target] } })
  opened.push(plugin)
  await plugin.call('conductor_watch', { action: 'start', taskId: 'target' })
  const end = (seq: number, time: number) => events.push({ seq, type: 'turn/end', time, data: { turn: seq, reason: { kind: 'completed' } } })
  const report = () => plugin.call('conductor_watch', { action: 'report' })
  return { plugin, owner, events, end, report }
}

describe('durable background report boundaries', () => {
  it('preserves every delivered event across distinct merge windows from one watch', async () => {
    const held = await fixture()
    held.end(1, 1)
    held.end(2, 100_000)
    await held.report()
    expect(held.owner.steer).toHaveBeenCalledTimes(2)
    expect(held.plugin.store.getWatch('owner::target')?.deliveredEventIds).toEqual(['session-1#1', 'session-1#2'])
    await held.report()
    expect(held.owner.steer).toHaveBeenCalledTimes(2)
  })

  it('does not resend a notice after Host acceptance when the later watch write fails', async () => {
    const held = await fixture()
    held.end(1, Date.now())
    const facility = held.plugin.services.storageDomain as { open(): Promise<{ table(name: string): { put(id: string, value: unknown): Promise<void> } }> }
    const watchTable = (await facility.open()).table('watches')
    const original = watchTable.put.bind(watchTable)
    watchTable.put = async (id, value) => {
      if (held.owner.steer.mock.calls.length > 0) throw new Error('injected post-acceptance storage outage')
      await original(id, value)
    }
    await expect(held.report()).rejects.toThrow(/storage outage/)
    expect(held.owner.steer).toHaveBeenCalledTimes(1)
    watchTable.put = original
    await held.report()
    expect(held.owner.steer).toHaveBeenCalledTimes(1)
  })

  it('does not deliver private reports to a reader removed from the task', async () => {
    const held = await fixture()
    held.end(1, Date.now())
    await held.plugin.store.putAccess({ ...held.plugin.store.getAccess('target')!, ownerSessionId: 'next-owner', ownerEpoch: 1,
      observerSessionIds: [] })
    const result = await held.report()
    expect(held.owner.steer).not.toHaveBeenCalled()
    expect(String(result.refusals)).toMatch(/permission/)
  })
})
