# PDF durable-command Redis recovery and closed execution boundary

Baseline: `feat/dyoffice-web` after merge #134 (`58306edb`). This slice adds integration coverage, not another queue, parser, execution adapter or production migration.

## Composition under test

`test/jobs/pdf-command-dispatch.test.mjs` uses the existing real services:

- `createTestPdfCommandQueue`: stores the canonical rotation command, native job and outbox in the existing transaction.
- `createJobDispatcher` and BullMQ `createJobQueue`: Redis carries only `jobId` and `deliveryEpoch`; it does not carry a command, owner, file path or credential.
- The actual restricted `createJobWorkerStore` claims in PostgreSQL. A newly spawned Node process reconnects with the restricted worker role and `createTestPdfClaimReader` reads the exact stored command and digest, not cached caller state.
- `createTestPdfInputPreparation` composes the existing claim reader, real job-bound edit lease, native authority verifier and bounded input-byte read. No backend receives database credentials.
- The actual **production** `createDocumentExecutionBoundary` rejects this control-plane observation with `DOCUMENT_BOUNDARY_UNAVAILABLE`. There is no substitute execution backend in these tests, not even a successful fake. A prepared observation is never described as an executable grant.

Candidate SQL is installed only in the disposable test database. Runtime registrations, enabled job types, HTTP routes, production migrations, OS settings and production fail-closed policies remain unchanged.

## Faults covered

1. Lost acknowledgement after a real Redis add yields duplicate opaque hints but only one PostgreSQL claim/attempt; a fresh process restores the exact command/facts.
2. Redis queue loss after acknowledgement is repaired from PostgreSQL outbox state without losing or reconstructing the command from user input.
3. A forged command field in a Redis hint is rejected before any claim. A later valid hint still works.
4. Missing command rows and command/digest tampering inconsistent with the immutable job request binding are rejected after dispatch, before input preparation can succeed.
5. A real forked BullMQ worker is killed with SIGKILL after receiving a PostgreSQL claim. The native job stays running, not falsely successful. After natural claim expiry and redelivery a new consumer receives a newer epoch/attempt. A fresh-process reader rejects the old claim, and its failure callback cannot overwrite the new claim.
6. Cancellation after dispatch makes the queued hint non-executable while retaining the command and original file revision.
7. Cancellation or session revocation after an actual Redis claim prevents subsequent command reads and input preparation, with no job revision commit.

The successful preparation paths confirm that boundary refusal leaves the file revision unchanged and the durable job still running. Test control code then explicitly records `NATIVE_FAILED`; completion of a BullMQ hint itself never marks a native job successful. Tests do not claim cleanup/termination of an OS process because no native document backend process is started (test Node worker/reader processes are forked).

## Scope and remaining gaps

All database and queue operations are real PostgreSQL/Redis with isolated roles and queue names. PDFs are synthetic and object storage is local. Owner-level command corruption is test fault injection, not a runtime-role capability. The restart test lets the claim expire naturally; forcing the outbox retry time only expedites redispatch. Child-process environments use an explicit runtime/locale allowlist plus the restricted worker fixture payload, not the parent environment. Both parent and child assert that the administrator `DYOFFICE_TEST_DATABASE_URL` is absent. Child-process stdout excludes claim credentials and storage keys. The killed child sends its private claim only over Node IPC to its test parent; the separate fresh-reader process outputs metadata only.

This is not positive PDF execution, runtime approval, OS isolation, output structural validation, T06 execution-to-save closure, or Ubuntu/openEuler certification. The production boundary remains closed. Because it rejects before reservation or backend start, these PDF tests cannot establish uncertain-capacity retention or stop-confirmed release. Those require the separate restricted-execution reservation suite and, ultimately, a supported positive PDF execution protocol; no positive PDF backend is fabricated here. Earlier queue/reader documents' “Redis not covered here” statements still describe their original slices; this additional slice supplies the composition coverage rather than retroactively changing their evidence.

## Verification

After the child-environment correction, the complete local jobs suite plus PDF command queue, claim and lease-controller integration suites passed: **76 tests, 76 passed, zero failed/skipped**, exit 0. The new Redis recovery file contributes 9 tests. Verification used Node 22.23.5 and disposable loopback PostgreSQL/Redis. Only the environment-injected `UNDICI-EHPA` warning code was suppressed for a pre-existing child-stderr assertion; no proxy configuration or security assertion was disabled. This is local integration evidence, not production deployment or native backend execution evidence.
