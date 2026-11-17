# PDF receipt recovery in a fresh restricted process

Baseline: merged #139, `70e99c3a25c4a0dce4b25718485f4b3896ca23db`.

## Design and scope

Use the existing `pg` client, `createPrincipalTransactions` and `createPdfJobReceiptRecovery`, rather than a new protocol or SQL implementation. A private test Node process receives only the restricted business connection and current session required for lookup. Parent environment credentials are not inherited; parent and child assert the owner URL is absent. The child returns only the existing receipt or an allowlisted authorization-denied result. Unexpected failures remain test failures. Time/output limits bound the child, and stdout/stderr from both successful and unsuccessful child exits are checked for fixture credentials and private upload/idempotency identifiers.

This complements same-process recovery tests, not the Rust consumer work in #138. No production code, routes, broker, grants, migrations or runtime configuration change.

## Verification plan

1. Execute the real revision COMMIT, inject loss of its acknowledgement, revoke the old owner session and authenticate a new session.
2. Query from new Node processes with the restricted business role. Require old-session, other-owner and administrator denial; the new owner receives the original committed revision.
3. Independently save a later revision, then prove a fresh process still resolves the original historical receipt. Compare uploads, revisions, commits, outbox events, file head, job state and reserved bytes before/after recovery.
4. Inject failure before COMMIT (real rollback), and independently cancel a job. Each fresh reader returns exactly `unresolved`, without replay or mutation of those durable state counters.
5. Run the receipt suite and relevant PDF queue/claim/lease/input/Redis recovery regressions using real disposable PostgreSQL/Redis.

## Limits

The actual commit producer remains the parent test process; acknowledgement loss is a deliberate post-COMMIT exception, not a killed producer or network fault. The reader truly is a new OS process with a new connection and no inherited in-memory receipt. Session authorization performs its normal transaction and session bookkeeping; “read-only recovery” means no output upload, revision commit, replay, native-job transition or outbox mutation, not a claim of zero SQL writes.

The output PDF is constructed by trusted test code using pdf-lib. This does not exercise a native PDF backend, prove rotation execution authority, close T06 native execution-to-save, certify OS isolation, or enable production. No unsupported system backend is started. Production execution remains fail-closed.

The counter/state snapshots demonstrate only unchanged row counts and the specifically selected head/job/reservation fields. They are not a full database comparison and do not prove that every persisted column is unchanged.

## Results

The final reviewed receipt suite passed **11/11**, zero failed/skipped, exit 0. The combined queue/claim/lease/input/Redis recovery/receipt run passed **53/53**, exit 0, with real disposable PostgreSQL/Redis and Node 22.23.5. The receipt suite was rerun separately after the unsuccessful-child-output checking correction. Syntax and whitespace checks passed.

An earlier combined attempt passed 26 tests then failed 27 fixture creations with PostgreSQL `53100: No space left on device`. It is not counted as a successful run; after workspace space recovery the complete 53-test run passed. The existing environment-injected `UNDICI-EHPA` warning was suppressed by its specific code only; proxy configuration and safety assertions were unchanged. No CI or supported-host acceptance is claimed by these local results.
