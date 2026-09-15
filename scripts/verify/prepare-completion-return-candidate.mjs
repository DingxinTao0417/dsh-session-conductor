/**
 * Pack dsh-session-conductor 0.1.6 and extract it into an isolated external
 * directory for the completion-return release candidate.
 *
 * This script does not inspect or change a Desktop Profile and does not start
 * or stop DSH Desktop.  It refuses to overwrite a previous candidate or clean
 * release directory, making the later offline install input immutable by path.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CANDIDATE,
  CLEAN_PACKAGE,
  CLEAN_RELEASE,
  ROOT,
  VERSION,
  assertArchiveNames,
  assertCleanPackage,
  assertSame,
  listRegularFiles,
  normalizePath,
  readJson,
  run,
  sha256,
} from './completion-return-common.mjs'

function candidateFileList(files) {
  assert(Array.isArray(files) && files.length > 0, 'npm pack did not report a candidate file list')
  const paths = files.map(file => String(file.path).replaceAll('\\', '/'))
  assert.equal(new Set(paths).size, paths.length, 'npm pack reported duplicate candidate paths')
  assert(paths.every(path => path.length > 0 && !path.startsWith('/') && !path.includes('..')),
    'Candidate contains an unsafe file path')
  assert(
    paths.every(path => !/(^|\/)(?:node_modules|\.verification|tests|scripts)(?:\/|$)/.test(path)),
    'Candidate contains development-only files',
  )
  return paths.sort()
}

function archiveFileList(archive) {
  return assertArchiveNames(archive)
    .filter(name => !name.endsWith('/'))
    .map(name => name.slice('package/'.length))
    .sort()
}

export function prepareCompletionReturnCandidate() {
  assert(!existsSync(CANDIDATE), `Candidate directory already exists: ${CANDIDATE}`)
  assert(!existsSync(CLEAN_RELEASE), `Clean release directory already exists: ${CLEAN_RELEASE}`)

  const sourceManifest = readJson(join(ROOT, 'package.json'))
  assert.equal(sourceManifest.name, 'dsh-session-conductor')
  assert.equal(sourceManifest.version, VERSION,
    `Source package version must be ${VERSION} before preparing the completion-return candidate`)

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
    throw new Error(`npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  assert.equal(packReceipt?.name, 'dsh-session-conductor')
  assert.equal(packReceipt?.version, VERSION)
  assert(typeof packReceipt?.filename === 'string' && packReceipt.filename.length > 0,
    'npm pack did not return an archive filename')

  const files = candidateFileList(packReceipt.files)
  const archive = join(CANDIDATE, packReceipt.filename)
  assert(existsSync(archive), `npm pack did not create the expected archive: ${archive}`)
  const archiveFiles = archiveFileList(archive)
  assertSame(archiveFiles, files, 'Archive and npm pack file lists differ')
  assert.equal(archiveFiles.filter(file => file === 'package.json').length, 1,
    'Candidate archive must contain exactly one package.json')

  mkdirSync(CLEAN_RELEASE, { recursive: false })
  run('tar', ['-xzf', archive, '-C', CLEAN_RELEASE])
  const clean = assertCleanPackage(CLEAN_PACKAGE)
  const packageFileHashes = Object.fromEntries(listRegularFiles(CLEAN_PACKAGE))
  assertSame(Object.keys(packageFileHashes), files, 'Extracted clean package and npm pack file lists differ')

  const record = {
    schemaVersion: 1,
    name: clean.manifest.name,
    version: clean.manifest.version,
    archive: packReceipt.filename,
    sha256: sha256(archive),
    packagePath: CLEAN_PACKAGE,
    packageJsonSha256: clean.manifestHash,
    files,
    packageFileHashes,
    status: 'clean local completion-return candidate; not installed, not published',
    preparation: {
      source: normalizePath(ROOT),
      sourceVersion: sourceManifest.version,
      archiveFileCount: archiveFiles.length,
      packageFileCount: Object.keys(packageFileHashes).length,
      profileChanged: false,
      desktopStartedOrStopped: false,
    },
  }
  writeFileSync(join(CANDIDATE, 'manifest.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

if (process.argv[1] && normalizePath(fileURLToPath(import.meta.url)) === normalizePath(process.argv[1])) {
  const record = prepareCompletionReturnCandidate()
  process.stdout.write(`${JSON.stringify({
    candidate: CANDIDATE,
    packagePath: CLEAN_PACKAGE,
    version: VERSION,
    sha256: record.sha256,
    packageFiles: Object.keys(record.packageFileHashes).length,
    installed: false,
  }, null, 2)}\n`)
}
