# Host API compatibility extensions

The specification (`docs/PRD.md` §一.5) keeps two small Host-API changes outside
this plugin's package:

| Extension | Why it is needed | Contract |
| --- | --- | --- |
| `selectModel.rememberAsDefault?: boolean` | The un-extended call **always** writes the Host's global default model, so selecting a model for one managed target would silently change every other session and the default for new ones. | Default `true` preserves today's behaviour. The conductor passes `false` and never writes the global default. The extension also mounts the callable writer below, so a configuration declaration alone can never be mistaken for a completed write. |
| `fork` gains `newSessionId?`, `workspaceId?`, `cwd?` | The Host's own fork command mints its own child id and inherits the source session's working directory, so it cannot be pre-addressed or aimed at a prepared directory. | Reuse the existing session-assembly path. `workspaceId` and `cwd` are mutually exclusive. A retry with the same identity must verify the source, the fork cutoff and the destination directory. |

### What the `fork` extension actually gates

Only the **Host's own fork command**. The conductor's fork does not go through
that command: it assembles the child with the Host's agent factory and preset
service, so it already chooses the child's identity and directory itself, and it
is measured working (`docs/compatibility.md`, C31–C34).

The extension still matters for two things the conductor does not do today:

- a browser or Remote caller invoking the Host's fork directly;
- any future path that must produce *the Host's own* fork, rather than an
  equivalent one, so that the two cannot diverge.

Its absence is therefore reported as "the Host command's target control is
unavailable", not as "forking is unavailable".

## 1. Callable model-selection writer

The companion extension must mount `ctx.conductorSessionModelSelection` in the
same Host process. The writer is:

```ts
selectForSession({
  sessionId,
  selection: { provider, model, reasoningEffort? },
  rememberAsDefault: false,
}) => Promise<{ selected: { provider, model, reasoningEffort? } }>
```

The implemented companion also provides a reader:

```ts
readForSession({ sessionId }) => Promise<{
  sessionId,
  next: { provider, model, reasoningEffort? },
  lastUsed?: { provider, model, reasoningEffort? },
  source: 'session_override' | 'request_header' | 'global_default',
  persisted: boolean,
  effectiveAt: 'next_request',
}>
```

This reads the Host's actual next selection separately from its last request header.
The session override is durable in the companion's independent storageDomain;
it survives a restart before the next request without creating Session events.

It also exposes `peekForSession({ sessionId })`, which synchronously returns the
same state for a loaded session or `undefined` when unavailable. Workflow start
captures each node's model, effort, preset, session and binding version. The plugin
uses the synchronous reader again immediately before Host dispatch, including queue
flush; changed configuration requires explicit reconciliation. Old runs without a
snapshot and Hosts without this reader cannot start new nodes under that guarantee.

It must use the Host's own session-controller path, apply the selection for the
next request only, and skip `saveSelection` when `rememberAsDefault` is false.
The returned `selected` value is the Host-normalized selection the conductor
may report. A missing writer disables the feature and performs no write. A failed
call or malformed response means the change is **unconfirmed**: the Host may have
applied it before acknowledgement failed. The plugin reports the failure without
claiming the model stayed unchanged or retrying the write. The plugin does not install
agent-scoped model-selection listeners or access private selection caches.

## 2. What the conductor does without them

Nothing. Both features stay **off**, and the capability report names them as
disabled with a reason. The conductor never falls back to the un-extended call:

- calling `selectModel` without `rememberAsDefault` would write a global default
  as a side effect of a per-target action — a different operation than the one
  the user asked for, which §一.5 forbids;
- calling `fork` without target parameters would create the session in the
  source directory under a Host-minted id, which is precisely the outcome the
  environment-handoff specification (§二.10.2) requires the plugin to control.

Because a Host exposes no machine-readable declaration for either parameter,
"not proven" is treated as "not available". For model selection, the operator
must install the extension, mount its callable writer in the current Host
process, **and** declare it. A declaration by itself does not enable a write:

```yaml
- id: dsh-session-conductor
  config:
    hostExtensions:
      selectModelRememberAsDefault: true
      forkTargetParameters: true
```

## 3. Where the un-extended behaviour lives

Recorded against the specification's own baseline, commit
`c291e7961a515f6d7af9304e7fd1d257929aef26` (`@deepseek-ai/dsh-root@0.1.5-rc.2`):

| Item | Location at that commit | Behaviour |
| --- | --- | --- |
| `selectModel` | `packages/api/session-controller/src/commands.ts:133` | Installs the selection for the session, then calls `ctx.agentDefaultModel.saveSelection(selected)` — an unconditional global-default write whose failure is only logged. |
| `fork` | `packages/api/session-controller/src/commands.ts:202` | Accepts only the source session and an optional `atSeq`. Mints `session-${randomUUID()}` itself, and sets the child's `cwd` from the source header. |
| Wire request types | `packages/api/session-controller/src/types.ts` | Neither request carries the extension fields. |

The actually installed Desktop **2.0.10** layout implements the same two
stock commands in `@deepseek-ai/dsh-api-session-controller@0.1.5-rc.2`.
`dsh-host-apiproxy` is gone. Companion `dsh-harness-compat@0.1.1` is an
insert-only overlay beside that controller; it does not replace the gateway
row. Native UI `selectModel` still always `saveSelection`; isolated writes go
through `ctx.conductorSessionModelSelection` with `rememberAsDefault: false`.

Desktop **2.0.3** implemented the same two commands in
`@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`. That exact bundle was the
historical `0.1.0` companion patch baseline and must not be reused as a
2.0.10 result.

## 4. Delivery stance

The extensions are **not** shipped inside this plugin and the conductor never
patches a user's Harness installation:

- they are a separate change against the pinned Host baseline, versioned and
  tested on their own, as §一.5 requires;
- an operator who needs them installs them into the Host build they run, then
  declares them in the conductor row; the model-selection extension must also
  mount a callable writer in that Host process, and the conductor checks that
  its `selectForSession` member is actually callable;
- until then, the affected features report disabled with a reason instead of
  changing semantics quietly.

## 5. Status

Implemented as the separate local project `dsh-harness-compat`, version `0.1.1`
on Desktop 2.0.10 / session-controller `0.1.5-rc.2`. The overlay mounts the
callable writer and fork services beside the stock controller and SHA-checks
that exact API bundle. It never rewrites the installed app directory.

Historical `0.1.0` replaced `dsh-host-apiproxy@0.1.1-rc.2` on Desktop 2.0.3;
that SHA and those isolated Host boots are not 2.0.10 evidence. The 0.1.1
overlay's isolated three-boot Host verification is still pending; unit tests
cover receipts, `rememberAsDefault: false`, and selection wrapping. Full
evidence and limitations are in the companion's compatibility record.
The native fork callable is `ctx.conductorSessionFork.fork({ sessionId, atSeq?,
newSessionId?, workspaceId?, cwd? }) => Promise<{ sessionId }>`.

This is **local implementation**, not publication. Linux, other versions and
remote Host adoption remain unmeasured; the capability gate remains necessary
until the companion is actually loaded and detected in the Host being used.
