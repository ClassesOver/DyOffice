# T11 process-restart read-only receipt recovery

Base 56342af. Design confirmed: use existing durable T06 revision_commits instead of introducing a replay queue or another attempt table. No migration, public API or production assembly.

## Contract

`createPdfReceiptRecovery({transactions, token}).lookup(fileId, idempotencyKey)` uses a currently valid owner session, files read/write scope and a live, non-trash PDF. Ownership/file authorization occurs before the key query, preventing cross-user key-existence disclosure. The lookup uses owner/deployment/file scope and joins the saved receipt, committed session upload and saved revision, checking base revision, lease epoch, content hash and size consistency. No token or key is logged or returned. The caller must preserve and protect these recovery identifiers; a key is not authority, and no credentials are persisted by this helper.

The result is committed with a T06 receipt or unresolved. Missing is NOT failure and grants no replay or cleanup permission. Historical receipt lookup does not require the old lease/current head because it only reports a past committed fact. Current authentication is checked again by the existing transaction wrapper at transaction completion. After logout, a fresh valid owner session may look up the receipt; an old revoked session cannot.

This is business-read-only: no upload/revision/head mutation, account initialization, TTL cleanup, lease restoration, native invocation or commit call. Authentication bookkeeping may still touch session activity. The receipt proves a T06 save, not that rotation occurred or that object bytes remain readable. It does not recover uncommitted attempts.

## Verification

RED: integration test failed with missing implementation. Four real isolated PostgreSQL tests passed against restricted business/auth roles and synthetic PDFs with local object storage (not RustFS). One Node process performs an actual T06 commit and exits with code73 before emitting an acknowledgement. A separately spawned Node process authenticates and retrieves the same receipt. This is a process-exit/restart boundary, not a database or machine crash test.

Other cases cover pending/unknown keys with no side effects; cross-user enumeration rejection for both real and fake keys; admin without personal scope; revoked session rejection followed by fresh owner login success; later head and lease changes with historical receipt retrieval; trash rejection. Before/after business counts and head assertions guard against accidental replay. Synthetic credentials travel through child stdin, not command-line arguments or test output. Child processes have test deadlines and are not reused as production worker isolation.

Independent real PostgreSQL rerun4/4 passed. Syntax passed; boundary scan1000 files/0 violations. Ordinary Web explicitly serial TAP run297 passed/1 optional S3 skip/0 failures. Default parallel and full aggregate were not rerun in this slice; no browser acceptance claim.

## Limits

No HTTP/UI, automatic retries, permission grant, new persisted credential, durable pre-commit attempt recovery, OS sandbox or CPU/RSS guarantees. Non-PDF refusal exists but is not separately integration-tested in this slice. No browser/desktop or full T11 closure claim. Prior rotation signature/encryption corpus limits remain. Rollback removes unused lookup/test/evidence without schema changes.
