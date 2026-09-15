/**
 * Offline-upgrade the selected Desktop Profile to the verified 0.1.5
 * delegation-only package.  The script never stops or starts DSH Desktop.
 * A running Desktop continues using its old module graph until the user exits
 * and reopens it normally.
 *
 * Prerequisite: CONDUCTOR_DELEGATION_PROOF must name external Host/Edge
 * evidence produced against the isolated CLEAN_PACKAGE.
 */
import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ASAR,
  BACKUP,
  CANDIDATE,
  CLEAN_PACKAGE,
  CLI_SHIM,
  COMPOSE_REQUIRED_IDS,
  DESKTOP_EXE,
  PROFILE,
  PROFILE_FILES,
  PROFILE_NAME,
  PRIOR_PACKAGE,
  PRIOR_VERSION,
  RECEIPT,
  VERSION,
  archiveEntry,
  assertCleanPackage,
  assertPriorRecoveryPackage,
  assertPriorProfileAndPackage,
  assertProfileBundleInvariant,
  assertProfileUnchangedExceptConductor,
  assertSameLinkDependency,
  assertSameFileMaps,
  desktopEnvironment,
  linkedPackageState,
  listRegularFiles,
  normalizePath,
  powerShellLiteral,
  profileState,
  readJson,
  run,
  sha256,
  sha256Bytes,
} from './delegation-only-common.mjs'

function assertProof(proofPath) {
  assert(typeof proofPath === 'string' && proofPath.length > 0,
    'Set CONDUCTOR_DELEGATION_PROOF to the external clean-package proof JSON before installing')
  assert(existsSync(proofPath), 'Delegation proof is absent: ' + proofPath)
  const proof = readJson(proofPath)
  assert.equal(proof.ok, true, 'Delegation proof is not successful')
  assert.equal(proof.portReleased, true, 'Delegation proof left its port in use')
  assert.equal(proof.responseInterception, false, 'Delegation proof used response interception')
  assert.equal(proof.receipt?.providerCalls, 0, 'Delegation proof made model-provider calls')
  assert(Array.isArray(proof.assertions) && proof.assertions.length > 0,
    'Delegation proof must record at least one assertion')
  const proofPackagePath = proof.packages?.['dsh-session-conductor'] ?? proof.packagePath
  assert.equal(normalizePath(proofPackagePath), normalizePath(CLEAN_PACKAGE),
    'Delegation proof identifies a different clean package')
  return proof
}

function assertCandidate() {
  const manifestPath = join(CANDIDATE, 'manifest.json')
  assert(existsSync(manifestPath), 'Candidate manifest is absent: ' + manifestPath)
  const candidate = readJson(manifestPath)
  assert.equal(candidate.name, 'dsh-session-conductor')
  assert.equal(candidate.version, VERSION)
  assert.equal(normalizePath(candidate.packagePath), normalizePath(CLEAN_PACKAGE),
    'Candidate manifest identifies a different clean package')
  assert(Array.isArray(candidate.files) && candidate.files.length > 0, 'Candidate manifest has no file list')
  assert(candidate.packageFileHashes !== null && typeof candidate.packageFileHashes === 'object',
    'Candidate manifest has no complete package hash map')
  const archive = join(CANDIDATE, candidate.archive)
  assert(existsSync(archive), 'Candidate archive is absent: ' + archive)
  assert.equal(sha256(archive), candidate.sha256, 'Candidate archive hash no longer matches its manifest')
  const clean = assertCleanPackage(CLEAN_PACKAGE)
  const archiveManifestHash = sha256Bytes(archiveEntry(archive, 'package/package.json'))
  assert.equal(clean.manifestHash, archiveManifestHash,
    'Clean package package.json differs from the sealed candidate archive')
  assertSameFileMaps(
    listRegularFiles(CLEAN_PACKAGE),
    new Map(Object.entries(candidate.packageFileHashes)),
    'Clean package differs from the sealed candidate manifest',
  )
  return { candidate, archive, clean }
}

