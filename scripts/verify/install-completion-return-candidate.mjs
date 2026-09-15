/**
 * Upgrade Desktop's `desktop` Profile to the sealed 0.1.6 completion-return
 * candidate through the official offline Desktop CLI.
 *
 * It does not start DSH Desktop's GUI or stop/kill an existing Desktop process.
 * It launches the installed executable in Electron Node mode only to invoke
 * the official CLI. A running Desktop keeps its old module graph until the
 * user fully exits it (including the tray process) and opens it again. No
 * Profile backup is ever copied back over a Profile: both this upgrade and
 * the generated rollback use only `plugin add --offline`.
 *
 * If the official CLI succeeds but a later local verification is interrupted,
 * `--verify-post-install` resumes only the verification/receipt phase.  It
 * never invokes `plugin add`, starts the Desktop GUI, or changes the Profile.
 */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ASAR,
  BACKUP,
  CANDIDATE,
  CLEAN_PACKAGE,
  CLI_SOURCE,
  COMPOSE_REQUIRED_IDS,
  DESKTOP_EXE,
  PROFILE,
  PROFILE_FILES,
  PROFILE_NAME,
  RECEIPT,
  VERIFICATION_ROOT,
  VERSION,
  archiveEntry,
  assertCleanPackage,
  assertProfileStillOnSealedPrior,
  assertProfileUnchangedExceptConductor,
  assertSealedPriorPackage,
  assertSameFileMaps,
  desktopEnvironment,
  assertVerifiedDesktopCliSource,
  linkedPackageState,
  listRegularFiles,
  normalizePath,
  powerShellLiteral,
  profileFileHashes,
  profileState,
  readJson,
  run,
  sha256,
  sha256Bytes,
} from './completion-return-common.mjs'

function assertCandidate() {
  const manifestPath = join(CANDIDATE, 'manifest.json')
  assert(existsSync(manifestPath), `Candidate manifest is absent: ${manifestPath}`)
  const candidate = readJson(manifestPath)
  assert.equal(candidate.schemaVersion, 1)
  assert.equal(candidate.name, 'dsh-session-conductor')
  assert.equal(candidate.version, VERSION)
  assert.equal(normalizePath(candidate.packagePath), normalizePath(CLEAN_PACKAGE),
    'Candidate manifest identifies a different clean package')
  assert(typeof candidate.archive === 'string' && candidate.archive.length > 0,
    'Candidate manifest has no archive filename')
  assert(typeof candidate.sha256 === 'string' && /^[a-f0-9]{64}$/.test(candidate.sha256),
    'Candidate manifest has an invalid archive hash')
  assert(typeof candidate.packageJsonSha256 === 'string' && /^[a-f0-9]{64}$/.test(candidate.packageJsonSha256),
    'Candidate manifest has an invalid package.json hash')
  assert(Array.isArray(candidate.files) && candidate.files.length > 0, 'Candidate manifest has no file list')
  assert(candidate.packageFileHashes !== null && typeof candidate.packageFileHashes === 'object',
    'Candidate manifest has no complete package hash map')
  assert.deepEqual(
    [...candidate.files].sort(),
    Object.keys(candidate.packageFileHashes).sort(),
    'Candidate manifest file list differs from its package hash map',
  )

  const archive = join(CANDIDATE, candidate.archive)
  assert(existsSync(archive), `Candidate archive is absent: ${archive}`)
  assert.equal(sha256(archive), candidate.sha256, 'Candidate archive hash no longer matches its manifest')
  const clean = assertCleanPackage(CLEAN_PACKAGE)
  assert.equal(clean.manifestHash, candidate.packageJsonSha256,
    'Clean package package.json differs from the candidate manifest')
  assert.equal(clean.manifestHash, sha256Bytes(archiveEntry(archive, 'package/package.json')),
    'Clean package package.json differs from the sealed candidate archive')
  assertSameFileMaps(
    listRegularFiles(CLEAN_PACKAGE),
    new Map(Object.entries(candidate.packageFileHashes)),
    'Clean package differs from the sealed candidate manifest',
  )
  return { candidate, archive, clean }
}

function assertDesktopInputs() {
  for (const path of [DESKTOP_EXE, ASAR]) {
    assert(existsSync(path), `Required Desktop installation input is absent: ${path}`)
  }
  for (const file of PROFILE_FILES) {
    assert(existsSync(join(PROFILE, file)), `Required Desktop Profile file is absent: ${file}`)
  }
  return assertVerifiedDesktopCliSource()
}

