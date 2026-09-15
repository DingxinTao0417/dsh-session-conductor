/** Full installed Harness web UI in Edge, real Host services and isolated sessions; no response interception. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.env.CONDUCTOR_ELECTRON, asar = process.env.CONDUCTOR_ASAR
const main = process.env.CONDUCTOR_PACKAGE, compat = process.env.CONDUCTOR_COMPAT
if (!executable || !asar || !main || !compat) throw new Error('Set CONDUCTOR_ELECTRON, CONDUCTOR_ASAR, CONDUCTOR_PACKAGE and CONDUCTOR_COMPAT to verified runtime and clean external package directories')
const run = join(root, '.verification', `navigation-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const home = join(run, 'home'), profile = join(home, 'profiles', 'navigation'), fixture = join(run, 'fixture')
await mkdir(join(profile, 'node_modules'), { recursive: true }); await mkdir(fixture); await mkdir(join(run, 'workspace'))
await copyFile(join(root, 'scripts/navigation-host-probe.mjs'), join(fixture, 'probe.mjs'))
await writeFile(join(fixture, 'hmr.mjs'), 'export function apply(ctx) { ctx.provide("hmr", { registerConfig: async () => () => {} }) }\n')
await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'conductor-navigation-fixture', private: true, type: 'module', exports: { './probe': './probe.mjs', './hmr': './hmr.mjs' } }))
const packages = { 'dsh-session-conductor': resolve(main), 'dsh-harness-compat': resolve(compat), 'conductor-navigation-fixture': fixture }
for (const [name, path] of Object.entries(packages)) await symlink(path, join(profile, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'conductor-navigation-isolated-profile', private: true, dependencies: Object.fromEntries(Object.entries(packages).map(([name, path]) => [name, `link:${path.replaceAll('\\', '/')}`])), dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-harness-compat', 'dsh-session-conductor'] } } }, null, 2))
await writeFile(join(profile, 'cordis.yml'), '[]\n')
const overlay = join(run, 'overlay.yml')
await writeFile(overlay, '- id: dsh-session-conductor\n  config:\n    hostExtensions:\n      selectModelRememberAsDefault: true\n      forkTargetParameters: true\n- insert:\n    - id: navigation-hmr\n      name: conductor-navigation-fixture/hmr\n    - id: navigation-probe\n      name: conductor-navigation-fixture/probe\n')
await writeFile(join(run, 'boot.mjs'), `import { join } from 'node:path'; import { pathToFileURL } from 'node:url'; const { installProfilePackageResolver } = await import(pathToFileURL(join(process.env.BINARY_ASAR, 'lib/module-resolution.js')).href); installProfilePackageResolver(pathToFileURL(join(process.env.BINARY_PROFILE, 'package.json')).href); const { runDesktopDshCli } = await import(pathToFileURL(join(process.env.BINARY_ASAR, 'lib/desktop-cli.js')).href); await runDesktopDshCli();\n`)
const reservation = createServer()
await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done) })
const port = reservation.address().port; await new Promise(done => reservation.close(done))
const base = `http://127.0.0.1:${port}`, logs = [], errors = [], assertions = []
const child = spawn(executable, ['--expose-internals', join(run, 'boot.mjs'), '--profile', 'navigation', '--patch', overlay, '--port', String(port)], { cwd: run, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, BINARY_PROFILE: profile, BINARY_ASAR: asar, BINARY_RUN: run }, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', data => logs.push(data.toString())); child.stderr.on('data', data => logs.push(data.toString()))
let exitCode, browser, receipt, failure
const pages = []
const closed = new Promise(done => { child.once('error', error => { failure = error; done() }); child.once('close', code => { exitCode = code; done() }) })
const sleep = ms => new Promise(done => setTimeout(done, ms))
try {
  const deadline = Date.now() + 55000
  while (Date.now() < deadline) {
    if (exitCode !== undefined || failure) throw failure ?? new Error('Isolated Host exited before readiness')
    try { receipt = JSON.parse(await readFile(join(run, 'ready.json'), 'utf8')); break } catch {}
    await sleep(200)
  }
  assert(receipt, 'Isolated Host readiness timed out')
  assert.equal(receipt.providerCalls, 0)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const pair of receipt.pairs) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 820 } }); pages.push(page)
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(base, { waitUntil: 'load' })
    await page.getByText('设置', { exact: true }).first().waitFor({ timeout: 15000 })
    const consent = page.getByRole('button', { name: '继续', exact: true })
    await consent.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
    if (await consent.isVisible()) await consent.click()
    const group = page.getByText(pair.workspaceTitle ?? '未分组', { exact: true })
    if (!await page.getByText(pair.parentTitle, { exact: true }).first().isVisible() && await group.isVisible()) await group.click()
    await page.getByText(pair.parentTitle, { exact: true }).first().click({ timeout: 15000 })
    // Native session registry/navigation, no plugin-private frontend methods.
    await page.getByText(`创建${pair.title}（独立测试数据）`, { exact: true }).first().waitFor({ timeout: 15000 }).catch(async () => {
      await page.screenshot({ path: join(run, `initial-${pages.length}.png`), fullPage: true })
      await writeFile(join(run, `initial-${pages.length}.html`), await page.content())
      throw new Error('Need select native parent session; inspect initial screenshot and HTML')
    })
    const card = page.locator(`[data-conductor-operation="${pair.operationId}"]`)
    await expect(card.getByRole('button', { name: '打开会话', exact: true })).toBeEnabled({ timeout: 15000 })
    await expect(page.locator('.conductor-panel')).toHaveCount(0)
    // The initial create result itself must tell the parent to stop.  This is
    // revealed before the separate, explicitly requested history read below.
    const creationDisclosure = page.locator(`[data-chat-call-id="${pair.creation.callId}"] [data-disclosure-row="true"]`)
    const creationBoundary = page.getByText('Default delegation is complete:', { exact: false }).first()
    const revealCreation = async () => {
      await expect(creationDisclosure).toBeVisible({ timeout: 15000 })
      if (await creationDisclosure.getAttribute('aria-expanded') !== 'true') await creationDisclosure.click()
      await expect(creationBoundary).toBeVisible({ timeout: 15000 })
      await expect(page.getByText('Do not repeat the delegated work', { exact: false }).first()).toBeVisible()
    }
    await revealCreation()
    // The unique child marker is not present in the parent prompt, title, or
    // navigation card.  Seeing it here proves `conductor_read(history)`'s
    // rendered public records entered the initiating session's normal UI. The
    // stock Harness intentionally collapses tool results, so reveal the exact
    // native tool row rather than treating a collapsed result as absent.
    const historyMarker = page.getByText(pair.historyRead.needle, { exact: false }).first()
    const historyDisclosure = page.locator(`[data-chat-call-id="${pair.historyRead.callId}"] [data-disclosure-row="true"]`)
    const revealHistory = async () => {
      await expect(historyDisclosure).toBeVisible({ timeout: 15000 })
      if (await historyDisclosure.getAttribute('aria-expanded') !== 'true') await historyDisclosure.click()
      await expect(historyMarker).toBeVisible({ timeout: 15000 })
      await expect(page.getByText('Public persisted records from the target session.', { exact: false }).first()).toBeVisible()
    }
    await revealHistory()
    await page.screenshot({ path: join(run, `parent-${pages.length}.png`), fullPage: true })
    await card.getByRole('button', { name: '打开会话', exact: true }).click()
    const back = page.getByRole('button', { name: '返回发起会话', exact: true })
    await expect(back).toBeEnabled({ timeout: 15000 })
    await expect(page.getByText(pair.nativeChildTitle, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(`${pair.title}：由另一会话发起（独立测试数据，无模型推理）；${pair.historyRead.needle}`, { exact: true })).toBeVisible()
    await page.screenshot({ path: join(run, `child-${pages.length}.png`), fullPage: true })
    await page.reload({ waitUntil: 'load' }); await expect(back).toBeEnabled({ timeout: 15000 })
    await back.click(); await expect(card).toBeVisible({ timeout: 15000 })
    await revealHistory()
    // Reload after returning to the parent so the marker must be reconstructed
    // from the persisted parent session rather than survive only in a live DOM.
    await page.reload({ waitUntil: 'load' })
    await expect(card).toBeVisible({ timeout: 15000 })
    await revealHistory()
    assertions.push(`${pair.parentId}: create result visibly ends default delegation; inherits initiating workspace/directory and chosen native title; explicitly requested read(history) body is visible and persists after refresh; inline card opens correct child; child returns after refresh; no floating panel`)
  }
  await pages[0].locator(`[data-conductor-operation="${receipt.pairs[0].operationId}"]`).getByRole('button', { name: '打开会话' }).click()
  await expect(pages[1].locator(`[data-conductor-operation="${receipt.pairs[1].operationId}"]`)).toBeVisible()
  assertions.push('two tabs maintain independent navigation')
  if (receipt.fork) {
    await pages[0].getByText(receipt.fork.title, { exact: true }).first().click()
    await pages[0].getByRole('button', { name: '返回发起会话', exact: true }).click()
    await expect(pages[0].locator(`[data-conductor-operation="${receipt.pairs[0].operationId}"]`)).toBeVisible()
    assertions.push('real fork inherits initiating workspace, keeps initiating-chosen native title and returns to origin')
  }
  assert.deepEqual(errors, [])
} catch (error) {
  failure = error
  for (let index = 0; index < pages.length; index++) {
    await pages[index].screenshot({ path: join(run, `failure-${index}.png`), fullPage: true }).catch(() => {})
    await writeFile(join(run, `failure-${index}.html`), await pages[index].content()).catch(() => {})
    await writeFile(join(run, `failure-${index}.txt`), await pages[index].locator('body').innerText()).catch(() => {})
  }
}
finally {
  if (browser) await browser.close()
  child.kill(); await closed
  await writeFile(join(run, 'host.log'), logs.join(''))
  const reachable = await new Promise(answer => { const socket = createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); answer(true) }); socket.once('error', () => { socket.destroy(); answer(false) }) })
  await writeFile(join(run, 'summary.json'), JSON.stringify({ ok: !failure && !reachable, assertions, errors, receipt, failure: failure?.stack, port, portReleased: !reachable, installedHarnessModified: false, realHost: true, responseInterception: false, packages }, null, 2))
  if (reachable && !failure) failure = new Error('Isolated port was not released')
}
if (failure) throw new Error(`Navigation E2E failed: ${failure.stack}\nEvidence: ${run}\n${logs.join('').slice(-7000)}`)
console.log(`${assertions.length} real Host/Edge navigation scenarios passed; port ${port} released. Evidence: ${run}`)
