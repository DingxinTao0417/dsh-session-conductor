/**
 * Versioned schema upgrade (PRD §三.6).
 *
 * > 数据升级先备份，再进行有版本标记的迁移。
 * > 迁移失败不推进版本。
 * > 降级不直接读取不兼容的新 schema。
 *
 * The Host's domain `open` still refuses a version mismatch. This module runs
 * **before** that open: it copies the medium, applies each numbered step, and
 * only then lets the Host see the new stamp. A failed step, a failed write, or
 * a failed open restores the backup so the stamped version does not advance.
 *
 * This build's code version is 1, so a live medium stamped 1 is opened as-is
 * and no backup is taken. The chain is what a later bump walks.
 *
 * @module dsh-session-conductor/store/migrate
 */

import { DOMAIN_NAME, DOMAIN_VERSION } from './schema.ts'

/** The JSON medium the Host's kv backend stores for one domain unit. */
export interface StoredMedium {
  readonly unit?: { readonly name?: string; readonly version?: number }
  readonly global?: unknown
  readonly tables?: unknown
}

/** One numbered step from version `from` to `from + 1` (= `to`). */
export interface MigrationStep {
  readonly from: number
  readonly to: number
  readonly migrate: (medium: StoredMedium) => StoredMedium
}

/**
 * Steps this build knows. Empty while `DOMAIN_VERSION` is 1: there is nothing
 * to transform, and a missing step for a later stamp is a hard refuse.
 */
export const MIGRATIONS: readonly MigrationStep[] = []

/** What to do with a stored stamp relative to this build. */
export type UpgradeDecision =
  | { readonly action: 'fresh' }
  | { readonly action: 'open' }
  | { readonly action: 'migrate'; readonly from: number; readonly to: number }
  | { readonly action: 'refuse'; readonly reason: string }

/**
 * Read the stamped version from a parsed medium.
 *
 * @param medium - the document, or undefined when the file is missing.
 * @returns the stamp, or undefined when there is no medium.
 */
export function storedVersionOf(medium: StoredMedium | undefined): number | undefined {
  if (medium === undefined) return undefined
  const version = medium.unit?.version
  return typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : undefined
}

/**
 * Decide whether to open, migrate, or refuse.
 *
 * @param stored - the stamp on disk, or undefined when there is no file.
 * @param code - this build's `DOMAIN_VERSION`.
 * @returns the decision.
 */
export function decideUpgrade(stored: number | undefined, code: number): UpgradeDecision {
  if (stored === undefined) return { action: 'fresh' }
  if (stored === code) return { action: 'open' }
  if (stored > code) {
    return {
      action: 'refuse',
      reason:
        `the stored medium is schema version ${String(stored)} and this build is version ${String(code)}. `
        + 'A downgrade does not read an incompatible newer schema.',
    }
  }
  return { action: 'migrate', from: stored, to: code }
}

/**
 * Name the backup copy of a medium about to be migrated.
 *
 * @param domain - the domain / file stem.
 * @param fromVersion - the stamp being copied.
 * @param at - an ISO-8601 instant, used so two backups do not collide.
 * @returns a file name next to the medium, not a path.
 */
export function backupFileName(domain: string, fromVersion: number, at: string): string {
  const safe = at.replace(/[:.]/g, '-')
  return `${domain}.v${String(fromVersion)}.bak.${safe}.json`
}

/**
 * Apply every step from `from` up to `to`, without writing.
 *
 * A missing step or a throwing step fails and does **not** return a document
 * stamped at `to`. The caller keeps the original.
 *
 * @param medium - the parsed original.
 * @param from - the stamp on disk.
 * @param to - this build's version.
 * @param steps - the chain.
 * @returns the upgraded document, or why not.
 */
