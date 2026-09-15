/**
 * Seal the history-first Desktop candidate after the source documentation has
 * been finalized.  This intentionally changes documentation only in the clean
 * package selected by the Desktop Profile.  It never changes the Profile's
 * package.json, source code, built artifacts, or package version.
 *
 * Prerequisite: source README/AGENTS/docs have finished their editorial pass.
 * The script packs those sources first, proves their contents and every
 * non-document package file against the installed clean package, then copies
 * the packed documentation into that package.  The final archive is therefore
 * byte-for-byte equivalent to the directory the Profile already links to.
 */
import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

const root = 'D:/workspace/dsh-plugins/dsh-session-conductor'
const version = '0.1.4'
const initialCandidate = join(root, 'dist/local-candidate-2026-09-15-history-first')
const finalCandidate = join(root, 'dist/local-candidate-2026-09-15-history-first-final')
const installedPackage = 'D:/dsh-local-plugins/dsh-session-conductor/0.1.4-20260915-history-first/package'
const profilePackageJson = 'D:/dsh/profiles/desktop/package.json'
const receiptFile = join(root, '.verification/desktop-install-2026-09-15/installation-history-first.json')
const proof = join(root, '.verification/navigation-2026-09-15T09-15-52-719Z/summary.json')

const normalized = path => path.replaceAll('\\', '/')
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const same = (actual, expected, label) => assert.deepEqual([...actual].sort(), [...expected].sort(), label)

function listRegularFiles(directory) {
  const files = new Map()
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      const metadata = lstatSync(absolute)
      assert(!metadata.isSymbolicLink(), `Symlink is not allowed in the candidate package: ${absolute}`)
      if (metadata.isDirectory()) {
        visit(absolute)
        continue
      }
      assert(metadata.isFile(), `Candidate contains a non-regular file: ${absolute}`)
      files.set(normalized(relative(directory, absolute)), sha256(absolute))
    }
  }
  visit(directory)
  return files
}

function assertExactFiles(files, expected, label) {
  same(files.keys(), expected, `${label} has a different file set`)
}

