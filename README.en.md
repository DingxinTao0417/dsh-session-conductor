[English](README.en.md) | [简体中文](README.md)

# DSH Session Conductor

Native multi-session coordination for DeepSeek Harness Desktop. Create focused child sessions, navigate both ways through inline links, inspect outputs, native subagents, delegated tasks, and sources in a persistent **conversation overview card**, and click resources to preview them in the native right pane.

Children inherit the parent workspace and receive parent-selected titles by default. The parent stops coordinating after creation; completed child work returns a receipt, with separate receipts for subsequent instructions. This does not wake the parent model or repeat verification. Continuous monitoring is explicitly enabled by the user.

**Current version: 0.2.6 local development candidate.** The sidebar toggle now sits immediately after `Session log`, with the overview header retaining an accessible fallback when the title bar is too narrow. The overview card stays right aligned in the main conversation flow, so the chat scroll area keeps its full width and its scrollbar remains at the main interface edge. Opening the sidebar allocates about 70% of the conversation area to the workspace and 30% to chat (excluding left navigation), hides the overview while open, and restores it on close. Wide layouts support a draggable and keyboard-adjustable split; narrow layouts use a full-width drawer below the Desktop title bar. Source type-checking, build, 97 test files / 1,407 tests, lint, smoke, and isolated Desktop Host/browser layout verification pass; the 0.2.6 candidate package and local `desktop` Profile installation, including rollback details, are recorded in the [Desktop trial record](docs/DESKTOP-TRYOUT.md). After installation, fully exit Desktop, including its tray process, and reopen it to load the new Host; the user's reopened window still needs confirmation. Not published to npm.

## What it provides

| Capability | Behavior |
| --- | --- |
| Native conversation links | Inline creation cards open children; each child header links back to its originating conversation. |
| Conversation overview card | Visible by default with no close control. Escape and outside clicks do not dismiss it. Resource rows are fully clickable and highlight across their width on hover or keyboard focus. |
| Native-subagent overview | Separate from Conductor's Delegated tasks and limited to the current conversation's direct Host subagents. Running, ended / idle, and unavailable are states, not evidence of successful completion. |
| Subagent directory | The overview entry opens a grouped right-pane list. Healthy rows open the corresponding native conversation; unavailable records retain their reason and cannot navigate. Each group starts with 10 items and expands by 30. |
| Independent sidebar entry | The conversation header button opens or closes the right pane. In very narrow layouts, the entry moves to the overview header. Closing the pane keeps the overview visible. |
| Right-pane content previews | Click the Outputs or Sources heading to open its resource collection; click a file, image attachment, or web link to preview it in the native right pane. |
| Codex-like workspace layout | The plugin-owned sidebar defaults to about 70% of the available conversation area and chat to about 30%, excluding left navigation. Chat and workspace retain 320/300 CSS px minimums. A separator supports pointer dragging, arrow keys, and Home reset; manual ratios are remembered. Narrow layouts use a title-bar-safe drawer. |
| Overview layering | Opening the plugin workspace or a resource preview hides the overview card and closing it restores the card. Native tool details are observed by actual visibility and follow the same hide/restore rule. |
| Independent delegation receipts | Initial and follow-up instructions retain separate results, unread states, and exact turn identities. Viewing a result does not advance model history cursors. |
| Direct controls | Template-based creation, steering, next-turn queuing, precise stop, and explicit monitoring controls. |
| Environment selection | Inherit the parent workspace by default, or explicitly create a worktree from the current commit; related running tasks sharing a directory receive an advisory. |
| Delegation by default | After a successful create or fork, the parent presents the result and stops. It does not repeat, validate, summarize, or monitor the child task unless the user asks. |
| One-shot completion return | A child with a nonempty initial instruction can update its original card once after that exact first delegated turn reaches a terminal state. It never creates a parent-model turn. |
| Authorized progress reading | When requested, the parent can read public records from an authorized child history directly instead of asking the child to write a report file. |
| Workspace and title inheritance | New tasks use the initiating conversation's current workspace by default; the initiating conversation supplies the child title. |
| Controlled coordination | Tasks support attach, fork, steer, queue, withdraw unconsumed input, stop, handoff, scheduling, workflows, constraints, and budget accounting. |

