# Compatibility record

> Current revision (2026-09-15): the active product uses native chat creation cards and header return links; the historical local panel is not mounted. It includes independent Host API and binary companions, Windows IPC/SSH bridge code, a separate HTTPS snapshot service, and T35 direct public-history progress reads. Local `0.1.4` has passed the recorded verification and is linked into the `desktop` Profile, but the currently running Desktop process must fully exit and reopen before it can load that version. [ACCEPTANCE](ACCEPTANCE.md) records current results and boundaries. The older numbered C rows and narrative below are retained historical evidence for their tested revisions, not current feature availability. In particular, C164/C166's absent model extension, C10's absent transport and C11's absent browser are superseded by the scoped measurements below; they do not imply that Linux SSH or the installed full Harness shell was tested. C251's old node retry semantics are also superseded: a full-node retry consumes the workflow rework budget.

## Current measured revision — 2026-09-15

| Surface | Current evidence | Limits |
| --- | --- | --- |
| Model API, native fork, conductor model snapshots | Independent `dsh-harness-compat`: 7 unit tests and 30 assertions over actual Host write/restart/stock boots | Exact `0.1.1-rc.2` API hash; controlled provider, no model network calls |
| Frozen workflow configuration and native source freeze | Actual 50-node DAG, repeated drive, model-drift rejection, both pre-step freeze races | Validates dispatch behavior, not model quality or 50 completed model outputs |
| Binary file provider | Independent `dsh-binary-files` unpacked candidate: 5 unit tests and 19 actual Host assertions | Real Windows fs-local/fs-sandbox paths and policy checks; other platforms untested |
| Main binary transfer/export integration | 13 assertions through real conductor tools with a 65,536-byte fixture | Real Host Agent/Session/storage/fs, no Host doubles; not an SSH or Git snapshot runtime measurement |
| Browser panel | Edge 153.0.4234.32, seven scenarios, production routes/tools | Host service doubles; full installed Harness shell not exercised |
| Remote transport | `remote.spec.ts` / `remote-host.spec.ts`: real Windows IPC endpoints, bridge processes and files | Host Agent/store doubles; no actual Linux SSH connection |
| Online sharing | `share-integration.spec.ts`: actual local TLS sockets and durable snapshot service | Local certificates; no public deployment |
| Load check | 20 actual managed sessions, four active controlled requests, 100 list reads: P95 0.383 ms | In-process tool latency; no browser/network/model SLA |
| Main final build/test/lint/smoke | `npm run check`: 75 files / 1167 tests; source/test typecheck and all builds pass; lint and Host/client smoke pass | Historical test totals below are not the current suite count; command logs in [ACCEPTANCE](ACCEPTANCE.md) |

The companions are independently versioned and explicitly loaded through profiles. The `desktop` Profile was deliberately updated for the local `0.1.4` installation; no installed ASAR, existing Session or credential was changed, and the running Desktop process was not forced to stop. Remote and sharing remain default-off until configured. Detailed evidence paths, process cleanup, candidate archives and PRD coverage are in [ACCEPTANCE](ACCEPTANCE.md) and [IMPLEMENTATION](IMPLEMENTATION.md).

This file records **measured** facts about the environments this plugin has run
in. It is evidence, not a plan: a row is added only after the corresponding
check actually ran, and it names the exact build, operating system and result.

The specification (`docs/PRD.md` §一.5, §五.2, §五.3) distinguishes a *source
review baseline* from a *runtime compatibility guarantee*. This document holds
the second kind.

## 1. Source-review baselines

| Item | Value | How it was established |
| --- | --- | --- |
| Specified baseline commit | `c291e7961a515f6d7af9304e7fd1d257929aef26` | Read from `docs/PRD.md` §一.5. |
| That commit's root manifest version | `@deepseek-ai/dsh-root@0.1.5-rc.2` | `git show <commit>:package.json` in a local checkout — the commit is reachable and its version matches the PRD. |
| Commit date | 2026-09-10 | `git log -1`. |
| Local development checkout | `D:\workspace\deepseek-harness` @ `47f943859bef60e4160492346772ded9b24f765a`, `0.1.0-rc.5`, 2026-08-13 | `git rev-parse HEAD`, `git log -1 --format=%ci`. |

The local checkout is **older** than the specification's baseline. Source paths
quoted by the PRD (`packages/api/session-controller/src/{types,commands}.ts`)
exist at the baseline commit and do **not** exist in the older checkout, which
is why the baseline commit was fetched to read them.

## 2. Runtime actually available on this machine

| Item | Value | How it was established |
| --- | --- | --- |
| Harness distribution | DSH Desktop `dsh-plugin-desktop@2.0.3` | `app.asar/package.json` read through Electron's asar-aware `fs`. |
| Harness runtime packages | `@deepseek-ai/dsh-*@0.1.1-rc.2`, `@deepseek-ai/cordis@4.0.1`, `@deepseek-ai/schemastery@3.18.1` | Version fields of `app.asar/node_modules/@deepseek-ai/*/package.json`. |
| Host home (`DSH_HOME`) | `D:\dsh` for the desktop profile | `dsh.cmd` shim plus `D:\dsh\profiles\desktop\package.json`. |
| Node used by `dsh` | Electron 43 re-entered as Node (`ELECTRON_RUN_AS_NODE=1`) | `…/host-commands/desktop/bin/dsh.cmd`. |
| Node used on `PATH` | `v26.5.0` (`^22.19.0 \|\| >=24.0.0` satisfied) | `node -v`. |
| pnpm | `11.8.0` | `pnpm -v`; the profile install ran with it. |

So the pinned specification baseline (`0.1.5-rc.2`) is **newer** than the
runtime that is actually installed (`0.1.1-rc.2`). Compatibility work therefore
targets the installed runtime and treats baseline-only APIs as capabilities to
be probed, not assumed.

## 3. How an out-of-tree plugin's imports resolve

Recorded because it is not obvious and it governs how this package may be
written. The desktop runtime installs a Node module-resolution hook
(`app.asar/lib/module-resolution.js`) that resolves a profile plugin's bare
`@deepseek-ai/*` specifiers against the **desktop installation** whenever the
profile does not carry its own copy. Two consequences:

1. The `@deepseek-ai/dsh-*` packages may be imported at runtime and stay
   external in the build; they must be declared as `peerDependencies`.
2. The junctions under `$DSH_HOME/profiles/node_modules/@deepseek-ai/` point
   into `app.asar` and are not traversable by a process without Electron's
   asar support. A plain-Node import of an installed plugin therefore fails on
   its bare `@deepseek-ai/*` specifiers even though the plugin loads correctly
   inside the Host. Do not diagnose a plugin from a plain-Node import alone.

## 4. Measured matrix