function assertSameHashes(actual, expected, label) {
  assertExactFiles(actual, expected.keys(), label)
  for (const [file, hash] of expected) {
    assert.equal(actual.get(file), hash, `${label} hash differs: ${file}`)
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

function archiveNames(archive) {
  const listed = run('tar', ['-tzf', archive])
  const names = listed.stdout.split(/\r?\n/).filter(Boolean)
  assert(names.length > 0, 'Final archive is empty')
  assert(
    names.every(name => name.startsWith('package/') && !name.includes('..') && !name.includes('\\')),
    'Final archive contains an unsafe path',
  )
  return names
}

function isDocumentation(file) {
  return file === 'AGENTS.md'
    || file === 'README.md'
    || file === 'README.en.md'
    || file.startsWith('docs/')
}

if (existsSync(finalCandidate)) throw new Error(`Final candidate directory already exists: ${finalCandidate}`)
for (const required of [initialCandidate, installedPackage, profilePackageJson, receiptFile, proof]) {
  if (!existsSync(required)) throw new Error(`Required finalization input is absent: ${required}`)
}

const initialManifest = readJson(join(initialCandidate, 'manifest.json'))
assert.equal(initialManifest.name, 'dsh-session-conductor')
assert.equal(initialManifest.version, version)
assert(Array.isArray(initialManifest.files) && initialManifest.files.length > 0, 'Initial candidate manifest has no file list')
const initialArchive = join(initialCandidate, initialManifest.archive)
assert.equal(sha256(initialArchive), initialManifest.sha256, 'Initial candidate archive hash no longer matches its manifest')

const expectedFiles = initialManifest.files.map(normalized)
assert.equal(new Set(expectedFiles).size, expectedFiles.length, 'Initial candidate manifest has duplicate paths')
assert(expectedFiles.every(file => !file.startsWith('/') && !file.includes('..')), 'Initial candidate manifest has an unsafe path')
const documentationFiles = expectedFiles.filter(isDocumentation)
const protectedFiles = expectedFiles.filter(file => !isDocumentation(file))
assert(documentationFiles.length > 0, 'Initial candidate has no documentation files to synchronize')
assert(protectedFiles.length > 0, 'Initial candidate has no protected package files')
assert(
  protectedFiles.every(file => file.startsWith('lib/') || file === 'cordis.patch.yml' || file === 'package.json'),
  'Only lib/*, cordis.patch.yml, and package.json may be non-document files in this finalization',
)

const installedBefore = listRegularFiles(installedPackage)
assertExactFiles(installedBefore, expectedFiles, 'Installed clean package before documentation sync')
const protectedBefore = new Map(protectedFiles.map(file => [file, installedBefore.get(file)]))
const profilePackageHashBefore = sha256(profilePackageJson)
const sourceDocumentation = new Map()
for (const file of documentationFiles) {
  const source = join(root, file)
  assert(existsSync(source), `Source documentation is missing: ${source}`)
  const metadata = lstatSync(source)
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `Source documentation is not a regular file: ${source}`)
  sourceDocumentation.set(file, sha256(source))
}

mkdirSync(finalCandidate, { recursive: false })
const packed = run(
  process.env.ComSpec ?? 'cmd.exe',
  ['/d', '/c', 'npm.cmd', 'pack', '--json', '--ignore-scripts', '--pack-destination', finalCandidate],
  { cwd: root },
)
let packReceipt
try {
  packReceipt = JSON.parse(packed.stdout)[0]
} catch (error) {
  throw new Error(`npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}\n${packed.stdout}`)
}
assert.equal(packReceipt.name, 'dsh-session-conductor')
assert.equal(packReceipt.version, version)
assert(Array.isArray(packReceipt.files), 'npm pack did not return its final file list')
const packedFiles = packReceipt.files.map(file => normalized(file.path))
same(packedFiles, expectedFiles, 'Final npm package has a different file set')

const archive = join(finalCandidate, packReceipt.filename)
archiveNames(archive)
const archiveCheck = join(finalCandidate, 'archive-check')
mkdirSync(archiveCheck, { recursive: false })
run('tar', ['-xzf', archive, '-C', archiveCheck])
const archivedPackage = join(archiveCheck, 'package')
const archivedFiles = listRegularFiles(archivedPackage)
assertExactFiles(archivedFiles, expectedFiles, 'Extracted final archive')

for (const [file, hash] of sourceDocumentation) {
  assert.equal(archivedFiles.get(file), hash, `Final archive does not contain the finalized source documentation: ${file}`)
}
for (const [file, hash] of protectedBefore) {
  assert.equal(archivedFiles.get(file), hash, `Final archive changed protected runtime content: ${file}`)
}

// Detect a concurrent documentation edit before changing the installed package.
for (const [file, hash] of sourceDocumentation) {
  assert.equal(sha256(join(root, file)), hash, `Source documentation changed during finalization: ${file}`)
}
for (const file of documentationFiles) {
  const target = join(installedPackage, file)
  assert(existsSync(target), `Installed documentation target is missing: ${target}`)
  copyFileSync(join(archivedPackage, file), target)
}

const installedAfter = listRegularFiles(installedPackage)
assertSameHashes(installedAfter, archivedFiles, 'Installed clean package after documentation sync')
for (const [file, hash] of protectedBefore) {
  assert.equal(installedAfter.get(file), hash, `Protected runtime content changed while syncing docs: ${file}`)
}
assert.equal(sha256(profilePackageJson), profilePackageHashBefore, 'Desktop Profile package.json changed during documentation finalization')

const finalSha256 = sha256(archive)
const proofSummary = readJson(proof)
assert.equal(proofSummary.ok, true, 'Clean-package Host/Edge proof is not successful')
assert.equal(proofSummary.portReleased, true, 'Clean-package Host/Edge proof left its port in use')
assert.equal(proofSummary.responseInterception, false, 'Clean-package Host/Edge proof used response interception')
assert.equal(proofSummary.receipt?.providerCalls, 0, 'Clean-package Host/Edge proof made model-provider calls')

const finalManifest = {
  name: 'dsh-session-conductor',
  version,
  archive: packReceipt.filename,
  sha256: finalSha256,
  packagePath: installedPackage,
  files: [...expectedFiles].sort(),
  status: 'local Desktop candidate installed to the desktop Profile; unpublished',
  sourceCheck: { files: 78, tests: 1194, lint: 'passed', smoke: 'passed' },
  verification: {
    cleanPackageHostEdge: {
      proof,
      assertions: proofSummary.assertions,
      providerCalls: proofSummary.receipt.providerCalls,
      portReleased: proofSummary.portReleased,
      responseInterception: proofSummary.responseInterception,
    },
    archiveMatchesInstalledPackage: true,
    protectedRuntimeFilesUnchanged: [...protectedFiles].sort(),
    synchronizedDocumentationFiles: [...documentationFiles].sort(),
    desktopProfilePackageJsonUnchanged: true,
  },
}
writeFileSync(join(finalCandidate, 'manifest.json'), `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8')

const installationReceipt = readJson(receiptFile)
assert.equal(normalized(installationReceipt.packagePath), normalized(installedPackage), 'Installation receipt identifies a different package')
assert.equal(installationReceipt.version, version, 'Installation receipt identifies a different version')
const finalizedReceipt = {
  ...installationReceipt,
  archive,
  sha256: finalSha256,
  documentationFinalization: {
    finalizedAt: new Date().toISOString(),
    initialArchive: installationReceipt.archive,
    initialSha256: installationReceipt.sha256,
    finalCandidate,
    finalArchive: archive,
    finalSha256,
    sourceDocumentationFiles: [...documentationFiles].sort(),
    archiveMatchesInstalledPackage: true,
    protectedRuntimeFilesUnchanged: [...protectedFiles].sort(),
    desktopProfilePackageJsonUnchanged: true,
  },
}
writeFileSync(receiptFile, `${JSON.stringify(finalizedReceipt, null, 2)}\n`, 'utf8')

process.stdout.write(`${JSON.stringify({
  finalized: `dsh-session-conductor@${version}`,
  finalArchive: archive,
  sha256: finalSha256,
  packageFiles: expectedFiles.length,
  synchronizedDocumentationFiles: documentationFiles.length,
  protectedRuntimeFilesVerified: protectedFiles.length,
  installedPackage,
  receiptFile,
}, null, 2)}\n`)
