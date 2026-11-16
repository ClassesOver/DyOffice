# T06 revision transactions and single-writer leases

2026-11-15, baseline `c7ef194b`, branch `feat/dyoffice-web`. Experimental local file APIs now support staged saves, fenced leases, immutable commit receipts, historical downloads and restore-as-new-version. This is server/API correctness work. Native editor mounting, a finished workspace UI, incoming command authorization, outbox dispatch, OS parser containment and production release remain later work. Editor capabilities stay unsupported; no native Office roundtrip or enterprise signoff is claimed.

## Lease and upload authority

A lease is scoped to deployment/owner/file and bound to session, captured auth version and an explicit editor UUID. Two tabs sharing a Cookie must use different editor UUIDs; the second cannot silently acquire the first tab's live lease. Client editor IDs distinguish instances, not ownership. Owner authority still comes only from the server-validated session. The default lease lasts 45 seconds; clients should renew approximately every 15 seconds. Acquire is idempotent for the exact live holder. Renew requires the live epoch/editor/session/version. Explicit takeover compares an expected epoch and increases it; release expires the row, and reacquire increases the persistent counter. Epochs are never reset by deleting a lease row. Recycle also fences the old epoch, so restoring a file cannot revive an old draft's writer authority.

Migration 6 extends uploads with revision kind, captured base revision, editor/session/epoch and optional server-selected restoration source. A save stage verifies the current base and live lease under owner locks and reserves quota. It uses the existing metered validation and immutable byte-transfer path. Preflight/receive check the captured session and lease as well as size/type, auth version, state and upload deadline. Initial-import finish explicitly refuses save uploads; it cannot be used to bypass revision CAS. All retained versions and staging/orphan objects remain accounted under the T05 quota policy.

Lock order is session authority, storage account, upload, file, lease. Lease-only operations lock file then lease and never later acquire the storage account. Commits retain authority/file/lease locks through object verification and database commit. Final checks repeat upload deadline, live lease and database-time session validation; holding a row lock does not freeze time. Takeover and protected commits therefore have a defined lock/commit order, and expired/revoked/stale writers cannot advance the pointer.

## Save commit and replay

`commitRevision(token, SaveInput)` uses the T01 shape: fileId, uploadId, baseRevision, idempotencyKey and leaseEpoch, plus optional sourceCommandId. Request IDs/epochs are validated and UUIDs canonicalized. Body fileId must match the URL. Caller owner/role/object-key/hash fields are rejected. The transaction:

1. Authenticates the current owner and locks the storage account.
2. Looks up an owner/file/key receipt. An exact canonical request hash returns its original RevisionRef; a different request under that committed key rejects 409. Replays need current owner authorization but do not require the old lease or head to remain current.
3. For a new commit, checks the ready upload's file/base/session/editor/epoch/version, the actual current head and live lease. It reads the real immutable object and recomputes size/SHA-256 through the adapter.
4. Inserts the child revision, CAS-updates current_revision, consumes upload, transfers reserved quota into retained storage, inserts the immutable receipt and appends one outbox intent, in one PostgreSQL transaction.
5. Rechecks upload/lease time and session authority before commit. Only transaction success returns a RevisionRef.

Two drafts on one base have one winner; the losing ready upload remains preserved, not overwritten or declared saved. Concurrent identical requests create one receipt/revision/event. A failed transaction leaves no successful receipt, pointer change or quota consumption; the immutable staged object remains for a retry. This is not a distributed object-store/DB transaction, and failed attempts are not claimed as committed receipts. The HTTP response is not an external delivery acknowledgment.

The optional sourceCommandId is recorded as **requested_source_command_id**, an unverified client label included in request hashing. It does not authorize a command, change command state, become trusted audit attribution or enter the outbox payload. T17 must validate real command/approval provenance before enabling that workflow. The trusted revision source is server-selected import/save/restore.

`revision_outbox` is append-only for the current business role and contains only server-derived file/revision/base/source metadata. A unique revision/event boundary prevents duplicate intents. It has no implemented publisher/ack/retry loop here; `published_at` remains for T08's separately authorized dispatcher. Initial imports retain their T05 protocol; this checkpoint's outbox event specifically covers saved/restored revision commits, not all future lifecycle/audit events.

## History, restore and schema boundary

Historical download resolves the exact owned file/revision tuple, including an older retained revision after the head advances. It never substitutes current bytes for the requested revision. Recycled files remain unavailable until restored. History lists are bounded and ordered by database timestamp/UUID; cursor timestamp comparison stays inside PostgreSQL so JavaScript millisecond conversion cannot skip microsecond-separated rows. DTOs omit object keys and auth metadata.

A historical restore first reads verified owned source bytes, stages a new object/upload with server-selected restored_from, and returns its upload ID. The caller then uses ordinary SaveInput commit against the current base and live lease. Restore thus creates a new child of the current revision, preserving all intervening history and the old immutable object. It never moves the head backward. Stage-response loss follows T05 pending-object retention/accounting; this API does not pretend the two-step workflow has already committed before receiving the commit result.

