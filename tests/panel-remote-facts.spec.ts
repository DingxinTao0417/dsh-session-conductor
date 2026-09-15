import { expect, it } from 'vitest'
import { RemotePanelFacts } from '../src/domain/panel-remote.ts'

const identity = { taskId: 'task', hostId: 'linux', sessionId: 'remote-session', version: 2 }
it('pins remote facts to the full binding and expires unrefreshed online evidence', () => {
  const cache = new RemotePanelFacts()
  const ticket = cache.begin(identity)
  cache.accept(identity, ticket, { execution: 'running', cursor: '8', expectedTurn: 2, expectedStartSeq: 7 }, 1000)
  expect(cache.read(identity, 2000)).toMatchObject({ projection: { execution: 'running', openTurn: 2 }, reach: { connection: 'online' }, observedAt: '1970-01-01T00:00:01.000Z' })
  expect(cache.read({ ...identity, version: 3 }, 2000).reach.connection).toBe('unavailable')
  expect(cache.read({ ...identity, hostId: 'other' }, 2000).reach.connection).toBe('unavailable')
  expect(cache.read(identity, 6001)).toMatchObject({ projection: { execution: 'reconciling' }, reach: { connection: 'unavailable', unrecoverable: false } })
})

it('invalidates online facts immediately on a failed read and cannot revive them with a late earlier response', () => {
  const cache = new RemotePanelFacts()
  const first = cache.begin(identity)
  cache.accept(identity, first, { execution: 'running', cursor: '1' }, 1000)
  const earlier = cache.begin(identity), newer = cache.begin(identity)
  cache.fail(identity, newer)
  cache.accept(identity, earlier, { execution: 'running', cursor: '2' }, 1200)
  expect(cache.read(identity, 1200).reach.connection).toBe('unavailable')
  const recovery = cache.begin(identity)
  cache.accept(identity, recovery, { execution: 'idle', cursor: '3', lastTurn: 'completed' }, 1300)
  expect(cache.read(identity, 1300)).toMatchObject({ projection: { execution: 'idle', lastTurn: 'completed' }, reach: { connection: 'online' } })
})
