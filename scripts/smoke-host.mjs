/**
 * Load-side smoke test for the built host half.
 *
 * It imports `lib/index.js` the way the Host Loader does, then mounts `apply`
 * with a stand-in Cordis context and asserts the observable contract: which
 * tools appear, what the capability report says, that every disabled feature
 * carries a reason, and that the durable store opens or reports why it did not.
 *
 * It deliberately does not construct a real Host — `scripts/verify/boot-profile.mjs`
 * does that.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const entry = pathToFileURL(resolve('lib/index.js')).href
const plugin = await import(entry)

assert.equal(plugin.name, 'dsh-session-conductor', 'plugin name must match the bundle row id')
assert.deepEqual(
  plugin.inject,
  [],
  'no hard dependency: an unmet injection would hide the plugin entirely instead of reporting the gap',
)
assert.equal(typeof plugin.apply, 'function', 'apply must be exported')

/** A table-like object backed by a Map, enough for the store's read paths. */
function memoryTable() {
  const records = new Map()
  return {
    get: key => records.get(key),
    entries: () => new Map(records).entries(),
    keys: () => new Map(records).keys(),
    get size() { return records.size },
    put: async (key, value) => { records.set(key, value) },
    delete: async key => records.delete(key),
    update: async (key, fn) => {
      const next = fn(records.get(key))
      records.set(key, next)
      return next
    },
  }
}

const tables = new Map()
let domainClosed = false
const openedDomain = {
  name: 'session_conductor',
  global: { get: () => ({ schemaVersion: 1 }), set: async () => {} },
  table: name => {
    if (!tables.has(name)) tables.set(name, memoryTable())
    return tables.get(name)
  },
  close: async () => { domainClosed = true },
}

/** Minimal stand-in for the Host tool registry and the services the probe reads. */
const registered = []
const unregistered = new Set()
const effects = []
const services = {
  tools: { register: definition => { registered.push(definition); return () => { unregistered.add(definition.name) } } },
  agents: { list: () => [] },
  sessionQuery: { listSessions: () => [] },
  storageDomain: { open: async () => openedDomain },
}
// Cordis exposes a service both as a context property and through
// `ctx.get(name)`; the conductor looks everything up through `ctx.get` so that
// a composition missing a service is a reported gap rather than a crash.
const ctx = {
  ...services,
  get: name => services[name],
  // Cordis's `effect` contract, faithfully: it CALLS the callback and registers what the callback
  // *returns* as the disposer. Storing the callback itself would make this stand-in look like it
  // had 29 owned registrations while none of them could actually be disposed, which is exactly the
  // teardown leak this smoke now checks for.
  effect: callback => {
    const disposer = callback()
    if (typeof disposer === 'function') effects.push(disposer)
  },
}
const config = {
  managedTargetLimit: 20,
  targetTurnConcurrency: 4,
  noticeConcurrency: 1,
  panelRefreshMergeMs: 250,
  noticeMergeWindowMs: 2000,
  defaultReadLimit: 20,
  toolTextLimit: 12000,
  waitLimitMs: 60000,
  interruptConfirmLimitMs: 30000,
  reworkRounds: 2,
  crossHostEnabled: false,
  shareEnabled: false,
  hostExtensions: { selectModelRememberAsDefault: false, forkTargetParameters: false },
}

plugin.apply(ctx, config)

const byName = new Map(registered.map(definition => [definition.name, definition]))
assert.deepEqual(
  [...byName.keys()].sort(),
  [
    'conductor_access', 'conductor_artifact_accept', 'conductor_artifact_list', 'conductor_artifact_open',
    'conductor_artifact_read', 'conductor_artifact_register',
    'conductor_artifact_verify', 'conductor_attach',     'conductor_brief', 'conductor_budget',
    'conductor_capabilities', 'conductor_cleanup', 'conductor_constraints', 'conductor_create', 'conductor_discover',
    'conductor_export', 'conductor_fork', 'conductor_handoff', 'conductor_list',
    'conductor_model', 'conductor_operation', 'conductor_queue', 'conductor_read', 'conductor_remote',
    'conductor_rule', 'conductor_schedule', 'conductor_send', 'conductor_share', 'conductor_stop',
    'conductor_transfer', 'conductor_update', 'conductor_wait', 'conductor_watch',
    'conductor_workflow',
  ],
)
assert.ok(effects.length >= registered.length, 'registered tools must have context-owned teardown')

const capabilities = byName.get('conductor_capabilities')
const value = await capabilities.execute({}, {})
assert.equal(value.protocolVersion, '1.0')
assert.equal(value.dataSchemaVersion, 1)
assert.match(value.summary, /dsh-session-conductor/)