Migration 6 is additive to immutable versions 1–5: it adds session ownership uniqueness, allows multiple uploads per file, adds scoped upload/base/restoration/session constraints, extends revision source/parent constraints, and creates edit_leases, revision_commits and revision_outbox. All new personal tables use FORCE RLS and composite owner/file references. Runtime business rights are narrowly checked: lease SELECT/INSERT/UPDATE, receipt/outbox SELECT/INSERT only, existing revision rows SELECT/INSERT only. Auth has no access to those personal tables. SQL migrations own constraints; Drizzle mappings support typed reads. Shared query helpers were extracted from T05 while preserving its full regression suite.

Run the migration-owner provisioning CLI before starting the new restricted runtime. Startup verifies version/checksum and grants; it never performs DDL or falls back to owner credentials. A v5 upgrade test preserves a real imported object's bytes, pointer/hash/quota, import state and active login session. That schema-upgrade fixture uses a disposable administrative connection; separate business/API/RLS tests use genuine nonsuperuser owner/auth/business logins and do not use that fixture as a runtime isolation claim.

## Executed evidence and review

Initial tests were RED because the lease/revision services were absent; the HTTP route case initially returned the unimplemented 501. Core tests then passed for same-Cookie editor separation, renewal/takeover fencing, same-base races, immutable history, owner/file-scoped receipts, exact retry, quota, real S3 objects and transactional outbox failure rollback. Real object-read barriers let lease/upload deadlines pass and prove no metadata/receipt/event survives rejection. B/Admin cannot access another owner's history, lease or upload; raw no-context SQL sees no rows, auth cannot read the new tables and business cannot mutate immutable receipts/outbox history.

Additional actual RED-to-GREEN regressions:

- A JS Date cursor returned one of three revisions at distinct PostgreSQL microseconds; SQL-side anchor comparison now returns all three in order.
- Uppercase configured deployment UUIDs passed identity lookup but failed object-key validation; the business principal now uses a canonical deployment UUID.
- Initial import finish retry returned a later save's moving head; it now returns the immutable original import revision, which remains downloadable after head advancement.
- Same-size corruption of a ready save object fails verified read without advancing head or creating receipt/outbox references; the previous current original remains readable.

One independent fresh read-only review reported no concrete Critical/Important/Minor finding in the reviewed scope. It inspected code and tests without mutating database/object state; author tests supply executed results. No second review is claimed. Historical T03c action-token retention remains deferred. Retention/reclamation of revisions, uploads, receipts, sessions/leases and events still requires T20/T24's bounded policy and reference-aware collection; this checkpoint retains rather than unsafely deletes them.

Chromium over actual local TLS performs initial import, acquires an editor lease, sends modified real DOCX bytes, commits/retries, takes over, rejects the old editor, stages history restoration, commits a new restored revision and verifies exact old/new downloads. The browser helper initially sent an empty application/json body for bodyless finish and got 400; it now omits that content-type when no JSON exists, preserving all expected server statuses/byte assertions. This is API/Cookie/network behavior, not native renderer editing. The existing save-generation unit suite still verifies an old response cannot mark newer edits saved; actual renderer wiring is T07.

Final observed gates:

- `npm run test:web:integration`: 108 passed, zero failures/skips, including 18 revision/lease cases and v5 file/object/session upgrade preservation.
- `npm run test:web:storage`: 21 passed against actual disk/S3/worker validation.
- All Web unit tests: 37 passed, including the save-generation guard; legacy Web suite: 32 passed; build smoke tests: 2 passed.
- `npm run test:web:e2e`: 5 real Chromium/TLS/PostgreSQL cases passed, including commit/retry/takeover/history restore.
- `npm run typecheck:web`: passed.
- Actual Node 22 run of revision/file/startup/session/RLS/revocation/migration/browser suites: 83 passed, zero failures/skips.
- Baseline/CI/IPC regressions: 12 passed. Compatibility inputs: 84, zero drift. Browser graph: 22 files, zero violations. `git diff --check`: clean.

These are local execution results, not a GitHub Actions, native Office compatibility, production, outbox-delivery or customer-acceptance claim. No dependency update or earlier migration checksum rewrite was needed.

## Remaining work and recovery

T07 must connect the native DOCX renderer, BrowserHost save transport, fonts/workers, selection/serialization and the existing save-generation guard. Other formats, real model tools and verified external commands remain their planned tasks. T08 implements authorized durable jobs/outbox dispatch. T20/T24 supply retention, reference-safe reclamation, audit and recovery; every retained version currently counts toward quota. Worker JS heap/time limits do not replace OS/native allocation containment or malware scanning, so experimental APIs remain for isolated authorized fixtures and production remains guarded.

No production resources or customer files were changed. Reverting source alone is not a rollback of schema 6 or immutable objects; use a backup/compatible recovery plan and preserve applied checksums. Do not delete rows or rewrite earlier migrations to force an old binary to report ready. Full implementation-plan and enterprise completion remain unproven and active.
