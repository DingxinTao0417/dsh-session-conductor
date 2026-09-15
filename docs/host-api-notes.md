# Host API notes

Working notes on the DeepSeek Harness surfaces this plugin builds against. They
exist so that later work does not re-derive them, and so that a claim can be
traced to the file it came from.

Every entry names the source it was read from. Where the source is a **source
checkout** rather than the **installed runtime**, that is stated: the two are
different versions on the reference machine (see `docs/compatibility.md`), and
an API read from the older checkout must be re-confirmed against the installed
runtime before a feature depends on it.

## 1. Service keys

Read from the source checkout `D:\workspace\deepseek-harness`
(`0.1.0-rc.5`, commit `47f943859b`) unless noted.

| Key | Interface | Notes |
| --- | --- | --- |
| `ctx.tools` | `ToolRuntime` | Tool registry. `register(definition)` returns a disposer. |
| `ctx.agents` | `AgentRegistry` | `create`, `resume`, `get`, `list`, `register`. |
| `ctx.sessions` | `SessionStore` | `create`, `prepare`, `get`, `list`, `flush`, `fork`. |
| `ctx.sessionQuery` | `SessionQueryEngine` | Session and event search and reads. |
| `ctx.sessionPersistence` | `SessionPersistence` | Durable session logs; required by `agents.resume`. |
| `ctx.storageDomain` | `DomainFacility` | **The plugin data store.** See §3. |
| `ctx.storage` | `Storage` | Hub: backend registry and mounted forms. No `get`/`set`. |
| `ctx.settings` | `SettingsProvider` | Persisted user settings (`$DSH_HOME/settings.yaml`). |
| `ctx.workspaceRegistry` | `WorkspaceRegistry` | **Not `ctx.workspaces`** — that key does not exist. |
| `ctx.subprocess` | `SubprocessRuntime` | The only way to run `git` (PRD §二.4). `spawn(spec)` is **synchronous** and applies no defaults: `argv`, `cwd`, `stdio` and `graceMs` are all required. |
| `ctx.fs` | `FileSystem` | Twelve primitives, and **no copy, no create-directory, no remove** — see §3. |
| `ctx.approval` | `ApprovalService` | `request(req)` → `allowed-once \| rejected \| cancelled \| unavailable`. |
| `ctx.userQuestions` | `UserQuestionService` | `ask(request)`; refuses a delegated caller. |
| `ctx.sessionTitle` | `SessionTitleService` | Rename support. |
| `ctx.jobs` | `JobRegistry` | Background job registry. |

A key that a composition does not mount is simply absent; `ctx.get(name)`
returns `undefined`. The conductor probes rather than injects everything except
`tools`, so a partial composition still loads and reports what is missing.

## 2. Driving an ordinary session

Read from the source checkout; the load-bearing calls are the same shape in the
installed runtime and are re-checked by the smoke test.

- Create: `ctx.agents.create({ sessionId, seed?, meta?, agentOptions?, setup? })`
  → `AgentHandle`. `meta` carries `cwd`, `parentSession`, `seedLength`,
  `agentPreset`. `seed` is a balanced completed-turn prefix of a parent log —
  it is the fork mechanism.
- Resume: `ctx.agents.resume({ resumeSessionId, agentOptions?, setup? })`.
  Requires `sessionPersistence`.
- Drive: `followup(message)` queues its own turn and wakes the driver;
  `steer(message)` targets the nearest step boundary; `inject(message)` queues
  model-facing context without waking.
- Stop: `cancel(cause, options?)` where `cause` is
  `{ kind: 'user' | 'parent' | 'hook' | 'disposed' }`. There is no bare
  `cancel()`.
- Observe: `status` is `'idle' | 'running'`; `whenIdle()` resolves when the
  whole agent reaches quiescence. **`whenIdle()` does not identify the end of
  any particular message**, which is exactly why the specification forbids
  using it as a substitute for a specified turn's end receipt
  (PRD §二.6).
- Tear down: `AgentHandle.dispose()`, not `Agent.dispose()`.
- The agent id **is** the `SessionId`; there is no separate `AgentId` type.

