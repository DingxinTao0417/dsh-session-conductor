/**
 * Offline-update the selected local Desktop Profile from the already verified
 * clean candidate.  The user's running Desktop is never stopped here; it will
 * continue using its old module graph until it exits normally.
 */
import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const root = 'D:/workspace/dsh-plugins/dsh-session-conductor'
const candidate = join(root, 'dist/local-candidate-2026-09-15-history-first')
const profile = 'D:/dsh/profiles/desktop'
const packagePath = 'D:/dsh-local-plugins/dsh-session-conductor/0.1.4-20260915-history-first/package'
const desktopExe = 'D:/Users/20825/AppData/Local/Programs/DSH Desktop/DSH Desktop.exe'
const asar = 'D:/Users/20825/AppData/Local/Programs/DSH Desktop/resources/app.asar'
const proof = join(root, '.verification/navigation-2026-09-15T09-15-52-719Z/summary.json')
const verificationRoot = join(root, '.verification/desktop-install-2026-09-15')
const backup = 'D:/dsh/plugin-backups/session-conductor-2026-09-15T07-32-33-735Z/before-history-first'
const receiptFile = join(verificationRoot, 'installation-history-first.json')
const cli = join(verificationRoot, 'desktop-cli.mjs')
const version = '0.1.4'
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const normalizedPath = path => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
const powerShellLiteral = value => `'${String(value).replaceAll("'", "''")}'`

function linkedPackageState(modulePath, expectedPackagePath, expectedVersion, expectedManifestHash, label) {
  if (!existsSync(modulePath)) throw new Error(`${label} is absent: ${modulePath}`)
  if (!lstatSync(modulePath).isSymbolicLink()) throw new Error(`${label} is not a junction or symbolic link: ${modulePath}`)
  const resolvedPath = realpathSync.native(modulePath)
  if (normalizedPath(resolvedPath) !== normalizedPath(expectedPackagePath)) {
    throw new Error(`${label} resolves to an unexpected path: ${resolvedPath}`)
  }
  const manifestPath = join(modulePath, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`${label} package.json is absent`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== 'dsh-session-conductor' || manifest.version !== expectedVersion) {
    throw new Error(`${label} has an unexpected package identity`)
  }
  if (hash(manifestPath) !== expectedManifestHash) throw new Error(`${label} package.json hash differs from the verified package`)
  return {
    modulePath,
    target: resolvedPath,
    packageName: manifest.name,
    version: manifest.version,
    packageJsonSha256: expectedManifestHash,
  }
}

if (!existsSync(packagePath)) throw new Error(`Clean package is absent: ${packagePath}`)
if (!existsSync(proof)) throw new Error(`Clean-package Host/Edge proof is absent: ${proof}`)
if (existsSync(backup)) throw new Error(`Refusing to overwrite existing upgrade backup: ${backup}`)
const candidateManifest = JSON.parse(readFileSync(join(candidate, 'manifest.json'), 'utf8'))
const archive = join(candidate, candidateManifest.archive)
if (candidateManifest.version !== version || candidateManifest.sha256 !== hash(archive)) {
  throw new Error('Candidate manifest does not match its archive')
}
const proofSummary = JSON.parse(readFileSync(proof, 'utf8'))
if (!proofSummary.ok || !proofSummary.portReleased || proofSummary.responseInterception || proofSummary.receipt?.providerCalls !== 0
  || proofSummary.packages?.['dsh-session-conductor']?.replaceAll('\\', '/') !== packagePath) {
  throw new Error('Clean-package Host/Edge proof does not match the package selected for installation')
}

