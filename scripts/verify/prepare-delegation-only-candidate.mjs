/**
 * Build the 0.1.5 delegation-only release in a fresh external directory.
 *
 * The candidate is intentionally a packed and extracted package rather than
 * the source checkout.  That makes a later Desktop Host/Edge proof exercise
 * the same isolated files that an offline profile upgrade will select.
 *
 * This script never changes a Desktop Profile or starts/stops Desktop.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CANDIDATE,
  CLEAN_PACKAGE,
  CLEAN_RELEASE,
  ROOT,
  VERSION,
  assertArchiveNames,
  assertCleanPackage,
  listRegularFiles,
  readJson,
  run,
  sha256,
} from './delegation-only-common.mjs'

function assertCandidateFileList(files) {
  assert(Array.isArray(files) && files.length > 0, 'npm pack did not report a file list')
  const paths = files.map(file => String(file.path).replaceAll('\\', '/'))
  assert.equal(new Set(paths).size, paths.length, 'npm pack reported duplicate candidate paths')
  assert(
    paths.every(path => !/(^|\/)(?:node_modules|\.verification|tests|scripts)(?:\/|$)/.test(path)),
    'Candidate contains development-only files',
  )
  assert(paths.every(path => !path.startsWith('/') && !path.includes('..')), 'Candidate contains an unsafe file path')
  return paths
}

if (existsSync(CANDIDATE)) throw new Error('Candidate directory already exists: ' + CANDIDATE)
if (existsSync(CLEAN_RELEASE)) throw new Error('Clean release directory already exists: ' + CLEAN_RELEASE)

const sourceManifest = readJson(join(ROOT, 'package.json'))
assert.equal(sourceManifest.name, 'dsh-session-conductor')
assert.equal(sourceManifest.version, VERSION,
  'Source package version must be ' + VERSION + ' before preparing the delegation-only candidate')

mkdirSync(CANDIDATE, { recursive: false })
const packed = run(
  process.env.ComSpec ?? 'cmd.exe',
  ['/d', '/c', 'npm.cmd', 'pack', '--json', '--ignore-scripts', '--pack-destination', CANDIDATE],
  { cwd: ROOT },
)

let packReceipt
try {
  packReceipt = JSON.parse(packed.stdout)[0]
} catch (error) {
  throw new Error('npm pack did not return JSON: ' + (error instanceof Error ? error.message : String(error)))
}
assert.equal(packReceipt?.name, 'dsh-session-conductor')
assert.equal(packReceipt?.version, VERSION)
const files = assertCandidateFileList(packReceipt.files)
const archive = join(CANDIDATE, packReceipt.filename)
const archiveNames = assertArchiveNames(archive)
assert.equal(archiveNames.filter(name => name === 'package/package.json').length, 1,
  'Candidate archive must contain exactly one package/package.json')

mkdirSync(CLEAN_RELEASE, { recursive: false })
run('tar', ['-xzf', archive, '-C', CLEAN_RELEASE])
const clean = assertCleanPackage(CLEAN_PACKAGE)
const packageFiles = Object.fromEntries(listRegularFiles(CLEAN_PACKAGE))

const record = {
  name: clean.manifest.name,
  version: clean.manifest.version,
  archive: packReceipt.filename,
  sha256: sha256(archive),
  packagePath: CLEAN_PACKAGE,
  files,
  packageFileHashes: packageFiles,
  status: 'clean local candidate; not installed, not published',
  nextRequiredProof: {
    environmentVariable: 'CONDUCTOR_DELEGATION_PROOF',
    packagePath: CLEAN_PACKAGE,
    requiredAssertions: [
      'ok === true',
      'portReleased === true',
      'responseInterception === false',
      'receipt.providerCalls === 0',
      'non-empty assertions',
    ],
    purpose: 'Prove the isolated 0.1.5 Host/Edge path before an offline Desktop Profile upgrade.',
  },
}
writeFileSync(join(CANDIDATE, 'manifest.json'), JSON.stringify(record, null, 2) + '\n', 'utf8')
process.stdout.write(JSON.stringify({
  candidate: CANDIDATE,
  packagePath: CLEAN_PACKAGE,
  version: VERSION,
  sha256: record.sha256,
  packageFiles: Object.keys(packageFiles).length,
  installed: false,
}, null, 2) + '\n')
