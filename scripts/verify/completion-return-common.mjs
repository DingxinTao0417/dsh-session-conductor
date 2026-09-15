/**
 * Independent release primitives for the 0.1.6 completion-return candidate.
 *
 * These scripts deliberately do not import the earlier 0.1.5 release helpers:
 * their target package, recovery package, evidence paths, and preconditions
 * are all explicit here.  A clean external package keeps development-only
 * dependencies in the source checkout out of the Desktop installation path.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

export const ROOT = 'D:/workspace/dsh-plugins/dsh-session-conductor'
export const VERSION = '0.1.6'
export const PRIOR_VERSION = '0.1.5'
export const RELEASE_TAG = 'completion-return'
export const CANDIDATE = join(ROOT, 'dist/local-candidate-2026-09-15-completion-return')
export const CLEAN_RELEASE = `D:/dsh-local-plugins/dsh-session-conductor/${VERSION}-20260915-${RELEASE_TAG}`
export const CLEAN_PACKAGE = join(CLEAN_RELEASE, 'package')

export const PROFILE = 'D:/dsh/profiles/desktop'
export const PROFILE_NAME = 'desktop'
export const DESKTOP_EXE = 'D:/Users/20825/AppData/Local/Programs/DSH Desktop/DSH Desktop.exe'
export const ASAR = 'D:/Users/20825/AppData/Local/Programs/DSH Desktop/resources/app.asar'
export const PROFILE_FILES = Object.freeze(['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'])
export const REQUIRED_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-context',
  'dshmarket',
  'dsh-computer-use',
  'dsh-binary-files',
  'dsh-harness-compat',
  'dsh-session-conductor',
])
export const COMPOSE_REQUIRED_IDS = Object.freeze([
  'dsh-session-conductor',
  'conductor-binary-files',
  'conductor-compatible-api-gateway',
])

// This shim calls the installed Desktop's public CLI entry through Electron's
// supported `--expose-internals` bootstrap. Its hash is pinned to the shim
// validated for the sealed 0.1.5 release, then it is copied into the new
// backup before use so a later rollback has the exact same shim available.
export const CLI_SOURCE = join(ROOT, '.verification/desktop-install-2026-09-15', 'desktop-cli.mjs')
export const VERIFIED_CLI_SOURCE_SHA256 = '05eab414d2c85ae9b1a564781098f1bb9dde296b212ad0512263197b1cb8cfe3'
export const VERIFICATION_ROOT = join(ROOT, '.verification/desktop-install-2026-09-15-completion-return')
export const RECEIPT = join(VERIFICATION_ROOT, 'installation-completion-return.json')
export const BACKUP = 'D:/dsh/plugin-backups/session-conductor-20260915-completion-return/before-upgrade'

export const PRIOR_PACKAGE = 'D:/dsh-local-plugins/dsh-session-conductor/0.1.5-20260915-delegation-only/package'
export const PRIOR_DEPENDENCY = `link:${PRIOR_PACKAGE}`
export const PRIOR_FINAL_MANIFEST = join(ROOT, 'dist/local-candidate-2026-09-15-delegation-only-final', 'manifest.json')

export const normalizePath = value => String(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
export const sha256Bytes = value => createHash('sha256').update(value).digest('hex')
export const sha256 = path => sha256Bytes(readFileSync(path))
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/**
 * Do not treat a same-file backup comparison as provenance. The installer
 * must reject a changed shim before it creates a backup or asks the official
 * CLI to mutate the Desktop Profile.
 */
export function assertVerifiedDesktopCliSource() {
  assert(existsSync(CLI_SOURCE), `Required Desktop CLI shim is absent: ${CLI_SOURCE}`)
  const actual = sha256(CLI_SOURCE)
  assert.equal(
    actual,
    VERIFIED_CLI_SOURCE_SHA256,
    `Desktop CLI shim hash differs from the verified source: ${CLI_SOURCE}`,
  )
  return { path: CLI_SOURCE, sha256: actual }
}

export function assertSame(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), label)
}

export function normalizeLinkDependency(value, label = 'Profile dependency') {
  assert(typeof value === 'string' && value.startsWith('link:'), `${label} must use a link: dependency`)
  const target = value.slice('link:'.length)
  assert(target.length > 0, `${label} has an empty link target`)
  return normalizePath(target)
}

export function assertSameLinkDependency(actual, expected, label) {
  assert.equal(
    normalizeLinkDependency(actual, `${label} actual value`),
    normalizeLinkDependency(expected, `${label} expected value`),
    `${label} link target differs`,
  )
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  return result
}