Session events (`ctx.on('session/event', (session, event) => …)`): `turn/start`,
`turn/end` (its `data.reason` distinguishes `completed`, `aborted`, `blocked`,
`error`, `max-tokens`), `step/start`, `step/end`, `user/message`,
`assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`,
`approval/asked`, `approval/decided`. Each event carries `seq` and `time`.

A user question is **not** a session event; it exists only as a transport frame.
Any "needs intervention" projection therefore has to combine the session event
stream with the approval and question services, not read one log.

### Cancellation and the inbox (measured)

PRD §二.6 requires an exact stop to verify the expected turn and cancel it inside
one critical section, with no asynchronous yield in between, and forbids claiming
the feature otherwise. What the pinned runtime actually offers:

- `agent.status` is a synchronous projection (`'idle' | 'running'`).
- `agent.cancel(cause, options?)` is a **synchronous** call returning `void`. The
  causes are `{kind:'user'} | {kind:'parent'} | {kind:'hook', reason} |
  {kind:'disposed'}`.
- `CancelOptions.keepInbox` preserves un-started and pending work across the
  cancel. Without it the default clears queued and steering work too, which for a
  conductor would silently destroy input it did not author.
- `agent.inbox` is a synchronous projection of pending input: `nextTurn` (prompts
  awaiting their own turns — the queue), `nextStep` (input awaiting the next step
  boundary — steering), `hasPending`, plus `remove(messageId)` and
  `replace(messageId, newMessage)`, which durably record the cancellation or swap.
  Those two are what PRD §二.6's "view, edit and withdraw unconsumed messages"
  needs, and they are typed against the Host's own `MessageId` rather than a local
  stand-in.
- **`turnStartSeq` does not exist.** It is named by the PRD, but a search of both
  the installed runtime's declarations and the PRD's own baseline commit finds no
  such member. The available turn identity is the durable event log: `turn/start`
  and `turn/end` carry the Host's own turn number, so the open turn and the
  sequence it began at are derived by folding that log. The conductor uses that as
  its anchor and says so in `docs/compatibility.md` rather than pretending the
  named member exists.

## 3. Plugin persistence

- Declare a domain with `defineDomain({ name, version, global?, tables })`.
  The name is lowercase snake case, is global (not namespaced per plugin), and
  becomes the storage file name.