function desktopCli(cliShim, args, timeout) {
  return run(
    DESKTOP_EXE,
    ['--expose-internals', cliShim, ...args],
    { env: desktopEnvironment(), timeout },
  )
}

function composedEntryCount(output, id) {
  return (output.match(new RegExp(`^- id: ${id}\\r?$`, 'gm')) ?? []).length
}

function assertComposition(output, label) {
  const entryCounts = Object.fromEntries(COMPOSE_REQUIRED_IDS.map(id => [id, composedEntryCount(output, id)]))
  for (const [id, count] of Object.entries(entryCounts)) {
    assert.equal(count, 1, `${label} has an unexpected composed entry count for ${id}`)
  }
  return entryCounts
}

function jsonBase64(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

/**
 * The rollback script intentionally verifies the installed state before its
 * single mutation and uses only the official offline CLI.  It contains no
 * process-control, backup-overwrite, or deletion command.
 */
export function renderCompletionReturnRollback({ current, previous, profileFiles, desktopCli }) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version Latest',
    '# Abort before any mutation when Desktop is still running; this script never stops it.',
    "$running = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)",
    "if ($running.Count -gt 0) { throw 'Fully quit every DSH Desktop process, including its tray process, before rollback. No files changed.' }",
    `$profilePath = ${powerShellLiteral(PROFILE.replaceAll('/', '\\'))}`,
    '$backupPath = $PSScriptRoot',
    `$desktopExe = ${powerShellLiteral(DESKTOP_EXE.replaceAll('/', '\\'))}`,
    "$desktopCli = Join-Path $backupPath 'desktop-cli.mjs'",
    `$profileName = ${powerShellLiteral(PROFILE_NAME)}`,
    `$expectedCurrent = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powerShellLiteral(jsonBase64(current))})) | ConvertFrom-Json`,
    `$expectedPrevious = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powerShellLiteral(jsonBase64(previous))})) | ConvertFrom-Json`,
    `$expectedProfileFiles = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powerShellLiteral(jsonBase64(profileFiles))})) | ConvertFrom-Json`,
    `$expectedDesktopCliSha256 = ${powerShellLiteral(desktopCli.sha256)}`,
    'function Normalize-FileSystemPath([string] $path) {',
    "  if ([string]::IsNullOrWhiteSpace($path)) { throw 'A required path is empty.' }",
    "  return [System.IO.Path]::GetFullPath($path).Replace('/', '\\').TrimEnd([char]92).ToLowerInvariant()",
    '}',
    'function Normalize-LinkDependency([string] $dependency) {',
    "  if ([string]::IsNullOrWhiteSpace($dependency) -or -not $dependency.StartsWith('link:')) { throw \"Expected a link: dependency, received: $dependency\" }",
    "  return Normalize-FileSystemPath $dependency.Substring('link:'.Length)",
    '}',
    'function Assert-FileHash([string] $path, [string] $expectedHash, [string] $label) {',
    "  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw \"$label is absent: $path\" }",
    "  $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()",
    "  if ($actualHash -ne $expectedHash) { throw \"$label changed: $path. No files changed.\" }",
    '}',
    'function Assert-LinkedPackage([string] $modulePath, [object] $expected, [string] $label) {',
    "  if (-not (Test-Path -LiteralPath $modulePath -PathType Container)) { throw \"$label is absent: $modulePath\" }",
    '  $item = Get-Item -LiteralPath $modulePath -Force',
    "  if ($item.LinkType -notin @('Junction', 'SymbolicLink')) { throw \"$label is not a junction or symbolic link: $modulePath\" }",
    "  $targets = @($item.Target | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })",
    "  if ($targets.Count -ne 1) { throw \"$label has an ambiguous link target: $modulePath\" }",
    '  $actualTarget = Normalize-FileSystemPath ([string] $targets[0])',
    '  if ($actualTarget -ne (Normalize-FileSystemPath ([string] $expected.packagePath))) { throw "$label resolves to an unexpected target: $($targets[0]). No files changed." }',
    "  Assert-FileHash (Join-Path $modulePath 'package.json') ([string] $expected.packageJsonSha256) \"$label package.json\"",
    "  $manifest = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $modulePath 'package.json') | ConvertFrom-Json",
    '  if ($manifest.name -ne \'dsh-session-conductor\' -or $manifest.version -ne $expected.version) { throw "$label has an unexpected package identity. No files changed." }',
    '}',
    'function Assert-ProfileState([object] $expected, [string] $label) {',
    "  $actual = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $profilePath 'package.json') | ConvertFrom-Json",
    '  Assert-JsonEquivalent $actual $expected.profilePackage "$label package.json"',
    '  $actualEntries = @($actual.dependencies.PSObject.Properties)',
    '  $expectedEntries = @($expected.dependencies.PSObject.Properties)',
    "  if ($actualEntries.Count -ne $expectedEntries.Count) { throw \"$label has a different dependency count.\" }",
    '  foreach ($entry in $expectedEntries) {',
    '    $current = $actual.dependencies.PSObject.Properties[$entry.Name]',
    "    if ($null -eq $current) { throw \"$label dependency is absent: $($entry.Name)\" }",
    "    if ($entry.Name -eq 'dsh-session-conductor') {",
    "      if ((Normalize-LinkDependency ([string] $current.Value)) -ne (Normalize-LinkDependency ([string] $entry.Value))) { throw \"$label conductor link target differs.\" }",
    '    } elseif ([string] $current.Value -ne [string] $entry.Value) {',
    "      throw \"$label dependency differs: $($entry.Name)\"",
    '    }',
    '  }',
    '  $actualBundles = @($actual.dsh.profile.bundles)',
    '  $expectedBundles = @($expected.bundles)',
    "  if ($actualBundles.Count -ne $expectedBundles.Count) { throw \"$label has a different bundle count.\" }",
    '  for ($index = 0; $index -lt $expectedBundles.Count; $index++) {',
    '    if ([string] $actualBundles[$index] -ne [string] $expectedBundles[$index]) { throw "$label bundle differs at index $index." }',
    '  }',
    '}',
    'function Assert-JsonEquivalent([object] $actual, [object] $expected, [string] $label) {',
    '  if ($null -eq $actual -or $null -eq $expected) {',
    '    if ($null -eq $actual -and $null -eq $expected) { return }',
    '    throw "$label differs."',
    '  }',
    "  $expectedProperties = @($expected.PSObject.Properties | Where-Object { $_.MemberType -eq 'NoteProperty' })",
    "  $actualProperties = @($actual.PSObject.Properties | Where-Object { $_.MemberType -eq 'NoteProperty' })",
    '  if ($expectedProperties.Count -gt 0 -or $actualProperties.Count -gt 0) {',
    "    if ($expectedProperties.Count -ne $actualProperties.Count) { throw \"$label has a different property count.\" }",
    '    foreach ($entry in $expectedProperties) {',
    '      $current = $actual.PSObject.Properties[$entry.Name]',
    "      if ($null -eq $current) { throw \"$label property is absent: $($entry.Name)\" }",
    '      Assert-JsonEquivalent $current.Value $entry.Value "$label.$($entry.Name)"',
    '    }',
    '    return',
    '  }',
    "  if ($expected -is [System.Collections.IEnumerable] -and $expected -isnot [string]) {",
    '    $expectedItems = @($expected)',
    '    $actualItems = @($actual)',
    "    if ($expectedItems.Count -ne $actualItems.Count) { throw \"$label has a different item count.\" }",
    '    for ($index = 0; $index -lt $expectedItems.Count; $index++) {',
    '      Assert-JsonEquivalent $actualItems[$index] $expectedItems[$index] "$label[$index]"',
    '    }',
    '    return',
    '  }',
    '  if ([string] $actual -ne [string] $expected) { throw "$label differs." }',
    '}',
    'function Assert-PackageFileMap([string] $packagePath, [object] $expectedFiles, [string] $label) {',
    "  if (-not (Test-Path -LiteralPath $packagePath -PathType Container)) { throw \"$label is absent: $packagePath\" }",
    '  $expectedEntries = @($expectedFiles.PSObject.Properties)',
    '  $actualFiles = @{}',
    "  $basePath = (Resolve-Path -LiteralPath $packagePath).Path.TrimEnd([char]92) + '\\'",
    '  foreach ($file in @(Get-ChildItem -LiteralPath $packagePath -Recurse -Force -File)) {',
    "    if (-not $file.FullName.StartsWith($basePath, [System.StringComparison]::OrdinalIgnoreCase)) { throw \"$label contains a file outside its package path: $($file.FullName)\" }",
    "    $relative = $file.FullName.Substring($basePath.Length).Replace('\\', '/')",
    '    $actualFiles[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()',
    '  }',
    "  if ($actualFiles.Count -ne $expectedEntries.Count) { throw \"$label has a different file count.\" }",
    '  foreach ($entry in $expectedEntries) {',
    "    if (-not $actualFiles.ContainsKey($entry.Name)) { throw \"$label file is absent: $($entry.Name)\" }",
    '    if ($actualFiles[$entry.Name] -ne [string] $entry.Value) { throw "$label file hash differs: $($entry.Name)" }',
    '  }',
    '}',
    'foreach ($entry in @($expectedProfileFiles)) {',
    '  if (-not [string]::IsNullOrWhiteSpace([string] $entry.afterSha256)) {',
    '    Assert-FileHash (Join-Path $profilePath $entry.name) ([string] $entry.afterSha256) "Current Profile file $($entry.name)"',
    '  }',
    '  Assert-FileHash (Join-Path $backupPath $entry.name) ([string] $entry.beforeSha256) "Backed-up Profile file $($entry.name)"',
    '}',
    "Assert-FileHash $desktopCli $expectedDesktopCliSha256 'Backed-up Desktop CLI shim'",
    'Assert-ProfileState $expectedCurrent \'Current Profile\'',
    "Assert-LinkedPackage (Join-Path $profilePath 'node_modules/dsh-session-conductor') $expectedCurrent 'Current dsh-session-conductor'",
    "Assert-PackageFileMap ([string] $expectedCurrent.packagePath) $expectedCurrent.packageFileHashes 'Current completion-return package'",
    "Assert-FileHash ([string] $expectedPrevious.archive) ([string] $expectedPrevious.archiveSha256) 'Sealed 0.1.5 recovery archive'",
    "Assert-PackageFileMap ([string] $expectedPrevious.packagePath) $expectedPrevious.packageFileHashes 'Sealed 0.1.5 recovery package'",
    "if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) { throw \"Desktop executable is absent: $desktopExe\" }",
    "$logStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fffffff'",
    '$rollbackCliLog = Join-Path $backupPath "rollback-completion-return-$logStamp-cli.log"',
    '$rollbackDumpLog = Join-Path $backupPath "rollback-completion-return-$logStamp-dump-config.log"',
    "$env:ELECTRON_RUN_AS_NODE = '1'",
    "$env:DSH_HOME = 'D:\\dsh'",
    `$env:CONDUCTOR_INSTALL_ASAR = ${powerShellLiteral(ASAR.replaceAll('/', '\\'))}`,
    '$env:CONDUCTOR_INSTALL_PROFILE = $profilePath',
    'try {',
    '  $cliOutput = & $desktopExe --expose-internals $desktopCli plugin --profile $profileName add --offline ([string] $expectedPrevious.packagePath) 2>&1',
    '  $cliExitCode = $LASTEXITCODE',
    '  $cliOutput | Out-File -LiteralPath $rollbackCliLog -Encoding utf8',
    '  if ($cliExitCode -ne 0) { throw "Official Desktop CLI returned exit code $cliExitCode. The script did not copy any backup over the Profile; inspect $rollbackCliLog." }',
    "  Assert-ProfileState $expectedPrevious 'Restored Profile'",
    "  Assert-LinkedPackage (Join-Path $profilePath 'node_modules/dsh-session-conductor') $expectedPrevious 'Restored dsh-session-conductor'",
    "  Assert-PackageFileMap ([string] $expectedPrevious.packagePath) $expectedPrevious.packageFileHashes 'Restored 0.1.5 recovery package'",
    "  $patch = @($expectedProfileFiles | Where-Object { $_.name -eq 'cordis.patch.yml' })",
    "  if ($patch.Count -ne 1) { throw 'Rollback metadata has no unique cordis.patch.yml hash.' }",
    "  Assert-FileHash (Join-Path $profilePath 'cordis.patch.yml') ([string] $patch[0].beforeSha256) 'Restored Profile cordis.patch.yml'",
    '  $dumpOutput = & $desktopExe --expose-internals $desktopCli --profile $profileName --dump-config 2>&1',
    '  $dumpExitCode = $LASTEXITCODE',
    '  $dumpOutput | Out-File -LiteralPath $rollbackDumpLog -Encoding utf8',
    '  if ($dumpExitCode -ne 0) { throw "Official Desktop CLI composition check returned exit code $dumpExitCode. Inspect $rollbackDumpLog." }',
    '  $dumpText = [string] ($dumpOutput -join [Environment]::NewLine)',
    "  foreach ($id in @('dsh-session-conductor', 'conductor-binary-files', 'conductor-compatible-api-gateway')) {",
    '    $count = [regex]::Matches($dumpText, "(?m)^- id: " + [regex]::Escape($id) + "\\r?$").Count',
    '    if ($count -ne 1) { throw "Unexpected composed entry count for ${id}: $count. Inspect $rollbackDumpLog." }',
    '  }',
    '$evidencePath = Join-Path $backupPath "rollback-completion-return-$logStamp.json"',
    '$evidence = [ordered]@{ completedAt = (Get-Date).ToString(\'o\'); profile = $profilePath; offline = $true; restoredDependency = $expectedPrevious.dependency; restoredPackagePath = $expectedPrevious.packagePath; restoredVersion = $expectedPrevious.version; rollbackCliLog = $rollbackCliLog; rollbackDumpLog = $rollbackDumpLog; desktopWasRequiredStopped = $true; copiedProfileBackupsOverProfile = $false; restoredProfileAndBundleVerified = $true; restoredModuleLinkVerified = $true; restoredCordisPatchHashVerified = $true; compositionVerified = $true }',
    '[System.IO.File]::WriteAllText($evidencePath, (($evidence | ConvertTo-Json -Depth 10) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))',
    '  Write-Output "Sealed 0.1.5 link restored and verified. Reopen DSH Desktop normally. Evidence: $evidencePath"',
    '} catch {',
    '  Write-Error "Rollback did not complete. The Desktop GUI was not started, no existing Desktop process was stopped, and this script never copied backup Profile files over the Profile. Inspect rollback logs if they exist. $($_.Exception.Message)"',
    '  exit 1',
    '}',
    '',
  ]
  return lines.join('\r\n')
}