## User experience

Click Subagents in the overview to inspect running, inactive, and unavailable records. Click an entry to open its native child conversation.

![Native subagent overview and grouped pane using isolated real-Host test data](docs/assets/subagents-sidebar.png)

Click the sidebar icon in the conversation header to open the workspace home without selecting a resource first. It offers Outputs, Sources, Web preview, Terminal, and Tool details. Preview toolbars return to this home without starting a model task. Terminal starts a real Host shell in the current session working directory.

The overview's Subagents entry opens the current conversation's native direct-child directory. It separates running, ended / idle, and unavailable records; accumulated time comes only from the Host's formal `subagentTiming` projection and is omitted when unavailable. Before opening a row, the directory membership is checked again and the session is opened through native `openSubagent`.

![Independent right-pane entry and workspace home using isolated test data](docs/assets/sidebar-home.png)

1. Ask the current conversation to create a task and give it a title and instruction.
2. Open the child from the inline creation card.
3. Use the child header to return to the originating conversation.
4. When the child's initial delegated turn ends, its original card may show one bounded terminal result and public preview.
5. Use the persistent overview card to see files, native subagents, sources, and unread receipts. Click the Subagents entry for the right-pane directory or a resource for a right-pane preview; exact results and follow-up controls remain available.
6. Enable monitoring explicitly when ongoing updates are wanted.

The original creation card retains its first result. Later instructions have separate receipts in the overview card. A receipt proves that the matched turn ended; it does not establish task acceptance.

![0.2.1 persistent overview and native right-side file preview, using isolated test data](docs/assets/overview-preview.png)

Text previews support UTF-8 text, code, and common Markdown structures, with a raw-text toggle. Files are limited to 512 KiB; displayed text is capped at 200,000 UTF-16 code units with an explicit truncation notice. Image attachments use the Host's supported read interface. Web preview includes an address bar, reload, in-tab back/forward, and an external-browser link. It remains a restricted iframe: sites that block embedding still cannot be forced open, and this is not a full embedded browser.

On wide windows the overview card stays right aligned in the main conversation flow; the chat scroll area keeps the full conversation width and its scrollbar remains at the main interface edge. Below 1080px of available conversation width, the card follows the header in normal flow and reserves its actual height; long source lists scroll inside it. When the plugin workspace is open, it uses about 70% of the available conversation area and chat uses about 30%, subject to 320/300 CSS px minimums. This is a plugin-owned surface and does not claim to set the Host's native details width. Both the overview and narrow workspace drawer respect the Desktop title bar. Historical sessions can obtain read-only overview and file-preview credentials through official session metadata without restoring an Agent; coordination writes still require a live Agent.

The three built-in templates cover read-only research, implementation, and review. One-time automatic summarization, custom templates, a cross-session notification overview, and more development tools remain later phases. See the [overview specification and roadmap](docs/CONVERSATION-OVERVIEW.md).

Side chat, a complete file tree, and Git working-tree review are not integrated. Tool details restores the existing Host detail view; it is not a standalone development tool. Terminal requires Host `spawnTerminal` and names the gap when that primitive is missing.

## Boundaries and safety

- Parent-to-child coordination uses stable task, binding, and operation identities; it does not infer relationships from titles or text.
- Completion projection requires the original parent, current read permission, the exact initial relay/turn relationship, and a private per-card capability. The capability is kept out of URLs and rendered chat content.
- Overview and exact-result requests use same-origin, loopback-only UserUI credentials, with authorization rechecked after I/O. Acknowledgements remain separate from model cursors.
- The native-subagent overview reads only the formal `sessions.list` directory and calls `refreshSubagents(parentId)` when needed. It neither reads child history, private caches, or session logs nor restores an Agent, starts a model, sends a message, or schedules model monitoring. A healthy row rechecks `parentSessionId + childSessionId + mode` before calling native `openSubagent`; a missing capability is reported and never falls back to a guessed ordinary-session route. Neither `inactive` nor a `SessionSummary.completed` unread marker means success.
- File previews additionally check the workspace, canonical path, and file identity of the current session or an authorized local child. Escapes, binary files, oversized files, and access changes during reading are rejected without starting a model turn.
- Only bounded public user/assistant content is eligible for a completion preview. Reasoning, token chunks, private session data, and raw session logs are excluded.
- A released task stops nonterminal completion observation. Previously persisted terminal data remains visible only while the original parent still has read permission.
- Remote routing and HTTPS sharing are disabled by default. Installation does not start a remote or sharing service.

