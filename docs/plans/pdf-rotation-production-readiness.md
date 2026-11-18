# PDF first-edit slice: page rotation admission and acceptance contract

Status: **not production-enabled**. This document and its regression tests do not enable PDF editing. The first intended slice is quarter-turn page rotation, save, reopen and export. Text editing, redaction, annotations and reordering remain out of scope. View rotation is not durable editing.

## Current architecture verified at 35abf2a

- `DocumentPreview` downloads an authenticated exact revision and `mountPdfEditor` renders it. The Web shell excludes PDF from native editing, and `buildLocalApp` reports `pdf: unsupported`.
- `rotatePdfPages` / `createPdfRotationJob` process real PDF bytes and can reopen output. They reject signed/encrypted/form-bearing or out-of-budget documents. They are private parser helpers, **not sandboxed services**.
- `createTestPdfCommandQueue`, claim/lease/input preparation and prepared-context/package adapters are test-only. Candidate SQL is not a production deployment migration. A prepared package is not an executable authority grant or proof of isolation.
- `createPdfSavePreparation` and `createPdfSaveAttempt` demonstrate T06 staging/commit and exact-payload retry semantics. The processor is injectable trusted configuration; it is not yet backed by an admitted production runtime.
- Default `createDocumentExecutionBoundary` and broker backend refuse execution. The test execution boundary currently coordinates a PPTX outline command, not a general PDF executor.
- Recovery HTTP composition exists separately but is not mounted by the real app. A recovery receipt does not authenticate parser output.

## Missing safe connections, in required order

1. **Public intent and approval**: specify the authorized PDF rotation command using the existing command journal (or a reviewed equivalent), including file/base revision, editor generation, lease epoch and normalized operations. Do not add `pdf.rotate` to the public jobs enum as a shortcut. Provider/model input may propose intent; it cannot grant runtime authority.
2. **Durable job binding**: production migration and restricted-role grants for command digest, owner/deployment/job binding and replay-safe admission. Promote candidate SQL only after real PostgreSQL RLS/cross-owner/privilege tests.
3. **Runtime registration/admission**: immutable PDF engine artifact digest, Ubuntu Docker + private D-Bus/zbus/systemd runtime policy, no host socket/privileged fallback. Prove the actual runtime, resource limits, no-network and input identity before parsing.
4. **Execution boundary**: add PDF rotation to the real typed command protocol, matching request/handle/generation. Recheck current authority before launch and before output delivery. Uncertain start/stop retains quarantine; it cannot be interpreted as “not running”.
5. **Artifact authenticity**: accept only the output tied to the exact admitted attempt, base revision/input digest and runtime. Check bounded size/hash, seal/provenance, PDF reopen, page count and allowed rotation delta. A valid hash alone is insufficient.
6. **Trusted save**: feed admitted output into T06 stage/commit; do not parse inside the API process or let a browser-supplied path/receipt authorize it. Stale head, lease loss, revoked session, wrong owner and cancelled/expired job must never advance the revision.
7. **Browser command lifecycle**: only show enabled rotation after an authoritative capability response. Keep a dirty/inflight/unknown close guard. Capture target file and revision once, prevent overlap, reject late results after tab/account changes, and never re-run rotation to recover an unknown commit.
8. **Recovery**: persist the exact attempt/recovery binding on the trusted side. Reconcile the existing T06 receipt, including after restart. Retrying the same commit must not duplicate rotation, upload or revision. A lookup miss/transport error remains unresolved, not “safe to redo”.

## Acceptance matrix for enabling the slice

All successful rows require a real authenticated session, real restricted PG, real object store, admitted isolated runtime and actual browser. Existing helper/stub tests do not substitute for these rows.

| Scenario | Required result |
|---|---|
| Import 2-page PDF; rotate page 1 by +90; save; close; reopen; export | New exact revision; original revision untouched; page 1 dimensions/rotation changed; page 2/text/annotations preserved; exported hash matches committed bytes |
| Rotate the saved revision -90; save and reopen again | Second new revision restores original orientation without duplicate transforms |
| Signed/encrypted/forms/unsupported structure; invalid or oversized operations | Explicit refusal before staging/commit; original head unchanged |
| Two accounts/two tabs; head or lease changes during processing | No foreign read/write; stale attempt cannot commit; correct draft retained |
| Logout/revocation/cancel/expiry at each await boundary | No stale output publication; no blanket automatic lease release |
| Runtime unavailable, wrong digest, unknown stop, output-binding mismatch | Fail closed; no parser fallback in API/browser; no fake successful receipt |
| Commit succeeds but response is lost | Exact receipt reconciliation; one rotation/upload/revision, never a new command |
| Process/container restart with unknown commit | Durable trusted recovery or explicit unresolved state; no silent data loss or automatic re-execution |
| Long list/mobile UI | Rotation controls and save state remain reachable; no unbounded page DOM or hidden unsafe operations |

## Regression coverage delivered here

`apps/web/test/pdf-edit-admission-contract.test.mjs` executes actual Fastify job-route schema admission (auth stubs only), verifies default boundary/broker refusal, and checks test adapters refuse production/development/unset NODE_ENV without touching storage. It deliberately confirms that existing XLSX jobs still reach their service.

Run: `cd apps/web && node --import tsx --test test/pdf-edit-admission-contract.test.mjs`.

This is an **admission/negative contract**, not a successful end-to-end PDF edit. Real rotation byte tests, real-PG T06 tests and the eventual Ubuntu/browser acceptance must be reported separately. Do not change the public capability from unsupported until the positive acceptance matrix and independent security review have passed.
