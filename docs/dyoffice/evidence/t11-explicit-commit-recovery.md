# T11 explicit commit recovery controller

Base d3db4d18. A private in-memory trusted service seam, not registered in HTTP/UI or a worker host. No OS isolation or durable restart recovery.

## Contract

The factory captures preparation inputs (including the session credential) immediately. Preparation runs exactly once. The immutable T06 commit payload is retained inside the controller. States are new, preparing, prepared, committing, unknown, saved and failed. Concurrent calls are rejected rather than queued. A failed prepare cannot be retried on the same attempt because an unknown staging result may already own an upload.

An explicit commit calls the existing T06 commitRevision. Failure after dispatch is classified conservatively as unknown, never as proof of rollback. Retrying from unknown reuses the identical upload/base/lease/idempotency payload; it does not rerun rotation or create another upload. Every commit invocation, including rechecking a known saved receipt, re-enters T06 authentication and receipt lookup. No cancellation or cleanup is attempted after dispatch. A revoked-session recheck rejects without erasing the already known saved fact. Returned receipt must match file/hash/size and a valid revision; once known, its revision cannot silently change.

No tokens or internal commit payload are returned by status/prepare. The service instance is a trusted internal object, not an authorization boundary itself. Process loss also loses its recovery state: production needs trusted durable attempt storage before exposing it to a restart-prone workflow. No automatic retries, polling or rollback is introduced.

## Evidence

Missing implementation produced RED. A new regression and independent reviewer exposed acceptance of a different revision on a known receipt recheck; RED was observed and fixed by retaining the known revision. Unit6/6 and independent6/6 passed.

Real PostgreSQL new2 + existing preparation7 =9/9 passed, independently repeated9/9. Synthetic PDF and restricted business/auth roles with local object store, not RustFS. The new loss-of-response test calls actual commitRevision, then throws after the database commit; explicit retry returns that exact receipt, one rotation/one upload and exactly two revisions (original plus saved). Reopened output has a 90 degree rotation. Logout then rejects another receipt recheck. Lease takeover before dispatch rejects repeated commits without another preparation or head change. Syntax and boundary checks (999 files, zero violations) passed.

## Scope limits

Ordinary Web default parallel run reported process-level failures in the existing PDF CMap and raster-budget test files (296 passed, 2 failed, 1 skip). No error details were available from that reporter; cause is not established and it is not counted as passing. Same-suite standalone serial TAP rerun passed 297 tests with 1 optional S3 skip, zero failures; subsequent default-parallel TAP rerun also passed 297/1skip/0fail. No tests were skipped or product workarounds applied. Original failure log is retained.

No HTTP/UI production assembly, global admission, native process isolation, CPU/RSS/time budget or durable attempt store. No browser/desktop, signed/encrypted corpus or full aggregate acceptance claim. A saved status is historical knowledge, not fresh access authorization; callers must handle failed receipt rechecks. Commit errors are reduced to stable codes; preparation errors retain the existing internal service behavior and need the usual HTTP error mapping if ever exposed. No dependency/schema migration; rollback removes unused controller and tests.
