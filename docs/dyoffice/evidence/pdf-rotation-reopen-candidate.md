# PDF rotation repeated-reopen candidate

Baseline: `feat/dyoffice-web` at `3e6c9831a98408103319145fbe0e7e73c8a26b6a`, verified using the GitHub ref/tree APIs. The 31 existing PDF server modules, top-level PDF tests, PDF CSP module and root package manifest used by the focused run match their Git blob IDs at that commit. The work directory is an isolated copy, not a complete verified checkout of that commit.

## Verified scope

`pdf-rotation-reopen.test.mjs` uses real pdf-lib serialization, PDFium WASM rasterization and PDF.js text extraction. A three-page file with prior rotations, text, graphics and an annotation is rotated on two pages, serialized, reopened, inversely rotated and reopened again. The checks cover source immutability, input/output digests, angles, page dimensions/order, text, unchanged page pixels, annotation preservation, and exact original pixel/text restoration after inverse rotation.

This is a **byte-processing candidate**. It is not a public editing endpoint, production save, durable object-store test, browser interaction test or Docker isolation test. No capability gates or execution paths were changed. PDF original-text editing, annotation writing, redaction and formal container-mediated edit/save remain unverified/unsupported.

## Verification

- Existing focused PDF suite before addition: 58 passed, 0 failed.
- New test plus existing PDF suite and save-attempt unit tests: 65 passed, 0 failed, 0 skipped.
- Mutation check: suppressing page 2 rotation caused the new test to fail (actual angle 0, expected 270). The original implementation was restored immediately.

```sh
node --import tsx --test apps/web/test/pdf-*.test.mjs apps/web/test/unit/pdf-save-attempt.test.mjs
```

## Remaining closure criteria

1. An authenticated, container-internal zbus/private D-Bus/systemd worker must enforce identity, resource/time limits and source/output binding. No host execution fallback or weakened production gate.
2. Connect the accepted worker output to existing revision/lease/idempotency fencing and exact-revision download.
3. Run a real Ubuntu Docker test through the public browser flow: open, rotate, save, reopen after restart; plus lease loss, cancellation, forged output and recovery failures.
4. Keep capability labels precise. Page rotation does not establish original-text editing or secure redaction. Signed/encrypted/form PDFs remain refused by the candidate operation.

Wider verification is a supporting local snapshot run, not a claim that the entire target branch was verified. The first `apps/web npm test` attempt lacked copied workspace packages (330 passed, 20 failed, 1 skipped). After copying those packages, it reached 378 passed, 2 failed, 1 skipped: `auth-only-admission.test.mjs` and `orphan-reclamation.test.mjs` could not import `fromBufferPromise` because the reused root dependency was yauzl 2.10.0 instead of the web lock's 3.4.0. An isolated web-local yauzl 3.4.0 was restored without changing dependency manifests, locks or shared node_modules for the final rerun.

Final wider `apps/web npm test`: **388 passed, 0 failed, 1 skipped** (389 tests). This includes the restored production PDF implementation and the new regression. `node --check apps/web/test/pdf-rotation-reopen.test.mjs` also passed. The snapshot's non-PDF files were not independently checked against the target commit, so this does not replace exact-head CI or a clean lockfile installation.

## Publication check

Before creating the draft PR, the target was re-read as `5fe6b84636e71e74c0e84916ebab77c9f6184ca6` after #155. All 31 checked baseline blobs were unchanged, and neither new file existed in that target tree. The PR contains only this evidence note and the new regression test. Sample boundaries: three synthetic pages, Latin text, a rectangle and a text annotation on the unrotated third page. This does not establish rotated-annotation interaction fidelity, arbitrary PDF fidelity, CJK/font coverage, scanned-image fidelity, or a real container save/restart flow.