function writeBackup(preflight) {
  // Validate before creating any backup. Compare the copied bytes to the
  // pinned hash too, so a change between validation and copy also fails closed.
  const trustedCli = assertVerifiedDesktopCliSource()
  assert(!existsSync(BACKUP), `Refusing to overwrite an existing completion-return backup: ${BACKUP}`)
  mkdirSync(BACKUP, { recursive: true })
  for (const file of PROFILE_FILES) {
    copyFileSync(join(PROFILE, file), join(BACKUP, file))
    assert.equal(sha256(join(BACKUP, file)), preflight.profileHashes[file],
      `Backed-up Profile file hash differs: ${file}`)
  }
  const backupCli = join(BACKUP, 'desktop-cli.mjs')
  copyFileSync(CLI_SOURCE, backupCli)
  const cliSha256 = sha256(backupCli)
  assert.equal(cliSha256, trustedCli.sha256, 'Backed-up Desktop CLI shim hash differs from the verified source')
  writeFileSync(join(BACKUP, 'preflight.json'), `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    profile: PROFILE,
    profileVersion: preflight.prior.finalManifest.version,
    profileDependency: preflight.state.dependencies['dsh-session-conductor'],
    profileHashes: preflight.profileHashes,
    profileModule: preflight.module,
    sealedPriorArchive: preflight.prior.archive,
    sealedPriorArchiveSha256: preflight.prior.finalManifest.sha256,
    desktopCli: { source: CLI_SOURCE, sha256: cliSha256 },
  }, null, 2)}\n`, 'utf8')
  return { path: backupCli, sha256: cliSha256 }
}