function assertDesktopInputs({ requiresSourceCli = true } = {}) {
  const paths = [DESKTOP_EXE, ASAR]
  if (requiresSourceCli) paths.push(CLI_SHIM)
  for (const path of paths) {
    assert(existsSync(path), 'Required Desktop installation input is absent: ' + path)
  }
  for (const file of PROFILE_FILES) {
    const path = join(PROFILE, file)
    assert(existsSync(path), 'Required Desktop Profile file is absent: ' + path)
  }
}

function desktopCli(args, timeout) {
  return run(
    DESKTOP_EXE,
    ['--expose-internals', CLI_SHIM, ...args],
    { env: desktopEnvironment(), timeout },
  )
}

function composedEntryCount(output, name) {
  return (output.match(new RegExp('^- id: ' + name + '\\r?$', 'gm')) ?? []).length
}

function assertComposition(output, label) {
  for (const name of COMPOSE_REQUIRED_IDS) {
    assert.equal(composedEntryCount(output, name), 1,
      label + ' has an unexpected composed entry count for ' + name)
  }
}

function rollbackJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

/**
 * The generated script is deliberately limited to validation plus the
 * official offline Desktop CLI.  It never overwrites a Profile backup onto a
 * changed Profile and it contains no process stop/start operations.
 */
