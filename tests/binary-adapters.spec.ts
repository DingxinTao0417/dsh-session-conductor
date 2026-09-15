import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { snapshotIoOf, transferFsOf } from '../src/adapters.ts'
import { snapshotCopy } from '../src/service/transfer.ts'
import { newArtifactRecord } from '../src/service/artifacts.ts'
import { mountedPlugin } from './helpers/mounted-plugin.ts'

const NOW = '2026-09-15T00:00:00Z'
const BYTES = Uint8Array.from({ length: 256 }, (_, i) => i)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const opened: Awaited<ReturnType<typeof mountedPlugin>>[] = []
afterEach(async () => { for (const plugin of opened.splice(0)) await plugin.close() })

function fixture() {
  const files = new Map<string, Uint8Array>([['D:/source/input.bin', BYTES.slice()]])
  const writes: { path: string; kind: string; bytes: Uint8Array }[] = []
  let afterRead: (() => Promise<void>) | undefined
  let truncate = false
  const services = {
    fs: {
      resolve: async (path: string) => path,
      contains: (root: string, target: string) => target === root || target.startsWith(`${root}/`),
      lstat: async (path: string) => files.has(path) ? { type: 'file' } : undefined,
      stat: async (path: string) => {
        const bytes = files.get(path)
        return bytes === undefined ? undefined : { type: 'file', size: bytes.length, version: hash(bytes) }
      },
      readBytes: async (path: string, _signal: AbortSignal | undefined, maxBytes: number) => {
        const bytes = files.get(path)
        if (bytes === undefined) throw new Error('FS_NOT_FOUND')
        const copy = bytes.slice(0, truncate ? 3 : maxBytes)
        await afterRead?.()
        return copy
      },
      readText: async () => { throw new Error('FS_NOT_TEXT') },
      writeText: async () => { throw new Error('binary path must not use text write') },
    },
    conductorBinaryFiles: {
      version: 1,
      maxBytes: 1024,
      writeBytes: async (path: string, bytes: Uint8Array, expected: { kind: string }) => {
        if (expected.kind !== 'createIfAbsent' || files.has(path)) throw new Error('FS_NOT_OBSERVED')
        files.set(path, bytes.slice())
        writes.push({ path, kind: expected.kind, bytes: bytes.slice() })
        return { operation: 'create', version: hash(bytes), sizeBytes: bytes.length, sha256: hash(bytes) }
      },
    },
  }
  return {
    files, writes, services,
    lookup: { get: (name: string) => (services as Record<string, unknown>)[name] },
    onRead: (fn: () => Promise<void>) => { afterRead = fn },
    truncate: () => { truncate = true },
  }
}

function artifact(taskId = 'source') {
  return {
    ...newArtifactRecord({ artifactId: 'bytes', taskId, kind: 'file', name: 'input.bin',
      hostId: 'local', path: 'D:/source/input.bin' }, NOW),
    existence: 'present' as const, contentHash: hash(BYTES), hashScope: 'full' as const,
  }
}