export function assertArchiveNames(archive) {
  const listed = run('tar', ['-tzf', archive])
  const names = listed.stdout.split(/\r?\n/).filter(Boolean)
  assert(names.length > 0, `Archive is empty: ${archive}`)
  assert(
    names.every(name => name.startsWith('package/') && !name.includes('..') && !name.includes('\\')),
    `Archive contains an unsafe path: ${archive}`,
  )
  return names
}

export function archiveEntry(archive, name) {
  const result = spawnSync('tar', ['-xOzf', archive, name], {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`Could not read ${name} from ${archive}: ${String(result.stderr)}`)
  }
  return result.stdout
}

export function listRegularFiles(directory) {
  const files = new Map()
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      const metadata = lstatSync(absolute)
      assert(!metadata.isSymbolicLink(), `Symbolic links are not allowed in a clean package: ${absolute}`)
      if (metadata.isDirectory()) {
        visit(absolute)
        continue
      }
      assert(metadata.isFile(), `Clean package contains a non-regular entry: ${absolute}`)
      files.set(relative(directory, absolute).replaceAll('\\', '/'), sha256(absolute))
    }
  }
  visit(directory)
  return files
}

export function assertSameFileMaps(actual, expected, label) {
  assertSame(actual.keys(), expected.keys(), `${label} has a different file set`)
  for (const [file, expectedHash] of expected) {
    assert.equal(actual.get(file), expectedHash, `${label} hash differs: ${file}`)
  }
}

export function assertCleanPackage(packagePath, expectedVersion = VERSION) {
  assert(existsSync(packagePath), `Clean package is absent: ${packagePath}`)
  const manifestPath = join(packagePath, 'package.json')
  const manifest = readJson(manifestPath)
  assert.equal(manifest.name, 'dsh-session-conductor')
  assert.equal(manifest.version, expectedVersion)
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert(
    manifest.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-conversation'),
    'Native chat client metadata is missing',
  )
  assert(existsSync(join(packagePath, 'lib/index.js')), 'Built Host entry is missing')
  assert(existsSync(join(packagePath, 'lib/client.js')), 'Built chat entry is missing')
  return { manifest, manifestHash: sha256(manifestPath) }
}

export function linkedPackageState(modulePath, expectedPackagePath, expectedVersion, expectedManifestHash, label) {
  assert(existsSync(modulePath), `${label} is absent: ${modulePath}`)
  assert(lstatSync(modulePath).isSymbolicLink(), `${label} is not a junction or symbolic link: ${modulePath}`)
  const resolvedPath = realpathSync.native(modulePath)
  assert.equal(
    normalizePath(resolvedPath),
    normalizePath(expectedPackagePath),
    `${label} resolves to an unexpected path: ${resolvedPath}`,
  )
  const manifestPath = join(modulePath, 'package.json')
  const manifest = readJson(manifestPath)
  assert.equal(manifest.name, 'dsh-session-conductor', `${label} has an unexpected package name`)
  assert.equal(manifest.version, expectedVersion, `${label} has an unexpected package version`)
  assert.equal(sha256(manifestPath), expectedManifestHash, `${label} package.json hash differs from the verified package`)
  return {
    modulePath,
    target: resolvedPath,
    packageName: manifest.name,
    version: manifest.version,
    packageJsonSha256: expectedManifestHash,
  }
}

export function profileState(profileJson) {
  const dependencies = profileJson.dependencies
  const bundles = profileJson.dsh?.profile?.bundles
  assert(dependencies !== null && typeof dependencies === 'object', 'Profile dependencies are absent')
  assert(Array.isArray(bundles), 'Profile bundle list is absent')
  return { dependencies, bundles }
}

export function assertProfileBundles(bundles, label) {
  assert.deepEqual(bundles, REQUIRED_BUNDLES, `${label} has an unexpected Desktop bundle sequence`)
}

export function assertProfileUnchangedExceptConductor(before, after, nextDependency) {
  const beforeState = profileState(before)
  const afterState = profileState(after)
  assertProfileBundles(beforeState.bundles, 'Original Profile')
  assertProfileBundles(afterState.bundles, 'Updated Profile')
  assert.equal(
    Object.keys(afterState.dependencies).length,
    Object.keys(beforeState.dependencies).length,
    'Profile dependency count changed',
  )
  for (const [name, dependency] of Object.entries(beforeState.dependencies)) {
    if (name === 'dsh-session-conductor') continue
    assert.equal(afterState.dependencies[name], dependency, `Unrelated dependency changed: ${name}`)
  }
  assertSameLinkDependency(
    afterState.dependencies['dsh-session-conductor'],
    nextDependency,
    'Profile did not point to the selected clean package',
  )
  assert.deepEqual(afterState.bundles, beforeState.bundles, 'Profile bundle sequence changed')
  const expectedAfter = JSON.parse(JSON.stringify(before))
  // The official CLI canonicalizes Windows link paths to forward slashes.
  // `assertSameLinkDependency` above already proves the only allowed value is
  // semantically the requested target.  Retain a byte-for-byte comparison for
  // every other Profile field without treating slash spelling in this one
  // portable path field as an unrelated mutation.
  expectedAfter.dependencies['dsh-session-conductor'] = afterState.dependencies['dsh-session-conductor']
  assert.deepEqual(after, expectedAfter,
    'Profile package.json changed outside the dsh-session-conductor dependency')
}