export function renderDelegationOnlyRollback(input) {
  const currentBase64 = rollbackJson(input.current)
  const previousBase64 = rollbackJson(input.previous)
  const protectedBase64 = rollbackJson(input.protectedFiles)
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "# Runtime guard: abort before any Profile mutation while Desktop is still running.",
    "$running = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)",
    "if ($running.Count -gt 0) { throw 'Fully quit every DSH Desktop process, including its tray process, before rollback. No files changed.' }",
    "$profilePath = " + powerShellLiteral(PROFILE.replaceAll('/', '\\')),
    "$backupPath = $PSScriptRoot",
    "$desktopExe = " + powerShellLiteral(DESKTOP_EXE.replaceAll('/', '\\')),
    "$desktopCli = Join-Path $backupPath 'desktop-cli.mjs'",
    "$profileName = " + powerShellLiteral(PROFILE_NAME),
    "$expectedCurrentPackagePath = " + powerShellLiteral(CLEAN_PACKAGE.replaceAll('/', '\\')),
    "$expectedPreviousPackagePath = " + powerShellLiteral(PRIOR_PACKAGE.replaceAll('/', '\\')),
    "$expectedPreviousDependency = " + powerShellLiteral(input.previous.dependency),
    "$expectedPriorArchive = " + powerShellLiteral(input.previous.archive.replaceAll('/', '\\')),
    "$expectedPriorArchiveSha256 = " + powerShellLiteral(input.previous.archiveSha256),
    "$expectedDesktopCliSha256 = " + powerShellLiteral(input.desktopCli.sha256),
    "$expectedCurrent = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(" + powerShellLiteral(currentBase64) + ")) | ConvertFrom-Json",
    "$expectedPrevious = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(" + powerShellLiteral(previousBase64) + ")) | ConvertFrom-Json",
    "$protectedFiles = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(" + powerShellLiteral(protectedBase64) + ")) | ConvertFrom-Json",
    "function Normalize-FileSystemPath([string] $path) {",
    "  if ([string]::IsNullOrWhiteSpace($path)) { throw 'A required path is empty.' }",
    "  return [System.IO.Path]::GetFullPath($path).Replace('/', '\\').TrimEnd([char]92).ToLowerInvariant()",
    "}",
    "function Normalize-LinkDependency([string] $dependency) {",
    "  if ([string]::IsNullOrWhiteSpace($dependency) -or -not $dependency.StartsWith('link:')) { throw \"Expected a link: dependency, received: $dependency\" }",
    "  return Normalize-FileSystemPath $dependency.Substring('link:'.Length)",
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
    "function Assert-ProfileState([object] $expected, [string] $label) {",
    "  $current = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $profilePath 'package.json') | ConvertFrom-Json",
    "  $currentDependencies = @($current.dependencies.PSObject.Properties)",
    "  $expectedDependencies = @($expected.dependencies.PSObject.Properties)",
    "  if ($currentDependencies.Count -ne $expectedDependencies.Count) { throw \"$label has a different dependency count.\" }",
    "  foreach ($entry in $expectedDependencies) {",
    "    $actual = $current.dependencies.PSObject.Properties[$entry.Name]",
    "    if ($null -eq $actual) { throw \"$label dependency is absent: $($entry.Name)\" }",
    "    if ($entry.Name -eq 'dsh-session-conductor') {",
    "      if ((Normalize-LinkDependency ([string]$actual.Value)) -ne (Normalize-LinkDependency ([string]$entry.Value))) { throw \"$label conductor link target differs.\" }",
    "    } elseif ([string]$actual.Value -ne [string]$entry.Value) { throw \"$label dependency differs: $($entry.Name)\" }",
    "  }",
    "  $actualBundles = @($current.dsh.profile.bundles)",
    "  $expectedBundles = @($expected.bundles)",
    "  if ($actualBundles.Count -ne $expectedBundles.Count) { throw \"$label has a different bundle count.\" }",
    "  for ($index = 0; $index -lt $expectedBundles.Count; $index++) {",
    "    if ([string]$actualBundles[$index] -ne [string]$expectedBundles[$index]) { throw \"$label bundle differs at index $index.\" }",
    "  }",
    "  if ((Normalize-LinkDependency ([string]$current.dependencies.'dsh-session-conductor')) -ne (Normalize-LinkDependency ([string]$expected.dependency))) { throw \"$label does not point at the expected conductor link target.\" }",
    "}",
    "foreach ($entry in $protectedFiles) {",
    "  $profileFile = Join-Path $profilePath $entry.name",
    "  $backupFile = Join-Path $backupPath $entry.name",
    "  Assert-FileHash $profileFile $entry.installedSha256 \"Current Profile file $($entry.name)\"",
    "  Assert-FileHash $backupFile $entry.backupSha256 \"Backup Profile file $($entry.name)\"",
    "}",
    "Assert-ProfileState $expectedCurrent 'Current Profile'",
    "Assert-LinkedPackage (Join-Path $profilePath 'node_modules/dsh-session-conductor') $expectedCurrentPackagePath $expectedCurrent.version $expectedCurrent.packageJsonSha256 'Current dsh-session-conductor'",
    "Assert-FileHash $desktopCli $expectedDesktopCliSha256 'Backed-up Desktop CLI shim'",
    "Assert-FileHash $expectedPriorArchive $expectedPriorArchiveSha256 'Sealed 0.1.4 recovery archive'",
    "Assert-FileHash (Join-Path $expectedPreviousPackagePath 'package.json') $expectedPrevious.packageJsonSha256 'Verified 0.1.4 recovery package'",
    "$previousManifest = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $expectedPreviousPackagePath 'package.json') | ConvertFrom-Json",
    "if ($previousManifest.name -ne 'dsh-session-conductor' -or $previousManifest.version -ne $expectedPrevious.version) { throw 'Verified 0.1.4 recovery package has an unexpected identity. No files changed.' }",
    "if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) { throw \"Desktop executable is absent: $desktopExe\" }",
    "if (-not (Test-Path -LiteralPath $desktopCli -PathType Leaf)) { throw \"Backed-up Desktop CLI shim is absent: $desktopCli\" }",
    "$logStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fffffff'",
    "$rollbackCliLog = Join-Path $backupPath \"rollback-delegation-only-$logStamp-cli.log\"",
    "$rollbackDumpLog = Join-Path $backupPath \"rollback-delegation-only-$logStamp-dump-config.log\"",
    "$env:ELECTRON_RUN_AS_NODE = '1'",
    "$env:DSH_HOME = 'D:\\dsh'",
    "$env:CONDUCTOR_INSTALL_ASAR = " + powerShellLiteral(ASAR.replaceAll('/', '\\')),
    "$env:CONDUCTOR_INSTALL_PROFILE = $profilePath",
    "try {",
    "  $cliOutput = & $desktopExe --expose-internals $desktopCli plugin --profile $profileName add --offline $expectedPreviousPackagePath 2>&1",
    "  $cliExitCode = $LASTEXITCODE",
    "  $cliOutput | Out-File -LiteralPath $rollbackCliLog -Encoding utf8",
    "  if ($cliExitCode -ne 0) { throw \"Official Desktop CLI returned exit code $cliExitCode. The script did not copy backup files over the Profile; inspect $rollbackCliLog.\" }",
    "  Assert-ProfileState $expectedPrevious 'Restored Profile'",
    "  Assert-LinkedPackage (Join-Path $profilePath 'node_modules/dsh-session-conductor') $expectedPreviousPackagePath $expectedPrevious.version $expectedPrevious.packageJsonSha256 'Restored dsh-session-conductor'",
    "  $patchEntry = @($protectedFiles | Where-Object { $_.name -eq 'cordis.patch.yml' })",
    "  if ($patchEntry.Count -ne 1) { throw 'Rollback metadata has no unique cordis.patch.yml hash.' }",
    "  Assert-FileHash (Join-Path $profilePath 'cordis.patch.yml') $patchEntry[0].backupSha256 'Restored cordis.patch.yml'",
    "  $dumpOutput = & $desktopExe --expose-internals $desktopCli --profile $profileName --dump-config 2>&1",
    "  $dumpExitCode = $LASTEXITCODE",
    "  $dumpOutput | Out-File -LiteralPath $rollbackDumpLog -Encoding utf8",
    "  if ($dumpExitCode -ne 0) { throw \"Official Desktop CLI composition check returned exit code $dumpExitCode. Inspect $rollbackDumpLog.\" }",
    "  foreach ($name in @('dsh-session-conductor', 'conductor-binary-files', 'conductor-compatible-api-gateway')) {",
    "    $count = @($dumpOutput | Select-String -Pattern \"^- id: $name\\r?$\").Count",
    "    if ($count -ne 1) { throw \"Unexpected composed entry count for ${name}: $count. Inspect $rollbackDumpLog.\" }",
    "  }",
    "  $evidencePath = Join-Path $backupPath \"rollback-delegation-only-$logStamp.json\"",
    "  $evidence = [ordered]@{ completedAt = (Get-Date).ToString('o'); profile = $profilePath; offline = $true; restoredDependency = $expectedPreviousDependency; restoredPackagePath = $expectedPreviousPackagePath; restoredVersion = $expectedPrevious.version; rollbackCliLog = $rollbackCliLog; rollbackDumpLog = $rollbackDumpLog; currentProfileHashGate = $protectedFiles; restoredProfileAndBundleVerified = $true; restoredModuleLinkVerified = $true; restoredCordisPatchHashVerified = $true; compositionVerified = $true }",
    "  [System.IO.File]::WriteAllText($evidencePath, (($evidence | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))",
    "  Write-Output \"0.1.4 link restored and verified. Reopen DSH Desktop normally. Evidence: $evidencePath\"",
    "} catch {",
    "  Write-Error \"Rollback did not complete. Desktop was not started and this script never copied backup Profile files over a changed Profile. Inspect the rollback logs if they exist. $($_.Exception.Message)\"",
    "  exit 1",
    "}",
    "",
  ]
  return lines.join('\r\n')
}

