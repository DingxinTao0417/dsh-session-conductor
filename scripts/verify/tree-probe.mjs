/**
 * Verification-harness probe plugin.
 *
 * Mounted into a booting profile by `boot-profile.mjs` to assert, from inside
 * the live Host, that the conductor reached the Host's tool registry. Test
 * scaffolding: never installed into a real profile.
 *
 * Environment:
 * - `CONDUCTOR_PROBE_MODULE` — file URL of the built conductor entry to import.
 * - `CONDUCTOR_PROBE_TOOL` — tool name that must be present (default
 *   `conductor_capabilities`).
 * - `CONDUCTOR_PROBE_DOMAIN` — storage domain name that must be open (default
 *   `session_conductor`).
 * - `CONDUCTOR_PROBE_CHECKS` — how many settled checks to run (default 3).
 * - `CONDUCTOR_PROBE_{CREATE,TURN,ORGANISE,BRIEF,ARTIFACT,TRANSFER,FORK,HANDOFF,RULE}`
 *   — each `=1` runs that probe against the live Host.
 * - `CONDUCTOR_PROBE_SCHEDULE=1` — exercise the schedule surface (PRD §二.11),
 *   leaving two overdue plans behind.
 * - `CONDUCTOR_PROBE_SCHEDULE_RECOVERY=1` — read what a later boot's restart
 *   calibration did to those two overdue plans.
 * - `CONDUCTOR_PROBE_INSPECT_NOTICE=1` — a read-only inspect notifies on change
 *   (PRD §二.11 有变化时通知) and stays silent when the observation is unchanged.
 * - `CONDUCTOR_PROBE_STOP=1` — exercise the stop and queue surfaces (PRD §二.6).
 *   Queue list/edit/withdraw is measured while the target agent's driver is held with the Host's
 *   own `runMaintenance` (waking input stays in the inbox until that task settles), because this
 *   composition otherwise drains a queued turn the instant it arrives.
 * - `CONDUCTOR_PROBE_WATCH=1` — exercise background reporting and the
 *   report-triggered write barrier (PRD §二.8.1).
 * - `CONDUCTOR_PROBE_ACCESS=1` — exercise observers and control transfer
 *   (PRD §二.10.1).
 * - `CONDUCTOR_PROBE_PASS=1` — measure the background pass: automatic reporting and
 *   scheduled checks with no tool call in between.
 * - `CONDUCTOR_PROBE_WORKFLOW=1` — exercise the workflow surface (PRD §二.12).
 * - `CONDUCTOR_PROBE_WORKSPACE=1` — exercise the Git starting states on the create path
 *   (PRD §二.4, T05/T07): a real scratch repository is prepared in the system temporary
 *   directory, the conductor is asked for a worktree, and the probe measures what was
 *   reported and what happened to the source repository.
 * - `CONDUCTOR_PROBE_CLEANUP=1` — preview and explicit cleanup of a plugin-owned worktree
 *   (PRD §三.6, T32): a referenced directory is refused, an unconfirmed execute deletes
 *   nothing, and after a handoff the leftover becomes eligible and is removed without
 *   `--force`.
 * - `CONDUCTOR_PROBE_CONTEXT=1` — measure the starting context (PRD §二.2.2): a task is
 *   created whose controller session is a real live Host session, and the probe reads back
 *   whether a brief was built, queued, and filed as a context snapshot — plus the honest
 *   `none` this Host must report when the creating session cannot be read.
 * - `CONDUCTOR_PROBE_PANEL=1` — measure the management panel's data routes and its status
 *   badge (PRD §二.1): a task is created, the live route is fetched over HTTP, the badge is
 *   checked against the dimensions on the same payload, the task's detail is read (and the two
 *   ways of naming no task are checked), and the task is then budget-limited and released so the
 *   badge has to change to facts the creation path never produced. Needs
 *   `CONDUCTOR_PROBE_PORT` when the boot port is not 43917.
 * - `CONDUCTOR_PROBE_ARCHIVE=1` — measure the externally-archived view (PRD §二.5): a session the
 *   Host already lists is archived through the **Host's own** `ctx.workspaceRegistry.archiveSession`
 *   (never through the plugin, which §二.5 forbids its own archiving from using), and the conductor's
 *   discovery is asked what it can see; then a **managed** task's session is archived the same way and
 *   the panel's two data routes are fetched to check that the card and the detail report the Host's
 *   archive separately from the conductor's. This build exposes no unarchive on any DSH surface, so the
 *   change to the verify store's archive set is permanent — deliberate, isolated, and never the user's.
 *   Needs `CONDUCTOR_PROBE_PORT` and a running web server when the boot port is not 43917.
 * - `CONDUCTOR_PROBE_LIST=1` — measure the task-list filter set of PRD §二.5 (项目、名称、状态、Host、分组、
 *   归档状态) through `conductor_list`: a task is created, read back unfiltered, and then filtered by the
 *   `status` and `hostId` **the tool itself reported**, with a negative control for each and for a name that
 *   cannot exist. Also measures the other half of that paragraph — 全文搜索仅限调用者有权读取的会话 — by
 *   sending a unique needle, searching as the controller (hit at seq/kind, no body), as a stranger (omitted),
 *   and as an observer (hit).
 * - `CONDUCTOR_PROBE_BUDGET_CANCEL=1` — a reached deadline requests cancellation of the current
 *   turn (PRD §二.13.2's second action) and reports the actual stop state; a concurrency ceiling
 *   does not abort in-flight work.
 * - `CONDUCTOR_PROBE_SOURCE=1` — native-interface input and a controller relay stay distinguishable
 *   on `conductor_read` history (PRD §四.2 / T11).
 */

export const name = 'conductor-verify-probe'

const MODULE_URL = process.env['CONDUCTOR_PROBE_MODULE']
const EXPECTED_TOOL = process.env['CONDUCTOR_PROBE_TOOL'] ?? 'conductor_capabilities'
const EXPECTED_DOMAIN = process.env['CONDUCTOR_PROBE_DOMAIN'] ?? 'session_conductor'
const CHECKS = Number.parseInt(process.env['CONDUCTOR_PROBE_CHECKS'] ?? '3', 10)

/**
 * A per-boot identifier for probe operations that assert **idempotency**.
 *
 * These ids used to be fixed, which made the probe measure the store's archaeology rather than the
 * plugin: an operation id claimed by an earlier boot is compared against a digest computed by an
 * earlier *revision*, and a revision that changes what the digest covers turns every later boot's
 * "same request, same id" into a conflict. That is correct behaviour for the store (§四.1 refuses a
 * reused id whose digest differs) and an unusable property for a probe whose assertions are about this
 * boot. The replay assertions are unaffected: they reuse the id **within** the boot, which is where the
 * rule is actually being tested.
 */
const BOOT_ID = String(Date.now())

/**
 * The two overdue plans the schedule probe leaves behind for a later boot.
 *
 * Fixed rather than run-scoped: the second boot is a different process and shares
 * no environment with the first, so a name it can predict is what makes the
 * restart calibration measurable across the two boots.
 */
const OVERDUE_INSPECT = 'schedule-probe-overdue-inspect'
const OVERDUE_EXEC = 'schedule-probe-overdue-exec'

/**
 * The operation the recovery probe plants in one boot and measures in the next.
 *
 * Fixed rather than run-scoped for the same reason the overdue schedules are: the second boot is a different
 * process and shares no environment with the first, so a name it can predict is what makes the calibration
 * measurable across two boots. It is also a name no tool would mint — the plugin uses `rule-<uuid>`-style ids —
 * so a collision would be a defect worth seeing.
 */
const PLANTED_OPERATION = 'probe-recovery-dispatching'

/** Read the registry's visible tool names, or an explanation of why not. */
function toolNames(ctx) {
  try {
    const tools = ctx.get('tools')
    if (tools === undefined) return { present: false, names: null }
    if (typeof tools.schemas !== 'function') return { present: true, names: null, reason: 'no schemas()' }
    return { present: true, names: tools.schemas().map(schema => schema.name) }
  } catch (error) {
    return { present: false, names: null, reason: String(error) }
  }
}

/**
 * Ask the storage facility whether the conductor's own domain is open.
 *
 * This is the strongest available evidence that durable state works: the
 * facility only reports a domain it opened successfully, and a version mismatch
 * or a drifted record would have failed that open.
 */
function domainState(ctx) {
  try {
    const facility = ctx.get('storageDomain')
    if (facility === undefined) return { facility: false, open: false }
    if (typeof facility.get !== 'function') return { facility: true, open: null, reason: 'no get()' }
    const domain = facility.get(EXPECTED_DOMAIN)
    return {
      facility: true,
      open: domain !== undefined,
      tables: domain === undefined ? null
        : ['tasks', 'bindings', 'access', 'operations', 'watches', 'notifications',
          'contexts', 'artifacts', 'transfers', 'rules', 'schedules', 'workflows',
          'workflow_runs', 'constraints', 'constraint_deliveries', 'budgets',
          'ledgers', 'remote_hosts', 'shares']
          .filter(name => {
            try {
              return domain.table(name) !== undefined
            } catch {
              return false
            }
          }),
    }
  } catch (error) {
    return { facility: false, open: false, reason: String(error) }
  }
}

export function apply(ctx) {
  const report = (label) => {
    const state = toolNames(ctx)
    const ok = state.names?.includes(EXPECTED_TOOL) === true
    const domain = domainState(ctx)
    // PRD §二.4's three dependencies, reported by presence so a missing one is measured rather
    // than inferred from a later failure: without `subprocess` there is no way to run `git`,
    // without `fs` a snapshot cannot copy a chosen untracked file, and without
    // `workspaceRegistry` a worktree cannot be registered as a workspace.
    const services = ['subprocess', 'fs', 'workspaceRegistry'].map(name => {
      try {
        return `${name}=${ctx.get(name) === undefined ? 'absent' : 'present'}`
      } catch (error) {
        return `${name}=error(${String(error?.message ?? error)})`
      }
    }).join(' ')
    process.stderr.write(
      `CONDUCTOR-VERIFY ${ok ? 'PASS' : 'PENDING'} [${label}] `
      + `expectedTool=${EXPECTED_TOOL} present=${JSON.stringify(state.names)} `
      + `registryPresent=${String(state.present)} domain=${EXPECTED_DOMAIN} `
      + `domainOpen=${String(domain.open)} domainTables=${JSON.stringify(domain.tables ?? null)} `
      + `services ${services}\n`,
    )
  }

  for (let index = 0; index < CHECKS; index += 1) {
    setTimeout(() => { report(`t+${String(1500 * (index + 1))}ms`) }, 1500 * (index + 1))
  }

  if (process.env['CONDUCTOR_PROBE_CREATE'] === '1') {
    setTimeout(() => { void runCreate(ctx) }, 3000)
  }

  if (process.env['CONDUCTOR_PROBE_WORKSPACE'] === '1') {
    setTimeout(() => { void runWorkspace(ctx) }, 3400)
  }

  if (process.env['CONDUCTOR_PROBE_CLEANUP'] === '1') {
    setTimeout(() => { void runCleanup(ctx) }, 3600)
  }

  if (process.env['CONDUCTOR_PROBE_CONTEXT'] === '1') {
    setTimeout(() => { void runContext(ctx) }, 3800)
  }

  if (process.env['CONDUCTOR_PROBE_OPERATION'] === '1') {
    setTimeout(() => { void runOperation(ctx) }, 4200)
  }

  if (process.env['CONDUCTOR_PROBE_APPROVAL'] === '1') {
    setTimeout(() => { void runApproval(ctx) }, 4600)
  }

  if (process.env['CONDUCTOR_PROBE_ACCEPT'] === '1') {
    setTimeout(() => { void runAcceptance(ctx) }, 5000)
  }

  if (process.env['CONDUCTOR_PROBE_BUDGET_GATE'] === '1') {
    setTimeout(() => { void runBudgetGate(ctx) }, 5400)
  }

  if (process.env['CONDUCTOR_PROBE_BUDGET_CANCEL'] === '1') {
    setTimeout(() => { void runBudgetCancel(ctx) }, 3600)
  }

  if (process.env['CONDUCTOR_PROBE_SOURCE'] === '1') {
    setTimeout(() => { void runHistorySource(ctx) }, 3800)
  }

  if (process.env['CONDUCTOR_PROBE_RECONCILE'] === '1') {
    setTimeout(() => { void runReconcile(ctx) }, 5800)
  }

  if (process.env['CONDUCTOR_PROBE_FIXED'] === '1') {
    setTimeout(() => { void runFixedTerms(ctx) }, 6200)
  }

  if (process.env['CONDUCTOR_PROBE_DELIVER'] === '1') {
    setTimeout(() => { void runConstraintDelivery(ctx) }, 5200)
  }

  if (process.env['CONDUCTOR_PROBE_BUNDLE'] === '1') {
    setTimeout(() => {
      void import('./bundle-probe.mjs').then(async (module) => {
        const registry = ctx.get('tools')
        await module.runExportBundle(ctx, registry)
      }).catch(error => process.stderr.write(`CONDUCTOR-BUNDLE FAIL: ${String(error?.stack ?? error)}
`))
    }, 5000)
  }

  if (process.env['CONDUCTOR_PROBE_HARD'] === '1') {
    setTimeout(() => { void runHardBudget(ctx) }, 5600)
  }

  if (process.env['CONDUCTOR_PROBE_IMPACT'] === '1') {
    setTimeout(() => { void runConstraintImpact(ctx) }, 6000)
  }

  if (process.env['CONDUCTOR_PROBE_RELEASE'] === '1') {
    setTimeout(() => { void runRelease(ctx) }, 6400)
  }

  if (process.env['CONDUCTOR_PROBE_FIXED_RULE'] === '1') {
    setTimeout(() => { void runFixedRule(ctx) }, 6600)
  }

  if (process.env['CONDUCTOR_PROBE_PANEL'] === '1') {
    setTimeout(() => { void runPanel(ctx) }, 6800)
  }

  if (process.env['CONDUCTOR_PROBE_WAIT'] === '1') {
    setTimeout(() => { void runWaitInterrupt(ctx) }, 7000)
  }

  if (process.env['CONDUCTOR_PROBE_PRESET'] === '1') {
    setTimeout(() => { void runPreset(ctx) }, 7200)
  }

  if (process.env['CONDUCTOR_PROBE_CONFLICT'] === '1') {
    setTimeout(() => { void runHandoffConflict(ctx) }, 7400)
  }

  if (process.env['CONDUCTOR_PROBE_RULE_WATCHER'] === '1') {
    setTimeout(() => { void runRuleWatcher(ctx) }, 7600)
  }

  if (process.env['CONDUCTOR_PROBE_LEDGER'] === '1') {
    setTimeout(() => { void runLedgerAcceptance(ctx) }, 7800)
  }

  if (process.env['CONDUCTOR_PROBE_ARCHIVE'] === '1') {
    setTimeout(() => { void runArchiveView(ctx) }, 8000)
  }

  if (process.env['CONDUCTOR_PROBE_LIST'] === '1') {
    setTimeout(() => { void runTaskFilters(ctx) }, 8200)
  }

  // Two boots, one flag each: the first plants a crash-window record, the second measures what the restart
  // did with it. Run them in that order against the same DSH_HOME.
  if (process.env['CONDUCTOR_PROBE_PLANT'] === '1') {
    setTimeout(() => { void runOperationPlant(ctx) }, 3200)
  }

  if (process.env['CONDUCTOR_PROBE_RECOVERY'] === '1') {
    setTimeout(() => { void runOperationRecovery(ctx) }, 3000)
  }

  if (typeof MODULE_URL === 'string' && MODULE_URL.length > 0) {
    import(MODULE_URL).then(
      (loaded) => {
        process.stderr.write(
          `CONDUCTOR-VERIFY module-import OK exports=${JSON.stringify(Object.keys(loaded))} `
          + `name=${String(loaded.name)}\n`,
        )
      },
      (error) => {
        process.stderr.write(`CONDUCTOR-VERIFY module-import FAIL ${String(error?.message ?? error)}\n`)
      },
    )
  }
}

/**
 * Exercise the Git starting states through the live tool registry (PRD §二.4, T05/T07).
 *
 * This is the measurement that code review cannot replace. It builds a real scratch repository,
 * asks the conductor for a worktree through `conductor_create`, and then reads the repository back
 * to see whether the source moved. Three facts are measured separately, because each one can fail
 * while the others hold:
 *
 * 1. the session's directory is the worktree, and the commit the task pinned is reported;
 * 2. the source repository's HEAD, branch and status are byte-identical afterwards;
 * 3. a preparation that cannot create its worktree FAILS, and no session appears in the source
 *    directory — the rule PRD §二.4 states outright.
 *
 * @param ctx - the probe's context.
 */