function assertInstalledState(beforeProfile, beforeHashes, candidateState) {
  const afterProfile = readJson(join(PROFILE, 'package.json'))
  assertProfileUnchangedExceptConductor(beforeProfile, afterProfile, `link:${CLEAN_PACKAGE}`)
  const afterState = profileState(afterProfile)
  const afterHashes = profileFileHashes()
  assert.equal(afterHashes['cordis.patch.yml'], beforeHashes['cordis.patch.yml'],
    'Profile cordis.patch.yml changed during the completion-return upgrade')
  const installedModule = linkedPackageState(
    join(PROFILE, 'node_modules/dsh-session-conductor'),
    CLEAN_PACKAGE,
    VERSION,
    candidateState.clean.manifestHash,
    'Installed dsh-session-conductor',
  )
  // Revalidate the isolated target after the CLI work before sealing receipt.
  assertCandidate()
  return { afterProfile, afterState, afterHashes, installedModule }
}

function rollbackInputs({ candidateState, preflight, desktopCliShim }) {
  const expectedCurrentProfile = JSON.parse(JSON.stringify(preflight.profileJson))
  expectedCurrentProfile.dependencies['dsh-session-conductor'] = `link:${CLEAN_PACKAGE}`
  const expectedCurrentState = profileState(expectedCurrentProfile)
  const current = {
    dependency: expectedCurrentState.dependencies['dsh-session-conductor'],
    dependencies: expectedCurrentState.dependencies,
    bundles: expectedCurrentState.bundles,
    packagePath: CLEAN_PACKAGE,
    version: VERSION,
    packageJsonSha256: candidateState.clean.manifestHash,
    packageFileHashes: candidateState.candidate.packageFileHashes,
    profilePackage: expectedCurrentProfile,
  }
  const previous = {
    dependency: preflight.state.dependencies['dsh-session-conductor'],
    dependencies: preflight.state.dependencies,
    bundles: preflight.state.bundles,
    packagePath: preflight.prior.finalManifest.packagePath,
    version: preflight.prior.finalManifest.version,
    packageJsonSha256: preflight.prior.manifestHash,
    packageFileHashes: preflight.prior.packageFileHashes,
    archive: preflight.prior.archive,
    archiveSha256: preflight.prior.finalManifest.sha256,
    profilePackage: preflight.profileJson,
  }
  return {
    script: join(BACKUP, 'rollback-completion-return.ps1'),
    desktopCli: desktopCliShim,
    current,
    previous,
    profileFiles: PROFILE_FILES.map(name => ({
      name,
      beforeSha256: preflight.profileHashes[name],
      // The official CLI determines package.json and lockfile bytes.  Their
      // semantic Profile state is guarded below; the patch is byte-stable.
      afterSha256: name === 'cordis.patch.yml' ? preflight.profileHashes[name] : null,
    })),
    behavior: 'Requires every DSH Desktop process to be stopped, validates expected 0.1.6 Profile semantics, junction, package map, shim, and sealed 0.1.5 archive, then uses only the official offline Desktop CLI. It never copies a backup over the Profile.',
  }
}

