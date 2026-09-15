/**
 * Seal the 0.1.5 delegation-only candidate without changing the Desktop
 * Profile or its clean linked package.  All package copies must already be
 * identical: the initial archive, final archive, and selected clean package.
 *
 * Unlike the older documentation finalizer, this script never copies files
 * into the installed package and never invokes the Desktop CLI.
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CANDIDATE,
  CLEAN_PACKAGE,
  FINAL_CANDIDATE,
  PROFILE,
  PROFILE_FILES,
  RECEIPT,
  ROOT,
  VERSION,
  assertArchiveNames,
  assertCleanPackage,
  assertSameLinkDependency,
  assertSameFileMaps,
  linkedPackageState,
  listRegularFiles,
  normalizePath,
  profileState,
  readJson,
  run,
  same,
  sha256,
} from './delegation-only-common.mjs'

function assertSafeManifestFiles(files, label) {
  assert(Array.isArray(files) && files.length > 0, label + ' has no file list')
  const paths = files.map(file => String(file).replaceAll('\\', '/'))
  assert.equal(new Set(paths).size, paths.length, label + ' has duplicate file paths')
  assert(paths.every(path => !path.startsWith('/') && !path.includes('..')), label + ' has an unsafe file path')
  return paths
}

function assertProof(proofPath) {
  assert(typeof proofPath === 'string' && proofPath.length > 0, 'Installation receipt has no delegation proof path')
  assert(existsSync(proofPath), 'Delegation proof is absent: ' + proofPath)
  const proof = readJson(proofPath)
  assert.equal(proof.ok, true, 'Delegation proof is not successful')
  assert.equal(proof.portReleased, true, 'Delegation proof left its port in use')
  assert.equal(proof.responseInterception, false, 'Delegation proof used response interception')
  assert.equal(proof.receipt?.providerCalls, 0, 'Delegation proof made model-provider calls')
  assert(Array.isArray(proof.assertions) && proof.assertions.length > 0, 'Delegation proof has no assertions')
  const packagePath = proof.packages?.['dsh-session-conductor'] ?? proof.packagePath
  assert.equal(normalizePath(packagePath), normalizePath(CLEAN_PACKAGE),
    'Delegation proof identifies a different clean package')
  return proof
}

function assertProfileAndLink(expectedManifestHash) {
  const profileJson = readJson(join(PROFILE, 'package.json'))
  const state = profileState(profileJson)
  assertSameLinkDependency(
    state.dependencies['dsh-session-conductor'],
    'link:' + CLEAN_PACKAGE,
    'Desktop Profile no longer points to the exact delegation-only clean package',
  )
  const module = linkedPackageState(
    join(PROFILE, 'node_modules/dsh-session-conductor'),
    CLEAN_PACKAGE,
    VERSION,
    expectedManifestHash,
    'Desktop dsh-session-conductor',
  )
  return { profileJson, module }
}

if (existsSync(FINAL_CANDIDATE)) throw new Error('Final candidate directory already exists: ' + FINAL_CANDIDATE)
for (const required of [
  CANDIDATE,
  join(CANDIDATE, 'manifest.json'),
  CLEAN_PACKAGE,
  join(PROFILE, 'package.json'),
  RECEIPT,
]) {
  if (!existsSync(required)) throw new Error('Required finalization input is absent: ' + required)
}
for (const file of PROFILE_FILES) {
  const path = join(PROFILE, file)
  if (!existsSync(path)) throw new Error('Required Desktop Profile file is absent: ' + path)
}

const initialManifest = readJson(join(CANDIDATE, 'manifest.json'))
assert.equal(initialManifest.name, 'dsh-session-conductor')
assert.equal(initialManifest.version, VERSION)
assert.equal(normalizePath(initialManifest.packagePath), normalizePath(CLEAN_PACKAGE),
  'Initial candidate manifest identifies a different clean package')
const expectedFiles = assertSafeManifestFiles(initialManifest.files, 'Initial candidate manifest')
const initialArchive = join(CANDIDATE, initialManifest.archive)
assert(existsSync(initialArchive), 'Initial candidate archive is absent: ' + initialArchive)
assert.equal(sha256(initialArchive), initialManifest.sha256, 'Initial candidate archive hash no longer matches its manifest')

const installedReceipt = readJson(RECEIPT)
assert.equal(normalizePath(installedReceipt.packagePath), normalizePath(CLEAN_PACKAGE),
  'Installation receipt identifies a different clean package')
assert.equal(installedReceipt.version, VERSION, 'Installation receipt identifies a different version')
assert.equal(installedReceipt.initialArchiveSha256 ?? installedReceipt.sha256, initialManifest.sha256,
  'Installation receipt does not identify the immutable initial candidate archive')
const proof = assertProof(installedReceipt.proof)

const clean = assertCleanPackage(CLEAN_PACKAGE)
const profileHashesBefore = Object.fromEntries(PROFILE_FILES.map(file => [file, sha256(join(PROFILE, file))]))
const linkBefore = assertProfileAndLink(clean.manifestHash)
const cleanBefore = listRegularFiles(CLEAN_PACKAGE)

const recordedHashes = initialManifest.packageFileHashes
assert(recordedHashes !== null && typeof recordedHashes === 'object',
  'Initial candidate manifest has no complete package hash map')
assertSameFileMaps(cleanBefore, new Map(Object.entries(recordedHashes)),
  'Clean package differs from the initial candidate manifest')

const staging = mkdtempSync(join(dirname(FINAL_CANDIDATE), '.delegation-only-final-'))
const initialExtract = join(staging, 'initial')
const finalPack = join(staging, 'final-pack')
const finalExtract = join(staging, 'final-extract')
const sealed = join(staging, 'sealed')
mkdirSync(initialExtract, { recursive: false })
mkdirSync(finalPack, { recursive: false })
mkdirSync(finalExtract, { recursive: false })
mkdirSync(sealed, { recursive: false })

assertArchiveNames(initialArchive)
run('tar', ['-xzf', initialArchive, '-C', initialExtract])
const initialPackage = join(initialExtract, 'package')
const initialFiles = listRegularFiles(initialPackage)
assertSameFileMaps(initialFiles, cleanBefore, 'Initial archive differs from the clean package')

const packed = run(
  process.env.ComSpec ?? 'cmd.exe',
  ['/d', '/c', 'npm.cmd', 'pack', '--json', '--ignore-scripts', '--pack-destination', finalPack],
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
const finalFiles = assertSafeManifestFiles(packReceipt.files?.map(file => file.path), 'Final npm package')
same(finalFiles, expectedFiles, 'Final npm package has a different file set from the initial candidate')

const finalArchive = join(finalPack, packReceipt.filename)
assertArchiveNames(finalArchive)
run('tar', ['-xzf', finalArchive, '-C', finalExtract])
const finalPackage = join(finalExtract, 'package')
const finalArchiveFiles = listRegularFiles(finalPackage)
assertSameFileMaps(finalArchiveFiles, initialFiles, 'Final archive differs from the initial archive')
assertSameFileMaps(finalArchiveFiles, cleanBefore, 'Final archive differs from the installed clean package')

const cleanAfter = listRegularFiles(CLEAN_PACKAGE)
assertSameFileMaps(cleanAfter, cleanBefore, 'Clean package changed during finalization')
const profileHashesAfter = Object.fromEntries(PROFILE_FILES.map(file => [file, sha256(join(PROFILE, file))]))
assert.deepEqual(profileHashesAfter, profileHashesBefore, 'Desktop Profile changed during finalization')
const linkAfter = assertProfileAndLink(clean.manifestHash)
assert.equal(normalizePath(linkAfter.module.target), normalizePath(linkBefore.module.target),
  'Desktop module junction changed during finalization')

const finalManifest = {
  name: 'dsh-session-conductor',
  version: VERSION,
  archive: packReceipt.filename,
  sha256: sha256(finalArchive),
  initialArchive,
  initialSha256: initialManifest.sha256,
  packagePath: CLEAN_PACKAGE,
  files: [...expectedFiles].sort(),
  packageFileHashes: Object.fromEntries(finalArchiveFiles),
  status: 'local Desktop candidate installed to the desktop Profile; unpublished',
  verification: {
    delegationProof: installedReceipt.proof,
    proofAssertions: proof.assertions,
    archiveMatchesInitialCandidate: true,
    archiveMatchesInstalledPackage: true,
    desktopProfileFilesUnchanged: true,
    moduleJunctionUnchanged: true,
    profileFiles: profileHashesAfter,
  },
}
renameSync(finalArchive, join(sealed, packReceipt.filename))
writeFileSync(join(sealed, 'manifest.json'), JSON.stringify(finalManifest, null, 2) + '\n', 'utf8')
renameSync(sealed, FINAL_CANDIDATE)
assert.equal(sha256(join(FINAL_CANDIDATE, packReceipt.filename)), finalManifest.sha256,
  'Final archive changed while moving it into the sealed candidate directory')

const finalizedReceipt = {
  ...installedReceipt,
  finalization: {
    finalizedAt: new Date().toISOString(),
    finalCandidate: FINAL_CANDIDATE,
    finalArchive: join(FINAL_CANDIDATE, packReceipt.filename),
    finalSha256: finalManifest.sha256,
    initialArchive,
    initialSha256: initialManifest.sha256,
    archiveMatchesInstalledPackage: true,
    desktopProfileFilesUnchanged: true,
    moduleJunctionUnchanged: true,
  },
}
writeFileSync(RECEIPT, JSON.stringify(finalizedReceipt, null, 2) + '\n', 'utf8')

process.stdout.write(JSON.stringify({
  finalized: 'dsh-session-conductor@' + VERSION,
  finalCandidate: FINAL_CANDIDATE,
  finalArchive: join(FINAL_CANDIDATE, packReceipt.filename),
  sha256: finalManifest.sha256,
  packageFiles: expectedFiles.length,
  profileChanged: false,
}, null, 2) + '\n')