## Compatibility and companion packages

This repository contains the main plugin. Some capabilities require separately delivered companion packages:

- `dsh-harness-compat` supplies the tested Host compatibility surface for isolated model settings and native fork targets.
- `dsh-binary-files` supplies guarded binary-file writes.

The plugin detects unavailable Host capabilities and refuses the affected operation instead of silently changing its meaning. It never rewrites the installed Desktop ASAR.

## Development quick start

Requirements: Node.js `^22.19.0 || >=24.0.0` and a compatible DeepSeek Harness development environment.

```sh
npm install
npm run check
npm run lint
npm run smoke
```

`npm run check` type-checks source and tests, builds the Host/client/companion entry points, and runs Vitest. The npm package is not published. The local Desktop profile workflow is intentionally guarded and environment-specific; review [OPERATIONS](docs/OPERATIONS.md) before adapting it to another machine.

## Project layout

```text
src/          Host services, coordination domain, storage, tools, and native chat UI
companions/   Companion bridge entry points
tests/        Unit, integration, lifecycle, and regression coverage
docs/         PRD, API, operations, acceptance, compatibility, and demos
scripts/      Build smoke checks and guarded local verification helpers
```

## Validation status

The `0.2.3` test and installation records and the `0.2.4 / T44` native-subagent record remain in [ACCEPTANCE](docs/ACCEPTANCE.md); they do not substitute for 0.2.6 evidence. The current 0.2.6 source checks, isolated Host/browser verification, candidate sealing, and local Profile offline installation are complete. The user's fully reopened Desktop window still needs a loading confirmation. Isolated validation does not call external models or modify production conversations.

## HTTP 404 from the overview API

The reported issue was traced to an old Host process that started before the `0.2.0` installation. Refreshing the frontend loaded the new overview code, while that process still lacked its endpoints. **Refreshing the page is insufficient: fully quit Desktop, including its tray process, then reopen normally.** The new UI explains the endpoint mismatch and restart action. Do not delete sessions or rewrite ASAR to resolve it. A missing preview file has a separate file error and must not be confused with an unavailable endpoint.

## Documentation

| Document | Purpose |
| --- | --- |
| [PRD](docs/PRD.md) | Product behavior, defaults, architecture, and acceptance criteria |
| [Implementation](docs/IMPLEMENTATION.md) | PRD-to-code/test mapping and milestone status |
| [Operations](docs/OPERATIONS.md) | Local setup, operation, recovery, and uninstall guidance |
| [API](docs/API.md) | Tools, routes, state, storage, and lifecycle contracts |
| [Native links](docs/NATIVE-LINKS.md) | Parent/child navigation and completion-card boundaries |
| [Conversation overview](docs/CONVERSATION-OVERVIEW.md) | Overview card, native-subagent directory, receipts, interfaces, and upgrade roadmap |
| [Design QA](design-qa.md) | Reference images, rendered evidence, interaction and visual checks |
| [Acceptance](docs/ACCEPTANCE.md) | Verification evidence, artifacts, and known gaps |
| [Demo](docs/DEMO.md) | Checked tool-argument examples |
| [Compatibility](docs/compatibility.md) | Measured Host/runtime compatibility notes |
| [Contributing guidance](AGENTS.md) | Implementation and collaboration rules |

## Status

The project is under active local development. It has no npm publication, public deployment, or declared license yet.