- Open it with `ctx.storageDomain.open(spec)` → `Domain`; then
  `domain.table(name)` → `KvTable` with `get`, `entries`, `keys`, `size`, `put`,
  `delete`, `update` (atomic read-modify-write on the domain's write chain), and
  `domain.global` for a single-slot document.
- There are **no transactions across records**, no secondary indexes, and no
  migration helper. Each write is atomic on the medium on its own.
- **Measured:** adding a table to the domain spec does **not** reject an existing
  medium. Rounds 8–13 each added tables (`contexts`, `artifacts`, `transfers`,
  `rules`, `schedules`) to a store already written by earlier rounds, and every
  live open succeeded with the new table present. The version stamp is what
  rejects, not the table set — so a new table is compatible, while a changed
  record shape is not.
- A version mismatch is a hard rejection at open, not a migration: the medium
  is stamped with the domain version and a mismatch raises. Schema drift in a
  stored record raises `invalid-record` at open, which under fail-loud boot
  stops the assembly.
- The JSON backend rewrites the whole document per write and has no
  cross-process write locking. High-churn data belongs on the SQLite backend,
  which a deployment selects by routing the domain.

Consequences the conductor must respect: keep the record granular enough that a
whole-document rewrite per write is acceptable, and treat "the stored schema no
longer matches the code" as a case to detect and report, never as a case to
overwrite.

### Time zones (measured)

Schedule support resolves local times through the runtime's ICU data rather than
a bundled zone table, and two of its behaviours were measured rather than assumed:

- `new Intl.DateTimeFormat('en-US', { timeZone: '…' })` **throws** for an
  unresolvable name such as `Mars/Olympus_Mons`, and that throw is the only
  reliable check — the runtime silently falls back to the machine's local zone
  otherwise, which would run a calendar plan at a local time nobody chose.
- A bare UTC offset such as `+08:00` **is** accepted as a fixed-offset zone. It is
  allowed through deliberately: a local time in a fixed offset is exactly well
  defined and can never be skipped or repeated, so there is nothing to be
  ambiguous about.


## 4. Registers, effects and lifecycle

- `ctx.effect(() => disposer, label?)` is the registration-plus-teardown
  primitive. Every registration the conductor makes goes through it.
- `ctx.inject(deps, callback)` activates a block only while those services
  exist — the graceful-degradation boundary.
- `ctx.on(event, listener)` is itself an effect.
- There is **no `ctx.on('ready')`**. Startup work belongs in dependency
  resolution, an injected callback, or a service's init hook; an `apply` that
  needs the tree mounted can await `ctx.get('loader')?.await()`.
- Services are reachable both as context properties (`ctx.tools`) and through
  `ctx.get('tools')`.

## 5. Remote (host ↔ browser) and the client half

Read from the source checkout. Not yet used by this plugin; recorded because
the panel milestone depends on it.

- `@Remote('name')` comes from `@deepseek-ai/dsh-typert-protocol` and requires
  the method to be a public instance method on a service that extends
  `TypertRemoteService` (or binds `typertRemote` explicitly). The `ctx` service
  key is the wire namespace.
- The generated contract is emitted by the Host's tsdown pass into
  `lib/typert.host.{js,d.ts}` and `lib/typert.remote-client.{js,d.ts}`, exported
  as `./typert` and `./remote`. An out-of-tree package must produce these
  itself.
- Arguments and results are strict JSON. An `Agent` parameter never crosses the
  wire: it is declared as a lookup and becomes an `agentId` string.
- **There is no authentication.** The `/api` fence checks the `Host` header,
  `sec-fetch-site`, and `Origin`; the documentation states plainly that this is
  a DNS-rebinding fence and not an auth layer. The `agentId` in a call is
  supplied by the caller and not verified against it. The specification's
  server-side authorization requirement (PRD §四.2) is therefore fully
  satisfiable for the **model-tool** surface, where `exec.agent` is Host-owned,
  and only partially for a browser surface, where the caller identity is not
  established by the Host. This must be stated in the panel's documentation
  rather than papered over.

### The Remote surface does not need the codegen pipeline (measured)

Round 24's finding about the client half raised the obvious next question: the panel has a
registration path but **no data source**, and PRD §三.2 wants the front end to call
"corresponding Remote methods". An earlier note in this section said an out-of-tree
package "must produce the generated artifacts itself", which would mean a generator this
environment does not have. Reading the protocol package shows that conclusion was **too
strong**:

- `@Remote` marks a public instance method, and the decorators "retain markers in a
  module-private `WeakMap` keyed on the Service prototype" — they add no constructor
  symbols and need no compiler-injected metadata;
- `remoteMethods(service)` returns "a detached declaration-order snapshot used by the
  Gateway's **SRC fallback**";
- the Gateway's own types confirm it: it resolves "strict generated definitions **or
  conservative SRC markers**", and one invocation mode is literally `'src-json'`.

So a plugin can register remote methods at runtime through `bindTypertRemote(this, key)`
and the Gateway will reflect them conservatively, without the Typert build pipeline. What
the generated artifacts add is *precision* — parameter, result and schema reflection —
rather than the ability to be called at all.

Two facts a future round will need, both checked rather than assumed:

- the decorators are **standard TC39 method decorators**
  (`ClassMethodDecoratorContext`), not legacy `experimentalDecorators`, so this project's
  `target: ES2023` tsconfig needs no flag added;
- the wire namespace is the Cordis service key passed to `super(ctx, key)` or
  `bindTypertRemote`, so the service key and the wire namespace are one decision, not two.

**Not implemented yet.** The Host-side Remote service, the client's call path and the
panel's rendering are the remaining work on this path, and none of them is claimed here.

### …but the client cannot reach a plugin's Remote anyway (measured)

Round 26 followed that up, and the Host's own gateway documentation closes the path for a
third-party plugin:

> The Host methods visible to any Client assembly are **limited to the Remote methods
> selected at generation time**. … Adding a Host Remote package is an explicit choice by
> the **Client composition owner**.

The client assembly is `@deepseek-ai/dsh-api-remotes`, a **Host-owned package** that
"imports the `/remote` subpaths of selected business packages as runtime values, mounts
their contributions through `ctx.remote.$mount()`". A plugin cannot add itself to that
selection, and making it happen would mean editing the installed Harness — which the
working rules forbid outright ("不自动修改用户已安装的 Harness").

So the SRC fallback makes a Remote *callable in principle*, while the client's assembled
descriptor set makes it *unreachable in practice*. Registering one would produce a Remote
that exists on the Host and cannot be called from the browser — worse than no Remote,
because it looks like one.

**What a plugin can own instead.** `ctx.webServer` is "a node:http server plus the
`webServer` service (HTTP and upgrade route registries …)", built for composing
applications to register routes on: `register({ name, kind: 'exact' | 'prefix', path,
handler })` returning a disposer. The panel reads a route this plugin registers itself,
which makes the transport the plugin's own responsibility instead of something it hopes a
Host package will expose. That deviation from PRD §三.2's "the front end uses the
corresponding Remote methods" is forced by the Host's assembly rule, and is recorded here
rather than passed over.

**The route is not an authorization boundary, and does not pretend to be.** The same
section of this file records that the Host's `/api` fence "is a DNS-rebinding fence and
not an auth layer" and that a browser caller's identity is not established by the Host. A
read-only route is therefore no more exposed than the surface beside it. Everything that
*mutates* stays behind the `conductor_*` tools, where the caller identity comes from the
Host's own execution context (PRD §三.2) — the panel is a view and is given no way to
change anything.


### The client half: the contract is readable even though the preset is not published

Round 18 recorded this as blocked on unpublished Host tooling and did not attempt it.


Round 18 recorded this as blocked on unpublished Host tooling and did not attempt it.
That verdict was **reached too early**: the preset is not a published package, but its
contract is readable from the source checkout, and reproducing it deliberately is a
different thing from guessing at it. What the Host's own client preset fixes, and what
this plugin's `tsdown.client.config.ts` therefore reproduces value by value:

- the artifact is **not an ES module** — `format: 'cjs'` with a banner
  `window.__ModuleLoader__.load({ id, factory: (require) => {`, an intro
  `var module = { exports: {} }; var exports = module.exports;`, and a footer
  `return module.exports; } });`;
- `platform: 'browser'`, `outDir: 'lib'`, `outputOptions.entryFileNames: 'client.js'`,
  and `clean: false` so the browser bundle does not wipe the node half beside it;
- **externals are the platform module table** and nothing else; everything else inlines,
  because a `require()` the frozen table cannot answer is a guaranteed throw at boot. The
  table is `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
  `@deepseek-ai/cordis`, and five `@deepseek-ai/dsh-client-*` UI packages;
- the `define` substitutions for `process.env.NODE_ENV` and both `import.meta.env` forms,
  without which an inlined browser library throws `ReferenceError` in the factory;
- the manifest declaration: `exports["./client"]` plus
  `dsh.client = { platform: 'web', immediately: true }`.

The Host's build **also** applies a purity gate rejecting cross-plugin value imports. That
gate is deliberately not reproduced: it is a workspace-wide invariant, while this plugin's
client half imports exactly one thing (`react`, a platform module), so the gate would be a
rule with nothing to enforce. If a second client-side import is ever added, the gate
becomes worth having and this note is the place to say so.

Fetched from a live Host, the bundle arrives over the shell's own plugin route:

```
GET /plugins/dsh-session-conductor/client.js → 200, 6950 bytes
window.__ModuleLoader__.load({ id: "dsh-session-conductor", factory: (require) => {
GET /plugins/@deepseek-ai/dsh-api-remotes/client.js → 200, 205655 bytes   (the Host's own, for comparison)
```

**What is still not verified** is rendering: there is no browser in this environment, so
whether the panel appears correctly once a real shell mounts it is untested. The bundle
loads, its module graph resolves, its registration path is exercised against a fake slot
registry, and React renders its markup server-side — but none of that is the same as
seeing it in a browser, and it is recorded as untested.

## 6. Packaging an out-of-tree bundle

- A bundle is an npm package declaring `dsh.bundle.patch`; the profile's
  `dsh.profile.bundles` list orders the layers. Later layers win per row, and a
  patch replaces a row's whole `config`.
- Install with `dsh plugin --profile <name> add <spec>`; the tool forwards to
  pnpm in the profile directory and appends the bundle when the installed
  package declares `dsh.bundle`.
- A row's bare `name` resolves as a Node bare specifier from the profile
  directory. The desktop runtime additionally installs a resolution hook that
  falls back to its own installation for `@deepseek-ai/*` specifiers, which is
  why those packages may stay external and are declared as `peerDependencies`.
- A client half needs `exports["./client"]`, a `dsh.client` declaration, and a
  bundle built as CJS wrapped in
  `window.__ModuleLoader__.load({ id, factory })` with the platform module
  table (`react`, `react-dom`, the client runtime and UI slots/primitives)
  external. A missing bundle file is a loud activation error, so the bundle must
  exist before launch.
- `pnpm run dev:web`, the repository's client watcher, only globs the Harness
  workspace and therefore cannot watch an installed external plugin.

## 7. Running `git` and touching files (PRD §二.4)

All three services below were measured **present** in the verification profile
(`services subprocess=present fs=present workspaceRegistry=present`), read from
the source checkout and then confirmed live.

### `ctx.subprocess` — the only route to `git`

- `spawn(spec)` is **synchronous** and returns a handle; `SubprocessSpawnSpec`
  requires `argv: readonly string[]`, `cwd`, `stdio` and `graceMs`. There is no
  shell and no command string: `argv[0]` is the program, so a branch name or a
  path containing a space cannot become two arguments.
- `stdio` is fully explicit: `stdin` is `'ignore' | 'pipe' | { data }` (the batch
  shape is what feeds `git apply -`), and `stdout`/`stderr` are
  `'pipe' | 'inherit' | { maxBytes, spill? }` — there is **no `'ignore'`** for
  outputs.
- Collected output is decoded **text**: `handle.collected.stdout?.readFrom(0)`
  after `await handle.done` returns `{ text, nextOffset, lossy, spillPath? }`.
  A non-zero exit **resolves** `done`; only a spawn-level failure rejects — and
  `spawn` itself can also throw synchronously, so both guards are needed.
- `lossy` is treated as a failure here rather than a short answer: a truncated
  `status --porcelain` describes fewer changes than the repository has, and a
  truncated diff would apply as a partial patch.
- `resolveExecutable('git')` resolves a bare name against the provider's scrubbed
  PATH; it rejects an empty name, a relative path containing a separator, an
  absolute path that is not an executable file, and a name not on PATH.

### `ctx.fs` — twelve primitives, and what is missing

`resolve`, `processPath`, `fileUrl`, `contains`, `stat`, `lstat`, `readText`,
`streamText`, `readBytes`, `listDir`, `writeText`, `editText`. There is **no
copy, no create-directory, no remove/rename, and no byte-write**, so a copy is
composed from `readText` + `writeText` — text-only, which is why a binary
untracked file is a **named refusal** in a snapshot rather than a silent partial
copy. `resolve` does not require the path to exist (a write targets a file that
is not there yet); existence is `stat`'s answer.

### `ctx.workspaceRegistry` — registering a worktree

- `create(path, title?)` canonicalizes the path with `realpath`, rejects a
  nonexistent path or a non-directory, and returns the **existing** record for an
  already-registered path without changing its title.
- `Workspace.attachSession(sessionId)` is the Host's own validation, not a
  formality: it re-reads the session's header and refuses when the recorded `cwd`
  is absent, unresolvable, or not the workspace directory. A session that is not
  physically in the directory therefore cannot be filed under it by asking.
- The registry declares `static inject = ['storageDomain', 'sessionPersistence']`,
  so it is only mounted in a composition that has both.

### A background pass must validate its own interval

`ctx.effect(callback)` **calls** the callback and registers what it *returns* as
the disposer. The host-half smoke's stand-in originally stored the callback
itself, which made a self-re-arming pass timer impossible to stop and kept the
process alive after teardown; the stand-in now follows the contract, and the
smoke runs every disposer and asserts the process exits on its own. The pass also
validates `passIntervalMs` against a positive finite number and falls back to the
documented default, because a caller that bypasses the config schema would
otherwise hand `setTimeout` an `undefined` delay in a loop that re-arms itself.