function writePreparedRollback(input) {
  assert(!existsSync(input.script), `Refusing to overwrite an existing rollback script: ${input.script}`)
  writeFileSync(input.script, renderCompletionReturnRollback(input), 'utf8')
  return input
}

function writeVerifiedInstallation({ candidateState, preflight, installed, rollback, composition, installLog, dumpLog }) {
  assert(!existsSync(RECEIPT), `Refusing to overwrite an existing completion-return receipt: ${RECEIPT}`)
  const profileFiles = PROFILE_FILES.map(name => ({
    name,
    beforeSha256: preflight.profileHashes[name],
    afterSha256: installed.afterHashes[name],
    backupSha256: sha256(join(BACKUP, name)),
  }))
  assert.equal(normalizePath(rollback.previous.packagePath), normalizePath(preflight.prior.finalManifest.packagePath),
    'Sealed prior package path changed while preparing rollback')
  assert.equal(normalizePath(rollback.current.packagePath), normalizePath(CLEAN_PACKAGE),
    'Prepared rollback identifies a different completion-return package')

  mkdirSync(VERIFICATION_ROOT, { recursive: true })
  const receipt = {
    installedAt: new Date().toISOString(),
    profilePath: PROFILE,
    packagePath: CLEAN_PACKAGE,
    version: VERSION,
    archive: candidateState.archive,
    sha256: candidateState.candidate.sha256,
    packageJsonSha256: candidateState.clean.manifestHash,
    backup: BACKUP,
    installLog,
    dumpConfigLog: dumpLog,
    preflight: {
      requiredPriorVersion: preflight.prior.finalManifest.version,
      requiredPriorDependency: preflight.state.dependencies['dsh-session-conductor'],
      requiredPriorPackagePath: preflight.prior.finalManifest.packagePath,
      sealedPriorArchive: preflight.prior.archive,
      sealedPriorArchiveSha256: preflight.prior.finalManifest.sha256,
      profileModule: preflight.module,
    },
    profileVerification: {
      path: PROFILE,
      dependenciesChanged: ['dsh-session-conductor'],
      bundlesUnchanged: true,
      hashesBefore: preflight.profileHashes,
      hashesAfter: installed.afterHashes,
      cordisPatchUnchanged: true,
      rollbackProfileHashGates: profileFiles,
    },
    installedModule: installed.installedModule,
    composition: {
      command: 'official Desktop CLI --profile desktop --dump-config',
      entryCounts: composition,
    },
    existingDesktopProcessesWereNotStopped: true,
    officialCliLaunchedInElectronNodeMode: true,
    desktopGuiWasNotStarted: true,
    nextStep: 'Fully exit DSH Desktop including its tray process, then reopen it normally.',
    rollback,
  }
  writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  return receipt
}

