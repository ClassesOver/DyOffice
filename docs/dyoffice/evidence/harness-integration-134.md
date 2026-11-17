# PR #134 integration checkpoint

Integrated PR head `a5a8d181` with target `ca1f9be5`, including the target's PDF job receipt recovery and read-only Manager diagnostic. This is an implementation checkpoint, not complete Office editor acceptance.

## Integration guarantees

- Target migrations 1–28 retain their exact bytes and order. Harness/channel migrations 29–31 append. Real PostgreSQL tests cover fresh initialization, upgrades from both 24 and 28, repeated migration, preserved ledger digests and rejection of divergent historical ledgers.
- Keep session-bound Sources/Results clients and the separately opt-in metadata-only source catalog. Collaboration/delegation does not turn source metadata access into unrestricted query access.
- Built-in Codex is the plan's default coding candidate when a provider gateway is configured; `DYOFFICE_CODING_AGENT=off` disables it. Registration is lazy and does not resolve/probe the CLI or spawn a process. An authenticated delegated run is required. Channels separately require `DYOFFICE_ASSISTANT_CHANNELS=on`.
- Preserve production/PPTX fail-closed checks. No ordinary-process isolation fallback is introduced.
- Office channel lifecycle fixes preserve in-flight cancellation and generation boundaries. Task receipt recovery matches owner, task, claim, epoch and command before exposing a durable delivery; recovering after input expiration does not requery data or repeat commit.

## Verification

- Web unit: **553 passed, 3 skipped**. Skips require an installed Codex/analysis runtime; they are not runtime acceptance.
- Web frontend/server, Docs Web, standard Sheets, Agent Core and CLI typechecks passed. The historical Sheets Electron/Vite build check passed, but desktop product builds are not a SaaS acceptance gate.
- Agent Core: **284 passed**; Docs assistant: **32 passed**; Sheets workbook tools: **83 passed**.
- PostgreSQL integration: **65 passed**, covering channels, task data, artifacts, shared budgets, source metadata, T11 receipts and realtime/session boundaries. Additional migration-upgrade regression: **4 passed**, including 28→31.
- Pure harness data client: **10 passed**. Combined MCP HTTP, capability discovery, pure data client and cloud-command regressions: **45 passed**. These are separate from Unix-socket-dependent CLI tests.

## Test/runtime fixes

The Web unit runner now uses Node's TypeScript transform mode for existing parameter properties/type assertions. The authority fixture reflects production's combined clock-and-role query; production authentication behavior was not relaxed.

Explicit `.ts` imports from Node-loadable provider sources are permitted in the actual no-emit TypeScript configurations. Standard typecheck commands are unchanged; Vite remains responsible for emitted bundles.

Capability discovery no longer initializes network proxy transports. Local packaged GSK lookup is retained separately. This fixes the pre-existing `deck_start` capability lookup contaminating subsequent MCP localhost requests. Actual cloud execution proxy handling is unchanged; its global dispatcher/NO_PROXY behavior remains a separate architectural limitation, not a claimed comprehensive proxy fix.

## Remaining acceptance

The full CLI suite is **not reported as passing**. Unix-domain socket binding is denied in this execution environment, including through the available elevated-command route; socket-dependent fixtures can hang awaiting a listen callback. No system or network security settings were changed and no socketpair was substituted for the real path test.

Installed Codex/offline Python acceptance, complete editor E2E, independent real external-harness compatibility, and full Office parent-task/yield continuation remain open. No customer source or real model endpoint was contacted in this checkpoint.

## SaaS-only direction

The product target is SaaS. Web harness transport, contracts and server-side coding/data APIs do not import Electron or require a desktop process. Shared editor/engine modules remain reusable; existing dependency-free IPC adapter types are not an Electron runtime requirement. Removing the legacy desktop shell/build/release surface is tracked separately and is not expanded by this checkpoint.

The optional built-in coding harness requires a server-side Codex CLI, and offline analysis requires its locked server-side Python runtime. These are worker capabilities, not desktop applications. Lazy registration does not launch either runtime. Runtime acceptance remains open; disabling coding or channels keeps the SaaS Office editing path available.

## SaaS/T16 and task recovery integration follow-up

This follow-up removes the standalone home question-answer entry (T16), not Office assistants or shared analysis/model capabilities. Default product commands now target SaaS. Desktop launch/package entrypoints and desktop-only utility APIs are removed from the active build/dependency graph; legacy desktop source directories still exist and are not claimed fully deleted. The lock was regenerated and checked against workspace manifests, including the shared Markdown renderer and explicit XML validation dependency.

The task-scoped `data receipt <commandId>` command and restarted external-process recovery checks are integrated. Office parent ledger routes, bounded continuation claims and separately reviewed token-correlated Docs/Sheets native lifecycle wiring are integrated. Scoped cancellation stops only the related native run; user work queued between continuations cannot settle a different parent. This is deterministic AgentLoop/HTTP/PG evidence, not browser E2E or third-party model acceptance.

The default SaaS `npm run build` completed all four browser bundles successfully without an installed Electron runtime. The composed candidate passed Web unit **553** (3 installed-runtime skips), Web HTTP **353** (1 S3 skip), shell **113**, data client/receipt **14**, and standard Web/server/Docs/Sheets/Slides/shell/CLI typechecks. Real PostgreSQL combined regressions passed **73** with **1** installed-builtin-runtime skip, including sources, quotas, realtime sessions, parent tasks and external-process receipt recovery. An initial concurrent verification attempt reported a ledger-test failure and did not finish; that test then passed independently, and the complete sequential PostgreSQL rerun passed. The initial attempt is not counted as a passing run.

The installed Codex path and historical full CLI suite were not retried after their initialization/external-network paths were blocked. No sandbox, socket permission or proxy setting was relaxed. These limitations remain distinct from the local synthetic process/HTTP/PG evidence above.

## Final native-wiring / latest-target verification

The integration also preserves all ten nonoverlapping files from target `66a11683` (#136) byte-for-byte. After the reviewed native-parent cancellation fix was included, the final Web suite passed **560** tests (3 runtime skips), shell **113**, and the native-parent/channel HTTP/PostgreSQL combination **20** without skips. Web/server, Docs, Sheets and shell standard typechecks were rerun successfully. All four default SaaS builds were rerun successfully. The earlier 73-test PostgreSQL run above overlaps these channel tests; counts must not be added as unique coverage.

The target's reservation/dispatch PostgreSQL regression passed **59** tests and the worker typecheck passed. These are candidate-ledger checks, not live systemd/OCI runtime acceptance.

A separate empty install directory with the exact final Web manifest/lock passed the CI command `npm ci --prefix apps/web --workspaces=false --include=dev --no-audit --no-fund` (412 packages). Only npm's cache location was changed to a writable workspace directory after the environment's default cache path was unavailable. Installed `mysql2` is 3.24.6 and `node-sql-parser` is 5.4.0; Electron cannot resolve. The Web lock checksum was unchanged by installation.

Legacy desktop source directories and historical desktop-oriented CI/e2e entries are not claimed removed in their entirety. No user files, stored conversations, source data, model configuration or artifact history were deleted by the T16/desktop entrypoint removal.