const before = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
const previousDependency = String(before.dependencies?.['dsh-session-conductor'] ?? '')
if (!previousDependency.includes('0.1.3-20260915-parent-workspace') || !previousDependency.startsWith('link:')) {
  throw new Error('The Desktop Profile no longer points to the expected 0.1.3 package; inspect it instead of overwriting')
}
const previousPackagePath = previousDependency.slice('link:'.length)
const previousManifestPath = join(previousPackagePath, 'package.json')
if (!existsSync(previousManifestPath)) throw new Error(`The expected 0.1.3 recovery package is absent: ${previousPackagePath}`)
const previousManifest = JSON.parse(readFileSync(previousManifestPath, 'utf8'))
if (previousManifest.name !== 'dsh-session-conductor' || previousManifest.version !== '0.1.3') {
  throw new Error('The expected 0.1.3 recovery package has an unexpected identity')
}
const previousPackageManifestHash = hash(previousManifestPath)
mkdirSync(backup, { recursive: false })
const protectedFiles = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']
for (const file of protectedFiles) copyFileSync(join(profile, file), join(backup, file))
copyFileSync(cli, join(backup, 'desktop-cli.mjs'))

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  DSH_HOME: 'D:/dsh',
  CONDUCTOR_INSTALL_ASAR: asar,
  CONDUCTOR_INSTALL_PROFILE: profile,
}
const base = ['--expose-internals', cli]
const installed = spawnSync(
  desktopExe,
  [...base, 'plugin', '--profile', 'desktop', 'add', '--offline', packagePath],
  { env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
)
writeFileSync(join(backup, 'install-cli.log'), `${installed.stdout}\n${installed.stderr}`, 'utf8')
if (installed.status !== 0) throw new Error(`Desktop CLI update failed; backup retained at ${backup}`)

const after = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
for (const bundle of before.dsh.profile.bundles) assert(after.dsh.profile.bundles.includes(bundle), `Prior bundle lost: ${bundle}`)
for (const [name, dependency] of Object.entries(before.dependencies)) {
  if (name !== 'dsh-session-conductor') assert.equal(after.dependencies[name], dependency, `Unrelated dependency changed: ${name}`)
}
assert(String(after.dependencies['dsh-session-conductor']).replaceAll('\\', '/').includes('0.1.4-20260915-history-first/package'),
  'Profile did not point at the expected clean 0.1.4 package')
const installedManifestHash = hash(join(packagePath, 'package.json'))
const installedModule = linkedPackageState(
  join(profile, 'node_modules/dsh-session-conductor'),
  packagePath,
  version,
  installedManifestHash,
  'Installed dsh-session-conductor',
)

const dump = spawnSync(
  desktopExe,
  [...base, '--profile', 'desktop', '--dump-config'],
  { env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
)
writeFileSync(join(backup, 'dump-config.log'), `${dump.stdout}\n${dump.stderr}`, 'utf8')
if (dump.status !== 0) throw new Error('Desktop Profile composition failed after update')
for (const name of ['dsh-session-conductor', 'conductor-binary-files', 'conductor-compatible-api-gateway']) {
  const count = (dump.stdout.match(new RegExp(`^- id: ${name}\\r?$`, 'gm')) ?? []).length
  assert.equal(count, 1, `Unexpected composed entry count for ${name}`)
}

const rollbackFiles = protectedFiles.map(name => ({
  name,
  installedSha256: hash(join(profile, name)),
  backupSha256: hash(join(backup, name)),
}))
const rollback = {
  script: join(backup, 'rollback-history-first.ps1'),
  desktopCli: {
    path: join(backup, 'desktop-cli.mjs'),
    sha256: hash(join(backup, 'desktop-cli.mjs')),
  },
  current: {
    profileFiles: rollbackFiles,
    module: installedModule,
  },
  previous: {
    dependency: previousDependency,
    packagePath: previousPackagePath,
    packageName: previousManifest.name,
    version: previousManifest.version,
    packageJsonSha256: previousPackageManifestHash,
    dependencies: before.dependencies,
    bundles: before.dsh.profile.bundles,
  },
  behavior: 'Requires all Desktop processes to be stopped, verifies the post-upgrade Profile and junction hashes, then uses the official offline Desktop CLI to restore the verified 0.1.3 link. It never copies backup Profile files over a changed Profile.',
}
const receipt = {
  installedAt: new Date().toISOString(),
  profile,
  packagePath,
  version,
  sha256: candidateManifest.sha256,
  archive,
  backup,
  proof,
  proofAssertions: proofSummary.assertions,
  providerCalls: proofSummary.receipt.providerCalls,
  portReleased: proofSummary.portReleased,
  responseInterception: proofSummary.responseInterception,
  compositionChecked: true,
  runningDesktopWasNotStopped: true,
  nextStep: 'Fully exit DSH Desktop including its tray process, then reopen it normally.',
  rollbackFiles,
  rollback,
}
writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
const rollbackScript = [
  "$ErrorActionPreference = 'Stop'",
  `$profilePath = '${profile.replaceAll('/', '\\')}'`,
  `$backupPath = $PSScriptRoot`,
  `$desktopExe = '${desktopExe.replaceAll('/', '\\')}'`,
  "$desktopCli = Join-Path $backupPath 'desktop-cli.mjs'",
  "$profileName = 'desktop'",
  `$expectedCurrentPackagePath = ${powerShellLiteral(packagePath.replaceAll('/', '\\'))}`,
  `$expectedPreviousPackagePath = ${powerShellLiteral(previousPackagePath.replaceAll('/', '\\'))}`,
  `$expectedPreviousDependency = ${powerShellLiteral(previousDependency)}`,
  "$running = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)",
  "if ($running.Count -gt 0) { throw 'Fully quit every DSH Desktop process, including its tray process, before rollback. No files changed.' }",
  "function Normalize-FileSystemPath([string] $path) {",
  "  if ([string]::IsNullOrWhiteSpace($path)) { throw 'A required path is empty.' }",
  "  return [System.IO.Path]::GetFullPath($path).Replace('/', '\\').TrimEnd([char]92).ToLowerInvariant()",
  "}",
  "function Assert-FileHash([string] $path, [string] $expectedHash, [string] $label) {",
  "  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw \"$label is absent: $path\" }",
  "  $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()",
  "  if ($actualHash -ne $expectedHash) { throw \"$label changed after the upgrade: $path. No files changed.\" }",
  "}",
  "function Assert-LinkedPackage([string] $modulePath, [string] $expectedTarget, [string] $expectedVersion, [string] $expectedHash, [string] $label) {",
  "  if (-not (Test-Path -LiteralPath $modulePath -PathType Container)) { throw \"$label is absent: $modulePath\" }",
  "  $item = Get-Item -LiteralPath $modulePath -Force",
  "  if ($item.LinkType -notin @('Junction', 'SymbolicLink')) { throw \"$label is not a junction or symbolic link: $modulePath\" }",
  "  $targets = @($item.Target | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })",
  "  if ($targets.Count -ne 1) { throw \"$label has an ambiguous link target: $modulePath\" }",
  "  $actualTarget = Normalize-FileSystemPath ([string] $targets[0])",
  "  if ($actualTarget -ne (Normalize-FileSystemPath $expectedTarget)) { throw \"$label resolves to an unexpected target: $($targets[0]). No files changed.\" }",
  "  $manifestPath = Join-Path $modulePath 'package.json'",
  "  Assert-FileHash $manifestPath $expectedHash \"$label package.json\"",
  "  $manifest = Get-Content -Raw -Encoding utf8 -LiteralPath $manifestPath | ConvertFrom-Json",
  "  if ($manifest.name -ne 'dsh-session-conductor' -or $manifest.version -ne $expectedVersion) { throw \"$label has an unexpected package identity. No files changed.\" }",
  "}",
  "function Assert-ProfileState([object] $expected) {",
  "  $current = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $profilePath 'package.json') | ConvertFrom-Json",
  "  $currentDependencies = @($current.dependencies.PSObject.Properties)",
  "  $expectedDependencies = @($expected.dependencies.PSObject.Properties)",
  "  if ($currentDependencies.Count -ne $expectedDependencies.Count) { throw 'Restored Profile has a different dependency count.' }",
  "  foreach ($entry in $expectedDependencies) {",
  "    $actual = $current.dependencies.PSObject.Properties[$entry.Name]",
  "    if ($null -eq $actual -or [string]$actual.Value -ne [string]$entry.Value) { throw \"Restored Profile dependency differs: $($entry.Name)\" }",
  "  }",
  "  $actualBundles = @($current.dsh.profile.bundles)",
  "  $expectedBundles = @($expected.bundles)",
  "  if ($actualBundles.Count -ne $expectedBundles.Count) { throw 'Restored Profile has a different bundle count.' }",
  "  for ($index = 0; $index -lt $expectedBundles.Count; $index++) {",
  "    if ([string]$actualBundles[$index] -ne [string]$expectedBundles[$index]) { throw \"Restored Profile bundle differs at index $index.\" }",
  "  }",
  "  if ((@($actualBundles | Where-Object { $_ -eq 'dsh-session-conductor' })).Count -ne 1) { throw 'Restored Profile must include dsh-session-conductor exactly once.' }",
  "  if ([string]$current.dependencies.'dsh-session-conductor' -ne $expectedPreviousDependency) { throw 'Restored Profile does not point at the backed-up 0.1.3 dependency.' }",
  "}",
  `$expected = @'`,
  JSON.stringify(rollbackFiles, null, 2),
  "'@ | ConvertFrom-Json",
  `$expectedModule = @'`,
  JSON.stringify(installedModule, null, 2),
  "'@ | ConvertFrom-Json",
  `$expectedPrevious = @'`,
  JSON.stringify(rollback.previous, null, 2),
  "'@ | ConvertFrom-Json",
  "foreach ($entry in $expected) {",
  "  $target = Join-Path $profilePath $entry.name; $saved = Join-Path $backupPath $entry.name",
  "  Assert-FileHash $target $entry.installedSha256 \"Current Profile file $($entry.name)\"",
  "  Assert-FileHash $saved $entry.backupSha256 \"Backup Profile file $($entry.name)\"",
  "}",
  "Assert-LinkedPackage (Join-Path $profilePath 'node_modules/dsh-session-conductor') $expectedCurrentPackagePath $expectedModule.version $expectedModule.packageJsonSha256 'Current dsh-session-conductor'",
  "Assert-FileHash $desktopCli ${powerShellLiteral(rollback.desktopCli.sha256)} 'Backed-up Desktop CLI shim'",
  "Assert-FileHash (Join-Path $expectedPreviousPackagePath 'package.json') $expectedPrevious.packageJsonSha256 'Backed-up 0.1.3 package'",
  "if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) { throw \"Desktop executable is absent: $desktopExe\" }",
  "if (-not (Test-Path -LiteralPath $desktopCli -PathType Leaf)) { throw \"Backed-up Desktop CLI shim is absent: $desktopCli\" }",
  "$logStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fffffff'",
  "$rollbackCliLog = Join-Path $backupPath \"rollback-history-first-$logStamp-cli.log\"",
  "$rollbackDumpLog = Join-Path $backupPath \"rollback-history-first-$logStamp-dump-config.log\"",
  "$env:ELECTRON_RUN_AS_NODE = '1'",
  "$env:DSH_HOME = 'D:\\dsh'",
  "$env:CONDUCTOR_INSTALL_ASAR = '${asar.replaceAll('/', '\\')}'",
  "$env:CONDUCTOR_INSTALL_PROFILE = $profilePath",
  "try {",
  "  $cliOutput = & $desktopExe --expose-internals $desktopCli plugin --profile $profileName add --offline $expectedPreviousPackagePath 2>&1",
  "  $cliExitCode = $LASTEXITCODE",
  "  $cliOutput | Out-File -LiteralPath $rollbackCliLog -Encoding utf8",
  "  if ($cliExitCode -ne 0) { throw \"Official Desktop CLI returned exit code $cliExitCode. The script did not copy backup files over the Profile; inspect $rollbackCliLog before taking another action.\" }",
  "  Assert-ProfileState $expectedPrevious",
  "  Assert-LinkedPackage (Join-Path $profilePath 'node_modules/dsh-session-conductor') $expectedPreviousPackagePath $expectedPrevious.version $expectedPrevious.packageJsonSha256 'Restored dsh-session-conductor'",
  "  $dumpOutput = & $desktopExe --expose-internals $desktopCli --profile $profileName --dump-config 2>&1",
  "  $dumpExitCode = $LASTEXITCODE",
  "  $dumpOutput | Out-File -LiteralPath $rollbackDumpLog -Encoding utf8",
  "  if ($dumpExitCode -ne 0) { throw \"Official Desktop CLI composition check returned exit code $dumpExitCode. Inspect $rollbackDumpLog.\" }",
  "  foreach ($name in @('dsh-session-conductor', 'conductor-binary-files', 'conductor-compatible-api-gateway')) {",
  "    $count = @($dumpOutput | Select-String -Pattern \"^- id: $name\\r?$\").Count",
  "    if ($count -ne 1) { throw \"Unexpected composed entry count for $($name): $count. Inspect $rollbackDumpLog.\" }",
  "  }",
  "  $evidencePath = Join-Path $backupPath \"rollback-history-first-$logStamp.json\"",
  "  $evidence = [ordered]@{ completedAt = (Get-Date).ToString('o'); profile = $profilePath; offline = $true; restoredDependency = $expectedPreviousDependency; restoredPackagePath = $expectedPreviousPackagePath; restoredVersion = $expectedPrevious.version; rollbackCliLog = $rollbackCliLog; rollbackDumpLog = $rollbackDumpLog; currentProfileHashGate = $expected; restoredProfileAndBundleVerified = $true; restoredModuleLinkVerified = $true; compositionVerified = $true }",
  "  [System.IO.File]::WriteAllText($evidencePath, (($evidence | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))",
  "  Write-Output \"0.1.3 link restored and verified. Reopen DSH Desktop normally. Evidence: $evidencePath\"",
  "} catch {",
  "  Write-Error \"Rollback did not complete. Desktop was not started and this script never copied backup Profile files over a changed Profile. Inspect $rollbackCliLog and $rollbackDumpLog if they exist. $($_.Exception.Message)\"",
  "  exit 1",
  "}",
  '',
].join('\r\n')
writeFileSync(join(backup, 'rollback-history-first.ps1'), rollbackScript, 'utf8')
process.stdout.write(`${JSON.stringify({ upgraded: `dsh-session-conductor@${version}`, packagePath, backup, receiptFile, sha256: candidateManifest.sha256 }, null, 2)}\n`)