/**
 * Reconstruct the immutable pre-upgrade inputs from the backup that was made
 * before the official CLI call.  This supports a safe verification-only
 * recovery if a post-install assertion fails after the Profile has changed.
 */
function readBackedUpPreflight() {
  const preflightPath = join(BACKUP, 'preflight.json')
  assert(existsSync(preflightPath), `Pre-upgrade record is absent: ${preflightPath}`)
  const recorded = readJson(preflightPath)
  assert.equal(normalizePath(recorded.profile), normalizePath(PROFILE),
    'Pre-upgrade record identifies a different Desktop Profile')
  assert(recorded.profileHashes !== null && typeof recorded.profileHashes === 'object',
    'Pre-upgrade record has no Profile hash map')

  const profileJson = readJson(join(BACKUP, 'package.json'))
  const state = profileState(profileJson)
  const profileHashes = Object.fromEntries(PROFILE_FILES.map(file => {
    const expected = recorded.profileHashes[file]
    assert(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected),
      `Pre-upgrade record has no valid hash for ${file}`)
    assert.equal(sha256(join(BACKUP, file)), expected,
      `Backed-up Profile file hash differs from its pre-upgrade record: ${file}`)
    return [file, expected]
  }))
  assert.equal(state.dependencies['dsh-session-conductor'], recorded.profileDependency,
    'Backed-up Profile dependency differs from its pre-upgrade record')

  const prior = assertSealedPriorPackage()
  assert.equal(recorded.profileVersion, prior.finalManifest.version,
    'Pre-upgrade record has an unexpected conductor version')
  assert.equal(recorded.sealedPriorArchive, prior.archive,
    'Pre-upgrade record identifies a different sealed recovery archive')
  assert.equal(recorded.sealedPriorArchiveSha256, prior.finalManifest.sha256,
    'Pre-upgrade record has an unexpected sealed recovery archive hash')
  assert(recorded.profileModule !== null && typeof recorded.profileModule === 'object',
    'Pre-upgrade record has no prior module record')
  assert.equal(recorded.profileModule.packageName, 'dsh-session-conductor',
    'Pre-upgrade record has an unexpected prior package name')
  assert.equal(recorded.profileModule.version, prior.finalManifest.version,
    'Pre-upgrade record has an unexpected prior module version')
  assert.equal(normalizePath(recorded.profileModule.target), normalizePath(prior.finalManifest.packagePath),
    'Pre-upgrade record has an unexpected prior module target')
  assert.equal(recorded.profileModule.packageJsonSha256, prior.manifestHash,
    'Pre-upgrade record has an unexpected prior module package.json hash')

  const trustedCli = assertVerifiedDesktopCliSource()
  const backupCli = join(BACKUP, 'desktop-cli.mjs')
  assert(existsSync(backupCli), `Backed-up Desktop CLI shim is absent: ${backupCli}`)
  assert.equal(sha256(backupCli), trustedCli.sha256,
    'Backed-up Desktop CLI shim differs from the verified source')
  assert.equal(recorded.desktopCli?.sha256, trustedCli.sha256,
    'Pre-upgrade record has an unexpected Desktop CLI shim hash')

  return {
    profileJson,
    state,
    profileHashes,
    prior,
    module: recorded.profileModule,
    desktopCli: { path: backupCli, sha256: trustedCli.sha256 },
  }
}

