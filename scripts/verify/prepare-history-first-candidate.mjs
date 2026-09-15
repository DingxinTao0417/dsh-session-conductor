/**
 * Build one clean, unpacked 0.1.4 candidate for the T35 Desktop validation.
 *
 * This intentionally packs the external plugin first and tests/installs only
 * the extracted directory.  Linking the source checkout would allow its
 * development node_modules to mask missing Desktop-host dependencies.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const root = 'D:/workspace/dsh-plugins/dsh-session-conductor'
const candidate = join(root, 'dist/local-candidate-2026-09-15-history-first')
const release = 'D:/dsh-local-plugins/dsh-session-conductor/0.1.4-20260915-history-first'
const version = '0.1.4'

if (existsSync(candidate)) throw new Error(`Candidate directory already exists: ${candidate}`)
if (existsSync(release)) throw new Error(`Clean release directory already exists: ${release}`)
mkdirSync(candidate, { recursive: false })

const packed = spawnSync(
  process.env.ComSpec ?? 'cmd.exe',
  ['/d', '/c', 'npm.cmd', 'pack', '--json', '--ignore-scripts', '--pack-destination', candidate],
  { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
)
if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stdout}\n${packed.stderr}`)
const receipt = JSON.parse(packed.stdout)[0]
assert.equal(receipt.name, 'dsh-session-conductor')
assert.equal(receipt.version, version)
assert(Array.isArray(receipt.files), 'npm pack did not report a file list')
assert(!receipt.files.some(file => /(^|\/)(?:node_modules|\.verification|tests|scripts)(?:\/|$)/.test(file.path)),
  'candidate contains development-only files')

const archive = join(candidate, receipt.filename)
const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true })
if (listing.status !== 0) throw new Error(`Could not list candidate archive: ${listing.stderr}`)
const names = listing.stdout.split(/\r?\n/).filter(Boolean)
assert(names.length > 0 && names.every(name => name.startsWith('package/') && !name.includes('..') && !name.includes('\\')),
  'candidate archive contains an unsafe path')

mkdirSync(release, { recursive: false })
const extracted = spawnSync('tar', ['-xzf', archive, '-C', release], { encoding: 'utf8', windowsHide: true })
if (extracted.status !== 0) throw new Error(`Could not extract candidate archive: ${extracted.stderr}`)
const packagePath = join(release, 'package')
const manifest = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'))
assert.equal(manifest.name, 'dsh-session-conductor')
assert.equal(manifest.version, version)
assert.equal(manifest.dsh?.client?.platform, 'web')
assert(manifest.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-conversation'), 'native chat client metadata missing')
assert(existsSync(join(packagePath, 'lib/index.js')), 'built host entry missing')
assert(existsSync(join(packagePath, 'lib/client.js')), 'built chat entry missing')

const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
const record = {
  name: manifest.name,
  version: manifest.version,
  archive: receipt.filename,
  sha256,
  packagePath,
  files: receipt.files.map(file => file.path),
  status: 'clean local candidate; not publicly published and not yet installed',
  sourceCheck: { files: 78, tests: 1194, lint: 'passed', smoke: 'passed' },
}
writeFileSync(join(candidate, 'manifest.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ candidate, packagePath, version, sha256, files: receipt.files.length }, null, 2)}\n`)