| # | Check | Environment | Result | Evidence |
| --- | --- | --- | --- | --- |
| C1 | Host-half build (`tsdown`) emits `lib/index.js` + `lib/index.d.ts` with `@deepseek-ai/*` external | Windows 11, Node 26.5.0, tsdown 0.23.0 | pass | `npx tsdown` output listing `lib/index.js`, `lib/index.js.map`, `lib/index.d.ts`. |
| C2 | Host half type-checks against the **installed** runtime types pinned at `0.1.1-rc.2` | TypeScript 7.0.2 | pass | `tsc -p tsconfig.json --noEmit` exits 0. |
| C3 | Host half loads and mounts against a stand-in context; capability report carries a reason on every disabled feature | Node 26.5.0 | pass | `node scripts/smoke-host.mjs`. |
| C4 | Domain layer unit tests | vitest 5.0.0 | pass | `npx vitest run` — see §5. |
| C5 | Bundle installs into a profile and appends its layer | DSH Desktop 2.0.3 | pass | `dsh plugin --profile <name> add <path>`; profile manifest lists the bundle. |
| C6 | Composed layer order places the plugin row last | DSH Desktop 2.0.3 | pass | `dsh --profile <name> --dump-config` ends with `# == dsh-session-conductor` then `- id: dsh-session-conductor`. |
| C7 | Plugin module loads and `apply` runs inside a real Host process | DSH Desktop 2.0.3, isolated `DSH_HOME`, web profile on `127.0.0.1:43917` | **pass** | `scripts/verify/boot-profile.mjs` — see §6. |
| C7a | The conductor registers its model-facing tool in that live Host | same | **pass** | In-process probe reports `present=["conductor_capabilities"]`. |
| C7b | The capability report is accurate against that composition | same | **pass** | Mount line names exactly the two Host-extension features as disabled. |
| C12 | The conductor's own storage domain opens in that live Host | same | **pass** | Probe reports `domainOpen=true`; the six tables it listed at the time were `["tasks","bindings","access","operations","watches","notifications"]`, and the probe now reports all eleven (see C48). |
| C13 | A rejected write leaves memory and the medium in agreement | in-memory tables with injected failures | **pass** | `tests/store.spec.ts` — the store's `updateTask` after an injected failure still reads the previous value. |
| C14 | `conductor_create` prepares a real session end to end | same live Host | **pass** | Tool invoked through the live registry; result `preparation=ready`, a real `sessionId`, and a session log written. |
| C15 | Two different operation ids produce two distinct tasks | same | **pass** | `first=task-64de6bd7… second=task-b0a69e24…`, two separate session logs. |
| C16 | A retried create replays instead of creating again | same | **pass** | `replayed=true`, same `taskId`, no third session. |
| C17 | The plugin's own domain materialises on disk once it writes | same | **pass** | `storages/session_conductor.json`, after the creates. |
| C19 | A created task runs a real Host turn and the conductor observes its end | same live Host | **pass** | `wait` returned in **218 ms** with a `turn_ended` wake, outcome `failed`, quoting the Host's own reason. |
| C20 | An accepted message is never reported as a completed turn | same | **pass** | The dispatched message was recorded `accepted`; the observed turn ended `failed`. |
| C21 | A wait does not re-report an event it already returned | same | **pass** | Second `wait` at `timeoutMs: 0` returned no wake, with the cursor advanced. |
| C22 | A snapshot read consumes nothing | unit test | **pass** | A `snapshot` read leaves the reader's cursor absent/unchanged. |
| C23 | Discovery finds unmanaged Host sessions with selection metadata only | same live Host | **pass** | `total=4`, each candidate carrying id/live/persisted/managed/directory/createdAt and no log content. |
| C24 | An existing session can be joined without modifying it | same | **pass** | Attached a session with `live: false`; a task was created and bound, and no message was sent. |
| C25 | A managed session stops appearing as a candidate | same | **pass** | `CONDUCTOR-DISCOVER-HIDES PASS stillListed=false`. |
| C26 | Organisation is conductor-side only | same + unit tests | **pass** | Rename, group, pin and archive changed only the task record; the binding and archive restore both survived. |
| C27 | Releasing management blocks new work but keeps accepted work | unit test | **pass** | After release, `send` fails `NOT_MANAGED` while the earlier accepted operation stays `accepted`. |
| C28 | A handoff brief is generated from a real session | same live Host | **pass** | `version=0 cutoff=11 decisions=1 openItems=1 refs=1`, rendered from genuine Host history. |
| C29 | Briefs version rather than overwrite | same | **pass** | `first=0 second=1`. |
| C30 | Adding a table to the domain spec does **not** reject an existing medium | same | **pass** | The medium written by earlier rounds opened with the new `contexts` table present (`contexts=size=2`). |
| C31 | A fork creates a distinct task and session carrying the completed prefix | same live Host | **pass** | Source `task-bfd79d73…`/`session-1e87e98c…` → child `task-85138cd5…`/`session-118908b6…`, `phase=ready`, no instruction, `replayed=false`. |
| C32 | The child session actually holds the seeded history | same | **pass** | Child log 1155 bytes against 307 bytes for an empty created session and 1298 for the source. |
| C33 | A retried fork replays rather than forking twice | same | **pass** | `replayed=true`, same `taskId`. |
| C34 | A fork with no instruction finishes idle | same | **pass** | `phase=ready`, and the unit tests assert no message reached the target. |
| C35 | The Host's filesystem service is reachable for verification | same live Host | **pass** | `fsServicePresent=true`, so artifact checks go through the Host's own policy. |
| C36 | Registration records a claim, not a fact | same | **pass** | `existence=claimed acceptance=pending`. |
| C37 | Verification records presence and a whole-file digest | same | **pass** | `existence=present version=0 pinned=true`. |
| C38 | A rewritten file is reported changed and refused as a fixed input | same | **pass** | `existence=changed version=1 pinned=false` with the reason recorded. |
| C39 | A reference handoff provides without applying | same live Host | **pass** | `provided=true applied=false`, with the reference text carrying version and verification facts. |
| C40 | A snapshot copy refuses a source that is not verified and unchanged | same | **pass** | `applied=false`, conflict names the reason; nothing was written. |
| C41 | A patch refuses a baseline mismatch and does not overwrite the receiver | same | **pass** | `applied=false unchanged=true` — the file is byte-for-byte what it was, and the conflict quotes both hashes. |
| C42 | A task moves to a successor session in another directory | same live Host | **pass** | `task-ae4b388d…` kept its id; session `2b51bc48…` → `ac4bbb36…` at `reached=switching_binding`. |
| C43 | The predecessor link is preserved across successive moves | same | **pass** | The second move's predecessor is the first move's successor, and the two successors are distinct. |
| C44 | A handoff names the preconditions it did **not** check | same | **pass** | The summary lists what was verified and marks the git baseline as a gap. |
| C45 | A one-time rule saves with its action, target and limit | same live Host | **pass** | `CONDUCTOR-RULE-SAVE PASS … maxExecutions=1`. |
| C46 | A rule fires once for its trigger | same | **pass** | `CONDUCTOR-RULE-FIRE PASS dispatches=1`. |
| C47 | A repeated event does **not** produce a second dispatch | same | **pass** | `CONDUCTOR-RULE-ONCE PASS`, refusal names the event already fired. |
| C48 | The `schedules` table is mounted in a live Host, and a calendar plan's instant is derived from the chosen zone | same live Host | **pass** | `domainTables=[…"rules","schedules"]`; `CONDUCTOR-SCHEDULE-CALENDAR PASS nextAt=2026-09-14T01:00:00.000Z localHourInShanghai=09`. |
| C49 | A plan that would silently change what the user asked for is refused, not repaired | same | **pass** | `CONDUCTOR-SCHEDULE-REFUSE-WALL PASS refusals=["a calendar schedule needs a local time of day (`hour` and `minute`)"]`; `CONDUCTOR-SCHEDULE-REFUSE-ZONE PASS refusals=["Mars/Olympus_Mons is not a zone this runtime can resolve, so a local time in it cannot be honoured"]`. |
| C50 | An execution plan with no stated limit is saved as a draft and does not run | same | **pass** | `CONDUCTOR-SCHEDULE-DRAFT PASS status=draft draftReason="an execution plan needs a limit …"`, and the following `tick` over it performed no occurrence (`CONDUCTOR-SCHEDULE-DRAFT-IDLE PASS runs=0`). |
| C51 | A due execution plan dispatches exactly once, carrying its dedupe identity as the operation id | same | **pass** | `CONDUCTOR-SCHEDULE-FIRE PASS runs=["schedule-377f4176… 2026-09-14T00:59:12.127Z: dispatched to task-5cf6c5d4… as schedule-schedule-377f4176…-2026-09-14T00:59:12.127Z"]`. |
| C52 | The same scheduled instant never triggers twice, and the plan finishes | same | **pass** | `CONDUCTOR-SCHEDULE-ONCE PASS secondRuns=0`; `CONDUCTOR-SCHEDULE-COMPLETED PASS status=completed runs=1`. |
| C53 | After a restart a read-only plan is calibrated **once**, not replayed | same live Host, second boot against the same store | **pass — inspects on recovery in round 70** | **Was: pass, narrowly.** Recovery now calls the same `inspectOf` the tick path uses and records that observation as the run reason, not the policy sentence. Live (`live-r70c.err.log`): `CONDUCTOR-SCHEDULE-RECOVERY-INSPECT PASS … reason="task task-edf7236e-… is ready/ready on session session-7975747f-…; 0 artifact(s), 0 verified present and 0 accepted"`. `tests/schedule.spec.ts` pins that the policy sentence is *why* to calibrate and `calibratedInspectRun` stores the observation. **Not re-measured this round:** C54's missed-execution path — boot 1's still-running Host dispatched the overdue exec before shutdown, so recovery saw `ran`/`dispatched` rather than `missed`. |
| C54 | A missed execution is recorded `missed` and not run late | same | **pass** | `CONDUCTOR-SCHEDULE-RECOVERY-EXEC PASS runs=[["2026-09-14T00:54:13.667Z","missed"]]`, reason `"the Host was not running and the plan saved no grace window, so the occurrence is missed"`. |
| C55 | Every missed cycle is **not** replayed | same | **pass** | Each plan was ~5 minutes overdue at 60 s spacing — five missed cycles — and exactly **one** run was recorded per plan (`totalRecordedRuns=2` for two plans). |
| C224 | A read-only inspect **notifies when the observation changes**, and stays silent when it does not | live Host + unit tests | **pass — round 71** | PRD §二.11: 默认巡检只读：检查状态、成果或已定义条件，**有变化时通知**. The observation was recorded; a notice was not delivered. Tick now compares this occurrence to `lastInspectObservation` (the last `ran` reason) and delivers a plugin `notice` to the authorising session only when the line differs and a target task exists — idle sessions are woken, busy ones queued, never interrupted; a session that is not live is named as undelivered. The first inspection is a baseline, not a change. Live (`live-r71b.err.log`): `CONDUCTOR-INSPECT-BASELINE PASS`; `CONDUCTOR-INSPECT-CHANGED PASS … (notified session-9fc7b4f4-… (woke))`; `CONDUCTOR-INSPECT-DELIVERED PASS count=1 waitedMs=0 notice="Scheduled inspection \"inspect-notice probe plan\" saw a change on task …"`; `CONDUCTOR-INSPECT-UNCHANGED PASS … (the observation is unchanged)`. `tests/schedule.spec.ts` pins the three-way decision and that a missed occurrence is not a baseline. |
| C225 | Resource cleanup is a **preview plus a confirmed selection**; referenced, modified and unknown directories are refused | live Host + unit tests | **pass — round 72** | PRD §三.6 / T32: stop, archive, unmanage, migrate and uninstall never delete a worktree; cleanup needs a preview and an explicit choice. `conductor_cleanup` is the 32nd tool. Creating a Git worktree registers it (`worktree:<taskId>`). Live (`live-r72.err.log`): `CONDUCTOR-CLEANUP-PREVIEW PASS … eligible=false referenced=true tree=clean … still referenced by task … (current working directory)`; `CONDUCTOR-CLEANUP-UNCONFIRMED PASS exists=true cleaned=[] … "cleanup is not automatic … Nothing was deleted."`; `CONDUCTOR-CLEANUP-REFERENCED PASS exists=true cleaned=[]`; after a real handoff off the worktree, `CONDUCTOR-CLEANUP-ELIGIBLE PASS eligible=true referenced=false tree=clean`; `CONDUCTOR-CLEANUP-EXECUTE PASS gone=true cleaned=["worktree:task-6a7f15f1-…"] refusals=[]`. `git worktree remove` is never passed `--force`. `tests/cleanup.spec.ts` pins the decision table (not owned / referenced / modified / unknown / already cleaned / missing) and the confirm gate. Auto-delete stays off (`DEFAULTS.autoDeleteResources === false`). A leftover worktree from a preparation that refused after `git worktree add` is registered too (`tests/coordinator.workspace.spec.ts`). |
| C226 | A reached budget **requests cancellation** of the current plugin-initiated turn and reports the actual stop state | live Host + unit tests | **pass — round 73** | PRD §二.13.2's second action, and the one that was only a name: `budgetDecision` always listed `request_cancel`, and C191 made the first action real, but nothing called `cancel()`. `Coordinator.requestTurnCancel` uses the same Host critical section as an exact stop and does **not** wait for confirmation. Identity is the task's current `ownerSessionId`. Native-interface turns are skipped; a concurrency ceiling is a gate on starting more, not a reason to abort in-flight work. Live (`live-r73.err.log`): `CONDUCTOR-BUDGET-CANCEL-IDLE PASS outcome="no_active_turn"` on a past-deadline policy (`cancels=[{"taskId":"task-ab37d9af-…","outcome":"no_active_turn","reason":"the session is between turns, so there is no active turn to stop"}]`); `CONDUCTOR-BUDGET-CANCEL-ACTIONS PASS actions=["stop_new_scheduling","request_cancel","keep_ledger"]`; `CONDUCTOR-BUDGET-CANCEL-KEPT PASS dispatches=0`; `CONDUCTOR-BUDGET-CANCEL-CONCURRENCY PASS limit="concurrency" cancels=[]`. **Boundary:** this Host still has no live running turn (no model credentials), so a running conductor-relay cancel is unit-measured (`tests/coordinator.spec.ts` asserts `cancel()` with `keepInbox` and no wait; `tests/budget.spec.ts` pins native skip / concurrency skip / idle request). |
| C227 | Native-interface input and a controller relay stay distinguishable on a history read (T11) | live Host + unit tests | **pass — round 74** | PRD §四.2 / T11: 用户原界面与主会话输入均保留并可追溯. `historyOf` had collapsed every `user/message` to `kind: 'user'` and dropped the Host's own `source`, so a history read could not tell a person in the original session from a `conductor_send`. User-role lines now carry `source`: `user` (native UI), `relay` (controller forward), `notice` (background report), `plugin` (any other plugin form), or `unknown`. Search hits stay `{seq, kind}` only. Live (`live-r74.err.log`): `CONDUCTOR-SOURCE-SEND PASS delivery="accepted"`; `CONDUCTOR-SOURCE-RELAY PASS source="relay" text="relay-input-6d70817c"`; `CONDUCTOR-SOURCE-NATIVE PASS source="user" inject="said through steer" text="native-input-6d70817c"`; `CONDUCTOR-SOURCE-DISTINCT PASS relaySeq=7 nativeSeq=15 kinds=["relay","plugin","user"]` — the extra `plugin` line is the Host's `@deepseek-ai/dsh-system-prompt` snapshot, kept as `plugin` rather than collapsed to a person. `tests/observer.spec.ts` pins the three named sources, `unknown` when the log named none, and that a history read returns them. |
| C228 | A controller session cannot manage more targets than the configured ceiling (PRD §四.7 default 20) | unit tests | **pass — unit; live ceiling not measured** | `managedTargetLimit` was stored in config and never read. Create, attach and fork now refuse a *new* target when the caller already owns the limit of still-managed tasks (`MANAGED_TARGET_LIMIT`). Identity is the current `ownerSessionId`, so a transfer moves the slot; `detachedAt` frees it. A retry of an existing operation id is not a new target. Count and reason are in `src/domain/limits.ts`. `tests/coordinator.spec.ts` drives the ceiling at 1 (second create refused, replay of the first still returns the original, a different controller still has a slot, release frees one); `tests/discovery.spec.ts` pins attach; `tests/fork.spec.ts` pins fork. **Live 20-ceiling not measured this round** — hitting it needs 21 Host sessions or a test-profile config override. |
| C229 | At the Host-wide plugin-turn limit a send is kept pending, not refused (PRD §四.4) | unit tests | **pass — unit; live occupancy not measured** | `targetTurnConcurrency` (default 4) and `noticeConcurrency` (default 1) were stored and never read. Occupancy is observed from live agents: a conductor `relay` turn occupies a target slot, a conductor `notice` occupies the report slot, waiting-for-user (`ask_user_question` → `waiting_input`) and waiting-for-approval still occupy, and a native-interface `{kind:'user'}` turn occupies neither and is not cancelled to make room. Reaching the limit leaves the send operation `prepared` (`delivery: pending` on the result) rather than refusing it. Flush (on the next send and on each background pass) dispatches explicit work before automatic, FIFO within a kind. Automatic writers (rules, schedules, workflows, constraints) do not count a firing when the send stayed pending; a notice wake is held until the notice slot frees, and its fact is not marked delivered. `tests/concurrency.spec.ts` pins occupancy and order; `tests/coordinator.spec.ts` pins pending → flush, explicit-before-automatic, and native-interface exemption. **Live occupancy not measured this round** — this Host still has no unfinished model turn (no credentials), so a live send under an empty Host remains `accepted`. Create and fork first instructions use the same flush: a new task at the limit stays ready with the create/fork operation `prepared` until a slot frees. |
| C230 | A read-only inspect also checks **defined conditions** (PRD §二.11 已定义条件) | unit tests | **pass — unit** | C224 closed 有变化时通知 against task state and artifacts only. The third inspect half is the saved shared constraints: `inspectObservationOf` lists each current constraint at the delivery stage this target has reached (`unset` when the current version was never sent, otherwise `sent` / `in_context` / `acknowledged` / `verified`), so a constraint added, versioned, or moved to a later stage is a change worth notifying and an unchanged condition line stays silent. `tests/inspect.spec.ts` pins the missing-target wording, zero-condition baseline, ordered listing, and unset→sent as a distinct observation. Live inspect-change notice is still C224; this round does not re-boot a Host. |
| C231 | Panel refreshes merge inside the configured 250 ms window; the first paint is not delayed (PRD §四.7) | unit tests | **pass — unit; browser rendering not measured** | `panelRefreshMergeMs` was stored in config and never read. The Host payload now carries it; `httpPanelPort.list()` coalesces overlapping fetches through `createMergedRefresh` (first request in a quiet period runs immediately; the window stays open `mergeMs` after settle). A payload that omits the field still lists and uses the published default. `tests/refresh.spec.ts` and `tests/panel.spec.ts` pin the share-one-run and after-window-new-run cases. **Browser rendering of the merge is still C11 / C93 — not measured.** |
| C232 | Cancelling a workflow also requests a stop of associated running turns (PRD §四.4) | unit tests | **pass — unit** | Pause still only stops new dispatch. Cancel now asks `Coordinator.requestTurnCancel` for each distinct task whose node is `running`, in definition order, catching per-task (idle, not live, not controller) rather than failing the whole cancel. Files and external actions already performed are not rolled back. Duplicate nodes on one task are asked once. `turnsToStopOnWorkflowCancel` is in `src/service/workflow.ts`; `tests/workflow.spec.ts` pins running-vs-idle and the duplicate-task collapse. Live running-turn cancel remains the same Host limit as C226 (no unfinished model turn here). |
| C233 | A compact snapshot names pending intervention and an artifact summary (PRD §二.7) | unit tests | **pass — unit** | `describeProjection` was only execution, interaction, last turn and cursor. `describeCompactSnapshot` adds whether a person must act and how many artifacts are present / changed / accepted. `conductor_read` uses it for the snapshot `state` and summary; `observer.read` fills counts from durable artifact records. `tests/observer.spec.ts` pins the idle wording, a waiting-approval line, unavailable summary, and store-backed counts. Wait-target state stays the projection line (not this compact form). |
| C234 | A network interrupt marks the panel disconnected and does not present old cards as live (PRD §四.5) | unit tests | **pass — unit; browser rendering not measured** | `applyPanelListResult` keeps the last snapshot when a later fetch fails and labels it disconnected (`the cards below are the last snapshot, not a live reading`). A first-fetch failure stays `unavailable` with no invented cards. Recovery replaces the leftover. The panel also listens for the browser `offline`/`online` events: offline marks the leftover, online retries. Page remount still re-fetches. `tests/panel.spec.ts` pins the three folds. **Browser rendering is still C11 / C93 — not measured.** |
| C235 | Discovery and the panel name **失联** and **不可恢复**, not only external archive (PRD §二.5, §三.4 连接) | unit tests | **pass — unit; live Host not re-booted; reconnecting not produced** | C220 closed 外部归档. The same §二.5 bullet also asks to 查看失联、不可恢复. `CONNECTION_STATES` existed and was never projected. `connectionOf` maps the Host's `live`/`persisted` onto `online` / `unavailable`+失联 / `unavailable`+不可恢复, and **never invents `reconnecting`** (this Host's agent is `idle`/`running` only). Discovery candidates carry `connection`, `unrecoverable` and `connectionReason`; the model summary says `(失联)` or `(不可恢复)` rather than a bare "not currently live". The panel and detail show the same dimension for a bound session; this route does not query persistence, so a missing live agent is 失联 rather than claimed 不可恢复 — said in the payload notes. `tests/state.spec.ts` and `tests/discovery.spec.ts` pin the three folds. |
| C236 | A workflow **重跑** opens a new `runId` for selected nodes and affected successors (PRD §三.3, §四.3) | unit tests | **pass — unit; live Host not re-booted** | The `workflow` family lists 重跑. Bounded rework still mutates the same run and still must not silently open another to evade its two-round cap. `rerun` is the explicit action: `planPartialRerun` takes the definition the source run **fixed**, names the selected nodes plus every transitive dependent, refuses an empty selection, an unknown node, a later definition version, and a source node that is still `running`. `nodesForPartialRerun` keeps verdicts and approvals on nodes this run is not redoing, and drops them on reset nodes (an old approval cannot cover redone work). The source run is not deleted or rewritten. Existing files and external actions are not treated as undone. `conductor_workflow` `action: 'rerun'` persists a new run pointing at `sourceRunId`. `tests/workflow.spec.ts` pins the chain, a diamond, the refusals, and that the source node list is unchanged. |
| C237 | `conductor_list` carries **失联** / **不可恢复** for a bound session (PRD §二.5) | unit tests | **pass — unit; live Host not re-booted** | C235 projected connection on discovery, the panel and the detail. The managed-task list still omitted it, so a `conductor_list` row could look more live than the card for the same task. `taskStatusOf` now returns the badge **and** `connectionListFields` from the same `panelFactsOf` call. Unbound tasks carry no connection (there is no session to be 失联). This route still does not query persistence, so a missing live agent is 失联 rather than claimed 不可恢复. The list line uses `connectionListNote`. Connection is not a filter. `tests/state.spec.ts` pins the three notes and that an unbound reading is omitted. |
| C238 | Concurrency limits are user-adjustable through Host settings when `ctx.settings` is mounted (PRD §四.4) | unit tests | **pass — unit; live Host not re-booted; smoke composition has no settings service** | `targetTurnConcurrency` (and the rest of the plugin Config) was captured at mount from the composition entry only. `installSettingsSection` now registers namespace `dsh-session-conductor` with that entry as `base`; `current()` reads the resolved user layer while settings are attached and falls back to the entry when they detach. Host-extension declarations cannot be flipped from settings (that would claim an extension this process did not install). Readers call `configOf()` at the moment they act — including the coordinator rebuild. `tests/liveconfig.spec.ts` pins the thunk swap and the extension refusal. **This smoke composition still has no `ctx.settings`; the live web Host does (C122).** |
| C241 | Task lists are **pinned first then newest**, and list/discover pages use **offset** (PRD §二.5 置顶及排序, §三.3 分页) | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | Pinning was a filter and a `conductor_update` flag; the list was newest-first only, the panel did not show or rank pins, and `limit` without `offset` could not reach the rest of a long list except by raising the cap. `sortTaskList` / `pageOf` in `taskfilter.ts` are the same functions the tool and the panel use: pinned first, then `updatedAt` descending, `taskId` as the tiebreak; a negative offset is 0. `conductor_list` and `conductor_discover` take `offset` and report it; a truncated page names the next offset. The panel payload carries `pinned` and is sorted the same way; the card renders a pin marker. `tests/taskfilter.spec.ts` pins the order, the non-mutation, and the three page folds. Live list/discover paging and browser pin rendering are not re-measured. |
| C242 | A directory artifact is **listed** at the recorded path (PRD §二.9.1 目录清单, §三.3 读取) | unit tests | **pass — unit; live Host not re-booted** | C240 closed read and open for files; a present directory was still refused (`another directory of the same name is not listed`) without listing the recorded path itself. `verifyArtifact` hashes the recorded directory's direct children (name + type, sorted, capped at `LISTING_ENTRY_LIMIT`) rather than reading it as a file; a file sitting at that path, a failed listing, or a composition that cannot list is reported as such. `decideArtifactRead` allows a listing only when that check is `present`; missing and changed directories stay refused. `conductor_artifact_read` returns `entries` for that path only. `tests/artifacts.spec.ts` pins the hash of the recorded children, that a sibling directory of the same name is not hashed, that a listing change keeps the previous digest, that a file is not this directory, and that a truncated listing is a prefix. Live Host listing is not re-measured. |
| C243 | Panel **unread** falls when the controller acknowledges reports (PRD §二.1 未读数量, §二.7) | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | Unread was `listNotifications({ taskId }).length` with no acknowledge step, so the card only ever grew. Opening a detail view must not consume another reader's unread (PRD §二.7), which is why GET still does not mark reports. `unreadCountOf` skips withdrawn and already-acknowledged records. `conductor_watch ack` writes `acknowledgedAt` on **this controller's** reports for that task and does not move a wait cursor, snapshot cursor, or `deliveredEventIds`. Another controller's reports stay unread. Stored v1 notifications without `acknowledgedAt` still parse. `tests/unread.spec.ts` and `tests/store.spec.ts` pin the count, the isolation, and the untouched watch. Live panel decrement and browser rendering are not re-measured. |
| C244 | Plugin disable **stops new scheduling and reports** and keeps data (PRD §四.5 插件停用) | unit tests | **pass — unit; live Host not re-booted** | The background timer already refused to re-arm after `stop()`, but an in-flight pass — and the same automatic tool paths — could still tick a schedule, deliver a notice, fire a rule, drive a workflow or flush a pending send. `PluginLifecycle` is disabled **before** `pass.stop()` on teardown. `runPass` returns without those halves; `conductor_schedule tick`, `conductor_watch report`, rule dispatch, workflow `drive` and the pass's pending-send flush each refuse with a reason that names the activity and states that tasks, artifacts and data are kept. User-initiated send/stop/list/read are not gated. `tests/lifecycle.spec.ts` pins that disable is final for the instance. Live Host plugin-disable of an in-flight pass is not re-measured. |
| C245 | Task detail lists **未读事项**, and opening it does not mark them read (PRD §二.1, §二.7) | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | C243 made the card count fall on `conductor_watch ack`. The panel still only showed a number. `unreadItemsOf` takes the newest unacknowledged, non-withdrawn reports (capped at 20). The detail payload carries `unreadItems` and `unreadCount` and states that GET does not acknowledge them. The client renders the list. `tests/unread.spec.ts` pins skip/order/cap. Live detail listing and browser rendering are not re-measured. |
| C246 | A disabled one-time rule can be **enabled** under the same grant (PRD §三.3 `rule` 启用、停用) | unit tests | **pass — unit; live Host not re-booted** | The family listed 保存、启用、停用; the tool only had `save` (starts active) and `disable`. `enable` resumes the same `grantId`, does not mint a new authorisation, and does not reset firings or rewrite the instruction. An already-enabled rule is reported rather than version-bumped. Enabling is checked against the currently active control graph, because a disabled edge was not in that graph and turning it on can close a cycle the save-time check never saw. `tests/rules.spec.ts` pins resume, already-enabled, and the cycle refusal. Live enable after disable is not re-measured. |
| C247 | Artifact verification is **kind-specific** (PRD §二.9.1 链接、patch、提交引用、测试报告、服务入口) | unit tests | **pass — unit; live Host not re-booted** | Register accepted every kind, but `verifyArtifact` hashed any record that had a path as a file and left URL/git-only records claimed with "not verified by a filesystem check". A link or service entry is now the recorded http(s) URL: the locator is digested, reachability is **not** probed (a well-formed URL is not `present`), and a filesystem path of the same name is not this artifact. A commit is the recorded git object in that repository (`rev-parse --verify ref^{commit}` through the Host git runner); another SHA, including HEAD, is not this commit; a missing resolver leaves the claim unadvanced. A patch or test report is hashed at the recorded path. `tests/artifacts.spec.ts` pins the path-is-not-the-link/commit, locator digest, git present/changed/missing, and patch/report hashes. Live git resolve and URL records are not re-measured. |
| C248 | Snapshots produce **interrupting** and **reconciling**, not only idle/running (PRD §三.4 执行) | unit tests | **pass — unit; live Host not re-booted** | The vocabulary listed four execution states; the Host log fold only emitted `idle`/`running` because the agent is only those two. `overlayExecution` is the producer: `interrupting` when a conductor cancel was issued for the **still-open** turn (a later turn is `running`, not a retargeted interrupt); `reconciling` when a delivery is parked `unknown` and there is no live turn — unknown deliveries do not hide a running turn. Cancels are tracked in memory (`CancelTracker`); after a restart the Host log is the fact. The panel, export and `conductor_read` share the overlay. The running badge stays a live turn (`interrupting` counts; `reconciling` does not — it is idle-with-unknown-work). `tests/state.spec.ts` pins the four folds. Live cancel overlay is not re-measured. |
| C249 | `waiting_input` clears when **that** question is answered (PRD §三.4 交互) | unit tests | **pass — unit; live Host not re-booted** | `ask_user_question` set `waiting_input` and nothing cleared it except `turn/end`, so a target that asked, was answered, and kept working still looked blocked on a person. The fold now records the outstanding `callId` and a matching `tool/result` returns interaction to `none`; a result for a different call does not. `tests/observer.spec.ts` pins the three folds. Live question-answer is not re-measured. |
| C250 | Workflow nodes use the **PRD §三.4** lifecycle, and acceptance stays a separate dimension | unit tests | **pass — unit; live Host not re-booted** | `domain/state.ts` listed `blocked`/`ready`/`running`/`waiting`/`validating`/`passed`/`failed`/`cancelled`; the engine stored `pending`/`accepted`/`reviewed`/`inconclusive`/`skipped` and never produced four of the specified names. Lifecycle is now that set: a run starts `blocked`, `drive` stamps `ready` when all six conditions hold then `running` on dispatch, overlays `waiting` from the target's question or approval and `validating` when that turn has ended, records `passed` only for a user or deterministic `pass`, leaves a model review or an `inconclusive` result `validating` so it cannot open a downstream node, and `cancel` marks unfinished nodes `cancelled` (passed/failed stay). Acceptance remains the verdict. Stored v1 names still parse and are mapped on read (`canonicalNodeState`); `DOMAIN_VERSION` is not bumped. `tests/workflow.spec.ts` pins the mapping, the overlay, cancel, and the downstream gate. Live drive overlay is not re-measured. |
| C251 | A node's saved **failure policy is executed** (PRD §二.12 失败处理) | unit tests | **pass — unit; live Host not re-booted** | C186 stored `node.failure.onFail` and C173 froze the budget; `afterNodeFailure` still opened a rework round for every `fail`. The policy is now frozen on `RunFixed.failure` at `start` (a later definition edit does not change a run in flight) and executed on `verdict`: `stop` hands the run to the user without opening a round; `continue` leaves the node `failed` so independent siblings can still run, and `runHasSettled` completes the run when remaining nodes are blocked forever behind that failure; `retry` resets the node to `blocked` without consuming a rework round until `retries` is spent, then the two-round cap applies. `inconclusive` still never retries. Runs recorded before the frozen field consult the live definition rather than inventing `stop`. Optional field; `DOMAIN_VERSION` is not bumped. `tests/workflow.spec.ts` pins stop/continue/retry/inconclusive and the settled/not-settled folds. Live onFail verdict is not re-measured. |
| C252 | A Watch record stores **待介入事项** (PRD §三.5 Watch) | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | The watch table had cursor and `deliveredEventIds` only. `pendingIntervention` is now optional on the record: `start` snapshots the live projection, `report` folds the **whole** log (not the cursor window) and writes `waiting_input` / `waiting_approval` or clears when the target is no longer waiting; a target that is not live keeps the last recorded intervention rather than pretending it went away. `list` shows it. Opening a panel still does not acknowledge or clear it (`ack` is reports, not this field). Stored v1 watches without the field still parse. `tests/observer.spec.ts` and `tests/store.spec.ts` pin the mapping and the round-trip. Live watch pending and browser rendering are not re-measured. |
| C253 | A not-live target still **shows** stored 待介入 (T14) | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | C252 stored the field; `conductor_read`, the panel card/detail (and therefore the list filter badge), and an export still folded `initialProjection()` when the session was not live, so a question asked before disconnect read as idle. When resolve says the session is not live, the last Watch `pendingIntervention` is shown as interaction; a released task or a task with no binding does not. Live projection always wins over the cache. `tests/observer.spec.ts` pins snapshot/read overlay and that another reader without that watch sees none. Live Host and browser rendering are not re-measured. |
| C254 | An artifact record stores **source session, turn and related constraint versions** (PRD §二.9.1) | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | The record already had optional `sessionId` / `turn` / singular `constraintVersion`, but register never filled the session from the binding, never defaulted the turn from the live projection, never captured the constraints then in force, and list/panel did not show any of it. `stampArtifactProvenance` fills omitted provenance from the current binding, the live `turnsStarted` (not inventing `turn: 0`) and `listConstraints`; a caller-supplied session or turn wins. New records store `constraints: [{constraintId, version}]` so a later constraint edit cannot rewrite what this artifact was produced under. Stored v1 records still parse; a singular `constraintVersion` is still described. `conductor_artifact_list` and the panel detail render the provenance. Optional fields; `DOMAIN_VERSION` is not bumped. `tests/artifacts.spec.ts` pins the stamp, the caller-wins rule, and the v1 description. Live register provenance and browser rendering are not re-measured. |
| C255 | An in-flight run **stops** when the live definition version moves, and an approval **binds** the approved action (PRD §三.3, §四.3) | unit tests | **pass — unit; live Host not re-booted** | C173 stored `fixed.definitionVersion` and never compared it, so `drive` read the live definition body after a save and would have dispatched the later instruction. `fixedDrift` now compares that version first; a later save stops the run as `needs_user` rather than silently changing in-flight nodes (the store overwrites the definition, so the frozen body is not retrievable). `approve` stamps `approvedBinding` — instruction, inputs, acceptance rule, task and definition version — and refuses an approval against a later definition than the run fixed. Expanding any of those fields makes `approvalStillApplies` fail the start gate, so an old approval cannot be reused. Partial rerun still drops the approval on reset nodes. Optional field; `DOMAIN_VERSION` is not bumped. `tests/workflow.spec.ts` pins version drift, the version-mismatch refuse, and that a longer instruction cannot reuse the recorded approval. Live drive-after-save is not re-measured. |
| C256 | A downstream node does not start on an artifact produced under a **different constraint version** than the run fixed (PRD §二.13.1) | unit tests | **pass — unit; live Host not re-booted** | C176 compares the live constraint table against the run; C254 stamps provenance on the artifact. Neither asked whether *this input* was produced under the versions the run fixed, so a pinned file from an older (or newer) constraint version could still open a downstream node. `artifactConstraintCompatibleWithRun` is now part of the start gate's `inputs_pinned` fact: overlapping constraint ids must match; an artifact that recorded no provenance (pre-C254) is not treated as a mismatch; a constraint the run did not fix is not a conflict. `tests/artifacts.spec.ts` pins the three folds. Live drive-with-mismatched-provenance is not re-measured. |
| C257 | `wait` still shows stored 待介入 when the target is not live (T14) | unit tests | **pass — unit; live Host not re-booted** | C253 overlaid Watch `pendingIntervention` on `conductor_read`, the panel and export. `wait` still returned only the per-target error, so a timeout after disconnect looked like a quiet idle target. Both PRD §二.7 sentences apply: 失联 is a per-target error, and a timeout still reports each target's current state. `waitErrorResult` now attaches the last-known interaction when it is `waiting_input` / `waiting_approval`; a missing or released task still has error only. A stored wait is not a new wake. `tests/observer.spec.ts` pins the overlay and the missing-task negative. Live wait-after-disconnect is not re-measured. |
| C258 | A run **keeps executing the graph it snapshotted** at start (PRD §三.3) | unit tests | **pass — unit; live Host not re-booted** | C255 stopped the whole run when the live definition version moved, because the store overwrites the body and `drive` had nothing else to execute. `start` now copies the node graph (plus title, rework and structured budget) onto `fixed`; `drive`, `approve`, `verdict`, `rerun` and cancel use that snapshot when present, so a later `save` neither rewrites in-flight nodes nor sends the run to `needs_user`. `fixedDrift` still stops on auth / constraint / artifact changes, and still stops graph-less runs on version or budget drift (C255, C173). Optional fields; `DOMAIN_VERSION` is not bumped. `tests/workflow.spec.ts` pins the rebuild and that a snapshotted run survives a later version and budget. Live drive-after-save is not re-measured. |
| C259 | `read` returns the **structured definition** and the **frozen-version run** (PRD §二.12, §三.3) | unit tests | **pass — unit; live Host not re-booted** | C258 made `drive` execute the snapshotted graph, but `conductor_workflow` `read` still returned a node *count* for definitions and `{nodeId, state, attempts}` for runs, so a later `save` would make the live body look like what an in-flight run was doing. `definitionViewOf` / `runViewOf` now project the seven things §二.12 lists; a frozen run overlays the snapshotted instruction, task and acceptance, and a graph-less run does not overlay the live body. `read` with `runId` or `workflowId` returns that subset. The output schema follows. `tests/workflow.spec.ts` pins the structured definition, the frozen-vs-live overlay, and that a verdict/approval is carried. Live read-after-save is not re-measured. |
| C260 | A workflow definition's **`maxConcurrent` is executed** (PRD §二.12 condition 5, §二.13.2) | unit tests | **pass — unit; live Host not re-booted** | The save schema advertised `maxConcurrent` as "recorded for a caller that enforces concurrency itself", then zod stripped it (`budget` only stored `maxTurns` / `maxTokens`), so condition 5's concurrency half was only the Host-wide occupancy (C174 / C229). The definition now stores and freezes `maxConcurrent`; `nodeReadiness` counts live nodes (`running` / `waiting`) on **this run** and refuses another start at the cap, naming both figures. A finished node frees the slot; an absent cap does not invent one. `budgetPolicyText` includes it so graph-less C173 comparison still matches. Optional field; `DOMAIN_VERSION` is not bumped. `tests/workflow.spec.ts` pins the occupied / freed / absent folds. Live drive-at-cap is not re-measured. |
| C261 | Every tool's **model-facing text** is capped at the configured 12,000-character limit, with a truncation marker (PRD §四.7, §二.7) | unit tests | **pass — unit; live Host not re-booted** | `DEFAULTS.toolTextLimit` and `truncateMarked` / `withinBudget` existed, `registerConductorTools` already claimed the check happened, and `textLimit` was only passed into an artifact file preview. `withinBudget` had no caller, so a 50 kB `conductor_read` or `conductor_export` render would have been returned unmarked. Every registered tool now goes through `withOutputBudget`: `output.render` and `finalizeContent` concatenate text blocks, cut them with the existing marker, and name the same tool as the continuation. Structured values are not silently shortened. `tests/tools-budget.spec.ts` pins the wrap, last-mile replacement, empty/reasoning-only negatives, and the published 12,000 default. Live Host tool overflow is not re-measured. |
| C262 | Artifact **display** names the four facts of PRD §二.9.1 separately (模型声称生成 / 已验证存在 / 检查通过 / 用户验收) | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | Existence and acceptance were stored separately, but list/snapshot/inspect/handover/panel rendered `existence: claimed` plus `acceptance: pass`, and **counted `acceptance === 'pass'` as accepted** — so a model review looked like 用户验收. `artifactDisplayFacts` / `describeArtifactFacts` in `src/domain/artifact-facts.ts` project the four labels; a model review is named as not acceptance; an unattributed pass counts as neither 检查通过 nor 用户验收. Compact snapshot, inspect, handover snapshot, `conductor_artifact_list` and the panel detail share that projection. `satisfiesRequirement` and constraint re-acceptance now use `acceptanceCounts`. `tests/artifact-facts.spec.ts` pins the four folds; `tests/observer.spec.ts` pins that a model-review pass is not 用户验收. Live list/inspect and browser rendering are not re-measured. |
| C263 | After an environment handoff the interface shows **任务继续于新会话** and the predecessor/successor session chain (PRD §二.10.2), and the panel card renders **更新时间** (PRD §二.1) | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | Bindings already stored `predecessorBindingId` and `retiredAt`; export listed the chain; the panel, `conductor_list` and the handoff sentence still named only the current `sessionId`, so a moved task looked like it had always lived there, and `updatedAt` was on the payload only to sort the list. `sessionChainOf` / `describeSessionContinuation` in `src/domain/session-chain.ts` project the chain; a single session is not a continuation. The panel card/detail, `conductor_list`, the handoff summary and the export Markdown share that sentence. The card also renders `updatedAt` and keeps last-used / next-request models apart. `tests/session-chain.spec.ts` pins the folds; `tests/handoff.spec.ts` pins a real successor; `tests/export.spec.ts` pins the Markdown line. Live handoff display and browser rendering are not re-measured. |
| C264 | History without a limit uses the **configured default read amount** (PRD §四.7 默认读取量, published 20) | unit tests | **pass — unit; live Host not re-booted** | `DEFAULTS.defaultReadLimit` and the config field existed, `conductor_read` already advertised "the configured read limit", and `TaskObserver.read` used a **literal 20**. Changing the setting would have done nothing. The observer now takes `defaultReadLimit` from live config (tests that omit it still get the published 20); an explicit `limit` still wins. `tests/observer.spec.ts` pins a configured 2 truncating a 3-entry log, an explicit 1 beating that default, and the published 20 returning the whole window. Live Host override of the setting is not re-measured. |
| C265 | A workflow without its own `rework.maxRounds` uses the **configured rework-round cap** (PRD §四.7 自动返工, published 2) | unit tests | **pass — unit; live Host not re-booted** | `DEFAULTS.reworkRounds` and the config field existed, `conductor_workflow` already advertised "two whole-workflow rounds by default", and `openReworkRound` / `afterNodeFailure` / definition save used a **literal 2**. Changing the setting would have done nothing for a definition that omitted `rework`. The engine now defaults to `DEFAULTS.reworkRounds`; save and verdict read live `config.reworkRounds`; a definition's own `maxRounds` still wins. `tests/workflow.spec.ts` pins the published 2, an explicit 1 beating that default, and that spent rounds still go to `needs_user`. Live Host override of the setting is not re-measured. |
| C266 | The panel and export show **最近进展** as a fact separate from the last-turn outcome (PRD §二.1 最近进展, §二.7 紧凑快照) | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | Projection already stored `lastTurnDetail` (the Host's own reason, e.g. `MISSING_CREDENTIAL: no API key`) and `conductor_read` / `conductor_wait` already rendered it; the panel payload and export only carried `lastTurn` (最近结果), so a failed turn looked like the word `failed`. `lastTurnFieldsOf` projects both facts; the card, detail, list/detail routes and export Markdown share them. A session with no finished turn omits both. `tests/observer.spec.ts` pins the failed-turn fold and the idle empty object; `tests/export.spec.ts` pins the Markdown line. Live panel/export and browser rendering are not re-measured. |
| C267 | Archiving a conductor task is **organisation only** (PRD §二.5 / T15): execution, authorised plans, data and necessary notices continue | unit tests | **pass — unit; live Host not re-booted** | Archive was a flag `updateTask` wrote, and the report loop asked only `monitoringAllowed` (release). Nothing named T15's other half, so a later `if (archived) skip` would have looked like the release path. `observationContinues` is the report loop's gate: release still stops monitoring; archive does not, and the reason says notices still reach the notice centre. A send after archive is still accepted; the binding, preparation and access record are untouched. `tests/access.spec.ts` pins the archived-vs-released folds; `tests/discovery.spec.ts` pins send-after-archive. Live archive-and-notice is not re-measured. |
| C268 | An interrupt-and-send without its own `confirmLimitMs` uses the **configured confirmation ceiling** (PRD §四.7 打断确认等待上限, published 30s) | unit tests | **pass — unit; live Host not re-booted** | `DEFAULTS.interruptConfirmLimitMs` and the config field existed, tools already passed live `interruptLimitMs()`, and `Coordinator.send` still fell back to a **literal 30_000**. A coordinator constructed without that dep — or a send that omitted `confirmLimitMs` — ignored the Host setting. `stop` now resolves `request.confirmLimitMs ?? deps.interruptConfirmLimitMs ?? DEFAULTS.interruptConfirmLimitMs`; the live plugin injects `configOf().interruptConfirmLimitMs`. `tests/coordinator.spec.ts` pins a configured 1000 named in the unconfirmed reason, and the published 30000 when none is configured. Live Host override of the setting is not re-measured. |
| C269 | Archiving does **not cancel authorised plans** (PRD §二.5 / T15): saved schedules stay active and still due; one-time rules stay active | unit tests | **pass — unit; live Host not re-booted** | C267 pinned send-after-archive and that notices still reach the notice centre. T15 also says 不取消授权计划, and `updateTask` only writes organisation fields — but nothing asserted the schedule or rule tables. `tests/discovery.spec.ts` now saves an active schedule and an active rule, archives, and checks both records are untouched; `dueDecision` still reports the past occurrence as due. Live archive-and-tick is not re-measured. |
| C270 | List and discover without a limit use the **configured default read amount** (PRD §四.7 默认读取量, published 20) | unit tests | **pass — unit; live Host not re-booted** | C264 closed history. `conductor_list` already advertised "the configured read limit" and still used a **literal 20**; `conductor_discover` said "Defaults to 20" the same way. Changing the setting would have paged history to the new amount and left the task list and candidate list at 20. Both tools now take `defaultReadLimit` from live config; an explicit `limit` still wins. `tests/list-page.spec.ts` pins a configured 2 truncating a 3-row list and a 3-candidate discover, an explicit 1 beating that default, and the published 20 returning the whole list. Live Host override of the setting is not re-measured. |
| C271 | `conductor_list` shows **最近结果 / 最近进展**, pending intervention and unread — the same card facts as the panel (PRD §二.1) | unit tests | **pass — unit; live Host not re-booted** | C266 put `lastTurn` / `lastTurnDetail` on the panel and export. `conductor_list` still omitted them (and pending / unread), so a model-facing row looked idle while the card showed `MISSING_CREDENTIAL: no API key`. `taskStatusOf` now spreads `lastTurnFieldsOf`, pending intervention and the unacked report count from the same `panelFactsOf` derivation the card uses. The list schema, render line and compact row share those fields; an idle session omits them together. `tests/list-progress.spec.ts` pins the failed-turn fold and the idle empty object. Live list and browser rendering are not re-measured. |
| C272 | `conductor_list` shows **execution** (kept separate from the status badge) and **最近实际使用** — the remaining card facts of PRD §二.1 / §二.3 | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | C271 put last-turn progress, pending and unread on the list. The panel card still showed `execution` and `modelLastUsed` that a model-facing row omitted, so a running session with a logged model looked idle on the list. `taskStatusOf` now spreads the live projection's `execution` and the same `describeLoggedModel` sentence the card and detail use; `modelForNextRequest` is still not produced (C164). The list schema, render line and compact row share those fields; an idle session with no logged model omits them. `tests/list-progress.spec.ts` pins the running/last-used fold and the idle empty object. Live list and browser rendering are not re-measured. |
| C273 | A new task without `contextMode` uses the **published default** `brief` (PRD §四.7 新任务上下文) | unit tests | **pass — unit; live Host not re-booted** | `DEFAULT_CONTEXT_MODE` existed so call sites would not invent a fallback, and `Coordinator.createTask` still used a **literal `'brief'`**. The coordinator now takes `request.contextMode ?? DEFAULT_CONTEXT_MODE`; an explicit `empty` still wins. `tests/coordinator.context.spec.ts` pins the omitted-mode store/result against that constant; `tests/domain.spec.ts` pins the published `brief`. Live create-without-contextMode is not re-measured. |
| C274 | `conductor_list` shows whether the bound session was **archived outside this plugin** (PRD §二.5) | unit tests | **pass — unit; live Host not re-booted** | Discovery and the panel card already report the Host's registry-global archive. `conductor_list` still omitted it, so a managed task whose Host session was archived in the sidebar looked like any other row. `taskStatusOf` now reads the same `archivedSessionsOf` adapter the card uses: a published set yields `true`/`false`; an unread set is omitted, so "cannot tell" cannot look like "not archived". The list schema carries the field; the render line annotates only `true`. `tests/list-progress.spec.ts` pins the three folds. Live list and browser rendering are not re-measured. |
| C275 | A same-Host handoff **checks the target git baseline and existing modifications**, and refuses a dirty tree rather than cleaning it (PRD §二.10.2) | unit tests | **pass — unit; live Host not re-booted** | The outcome used to name git baseline as unchecked because "the Host exposes no git adapter". Worktree creation already has that adapter (`hostGitRunner`). `inspectTargetWorkingTree` now runs `status --porcelain` on the target: a dirty tree refuses at `preparing_target` and names the paths; a failed status refuses rather than inventing clean; a non-repo is checked as having no git baseline to refuse; no adapter still names the gap. Process occupancy remains unchecked. `tests/git.spec.ts` and `tests/handoff.spec.ts` pin the folds. Live handoff-into-dirty is not re-measured. |
| C276 | A same-Host handoff **confirms stop by the cancelled turn's end**, never by `whenIdle()` (PRD §二.6, §二.10.2) | unit tests | **pass — unit; live Host not re-booted** | The first handoff step is 停止并确认. The implementation cancelled with `{kind:'user'}` and waited on `whenIdle()`, which PRD §二.6 says cannot substitute for that turn's end, and the wait used a **literal 30_000**. It now uses `cancelExpectedTurn` in one critical section and polls `turnEndOf` for that turn, with `request.stopTimeoutMs ?? deps.interruptConfirmLimitMs ?? DEFAULTS.interruptConfirmLimitMs`. A new turn after the end refuses the move. No event log still waits on `whenIdle` and names that as not a turn-end receipt. The live tool passes the configured ceiling. `tests/handoff.spec.ts` pins unconfirmed timeout, configured 1000, confirmed end, new-turn refuse, and the idle/no-log folds. Live handoff-of-a-running-turn is not re-measured. |
| C277 | A same-Host handoff **refuses unresolved interaction** (`waiting_input` / `waiting_approval`) before cancelling anything (PRD §二.10.2) | unit tests | **pass — unit; live Host not re-booted** | The default conditions require 源任务没有未消费队列或未解决交互. Queue was already a hard refuse; a source waiting on `ask_user_question` or an approval could still be migrated, which would abort the pending question as a side effect of the stop. Handoff now folds the live session log the same way the panel does: `waiting_input` / `waiting_approval` refuse at `stopping` with **no** cancel and **no** successor; a resolved question proceeds; no event log names the check as unchecked rather than implying "none". `tests/handoff.spec.ts` pins the four folds. Live handoff-of-a-waiting-source is not re-measured. |
| C278 | A same-Host handoff **freezes source history and file state** (PRD §二.10.2 固定历史与文件状态) | unit tests | **pass — unit; live Host not re-booted** | The freeze step computed `cutoffSeq` and seeded the successor, but a non-empty log was neither checked nor unchecked, and source file state was never captured. History is now recorded as frozen through that seq (empty/missing log stays a named gap). When a Git adapter is mounted and the source binding has a cwd, the same read-only `status --porcelain` inspection captures dirty/clean/not-a-repo as a freeze fact and **does not modify** the source; a dirty source is not a refusal (only a dirty **target** is, C275). No adapter or no recorded cwd names the capture as unchecked. `tests/handoff.spec.ts` pins dirty-source-succeeds vs clean-source, and the no-cwd/no-log folds. Live freeze-of-a-dirty-source is not re-measured. |
| C279 | `conductor_read` (and `conductor_wait`) expose **`expectedTurn` / `expectedStartSeq`** plus structured compact-snapshot fields (PRD §二.6, §二.7) | unit tests | **pass — unit; live Host not re-booted** | `conductor_stop` / `interrupt_and_send` tell the caller to pass `expectedTurn` from `conductor_read`, but read only returned a state **string**. The projection now folds the unmatched `turn/start` as `openTurn` / `openTurnStartSeq` (cleared on that turn's end). `conductor_read` spreads `execution`, `lastTurn` / `lastTurnDetail` (最近进展), `pendingIntervention`, and the interrupt anchor; idle omits the anchor so it cannot be copied into a stop. Wait targets share the same fields. `tests/observer.spec.ts` and `tests/read-snapshot.spec.ts` pin the folds. Live read-then-stop is not re-measured. |
| C280 | A fork copies only the **completed-turn prefix** and does **not** copy the gap after `turn/end` (T04 / PRD §二.2.2) | unit tests | **pass — unit; live Host not re-booted** | `computeForkCut` walked from the completed `turn/end` forward to the next `turn/start`, so interstitial `agent/inbox/spliced`, `approval/asked` and `command/run` events were included in the child's seed — the opposite of 不复制未消费消息、审批请求或后台进程. The seed now stops at that end. A source inbox is left on the source; a source schedule still targets only the source. `tests/fork.spec.ts` pins the gap fold, the live-inbox fold and the schedule non-inheritance. Live running-fork is not re-measured. |
| C281 | After a same-Host handoff, plugin writes that still name the **retired binding version** fail (`STALE_BINDING`) and never steer the predecessor (PRD §二.10.2 旧绑定的插件写操作失效) | unit tests | **pass — unit; live Host not re-booted** | Coordinator `send`/`stop` already refused a stale `expectedBindingVersion`, but the tools did not accept that pin and `conductor_read` did not return it, so a late write after handoff silently followed `taskId` onto the successor. `conductor_read` / `conductor_wait` now expose `sessionId` and `bindingVersion`; `conductor_send` / `conductor_stop` / `conductor_queue` accept `expectedBindingVersion`. A pinned pending send that is flushed after the version advances is marked failed rather than delivered. Unpinned writes still go to the current (successor) binding, never the predecessor. `tests/handoff.spec.ts` pins a real handoff then send; `tests/coordinator.spec.ts` pins queue-stale and the pending-flush hole; `tests/read-snapshot.spec.ts` pins the tool surface. Live handoff-then-send is not re-measured. |
| C282 | Mutation writes accept PRD §三.2 `MutationContext` (`expectedOwnerEpoch` + `expectedBindingVersion`); `conductor_handoff` accepts **预期绑定** (PRD §三.3) | unit tests | **pass — unit; live Host not re-booted** | C281 pinned the binding on send/stop/queue, but `conductor_handoff` had no pin, so a late second move silently migrated the successor, and write tools never accepted `expectedOwnerEpoch` even though send/stop already checked it internally. `conductor_read` / `conductor_wait` now also return `ownerEpoch`. `conductor_send` / `conductor_stop` / `conductor_queue` / `conductor_handoff` accept both pins. A second handoff that still names the retired binding or epoch is refused at `stopping` with no cancel and no successor. Queue and a pinned pending-send flush refuse a stale epoch (`STALE_OWNER_EPOCH`) rather than delivering after a transfer; an *unpinned* pending send is still taken over by the new controller (PRD §二.10.1 未发送操作按原 ID 承接). `tests/handoff.spec.ts` pins the second-move refuse; `tests/coordinator.spec.ts` pins queue-stale-epoch and the pending-flush hole; `tests/read-snapshot.spec.ts` and `tests/observer.spec.ts` pin the tool and live-read surfaces. Live handoff-then-handoff is not re-measured. |
| C283 | A same-Host handoff **stores the freeze cutoff on the successor binding** and names that terminals, processes and credentials are **not** migrated (PRD §二.10.2) | unit tests | **pass — unit; live Host not re-booted** | C278 named the history cutoff as a checked precondition and seeded the successor, but the binding did not record that seq, so after the source session is gone the freeze boundary could not be proved. The successor binding now stores optional `frozenThroughSeq` (omitted when the log was empty so the boundary stays a named gap). The default condition 不迁移正在运行的终端、外部进程和凭据 is named as checked: the successor is a new session seeded with history only. `conductor_handoff` returns `frozenThroughSeq`. Optional field; `DOMAIN_VERSION` is not bumped. `tests/handoff.spec.ts` pins a freeze-through-seq 2 write and the empty-log omit; `tests/schema.spec.ts` pins a v1 binding without the field. Live freeze-then-read-binding is not re-measured. |
| C284 | A fork **shows** the source task, source session and history cutoff it recorded (PRD §二.2.2) | unit tests | **pass — unit; live Host not re-booted; browser rendering not measured** | The cut was stored on a `contexts` snapshot (`fork-<taskId>`) and never returned: `conductor_fork` named only the new `taskId`/`sessionId`, and the panel detail's 配置 omitted the origin, so a model or a person could not tell where the copied prefix stopped. `CreateTaskResult` now carries `sourceTaskId` / `sourceSessionId` / `cutoffSeq`; the tool summary and the panel configuration share `describeForkOrigin`. A replay of the same operation id returns the same origin. `tests/fork.spec.ts` pins the sentence, the live fork result and the replay. Live fork-then-read-detail is not re-measured. |
| C285 | A fork is a **write against the source**: it requires write control and accepts PRD §三.2 `MutationContext` pins | unit tests | **pass — unit; live Host not re-booted** | C282 pinned send/stop/queue/handoff, but `conductor_fork` copied history for any caller and had no epoch or binding pin, so an observer, a retired controller, or a late fork after a transfer/handoff could still mint a child. `forkTask` now calls `requireControlledTask` and refuses `STALE_OWNER_EPOCH` / `STALE_BINDING` **before** `beginOperation`, so a refused fork leaves no operation record. Matching pins still succeed. `tests/fork.spec.ts` pins the four folds. Live fork-after-transfer is not re-measured. |
| C286 | `conductor_update` accepts PRD §三.2 `MutationContext` pins (`expectedOwnerEpoch` + `expectedBindingVersion`) | unit tests | **pass — unit; live Host not re-booted** | Organisation already required write control, but a late rename/archive after a transfer or handoff still landed: there was no epoch or binding pin. `updateTask` now refuses `STALE_OWNER_EPOCH` / `STALE_BINDING` and does not write the title. Matching pins still rename. `tests/discovery.spec.ts` pins the three folds. Live update-after-transfer is not re-measured. |
| C287 | `conductor_access` mutating actions accept PRD §三.2 `MutationContext` pins | unit tests | **pass — unit; live Host not re-booted** | The access surface already froze a *previous* controller via the owner field, and its comment claimed it also checked "the epoch it believes it holds", but `observe` / `unobserve` / `transfer` / `release` accepted no pin. A current controller that still named a retired epoch (or a retired binding after a directory handoff) could still grant, move or release control. `mutationPinRefusal` now refuses `STALE_OWNER_EPOCH` / `STALE_BINDING` / `NO_BINDING` before those writes; `list` stays a read. `tests/access.spec.ts` pins the folds and that the tool forwards both pins. Live access-after-handoff is not re-measured. |
| C56 | The exact stop verifies its turn and cancels inside one critical section | unit test, driven fake | **pass** | `cancelExpectedTurn` is synchronous and is asserted not to return a thenable; a turn that starts between two calls is what the anchor refuses. |
| C57 | An old turn ending early does **not** mis-stop the new one (T09) | unit test | **pass** | With turn 1 ended and turn 2 open, a stop anchored on turn 1 rejects `STALE_TURN` and issues **no** cancel; the agent is still `running`. |
| C58 | An interrupt-and-send refuses before cancelling when the queue is not empty (T10) | unit test | **pass** | The result is `kept`, the text is kept, and the fake records **no** cancel call. |
| C59 | New turn, grown queue or moved binding abandons the send and keeps the text (T10) | unit test | **pass** | Three separate races driven from inside `cancel`; each returns `kept` with the reason naming what changed, and no `steer` is issued. |
| C60 | An unconfirmed stop does not send | unit test | **pass** | The result carries the specification's own wording, `stop not confirmed, instruction not sent`. |
| C61 | `conductor_stop` reports an idle session as a normal outcome, not a fault | same live Host | **pass** | `CONDUCTOR-STOP-IDLE PASS outcome=no_active_turn reason="the session is between turns, so there is no active turn to stop"`. |
| C62 | The idle row of the PRD §二.6 table is what actually happens | same live Host | **pass** | `CONDUCTOR-INTERRUPT-AND-SEND-IDLE PASS delivery=accepted mode=interrupt_and_send` — the state was checked and the instruction sent, with no turn to stop. |
| C63 | The queue surface reads the Host's real inbox, and is closed to a non-controller | same live Host | **pass** | `CONDUCTOR-QUEUE-NOT-CONTROLLER PASS refused="NOT_CONTROLLER: session session-not-the-controller does not hold write control of task …"`; the listing read the live inbox and reported it empty. |
| C64 | Reading and withdrawing unconsumed input against a live Host | live Host + unit tests | **pass — round 68** | **Was: not measured.** Turns still fail at once on this Host (no model credentials), which used to drain the inbox before the probe could read it (`CONDUCTOR-QUEUE-LIST DRAINED queued=0 ofQueued=4`). The hold is now the Host's own `runMaintenance` claim — waking input stays in the inbox until that task settles — and `pendingInputOf` flattens the live `UserMessage.content` blocks rather than looking for a `.text` field the Host does not publish. Live, product `conductor_send` `mode:'queue'` then `conductor_queue`: `CONDUCTOR-QUEUE-LIST PASS queued=2 ofQueued=2 hold="runMaintenance"` with readable bodies; `CONDUCTOR-QUEUE-EDIT PASS changed="edited e7a82be9-…" remaining=2 newText="edited follow-up the probe replaced 1789387567993"`; `CONDUCTOR-QUEUE-WITHDRAW PASS changed="withdrawn 391d5fe8-…" remaining=1`; `CONDUCTOR-QUEUE-WITHDRAW-REPLAY PASS changed="already_consumed 391d5fe8-…"`. C63's not-controller refusal still holds in the same run. `tests/stop.spec.ts` pins the content-block read. The interrupt-and-send success path against a *running* turn remains unit-only (T09/T10), because this Host still has no live turn to race. |
| C65 | A watch starts from the target's current position, not its history | same live Host | **pass** | `CONDUCTOR-WATCH-START PASS cursor=2` — the cursor is read from the real session, so a new watch reports forward rather than replaying history. |
| C66 | A pass with nothing meaningful to say stays silent | same | **pass** | `CONDUCTOR-WATCH-QUIET PASS delivered=0 summary="…nothing meaningful changed, so nothing was reported."` |
| C67 | A turn end produces one report, delivered by waking an idle controller | same | **pass** | `CONDUCTOR-WATCH-REPORT PASS delivered=["…: woke the controller with 1 fact(s)"] refusals=[]`. |
| C68 | The same fact is never reported twice | same | **pass** | `CONDUCTOR-WATCH-NOREPEAT PASS secondDelivered=0` — the watch's delivered-id list, not its cursor, decides what is new. |
| C69 | An undeliverable report is recorded and reported, not dropped | same | **pass** | `CONDUCTOR-WATCH-NO-CONTROLLER PASS refusals=["…: the controller session is not live, so the report could not be delivered"]`. |
| C70 | The notice carries the source the barrier keys on, in a real Host log | same | **pass** | `CONDUCTOR-WATCH-NOTICE-SOURCE PASS` — the controller's own log holds `{"kind":"plugin","plugin":"dsh-session-conductor","form":"notice","summary":"Observed on task …"}`. |
| C71 | A report-triggered turn **cannot** make a coordination write | same | **pass** | A real `conductor_create` called as that session: `CONDUCTOR-WATCH-BARRIER PASS refusal="REPORT_TRIGGERED: this turn was opened by a conductor report…"`. |
| C72 | Reporting cannot form a wake loop between controllers (T28) | same | **pass** | `CONDUCTOR-WATCH-NO-WAKE-LOOP PASS` — the reporting surface is guarded too, so a report-triggered turn cannot deliver another report. |
| C73 | The barrier blocks writes without freezing the session | same | **pass** | `CONDUCTOR-WATCH-READ-ALLOWED PASS` — a read from the same turn succeeds. |
| C74 | The control relationship is readable, and an observer can be added | same live Host | **pass** | `CONDUCTOR-ACCESS-LIST PASS owner=session-verify-controller epoch=0 observers=[]`; `CONDUCTOR-ACCESS-OBSERVE PASS observers=["session-auditor"]`. |
| C75 | An observer may read but may not move control | same | **pass** | `CONDUCTOR-ACCESS-OBSERVER-CANNOT-TRANSFER PASS refusal="NOT_CONTROLLER: session session-auditor does not hold write control of task … so it cannot change who does"`. |
| C76 | A transfer switches the owner and increments the epoch | same | **pass** | `CONDUCTOR-ACCESS-TRANSFER PASS owner=session-new-controller epoch=1`. |
| C77 | A handover snapshot is produced that says reports are not replayed, and the new controller **receives** it | same | **pass — delivered as a notice in round 69** | **Was: pass, narrowly** — the snapshot existed only in the transferring caller's tool result. It is now also delivered to the new controller as a plugin `notice` when that session is live: idle sessions are woken with `steer`, busy ones are queued with `followup` and not interrupted. Live: `CONDUCTOR-ACCESS-TRANSFER PASS … snapshotDelivered=true snapshotDelivery="woke the new controller with the handover snapshot"`; `CONDUCTOR-ACCESS-SNAPSHOT PASS` still carries `"…not replayed here"`; `CONDUCTOR-ACCESS-SNAPSHOT-DELIVERED PASS count=1 … types=[…,"user/message:notice"] notice="Handover snapshot for task …"`. A session that is not live is named as undelivered rather than invented. The notice opens a turn, so a later write from that session is refused by the report-triggered barrier until a person speaks — measured, not a hole. |
| C78 | The previous controller's late request is **refused** | same | **pass — freeze on every write path in round 69** | **Was: pass, narrowly** — only `send`, `stop`, `queue`, `read` and the access tool consulted the access record. `writeControlRefusal` is now the single freeze: rule save, schedule save, artifact register/verify/transfer, handoff, and workflow save/start/drive all ask it. Live, after a real transfer: `CONDUCTOR-ACCESS-LATE-REFUSED PASS` (send); `CONDUCTOR-ACCESS-LATE-RULE PASS`; `CONDUCTOR-ACCESS-LATE-ARTIFACT PASS`; `CONDUCTOR-ACCESS-LATE-SCHEDULE PASS`; `CONDUCTOR-ACCESS-LATE-HANDOFF PASS`; `CONDUCTOR-ACCESS-LATE-WORKFLOW PASS refusal="NOT_CONTROLLER: session session-verify-controller does not hold write control of task … (node only); 1 control problem(s); the definition was not saved."`. The epoch still increments in the same record as the owner change. |
| C79 | The new controller can work after the transfer | same | **pass** | `CONDUCTOR-ACCESS-NEW-CONTROLLER PASS delivery=accepted`. |
| C80 | An undispatched operation carries over under its original id, and an uncertain one stays uncertain | unit tests | **pass** | `tests/access.spec.ts` — a `prepared` operation is `continue`; `dispatching` and `unknown` are `reconcile` and appear in `uncertain`; a withdrawn one is not taken over. **Not measured live**: this composition's send path completes synchronously to `accepted`, so no operation can be left in flight to hand over. |
| C81 | Reported **automatically**, with no tool call asking for it | same live Host | **pass** | The probe sets up a watch, then does nothing for 18 s: `CONDUCTOR-PASS-AUTOREPORT PASS notice="Observed on task … [turn_ended] …"`. |
| C82 | A scheduled check **fires on its own cadence**, with no tick call | same | **pass** | `CONDUCTOR-PASS-AUTOTICK PASS runs=4` over ~18 s at 1000 ms spacing — four occurrences, not one, so the pass re-arms rather than firing once. |
| C83 | The pass is armed after the store opens and says so | same | **pass** | `[dsh-session-conductor] background pass every 5000 ms`. |
| C84 | The pass records durable evidence | same | **pass** | `CONDUCTOR-PASS-RECORDS PASS notifications=size=103`. |
| C85 | **Uninstall leaves the profile bootable** (M0, C8) | DSH Desktop 2.0.3, `dev` profile, isolated `DSH_HOME` | **pass** | After `plugin --profile dev remove dsh-session-conductor` the profile still boots and serves the web app: `aliveAfter22s=True served=True loadError=False`, and the probe reports `CONDUCTOR-VERIFY PENDING … present=[] registryPresent=true domainOpen=false` — no conductor tools and no conductor domain. |
| C86 | Uninstall does **not** delete data (PRD §八) | same | **pass** | `storages/session_conductor.json` is still present and unchanged (272 564 bytes) after the removal. |
| C87 | Re-installing restores the plugin | same | **pass** | After re-adding: `conductorMounted=True toolPresent=True loadError=False`. |
| C88 | Workflow definition validity — acyclic, and rework is not a cycle | unit tests | **pass** | `tests/workflow.spec.ts` — a cycle is refused with the reason that rework is expressed by the bounded mechanism; a diamond is accepted; every problem is reported, not the first. |
| C89 | The six start conditions are each reported | unit tests | **pass** | Each of upstream acceptance, pinned inputs, authorisation, environment, capacity/budget and approvals is asserted to block on its own, with the failing one named. |
| C90 | Acceptance has three outcomes and a model review is never user acceptance | unit tests | **pass** | `pass`/`fail`/`inconclusive` map to three distinct node states; `isUserAcceptance` is false for `model_review` and for `deterministic_check`. |
| C91 | Rework is bounded to two whole-workflow rounds, initial execution excluded | unit tests | **pass** | Rounds 1 and 2 open, round 3 is refused with the reason that a fresh workflow would evade the limit; a node named twice in one round is refused; a task retry counts and a message retry does not. |
| C92 | The workflow surface is reachable from a tool and durable | same live Host | **pass** | `conductor_workflow` validates, versions, starts, drives, records verdicts and bounds rework — C94–C100 below, eight checks, all measured live. |
| C94 | A cyclic definition is refused, naming why | same live Host | **pass** | `CONDUCTOR-WORKFLOW-CYCLE PASS problems=["CYCLE: these nodes form a dependency cycle: a, b. … rework is expressed by the bounded rework mechanism, not by an edge that points backwards"]`. |
| C95 | A valid definition validates without being saved | same | **pass** | `CONDUCTOR-WORKFLOW-VALIDATE PASS summary="The definition is valid: 2 node(s) in order first → second. Nothing was saved."` |
| C96 | Saving stores a version, and starting freezes it | same | **pass** | `SAVE PASS version=0`; `START PASS definitionVersion=0 nodes=[both pending]` — the run records the version *and* its own node list, so a node added later is not silently part of it. |
| C97 | A ready node is dispatched with a deterministic operation id | same | **pass** | `DRIVE PASS actions=["first: dispatched as workflow-run-6754bd97-…-first-1"]` — a repeated drive is a replay, not a second instruction. |
| C98 | A node whose upstream has not passed acceptance is blocked, and the condition is named | same | **pass** | `BLOCKED PASS problems=["second: upstream_accepted — these upstream nodes have not passed acceptance: first"]`. |
| C99 | A verdict moves the node to its acceptance state | same | **pass** | `VERDICT PASS firstState=accepted`. |
| C100 | Rework ends at `needs_user` rather than looping | same | **pass** | `REWORK-LIMIT PASS status=needs_user reworkRoundsUsed=1 problems=["node first failed and the workflow has used all 1 rework round(s); it now needs the user. Starting another workflow to get more room would evade the limit rather than respect it."]` |
| C101 | A nested `required` in a tool parameter fails the **whole** registration | measured while building this | **found and fixed** | The Host's value-schema DSL supports `required` only at the top level of a parameter map. A nested one threw `JsonSchemaError: … items.required is not supported by the value schema DSL` and took **every** conductor tool down with it, not just the offending one. The two mandatory node fields are now checked in `execute`, where nothing upstream can enforce them. |
| C102 | A constraint change produces a new version; an unchanged statement is refused | same live Host | **pass** | `SET PASS version=0`; `VERSION PASS afterChange=1 unchangedProblems=["the constraint already says exactly this, so no new version was created"]`. |
| C103 | The default scope reaches only future runs, and says so | same | **pass** | `FUTURE PASS caveat="This change applies to future runs only. … nothing in progress was altered."` |
| C104 | Applying to current work computes the impact and states its limits | same | **pass** | `CURRENT PASS nodes=["build","verify"] caveat="… at the next processable boundary. It does not alter a request that has already been committed, and no in-flight turn is claimed to have changed."` |
| C105 | Acknowledgement is **not** compliance | same | **pass** | `ACK-NOT-COMPLIANCE PASS summary="… acknowledged constraint … v1. Acknowledgement is not compliance."` |
| C106 | Delivery stages are one-way, may not be skipped, and `verified` needs a check | same | **pass** | `STAGES PASS` — `in_context → verified` refused (`"cannot jump to verified, because the stage in between would be asserted without having happened"`), and `verified` without a command refused (`"verification needs the check that established it"`). |
| C107 | A budget sets, and the ledger counts every plugin-initiated event | same live Host | **pass — automatic writers for all four kinds in round 70** | **Was: pass, narrowly** — arithmetic via the manual `record` action, with no dispatch path writing the ledger. PRD §二.13.2 names 节点、验收、回报和返工. Nodes write through `countDispatch` (C192); acceptances through `countAcceptance` (C216); a delivered report now writes `report_turn` (`CONDUCTOR-LEDGER-REPORT PASS delivered=1 reportTurns=1`, `live-r70c.err.log`); an opened rework round writes `rework_round` (`CONDUCTOR-LEDGER-REWORK PASS reworkRounds=1`, `live-r70d.err.log`). Failed or silent reports are not counted. A later failure that hits the rework limit and hands the run to the user is a stop, not another round. Manual `record` remains for attempts, person turns and usage. |
| C108 | An unmeterable figure reads as unavailable, never as zero | same | **pass** | `UNAVAILABLE PASS tokens="tokens: unavailable — this deployment cannot meter it, which is not the same as zero"`. |
| C109 | Reaching a limit produces the specification's three-part response | same | **pass** | `REACHED PASS limit=dispatches actions=["stop_new_scheduling","request_cancel","keep_ledger"]`. |
| C110 | A strict limit the deployment cannot meter **refuses** the execution | same | **pass** | `STRICT-REFUSED PASS reason="a token ceiling cannot be enforced because this deployment cannot meter tokens. This policy asked for a strict limit, so the automatic execution does not start: a limit that cannot be measured cannot be guaranteed…"`. |
| C111 | The boundary a budget does not cross is stated, not implied | same | **pass** | `BOUNDARY PASS` — the summary names the native interface. |
| C112 | An export renders as Markdown and as JSON, exact at its cutoff | same live Host | **pass** | `MARKDOWN PASS cutoff=2026-09-14T02:53:30.078Z bytes=1194 excluded=3`; `JSON PASS notRestorable=true chain=1`. |
| C113 | The three exclusions are in the document, and it says it is not a restore package | same | **pass** | `EXCLUSIONS PASS excluded=["credentials and tokens","environment variable values","full raw tool output"]`. |
| C114 | Online sharing is off, with a reason rather than a failure | same | **pass** | `SHARE-OFF PASS reason="online sharing is disabled by default. Enabling it needs a separate self-hosted HTTPS snapshot service, which this deployment does not have…"`; `SHARE-RULES PASS rules=6`. |
| C115 | Model options come from the Host's live catalogue, not a private list | same live Host | **pass** | `CATALOGUE PASS providers=["deepseek-official"] models=["deepseek-v4-flash","deepseek-v4-pro","deepseek-v4-flash-vision-exp"] efforts=[]` — read from `ctx.llm` at call time. |
| C116 | "Next request" and "most recently actually used" are reported separately | same | **overstated — corrected in round 32** | The quoted output is `TWO-FACTS PASS state="Next request will use: (none recorded)\nMost recently actually used: (none recorded)\nNo change is pending…"` — **both** halves read "none recorded". PRD §二.3 requires the interface to show the two separately, and the separation is real in the renderer, but the production call never supplies a pending selection, so "next request" can never say anything. The check as written measured two empty lines and was graded a pass; it is downgraded to **partial**. |
| C117 | A provider with no registered route is refused; an unlisted model is kept with a note | same | **pass** | `BAD-PROVIDER PASS notes=["this Host has no registered route for provider \"not-a-provider\". Registered providers are: deepseek-official…"]`; `GATED notes=["some-model is not advertised by provider \"deepseek-official\" … It was kept: the Host documents its model catalogue as advisory … this is a note, not a rejection."]`. |
| C118 | The write is gated on the Host extension rather than changing the global default | same | **pass** | `GATED PASS changed=false` with the reason naming `rememberAsDefault` and `docs/host-extension.md`. |
| C93 | The management panel (client half) | — | **no longer blocked: built, served and loadable; list filter, grouping, detail view and 打开原会话 implemented; rendering unverified** | See C119–C122, C204–C208, C211. The build preset is unpublished, but its *contract* is readable from the source checkout and was reproduced deliberately; the previous "blocked" verdict was reached before doing that. What remains untested is what the panel looks like when a real browser mounts it — recorded as untested rather than implied by a green build. Round 50 added the status filter, the grouping and the derived status badge (C204–C206); round 51 added §二.1's 任务详情 over a second read-only route (C208); round 54 added 打开原会话 through the Shell's own `sessions.open` (C211); round 58 established why the detail **input box** is not implementable here rather than leaving it as an omission (C207). |
| C119 | The client half builds in the shell's closure-factory format | Windows 11, tsdown 0.23.0 | **pass** | `lib/client.js` 6.95 kB, banner `window.__ModuleLoader__.load({ id: "dsh-session-conductor", factory: (require) => {`, footer `return module.exports; } });`. |
| C120 | Every specifier the bundle requires is a platform module | Node 26.5.0 | **pass** | `client-half smoke: OK (bundle=6937 bytes, requires=["react"], slot=shell.overlay, rendered=334 bytes)` — the smoke test refuses any `require` the frozen module table cannot answer. |
| C121 | The panel registers into an **additive** seat and reports a shell with no slot registry | Node 26.5.0 | **pass** | The probe asserts `slots.inject('shell.overlay')`, that the entry carries an `order`, and that `apply({})` warns rather than pretending it mounted. |
| C122 | The Host **serves** the bundle to the shell | same live Host | **pass** | `GET /plugins/dsh-session-conductor/client.js → 200 bytes=6950`, head `window.__ModuleLoader__.load({ id: "dsh-session-conductor"` — the same route and format as `@deepseek-ai/dsh-api-remotes/client.js`. |
| C123 | The panel is a view, not an authority, and says which absence it has | unit test | **pass** | Rendered through `react-dom/server`: "No coordination data source is registered in this shell … This is not the same as having no tasks." — three absences (no source, loading, empty list) are kept apart. |
| C124 | A published tarball would carry **both** halves | `npm pack --dry-run` | **pass** | 10 files: `lib/client.js` 7.0 kB, `lib/client.js.map` 11.3 kB, `lib/index.js` 492.1 kB, `lib/index.js.map` 946.1 kB, `lib/index.d.ts`, `cordis.patch.yml`, both READMEs, `docs/PRD.md`. Package 388.5 kB. The client entry is a real shipped artifact, not a build leftover. |
| C125 | Both entries resolve from an **installed** profile's `node_modules` | fresh profile, `plugin add` | **pass** | `dsh-session-conductor` → `lib/index.js`; `dsh-session-conductor/client` → `lib/client.js`, announcing `id: "dsh-session-conductor"`; `dsh.client` reads back `{"platform":"web","immediately":true}`. |
| C126 | Booting a freshly composed **minimal** profile | fresh profile | **not measured — environment / scaffolding, not the package** | The profile carries only `@deepseek-ai/dsh-base`, so it exposes no tool registry and its own `cordis-plugin-hmr` collides with the harness's HMR stub (`service "hmr" has been registered at <conductor-verify-hmr-stub>`). This is the same limitation recorded in round 17 for a fresh profile; the plugin itself mounted and reported `7 of 7 features disabled`, which is the correct reading of a composition with no services. A composition with the web app (the `dev` profile) boots and serves both halves — C122. |
| C127 | The panel's data route is registered in a live Host | same live Host | **pass** | `[dsh-session-conductor] panel data route at /conductor/panel`. |
| C128 | The route answers with selection metadata and nothing else | same | **pass — re-measured in round 50** | `GET /conductor/panel → 200, application/json; charset=utf-8, cache-control: no-store, 25929 bytes, total=91`. Task fields are exactly `taskId, title, preparation, execution, status, cwd, updatedAt` (plus the optional `statusReason`, `lastTurn`, `pendingInteraction`, `unread` when present). The longest string values are 52-character directory paths — no message content. The `status` badge was added in round 50 and the field list re-read from the live payload in the same run; the byte count and `total` above are from that run, and both grow as the store does, so they are a record of the run rather than a constant. |
| C129 | The panel distinguishes a failed read from an empty list | unit tests | **pass — fixed in round 50** | **Was: overstated.** This row claimed a unit test in round 32 and there was **no** `tests/panelapi.spec.ts` — `httpPanelPort`, the `500` path and the status-carrying behaviour were asserted nowhere. `tests/panel.spec.ts` (new, 14 tests) now pins both halves: the route handler called with a `build` that throws answers `500` with `{"error":"the store is not open"}` and **not** a `tasks` key ("a failed read is reported as a failure, never as an empty list"), a successful call answers `200` with `application/json; charset=utf-8` and `cache-control: no-store`, `registerPanelRoute(undefined, …)` returns `undefined` rather than pretending, and `httpPanelPort` carries the HTTP status into the message — `404 Not Found` and `500 Internal Server Error` are distinguishable, and a payload with no `tasks` key reads as an empty list rather than crashing. |
| C130 | Cross-Host compatibility is checked on four aspects, all reported | unit tests | **pass** | `tests/crosshost.spec.ts` — plugin, protocol, model and workspace; a protocol mismatch is refused rather than negotiated, and a remote that has reported **nothing** is not read as compatible. |
| C131 | The ordering rule: the target binds only after a confirmed stop **and** a frozen dispatch | unit tests | **pass** | `stopped`+`frozen` allows; `unknown` is refused explicitly ("a source that cannot be confirmed is not a source that has stopped … two live copies"); `running` and an unfrozen dispatch are each refused with their own reason. |
| C132 | Unmapped source paths are reported, not guessed at | unit tests | **pass** | `translatePath` returns an unmapped path unchanged **and** `mapped: false`, and does not map a path that merely shares a prefix string (`D:/work/application/x.ts`). |
| C133 | Reconciliation across a recovered link never resends | unit tests | **pass** | What the remote reports as accepted is **adopted**; an unknown delivery stays unknown; an operation the remote never saw asks a human. The test asserts no decision is a resend and that all three actions appear. |
| C134 | Cross-Host is off, with a reason naming the missing transport | unit tests | **pass** | Unavailable by default; unavailable when enabled with no registered Host; and with one registered it states that "the compatibility, manifest, path-mapping and reconciliation rules are implemented and tested; the wire is not." |
| C135 | The cross-Host surface is reachable from a tool and durable | same live Host | **pass** | `conductor_remote` registers, checks, enables, disables, removes, reconciles, and refuses a migration — C136–C140 below; the domain is now 18 tables. |
| C136 | A registration is recorded, disabled, and holds no credential | same live Host | **pass** | `REMOTE-REGISTER PASS hosts=[["probe-remote-…",false,false]]` — enabled `false`, reached `false`; `REMOTE-NOCRED PASS summary="… No credential is stored: the transport PRD §二.14.1 specifies uses your existing SSH configuration."` |
| C137 | A remote that has reported nothing fails **all four** aspects | same | **pass** | `CHECK PASS aspects=[["plugin",false],["protocol",false],["model",false],["workspace",false]]`. The first run of this probe returned `workspace: true` — an asymmetry the probe surfaced and the code no longer has (see below). |
| C138 | A migration is refused, with the reason, and nothing is sent | same | **pass** | `MIGRATE-REFUSED PASS summary="The migration was not started, and nothing was sent. cross-Host work is disabled by default, and this build carries no transport for it…"` |
| C139 | Removing a registration states what it cannot undo | same | **pass** | `REMOVE PASS summary="… This removes the permission to name that Host; it does not and cannot undo a migration that already happened."` |
| C140 | The four checks are all-silence-consistent | unit test | **pass** | `tests/crosshost.spec.ts` pins that an unreported workspace capability is **not satisfied**, so all four aspects reject an unreported answer rather than three of them rejecting and one accepting. |
| C141 | A share preview states what would be published, and publishes nothing | same live Host | **pass** | `PREVIEW PASS bytes=1196 includes=4 excludes=["credentials and tokens","environment variable values","full raw tool output"]`; `PREVIEW-NOPUBLISH PASS summary="… Nothing was published."` — the exclusions are carried from the export, so a preview cannot understate them. |
| C142 | Publishing is refused without a confirmed preview | same | **pass** | `UNCONFIRMED PASS refusals=["publishing needs the user to confirm the preview they were shown. An unconfirmed publish would put whatever the state happens to be at the moment of the call on a public address."]` |
| C143 | A confirmed publish is refused for the missing service, with nothing uploaded | same | **pass** | `NO-SERVICE PASS summary="The snapshot was not published, and nothing was uploaded: online sharing is disabled by default, and this build registers no snapshot service…"`; `NOTHING-PUBLISHED PASS shares=0`. |
| C144 | Revoking states what it cannot do | unit test | **pass** | `tests/share.spec.ts` — revocation records the instant rather than deleting the record, is one-way, and its wording says "copies that were already downloaded cannot be recalled … no mechanism exists that could recall them", so it cannot be read as "the data is gone". |
| C145 | The share surface exposes no execution interface | unit test | **pass** | The module's own surface is asserted to contain no `send`/`dispatch`/`execute`/`run`, and `SHARE_SURFACE` states that the service serves snapshots and nothing else. |
| C146 | The share service itself | — | **not implemented / not measured — no snapshot service in this environment** | The lifecycle rules are implemented and verified (C141–C145); the self-hosted HTTPS snapshot service that would receive an upload is not present here, so `publish` is refused with that reason and there is nothing to measure a successful upload against. |
| C147 | The six Git starting states of PRD §二.4 are each plannable, and each refusal names what it could not determine | unit tests + real git | **pass** | `tests/git.spec.ts` (25 tests) drives an injected runner: all six strategies plan; `default_branch` refuses rather than guessing `main` when neither `origin/HEAD` nor `main`/`master` exists; an empty repository is refused because there is no HEAD to pin; `specific_rev` pins the **resolved commit**, not the branch name. `tests/git.integration.spec.ts` (6 tests) repeats the load-bearing ones against real git 2.55.0.windows.2 in a `mkdtemp` scratch repository, and **skips itself when `git` is not on the PATH** — a skip is reported as a skip. |
| C148 | A worktree is created from the pinned commit and the source repository is untouched | live Host | **pass** | `CONDUCTOR-WORKSPACE-SOURCE-UNTOUCHED PASS head=9b1a699…->9b1a699… branch=main->main status=""->"" contentSame=true`, measured around a real `conductor_create`; `CONDUCTOR-WORKSPACE-MATERIALISED PASS worktreeFile="committed\r\n"` shows the worktree holds the committed content. The worktree is created with `git worktree add --detach`, so no branch is created, moved or left checked out on the user's behalf. |
| C149 | Creating a task from a Git starting state runs the session in the worktree and reports the baseline | live Host | **pass** | `CONDUCTOR-WORKSPACE PASS preparation=ready phase=ready strategy=current_head path=…\Temp\conductor-probe-ws-q76HJp\repo.conductor commit=9b1a699eed0cd1fb897b70ae4b5e7b13f75caf8b created=true originRepo=…\repo workspaceId=7f77027a-1cff-467e-8b7b-3608830fa26f workspaceFailure=none`; `CONDUCTOR-WORKSPACE-BASELINE PASS reportedCommit=…=repoHead reportedPath=…`. The strategy, the pinned commit and the originating project are recorded on the task, so a later reader does not have to re-derive them from a mutable branch. |
| C150 | A preparation that cannot create its worktree fails, and is **not** run in the source directory instead | live Host + unit tests | **pass** | PRD §二.4's outright rule. Live: a `worktreePath` that is an existing file produced `CONDUCTOR-WORKSPACE-NO-FALLBACK PASS preparation=failed sessionId=none reason=WORKSPACE_PREPARATION_FAILED: creating the worktree failed, so the task does not run anywhere: … It is NOT run in the source directory instead.` `tests/coordinator.workspace.spec.ts` asserts the same three ways — the failure is reported, **no session exists**, and no binding claims a directory — for a failed worktree, an unplannable starting state, and a fork. |
| C151 | The created worktree is registered as a Host workspace and the session is attached to it (T05/T07) | live Host + unit tests | **pass** | Live: a real workspace id came back from the running Host's own `ctx.workspaceRegistry` (`workspaceId=7f77027a-…`) with `workspaceFailure=none`. `tests/adapters.spec.ts` pins the adapter's refusals — a registry refusal is carried through, a refused attachment is reported while keeping the registration, and a registry whose shape is not recognised is reported rather than assumed successful. The Host's `attachSession` re-reads the session header and compares its `cwd`, so a session that is not in the directory cannot be filed under it by asking. |
| C152 | A snapshot rebuilds the committed content plus the working tree's changes, keeping staged and unstaged apart, and never copies ignored files, credentials or nested repositories | real git | **pass** | `tests/git.snapshot.spec.ts` (7 tests) against real git: the snapshot's tracked `git status --porcelain` **equals the source's** (`M  a.txt`, ` M b.txt`, `MM c.txt`), so the split survived; `git show :b.txt` in the snapshot is still the committed text while its working tree holds the edit; the source's HEAD, branch, status and file contents are byte-identical afterwards; `git stash list` stays empty (nothing was committed or stashed on the user's behalf). An ignored path, a credential-shaped path, a nested repository, a tracked path and a missing filesystem port are each **refused by name** rather than skipped. |
| C153 | A fork into a new worktree gives the child its own directory and its own workspace, leaving the source's alone | unit tests | **pass** | `tests/coordinator.workspace.spec.ts` asserts that the child's `meta.cwd` and binding `cwd` are the new worktree, that the source binding still names the source directory, that the two sessions differ, that the child's own directory is what got registered and attached, and that a fork whose worktree cannot be created **fails rather than starting the child in the source directory**. |
| C154 | The Git adapter runs through the Host subprocess seam, with an argument vector and never a shell | live Host + unit tests | **pass** | Live: `services subprocess=present fs=present workspaceRegistry=present` in the `dev` profile, and all 29 tools registered with the new parameters. `tests/adapters.spec.ts` pins the seam's contract: `argv` is `['<resolved git>', …args]` with no shell, stdin is `'ignore'` or the batch `{ data }` shape, a non-zero exit is a **result** (`ok: false`, exit 128) while an unresolvable `git`, a refused spawn and a rejected run are three distinct reported failures, and a **truncated capture is a failure**, because a truncated `status --porcelain` would describe fewer changes than the repository has and a truncated diff would apply as a partial patch. That same file covers the workspace port (C151) and the archive reader (C220/C221), and its test count is deliberately not copied here. |
| C155 | A missing or non-positive background-pass interval falls back to the documented default instead of a hot loop, and the plugin can be stopped | unit tests + smoke | **pass** | `scripts/smoke-host.mjs` now implements Cordis's `effect` contract faithfully (it calls the callback and registers what it *returns* as the disposer) and then runs every disposer: the process exits on its own with `background pass stopped after 0 pass(es)`. The fallback was added because that smoke, which bypasses the config schema, produced `setTimeout(cb, undefined)` in a self-re-arming loop — the log now reads `background pass every 5000 ms (the configured interval undefined is not a positive number)`. |
| C156 | `brief` — the **default** context mode — is really built and delivered, not merely recorded | live Host + unit tests | **pass** | §二.2.2's common path. Live: `CONDUCTOR-CONTEXT-BRIEF PASS preparation=ready contextMode=brief status=injected source=session-821f02a0-… cutoff=-1 version=0 digest=fcb6e5ad7eeeaecf`, measured through `conductor_create` whose controlling session was a real live Host session. `tests/coordinator.context.spec.ts` (12 tests) covers the non-empty case: the brief carries the completed turn's goal, `exact through event seq 2`, and the still-running turn's request is **absent** from it. Before this round the phase recorded the mode and delivered nothing. |
| C157 | The brief is queued as model-facing context and does **not** start a turn | live Host | **pass** | `CONDUCTOR-CONTEXT-QUEUED PASS status=injected observed=true targetAgentStatus=idle nextStep=1` — the brief is sitting in the target's own inbox as next-step context while the target is still `idle`. That is what §二.2.2's "a task prepared with a brief and no instruction is ready and idle" means, and it is why the conductor uses the Host's `inject` primitive rather than `followup`; `tests/coordinator.context.spec.ts` pins the order as `['inject', 'followup']` when an instruction is also given, so the instruction is read in that context. The `observed=true` flag is part of the check: the probe's first version reported PASS on a **replayed** task whose session was no longer live, i.e. it passed while observing nothing, so the observation is now required and the operation ids are run-unique. |
| C158 | A brief saves its source session, cutoff, generation time and content version | live Host + unit tests | **pass** | Live: `CONDUCTOR-CONTEXT-FILED PASS sourceSessionId=session-821f02a0-… cutoff=-1 version=0 digest=fcb6e5ad7eeeaecf sourceTaskId=task-36ec5f64-…`, read back out of the live domain's `contexts` table, with the digest equal to the one reported to the caller. `sourceTaskId` is present here because the source session was itself a managed task, and is **absent** when it is not — PRD §一.2 forbids inventing a task identity for a session. Two store lookups were added for this: briefs by **source session** (the version is monotonic per source, and a source is usually a session, not a task) and briefs by the **task they were delivered to**. |
| C159 | A context that could not be produced is reported as `none` **with the reason**, never as a `brief` | live Host + unit tests | **pass** | `CONDUCTOR-CONTEXT-HONEST-NONE PASS preparation=ready status=none reason=the \`brief\` starting context is taken from the creating session session-that-does-not-exist, and this Host cannot read its history…`. The task is still created — PRD §一.5 requires a missing ability to be disabled and explained, not to fail the request — and `tests/coordinator.context.spec.ts` also covers a Host agent with no `inject` primitive, where the status is `none` and **nothing is sent as a follow-up** instead. `contextMode: 'fork'` on create is the one genuine refusal: that mode is the fork verb's job, and the error says so. |
| C194 | A metered usage figure can be recorded at all | live Host + unit tests | **pass** | PRD §二.13.2 requires actual, partial, estimated and unavailable to be told apart, and a ceiling may only bind on a fully metered figure. The ledger's `usage` event was **unreachable** — the tool's event enum had no `usage` member and there was no way to supply a value — so tokens and cost rendered "unavailable" forever no matter what the caller knew, and `maxTokens`/`maxCost` could never bind. Now `record` accepts `event: usage` with a value **and its quality**, and refuses a figure without one: `CONDUCTOR-BUDGET-USAGE-RECORDED PASS tokens="tokens: 1200 (actually metered)"`; `CONDUCTOR-BUDGET-USAGE-NEEDS-QUALITY PASS result="BAD_REQUEST: recording usage needs a figure with its quality — tokensValue and tokensQuality, or costValue and costQuality. A figure without a quality would have to be assumed, and assuming "actual" is how an unmeterable deployment gets a ceiling it cannot honour."` |
| C195 | The concurrency limit is examined before an automatic dispatch | live Host + unit tests | **pass** | The last dead field of PRD §二.12's condition 5: `maxConcurrent` was stored, displayed nowhere, and read by nothing. It is now part of `budgetDecision` and checked before every automatic dispatch against what the Host **actually reports running** — for a task scope whether the task's own session is `running`, for a group scope how many of the group's tasks are. Live: `CONDUCTOR-BUDGET-CONCURRENT-REFUSED PASS reasons="rule-…: not dispatched — task budget task-e04102a6-…: 0 execution(s) are already in flight for this scope, and its limit is 0."` Two properties are deliberate. Concurrency lives in the *observation* rather than in the ledger, because it is a state rather than a total, and it is handed to the pure decision as `ledger.concurrent`. And when nothing observed it, the limit is **refused with that reason rather than treated as satisfied** — silence is not zero, which is the same discipline the metering qualities follow. `tests/budget.spec.ts` pins all three cases. |
| C196 | A run stops when the terms it fixed change underneath it | live Host + unit tests | **pass** | The run fixed six things at start; three of them are facts someone else can change while it is in flight, and until this existed nothing compared them — so a constraint rewritten mid-run, an input artifact replaced, or control of a node's task transferred would silently change what the work was judged against. Live, in one run: a constraint is created **before** the run starts, the run starts and its node dispatches normally (`CONDUCTOR-FIXED-HEALTHY-RUN-DISPATCHES PASS actions="only: dispatched as workflow-run-8857f582-…-only-1"`, so the check does not block a healthy run), the constraint's version is then bumped, and the next `drive` refuses — `CONDUCTOR-FIXED-STALE-RUN-STOPS PASS problems="the run's fixed terms changed: constraint constraint-2026-09-14T07:40:34.395Z moved from version 0 to 1 after this run started, so the run would be judged against a statement it never fixed"`. The run is also marked `needs_user`, because a run that keeps being driven must not look healthy to the next reader. This is also the first caller `constraintCompatibility`-style checking has ever had (R30 in the audit). |
| C197 | The acceptance rule a run fixed is enforced, not just stored | live Host + unit tests | **pass** | The last decorative part of C173, and the fix for audit finding R5: the definition's 验收规则 was persisted and **never read**, so a verdict could be judged against anything and a definition edited after a run started silently redefined what passing meant for that run. A verdict must now name the rule it was judged against, and that must be the rule the run fixed. Live: `CONDUCTOR-FIXED-RULE-NEEDS-THE-RULE PASS result="BAD_REQUEST: this node's acceptance rule was fixed when the run started (\"the report lists every finding\"), and the verdict does not say which rule it was judged against…"`; `CONDUCTOR-FIXED-RULE-REJECTS-ANOTHER PASS result="BAD_REQUEST: the verdict was judged against \"looks good to me\", and this run fixed \"the report lists every finding\". A rule changed after the run started must not silently redefine what passing means; start a new run to judge…"`; and the positive control `CONDUCTOR-FIXED-RULE-ACCEPTS-THE-FIXED-ONE PASS summary="only was recorded as pass by user."` — a correct verdict is still accepted, so the check rejects disagreement rather than everything. `tests/workflow.spec.ts` (`verdictRuleRefusal`) covers the match, whitespace-only differences, the unnamed case, the changed-rule case and a node the run fixed no rule for (which stays unconstrained, because refusing there would invent a requirement). |
| C198 | Applying a constraint to current work marks what must be re-judged, and is scoped | live Host | **pass** | The impact used to be computed and returned with **nothing written**, so an artifact reported as "needs re-acceptance" kept `acceptance: pass` and a later reader saw a clean state; and the list covered **every** accepted artifact in the store with the reason simply asserted. Live, in one run with two tasks: `CONDUCTOR-IMPACT-MARKED PASS summary="Constraint constraint-… v0 reaches current work: 1 node(s) and 1 accepted artifact(s) were marked for re-judgement (acceptance returned to \"pending\", with the reason recorded)…"`; `CONDUCTOR-IMPACT-WRITTEN PASS reached=pending unrelated=pass` — the artifact the change reaches really moved back to `pending` and the unrelated task's artifact did not move at all; `CONDUCTOR-IMPACT-SCOPED PASS affected=["artifact-probe-impact-reg-a-…"]`. Node ids are resolved **through the workflow definitions** that contain them, because a definition is what says which task a node drives — resolving by display title would treat a name as an identifier. |
| C199 | A task card shows its project, its actual directory and its Host | smoke | **pass (markup only)** | PRD §二.1 requires a card to show 名称、项目、实际目录及 Host. `project` was declared on the view type with **nothing producing it**, `cwd` was produced but never rendered, and the Host was absent from both. The payload now carries the project (the source repository a worktree came from, read from the task record) and the binding's `hostId`, and the row renders all three. Verified by rendering the row component directly through `react-dom/server` and asserting the four facts appear — plus the negative control that a task with no project of its own invents none: `project: D:\projects\parser`, `dir: …conductor`, `host: local`, and `doesNotMatch(/project:/)` for a plain task. The client bundle grew from 8010 to 8566 bytes in the same run. **Boundary:** this is markup, not a browser — browser rendering remains unmeasured, as it has been throughout (see the panel rows). |
| C200 | A strict budget is not claimed as hard without the capabilities it needs | live Host + unit tests | **pass** | `hardBudgetAllowed` existed, was tested, and was called by **nothing** — so a strict token ceiling was stored and displayed as though it were hard while nothing checked whether the deployment could honour the claim. Live: `CONDUCTOR-HARD-NOT-CLAIMED PASS summary="Budget task::probe-hard-… set (strict): 1000 tokens. a token ceiling cannot be enforced because this deployment cannot meter tokens. This policy asked for a strict limit, so the automatic execution does not start: a limit that cannot be measured cannot…"`; `CONDUCTOR-HARD-REASON-NAMES-THE-GAP PASS problems="… and claiming it would be …"`; and the control `CONDUCTOR-HARD-NO-FALSE-WARNING PASS summary="Budget task::probe-soft-… set: 3 dispatches. the run is within every limit this policy sets"` — a budget that claims nothing strict is not warned about, so the warning means something. The capability set is read from the ledger rather than assumed (`fullMetering` only when the figure is `actual_full`), and the two capabilities this build genuinely lacks are reported as absent rather than passed in as true. |
| C201 | A constraint delivery is an actual dispatch, and does not overclaim | live Host | **pass** | PRD §二.13.1: a new constraint is delivered at the **next processable boundary** and must not claim to change an in-flight request. The branch recorded whichever stage the caller named and sent **nothing**, so `sent` was a stage nobody had earned. The first delivery is now a real dispatch: `CONDUCTOR-DELIVER-SENT PASS summary="Constraint constraint-… v0 was sent to task-d42ec05a-… at its next step boundary, as constraint-constraint-…-v0-task-d42ec05a-…."`, and the operation record proves it — `CONDUCTOR-DELIVER-DISPATCHED PASS found=true delivery=accepted by=relay sourceEventId=constraint-…`. The summary carries both caveats the specification asks for: `CONDUCTOR-DELIVER-NO-OVERCLAIM PASS caveats="…not consumption and not compliance: the target reports those separately. An in-flight request is not altered — steering reaches the nearest boundary, it does not rewrite what the Host has already assembled."` The operation id is deterministic in (constraint version, target), so a repeated delivery is a replay rather than a second message, and a refused dispatch reports the reason instead of recording a stage it did not reach. |
| C202 | The export attachment bundle is written, and its ids are validated | live Host | **pass** | PRD §二.14.2: a local export supports Markdown, JSON **and a selected attachment bundle**. Live, in one run: `CONDUCTOR-BUNDLE-WRITTEN PASS file="# notes\n" summary="Exported task task-319673f8-… as markdown, exact at 2026-09-14T08:39:58.280Z: 1 session binding(s), 1 artifact(s), 1 attachment(s) written to C:\Users\…\Te…"` — the file is on disk with the artifact's content and the summary names where. Two refusals make the promise checkable: an id naming no recorded artifact is refused by name (`CONDUCTOR-BUNDLE-UNKNOWN-REFUSED PASS problems="artifact-that-does-not-exist is not a recorded artifact, so nothing was written for it"`), and naming attachments **without** a directory reports that nothing was written rather than implying a bundle exists (`CONDUCTOR-BUNDLE-NO-FALSE-PROMISE PASS`). **Boundary:** the copy goes through the Host filesystem service, which has no byte-write primitive, so a binary attachment is refused with its reason rather than copied in part — the same limit the snapshot strategy records. |
| C203 | A released task is a per-target error in `read` and `wait` | unit tests | **pass** | PRD §二.5 stops the relationship the conductor's monitoring depends on, and §二.7 requires an unavailable target to come back as **its own** error. `tests/observer.release.spec.ts` (new) asserts the snapshot reports `management of task task-1 was released at 2026-09-13T01:00:00.000Z … no longer reads its session … Anything already accepted is untouched`, that a wait returns the same error per target with no state served, and — the control — that a task which is still managed, and one that was never given a control record at all, are both still readable. That control is the reason the check is narrow: reusing the broader `monitoringAllowed` predicate here would have made every task without an access record unreadable, which is not a rule the specification states. |
| C204 | The list's status filter and grouping have a **stable key**, and the badge agrees with the card it sits on | live Host | **pass — round 50** | PRD §二.1 asks the panel for 状态筛选 and 分组, and the fields the view carried were prose written for a person (`execution` is the projection's own sentence), so there was nothing to key on. A derived badge (`preparing`, `preparation_failed`, `cancelled`, `released`, `budget_limited`, `waiting_user`, `running`, `idle`) is now built on the Host and compared, **within one live payload**, against the dimensions beside it: `CONDUCTOR-PANEL-BADGE PASS status="idle" preparation="ready" execution="idle" interaction=undefined reason=undefined`. The badge is deliberately *additional* — preparation, execution, interaction and the last turn stay separate on every card, because PRD §三.4 forbids collapsing those dimensions into one status — and the payload says so in its own notes (`CONDUCTOR-PANEL-NOTES PASS`, which also pins the honest note that `unread` counts every reported fact and never decreases, since this build has no acknowledge step). The derivation is pure and total: `tests/panel.spec.ts` enumerates all 60 combinations of the three projected dimensions and asserts each yields a badge the filter knows, plus the precedence order and the deliberate **absence** of `migrating` (every migration is refused and no migration record is constructed, so that badge would be a filter that can never match a row). |
| C205 | The badge follows facts the creation path never produces | live Host | **pass — round 50** | The measurement that makes the badge a derivation rather than a default. The probe creates a task (badge `idle`), sets a **zero-dispatch** task-scope budget on it, releases it through `conductor_access`, and re-reads the same route after each step. 预算受限 must be the **budget gate's own** answer rather than a second opinion computed for the panel, and it is: `CONDUCTOR-PANEL-BUDGET PASS status="budget_limited" preparation="ready" reason="task budget task-163b737a-…: the run has dispatched 0 time(s), its maximum. PRD §二.13.2's response is stop_new_scheduling, request_cancel, keep_ledger; …"`. Then the release: `CONDUCTOR-PANEL-RELEASED PASS status="released" preparation="ready" reason="management of task task-163b737a-… was released at 2026-09-14T08:56:35.674Z, so the monitoring that depended on that relationship has stopped. Anything already accepted is un…"`. In both cases `preparation` stays `ready`, so the badge changed for a reason that field cannot explain; the reason text is the one `budgetPermits` and `monitoringAllowed` give, so the card cannot disagree with the gate; and the second reading also demonstrates the documented precedence live — `released` wins over a budget that is still refusing. The route is fetched over real HTTP from inside the Host process, not called as a function: `CONDUCTOR-PANEL-ROUTE PASS status=200 cacheControl="no-store" contentType="application/json; charset=utf-8" bytes=26453 total=92`. Re-run against the final build of the round, all five checks pass again with a new task: `CONDUCTOR-PANEL-BUDGET PASS status="budget_limited" … task-320c03ad-…` and `CONDUCTOR-PANEL-RELEASED PASS status="released" … released at 2026-09-14T08:58:26.726Z`, `CONDUCTOR-PANEL-ROUTE PASS … bytes=26977 total=93` — the counts grow because the probe adds tasks to the retained verification store, which is why they are quoted as a record of a run rather than as constants. |
| C206 | The filter and the grouping are pure, and survive the build | smoke + unit tests | **pass — round 50** | `filterTasks`, `groupTasks` and `statusCounts` are asserted against the **built** `lib/client.js` rather than only against the sources, because a helper the bundler dropped would be a panel whose controls silently do nothing: `client-half smoke: OK (bundle=17894 bytes, requires=["react"], slot=shell.overlay, rendered=334 bytes)`. The grouping keys are asserted too: by badge in precedence order, and by project ascending with the tasks that report **no** project last under a key of `undefined` — an unnamed group that cannot be mistaken for a project actually called something, which is also the reason it is not folded into the first project. `statusCounts` returns **every** badge including the ones nothing carries, so the control surface does not move under the reader's cursor as tasks change state. The row's badge is rendered with its key in a `data-status` attribute as well as its text, so a stylesheet or an end-to-end test can select a state without matching wording. **Boundary:** this is markup and pure-function behaviour; what the panel looks like in a browser remains unmeasured (see C93, C11). |
| C207 | The rest of §二.1: 新标签页打开 and the two input boxes | — | **not implemented — 打开原会话 moved to C211 in round 54; round 58 established that the detail input box is not implementable in this build** | Narrowed three times now. Round 51 implemented the 任务详情 view (C208); round 54 implemented **打开原会话** (C211). What remains is two things, and round 58 went looking for the mechanism behind the second instead of leaving it as an omission — the result is a **decision**, not a gap. **新标签页打开** has no mechanism: the Shell's client exposes no URL or route for a session (`window.open` appears only for external repository URLs, there is no `history.pushState`, and every `location.hash` hit belongs to a bundled third-party library), so a new tab could not be told which session to show. **任务详情输入框 — sending to the task — is not implementable here without building a second, unaudited write path**, and the three measurements that settle it are: (1) the composer belongs to the shipped conversation plugin — `const inputHub = new InputHub(ctx, t)` is **module-local** and is passed to that plugin's own controller, so no service key reaches it and a third-party panel cannot draft into or submit through it; (2) the Host's `session.prompt` RPC — whose payload is `{ sessionId, mode, content, clientTimeZone? }` and whose host half is the `agent.steer/followup(createUserMessage({ source: { kind: 'user' } }))` path this project reproduced in its own probe — is invoked from a **client-side session controller**, not from any plugin-facing context service, so a plugin cannot call it; (3) the panel's own route is documented as **not an authorization boundary** ("the Host documents its own `/api` fence as a DNS-rebinding fence rather than an auth layer, and a browser caller's identity is not established by the Host"), so a write route would let any local page instruct managed sessions **as the user** — precisely the "second read path" problem the read-only route was designed to avoid, with worse consequences. The plugin's answer is therefore the honest one: the detail view **names** the target (title, directory, Host and session id), and `打开原会话` hands the reader to that session, where the shell's own composer authors the message with the person's own identity. **The main input box is untouched and always sends to the main session** — the panel registers no composer at all, so that half of §二.1 holds by construction. **Round 68:** left as this decision rather than reopened as an omission. It is a Host capability limit, not an unimplemented product path. |
| C211 | §二.1's 打开原会话 reaches the shell's own session navigation | smoke + unit tests | **pass — round 54** | §二.1 requires the panel to offer "打开原会话". The API was found by reading the installed Shell instead of inventing one: its client context exposes a **`sessions` service** whose `open(sessionId)` brings a session to the front, its own conversation plugin documents it ("The caller owns navigation: take the returned id to `sessions.open`"), and the shipped `ui-workflow-run` plugin declares `inject = ["conversationEvents", "slots", "sessions", "locale"]` and calls `ctx.sessions.open(id)`. The panel now reads that service — **not** through `inject`, because an unmet injection keeps a cordis entry pending and the whole panel would vanish in a shell without navigation rather than existing and saying what it cannot do — and offers an `open session` control on the card and in the detail view, carrying the session it would open in `data-session-id`. Two boundaries are enforced rather than implied: the control is rendered **only** when the shell can actually navigate (a control that silently did nothing would be worse than none), and the panel says once, above the list, that this shell has no session navigation when it has none. The wiring is asserted through the registered entry itself — `entry.render().props.navigation.open('session-from-shell')` forwards to the service — and the method is called **as a member** of `sessions`, because a detached call works in the harness and breaks in the browser, which is the one place it cannot be tested here. Live, the card carries the session the create actually bound: `CONDUCTOR-PANEL-SESSION PASS bound="session-4254f617-…" card="session-4254f617-…"` (checked against the binding, since a card naming a different session would open the wrong conversation rather than none). **Boundary:** markup and wiring are verified; what the browser does when the reader clicks it remains unmeasured, as all rendering here does (C93, C11). |
| C208 | §二.1's 任务详情: 成果, 操作记录, 配置 and 权限 — and the conversation refused **by name** | live Host + unit tests | **pass — round 51** | §二.1 requires the detail surface to show 聊天、成果、操作记录、配置与权限. Three of the four are metadata a read-only route can serve honestly; **chat is not**, because history belongs to `conductor_read`, which keeps a per-reader cursor, marks truncation and decides what a reader may see — a second read path here would have none of that, and a view that rendered nothing for chat would read as "there was no conversation". So the payload carries the other three plus a `refusals` entry naming `conductor_read`, and the view renders it rather than hiding it. Live, in one run: `CONDUCTOR-PANEL-DETAIL PASS status=200 taskId="task-14ea9d12-…" preparation="ready" contextMode="empty" artifacts=0 operations=1 refusals=3 bytes=1421`, with the route announced as `[dsh-session-conductor] panel detail route at /conductor/panel/task`. The route takes its subject as a **query parameter** (`?taskId=`) rather than a path segment because the Host's own matcher resolves on `new URL(req.url ?? '/', 'http://x').pathname` — read from the `dsh-host-webserver` source in the pinned install, not assumed. Two negative checks make the answers distinguishable rather than merely present: `CONDUCTOR-PANEL-DETAIL-UNKNOWN PASS status=404 error="NOT_FOUND: no task \"task-that-does-not-exist\" is recorded, so there is no detail to serve."` and `CONDUCTOR-PANEL-DETAIL-NAMELESS PASS status=400 error="BAD_REQUEST: the task detail route needs a \"taskId\" query parameter naming the task to describe. …"` — "no subject", "no such task" and "the read failed" (`500`) are three different answers, because a view has to tell them apart. `tests/panel.spec.ts` (19 tests) pins the query parsing (encoded ids, blank parameters, absent target, undefined request), the three statuses, `no-store`, and the client port's encoding of an id that contains a separator. **Boundary:** the markup is verified through `react-dom/server`, and what the panel looks like in a browser remains unmeasured (see C93, C11). |
| C8 | Plugin uninstall leaves the profile bootable | — | **measured as C85** | — |
| C191 | A reached budget limit **stops new automatic dispatch** | live Host | **pass** | PRD §二.13.2's first action, and the one that did not exist: nothing consulted the budget, so a reached limit stopped nothing. Live, in one run: a strict task-scope budget of one dispatch is set, the first automatic rule dispatch goes out, and the second is refused — `CONDUCTOR-BUDGET-GATE-REFUSED PASS reasons="rule-8f4b0405-…: not dispatched — task budget task-99a6b168-…: the run has dispatched 1 time(s), its maximum. PRD §二.13.2's response is stop_new_scheduling, request_cancel, keep_ledger; the automatic dispatch was not made, and the ledger and result…"`. The gate is asked by **all three** automatic dispatch paths (rule firing, schedule occurrence, workflow node) and deliberately **not** inside the ordinary send path: a person's explicit instruction is not "自动调度", and refusing it would be a different rule than the specification states. A refused schedule occurrence is recorded with its own outcome `refused` rather than as a failure or a skip, because a plan that quietly stops firing is indistinguishable from one that was never saved. |
| C192 | The ledger counts automatic dispatches **by itself** | live Host | **pass** | The other half of the same rule, and the reason C107's "counting" was narrow: the ledger had one writer, the manual `record` action, so automatic work was counted only if a caller counted it. Live: `CONDUCTOR-BUDGET-GATE-COUNTED PASS fired=true ledgerDispatches=1` — nobody recorded anything, and the dispatch appears in the ledger of every governing scope. `countDispatch` increments **all** scopes that govern the target, because a group-scope limit counts the dispatches its tasks make rather than only its own. |
| C193 | The wall-clock deadline is measured from the first **dispatch** | live Host + unit tests | **pass** | PRD §二.13.2 says so, and the anchor was taken from the first *turn* instead — a different, later fact, which silently extended every deadline by however long the target took to start. A `dispatch` event now carries its instant, `carryLedger` anchors on the first event that has one (never rewriting it), and the instant is exposed in the ledger view so a reader can check the one limit whose meaning depends on when it started: `CONDUCTOR-BUDGET-GATE-KEPT PASS ledgerDispatches=1 firstDispatchedAt=2026-09-14T06:51:51.470Z`. `tests/budget.spec.ts` pins that a later dispatch or turn cannot move it and that an event carrying no instant leaves it unset rather than inventing one. |
| C190 | Why a message was sent is answerable afterwards | live Host | **pass** | The reader half of §四.2, and the reason the association is worth storing: `conductor_operation status` reports the kind, the grant, the rule and the triggering event for the operation a rule claimed — `CONDUCTOR-ACCEPT-ATTRIBUTION PASS by=rule grantId=grant-… ruleId=rule-… sourceEventId=artifact-…`. Without it, "this message arrived from somewhere" and "a grant you issued for this rule, in response to this event, sent it" would look the same. Its boundary is recorded in C182: the attribution is durable in the conductor's own operation record, not injected into the Host's session-log source. |
| C160 | The `operation` family exists and reads preparation progress through an operation id | live Host + unit tests | **pass** | PRD §三.3 lists `operation` as a method family and §二.2.1 requires progress to be read through it; before this round there was **no surface at all** — creation did not even echo the `operationId` it had recorded, so nothing the caller held could address an operation. `conductor_operation` (30th tool) now reports one operation with the task's own preparation beside it, lists a task's operations, cancels a preparation and resumes one. Live: `CONDUCTOR-OPERATION-ECHO PASS operationId=probe-operation-create-aaedabbb … taskId=task-369a76e7-…` (creation hands back both, §二.2.1); `CONDUCTOR-OPERATION-STATUS PASS found=true preparation=ready phase=ready delivery=accepted cancellable=false`; `CONDUCTOR-OPERATION-LIST PASS total=1`; `CONDUCTOR-OPERATION-CANCEL-REFUSED PASS result=PREPARATION_NOT_CANCELLABLE: … finished preparing, so there is nothing left to cancel. Its first instruction, if it…`. The 30-tool list in the same run confirms the new schema registers. `tests/coordinator.operation.spec.ts` (13 tests). |
| C161 | Cancelling a preparation withdraws the undelivered instruction and keeps what was created | unit tests | **pass** | PRD §二.2.1: "用户取消准备后，未投递的首条指令不执行；已创建目录和会话保留并报告". The cancellation window is narrow and stated as such: creation runs its phases inside one Host call, so a task is observed in `preparing` when the Host stopped between phases. The test constructs exactly that state, then asserts the operation becomes `withdrawn`, the task becomes `cancelled` **with the phase it reached still recorded**, and the session id is reported as kept. A preparation that already **failed** is refused rather than cancelled — it is not running, so there is nothing to stop, and `resume` is the verb for it. |
| C162 | A resume continues from the phase reached without creating a second session or worktree | unit tests | **pass** | A preparation stops for reasons that do not destroy what it made (§二.2.1 keeps "已创建目录和会话"). `resumePreparation` re-runs only the phases that had not completed, reuse-guarded on the existing binding: the test asserts the resumed task reports the **same** `sessionId` and that the instruction is not sent a second time. It is refused for a cancelled task (resuming would undo a decision the user made), for a ready one, and for a caller that does not control the task. |
| C163 | Reading and changing are separated on the model-configuration surface | unit tests | **pass** | A systematic audit found `conductor_model` accepted a `callerSessionId` and never checked it, so **any** session could ask to reconfigure a task it does not control — unlike every other mutating surface (PRD §一.3, §二.10.1). The change actions now go through the same `requireController` gate as the rest of the plugin. |
| C164 | The model-configuration change path actually changes something | unit tests + pinned Host source | **safe refusal in the current Host; companion writer not installed** | The previous path used `applySelection` as a pure predicate but still reported `changed: true`. That false-success path is corrected: `set` now requires both the operator declaration and a callable `ctx.conductorSessionModelSelection`, invokes `selectForSession({ sessionId, selection, rememberAsDefault: false })`, validates the returned normalized provider/model, and reports `changed: false` if the writer is missing, fails or responds malformed. `tests/modelconfig.spec.ts` and `tests/capabilities.spec.ts` pin those cases. The measured Host has neither the parameter nor the writer, so no model change is applied there. The writer remains a separate Host extension contract in `docs/host-extension.md`; it has not been installed or measured. |
| C165 | Reasoning effort comes from the Host's live catalogue, per **model** | live Host + unit tests | **pass — fixed in round 60** | **Was: partial, and the port behind it had no Host counterpart.** The plugin declared `listReasoningEfforts?()`, no Host ever supplied it, so `reasoningEfforts` was always `[]` and C115's `efforts=[]` measured a missing port rather than the Host. Round 55 established that no such bulk method exists anywhere in the install (`listReasoningEfforts` appears **0 times**), and round 60 read the installed Harness to find what does exist: `ctx.llm.resolveModelInfo(provider, model)` "resolves and validates the exact model identity, the available context, the output default and the **reasoning metadata**" from the adapter that owns the route — and the Host builds its own model catalogue from exactly that (`const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)` → `resolved.reasoning.efforts`). Levels are therefore **per model**, read through `publishedReasoningOf`. The flat field was replaced by one that names its subject: `reasoning: { model, efforts }`, plus a `reasoningNote` whenever there are none — because "the Host publishes none for this model" and "no catalogue could be read" are different facts, and neither is an empty list. The distinction is the Host's own and is quoted from its documentation: a model **with** reasoning metadata publishes its ordered levels, while one **without** it "exposes no `reasoning` at all", because pi-ai reports such a model as supporting only `off` — and `off` is translated into *omitting* the option, which is the same request as naming nothing. Calling that a level "would be a control that does nothing". Live: `CONDUCTOR-MODEL-REASONING PASS readings=[{"model":"deepseek-official/deepseek-v4-flash","efforts":["off","low","high","max"],"reportedFor":"deepseek-official/deepseek-v4-flash"},{"model":"deepseek-official/deepseek-v4-pro",…},{"model":"deepseek-official/deepseek-v4-flash-vision-exp",…}]`. **Boundary, stated because the evidence does not reach it:** every model this Host advertises publishes the *same* four levels, so this run shows the levels arrive **with the model they belong to** and are read from the Host — it does not show that two models' sets would differ (`distinctEffortSets=1`), nor exercise the "publishes none" branch end to end. Both are covered by `tests/modelconfig.spec.ts` against synthetic catalogs, including the empty-but-published case that must stay distinct from nothing-published. |
| C166 | "Most recently actually used" is read from the Host's own record, and "next request" is honestly absent | live Host + unit tests | **half fixed in round 55; the other half is now measured rather than merely missing** | **Was: both halves read "(none recorded)"** (C116), and the panel's `modelLastUsed`/`modelForNextRequest` were declared on the view with nothing producing either. Round 55 fixed the half that is readable and left the other absent **with its reason**. The actually-used fact now comes from the **Host's own** record: the installed Host answers "what did the last request use" with `agent.session.requestHeader()?.config` (its own model-selection code reads exactly that, in the documented precedence "a selection made in this process, else the session's own latest logged `request/header`, else the live Agent default"), so `selectionFromHeader` reads the same field and cannot disagree with the Host about the session's configuration. It appears in three places from one helper — the model tool, the card and the detail — because a card that disagreed with the tool would be worse than a card that said nothing. Measured live: the verify Host cannot assemble a request (no model credentials), so the probe writes the Host's **own** `request/header` event through the Host's **own** session API and then measures the read-back: `CONDUCTOR-PANEL-MODEL-LASTUSED PASS written=true append="written" card="probe-provider/probe-model at high reasoning" forNextRequest=undefined state="Next request will use: (none recorded)\nMost recently actually used: probe-provider/probe-model at high reasoning\n…"`, and the same value travels with the detail (`CONDUCTOR-PANEL-DETAIL PASS … modelLastUsed="probe-provider/probe-model at high reasoning" …`). **The next-request half is still not produced, and the reason is now precise rather than generic:** it is the conductor's own *pending* selection, this build stores none, and the only writer would be a model change — which `conductor_model` refuses (C164). The card's own notes and the detail's refusals say so, in the words a reader needs: an empty `modelForNextRequest` means "nothing pending is known", not "no change is pending". `tests/panel.spec.ts` pins the header reading, including every shape that must yield no selection rather than a fabricated one. |
| C167 | Presets can be chosen at creation, and changed only by a new task or a fork | live Host + unit tests | **pass — fixed in round 57** | **Was: partial.** `presetChangeAllowed` implemented PRD §二.3's rule and was unit-tested, but it had **no production caller**, and `conductor_create`/`conductor_fork` had no preset parameter at all — so the rule was neither enforced nor actionable while the README and the tool description advertised it. Now: `conductor_create` and `conductor_fork` accept a `preset`, the id is checked against the **Host's own roster** before anything is created, the session is composed through the Host's `mount`, and the composition is recorded on the task so a reader can see what it actually got. The check runs in the preparation phase, which means a bad preset is a **preparation failure** like any other: the task record survives with the reason and **no session is created** — rather than a Host assembly error arriving after a worktree already exists. Three live checks, with the roster read from the Host instead of assumed (this profile offers `standard, code, minimal, cordis`, and `standard` is its default): `CONDUCTOR-PRESET-NAMED PASS preset="standard" preparation="ready" taskId="task-051cd904-…" detailPreset="standard" roster=["standard","code","minimal","cordis"]`; `CONDUCTOR-PRESET-UNKNOWN PASS preparation="failed" sessionId="none" reason="PRESET_UNAVAILABLE: preset \"probe-preset-that-does-not-exist-…\" could not be resolved: agent-presets: preset \"…\" not found (available: standard, code, mi…"` — the roster's own words, listing the real alternatives; and `CONDUCTOR-PRESET-UPDATE-REFUSED PASS refusal="BAD_REQUEST: a preset takes part in runtime assembly, so it cannot be changed on a session that already exists. … move the task to a successor session (conductor_handoff), …"`, which is `presetChangeAllowed` finally having an enforcement point (the parameter exists on `conductor_update` only so that asking gets the explanation rather than a schema error). Two boundaries are enforced rather than implied: a preset the roster lists as **broken** is refused with the roster's own reason (it resolves — the directory still holds the id — so "exists but cannot be assembled" is a different answer from "no such preset"), and a **named preset with no roster to check it against** is refused rather than composed without it. A fork still inherits the source's preset by default (分叉继承源会话有效配置), resolved from the source's own log rather than its header, and a named one overrides it. **Note on the digest:** `preset` joins the create operation digest **only when it is named** — the canonical form drops undefined members, so a create that names no preset digests exactly as it did before this parameter existed. Writing `null` there would have changed the digest of every ordinary creation, which is the compatibility cost C209 records. |
| C168 | Releasing management stops the monitoring that depends on it, and is reachable | live Host + unit tests | **pass — fixed in round 43** | **Was: two defects.** `Coordinator.detachTask` was reachable from **nothing** — no tool, no panel, no Remote — while its doc comment claimed release "stops the monitoring", which the report loop did not do: it checked only that the task existed, so a released task's watch kept reporting. `conductor_access` now has a `release` action (the family that owns the control relationship), the report path asks `monitoringAllowed` before it observes anything, and releasing twice is idempotent. Live: `CONDUCTOR-RELEASE-REACHABLE PASS summary="Task task-78d3da94-… is released from management. Monitoring that depended on the relationship has stopped and new automatic actions through it are blocked; the task record, its artifacts and …"`; `CONDUCTOR-RELEASE-STOPS-MONITORING PASS refusals="management of task task-78d3da94-… was released at 2026-09-14T08:02:48.686Z, so the monitoring that depended on that relationship has stopped. Anything already accepted is untouched; r…"`; `CONDUCTOR-RELEASE-WATCH-LIVE PASS refusals=""` (the control: a live watch is not refused) and `CONDUCTOR-RELEASE-ONCE PASS`. `tests/access.spec.ts` pins the predicate's three answers. |
| C169 | A task list can be filtered by project, name, status, Host, group and archive state | live Host + unit tests | **pass — filters and access-checked session search** | PRD §二.5: 支持按项目、名称、状态、Host、分组、归档状态筛选. **Was: only group, archive, pinned, preparation and controller filters existed**, and the row recorded a second gap in the same sentence of the specification. The filters are now the full set, and two facts that made them impossible before are now on every row: the **project** was not exposed at all, and neither was the **status** — a caller had nothing to filter by. The new filters are not implemented where each fact happens to live, because they span three homes: the task record (name, project, group, archive state, preparation), the **binding** (the Host and directory), and a **derived** fact (the badge `panelStatusOf` computes from the projection, the release record and the budget gate). Filtering each where it lives would have been three disagreeing ideas of what "filter by status" means, so the row is assembled once in `conductor_list` and narrowed by one pure function (`service/taskfilter.ts`), which is why the filter semantics are unit-tested without a Host at all (`tests/taskfilter.spec.ts`, 6 tests: substring and case rules, exact matching, absent filters, order preservation, and that a row which *cannot* answer a filter — no binding, so no Host and no badge — does not match it). The badge itself now comes from **one** derivation shared by the card, the detail view and this filter (`index.ts`'s `panelFactsOf`), so a list that filters on a status the card does not show is no longer possible; `scripts/smoke-host.mjs` asserts the tool's `status` enum **is** `PANEL_STATUSES` rather than a copy that could drift. **Measured live**, filtering by the values the tool itself reported rather than by values the probe chose: `CONDUCTOR-LIST-EXPOSED PASS status="idle" hostId="local" cwd="D:\\workspace\\…" sessionId="session-7f28c272-…" rows=216 of 216`; `CONDUCTOR-LIST-NAME PASS name="C10A7B0F" total=1` (case-insensitive substring); `CONDUCTOR-LIST-STATUS PASS status="idle" total=196 because="status = idle"` with the control `CONDUCTOR-LIST-STATUS-CONTROL PASS status="preparing" total=0 carriesMine=false`; `CONDUCTOR-LIST-HOST PASS hostId="local" total=214` with `CONDUCTOR-LIST-HOST-CONTROL PASS total=0` for a Host that does not exist; and `CONDUCTOR-LIST-PROJECT PASS needle="-q76HJp\\repo" upperCased=true total=1` — a real Windows project path matched case-insensitively. A narrowed list also **says it is narrowed**: every result carries `filteredBy`, so `CONDUCTOR-LIST-NONE PASS total=0 tasks=0 filteredBy="name contains \"no-such-task-…\""` — "no task matched this filter" rather than "the conductor manages nothing", which a bare count cannot distinguish. **Closed in round 66, the other half of §二.5's paragraph:** 全文搜索仅限调用者有权读取的会话. A `query` on `conductor_list` now searches the same readable history `conductor_read` projects (`historyOf`: public messages and tool results, never token streams), through the observer's own resolve path — **not** `callerEvents`, which remains the write-barrier's unauthenticated read of the caller's *own* session. Access is `mayRead` (controller or observer) plus the release check: a stranger is omitted entirely (not listed as unreadable, which would leak that a session exists), a released task the caller used to read is named as unreadable, and each hit is `{ seq, kind }` only — the matching text stays on `conductor_read`. Unit tests (`tests/search.spec.ts`, 9 tests) pin the match rule, the access predicate, that a token stream cannot produce a hit, that a search does not move a reader cursor, and that the body never appears on a hit. **Measured live** (`D:\dsh-conductor-verify\list-live-r66.log`): a unique needle was sent into a real session, then searched as the controller (`CONDUCTOR-LIST-SEARCH-OWNER PASS delivery="accepted" total=1 hits=[{"seq":7,"kind":"user"}] bodyLeaked=false filteredBy="session text contains \"SEARCH-NEEDLE-D5016271\""`), as a stranger (`CONDUCTOR-LIST-SEARCH-STRANGER PASS total=0 carriesMine=false listedUnreadable=false`), as an observer added through `conductor_access` (`CONDUCTOR-LIST-SEARCH-OBSERVER PASS observers=["session-search-auditor-d5016271"] hits=[{"seq":7,"kind":"user"}]`), and as a query that cannot exist (`CONDUCTOR-LIST-SEARCH-NONE PASS total=0 filteredBy="session text contains \"no-such-session-text-d5016271\""`). The previous filter measurements still hold on the same boot (`CONDUCTOR-LIST-EXPOSED` … `CONDUCTOR-LIST-NONE`, rows=218 of 218). |
| C170 | Artifact acceptance is reachable, so "检查通过/用户验收" can be recorded | live Host + unit tests | **pass — fixed in round 34** | **Was: missing.** `applyAcceptance` existed and was tested but was called by **no** production code, and no artifact tool accepted a verdict, so `acceptance` stayed `pending` forever. That single absence made the `artifact_accepted` trigger impossible to fire and refused every rule naming a required artifact, permanently. `conductor_artifact_accept` (31st tool) now records `pass`/`fail`/`inconclusive` by `user`/`deterministic_check`/`model_review`, with the controller gate, and reports what the acceptance triggered. Live, in one run: `CONDUCTOR-ACCEPT-REGISTERED PASS … acceptance=none`; `CONDUCTOR-ACCEPT-USER-COUNTS PASS acceptance=pass counts=true acceptedBy=user`; `CONDUCTOR-ACCEPT-NEEDS-CONTROL PASS result="NOT_CONTROLLER: session session-that-does-not-control-it does not hold write control of task …"`. |
| C171 | A patch handover applies the whole patch or refuses it | unit tests | **pass — fixed in round 38** | **Was: partial, and silently so.** `transfer.ts` took `parsed.files[0]`, so a multi-file diff applied its **first** file and reported `applied`/`verified` for "the patch" — a partial application reading as a complete one, while the module's own doc said "there is no partial application". PRD §二.9.2's rule is an either/or, so the fix takes the other arm honestly rather than inventing a path-mapping the filesystem port cannot express: a patch changing more than one file is **refused**, with a reason naming every file it touches, and nothing is written — not even the file the patch described correctly. `tests/transfer.spec.ts` pins it (`expect(fs.writes).toEqual([])`, the target content unchanged, and the refusal naming `target.txt, other.txt`). The record and evidence also now state the files a patch involves (`the patch involves 1 file(s): target.txt`), which is the other half of the same rule — "must state which files it involves". **Boundary:** handing over each file separately, or splitting the diff, is the caller's route to a multi-file change; the service does not guess how a diff path maps onto the receiver's layout. |
| C172 | Rules are evaluated automatically by their own executor | live Host + unit tests | **pass — fixed in round 59** | **Was: the executor had no trigger.** It was genuinely separate and correctly de-duplicated, but the only entry point was `conductor_rule evaluate`, so a saved one-time rule fired **only if somebody asked** — while `src/index.ts` claimed "the same executor an automatic watcher will use" and there was no such watcher. PRD §二.8.2 requires 规则由独立执行器执行，不依赖回报模型自行决定下一步. The background pass now evaluates every active rule's source task on its own, through the **same** `dispatchRulesFor` as the tool action and the acceptance path rather than a fourth implementation: the firing identity, the execution count, §四.2's attribution and §二.13.2's budget gate all live there, and a second dispatch path is a second place for them to be got wrong. Live, and the measurement is the point — **nothing in the probe calls `evaluate`**: `CONDUCTOR-RULE-WATCHER-SAVED PASS ruleId="rule-67d0d0e2-…" grant="grant-36207a3d-…"`; the source's turn is made to fail; then the probe waits and asks nothing, `CONDUCTOR-RULE-WATCHER-FIRED PASS waitedMs=10153 arrived=1 withoutAnyEvaluateCall=true relaySource={"kind":"plugin","plugin":"dsh-session-conductor","form":"relay"}` — the instruction arrived in the target's own log about ten seconds later, and it arrived attributed to the plugin's **relay** rather than to the user, which is what §四.2 requires of a forwarded instruction. A source whose session is not live is counted in the pass account rather than listed every pass, so a refusal that never changes cannot bury the ones that do. |
| C216 | An acceptance counts into the run ledger, and a retry of it does not | live Host + unit tests | **pass — round 61** | PRD §二.13.2: 所有由插件发起的节点、验收、回报和返工计入关联运行账本. Nodes, reports and reworks were counted; **acceptances were the one of the four the ledger had no way to record** — no event kind, no counter, no limit — so an action the conductor took on the user's behalf left no trace in the accounting of the run it belongs to. `LedgerEvent` gained `acceptance`, `RunLedger`/`ledgerRecord` gained `acceptances` (optional in the store, read as `0`, so no format-version bump), and `countAcceptance` writes it into **every** ledger governing the artifact's task through the same writer a dispatch uses — one writer, because two is how one of them ends up missing a counter. Live, with a task-scope policy so a ledger exists to read: `CONDUCTOR-LEDGER-ACCEPTANCE PASS before={"…","acceptances":0,…} after={"…","acceptances":1,…}` — and the other counters are untouched in the same reading (`dispatches: 0`, `reportTurns: 0`), because an acceptance is not a dispatch, a turn or a rework. The counter is a figure for a reader, not a ceiling: §二.13.2 names no acceptance limit and `budgetLimitsOf` therefore offers none. `tests/budget.spec.ts` pins the counting and that `emptyLedger()` starts at zero. |
| C217 | A repeated acceptance is a replay, not a second acceptance | live Host | **pass — fixed in round 61** | Found by this round's own control, and only because the control's *label* disagreed with its condition — the assertion required the count to reach 2 while the check was named "REPLAY-NOT-COUNTED". Investigating that mismatch rather than renaming the check exposed a real defect: **`artifact_accept` was not in `OPERATION_KINDS`**, so the acceptance path could not claim an operation even if a caller passed an id, and §四.1's replay rule had nothing to apply to. A repeated identical call therefore re-applied the verdict, **appended a second evidence line**, moved `acceptedAt`, and — once acceptances began counting — incremented the ledger again. A figure a budget decides on must not inflate from a retry. The path now claims `artifact_accept` with the decision's own parameters (artifact, result, who decided, and the check's command/output/evidence), replays report what was already recorded and count nothing, and a reused id with different parameters is refused as a conflict like every other family. Live, the same call twice: `CONDUCTOR-LEDGER-REPLAY-NOT-COUNTED PASS replayed=true acceptances=1 summary="Acceptance of probe-ledger-artifact-… was already recorded under operation probe-ledger-accept-… (pass by user at 2026-09-14T10:48:18.640Z). A retry is a replay, so nothing was recorded …"`. |
| C219 | The unresolved-operation account is readable on demand, not only in the mount log | live Host | **pass — round 63** | Round 62's calibration announces what it did at mount, but **a log line is not a question a caller can ask**: `ConductorStore.unresolvedOperationCount` existed and had no reader, so "was anything left mid-dispatch?" was answerable only by someone who happened to be watching the boot. The PRD designates `capabilities` as the surface for the environment's state and its reasons, so the snapshot now carries `durableState.unresolvedOperations` (always present when the store is open, so "nothing is unresolved" is distinguishable from "this build does not report it") plus `unresolvedNote` naming what is unresolved and stating that these are **not** resent. The count is read **at snapshot time** rather than captured with the store status, because operations get resolved as a session goes on and a number frozen at open would report a stale backlog for the rest of the process. Live, against **real** leftovers from earlier rounds rather than a planted record alone: `CONDUCTOR-RECOVERY-SURFACED PASS count=3 note="rule-…-seq-1 (rule, prepared), probe-ledger-accept-d3f8f2c7 (artifact_accept, prepared), pr…" rendered=true` — the rendered snapshot carries `Unresolved operations: 3`, and the three are the planted `send` from round 62 plus a rule execution and an acceptance claimed by earlier probes, each reported with its kind and delivery state. **Observation, recorded rather than judged:** one of those ids is `rule-…-turn-1-UNKNOWN: prompt variable "{{model}}" has no value for this assembly (section "deployment:persona")-seq-1`, because `conductor_rule save` accepts a caller-supplied `ruleId` and that id flows into every operation id the rule mints (`fireOperationId(ruleId, eventId)`). It was minted by an earlier round's probe, not by this build, and an opaque id is not a specification violation — but a rule id containing an error message makes a ledger row unreadable, and nothing today refuses one. |
| C218 | Restart calibration covers operations, not only schedules | live Host (three boots, fault-injected) + unit tests | **pass — fixed in round 62** | **Was: schedules were calibrated at boot and operations were not.** `recoveryAction` was implemented and tested, and `ConductorStore.listRecoverableOperations()` — the method that turns every stored operation into `continue | backfill_receipt | reconcile | done` — had **no caller outside its own test**. So an operation left in `dispatching` by a crash stayed in `dispatching` for ever: a stage that can never resolve, on the one surface a caller reads to find out what happened. PRD §四.5 requires a restart to 先校准历史、队列和操作, and §四.1 says what calibration means for an unconfirmable delivery: it enters `unknown` and is reconciled, **never resent**. The boot now calibrates operations beside schedules, and `calibrateOperation` makes exactly **one** state change on its own — `dispatching → unknown` — while everything else is **reported as it stands**: a `prepared` operation was claimed and never dispatched, so nothing is finished automatically (resuming a preparation creates a session or a worktree, which is the controller's decision via `conductor_operation resume`, not a boot's), and a retry stays the caller's, where reusing the operation id makes it a replay. The transition is checked against the same delivery table every other writer uses, so a move the model does not allow is refused here rather than written because this caller believed it was fine. **Measured by fault injection across three boots**, with the record planted through the **Host's own storage service** — a legal `operations` row written to the open domain, which is what simulates a process dying inside the crash window, since no probe can time that by hand. Boot 1: `CONDUCTOR-RECOVERY-PLANT PASS operationId="probe-recovery-dispatching" delivery="dispatching"`. Boot 2: `[dsh-session-conductor] operation recovery: 3 operation(s) were unresolved after restart (rule, artifact_accept, send): 1 moved dispatching → unknown and left for reconciliation, never resent; 2 reported as they stand.` and `CONDUCTOR-RECOVERY-CALIBRATED PASS stored="unknown" reported="unknown" found=true phase="calibrated_after_restart"` — read back both from the store and through `conductor_operation status`, because a calibration that moved one and not the other would leave the plugin contradicting itself. Boot 3 is the control: `0 moved dispatching → unknown …; 3 reported as they stand`, so a second restart is a no-op and the calibration cannot churn. Two details worth recording: the boot-1 line came from **real leftovers** — a `rule` and an `artifact_accept` claimed by earlier rounds' probes, both correctly *reported* and untouched — so the reporting half is exercised by genuine state and not only by the planted record; and the calibration is announced at mount, which is how all of this is observable at all. `tests/domain.spec.ts` pins the three outcomes and, as the property worth keeping, that exactly one of the seven delivery states produces a state change. |
| C215 | The control relation between rules must be acyclic | live Host + unit tests | **pass — round 59** | PRD §三.6 and AGENTS.md §6: 按事件去重、控制关系无环，防止跨控制者相互唤醒. Wiring the automatic watcher (C172) is what makes this reachable — before it, nothing ran the executor unasked, so a loop could not form — and the guard therefore had to land in the same round. One rule is one directed edge (an event on its **source** causes work on its **target**), and `controlCycleRefusal` walks forward from the candidate's target to see whether the path returns to its source. It is checked at **save**, because a loop is an authorisation problem and saving is the only moment the whole picture exists; a rule naming the same task as source and target is a one-node loop and is refused too. Live: `CONDUCTOR-RULE-WATCHER-CYCLE-REFUSED PASS refusal="CONTROL_CYCLE: rule rule-193dfd9b-… would close a control cycle: task-487a3b61-… → task-247f264e-… → task-487a3b61-…. Rules that instruct each other's sources wake each other for as long as they h…"` — the refusal names the chain a reader has to look at. `tests/rules.spec.ts` pins the fan and the diamond as **allowed**, the two-rule loop and the three-rule loop as refused, the one-node loop, and — because a store can already hold a loop saved before this check existed — that a stored loop cannot make the walk hang. **Boundary:** the default `maxExecutions` is 1, which is what keeps the ordinary case safe on its own; this guard is for the case where someone raises it, and it is the specification's stated rule rather than a property the tests discovered. |
| C173 | Each run fixes the definitions it started under | live Host + unit tests | **pass — budget policy compared in round 68** | **Was: the six recorded and three enforced; the budget policy was stored and never compared.** PRD §三.3 requires a run to fix the workflow version, the authorisation, the shared constraint versions, the input artifact versions, the acceptance configuration and the budget policy. All six are captured at `start`. Before every `drive`, `fixedDrift` now also compares the run's `fixed.budget` string — rendered by one helper, `budgetPolicyText`, so start and drive cannot disagree about what "the same policy" looks like — against the live definition. A later save that tightens `maxTurns` from 6 to 1 stops the run, records `needs_user`, and names both figures. Live: `CONDUCTOR-FIXED-BUDGET-STARTED PASS runId=run-169bb7db-…`; `CONDUCTOR-FIXED-BUDGET-STOPS PASS problems="the run's fixed terms changed: the budget policy moved from maxTurns=6 to maxTurns=1 after this run started, so the run would be gated by a limit it never fixed" thisRun=["needs_user"] actions=""`. Constraint drift still holds in the same boot (`CONDUCTOR-FIXED-STALE-RUN-STOPS PASS`). Task/group policy/ledger enforcement is the separate path (C191–C195) and is not this comparison. Acceptance remains C197. |
| C174 | A node starts only when all six conditions hold, including approvals | live Host + unit tests | **pass — corrected in round 59** | The sixth condition is real since round 33 (C185), and the fifth is closable since round 36: `turnsUsed` is incremented when `drive` dispatches a node, and the node's task is checked against every stored budget policy before it is dispatched. **The concurrency half is real too, and this row said otherwise.** It claimed "`maxConcurrent` is stored and read by nothing, so a node cannot be blocked for exceeding a concurrency limit" — that was true when it was written and stopped being true in round 43, when `budgetPermits` began computing the in-flight count through `inFlightFor` and handing it to `budgetDecision`; the workflow node path calls `budgetPermits(current, node.taskId, now, record.workflowId)`, so a node **is** blocked for exceeding a concurrency limit. Round 59 re-read the call sites rather than trusting the row: `maxConcurrent` is read at `budgetPermits`, at `budgetDecision` and in the report pass's budget facts. **One honest limit remains, and it is the design rather than a gap:** for a **workflow**-scope policy `inFlightFor` returns `undefined`, because nothing observes how many executions are in flight for a workflow — so `budgetDecision` refuses with "the limit cannot be checked. It is not treated as satisfied", which blocks the node and says why instead of pretending the limit holds. |
| C175 | Budget limits are enforced by the dispatch paths | live Host + unit tests | **pass — second action in round 73** | Every piece of PRD §二.13.2 that this deployment can honour is now wired and measured: the decision is consulted before every automatic dispatch (C191), each dispatch counts itself into every governing ledger (C192), the deadline is anchored on the first dispatch (C193), a metered figure can be recorded and a ceiling may only bind on a fully metered one (C194), the concurrency limit is checked against what the Host reports (C195), a strict budget is **not claimed as hard** without full metering, a single-request upper bound and a concurrency reservation (C200), and a reached limit **requests cancellation** of the current plugin-initiated turn and reports the actual stop state rather than waiting to confirm it (C226). |
| C176 | Constraint version pinning, impact marking, delivery and compatibility checks are performed | live Host | **pass** | All four gaps closed and measured. A run records the constraint version it started under and compares it before every dispatch (C196 — the compatibility check finally has a caller); `apply` on current work **writes** the re-acceptance marking instead of returning a list and changing nothing, and its scope comes from the workflow definitions the named nodes belong to rather than every accepted artifact in the store (C198); and a delivery is an actual dispatch — `sent` was a stage name nobody had earned while the branch sent nothing, and `in_context` could be asserted with no message in existence (C201). |
| C177 | The cross-Host manifest, path translation and target gating are wired | live Host + unit tests | **pass — the plan is constructed in round 68; the wire is still C138** | **Was: `MigrationManifest` had no construction site, and `translatePath` / `enableTargetAllowed` had no caller.** `planMigration` is that site: it names the task, the two Hosts, the history cut, the artifacts, runs every source path through `translatePath`, and applies `enableTargetAllowed` before anything could bind. `conductor_remote migrate` builds the plan when a `taskId` and `hostId` are given, then **still sends nothing**. With no transport the source stop is `unknown`, so the ordering gate refuses to enable the target — silence is not a stop. Live: `CONDUCTOR-REMOTE-MIGRATE-REFUSED PASS` (no task: transport reason only); `CONDUCTOR-REMOTE-MIGRATE-PLANNED PASS refusals=2` (task named: transport reason **and** "the source Host did not confirm that it stopped"; unmapped paths reported rather than guessed). Reconciliation scope remains the round-40 fix. **`check` is still unanswerable without a transport** — C138's refusal, not a fabrication path. |
| C178 | Export produces the selected attachment bundle | live Host | **pass — fixed in round 48** | **Was: partial.** Markdown and JSON exports were complete, but the bundle was only ever **named**: the document listed artifact ids and a note, no file was produced, and an id naming no artifact was passed through unvalidated — so an export could promise a bundle that did not exist and name attachments that did not either. `export` now takes a `bundleDirectory` and writes each named artifact as a real file (C202). |
| C179 | `conductor_export`'s declared `publish`/`status`/`revoke` actions exist | smoke | **pass — the declaration is gone in round 39** | **Was: missing, and misleading.** The export tool declared `publish`, `status` and `revoke` (with `shareId`, `lifetimeDays` and `confirmed`) while `exportOf` routed only `export`, `share` and `rules` — so `conductor_export publish` **silently performed an export**, and without a `taskId` it reported `BAD_REQUEST: exporting needs its taskId` instead of publishing. Declaring an action is not implementing it, so the declaration is removed: the tool now offers `['export', 'share', 'rules']`, its description says where sharing actually lives (`conductor_share`: preview / publish / status / revoke), and the orphaned parameters are gone. Both tools' action enums are now asserted by `scripts/smoke-host.mjs`, because an action a tool cannot perform must not appear in its schema — that assertion failed on the first run against the stale build, which is exactly the regression it exists to catch. |
| C180 | A detached target is a per-target error, and a wait can be ended by new user input | live Host + unit tests | **pass — the wait half is fixed in round 56; the release half in round 49** | **Audit finding, now closed.** Two halves, both were missing. (1) *Release*: `observer.resolve()` never read the access record, so a released task was served as an ordinary read; fixed in round 49 and pinned by `tests/observer.release.spec.ts` (C203). (2) *New user input ends a wait* — PRD §二.7's 用户新输入可结束等待 — had no implementation at all: the loop ran to its deadline and nothing else could stop it, so a person taking the wheel was reported to the model as a quiet system. A wait now has **four endings**, all reported as `ending` rather than folded into `timedOut`: `woke`, `timed_out`, `user_spoke` and `cancelled`. The user half is read from the Host's own `source` on each message — a person is `{kind:'user'}`, while a conductor `notice`, a forwarded `relay` and the Host's injected context are not — so a report arriving mid-wait cannot be mistaken for the user, and the marker is a **position** taken before the wait starts, so input that arrived earlier can never end a wait that began after it. The cancelled half uses the Host's own `AbortSignal`, which `ToolExecutionInput` declares as a **required** member of the execution context `execute` receives. **Measured live, both halves, against a real Host session:** `CONDUCTOR-WAIT-USER-SPOKE PASS append="said through steer" ending="user_spoke" timedOut=false elapsedMs=272` — the person's message was delivered exactly the way the Host's own `session.prompt` delivers one (`createUserMessage({ content, source: { kind: 'user' } })` handed to the agent; a raw `session.append` was tried first and the Host **refused** it with "user/message is surface-eligible and requires" the surface intent, which is the Host saying that event is not a plugin's to author directly) — and it ended a 20-second wait in 272 ms; `CONDUCTOR-WAIT-CANCELLED PASS ending="cancelled" timedOut=false elapsedAfterAbortMs=94`; and the control `CONDUCTOR-WAIT-QUIET-CONTROL PASS ending="timed_out" elapsedMs=1`, so an uninterrupted wait is still a timeout rather than one of the new endings. `tests/observer.spec.ts` pins all three, plus the rule that a wake arriving in the same instant as an interruption is still reported as `woke` — the interruption decides whether to keep *waiting*, not whether to discard a fact already observed. |
| C181 | Every notice kind §二.8.1 names has a producer, and notices merge across targets | live Host + unit tests | **pass — round 52 for the merge and the stored facts; round 53 adds the remaining kinds** | **Was: three separate gaps in the audit.** (1) `mergeReports` was only ever called with **one** watch's facts — the loop built a one-entry map *inside* the per-watch iteration, so the cross-target 2-second merge the module documents was unreachable: a controller watching three tasks was woken three times inside the window it should have been woken once for. The pass now gathers facts per watch, merges **once** across all of them, delivers once, and splits the recording back per watch because the cursor and the delivered-id list belong to one watch. Live, on the **unattended** path (the plugin's own pass, not a tool call): `CONDUCTOR-WATCH-MERGED PASS waitedMs=5125 … text="Observed on 2 tasks (315 ms of activity):\n- [turn_ended] task-736981b6-…\n- [turn_ended] task-d238d1a7-…"` — **one** notice naming **two** tasks. (2) `externalFact` had exactly one call site (`target_unavailable`), so the declared `artifact_changed`/`artifact_missing`/`handoff_conflict` kinds were produced nowhere. They are now read from records the store already holds — an artifact whose existence dimension is `missing` or `changed`, and a transfer that recorded conflicts — with the identity derived from the record so a re-read recognises the same fact and a *new* problem is not mistaken for the old one. `claimed` and `present` are deliberately silent: a claim is not a fact. Live: `CONDUCTOR-WATCH-ARTIFACT-MISSING PASS existence="missing" delivered=["task-0c665fe9-…: woke the controller with 1 fact(s) [artifact_missing] over 1 task(s)]"`, with the existence check itself run against a path that does not exist, and the control `CONDUCTOR-WATCH-ARTIFACT-NOREPEAT PASS firstRefusals=["… the controller session is not live …"] secondDelivered=[] secondRefusals=[]`. (3) **Round 53** added the three kinds that did not exist at all. `budget_limited` is the budget **gate's own** decision (`budgetDecision`, handed in rather than recomputed, so a notice cannot disagree with the gate that stops dispatches) — live, with the quiet control in the same run: `CONDUCTOR-WATCH-BUDGET-LIMIT PASS quietNotices=0 limitedNotices=1 waitedMs=12171 text="… [budget_limited] … task budget task-d9c3f688-… no longer permits automatic work: the run has dispatched 0 time(s), its maximum…"`. `workflow_blocked` is a run the store records as `needs_user`, reached the way the product reaches it (a node judged `inconclusive`) — live: `CONDUCTOR-WATCH-WORKFLOW-BLOCKED PASS stoppedForUser=true runId=run-af81bd26-… blockedNotices=1 text="… [workflow_blocked] … workflow run run-af81bd26-… of probe-watch-blocked-… stopped for the user (needs_user)"`. `user_question` is §二.8.1's 用户问题, and the signal for it was **established by reading the installed Host rather than assumed**: `SessionEventMap` has no question event and `TurnEndReasonMap` is `completed | aborted | blocked | error | max-tokens | interrupted`, so the log's evidence of a question is the **call to the tool that asks one** (`ask_user_question`), which `applyEvent` now projects as a notable event and `isWake` treats as ending a wait. `tests/observer.spec.ts` pins the fold, the non-matching call and the wake; `tests/report.spec.ts` pins the fact. **Boundaries, stated rather than implied:** the `user_question` fold is unit-measured and its *delivery* is covered by the shared notice path measured live for the other kinds — no live session in this environment can call `ask_user_question` (the verify Host has no model credentials); `handoff_conflict` is now live-measured too, in round 58 — see below. |
| C214 | A handoff conflict reaches the receiving task's controller, end to end | live Host | **pass — round 58** | The producer was added in round 52 and pinned by unit test, but a unit test cannot show that **the path a real conflict travels** arrives at a controller. Driven live, in the order a real conflict happens: a file artifact is registered on the source task and **verified**, so the record holds a real hash of the file as it was; the file is then changed underneath it, which is exactly the situation PRD §二.9.2 refuses to overwrite; the patch handover is asked for; and the receiving task's controller is notified on the plugin's own pass. `CONDUCTOR-CONFLICT-REFUSED PASS expected="4f578dc94707" applied=false provided=false verified=false conflicts=["the target does not match the patch baseline (expected 4f578dc94707…, found 822944e0332d…); the receiver has different content and nothing was written"]` — a conflict is never a success: the refusal reports `provided: false` and `verified: false` as well as `applied: false`. `CONDUCTOR-CONFLICT-REPORTED PASS waitedMs=25488 found=1 text="… [handoff_conflict] task-8fdda3a2-…: handoff probe-conflict-transfer-… of probe-conflict-artifact-… from task-6c7011a8-… to task-8fdda3a2-…"` — one notice, on the receiving task, naming the transfer and **both** ends of the handoff. The notice is read from the controller's **own log** and no `report` call is made, so this measures the unattended path (the same discipline round 53 established). |
| C213 | A wait reports **four** endings, and the Host's abort signal is honoured | live Host + unit tests | **pass — round 56** | §二.7 lists a wait's endings as a wake, a deadline, and the user's new input; the tool reported only `timedOut: true|false`, so "the user took the wheel" and "nothing happened for 60 seconds" were the **same answer** — and the second is what a reader would conclude. The result now carries `ending: 'woke' | 'timed_out' | 'user_spoke' | 'cancelled'`, and the model-facing text says which one happened rather than leading every non-wake with "Nothing to report". The Host's `AbortSignal` comes from `ToolExecutionInput`, whose declaration was read rather than assumed: `signal: AbortSignal` is a **required** member of the execution context `execute` receives, so a polling tool can be ended when the Host stops wanting it. `ToolCaller` carries it as **optional** on purpose — a hand-made context (this project's own probes and tests) must mean "nobody can cancel me", not a crash. Timing is what makes this check meaningful, so both interruptions are asserted to end the wait **early**: 272 ms and 94 ms against a 20-second deadline, with `elapsedMs=1` for the quiet control. See C180 for the user-input half and its evidence. |
| C212 | §二.3's "最近实际使用" is read from the Host's own request header, on every surface that shows it | live Host + unit tests | **pass — round 55** | The card, the detail and the model tool all report the configuration the task's last assembled request used, from the **Host's own** record rather than from anything the conductor believes it set. The field was chosen by reading the installed Host: its own model selection resolves as "a selection made in this process, else the session's own latest logged `request/header`, else the live Agent default", and it reads that middle tier as `agent.session.requestHeader()?.config` — an `EpochHeader` whose `config` is an `LlmCallConfig` (`{ provider, model, reasoningEffort? }`). `selectionFromHeader` reads the same field, so the conductor's answer cannot disagree with the Host's. One helper feeds all three surfaces, because a card that disagreed with the tool would be worse than a card that said nothing. **Measured live, and the measurement is the interesting part:** the verify Host cannot assemble a request (no model credentials), so a session here *never* logs a header on its own — which would leave the reading path untested and the honest "(none recorded)" indistinguishable from a broken reader. The probe therefore writes the Host's **own** `request/header` event through the Host's **own** session API and measures the read-back: `CONDUCTOR-PANEL-MODEL-LASTUSED PASS written=true append="written" card="probe-provider/probe-model at high reasoning" forNextRequest=undefined state="Next request will use: (none recorded)\nMost recently actually used: probe-provider/probe-model at high reasoning\nNo change is pending: …"`, with the same value on the detail route (`… modelLastUsed="probe-provider/probe-model at high reasoning" …`). The card is re-read **after** the append, so the field is proven to come from the log rather than from the earlier payload. **Boundary:** the fact is the Host's and the reader is the plugin's, but the *header* here was written by the harness rather than by a real model request, and that is stated rather than glossed — what it proves is that the plugin reads the Host's field correctly, not that a real request populates it identically. `tests/panel.spec.ts` pins the reading, including every shape that must yield **no** selection rather than a fabricated one (absent header, missing config, non-string provider or model, empty strings, blank effort). |
| C210 | A notice on a retained store takes ~12 s, not the 5 s the interval suggests | live Host | **pass — measured, round 53** | Recorded because the number is not the one the design implies and because it changed how the harness measures. The pass interval is 5000 ms and `BackgroundPass` re-arms **after** a pass finishes (it counts skips rather than overlapping, which is the right design), so on the retained verification store — 95+ tasks, ~100 watches, a single JSON file rewritten per write — a pass takes several seconds and the effective notice latency is the pass duration plus the interval. Measured by polling rather than guessing: `waitedMs=12171` for the budget notice and `12141` for the workflow one, against `5125` for the merged report. **This is not a claim about a small store**, where the same pass has far less to fold, and it is not a latency the specification states; it is what this store measures. The harness consequence is the real content of this row: the probe's fixed sleeps (7 s, supposedly "one interval") landed **inside** a pass and read an empty log, which is indistinguishable from a producer that does not work. It now polls for the notice and reports how long it waited. |
| C209 | A claim whose digest no longer matches says which kind of mismatch it is | unit tests | **pass — round 52** | Found by measuring, not by reading: the create probe's fixed operation id began failing with `OPERATION_CONFLICT: operationId verify-call-1 was used with different parameters` against a record written earlier the same day. The cause is exact, and was computed rather than guessed: the stored digest `3b3ded4c…` is `paramDigest('create', …)` **without** the `workspace` member, and the current code produces `0e085ab0…` **with** it (`workspace` joined the digest in the Git-starting-state round, so an operation claimed before that revision conflicts with an identical request). The store's behaviour is right — §四.1 refuses a reused id whose digest differs, and the conductor genuinely cannot tell "different request" from "same request, different digest scheme" — but the **refusal text was false** for the second case, asserting different parameters when there were none. It now says which of the two it can rule out: a record that kept no parameters reports that it kept none and that a revision changing the digest covers looks the same from here, while a record that *did* keep them keeps the plain statement. `classifyOperation` receives the stored parameters through the pure operation shape, which was discarding the only evidence that separates the cases. `tests/domain.spec.ts` asserts both texts. The probe's idempotency operations are now **boot-scoped** (`verify-call-1-<boot>`), because a fixed id in a retained verification store measures the store's archaeology rather than the plugin; the replay assertions are unaffected, since they reuse the id within the boot. |
| C182 | A rule execution carries `grantId`, `ruleId` and `sourceEventId` | live Host + unit tests | **pass — fixed in round 35** | **Was: missing.** PRD §四.2 requires a rule execution to be associated with all three; the message was built with the plain `relaySource()` and carried none of them, `MessageSourceRecord` (which has exactly those fields) was declared and never used, and `grantId` existed nowhere. Now: a **save mints a grant** (`grant-<uuid>`, so a re-save is a new authorisation rather than the same one extended), the dispatch hands the attribution to the ordinary send path, and the operation it claims stores it. Live, end to end through the real tools: `CONDUCTOR-ACCEPT-ATTRIBUTION PASS by=rule grantId=grant-97d1f893-… ruleId=rule-034a4108-… sourceEventId=artifact-artifact-probe-accept-register-084fab2e-0-2026-09-14T06:36:34.829Z` — read back with `conductor_operation status`, so the association is **readable**, which is what "关联" requires. Each firing also records the grant it ran under (`tests/rules.spec.ts` pins that it copies the grant rather than reading the rule's current one, so a later re-save cannot reattribute a past dispatch), and a rule with no grant identity records none rather than inventing one. **Not covered:** the Host's user-message source still carries only the plugin `relay` form, so the attribution is durable in the conductor's own record rather than in the session log — recorded here as a boundary rather than a claim. |
| C187 | A `model_review` artifact acceptance is recorded but does **not** count as acceptance | live Host + unit tests | **pass** | PRD §二.9.1 keeps "检查通过" and "用户验收" apart from the model's own claim, and §二.12 forbids a subjective review from standing in for acceptance — an automatic dispatch is exactly what that protects. Live: `CONDUCTOR-ACCEPT-MODEL-REVIEW-NOT-ACCEPTANCE PASS acceptance=pass counts=false reason=it was reviewed by the model, which is a judgement and not acceptance`. The acceptance's *who* is durable (`acceptedBy`/`acceptedAt` on the record), and `acceptanceCounts` is the single place that answers whether it may gate automatic work: `user` and `deterministic_check` count, `model_review` does not, and an **unattributed** acceptance does not either — an acceptance that says nothing about who decided is the claim the rule refuses. `tests/rules.spec.ts` pins all four answers. |
| C188 | The `artifact_accepted` trigger fires, and a rule requiring an accepted artifact works | live Host + unit tests | **pass** | PRD §二.8.2 lists the trigger; it was declared in the schema and **produced nowhere**, and `requiredArtifactId` rules were refused forever because no acceptance could exist. In one live run: the rule refuses while the only acceptance is the model's — `CONDUCTOR-ACCEPT-RULE-REFUSED PASS triggered=["rule-…: rule … requires artifact artifact-pro…"]` — and then fires on the user's acceptance: `CONDUCTOR-ACCEPT-RULE-FIRED PASS triggered=["rule-5d65f20b…→rule-rule-5d65f20b…-artifact-artifact-probe-accept-register-7ae3be51-0-2026-09-14T06:26:50.333Z"]`. The dispatch goes through the **same** executor the periodic evaluation uses (`dispatchRulesFor`, extracted for exactly that reason), so the deduplication and execution-count rules cannot differ between the two paths; the acceptance's event identity carries the artifact's content version and the instant, so a later acceptance of a changed artifact is a new fact while a replay keeps its identity. `tests/rules.spec.ts` pins the trigger mapping and the gate. |
| C189 | Recording an acceptance requires control of the artifact's task | live Host | **pass** | Accepting someone else's work is a decision about it, so it goes through the same `requireController` gate as every other mutating surface (PRD §一.3): `CONDUCTOR-ACCEPT-NEEDS-CONTROL PASS result="NOT_CONTROLLER: session session-that-does-not-control-it does not hold write control of task task-96267c16-…"`. A deterministic check must also record the command it ran and what it returned — `CONDUCTOR-ACCEPT-CHECK-NEEDS-EVIDENCE PASS` — reusing the workflow module's `verdictRefusal`, because it is the same sentence of the specification and must not be enforced differently in two places. |
| C183 | A model review that says `pass` does **not** stand in for acceptance, so it cannot open a downstream node | live Host + unit tests | **pass** | PRD §二.12's last rule about verdicts. Live, through a real run: `CONDUCTOR-APPROVAL-MODEL-REVIEW-NOT-ACCEPTANCE PASS reasons="0 node(s) advanced … downstream: upstream_accepted — these upstream nodes have not passed acceptance: upstream (reviewed by the model, which is a judgement and not acceptance); approvals — the node requires an approval that has not been given" actions=""`. The fix was a vocabulary one, not a flag: a `pass` now yields the node state **`reviewed`** when a model gave it and `accepted` only when the user or a deterministic check did, and the gate asks `isAcceptance` rather than reading the state name. Before this, `recordVerdict` mapped every `pass` to `accepted`, so a subjective review satisfied the gate — the masquerade the specification forbids — while `isUserAcceptance` sat unused. `tests/workflow.spec.ts` pins the state, the gate, the reason, and the distinction between "counts as acceptance" and "the user accepted it". |
| C184 | A deterministic check must record the command it ran and what it returned | live Host + unit tests | **pass** | The other half of the same sentence: "确定性检查记录真实命令、结果和证据". Live: `CONDUCTOR-APPROVAL-CHECK-NEEDS-EVIDENCE PASS result="BAD_REQUEST: a deterministic check must record the command it actually ran (PRD §二.12). Without one it is an opinion wearing a check's label, so it is refused rather than recorded as evidence."` A verdict naming no command, or a command with no result, is refused at the boundary; `verdictRefusal` is the single place that decides, and `tests/workflow.spec.ts` covers all four cases. |
| C185 | A node that declares `requiresApproval` starts only after an approval is recorded | live Host + unit tests | **pass** | PRD §二.12 condition 6 ("必需审批已满足"). The condition was previously handed a hardcoded `approved: true`, so it could never fail and a gated node started immediately. Live, in order: `CONDUCTOR-APPROVAL-GATED PASS problems="… approvals — the node requires an approval that has not been given"`; after the user accepts the upstream node, `CONDUCTOR-APPROVAL-UNMET-UNTIL-RECORDED PASS reasons="… downstream: approvals — the node requires an approval that has not been given"`; then `CONDUCTOR-APPROVAL-RECORDED PASS`, `CONDUCTOR-APPROVAL-STARTS PASS actions="downstream: dispatched as workflow-run-…-downstream-1"`. A second approval is refused — `CONDUCTOR-APPROVAL-ONCE PASS result="BAD_REQUEST: node downstream was already approved by session-probe-controller at 2026-09-14T06:05:48.284Z, so a second approval would rewrite who decided"` — and an approval for an ungated or already-running node is refused too (`approveNode` carries all four refusals, unit-tested). The recorded `approvedBy`/`approvedAt` are stored on the run node. |
| C186 | A workflow definition keeps the failure handling and budget it was saved with | live Host + unit tests | **pass** | PRD §二.12 lists 失败处理 and 预算 as two of the seven things a definition contains. Both were silently **dropped on save** — `node.failure` never reached the record and `definition.budget` had no tool parameter — so condition 5 ("并发及预算允许") consulted a value that was always `undefined` and could never close, while `node.failure` had no writer at all. Both are now accepted by the tool, validated (`onFail` is required whenever `failure` is declared, checked in `execute` because the DSL cannot express a nested `required`), carried through the pure definition, and persisted — the live probe saves a definition carrying both (`CONDUCTOR-APPROVAL-SAVED PASS`). **Withdrawn in round 70:** the claim that `turnsUsed` is written by nothing. `drive` increments it when a node is dispatched, and `maxConcurrent` is observed from in-flight work, so both halves of condition 5 can close the gate (C174). |
| C220 | A session archived **outside** the conductor is shown as archived | live Host + unit tests | **pass — round 64** | PRD §二.5's last bullet: 查看失联、不可恢复及外部归档的会话 (T15 with T01's selection metadata). The set is the Host's own registry-global one — `ctx.workspaceRegistry.archivedSessionIds`, served by its `workspace.list` as a full snapshot and changed-frame — and the sentence beside the requirement (归档…不调用当前只有单向归档能力的宿主接口) means this is a **read and only a read**: the plugin never archives, never unarchives, never writes the set, and the probe therefore drives the set through the Host's own `archiveSession` rather than through the plugin, which is the only way "outside" can mean anything. Three Host facts were read out of the installed build rather than assumed, and each one changed the code: it is a **getter** (`get archivedSessionIds() { return this.requireState().archivedSessionIds }`) returning ids **in archive order**; every mutation installs a **new array**, so it must be read per call; and the getter **throws** (`workspace registry is not started yet`) while the registry is mounted but not yet started. Measured live: `CONDUCTOR-ARCHIVE-BASELINE total=7 hostSet=0`; then `ctx.workspaceRegistry.archiveSession(session-ac4bbb36-…)`; then `CONDUCTOR-ARCHIVE-VIEW PASS session=session-ac4bbb36-… hostKnows=true flag=true hostSet=1 stillListed=true`, with the control `CONDUCTOR-ARCHIVE-CONTROL PASS session=session-2b51bc48-… flag=false` — a set that *was* read reports `false` for a session it does not contain, so an implementation that only marked archived rows would pass the first assertion and fail the control. `stillListed=true` is a Host fact worth recording: archiving does not remove a session from the Host's list, which is what makes it showable at all. **Observed rather than assumed about the interface:** no DSH package exposes an unarchive — a case-insensitive scan of all 10 018 JavaScript files in the installed `app.asar` finds the word only in a vendored Mistral SDK and a syntax highlighter — which matches §二.5's own 只有单向归档能力 and is why this probe's archiving is a **permanent** change, confined to the isolated verification store. |
| C221 | "Cannot tell" is never rendered as "not archived" — the list says which of three cases it is in | live Host + unit tests | **pass — round 64** | Three different answers were about to look identical. A per-row boolean alone cannot distinguish *the set was read and this session is not in it* from *this Host publishes no set* from *the set exists but could not be read right now* — and the third is not hypothetical: the Host's getter throws while the registry is starting, which is exactly the boot window this plugin resolves services at call time to survive. So `ArchiveSetRead` is `published | absent | unreadable`, the row carries `externallyArchived` **only** in the first case (documented, and asserted by test, as absent-means-not-known rather than false), and `conductor_discover` gained an `archive` sentence stating which case the whole list is in — because the rows can only ever show part of it. Live: `CONDUCTOR-ARCHIVE-SUMMARY PASS` with the summary ending "…The Host's archive set was read (1 archived session(s) in the Host's registry); 1 of the sessions below are archived outside the conductor." and `CONDUCTOR-ARCHIVE-STATED PASS`. `tests/discovery.spec.ts` pins all three cases plus the property that matters for cost and consistency — the set is read **once per call**, not once per candidate, so one list cannot answer differently inside itself; `tests/adapters.spec.ts` pins the adapter's four outcomes (read, absent field, throwing getter, non-array answer) and that no registry means no reader at all. |
| C222 | The candidate shape the tool declares is the shape it returns | live Host | **pass — round 64** | The recurring defect of this codebase, caught by reading the mapping rather than the schema: `CandidateSession` carried `parentSessionId` (the session a candidate was forked from) and `origin` (the Host's own subagent classification), and `conductor_discover`'s output schema declared neither, so **two selection facts the service computes were dropped at the tool boundary** — the same class as the `conductor_model` field and the `transfer` recipient before it. Both are now declared and forwarded, since §二.5 asks a caller to choose a session from metadata and "what this session came from" is metadata. The same edit removed a smaller lie next door: when the Host mounts no `ctx.sessionQuery`, discovery returned an **empty list**, which the tool rendered as "No unmanaged sessions matched." — a capability gap reported as a search result. `CandidateList.unavailable` now carries the reason and the tool reports it verbatim instead of a count of zero, so "this Host cannot list sessions" and "nothing matched" are different sentences. Live: the boot log for the same run shows the registry and all 31 tools present with `workspaceRegistry=present`, and the discover calls above return rows of the declared shape. |
| C223 | The panel reports the Host's archive, and states in words which of the two archives it cannot report | live Host (two data routes) + unit-tested pure helpers | **pass — round 64** | §二.5's 归档作用于插件任务集合…**界面明确显示其作用范围** is a requirement about the interface, and the interface is the panel — so the same read that powers `conductor_discover` now feeds both panel routes, once per request through the same adapter (a cached copy would report the set as it was when the page loaded). Two archives exist: the conductor's own (`archived` on the task record, written and filtered through the conductor tools, conductor-side only) and the Host's registry-global one (the user's, one-way, never written here). A card therefore carries `sessionArchivedExternally` beside `sessionId` and the detail carries it too, and both payloads **say which archive they can and cannot report** rather than leaving a bare boolean to be interpreted. The first version of that sentence was wrong — it described "the panel's own archive flag", a field this route does not carry — and it was corrected before the wording was quoted here, which is why the evidence below is from the run **after** the fix. **Measured live, on a session the conductor manages** — the case that matters, since an unmanaged candidate never appears in the panel at all: a task is created, its session is archived through the Host's own interface, and the card is fetched over HTTP — `CONDUCTOR-ARCHIVE-PANEL PASS taskId=task-c8c1cf30-… session=session-834a5b16-… status=200 flag=true othersFalse=true note="This route reports one of the two archives and not the other. sessionArchivedExternally is the Host's own registry-global archive of the task's session — read from the Host (9 session(s) archived there). The conductor's own archive of a task is a plugin record this route does not report: …"` (the control row, a task whose session is not archived, reads `false`) — with the detail route agreeing: `CONDUCTOR-ARCHIVE-DETAIL PASS status=200 flag=true refusal="Two archives exist and this route reports one. sessionArchivedExternally is the Host's registry-global session archive — the user's, read-only here and one-way in this build — read from the Host (9 session(s) archived there). …"`. **Boundary:** the panel is a view and this is a read; archiving and restoring a task still change only the conductor's records, so the panel's own archive flag cannot restore a session the user archived in the Harness sidebar — which is what the corrected sentence tells the reader. The browser rendering of the new row is **not** measured (this environment has no browser); `node scripts/smoke-client.mjs` builds and loads the bundle (30 782 bytes), and the payload half is measured above. |
| C10 | Remote (cross-Host) runtime | — | **not measured — environment** | This machine has one Host and no Host Router / Companion Bridge. The decision rules are implemented and live-measured (C130–C140, C177); a second Host to move work onto is not present, so the runtime itself is not measured. |
| C11 | The panel (client half) loads in a browser | — | **not measured — environment** | The bundle is built, served and loadable (C119–C122). This verification setup has no browser that mounts the shell, so rendering is not measured. See C93. |
| C18 | A model-initiated tool call reaches these tools | — | not yet measured — the probe invokes the tool definitions directly with the caller identity the Host would supply | — |

## 5. Test inventory

`npx vitest run` covers the parts that do not need a Host:

- **`tests/state.spec.ts`** — the state model of PRD §三.4, including the
  delivery pipeline's one-way edges, the `unknown` reconciliation state, and the
  execution overlay that produces `interrupting` and `reconciling`.
- **`tests/domain.spec.ts`** — operation identity and idempotency of PRD §四.1,
  recovery classification, the restart calibration of PRD §四.5 (that exactly one of the
  seven delivery states produces a state change, and that a claimed-but-undispatched
  request is reported rather than finished), the default table of PRD §四.7, the managed-target count (released
  management does not occupy a slot), and the
  truncation marker of PRD §二.7.
- **`tests/tools-budget.spec.ts`** — PRD §四.7's 工具单次文本输出上限: every
  registered tool's model-facing text is cut at the configured character budget
  with a marker that names the same tool, last-mile `finalizeContent` is included,
  a result with no text is not invented as truncated, and the shipped default is
  12,000 (C261).
- **`tests/artifact-facts.spec.ts`** — PRD §二.9.1's four display facts: a claim is
  not verified presence, a check pass is not user acceptance, a model review is
  named as not acceptance, and an unattributed `pass` is counted as neither
  (C262).
- **`tests/schema.spec.ts`** — the domain declaration the Host validates at open
  time, and the record schemas it validates every stored record against. A
  mistake here surfaces as a rejected medium, so it is checked before a Host
  ever sees it.
- **`tests/store.spec.ts`** — task and binding persistence, the session chain a
  handoff retains, schedule persistence (a firing and the advance of `nextAt`
  written in **one** update, so no window exists in which the schedule moved on
  with no evidence it fired), operation idempotency against the store, recovery
  ordering, and fault injection: a write that is made to fail must leave the
  readable state exactly as it was.
- **`tests/coordinator.spec.ts`** — the create and send state machines against
  fake agents and a real store: the preparation phases, the fact that a
  dispatched message is recorded as *accepted* and never as finished, the
  replay/conflict rules, the managed-target ceiling (a retry is not a second
  target; releasing management frees a slot), Host-wide plugin-turn concurrency
  (a send at the limit stays `prepared` rather than refused; flush dispatches a
  person's pending send before an automatic one; a native-interface turn occupies
  no plugin slot), and every refusal — not ready, not the controller,
  stale epoch, stale binding, unavailable target, and the interrupt modes this
  build declines to approximate. `requestTurnCancel` issues `cancel()` with `keepInbox` and
  does not wait for a turn end; an idle session is reported as `no_active_turn`.
- **`tests/concurrency.spec.ts`** — PRD §四.4 occupancy: native UI occupies no
  slot, a conductor relay occupies a target slot (including while waiting for a
  person or an approval), notices have their own quota, admission keeps work
  pending rather than refusing it, and pending order is explicit-then-automatic
  FIFO.
- **`tests/inspect.spec.ts`** — PRD §二.11's third inspect half: defined
  conditions are the saved shared constraints, reported at the delivery stage
  this target has reached (`unset` when the current version was never sent), so
  a stage change is a new observation and an unchanged inspection stays silent.
- **`tests/observer.spec.ts`** — the projection and the reader rules: the turn
  outcome mapping (including a `max-tokens` stop reported as `blocked`, never as
  `completed`), fold idempotence, per-reader cursors, the fact that only a
  history read consumes while a snapshot read does not, truncation that keeps the
  remainder for the next read, zero-timeout snapshots, single-target errors, and
  the rule that an event already returned is not returned again. User-role
  history keeps the Host's own source so native-interface input, a controller
  relay and a background notice stay distinguishable (T11).
- **`tests/discovery.spec.ts`** — candidate discovery and organisation: that a
  candidate carries selection metadata and nothing from a log, that managed
  sessions are hidden unless asked for, the directory/liveness/text filters, the
  title budget, joining a session without dispatching anything, refusing to
  manage one session twice, refusing to attach another when the controller is
  already at the managed-target ceiling, conductor-side rename/group/pin/archive, and that
  releasing management blocks new sends while leaving accepted work readable. It
  also pins the archive read of C220/C221: a session the Host archived outside
  the conductor is flagged and one it did not is `false`, an unreadable set
  leaves the field **off** rather than `false`, an absent set is reported as
  absent rather than as empty, and the set is read once per call.
- **`tests/taskfilter.spec.ts`** — the task-list filters of PRD §二.5: that an
  absent filter constrains nothing, that `name` and `project` match
  case-insensitively as substrings while the rest match exactly, that a row which
  cannot answer a filter (no binding, so no Host and no badge) does not match it,
  that the caller's newest-first order survives filtering, and that the active
  filters are named so a narrowed total cannot be read as the whole list.
- **`tests/search.spec.ts`** — the other half of §二.5: full-text search of
  sessions the caller may read. Hits are `{ seq, kind }` only (the body is never
  on the hit), matching is a case-insensitive substring of the same readable
  history `conductor_read` projects, a token stream cannot produce a hit, an
  empty query matches nothing rather than everything, the controller and an
  observer match while a stranger is omitted from both matches and unreadable, a
  released task is named as unreadable to a caller who may still read and omitted
  for a stranger, a search does not move a reader cursor, and the search is
  restricted to the task ids it was given, in that order.
- **`tests/brief.spec.ts`** — the handoff brief: that the first human statement
  becomes the goal, that a model statement is recorded as a suggestion and never
  as a decision, that a prohibition lands under constraints and an acceptance
  rule under acceptance, that failed tools and unfinished turns become unverified
  open items, that nothing past the cutoff is read, that sections are bounded and
  report what they dropped, that no goal is claimed when no human spoke, and that
  the digest changes when the content does.
- **`tests/fork.spec.ts`** — the fork cut and the fork flow: that only a
  completed-turn prefix is copied, that anchoring, past-the-end and
  inside-an-unfinished-turn requests behave as specified, that the resulting seed
  is a balanced set of turns the Host's validator will accept, that a fork gets
  its own control record, that the source and cutoff are recorded, and that a
  failed fork leaves the source untouched.
- **`tests/artifacts.spec.ts`** — the artifact state machine: that registration
  is a claim rather than a fact, that a missing file is reported missing with no
  invented hash, that a rewritten file is reported changed while the recorded
  digest keeps describing what was verified last, that a prefix digest is
  recorded as a prefix, and that the fixed-input rule refuses a claim, a missing
  file, a changed file, a hashless record and a partial digest while accepting a
  present, fully-hashed one. Kind-specific checks: a link or service entry is
  the recorded URL (reachability is not probed; a path of the same name is not
  the artifact), a commit is the recorded git object (another SHA is not this
  commit; a missing resolver does not invent presence), and a patch or test
  report is hashed at the recorded path.
- **`tests/patch.spec.ts`** — the unified-diff parser and applier: path and range
  parsing, line classification, the `@@ -n +n @@` shorthand, prose before the
  first file, unreadable headers reported rather than skipped, application at the
  named position, the running offset across several hunks, trailing-newline
  preservation, pure additions, and the two refusals that matter — a hunk that
  does not match the target, and a hunk pointing past the end of the file — with
  the original left untouched.
- **`tests/transfer.spec.ts`** — the three handoff modes: that a reference
  carries version and fixed-input facts and copies nothing, that a snapshot copy
  refuses an unverified or changed source and refuses one that changed between
  verification and the copy, that a copy which does not read back identically is
  reported unverified rather than verified, and that a patch checks on an
  isolated copy, applies and confirms, stops on a baseline mismatch without
  writing, stops on a hunk conflict, refuses an unparseable diff, and names what
  it touches.
- **`tests/rules.spec.ts`** — the one-time rule executor: the stable operation id
  a dispatch is keyed on, the trigger vocabulary, deduplication checked **before**
  the execution ceiling, the ceiling itself, expiry, and the artifact-acceptance
  requirement, enabling a disabled rule under the same grant, and refusing an
  enable that would close a control cycle.
- **`tests/schedule.spec.ts`** — the schedule rules of PRD §二.11: wall-clock
  resolution in a named zone, a local time that does not exist across a
  daylight-saving jump being **rejected**, one that occurs twice resolving to the
  **earlier** instance with a note (including the case where the two-pass
  resolution happens to land on the earlier one already — landing there by
  coincidence must still be *recognised* as ambiguous), every refusal in the save
  planner, the draft rule for an execution plan with no limit, the
  due/duplicate/no-overlap decisions, and the recovery and resume policies that
  skip missed cycles instead of replaying them.
- **`tests/report.spec.ts`** — background reporting and the write barrier: which
  turn outcomes are worth reporting at all (a turn that *started* is not), that a raw
  token stream never is, per-reader cursors, the merge window per waking session
  (including merging across tasks, because the constraint is on the session being
  woken), the rule that an empty window is silence rather than a report, wake-vs-queue
  versus a running session, and the barrier — including the two cases a live run
  found: the Host's own `snapshot` context must neither trigger the barrier nor lift
  it, and a person speaking *inside* a report-opened turn must lift it. Round 52 added
  `storedFactsOf`: an artifact recorded `missing` or `changed` is a fact while
  `claimed` and `present` are deliberately silent, a transfer that recorded conflicts
  is a fact on either side of the handoff with "applied anyway" and "not applied" kept
  apart, the fact sits at the instant the **record** reports rather than the instant it
  was read, an unparseable timestamp falls back rather than landing at epoch zero, and
  both identities are derived from the record so a repeat read is the same fact. Round 53
  extended it with the two remaining §二.8.1 kinds: a budget that refuses, whose identity
  carries the policy, the limit and the run's ledger anchor (so a second run on the same
  policy is a new fact) and whose instant is the deadline when the policy fixes one; and a
  workflow run that stopped for the user, whose identity carries the status and the nodes
  involved. It also pins the question fact and the three new kinds' distinctness.
- **`tests/observer.spec.ts`** also pins the projection's reading of a **question**: a
  `tool/call` naming `ask_user_question` becomes a `user_question` notable, a call to any
  other tool does not, a name that merely contains the word does not, the execution
  dimension is untouched, a matching `tool/result` clears `waiting_input` while a
  different call's result does not, and `isWake` treats a question as ending a wait.
- **`tests/crosshost.spec.ts`** — cross-Host migration (PRD §二.14.1): the four
  compatibility aspects each reported, that a silent remote is not a compatible one, path
  translation that reports an unmapped path rather than guessing at it, the ordering rule
  that the target binds only after a confirmed stop **and** a frozen dispatch — with
  `unknown` refused explicitly, because that is the state a link failure produces and the
  one most likely to be mistaken for success — and reconciliation across a recovered link
  that adopts what the remote confirms and never resends.
- **`tests/modelconfig.spec.ts`** — model and runtime configuration (PRD §二.3): that a
  provider with no registered route is refused while an **unlisted model is accepted with
  a note**, because the Host documents its model catalogue as advisory and forbids turning
  absence into rejection; that an unlisted reasoning effort is passed through for the same
  reason; that "next request" and "most recently actually used" are reported separately
  with a pending-change note, including for a reasoning-effort change; that a preset is
  allowed only where a session is assembled; and that applying a model **refuses** without
  the Host extension rather than changing the global default.
- **`tests/export.spec.ts`** — local export and the share surface (PRD §二.14.2): that
  the document carries the cutoff, the session chain including retired bindings, the run
  status and the artifact versions; that environment **values** are withheld while names
  survive and an unset variable stays distinguishable from a withheld one; that raw tool
  output is reduced to a summary; that the exclusions are **listed** rather than only
  applied; that a field the builder was never told about cannot leak in; and that sharing
  is unavailable with a reason naming what would have to exist.
- **`tests/budget.spec.ts`** — budgets and the run ledger (PRD §二.13.2): that the
  ledger counts report turns as well as nodes, that it has no operation which could zero
  it, that the deadline is wall-clock from the first dispatch, that reaching a limit
  yields the specification's three-part response, that an unmeterable figure never
  renders as `0`, and that a strict limit on unmeterable usage **refuses** the automatic
  execution rather than reporting it as satisfied. A hard budget is refused unless full
  metering, a single-request upper bound and a concurrency reservation are all present.
  Reaching a limit **requests** cancellation of a plugin-initiated turn (not a native-interface
  one, and not for a concurrency ceiling) and reports the actual stop state rather than waiting
  for confirmation.
- **`tests/constraints.spec.ts`** — shared constraints and impact tracking
  (PRD §二.13.1): that a change versions while an unchanged statement is refused, that
  the default scope reaches only future runs, that applying to current work computes the
  affected nodes and marks **only** artifacts whose acceptance the change contradicts,
  that compatibility is checked before an automatic downstream start, and that the four
  delivery facts — sent, in context, acknowledged, verified — are one-way, unskippable,
  and that `verified` without a recorded check is refused.
- **`tests/workflow.spec.ts`** — the workflow rules of PRD §二.12: definition
  validation (a cycle is refused, a diamond is accepted, every problem is reported),
  the six start conditions each blocking on its own, the three acceptance outcomes and
  the rule that a model review is never user acceptance, and bounded rework — two
  whole-workflow rounds with the initial execution excluded, a node at most once per
  round, a task retry counting and a message retry not, and `needs_user` at the limit
  rather than a fresh workflow.
- **`tests/pass.spec.ts`** — the background pass, over a hand-driven timer: that it
  does not run on start, that it re-arms, that starting twice does not leave two
  timers, that passes never overlap and the skipped tick is counted, that a failure is
  contained and cleared by the next success, and that stopping is final — including
  that a pass already in flight cannot re-arm the loop on its way out.
- **`tests/access.spec.ts`** — control transfer and observers: that the owner and the
  epoch change in **one** record (two writes would leave a window in which the new
  owner holds control at the old epoch and the previous controller's requests still
  pass), that an undispatched operation carries over under its original id while an
  uncertain one stays uncertain and is named as such in the snapshot, that a withdrawn
  operation is not taken over, that the promise about authorisations and budgets is
  counted rather than asserted, that reports are not replayed, that transferring to the
  current controller is refused, and that adding an observer twice is the same
  permission rather than a conflict.
- **`tests/stop.spec.ts`** — the exact-stop primitives: folding the open turn out of
  the Host's event log (including that an unrelated `turn/end` must not close a live
  turn's anchor), the idle row of the PRD §二.6 table, a stale expectation refusing
  **without** issuing a cancel, `keepInbox` being set so a stop does not destroy input
  the conductor did not author, the synchronous shape of `cancelExpectedTurn` (it must
  not return a thenable), the queue precondition, and every post-stop change that
  abandons the send. A budget cancel records a distinct cause rather than being labelled
  an exact stop.
- **`tests/panel.spec.ts`** — the management panel (PRD §二.1): the status badge's
  derivation, precedence and totality (all 60 combinations of preparation, execution and
  interaction, each yielding a badge the filter knows), the deliberate absence of a
  `migrating` badge nothing can produce, the filter and grouping as pure functions
  (including that the tasks reporting no project form their own group, keyed `undefined`,
  rather than being folded into the first project), the shell's **session navigation** —
  that the port forwards the id, calls the service method **bound to its service** rather
  than detached from it, and reports no navigation when the shell has none or has a
  non-callable member — and both data routes — the list route's
  `500`-with-a-reason path, its `no-store` success path, and `httpPanelPort` carrying the
  HTTP status into its error; then the **detail** route's query parsing (encoded ids, blank
  parameters, a missing target, an absent request), its three distinguishable answers
  (`400` no subject, `404` no such task, `500` read failed), and the client port encoding an
  id that contains a separator. This is also the test C129 recorded as existing when it did
  not.
- **`tests/observer.release.spec.ts`** — a released task as a per-target error: the
  snapshot and the wait both report the release as that target's own error with no state
  served, and the control that a still-managed task and one that never had a control
  record are both still readable (see C203).

`node scripts/smoke-host.mjs` covers the built host half: it imports
`lib/index.js` the way the Loader does, mounts `apply` against a stand-in
context, and asserts which tools appear, that durable state is not claimed
before the domain has opened, that it is claimed once it has, and that every
disabled feature carries a reason.

Counts are reported by the commands' own output rather than copied here, so this
file cannot drift from them.

## 6. Booting a profile for verification (C7)

`scripts/verify/boot-profile.mjs` boots a profile **the way the desktop
application does**, which turns out to matter. Invoking
`app.asar/lib/desktop-cli.js` directly does *not* reproduce a real boot:

- `app.asar/lib/main.js` calls
  `installProfilePackageResolver(prepared.bareModuleBaseUrl)` immediately before
  `boot(...)`;
- `app.asar/lib/desktop-cli.js` never calls it.

Without that hook every row whose `name` is a bare `@deepseek-ai/*` specifier
fails to import — `Cannot find package '@deepseek-ai/dsh-session' imported from
<profile>` — and the tree fails to apply with one `AggregateError` that names no
entry at all. Two whole rounds of investigation were spent on that message; the
harness now installs the same hook first, and the failures disappear.

The first diagnostic that worked was to wrap `globalThis.AggregateError` so the
per-entry errors the loader collects are printed instead of collapsed. That is
worth remembering: the launcher's error handler reports the aggregate only.

### What the run does

Boots the `dev` profile (base + web-app + this plugin) from an isolated
`DSH_HOME`, on `127.0.0.1:43917`, with two scaffolding rows injected by
`--verify`:

- `scripts/verify/hmr-stub.mjs` provides an `hmr` service. Without it, the
  launcher's post-boot step creates the real `@deepseek-ai/cordis-plugin-hmr`,
  which refuses to construct unless `ctx.loader.internal` exists and takes the
  process down with an error that has nothing to do with the plugin.
- `scripts/verify/tree-probe.mjs` asserts, from inside the live Host, that the
  expected tool name is in the registry, and imports the built entry in-process.

### Result (passing)

```
[dsh-session-conductor] 0.1.0 loaded; waiting for the Host tool registry
CONDUCTOR-VERIFY module-import OK exports=["Config","apply","inject","name"] name=dsh-session-conductor
dsh web: http://127.0.0.1:43917
[dsh-session-conductor] 0.1.0 mounted; 2 of 7 features disabled: model_selection_isolated, fork_target_control
CONDUCTOR-VERIFY PASS [t+1500ms] expectedTool=conductor_capabilities present=["conductor_capabilities"]
CONDUCTOR-VERIFY PASS [t+3000ms] ...
CONDUCTOR-VERIFY PASS [t+4500ms] ...
```

Two of seven features disabled is the correct answer for this Host: the two
Host API extensions are genuinely absent, and every other capability —
`model_tools`, `session_driving`, `durable_state`, `workspace_registration`,
`settings_surface` — is present in the web composition.

The probe also asks the storage facility whether the conductor's own domain is
open, which is the strongest available evidence that durable state works: the
facility reports only a domain it opened successfully, so a version mismatch or
a drifted record would have failed that open. Measured:

```
CONDUCTOR-VERIFY PASS [t+4500ms] expectedTool=conductor_capabilities
  present=["conductor_capabilities","conductor_list"] registryPresent=true
  domain=session_conductor domainOpen=true
  domainTables=["tasks","bindings","access","operations","watches","notifications"]
```

Note that `storages/session_conductor.json` does **not** appear after a read-only
boot, and that is correct: opening a domain reads the medium, and the JSON
backend materialises the file on the first write. A file appearing after a boot
that only reads would have meant the conductor wrote something it should not
have.

### The create pipeline in a live Host

With `CONDUCTOR_PROBE_CREATE=1` the probe also drives `conductor_create` through
the *live registry*, supplying the caller identity the Host would supply for a
model-initiated call. This is the strongest end-to-end check available without
credentials: it creates no turn, because no instruction is sent, so no model
call happens.

```
CONDUCTOR-VERIFY PASS present=["conductor_capabilities","conductor_list","conductor_create","conductor_send"]
  domain=session_conductor domainOpen=true
CONDUCTOR-CREATE PASS taskId=task-64de6bd7… preparation=ready phase=ready
  sessionId=session-e5aa5906… replayed=false
CONDUCTOR-CREATE-DISTINCT PASS first=task-64de6bd7… second=task-b0a69e24…
CONDUCTOR-CREATE-REPLAY PASS replayed=true taskId=task-b0a69e24…
```

Corroborating artefacts on disk, in the isolated home:

- `storages/session_conductor.json` — 3735 bytes, materialised by the first write;
- two new session logs of ~308 bytes each (an empty created session), against the
  ~18 KB logs belonging to the Host's own pre-existing sessions.

**What this does not prove.** The probe calls the tool definition's `execute`
directly rather than going through a model turn, so the *schema-to-model* path —
that the model sees these tools, calls them with valid arguments, and reads the
rendered result — is still unmeasured (C18). That is recorded as an open check
rather than folded into these results.

### A real turn, observed end to end

With `CONDUCTOR_PROBE_TURN=1` the probe creates a task **with an instruction**,
so the new session actually starts a Host turn, then waits for it. The verify
Host has no model credentials and its persona section is unassembled, so the turn
is expected to fail — which is what makes it a useful measurement rather than a
limitation:

```
CONDUCTOR-TURN-CREATE PASS taskId=task-31f78c0b… phase=initial_message_accepted
CONDUCTOR-TURN-WAIT PASS ms=218 timedOut=false
  wake="turn 1 ended: failed (UNKNOWN: prompt variable \"{{model}}\" has no value
        for this assembly (section \"deployment:persona\"))"
  state="execution=idle; interaction=none; last turn=failed (…); cursor=10" cursor=10
CONDUCTOR-TURN-READ   state="… last turn=failed …" cursor=10
CONDUCTOR-TURN-NOREPEAT PASS wake=null
```

What this establishes:

- creation reached `initial_message_accepted`, and the dispatched message was
  recorded **accepted**;
- the turn that followed ended **failed**, with the Host's own reason quoted
  verbatim — the conductor never presented acceptance as completion (C20);
- `wait` returned on the turn-end wake in **218 ms**, one sample against the
  specification's "Host event to panel under 1 second" target — a single
  observation, not a P95, and not offered as one;
- a second wait returned nothing, so an event already returned is not
  re-reported (C21).

The failure reason is worth reading as evidence rather than as noise: the turn
never reached a model, so what was observed is the Host's own pre-request failure
path, reported exactly as the Host stated it.

### Discovery and organisation in a live Host

With `CONDUCTOR_PROBE_ORGANISE=1` the probe discovers candidates, joins one, and
organises it:

```
CONDUCTOR-DISCOVER PASS total=4 shown=4 sample={"sessionId":"session-9aae5056…","live":false,
  "persisted":true,"managed":false,"directory":"D:\\workspace\\…","createdAt":"2026-09-13T23:29:54.393Z"}
CONDUCTOR-ATTACH PASS taskId=task-4e0e3d8c… sessionId=session-9aae5056… replayed=false
CONDUCTOR-UPDATE PASS title="joined and renamed" group="verification" pinned=true archived=false
CONDUCTOR-ARCHIVE PASS archived=true listedArchived=1
CONDUCTOR-DISCOVER-HIDES PASS stillListed=false
```

Two details are load-bearing. The joined session reports `live: false`, so
joining demonstrably does not require the Host to be holding the session
in memory. And the candidate shape carries only selection metadata — no message,
no tool output, no history — which is what PRD §二.5 permits a caller to see
about a session it has not joined.

### A session archived outside the conductor

With `CONDUCTOR_PROBE_ARCHIVE=1` the probe drives the Host's own archive set and
then asks the conductor what it can see, on both surfaces that answer:

§二.5's last bullet is 查看失联、不可恢复及外部归档的会话, and the sentence
below it forbids the plugin's own archiving from using the Host's archive
interface. So the externally-archived view is a **read of the Host's own set**,
and the probe drives that set the way the Host's own UI does — never through the
plugin, which is the only way the words "outside the conductor" can mean
anything:

```
CONDUCTOR-ARCHIVE-BASELINE total=7 hostSet=0 archive="The Host's archive set was read (0 archived
  session(s) in the Host's registry); 0 of the sessions below are archived outside the conductor."
CONDUCTOR-ARCHIVE-VIEW PASS session=session-ac4bbb36… hostKnows=true flag=true hostSet=1 stillListed=true
CONDUCTOR-ARCHIVE-CONTROL PASS session=session-2b51bc48… flag=false
CONDUCTOR-ARCHIVE-SUMMARY PASS summary="…The Host's archive set was read (1 archived session(s) in the
  Host's registry); 1 of the sessions below are archived outside the conductor."
```

Reading the installed Host rather than assuming its shape decided three things
the implementation depends on:

- `archivedSessionIds` is a **getter** (`requireState().archivedSessionIds`),
  returning the ids **in archive order**, and every mutation installs a **new
  array** — so it is read per call, never captured at mount.
- That getter **throws** (`workspace registry is not started yet`) while the
  registry is mounted but still starting. That window is reachable during a boot,
  and it is why this is a three-way answer — `published`, `absent`, `unreadable`
  — instead of an array that can only be empty or full.
- **No DSH package exposes an unarchive** (checked across all 10 018 JavaScript
  files in the installed `app.asar`; the only mentions of the word belong to a
  vendored Mistral SDK and a syntax highlighter). That matches §二.5's own
  wording, 宿主接口…只有单向归档能力, and it is why a successful archiving probe
  is a permanent change to the set — done here in the isolated verification
  store, never in a user's.

`CONDUCTOR-ARCHIVE-CONTROL` is the assertion that gives the other one meaning:
in a set that **was** read, a session the set does not contain is reported
`false`. An implementation that only ever set the field for archived rows would
pass `ARCHIVE-VIEW` and fail the control. And `stillListed=true` records a
Host fact worth knowing: archiving does not remove a session from the Host's
list, which is what makes it showable at all.

The probe's own control had to be corrected once, and the correction is worth
recording because the mistake was in the harness rather than the plugin: it
first picked "any candidate that is not the one just archived" as the row that
must read `false`, which was true only while the set was empty. Archiving is
one-way, so the second run found the sessions the first run had archived still
archived and reported a plugin failure for an assumption the probe had made.
The control now asks the field for a row it says is not archived, and reports
`N/A` with the reason when every other row genuinely is.

The 界面 half of the same requirement is measured on a session the conductor
**manages** — an unmanaged candidate never appears in the panel, so the earlier
half could not exercise it. A task is created, its session is archived through
the Host, and both panel routes are fetched:

```
CONDUCTOR-ARCHIVE-PANEL PASS taskId=task-c8c1cf30-… session=session-834a5b16-… status=200
  flag=true othersFalse=true note="This route reports one of the two archives and not the other.
  sessionArchivedExternally is the Host's own registry-global archive of the task's session — read
  from the Host (9 session(s) archived there). The conductor's own archive of a task is a plugin
  record this route does not report: …"
CONDUCTOR-ARCHIVE-DETAIL PASS status=200 flag=true refusal="Two archives exist and this route
  reports one. sessionArchivedExternally is the Host's registry-global session archive — the user's,
  read-only here and one-way in this build — read from the Host (9 session(s) archived there). …"
```

Two archives, one field, and a sentence saying which of them the field is
**and** which one this route cannot report: the conductor's own archive is a
plugin record written through `conductor_update` and filtered by
`conductor_list`, the Host's is the user's and is never written here. The
browser rendering of the new row is not measured (no browser in this
environment); the payload is, and the bundle still builds and loads
(30 782 bytes).

### The task-list filters of §二.5, and where a filter is allowed to live

With `CONDUCTOR_PROBE_LIST=1` the probe creates a task and filters the list by the
values the tool **itself** reported for it — the round trip a caller actually
makes, rather than a value the probe decided the answer should have:

```
CONDUCTOR-LIST-EXPOSED PASS status="idle" statusReason=null hostId="local"
  project=null cwd="D:\workspace\dsh-plugins\dsh-session-conductor"
  sessionId="session-7f28c272…" rows=216 of 216
CONDUCTOR-LIST-NAME PASS name="C10A7B0F" total=1 filteredBy="name contains \"C10A7B0F\""
CONDUCTOR-LIST-STATUS PASS status="idle" total=196 because="status = idle"
CONDUCTOR-LIST-STATUS-CONTROL PASS status="preparing" total=0 carriesMine=false
CONDUCTOR-LIST-HOST PASS hostId="local" total=214 because="host = local"
CONDUCTOR-LIST-HOST-CONTROL PASS total=0 tasks=0
CONDUCTOR-LIST-PROJECT PASS needle="-q76HJp\\repo" upperCased=true total=1
CONDUCTOR-LIST-NONE PASS total=0 tasks=0 filteredBy="name contains \"no-such-task-c10a7b0f\""
```

Three things about this are load-bearing rather than decorative. The filters are
asked for with values read **out of the tool's own answer** (`status="idle"`,
`hostId="local"`), so the check cannot pass by a probe asserting what it hoped
for; each case also asserts that **every** returned row carries the value asked
for, so a filter that matched everything would fail. The project case needed a
task prepared from a directory, and the verify store has one from an earlier
Git-start probe — a real Windows path with a backslash, matched with the needle
**upper-cased**, which is the case-insensitivity rule doing real work. And the
negative control is not just "zero rows": the answer carries `filteredBy`, so an
empty result says *which filter* emptied it. "No task matched this filter" and
"the conductor manages nothing" are different facts, and a bare `total: 0`
cannot tell them apart.

### Access-checked session search (round 66)

The other half of the same paragraph — 全文搜索仅限调用者有权读取的会话 — is
now a `query` on `conductor_list`. It searches through the observer (the same
resolve path `conductor_read` uses), never through `callerEvents`. Hits name the
task and the event location; they do not carry the matching text.

```
CONDUCTOR-LIST-SEARCH-OWNER PASS delivery="accepted" total=1
  hits=[{"seq":7,"kind":"user"}] bodyLeaked=false
  filteredBy="session text contains \"SEARCH-NEEDLE-D5016271\""
CONDUCTOR-LIST-SEARCH-STRANGER PASS total=0 carriesMine=false listedUnreadable=false
CONDUCTOR-LIST-SEARCH-OBSERVER PASS observers=["session-search-auditor-d5016271"]
  hits=[{"seq":7,"kind":"user"}]
CONDUCTOR-LIST-SEARCH-NONE PASS total=0
  filteredBy="session text contains \"no-such-session-text-d5016271\""
```

Four facts, all measured on a real Host session (`list-live-r66.log`). The
controller who sent the needle sees one hit at `seq 7` / `user`, and the hit
object has only those two fields — `bodyLeaked=false` is the JSON of `hits` not
containing the needle. A caller that is not the controller or an observer sees
`total=0` and is not named in `unreadable` either, which is the difference
between "you cannot read this" and "this session exists". An observer added
through `conductor_access` sees the same location. A query that cannot exist
returns zero with `filteredBy` naming the search, so it cannot be read as "the
conductor manages nothing".

### Live queue list/edit/withdraw (round 68)

C64 was the last half of PRD §二.6 that this Host could not show: a queued
follow-up was consumed before the probe listed it. The hold is the Host's own
`runMaintenance` — not a fake inbox — and the list now flattens live
`UserMessage.content` blocks.

```
CONDUCTOR-QUEUE-LIST PASS queued=2 ofQueued=2 hold="runMaintenance"
CONDUCTOR-QUEUE-EDIT PASS changed="edited e7a82be9-…" remaining=2
  newText="edited follow-up the probe replaced 1789387567993"
CONDUCTOR-QUEUE-WITHDRAW PASS changed="withdrawn 391d5fe8-…" remaining=1
CONDUCTOR-QUEUE-WITHDRAW-REPLAY PASS changed="already_consumed 391d5fe8-…"
```

The same boot also closed the last uncompared of PRD §三.3's six fixed terms
(the budget policy) and gave `MigrationManifest` a construction site:

```
CONDUCTOR-FIXED-BUDGET-STOPS PASS
  problems="… the budget policy moved from maxTurns=6 to maxTurns=1 …"
  thisRun=["needs_user"] actions=""
CONDUCTOR-REMOTE-MIGRATE-PLANNED PASS refusals=2
```

The filters deliberately do **not** live where their facts live. §二.5's six span
the task record, the **binding** (the Host) and a **derived** value (the status
badge), and the badge is the one that matters: it is `panelStatusOf`'s output,
which the panel filters and groups by, so `index.ts` now derives it in one place
(`panelFactsOf`) for the card, the detail view and this filter. A list that
filtered on a status the card did not show would be worse than a list with no
filter, because both would look authoritative.

### Control freeze on every write path, and a snapshot the new controller actually receives (round 69)

PRD §二.10.1's freeze had been true for `send` and false for the rest. Round 32
recorded that honestly. The freeze is now one predicate, `writeControlRefusal`,
asked by rule save, schedule save, artifact register/verify/transfer, handoff, and
workflow save/start/drive — the same question `send` already asked. A late request
from the previous controller is refused on those surfaces with the same
`NOT_CONTROLLER` code:

```
CONDUCTOR-ACCESS-LATE-REFUSED PASS
CONDUCTOR-ACCESS-LATE-RULE PASS
CONDUCTOR-ACCESS-LATE-ARTIFACT PASS
CONDUCTOR-ACCESS-LATE-SCHEDULE PASS
CONDUCTOR-ACCESS-LATE-HANDOFF PASS
CONDUCTOR-ACCESS-LATE-WORKFLOW PASS
  refusal="NOT_CONTROLLER: … (node only); 1 control problem(s); the definition was not saved."
```

The receiving half of the same paragraph — 新控制者收到接管快照 — is a plugin
`notice` on the new controller's live session, not a second copy of the
transferring caller's tool result. Idle sessions are woken with `steer`; busy ones
are queued with `followup`. The first live check read the receiver log before the
Host had written `user/message:notice`; waiting until that event existed is what
made delivery observable:

```
CONDUCTOR-ACCESS-SNAPSHOT-DELIVERED PASS count=1 delivered=true
  types=[…,"user/message:notice"]
  notice="Handover snapshot for task …"
```

That notice opens a turn. A send issued from the new controller *during* that turn
is refused by the report-triggered write barrier — which is the product working (a
snapshot is not an authorisation). After a person spoke in that session,
`CONDUCTOR-ACCESS-NEW-CONTROLLER PASS delivery=accepted`.

### Recovery actually inspects, and the ledger writes reports and rework (round 70)

PRD §二.11 asks for one read-only calibration after downtime. Recovery already
recorded a `ran` entry once; it recorded the *policy sentence* and never called
`inspectOf`. The tick path inspected; the restart path did not. Recovery now
writes `calibratedInspectRun` with the observation `inspectOf` returns:

```
CONDUCTOR-SCHEDULE-RECOVERY-INSPECT PASS
  reason="task task-edf7236e-… is ready/ready on session session-7975747f-…;
  0 artifact(s), 0 verified present and 0 accepted"
```

PRD §二.13.2 names four plugin-initiated events that count into the run ledger.
Nodes and acceptances already had automatic writers (C192, C216). A delivered
report and an opened rework round now write through the same `countLedgerEvent`
path. Failed or silent reports are not counted; hitting the rework limit and
handing the run to the user is a stop, not another round:

```
CONDUCTOR-LEDGER-REPORT PASS delivered=1 reportTurns=1
CONDUCTOR-LEDGER-REWORK PASS reworkRounds=1
```

### A read-only inspect notifies on change (round 71)

PRD §二.11: 有变化时通知. The inspection was recorded in the run log; nothing
was delivered. A later occurrence now compares its observation to the last
`ran` reason and, when they differ and a target task exists, delivers a plugin
`notice` to the session that authorised the plan:

```
CONDUCTOR-INSPECT-BASELINE PASS
CONDUCTOR-INSPECT-CHANGED PASS … notified session-9fc7b4f4-… (woke)
CONDUCTOR-INSPECT-DELIVERED PASS count=1 waitedMs=0
  notice="Scheduled inspection \"inspect-notice probe plan\" saw a change on task …"
CONDUCTOR-INSPECT-UNCHANGED PASS … (the observation is unchanged)
```

The first inspection is a baseline. An unchanged inspection stays silent. The
notice opens a turn, so a later coordination write from that session is refused
by the report-triggered barrier — which is the product working.

### Resource cleanup is preview-then-confirm (round 72)

PRD §三.6 / T32: stop and uninstall never delete a worktree. Cleanup is a
separate action: a preview first, then a named selection the user confirmed.
Only plugin-owned, unreferenced resources whose working tree is clean (or
already gone) are eligible; user modifications and unknown contents are
refused rather than forced, and `git worktree remove` is never passed
`--force`. Auto-delete stays off.

```
CONDUCTOR-CLEANUP-PREVIEW PASS … eligible=false referenced=true tree=clean
CONDUCTOR-CLEANUP-UNCONFIRMED PASS exists=true cleaned=[]
CONDUCTOR-CLEANUP-REFERENCED PASS exists=true cleaned=[]
CONDUCTOR-CLEANUP-HANDOFF PASS succeeded=true reached=switching_binding
CONDUCTOR-CLEANUP-ELIGIBLE PASS eligible=true referenced=false tree=clean
CONDUCTOR-CLEANUP-EXECUTE PASS gone=true cleaned=["worktree:task-6a7f15f1-…"]
```

A Git starting state that creates a worktree registers it as `worktree:<taskId>`.
A preparation that refuses after `git worktree add` registers the leftover so
the directory is not missing from the bookkeeping. The 32nd tool is
`conductor_cleanup`; the domain gained a `resources` table (C30: adding a
table does not reject an existing medium).

### A reached budget requests cancellation of the current turn (round 73)

PRD §二.13.2's three-part response was named (`request_cancel` in the decision)
and only the first part was issued (C191 stops new automatic dispatch). The
second part is now a real cancel request through the exact-stop critical
section, without waiting 30 seconds for a confirmation the budget is not
claiming. Native-interface turns are skipped; a concurrency ceiling does not
abort work already in flight. An idle session reports `no_active_turn` as the
actual stop state.

```
CONDUCTOR-BUDGET-CANCEL-IDLE PASS outcome="no_active_turn"
CONDUCTOR-BUDGET-CANCEL-ACTIONS PASS actions=["stop_new_scheduling","request_cancel","keep_ledger"]
CONDUCTOR-BUDGET-CANCEL-KEPT PASS dispatches=0
CONDUCTOR-BUDGET-CANCEL-CONCURRENCY PASS limit="concurrency" cancels=[]
```

This Host still has no live running turn (no model credentials). A running
conductor-relay cancel is unit-measured: `cancel()` is issued with `keepInbox`,
and the method returns before the turn ends.

### Native-interface and controller input stay distinguishable (round 74)

T11 requires both ends of dual input to remain, and to stay traceable.
`conductor_read` already returned user-role lines; it did not say who wrote
them. The Host already records `{kind:'user'}` for the original session and
`{kind:'plugin', form:'relay'}` for a forwarded instruction (C70 measured the
`notice` form the same way). The reader now keeps that provenance.

```
CONDUCTOR-SOURCE-SEND PASS delivery="accepted"
CONDUCTOR-SOURCE-RELAY PASS source="relay"
CONDUCTOR-SOURCE-NATIVE PASS source="user"
CONDUCTOR-SOURCE-DISTINCT PASS relaySeq=7 nativeSeq=15 kinds=["relay","plugin","user"]
```

The `plugin` line in that window is the Host's own system-prompt snapshot, not
a person and not a controller relay — which is the point of not collapsing
every user-role event to `kind: 'user'`.

### A repeated defect, and the fix that removes the class

Discovery initially returned nothing while the probe's own diagnostic showed
`sessionQuery.listSessions()` returning **7** sessions. The cause was the same
one found in round 2 for the tool registry: `ctx.get('sessionQuery')` was read
**once during `apply`**, and cordis mounts entries concurrently, so the service
belonged to a sibling entry that had not published yet. The captured value was
`undefined` for the process's whole life, and the tool silently reported an empty
Host.

Every service lookup is now resolved **at call time** rather than captured at
mount. That is the general fix; the round-2 fix was only the instance of it that
the tool registry happened to expose. A plugin that caches a service handle
obtained during `apply` has a latent version of this bug.

### A handoff brief from real history

With `CONDUCTOR_PROBE_BRIEF=1` the probe creates a task, lets it run a turn, and
briefs it:

```
CONDUCTOR-BRIEF PASS version=0 cutoff=11 decisions=1 openItems=1 refs=1 error=null
CONDUCTOR-BRIEF-VERSION PASS first=0 second=1
CONDUCTOR-BRIEF-DOMAIN PASS domainOpen=true contexts=size=2
```

The third line answers the question this round actually turned on. Adding the
`contexts` table to the domain spec could plausibly have made every medium
written by an earlier round refuse to open — the Host's domain layer rejects a
medium whose stamped version differs, and it validates the record set at open.
It does not: the facility builds its table map **from the spec**, so a stored
medium with no `contexts` key loads as an empty table. That is now measured
against a medium carrying real data from rounds 4–6 rather than assumed, and it
is why the table addition needed no format-version bump.

### Fork, and why it does not need the Host extension

```
CONDUCTOR-FORK PASS source=task-bfd79d73… taskId=task-85138cd5… sessionId=session-118908b6… phase=ready replayed=false
CONDUCTOR-FORK-REPLAY PASS replayed=true taskId=task-85138cd5…
CONDUCTOR-FORK-IDLE PASS phase=ready
```

The child session's log is **1155 bytes**, against **307** for an empty created
session and **1298** for the source — so the fork demonstrably carries the
completed-turn prefix rather than merely existing.

The specification names a `fork` Host extension for `newSessionId`, `workspaceId`
and `cwd`. That extension is about the Host's own **fork command**, which mints
its child id and inherits the source directory. The conductor does not use that
command: it assembles the child through the Host's agent factory and preset
service, so it chooses the child's identity and directory itself. Two things had
to be true before this was honest rather than an approximation:

- the cut is computed exactly as the Host's own fork computes it — back to the
  last `turn/end`, then forward to the next `turn/start` — so the seed is a
  balanced completed-turn prefix the factory will accept;
- the child's preset is resolved with the Host's own `resolveSessionPreset`,
  which knows that a later `agent-preset/selected` event overrides the header's
  creation-time value, and mounted with the preset service's own `mount`. Reading
  the header alone would have silently picked the wrong composition.

The capability report was corrected accordingly: `fork_target_control` now states
that it gates *the Host command's* target control, not the conductor's fork.

### Artifacts, and the three facts that must stay apart

```
CONDUCTOR-ARTIFACT-FS PASS fsServicePresent=true
CONDUCTOR-ARTIFACT-REGISTER PASS existence=claimed acceptance=pending
CONDUCTOR-ARTIFACT-VERIFY PASS existence=present version=0 pinned=true
  reason="verified present with a whole-content hash"
CONDUCTOR-ARTIFACT-CHANGED PASS existence=changed version=1 pinned=false
  reason="the artifact changed since it was verified, so it is not a fixed input"
```

Three separate confirmations are in that output.

**The check goes through the Host's own filesystem service.** `ctx.fs` is present,
so artifact verification reads through the same policy any other reader is
subject to rather than reaching for `node:fs` and bypassing it.

**Registration is a claim.** The record starts `claimed`/`pending` no matter what
the producer asserted about it, because nothing has looked yet. A producer-supplied
hash is stored for later comparison but does not advance the state.

**A changed file stays changed.** After the file was rewritten the state became
`changed`, the content version advanced, and — importantly — the recorded digest
still describes what was verified *last*, so the drift remains readable rather
than being silently re-baselined. The fixed-input rule then answers no, which is
what PRD §二.9.1 requires before a downstream execution may be triggered.

### Transfer, and the refusals that matter

```
CONDUCTOR-TRANSFER-REFERENCE PASS provided=true applied=false hasReference=true
CONDUCTOR-TRANSFER-COPY-REFUSED PASS applied=false
  conflicts=["the source is not a verified, unchanged artifact: the artifact changed since it was
              verified, so it is not a fixed input"]
CONDUCTOR-TRANSFER-PATCH-STOPPED PASS applied=false verified=false unchanged=true
  conflicts=["the target does not match the patch baseline (expected fe5887e7fb37…, found 3e96b242dac1…);
              the receiver has different content and nothing was written"]
```

The two refusals are the point. A snapshot copy of an artifact whose content
changed after verification is refused rather than propagated, and a patch whose
baseline does not match the receiver's file is refused **before** anything is
written — `unchanged=true` is a byte-for-byte comparison of the file before and
after the attempt, not an assertion that the code intended not to write.

The patch module has no fuzz factor. A hunk that does not match at the position
the diff names is a conflict, because a fuzzy match is exactly how a change lands
on top of somebody else's edit without anyone noticing. Applying into a string
before writing is the "isolated copy" the specification asks for; the file on
disk is untouched until every hunk has been checked.

### The environment handoff, and the precondition it cannot check

```
CONDUCTOR-HANDOFF PASS taskId=task-ae4b388d… reached=switching_binding
  previous=session-2b51bc48… successor=session-ac4bbb36… reason=null
CONDUCTOR-HANDOFF-PRECONDITIONS taskIdPreserved=true
  summary="…The task id is unchanged and the previous session is kept as the predecessor.
  Verified before the move:
    - the source has no unconsumed queued input
    - the source reached quiescence
    - no other managed task is bound to the target directory
    - the target directory exists
  NOT verified (this is a gap, not a pass):
    - the target's git baseline and existing local modifications
    - whether any process currently holds the target directory"
CONDUCTOR-HANDOFF-CHAIN PASS first=session-ac4bbb36… secondPrevious=session-ac4bbb36… distinct=true
```

**This build cannot perform the baseline check the specification asks for.** The
Host exposes no git adapter and this plugin does not shell out, so the target's
baseline and existing local modifications are not inspected. Rather than silently
omitting the precondition — which would let the migration read as having passed a
check it never ran — the outcome carries an explicit `unchecked` list and the
model-facing summary prints it under "NOT verified (this is a gap, not a pass)".

Two harness corrections are worth recording, because both were mine:

- the first attempt labelled a repeat move as an idempotency check. It is not
  idempotent by design — a second move produces a second successor — so the check
  now measures what it actually establishes: that the chain links.
- a test fake for "a source that will not settle" settled in 5 ms against a 20 ms
  timeout, so the test passed for the wrong reason until the fake was made to
  outlast the bound.

### One-time rules, and the two bugs the live run found

```
CONDUCTOR-RULE-SAVE PASS ruleId=rule-probe-… target=task-cc746ad5… maxExecutions=1
CONDUCTOR-RULE-FIRE PASS dispatches=1 refusals=[]
CONDUCTOR-RULE-ONCE PASS secondDispatches=0
  refusals=["rule … already fired for event turn-1-…-seq-1"]
```

The third line is T21. A repeated event produces one dispatch because the
dispatch is keyed on the rule and the event id together, and that key is handed
to the ordinary send path — so a repeat is a *replay* in the operation layer
rather than a second instruction. There is no separate deduplication table to
drift out of sync with the thing it is deduplicating.

Three corrections came out of running it rather than reasoning about it:

- **A real defect.** The executor claimed the operation id as kind `rule` and
  then handed the same id to `send`, which classifies it as `send`. The claim
  collided and every dispatch was refused as a conflict. The executor now lets
  the send path own the claim; the id is still deterministic, so the guarantee is
  unchanged.
- **A naming collision.** The rule's action vocabulary is `send`/`queue`, and the
  tool exposed it as `mode`, which is the *send mode* enum (`steer`/`queue`/
  `interrupt`/`interrupt_and_send`). Two different vocabularies under one name is
  how a caller ends up passing `steer` to a field that has never accepted it. The
  parameter is now `delivery`.
- **A probe that measured nothing.** The first version listened for
  `turn_completed`, which this credential-less Host never produces — its turns
  end in failure. The executor was right to stay silent; the probe was wrong
  about the environment. It now listens for the trigger that actually occurs, and
  the reason is written next to it.

### Schedules, and the one property that needed a second process

The scheduling checks run in two boots, because the recovery rules of PRD §二.11
are about what happens when the Host was **not** running, and no single process
can observe its own absence.

The first boot leaves two plans deliberately overdue — a read-only one and an
execution one — each about five minutes past due at a 60-second spacing, so each
has five missed cycles behind it. The second boot then reads the persisted
records directly rather than trusting a count:

```
[dsh-session-conductor] schedule recovery: 3 active schedule(s): 1 calibrated once,
    1 missed occurrence(s) recorded, nothing replayed
CONDUCTOR-SCHEDULE-RECOVERY-INSPECT PASS
    runs=[["2026-09-14T00:54:13.667Z","ran"]] nextAt=2026-09-14T01:01:13.667Z advanced=true
CONDUCTOR-SCHEDULE-RECOVERY-EXEC PASS
    runs=[["2026-09-14T00:54:13.667Z","missed"]] nextAt=2026-09-14T01:01:13.667Z status=active
CONDUCTOR-SCHEDULE-RECOVERY-NOREPLAY PASS totalRecordedRuns=2
```

That is T22, and the arithmetic in the last line is the part worth reading: two
plans, five missed cycles each, **one** recorded run each. A schedule that
replayed its backlog would have recorded ten.

In the first boot:

```
CONDUCTOR-SCHEDULE-CALENDAR PASS nextAt=2026-09-14T01:00:00.000Z localHourInShanghai=09
CONDUCTOR-SCHEDULE-DRAFT PASS status=draft
    draftReason="an execution plan needs a limit — maxRuns or expiresAt — before it may run automatically"
CONDUCTOR-SCHEDULE-DRAFT-IDLE PASS runs=0
CONDUCTOR-SCHEDULE-FIRE PASS
    runs=["schedule-377f4176… 2026-09-14T00:59:12.127Z: dispatched to task-5cf6c5d4…
           as schedule-schedule-377f4176…-2026-09-14T00:59:12.127Z"]
CONDUCTOR-SCHEDULE-ONCE PASS secondRuns=0
CONDUCTOR-SCHEDULE-COMPLETED PASS status=completed runs=1
```

The dispatched operation id is the whole dedupe design in one string: it is
`schedule-<scheduleId>-<scheduled instant>`, built from the plan and the moment
rather than generated. A second tick over the same instant therefore hands the
send path an id it has already claimed, and the refusal comes from the operation
layer that already refuses duplicate sends — there is no separate deduplication
table for schedules that could disagree with it.

Three things were corrected while building this, and the first is the one I would
have got away with:

- **An ambiguous local time that was resolved correctly by accident.** The
  resolver probed `candidate − 1h` for a second occurrence. On the test's
  transition date the two-pass resolution happened to land on the *earlier*
  instance already, so the backward probe found nothing, the instant was right,
  and the note the specification requires was silently missing. Getting the answer
  right is not the same as knowing why. The probe now searches both directions
  across every plausible shift (30 minutes, 1 hour, 2 hours — all real), so
  landing on the earlier occurrence by coincidence is still *recognised* as
  ambiguous. The test failed before the fix and passes after.
- **A test that asserted something false.** I asserted that `+08:00` is not a
  zone this runtime resolves — it is; ICU treats a bare offset as a fixed-offset
  zone. Rather than keep the assertion and "fix" the code, the behaviour was
  measured and kept, because a local time in a fixed offset is exactly well
  defined and can never be ambiguous. The comment now says so.
- **A dead table.** `notifications` has been declared since the domain was
  written and no code path writes to it. The schedule work did not change that, so
  a read-only occurrence records what it saw in its own run log — a record of the
  occurrence, which is what §三.5 asks a `Schedule` to keep — and the notice
  delivery path is listed as an open gap rather than half-wired.

### Exact stop, and the one thing the pinned runtime does not have

PRD §二.6 states two conditions for claiming a precise stop, and then states
plainly that a build which does not meet them must not claim the feature:

> 精确停止必须在同一 Host 临界区内完成轮次校验与实际取消，且内部不得异步让出。
> 使用宿主同步投影与取消接口实现 … 未满足条件时不得宣称支持精确停止。

Both are met, but only after substituting one thing, and the substitution is worth
recording because it is where this could have gone wrong quietly.

**The condition that is met directly.** The Host's `agent.status` and
`agent.session.events` are synchronous projections and `agent.cancel()` is a
synchronous call, so the check and the cancel run in one tick of the event loop.
Nothing can start a turn *between* them, because nothing else can run between
them. `cancelExpectedTurn` is therefore a synchronous function, and a test asserts
it does not return a thenable — because making it `async` later would remove the
guarantee while leaving the code looking correct.

**The substitution.** The PRD names `turnStartSeq`. That member does not exist in
the pinned runtime, and a search of the PRD's own baseline commit for it returns
nothing either. What the Host does expose is its durable event log, in which
`turn/start` carries the Host's own turn number. `openTurnOf` folds that log to
find the open turn and the sequence it started at, which is the same anchor under
a different name — and `turnEndOf` matches the end receipt by *that* turn number
rather than by "the session went idle", which the PRD explicitly forbids using as
a substitute.

The limit of the substitution is stated rather than glossed: this is the Host's
turn identity, so a stop whose anchor no longer matches the open turn is refused,
never retargeted. `CONDUCTOR-STOP-IDLE` and the unit tests measure the two halves
that are measurable here; a *running* turn cannot be driven in this
credential-less composition, so the interrupt-and-send success path is asserted
against a driven fake rather than against a live turn, and that is a gap in the
evidence, not a pass.

What the live Host did establish:

```
CONDUCTOR-STOP-IDLE PASS outcome=no_active_turn
    reason="the session is between turns, so there is no active turn to stop"
CONDUCTOR-INTERRUPT-AND-SEND-IDLE PASS delivery=accepted mode=interrupt_and_send
CONDUCTOR-QUEUE-NOT-CONTROLLER PASS
    refused="NOT_CONTROLLER: session session-not-the-controller does not hold write control of task …"
CONDUCTOR-QUEUE-LIST DRAINED queued=0 ofQueued=4 summary="the session has no unconsumed input"
CONDUCTOR-QUEUE-WITHDRAW NOT MEASURED: the Host consumed every queued message before the probe could
    withdraw one; the withdrawal path is covered by tests/coordinator.spec.ts
```

The `DRAINED` line is the honest one. Four messages were queued and the Host
accepted all four, then consumed them before the queue could be read — this
composition fails turns almost immediately, so a queue exists only briefly. The
probe reports what it found instead of being tuned until it printed a pass, and the
read/edit/withdraw path is measured against a driven inbox projection instead.

**One judgement the specification left open.** The Host's default `cancel()` clears
queued and steering work along with the turn. The conductor passes
`keepInbox: true`: it did not author that text, and discarding a user's pending
message as a side effect of a stop is the silent deletion PRD §八 forbids. The
measurement confirms the option is actually used —
`expect(cancel?.message).toMatchObject({ options: { keepInbox: true } })` — and the
pending steering is still there afterwards.

A defect was found by a test written for an unrelated reason. `afterStopCheck`
reported "the binding moved" whenever the *after* reading was missing, which
claims a change nobody observed. It now separates the two facts: a value that
could not be read still refuses the send, because sending into unverified control
is the risk the rule exists to avoid, but the reason says it could not be read
rather than asserting a change.

### Background reporting, and the two live runs it took to get the barrier right

PRD §二.8.1 asks for automatic reports and then adds a rule that is easy to read past:

> 仅由回报触发的执行禁止调用协调写接口；服务端执行此限制，提示词只作为辅助。

A prompt telling the model not to do it is advice. The guarantee had to come from
somewhere the model cannot reach, and the available evidence is the Host's own log:
every message records its `source`, so a turn opened by a plugin `notice` is
identifiable from facts no tool argument can forge.

**The first live run found a real defect.** The barrier read the *most recent*
user-role message. On a live Host that is not the message that opened the turn: once
a notice wakes a session, the Host appends its system-prompt `snapshot` as a
user-role message, and the barrier concluded "not a report" and lifted.

```
CONDUCTOR-WATCH-NOTICE-SOURCE PASS promptSources=[{"kind":"plugin","plugin":"dsh-session-conductor","form":"notice",…},
                                                  {"kind":"plugin","plugin":"@deepseek-ai/dsh-system-prompt","form":"snapshot",…}]
CONDUCTOR-WATCH-BARRIER FAIL refusal="no error"
```

**The first fix was wrong too, and the second run said so.** I reasoned that the
opening message must be the last user-role message at or before `turn/start`, and
made the lookup turn-aware. It still failed — because the snapshot lands *before*
`turn/start`, so a turn boundary cannot separate the two. The measurement is what
established the order; reasoning about it had produced a plausible wrong answer.

**What is right is the Host's own vocabulary.** `ContextForm` distinguishes a
`notice` — "a one-off account of something that just happened; it supersedes
nothing" — from a `snapshot` — "current state, where a later snapshot from the same
producer supersedes an earlier one". A snapshot is context riding along with a turn,
not something that opens one. So the barrier now ignores every context form
(`snapshot`, `catalog`, `instructions`, `recall`) when looking for the opener, and
treats a `notice` as the opener while a `{kind:'user'}` message at or after it lifts
the barrier. Both of those cases are now unit tests, taken from the measured log.

The second run, after that fix:

```
CONDUCTOR-WATCH-NOTICE-SOURCE PASS
CONDUCTOR-WATCH-BARRIER        PASS refusal="REPORT_TRIGGERED: this turn was opened by a conductor report…"
CONDUCTOR-WATCH-NO-WAKE-LOOP   PASS
CONDUCTOR-WATCH-READ-ALLOWED   PASS
```

Two further decisions were forced by the live run rather than chosen in advance, and
both are recorded because a reader would otherwise assume the opposite:

- **The reporting surface is guarded too.** `conductor_watch action: report` from a
  notice-triggered turn is refused. That looked like a probe bug at first — the probe
  could not run its own second pass — but it is the behaviour that prevents two
  controllers waking each other forever (PRD §三.6, T28). The consequence is stated
  plainly: the tool's `report` action is usable by a session that has not itself just
  received a report; the pass the plugin runs on its own is not affected, because it
  does not travel through the tool layer.
- **A guard that cannot be forgotten.** The barrier is applied by wrapping every
  mutating tool in `registerConductorTools`, not by writing a check into twelve
  `execute` bodies. `conductor_artifact_register` and `conductor_artifact_verify` are
  deliberately left unguarded: recording a claim about your own work and checking it
  against the filesystem are observations of the conductor's own bookkeeping and cause
  no other session to do anything.

**Round 52: the merge was documented, implemented and unreachable.** PRD §二.8.1's rule
is that events for the same main session inside the window become **one** notice, and
`mergeReports` implements exactly that — but the caller built a one-entry map *inside* the
per-watch loop, so every report was merged against itself. A controller watching three
tasks was woken three times inside the window it was supposed to be woken once for, and
the module's own tests could not see it because they exercise the function, not the call
site. The pass now gathers facts per watch, merges once across all of them, delivers once,
and splits the recording back per watch — the cursor and the delivered-id list belong to a
watch, the window belongs to the session. Measured: `CONDUCTOR-WATCH-MERGED PASS
delivered=["task-193c2b40-…, task-5093ee57-…: woke the controller with 2 fact(s)
[turn_ended] over 2 task(s)]"`.

Two of the five notice kinds §二.8.1 lists had no producer at all, including the ones the
module declares but never emits: an artifact verified `missing` or `changed`, and a
transfer that recorded conflicts. Both are facts the **store already holds**, so the pass
reads them rather than waiting for someone to announce them, with identities derived from
the record so a repeat read is the same fact and a new problem is a different one.
Measured with the existence check run for real against a path that does not exist:
`CONDUCTOR-WATCH-ARTIFACT-MISSING PASS existence="missing" delivered=["task-89a4d5aa-…:
woke the controller with 1 fact(s) [artifact_missing] over 1 task(s)]"`.

One lesson repeated from the barrier work above, and worth recording because I made it
again: **the repeat check must not run from the session that just received the notice.**
My first version of the "the same stored fact is not reported twice" assertion called
`report` as the controller whose turn the notice had opened, and the barrier refused it —
the same behaviour this section already documents, met from the other side. The check now
runs from an identity that is not a live session, so the fact is recorded without a notice
landing and a second pass over an unchanged record can be observed directly:
`CONDUCTOR-WATCH-ARTIFACT-NOREPEAT PASS firstRefusals=["… the controller session is not
live …"] secondDelivered=[] secondRefusals=[]`.

**Two more harness lessons from round 53, both about measuring rather than about the
plugin.** First, an assertion that asks for the report *itself* races the plugin's own pass:
once the pass's notice lands, that session's turn is report-triggered and its next call to
the reporting surface is refused — so the check failed for the right reason and the wrong
measurement. The three round-53 checks now read the notice out of the controller's **own
log** and never call `report` at all, which measures the unattended path: the one a person
is not driving. Second, a fixed sleep is not a timing measurement. The pass re-arms only
after a pass finishes, so on this retained store a notice took ~12 s where the interval is
5 s, and a 7-second sleep read an empty log — indistinguishable from a producer that does
not work. The harness polls for the notice and reports how long it waited:
`CONDUCTOR-WATCH-BUDGET-LIMIT PASS … waitedMs=12171` and `CONDUCTOR-WATCH-MERGED PASS
waitedMs=5125`. C210 records the latency itself.

### Control transfer, and a freeze that costs nothing to enforce

PRD §二.10.1 gives the transfer a sequence, and one line in it does the real work:

> 旧控制者迟到请求被拒绝。

The tempting implementation is a flag — `frozen: true` — checked by each write path.
That is a rule every future write path has to remember. The implementation here adds
no rule at all: the transfer increments `ownerEpoch`, and **every** write path already
compares the epoch it was given. A late request from the previous controller therefore
fails on the check that was already there.

That claim is the one worth measuring, because it is a claim about *absence* — about
a rule that is not needed:

```
CONDUCTOR-ACCESS-LATE-REFUSED PASS
    refusal="NOT_CONTROLLER: session session-verify-controller does not hold write control of task …"
CONDUCTOR-ACCESS-NEW-CONTROLLER PASS delivery=accepted
```

Two further details are load-bearing and are tested rather than assumed:

- **The owner and the epoch change in one record.** Two writes would leave a window in
  which the new owner holds control at the old epoch — and in that window the previous
  controller's requests still pass. `applyTransfer` is a pure transform for exactly
  this reason, and the test asserts the input record is untouched.
- **An uncertain operation stays uncertain.** An operation that entered dispatch
  without a confirmable result is carried across as `reconcile` and named in the
  snapshot as "UNCERTAIN, do not resend". Clearing it would invent a delivery nobody
  observed; resending it is the failure the state exists to prevent. This path is
  unit-tested only: this composition's send path completes synchronously to `accepted`,
  so no operation can be left in flight to hand over, and saying otherwise would be a
  claim I cannot support.

### The background pass, and a feature that was quietly on-demand only

Seventeen rounds built scheduled checks and background reports, and both had the same
hole: **nothing ran them**. A schedule fired only when a caller called `tick`, and a
watch reported only when a caller called `report`. That is a scheduling service that
does not schedule and a reporting service that does not report — and no unit test
would ever have caught it, because every unit test calls the function it is testing.

The check that found it is the one that does nothing:

```
CONDUCTOR-PASS-SETUP      PASS controllerSession=… target=… schedule=…
   (18 seconds with no tool call)
CONDUCTOR-PASS-AUTOREPORT PASS notice="Observed on task … [turn_ended] …"
CONDUCTOR-PASS-AUTOTICK   PASS runs=4 nextAt=… status=active
```

The `runs=4` matters more than a `runs=1` would: one occurrence could be a startup
side effect, while four occurrences over eighteen seconds at a one-second spacing is
the loop re-arming on its own cadence.

Four properties of the pass are asserted rather than assumed, and each has a test in
`tests/pass.spec.ts`:

- **It does not run on `start`.** Mounting the plugin must not do work inside the
  Host's own startup path, so the first pass is scheduled, not run.
- **Passes do not overlap.** Two concurrent report passes would both read the same
  undelivered facts and could both deliver them. The cheapest way to prevent that is
  not to start the second pass, and the skipped tick is counted so a loop whose
  interval is shorter than its work is visible.
- **A failure is contained.** One failing pass is recorded and the next still runs. A
  background loop that dies on its first error is a loop that silently stops
  monitoring.
- **Stopping is final.** `stop()` clears the timer and refuses to schedule again, so a
  pass already in flight cannot re-arm the loop on its way out. That is the whole of
  PRD §二.12's "stopping the plugin stops new scheduling and reporting, and keeps
  tasks, artifacts and data": nothing else is touched.

One design decision is worth recording because a test forced it. The pass interval is
**not** a specification default — PRD §四.7 has no row for it, and it cannot: how often
an implementation looks for due work is not observable behaviour. I first put it in
`DEFAULTS` anyway, and `tests/domain.spec.ts` failed, because that object is asserted
equal to the published table value for value. The test was right and the placement was
wrong: it now lives in `IMPLEMENTATION_DEFAULTS`, named as what it is, so the PRD table
keeps an invariant that stops a specified default from being quietly changed.

### Uninstall, measured against a profile that boots

C8 had been "not yet measured" since the first round. Measuring it needed one piece of
care: a freshly created profile does **not** boot under this harness, and the failure
has nothing to do with the plugin under test — the profile's own
`@deepseek-ai/cordis-plugin-hmr` entry refuses to start, and without `--verify` the
harness's resolver hook is not the issue either. Rather than dress that up as a plugin
failure, C8 was measured against the profile that is known to boot, and the profile was
restored afterwards.

```
plugin --profile dev remove dsh-session-conductor
  → boots and serves:  aliveAfter22s=True served=True loadError=False
  → CONDUCTOR-VERIFY PENDING … present=[] registryPresent=true domainOpen=false
  → storages/session_conductor.json still present, 272 564 bytes
plugin --profile dev add <path>
  → conductorMounted=True toolPresent=True loadError=False
```

The third line is the one worth keeping: uninstalling removes the plugin, not the data.
PRD §八 requires that, and it is the kind of requirement that is silently violated by
a cleanup routine nobody thought of as a deletion.

### A tooling hazard worth recording

Twice in this project a `Get-Content`/`Set-Content` round-trip silently corrupted
UTF-8 in `src/index.ts`: non-ASCII characters were re-decoded through the console
code page, and the replacement character swallowed the following newline, merging
two source lines into one. Both times the damage was confined to comments, and
both times it compiled — which is exactly what makes it dangerous.

The repair is to rebuild the affected characters from code points and write with
an explicit `UTF8Encoding`, never to let the console near the text. The durable
rule is simpler: **do not edit source files through PowerShell text cmdlets.**
Use the file tools, which handle encoding explicitly.

A third occurrence in round 12 established a second, better repair: the
transformation is *reversible*. The original UTF-8 bytes were read as CP936, so
encoding the mojibake back to CP936 and decoding it as UTF-8 recovers the text —
`repository.ts` was repaired that way in one pass, with only the ten lines whose
lost byte was a newline needing a manual fix. That round's incident is also why
the count went up: I had written the rule down and then broke it twice in the
same round, so the rule is restated here rather than assumed to be remembered.

### Two defects this check found

Both were real and neither was visible from unit tests:

1. **`inject: ['tools']` silently prevented the plugin from existing.** A cordis
   entry whose injections are unmet stays pending, so a Host without a tool
   registry turned "the conductor is unavailable" into "the conductor is not
   there" — no error, nothing to act on. The plugin now declares no hard
   dependency, always mounts, and reports what it had to disable.
2. **Probing `ctx.get('tools')` once during `apply` races the registry's
   publication.** Entries mount concurrently, so the registry was reliably
   absent at that instant and the plugin concluded "no tool registry" for a Host
   that has one. Registration now waits through `ctx.inject(['tools'], …)`, and
   the one-line mount report waits (bounded) for the Loader to settle so its
   feature summary is not a stale snapshot.

### Housekeeping

The verification Host is started only for a check and stopped immediately after;
`netstat` on the port is confirmed empty afterwards. It runs against an
**isolated `DSH_HOME`** because the storage subsystem documents no cross-process
write locking — two processes on one home can interleave whole-file
replacements. `D:\dsh-conductor-verify` is retained so the next run starts from
the same state; delete it manually when it is no longer useful.