/**
 * Finish evidence collection after a proven post-CLI verification interruption.
 * The function is deliberately read-only with respect to the Desktop Profile.
 */
export function verifyCompletionReturnPostInstall() {
  assert(!existsSync(RECEIPT), `Refusing to overwrite an existing completion-return receipt: ${RECEIPT}`)
  assertDesktopInputs()
  const candidateState = assertCandidate()
  const preflight = readBackedUpPreflight()
  const rollback = rollbackInputs({ candidateState, preflight, desktopCliShim: preflight.desktopCli })
  assert(existsSync(rollback.script), `Prepared rollback script is absent: ${rollback.script}`)
  assert.equal(
    readFileSync(rollback.script, 'utf8'),
    renderCompletionReturnRollback(rollback),
    'Prepared rollback script differs from the verified recovery plan',
  )

  const installed = assertInstalledState(preflight.profileJson, preflight.profileHashes, candidateState)
  const installLog = join(BACKUP, 'install-cli.log')
  assert(existsSync(installLog), `Official CLI install log is absent: ${installLog}`)
  const dumpLog = join(BACKUP, 'dump-config.log')
  let dumped
  try {
    dumped = desktopCli(preflight.desktopCli.path, ['--profile', PROFILE_NAME, '--dump-config'], 30_000)
  } catch (error) {
    writeFileSync(dumpLog, `${String(error)}\n`, 'utf8')
    throw new Error(`Desktop Profile composition failed during verification-only recovery. ${String(error)}`)
  }
  const dumpOutput = `${dumped.stdout ?? ''}${dumped.stderr ?? ''}`
  writeFileSync(dumpLog, `${dumpOutput}\n`, 'utf8')
  const composition = assertComposition(dumpOutput, 'Desktop Profile composition')
  const receipt = writeVerifiedInstallation({
    candidateState,
    preflight,
    installed,
    rollback,
    composition,
    installLog,
    dumpLog,
  })
  process.stdout.write(`${JSON.stringify({
    verifiedExistingInstall: `dsh-session-conductor@${VERSION}`,
    profileMutatedByThisRun: false,
    packagePath: CLEAN_PACKAGE,
    backup: BACKUP,
    receipt: RECEIPT,
    sha256: candidateState.candidate.sha256,
    composition: receipt.composition.entryCounts,
    existingDesktopProcessesWereNotStopped: true,
    officialCliLaunchedInElectronNodeMode: true,
    desktopGuiWasNotStarted: true,
  }, null, 2)}\n`)
  return receipt
}