function assertSafeResumeBackup() {
  for (const file of [...PROFILE_FILES, 'desktop-cli.mjs', 'install-cli.log']) {
    const path = join(BACKUP, file)
    assert(existsSync(path), 'Safe resume backup is incomplete: ' + path)
  }
  const installLog = readFileSync(join(BACKUP, 'install-cli.log'), 'utf8')
  assert(installLog.trim().length > 0, 'Safe resume backup has no successful-install CLI evidence')

  const before = readJson(join(BACKUP, 'package.json'))
  const beforeState = profileState(before)
  assertProfileBundleInvariant(beforeState.bundles, 'Saved pre-upgrade Profile')
  assertSameLinkDependency(
    beforeState.dependencies['dsh-session-conductor'],
    'link:' + PRIOR_PACKAGE,
    'Saved pre-upgrade Profile does not prove the expected 0.1.4 history-first link',
  )
  const prior = assertPriorRecoveryPackage()
  return { before, beforeState, prior, installLog }
}

function assertInstalledState(before, clean) {
  const after = readJson(join(PROFILE, 'package.json'))
  const afterState = profileState(after)
  assertProfileBundleInvariant(afterState.bundles, 'Installed Profile')
  assertProfileUnchangedExceptConductor(before, after, 'link:' + CLEAN_PACKAGE)
  const installedModule = linkedPackageState(
    join(PROFILE, 'node_modules/dsh-session-conductor'),
    CLEAN_PACKAGE,
    VERSION,
    clean.manifestHash,
    'Installed dsh-session-conductor',
  )
  return { after, afterState, installedModule }
}

