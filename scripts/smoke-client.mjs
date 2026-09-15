/** Built closure factory and native-slot contract. Real rendering is verified separately in Edge. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const require = createRequire(import.meta.url), asked = []
let loaded
globalThis.window = { __ModuleLoader__: { load(entry) { loaded = entry } } }
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function(source)()
assert.equal(loaded.id, 'dsh-session-conductor')
const client = loaded.factory(specifier => {
  asked.push(specifier)
  assert.equal(specifier, 'react', `Unsupported platform import ${specifier}`)
  return require(specifier)
})
assert(asked.length > 0)
assert.deepEqual(client.inject, ['slots', 'sessions', 'conversationEvents'])
const registrations = [], definitions = [], cleanups = []
client.apply({
  sessions: { open() {}, list: { getSnapshot: () => ({ ids: ['parent', 'child'] }) } },
  conversationEvents: { register(definition) { definitions.push(definition) } },
  effect(callback) { cleanups.push(callback()) },
  slots: {
    inject(_key, callback) { cleanups.push(callback()) },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
})
assert.deepEqual(registrations.map(value => value.options.name), ['conversation.chat.node', 'conversation.session.header.actions'])
assert.equal(registrations[0].options.key, client.LINK_NODE_KIND)
assert.equal(definitions[0], client.creationLinkDefinition)
assert(!source.includes('conductor-panel'), 'Legacy panel leaked into the active bundle')
const port = { subscribe() { return () => {} }, close() {} }
const props = { sessionId: 'parent', port, sessions: { open() {}, list: { getSnapshot: () => ({ ids: [] }) } } }
const markup = renderToStaticMarkup(createElement(client.CreatedSessionCard, { ...props, node: { data: { operationId: 'op', title: '<unsafe>', failed: false, seq: 1 } } }))
assert(markup.includes('正在创建会话'))
assert(markup.includes('&lt;unsafe&gt;'))
assert(markup.includes('disabled=""'))
assert.equal(renderToStaticMarkup(createElement(client.SessionOrigin, props)), '')
for (const cleanup of cleanups.reverse()) cleanup()
delete globalThis.window
console.log('Native client closure, declared services, additive slots, escaped pending card and cleanup passed.')
