import { randomUUID } from 'node:crypto'
import { link, open, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Publish a fully flushed inode without ever replacing an existing immutable record. */
export async function commitImmutableFile(directory: string, name: string, contents: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,160}\.(?:json|revoked)$/.test(name)) throw new Error('invalid snapshot filename')
  // Staging names cannot be mistaken for published snapshots during restart. A crash
  // before link leaves only an ignored staging file; after link the complete file exists.
  const staging = join(directory, `.snapshot-${randomUUID()}.pending`)
  try {
    await writeFile(staging, contents, {flag: 'wx', mode: 0o600, flush: true})
    await link(staging, join(directory, name))
    // fsync of the containing directory persists the link on systems that expose it.
    // Windows does not provide directory handles through this Node API; the file
    // contents are still flushed, but sudden power-loss durability is platform-specific.
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r')
      try { await parent.sync() } finally { await parent.close() }
    }
  } finally {
    // Failure to remove a staging link must not turn a committed publication into
    // an apparent rejection. Restart ignores it and never treats it as another share.
    await unlink(staging).catch(() => undefined)
  }
}

/** Bound restart reads just as tightly as incoming requests, including growing files. */
export async function readSnapshotFile(path: string, maximumBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error('invalid snapshot storage size or type')
    const buffer = Buffer.alloc(maximumBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null)
      if (read.bytesRead === 0) break
      size += read.bytesRead
    }
    if (size > maximumBytes) throw new Error('snapshot storage exceeds limit')
    return new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, size))
  } finally { await handle.close() }
}