function writeVerifiedInstallation({
  candidate,
  archive,
  clean,
  proof,
  proofPath,
  beforeState,
  prior,
  afterState,
  installedModule,
  compositionChecked,
  resumed,
}) {
  const protectedFiles = PROFILE_FILES.map(name => ({
    name,
    installedSha256: sha256(join(PROFILE, name)),
    backupSha256: sha256(join(BACKUP, name)),
  }))
  const rollback = {
    script: join(BACKUP, 'rollback-delegation-only.ps1'),
    desktopCli: {
      path: join(BACKUP, 'desktop-cli.mjs'),
      sha256: sha256(join(BACKUP, 'desktop-cli.mjs')),
    },
    current: {
      dependency: afterState.dependencies['dsh-session-conductor'],
      dependencies: afterState.dependencies,
      bundles: afterState.bundles,
      module: installedModule,
      version: VERSION,
      packageJsonSha256: clean.manifestHash,
    },
    previous: {
      dependency: beforeState.dependencies['dsh-session-conductor'],
      dependencies: beforeState.dependencies,
      bundles: beforeState.bundles,
      packagePath: PRIOR_PACKAGE,
      version: PRIOR_VERSION,
      packageJsonSha256: prior.priorManifestHash,
      archive: prior.priorArchive,
      archiveSha256: prior.priorFinal.sha256,
    },
    behavior: 'Requires every DSH Desktop process to be stopped, checks the post-upgrade Profile, junction, package, CLI shim, and recovery archive hashes, then uses only the official offline Desktop CLI to restore 0.1.4.',
  }
  assert(!existsSync(rollback.script), 'Refusing to overwrite an existing delegation-only rollback script: ' + rollback.script)
  const rollbackScript = renderDelegationOnlyRollback({
    current: rollback.current,
    previous: rollback.previous,
    protectedFiles,
    desktopCli: rollback.desktopCli,
  })
  writeFileSync(rollback.script, rollbackScript, 'utf8')

  const receipt = {
    installedAt: new Date().toISOString(),
    profile: PROFILE,
    packagePath: CLEAN_PACKAGE,
    version: VERSION,
    archive,
    sha256: candidate.sha256,
    initialArchiveSha256: candidate.sha256,
    backup: BACKUP,
    proof: proofPath,
    proofAssertions: proof.assertions,
    providerCalls: proof.receipt.providerCalls,
    portReleased: proof.portReleased,
    responseInterception: proof.responseInterception,
    compositionChecked,
    compositionCheck: compositionChecked
      ? 'passed via the official Desktop CLI --dump-config'
      : 'not invoked during safe resume; the resume path never calls the Desktop CLI',
    resumed,
    resumeInstallLog: resumed ? join(BACKUP, 'install-cli.log') : undefined,
    runningDesktopWasNotStopped: true,
    nextStep: 'Fully exit DSH Desktop including its tray process, then reopen it normally.',
    protectedFiles,
    rollback,
  }
  writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n', 'utf8')
  return receipt
}