describe('binary companion through the production filesystem adapters', () => {
  it('copies all 256 byte values through the guarded Host provider and verifies readback', async () => {
    const held = fixture()
    await snapshotIoOf(held.lookup)!.copyFile('D:/source/input.bin', 'D:/target/copy.bin', {
      source: 'D:/source', target: 'D:/target',
    })
    expect(held.writes).toEqual([{ path: 'D:/target/copy.bin', kind: 'createIfAbsent', bytes: BYTES }])
  })

  it.each(['truncated', 'changed', 'oversized', 'outside'] as const)('refuses %s sources or destinations without writing', async mode => {
    const held = fixture()
    if (mode === 'truncated') held.truncate()
    if (mode === 'changed') held.onRead(async () => { held.files.set('D:/source/input.bin', new Uint8Array(256)) })
    if (mode === 'oversized') held.services.conductorBinaryFiles.maxBytes = 128
    await expect(snapshotIoOf(held.lookup)!.copyFile('D:/source/input.bin', mode === 'outside' ? 'D:/elsewhere/x' : 'D:/target/copy.bin', {
      source: 'D:/source', target: 'D:/target',
    })).rejects.toThrow()
    expect(held.writes).toEqual([])
  })

  it('does not reinterpret bytes through text when the extension is missing', async () => {
    const held = fixture()
    await expect(snapshotIoOf({ get: name => name === 'fs' ? held.services.fs : undefined })!
      .copyFile('D:/source/input.bin', 'D:/target/copy.bin')).rejects.toThrow('FS_NOT_TEXT')
    expect(held.writes).toEqual([])
  })
  it('refuses a destination alias that changes identity within the permitted root during source reading', async () => {
    const held = fixture()
    let moved = false
    held.services.fs.resolve = async path => path === 'D:/target/copy.bin'
      ? moved ? 'D:/target/new/copy.bin' : 'D:/target/old/copy.bin' : path
    held.onRead(async () => { moved = true })
    await expect(snapshotIoOf(held.lookup)!.copyFile('D:/source/input.bin', 'D:/target/copy.bin', {
      source: 'D:/source', target: 'D:/target',
    })).rejects.toThrow(/identity|changed/)
    expect(held.writes).toEqual([])
  })
  it('does not certify a snapshot when the byte writer reports replacement instead of exclusive creation', async () => {
    const held = fixture()
    const write = held.services.conductorBinaryFiles.writeBytes
    held.services.conductorBinaryFiles.writeBytes = async (...args) => ({ ...await write(...args), operation: 'update' })
    await expect(snapshotIoOf(held.lookup)!.copyFile('D:/source/input.bin', 'D:/target/copy.bin')).rejects.toThrow(/receipt/)
  })

  it('uses full source hashes and exclusive creation for binary artifact snapshots', async () => {
    const held = fixture()
    const request = { transferId: 'copy', artifact: artifact(), toTaskId: 'target', destination: 'D:/target/input.bin', now: NOW }
    expect((await snapshotCopy(request, transferFsOf(held.lookup)!)).record.verified).toBe(true)
    const repeated = await snapshotCopy(request, transferFsOf(held.lookup)!)
    expect(repeated.record.applied).toBe(false)
    expect(repeated.record.conflicts.join(' ')).toContain('already exists')
    held.files.set('D:/source/input.bin', new Uint8Array(256))
    const changed = await snapshotCopy({ ...request, destination: 'D:/target/changed.bin' }, transferFsOf(held.lookup)!)
    expect(changed.record.conflicts.join(' ')).toContain('source changed')
    expect(held.writes).toHaveLength(1)
  })

  it('connects byte capability to the actual transfer and attachment-export tools', async () => {
    const held = fixture()
    const plugin = await mountedPlugin(held.services)
    opened.push(plugin)
    await plugin.store.createTask({ ...plugin.store.getTask('target')!, taskId: 'source', currentBindingId: undefined } as never)
    await plugin.store.putAccess({ ...plugin.store.getAccess('target')!, taskId: 'source' })
    await plugin.store.putArtifact(artifact())
    const transferred = await plugin.call('conductor_transfer', {
      mode: 'snapshot_copy', artifactId: 'bytes', toTaskId: 'target', destination: 'D:/target/bytes.bin',
    })
    expect(transferred.verified).toBe(true)
    const exported = await plugin.call('conductor_export', {
      action: 'export', taskId: 'source', attachmentIds: ['bytes'], bundleDirectory: 'D:/bundle',
    })
    expect(exported.problems).toEqual([])
    expect(held.files.get('D:/bundle/bytes-input.bin')).toEqual(BYTES)
  })

  it('rechecks controller epoch after byte reads before writing an export attachment', async () => {
    const held = fixture()
    const plugin = await mountedPlugin(held.services)
    opened.push(plugin)
    await plugin.store.putArtifact(artifact('target'))
    held.onRead(async () => {
      await plugin.store.putAccess({ ...plugin.store.getAccess('target')!, ownerSessionId: 'next', ownerEpoch: 1 })
    })
    const result = await plugin.call('conductor_export', {
      action: 'export', taskId: 'target', attachmentIds: ['bytes'], bundleDirectory: 'D:/bundle',
    })
    expect(String(result.problems)).toMatch(/CONTROLLER|EPOCH/)
    expect(held.writes).toEqual([])
  })
})