export function installCompletionReturnCandidate() {
  assert(!existsSync(RECEIPT), `Refusing to overwrite an existing completion-return receipt: ${RECEIPT}`)
  assert(!existsSync(BACKUP), `Refusing to reuse an existing completion-return backup: ${BACKUP}`)
  assertDesktopInputs()
  const candidateState = assertCandidate()
  const preflight = assertProfileStillOnSealedPrior()
  const desktopCliShim = writeBackup(preflight)
  // The recovery path exists before the official CLI can mutate the Profile.
  // If a later post-CLI assertion fails, it remains available and still rejects
  // any state that does not exactly match the expected new link and semantics.
  const rollback = writePreparedRollback(rollbackInputs({ candidateState, preflight, desktopCliShim }))
  assert.deepEqual(profileFileHashes(), preflight.profileHashes,
    'Desktop Profile changed while creating the backup and rollback guard; no official CLI call was made')
  assertProfileStillOnSealedPrior()

  let installedCli
  const installLog = join(BACKUP, 'install-cli.log')
  try {
    installedCli = desktopCli(desktopCliShim.path,
      ['plugin', '--profile', PROFILE_NAME, 'add', '--offline', CLEAN_PACKAGE], 120_000)
  } catch (error) {
    writeFileSync(installLog, `${String(error)}\n`, 'utf8')
    throw new Error(`Official Desktop CLI upgrade failed; backup retained at ${BACKUP}. ${String(error)}`)
  }
  writeFileSync(installLog, `${installedCli.stdout ?? ''}\n${installedCli.stderr ?? ''}\n`, 'utf8')

  const installed = assertInstalledState(preflight.profileJson, preflight.profileHashes, candidateState)
  let dumped
  const dumpLog = join(BACKUP, 'dump-config.log')
  try {
    dumped = desktopCli(desktopCliShim.path, ['--profile', PROFILE_NAME, '--dump-config'], 30_000)
  } catch (error) {
    writeFileSync(dumpLog, `${String(error)}\n`, 'utf8')
    throw new Error(`Desktop Profile composition failed after upgrade. ${String(error)}`)
  }
  const dumpOutput = `${dumped.stdout ?? ''}${dumped.stderr ?? ''}`
  writeFileSync(dumpLog, `${dumpOutput}\n`, 'utf8')
  const composition = assertComposition(dumpOutput, 'Desktop Profile composition')
  const receipt = writeVerifiedInstallation({
    candidateState,
    preflight,
    installed,
    rollback,
    composition,
    installLog,
    dumpLog,
  })
  process.stdout.write(`${JSON.stringify({
    upgraded: `dsh-session-conductor@${VERSION}`,
    packagePath: CLEAN_PACKAGE,
    backup: BACKUP,
    receipt: RECEIPT,
    sha256: candidateState.candidate.sha256,
    composition: receipt.composition.entryCounts,
    existingDesktopProcessesWereNotStopped: true,
    officialCliLaunchedInElectronNodeMode: true,
    desktopGuiWasNotStarted: true,
  }, null, 2)}\n`)
  return receipt
}

if (process.argv[1] && normalizePath(fileURLToPath(import.meta.url)) === normalizePath(process.argv[1])) {
  const commands = process.argv.slice(2)
  if (commands.length === 0) {
    installCompletionReturnCandidate()
  } else if (commands.length === 1 && commands[0] === '--verify-post-install') {
    verifyCompletionReturnPostInstall()
  } else {
    throw new Error('Usage: node install-completion-return-candidate.mjs [--verify-post-install]')
  }
}