function emitCompleted({ candidate, resumed }) {
  process.stdout.write(JSON.stringify({
    upgraded: 'dsh-session-conductor@' + VERSION,
    packagePath: CLEAN_PACKAGE,
    backup: BACKUP,
    receipt: RECEIPT,
    sha256: candidate.sha256,
    resumed,
    runningDesktopWasNotStopped: true,
  }, null, 2) + '\n')
}

export function installDelegationOnlyCandidate() {
  const requestedProofPath = process.env.CONDUCTOR_DELEGATION_PROOF
  const proofPath = typeof requestedProofPath === 'string' && requestedProofPath.length > 0
    ? resolve(requestedProofPath)
    : requestedProofPath
  const proof = assertProof(proofPath)
  assert(!existsSync(RECEIPT), 'Refusing to overwrite an existing delegation-only installation receipt: ' + RECEIPT)
  const candidateState = assertCandidate()

  if (existsSync(BACKUP)) {
    assertDesktopInputs({ requiresSourceCli: false })
    const saved = assertSafeResumeBackup()
    const installed = assertInstalledState(saved.before, candidateState.clean)
    writeVerifiedInstallation({
      ...candidateState,
      proof,
      proofPath,
      beforeState: saved.beforeState,
      prior: saved.prior,
      afterState: installed.afterState,
      installedModule: installed.installedModule,
      compositionChecked: false,
      resumed: true,
    })
    emitCompleted({ candidate: candidateState.candidate, resumed: true })
    return
  }

  assertDesktopInputs()
  const prior = assertPriorProfileAndPackage()
  const before = prior.profileJson
  const beforeState = profileState(before)

  mkdirSync(BACKUP, { recursive: false })
  for (const file of PROFILE_FILES) copyFileSync(join(PROFILE, file), join(BACKUP, file))
  copyFileSync(CLI_SHIM, join(BACKUP, 'desktop-cli.mjs'))

  let installedCli
  try {
    installedCli = desktopCli(['plugin', '--profile', PROFILE_NAME, 'add', '--offline', CLEAN_PACKAGE], 120_000)
  } catch (error) {
    writeFileSync(join(BACKUP, 'install-cli.log'), String(error) + '\n', 'utf8')
    throw new Error('Official Desktop CLI upgrade failed; backup retained at ' + BACKUP + '. ' + String(error))
  }
  writeFileSync(join(BACKUP, 'install-cli.log'), (installedCli.stdout ?? '') + '\n' + (installedCli.stderr ?? '') + '\n', 'utf8')

  const installed = assertInstalledState(before, candidateState.clean)
  let dump
  try {
    dump = desktopCli(['--profile', PROFILE_NAME, '--dump-config'], 30_000)
  } catch (error) {
    writeFileSync(join(BACKUP, 'dump-config.log'), String(error) + '\n', 'utf8')
    throw new Error('Desktop Profile composition failed after upgrade. ' + String(error))
  }
  writeFileSync(join(BACKUP, 'dump-config.log'), (dump.stdout ?? '') + '\n' + (dump.stderr ?? '') + '\n', 'utf8')
  assertComposition(dump.stdout ?? '', 'Desktop Profile composition')

  writeVerifiedInstallation({
    ...candidateState,
    proof,
    proofPath,
    beforeState,
    prior,
    afterState: installed.afterState,
    installedModule: installed.installedModule,
    compositionChecked: true,
    resumed: false,
  })
  emitCompleted({ candidate: candidateState.candidate, resumed: false })
}

if (process.argv[1]
  && normalizePath(fileURLToPath(import.meta.url)) === normalizePath(process.argv[1])) {
  installDelegationOnlyCandidate()
}
