/**
 * Opening the conductor's domain against the Host's storage facility.
 *
 * Kept apart from {@link ConductorStore} so the store's rules stay testable
 * without a Host, and apart from the plugin entry so the failure vocabulary
 * lives in one place.
 *
 * The Host's domain layer refuses a medium whose stamped version differs, and
 * validates every stored record at open. A mismatch must not be papered over
 * by writing anyway. Numbered upgrades copy the medium first (`store/migrate.ts`)
 * and run *before* that open; a failed step restores the copy so the stamp
 * does not advance. A downgrade refuses to read a newer schema.
 *
 * @module dsh-session-conductor/store/host
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { ConductorStore, type ConductorTables, type TableLike } from './repository.ts'
import { conductorDomain } from './schema.ts'

/** The slice of `ctx.storageDomain` this module uses. */
export interface DomainFacilityLike {
  open(spec: typeof conductorDomain): Promise<Domain<typeof conductorDomain>>
}

/** Result of opening the store. */
export type OpenStoreResult =
  | { readonly ok: true; readonly store: ConductorStore; readonly close: () => Promise<void> }
  | { readonly ok: false; readonly reason: string; readonly code?: string }

/**
 * Bind the Host's typed domain onto the store's structural table interface.
 *
 * @param domain - the opened domain.
 * @returns the tables the store operates on.
 */
function tablesOf(domain: Domain<typeof conductorDomain>): ConductorTables {
  return {
    tasks: domain.table('tasks') as unknown as TableLike<string, ConductorTables['tasks'] extends TableLike<string, infer V> ? V : never>,
    bindings: domain.table('bindings') as unknown as TableLike<string, ConductorTables['bindings'] extends TableLike<string, infer V> ? V : never>,
    access: domain.table('access') as unknown as TableLike<string, ConductorTables['access'] extends TableLike<string, infer V> ? V : never>,
    operations: domain.table('operations') as unknown as TableLike<string, ConductorTables['operations'] extends TableLike<string, infer V> ? V : never>,
    watches: domain.table('watches') as unknown as TableLike<string, ConductorTables['watches'] extends TableLike<string, infer V> ? V : never>,
    notifications: domain.table('notifications') as unknown as TableLike<string, ConductorTables['notifications'] extends TableLike<string, infer V> ? V : never>,
    contexts: domain.table('contexts') as unknown as TableLike<string, ConductorTables['contexts'] extends TableLike<string, infer V> ? V : never>,
    artifacts: domain.table('artifacts') as unknown as TableLike<string, ConductorTables['artifacts'] extends TableLike<string, infer V> ? V : never>,
    transfers: domain.table('transfers') as unknown as TableLike<string, ConductorTables['transfers'] extends TableLike<string, infer V> ? V : never>,
    rules: domain.table('rules') as unknown as TableLike<string, ConductorTables['rules'] extends TableLike<string, infer V> ? V : never>,
    schedules: domain.table('schedules') as unknown as TableLike<string, ConductorTables['schedules'] extends TableLike<string, infer V> ? V : never>,
    workflows: domain.table('workflows') as unknown as TableLike<string, ConductorTables['workflows'] extends TableLike<string, infer V> ? V : never>,
    workflow_runs: domain.table('workflow_runs') as unknown as TableLike<string, ConductorTables['workflow_runs'] extends TableLike<string, infer V> ? V : never>,
    constraints: domain.table('constraints') as unknown as TableLike<string, ConductorTables['constraints'] extends TableLike<string, infer V> ? V : never>,
    constraint_deliveries: domain.table('constraint_deliveries') as unknown as TableLike<string, ConductorTables['constraint_deliveries'] extends TableLike<string, infer V> ? V : never>,
    budgets: domain.table('budgets') as unknown as TableLike<string, ConductorTables['budgets'] extends TableLike<string, infer V> ? V : never>,
    ledgers: domain.table('ledgers') as unknown as TableLike<string, ConductorTables['ledgers'] extends TableLike<string, infer V> ? V : never>,
    remote_hosts: domain.table('remote_hosts') as unknown as TableLike<string, ConductorTables['remote_hosts'] extends TableLike<string, infer V> ? V : never>,
    shares: domain.table('shares') as unknown as TableLike<string, ConductorTables['shares'] extends TableLike<string, infer V> ? V : never>,
    resources: domain.table('resources') as unknown as TableLike<string, ConductorTables['resources'] extends TableLike<string, infer V> ? V : never>,
  }
}

/**
 * Open the conductor domain and wrap it in a store.
 *
 * Every failure mode of the Host's `open` — a missing backend, a version
 * mismatch, a medium that is not valid JSON, a stored record that no longer
 * matches its schema — arrives here as a rejection and is turned into a single
 * readable reason. Nothing is retried and nothing is written.
 *
 * @param facility - the Host storage domain facility.
 * @param now - clock, injectable for tests.
 * @returns the opened store with its disposer, or the reason it could not open.
 */
export async function openConductorStore(
  facility: DomainFacilityLike,
  now?: () => string,
): Promise<OpenStoreResult> {
  let domain: Domain<typeof conductorDomain>
  try {
    domain = await facility.open(conductorDomain)
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return {
      ok: false,
      reason: describeOpenFailure(error),
      ...typeof code === 'string' ? { code } : {},
    }
  }
  return {
    ok: true,
    store: new ConductorStore(tablesOf(domain), now),
    close: async () => { await domain.close() },
  }
}

/**
 * Turn a storage rejection into one operator-readable line.
 * @param error - the thrown value.
 * @returns the reason text.
 */
function describeOpenFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code
  const name = (error as { name?: unknown } | null)?.name
  if (code === 'version-mismatch') {
    return `the stored ${String(name ?? 'domain')} medium was written by a different schema version. `
      + 'This build copies the medium, then applies numbered steps; without a readable copy it will not '
      + `open a mismatched stamp: ${detail}`
  }
  if (code === 'invalid-record') {
    return `a stored record no longer matches this build's schema, so the medium was not opened: ${detail}`
  }
  if (code === 'backend-not-found' || code === 'facet-unsupported') {
    return `this Host composition mounts no usable storage backend for the conductor domain: ${detail}`
  }
  return `opening the conductor storage domain failed: ${detail}`
}
