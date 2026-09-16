/** Isolated real-Host fixture for manual/in-app browser QA. Write stop.json in the run directory to stop.
 * Set CONDUCTOR_LAYOUT_REGRESSION=1 for long titles, 114 sources, scrollable answers and a Desktop frame simulation.
 * Also set CONDUCTOR_COLD_SESSION_VERIFY=1 to assert real HTTP reads of a disposed, persisted fixture Session.
 * Cold verification is opt-in so the same layout fixture remains usable against older sealed packages.
 * Set CONDUCTOR_SUBAGENTS_VERIFY=1 for real native spawn/continuable/catalog/history fixtures.
 * Native verification adds exactly three offline child calls (one completed and two held until teardown),
 * plus one public-API missing-descriptor diagnostic. Default mode remains two calls; neither wakes the parent.
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.env.CONDUCTOR_ELECTRON, asar = process.env.CONDUCTOR_ASAR
const main = process.env.CONDUCTOR_PACKAGE, compat = process.env.CONDUCTOR_COMPAT
const layoutRegression = process.env.CONDUCTOR_LAYOUT_REGRESSION === '1'
if (!executable || !asar || !main || !compat) throw Error('Set the four verified CONDUCTOR runtime/package paths; no installed profile is used.')
const run = join(root, '.verification', 'overview-' + new Date().toISOString().replace(/[:.]/g, '-'))
const home = join(run, 'home'), profile = join(home, 'profiles', 'overview'), fixture = join(run, 'fixture')
await mkdir(join(profile, 'node_modules'), { recursive: true }); await mkdir(fixture); await mkdir(join(run, 'workspace'))
await copyFile(join(root, 'scripts/overview-host-probe.mjs'), join(fixture, 'probe.mjs'))
await writeFile(join(fixture, 'hmr.mjs'), 'export function apply(ctx) { ctx.provide("hmr", { registerConfig: async () => () => {} }) }\n')
if (layoutRegression) {
  // A real client half in the Host's closure-factory format. These styles reproduce
  // Desktop's framed-shell containing block; they do not alter the installed ASAR.
  // Evidence: .verification/overview-022-desktop-wrapper-evidence.json.
  const frameCss = `
html:has(body[data-conductor-desktop-layout-fixture]),body[data-conductor-desktop-layout-fixture]{width:100%;height:100%}
body[data-conductor-desktop-layout-fixture]{--dsh-desktop-frame-height:36px;margin:0;overflow:hidden;background:transparent!important}
body[data-conductor-desktop-layout-fixture] #root{box-sizing:border-box;position:fixed;top:36px;right:0;bottom:0;left:0;width:auto;height:auto;padding-top:0;overflow:hidden;transform:translateZ(0)}
body[data-conductor-desktop-layout-fixture] [data-shell-overlay]{overflow:hidden;transform:translateZ(0)}
[data-conductor-fixture-frame]{position:fixed;top:0;left:0;right:0;height:36px;display:flex;align-items:center;justify-content:center;z-index:2147483647;font:12px system-ui;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-1,#f8f8f8);border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);box-sizing:border-box;pointer-events:none}
`
  await writeFile(join(fixture, 'client.js'), `window.__ModuleLoader__.load({ id: "conductor-overview-fixture", factory: (_require) => {
var module = { exports: {} }; var exports = module.exports;
exports.name = "conductor-overview-desktop-frame-fixture";
exports.apply = function (ctx) {
  ctx.effect(function () {
    var body = document.body;
    var previous = body.getAttribute("data-conductor-desktop-layout-fixture");
    var style = document.createElement("style");
    style.setAttribute("data-conductor-desktop-layout-fixture-style", "");
    style.textContent = ${JSON.stringify(frameCss)};
    var frame = document.createElement("div");
    frame.setAttribute("data-conductor-fixture-frame", "");
    frame.textContent = "隔离测试 · Desktop 兼容模式布局仿真（36 px）";
    body.setAttribute("data-conductor-desktop-layout-fixture", "compatibility");
    document.head.appendChild(style); body.appendChild(frame);
    return function () {
      style.remove(); frame.remove();
      if (previous === null) body.removeAttribute("data-conductor-desktop-layout-fixture");
      else body.setAttribute("data-conductor-desktop-layout-fixture", previous);
    };
  }, "fixture: Desktop transformed content viewport");
};
return module.exports; } });\n`)
}
await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'conductor-overview-fixture', private: true, type: 'module',
  exports: { '.': './probe.mjs', './probe': './probe.mjs', './hmr': './hmr.mjs', ...(layoutRegression ? { './client': './client.js' } : {}) },
  ...(layoutRegression ? { dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-conversation'], immediately: true } } } : {}),
}))
const packages = { 'dsh-session-conductor': resolve(main), 'dsh-harness-compat': resolve(compat), 'conductor-overview-fixture': fixture }
for (const [name, path] of Object.entries(packages)) await symlink(path, join(profile, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'conductor-overview-isolated-profile', private: true,
  dependencies: Object.fromEntries(Object.entries(packages).map(([name, path]) => [name, 'link:' + path.replaceAll('\\', '/')])),
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-harness-compat', 'dsh-session-conductor'] } } }, null, 2))
await writeFile(join(profile, 'cordis.yml'), '[]\n')
const overlay = join(run, 'overlay.yml')
await writeFile(overlay, '- id: dsh-session-conductor\n  config:\n    hostExtensions:\n      selectModelRememberAsDefault: true\n      forkTargetParameters: true\n- insert:\n    - id: overview-hmr\n      name: conductor-overview-fixture/hmr\n    - id: overview-probe\n      name: conductor-overview-fixture' + (layoutRegression ? '' : '/probe') + '\n')
await writeFile(join(run, 'boot.mjs'), 'import { join } from "node:path"; import { pathToFileURL } from "node:url"; const { installProfilePackageResolver } = await import(pathToFileURL(join(process.env.BINARY_ASAR, "lib/module-resolution.js")).href); installProfilePackageResolver(pathToFileURL(join(process.env.BINARY_PROFILE, "package.json")).href); const { runDesktopDshCli } = await import(pathToFileURL(join(process.env.BINARY_ASAR, "lib/desktop-cli.js")).href); await runDesktopDshCli();\n')
const reservation = createServer()
await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done) })
const port = reservation.address().port; await new Promise(done => reservation.close(done))
const logs = []
const child = spawn(executable, ['--expose-internals', join(run, 'boot.mjs'), '--profile', 'overview', '--patch', overlay, '--port', String(port)], {
  cwd: run, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, BINARY_PROFILE: profile, BINARY_ASAR: asar, BINARY_RUN: run, BINARY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', data => logs.push(data.toString())); child.stderr.on('data', data => logs.push(data.toString()))
let exited = false, failure
const closed = new Promise(done => { child.once('error', error => { failure = error; exited = true; done() }); child.once('close', () => { exited = true; done() }) })
const pause = ms => new Promise(done => setTimeout(done, ms))
process.on('SIGINT', () => { child.kill() }); process.on('SIGTERM', () => { child.kill() })
try {
  let ready
  const deadline = Date.now() + 55000
  while (!exited && Date.now() < deadline) {
    try { ready = JSON.parse(await readFile(join(run, 'ready.json'), 'utf8')); break } catch {}
    try { const failed = JSON.parse(await readFile(join(run, 'failed.json'), 'utf8')); throw Error(failed.error) } catch (error) { if (error.code !== 'ENOENT') throw error }
    await pause(200)
  }
  if (!ready) throw failure ?? Error('Isolated Host did not become ready')
  await writeFile(join(run, 'preview.json'), JSON.stringify({ url: 'http://127.0.0.1:' + port, run, ready }, null, 2))
  console.log(JSON.stringify({ url: 'http://127.0.0.1:' + port, run, ready }))
  while (!exited) {
    try { await readFile(join(run, 'stop.json')); break } catch {}
    await pause(500)
  }
} catch (error) { failure = error; console.error(error.stack) }
finally {
  if (!exited) child.kill()
  await closed
  await writeFile(join(run, 'host.log'), logs.join(''))
  const reachable = await new Promise(answer => { const socket = createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); answer(true) }); socket.once('error', () => { socket.destroy(); answer(false) }) })
  await writeFile(join(run, 'cleanup.json'), JSON.stringify({ port, portReleased: !reachable, installedHarnessModified: false, failure: failure?.stack }, null, 2))
  if (failure || reachable) process.exitCode = 1
  console.log('Host stopped. Port released: ' + !reachable + '. Evidence: ' + run)
  if (failure) console.log(logs.join('').slice(-6000))
}