export function profileFileHashes() {
  return Object.fromEntries(PROFILE_FILES.map(file => [file, sha256(join(PROFILE, file))]))
}

/**
 * The current 0.1.5 package is the rollback target.  It is accepted only if
 * both the sealed final archive and its complete installed file map match the
 * historical final manifest.
 */
export function assertSealedPriorPackage() {
  assert(existsSync(PRIOR_FINAL_MANIFEST), `Sealed 0.1.5 manifest is absent: ${PRIOR_FINAL_MANIFEST}`)
  const finalManifest = readJson(PRIOR_FINAL_MANIFEST)
  assert.equal(finalManifest.name, 'dsh-session-conductor')
  assert.equal(finalManifest.version, PRIOR_VERSION)
  assert(typeof finalManifest.archive === 'string' && finalManifest.archive.length > 0, 'Sealed 0.1.5 archive is absent')
  assert(typeof finalManifest.sha256 === 'string' && /^[a-f0-9]{64}$/.test(finalManifest.sha256), 'Sealed 0.1.5 archive hash is invalid')
  assert(finalManifest.packageFileHashes !== null && typeof finalManifest.packageFileHashes === 'object',
    'Sealed 0.1.5 file hash map is absent')
  const archive = join(dirname(PRIOR_FINAL_MANIFEST), finalManifest.archive)
  assert(existsSync(archive), `Sealed 0.1.5 archive is absent: ${archive}`)
  assert.equal(sha256(archive), finalManifest.sha256, 'Sealed 0.1.5 archive hash changed')
  const packageState = assertCleanPackage(PRIOR_PACKAGE, PRIOR_VERSION)
  assert.equal(
    packageState.manifestHash,
    sha256Bytes(archiveEntry(archive, 'package/package.json')),
    '0.1.5 recovery package package.json differs from the sealed archive',
  )
  const expectedFiles = new Map(Object.entries(finalManifest.packageFileHashes))
  assertSameFileMaps(listRegularFiles(PRIOR_PACKAGE), expectedFiles, '0.1.5 recovery package')
  return {
    finalManifest,
    archive,
    manifestHash: packageState.manifestHash,
    packageFileHashes: Object.fromEntries(expectedFiles),
  }
}

/**
 * Strictly bind this upgrade to the known 0.1.5 release.  A different link,
 * a copied directory, or a package modified after sealing aborts before any
 * backup or official CLI mutation is attempted.
 */
export function assertProfileStillOnSealedPrior() {
  for (const file of PROFILE_FILES) {
    assert(existsSync(join(PROFILE, file)), `Required Desktop Profile file is absent: ${file}`)
  }
  const profileJson = readJson(join(PROFILE, 'package.json'))
  const state = profileState(profileJson)
  assertProfileBundles(state.bundles, 'Current Profile')
  assert.equal(
    state.dependencies['dsh-session-conductor'],
    PRIOR_DEPENDENCY,
    'Desktop Profile dependency text no longer exactly matches the expected sealed 0.1.5 link',
  )
  assertSameLinkDependency(
    state.dependencies['dsh-session-conductor'],
    PRIOR_DEPENDENCY,
    'Desktop Profile no longer points exactly to the expected sealed 0.1.5 package; inspect it instead of overwriting',
  )
  const prior = assertSealedPriorPackage()
  const module = linkedPackageState(
    join(PROFILE, 'node_modules/dsh-session-conductor'),
    PRIOR_PACKAGE,
    PRIOR_VERSION,
    prior.manifestHash,
    'Current dsh-session-conductor',
  )
  return { profileJson, state, profileHashes: profileFileHashes(), prior, module }
}

export function desktopEnvironment() {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: 'D:/dsh',
    CONDUCTOR_INSTALL_ASAR: ASAR,
    CONDUCTOR_INSTALL_PROFILE: PROFILE,
  }
}

export function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}
