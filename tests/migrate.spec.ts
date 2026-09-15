import { describe, expect, it } from 'vitest'
import {
  applyMigrations,
  backupFileName,
  decideUpgrade,
  prepareStoredMedium,
  restoreMediumBackup,
  storedVersionOf,
  type MediumFiles,
  type StoredMedium,
} from '../src/store/migrate.ts'

const AT = '2026-09-14T15:00:00.000Z'

function medium(version: number, extra: Partial<StoredMedium> = {}): StoredMedium {
  return { unit: { name: 'session_conductor', version }, global: null, tables: {}, ...extra }
}

function memoryFiles(initial: Record<string, string> = {}): MediumFiles & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial))
  return {
    store,
    read: async (path) => store.get(path),
    write: async (path, contents) => { store.set(path, contents) },
  }
}

describe('schema upgrade (PRD §三.6)', () => {
  it('opens a matching stamp, treats a missing file as fresh, and refuses a newer schema', () => {
    expect(decideUpgrade(undefined, 1)).toEqual({ action: 'fresh' })
    expect(decideUpgrade(1, 1)).toEqual({ action: 'open' })
    expect(decideUpgrade(2, 1)).toMatchObject({
      action: 'refuse',
      reason: expect.stringMatching(/does not read an incompatible newer schema/),
    })
    expect(decideUpgrade(1, 2)).toEqual({ action: 'migrate', from: 1, to: 2 })
  })

  it('names a backup beside the medium, with the from-version in the file name', () => {
    expect(backupFileName('session_conductor', 1, AT))
      .toBe('session_conductor.v1.bak.2026-09-14T15-00-00-000Z.json')
  })

  it('applies numbered steps and stamps the result; a missing or throwing step does not advance', () => {
    const bumped = applyMigrations(medium(1), 1, 2, [{
      from: 1,
      to: 2,
      migrate: (doc) => ({ ...doc, unit: { name: 'session_conductor', version: 2 } }),
    }])
    expect(bumped.ok).toBe(true)
    if (!bumped.ok) return
    expect(storedVersionOf(bumped.medium)).toBe(2)

    const missing = applyMigrations(medium(1), 1, 2, [])
    expect(missing).toMatchObject({ ok: false, reason: expect.stringMatching(/no migration step/) })

    const threw = applyMigrations(medium(1), 1, 2, [{
      from: 1,
      to: 2,
      migrate: () => { throw new Error('boom') },
    }])
    expect(threw).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/failed; the original medium was not overwritten: boom/),
    })
  })

  it('writes the backup before the upgraded medium, and does not write an upgrade when the step fails', async () => {
    const files = memoryFiles({
      '/storages/session_conductor.json': `${JSON.stringify(medium(1), null, 2)}\n`,
    })
    const order: string[] = []
    const tracing: MediumFiles = {
      read: async (path) => files.read(path),
      write: async (path, contents) => {
        order.push(path)
        await files.write(path, contents)
      },
    }
    const prepared = await prepareStoredMedium({
      mediumPath: '/storages/session_conductor.json',
      backupDir: '/storages',
      codeVersion: 2,
      now: AT,
      files: tracing,
      steps: [{
        from: 1,
        to: 2,
        migrate: (doc) => ({ ...doc, unit: { name: 'session_conductor', version: 2 } }),
      }],
    })
    expect(prepared.action).toBe('migrated')
    expect(prepared.backupPath).toBe('/storages/session_conductor.v1.bak.2026-09-14T15-00-00-000Z.json')
    expect(order[0]).toBe(prepared.backupPath)
    expect(order[1]).toBe('/storages/session_conductor.json')
    expect(JSON.parse(files.store.get(prepared.backupPath ?? '') ?? '').unit.version).toBe(1)
    expect(JSON.parse(files.store.get('/storages/session_conductor.json') ?? '').unit.version).toBe(2)

    const refused = memoryFiles({
      '/storages/session_conductor.json': `${JSON.stringify(medium(1), null, 2)}\n`,
    })
    const failed = await prepareStoredMedium({
      mediumPath: '/storages/session_conductor.json',
      backupDir: '/storages',
      codeVersion: 2,
      now: AT,
      files: refused,
      steps: [{ from: 1, to: 2, migrate: () => { throw new Error('nope') } }],
    })
    expect(failed.action).toBe('refused')
    expect(JSON.parse(refused.store.get('/storages/session_conductor.json') ?? '').unit.version).toBe(1)
    expect([...refused.store.keys()]).toEqual(['/storages/session_conductor.json'])
  })

  it('does not rewrite a matching stamp, and restores the backup over a failed later open', async () => {
    const body = `${JSON.stringify(medium(1), null, 2)}\n`
    const files = memoryFiles({ '/storages/session_conductor.json': body })
    const same = await prepareStoredMedium({
      mediumPath: '/storages/session_conductor.json',
      backupDir: '/storages',
      codeVersion: 1,
      now: AT,
      files,
    })
    expect(same.action).toBe('open')
    expect(files.store.size).toBe(1)

    files.store.set('/storages/session_conductor.json', '{"unit":{"version":2}}')
    files.store.set('/storages/backup.json', body)
    await restoreMediumBackup(files, '/storages/session_conductor.json', '/storages/backup.json')
    expect(files.store.get('/storages/session_conductor.json')).toBe(body)
  })

  it('refuses to open a newer medium and leaves it untouched', async () => {
    const body = `${JSON.stringify(medium(2), null, 2)}\n`
    const files = memoryFiles({ '/storages/session_conductor.json': body })
    const result = await prepareStoredMedium({
      mediumPath: '/storages/session_conductor.json',
      backupDir: '/storages',
      codeVersion: 1,
      now: AT,
      files,
    })
    expect(result.action).toBe('refused')
    expect(result.reason).toMatch(/does not read an incompatible newer schema/)
    expect(files.store.get('/storages/session_conductor.json')).toBe(body)
  })
})
