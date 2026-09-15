/**
 * In-memory implementations of the conductor's tables.
 *
 * They exist for two reasons the specification asks for directly:
 *
 * - **fault injection** (PRD §五.2): a crash window is tested by making a write
 *   fail at a chosen point, which needs a table whose failure the test controls;
 * - **tests without a Host**: the store's rules are about ordering and
 *   idempotency, not about JSON files, so they are verified against these.
 *
 * They deliberately mirror the Host's `KvTable` semantics rather than improving
 * on them: writes become visible only after resolution, and `update` is a
 * read-modify-write applied at the moment it runs.
 *
 * @module dsh-session-conductor/store/memory
 */

import type { ConductorTables, TableLike } from './repository.ts'

/** A table whose next write can be made to fail, for crash-window tests. */
export interface FaultableTable<K extends string, V> extends TableLike<K, V> {
  /**
   * Make the next `count` writes reject before touching state.
   * @param count - how many writes to fail; `Infinity` fails until reset.
   */
  failNextWrites(count: number): void
  /** Stop failing writes. */
  clearFailures(): void
  /** How many writes this table has attempted, failed ones included. */
  readonly writeAttempts: number
}

/** One in-memory table. */
class MemoryTable<K extends string, V> implements FaultableTable<K, V> {
  private readonly records = new Map<K, V>()
  private remainingFailures = 0

  writeAttempts = 0

  get(key: K): V | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[K, V]> {
    return new Map(this.records).entries()
  }

  keys(): IterableIterator<K> {
    return new Map(this.records).keys()
  }

  get size(): number {
    return this.records.size
  }

  async put(key: K, value: V): Promise<void> {
    this.beforeWrite()
    this.records.set(key, value)
  }

  async delete(key: K): Promise<boolean> {
    this.beforeWrite()
    return this.records.delete(key)
  }

  async update(key: K, fn: (current: V) => V): Promise<V> {
    this.beforeWrite()
    const current = this.records.get(key)
    if (current === undefined) {
      throw new Error(`memory-table: missing key ${String(key)}`)
    }
    const next = fn(current)
    this.records.set(key, next)
    return next
  }

  failNextWrites(count: number): void {
    this.remainingFailures = count
  }

  clearFailures(): void {
    this.remainingFailures = 0
  }

  /** Count the attempt and reject when the table is armed to fail. */
  private beforeWrite(): void {
    this.writeAttempts += 1
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1
      throw new Error('memory-table: injected write failure')
    }
  }
}

/** The conductor's tables, held in memory, with per-table fault injection. */
export interface InMemoryConductorTables extends ConductorTables {
  readonly tasks: FaultableTable<string, ConductorTables['tasks'] extends TableLike<string, infer V> ? V : never>
  readonly bindings: FaultableTable<string, ConductorTables['bindings'] extends TableLike<string, infer V> ? V : never>
  readonly access: FaultableTable<string, ConductorTables['access'] extends TableLike<string, infer V> ? V : never>
  readonly operations: FaultableTable<string, ConductorTables['operations'] extends TableLike<string, infer V> ? V : never>
  readonly watches: FaultableTable<string, ConductorTables['watches'] extends TableLike<string, infer V> ? V : never>
  readonly notifications: FaultableTable<string, ConductorTables['notifications'] extends TableLike<string, infer V> ? V : never>
  readonly contexts: FaultableTable<string, ConductorTables['contexts'] extends TableLike<string, infer V> ? V : never>
  readonly artifacts: FaultableTable<string, ConductorTables['artifacts'] extends TableLike<string, infer V> ? V : never>
  readonly transfers: FaultableTable<string, ConductorTables['transfers'] extends TableLike<string, infer V> ? V : never>
  readonly rules: FaultableTable<string, ConductorTables['rules'] extends TableLike<string, infer V> ? V : never>
  readonly schedules: FaultableTable<string, ConductorTables['schedules'] extends TableLike<string, infer V> ? V : never>
  readonly workflows: FaultableTable<string, ConductorTables['workflows'] extends TableLike<string, infer V> ? V : never>
  readonly workflow_runs: FaultableTable<string, ConductorTables['workflow_runs'] extends TableLike<string, infer V> ? V : never>
  readonly constraints: FaultableTable<string, ConductorTables['constraints'] extends TableLike<string, infer V> ? V : never>
  readonly constraint_deliveries: FaultableTable<string, ConductorTables['constraint_deliveries'] extends TableLike<string, infer V> ? V : never>
  readonly budgets: FaultableTable<string, ConductorTables['budgets'] extends TableLike<string, infer V> ? V : never>
  readonly ledgers: FaultableTable<string, ConductorTables['ledgers'] extends TableLike<string, infer V> ? V : never>
  readonly remote_hosts: FaultableTable<string, ConductorTables['remote_hosts'] extends TableLike<string, infer V> ? V : never>
  readonly shares: FaultableTable<string, ConductorTables['shares'] extends TableLike<string, infer V> ? V : never>
  readonly resources: FaultableTable<string, ConductorTables['resources'] extends TableLike<string, infer V> ? V : never>
}

/**
 * Build a fresh set of in-memory tables.
 * @returns the tables, each individually fault-injectable.
 */
export function createInMemoryTables(): InMemoryConductorTables {
  return {
    tasks: new MemoryTable(),
    bindings: new MemoryTable(),
    access: new MemoryTable(),
    operations: new MemoryTable(),
    watches: new MemoryTable(),
    notifications: new MemoryTable(),
    contexts: new MemoryTable(),
    artifacts: new MemoryTable(),
    transfers: new MemoryTable(),
    rules: new MemoryTable(),
    schedules: new MemoryTable(),
    workflows: new MemoryTable(),
    workflow_runs: new MemoryTable(),
    constraints: new MemoryTable(),
    constraint_deliveries: new MemoryTable(),
    budgets: new MemoryTable(),
    ledgers: new MemoryTable(),
    remote_hosts: new MemoryTable(),
    shares: new MemoryTable(),
    resources: new MemoryTable(),
  } as InMemoryConductorTables
}
