import { describe, expect, it } from 'vitest'
import { ConductorStore } from '../src/store/repository.ts'
import { createInMemoryTables } from '../src/store/memory.ts'

const time = '2026-09-15T00:00:00.000Z'
const dispatch = { kind: 'dispatch' as const, at: time }

describe('durable dispatch accounting (T26/T27)', () => {
  it('counts an operation once across concurrent callers and a reconstructed store', async () => {
    const tables = createInMemoryTables()
    const first = new ConductorStore(tables)
    const second = new ConductorStore(tables)
    await Promise.all([first.recordLedgerEvent('task', dispatch, time, 'op'),
      second.recordLedgerEvent('task', dispatch, time, 'op')])
    await new ConductorStore(tables).recordLedgerEvent('task', dispatch, time, 'op')
    expect(first.getLedger('task')?.dispatches).toBe(1)
    expect(first.getLedger('task')?.countedOperationIds).toEqual(['op'])
  })

  it('does not lose increments from concurrent different operations', async () => {
    const store = new ConductorStore(createInMemoryTables())
    await Promise.all([store.recordLedgerEvent('group', dispatch, time, 'a'),
      store.recordLedgerEvent('group', dispatch, time, 'b')])
    expect(store.getLedger('group')?.dispatches).toBe(2)
    expect(store.getLedger('group')?.countedOperationIds).toEqual(['a', 'b'])
  })

  it('preserves dispatch identities across manual events and legacy ledger writes', async () => {
    const store = new ConductorStore(createInMemoryTables())
    await store.recordLedgerEvent('task', dispatch, time, 'op')
    await store.recordLedgerEvent('task', { kind: 'acceptance' }, time)
    await store.recordLedgerEvent('task', { kind: 'usage', tokens: { quality: 'actual_full', value: 12 } }, time)
    const { countedOperationIds: _ids, ...legacy } = store.getLedger('task')!
    await store.putLedger(legacy)
    await store.updateLedger('task', current => {
      const { countedOperationIds: _currentIds, ...withoutIds } = current
      return withoutIds
    })
    await store.recordLedgerEvent('task', dispatch, time, 'op')
    expect(store.getLedger('task')).toMatchObject({ dispatches: 1, acceptances: 1,
      tokens: { quality: 'actual_full', value: 12 }, countedOperationIds: ['op'] })
  })

  it('does not remember an operation when the atomic ledger write failed', async () => {
    const tables = createInMemoryTables()
    const store = new ConductorStore(tables)
    tables.ledgers.failNextWrites(1)
    await expect(store.recordLedgerEvent('task', dispatch, time, 'op')).rejects.toThrow(/injected/)
    await store.recordLedgerEvent('task', dispatch, time, 'op')
    expect(store.getLedger('task')).toMatchObject({ dispatches: 1, countedOperationIds: ['op'] })
  })
})