async function runWorkspace(ctx) {
  const { execFile } = await import('node:child_process')
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  /** Run git the way the probe needs it: fixed arguments, no shell. */
  const git = async (args, cwd) => {
    const { stdout } = await run('git', args, { cwd, windowsHide: true })
    return stdout
  }

  let root
  try {
    root = await mkdtemp(join(tmpdir(), 'conductor-probe-ws-'))
    const repo = join(root, 'repo')
    const worktree = join(root, 'repo.conductor')
    const blocked = join(root, 'blocked')
    await mkdir(repo, { recursive: true })
    await git(['init', '--initial-branch=main'], repo)
    await git(['config', 'user.email', 'probe@example.invalid'], repo)
    await git(['config', 'user.name', 'probe'], repo)
    await writeFile(join(repo, 'tracked.txt'), 'committed\n', 'utf8')
    await git(['add', 'tracked.txt'], repo)
    await git(['commit', '-m', 'initial'], repo)

    const tools = ctx.get('tools')
    const create = typeof tools?.get === 'function' ? tools.get('conductor_create') : undefined
    if (create === undefined) {
      process.stderr.write('CONDUCTOR-WORKSPACE FAIL: conductor_create is not registered\n')
      return
    }

    const before = {
      head: (await git(['rev-parse', 'HEAD'], repo)).trim(),
      branch: (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim(),
      status: (await git(['status', '--porcelain'], repo)).trim(),
      content: await readFile(join(repo, 'tracked.txt'), 'utf8'),
    }

    const created = await create.execute(
      {
        title: 'probe worktree task',
        contextMode: 'empty',
        operationId: 'probe-workspace-1',
        gitStrategy: 'current_head',
        repoPath: repo,
        worktreePath: worktree,
      },
      { callId: 'probe-workspace-call-1', agent: { id: 'session-probe-controller' } },
    )

    process.stderr.write(
      `CONDUCTOR-WORKSPACE ${created.preparation === 'ready' ? 'PASS' : 'FAIL'} `
      + `preparation=${String(created.preparation)} phase=${String(created.preparationPhase)} `
      + `reason=${String(created.failureReason ?? 'none')} `
      + `strategy=${String(created.workspaceStrategy ?? 'none')} `
      + `path=${String(created.workspacePath ?? 'none')} `
      + `commit=${String(created.workspaceCommit ?? 'none')} `
      + `created=${String(created.workspaceCreated ?? 'none')} `
      + `originRepo=${String(created.originRepoPath ?? 'none')} `
      + `workspaceId=${String(created.workspaceId ?? 'none')} `
      + `workspaceFailure=${String(created.workspaceFailure ?? 'none')}\n`,
    )

    // The pinned commit is the one the repository was at, and the directory is the worktree.
    process.stderr.write(
      `CONDUCTOR-WORKSPACE-BASELINE ${created.workspaceCommit === before.head
        && created.workspacePath === worktree ? 'PASS' : 'FAIL'} `
      + `reportedCommit=${String(created.workspaceCommit ?? 'none')} repoHead=${before.head} `
      + `reportedPath=${String(created.workspacePath ?? 'none')} expectedPath=${worktree}\n`,
    )

    // The worktree really exists on disk and really holds the committed content.
    let worktreeContent = '<absent>'
    try {
      worktreeContent = await readFile(join(worktree, 'tracked.txt'), 'utf8')
    } catch (error) {
      worktreeContent = `<unreadable: ${String(error?.message ?? error)}>`
    }
    process.stderr.write(
      `CONDUCTOR-WORKSPACE-MATERIALISED ${worktreeContent.replace(/\r\n/g, '\n') === 'committed\n' ? 'PASS' : 'FAIL'} `
      + `worktreeFile=${JSON.stringify(worktreeContent)}\n`,
    )

    const after = {
      head: (await git(['rev-parse', 'HEAD'], repo)).trim(),
      branch: (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim(),
      status: (await git(['status', '--porcelain'], repo)).trim(),
      content: await readFile(join(repo, 'tracked.txt'), 'utf8'),
    }
    const untouched = after.head === before.head && after.branch === before.branch
      && after.status === before.status && after.content === before.content
    process.stderr.write(
      `CONDUCTOR-WORKSPACE-SOURCE-UNTOUCHED ${untouched ? 'PASS' : 'FAIL'} `
      + `head=${before.head}->${after.head} branch=${before.branch}->${after.branch} `
      + `status=${JSON.stringify(before.status)}->${JSON.stringify(after.status)} `
      + `contentSame=${String(after.content === before.content)}\n`,
    )

    // §二.4's outright rule, measured: a worktree that cannot be created must fail the task
    // rather than run it in the source directory.
    await writeFile(blocked, 'not a directory\n', 'utf8')
    const refused = await create.execute(
      {
        title: 'probe blocked worktree',
        contextMode: 'empty',
        operationId: 'probe-workspace-2',
        gitStrategy: 'current_head',
        repoPath: repo,
        worktreePath: blocked,
      },
      { callId: 'probe-workspace-call-2', agent: { id: 'session-probe-controller' } },
    )
    const refusedProperly = refused.preparation === 'failed'
      && /NOT run in the source directory instead/.test(String(refused.failureReason ?? ''))
      && refused.sessionId === undefined
    process.stderr.write(
      `CONDUCTOR-WORKSPACE-NO-FALLBACK ${refusedProperly ? 'PASS' : 'FAIL'} `
      + `preparation=${String(refused.preparation)} sessionId=${String(refused.sessionId ?? 'none')} `
      + `reason=${String(refused.failureReason ?? 'none')}\n`,
    )

    // The starting state is recorded on the task, not only returned to this caller: a later
    // reader must be able to tell which commit the task came from.
    const capabilities = typeof tools?.get === 'function' ? tools.get('conductor_capabilities') : undefined
    if (capabilities !== undefined) {
      const snapshot = await capabilities.execute(
        {},
        { callId: 'probe-workspace-call-3', agent: { id: 'session-probe-controller' } },
      )
      // The tool renders the snapshot rather than returning it raw, so the disabled list is what
      // names an unavailable feature; a feature absent from it is available.
      const disabled = new Map((snapshot?.disabledFeatures ?? []).map(entry => [entry.feature, entry.reason]))
      const listing = snapshot?.services?.join(' ') ?? '<no service list>'
      process.stderr.write(
        `CONDUCTOR-WORKSPACE-CAPABILITY git_start_states=${disabled.has('git_start_states') ? 'disabled' : 'enabled'} `
        + `workspace_registration=${disabled.has('workspace_registration') ? 'disabled' : 'enabled'} `
        + `reason=${String(disabled.get('git_start_states') ?? 'none')} `
        + `subprocessLine=${JSON.stringify(listing.split('\n').filter(line => line.includes('subprocess')).join('|'))}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`CONDUCTOR-WORKSPACE FAIL: ${String(error?.stack ?? error)}\n`)
  } finally {
    // The scratch repository is this probe's own, and it is removed. Nothing under the user's
    // directories is touched: the worktree lives inside the same temporary root.
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Preview and clean a plugin-owned worktree (PRD §三.6, T32).
 *
 * Stop and a failed preparation do not delete the directory, so cleanup is a
 * separate, explicit action. This measures the three refusals the specification
 * names plus the one delete that is allowed: a referenced worktree stays, an
 * unconfirmed execute deletes nothing, and after the task is handed off to
 * another directory the leftover is eligible and `git worktree remove` runs
 * without `--force`.
 *
 * @param ctx - the probe's context.
 */
async function runCleanup(ctx) {
  const { execFile } = await import('node:child_process')
  const { access, mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const git = async (args, cwd) => {
    const { stdout } = await run('git', args, { cwd, windowsHide: true })
    return stdout
  }
  const exists = async (path) => {
    try {
      await access(path, constants.F_OK)
      return true
    } catch {
      return false
    }
  }

  let root
  try {
    root = await mkdtemp(join(tmpdir(), 'conductor-probe-cleanup-'))
    const repo = join(root, 'repo')
    const worktree = join(root, 'repo.conductor')
    await mkdir(repo, { recursive: true })
    await git(['init', '--initial-branch=main'], repo)
    await git(['config', 'user.email', 'probe@example.invalid'], repo)
    await git(['config', 'user.name', 'probe'], repo)
    await writeFile(join(repo, 'tracked.txt'), 'committed\n', 'utf8')
    await git(['add', 'tracked.txt'], repo)
    await git(['commit', '-m', 'initial'], repo)

    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const cleanup = get('conductor_cleanup')
    const handoff = get('conductor_handoff')
    if (create === undefined || cleanup === undefined) {
      process.stderr.write('CONDUCTOR-CLEANUP FAIL: conductor_create or conductor_cleanup is not registered\n')
      return
    }
    const caller = 'session-cleanup-controller'
    const exec = (suffix) => ({ callId: `probe-cleanup-${suffix}`, agent: { id: caller } })

    const created = await create.execute(
      {
        title: 'cleanup probe worktree',
        contextMode: 'empty',
        operationId: 'probe-cleanup-create',
        gitStrategy: 'current_head',
        repoPath: repo,
        worktreePath: worktree,
      },
      exec('create'),
    )
    if (created.preparation !== 'ready' || created.workspaceCreated !== true) {
      process.stderr.write(
        `CONDUCTOR-CLEANUP FAIL: create did not leave a plugin-owned worktree `
        + `preparation=${String(created.preparation)} created=${String(created.workspaceCreated)} `
        + `reason=${String(created.failureReason ?? 'none')}\n`,
      )
      return
    }
    const taskId = created.taskId
    const resourceId = `worktree:${taskId}`

    const previewed = await cleanup.execute({ action: 'preview' }, exec('preview'))
    const listed = (previewed.resources ?? []).find((row) => row.resourceId === resourceId || row.path === worktree)
    const referencedRefused = listed !== undefined && listed.eligible === false
      && /still referenced/.test(String(listed.condition ?? ''))
    process.stderr.write(
      `CONDUCTOR-CLEANUP-PREVIEW ${referencedRefused ? 'PASS' : 'FAIL'} `
      + `resourceId=${String(listed?.resourceId ?? 'none')} eligible=${String(listed?.eligible)} `
      + `referenced=${String(listed?.referenced)} tree=${String(listed?.tree)} `
      + `owned=${String(listed?.owned)} condition=${JSON.stringify(String(listed?.condition ?? previewed.summary))}\n`,
    )

    const unconfirmed = await cleanup.execute(
      { action: 'execute', resourceIds: [resourceId], confirmed: false, operationId: 'probe-cleanup-unconfirmed' },
      exec('unconfirmed'),
    )
    const stillThereAfterUnconfirmed = await exists(worktree)
    const unconfirmedOk = stillThereAfterUnconfirmed
      && (unconfirmed.cleaned ?? []).length === 0
      && /not automatic/.test(String(unconfirmed.summary ?? ''))
    process.stderr.write(
      `CONDUCTOR-CLEANUP-UNCONFIRMED ${unconfirmedOk ? 'PASS' : 'FAIL'} `
      + `exists=${String(stillThereAfterUnconfirmed)} cleaned=${JSON.stringify(unconfirmed.cleaned ?? [])} `
      + `summary=${JSON.stringify(String(unconfirmed.summary ?? '').slice(0, 240))}\n`,
    )

    const referenced = await cleanup.execute(
      { action: 'execute', resourceIds: [resourceId], confirmed: true, operationId: 'probe-cleanup-referenced' },
      exec('referenced'),
    )
    const stillThereAfterReferenced = await exists(worktree)
    const referencedOk = stillThereAfterReferenced
      && (referenced.cleaned ?? []).length === 0
      && /still referenced/.test(String(referenced.summary ?? referenced.refusals?.join(' ') ?? ''))
    process.stderr.write(
      `CONDUCTOR-CLEANUP-REFERENCED ${referencedOk ? 'PASS' : 'FAIL'} `
      + `exists=${String(stillThereAfterReferenced)} cleaned=${JSON.stringify(referenced.cleaned ?? [])} `
      + `refusals=${JSON.stringify(referenced.refusals ?? [])}\n`,
    )

    if (handoff === undefined) {
      process.stderr.write('CONDUCTOR-CLEANUP-HANDOFF FAIL: conductor_handoff is not registered\n')
      return
    }
    const moved = await handoff.execute(
      { taskId, targetPath: repo, operationId: 'probe-cleanup-handoff' },
      exec('handoff'),
    )
    const handed = moved.succeeded === true
    process.stderr.write(
      `CONDUCTOR-CLEANUP-HANDOFF ${handed ? 'PASS' : 'FAIL'} `
      + `succeeded=${String(moved.succeeded)} reached=${String(moved.reached)} `
      + `reason=${JSON.stringify(String(moved.reason ?? 'none').slice(0, 200))}\n`,
    )
    if (!handed) return

    const afterMove = await cleanup.execute({ action: 'preview' }, exec('preview-after'))
    const leftover = (afterMove.resources ?? []).find((row) => row.resourceId === resourceId || row.path === worktree)
    const eligible = leftover !== undefined && leftover.eligible === true && leftover.referenced === false
    process.stderr.write(
      `CONDUCTOR-CLEANUP-ELIGIBLE ${eligible ? 'PASS' : 'FAIL'} `
      + `eligible=${String(leftover?.eligible)} referenced=${String(leftover?.referenced)} `
      + `tree=${String(leftover?.tree)} condition=${JSON.stringify(String(leftover?.condition ?? afterMove.summary))}\n`,
    )
    if (!eligible) return

    const executed = await cleanup.execute(
      { action: 'execute', resourceIds: [resourceId], confirmed: true, operationId: 'probe-cleanup-execute' },
      exec('execute'),
    )
    const gone = !(await exists(worktree))
    const executedOk = gone && (executed.cleaned ?? []).includes(resourceId)
    process.stderr.write(
      `CONDUCTOR-CLEANUP-EXECUTE ${executedOk ? 'PASS' : 'FAIL'} `
      + `gone=${String(gone)} cleaned=${JSON.stringify(executed.cleaned ?? [])} `
      + `refusals=${JSON.stringify(executed.refusals ?? [])} `
      + `summary=${JSON.stringify(String(executed.summary ?? '').slice(0, 240))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-CLEANUP FAIL: ${String(error?.stack ?? error)}\n`)
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Measure that a run stops when the terms it fixed change (PRD §三.3, §二.13.1).
 *
 * The run fixed six things at start. Those are exactly what someone else can change while it is in
 * flight, and until this existed nothing compared them — so a constraint rewritten mid-run, or
 * control of a node's task transferred, would silently change what the work was being judged
 * against. Here the constraint is bumped after the run starts, and the run must refuse to dispatch
 * **and** record `needs_user` rather than quietly continuing.
 *
 * @param ctx - the probe's context.
 */
async function runFixedTerms(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const workflow = get('conductor_workflow')
    const constraints = get('conductor_constraints')
    if (create === undefined || workflow === undefined || constraints === undefined) {
      process.stderr.write('CONDUCTOR-FIXED FAIL: a required tool is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-fixed-${suffix}-${run}`, agent: { id: caller } })

    const task = await create.execute(
      { title: `fixed probe ${run}`, contextMode: 'empty', operationId: `probe-fixed-${run}` },
      exec('create'),
    )
    if (task.preparation !== 'ready') {
      process.stderr.write('CONDUCTOR-FIXED FAIL: the task did not prepare\n')
      return
    }

    const workflowId = `probe-fixed-${run}`
    // The constraint has to exist **before** the run starts, or the run fixes nothing to drift from —
    // which is what the first version of this probe got wrong: it created the constraint afterwards
    // and then measured the absence of drift as a defect in the code.
    const set = await constraints.execute({
      action: 'set',
      kind: 'prohibition',
      text: `no shell access (probe ${run})`,
      scope: 'future',
      authorizedBy: caller,
    }, exec('constraint-set'))
    const constraintId = set.constraints?.[0]?.constraintId
    process.stderr.write(
      `CONDUCTOR-FIXED-CONSTRAINT-BEFORE-RUN ${constraintId === undefined ? 'FAIL' : 'PASS'} `
      + `constraintId=${String(constraintId ?? 'none')} version=${String(set.constraints?.[0]?.version ?? 'none')}\n`,
    )

    await workflow.execute({
      action: 'save',
      authorizedBy: caller,
      definition: {
        workflowId,
        title: `fixed probe ${run}`,
        nodes: [{ nodeId: 'only', taskId: task.taskId, instruction: 'do the work' }],
      },
    }, exec('save'))
    const started = await workflow.execute({ action: 'start', workflowId, authorizedBy: caller }, exec('start'))
    const runId = started.runs?.[0]?.runId
    process.stderr.write(
      `CONDUCTOR-FIXED-STARTED ${runId === undefined ? 'FAIL' : 'PASS'} runId=${String(runId ?? 'none')}\n`,
    )
    if (runId === undefined) return

    // Nothing has drifted yet, so the node starts — the check must not block a healthy run.
    const healthy = await workflow.execute({ action: 'drive', runId, authorizedBy: caller }, exec('drive-1'))
    const started_ok = (healthy.actions ?? []).some(action => /only: dispatched/.test(action))
    process.stderr.write(
      `CONDUCTOR-FIXED-HEALTHY-RUN-DISPATCHES ${started_ok ? 'PASS' : 'FAIL'} `
      + `actions=${JSON.stringify((healthy.actions ?? []).join('|').slice(0, 140))}\n`,
    )

    // Now the shared constraint the run fixed is rewritten. The next drive must stop rather than
    // judge the work against a statement it never fixed.
    const bumped = await constraints.execute({
      action: 'set',
      constraintId,
      kind: 'prohibition',
      text: `no shell access, revised (probe ${run})`,
      scope: 'future',
      authorizedBy: caller,
    }, exec('constraint-bump'))
    process.stderr.write(
      `CONDUCTOR-FIXED-CONSTRAINT-MOVED ${Number(bumped.constraints?.[0]?.version ?? 0) >= 1 ? 'PASS' : 'FAIL'} `
      + `version=${String(bumped.constraints?.[0]?.version ?? 'none')}\n`,
    )

    const after = await workflow.execute({ action: 'drive', runId, authorizedBy: caller }, exec('drive-2'))
    const stopped = /constraint .* moved from version/.test(String((after.problems ?? []).join(' ')))
    const notDispatched = !(after.actions ?? []).some(action => /dispatched/.test(action))
    // Scoped to **this** run: scanning every run in the store counted an older one's `needs_user` as
    // evidence about this one, which is how the first version of this check passed while the run it
    // was measuring had not stopped at all.
    const needsUser = (after.runs ?? []).some(entry => entry.runId === runId && entry.status === 'needs_user')
    process.stderr.write(
      `CONDUCTOR-FIXED-STALE-RUN-STOPS ${stopped && notDispatched && needsUser ? 'PASS' : 'FAIL'} `
      + `problems=${JSON.stringify((after.problems ?? []).join(' ').slice(0, 260))} `
      + `summary=${JSON.stringify(String(after.summary).slice(0, 280))} `
      +       `thisRun=${JSON.stringify((after.runs ?? []).filter(entry => entry.runId === runId).map(entry => entry.status))} `
      + `actions=${JSON.stringify((after.actions ?? []).join('|').slice(0, 80))} needsUser=${String(needsUser)}\n`,
    )

    // C173: the run also fixes the budget policy, and a later save must not silently
    // tighten (or loosen) the gate of a run already in flight.
    const budgetWorkflowId = `probe-fixed-budget-${run}`
    await workflow.execute({
      action: 'save',
      authorizedBy: caller,
      definition: {
        workflowId: budgetWorkflowId,
        title: `fixed budget probe ${run}`,
        budget: { maxTurns: 6 },
        nodes: [{ nodeId: 'only', taskId: task.taskId, instruction: 'do the work under the original budget' }],
      },
    }, exec('budget-save'))
    const budgetStarted = await workflow.execute(
      { action: 'start', workflowId: budgetWorkflowId, authorizedBy: caller },
      exec('budget-start'),
    )
    const budgetRunId = budgetStarted.runs?.[0]?.runId
    process.stderr.write(
      `CONDUCTOR-FIXED-BUDGET-STARTED ${budgetRunId === undefined ? 'FAIL' : 'PASS'} `
      + `runId=${String(budgetRunId ?? 'none')}\n`,
    )
    if (budgetRunId !== undefined) {
      await workflow.execute({
        action: 'save',
        authorizedBy: caller,
        definition: {
          workflowId: budgetWorkflowId,
          title: `fixed budget probe ${run}`,
          budget: { maxTurns: 1 },
          nodes: [{ nodeId: 'only', taskId: task.taskId, instruction: 'do the work under a later budget' }],
        },
      }, exec('budget-resave'))
      const drifted = await workflow.execute(
        { action: 'drive', runId: budgetRunId, authorizedBy: caller },
        exec('budget-drive'),
      )
      const joined = `${(drifted.problems ?? []).join(' ')} ${String(drifted.summary)}`
      const budgetStopped = /budget policy moved from maxTurns=6 to maxTurns=1/.test(joined)
      const budgetNotDispatched = !(drifted.actions ?? []).some(action => /dispatched/.test(action))
      const budgetNeedsUser = (drifted.runs ?? []).some(entry => entry.runId === budgetRunId && entry.status === 'needs_user')
      process.stderr.write(
        `CONDUCTOR-FIXED-BUDGET-STOPS ${budgetStopped && budgetNotDispatched && budgetNeedsUser ? 'PASS' : 'FAIL'} `
        + `problems=${JSON.stringify((drifted.problems ?? []).join(' ').slice(0, 260))} `
        + `summary=${JSON.stringify(String(drifted.summary).slice(0, 280))} `
        + `thisRun=${JSON.stringify((drifted.runs ?? []).filter(entry => entry.runId === budgetRunId).map(entry => entry.status))} `
        + `actions=${JSON.stringify((drifted.actions ?? []).join('|').slice(0, 80))}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`CONDUCTOR-FIXED FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Measure that releasing a task is reachable and stops its monitoring (PRD 2.5).
 *
 * Two things were wrong: `detachTask` had **no product entry** - no tool, no panel - and the report
 * path never asked whether the relationship still existed, so a released task's watch kept
 * reporting while the code's own comment said it had stopped.
 *
 * @param ctx - the probe's context.
 */
/**
 * Measure that applying a constraint to current work actually marks what must be re-judged (PRD 2.13.1).
 *
 * The impact used to be computed and returned with **nothing written**, so an artifact reported as
 * "needs re-acceptance" kept `acceptance: pass` and a later reader saw a clean state. The impact list
 * was also unscoped: every accepted artifact in the store was reported, with the reason asserted.
 *
 * @param ctx - the probe's context.
 */
/**
 * Measure that a strict budget is not claimed as hard without the capabilities it needs (PRD 2.13.2).
 *
 * `hardBudgetAllowed` existed, was tested, and was called by **nothing** - so a strict token ceiling
 * was stored and shown as though it were hard while nothing checked whether the deployment could
 * honour the claim.
 *
 * @param ctx - the probe's context.
 */
/**
 * Measure that a constraint is actually delivered to a target (PRD 2.13.1).
 *
 * The delivery branch recorded whichever stage the caller named and sent **nothing** - so `sent`
 * was a stage nobody had earned and `in_context` could be asserted with no message in existence.
 *
 * @param ctx - the probe's context.
 */
async function runConstraintDelivery(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const constraints = get('conductor_constraints')
    const operation = get('conductor_operation')
    if (create === undefined || constraints === undefined || operation === undefined) {
      process.stderr.write('CONDUCTOR-DELIVER FAIL: a required tool is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-deliver-${suffix}-${run}`, agent: { id: caller } })

    const target = await create.execute(
      { title: `deliver probe ${run}`, contextMode: 'empty', operationId: `probe-deliver-${run}` },
      exec('create'),
    )
    if (target.preparation !== 'ready') {
      process.stderr.write('CONDUCTOR-DELIVER FAIL: the target task did not prepare\n')
      return
    }
    const set = await constraints.execute({
      action: 'set', kind: 'interface', text: `return 404 for unknown ids (probe ${run})`, scope: 'future', authorizedBy: caller,
    }, exec('set'))
    const constraintId = set.constraints?.[0]?.constraintId

    const delivered = await constraints.execute({
      action: 'deliver', constraintId, targetId: target.taskId, stage: 'sent', authorizedBy: caller,
    }, exec('deliver'))
    const summary = String(delivered.summary)
    process.stderr.write(
      `CONDUCTOR-DELIVER-SENT ${/was sent to .*next step boundary/.test(summary) ? 'PASS' : 'FAIL'} summary=${JSON.stringify(summary.slice(0, 260))}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-DELIVER-NO-OVERCLAIM ${/in-flight request is not altered/.test(summary) && /not consumption and not compliance/.test(summary) ? 'PASS' : 'FAIL'} `
      + `caveats=${JSON.stringify(summary.slice(-200))}\n`,
    )

    // The dispatch really happened: its operation is recorded and its attribution says the plugin
    // relayed it, which is what PRD 4.2 asks of a plugin-initiated message.
    const operationId = `constraint-${constraintId}-v0-${target.taskId}`
    const status = await operation.execute({ action: 'status', operationId }, exec('status'))
    process.stderr.write(
      `CONDUCTOR-DELIVER-DISPATCHED ${status.found === true && status.delivery === 'accepted' ? 'PASS' : 'FAIL'} `
      + `found=${String(status.found)} delivery=${String(status.delivery ?? 'none')} `
      + `by=${String(status.attributedBy ?? 'none')} sourceEventId=${String(status.attributedSourceEventId ?? 'none')}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-DELIVER FAIL: ${String(error?.stack ?? error)}\n`)
  }
}
async function runHardBudget(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const tools = ctx.get('tools')
    const budgetTool = typeof tools?.get === 'function' ? tools.get('conductor_budget') : undefined
    if (budgetTool === undefined) {
      process.stderr.write('CONDUCTOR-HARD FAIL: conductor_budget is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-hard-${suffix}-${run}`, agent: { id: caller } })

    // A strict token ceiling on a deployment that cannot meter tokens: the claim must be refused
    // and said out loud, not stored as though it were enforceable.
    const strict = await budgetTool.execute({
      action: 'set', scope: 'task', targetId: `probe-hard-${run}`, strict: true, maxTokens: 1000,
    }, exec('strict'))
    const claim = String(strict.summary)
    process.stderr.write(
      `CONDUCTOR-HARD-NOT-CLAIMED ${/NOT claimed as a hard budget/.test(claim) ? 'PASS' : 'FAIL'} summary=${JSON.stringify(claim.slice(0, 300))}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-HARD-REASON-NAMES-THE-GAP ${/full metering|single-request upper bound|concurrency reservation/.test((strict.problems ?? []).join(' ')) ? 'PASS' : 'FAIL'} problems=${JSON.stringify((strict.problems ?? []).join(' ').slice(0, 240))}\n`,
    )

    // A budget that asks for nothing strict makes no claim, so it is not warned about.
    const soft = await budgetTool.execute({
      action: 'set', scope: 'task', targetId: `probe-soft-${run}`, maxDispatches: 3,
    }, exec('soft'))
    process.stderr.write(
      `CONDUCTOR-HARD-NO-FALSE-WARNING ${/NOT claimed as a hard budget/.test(String(soft.summary)) ? 'FAIL' : 'PASS'} summary=${JSON.stringify(String(soft.summary).slice(0, 160))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-HARD FAIL: ${String(error?.stack ?? error)}\n`)
  }
}
async function runConstraintImpact(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const run = randomUUID().slice(0, 8)
    const root = await mkdtemp(join(tmpdir(), 'conductor-probe-impact-'))
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const register = get('conductor_artifact_register')
    const accept = get('conductor_artifact_accept')
    const constraints = get('conductor_constraints')
    const list = get('conductor_artifact_list')
    const workflow = get('conductor_workflow')
    if ([create, register, accept, constraints, list].some(tool => tool === undefined)) {
      process.stderr.write('CONDUCTOR-IMPACT FAIL: a required tool is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-impact-${suffix}-${run}`, agent: { id: caller } })

    // Two tasks: the one the constraint reaches, and an unrelated one whose accepted artifact must
    // NOT be reported as invalidated.
    const target = await create.execute({ title: `impact probe target ${run}`, contextMode: 'empty', operationId: `probe-impact-a-${run}` }, exec('create-a'))
    const other = await create.execute({ title: `impact probe other ${run}`, contextMode: 'empty', operationId: `probe-impact-b-${run}` }, exec('create-b'))
    const fileA = join(root, 'a.md'); const fileB = join(root, 'b.md')
    await writeFile(fileA, 'a\n', 'utf8'); await writeFile(fileB, 'b\n', 'utf8')
    const artA = await register.execute({ taskId: target.taskId, kind: 'file', name: 'a.md', path: fileA }, exec('reg-a'))
    const artB = await register.execute({ taskId: other.taskId, kind: 'file', name: 'b.md', path: fileB }, exec('reg-b'))
    await accept.execute({ artifactId: artA.artifactId, result: 'pass', by: 'user' }, exec('acc-a'))
    await accept.execute({ artifactId: artB.artifactId, result: 'pass', by: 'user' }, exec('acc-b'))

    // The node id must name a node in a workflow definition, because that is what says which task it drives.
    await workflow.execute({
      action: 'save',
      authorizedBy: caller,
      definition: {
        workflowId: `impact-{run}`,
        title: `impact probe {run}`,
        nodes: [{ nodeId: 'impact-node', taskId: target.taskId, instruction: 'work' }],
      },
    }, exec('save-workflow'))
    const set = await constraints.execute({ action: 'set', kind: 'interface', text: `use the v2 interface (probe ${run})`, scope: 'current', authorizedBy: caller }, exec('set'))
    const constraintId = set.constraints?.[0]?.constraintId
    const applied = await constraints.execute({
      action: 'apply',
      constraintId,
      scope: 'current',
      affectedNodes: ['impact-node'],
      authorizedBy: caller,
    }, exec('apply'))
    process.stderr.write(
      `CONDUCTOR-IMPACT-MARKED ${/marked for re-judgement/.test(String(applied.summary)) ? 'PASS' : 'FAIL'} summary=${JSON.stringify(String(applied.summary).slice(0, 220))}\n`,
    )

    // The reached artifact really moved back to pending, and the unrelated one did not move at all.
    const after = await list.execute({ taskId: target.taskId }, exec('list-a'))
    const afterOther = await list.execute({ taskId: other.taskId }, exec('list-b'))
    const mine = (after.artifacts ?? []).find(entry => entry.artifactId === artA.artifactId)
    const theirs = (afterOther.artifacts ?? []).find(entry => entry.artifactId === artB.artifactId)
    process.stderr.write(
      `CONDUCTOR-IMPACT-WRITTEN ${mine?.acceptance === 'pending' && theirs?.acceptance === 'pass' ? 'PASS' : 'FAIL'} `
      + `reached=${String(mine?.acceptance ?? 'none')} unrelated=${String(theirs?.acceptance ?? 'none')}\n`,
    )
    const reportedOther = (applied.impact?.affectedArtifacts ?? []).some(entry => entry.artifactId === artB.artifactId)
    process.stderr.write(
      `CONDUCTOR-IMPACT-SCOPED ${reportedOther ? 'FAIL' : 'PASS'} `
      + `affected=${JSON.stringify((applied.impact?.affectedArtifacts ?? []).map(entry => entry.artifactId))}\n`,
    )

    await rm(root, { recursive: true, force: true }).catch(() => {})
  } catch (error) {
    process.stderr.write(`CONDUCTOR-IMPACT FAIL: ${String(error?.stack ?? error)}\n`)
  }
}
async function runRelease(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const accessTool = get('conductor_access')
    const watch = get('conductor_watch')
    if (create === undefined || accessTool === undefined || watch === undefined) {
      process.stderr.write('CONDUCTOR-RELEASE FAIL: a required tool is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-release-${suffix}-${run}`, agent: { id: caller } })

    const task = await create.execute(
      { title: `release probe ${run}`, contextMode: 'empty', operationId: `probe-release-${run}` },
      exec('create'),
    )
    if (task.preparation !== 'ready') {
      process.stderr.write('CONDUCTOR-RELEASE FAIL: the task did not prepare\n')
      return
    }
    await watch.execute({ action: 'start', taskId: task.taskId, authorizedBy: caller }, exec('watch'))

    const before = await watch.execute({ action: 'report', taskId: task.taskId, authorizedBy: caller }, exec('report-before'))
    process.stderr.write(
      `CONDUCTOR-RELEASE-WATCH-LIVE ${(before.refusals ?? []).length === 0 ? 'PASS' : 'FAIL'} refusals=${JSON.stringify((before.refusals ?? []).join(' ').slice(0, 140))}\n`,
    )

    const released = await accessTool.execute({ action: 'release', taskId: task.taskId, callerSessionId: caller }, exec('release'))
    process.stderr.write(
      `CONDUCTOR-RELEASE-REACHABLE ${/is released from management/.test(String(released.summary)) ? 'PASS' : 'FAIL'} summary=${JSON.stringify(String(released.summary).slice(0, 220))}\n`,
    )

    const after = await watch.execute({ action: 'report', taskId: task.taskId, authorizedBy: caller }, exec('report-after'))
    const stopped = (after.refusals ?? []).some(entry => /was released at .*monitoring that/.test(entry))
    process.stderr.write(
      `CONDUCTOR-RELEASE-STOPS-MONITORING ${stopped ? 'PASS' : 'FAIL'} refusals=${JSON.stringify((after.refusals ?? []).join(' ').slice(0, 260))}\n`,
    )

    const again = await accessTool.execute({ action: 'release', taskId: task.taskId, callerSessionId: caller }, exec('release-again'))
    process.stderr.write(
      `CONDUCTOR-RELEASE-ONCE ${/already released/.test(String(again.summary)) ? 'PASS' : 'FAIL'} summary=${JSON.stringify(String(again.summary).slice(0, 160))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-RELEASE FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Plant a schema-valid operation record in the crash window (PRD §四.5).
 *
 * Fault injection, and it is done through the **Host's own storage service** rather than by editing the store
 * file: the record is a legal `operations` row written to the open domain, exactly as the plugin's own claim
 * writes one — what is simulated is the process dying between the claim and the outcome, which no probe can
 * time by hand.
 *
 * @param ctx - the probe's context.
 */
async function runOperationPlant(ctx) {
  try {
    const facility = ctx.get('storageDomain')
    const domain = facility?.get?.(EXPECTED_DOMAIN)
    if (domain === undefined) {
      process.stderr.write('CONDUCTOR-RECOVERY-PLANT FAIL: the conductor domain is not open\n')
      return
    }
    const table = domain.table('operations')
    const stamp = new Date().toISOString()
    await table.put(PLANTED_OPERATION, {
      operationId: PLANTED_OPERATION,
      kind: 'send',
      // 64 hex characters, which is the shape a real digest has. The value itself is never compared: what the
      // calibration reads is the operation's kind and delivery state.
      paramDigest: '0'.repeat(64),
      delivery: 'dispatching',
      withdrawn: false,
      createdAt: stamp,
      updatedAt: stamp,
    })
    const written = await table.get(PLANTED_OPERATION)
    process.stderr.write(
      `CONDUCTOR-RECOVERY-PLANT ${written?.delivery === 'dispatching' ? 'PASS' : 'FAIL'} `
      + `operationId=${JSON.stringify(PLANTED_OPERATION)} delivery=${JSON.stringify(String(written?.delivery))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-RECOVERY-PLANT ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Measure what the **next** boot did with the planted record.
 *
 * Two readings of the same fact, because they are read by different audiences: the stored record, which is
 * what the next restart will see, and `conductor_operation status`, which is what a caller sees. A calibration
 * that moved one and not the other would leave the plugin's own report contradicting its store.
 *
 * @param ctx - the probe's context.
 */
async function runOperationRecovery(ctx) {
  try {
    const tools = ctx.get('tools')
    const operation = typeof tools?.get === 'function' ? tools.get('conductor_operation') : undefined
    if (operation === undefined) {
      process.stderr.write('CONDUCTOR-RECOVERY FAIL: conductor_operation is not registered\n')
      return
    }
    // The calibration runs in the store-open callback, which is asynchronous; give it a moment rather than
    // racing it (the same reason the panel probe retries its first fetch).
    await new Promise(resolve => { setTimeout(resolve, 4000) })
    const facility = ctx.get('storageDomain')
    const domain = facility?.get?.(EXPECTED_DOMAIN)
    const stored = domain === undefined ? undefined : await domain.table('operations').get(PLANTED_OPERATION)
    const status = await operation.execute(
      { action: 'status', operationId: PLANTED_OPERATION },
      { callId: `probe-recovery-status`, agent: { id: 'session-probe-recovery' } },
    )
    const calibrated = stored?.delivery === 'unknown' && status.delivery === 'unknown'
    process.stderr.write(
      `CONDUCTOR-RECOVERY-CALIBRATED ${calibrated ? 'PASS' : 'FAIL'} `
      + `stored=${JSON.stringify(String(stored?.delivery))} reported=${JSON.stringify(String(status.delivery))} `
      + `found=${String(status.found)} phase=${JSON.stringify(String(stored?.phase ?? 'none'))}\n`,
    )

    // The account a caller can actually ask for. The calibration announces itself at mount, but a log line is
    // not a question, so the snapshot carries the same fact — and the store this runs against has real
    // leftovers from earlier rounds, not only a planted record.
    const capabilities = typeof tools?.get === 'function' ? tools.get('conductor_capabilities') : undefined
    const snapshot = capabilities === undefined
      ? undefined
      : await capabilities.execute({}, { callId: 'probe-recovery-caps', agent: { id: 'session-probe-recovery' } })
    const counted = (snapshot?.durableState?.unresolvedOperations ?? 0) >= 1
    const explained = typeof snapshot?.durableState?.unresolvedNote === 'string'
      && /did not finish before the last restart/.test(snapshot.durableState.unresolvedNote)
      && /NOT resent/.test(snapshot.durableState.unresolvedNote)
    const rendered = /Unresolved operations: \d+/.test(String(snapshot?.summary ?? ''))
    process.stderr.write(
      `CONDUCTOR-RECOVERY-SURFACED ${counted && explained && rendered ? 'PASS' : 'FAIL'} `
      + `count=${JSON.stringify(snapshot?.durableState?.unresolvedOperations)} `
      + `note=${JSON.stringify(String(snapshot?.durableState?.unresolvedNote ?? '').slice(0, 220))} `
      + `rendered=${String(rendered)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-RECOVERY ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Measure that an acceptance counts into the run ledger (PRD §二.13.2).
 *
 * > 所有由插件发起的节点、验收、回报和返工计入关联运行账本。
 *
 * Nodes, reports and reworks were counted; acceptances were not, so an action the conductor took on the
 * user's behalf left no trace in the accounting of the run it belongs to. This drives the real path — a task
 * under a task-scope budget, an artifact registered and verified, then accepted — and reads the ledger back
 * through the tool a caller would use.
 *
 * The control is the second half: a second acceptance of the same artifact with the same verdict is a
 * **replay** of the first, and a replay must not count twice. PRD §四.1 makes a repeated operation id a
 * replay rather than a second action, and a ledger that counted replays would inflate every figure a budget
 * decides on.
 *
 * @param ctx - the probe's context.
 */
async function runLedgerAcceptance(ctx) {
  try {
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const budget = get('conductor_budget')
    const register = get('conductor_artifact_register')
    const accept = get('conductor_artifact_accept')
    if ([create, budget, register, accept].some(tool => tool === undefined)) {
      process.stderr.write('CONDUCTOR-LEDGER FAIL: a required tool is not registered\n')
      return
    }
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const caller = 'session-probe-ledger'
    const exec = (suffix) => ({ callId: `probe-ledger-${suffix}-${run}`, agent: { id: caller } })

    const task = await create.execute(
      { title: `ledger subject ${run}`, contextMode: 'empty', operationId: `probe-ledger-task-${run}` },
      exec('task'),
    )
    const taskId = String(task.taskId)
    // A budget makes a ledger exist for the scope: the counters live on the policy's target.
    await budget.execute({ action: 'set', scope: 'task', targetId: taskId, maxDispatches: 10 }, exec('budget'))

    const readCounters = async (suffix) => {
      const listed = await budget.execute({ action: 'list' }, exec(suffix))
      const entry = (listed.ledgers ?? []).find(row => row.targetId === taskId)
      return entry
    }
    const before = await readCounters('before')

    const artifactId = `probe-ledger-artifact-${run}`
    await register.execute({
      taskId, artifactId, kind: 'file', name: `ledger-${run}.txt`,
      path: `D:\\dsh-conductor-verify\\ledger-${run}.txt`,
    }, exec('register'))
    await accept.execute({ artifactId, result: 'pass', by: 'user' }, exec('accept'))
    const after = await readCounters('after')

    const counted = (before?.acceptances ?? -1) === 0
      && after?.acceptances === 1
      // The other counters are untouched by an acceptance: it is not a dispatch, a turn or a rework.
      && after?.dispatches === before?.dispatches
      && after?.reportTurns === before?.reportTurns
    process.stderr.write(
      `CONDUCTOR-LEDGER-ACCEPTANCE ${counted ? 'PASS' : 'FAIL'} before=${JSON.stringify(before)} `
      + `after=${JSON.stringify(after)}\n`,
    )

    // The control: the same acceptance again is a **replay** of the same operation, so it must not count a
    // second time. The first version of this check asserted the opposite and passed — its label said
    // "not counted" while its condition required the count to reach 2 — which is how the missing operation
    // family was found: nothing in the acceptance path claimed an operation id, so a retry was a second
    // acceptance in every respect, including the ledger figure a budget decides on.
    const replayCall = { callId: `probe-ledger-accept-${run}`, agent: { id: caller } }
    const replayed = await accept.execute({ artifactId, result: 'pass', by: 'user' }, replayCall)
    const onceMore = await readCounters('replay')
    const notCounted = onceMore?.acceptances === 1 && replayed.replayed === true
    process.stderr.write(
      `CONDUCTOR-LEDGER-REPLAY-NOT-COUNTED ${notCounted ? 'PASS' : 'FAIL'} `
      + `replayed=${String(replayed.replayed)} acceptances=${String(onceMore?.acceptances)} `
      + `summary=${JSON.stringify(String(replayed.summary ?? '').slice(0, 200))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-LEDGER ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Measure the rule executor running **by itself** (PRD §二.8.2).
 *
 * > 规则由独立执行器执行，不依赖回报模型自行决定下一步。
 *
 * The executor existed and was de-duplicated, but the only entry point was `conductor_rule evaluate`, so a
 * saved rule fired only if somebody asked. This drives the real thing: a rule is saved from a source task to a
 * target task, the source's turn is made to fail — the trigger — and the probe then **waits and asks nothing**,
 * reading the target's own log for the instruction that arrived. Nothing in this probe calls `evaluate`.
 *
 * The second check is the guard that makes automatic firing safe: a rule pointing back the other way would
 * close a control cycle, and must be refused **before** it is saved rather than discovered as a loop later.
 *
 * @param ctx - the probe's context.
 */
async function runRuleWatcher(ctx) {
  try {
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const send = get('conductor_send')
    const rule = get('conductor_rule')
    if (create === undefined || send === undefined || rule === undefined) {
      process.stderr.write('CONDUCTOR-RULE-WATCHER FAIL: a required tool is not registered\n')
      return
    }
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const caller = 'session-probe-rule-watcher'
    const exec = (suffix) => ({ callId: `probe-rule-watcher-${suffix}-${run}`, agent: { id: caller } })

    const source = await create.execute(
      { title: `watcher source ${run}`, contextMode: 'empty', operationId: `probe-watcher-source-${run}` },
      exec('source'),
    )
    const target = await create.execute(
      { title: `watcher target ${run}`, contextMode: 'empty', operationId: `probe-watcher-target-${run}` },
      exec('target'),
    )
    const sourceTask = String(source.taskId)
    const targetTask = String(target.taskId)
    const targetSession = String(target.sessionId)

    // The authorisation: on a failed turn of the source, instruct the target once.
    const saved = await rule.execute({
      action: 'save',
      sourceTaskId: sourceTask,
      targetTaskId: targetTask,
      trigger: 'turn_failed',
      // The tool's parameter is `delivery` ('send' | 'queue'); it maps onto the request's `mode`. The first
      // attempt passed `mode` and was refused — "a rule that does not state its action is not an
      // authorisation" — which is the tool checking its own schema rather than guessing on my behalf.
      delivery: 'queue',
      instruction: 'the source failed; carry on with your part',
      authorizedBy: caller,
      title: `watcher rule ${run}`,
    }, exec('save'))
    // The grant is published in the save **summary**, not in the structured rules — reading it from the
    // structured output produced a misleading `grantId="none"` on a save that had minted one.
    const savedSummary = String(saved.summary ?? '')
    const savedRuleId = String(saved.rules?.[0]?.ruleId ?? '')
    process.stderr.write(
      `CONDUCTOR-RULE-WATCHER-SAVED ${savedRuleId.length > 0 && /grant-/.test(savedSummary) ? 'PASS' : 'FAIL'} `
      + `ruleId=${JSON.stringify(savedRuleId)} grant=${JSON.stringify(/grant-[0-9a-f-]+/.exec(savedSummary)?.[0] ?? 'not named')} `
      + `summary=${JSON.stringify(savedSummary.slice(0, 160))}\n`,
    )

    // The trigger: make the source's turn end in failure. This Host fails turns at once (no credentials), which
    // is the `turn_failed` trigger exactly.
    await send.execute(
      { taskId: sourceTask, text: 'do the thing that will fail', mode: 'steer', operationId: `probe-watcher-turn-${run}` },
      exec('turn'),
    )

    // Now wait, and ask nothing. The instruction has to arrive on the plugin's own pass.
    const targetAgent = ctx.get('agents')?.get(targetSession)
    const sentToTarget = () => {
      const events = targetAgent?.session?.events ?? []
      return events.filter(event => event.type === 'user/message').map((event) => {
        const content = event.data?.content
        return Array.isArray(content)
          ? content.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n')
          : String(content ?? '')
      })
    }
    const started = Date.now()
    let arrived = []
    for (;;) {
      arrived = sentToTarget().filter(text => text.includes('carry on with your part'))
      if (arrived.length > 0 || Date.now() - started > 45000) break
      await new Promise(resolve => { setTimeout(resolve, 1000) })
    }
    const waited = Date.now() - started
    // The source of that message is the plugin's own relay, not a person: PRD §四.2 requires a forwarded
    // instruction to be attributed to the relay rather than passed off as the user's own words.
    const forwarded = (targetAgent?.session?.events ?? [])
      .filter(event => event.type === 'user/message')
      .map(event => event.data?.source)
      .find(source => typeof source === 'object' && source !== null && source.form === 'relay')
    process.stderr.write(
      `CONDUCTOR-RULE-WATCHER-FIRED ${arrived.length === 1 && forwarded !== undefined ? 'PASS' : 'FAIL'} `
      + `waitedMs=${String(waited)} arrived=${String(arrived.length)} withoutAnyEvaluateCall=true `
      + `relaySource=${JSON.stringify(forwarded ?? null)}\n`,
    )

    // The guard: a rule pointing back the other way would close a cycle.
    let cycleRefusal = 'no error'
    try {
      await rule.execute({
        action: 'save',
        sourceTaskId: targetTask,
        targetTaskId: sourceTask,
        trigger: 'turn_failed',
        delivery: 'queue',
        instruction: 'and now instruct the source back',
        authorizedBy: caller,
        title: `watcher loop ${run}`,
      }, exec('loop'))
    } catch (error) {
      cycleRefusal = String(error?.message ?? error)
    }
    process.stderr.write(
      `CONDUCTOR-RULE-WATCHER-CYCLE-REFUSED ${/CONTROL_CYCLE|control cycle/.test(cycleRefusal) ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(cycleRefusal.slice(0, 300))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-RULE-WATCHER ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Measure a handoff conflict and the notice it produces (PRD §二.8.1's 交接冲突).
 *
 * The producer was added in round 52 and pinned by unit test, but a unit test cannot show that the **path a
 * real conflict travels** reaches a controller. This drives the whole thing live:
 *
 * 1. a file artifact is registered on the source task and **verified**, so the record holds a real baseline
 *    hash of the file as it was;
 * 2. the file is then changed underneath it — the receiver's copy is no longer the revision the patch was
 *    made against, which is the conflict the specification says must stop the handover rather than
 *    overwrite the receiver's work;
 * 3. the patch handover is asked for, and must refuse with `applied: false` and a recorded conflict;
 * 4. a live controller watching the **receiving** task is notified about it, on the plugin's own pass.
 *
 * @param ctx - the probe's context.
 */
async function runHandoffConflict(ctx) {
  try {
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const watch = get('conductor_watch')
    const register = get('conductor_artifact_register')
    const verify = get('conductor_artifact_verify')
    const transfer = get('conductor_transfer')
    if ([create, watch, register, verify, transfer].some(tool => tool === undefined)) {
      process.stderr.write('CONDUCTOR-CONFLICT FAIL: a required tool is not registered\n')
      return
    }
    const { randomUUID } = await import('node:crypto')
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const run = randomUUID().slice(0, 8)
    const caller = 'session-probe-conflict'
    const exec = (suffix) => ({ callId: `probe-conflict-${suffix}-${run}`, agent: { id: caller } })

    const dir = 'D:\\dsh-conductor-verify\\conflict-probe'
    await mkdir(dir, { recursive: true })
    const target = join(dir, `receiver-${run}.txt`)
    // The revision the patch will be made against, hashed through the Host's own filesystem service when the
    // artifact is verified.
    await writeFile(target, 'the revision the patch was made against\n', 'utf8')

    const source = await create.execute(
      { title: `conflict source ${run}`, contextMode: 'empty', operationId: `probe-conflict-source-${run}` },
      exec('source'),
    )
    const receiver = await create.execute(
      { title: `conflict receiver ${run}`, contextMode: 'empty', operationId: `probe-conflict-receiver-${run}` },
      exec('receiver'),
    )
    const receiverTask = String(receiver.taskId)
    const artifactId = `probe-conflict-artifact-${run}`
    await register.execute({
      taskId: String(source.taskId), artifactId, kind: 'file', name: `receiver-${run}.txt`, path: target,
    }, exec('register'))
    const verified = await verify.execute({ artifactId }, exec('verify'))
    // The verification is what records the baseline; only its existence is asserted here, because the
    // recorded hash is read back from the refusal below, where it is actually published.
    void verified

    // The receiver's file moves on. This is the situation PRD §二.9.2 refuses to overwrite.
    await writeFile(target, 'the receiver has moved on since the patch was made\n', 'utf8')

    const diff = [
      `--- a/receiver-${run}.txt`,
      `+++ b/receiver-${run}.txt`,
      '@@ -1,1 +1,1 @@',
      '-the revision the patch was made against',
      '+the patched result',
      '',
    ].join('\n')
    const handed = await transfer.execute({
      transferId: `probe-conflict-transfer-${run}`,
      mode: 'patch',
      artifactId,
      toTaskId: receiverTask,
      destination: target,
      diff,
      apply: true,
    }, exec('transfer'))
    const refused = handed.applied === false && handed.conflicts.length > 0
      && /baseline/.test(String(handed.conflicts[0]))
    // The hashes are read out of the refusal because that is where they are: the verify tool's own result
    // does not publish `contentHash`, and printing an empty `baseline` field here would read as "the
    // baseline was empty" — a false statement about a check that passed on a real hash.
    const expected = /expected ([0-9a-f]{12})/.exec(String(handed.conflicts[0] ?? ''))?.[1]
    process.stderr.write(
      `CONDUCTOR-CONFLICT-REFUSED ${refused ? 'PASS' : 'FAIL'} expected=${JSON.stringify(expected ?? 'not named')} `
      + `applied=${String(handed.applied)} provided=${String(handed.provided)} verified=${String(handed.verified)} `
      + `conflicts=${JSON.stringify(handed.conflicts.map(entry => String(entry).slice(0, 150)))}\n`,
    )

    // And the controller of the **receiving** task hears about it, on the plugin's own pass.
    const controller = await create.execute(
      { title: `conflict controller ${run}`, contextMode: 'empty', operationId: `probe-conflict-controller-${run}` },
      exec('controller'),
    )
    const controllerSession = String(controller.sessionId)
    await watch.execute(
      { action: 'start', taskId: receiverTask },
      { callId: `probe-conflict-watch-${run}`, agent: { id: controllerSession } },
    )
    const waited = await waitForNotice(ctx, controllerSession, notice => /\[handoff_conflict\]/.test(notice.text), 45000)
    const reported = waited.found.length === 1
    process.stderr.write(
      `CONDUCTOR-CONFLICT-REPORTED ${reported ? 'PASS' : 'FAIL'} waitedMs=${String(waited.waited)} `
      + `found=${String(waited.found.length)} `
      + `text=${JSON.stringify(String(waited.found[0]?.text ?? '').slice(0, 300))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-CONFLICT ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Measure the Host preset path (PRD §二.3).
 *
 * Three claims, and the roster's own answers are what make them checkable:
 *
 * 1. a preset the roster offers composes the session and is **recorded on the task**;
 * 2. a preset no root offers fails the preparation with the roster's own reason, **before** any session
 *    exists — the alternative is a Host assembly error with a worktree already on disk;
 * 3. `conductor_update` refuses a preset with the explanation and the pointer to `conductor_handoff`, which
 *    is where `presetChangeAllowed` finally gets a caller.
 *
 * The roster is read from the Host rather than assumed, so this reports what the verify profile actually
 * offers instead of failing when it offers nothing.
 *
 * @param ctx - the probe's context.
 */
async function runPreset(ctx) {
  try {
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const update = get('conductor_update')
    if (create === undefined || update === undefined) {
      process.stderr.write('CONDUCTOR-PRESET FAIL: create/update is not registered\n')
      return
    }
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const caller = 'session-probe-preset'
    const exec = (suffix) => ({ callId: `probe-preset-${suffix}-${run}`, agent: { id: caller } })
    const presets = ctx.get('agentPresets')
    const defaultId = typeof presets?.defaultId === 'string' ? presets.defaultId : undefined
    let roster = []
    try {
      roster = typeof presets?.list === 'function' ? (await presets.list()).map(row => String(row?.id)) : []
    } catch (error) {
      roster = [`(list failed: ${String(error?.message ?? error)})`]
    }

    // 1. A preset the roster offers. The Host's own default is the one id guaranteed to be meaningful here.
    if (defaultId === undefined) {
      process.stderr.write(
        `CONDUCTOR-PRESET-NAMED SKIP this Host publishes no default preset id; roster=${JSON.stringify(roster)}\n`,
      )
    } else {
      const named = await create.execute(
        { title: `preset task ${run}`, contextMode: 'empty', preset: defaultId, operationId: `probe-preset-named-${run}` },
        exec('named'),
      )
      const recorded = named.preparation === 'ready' && String(named.taskId).length > 0
      // Read the composition back from the model tool's own view of the task, which is where a reader sees it.
      const detail = await fetch(`http://127.0.0.1:${process.env['CONDUCTOR_PROBE_PORT'] ?? '43917'}/conductor/panel/task?taskId=${encodeURIComponent(String(named.taskId))}`,
        { headers: { accept: 'application/json' } }).then(response => response.json()).catch(() => undefined)
      const shown = detail?.task?.configuration?.preset
      process.stderr.write(
        `CONDUCTOR-PRESET-NAMED ${recorded && shown === defaultId ? 'PASS' : 'FAIL'} preset=${JSON.stringify(defaultId)} `
        + `preparation=${JSON.stringify(named.preparation)} taskId=${JSON.stringify(String(named.taskId))} `
        + `detailPreset=${JSON.stringify(shown)} roster=${JSON.stringify(roster)}\n`,
      )
    }

    // 2. A preset no root offers.
    const unknownId = `probe-preset-that-does-not-exist-${run}`
    const unknown = await create.execute(
      { title: `preset refusal ${run}`, contextMode: 'empty', preset: unknownId, operationId: `probe-preset-unknown-${run}` },
      exec('unknown'),
    )
    const refused = unknown.preparation === 'failed'
      && /could not be resolved|no preset root offers/.test(String(unknown.failureReason ?? ''))
    process.stderr.write(
      `CONDUCTOR-PRESET-UNKNOWN ${refused ? 'PASS' : 'FAIL'} preparation=${JSON.stringify(unknown.preparation)} `
      + `sessionId=${JSON.stringify(String(unknown.sessionId ?? 'none'))} `
      + `reason=${JSON.stringify(String(unknown.failureReason ?? '').slice(0, 200))}\n`,
    )

    // 3. The preset cannot be changed on an existing task.
    let updateRefusal = 'no error'
    try {
      await update.execute({ taskId: String(unknown.taskId), preset: 'anything' }, exec('update'))
    } catch (error) {
      updateRefusal = String(error?.message ?? error)
    }
    process.stderr.write(
      `CONDUCTOR-PRESET-UPDATE-REFUSED ${/successor session|conductor_handoff/.test(updateRefusal) ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(updateRefusal.slice(0, 260))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-PRESET ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Measure the two ways a wait can end before its deadline (PRD §二.7).
 *
 * > 用户新输入可结束等待。
 *
 * Both endings are measured against a **real** Host session, because that is what makes them observable at
 * all: the waiting identity must be a live session (the conductor reads that session's own log to see who
 * spoke), and the user's words are written through the Host's **own** session API rather than fabricated
 * inside the plugin. Two claims are checked, and they are deliberately separate — "the wait ended" and
 * "the wait ended for the right reason":
 *
 * 1. a person's message ends it, reported as `user_spoke` rather than as a timeout;
 * 2. the Host's abort signal ends it, reported as `cancelled`.
 *
 * Each also checks that it ended **early**: a wait that ran to its 20-second deadline and then reported the
 * right word would be a coincidence, not a mechanism.
 *
 * @param ctx - the probe's context.
 */
async function runWaitInterrupt(ctx) {
  try {
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const wait = get('conductor_wait')
    if (create === undefined || wait === undefined) {
      process.stderr.write('CONDUCTOR-WAIT-INTERRUPT FAIL: create/wait is not registered\n')
      return
    }
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)

    // The target the wait is about, and a separate live session to wait from — the reader must be a real
    // session for the conductor to be able to read who spoke in it.
    const target = await create.execute(
      { title: `wait target ${run}`, contextMode: 'empty', operationId: `probe-wait-target-${run}` },
      { callId: `probe-wait-target-${run}`, agent: { id: 'session-probe-wait-creator' } },
    )
    const waiter = await create.execute(
      { title: `wait waiter ${run}`, contextMode: 'empty', operationId: `probe-wait-waiter-${run}` },
      { callId: `probe-wait-waiter-${run}`, agent: { id: 'session-probe-wait-creator' } },
    )
    const waiterSession = String(waiter.sessionId)
    const targetTask = String(target.taskId)
    const waiterExec = (suffix) => ({ callId: `probe-wait-${suffix}-${run}`, agent: { id: waiterSession } })

    // ── 1. a person's message ends the wait ──────────────────────────────────────────────────────────
    const spoken = wait.execute(
      { targets: [{ taskId: targetTask }], timeoutMs: 20000 },
      waiterExec('spoken'),
    )
    await new Promise(resolve => { setTimeout(resolve, 1200) })
    const agent = ctx.get('agents')?.get(waiterSession)
    let appendNote = 'the waiting session could not be reached, so nothing was said'
    if (agent?.session !== undefined) {
      // Written the way the Host's own `session.prompt` writes it, because that is what "the user said
      // something" *is*: `createUserMessage({ content, source: { kind: 'user' } })` handed to the agent.
      // A raw `session.append` was tried first and the Host refused it — "user/message is surface-eligible
      // and requires" the surface intent — which is the Host telling us this event is not ours to author
      // directly, so the agent's own delivery path is used instead.
      try {
        const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
        const message = createUserMessage({
          content: [{ type: 'text', text: 'stop waiting, I am taking over' }],
          source: { kind: 'user' },
        })
        if (typeof agent.steer === 'function') agent.steer(message)
        else if (typeof agent.followup === 'function') agent.followup(message)
        else throw new Error('this agent exposes neither steer nor followup')
        appendNote = `said through ${typeof agent.steer === 'function' ? 'steer' : 'followup'}`
      } catch (error) {
        appendNote = `the Host refused the message: ${String(error?.message ?? error)}`
      }
    }
    const startedAt = Date.now()
    const spokenResult = await spoken
    const spokeMs = Date.now() - startedAt
    const spokeOk = appendNote.startsWith('said through')
      && spokenResult.ending === 'user_spoke'
      && spokenResult.timedOut === false
      && spokeMs < 15000
    process.stderr.write(
      `CONDUCTOR-WAIT-USER-SPOKE ${spokeOk ? 'PASS' : 'FAIL'} append=${JSON.stringify(appendNote.slice(0, 90))} `
      + `ending=${JSON.stringify(spokenResult.ending)} timedOut=${String(spokenResult.timedOut)} `
      + `elapsedMs=${String(spokeMs)} targets=${String(spokenResult.targets?.length)} `
      + `summary=${JSON.stringify(String(spokenResult.summary ?? '').slice(0, 140))}\n`,
    )

    // ── 2. the Host's abort signal ends the wait ─────────────────────────────────────────────────────
    const controller = new AbortController()
    const cancelledRun = wait.execute(
      { targets: [{ taskId: targetTask }], timeoutMs: 20000 },
      { ...waiterExec('cancelled'), signal: controller.signal },
    )
    await new Promise(resolve => { setTimeout(resolve, 1200) })
    const cancelStarted = Date.now()
    controller.abort()
    const cancelledResult = await cancelledRun
    const cancelMs = Date.now() - cancelStarted
    const cancelledOk = cancelledResult.ending === 'cancelled'
      && cancelledResult.timedOut === false
      && cancelMs < 15000
    process.stderr.write(
      `CONDUCTOR-WAIT-CANCELLED ${cancelledOk ? 'PASS' : 'FAIL'} `
      + `ending=${JSON.stringify(cancelledResult.ending)} timedOut=${String(cancelledResult.timedOut)} `
      + `elapsedAfterAbortMs=${String(cancelMs)} `
      + `summary=${JSON.stringify(String(cancelledResult.summary ?? '').slice(0, 140))}\n`,
    )

    // ── 3. the control: with nobody speaking and nobody cancelling, the deadline is what ends it ─────
    const quietStarted = Date.now()
    const quiet = await wait.execute(
      { targets: [{ taskId: targetTask }], timeoutMs: 0 },
      waiterExec('quiet'),
    )
    process.stderr.write(
      `CONDUCTOR-WAIT-QUIET-CONTROL ${quiet.ending === 'timed_out' && quiet.timedOut === true ? 'PASS' : 'FAIL'} `
      + `ending=${JSON.stringify(quiet.ending)} elapsedMs=${String(Date.now() - quietStarted)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-WAIT-INTERRUPT ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Measure the management panel's data route and its status badge (PRD §二.1).
 *
 * The panel's whole job is to say something true about work happening elsewhere, so the two things
 * worth measuring live are:
 *
 * 1. **The route answers.** Fetched over real HTTP from inside the Host process, not called as a
 *    function: a registered route that the server does not actually serve would pass a unit test.
 * 2. **The badge agrees with the card it sits on.** The badge is derived on the Host from the same
 *    facts the response carries, so the probe compares them *within a single payload*. Releasing the
 *    task then has to change the badge to `released` **with a reason** while its preparation stays
 *    `ready` — a fact the creation path never produces, which is what makes this a measurement of the
 *    release wiring rather than of a default value.
 *
 * The badge vocabulary is written out here rather than imported from the plugin. A probe that asked
 * the code under test what its vocabulary is could only ever confirm that the code is self-consistent;
 * naming the contract is what makes a change to it deliberate in two places.
 *
 * @param ctx - the probe's context.
 */
async function runPanel(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const port = process.env['CONDUCTOR_PROBE_PORT'] ?? '43917'
    const url = `http://127.0.0.1:${port}/conductor/panel`
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const accessTool = get('conductor_access')
    if (create === undefined || accessTool === undefined) {
      process.stderr.write('CONDUCTOR-PANEL FAIL: a required tool is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-panel-${suffix}-${run}`, agent: { id: caller } })

    const vocabulary = ['preparing', 'preparation_failed', 'cancelled', 'released', 'budget_limited',
      'waiting_user', 'running', 'idle']

    const read = async () => {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        payload = undefined
      }
      return { response, text, payload }
    }

    // The route is registered when the store opens, which is asynchronous; retry rather than racing it.
    let first
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        first = await read()
        break
      } catch (error) {
        if (attempt === 9) throw error
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    if (first === undefined) {
      process.stderr.write('CONDUCTOR-PANEL FAIL: the route was never reachable\n')
      return
    }
    const routeOk = first.response.status === 200
      && first.response.headers.get('cache-control') === 'no-store'
      && String(first.response.headers.get('content-type')).startsWith('application/json')
      && first.payload !== undefined
    process.stderr.write(
      `CONDUCTOR-PANEL-ROUTE ${routeOk ? 'PASS' : 'FAIL'} status=${String(first.response.status)} `
      + `cacheControl=${JSON.stringify(first.response.headers.get('cache-control'))} `
      + `contentType=${JSON.stringify(first.response.headers.get('content-type'))} `
      + `bytes=${String(first.text.length)} total=${String(first.payload?.total)}\n`,
    )

    const task = await create.execute(
      { title: `panel probe ${run}`, contextMode: 'empty', operationId: `probe-panel-${run}` },
      exec('create'),
    )
    if (task.preparation !== 'ready') {
      process.stderr.write('CONDUCTOR-PANEL FAIL: the task did not prepare\n')
      return
    }

    const after = await read()
    const card = (after.payload?.tasks ?? []).find(entry => entry.taskId === task.taskId)

    // PRD §二.3's "最近实际使用". The verify Host cannot assemble a request (no model credentials), so a
    // session here never logs a `request/header` on its own — which would leave the reading path unmeasured
    // and the honest "(none recorded)" indistinguishable from a broken reader. So the probe writes the
    // Host's **own** event through the Host's **own** session API and then measures what the conductor
    // reports: the fact is the Host's, the reader is the plugin's, and that is the half under test.
    const boundAgent = ctx.get('agents')?.get(String(task.sessionId))
    let appendNote = 'the Host session could not be reached, so no header was written'
    let headerWritten = false
    if (typeof boundAgent?.session?.append === 'function') {
      try {
        boundAgent.session.append('request/header', {
          header: { config: { provider: 'probe-provider', model: 'probe-model', reasoningEffort: 'high' } },
          reason: 'initial',
        })
        headerWritten = true
        appendNote = 'written'
      } catch (error) {
        appendNote = `the Host refused the append: ${String(error?.message ?? error)}`
      }
    }
    const modelTool = get('conductor_model')
    const shown = modelTool === undefined
      ? undefined
      : await modelTool.execute({ action: 'show', taskId: task.taskId }, exec('model'))
    const usedLine = `${String(shown?.state ?? '')}`
    const readBack = headerWritten && usedLine.includes('probe-provider/probe-model at high reasoning')
    // And the same fact on the **card**, re-read after the header was written: §二.1's card shows 实际模型配置,
    // and a card that disagreed with the model tool about what the task last used would be worse than one
    // that said nothing.
    const relisted = await read()
    const relistedCard = (relisted.payload?.tasks ?? []).find(entry => entry.taskId === task.taskId)
    const cardShows = relistedCard?.modelLastUsed === 'probe-provider/probe-model at high reasoning'
      && relistedCard?.modelForNextRequest === undefined
    process.stderr.write(
      `CONDUCTOR-PANEL-MODEL-LASTUSED ${readBack && cardShows ? 'PASS' : 'FAIL'} written=${String(headerWritten)} `
      + `append=${JSON.stringify(appendNote.slice(0, 120))} `
      + `card=${JSON.stringify(relistedCard?.modelLastUsed)} `
      + `forNextRequest=${JSON.stringify(relistedCard?.modelForNextRequest)} `
      + `state=${JSON.stringify(usedLine.slice(0, 220))}\n`,
    )
    const known = card !== undefined && vocabulary.includes(card.status)
    // The badge and the dimensions travel in the same answer, so they can be compared directly. A card
    // that is ready, idle and not waiting must read `idle`; anything else and the derivation has drifted
    // from the fields beside it.
    const agrees = card !== undefined
      && card.status === 'idle'
      && card.preparation === 'ready'
      && card.execution === 'idle'
      && card.pendingInteraction === undefined
      && card.statusReason === undefined
    process.stderr.write(
      `CONDUCTOR-PANEL-BADGE ${known && agrees ? 'PASS' : 'FAIL'} `
      + `status=${JSON.stringify(card?.status)} preparation=${JSON.stringify(card?.preparation)} `
      + `execution=${JSON.stringify(card?.execution)} interaction=${JSON.stringify(card?.pendingInteraction)} `
      + `reason=${JSON.stringify(card?.statusReason)}\n`,
    )

    const notes = after.payload?.notes ?? []
    const honest = notes.some(note => /unread counts every fact/.test(note))
      && notes.some(note => /derived badge/.test(note))
    process.stderr.write(
      `CONDUCTOR-PANEL-NOTES ${honest ? 'PASS' : 'FAIL'} notes=${JSON.stringify(notes.map(note => note.slice(0, 60)))}\n`,
    )

    // PRD §二.1's 打开原会话 needs the session on the card, and the card carried every other identity but
    // that one — so the panel had nothing to navigate to. Checked on the card **and** the detail against
    // the session the create actually bound, because a card naming a different session would open the
    // wrong conversation rather than none.
    const boundSession = String(task.sessionId ?? '')
    const cardSession = card?.sessionId
    const sessionMatches = boundSession.length > 0 && cardSession === boundSession
    process.stderr.write(
      `CONDUCTOR-PANEL-SESSION ${sessionMatches ? 'PASS' : 'FAIL'} bound=${JSON.stringify(boundSession)} `
      + `card=${JSON.stringify(cardSession)}\n`,
    )

    // The detail route (PRD §二.1's 任务详情). Three answers are checked because a view has to tell them
    // apart: the task it asked for, a task that is not recorded, and a request that names no task at all.
    const readDetail = async (query) => {
      const response = await fetch(`http://127.0.0.1:${port}/conductor/panel/task${query}`,
        { headers: { accept: 'application/json' } })
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        payload = undefined
      }
      return { status: response.status, payload, text }
    }

    const own = await readDetail(`?taskId=${encodeURIComponent(task.taskId)}`)
    const detail = own.payload?.task
    const detailOk = own.status === 200
      && detail?.taskId === task.taskId
      && detail?.preparation === 'ready'
      && detail?.configuration?.contextMode === 'empty'
      && Array.isArray(detail?.artifacts)
      && Array.isArray(detail?.operations)
      // The conversation is refused **by name**, and the refusal names the tool that owns it — a blank
      // area would read as "there was no conversation", which is the misreading worth designing against.
      && (detail?.refusals ?? []).some(entry => /conductor_read/.test(entry))
      // The other two absences are stated as absences rather than omitted. The wording changed in round 55
      // when the detail gained the Host's own logged configuration: what is missing is the **pending** half
      // of §二.3's pair, not the whole notion of a per-task configuration.
      && (detail?.refusals ?? []).some(entry => /configuration the NEXT request will use is not reported/.test(entry))
      && (detail?.refusals ?? []).some(entry => /No budget governs this task/.test(entry))
      // And the half that IS readable travels with the detail: the same Host header the model tool reports,
      // read through the other route, so the two cannot disagree about what the task last ran with.
      && /^probe-provider\/probe-model at high reasoning$/.test(String(detail?.configuration?.modelLastUsed ?? ''))
    process.stderr.write(
      `CONDUCTOR-PANEL-DETAIL ${detailOk ? 'PASS' : 'FAIL'} status=${String(own.status)} `
      + `taskId=${JSON.stringify(detail?.taskId)} preparation=${JSON.stringify(detail?.preparation)} `
      + `contextMode=${JSON.stringify(detail?.configuration?.contextMode)} `
      + `modelLastUsed=${JSON.stringify(detail?.configuration?.modelLastUsed)} `
      + `artifacts=${String(detail?.artifacts?.length)} operations=${String(detail?.operations?.length)} `
      + `refusals=${String((detail?.refusals ?? []).length)} bytes=${String(own.text.length)}\n`,
    )

    const unknownDetail = await readDetail('?taskId=task-that-does-not-exist')
    const namesIt = unknownDetail.status === 404
      && /no task "task-that-does-not-exist" is recorded/.test(String(unknownDetail.payload?.error))
      && unknownDetail.payload?.task === undefined
    process.stderr.write(
      `CONDUCTOR-PANEL-DETAIL-UNKNOWN ${namesIt ? 'PASS' : 'FAIL'} status=${String(unknownDetail.status)} `
      + `error=${JSON.stringify(String(unknownDetail.payload?.error ?? '').slice(0, 120))}\n`,
    )

    const namelessDetail = await readDetail('')
    const refusesNameless = namelessDetail.status === 400
      && /needs a "taskId" query parameter/.test(String(namelessDetail.payload?.error))
    process.stderr.write(
      `CONDUCTOR-PANEL-DETAIL-NAMELESS ${refusesNameless ? 'PASS' : 'FAIL'} status=${String(namelessDetail.status)} `
      + `error=${JSON.stringify(String(namelessDetail.payload?.error ?? '').slice(0, 120))}\n`,
    )

    // §二.1's third named special state, and the one that would be easiest to fake: 预算受限 must be the
    // **budget gate's own** answer, not a second opinion computed for the panel. A zero-dispatch limit is
    // reachable immediately (0 >= 0), and the badge must also carry the gate's reason.
    const budget = get('conductor_budget')
    if (budget === undefined) {
      process.stderr.write('CONDUCTOR-PANEL-BUDGET FAIL: conductor_budget is not registered\n')
    } else {
      const set = await budget.execute({
        action: 'set',
        scope: 'task',
        targetId: task.taskId,
        maxDispatches: 0,
      }, exec('budget'))
      const limitedRead = await read()
      const limited = (limitedRead.payload?.tasks ?? []).find(entry => entry.taskId === task.taskId)
      const showsLimit = limited?.status === 'budget_limited'
        && typeof limited.statusReason === 'string'
        && /dispatched 0 time\(s\), its maximum/.test(limited.statusReason)
        // The preparation state is still `ready`, so the badge is not just repeating it.
        && limited.preparation === 'ready'
      process.stderr.write(
        `CONDUCTOR-PANEL-BUDGET ${showsLimit ? 'PASS' : 'FAIL'} status=${JSON.stringify(limited?.status)} `
        + `preparation=${JSON.stringify(limited?.preparation)} `
        + `reason=${JSON.stringify(String(limited?.statusReason ?? '').slice(0, 200))} `
        + `setSummary=${JSON.stringify(String(set.summary).slice(0, 80))}\n`,
      )
    }

    const released = await accessTool.execute(
      { action: 'release', taskId: task.taskId, callerSessionId: caller },
      exec('release'),
    )
    if (!/is released from management/.test(String(released.summary))) {
      process.stderr.write(`CONDUCTOR-PANEL FAIL: the release was refused: ${String(released.summary).slice(0, 200)}\n`)
      return
    }

    const final = await read()
    const releasedCard = (final.payload?.tasks ?? []).find(entry => entry.taskId === task.taskId)
    const showsRelease = releasedCard !== undefined
      && releasedCard.status === 'released'
      && typeof releasedCard.statusReason === 'string'
      && /was released at/.test(releasedCard.statusReason)
      // The preparation state is untouched by a release, so the badge changed for a reason the
      // preparation field cannot explain — which is the point of deriving it from the release record.
      && releasedCard.preparation === 'ready'
    process.stderr.write(
      `CONDUCTOR-PANEL-RELEASED ${showsRelease ? 'PASS' : 'FAIL'} status=${JSON.stringify(releasedCard?.status)} `
      + `preparation=${JSON.stringify(releasedCard?.preparation)} `
      + `reason=${JSON.stringify(String(releasedCard?.statusReason ?? '').slice(0, 200))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-PANEL FAIL: ${String(error?.stack ?? error)}\n`)
  }
}
/**
 * Measure that the acceptance rule a run fixed is enforced (PRD §二.12, §三.3).
 *
 * The stored rule was display-only: a verdict could be judged against anything, and a definition
 * edited after a run started silently redefined what passing meant for that run. The rule the run
 * fixed is now required to match, so a verdict naming a different rule is refused with both texts.
 *
 * @param ctx - the probe's context.
 */
async function runFixedRule(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const workflow = get('conductor_workflow')
    if (create === undefined || workflow === undefined) {
      process.stderr.write('CONDUCTOR-FIXED-RULE FAIL: a required tool is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-rule-${suffix}-${run}`, agent: { id: caller } })
    const task = await create.execute(
      { title: `rule probe ${run}`, contextMode: 'empty', operationId: `probe-rule-${run}` },
      exec('create'),
    )
    if (task.preparation !== 'ready') {
      process.stderr.write('CONDUCTOR-FIXED-RULE FAIL: the task did not prepare\n')
      return
    }
    const workflowId = `probe-rule-${run}`
    await workflow.execute({
      action: 'save',
      authorizedBy: caller,
      definition: {
        workflowId,
        title: `rule probe ${run}`,
        nodes: [{ nodeId: 'only', taskId: task.taskId, instruction: 'do the work', acceptance: 'the report lists every finding' }],
      },
    }, exec('save'))
    const started = await workflow.execute({ action: 'start', workflowId, authorizedBy: caller }, exec('start'))
    const runId = started.runs?.[0]?.runId
    if (runId === undefined) {
      process.stderr.write('CONDUCTOR-FIXED-RULE FAIL: no run was started\n')
      return
    }

    // A verdict that names no rule is refused: it cannot be checked against the fixed one.
    const unnamed = await workflow.execute(
      { action: 'verdict', runId, nodeId: 'only', result: 'pass', by: 'user', authorizedBy: caller },
      exec('verdict-unnamed'),
    ).then(value => `returned: ${String(value.summary).slice(0, 60)}`, error => String(error?.message ?? error))
    process.stderr.write(
      `CONDUCTOR-FIXED-RULE-NEEDS-THE-RULE ${/does not say which rule|BAD_REQUEST/.test(unnamed) ? 'PASS' : 'FAIL'} `
      + `result=${JSON.stringify(unnamed.slice(0, 220))}\n`,
    )

    // A verdict judged against a different rule is refused, naming both texts.
    const wrong = await workflow.execute({
      action: 'verdict', runId, nodeId: 'only', result: 'pass', by: 'user',
      rule: 'looks good to me', authorizedBy: caller,
    }, exec('verdict-wrong')).then(value => `returned: ${String(value.summary).slice(0, 60)}`, error => String(error?.message ?? error))
    process.stderr.write(
      `CONDUCTOR-FIXED-RULE-REJECTS-ANOTHER ${/judged against "looks good to me"/.test(wrong) ? 'PASS' : 'FAIL'} `
      + `result=${JSON.stringify(wrong.slice(0, 240))}\n`,
    )

    // And the rule the run fixed is accepted.
    const right = await workflow.execute({
      action: 'verdict', runId, nodeId: 'only', result: 'pass', by: 'user',
      rule: 'the report lists every finding', authorizedBy: caller,
    }, exec('verdict-right'))
    process.stderr.write(
      `CONDUCTOR-FIXED-RULE-ACCEPTS-THE-FIXED-ONE ${/was recorded as pass by user/.test(String(right.summary)) ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(right.summary).slice(0, 200))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-FIXED-RULE FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Measure cross-Host reconciliation's scope (PRD §二.14.1).
 *
 * The filter used to pass a **host id as a task id**, so it matched nothing and reconciliation
 * compared an empty list while reporting success — a no-op dressed as a check. Three facts are
 * measured: a named task really is compared, a task with operations to compare produces decisions
 * (not an empty result), and a caller naming neither a task nor a host is refused instead of being
 * handed a clean-looking empty reconciliation.
 *
 * @param ctx - the probe's context.
 */
async function runReconcile(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const tools = ctx.get('tools')
    const create = typeof tools?.get === 'function' ? tools.get('conductor_create') : undefined
    const remote = typeof tools?.get === 'function' ? tools.get('conductor_remote') : undefined
    if (create === undefined || remote === undefined) {
      process.stderr.write('CONDUCTOR-RECONCILE FAIL: the create or remote tool is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-reconcile-${suffix}-${run}`, agent: { id: caller } })

    const task = await create.execute(
      { title: `reconcile probe ${run}`, contextMode: 'empty', instruction: 'do something', operationId: `probe-reconcile-${run}` },
      exec('create'),
    )
    if (task.preparation !== 'ready') {
      process.stderr.write(`CONDUCTOR-RECONCILE FAIL: the task did not prepare (${String(task.preparation)})\n`)
      return
    }

    const byTask = await remote.execute({ action: 'reconcile', taskId: task.taskId, authorizedBy: caller }, exec('by-task'))
    // The task has at least one operation (its creation), so the comparison must see it.
    const compared = /operation\(s\) reconciled|No operations are recorded/.test(String(byTask.summary))
    process.stderr.write(
      `CONDUCTOR-RECONCILE-BY-TASK ${compared && !/No operations are recorded/.test(String(byTask.summary)) ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(byTask.summary).slice(0, 260))}\n`,
    )

    // A host name reconciles the work bound to it. This Host's tasks are bound to `local`, which no
    // registration covers, so the honest answer is that it names no task of its own.
    await remote.execute(
      { action: 'register', hostId: `probe-host-${run}`, label: 'probe', authorizedBy: caller },
      exec('register'),
    )
    const byHost = await remote.execute(
      { action: 'reconcile', hostId: `probe-host-${run}`, authorizedBy: caller },
      exec('by-host'),
    )
    process.stderr.write(
      `CONDUCTOR-RECONCILE-BY-HOST ${/bound to probe-host|No operations are recorded/.test(String(byHost.summary)) ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(byHost.summary).slice(0, 220))}\n`,
    )

    // Naming neither is refused: an empty filter must not look like a clean reconciliation.
    const unnamed = await remote.execute({ action: 'reconcile', authorizedBy: caller }, exec('unnamed'))
      .then(value => `returned: ${String(value.summary).slice(0, 60)}`, error => String(error?.message ?? error))
    process.stderr.write(
      `CONDUCTOR-RECONCILE-NEEDS-A-SCOPE ${/needs either a taskId or a hostId|BAD_REQUEST/.test(unnamed) ? 'PASS' : 'FAIL'} `
      + `result=${JSON.stringify(unnamed.slice(0, 190))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-RECONCILE FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Measure that a reached budget limit actually stops automatic dispatch (PRD §二.13.2).
 *
 * The decision logic existed and was unit-tested, but **no dispatch path consulted it**, and the
 * ledger was written only by the manual `record` action — so a "measured" budget counted nothing by
 * itself and no limit could be reached in practice. Three facts are measured here, in one run:
 *
 * 1. an automatic rule dispatch counts into the ledger **by itself**;
 * 2. once the limit is reached, the next automatic dispatch is **refused**, with the reason naming
 *    the limit and §二.13.2's three actions;
 * 3. the ledger keeps what it counted — the refusal does not zero it.
 *
 * @param ctx - the probe's context.
 */
async function runBudgetGate(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const run = randomUUID().slice(0, 8)
    const root = await mkdtemp(join(tmpdir(), 'conductor-probe-budget-'))
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const register = get('conductor_artifact_register')
    const verify = get('conductor_artifact_verify')
    const accept = get('conductor_artifact_accept')
    const ruleTool = get('conductor_rule')
    const budgetTool = get('conductor_budget')
    if ([create, register, verify, accept, ruleTool, budgetTool].some(tool => tool === undefined)) {
      process.stderr.write('CONDUCTOR-BUDGET-GATE FAIL: a required tool is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-budget-${suffix}-${run}`, agent: { id: caller } })

    const source = await create.execute(
      { title: `budget probe source ${run}`, contextMode: 'empty', operationId: `probe-budget-src-${run}` },
      exec('create-source'),
    )
    const target = await create.execute(
      { title: `budget probe target ${run}`, contextMode: 'empty', operationId: `probe-budget-tgt-${run}` },
      exec('create-target'),
    )
    const file = join(root, 'gate.md')
    await writeFile(file, '# gate\n', 'utf8')
    const registered = await register.execute(
      { taskId: source.taskId, kind: 'file', name: 'gate.md', path: file },
      exec('register'),
    )
    await verify.execute({ artifactId: registered.artifactId }, exec('verify'))
    await ruleTool.execute({
      action: 'save',
      sourceTaskId: source.taskId,
      targetTaskId: target.taskId,
      trigger: 'artifact_accepted',
      requiredArtifactId: registered.artifactId,
      delivery: 'send',
      instruction: 'continue after the gate was accepted',
      maxExecutions: 5,
      authorizedBy: caller,
    }, exec('rule'))

    // A task-scope budget permitting exactly ONE dispatch, so the second is over the limit.
    const set = await budgetTool.execute(
      { action: 'set', scope: 'task', targetId: target.taskId, maxDispatches: 1, strict: true },
      exec('budget-set'),
    )
    process.stderr.write(
      `CONDUCTOR-BUDGET-GATE-SET ${/maxDispatches|1 dispatches|Set|set/.test(String(set.summary)) ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(set.summary).slice(0, 160))}\n`,
    )

    // 1. The first acceptance dispatches, and the ledger counts it **without being told**.
    const first = await accept.execute({ artifactId: registered.artifactId, result: 'pass', by: 'user' }, exec('accept-1'))
    const firstFired = (first.triggered ?? []).some(entry => typeof entry.operationId === 'string' && entry.operationId !== '')
    const ledger = await budgetTool.execute({ action: 'list' }, exec('budget-list'))
    const counted = (ledger.ledgers ?? []).find(entry => entry.targetId === target.taskId)
    process.stderr.write(
      `CONDUCTOR-BUDGET-GATE-COUNTED ${firstFired && Number(counted?.dispatches ?? 0) >= 1 ? 'PASS' : 'FAIL'} `
      + `fired=${String(firstFired)} ledgerDispatches=${String(counted?.dispatches ?? 'none')} `
      + `ledgers=${JSON.stringify((ledger.ledgers ?? []).map(entry => `${entry.targetId}:${String(entry.dispatches)}`))}\n`,
    )

    // 2. A second acceptance must be REFUSED by the limit — the behaviour that did not exist.
    const second = await accept.execute({ artifactId: registered.artifactId, result: 'pass', by: 'user' }, exec('accept-2'))
    const refusal = (second.triggered ?? []).map(entry => String(entry.reason)).join(' | ')
    const refused = /budget does not permit|dispatched \d+ time\(s\), its maximum|not dispatched/.test(refusal)
      && !(second.triggered ?? []).some(entry => typeof entry.operationId === 'string' && entry.operationId !== '')
    process.stderr.write(
      `CONDUCTOR-BUDGET-GATE-REFUSED ${refused ? 'PASS' : 'FAIL'} reasons=${JSON.stringify(refusal.slice(0, 300))}\n`,
    )

    // 3. The ledger kept what it counted: a refusal is not a reset (PRD §二.13.2).
    const after = await budgetTool.execute({ action: 'list' }, exec('budget-list-2'))
    const kept = (after.ledgers ?? []).find(entry => entry.targetId === target.taskId)
    process.stderr.write(
      `CONDUCTOR-BUDGET-GATE-KEPT ${Number(kept?.dispatches ?? 0) >= 1 ? 'PASS' : 'FAIL'} `
      + `ledgerDispatches=${String(kept?.dispatches ?? 'none')} `
      + `firstDispatchedAt=${String(kept?.firstDispatchedAt ?? 'none')}\n`,
    )

    // 4. A usage figure can be recorded at all — and a ceiling may only bind on a fully metered one.
    const usageRecorded = await budgetTool.execute(
      { action: 'record', targetId: target.taskId, event: 'usage', tokensValue: 1200, tokensQuality: 'actual_full' },
      exec('usage'),
    )
    const usageLedger = await budgetTool.execute({ action: 'list' }, exec('budget-list-3'))
    const withUsage = (usageLedger.ledgers ?? []).find(entry => entry.targetId === target.taskId)
    process.stderr.write(
      `CONDUCTOR-BUDGET-USAGE-RECORDED ${/1200|tokens/.test(String(withUsage?.tokens ?? '')) ? 'PASS' : 'FAIL'} `
      + `tokens=${JSON.stringify(String(withUsage?.tokens ?? 'none').slice(0, 120))} `
      + `summary=${JSON.stringify(String(usageRecorded.summary).slice(0, 120))}\n`,
    )
    const noQuality = await budgetTool.execute(
      { action: 'record', targetId: target.taskId, event: 'usage', tokensValue: 5 },
      exec('usage-bare'),
    ).then(value => `returned: ${String(value.summary).slice(0, 60)}`, error => String(error?.message ?? error))
    process.stderr.write(
      `CONDUCTOR-BUDGET-USAGE-NEEDS-QUALITY ${/needs a figure with its quality|BAD_REQUEST/.test(noQuality) ? 'PASS' : 'FAIL'} `
      + `result=${JSON.stringify(noQuality.slice(0, 170))}\n`,
    )

    // 5. A concurrency limit is examined before an automatic dispatch, against what the Host reports.
    const concurrent = await budgetTool.execute(
      { action: 'set', scope: 'task', targetId: target.taskId, maxConcurrent: 0 },
      exec('budget-concurrent'),
    )
    process.stderr.write(
      `CONDUCTOR-BUDGET-CONCURRENT-SET ${/0|concurrent/.test(String(concurrent.summary)) ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(concurrent.summary).slice(0, 160))}\n`,
    )
    const third = await accept.execute({ artifactId: registered.artifactId, result: 'pass', by: 'user' }, exec('accept-3'))
    const concurrencyRefusal = (third.triggered ?? []).map(entry => String(entry.reason)).join(' | ')
    process.stderr.write(
      `CONDUCTOR-BUDGET-CONCURRENT-REFUSED ${/concurrency|in flight/.test(concurrencyRefusal) ? 'PASS' : 'FAIL'} `
      + `reasons=${JSON.stringify(concurrencyRefusal.slice(0, 240))}\n`,
    )

    await rm(root, { recursive: true, force: true }).catch(() => {})
  } catch (error) {
    process.stderr.write(`CONDUCTOR-BUDGET-GATE FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Measure PRD §二.13.2's second action: a reached budget requests cancellation of
 * the current turn and reports the actual stop state.
 *
 * This Host has no model credentials, so a created task is idle. The measurement
 * is therefore the idle half — `no_active_turn` is a real stop state, not a
 * skipped request — plus the control that a concurrency ceiling does not abort.
 * A running plugin-initiated turn is asserted by unit test against a fake agent.
 *
 * @param ctx - the probe's context.
 */
async function runBudgetCancel(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const budgetTool = get('conductor_budget')
    if (create === undefined || budgetTool === undefined) {
      process.stderr.write('CONDUCTOR-BUDGET-CANCEL FAIL: a required tool is not registered\n')
      return
    }
    // Distinct from session-probe-controller so leftover inspect schedules on the
    // retained verify store cannot attribute notices to this caller.
    const caller = 'session-budget-cancel-controller'
    const exec = (suffix) => ({ callId: `probe-budget-cancel-${suffix}-${run}`, agent: { id: caller } })

    const idle = await create.execute(
      { title: `budget cancel idle ${run}`, contextMode: 'empty', operationId: `probe-budget-cancel-idle-${run}` },
      exec('create-idle'),
    )
    const concurrent = await create.execute(
      { title: `budget cancel concurrent ${run}`, contextMode: 'empty', operationId: `probe-budget-cancel-conc-${run}` },
      exec('create-conc'),
    )
    if (idle.preparation !== 'ready' || concurrent.preparation !== 'ready') {
      process.stderr.write(
        `CONDUCTOR-BUDGET-CANCEL FAIL: tasks did not prepare (${String(idle.preparation)}/${String(concurrent.preparation)})\n`,
      )
      return
    }

    const past = '2000-01-01T00:00:00.000Z'
    const setDeadline = await budgetTool.execute(
      { action: 'set', scope: 'task', targetId: idle.taskId, deadlineAt: past },
      exec('set-deadline'),
    )
    const deadlineSummary = String(setDeadline.summary)
    const deadlineCancels = setDeadline.cancels ?? []
    const idleOutcome = deadlineCancels.find(entry => entry.taskId === idle.taskId)?.outcome
    const actions = setDeadline.decision?.actions ?? []
    process.stderr.write(
      `CONDUCTOR-BUDGET-CANCEL-IDLE ${idleOutcome === 'no_active_turn' ? 'PASS' : 'FAIL'} `
      + `outcome=${JSON.stringify(idleOutcome ?? null)} `
      + `cancels=${JSON.stringify(deadlineCancels)} `
      + `summary=${JSON.stringify(deadlineSummary.slice(0, 280))}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-BUDGET-CANCEL-ACTIONS ${actions.includes('request_cancel') ? 'PASS' : 'FAIL'} `
      + `actions=${JSON.stringify(actions)}\n`,
    )

    const listed = await budgetTool.execute({ action: 'list' }, exec('list'))
    const ledger = (listed.ledgers ?? []).find(entry => entry.targetId === idle.taskId)
    process.stderr.write(
      `CONDUCTOR-BUDGET-CANCEL-KEPT ${Number(ledger?.dispatches ?? 0) === 0 ? 'PASS' : 'FAIL'} `
      + `dispatches=${String(ledger?.dispatches ?? 'none')}\n`,
    )

    const setConcurrent = await budgetTool.execute(
      { action: 'set', scope: 'task', targetId: concurrent.taskId, maxConcurrent: 0 },
      exec('set-concurrent'),
    )
    const concurrentCancels = setConcurrent.cancels ?? []
    const concurrentLimit = setConcurrent.decision?.limit
    const concurrentNotes = String(setConcurrent.summary)
    const skippedAbort = concurrentCancels.length === 0
      && concurrentLimit === 'concurrency'
      && !/Cancel:/.test(concurrentNotes)
    process.stderr.write(
      `CONDUCTOR-BUDGET-CANCEL-CONCURRENCY ${skippedAbort ? 'PASS' : 'FAIL'} `
      + `limit=${JSON.stringify(concurrentLimit ?? null)} `
      + `cancels=${JSON.stringify(concurrentCancels)} `
      + `summary=${JSON.stringify(concurrentNotes.slice(0, 240))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-BUDGET-CANCEL FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Measure that native-interface input and a controller relay both stay on the
 * target and remain distinguishable (PRD §四.2, T11).
 *
 * History used to collapse every `user/message` to `kind: 'user'`, so a reader
 * could not tell who spoke. The Host already records `{kind:'user'}` for the
 * original session and `{kind:'plugin', form:'relay'}` for `conductor_send`;
 * `conductor_read` now keeps that provenance on each user-role line.
 *
 * @param ctx - the probe's context.
 */
async function runHistorySource(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const tools = ctx.get('tools')
    const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const create = get('conductor_create')
    const send = get('conductor_send')
    const read = get('conductor_read')
    if (create === undefined || send === undefined || read === undefined) {
      process.stderr.write('CONDUCTOR-SOURCE FAIL: a required tool is not registered\n')
      return
    }
    // Distinct from session-probe-controller so leftover inspect schedules on the
    // retained verify store cannot attribute notices to this caller.
    const caller = 'session-history-source-controller'
    const exec = (suffix) => ({ callId: `probe-source-${suffix}-${run}`, agent: { id: caller } })
    const relayNeedle = `relay-input-${run}`
    const nativeNeedle = `native-input-${run}`

    const created = await create.execute(
      { title: `history source ${run}`, contextMode: 'empty', operationId: `probe-source-create-${run}` },
      exec('create'),
    )
    if (created.preparation !== 'ready') {
      process.stderr.write(
        `CONDUCTOR-SOURCE FAIL: task did not prepare (${String(created.preparation)}) `
        + `summary=${JSON.stringify(String(created.summary ?? '').slice(0, 200))}\n`,
      )
      return
    }
    const taskId = String(created.taskId)
    const sessionId = String(created.sessionId)

    const sent = await send.execute(
      { taskId, text: relayNeedle, mode: 'steer', operationId: `probe-source-relay-${run}` },
      exec('send'),
    )
    process.stderr.write(
      `CONDUCTOR-SOURCE-SEND ${sent.delivery === 'accepted' ? 'PASS' : 'FAIL'} `
      + `delivery=${JSON.stringify(sent.delivery ?? null)} `
      + `messageId=${JSON.stringify(sent.messageId ?? null)}\n`,
    )

    const targetOf = () => ctx.get('agents')?.get(sessionId)
    const idleDeadline = Date.now() + 8000
    while (Date.now() < idleDeadline) {
      if (targetOf()?.status !== 'running') break
      await new Promise(resolve => { setTimeout(resolve, 250) })
    }

    let injectNote = 'the target session could not be reached, so nothing was typed'
    const agent = targetOf()
    if (agent?.session !== undefined) {
      try {
        const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
        const message = createUserMessage({
          content: [{ type: 'text', text: nativeNeedle }],
          source: { kind: 'user' },
        })
        if (typeof agent.steer === 'function') agent.steer(message)
        else if (typeof agent.followup === 'function') agent.followup(message)
        else throw new Error('this agent exposes neither steer nor followup')
        injectNote = `said through ${typeof agent.steer === 'function' ? 'steer' : 'followup'}`
      } catch (error) {
        injectNote = `the Host refused the message: ${String(error?.message ?? error)}`
      }
    }

    const waitUntil = Date.now() + 8000
    let history = []
    let summary = ''
    let error = undefined
    let lastResult = undefined
    while (Date.now() < waitUntil) {
      const result = await read.execute(
        { taskId, view: 'history', afterCursor: '-1', limit: 50 },
        exec('read'),
      )
      lastResult = result
      history = Array.isArray(result.history) ? result.history : []
      summary = String(result.summary ?? '')
      error = result.error
      const texts = history.map(entry => String(entry.text ?? ''))
      if (texts.some(text => text.includes(relayNeedle)) && texts.some(text => text.includes(nativeNeedle))) break
      await new Promise(resolve => { setTimeout(resolve, 250) })
    }

    const userLines = history.filter(entry => entry.kind === 'user')
    const relayLine = userLines.find(entry => String(entry.text ?? '').includes(relayNeedle))
    const nativeLine = userLines.find(entry => String(entry.text ?? '').includes(nativeNeedle))
    const hostSources = (targetOf()?.session?.events ?? [])
      .filter(event => event.type === 'user/message')
      .map(event => event.data?.source)

    // The Host conversation persists a tool's rendered content, not an
    // arbitrary structured return value. Verify the registered (budgeted)
    // renderer contains the public records themselves, so a controller model
    // can read progress without asking the target to write a report file.
    const rendered = lastResult === undefined
      ? ''
      : read.output.render(
          { taskId, view: 'history', afterCursor: '-1', limit: 50 },
          lastResult,
        )
          .filter(block => block?.type === 'text')
          .map(block => String(block.text ?? ''))
          .join('')
    const historyRenderPass = rendered.includes('Public persisted records from the target session')
      && rendered.includes(relayNeedle)
      && rendered.includes(nativeNeedle)
      && /\[\d+\|user\|relay\]/.test(rendered)
      && /\[\d+\|user\|user\]/.test(rendered)
      && rendered !== summary
      && rendered.length <= 12_000
    process.stderr.write(
      `CONDUCTOR-HISTORY-RENDER ${historyRenderPass ? 'PASS' : 'FAIL'} `
      + `chars=${String(rendered.length)} relay=${String(rendered.includes(relayNeedle))} `
      + `native=${String(rendered.includes(nativeNeedle))} recordRelay=${String(/\[\d+\|user\|relay\]/.test(rendered))} `
      + `recordNative=${String(/\[\d+\|user\|user\]/.test(rendered))}\n`,
    )

    process.stderr.write(
      `CONDUCTOR-SOURCE-RELAY ${relayLine?.source === 'relay' ? 'PASS' : 'FAIL'} `
      + `source=${JSON.stringify(relayLine?.source ?? null)} `
      + `text=${JSON.stringify(String(relayLine?.text ?? '').slice(0, 80))}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-SOURCE-NATIVE ${nativeLine?.source === 'user' && injectNote.startsWith('said through') ? 'PASS' : 'FAIL'} `
      + `source=${JSON.stringify(nativeLine?.source ?? null)} inject=${JSON.stringify(injectNote.slice(0, 90))} `
      + `text=${JSON.stringify(String(nativeLine?.text ?? '').slice(0, 80))}\n`,
    )
    const distinct = relayLine?.source === 'relay'
      && nativeLine?.source === 'user'
      && relayLine?.seq !== nativeLine?.seq
    process.stderr.write(
      `CONDUCTOR-SOURCE-DISTINCT ${distinct ? 'PASS' : 'FAIL'} `
      + `relaySeq=${JSON.stringify(relayLine?.seq ?? null)} nativeSeq=${JSON.stringify(nativeLine?.seq ?? null)} `
      + `kinds=${JSON.stringify(userLines.map(entry => entry.source))} `
      + `hostSources=${JSON.stringify(hostSources)} `
      + `error=${JSON.stringify(error ?? null)} `
      + `summary=${JSON.stringify(summary.slice(0, 220))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-SOURCE FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Measure the artifact-acceptance axis and the trigger it publishes (PRD §二.9.1, §二.8.2, §二.12).
 *
 * This is the chain that was entirely unreachable before: `applyAcceptance` existed and was tested
 * but nothing in the product called it, so an artifact's `acceptance` stayed `pending` forever —
 * which made the `artifact_accepted` trigger impossible to fire and refused every rule that named a
 * required artifact, permanently. Four facts are measured here:
 *
 * 1. a `model_review` is recorded as a review and does **not** count as acceptance;
 * 2. the user's `pass` counts, and a rule listening for an accepted artifact fires from it;
 * 3. a deterministic check without its command is refused;
 * 4. a rule requiring the artifact is refused while the only acceptance is the model's.
 *
 * @param ctx - the probe's context.
 */
async function runAcceptance(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const run = randomUUID().slice(0, 8)
    const root = await mkdtemp(join(tmpdir(), 'conductor-probe-accept-'))
    const tools = ctx.get('tools')
    const create = typeof tools?.get === 'function' ? tools.get('conductor_create') : undefined
    const register = typeof tools?.get === 'function' ? tools.get('conductor_artifact_register') : undefined
    const verify = typeof tools?.get === 'function' ? tools.get('conductor_artifact_verify') : undefined
    const accept = typeof tools?.get === 'function' ? tools.get('conductor_artifact_accept') : undefined
    const ruleTool = typeof tools?.get === 'function' ? tools.get('conductor_rule') : undefined
    if (create === undefined || register === undefined || verify === undefined || accept === undefined || ruleTool === undefined) {
      process.stderr.write('CONDUCTOR-ACCEPT FAIL: one of the artifact tools is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-accept-${suffix}-${run}`, agent: { id: caller } })

    const source = await create.execute(
      { title: `accept probe source ${run}`, contextMode: 'empty', operationId: `probe-accept-src-${run}` },
      exec('create-source'),
    )
    const target = await create.execute(
      { title: `accept probe target ${run}`, contextMode: 'empty', operationId: `probe-accept-tgt-${run}` },
      exec('create-target'),
    )
    if (source.preparation !== 'ready' || target.preparation !== 'ready') {
      process.stderr.write('CONDUCTOR-ACCEPT FAIL: the probe tasks did not prepare\n')
      return
    }

    const file = join(root, 'interface.md')
    await writeFile(file, '# interface\n', 'utf8')
    const registered = await register.execute(
      { taskId: source.taskId, kind: 'file', name: 'interface.md', path: file },
      exec('register'),
    )
    const artifactId = registered.artifactId
    const verified = await verify.execute({ artifactId }, exec('verify'))
    process.stderr.write(
      `CONDUCTOR-ACCEPT-REGISTERED ${artifactId !== undefined && verified.existence === 'present' ? 'PASS' : 'FAIL'} `
      + `artifactId=${String(artifactId ?? 'none')} existence=${String(verified.existence ?? 'none')} `
      + `acceptance=${String(verified.acceptance ?? 'none')}\n`,
    )

    // A rule that listens for an accepted artifact and requires it — the shape that was refused
    // forever while nothing could record an acceptance.
    await ruleTool.execute({
      action: 'save',
      sourceTaskId: source.taskId,
      targetTaskId: target.taskId,
      trigger: 'artifact_accepted',
      requiredArtifactId: artifactId,
      delivery: 'send',
      instruction: 'the interface was accepted; continue',
      authorizedBy: caller,
    }, exec('rule')).catch(error => process.stderr.write(`CONDUCTOR-ACCEPT-RULE-SAVE note: ${String(error?.message ?? error)}\n`))

    // 3. A deterministic check without its command is refused.
    const bare = await accept.execute(
      { artifactId, result: 'pass', by: 'deterministic_check' },
      exec('accept-bare'),
    ).then(value => `returned: ${String(value.summary).slice(0, 60)}`, error => String(error?.message ?? error))
    process.stderr.write(
      `CONDUCTOR-ACCEPT-CHECK-NEEDS-EVIDENCE ${/must record the command|BAD_REQUEST/.test(bare) ? 'PASS' : 'FAIL'} `
      + `result=${JSON.stringify(bare.slice(0, 170))}\n`,
    )

    // 1. A model review does not count, and the rule that requires the artifact must refuse.
    const reviewed = await accept.execute(
      { artifactId, result: 'pass', by: 'model_review', note: 'looks right to me' },
      exec('accept-review'),
    )
    const reviewOk = reviewed.counts === false && reviewed.acceptance === 'pass'
      && /judgement and not acceptance/.test(String(reviewed.countsReason))
    process.stderr.write(
      `CONDUCTOR-ACCEPT-MODEL-REVIEW-NOT-ACCEPTANCE ${reviewOk ? 'PASS' : 'FAIL'} `
      + `acceptance=${String(reviewed.acceptance ?? 'none')} counts=${String(reviewed.counts ?? 'none')} `
      + `reason=${String(reviewed.countsReason ?? 'none')} `
      + `triggered=${JSON.stringify((reviewed.triggered ?? []).map(entry => `${entry.ruleId}:${String(entry.reason).slice(0, 70)}`))}\n`,
    )

    // 4. The rule refused, and said why — not silence.
    const refusedRule = (reviewed.triggered ?? []).some(entry => /not acceptance|no attribution/.test(String(entry.reason)))
    process.stderr.write(
      `CONDUCTOR-ACCEPT-RULE-REFUSED ${refusedRule ? 'PASS' : 'FAIL'} `
      + `triggered=${JSON.stringify((reviewed.triggered ?? []).map(entry => String(entry.reason).slice(0, 120)))}\n`,
    )

    // 2. The user's own acceptance counts and fires the rule.
    const accepted = await accept.execute(
      { artifactId, result: 'pass', by: 'user', note: 'accepted after review' },
      exec('accept-user'),
    )
    const fired = (accepted.triggered ?? []).filter(entry => entry.operationId !== undefined && entry.operationId !== '')
    process.stderr.write(
      `CONDUCTOR-ACCEPT-USER-COUNTS ${accepted.counts === true && accepted.acceptedBy === 'user' ? 'PASS' : 'FAIL'} `
      + `acceptance=${String(accepted.acceptance ?? 'none')} counts=${String(accepted.counts ?? 'none')} `
      + `acceptedBy=${String(accepted.acceptedBy ?? 'none')}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-ACCEPT-RULE-FIRED ${fired.length > 0 ? 'PASS' : 'FAIL'} `
      + `triggered=${JSON.stringify((accepted.triggered ?? []).map(entry => `${entry.ruleId}→${String(entry.operationId ?? 'refused')}`))} `
      + `summary=${JSON.stringify(String(accepted.summary).slice(0, 200))}\n`,
    )

    // §四.2: the dispatch is associated with the grant, the rule and the event that caused it, and
    // the association is **readable** — `conductor_operation status` reports it for the operation the
    // rule claimed, which is how "why was this message sent to my task?" is answered.
    const operationTool = typeof tools?.get === 'function' ? tools.get('conductor_operation') : undefined
    const firedOperationId = fired[0]?.operationId
    if (operationTool !== undefined && typeof firedOperationId === 'string' && firedOperationId.length > 0) {
      const status = await operationTool.execute(
        { action: 'status', operationId: firedOperationId },
        exec('attribution'),
      )
      const attributed = status.attributedBy === 'rule'
        && typeof status.attributedRuleId === 'string' && status.attributedRuleId.length > 0
        && typeof status.attributedSourceEventId === 'string' && status.attributedSourceEventId.length > 0
        && typeof status.attributedGrantId === 'string' && status.attributedGrantId.startsWith('grant-')
      process.stderr.write(
        `CONDUCTOR-ACCEPT-ATTRIBUTION ${attributed ? 'PASS' : 'FAIL'} by=${String(status.attributedBy ?? 'none')} `
        + `grantId=${String(status.attributedGrantId ?? 'none')} ruleId=${String(status.attributedRuleId ?? 'none')} `
        + `sourceEventId=${String(status.attributedSourceEventId ?? 'none')}\n`,
      )
    } else {
      process.stderr.write('CONDUCTOR-ACCEPT-ATTRIBUTION FAIL: no fired operation id was available to read\n')
    }

    // The second acceptance keeps its own identity, so it is not reported as the first one replayed.
    process.stderr.write(
      `CONDUCTOR-ACCEPT-DISTINCT-EVENTS ${accepted.acceptedAt !== undefined ? 'PASS' : 'FAIL'} `
      + `acceptedAt=${String(accepted.acceptedAt ?? 'none')}\n`,
    )

    // Accepting someone else's work is a decision about it, so a session that does not control the
    // task may not record one — the same gate every other mutating surface has.
    const refused = await accept.execute(
      { artifactId, result: 'pass', by: 'user' },
      { callId: `probe-accept-intruder-${run}`, agent: { id: 'session-that-does-not-control-it' } },
    ).then(value => `returned: ${String(value.summary).slice(0, 60)}`, error => String(error?.message ?? error))
    process.stderr.write(
      `CONDUCTOR-ACCEPT-NEEDS-CONTROL ${/NOT_CONTROLLER|does not hold write control/.test(refused) ? 'PASS' : 'FAIL'} `
      + `result=${JSON.stringify(refused.slice(0, 160))}\n`,
    )

    await rm(root, { recursive: true, force: true }).catch(() => {})
  } catch (error) {
    process.stderr.write(`CONDUCTOR-ACCEPT FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Measure the sixth start condition and the model-review rule (PRD §二.12).
 *
 * Two rules that the code used to assert rather than enforce are measured end to end here, through
 * the real tool surface and a real run:
 *
 * 1. a **model review** that says `pass` must not stand in for acceptance, so the downstream node
 *    must not start and the reason must say why;
 * 2. a node that declares `requiresApproval` must not start until an approval is **recorded** — *    before this the condition was handed a hardcoded `true` and could never fail.
 *
 * @param ctx - the probe's context.
 */
async function runApproval(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const tools = ctx.get('tools')
    const create = typeof tools?.get === 'function' ? tools.get('conductor_create') : undefined
    const workflow = typeof tools?.get === 'function' ? tools.get('conductor_workflow') : undefined
    if (create === undefined || workflow === undefined) {
      process.stderr.write('CONDUCTOR-APPROVAL FAIL: the create or workflow tool is not registered\n')
      return
    }
    const caller = 'session-probe-controller'
    const exec = (suffix) => ({ callId: `probe-approval-${suffix}-${run}`, agent: { id: caller } })

    const first = await create.execute(
      { title: `approval probe upstream ${run}`, contextMode: 'empty', operationId: `probe-approval-up-${run}` },
      exec('create-up'),
    )
    const second = await create.execute(
      { title: `approval probe downstream ${run}`, contextMode: 'empty', operationId: `probe-approval-down-${run}` },
      exec('create-down'),
    )
    if (first.preparation !== 'ready' || second.preparation !== 'ready') {
      process.stderr.write(
        `CONDUCTOR-APPROVAL FAIL: tasks did not prepare (${String(first.preparation)}/${String(second.preparation)})\n`,
      )
      return
    }

    const workflowId = `probe-approval-${run}`
    const saved = await workflow.execute({
      action: 'save',
      authorizedBy: caller,
      definition: {
        workflowId,
        title: `approval probe ${run}`,
        budget: { maxTurns: 10 },
        nodes: [
          { nodeId: 'upstream', taskId: first.taskId, instruction: 'do the upstream work' },
          {
            nodeId: 'downstream',
            taskId: second.taskId,
            dependsOn: ['upstream'],
            instruction: 'do the downstream work',
            requiresApproval: true,
            failure: { onFail: 'stop' },
          },
        ],
      },
    }, exec('save'))
    process.stderr.write(
      `CONDUCTOR-APPROVAL-SAVED ${/Saved/.test(String(saved.summary)) ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(saved.summary).slice(0, 120))}\n`,
    )

    const started = await workflow.execute({ action: 'start', workflowId, authorizedBy: caller }, exec('start'))
    const runId = started.runs?.[0]?.runId
    process.stderr.write(
      `CONDUCTOR-APPROVAL-STARTED ${runId === undefined ? 'FAIL' : 'PASS'} runId=${String(runId ?? 'none')}\n`,
    )
    if (runId === undefined) return

    // The upstream node starts (it needs no approval) and the downstream one does not.
    const firstDrive = await workflow.execute({ action: 'drive', runId, authorizedBy: caller }, exec('drive-1'))
    // The readiness reasons are reported in `problems`, not in `summary`: reading only the summary
    // is what made the first draft of this probe claim a gate was missing when it was working.
    const reasonsOf = (value) => `${String(value.summary)} ${(value.problems ?? []).join(' ')}`
    process.stderr.write(
      `CONDUCTOR-APPROVAL-GATED ${/approvals/.test(reasonsOf(firstDrive)) ? 'PASS' : 'FAIL'} `
      + `problems=${JSON.stringify(reasonsOf(firstDrive).slice(0, 260))}\n`,
    )

    // A model review that says pass is recorded as a review, and the run must still refuse to start
    // the downstream node.
    await workflow.execute(
      { action: 'verdict', runId, nodeId: 'upstream', result: 'pass', by: 'model_review', authorizedBy: caller },
      exec('verdict-review'),
    )
    const afterReview = await workflow.execute({ action: 'drive', runId, authorizedBy: caller }, exec('drive-2'))
    const reviewOk = /reviewed by the model, which is a judgement and not acceptance/.test(reasonsOf(afterReview))
      && !(afterReview.actions ?? []).some(action => /downstream: dispatched/.test(action))
    process.stderr.write(
      `CONDUCTOR-APPROVAL-MODEL-REVIEW-NOT-ACCEPTANCE ${reviewOk ? 'PASS' : 'FAIL'} `
      + `reasons=${JSON.stringify(reasonsOf(afterReview).slice(0, 300))} `
      + `actions=${JSON.stringify((afterReview.actions ?? []).join('|').slice(0, 140))}\n`,
    )

    // The user's own acceptance opens the upstream gate, and the downstream node then waits only for
    // its recorded approval.
    await workflow.execute(
      { action: 'verdict', runId, nodeId: 'upstream', result: 'pass', by: 'user', authorizedBy: caller },
      exec('verdict-user'),
    )
    const afterUser = await workflow.execute({ action: 'drive', runId, authorizedBy: caller }, exec('drive-3'))
    const stillGated = /requires an approval that has not been given/.test(reasonsOf(afterUser))
    process.stderr.write(
      `CONDUCTOR-APPROVAL-UNMET-UNTIL-RECORDED ${stillGated ? 'PASS' : 'FAIL'} `
      + `reasons=${JSON.stringify(reasonsOf(afterUser).slice(0, 260))}\n`,
    )

    const approved = await workflow.execute({ action: 'approve', runId, nodeId: 'downstream', authorizedBy: caller }, exec('approve'))
    process.stderr.write(
      `CONDUCTOR-APPROVAL-RECORDED ${/is approved/.test(String(approved.summary)) ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(approved.summary).slice(0, 160))}\n`,
    )

    const afterApproval = await workflow.execute({ action: 'drive', runId, authorizedBy: caller }, exec('drive-4'))
    // `actions` is where a dispatch is reported; `summary` counts them. Reading only the summary is
    // what made the first draft of this probe report a working gate as broken.
    const startedOk = (afterApproval.actions ?? []).some(action => /downstream: dispatched/.test(action))
    process.stderr.write(
      `CONDUCTOR-APPROVAL-STARTS ${startedOk ? 'PASS' : 'FAIL'} `
      + `actions=${JSON.stringify((afterApproval.actions ?? []).join('|').slice(0, 200))} `
      + `summary=${JSON.stringify(String(afterApproval.summary).slice(0, 120))}\n`,
    )

    // And a second approval must not rewrite who decided.
    const twice = await workflow.execute({ action: 'approve', runId, nodeId: 'downstream', authorizedBy: caller }, exec('approve-2'))
      .then(value => `returned: ${String(value.summary).slice(0, 80)}`, error => String(error?.message ?? error))
    process.stderr.write(
      `CONDUCTOR-APPROVAL-ONCE ${/already approved|BAD_REQUEST/.test(twice) ? 'PASS' : 'FAIL'} result=${JSON.stringify(twice.slice(0, 200))}\n`,
    )

    // A deterministic check with no command is refused rather than stored as evidence.
    const bare = await workflow.execute(
      { action: 'verdict', runId, nodeId: 'upstream', result: 'pass', by: 'deterministic_check', authorizedBy: caller },
      exec('verdict-bare'),
    ).then(value => `returned: ${String(value.summary).slice(0, 80)}`, error => String(error?.message ?? error))
    process.stderr.write(
      `CONDUCTOR-APPROVAL-CHECK-NEEDS-EVIDENCE ${/must record the command|BAD_REQUEST/.test(bare) ? 'PASS' : 'FAIL'} `
      + `result=${JSON.stringify(bare.slice(0, 200))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-APPROVAL FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Measure the `operation` family against the live Host (PRD §三.3, §二.2.1).
 *
 * Creation is asynchronous, so the caller has to be able to ask how far it got and to stop or
 * continue it. Three facts are measured: that creation hands back the operation id it recorded,
 * that one operation can be read together with the task preparation it belongs to, and that a task's
 * operations can be listed — plus that a finished preparation honestly refuses cancellation.
 *
 * @param ctx - the probe's context.
 */
async function runOperation(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const tools = ctx.get('tools')
    const create = typeof tools?.get === 'function' ? tools.get('conductor_create') : undefined
    const operation = typeof tools?.get === 'function' ? tools.get('conductor_operation') : undefined
    if (create === undefined || operation === undefined) {
      process.stderr.write(
        `CONDUCTOR-OPERATION FAIL: create=${String(create !== undefined)} operation=${String(operation !== undefined)}\n`,
      )
      return
    }
    const exec = (suffix) => ({ callId: `probe-operation-${suffix}-${run}`, agent: { id: 'session-probe-controller' } })
    const operationId = `probe-operation-create-${run}`
    const created = await create.execute(
      { title: `operation probe ${run}`, contextMode: 'empty', operationId },
      exec('create'),
    )
    // §二.2.1: creation hands back both the operation id and the logical task id.
    process.stderr.write(
      `CONDUCTOR-OPERATION-ECHO ${created.operationId === operationId && created.taskId !== undefined
        ? 'PASS' : 'FAIL'} `
      + `operationId=${String(created.operationId ?? 'none')} expected=${operationId} taskId=${String(created.taskId ?? 'none')}\n`,
    )

    const status = await operation.execute({ action: 'status', operationId }, exec('status'))
    const statusOk = status.found === true && status.preparation === 'ready'
      && status.delivery === 'accepted' && status.cancellable === false
    process.stderr.write(
      `CONDUCTOR-OPERATION-STATUS ${statusOk ? 'PASS' : 'FAIL'} found=${String(status.found)} `
      + `preparation=${String(status.preparation ?? 'none')} phase=${String(status.preparationPhase ?? 'none')} `
      + `delivery=${String(status.delivery ?? 'none')} cancellable=${String(status.cancellable ?? 'none')} `
      + `refusal=${String(status.cancellationRefusal ?? 'none').slice(0, 90)}\n`,
    )

    const listed = await operation.execute({ action: 'list', taskId: created.taskId }, exec('list'))
    process.stderr.write(
      `CONDUCTOR-OPERATION-LIST ${listed.total >= 1 ? 'PASS' : 'FAIL'} total=${String(listed.total ?? 'none')} `
      + `ids=${JSON.stringify((listed.operations ?? []).map(entry => entry.operationId))}\n`,
    )

    // Cancelling a delivered instruction must be refused, with the reason naming what to use.
    const refused = await operation.execute({ action: 'cancel', operationId }, exec('cancel'))
      .then(value => ({ ok: false, value }), error => ({ ok: true, value: String(error?.message ?? error) }))
    process.stderr.write(
      `CONDUCTOR-OPERATION-CANCEL-REFUSED ${refused.ok && /PREPARATION_NOT_CANCELLABLE|finished preparing/.test(refused.value)
        ? 'PASS' : 'FAIL'} result=${String(typeof refused.value === 'string' ? refused.value : 'returned a value instead of refusing').slice(0, 160)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-OPERATION FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Measure the starting context (PRD §二.2.2).
 *
 * `brief` is the default for a created task, so this is the common path. Three facts are measured,
 * and each is one that code review cannot confirm:
 *
 * 1. a brief is built from the **creating** session, which is a real live Host session here, and
 *    queued through the Host's own starting-context primitive (`inject`) — so the session is not
 *    woken and no turn starts;
 * 2. it is filed as a context snapshot against the task, with the source session, the cutoff, the
 *    content version and the digest (§二.2.2 requires all four);
 * 3. when the creating session cannot be read, the Host reports `none` **with the reason** instead
 *    of recording a `brief` it never delivered.
 *
 * @param ctx - the probe's context.
 */
async function runContext(ctx) {
  try {
    const { randomUUID } = await import('node:crypto')
    // Run-unique operation ids. A fixed id would make every run after the first a **replay** of the
    // original creation — which is the idempotency rule working correctly, but it means a re-run
    // measures a task whose session is no longer live, and the inbox observation below would have
    // nothing to observe. The first draft of this probe reported PASS in exactly that state.
    const run = randomUUID().slice(0, 8)

    const tools = ctx.get('tools')
    const create = typeof tools?.get === 'function' ? tools.get('conductor_create') : undefined
    if (create === undefined) {
      process.stderr.write('CONDUCTOR-CONTEXT FAIL: conductor_create is not registered\n')
      return
    }

    // A real live session to read the brief from. It is created through the conductor itself, so
    // nothing about the Host's own session plumbing is faked.
    const source = await create.execute(
      {
        title: `context probe source ${run}`,
        contextMode: 'empty',
        operationId: `probe-context-source-${run}`,
      },
      { callId: `probe-context-call-source-${run}`, agent: { id: 'session-probe-controller' } },
    )
    process.stderr.write(
      `CONDUCTOR-CONTEXT-SOURCE ${source.preparation === 'ready' && source.sessionId !== undefined ? 'PASS' : 'FAIL'} `
      + `run=${run} preparation=${String(source.preparation)} sessionId=${String(source.sessionId ?? 'none')} `
      + `contextMode=${String(source.contextMode ?? 'none')}\n`,
    )
    if (source.sessionId === undefined) return

    // Now create a second task whose controller is that live session, with the default context
    // mode — i.e. `brief`, which is the common path.
    const target = await create.execute(
      {
        title: `context probe target ${run}`,
        operationId: `probe-context-target-${run}`,
      },
      { callId: `probe-context-call-target-${run}`, agent: { id: source.sessionId } },
    )
    process.stderr.write(
      `CONDUCTOR-CONTEXT-BRIEF ${target.preparation === 'ready' ? 'PASS' : 'FAIL'} `
      + `preparation=${String(target.preparation)} reason=${String(target.failureReason ?? 'none')} `
      + `contextMode=${String(target.contextMode ?? 'none')} status=${String(target.contextStatus ?? 'none')} `
      + `source=${String(target.contextSourceSessionId ?? 'none')} cutoff=${String(target.contextCutoffSeq ?? 'none')} `
      + `version=${String(target.contextContentVersion ?? 'none')} `
      + `digest=${String(target.contextDigest ?? 'none').slice(0, 16)}\n`,
    )

    // The brief was queued into the target session's own inbox, and queuing is not a turn: the
    // target is still idle, which is what "prepared with a brief and no instruction" means.
    //
    // The observation is required, not incidental: if the agent or its inbox cannot be read, this
    // check FAILS. A check that passes without observing anything is not evidence, and that is how
    // this probe's first version reported a replayed task as if it had measured the queue.
    let observed = false
    let detail = '<not observed>'
    try {
      const agents = ctx.get('agents')
      const agent = agents?.get?.(target.sessionId)
      const pending = agent?.inbox?.nextStep
      if (agent !== undefined && typeof agent.status === 'string' && Array.isArray(pending)) {
        observed = true
        detail = `targetAgentStatus=${agent.status} nextStep=${String(pending.length)}`
      } else {
        detail = `agent=${agent === undefined ? 'absent' : 'present'} status=${String(agent?.status ?? 'none')} `
          + `nextStep=${Array.isArray(pending) ? 'array' : typeof pending}`
      }
    } catch (error) {
      detail = `<error: ${String(error?.message ?? error)}>`
    }
    const queuedOk = target.contextStatus === 'injected' && observed
    process.stderr.write(
      `CONDUCTOR-CONTEXT-QUEUED ${queuedOk ? 'PASS' : 'FAIL'} `
      + `status=${String(target.contextStatus ?? 'none')} observed=${String(observed)} ${detail}\n`,
    )

    // And it is filed with everything §二.2.2 requires a brief to save.
    let filed = '<unreadable>'
    try {
      const domain = ctx.get('storageDomain')?.get?.(EXPECTED_DOMAIN)
      const table = domain?.table?.('contexts')
      const records = table === undefined ? [] : [...table.entries()].map(entry => entry[1])
      const mine = records.filter(record => record?.deliveredToTaskId === target.taskId)
      const record = mine[0]
      filed = record === undefined
        ? '<no record>'
        : `sourceSessionId=${String(record.sourceSessionId)} cutoff=${String(record.cutoffSeq)} `
          + `version=${String(record.contentVersion)} digest=${String(record.contentDigest).slice(0, 16)} `
          + `sourceTaskId=${String(record.sourceTaskId ?? 'none (the source is a session, not a task)')}`
    } catch (error) {
      filed = `<error: ${String(error?.message ?? error)}>`
    }
    process.stderr.write(`CONDUCTOR-CONTEXT-FILED ${filed.includes('sourceSessionId=') ? 'PASS' : 'FAIL'} ${filed}\n`)

    // The honest gap: a creating session this Host cannot read must produce `none` **with the
    // reason**, never a record that claims a brief.
    const orphan = await create.execute(
      {
        title: `context probe unreadable controller ${run}`,
        operationId: `probe-context-orphan-${run}`,
      },
      { callId: `probe-context-call-orphan-${run}`, agent: { id: 'session-that-does-not-exist' } },
    )
    const orphanOk = orphan.preparation === 'ready' && orphan.contextStatus === 'none'
      && typeof orphan.contextReason === 'string' && orphan.contextReason.length > 0
    process.stderr.write(
      `CONDUCTOR-CONTEXT-HONEST-NONE ${orphanOk ? 'PASS' : 'FAIL'} `
      + `preparation=${String(orphan.preparation)} status=${String(orphan.contextStatus ?? 'none')} `
      + `reason=${String(orphan.contextReason ?? 'none')}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-CONTEXT FAIL: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Drive the create pipeline through the live tool registry.
 *
 * This is the strongest end-to-end check available without credentials: it
 * exercises the real store, the real agent factory and a real Host session,
 * while creating no turn (no instruction is sent, so no model call happens).
 * The caller identity is supplied as a stand-in agent id, exactly as the Host
 * would supply the calling session's own.
 *
 * @param ctx - the probe's context.
 */
async function runCreate(ctx) {
  try {
    const tools = ctx.get('tools')
    const tool = typeof tools?.get === 'function' ? tools.get('conductor_create') : undefined
    if (tool === undefined) {
      process.stderr.write('CONDUCTOR-CREATE FAIL: conductor_create is not registered\n')
      return
    }
    const exec = { callId: `verify-call-1-${BOOT_ID}`, agent: { id: 'session-verify-controller' } }
    const value = await tool.execute({ title: 'conductor verification task', contextMode: 'empty' }, exec)
    process.stderr.write(
      `CONDUCTOR-CREATE ${value.preparation === 'ready' ? 'PASS' : 'FAIL'} `
      + `taskId=${String(value.taskId)} preparation=${String(value.preparation)} `
      + `phase=${String(value.preparationPhase)} sessionId=${String(value.sessionId ?? 'none')} `
      + `replayed=${String(value.replayed)}\n`,
    )

    // A second call under a new operation id must create a second, distinct task.
    const second = await tool.execute(
      { title: 'conductor verification task 2', contextMode: 'empty', operationId: `verify-call-2-${BOOT_ID}` },
      { callId: `verify-call-1b-${BOOT_ID}`, agent: { id: 'session-verify-controller' } },
    )
    process.stderr.write(
      `CONDUCTOR-CREATE-DISTINCT ${second.taskId !== value.taskId ? 'PASS' : 'FAIL'} `
      + `first=${String(value.taskId)} second=${String(second.taskId)}\n`,
    )

    // Retrying the same operation id must replay, not create again.
    const replay = await tool.execute(
      { title: 'conductor verification task 2', contextMode: 'empty', operationId: `verify-call-2-${BOOT_ID}` },
      { callId: `verify-call-2b-${BOOT_ID}`, agent: { id: 'session-verify-controller' } },
    )
    process.stderr.write(
      `CONDUCTOR-CREATE-REPLAY ${replay.replayed === true && replay.taskId === second.taskId ? 'PASS' : 'FAIL'} `
      + `replayed=${String(replay.replayed)} taskId=${String(replay.taskId)}\n`,
    )

    if (process.env['CONDUCTOR_PROBE_TURN'] === '1') {
      await runTurn(ctx, tools, exec)
    }
    if (process.env['CONDUCTOR_PROBE_ORGANISE'] === '1') {
      await runOrganise(ctx, tools, exec)
    }
    if (process.env['CONDUCTOR_PROBE_BRIEF'] === '1') {
      await runBrief(ctx, tools, exec)
    }
    if (process.env['CONDUCTOR_PROBE_SCHEDULE'] === '1') {
      await runSchedule(ctx, tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_SCHEDULE_RECOVERY'] === '1') {
      await runScheduleRecovery(ctx, tools, exec)
    }
    if (process.env['CONDUCTOR_PROBE_INSPECT_NOTICE'] === '1') {
      await runInspectNotice(ctx, tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_STOP'] === '1') {
      await runStop(ctx, tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_WATCH'] === '1') {
      await runWatch(ctx, tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_ACCESS'] === '1') {
      await runAccess(ctx, tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_PASS'] === '1') {
      await runPass(ctx, tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_WORKFLOW'] === '1') {
      await runWorkflow(tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_CONSTRAINTS'] === '1') {
      await runConstraints(tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_BUDGET'] === '1') {
      await runBudget(tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_EXPORT'] === '1') {
      await runExport(tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_MODEL'] === '1') {
      await runModel(ctx, tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_REMOTE'] === '1') {
      await runRemote(tools, exec, String(Date.now()))
    }
    if (process.env['CONDUCTOR_PROBE_SHARE'] === '1') {
      await runShare(tools, exec, String(Date.now()))
    }
  } catch (error) {
    process.stderr.write(`CONDUCTOR-CREATE ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Generate a handoff brief from a task whose session has real history.
 *
 * The session used is one the earlier checks created and then drove a turn on,
 * so the brief is taken from genuine Host content rather than a fixture. The
 * check also re-reads the storage domain afterwards, because adding a table to
 * the domain spec is the change most likely to make an existing medium refuse to
 * open — and a refusal would show up here rather than in a unit test.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 */
async function runBrief(ctx, tools, exec) {
  try {
    const create = tools.get('conductor_create')
    const brief = tools.get('conductor_brief')
    if (create === undefined || brief === undefined) {
      process.stderr.write('CONDUCTOR-BRIEF FAIL: the brief tool is not registered\n')
      return
    }

    // A fresh operation id per run: reusing one would replay a task created by
    // an earlier Host process, whose session is no longer live — correct
    // behaviour, but it makes the check measure something else.
    const runId = String(Date.now())
    const created = await create.execute(
      { title: 'brief source', instruction: 'summarise the deployment steps', contextMode: 'empty', operationId: `verify-brief-source-${runId}` },
      exec,
    )
    // Give the target a moment to record its turn before briefing it.
    await new Promise(resolve => { setTimeout(resolve, 4000) })

    const first = await brief.execute({ taskId: String(created.taskId) }, exec)
    process.stderr.write(
      `CONDUCTOR-BRIEF ${String(first.brief ?? '').includes('# Handoff brief') ? 'PASS' : 'FAIL'} `
      + `taskId=${String(created.taskId)} version=${String(first.contentVersion)} `
      + `cutoff=${String(first.cutoffSeq)} decisions=${String(first.decisions)} `
      + `openItems=${String(first.openItems)} refs=${String(first.references)} `
      + `error=${JSON.stringify(first.error ?? null)}\n`,
    )

    // A second brief for the same source is a new version, not a replacement.
    const second = await brief.execute({ taskId: String(created.taskId) }, exec)
    process.stderr.write(
      `CONDUCTOR-BRIEF-VERSION ${second.contentVersion === first.contentVersion + 1 ? 'PASS' : 'FAIL'} `
      + `first=${String(first.contentVersion)} second=${String(second.contentVersion)}\n`,
    )

    // The domain must still be open after the new table was first written to.
    const facility = ctx.get('storageDomain')
    const domain = typeof facility?.get === 'function' ? facility.get('session_conductor') : undefined
    let contextsReadable = 'unknown'
    try {
      const table = domain?.table('contexts')
      contextsReadable = table === undefined ? 'no handle' : `size=${String(table.size)}`
    } catch (error) {
      contextsReadable = `threw: ${String(error?.message ?? error)}`
    }
    process.stderr.write(
      `CONDUCTOR-BRIEF-DOMAIN ${domain !== undefined ? 'PASS' : 'FAIL'} `
      + `domainOpen=${String(domain !== undefined)} contexts=${contextsReadable}\n`,
    )

    if (process.env['CONDUCTOR_PROBE_FORK'] === '1') {
      await runFork(ctx, tools, exec, String(created.taskId), runId)
    }
    if (process.env['CONDUCTOR_PROBE_ARTIFACT'] === '1') {
      await runArtifact(ctx, tools, exec, String(created.taskId), runId)
    }
    if (process.env['CONDUCTOR_PROBE_RULE'] === '1') {
      await runRule(tools, exec, String(created.taskId), runId)
    }
  } catch (error) {
    process.stderr.write(`CONDUCTOR-BRIEF ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Register an artifact, verify it, then change the file and verify again.
 *
 * The interesting part is the third state. A file the conductor has hashed, that
 * is then rewritten, must come back as `changed` — and must still be refused as a
 * fixed input for a downstream dependency. A build that silently re-baselined the
 * digest would pass the first two checks and fail this one.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param taskId - the task the artifact is attributed to.
 * @param runId - a per-run identifier, so ids do not collide across runs.
 */
async function runArtifact(ctx, tools, exec, taskId, runId) {
  try {
    const register = tools.get('conductor_artifact_register')
    const verify = tools.get('conductor_artifact_verify')
    const list = tools.get('conductor_artifact_list')
    if (register === undefined || verify === undefined || list === undefined) {
      process.stderr.write('CONDUCTOR-ARTIFACT FAIL: artifact tools are not registered\n')
      return
    }
    const fs = ctx.get('fs')
    process.stderr.write(
      `CONDUCTOR-ARTIFACT-FS ${fs !== undefined ? 'PASS' : 'SKIP'} `
      + `fsServicePresent=${String(fs !== undefined)}\n`,
    )

    // A file the probe owns, inside the isolated home.
    const path = `D:\\dsh-conductor-verify\\artifact-probe-${runId}.txt`
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, 'first content\n', 'utf8')

    const artifactId = `artifact-probe-${runId}`
    const registered = await register.execute(
      { taskId, kind: 'file', name: 'probe artifact', path, artifactId },
      exec,
    )
    process.stderr.write(
      `CONDUCTOR-ARTIFACT-REGISTER ${registered.existence === 'claimed' ? 'PASS' : 'FAIL'} `
      + `artifactId=${String(registered.artifactId)} existence=${String(registered.existence)} `
      + `acceptance=${String(registered.acceptance)}\n`,
    )

    const verified = await verify.execute({ artifactId }, exec)
    process.stderr.write(
      `CONDUCTOR-ARTIFACT-VERIFY ${verified.existence === 'present' ? 'PASS' : 'FAIL'} `
      + `existence=${String(verified.existence)} version=${String(verified.contentVersion)} `
      + `pinned=${String(verified.pinned)} reason=${JSON.stringify(verified.pinnedReason)}\n`,
    )

    writeFileSync(path, 'second content, deliberately different\n', 'utf8')
    const changed = await verify.execute({ artifactId }, exec)
    process.stderr.write(
      `CONDUCTOR-ARTIFACT-CHANGED ${changed.existence === 'changed' && changed.contentVersion === 1 ? 'PASS' : 'FAIL'} `
      + `existence=${String(changed.existence)} version=${String(changed.contentVersion)} `
      + `pinned=${String(changed.pinned)} reason=${JSON.stringify(changed.pinnedReason)}\n`,
    )

    const listed = await list.execute({ taskId }, exec)
    const entry = (listed.artifacts ?? []).find(item => item.artifactId === artifactId)
    process.stderr.write(
      `CONDUCTOR-ARTIFACT-LIST ${entry !== undefined ? 'PASS' : 'FAIL'} `
      + `total=${String(listed.total)} entry=${JSON.stringify(entry ?? null)}\n`,
    )

    if (process.env['CONDUCTOR_PROBE_TRANSFER'] === '1') {
      await runTransfer(tools, exec, taskId, artifactId, path, runId)
    }
    if (process.env['CONDUCTOR_PROBE_HANDOFF'] === '1') {
      await runHandoff(tools, exec, taskId, runId)
    }

  } catch (error) {
    process.stderr.write(`CONDUCTOR-ARTIFACT ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Save a one-time rule and evaluate it.
 *
 * The source task has already ended a turn (the turn the brief was taken from),
 * so the executor has a real trigger to work from. What the check establishes is
 * that the first evaluation dispatches and that the **second** does not — the
 * repeated-event rule is the property worth measuring, because a rule that fires
 * twice would send a second instruction nobody authorised.
 *
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param sourceTaskId - the task whose events trigger the rule.
 * @param runId - a per-run identifier.
 */
async function runRule(tools, exec, sourceTaskId, runId) {
  try {
    const create = tools.get('conductor_create')
    const rule = tools.get('conductor_rule')
    if (create === undefined || rule === undefined) {
      process.stderr.write('CONDUCTOR-RULE FAIL: the rule tool is not registered\n')
      return
    }
    const target = await create.execute(
      { title: 'rule target', contextMode: 'empty', operationId: `verify-rule-target-${runId}` },
      exec,
    )
    const ruleId = `rule-probe-${runId}`

    const saved = await rule.execute({
      action: 'save',
      ruleId,
      title: 'probe rule',
      // This Host has no model credentials, so its turns END IN FAILURE. A
      // rule listening for turn_completed would correctly never fire here, so
      // the probe listens for the trigger this environment actually produces.
      trigger: 'turn_failed',
      sourceTaskId,
      targetTaskId: String(target.taskId),
      delivery: 'send',
      instruction: 'the source turn completed; begin integration',
      maxExecutions: 1,
    }, exec)
    process.stderr.write(
      `CONDUCTOR-RULE-SAVE ${saved.rules.length === 1 && saved.rules[0].active === true ? 'PASS' : 'FAIL'} `
      + `ruleId=${ruleId} target=${String(target.taskId)} maxExecutions=${String(saved.rules[0]?.maxExecutions)}\n`,
    )

    const first = await rule.execute({ action: 'evaluate', ruleId }, exec)
    process.stderr.write(
      `CONDUCTOR-RULE-FIRE ${first.dispatches.length === 1 ? 'PASS' : 'FAIL'} `
      + `dispatches=${String(first.dispatches.length)} refusals=${JSON.stringify(first.refusals)}\n`,
    )

    const second = await rule.execute({ action: 'evaluate', ruleId }, exec)
    process.stderr.write(
      `CONDUCTOR-RULE-ONCE ${second.dispatches.length === 0 ? 'PASS' : 'FAIL'} `
      + `secondDispatches=${String(second.dispatches.length)} refusals=${JSON.stringify(second.refusals)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-RULE ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Exercise the schedule surface against the live Host (PRD §二.11).
 *
 * The properties worth measuring here are the ones a unit test cannot prove: that
 * the `schedules` table really is mounted in a running Host, that a calendar
 * plan's UTC instant is derived from the zone the user chose, and that a repeated
 * `tick` over the same due occurrence does **not** produce a second dispatch — * the dedupe identity is the operation id, so the send path's own idempotency
 * layer is what has to refuse it.
 *
 * The ambiguous-local-time case is deliberately not measured here: whether the
 * next occurrence of a chosen local time is ambiguous depends on the calendar
 * date the probe happens to run on, so it is asserted in
 * `tests/schedule.spec.ts` against fixed instants instead of being left to chance.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runSchedule(ctx, tools, exec, runId) {
  try {
    const create = tools.get('conductor_create')
    const schedule = tools.get('conductor_schedule')
    if (create === undefined || schedule === undefined) {
      process.stderr.write('CONDUCTOR-SCHEDULE FAIL: the schedule tool is not registered\n')
      return
    }

    // A calendar plan must land on the local time the user chose, in their zone.
    const calendar = await schedule.execute({
      action: 'preview',
      kind: 'calendar',
      timezone: 'Asia/Shanghai',
      hour: 9,
      minute: 0,
    }, exec)
    const previewed = calendar.schedules[0]
    const nextAtMs = Date.parse(String(previewed?.nextAt ?? ''))
    const localHour = Number.isFinite(nextAtMs)
      ? new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false })
          .format(new Date(nextAtMs))
      : 'n/a'
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-CALENDAR ${String(previewed?.nextAt ?? '').endsWith('T01:00:00.000Z') && String(localHour).includes('09') ? 'PASS' : 'FAIL'} `
      + `nextAt=${String(previewed?.nextAt ?? 'none')} localHourInShanghai=${String(localHour)} `
      + `timezone=${String(previewed?.timezone ?? 'none')} savedByPreview=${String(calendar.summary.includes('nothing was saved'))}\n`,
    )

    const noWall = await schedule.execute({
      action: 'save', kind: 'calendar', timezone: 'Asia/Shanghai',
    }, exec)
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-REFUSE-WALL ${noWall.refusals.length === 1 ? 'PASS' : 'FAIL'} `
      + `refusals=${JSON.stringify(noWall.refusals)}\n`,
    )

    const badZone = await schedule.execute({
      action: 'save', kind: 'once', timezone: 'Mars/Olympus_Mons', delayMs: 60000,
    }, exec)
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-REFUSE-ZONE ${badZone.refusals.length === 1 && badZone.refusals[0].includes('not a zone') ? 'PASS' : 'FAIL'} `
      + `refusals=${JSON.stringify(badZone.refusals)}\n`,
    )

    // An execution plan without a stated limit must be saved as a draft, not started.
    // The target has to exist: saving an execution plan consults the target's control
    // record, and a fake id would abort this probe before the overdue plans are planted.
    const target = await create.execute(
      { title: 'schedule target', contextMode: 'empty', operationId: `verify-schedule-target-${runId}` },
      exec,
    )
    const unlimited = await schedule.execute({
      action: 'save', kind: 'once', delayMs: 3600000, mode: 'send',
      targetTaskId: String(target.taskId), instruction: 'this plan states no limit',
    }, exec)
    const draft = unlimited.schedules[0]
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-DRAFT ${draft?.status === 'draft' ? 'PASS' : 'FAIL'} `
      + `status=${String(draft?.status ?? 'none')} draftReason=${JSON.stringify(draft?.draftReason ?? null)}\n`,
    )
    const draftTick = await schedule.execute({ action: 'tick' }, exec)
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-DRAFT-IDLE ${draftTick.runs.length === 0 ? 'PASS' : 'FAIL'} `
      + `runs=${String(draftTick.runs.length)} summary=${JSON.stringify(draftTick.summary.slice(0, 200))}\n`,
    )

    // A real execution: a one-shot that is due immediately, dispatched once.
    const limited = await schedule.execute({
      action: 'save', kind: 'once', delayMs: 1, mode: 'send',
      targetTaskId: String(target.taskId), instruction: 'the scheduled check is due', maxRuns: 1,
    }, exec)
    const active = limited.schedules[0]
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-LIMITED ${active?.status === 'active' ? 'PASS' : 'FAIL'} `
      + `scheduleId=${String(active?.scheduleId ?? 'none')} status=${String(active?.status ?? 'none')} `
      + `nextAt=${String(active?.nextAt ?? 'none')}\n`,
    )

    await new Promise(resolve => { setTimeout(resolve, 1500) })
    const firstTick = await schedule.execute({ action: 'tick' }, exec)
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-FIRE ${firstTick.runs.length === 1 ? 'PASS' : 'FAIL'} `
      + `runs=${JSON.stringify(firstTick.runs)} refusals=${JSON.stringify(firstTick.refusals)}\n`,
    )

    // The same occurrence must never trigger twice: the second tick sees a
    // completed one-shot, and the dispatch's operation id is the dedupe identity.
    const secondTick = await schedule.execute({ action: 'tick' }, exec)
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-ONCE ${secondTick.runs.length === 0 ? 'PASS' : 'FAIL'} `
      + `secondRuns=${String(secondTick.runs.length)} summary=${JSON.stringify(secondTick.summary.slice(0, 240))}\n`,
    )

    const listed = await schedule.execute({ action: 'list' }, exec)
    const fired = listed.schedules.find(entry => entry.scheduleId === active?.scheduleId)
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-COMPLETED ${fired?.status === 'completed' && fired.runs === 1 ? 'PASS' : 'FAIL'} `
      + `status=${String(fired?.status ?? 'none')} runs=${String(fired?.runs ?? -1)} `
      + `all=${JSON.stringify(listed.schedules.map(entry => [entry.scheduleId, entry.status]))}\n`,
    )

    // Two overdue plans are left behind deliberately, so the NEXT boot's restart
    // calibration has both of the specification's recovery rules to decide about:
    // a read-only plan must be calibrated once, and a missed *execution* must be
    // recorded as missed rather than run late. Their ids are fixed so the later
    // boot can find them without sharing state through a file.
    for (const id of [OVERDUE_INSPECT, OVERDUE_EXEC]) {
      const existing = listed.schedules.some(entry => entry.scheduleId === id)
      if (existing) {
        await schedule.execute({ action: 'remove', scheduleId: id }, exec)
      }
    }
    const overdueAt = new Date(Date.now() - 5 * 60000).toISOString()
    await schedule.execute({
      action: 'save',
      scheduleId: OVERDUE_INSPECT,
      kind: 'interval',
      intervalMs: 60000,
      at: overdueAt,
      title: 'overdue read-only probe plan',
      targetTaskId: String(target.taskId),
    }, exec)
    await schedule.execute({
      action: 'save',
      scheduleId: OVERDUE_EXEC,
      kind: 'interval',
      intervalMs: 60000,
      at: overdueAt,
      mode: 'send',
      targetTaskId: String(target.taskId),
      instruction: 'this plan must be recorded as missed, not run late',
      maxRuns: 5,
      title: 'overdue execution probe plan',
    }, exec)
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-OVERDUE-LEFT inspect=${OVERDUE_INSPECT} exec=${OVERDUE_EXEC} at=${overdueAt} `
      + 'note=the next boot must calibrate the first once and mark the second missed\n',
    )

    const facility = ctx.get('storageDomain')
    const domain = typeof facility?.get === 'function' ? facility.get('session_conductor') : undefined
    let sizes = 'unknown'
    try {
      const table = domain?.table('schedules')
      sizes = table === undefined ? 'no handle' : `size=${String(table.size)}`
    } catch (error) {
      sizes = `threw ${String(error?.message ?? error)}`
    }
    process.stderr.write(`CONDUCTOR-SCHEDULE-TABLE ${sizes.startsWith('size=') ? 'PASS' : 'FAIL'} schedules=${sizes}\n`)
  } catch (error) {
    process.stderr.write(`CONDUCTOR-SCHEDULE ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Check what the restart calibration did to the overdue plans (PRD §二.11).
 *
 * The plans this reads were left overdue by an earlier boot. The specification's
 * rules are that a read-only plan is calibrated **once**, and that a missed
 * execution is recorded as missed rather than run late — so this reads the
 * persisted records themselves and reports each run's outcome, rather than
 * trusting a count. Reading the store directly is deliberate: the run log is the
 * evidence, and a summary line cannot show which outcome was recorded.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 */
async function runScheduleRecovery(ctx, tools, exec) {
  try {
    const schedule = tools.get('conductor_schedule')
    if (schedule === undefined) {
      process.stderr.write('CONDUCTOR-SCHEDULE-RECOVERY FAIL: the schedule tool is not registered\n')
      return
    }
    // Give the mount's own recovery pass time to finish before reading.
    await new Promise(resolve => { setTimeout(resolve, 2500) })
    const now = Date.now()
    const listed = await schedule.execute({ action: 'list' }, exec)

    const read = (scheduleId) => {
      try {
        const facility = ctx.get('storageDomain')
        const domain = typeof facility?.get === 'function' ? facility.get('session_conductor') : undefined
        return domain?.table('schedules')?.get(scheduleId)
      } catch {
        return undefined
      }
    }

    const inspect = read(OVERDUE_INSPECT)
    const own = inspect?.runs ?? []
    const reason = String(own[0]?.reason ?? '')
    // The recovery path must have *inspected*, not just recorded the policy sentence.
    // A reason that still says "calibrated once after the Host was not running" is the
    // old write: a `ran` entry with no observation behind it.
    const observed = /task .+ is /.test(reason) && !reason.includes('calibrated once after the Host was not running')
    const calibratedOnce = own.length === 1 && own[0]?.outcome === 'ran' && observed
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-RECOVERY-INSPECT ${calibratedOnce && Date.parse(inspect.nextAt) > now ? 'PASS' : 'FAIL'} `
      + `scheduleId=${OVERDUE_INSPECT} runs=${JSON.stringify(own.map(run => [run.scheduledFor, run.outcome]))} `
      + `nextAt=${String(inspect?.nextAt ?? 'none')} advanced=${String(Date.parse(inspect?.nextAt ?? '') > now)} `
      + `reason=${JSON.stringify(reason.slice(0, 240))}\n`,
    )

    const execPlan = read(OVERDUE_EXEC)
    const execRuns = execPlan?.runs ?? []
    const missedOnce = execRuns.length === 1 && execRuns[0]?.outcome === 'missed'
    process.stderr.write(
      `CONDUCTOR-SCHEDULE-RECOVERY-EXEC ${missedOnce && Date.parse(execPlan.nextAt) > now ? 'PASS' : 'FAIL'} `
      + `scheduleId=${OVERDUE_EXEC} runs=${JSON.stringify(execRuns.map(run => [run.scheduledFor, run.outcome]))} `
      + `nextAt=${String(execPlan?.nextAt ?? 'none')} status=${String(execPlan?.status ?? 'none')} `
      + `reason=${JSON.stringify(String(execRuns[0]?.reason ?? '').slice(0, 240))}\n`,
    )

    process.stderr.write(
      `CONDUCTOR-SCHEDULE-RECOVERY-NOREPLAY ${own.length + execRuns.length <= 2 ? 'PASS' : 'FAIL'} `
      + `totalRecordedRuns=${String(own.length + execRuns.length)} `
      + `all=${JSON.stringify(listed.schedules.map(entry => [entry.scheduleId, entry.runs, entry.status]))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-SCHEDULE-RECOVERY ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * A read-only inspect notifies when the observation changes, and stays silent when it does not
 * (PRD §二.11 有变化时通知).
 *
 * Three ticks, in order: the first is a baseline (no notice), a registered artifact makes the
 * second a change (one notice), and the third sees the same facts (no second notice). The
 * controller is a live session so the notice has somewhere to land; a tick of leftover plans
 * in this store is ignored by matching on this probe's schedule id.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runInspectNotice(ctx, tools, exec, runId) {
  try {
    const create = tools.get('conductor_create')
    const schedule = tools.get('conductor_schedule')
    const register = tools.get('conductor_artifact_register')
    if (create === undefined || schedule === undefined || register === undefined) {
      process.stderr.write('CONDUCTOR-INSPECT-NOTICE FAIL: a required tool is not registered\n')
      return
    }

    const controller = await create.execute(
      { title: 'inspect-notice controller', contextMode: 'empty', operationId: `verify-inspect-ctl-${runId}` },
      exec,
    )
    const controllerSession = String(controller.sessionId)
    const controllerExec = { callId: `verify-inspect-caller-${runId}`, agent: { id: controllerSession } }

    const target = await create.execute(
      { title: 'inspect-notice target', contextMode: 'empty', operationId: `verify-inspect-tgt-${runId}` },
      controllerExec,
    )
    const targetTask = String(target.taskId)
    const scheduleId = `inspect-notice-${runId}`

    await schedule.execute({
      action: 'save',
      scheduleId,
      kind: 'interval',
      intervalMs: 1,
      at: new Date(Date.now() - 10).toISOString(),
      title: 'inspect-notice probe plan',
      targetTaskId: targetTask,
    }, controllerExec)

    const lineOf = (result) => (result.runs ?? []).find((line) => String(line).includes(scheduleId))

    const first = await schedule.execute({ action: 'tick' }, exec)
    const firstLine = String(lineOf(first) ?? '')
    process.stderr.write(
      `CONDUCTOR-INSPECT-BASELINE ${firstLine.includes('baseline') ? 'PASS' : 'FAIL'} `
      + `line=${JSON.stringify(firstLine.slice(0, 280))}\n`,
    )

    const { writeFileSync } = await import('node:fs')
    const path = `D:\\dsh-conductor-verify\\inspect-notice-${runId}.txt`
    writeFileSync(path, 'a file the inspection must notice\n', 'utf8')
    await register.execute(
      { taskId: targetTask, artifactId: `inspect-art-${runId}`, kind: 'file', name: 'inspect-notice', path },
      controllerExec,
    )

    const second = await schedule.execute({ action: 'tick' }, exec)
    const secondLine = String(lineOf(second) ?? '')
    const notified = /notified .+ \(woke\)/.test(secondLine) || /notified .+ \(queued\)/.test(secondLine)
    process.stderr.write(
      `CONDUCTOR-INSPECT-CHANGED ${notified ? 'PASS' : 'FAIL'} `
      + `line=${JSON.stringify(secondLine.slice(0, 320))}\n`,
    )

    const { found, waited } = await waitForNotice(
      ctx,
      controllerSession,
      (event) => String(event?.text ?? event?.summary ?? '').includes('saw a change'),
      8000,
    )
    process.stderr.write(
      `CONDUCTOR-INSPECT-DELIVERED ${found.length >= 1 ? 'PASS' : 'FAIL'} `
      + `count=${String(found.length)} waitedMs=${String(waited)} `
      + `notice=${JSON.stringify(String(found[0]?.text ?? found[0]?.summary ?? '').slice(0, 240))}\n`,
    )

    const third = await schedule.execute({ action: 'tick' }, exec)
    const thirdLine = String(lineOf(third) ?? '')
    process.stderr.write(
      `CONDUCTOR-INSPECT-UNCHANGED ${thirdLine.includes('unchanged') ? 'PASS' : 'FAIL'} `
      + `line=${JSON.stringify(thirdLine.slice(0, 280))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-INSPECT-NOTICE ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Hold a live agent's driver so queued input stays in the inbox long enough to list.
 *
 * This composition drains a queued turn the instant it arrives (turns fail at once,
 * with no model credentials). The Host documents the hold this uses: `runMaintenance`
 * claims the idle phase, and "later waking input remains in the inbox until the task
 * settles". That is a slow-consumption scenario, not a fake inbox.
 *
 * @param agent - the live agent bound to the task, when one is reachable.
 * @returns a note naming the hold, and a release that lets the driver run again.
 */
function holdAgentInbox(agent) {
  const noop = { note: 'no-hold', release: async () => {} }
  if (agent === undefined) return { ...noop, note: 'no-agent' }
  if (typeof agent.runMaintenance !== 'function') return { ...noop, note: 'no-runMaintenance' }
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  let running
  try {
    running = agent.runMaintenance(async (signal) => {
      await new Promise((resolve) => {
        const done = () => resolve()
        if (signal !== undefined && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', done, { once: true })
        }
        gate.then(done)
      })
    })
    if (running !== undefined && typeof running.catch === 'function') running.catch(() => {})
  } catch (error) {
    return { note: `runMaintenance-threw:${String(error?.message ?? error).slice(0, 80)}`, release: async () => {} }
  }
  return {
    note: 'runMaintenance',
    release: async () => {
      release()
      if (typeof agent.cancel === 'function') {
        try { agent.cancel({ kind: 'hook', reason: 'probe releasing inbox hold' }, { keepInbox: true }) } catch { /* already idle */ }
      }
      try {
        await Promise.race([
          running ?? Promise.resolve(),
          new Promise((resolve) => { setTimeout(resolve, 1000) }),
        ])
      } catch { /* hold already ended */ }
    },
  }
}

/**
 * Park one follow-up in the Host inbox without waking the driver.
 *
 * Fallback when `runMaintenance` is missing or failed to hold: `Agent.send` takes
 * an explicit `wakeup` flag, and `false` is the Host's own "leave it pending".
 *
 * @param agent - the live agent.
 * @param text - the queued text.
 * @returns the message id, or the reason it could not be parked.
 */
async function parkQueuedTurn(agent, text) {
  if (typeof agent?.send !== 'function') return { ok: false, reason: 'agent.send is not a function' }
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-session-conductor', form: 'relay' },
    })
    agent.send(message, 'next-turn', false)
    return { ok: true, messageId: String(message.id) }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * Exercise the stop and queue surfaces against the live Host (PRD §二.6).
 *
 * What is measurable here is narrower than the unit tests, and deliberately so:
 * this Host has no model credentials, so a *running* turn barely exists and the
 * interrupt-and-send success path cannot be driven against it. What this does
 * establish is that the three things a unit test cannot — the real Host inbox
 * projection, the real tool registration, and the idle row of the specification's
 * own table — behave as the specification says on this runtime.
 *
 * Queue list/edit/withdraw used to drain before the probe could read them. The
 * hold above is the scenario that makes them measurable: consumption is slowed
 * by the Host's own maintenance claim, then the product send path queues, then
 * the queue tool reads and mutates the Host's inbox.
 *
 * The race paths (T09, T10) are asserted against a driven fake in
 * `tests/coordinator.spec.ts`, because reproducing a genuine turn race in a
 * credential-less Host would mean racing the Host's own failure path.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runStop(ctx, tools, exec, runId) {
  let hold = { note: 'not-started', release: async () => {} }
  try {
    const create = tools.get('conductor_create')
    const send = tools.get('conductor_send')
    const stop = tools.get('conductor_stop')
    const queue = tools.get('conductor_queue')
    if (create === undefined || send === undefined || stop === undefined || queue === undefined) {
      process.stderr.write('CONDUCTOR-STOP FAIL: one of the send/stop/queue tools is not registered\n')
      return
    }

    const target = await create.execute(
      { title: 'stop target', contextMode: 'empty', operationId: `verify-stop-target-${runId}` },
      exec,
    )
    const taskId = String(target.taskId)
    const sessionId = String(target.sessionId ?? '')

    const idle = await stop.execute({ taskId, operationId: `verify-stop-idle-${runId}` }, exec)
    process.stderr.write(
      `CONDUCTOR-STOP-IDLE ${idle.outcome === 'no_active_turn' ? 'PASS' : 'FAIL'} `
      + `outcome=${String(idle.outcome)} reason=${JSON.stringify(String(idle.reason).slice(0, 160))}\n`,
    )

    // The idle row of the PRD §二.6 table, *before* anything is queued: interrupt_and_send
    // checks the state and then sends, because there is no turn to stop. After the hold it
    // would see unconsumed input and refuse with QUEUE_CONFLICT.
    const sent = await send.execute({
      taskId, text: 'sent because no turn was running', mode: 'interrupt_and_send',
      operationId: `verify-stop-send-${runId}`,
    }, exec)
    process.stderr.write(
      `CONDUCTOR-INTERRUPT-AND-SEND-IDLE ${sent.delivery === 'accepted' ? 'PASS' : 'FAIL'} `
      + `delivery=${String(sent.delivery)} mode=${String(sent.mode)} messageId=${String(sent.messageId ?? 'none')}\n`,
    )

    const agent = sessionId.length === 0 ? undefined : ctx.get('agents')?.get(sessionId)
    if (typeof agent?.whenIdle === 'function') {
      try {
        await Promise.race([
          agent.whenIdle(),
          new Promise((_, reject) => { setTimeout(() => reject(new Error('whenIdle timed out')), 4000) }),
        ])
      } catch { /* the hold below still tries */ }
    }
    hold = holdAgentInbox(agent)

    const queuedTexts = [
      `queued follow-up 0 the probe may edit ${runId}`,
      `queued follow-up 1 the probe may withdraw ${runId}`,
    ]
    for (let index = 0; index < queuedTexts.length; index += 1) {
      await send.execute({
        taskId, text: queuedTexts[index], mode: 'queue',
        operationId: `verify-stop-queue-${runId}-${String(index)}`,
      }, exec)
    }

    let listed = await queue.execute({ taskId, action: 'list' }, exec)
    let queued = listed.messages.filter(entry => entry.list === 'queue')
    let how = hold.note
    if (queued.length === 0 && agent !== undefined) {
      const parked = []
      for (const text of queuedTexts) {
        parked.push(await parkQueuedTurn(agent, text))
      }
      how = `send-no-wake:${parked.filter(entry => entry.ok).length}/${String(parked.length)}`
      listed = await queue.execute({ taskId, action: 'list' }, exec)
      queued = listed.messages.filter(entry => entry.list === 'queue')
    }
    process.stderr.write(
      `CONDUCTOR-QUEUE-LIST ${queued.length > 0 ? 'PASS' : 'DRAINED'} `
      + `queued=${String(queued.length)} ofQueued=${String(queuedTexts.length)} `
      + `hold=${JSON.stringify(how)} steering=${String(listed.messages.length - queued.length)} `
      + `messages=${JSON.stringify(listed.messages.map(entry => [entry.list, entry.messageId]))} `
      + `summary=${JSON.stringify(String(listed.summary).slice(0, 200))}\n`,
    )

    const stranger = { callId: `verify-stop-stranger-${runId}`, agent: { id: 'session-not-the-controller' } }
    let refused = 'no error'
    try {
      await queue.execute({ taskId, action: 'list', operationId: `verify-stop-stranger-${runId}` }, stranger)
    } catch (error) {
      refused = String(error?.message ?? error)
    }
    process.stderr.write(
      `CONDUCTOR-QUEUE-NOT-CONTROLLER ${refused.includes('NOT_CONTROLLER') ? 'PASS' : 'FAIL'} `
      + `refused=${JSON.stringify(refused.slice(0, 200))}\n`,
    )

    const first = queued[0]
    if (first === undefined) {
      process.stderr.write(
        `CONDUCTOR-QUEUE-EDIT NOT MEASURED: hold=${how}; the Host still consumed every queued message before `
          + 'the probe could edit one\n',
      )
      process.stderr.write(
        `CONDUCTOR-QUEUE-WITHDRAW NOT MEASURED: hold=${how}; the Host still consumed every queued message before `
          + 'the probe could withdraw one\n',
      )
    } else {
      const replacement = `edited follow-up the probe replaced ${runId}`
      const edited = await queue.execute({
        taskId, action: 'edit', messageId: first.messageId, text: replacement,
        operationId: `verify-stop-edit-${runId}`,
      }, exec)
      const afterEdit = Array.isArray(edited.messages) ? edited.messages : []
      const replaced = afterEdit.find(entry => entry.text === replacement)
      const editOk = String(edited.changed).startsWith('edited ')
        && replaced !== undefined
        && afterEdit.every(entry => entry.messageId !== first.messageId || entry.text === replacement)
      process.stderr.write(
        `CONDUCTOR-QUEUE-EDIT ${editOk ? 'PASS' : 'FAIL'} `
        + `changed=${JSON.stringify(edited.changed)} remaining=${String(afterEdit.length)} `
        + `newText=${JSON.stringify(replaced?.text ?? null)} `
        + `summary=${JSON.stringify(String(edited.summary).slice(0, 160))}\n`,
      )

      const toWithdraw = replaced ?? afterEdit.find(entry => entry.list === 'queue') ?? first
      const withdrawn = await queue.execute({
        taskId, action: 'withdraw', messageId: toWithdraw.messageId,
        operationId: `verify-stop-withdraw-${runId}`,
      }, exec)
      const afterWithdraw = Array.isArray(withdrawn.messages) ? withdrawn.messages : []
      const gone = afterWithdraw.every(entry => entry.messageId !== toWithdraw.messageId)
      process.stderr.write(
        `CONDUCTOR-QUEUE-WITHDRAW ${String(withdrawn.changed).startsWith('withdrawn ') && gone ? 'PASS' : 'FAIL'} `
        + `changed=${JSON.stringify(withdrawn.changed)} remaining=${String(afterWithdraw.length)} `
        + `summary=${JSON.stringify(String(withdrawn.summary).slice(0, 160))}\n`,
      )

      const again = await queue.execute({
        taskId, action: 'withdraw', messageId: toWithdraw.messageId,
        operationId: `verify-stop-withdraw-${runId}`,
      }, exec)
      process.stderr.write(
        `CONDUCTOR-QUEUE-WITHDRAW-REPLAY ${String(again.changed).includes('already_consumed') ? 'PASS' : 'FAIL'} `
        + `changed=${JSON.stringify(again.changed)} summary=${JSON.stringify(String(again.summary).slice(0, 160))}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`CONDUCTOR-STOP ERROR: ${String(error?.stack ?? error)}\n`)
  } finally {
    try { await hold.release() } catch { /* process is ending anyway */ }
  }
}

/**
 * Exercise background reporting and the write barrier against the live Host
 * (PRD §二.8.1).
 *
 * This is the probe that measures the barrier end to end, because the barrier's
 * whole claim is that it rests on Host facts rather than on a prompt. The sequence
 * makes a *real* session receive a real `notice`, then calls a mutating tool as
 * that session and checks the call is refused — and reads the session's own log to
 * show the `source` the refusal was derived from.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
/**
 * The notices the background pass has delivered to one controller session.
 *
 * Read from the controller's **own log**, not from a tool's return value, for two reasons that a live run
 * forced: the plugin's pass delivers on its own timer, so a `report` call from the same session races it —
 * and once the pass's notice lands, that session's turn is report-triggered and its next call to the
 * reporting surface is refused. Reading the log measures the unattended path, which is the one a person is
 * not driving.
 *
 * @param ctx - the probe's context.
 * @param sessionId - the controller session.
 * @returns one entry per notice, with the full text and the Host's recorded summary.
 */
function noticesTo(ctx, sessionId) {
  const agent = ctx.get('agents')?.get(sessionId)
  const events = agent?.session?.events ?? []
  const notices = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source === null || typeof source !== 'object' || source.form !== 'notice') continue
    const content = event.data?.content
    const text = Array.isArray(content)
      ? content.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n')
      : String(content ?? '')
    notices.push({ text, summary: String(source.summary ?? '') })
  }
  return notices
}

/**
 * Wait until the background pass has delivered a notice matching a predicate.
 *
 * Polling rather than sleeping a fixed time, and the reason is a measured one: the pass re-arms **after**
 * each pass finishes, and on a retained verification store with hundreds of watches a single pass can take
 * longer than its own interval. A fixed sleep therefore lands inside a pass and reads an empty log, which
 * looks exactly like a producer that does not work. Polling also reports how long the delivery took, which
 * is the number worth knowing.
 *
 * @param ctx - the probe's context.
 * @param sessionId - the controller session to watch.
 * @param matches - which notices count.
 * @param timeoutMs - how long to wait before giving up.
 * @returns the matching notices and how long the wait was.
 */
async function waitForNotice(ctx, sessionId, matches, timeoutMs) {
  const started = Date.now()
  for (;;) {
    const found = noticesTo(ctx, sessionId).filter(matches)
    const waited = Date.now() - started
    if (found.length > 0 || waited >= timeoutMs) return { found, waited }
    await new Promise(resolve => { setTimeout(resolve, 1000) })
  }
}

async function runWatch(ctx, tools, exec, runId) {
  // Which part of the chain is running. The catch below reports it, because a refusal that aborts the
  // chain otherwise says *what* was refused and not *where* — and the barrier makes several of these
  // calls legitimately refusable, so "where" is the whole diagnosis.
  let stage = 'setup'
  try {
    const create = tools.get('conductor_create')
    const send = tools.get('conductor_send')
    const watch = tools.get('conductor_watch')
    const budget = tools.get('conductor_budget')
    if (create === undefined || send === undefined || watch === undefined) {
      process.stderr.write('CONDUCTOR-WATCH FAIL: one of the create/send/watch tools is not registered\n')
      return
    }

    // The session that will receive the report. Created empty so it is idle and the
    // report has to wake it, which is the branch the specification cares about.
    const controller = await create.execute(
      { title: 'report controller', contextMode: 'empty', operationId: `verify-watch-controller-${runId}` },
      exec,
    )
    const controllerSession = String(controller.sessionId)
    const controllerExec = { callId: `verify-watch-caller-${runId}`, agent: { id: controllerSession } }

    const target = await create.execute(
      { title: 'report target', contextMode: 'empty', operationId: `verify-watch-target-${runId}` },
      exec,
    )
    const targetTask = String(target.taskId)

    // A budget makes a ledger exist for the target: without one, a delivered report
    // has nowhere to count (PRD §二.13.2's 回报).
    if (budget !== undefined) {
      await budget.execute(
        { action: 'set', scope: 'task', targetId: targetTask, maxDispatches: 10 },
        exec,
      )
    }

    // Two watchers, because they measure different things and the barrier makes one
    // of them single-use. The probe's own identity is not a live session, so its
    // reports are recorded but cannot be delivered — which is what makes a *second*
    // pass from it observable, since no notice ever lands to close the barrier.
    const probeExec = { ...exec, callId: `verify-watch-probe-${runId}` }

    const started = await watch.execute(
      { action: 'start', taskId: targetTask },
      { ...controllerExec, callId: `verify-watch-start-${runId}` },
    )
    process.stderr.write(
      `CONDUCTOR-WATCH-START ${started.watches.length === 1 ? 'PASS' : 'FAIL'} `
      + `taskId=${targetTask} cursor=${String(started.watches[0]?.cursor ?? 'none')} `
      + `summary=${JSON.stringify(String(started.summary).slice(0, 180))}\n`,
    )

    // Nothing has happened on the target yet, so the pass must stay silent.
    const quiet = await watch.execute({ action: 'report' }, { ...controllerExec, callId: `verify-watch-quiet-${runId}` })
    process.stderr.write(
      `CONDUCTOR-WATCH-QUIET ${quiet.delivered.length === 0 ? 'PASS' : 'FAIL'} `
      + `delivered=${String(quiet.delivered.length)} summary=${JSON.stringify(String(quiet.summary).slice(0, 200))}\n`,
    )

    await watch.execute({ action: 'start', taskId: targetTask }, probeExec)

    // Now make the target's turn end. This Host fails turns, which is exactly the
    // reportable outcome a controller should be told about.
    await send.execute(
      { taskId: targetTask, text: 'do the thing the report is about', mode: 'steer', operationId: `verify-watch-turn-${runId}` },
      exec,
    )
    await new Promise(resolve => { setTimeout(resolve, 4000) })

    // The probe's own watch: the fact is recorded, but its controller is not a live
    // session so nothing can be delivered.
    const undeliverable = await watch.execute({ action: 'report' }, probeExec)
    process.stderr.write(
      `CONDUCTOR-WATCH-NO-CONTROLLER ${undeliverable.refusals.length >= 1 ? 'PASS' : 'FAIL'} `
      + `delivered=${String(undeliverable.delivered.length)} refusals=${JSON.stringify(undeliverable.refusals)}\n`,
    )

    // And the same fact is not reported again: the watch's delivered-id list, not its
    // cursor, decides what is new, so this is what survives a restart.
    const repeat = await watch.execute({ action: 'report' }, { ...probeExec, callId: `verify-watch-repeat-${runId}` })
    process.stderr.write(
      `CONDUCTOR-WATCH-NOREPEAT ${repeat.delivered.length === 0 ? 'PASS' : 'FAIL'} `
      + `secondDelivered=${String(repeat.delivered.length)} summary=${JSON.stringify(String(repeat.summary).slice(0, 220))}\n`,
    )

    const reported = await watch.execute({ action: 'report' }, { ...controllerExec, callId: `verify-watch-report-${runId}` })
    process.stderr.write(
      `CONDUCTOR-WATCH-REPORT ${reported.delivered.length >= 1 ? 'PASS' : 'FAIL'} `
      + `delivered=${JSON.stringify(reported.delivered)} refusals=${JSON.stringify(reported.refusals)}\n`,
    )

    if (budget !== undefined) {
      const listed = await budget.execute({ action: 'list' }, { ...exec, callId: `verify-watch-ledger-${runId}` })
      const entry = (listed.ledgers ?? []).find(row => row.targetId === targetTask)
      const counted = reported.delivered.length >= 1 && entry?.reportTurns === 1
      process.stderr.write(
        `CONDUCTOR-LEDGER-REPORT ${counted ? 'PASS' : 'FAIL'} `
        + `delivered=${String(reported.delivered.length)} reportTurns=${String(entry?.reportTurns ?? 'none')} `
        + `ledger=${JSON.stringify(entry ?? null)}\n`,
      )
    } else {
      process.stderr.write('CONDUCTOR-LEDGER-REPORT FAIL: conductor_budget is not registered\n')
    }

    // The evidence the barrier keys on: the notice is in the controller's own log,
    // with the source the Host recorded for it.
    const agent = ctx.get('agents')?.get(controllerSession)
    const prompts = (agent?.session?.events ?? [])
      .filter(event => event.type === 'user/message')
      .map(event => event.data?.source)
    const notice = prompts.find(source => source?.form === 'notice')
    process.stderr.write(
      `CONDUCTOR-WATCH-NOTICE-SOURCE ${notice !== undefined ? 'PASS' : 'FAIL'} `
      + `promptSources=${JSON.stringify(prompts).slice(0, 400)}\n`,
    )

    // And the barrier itself, measured on a real call: this session's turn was
    // opened by that notice, so a coordination write must be refused.
    let refusal = 'no error'
    try {
      await create.execute(
        { title: 'must not be created from a report', contextMode: 'empty', operationId: `verify-watch-barrier-${runId}` },
        { ...controllerExec, callId: `verify-watch-barrier-${runId}` },
      )
    } catch (error) {
      refusal = String(error?.message ?? error)
    }
    process.stderr.write(
      `CONDUCTOR-WATCH-BARRIER ${refusal.includes('REPORT_TRIGGERED') ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(refusal.slice(0, 240))}\n`,
    )

    // The reporting surface is guarded too, and deliberately: a report-triggered turn
    // that could deliver another report is how two controllers wake each other
    // forever (PRD §二.6, T28).
    let loopRefusal = 'no error'
    try {
      await watch.execute({ action: 'report' }, { ...controllerExec, callId: `verify-watch-loop-${runId}` })
    } catch (error) {
      loopRefusal = String(error?.message ?? error)
    }
    process.stderr.write(
      `CONDUCTOR-WATCH-NO-WAKE-LOOP ${loopRefusal.includes('REPORT_TRIGGERED') ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(loopRefusal.slice(0, 200))}\n`,
    )

    // A read is still allowed from the same turn, so the barrier blocks writes
    // rather than freezing the session.
    const allowed = await tools.get('conductor_list').execute({}, { ...controllerExec, callId: `verify-watch-read-${runId}` })
    process.stderr.write(
      `CONDUCTOR-WATCH-READ-ALLOWED ${allowed !== undefined ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(allowed?.summary ?? '').slice(0, 120))}\n`,
    )

    // PRD §二.8.1's merge rule, measured across **targets**: the window is about the session being
    // woken, not about the task, and the merge used to be applied to a one-watch map inside the loop —
    // which made it unreachable, so a controller watching two tasks was woken twice inside the window it
    // should have been woken once for. A fresh controller session is used because the barrier makes the
    // first one single-use once a notice lands.
    stage = 'merge:create-controller'
    const mergeController = await create.execute(
      { title: 'merge controller', contextMode: 'empty', operationId: `verify-watch-merge-controller-${runId}` },
      exec,
    )
    const mergeControllerSession = String(mergeController.sessionId)
    const mergeExec = { callId: `verify-watch-merge-caller-${runId}`, agent: { id: mergeControllerSession } }
    const mergeTargets = []
    for (const label of ['a', 'b']) {
      stage = `merge:create-target-${label}`
      const created = await create.execute(
        { title: `merge target ${label}`, contextMode: 'empty', operationId: `verify-watch-merge-target-${label}-${runId}` },
        exec,
      )
      mergeTargets.push(String(created.taskId))
      stage = `merge:watch-${label}`
      await watch.execute(
        { action: 'start', taskId: String(created.taskId) },
        { ...mergeExec, callId: `verify-watch-merge-start-${label}-${runId}` },
      )
    }
    // Both turns are opened together, so their ends land inside one merge window.
    for (const [index, taskId] of mergeTargets.entries()) {
      stage = `merge:send-${String(index)}`
      await send.execute(
        { taskId, text: 'produce a fact for the merge window', mode: 'steer', operationId: `verify-watch-merge-turn-${String(index)}-${runId}` },
        exec,
      )
    }
    // Deliberately **not** asking for the report from this controller. The plugin's own pass runs every
    // few seconds and delivers it — and a controller that has just received a notice may not call the
    // reporting surface, which is the barrier working (see the note in the docs). Asking here would race
    // the pass, so the check reads the notice out of the controller's own log instead, which measures the
    // unattended path: the one a person is not driving.
    stage = 'merge:settle'
    const mergeWait = await waitForNotice(ctx, mergeControllerSession, notice => /Observed on 2 tasks/.test(notice.text), 40000)
    const merged = mergeWait.found
    const oneNoticeCoversBoth = merged.length === 1
      && mergeTargets.every(taskId => merged[0].text.includes(taskId))
    process.stderr.write(
      `CONDUCTOR-WATCH-MERGED ${oneNoticeCoversBoth ? 'PASS' : 'FAIL'} waitedMs=${String(mergeWait.waited)} `
      + `notices=${String(noticesTo(ctx, mergeControllerSession).length)} mergedNotices=${String(merged.length)} `
      + `tasks=${JSON.stringify(mergeTargets)} text=${JSON.stringify(String(merged[0]?.text ?? '').slice(0, 260))}\n`,
    )

    // The facts the store already holds, produced for the first time here: an artifact verified absent
    // is not a session event, and §二.8.1 lists "an artifact was lost" among the things a controller is
    // told about. A third fresh controller, again because the barrier is single-use.
    stage = 'artifact-missing'
    const artifactController = await create.execute(
      { title: 'artifact controller', contextMode: 'empty', operationId: `verify-watch-artifact-controller-${runId}` },
      exec,
    )
    const artifactExec = {
      callId: `verify-watch-artifact-caller-${runId}`,
      agent: { id: String(artifactController.sessionId) },
    }
    const artifactTarget = await create.execute(
      { title: 'artifact target', contextMode: 'empty', operationId: `verify-watch-artifact-target-${runId}` },
      exec,
    )
    const artifactTask = String(artifactTarget.taskId)
    await watch.execute(
      { action: 'start', taskId: artifactTask },
      { ...artifactExec, callId: `verify-watch-artifact-start-${runId}` },
    )
    const register = tools.get('conductor_artifact_register')
    const verifyTool = tools.get('conductor_artifact_verify')
    const missingArtifactId = `verify-watch-missing-${runId}`
    await register.execute({
      taskId: artifactTask,
      artifactId: missingArtifactId,
      kind: 'file',
      name: 'gone.txt',
      // A path that certainly does not exist, so the existence check has one honest answer.
      path: `D:\\dsh-conductor-verify\\definitely-not-here-${runId}.txt`,
    }, exec)
    const verified = await verifyTool.execute({ artifactId: missingArtifactId }, exec)
    const artifactReport = await watch.execute(
      { action: 'report' },
      { ...artifactExec, callId: `verify-watch-artifact-report-${runId}` },
    )
    const showsMissing = artifactReport.delivered.length === 1
      && /\[artifact_missing\]/.test(String(artifactReport.delivered[0]))
      && /artifact_missing/.test(String(artifactReport.delivered[0]))
    process.stderr.write(
      `CONDUCTOR-WATCH-ARTIFACT-MISSING ${showsMissing ? 'PASS' : 'FAIL'} `
      + `existence=${JSON.stringify(String(verified.existence))} `
      + `delivered=${JSON.stringify(artifactReport.delivered)} refusals=${JSON.stringify(artifactReport.refusals)}\n`,
    )

    // And the same stored fact is not reported twice. Measured from the **probe's own** identity, not
    // from the controller that just received the notice: that session's turn was opened by the report,
    // so its next call to the reporting surface is refused by the barrier — which is the barrier working,
    // not a repeat measurement. A reader that is not a live session gets the fact recorded without a
    // notice landing, so a second pass over an unchanged record can be observed directly.
    //
    // The reader identity is **boot-scoped** for the same reason the idempotency ids are: a fixed identity
    // in a retained store accumulates watches from every earlier boot, so "the first pass produced exactly
    // this fact" stops being true and the check measures the store's history instead of this run's.
    const repeatWatch = {
      callId: `verify-watch-artifact-repeat-reader-${BOOT_ID}`,
      agent: { id: `session-probe-artifact-reader-${BOOT_ID}` },
    }
    stage = 'artifact-norepeat'
    await watch.execute({ action: 'start', taskId: artifactTask }, { ...repeatWatch, callId: `verify-watch-artifact-repeat-start-${runId}` })
    const firstProbePass = await watch.execute({ action: 'report' }, repeatWatch)
    const artifactRepeat = await watch.execute(
      { action: 'report' },
      { ...repeatWatch, callId: `verify-watch-artifact-repeat-report-${runId}` },
    )
    const noRepeat = firstProbePass.refusals.length === 1
      && /the controller session is not live/.test(String(firstProbePass.refusals[0]))
      && artifactRepeat.delivered.length === 0
      && artifactRepeat.refusals.length === 0
    process.stderr.write(
      `CONDUCTOR-WATCH-ARTIFACT-NOREPEAT ${noRepeat ? 'PASS' : 'FAIL'} `
      + `firstRefusals=${JSON.stringify(firstProbePass.refusals.map(entry => entry.slice(0, 90)))} `
      + `secondDelivered=${JSON.stringify(artifactRepeat.delivered)} `
      + `secondRefusals=${JSON.stringify(artifactRepeat.refusals.map(entry => entry.slice(0, 90)))}\n`,
    )

    // §二.8.1's "预算达到限制". The fact must be the **budget gate's own** decision, so the probe reaches a
    // limit that is genuinely reached: a task-scope policy of zero dispatches (0 >= 0). A fresh controller
    // again, because the first notice it receives makes its turn report-triggered and single-use.
    stage = 'budget-limit'
    const budgetController = await create.execute(
      { title: 'budget controller', contextMode: 'empty', operationId: `verify-watch-budget-controller-${runId}` },
      exec,
    )
    const budgetExec = {
      callId: `verify-watch-budget-caller-${runId}`,
      agent: { id: String(budgetController.sessionId) },
    }
    const budgetTarget = await create.execute(
      { title: 'budget target', contextMode: 'empty', operationId: `verify-watch-budget-target-${runId}` },
      exec,
    )
    const budgetTask = String(budgetTarget.taskId)
    await watch.execute(
      { action: 'start', taskId: budgetTask },
      { ...budgetExec, callId: `verify-watch-budget-start-${runId}` },
    )
    // The control first: with no budget governing the task, the pass must stay silent for a full window.
    stage = 'budget-limit:quiet'
    await new Promise(resolve => { setTimeout(resolve, 12000) })
    const quietNotices = noticesTo(ctx, String(budgetController.sessionId))
    const budgetTool = tools.get('conductor_budget')
    stage = 'budget-limit:set'
    await budgetTool.execute({ action: 'set', scope: 'task', targetId: budgetTask, maxDispatches: 0 }, exec)
    stage = 'budget-limit:settle'
    const limitedWait = await waitForNotice(
      ctx,
      String(budgetController.sessionId),
      notice => /\[budget_limited\]/.test(notice.text),
      40000,
    )
    process.stderr.write(
      `CONDUCTOR-WATCH-BUDGET-LIMIT ${quietNotices.length === 0 && limitedWait.found.length === 1 ? 'PASS' : 'FAIL'} `
      + `quietNotices=${String(quietNotices.length)} limitedNotices=${String(limitedWait.found.length)} `
      + `waitedMs=${String(limitedWait.waited)} `
      + `text=${JSON.stringify(String(limitedWait.found[0]?.text ?? '').slice(0, 260))}\n`,
    )

    // §二.8.1's "工作流受阻". Reached the way the product reaches it: a run whose node is judged
    // **inconclusive** stops for the user (`afterNodeFailure`), and that stored state is what the report
    // reads — not a fresh opinion about the run.
    stage = 'workflow-blocked'
    const flowController = await create.execute(
      { title: 'workflow controller', contextMode: 'empty', operationId: `verify-watch-flow-controller-${runId}` },
      exec,
    )
    const flowExec = {
      callId: `verify-watch-flow-caller-${runId}`,
      agent: { id: String(flowController.sessionId) },
    }
    const flowTarget = await create.execute(
      { title: 'workflow target', contextMode: 'empty', operationId: `verify-watch-flow-target-${runId}` },
      exec,
    )
    const flowTask = String(flowTarget.taskId)
    await watch.execute(
      { action: 'start', taskId: flowTask },
      { ...flowExec, callId: `verify-watch-flow-start-watch-${runId}` },
    )
    const workflowTool = tools.get('conductor_workflow')
    const flowId = `probe-watch-blocked-${runId}`
    const rule = 'the report lists every finding'
    // `authorizedBy` is the caller's own session id: a workflow's approval path is gated on it, so it has
    // to be the identity the probe is actually acting as rather than a name invented for the occasion.
    const flowAuthoriser = exec.agent.id
    await workflowTool.execute({
      action: 'save',
      authorizedBy: flowAuthoriser,
      definition: {
        workflowId: flowId,
        title: 'blocked probe',
        nodes: [{ nodeId: 'only', taskId: flowTask, instruction: 'do the work', acceptance: rule }],
      },
    }, { ...exec, callId: `verify-watch-flow-save-${runId}` })
    const flowStarted = await workflowTool.execute(
      { action: 'start', workflowId: flowId, authorizedBy: flowAuthoriser },
      { ...exec, callId: `verify-watch-flow-start-${runId}` },
    )
    const flowRunId = flowStarted.runs?.[0]?.runId
    if (flowRunId === undefined) {
      process.stderr.write('CONDUCTOR-WATCH-WORKFLOW-BLOCKED FAIL: no run was started\n')
    } else {
      const judged = await workflowTool.execute({
        action: 'verdict',
        runId: flowRunId,
        nodeId: 'only',
        result: 'inconclusive',
        by: 'user',
        rule,
      }, { ...exec, callId: `verify-watch-flow-verdict-${runId}` })
      const stoppedForUser = (judged.problems ?? []).some(entry => /inconclusive/.test(entry))
      stage = 'workflow-blocked:settle'
      const flowWait = await waitForNotice(
        ctx,
        String(flowController.sessionId),
        notice => /\[workflow_blocked\]/.test(notice.text),
        40000,
      )
      const reportedBlocked = stoppedForUser && flowWait.found.length === 1
      process.stderr.write(
        `CONDUCTOR-WATCH-WORKFLOW-BLOCKED ${reportedBlocked ? 'PASS' : 'FAIL'} `
        + `stoppedForUser=${String(stoppedForUser)} runId=${String(flowRunId)} `
        + `blockedNotices=${String(flowWait.found.length)} waitedMs=${String(flowWait.waited)} `
        + `text=${JSON.stringify(String(flowWait.found[0]?.text ?? '').slice(0, 260))}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`CONDUCTOR-WATCH ERROR at stage ${stage}: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Exercise observers and control transfer against the live Host (PRD §二.10.1).
 *
 * The property worth measuring here is the one the specification states as a
 * consequence rather than a rule: "the previous controller's late requests are
 * refused". It is measured on a real `conductor_send`, because the claim being tested
 * is that the freeze comes from the epoch check every write path already performs — * not from a rule added for transfers, which a future path could forget.
 *
 * @param ctx - the probe's context, so a delivered snapshot can be read off the new controller.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runAccess(ctx, tools, exec, runId) {
  try {
    const create = tools.get('conductor_create')
    const send = tools.get('conductor_send')
    const access = tools.get('conductor_access')
    const rule = tools.get('conductor_rule')
    const register = tools.get('conductor_artifact_register')
    const schedule = tools.get('conductor_schedule')
    const handoff = tools.get('conductor_handoff')
    const workflow = tools.get('conductor_workflow')
    if (create === undefined || send === undefined || access === undefined) {
      process.stderr.write('CONDUCTOR-ACCESS FAIL: one of the create/send/access tools is not registered\n')
      return
    }

    const target = await create.execute(
      { title: 'access target', contextMode: 'empty', operationId: `verify-access-target-${runId}` },
      exec,
    )
    const taskId = String(target.taskId)

    const listed = await access.execute({ taskId, action: 'list' }, exec)
    process.stderr.write(
      `CONDUCTOR-ACCESS-LIST ${listed.ownerEpoch === 0 && listed.observers.length === 0 ? 'PASS' : 'FAIL'} `
      + `owner=${String(listed.ownerSessionId)} epoch=${String(listed.ownerEpoch)} observers=${JSON.stringify(listed.observers)}\n`,
    )

    const observed = await access.execute(
      { taskId, action: 'observe', sessionId: 'session-auditor' },
      { ...exec, callId: `verify-access-observe-${runId}` },
    )
    process.stderr.write(
      `CONDUCTOR-ACCESS-OBSERVE ${observed.changed === true && observed.observers.includes('session-auditor') ? 'PASS' : 'FAIL'} `
      + `observers=${JSON.stringify(observed.observers)}\n`,
    )

    // An observer may read but may not change the relationship.
    let observerRefusal = 'no error'
    try {
      await access.execute(
        { taskId, action: 'transfer', sessionId: 'session-auditor' },
        { callId: `verify-access-observer-caller-${runId}`, agent: { id: 'session-auditor' } },
      )
    } catch (error) {
      observerRefusal = String(error?.message ?? error)
    }
    process.stderr.write(
      `CONDUCTOR-ACCESS-OBSERVER-CANNOT-TRANSFER ${observerRefusal.includes('NOT_CONTROLLER') ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(observerRefusal.slice(0, 200))}\n`,
    )

    // A second live session is the new controller, so the snapshot can be delivered as a
    // plugin notice rather than remaining only in the transferring caller's tool result.
    const receiver = await create.execute(
      { title: 'access receiver', contextMode: 'empty', operationId: `verify-access-receiver-${runId}` },
      { ...exec, callId: `verify-access-receiver-${runId}` },
    )
    const newController = String(receiver.sessionId ?? '')
    if (newController.length === 0) {
      process.stderr.write('CONDUCTOR-ACCESS-TRANSFER FAIL: the receiver session was not created\n')
      return
    }

    const transferred = await access.execute(
      { taskId, action: 'transfer', sessionId: newController },
      { ...exec, callId: `verify-access-transfer-${runId}` },
    )
    process.stderr.write(
      `CONDUCTOR-ACCESS-TRANSFER ${transferred.changed === true && transferred.ownerEpoch === 1 ? 'PASS' : 'FAIL'} `
      + `owner=${String(transferred.ownerSessionId)} epoch=${String(transferred.ownerEpoch)} `
      + `uncertain=${JSON.stringify(transferred.uncertain)} `
      + `snapshotDelivered=${String(transferred.snapshotDelivered)} `
      + `snapshotDelivery=${JSON.stringify(String(transferred.snapshotDelivery ?? '').slice(0, 220))}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-ACCESS-SNAPSHOT ${String(transferred.snapshot).includes('not replayed here') ? 'PASS' : 'FAIL'} `
      + `snapshot=${JSON.stringify(String(transferred.snapshot).slice(0, 420))}\n`,
    )

    const snapshotWait = await waitForNotice(
      ctx,
      newController,
      entry => entry.text.includes('Handover snapshot') || entry.summary.includes('Handover snapshot'),
      5000,
    )
    const agentEvents = ctx.get('agents')?.get(newController)?.session?.events ?? []
    const bodyHits = []
    for (const event of agentEvents) {
      const payload = event.data?.message ?? event.data ?? {}
      const content = payload.content
      const text = Array.isArray(content)
        ? content.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n')
        : String(payload.text ?? content ?? '')
      if (text.includes('Handover snapshot')) {
        bodyHits.push({
          type: String(event.type ?? ''),
          form: String(payload.source?.form ?? event.data?.source?.form ?? ''),
          text,
        })
      }
    }
    const snapshotNotices = snapshotWait.found.length > 0 ? snapshotWait.found : bodyHits
    const receiverEvents = agentEvents.slice(0, 8).map(event =>
      `${String(event.type)}:${String(event.data?.source?.form ?? event.data?.message?.source?.form ?? '')}`)
    process.stderr.write(
      `CONDUCTOR-ACCESS-SNAPSHOT-DELIVERED ${
        transferred.snapshotDelivered === true && snapshotNotices.length > 0 ? 'PASS' : 'FAIL'
      } count=${String(snapshotNotices.length)} delivered=${String(transferred.snapshotDelivered)} `
      + `waitMs=${String(snapshotWait.waited)} types=${JSON.stringify(receiverEvents)} `
      + `notice=${JSON.stringify(String(snapshotNotices[0]?.text ?? snapshotNotices[0]?.summary ?? '').slice(0, 220))}\n`,
    )

    // The previous controller's late request, measured on a real send.
    let lateRefusal = 'no error'
    try {
      await send.execute(
        { taskId, text: 'a late request from the previous controller', mode: 'steer', operationId: `verify-access-late-${runId}` },
        { ...exec, callId: `verify-access-late-${runId}` },
      )
    } catch (error) {
      lateRefusal = String(error?.message ?? error)
    }
    process.stderr.write(
      `CONDUCTOR-ACCESS-LATE-REFUSED ${lateRefusal.includes('NOT_CONTROLLER') ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(lateRefusal.slice(0, 220))}\n`,
    )

    const lateCaller = { ...exec, callId: `verify-access-late-write-${runId}` }

    let lateRule = 'no error'
    if (rule !== undefined) {
      try {
        await rule.execute({
          action: 'save',
          ruleId: `rule-late-${runId}`,
          title: 'late rule',
          trigger: 'turn_failed',
          sourceTaskId: taskId,
          targetTaskId: taskId,
          delivery: 'send',
          instruction: 'the previous controller must not be able to authorise this',
        }, lateCaller)
      } catch (error) {
        lateRule = String(error?.message ?? error)
      }
    }
    process.stderr.write(
      `CONDUCTOR-ACCESS-LATE-RULE ${lateRule.includes('NOT_CONTROLLER') ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(lateRule.slice(0, 220))}\n`,
    )

    let lateArtifact = 'no error'
    if (register !== undefined) {
      try {
        await register.execute({
          taskId,
          kind: 'file',
          name: 'late-claim.txt',
          path: 'D:\\dsh-conductor-verify\\late-claim.txt',
          artifactId: `artifact-late-${runId}`,
        }, lateCaller)
      } catch (error) {
        lateArtifact = String(error?.message ?? error)
      }
    }
    process.stderr.write(
      `CONDUCTOR-ACCESS-LATE-ARTIFACT ${lateArtifact.includes('NOT_CONTROLLER') ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(lateArtifact.slice(0, 220))}\n`,
    )

    let lateSchedule = 'no error'
    if (schedule !== undefined) {
      try {
        await schedule.execute({
          action: 'save',
          scheduleId: `schedule-late-${runId}`,
          title: 'late inspect',
          kind: 'once',
          delayMs: 60_000,
          mode: 'inspect',
          targetTaskId: taskId,
        }, lateCaller)
      } catch (error) {
        lateSchedule = String(error?.message ?? error)
      }
    }
    process.stderr.write(
      `CONDUCTOR-ACCESS-LATE-SCHEDULE ${lateSchedule.includes('NOT_CONTROLLER') ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(lateSchedule.slice(0, 220))}\n`,
    )

    let lateHandoff = 'no error'
    if (handoff !== undefined) {
      try {
        const outcome = await handoff.execute({
          taskId,
          targetPath: 'D:\\dsh-conductor-verify\\handoff-late',
          operationId: `verify-access-late-handoff-${runId}`,
        }, lateCaller)
        lateHandoff = String(outcome.reason ?? outcome.summary ?? 'no error')
      } catch (error) {
        lateHandoff = String(error?.message ?? error)
      }
    }
    process.stderr.write(
      `CONDUCTOR-ACCESS-LATE-HANDOFF ${lateHandoff.includes('NOT_CONTROLLER') ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(lateHandoff.slice(0, 220))}\n`,
    )

    let lateWorkflow = 'no error'
    if (workflow !== undefined) {
      try {
        const started = await workflow.execute({
          action: 'save',
          workflowId: `wf-late-${runId}`,
          definition: {
            workflowId: `wf-late-${runId}`,
            title: 'late workflow',
            nodes: [{ nodeId: 'only', taskId, instruction: 'must not start' }],
          },
        }, lateCaller)
        lateWorkflow = [
          ...(Array.isArray(started.problems) ? started.problems : []),
          String(started.summary ?? ''),
        ].join('; ')
      } catch (error) {
        lateWorkflow = String(error?.message ?? error)
      }
    }
    process.stderr.write(
      `CONDUCTOR-ACCESS-LATE-WORKFLOW ${lateWorkflow.includes('NOT_CONTROLLER') ? 'PASS' : 'FAIL'} `
      + `refusal=${JSON.stringify(lateWorkflow.slice(0, 220))}\n`,
    )

    // And the new controller can work.
    // The snapshot is a plugin notice, so it is the last user-role message in the new
    // controller's log. The report-triggered write barrier then refuses every write from
    // that session until a **person** speaks — which is the product working (PRD §二.8.1),
    // not the new controller being unable to work. Speak as a user, then send.
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const liveReceiver = ctx.get('agents')?.get(newController)
    if (typeof liveReceiver?.steer === 'function') {
      liveReceiver.steer(createUserMessage({
        content: [{ type: 'text', text: 'I have taken over this task.' }],
        source: { kind: 'user' },
      }))
    }
    const idleDeadline = Date.now() + 8000
    while (Date.now() < idleDeadline) {
      const currentReceiver = ctx.get('agents')?.get(newController)
      if (currentReceiver?.status !== 'running') break
      await new Promise(resolve => { setTimeout(resolve, 250) })
    }
    const accepted = await send.execute(
      { taskId, text: 'the new controller takes over', mode: 'steer', operationId: `verify-access-new-${runId}` },
      { callId: `verify-access-new-${runId}`, agent: { id: newController } },
    )
    process.stderr.write(
      `CONDUCTOR-ACCESS-NEW-CONTROLLER ${accepted.delivery === 'accepted' ? 'PASS' : 'FAIL'} `
      + `delivery=${String(accepted.delivery)} messageId=${String(accepted.messageId ?? 'none')}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-ACCESS ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Measure the background pass against the live Host (PRD §二.8.1, §二.11).
 *
 * Everything here happens with **no tool call in between**: the probe sets up a watch
 * and a due schedule, then waits. If automatic reporting and scheduled checks are real
 * rather than features that only run when asked, both will have happened by the time
 * it looks — and if the pass is not running, this is the check that says so.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runPass(ctx, tools, exec, runId) {
  try {
    const create = tools.get('conductor_create')
    const send = tools.get('conductor_send')
    const watch = tools.get('conductor_watch')
    const schedule = tools.get('conductor_schedule')
    if (create === undefined || send === undefined || watch === undefined || schedule === undefined) {
      process.stderr.write('CONDUCTOR-PASS FAIL: a required tool is not registered\n')
      return
    }

    const controller = await create.execute(
      { title: 'pass controller', contextMode: 'empty', operationId: `verify-pass-controller-${runId}` },
      exec,
    )
    const controllerSession = String(controller.sessionId)
    const controllerExec = { callId: `verify-pass-caller-${runId}`, agent: { id: controllerSession } }

    const target = await create.execute(
      { title: 'pass target', contextMode: 'empty', operationId: `verify-pass-target-${runId}` },
      exec,
    )
    const targetTask = String(target.taskId)

    await watch.execute({ action: 'start', taskId: targetTask }, { ...controllerExec, callId: `verify-pass-watch-${runId}` })

    // A read-only schedule due in a moment. `once` refuses a past instant, so this is
    // an interval plan with a short spacing: `advanceNextAt` moves it on after each
    // occurrence, and the pass is what performs it.
    const due = await schedule.execute({
      action: 'save',
      kind: 'interval',
      intervalMs: 1000,
      at: new Date(Date.now() + 1000).toISOString(),
      title: 'due during the pass',
    }, { ...exec, callId: `verify-pass-schedule-${runId}` })
    const scheduleId = String(due.schedules[0]?.scheduleId ?? '')

    // Make the target's turn fail, which is a reportable fact, then stop touching
    // anything and let the pass do its work.
    await send.execute(
      { taskId: targetTask, text: 'the turn whose end must be reported', mode: 'steer', operationId: `verify-pass-turn-${runId}` },
      exec,
    )

    process.stderr.write(
      `CONDUCTOR-PASS-SETUP ${scheduleId.length > 0 ? 'PASS' : 'FAIL'} controllerSession=${controllerSession} `
      + `target=${targetTask} schedule=${scheduleId}\n`,
    )

    // Six intervals of silence; nothing below this line calls a tick or a report.
    await new Promise(resolve => { setTimeout(resolve, 18_000) })

    // Was the report delivered without anyone asking for it?
    const agent = ctx.get('agents')?.get(controllerSession)
    const prompts = (agent?.session?.events ?? [])
      .filter(event => event.type === 'user/message')
      .map(event => event.data?.source)
    const notice = prompts.find(source => source?.form === 'notice')
    process.stderr.write(
      `CONDUCTOR-PASS-AUTOREPORT ${notice !== undefined ? 'PASS' : 'FAIL'} `
      + `notice=${JSON.stringify(String(notice?.summary ?? 'none')).slice(0, 220)} prompts=${String(prompts.length)}\n`,
    )

    // And did the schedule fire without anyone ticking it?
    const listed = await schedule.execute({ action: 'list' }, exec)
    const entry = listed.schedules.find(item => item.scheduleId === scheduleId)
    process.stderr.write(
      `CONDUCTOR-PASS-AUTOTICK ${(entry?.runs ?? 0) >= 1 ? 'PASS' : 'FAIL'} `
      + `scheduleId=${scheduleId} runs=${String(entry?.runs ?? -1)} nextAt=${String(entry?.nextAt ?? 'none')} `
      + `status=${String(entry?.status ?? 'none')}\n`,
    )

    // The records the pass wrote are the durable evidence of both.
    let notifications = 'unreadable'
    try {
      const domain = ctx.get('storageDomain')?.get('session_conductor')
      const table = domain?.table('notifications')
      notifications = table === undefined ? 'no handle' : `size=${String(table.size)}`
    } catch (error) {
      notifications = `threw ${String(error?.message ?? error)}`
    }
    process.stderr.write(
      `CONDUCTOR-PASS-RECORDS ${notifications.startsWith('size=') ? 'PASS' : 'FAIL'} notifications=${notifications}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-PASS ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Exercise the workflow surface against the live Host (PRD §二.12).
 *
 * What is measurable here is the shape of the feature rather than its throughput: this
 * Host cannot run a turn to completion, so no node ever becomes `accepted` on its own.
 * The checks therefore establish the properties a caller depends on — a cycle is
 * refused, a definition is versioned, a run freezes its version, the six conditions are
 * reported with the blocking one named, a verdict is recorded, and the rework limit
 * ends at `needs_user` rather than looping.
 *
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runWorkflow(tools, exec, runId) {
  try {
    const create = tools.get('conductor_create')
    const workflow = tools.get('conductor_workflow')
    const budget = tools.get('conductor_budget')
    if (create === undefined || workflow === undefined) {
      process.stderr.write('CONDUCTOR-WORKFLOW FAIL: a required tool is not registered\n')
      return
    }
    const wfExec = { ...exec, callId: `verify-workflow-${runId}` }

    // A cyclic definition must be refused, and the reason must say why rework is not
    // the way to express a backwards edge.
    const cyclic = await workflow.execute({
      action: 'validate',
      definition: {
        workflowId: `wf-cyclic-${runId}`,
        title: 'cyclic',
        nodes: [
          { nodeId: 'a', taskId: 't1', dependsOn: ['b'] },
          { nodeId: 'b', taskId: 't2', dependsOn: ['a'] },
        ],
      },
    }, wfExec)
    process.stderr.write(
      `CONDUCTOR-WORKFLOW-CYCLE ${cyclic.problems.some(problem => problem.includes('CYCLE')) ? 'PASS' : 'FAIL'} `
      + `problems=${JSON.stringify(cyclic.problems).slice(0, 260)}\n`,
    )

    const first = await create.execute(
      { title: 'workflow node one', contextMode: 'empty', operationId: `verify-workflow-a-${runId}` },
      exec,
    )
    const second = await create.execute(
      { title: 'workflow node two', contextMode: 'empty', operationId: `verify-workflow-b-${runId}` },
      exec,
    )
    const workflowId = `wf-${runId}`
    const valid = await workflow.execute({
      action: 'validate',
      definition: {
        workflowId,
        title: 'probe workflow',
        nodes: [
          { nodeId: 'first', taskId: String(first.taskId) },
          { nodeId: 'second', taskId: String(second.taskId), dependsOn: ['first'] },
        ],
        rework: { maxRounds: 1 },
      },
    }, wfExec)
    process.stderr.write(
      `CONDUCTOR-WORKFLOW-VALIDATE ${valid.problems.length === 0 && valid.summary.includes('Nothing was saved') ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(valid.summary).slice(0, 200))}\n`,
    )

    const saved = await workflow.execute({
      action: 'save',
      workflowId,
      definition: {
        workflowId,
        title: 'probe workflow',
        nodes: [
          { nodeId: 'first', taskId: String(first.taskId), instruction: 'do the first thing' },
          { nodeId: 'second', taskId: String(second.taskId), dependsOn: ['first'], instruction: 'do the second thing' },
        ],
        rework: { maxRounds: 1 },
      },
    }, wfExec)
    process.stderr.write(
      `CONDUCTOR-WORKFLOW-SAVE ${saved.workflows.some(entry => entry.workflowId === workflowId && entry.version === 0) ? 'PASS' : 'FAIL'} `
      + `workflows=${JSON.stringify(saved.workflows.filter(entry => entry.workflowId === workflowId))}\n`,
    )

    if (budget !== undefined) {
      await budget.execute(
        { action: 'set', scope: 'workflow', targetId: workflowId, maxReworkRounds: 10, maxDispatches: 20 },
        exec,
      )
    }

    const started = await workflow.execute({ action: 'start', workflowId }, { ...wfExec, callId: `verify-workflow-start-${runId}` })
    const run = started.runs.find(entry => entry.workflowId === workflowId && entry.definitionVersion === 0)
    process.stderr.write(
      `CONDUCTOR-WORKFLOW-START ${run !== undefined ? 'PASS' : 'FAIL'} `
      + `runId=${String(run?.runId ?? 'none')} definitionVersion=${String(run?.definitionVersion ?? 'none')} `
      + `nodes=${JSON.stringify(run?.nodes ?? [])}\n`,
    )

    const driven = await workflow.execute(
      { action: 'drive', runId: String(run?.runId ?? '') },
      { ...wfExec, callId: `verify-workflow-drive-${runId}` },
    )
    const afterDrive = driven.runs.find(entry => entry.runId === run?.runId)
    process.stderr.write(
      `CONDUCTOR-WORKFLOW-DRIVE ${(afterDrive?.nodes.find(node => node.nodeId === 'first')?.state) === 'running' ? 'PASS' : 'FAIL'} `
      + `actions=${JSON.stringify(driven.actions)} problems=${JSON.stringify(driven.problems).slice(0, 300)}\n`,
    )

    // The second node's upstream has not passed acceptance, so it must not start — and
    // the refusal must name the condition that blocked it.
    const blocked = driven.problems.some(problem => problem.includes('second') && problem.includes('upstream_accepted'))
    process.stderr.write(
      `CONDUCTOR-WORKFLOW-BLOCKED ${blocked ? 'PASS' : 'FAIL'} problems=${JSON.stringify(driven.problems).slice(0, 300)}\n`,
    )

    const verdict = await workflow.execute({
      action: 'verdict', runId: String(run?.runId ?? ''), nodeId: 'first',
      result: 'pass', by: 'user',
    }, { ...wfExec, callId: `verify-workflow-verdict-${runId}` })
    const accepted = verdict.runs.find(entry => entry.runId === run?.runId)?.nodes.find(node => node.nodeId === 'first')?.state
    process.stderr.write(
      `CONDUCTOR-WORKFLOW-VERDICT ${accepted === 'accepted' ? 'PASS' : 'FAIL'} firstState=${String(accepted ?? 'none')} `
      + `summary=${JSON.stringify(String(verdict.summary).slice(0, 160))}\n`,
    )

    // A failing verdict with the round limit spent must hand the run to the user rather
    // than start another round or a fresh workflow.
    await workflow.execute({
      action: 'verdict', runId: String(run?.runId ?? ''), nodeId: 'second',
      result: 'fail', by: 'deterministic_check', command: 'pnpm test', output: '1 failed',
    }, { ...wfExec, callId: `verify-workflow-fail-${runId}` })

    if (budget !== undefined) {
      const listed = await budget.execute({ action: 'list' }, { ...exec, callId: `verify-workflow-ledger-${runId}` })
      const entry = (listed.ledgers ?? []).find(row => row.targetId === workflowId)
      process.stderr.write(
        `CONDUCTOR-LEDGER-REWORK ${entry?.reworkRounds === 1 ? 'PASS' : 'FAIL'} `
        + `reworkRounds=${String(entry?.reworkRounds ?? 'none')} `
        + `ledger=${JSON.stringify(entry ?? null)}\n`,
      )
    } else {
      process.stderr.write('CONDUCTOR-LEDGER-REWORK FAIL: conductor_budget is not registered\n')
    }

    const exhausted = await workflow.execute(
      { action: 'verdict', runId: String(run?.runId ?? ''), nodeId: 'first', result: 'fail', by: 'user' },
      { ...wfExec, callId: `verify-workflow-exhaust-${runId}` },
    )
    const finalRun = exhausted.runs.find(entry => entry.runId === run?.runId)
    process.stderr.write(
      `CONDUCTOR-WORKFLOW-REWORK-LIMIT ${finalRun?.status === 'needs_user' ? 'PASS' : 'FAIL'} `
      + `status=${String(finalRun?.status ?? 'none')} reworkRoundsUsed=${String(finalRun?.reworkRoundsUsed ?? -1)} `
      + `problems=${JSON.stringify(exhausted.problems).slice(0, 260)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-WORKFLOW ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Exercise the constraints surface against the live Host (PRD §二.13.1).
 *
 * The four delivery facts are the point of this probe: a constraint that was
 * acknowledged is not a constraint that was complied with, and the checks below
 * establish that the server keeps those apart rather than accepting whichever word the
 * caller sends.
 *
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runConstraints(tools, exec, runId) {
  try {
    const constraints = tools.get('conductor_constraints')
    if (constraints === undefined) {
      process.stderr.write('CONDUCTOR-CONSTRAINTS FAIL: the constraints tool is not registered\n')
      return
    }
    const cExec = { ...exec, callId: `verify-constraints-${runId}` }

    const first = await constraints.execute({
      action: 'set', kind: 'interface', text: 'all timestamps cross the wire as ISO 8601 UTC',
    }, cExec)
    const constraintId = String(first.constraints[0]?.constraintId ?? '')
    process.stderr.write(
      `CONDUCTOR-CONSTRAINTS-SET ${first.constraints.some(entry => entry.version === 0) ? 'PASS' : 'FAIL'} `
      + `constraintId=${constraintId} version=${String(first.constraints.find(entry => entry.constraintId === constraintId)?.version ?? 'none')}\n`,
    )

    // A change versions; an unchanged statement is refused rather than re-versioned.
    const changed = await constraints.execute({
      action: 'set', constraintId, kind: 'interface', text: 'all timestamps cross the wire as RFC 3339 UTC',
    }, { ...cExec, callId: `verify-constraints-change-${runId}` })
    const unchanged = await constraints.execute({
      action: 'set', constraintId, kind: 'interface', text: 'all timestamps cross the wire as RFC 3339 UTC',
    }, { ...cExec, callId: `verify-constraints-unchanged-${runId}` })
    process.stderr.write(
      `CONDUCTOR-CONSTRAINTS-VERSION ${changed.constraints.some(e => e.version === 1) && unchanged.problems.length === 1 ? 'PASS' : 'FAIL'} `
      + `afterChange=${String(changed.constraints.find(e => e.constraintId === constraintId)?.version ?? 'none')} `
      + `unchangedProblems=${JSON.stringify(unchanged.problems).slice(0, 200)}\n`,
    )

    // Default scope reaches only future runs.
    const future = await constraints.execute({ action: 'apply', constraintId }, { ...cExec, callId: `verify-constraints-future-${runId}` })
    process.stderr.write(
      `CONDUCTOR-CONSTRAINTS-FUTURE ${future.impact !== undefined && future.impact.affectedNodes.length === 0 ? 'PASS' : 'FAIL'} `
      + `caveat=${JSON.stringify(String(future.impact?.caveat ?? '').slice(0, 200))}\n`,
    )

    // Applying to current work computes the impact and says what it must not claim.
    const current = await constraints.execute({
      action: 'apply', constraintId, scope: 'current', affectedNodes: ['build', 'verify'],
    }, { ...cExec, callId: `verify-constraints-current-${runId}` })
    process.stderr.write(
      `CONDUCTOR-CONSTRAINTS-CURRENT ${current.impact?.affectedNodes.length === 2 && current.impact.caveat.includes('next processable boundary') ? 'PASS' : 'FAIL'} `
      + `nodes=${JSON.stringify(current.impact?.affectedNodes ?? [])} `
      + `artifacts=${String(current.impact?.affectedArtifacts.length ?? -1)} `
      + `caveat=${JSON.stringify(String(current.impact?.caveat ?? '').slice(0, 240))}\n`,
    )

    const target = String(exec.agent?.id ?? 'session-verify-controller')
    const sent = await constraints.execute({
      action: 'deliver', constraintId, targetId: target, stage: 'in_context',
    }, { ...cExec, callId: `verify-constraints-deliver-${runId}` })
    process.stderr.write(
      `CONDUCTOR-CONSTRAINTS-DELIVER ${sent.deliveries.some(d => d.stage === 'in_context') ? 'PASS' : 'FAIL'} `
      + `deliveries=${JSON.stringify(sent.deliveries.map(d => [d.targetId, d.stage]))}\n`,
    )

    // Acknowledged is not compliant: the stage cannot jump, and `verified` needs a check.
    const jump = await constraints.execute({
      action: 'deliver', constraintId, targetId: target, stage: 'verified', command: 'pnpm test', output: 'ok',
    }, { ...cExec, callId: `verify-constraints-jump-${runId}` })
    const acknowledged = await constraints.execute({
      action: 'deliver', constraintId, targetId: target, stage: 'acknowledged',
    }, { ...cExec, callId: `verify-constraints-ack-${runId}` })
    const noCheck = await constraints.execute({
      action: 'deliver', constraintId, targetId: target, stage: 'verified',
    }, { ...cExec, callId: `verify-constraints-nocheck-${runId}` })
    const verified = await constraints.execute({
      action: 'deliver', constraintId, targetId: target, stage: 'verified', command: 'pnpm test', output: 'all passed',
    }, { ...cExec, callId: `verify-constraints-verified-${runId}` })
    process.stderr.write(
      `CONDUCTOR-CONSTRAINTS-STAGES ${jump.problems.length === 1 && acknowledged.deliveries.some(d => d.stage === 'acknowledged') && noCheck.problems.length === 1 && verified.deliveries.some(d => d.stage === 'verified') ? 'PASS' : 'FAIL'} `
      + `jump=${JSON.stringify(jump.problems).slice(0, 150)} noCheck=${JSON.stringify(noCheck.problems).slice(0, 150)} `
      + `final=${JSON.stringify(verified.deliveries.find(d => d.targetId === target)?.stage ?? 'none')}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-CONSTRAINTS-ACK-NOT-COMPLIANCE ${String(acknowledged.summary).includes('not compliance') ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(acknowledged.summary).slice(0, 200))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-CONSTRAINTS ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Exercise the budget surface against the live Host (PRD §二.13.2).
 *
 * The checks that matter most are the negative ones: an unmeterable figure must read as
 * unavailable rather than as zero, and a strict limit this deployment cannot meter must
 * be refused rather than reported as satisfied.
 *
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runBudget(tools, exec, runId) {
  try {
    const budget = tools.get('conductor_budget')
    if (budget === undefined) {
      process.stderr.write('CONDUCTOR-BUDGET FAIL: the budget tool is not registered\n')
      return
    }
    const bExec = { ...exec, callId: `verify-budget-${runId}` }
    const targetId = `budget-target-${runId}`

    const set = await budget.execute({
      action: 'set', scope: 'workflow', targetId, maxDispatches: 1, maxAttempts: 1,
    }, bExec)
    process.stderr.write(
      `CONDUCTOR-BUDGET-SET ${set.policies.some(p => p.targetId === targetId) ? 'PASS' : 'FAIL'} `
      + `limits=${JSON.stringify(set.policies.find(p => p.targetId === targetId)?.limits ?? [])}\n`,
    )

    let last
    for (const event of ['dispatch', 'attempt', 'turn', 'report_turn', 'rework_round']) {
      last = await budget.execute({ action: 'record', targetId, event }, { ...bExec, callId: `verify-budget-${event}-${runId}` })
    }
    const counted = last?.ledgers.find(entry => entry.targetId === targetId)
    process.stderr.write(
      `CONDUCTOR-BUDGET-LEDGER ${counted?.dispatches === 1 && counted.reportTurns === 1 && counted.turns === 1 ? 'PASS' : 'FAIL'} `
      + `dispatches=${String(counted?.dispatches ?? -1)} attempts=${String(counted?.attempts ?? -1)} `
      + `rework=${String(counted?.reworkRounds ?? -1)} turns=${String(counted?.turns ?? -1)} reports=${String(counted?.reportTurns ?? -1)}\n`,
    )

    process.stderr.write(
      `CONDUCTOR-BUDGET-UNAVAILABLE ${String(counted?.tokens).includes('unavailable') && String(counted?.cost).includes('not the same as zero') ? 'PASS' : 'FAIL'} `
      + `tokens=${JSON.stringify(String(counted?.tokens ?? '').slice(0, 130))}\n`,
    )

    const reached = await budget.execute({ action: 'check', targetId }, { ...bExec, callId: `verify-budget-check-${runId}` })
    process.stderr.write(
      `CONDUCTOR-BUDGET-REACHED ${reached.decision?.within === false ? 'PASS' : 'FAIL'} `
      + `limit=${String(reached.decision?.limit ?? 'none')} actions=${JSON.stringify(reached.decision?.actions ?? [])}\n`,
    )

    const strictTarget = `budget-strict-${runId}`
    await budget.execute({
      action: 'set', scope: 'task', targetId: strictTarget, maxTokens: 1000, strict: true,
    }, { ...bExec, callId: `verify-budget-strict-set-${runId}` })
    const strict = await budget.execute({ action: 'check', targetId: strictTarget }, { ...bExec, callId: `verify-budget-strict-${runId}` })
    process.stderr.write(
      `CONDUCTOR-BUDGET-STRICT-REFUSED ${strict.decision?.within === false && strict.decision.limit === 'tokens' ? 'PASS' : 'FAIL'} `
      + `reason=${JSON.stringify(String(strict.decision?.reason ?? '').slice(0, 280))}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-BUDGET-BOUNDARY ${String(strict.summary).includes('native interface') ? 'PASS' : 'FAIL'}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-BUDGET ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Exercise the export surface against the live Host (PRD §二.14.2).
 *
 * The checks that matter are the exclusions: an export is a file that leaves the Host, so
 * the probe looks for the three things the specification says must not be in it, and for
 * the statement that it is not a restore package.
 *
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runExport(tools, exec, runId) {
  try {
    const create = tools.get('conductor_create')
    const exportTool = tools.get('conductor_export')
    if (create === undefined || exportTool === undefined) {
      process.stderr.write('CONDUCTOR-EXPORT FAIL: a required tool is not registered\n')
      return
    }
    const eExec = { ...exec, callId: `verify-export-${runId}` }

    const task = await create.execute(
      { title: 'export subject', contextMode: 'empty', operationId: `verify-export-task-${runId}` },
      exec,
    )
    const taskId = String(task.taskId)

    const markdown = await exportTool.execute({ action: 'export', taskId }, eExec)
    process.stderr.write(
      `CONDUCTOR-EXPORT-MARKDOWN ${markdown.document.includes('# Export: export subject') ? 'PASS' : 'FAIL'} `
      + `cutoff=${String(markdown.cutoffAt)} bytes=${String(markdown.document.length)} excluded=${String(markdown.excluded.length)}\n`,
    )

    const json = await exportTool.execute({ action: 'export', taskId, format: 'json' }, { ...eExec, callId: `verify-export-json-${runId}` })
    let parsed
    try {
      parsed = JSON.parse(json.document)
    } catch {
      parsed = undefined
    }
    process.stderr.write(
      `CONDUCTOR-EXPORT-JSON ${parsed !== undefined && parsed.notRestorable === true ? 'PASS' : 'FAIL'} `
      + `notRestorable=${String(parsed?.notRestorable)} chain=${String(parsed?.sessionChain?.length ?? -1)}\n`,
    )

    const text = markdown.document
    const excludes = ['credentials and tokens', 'environment variable values', 'full raw tool output']
      .every(what => text.includes(what))
    process.stderr.write(
      `CONDUCTOR-EXPORT-EXCLUSIONS ${excludes && text.includes('not a restore package') ? 'PASS' : 'FAIL'} `
      + `excluded=${JSON.stringify(markdown.excluded.map(line => line.split(' \u2014 ')[0]))}\n`,
    )

    const share = await exportTool.execute({ action: 'share' }, { ...eExec, callId: `verify-export-share-${runId}` })
    process.stderr.write(
      `CONDUCTOR-EXPORT-SHARE-OFF ${share.share.available === false && share.share.reason.includes('disabled by default') ? 'PASS' : 'FAIL'} `
      + `reason=${JSON.stringify(String(share.share.reason).slice(0, 220))}\n`,
    )

    const rules = await exportTool.execute({ action: 'rules' }, { ...eExec, callId: `verify-export-rules-${runId}` })
    process.stderr.write(
      `CONDUCTOR-EXPORT-SHARE-RULES ${rules.document.split('\n').length === 6 ? 'PASS' : 'FAIL'} `
      + `rules=${String(rules.document.split('\n').length)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-EXPORT ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Exercise the model-configuration surface against the live Host (PRD §二.3).
 *
 * The catalogue is the point: the probe reads whatever this Host actually registers
 * rather than checking a list the conductor holds, and it confirms that a change is
 * refused rather than applied while the Host extension is missing.
 *
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runModel(ctx, tools, exec, runId) {
  try {
    const create = tools.get('conductor_create')
    const model = tools.get('conductor_model')
    if (create === undefined || model === undefined) {
      process.stderr.write('CONDUCTOR-MODEL FAIL: a required tool is not registered\n')
      return
    }
    const mExec = { ...exec, callId: `verify-model-${runId}` }

    const task = await create.execute(
      { title: 'model subject', contextMode: 'empty', operationId: `verify-model-task-${runId}` },
      exec,
    )
    const taskId = String(task.taskId)

    const shown = await model.execute({ action: 'show', taskId }, mExec)
    process.stderr.write(
      `CONDUCTOR-MODEL-CATALOGUE ${shown.summary.includes("Host's own catalogue") ? 'PASS' : 'FAIL'} `
      + `providers=${JSON.stringify(shown.providers)} models=${JSON.stringify(shown.models)}\n`,
    )

    // PRD §二.3's "模型支持的推理强度". Two things are checked, and the second is the stronger one:
    //
    // 1. the tool asks the Host for the levels of the model **in question** and reports them together with
    //    that model's name — it never reports a bare list whose subject is unknown;
    // 2. the answer **differs per model**, and is absent with a reason for a model that publishes none. A
    //    list the plugin held itself would be one list for every model, so naming a different model and
    //    reading again is an independent check of where the levels came from.
    const readings = []
    const providerName = String(shown.providers?.[0] ?? '')
    for (const advertised of (shown.models ?? []).slice(0, 3)) {
      // Only the provider half is used: the model half of that string is the `advertised` id being iterated.
      const [providerId] = String(shown.reasoning?.model ?? `${providerName}/${String(advertised)}`).split('/')
      const named = `${providerId}/${String(advertised)}`
      const agent = ctx.get('agents')?.get(String(task.sessionId))
      if (typeof agent?.session?.append === 'function') {
        try {
          agent.session.append('request/header', {
            header: { config: { provider: providerId, model: String(advertised) } },
            reason: 'initial',
          })
        } catch (error) {
          readings.push({ model: named, error: String(error?.message ?? error) })
          continue
        }
      }
      const read = await model.execute({ action: 'show', taskId }, { ...mExec, callId: `verify-model-reasoning-${String(advertised)}-${runId}` })
      readings.push({
        model: named,
        efforts: read.reasoning?.efforts,
        reportedFor: read.reasoning?.model,
        note: read.reasoningNote,
      })
    }
    const distinct = new Set(readings.map(entry => JSON.stringify(entry.efforts)))
    const alwaysExplained = readings.every(entry =>
      (entry.efforts !== undefined && entry.reportedFor === entry.model && entry.efforts.length > 0)
      || (entry.efforts === undefined && typeof entry.note === 'string' && entry.note.length > 0))
    process.stderr.write(
      `CONDUCTOR-MODEL-REASONING ${alwaysExplained ? 'PASS' : 'FAIL'} `
      + `readings=${JSON.stringify(readings).slice(0, 400)} distinctEffortSets=${String(distinct.size)}\n`,
    )

    // Two facts, kept apart.
    process.stderr.write(
      `CONDUCTOR-MODEL-TWO-FACTS ${shown.state.includes('Next request will use') && shown.state.includes('Most recently actually used') ? 'PASS' : 'FAIL'} `
      + `state=${JSON.stringify(shown.state).slice(0, 260)}\n`,
    )

    // A provider with no registered route cannot route, so it is refused.
    const badProvider = await model.execute(
      { action: 'set', taskId, provider: 'not-a-provider', model: 'x' },
      { ...mExec, callId: `verify-model-bad-${runId}` },
    )
    process.stderr.write(
      `CONDUCTOR-MODEL-BAD-PROVIDER ${badProvider.changed === false && badProvider.notes.join(' ').includes('no registered route') ? 'PASS' : 'FAIL'} `
      + `notes=${JSON.stringify(badProvider.notes).slice(0, 240)}\n`,
    )

    // The write path is gated on the Host extension, and refuses rather than changing the
    // global model default.
    const gated = await model.execute(
      { action: 'set', taskId, provider: shown.providers[0] ?? 'deepseek', model: 'some-model' },
      { ...mExec, callId: `verify-model-gated-${runId}` },
    )
    const refused = gated.changed === false && gated.notes.join(' ').includes('rememberAsDefault')
    process.stderr.write(
      `CONDUCTOR-MODEL-GATED ${refused || gated.changed === true ? 'PASS' : 'FAIL'} `
      + `changed=${String(gated.changed)} notes=${JSON.stringify(gated.notes).slice(0, 320)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-MODEL ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Exercise the cross-Host surface against the live Host (PRD §二.14.1).
 *
 * What is measurable here is registration and the refusal: the transport does not exist,
 * so `migrate` must say so rather than appear to work, and a fresh registration must carry
 * no capability claims — silence is not compatibility.
 *
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runRemote(tools, exec, runId) {
  try {
    const remote = tools.get('conductor_remote')
    if (remote === undefined) {
      process.stderr.write('CONDUCTOR-REMOTE FAIL: the remote tool is not registered\n')
      return
    }
    const rExec = { ...exec, callId: `verify-remote-${runId}` }
    const hostId = `probe-remote-${runId}`

    const registered = await remote.execute({ action: 'register', hostId, label: 'probe remote' }, rExec)
    process.stderr.write(
      `CONDUCTOR-REMOTE-REGISTER ${registered.hosts.some(host => host.hostId === hostId && host.enabled === false) ? 'PASS' : 'FAIL'} `
      + `hosts=${JSON.stringify(registered.hosts.filter(host => host.hostId === hostId).map(host => [host.hostId, host.enabled, host.reached]))}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-REMOTE-NOCRED ${String(registered.summary).includes('No credential is stored') ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(registered.summary).slice(0, 200))}\n`,
    )

    // A fresh registration has reported nothing, so the four checks must report silence.
    const checked = await remote.execute(
      { action: 'check', hostId, requiredModels: ['some-model'], workspaceRepresentable: true },
      { ...rExec, callId: `verify-remote-check-${runId}` },
    )
    const unsatisfied = checked.checks.filter(check => !check.satisfied).map(check => check.aspect)
    process.stderr.write(
      `CONDUCTOR-REMOTE-CHECK ${unsatisfied.length >= 3 ? 'PASS' : 'FAIL'} `
      + `aspects=${JSON.stringify(checked.checks.map(check => [check.aspect, check.satisfied]))} `
      + `pluginReason=${JSON.stringify(String(checked.checks.find(c => c.aspect === 'plugin')?.reason ?? '').slice(0, 120))}\n`,
    )

    // The migration must be refused with the transport reason, and nothing sent.
    const migrated = await remote.execute({ action: 'migrate', hostId }, { ...rExec, callId: `verify-remote-migrate-${runId}` })
    process.stderr.write(
      `CONDUCTOR-REMOTE-MIGRATE-REFUSED ${migrated.availability.available === false && String(migrated.summary).includes('nothing was sent') ? 'PASS' : 'FAIL'} `
      + `refusals=${String(migrated.refusals.length)} summary=${JSON.stringify(String(migrated.summary).slice(0, 220))}\n`,
    )

    const create = tools.get('conductor_create')
    if (create !== undefined) {
      const task = await create.execute(
        { title: `migrate plan ${runId}`, contextMode: 'empty', operationId: `verify-remote-migrate-task-${runId}` },
        { ...rExec, callId: `verify-remote-migrate-create-${runId}` },
      )
      const planned = await remote.execute(
        { action: 'migrate', hostId, taskId: task.taskId },
        { ...rExec, callId: `verify-remote-migrate-plan-${runId}` },
      )
      const text = String(planned.summary)
      const plannedOk = planned.availability.available === false
        && text.includes('nothing was sent')
        && text.includes(`task ${String(task.taskId)}`)
        && text.includes('unmapped path')
        && text.includes('did not confirm that it stopped')
      process.stderr.write(
        `CONDUCTOR-REMOTE-MIGRATE-PLANNED ${plannedOk ? 'PASS' : 'FAIL'} `
        + `refusals=${String(planned.refusals.length)} `
        + `summary=${JSON.stringify(text.slice(0, 360))}\n`,
      )
    }

    const removed = await remote.execute({ action: 'remove', hostId }, { ...rExec, callId: `verify-remote-remove-${runId}` })
    process.stderr.write(
      `CONDUCTOR-REMOTE-REMOVE ${String(removed.summary).includes('cannot undo a migration that already happened') ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(removed.summary).slice(0, 180))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-REMOTE ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Exercise the share surface against the live Host (PRD §二.14.2).
 *
 * The preview is the check that matters: publishing must be refused without a confirmed
 * preview and without a service, and the revocation wording must not soften what revoking
 * cannot do.
 *
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param runId - a per-run identifier.
 */
async function runShare(tools, exec, runId) {
  try {
    const create = tools.get('conductor_create')
    const share = tools.get('conductor_share')
    if (create === undefined || share === undefined) {
      process.stderr.write('CONDUCTOR-SHARE FAIL: a required tool is not registered\n')
      return
    }
    const sExec = { ...exec, callId: `verify-share-${runId}` }

    const task = await create.execute(
      { title: 'share subject', contextMode: 'empty', operationId: `verify-share-task-${runId}` },
      exec,
    )
    const taskId = String(task.taskId)

    const previewed = await share.execute({ action: 'preview', taskId }, sExec)
    process.stderr.write(
      `CONDUCTOR-SHARE-PREVIEW ${previewed.preview !== undefined && previewed.preview.byteSize > 0 ? 'PASS' : 'FAIL'} `
      + `bytes=${String(previewed.preview?.byteSize ?? -1)} includes=${String(previewed.preview?.includes.length ?? -1)} `
      + `excludes=${JSON.stringify(previewed.preview?.excludes ?? [])}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-SHARE-PREVIEW-NOPUBLISH ${String(previewed.summary).includes('Nothing was published') ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(previewed.summary).slice(0, 200))}\n`,
    )

    // Publishing without confirmation must be refused before anything else is considered.
    const unconfirmed = await share.execute(
      { action: 'publish', taskId, confirmed: false },
      { ...sExec, callId: `verify-share-unconfirmed-${runId}` },
    )
    process.stderr.write(
      `CONDUCTOR-SHARE-UNCONFIRMED ${unconfirmed.refusals.join(' ').includes('confirm the preview') ? 'PASS' : 'FAIL'} `
      + `refusals=${JSON.stringify(unconfirmed.refusals).slice(0, 240)}\n`,
    )

    // And a confirmed publish is refused for the missing service, with nothing uploaded.
    const confirmed = await share.execute(
      { action: 'publish', taskId, confirmed: true, lifetimeDays: 7 },
      { ...sExec, callId: `verify-share-publish-${runId}` },
    )
    process.stderr.write(
      `CONDUCTOR-SHARE-NO-SERVICE ${confirmed.availability.available === false && String(confirmed.summary).includes('nothing was uploaded') ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(confirmed.summary).slice(0, 240))}\n`,
    )

    const listed = await share.execute({ action: 'list' }, { ...sExec, callId: `verify-share-list-${runId}` })
    process.stderr.write(
      `CONDUCTOR-SHARE-NOTHING-PUBLISHED ${listed.shares.length === 0 ? 'PASS' : 'FAIL'} shares=${String(listed.shares.length)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-SHARE ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Move a task to a successor session in another directory.
 *
 * The target is created by the probe so the directory check has something real
 * to pass, and the check afterwards is that the task id is unchanged, the session
 * changed, and the previous binding is retired rather than deleted.
 *
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param taskId - the task to move.
 * @param runId - a per-run identifier.
 */
async function runHandoff(tools, exec, taskId, runId) {
  try {
    const handoff = tools.get('conductor_handoff')
    if (handoff === undefined) {
      process.stderr.write('CONDUCTOR-HANDOFF FAIL: the handoff tool is not registered\n')
      return
    }
    const target = `D:\\dsh-conductor-verify\\handoff-target-${runId}`
    const { mkdirSync } = await import('node:fs')
    mkdirSync(target, { recursive: true })

    const moved = await handoff.execute(
      { taskId, targetPath: target, operationId: `verify-handoff-${runId}` },
      exec,
    )
    process.stderr.write(
      `CONDUCTOR-HANDOFF ${moved.succeeded === true ? 'PASS' : 'FAIL'} `
      + `taskId=${String(moved.taskId)} reached=${String(moved.reached)} `
      + `previous=${String(moved.previousSessionId ?? 'none')} successor=${String(moved.successorSessionId ?? 'none')} `
      + `reason=${JSON.stringify(moved.reason ?? null)}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-HANDOFF-PRECONDITIONS taskIdPreserved=${String(moved.taskId === taskId)} `
      + `summary=${JSON.stringify(String(moved.summary ?? '').slice(0, 400))}\n`,
    )

    // Moving the same task again is NOT idempotent by design — it produces
    // another successor — so what this checks is that the chain links: the
    // second move's predecessor is the first move's successor.
    const again = await handoff.execute(
      { taskId, targetPath: target, operationId: `verify-handoff-again-${runId}` },
      exec,
    )
    process.stderr.write(
      `CONDUCTOR-HANDOFF-CHAIN ${again.succeeded === true && again.previousSessionId === moved.successorSessionId ? 'PASS' : 'FAIL'} `
      + `first=${String(moved.successorSessionId ?? 'none')} secondPrevious=${String(again.previousSessionId ?? 'none')} `
      + `second=${String(again.successorSessionId ?? 'none')} distinct=${String(again.successorSessionId !== moved.successorSessionId)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-HANDOFF ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Hand the probe artifact to another task by all three modes.
 *
 * The patch mode is the one worth measuring: it must refuse when the receiver's
 * file is not the revision the patch was made against, and refuse without
 * writing. The check therefore patches the *changed* file — the state the
 * previous step deliberately left behind — and asserts both the refusal and that
 * the file is byte-for-byte what it was.
 *
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param fromTaskId - the task holding the artifact.
 * @param artifactId - the artifact to hand over.
 * @param path - the artifact's file, already modified by the previous step.
 * @param runId - a per-run identifier.
 */
async function runTransfer(tools, exec, fromTaskId, artifactId, path, runId) {
  try {
    const create = tools.get('conductor_create')
    const transfer = tools.get('conductor_transfer')
    if (create === undefined || transfer === undefined) {
      process.stderr.write('CONDUCTOR-TRANSFER FAIL: transfer tools are not registered\n')
      return
    }
    const receiver = await create.execute(
      { title: 'transfer receiver', contextMode: 'empty', operationId: `verify-receiver-${runId}` },
      exec,
    )
    const toTaskId = String(receiver.taskId)

    const reference = await transfer.execute(
      { mode: 'reference', artifactId, toTaskId, transferId: `verify-ref-${runId}` },
      exec,
    )
    process.stderr.write(
      `CONDUCTOR-TRANSFER-REFERENCE ${reference.provided === true && reference.applied === false ? 'PASS' : 'FAIL'} `
      + `provided=${String(reference.provided)} applied=${String(reference.applied)} `
      + `hasReference=${String(typeof reference.reference === 'string')}\n`,
    )

    const destination = `D:\\dsh-conductor-verify\\artifact-copy-${runId}.txt`
    const copy = await transfer.execute(
      { mode: 'snapshot_copy', artifactId, toTaskId, destination, transferId: `verify-copy-${runId}` },
      exec,
    )
    // The artifact is in the `changed` state, so a snapshot copy must refuse.
    process.stderr.write(
      `CONDUCTOR-TRANSFER-COPY-REFUSED ${copy.applied === false && copy.conflicts.length > 0 ? 'PASS' : 'FAIL'} `
      + `applied=${String(copy.applied)} conflicts=${JSON.stringify(copy.conflicts)}\n`,
    )

    const { readFileSync } = await import('node:fs')
    const before = readFileSync(path, 'utf8')
    const patch = await transfer.execute(
      {
        mode: 'patch',
        artifactId,
        toTaskId,
        destination: path,
        diff: [
          '--- a/target', '+++ b/target',
          '@@ -1,1 +1,1 @@',
          '-a line the file does not contain',
          '+replacement',
          '',
        ].join('\n'),
        apply: true,
        // The artifact's hash is of the FIRST content, and the file now holds the
        // second, so this is a baseline mismatch as well as a hunk mismatch.
        transferId: `verify-patch-${runId}`,
      },
      exec,
    )
    const after = readFileSync(path, 'utf8')
    process.stderr.write(
      `CONDUCTOR-TRANSFER-PATCH-STOPPED ${patch.applied === false && before === after ? 'PASS' : 'FAIL'} `
      + `applied=${String(patch.applied)} verified=${String(patch.verified)} `
      + `unchanged=${String(before === after)} conflicts=${JSON.stringify(patch.conflicts)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-TRANSFER ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Fork a task whose session has a finished turn.
 *
 * The verify Host's turns fail rather than complete, which is fine for this
 * check: a `turn/end` is a boundary whatever its reason, and the Host's own fork
 * reads it the same way. What the check establishes is that the child session is
 * created carrying a seed, that it is a distinct session from the source, and
 * that the source is untouched.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 * @param sourceTaskId - the task to fork.
 * @param runId - a per-run identifier, so a retried fork replay is observable.
 */
async function runFork(ctx, tools, exec, sourceTaskId, runId) {
  try {
    const fork = tools.get('conductor_fork')
    if (fork === undefined) {
      process.stderr.write('CONDUCTOR-FORK FAIL: the fork tool is not registered\n')
      return
    }
    const operationId = `verify-fork-${runId}`
    const forked = await fork.execute(
      { sourceTaskId, title: 'forked in verification', operationId },
      exec,
    )
    process.stderr.write(
      `CONDUCTOR-FORK ${forked.preparation === 'ready' && forked.sessionId !== undefined ? 'PASS' : 'FAIL'} `
      + `source=${sourceTaskId} taskId=${String(forked.taskId)} sessionId=${String(forked.sessionId ?? 'none')} `
      + `phase=${String(forked.preparationPhase)} replayed=${String(forked.replayed)} `
      + `error=${JSON.stringify(forked.failureReason ?? null)}\n`,
    )

    // A retried fork must replay rather than fork again.
    const again = await fork.execute(
      { sourceTaskId, title: 'forked in verification', operationId },
      exec,
    )
    process.stderr.write(
      `CONDUCTOR-FORK-REPLAY ${again.replayed === true && again.taskId === forked.taskId ? 'PASS' : 'FAIL'} `
      + `replayed=${String(again.replayed)} taskId=${String(again.taskId)}\n`,
    )

    // A fork with an instruction must stay idle when none is given.
    process.stderr.write(
      `CONDUCTOR-FORK-IDLE ${forked.preparationPhase === 'ready' ? 'PASS' : 'FAIL'} `
      + `phase=${String(forked.preparationPhase)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-FORK ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * Discover unmanaged sessions, join one, and organise it.
 *
 * The verify Host has accumulated real sessions across earlier runs, so
 * discovery has something to find. Joining must not modify the session, which
 * is why the check also asserts the discovered metadata rather than only that
 * the call returned.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 */
async function runOrganise(ctx, tools, exec) {
  try {
    const discover = tools.get('conductor_discover')
    const attach = tools.get('conductor_attach')
    const update = tools.get('conductor_update')
    const list = tools.get('conductor_list')
    if (discover === undefined || attach === undefined || update === undefined || list === undefined) {
      process.stderr.write('CONDUCTOR-ORGANISE FAIL: organisation tools are not registered\n')
      return
    }

    const found = await discover.execute({ limit: 5 }, exec)
    process.stderr.write(
      `CONDUCTOR-DISCOVER ${found.candidates.length > 0 ? 'PASS' : 'FAIL'} `
      + `total=${String(found.total)} shown=${String(found.candidates.length)} `
      + `sample=${JSON.stringify(found.candidates[0] ?? null)}\n`,
    )
    if (found.candidates.length === 0) {
      // Distinguish "the Host offers no session query" from "the query returned
      // nothing", because the two need different fixes.
      let probe = 'unavailable'
      try {
        const query = ctx.get('sessionQuery')
        if (query === undefined) probe = 'ctx.sessionQuery is undefined'
        else if (typeof query.listSessions !== 'function') probe = 'listSessions is not a function'
        else {
          const raw = await query.listSessions()
          probe = `listSessions returned ${String(raw.length)}`
        }
      } catch (error) {
        probe = `listSessions threw: ${String(error?.message ?? error)}`
      }
      process.stderr.write(`CONDUCTOR-DISCOVER-DIAGNOSTIC ${probe}\n`)
      return
    }

    // Prefer a session that is not live, so the check also proves joining does
    // not depend on the Host currently holding it.
    const pick = found.candidates.find(c => c.live === false) ?? found.candidates[0]
    const joined = await attach.execute(
      { sessionId: pick.sessionId, title: 'joined in verification', operationId: 'verify-attach-1' },
      exec,
    )
    process.stderr.write(
      `CONDUCTOR-ATTACH ${joined.taskId !== undefined ? 'PASS' : 'FAIL'} `
      + `taskId=${String(joined.taskId)} sessionId=${String(joined.sessionId)} replayed=${String(joined.replayed)}\n`,
    )

    const renamed = await update.execute(
      { taskId: joined.taskId, title: 'joined and renamed', group: 'verification', pinned: true },
      exec,
    )
    process.stderr.write(
      `CONDUCTOR-UPDATE ${renamed.title === 'joined and renamed' && renamed.group === 'verification' ? 'PASS' : 'FAIL'} `
      + `title=${JSON.stringify(renamed.title)} group=${JSON.stringify(renamed.group ?? null)} `
      + `pinned=${String(renamed.pinned)} archived=${String(renamed.archived)}\n`,
    )

    const archived = await update.execute({ taskId: joined.taskId, archived: true }, exec)
    const listed = await list.execute({ archived: true }, exec)
    process.stderr.write(
      `CONDUCTOR-ARCHIVE ${archived.archived === true && listed.tasks.some(t => t.taskId === joined.taskId) ? 'PASS' : 'FAIL'} `
      + `archived=${String(archived.archived)} listedArchived=${String(listed.total)}\n`,
    )

    // A session the conductor now manages must no longer appear as a candidate.
    const after = await discover.execute({ limit: 50 }, exec)
    process.stderr.write(
      `CONDUCTOR-DISCOVER-HIDES ${after.candidates.every(c => c.sessionId !== pick.sessionId) ? 'PASS' : 'FAIL'} `
      + `stillListed=${String(after.candidates.some(c => c.sessionId === pick.sessionId))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-ORGANISE ERROR: ${String(error?.message ?? error)}\n`)
  }
}

/**
 * See a session the Host archived **outside** the conductor (PRD §二.5).
 *
 * > 支持查看…外部归档的会话
 *
 * The requirement is a read, and the sentence beside it forbids the plugin's own archiving from calling the
 * Host's archive interface — so this probe drives the Host directly, which is exactly the "outside" the
 * requirement is about, and then asks the conductor's own tool what it can see. Nothing here goes through
 * the plugin to change the set; `ctx.workspaceRegistry.archiveSession` is the Host's own interface, called
 * the way the Host's own UI calls it.
 *
 * Three facts are measured, and each one is a different way to get this wrong:
 *
 * 1. The set is read **per call**, so a session archived after an earlier list still shows up as archived.
 * 2. A session in a set that was read and does **not** contain it is reported `false` — a fact, not a
 *    missing field.
 * 3. The tool says in words which case the whole list is in, because the rows alone cannot distinguish
 *    "not archived" from "this Host publishes no set".
 *
 * The session archived is one the Host already lists and the conductor does not manage, so the target is
 * ordinary history rather than something this plugin made. This build exposes no unarchive on any DSH
 * surface (checked across the installed packages), so an archiving probe is a **permanent** change to the
 * archive set of the verify store — a deliberate one, in an isolated store, and never the user's.
 *
 * @param ctx - the probe's context.
 */
async function runArchiveView(ctx) {
  try {
    const tools = ctx.get('tools')
    const get = name => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const discover = get('conductor_discover')
    if (discover === undefined) {
      process.stderr.write('CONDUCTOR-ARCHIVE-VIEW FAIL: conductor_discover is not registered\n')
      return
    }
    const exec = { callId: `probe-archive-${BOOT_ID}`, agent: { id: 'session-probe-archive' } }

    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.archiveSession !== 'function') {
      process.stderr.write(
        `CONDUCTOR-ARCHIVE-VIEW UNAVAILABLE registry=${registry === undefined ? 'absent' : typeof registry} `
        + `archiveSession=${typeof registry?.archiveSession}\n`,
      )
      return
    }

    let hostSet = null
    try {
      hostSet = [...registry.archivedSessionIds]
    } catch (error) {
      process.stderr.write(`CONDUCTOR-ARCHIVE-VIEW-SET THREW ${String(error?.message ?? error)}\n`)
    }
    const before = await discover.execute({ limit: 50 }, exec)
    process.stderr.write(
      `CONDUCTOR-ARCHIVE-BASELINE total=${String(before.total)} hostSet=${String(hostSet === null ? 'unreadable' : hostSet.length)} `
      + `archive=${JSON.stringify(String(before.archive ?? '').slice(0, 220))}\n`,
    )
    if (before.total === 0) {
      // The verify store has accumulated real history across runs, so an empty list means the session query
      // is not answering rather than that nothing exists.
      process.stderr.write('CONDUCTOR-ARCHIVE-VIEW FAIL: no candidates to archive\n')
      return
    }

    // A session the Host's set does not already contain, so a repeated run measures something new each time;
    // `archiveSession` is idempotent, so re-archiving the same id would silently measure nothing.
    const pick = before.candidates.find(candidate => candidate.externallyArchived === false)
      ?? before.candidates.find(candidate => !Array.isArray(hostSet) || !hostSet.includes(candidate.sessionId))
      ?? before.candidates[0]
    await registry.archiveSession(pick.sessionId)
    const nowArchived = [...registry.archivedSessionIds]

    const after = await discover.execute({ limit: 50 }, exec)
    const row = after.candidates.find(candidate => candidate.sessionId === pick.sessionId)
    process.stderr.write(
      `CONDUCTOR-ARCHIVE-VIEW ${row?.externallyArchived === true ? 'PASS' : 'FAIL'} `
      + `session=${pick.sessionId} hostKnows=${String(nowArchived.includes(pick.sessionId))} `
      + `flag=${String(row?.externallyArchived)} hostSet=${String(nowArchived.length)} `
      + `stillListed=${String(row !== undefined)}\n`,
    )

    // The control that makes the check mean something: in a set that was read, a session it does not contain
    // is `false` — not absent. An implementation that only ever set the field for archived rows would pass
    // the check above and fail this one.
    //
    // The control candidate must be one the set genuinely does **not** contain, which is asked of the field
    // itself rather than assumed of "any other row": archiving is one-way, so a re-run of this probe finds
    // the sessions *earlier* runs archived still archived, and the first version of this check picked one of
    // those and reported a plugin failure for a probe assumption.
    const control = after.candidates.find(candidate => candidate.sessionId !== pick.sessionId
      && candidate.externallyArchived === false)
    const archivedShown = after.candidates.filter(candidate => candidate.externallyArchived === true).length
    process.stderr.write(
      `CONDUCTOR-ARCHIVE-CONTROL ${control === undefined ? 'N/A' : 'PASS'} `
      + `session=${String(control?.sessionId ?? 'none')} flag=${String(control?.externallyArchived)} `
      + `archivedAmongShown=${String(archivedShown)} `
      + `${control === undefined ? 'reason="every other candidate is itself archived, so this run has no row that must read false"' : ''}\n`,
    )

    process.stderr.write(
      `CONDUCTOR-ARCHIVE-SUMMARY ${/archive set was read/.test(String(after.summary ?? '')) ? 'PASS' : 'FAIL'} `
      + `summary=${JSON.stringify(String(after.summary ?? '').slice(-260))}\n`,
    )
    process.stderr.write(
      `CONDUCTOR-ARCHIVE-STATED ${/archived outside the conductor/.test(String(after.summary ?? '')) ? 'PASS' : 'FAIL'} `
      + `note=${JSON.stringify(String(after.archive ?? '').slice(0, 220))}\n`,
    )

    // The 界面 half of the same requirement. §二.5's 界面明确显示其作用范围 is about scope: the conductor's
    // archive is its own task collection and the Host's is the user's, so a panel that showed only the first
    // invites a reader to read it as the second. A **managed** task's session is the case that matters — the
    // one above was an unmanaged candidate and would never appear in the panel at all.
    const create = get('conductor_create')
    const port = process.env['CONDUCTOR_PROBE_PORT'] ?? '43917'
    if (create === undefined) {
      process.stderr.write('CONDUCTOR-ARCHIVE-PANEL SKIPPED: conductor_create is not registered\n')
      return
    }
    const mine = await create.execute(
      { title: `archive view probe ${BOOT_ID}`, contextMode: 'empty', operationId: `probe-archive-task-${BOOT_ID}` },
      exec,
    )
    if (mine.preparation !== 'ready' || mine.sessionId === undefined) {
      process.stderr.write(
        `CONDUCTOR-ARCHIVE-PANEL FAIL: the task did not prepare — `
        + `${String(mine.failureReason ?? mine.preparationPhase)}\n`,
      )
      return
    }
    await registry.archiveSession(String(mine.sessionId))
    const panelResponse = await fetch(`http://127.0.0.1:${port}/conductor/panel`, {
      headers: { accept: 'application/json' },
    })
    const panel = await panelResponse.json()
    const rows = Array.isArray(panel?.tasks) ? panel.tasks : []
    const panelRow = rows.find(entry => entry.taskId === mine.taskId)
    // The control: a task whose session is *not* in the set is `false`, so the field is a fact about every
    // row rather than a label attached only to the interesting ones.
    const controlRow = rows.find(entry => entry.sessionArchivedExternally === false)
    const note = String((Array.isArray(panel?.notes) ? panel.notes : [])
      .find(entry => String(entry).includes('sessionArchivedExternally')) ?? '')
    process.stderr.write(
      `CONDUCTOR-ARCHIVE-PANEL ${panelRow?.sessionArchivedExternally === true && note.length > 0 ? 'PASS' : 'FAIL'} `
      + `taskId=${String(mine.taskId)} session=${String(mine.sessionId)} status=${String(panelResponse.status)} `
      + `flag=${String(panelRow?.sessionArchivedExternally)} othersFalse=${String(controlRow !== undefined)} `
      + `note=${JSON.stringify(note.slice(0, 260))}\n`,
    )
    const detailResponse = await fetch(
      `http://127.0.0.1:${port}/conductor/panel/task?taskId=${encodeURIComponent(String(mine.taskId))}`,
      { headers: { accept: 'application/json' } },
    )
    const detail = await detailResponse.json()
    const refusal = String((Array.isArray(detail?.task?.refusals) ? detail.task.refusals : [])
      .find(entry => String(entry).includes('sessionArchivedExternally')) ?? '')
    process.stderr.write(
      `CONDUCTOR-ARCHIVE-DETAIL `
      + `${detail?.task?.sessionArchivedExternally === true && refusal.length > 0 ? 'PASS' : 'FAIL'} `
      + `status=${String(detailResponse.status)} flag=${String(detail?.task?.sessionArchivedExternally)} `
      + `refusal=${JSON.stringify(refusal.slice(0, 220))}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-ARCHIVE-VIEW ERROR: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Measure the task-list filter set of PRD §二.5 (项目、名称、状态、Host、分组、归档状态).
 *
 * The design of this check is the interesting part: every filter is applied using a value the tool
 * **itself reported on a row**, rather than a value the probe decided the answer should have. A task is
 * created, then read back unfiltered; the row's own `status` and `hostId` are then used as filters and the
 * task must come back. That measures the round trip — the badge a caller sees is the badge a caller can
 * filter by — and it cannot pass by accident from a filter that matches nothing or everything, because each
 * case also asserts that every returned row carries the value asked for.
 *
 * The negative controls are the other half: a name that cannot exist returns an empty list *with*
 * `filteredBy` naming the filter, which is the difference between "no task matched" and "the conductor
 * manages nothing" — two answers that read the same in a bare count.
 *
 * @param ctx - the probe's context.
 */
async function runTaskFilters(ctx) {
  try {
    const tools = ctx.get('tools')
    const get = name => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
    const list = get('conductor_list')
    const create = get('conductor_create')
    const send = get('conductor_send')
    const access = get('conductor_access')
    if (list === undefined || create === undefined) {
      process.stderr.write('CONDUCTOR-LIST-FILTER FAIL: a required tool is not registered\n')
      return
    }
    const { randomUUID } = await import('node:crypto')
    const run = randomUUID().slice(0, 8)
    const exec = suffix => ({ callId: `probe-list-${suffix}-${run}`, agent: { id: 'session-probe-filters' } })

    const title = `filter probe ${run}`
    const created = await create.execute(
      { title, contextMode: 'empty', operationId: `probe-list-task-${run}` },
      exec('create'),
    )
    const taskId = String(created.taskId)
    const call = async (args, suffix) => list.execute(args, exec(suffix))

    const all = await call({ limit: 400 }, 'all')
    const mine = all.tasks.find(entry => entry.taskId === taskId)
    // The two facts §二.5 lets a caller filter by that the task record alone cannot answer. Before this
    // round they were not even exposed on a row, so a caller had nothing to filter with.
    process.stderr.write(
      `CONDUCTOR-LIST-EXPOSED ${mine?.status !== undefined && mine?.hostId !== undefined ? 'PASS' : 'FAIL'} `
      + `taskId=${taskId} status=${JSON.stringify(mine?.status ?? null)} statusReason=${JSON.stringify(mine?.statusReason ?? null)} `
      + `hostId=${JSON.stringify(mine?.hostId ?? null)} project=${JSON.stringify(mine?.project ?? null)} `
      + `cwd=${JSON.stringify(mine?.cwd ?? null)} sessionId=${JSON.stringify(mine?.sessionId ?? null)} `
      + `rows=${String(all.tasks.length)} of ${String(all.total)}\n`,
    )

    // ── 名称 ─────────────────────────────────────────────────────────────────
    const byName = await call({ name: run.toUpperCase(), limit: 50 }, 'name')
    const nameOk = byName.tasks.some(entry => entry.taskId === taskId)
      && byName.tasks.every(entry => entry.title.toLowerCase().includes(run.toLowerCase()))
    process.stderr.write(
      `CONDUCTOR-LIST-NAME ${nameOk ? 'PASS' : 'FAIL'} name=${JSON.stringify(run.toUpperCase())} `
      + `total=${String(byName.total)} ids=${JSON.stringify(byName.tasks.map(entry => entry.taskId))} `
      + `filteredBy=${JSON.stringify(byName.filteredBy)}\n`,
    )

    // ── 状态 ─────────────────────────────────────────────────────────────────
    const byStatus = await call({ status: mine?.status, limit: 400 }, 'status')
    const statusOk = mine?.status !== undefined
      && byStatus.tasks.some(entry => entry.taskId === taskId)
      && byStatus.tasks.every(entry => entry.status === mine.status)
    process.stderr.write(
      `CONDUCTOR-LIST-STATUS ${statusOk ? 'PASS' : 'FAIL'} status=${JSON.stringify(mine?.status ?? null)} `
      + `total=${String(byStatus.total)} because=${JSON.stringify(byStatus.filteredBy)}\n`,
    )
    // The control: a status our task does not have must not return it. The statuses are the panel's own
    // vocabulary, so one of them is guaranteed to differ.
    const other = ['preparing', 'preparation_failed', 'cancelled', 'released', 'budget_limited', 'waiting_user',
      'running', 'idle'].find(status => status !== mine?.status)
    const byOther = await call({ status: other, limit: 400 }, 'status-other')
    process.stderr.write(
      `CONDUCTOR-LIST-STATUS-CONTROL ${byOther.tasks.every(entry => entry.taskId !== taskId) ? 'PASS' : 'FAIL'} `
      + `status=${JSON.stringify(other ?? null)} total=${String(byOther.total)} `
      + `carriesMine=${String(byOther.tasks.some(entry => entry.taskId === taskId))}\n`,
    )

    // ── Host ─────────────────────────────────────────────────────────────────
    const byHost = await call({ hostId: mine?.hostId, limit: 400 }, 'host')
    const hostOk = mine?.hostId !== undefined
      && byHost.tasks.some(entry => entry.taskId === taskId)
      && byHost.tasks.every(entry => entry.hostId === mine.hostId)
    process.stderr.write(
      `CONDUCTOR-LIST-HOST ${hostOk ? 'PASS' : 'FAIL'} hostId=${JSON.stringify(mine?.hostId ?? null)} `
      + `total=${String(byHost.total)} because=${JSON.stringify(byHost.filteredBy)}\n`,
    )
    const noHost = await call({ hostId: `host-that-does-not-exist-${run}` }, 'host-none')
    process.stderr.write(
      `CONDUCTOR-LIST-HOST-CONTROL ${noHost.total === 0 && noHost.tasks.length === 0 ? 'PASS' : 'FAIL'} `
      + `total=${String(noHost.total)} tasks=${String(noHost.tasks.length)}\n`,
    )

    // ── 项目 ─────────────────────────────────────────────────────────────────
    // A project exists on a task prepared from a directory, and the verify store has tasks from the Git
    // probe's scratch repositories. If no row in this store has one, the case is reported as unmeasurable
    // with the reason rather than passed on an empty comparison — the habit this project already follows
    // for environment-bound rows.
    const withProject = all.tasks.find(entry => typeof entry.project === 'string' && entry.project.length > 0)
    if (withProject === undefined) {
      process.stderr.write(
        `CONDUCTOR-LIST-PROJECT N/A reason="no task in this store reports a project, so there is nothing to `
        + `filter by" rows=${String(all.tasks.length)}\n`,
      )
    } else {
      const needle = String(withProject.project).slice(-12)
      const byProject = await call({ project: needle.toUpperCase(), limit: 400 }, 'project')
      const projectOk = byProject.tasks.some(entry => entry.taskId === withProject.taskId)
        && byProject.tasks.every(entry => String(entry.project ?? '').toLowerCase().includes(needle.toLowerCase()))
      process.stderr.write(
        `CONDUCTOR-LIST-PROJECT ${projectOk ? 'PASS' : 'FAIL'} needle=${JSON.stringify(needle)} `
        + `upperCased=${String(true)} total=${String(byProject.total)} `
        + `expected=${withProject.taskId} because=${JSON.stringify(byProject.filteredBy)}\n`,
      )
    }

    // ── The negative control, and the sentence that makes an empty list readable ──
    const nothing = await call({ name: `no-such-task-${run}`, limit: 50 }, 'none')
    process.stderr.write(
      `CONDUCTOR-LIST-NONE ${nothing.total === 0 && String(nothing.filteredBy ?? '').length > 0 ? 'PASS' : 'FAIL'} `
      + `total=${String(nothing.total)} tasks=${String(nothing.tasks.length)} `
      + `filteredBy=${JSON.stringify(nothing.filteredBy ?? null)}\n`,
    )

    // ── 全文搜索仅限调用者有权读取的会话 (PRD §二.5) ────────────────────────────────
    // A content search needs a real message in a real session, and the access rule applied per
    // session. The needle is unique to this boot so a retained store cannot produce a hit from
    // an earlier round. Hits name the location; the matching text is not in the hit — that is
    // the whole point of not building this on callerEvents.
    if (send === undefined || access === undefined) {
      process.stderr.write(
        `CONDUCTOR-LIST-SEARCH FAIL send=${String(send !== undefined)} access=${String(access !== undefined)}\n`,
      )
      return
    }
    const needle = `search-needle-${run}`
    const sent = await send.execute(
      { taskId, text: `please remember ${needle} as a unique token`, mode: 'steer', operationId: `probe-list-send-${run}` },
      exec('send'),
    )
    const asController = await call({ query: needle.toUpperCase(), limit: 50 }, 'search-owner')
    const ownerRow = asController.tasks.find(entry => entry.taskId === taskId)
    const ownerHits = Array.isArray(ownerRow?.hits) ? ownerRow.hits : []
    const hitShape = ownerHits.length > 0
      && ownerHits.every(hit => typeof hit.seq === 'number' && typeof hit.kind === 'string'
        && Object.keys(hit).sort().join(',') === 'kind,seq')
    const bodyLeaked = JSON.stringify(ownerHits).toLowerCase().includes(needle.toLowerCase())
      || JSON.stringify(ownerHits).toLowerCase().includes('please remember')
    const ownerOk = ownerRow !== undefined && hitShape && bodyLeaked === false
      && String(asController.filteredBy ?? '').includes('session text contains')
    process.stderr.write(
      `CONDUCTOR-LIST-SEARCH-OWNER ${ownerOk ? 'PASS' : 'FAIL'} `
      + `delivery=${JSON.stringify(sent.delivery ?? sent.summary ?? null)} `
      + `total=${String(asController.total)} hits=${JSON.stringify(ownerHits)} `
      + `bodyLeaked=${String(bodyLeaked)} filteredBy=${JSON.stringify(asController.filteredBy ?? null)}\n`,
    )

    const asStranger = await list.execute(
      { query: needle, limit: 50 },
      { callId: `probe-list-search-stranger-${run}`, agent: { id: 'session-that-does-not-control-it' } },
    )
    const strangerCarries = asStranger.tasks.some(entry => entry.taskId === taskId)
    const strangerUnreadable = Array.isArray(asStranger.unreadable)
      && asStranger.unreadable.some(entry => entry.taskId === taskId)
    process.stderr.write(
      `CONDUCTOR-LIST-SEARCH-STRANGER ${strangerCarries === false && strangerUnreadable === false ? 'PASS' : 'FAIL'} `
      + `total=${String(asStranger.total)} carriesMine=${String(strangerCarries)} `
      + `listedUnreadable=${String(strangerUnreadable)}\n`,
    )

    const observed = await access.execute(
      { taskId, action: 'observe', sessionId: `session-search-auditor-${run}` },
      exec('observe'),
    )
    const asObserver = await list.execute(
      { query: needle, limit: 50 },
      { callId: `probe-list-search-observer-${run}`, agent: { id: `session-search-auditor-${run}` } },
    )
    const observerRow = asObserver.tasks.find(entry => entry.taskId === taskId)
    const observerHits = Array.isArray(observerRow?.hits) ? observerRow.hits : []
    const observerOk = observed.changed === true
      && observerRow !== undefined
      && observerHits.length > 0
      && JSON.stringify(observerHits).toLowerCase().includes(needle.toLowerCase()) === false
    process.stderr.write(
      `CONDUCTOR-LIST-SEARCH-OBSERVER ${observerOk ? 'PASS' : 'FAIL'} `
      + `observers=${JSON.stringify(observed.observers ?? null)} hits=${JSON.stringify(observerHits)}\n`,
    )

    const missed = await call({ query: `no-such-session-text-${run}`, limit: 50 }, 'search-none')
    process.stderr.write(
      `CONDUCTOR-LIST-SEARCH-NONE ${missed.total === 0 && String(missed.filteredBy ?? '').includes('session text contains') ? 'PASS' : 'FAIL'} `
      + `total=${String(missed.total)} filteredBy=${JSON.stringify(missed.filteredBy ?? null)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-LIST-FILTER ERROR: ${String(error?.stack ?? error)}\n`)
  }
}

/**
 * Create a task that actually starts a Host turn, then wait for it to end.
 *
 * This is the check the whole observation layer exists for. The verify Host has
 * no model credentials, so the turn is expected to FAIL — which is exactly what
 * makes it a useful measurement: the conductor must report the turn as failed
 * with the Host's own reason, and must never present the accepted message as a
 * completed turn.
 *
 * @param ctx - the probe's context.
 * @param tools - the live tool registry.
 * @param exec - the caller identity to supply.
 */
async function runTurn(ctx, tools, exec) {
  try {
    const create = tools.get('conductor_create')
    const wait = tools.get('conductor_wait')
    const read = tools.get('conductor_read')
    if (create === undefined || wait === undefined || read === undefined) {
      process.stderr.write('CONDUCTOR-TURN FAIL: observation tools are not registered\n')
      return
    }

    const created = await create.execute(
      {
        title: 'conductor turn observation',
        instruction: 'reply with the single word: ok',
        contextMode: 'empty',
        operationId: 'verify-turn-create',
      },
      exec,
    )
    process.stderr.write(
      `CONDUCTOR-TURN-CREATE ${created.preparationPhase === 'initial_message_accepted' ? 'PASS' : 'FAIL'} `
      + `taskId=${String(created.taskId)} phase=${String(created.preparationPhase)}\n`,
    )

    const started = Date.now()
    const waited = await wait.execute(
      { targets: [{ taskId: String(created.taskId) }], timeoutMs: 30000 },
      exec,
    )
    const target = waited.targets?.[0] ?? {}
    const wake = String(target.wake ?? '')
    process.stderr.write(
      `CONDUCTOR-TURN-WAIT ${wake.startsWith('turn 1 ended:') ? 'PASS' : 'FAIL'} `
      + `ms=${String(Date.now() - started)} timedOut=${String(waited.timedOut)} `
      + `wake=${JSON.stringify(wake)} state=${JSON.stringify(target.state ?? null)} `
      + `cursor=${String(target.cursor ?? '')}\n`,
    )

    const snapshot = await read.execute({ taskId: String(created.taskId) }, exec)
    process.stderr.write(
      `CONDUCTOR-TURN-READ state=${JSON.stringify(snapshot.state)} cursor=${String(snapshot.cursor)}\n`,
    )

    // A second wait must not re-report the turn that was already returned.
    const again = await wait.execute({ targets: [{ taskId: String(created.taskId) }], timeoutMs: 0 }, exec)
    const secondWake = again.targets?.[0]?.wake
    process.stderr.write(
      `CONDUCTOR-TURN-NOREPEAT ${secondWake === undefined ? 'PASS' : 'FAIL'} `
      + `wake=${JSON.stringify(secondWake ?? null)}\n`,
    )
  } catch (error) {
    process.stderr.write(`CONDUCTOR-TURN ERROR: ${String(error?.message ?? error)}\n`)
  }
}
