# T11 authorized PDF save preparation

Base f42f9113. Isolated synthetic PDFs, disposable PostgreSQL databases/roles and local object store only. No real user files, HTTP registration or T10 files changed.

## Design and behavior

This internal session-side adapter takes a session credential and exact file/base revision, editor, lease epoch, request JSON and caller-selected idempotency key. It snapshots scalar inputs before awaiting. Existing getLease enforces files:write ownership/session authority before a processor receives bytes. The adapter rejects stale lease/current head or non-PDF format, downloads the exact authorized revision and checks its digest. The injected processor gets only bytes, request and signal, never the session credential. Output bytes are snapshotted and input/output digests and size checked.

The existing T06 stageUpload and receiveUpload perform fresh authority, head, lease and content checks. Preparation returns an immutable commitInput plus expected digest/size, not a save receipt. It deliberately never calls commitRevision or auto-retries. The trusted caller must preserve the returned commitInput and use the existing T06 commit/receipt replay when the outcome is uncertain, rather than generating another upload or re-executing rotation.

On failures after a known stage, cancellation is attempted without replacing the original error. Failed cleanup or a stage whose response is lost may leave an abandoned upload for existing TTL reclamation; immediate cleanup is not guaranteed. Cancellation of preparation cannot undo a separately committed revision.

## Verification

RED: new integration test failed with missing module. The first PostgreSQL invocation then failed ECONNREFUSED because its separate startup command did not keep the process alive; it was not counted as passing. Starting, testing and stopping the isolated cluster in one invocation resolved that environmental issue.

Seven real PostgreSQL tests passed: prepare leaves original head; explicit T06 commit saves rotated bytes and replay returns the same receipt; cross-user and stale lease reject before native input; lease takeover during processing rejects stage; incorrect source/output digest and size reject; concurrent head advance rejects stale source; abort after stage and lost receive response cancel drafts with reserved bytes returning to zero; session revocation blocks stage. Independent reviewer repeated the seven tests. These use actual restricted auth/business DB roles and local immutable object storage, not RustFS.

Syntax checks and browser-boundary scan (999 files, zero violations) passed. Ordinary Web regression: 297 passed, 1 optional S3 skip, zero failures. No aggregate/browser/desktop acceptance claim.

## Remaining boundaries

No OS isolation, CPU/RSS/wall enforcement, public API, UI, command approval integration or production assembly. The processor remains an injected trusted implementation; digest binding checks byte identity, not semantic correctness of arbitrary worker output. Production must supply an isolated worker controller and global admission policy before exposing this path. Signed/encrypted fidelity limits from the rotation core remain. This is a tested T06 preparation seam with explicit commit exercised in tests, not full T11 closure.

No dependency/schema/data migration. Rollback removes the unused adapter, test and evidence.
