# Harness committed-delivery receipt recovery

Scope: incremental implementation against PR #134 head `a5a8d181fab4191bbf6e9c69cb7a2bae59ccfed7`, unified data plan F (lost response) and H (expired input).

## Operation

After a lost `artifacts.commit` response, use the existing shared data transport:

```sh
genoffice data execute artifacts.get_receipt --args '{"commandId":"<original-command-uuid>"}'
```

The operation takes only `commandId`. It requires the original live task credential and current owner session/claim authorization. It reads the existing durable owner receipt and additionally matches task ID, claim ID, epoch and command ID before returning it. It does not query sources, reread input snapshots, stage objects, or repeat commit. Therefore an input snapshot expiring after a successful commit does not prevent receipt recovery. Returned values and the trusted delivery cache are independent copies.

A missing receipt is an error, not permission to change the command ID or automatically rerun a query. Expired/revoked grants cannot use this operation. Owner-session recovery after the task has ended remains the existing `GET /api/v1/agents/deliveries/:commandId` route. This addition does not implement persistent task-grant reissue, background reconnect or editor insertion/save.

## Verification

- Task data-access unit suite: 16 passed, 0 skipped. New positive recovery test failed before implementation; recovery passed after adding the operation. Includes cross-task/claim/epoch/command rejection and claim revocation while reading storage.
- Real PostgreSQL 17 integration: synthetic frozen snapshot plus local ObjectStore, real sessions and RLS. A committed delivery remains readable after its pending input expires; another task, another owner, expired task credential and logged-out session cannot recover it. Receipt count remains one.
- `npm run typecheck:web` passed for this verification snapshot (frontend and server TypeScript).
- No external source, real model endpoint, customer data or credential transmission was used.

### Historical pre-integration snapshot (superseded)

The following records the earlier, unintegrated attempt, not the current branch result. These runner/fixture failures were subsequently resolved during integration; the integrated Web suite passed 553 tests with 3 runtime-dependent skips, as recorded in `harness-integration-134.md`.

The working verification snapshot combines exact PR #134 data/DB files with the existing local target snapshot for unchanged test dependencies. It is not a fully reconciled PR #134 merge candidate. The attempted broad `npm run test:web:unit` run had 486 passed and 12 failed: nine authority-fixture tests, bridge schema/assembly tests and a Node native TypeScript-strip failure in source-wire-budget. These are not reported as passing or as proven unrelated. Full integrated branch typecheck, regression and editor E2E remain required after synchronization.

## CLI and restarted external-process checkpoint

The shared client and CLI/helper now expose `data receipt <commandId>` (the low-level `execute artifacts.get_receipt --args ...` remains the same protocol). The command uses the existing task grant; it cannot recover another task's receipt and is not a new owner-wide recovery endpoint. The coding-task instructions direct a lost commit response to receipt lookup rather than another source query or commit.

A real PostgreSQL/RLS + local HTTP + independently restarted Node fixture exercises this command after the frozen input expires. It checks identical committed artifact IDs, one original source query, one delivery row, rejected cross-owner/same-owner-other-task/revoked access, and continued owner access to durable artifacts after the task directory is removed. The process is a deterministic external fixture, not a third-party agent/model compatibility claim.

New command tests cover authenticated read-only dispatch, identifier validation, cancellation before transport, rejection of unrelated flags, and denied reads without retry or upstream diagnostic disclosure. Tests first failed with the previous CLI/client (four failures), then passed with the implementation.

Installed Codex was not accepted in this environment: its startup encountered a sandbox helper initialization error, and the installed runtime's attempted external initialization is outside this local-fixture-only test scope. Testing stopped without changing sandbox/network settings. No locked offline Python runtime is present in this checkpoint; previous historical runtime evidence is not a current-environment pass. The full Unix-socket CLI suite remains subject to the separately recorded environment limitation.

SaaS scope is unchanged: the command is a server/worker data capability. It does not add an Electron dependency or revive the removed T16 home question-answer entry.
