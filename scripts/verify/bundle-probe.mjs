/**
 * Measure the export attachment bundle (PRD §二.14.2).
 *
 * The bundle was only ever **named**: the document listed artifact ids and a note, no file was
 * produced, and an id naming no artifact was passed through unvalidated — so an export could promise
 * a bundle that did not exist and name attachments that did not either.
 *
 * @param ctx - the probe's context.
 */
export async function runExportBundle(ctx, tools) {
  const { randomUUID } = await import('node:crypto')
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const run = randomUUID().slice(0, 8)
  const root = await mkdtemp(join(tmpdir(), 'conductor-probe-bundle-'))
  const get = (name) => (typeof tools?.get === 'function' ? tools.get(name) : undefined)
  const create = get('conductor_create')
  const register = get('conductor_artifact_register')
  const exportTool = get('conductor_export')
  if (create === undefined || register === undefined || exportTool === undefined) {
    process.stderr.write('CONDUCTOR-BUNDLE FAIL: a required tool is not registered\n')
    return
  }
  const caller = 'session-probe-controller'
  const exec = (suffix) => ({ callId: `probe-bundle-${suffix}-${run}`, agent: { id: caller } })

  const task = await create.execute(
    { title: `bundle probe ${run}`, contextMode: 'empty', operationId: `probe-bundle-${run}` },
    exec('create'),
  )
  if (task.preparation !== 'ready') {
    process.stderr.write('CONDUCTOR-BUNDLE FAIL: the task did not prepare\n')
    return
  }
  const source = join(root, 'notes.md')
  await writeFile(source, '# notes\n', 'utf8')
  const artifact = await register.execute(
    { taskId: task.taskId, kind: 'file', name: 'notes.md', path: source },
    exec('register'),
  )
  const bundleDirectory = join(root, 'bundle')

  const exported = await exportTool.execute({
    action: 'export',
    taskId: task.taskId,
    format: 'markdown',
    attachmentIds: [artifact.artifactId],
    bundleDirectory,
    authorizedBy: caller,
  }, exec('export'))

  let written = '<absent>'
  try {
    written = await readFile(join(bundleDirectory, `${artifact.artifactId}-notes.md`), 'utf8')
  } catch (error) {
    written = `<unreadable: ${String(error?.message ?? error)}>`
  }
  process.stderr.write(
    `CONDUCTOR-BUNDLE-WRITTEN ${written === '# notes\n' ? 'PASS' : 'FAIL'} file=${JSON.stringify(written.slice(0, 60))} `
    + `summary=${JSON.stringify(String(exported.summary).slice(0, 200))}\n`,
  )

  // An id that names no artifact is refused by name instead of being listed.
  const bogus = await exportTool.execute({
    action: 'export',
    taskId: task.taskId,
    format: 'markdown',
    attachmentIds: ['artifact-that-does-not-exist'],
    bundleDirectory,
    authorizedBy: caller,
  }, exec('export-bogus'))
  process.stderr.write(
    `CONDUCTOR-BUNDLE-UNKNOWN-REFUSED ${(bogus.problems ?? []).some(entry => /not a recorded artifact/.test(entry)) ? 'PASS' : 'FAIL'} `
    + `problems=${JSON.stringify((bogus.problems ?? []).join(' ').slice(0, 200))}\n`,
  )

  // Naming attachments without a directory says they were not written, rather than implying a bundle.
  const noDirectory = await exportTool.execute({
    action: 'export',
    taskId: task.taskId,
    format: 'markdown',
    attachmentIds: [artifact.artifactId],
    authorizedBy: caller,
  }, exec('export-nodir'))
  process.stderr.write(
    `CONDUCTOR-BUNDLE-NO-FALSE-PROMISE ${/no bundleDirectory was given, so no files were written/.test(String((noDirectory.problems ?? []).join(' '))) ? 'PASS' : 'FAIL'} `
    + `summary=${JSON.stringify(String(noDirectory.summary).slice(-220))}\n`,
  )

  await rm(root, { recursive: true, force: true }).catch(() => {})
}
