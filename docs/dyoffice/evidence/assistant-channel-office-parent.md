# SaaS Office parent ledger slice

Baseline: PR #134 `9f269bc9f6fb0d37919f16c51a82905f2555e1ae`.

This slice adds an opt-in owner-only `/channels/:id/office-task` operation. It records a running Office parent only for the channel's current Office connection/epoch. It does not execute a model, broaden document permissions, or require normal chat to create a task. Existing session, CSRF, channel/file access and transaction/RLS gates apply.

Request ID reuse is exact: concurrent identical requests return the same persisted task; a changed instruction/connection binding is rejected. A changed connection cannot replay an old receipt. The existing 32 active-task limit, single Office-running-task slot and ten-minute root deadline remain in force.

Existing yield/wake now accepts exact retries only for the same claim and live connection, with identical child IDs. A continuation claim returns direct child results in dependency order, explicitly `untrusted`, bounded to the existing summary preview size, with truncation recorded. It does not include other members' tasks. Claims remain atomic, with new claim IDs; lost execution cannot be automatically retried.

## Real verification

PostgreSQL 17, disposable RLS databases with separately provisioned runtime roles. Existing local test cluster was started for the run and stopped afterward.

`node --import tsx --test apps/web/test/local-integration/assistant-channel-office-parent.test.mjs apps/web/test/local-integration/assistant-channel-store.test.mjs`: **15 passed, 0 failed, 0 skipped**.

New cases: concurrent idempotent parent creation; stale connection and wrong owner rejection; Office → peer → Office nested read while parent waits; service reconstruction and atomic continuation claim; early child result and repeated yield; session revocation; out-of-order multi-child results and bounded summaries; cancellation preventing another yield; real Fastify HTTP injection with strict payload, CSRF and trashed-document rejection. The parent entry and yield retry reproductions failed before implementation.

`tsc -p apps/web/server/tsconfig.json`: exit 0.

## Service-slice checkpoint and follow-up

At this service-only checkpoint the SaaS Docs/Sheets native run lifecycle was not connected. The subsequent reviewed integration adds token-correlated native editor wiring and cancellation propagation; see `assistant-channel-native-parent.md` for its separate evidence and remaining boundaries. Browser E2E, real model execution, and the second real harness adapter are not claimed. No T16 or desktop shell feature was added. No production flags were enabled.

Independent review found no blocking issue in the service slice. Added the review's requested waiting-peer replay/reconnect-fence and revoked-member claim tests; final 15-test run passed. A browser reconnect while its former task is running produces `unknown_outcome` and still requires reconciliation. A claim whose response is lost must not be blindly re-executed. This service slice does not promise automatic execution recovery.
