/**
 * Shared, deliberately small primitives for the 0.1.5 delegation-only local
 * release scripts.  These scripts package a clean external directory instead
 * of linking the source checkout, whose development dependencies can mask
 * missing Desktop-host dependencies.
 */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'

export const ROOT = 'D:/workspace/dsh-plugins/dsh-session-conductor'
export const VERSION = '0.1.5'
export const PRIOR_VERSION = '0.1.4'
export const TAG = 'delegation-only'
export const CANDIDATE = join(ROOT, 'dist/local-candidate-2026-09-15-delegation-only')
export const FINAL_CANDIDATE = join(ROOT, 'dist/local-candidate-2026-09-15-delegation-only-final')
export const CLEAN_RELEASE = `D:/dsh-local-plugins/dsh-session-conductor/${VERSION}-20260915-${TAG}`
export const CLEAN_PACKAGE = join(CLEAN_RELEASE, 'package')
export const PROFILE = 'D:/dsh/profiles/desktop'
export const PROFILE_NAME = 'desktop'
export const DESKTOP_EXE = 'D:/Users/20825/AppData/Local/Programs/DSH Desktop/DSH Desktop.exe'
export const ASAR = 'D:/Users/20825/AppData/Local/Programs/DSH Desktop/resources/app.asar'
export const VERIFICATION_ROOT = join(ROOT, '.verification/desktop-install-2026-09-15')
export const CLI_SHIM = join(VERIFICATION_ROOT, 'desktop-cli.mjs')
export const RECEIPT = join(VERIFICATION_ROOT, 'installation-delegation-only.json')
export const BACKUP = 'D:/dsh/plugin-backups/session-conductor-2026-09-15T07-32-33-735Z/before-delegation-only'
export const PRIOR_PACKAGE = 'D:/dsh-local-plugins/dsh-session-conductor/0.1.4-20260915-history-first/package'
export const PRIOR_DEPENDENCY = `link:${PRIOR_PACKAGE}`
export const PRIOR_FINAL_MANIFEST = join(ROOT, 'dist/local-candidate-2026-09-15-history-first-final/manifest.json')
export const PROFILE_FILES = Object.freeze(['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'])
export const PROFILE_REQUIRED_BUNDLES = Object.freeze([
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

export const normalizePath = value => String(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
export function normalizeLinkDependency(value, label = 'Profile dependency') {
  assert(typeof value === 'string' && value.startsWith('link:'), label + ' must use a link: dependency')
  const target = value.slice('link:'.length)
  assert(target.length > 0, label + ' has an empty link target')
  return normalizePath(target)
}
export function assertSameLinkDependency(actual, expected, label) {
  assert.equal(
    normalizeLinkDependency(actual, label + ' actual value'),
    normalizeLinkDependency(expected, label + ' expected value'),
    label + ' link target differs',
  )
}
export const sha256Bytes = value => createHash('sha256').update(value).digest('hex')
export const sha256 = path => sha256Bytes(readFileSync(path))
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
export const same = (actual, expected, label) => assert.deepEqual([...actual].sort(), [...expected].sort(), label)

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
    encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`Could not read ${name} from ${archive}: ${String(result.stderr)}`)
  return result.stdout
}

export function listRegularFiles(directory) {
  const files = new Map()
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      const metadata = lstatSync(absolute)
      assert(!metadata.isSymbolicLink(), `Symlink is not allowed in a clean package: ${absolute}`)
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
  same(actual.keys(), expected.keys(), `${label} has a different file set`)
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
  assert(manifest.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-conversation'), 'Native chat client metadata is missing')
  assert(existsSync(join(packagePath, 'lib/index.js')), 'Built Host entry is missing')
  assert(existsSync(join(packagePath, 'lib/client.js')), 'Built chat entry is missing')
  return { manifest, manifestHash: sha256(manifestPath) }
}

export function linkedPackageState(modulePath, expectedPackagePath, expectedVersion, expectedManifestHash, label) {
  assert(existsSync(modulePath), `${label} is absent: ${modulePath}`)
  assert(lstatSync(modulePath).isSymbolicLink(), `${label} is not a junction or symbolic link: ${modulePath}`)
  const resolvedPath = realpathSync.native(modulePath)
  assert.equal(normalizePath(resolvedPath), normalizePath(expectedPackagePath), `${label} resolves to an unexpected path: ${resolvedPath}`)
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

export function assertProfileBundleInvariant(bundles, label) {
  assert.deepEqual(bundles, PROFILE_REQUIRED_BUNDLES, label + ' has an unexpected Desktop bundle sequence')
}

export function assertProfileUnchangedExceptConductor(before, after, nextDependency) {
  const beforeState = profileState(before)
  const afterState = profileState(after)
  assertProfileBundleInvariant(beforeState.bundles, 'Original Profile')
  assertProfileBundleInvariant(afterState.bundles, 'Updated Profile')
  for (const [name, dependency] of Object.entries(beforeState.dependencies)) {
    if (name !== 'dsh-session-conductor') {
      assert.equal(afterState.dependencies[name], dependency, `Unrelated dependency changed: ${name}`)
    }
  }
  assert.equal(Object.keys(afterState.dependencies).length, Object.keys(beforeState.dependencies).length, 'Profile dependency count changed')
  assertSameLinkDependency(
    afterState.dependencies['dsh-session-conductor'],
    nextDependency,
    'Profile did not point to the selected clean package',
  )
  assert.deepEqual(afterState.bundles, beforeState.bundles, 'Profile bundle sequence changed')
}

export function assertPriorRecoveryPackage() {
  const priorFinal = readJson(PRIOR_FINAL_MANIFEST)
  assert.equal(priorFinal.name, 'dsh-session-conductor')
  assert.equal(priorFinal.version, PRIOR_VERSION)
  const priorArchive = join(dirname(PRIOR_FINAL_MANIFEST), priorFinal.archive)
  assert(existsSync(priorArchive), `Verified 0.1.4 final archive is absent: ${priorArchive}`)
  assert.equal(sha256(priorArchive), priorFinal.sha256, 'Verified 0.1.4 final archive hash changed')
  const expectedManifestHash = sha256Bytes(archiveEntry(priorArchive, 'package/package.json'))
  const prior = assertCleanPackage(PRIOR_PACKAGE, PRIOR_VERSION)
  assert.equal(prior.manifestHash, expectedManifestHash, 'The 0.1.4 recovery package differs from its sealed archive')
  return { priorFinal, priorArchive, priorManifestHash: expectedManifestHash }
}

export function assertPriorProfileAndPackage() {
  const profileJson = readJson(join(PROFILE, 'package.json'))
  const state = profileState(profileJson)
  assertProfileBundleInvariant(state.bundles, 'Current Profile')
  assertSameLinkDependency(
    state.dependencies['dsh-session-conductor'],
    PRIOR_DEPENDENCY,
    'The Desktop Profile no longer points to the expected 0.1.4 history-first link; inspect it instead of overwriting',
  )
  const prior = assertPriorRecoveryPackage()
  const link = linkedPackageState(
    join(PROFILE, 'node_modules/dsh-session-conductor'),
    PRIOR_PACKAGE,
    PRIOR_VERSION,
    prior.priorManifestHash,
    'Current dsh-session-conductor',
  )
  return { profileJson, priorManifestHash: prior.priorManifestHash, priorLink: link, ...prior }
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
