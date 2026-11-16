# T07 native DOCX save metadata and document-generation fences

Date: 2026-11-16. Scope: the existing native Renderer save pipeline and its Web bridge. This is not four-format, external Word, production, or complete T06/T07 acceptance.

## Defects and fixes

1. A page-color change while an older native save awaited its receipt did not change the ProseMirror document identity. The old bytes were reparsed, the new color was overwritten, and dirty state was cleared. The real `save()` regression failed with `expected null to be 'FF0000'` before the fix. Capture all non-PM serialization state and write-intent flags, compare against the latest React context after awaits, and keep newer state dirty without rebasing it from old bytes.
2. The Web bridge marked a successful-but-incomplete native save clean when only metadata changed. Its independent Node regression failed `false !== true` before the fix. An incomplete native result now retains unsaved UI state.
3. Independent review found that old saves could cross a document replacement. A real `save()` test failed because the old receipt returned success and changed the new document path. A `beforeSave` reconciliation test demonstrated one stale-path write where zero was required. Guard the original document generation before writing, after native receipts and parsing, before caching a newly created path, and before applying errors or lifecycle callbacks to UI state. Do not apply an old Save New path to a replacement pathless document.

The metadata comparison relies on React state replacement, matching the existing setters. It does not substitute for the server's owner/session/lease/revision checks. The server CAS and immutable receipt protocol are unchanged.

## Local verification

- Real native `save()` with actual DOCX serialization/reparse: 35 regression cases passed, including page color surviving the first stale receipt and being present in a second saved DOCX; 30 metadata categories; document replacement; pathless replacement; failure; and the pre-write reconciliation gate. Only desktop I/O is controlled by the test; this is not a browser result.
- Web bridge and existing generation guard: 7 Node tests passed, no skips.
- The browser regression added to `apps/web/test/native-docs/roundtrip.test.mjs` edits Page Color during a delayed HTTP commit, checks the unsaved state, saves again, verifies the DOCX XML and reloads. Its execution status must be reported separately; adding the test is not proof that Chromium ran.
- An initial `typecheck:web:docs` passed. Broad native type checking was interrupted by the environment killing the process; no compiler success is inferred from that interruption. Final verification results are recorded below when available.

JSDOM reports its existing unimplemented-canvas warnings on native save tests. These are not used as a substitute for visual comparison.

## Remaining boundaries

The T06/T07 plan now distinguishes historical ledger/simplified-editor notes from the current PostgreSQL/native Renderer paths. The prior “no ribbon” and “no LibreOffice” wording is not current environment evidence. Office installation does not establish DOCX compatibility: external-office roundtrip and visual evidence remain separate gates.

The unconditional `pagehide` disposal was noted as a potential back/forward-cache lifecycle gap. This pass has not reproduced it in a real browser and does not label it a confirmed bug or claim a fix.

## Final local environment attempts and CI handoff

- `NODE_OPTIONS=--max-old-space-size=768 npm run build:web:docs`: passed; existing bundle-size warning retained.
- `npm test --workspace @genoffice/docs -- --maxWorkers=1 --no-file-parallelism`, with a workspace TMPDIR and 768 MiB V8 heap cap: terminated by the host with exit 137 (`Killed`) before a final aggregate. No full-renderer pass is claimed.
- Real PostgreSQL native browser suite, default launch: the non-browser server-entry case passed; five browser cases failed before UI assertions because the required Playwright headless-shell binary was absent.
- Repeated against installed Chromium 156.0.8078.79 using a local-only preload that changed only `executablePath`: the non-browser case passed; all five browser launches were blocked by `socket() failed: Operation not permitted`. No extra launch flags or security settings were changed. The preload is not part of the PR, and this run is not a default-browser pass. PostgreSQL was stopped after each attempt.

The owner subsequently directed tests that cannot run locally to CI. The existing `DyOffice Web boundary gate` / `native-docx` job installs its Chromium, provisions its isolated PostgreSQL, runs native Web type checking, builds and executes the TLS browser suite, and regresses the complete Docs renderer and DOCX engine. This change adds the seven bridge/generation Node cases to that job. Repository Actions settings are not changed by this PR. A queued or newly created workflow is not a successful run; report results against the exact PR head.

Final bounded local rerun after the review fixes: four renderer regression files **85/85 passed, zero skipped** (including all 35 new cases), bridge/generation **7/7 passed, zero skipped**. With a 768 MiB heap cap, final native Web type checking (`tsc -p apps/web/tsconfig.docs.json`) passed. This does not replace the interrupted full-renderer suite or the blocked browser cases above.
