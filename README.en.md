[English](README.en.md) | [简体中文](README.md)

# DSH Session Conductor

Native multi-session coordination for DeepSeek Harness Desktop. Create a focused child session from an ordinary conversation, open it through an inline card, and return to the creator through the child session header.

The plugin keeps the parent conversation out of the child task by default. A child inherits the parent workspace and receives the title chosen by the parent. Its first delegated turn can return one terminal result to the original creation card without waking the parent model. Continuous monitoring remains an explicit user request.

## What it provides

| Capability | Behavior |
| --- | --- |
| Native conversation links | Create/fork calls render an inline **Created conversation** card. The child header contains a link back to its origin. No floating panel is mounted. |
| Delegation by default | After a successful create or fork, the parent presents the result and stops. It does not repeat, validate, summarize, or monitor the child task unless the user asks. |
| One-shot completion return | A child with a nonempty initial instruction can update its original card once after that exact first delegated turn reaches a terminal state. It never creates a parent-model turn. |
| Authorized progress reading | When requested, the parent can read public records from an authorized child history directly instead of asking the child to write a report file. |
| Workspace and title inheritance | New tasks use the initiating conversation's current workspace by default; the initiating conversation supplies the child title. |
| Controlled coordination | Tasks support attach, fork, steer, queue, withdraw unconsumed input, stop, handoff, scheduling, workflows, constraints, and budget accounting. |

## User experience

1. Ask the current conversation to create a task and give it a title and instruction.
2. Open the child from the inline creation card.
3. Use the child header to return to the originating conversation.
4. When the child's initial delegated turn ends, its original card may show one bounded terminal result and public preview.
5. Ask explicitly to monitor a task when ongoing updates are wanted.

The completion card is intentionally narrow: it is not a task acceptance signal, it does not follow later turns, and it does not replace `watch` or a direct history read.

## Boundaries and safety

- Parent-to-child coordination uses stable task, binding, and operation identities; it does not infer relationships from titles or text.
- Completion projection requires the original parent, current read permission, the exact initial relay/turn relationship, and a private per-card capability. The capability is kept out of URLs and rendered chat content.
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

The current `0.1.6` source candidate passed the local source suite: 82 test files / 1,236 tests, plus lint and smoke checks. A clean local candidate has also been linked to one Desktop profile through the official offline CLI. This is local source and profile-link evidence only; it is not a published release, a general installation guarantee, or a completed GUI/Host/Edge end-to-end validation. See [ACCEPTANCE](docs/ACCEPTANCE.md) for the evidence and remaining work.

## Documentation

| Document | Purpose |
| --- | --- |
| [PRD](docs/PRD.md) | Product behavior, defaults, architecture, and acceptance criteria |
| [Implementation](docs/IMPLEMENTATION.md) | PRD-to-code/test mapping and milestone status |
| [Operations](docs/OPERATIONS.md) | Local setup, operation, recovery, and uninstall guidance |
| [API](docs/API.md) | Tools, routes, state, storage, and lifecycle contracts |
| [Native links](docs/NATIVE-LINKS.md) | Parent/child navigation and completion-card boundaries |
| [Acceptance](docs/ACCEPTANCE.md) | Verification evidence, artifacts, and known gaps |
| [Demo](docs/DEMO.md) | Checked tool-argument examples |
| [Compatibility](docs/compatibility.md) | Measured Host/runtime compatibility notes |
| [Contributing guidance](AGENTS.md) | Implementation and collaboration rules |

## Status

The project is under active local development. It has no npm publication, public deployment, or declared license yet.
