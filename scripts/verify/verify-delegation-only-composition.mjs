/**
 * Read-only composition evidence for the installed 0.1.5 local candidate.
 *
 * It invokes only Desktop's official `--dump-config` command, guards the
 * Profile file hashes and selected module junction before and after, and
 * writes evidence outside the Profile and package directories.  It never
 * runs `plugin add`, starts or stops Desktop, or changes either package.
 */
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ASAR,
  CLEAN_PACKAGE,
  CLI_SHIM,
  COMPOSE_REQUIRED_IDS,
  DESKTOP_EXE,
  PROFILE,
  PROFILE_FILES,
  PROFILE_NAME,
  RECEIPT,
  VERSION,
  assertCleanPackage,
  assertProfileBundleInvariant,
  desktopEnvironment,
  linkedPackageState,
  normalizePath,
  profileState,
  readJson,
  sha256,
} from './delegation-only-common.mjs'

for (const path of [DESKTOP_EXE, ASAR, CLI_SHIM, RECEIPT]) {
  assert(existsSync(path), `Required verification input is absent: ${path}`)
}
for (const file of PROFILE_FILES) {
  assert(existsSync(join(PROFILE, file)), `Required Profile file is absent: ${file}`)
}

const receipt = readJson(RECEIPT)
assert.equal(receipt.version, VERSION)
assert.equal(normalizePath(receipt.packagePath), normalizePath(CLEAN_PACKAGE))
const clean = assertCleanPackage(CLEAN_PACKAGE)
const profileJson = readJson(join(PROFILE, 'package.json'))
const state = profileState(profileJson)
assertProfileBundleInvariant(state.bundles, 'Installed Profile')
const conductorDependency = String(state.dependencies['dsh-session-conductor'])
assert(conductorDependency.startsWith('link:'), 'Installed Profile conductor dependency must use link:')
assert.equal(normalizePath(conductorDependency.slice('link:'.length)), normalizePath(CLEAN_PACKAGE))
const moduleBefore = linkedPackageState(
  join(PROFILE, 'node_modules/dsh-session-conductor'),
  CLEAN_PACKAGE,
  VERSION,
  clean.manifestHash,
  'Installed dsh-session-conductor',
)
const hashesBefore = Object.fromEntries(PROFILE_FILES.map(file => [file, sha256(join(PROFILE, file))]))

const dumped = spawnSync(
  DESKTOP_EXE,
  ['--expose-internals', CLI_SHIM, '--profile', PROFILE_NAME, '--dump-config'],
  { env: desktopEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
)
const output = `${dumped.stdout ?? ''}${dumped.stderr ?? ''}`
assert.equal(dumped.status, 0, `Official Desktop CLI --dump-config failed:\n${output}`)
const entryCounts = Object.fromEntries(COMPOSE_REQUIRED_IDS.map(id => [
  id,
  (output.match(new RegExp(`^- id: ${id}\\r?$`, 'gm')) ?? []).length,
]))
for (const [id, count] of Object.entries(entryCounts)) {
  assert.equal(count, 1, `Unexpected composed entry count for ${id}: ${String(count)}`)
}

const hashesAfter = Object.fromEntries(PROFILE_FILES.map(file => [file, sha256(join(PROFILE, file))]))
assert.deepEqual(hashesAfter, hashesBefore, 'Profile changed during read-only --dump-config verification')
const moduleAfter = linkedPackageState(
  join(PROFILE, 'node_modules/dsh-session-conductor'),
  CLEAN_PACKAGE,
  VERSION,
  clean.manifestHash,
  'Installed dsh-session-conductor after composition verification',
)
assert.equal(normalizePath(moduleAfter.target), normalizePath(moduleBefore.target))

const root = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), '.verification', 'desktop-install-2026-09-15')
const logPath = join(root, 'composition-delegation-only.log')
const evidencePath = join(root, 'composition-delegation-only.json')
writeFileSync(logPath, output, 'utf8')
writeFileSync(evidencePath, `${JSON.stringify({
  verifiedAt: new Date().toISOString(),
  command: 'official Desktop CLI --profile desktop --dump-config',
  packagePath: CLEAN_PACKAGE,
  version: VERSION,
  entryCounts,
  profileHashesBefore: hashesBefore,
  profileHashesAfter: hashesAfter,
  moduleTarget: moduleAfter.target,
  profileChanged: false,
  desktopWasNotStopped: true,
  logPath,
}, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ evidencePath, logPath, entryCounts, profileChanged: false }, null, 2)}\n`)