export function applyMigrations(
  medium: StoredMedium,
  from: number,
  to: number,
  steps: readonly MigrationStep[] = MIGRATIONS,
): { readonly ok: true; readonly medium: StoredMedium } | { readonly ok: false; readonly reason: string } {
  let current = medium
  let version = from
  while (version < to) {
    const step = steps.find(entry => entry.from === version && entry.to === version + 1)
    if (step === undefined) {
      return {
        ok: false,
        reason:
          `no migration step is registered from schema version ${String(version)} to ${String(version + 1)}, `
          + `so the medium was not upgraded to ${String(to)}`,
      }
    }
    try {
      current = step.migrate(current)
    } catch (error) {
      return {
        ok: false,
        reason:
          `migration from schema version ${String(version)} to ${String(step.to)} failed; `
          + 'the original medium was not overwritten: '
          + (error instanceof Error ? error.message : String(error)),
      }
    }
    const stamped = storedVersionOf(current)
    if (stamped !== step.to) {
      current = {
        ...current,
        unit: { name: current.unit?.name ?? DOMAIN_NAME, version: step.to },
      }
    }
    version = step.to
  }
  return { ok: true, medium: current }
}

/** A string-keyed file surface, so tests do not need a disk. */
export interface MediumFiles {
  read(path: string): Promise<string | undefined>
  write(path: string, contents: string): Promise<void>
}

/** The outcome of preparing a medium for this build's schema. */
export interface PrepareResult {
  readonly action: 'fresh' | 'open' | 'migrated' | 'refused'
  readonly reason?: string | undefined
  readonly backupPath?: string | undefined
}

/**
 * Backup, migrate and replace a stored medium when this build is newer.
 *
 * Order is load-bearing: the backup is written before the upgraded document,
 * and a failed transform does not write the upgraded document at all. Restoring
 * after a later open failure is {@link restoreMediumBackup}.
 *
 * @param opts - paths, versions, the file surface and the clock.
 * @returns what happened, including the backup path when one was written.
 */
export async function prepareStoredMedium(opts: {
  readonly mediumPath: string
  readonly backupDir: string
  readonly codeVersion?: number
  readonly now: string
  readonly files: MediumFiles
  readonly steps?: readonly MigrationStep[]
}): Promise<PrepareResult> {
  const code = opts.codeVersion ?? DOMAIN_VERSION
  const raw = await opts.files.read(opts.mediumPath)
  if (raw === undefined) return { action: 'fresh' }
  let parsed: StoredMedium
  try {
    parsed = JSON.parse(raw) as StoredMedium
  } catch {
    // Let the Host's own open report a malformed medium; we must not invent a
    // "refused" that hides that error, and we must not rewrite the file.
    return { action: 'open' }
  }
  const stored = storedVersionOf(parsed)
  const decision = decideUpgrade(stored, code)
  if (decision.action === 'fresh' || decision.action === 'open') return { action: decision.action }
  if (decision.action === 'refuse') return { action: 'refused', reason: decision.reason }

  const migrated = applyMigrations(parsed, decision.from, decision.to, opts.steps ?? MIGRATIONS)
  if (!migrated.ok) return { action: 'refused', reason: migrated.reason }

  const name = backupFileName(DOMAIN_NAME, decision.from, opts.now)
  const backupPath = `${opts.backupDir.replace(/[\\/]+$/, '')}/${name}`
  await opts.files.write(backupPath, raw)
  await opts.files.write(opts.mediumPath, `${JSON.stringify(migrated.medium, null, 2)}\n`)
  return { action: 'migrated', backupPath }
}

/**
 * Put the backup back over the medium. Used when open fails after a migrate.
 *
 * @param files - the file surface.
 * @param mediumPath - the live medium.
 * @param backupPath - the copy taken before the upgrade.
 */
export async function restoreMediumBackup(
  files: MediumFiles,
  mediumPath: string,
  backupPath: string,
): Promise<void> {
  const backup = await files.read(backupPath)
  if (backup === undefined) {
    throw new Error(`the schema backup ${backupPath} is missing, so the original medium cannot be restored`)
  }
  await files.write(mediumPath, backup)
}
