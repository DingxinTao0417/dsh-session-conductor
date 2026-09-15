/**
 * Diagnostic: which timers survive the host-half smoke's teardown, and who scheduled them?
 *
 * Test scaffolding only. Wraps `setTimeout`/`clearTimeout` so every live timer can be reported with
 * the stack that created it, then imports the smoke (which has no exports and runs on import).
 */

import { pathToFileURL } from 'node:url'

/** Live timers, keyed by the handle `setTimeout` returned. */
const live = new Map()
const originalSet = globalThis.setTimeout
const originalClear = globalThis.clearTimeout

globalThis.setTimeout = function trackedSetTimeout(callback, delay, ...rest) {
  const handle = originalSet.call(globalThis, callback, delay, ...rest)
  const stack = new Error('scheduled here').stack?.split('\n').slice(2, 6).join('\n') ?? '<no stack>'
  live.set(handle, { delay, stack })
  return handle
}
globalThis.clearTimeout = function trackedClearTimeout(handle) {
  live.delete(handle)
  return originalClear.call(globalThis, handle)
}

try {
  await import(pathToFileURL(new URL('../smoke-host.mjs', import.meta.url).pathname.replace(/^\//, '')).href)
} catch (error) {
  process.stderr.write(`timer-probe: the smoke itself failed: ${String(error?.stack ?? error)}\n`)
}

originalSet.call(globalThis, () => {
  process.stderr.write(`timer-probe: ${String(live.size)} timer(s) still live after teardown\n`)
  for (const [handle, info] of live) {
    process.stderr.write(`timer-probe: --- delay=${String(info.delay)}\n${info.stack}\n`)
    originalClear.call(globalThis, handle)
  }
  process.exit(0)
}, 1500)