const disabled = new Map(value.disabledFeatures.map(entry => [entry.feature, entry.reason]))
assert.ok(disabled.has('model_selection_isolated'), 'model selection stays off without the Host extension')
assert.ok(disabled.has('fork_target_control'), 'fork target control stays off without the Host extension')
assert.match(disabled.get('fork_target_control'), /host-extension/)
assert.ok(!disabled.has('model_tools'), 'the tool registry is present, so model tools are enabled')
assert.ok(!disabled.has('session_driving'), 'the agent registry is present, so session driving is enabled')
assert.ok(!disabled.has('durable_state'), 'the storage domain facility is present, so durable state is enabled')
assert.ok(disabled.has('workspace_registration'), 'no workspace registry in this stand-in')

// The domain opens asynchronously, so the first snapshot legitimately says it is
// not open yet; after a tick the store must report itself available.
assert.equal(value.durableState.available, false, 'storage open is asynchronous, never claimed early')
await new Promise(resolve => setTimeout(resolve, 0))
const settled = await capabilities.execute({}, {})
assert.equal(settled.durableState.available, true, 'the store opens once the facility resolves')
assert.match(settled.summary, /Durable state: open/)

// The listing tool reads that store and reports an empty result honestly.
const listing = await byName.get('conductor_list').execute({}, {})
assert.equal(listing.total, 0)
assert.equal(listing.offset, 0)
assert.equal(listing.unavailableReason, undefined)

// The mount report goes to stderr rather than through the Host logger, so a
// missing logger cannot make "mounted" and "never loaded" look the same.
assert.equal(ctx.logger, undefined, 'this stand-in deliberately has no Host logger')

// A Host without a tool registry must still mount and report, not disappear.
// An entry whose injections are unmet stays pending with no error at all, which
// is exactly the failure mode this design avoids.
const bareCtx = { get: () => undefined, effect: () => {}, inject: () => {} }
plugin.apply(bareCtx, config)

// A declared action is a promise. `conductor_export` used to offer `publish`, `status` and `revoke`,
// none of which its routing implemented — so asking it to publish silently performed an export.
// The enum is asserted here because that is the whole defect: an action the tool cannot perform must
// not appear in its schema.
const exportActions = byName.get('conductor_export').parameters.properties.action.enum
assert.deepEqual(
  [...exportActions],
  ['export', 'share', 'rules'],
  'conductor_export must offer only the actions it routes',
)
const shareActions = byName.get('conductor_share').parameters.properties.action.enum
assert.deepEqual(
  [...shareActions],
  ['preview', 'publish', 'status', 'revoke', 'list'],
  'sharing lives in conductor_share, and its actions must match its routing',
)
const cleanupActions = byName.get('conductor_cleanup').parameters.properties.action.enum
assert.deepEqual(
  [...cleanupActions],
  ['preview', 'execute'],
  'cleanup offers only preview and execute; stop and uninstall never delete',
)

// The same rule for a filter vocabulary: PRD §二.5 names the filters a task list must offer, and a filter
// whose schema offers a status the panel cannot produce would be a filter that can only ever return nothing.
// The enum is asserted against the panel's own vocabulary rather than a copy of it, so the two cannot drift.
const listParams = byName.get('conductor_list').parameters.properties
assert.deepEqual(
  [...listParams.status.enum],
  ['preparing', 'preparation_failed', 'cancelled', 'released', 'budget_limited', 'waiting_user', 'running', 'idle'],
  'conductor_list must offer exactly the statuses the panel filters and groups by',
)
for (const name of ['project', 'name', 'hostId', 'status', 'query', 'offset', 'limit']) {
  assert.ok(listParams[name] !== undefined, `conductor_list must declare the §二.5 filter "${name}"`)
}
assert.ok(byName.get('conductor_discover').parameters.properties.offset !== undefined, 'conductor_discover paginates with offset')

// Teardown, and the reason it is here: the conductor owns a self-rescheduling background pass
// timer that it starts *after* the storage domain opens, so its disposer is registered later than
// the 29 tool registrations. A mounted plugin whose timer could not be stopped would keep a Host's
// event loop alive after teardown, so the disposers are run and the process is expected to exit on
// its own — no `process.exit` here, because that would hide exactly the leak this checks for.
await new Promise(resolve => setTimeout(resolve, 50))
assert.ok(effects.length > 29, `the background pass registers its own disposer (got ${String(effects.length)})`)
for (const dispose of effects.reverse()) {
  if (typeof dispose === 'function') await dispose()
}
assert.deepEqual([...unregistered].sort(), [...byName.keys()].sort(), 'every mounted tool is unregistered on teardown')
assert.equal(domainClosed, true, 'the opened durable domain is closed on teardown')

console.log('host-half smoke: OK')
console.log(settled.summary)
