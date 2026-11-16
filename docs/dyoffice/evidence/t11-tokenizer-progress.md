# T11 PDF tokenizer progress safety

Scope: one malformed-PDF termination bug, not T11 closure. The original capabilities.mjs blob is a5a9e2042841cb84861efdeb893d1e5eb9cc65c6, byte-identical to feat/dyoffice-web at investigation. Tests used an isolated copy of the existing foundation integration checkout, not an exact fresh target snapshot.

The generic scanner considers `)` a delimiter but has no consuming branch for it. A stray closing literal delimiter therefore leaves index unchanged forever, blocking the synchronous inspection worker. Two real pdf-lib-generated documents reproduced this in child processes terminated after 5s. The fix rejects this malformed token as UNREADABLE. Comments, escaped parentheses and nested literal strings remain supported.

Verification:
- RED: 2 timeout failures, 1 valid-literal pass.
- GREEN: focused capabilities/pages/progress 9/9; independent reviewer repeated 9/9.
- All PDF tests: 13/13, including actual PDFium raster/text reopen, CMap and CSP checks.
- Ordinary Web tests using project tsx loader: 268 passed, 1 existing optional S3 skip, 0 failed. Initial incorrectly selected strip-types loader produced unrelated module/decorator failures; corrected invocation above passed.
- node --check passed; boundary scan 997 files / 0 violations.
- Actual npm test: docx-engine 2239 pass/1skip and pdf2docx 825 pass/7skip. Stops in html2docx: features.test.ts and pagebg-restore.test.ts cannot launch Chromium because process_singleton socket() is Operation not permitted. No security settings were changed. Later workspaces were not run; this is not a full-suite pass.

No browser editor GUI or database retest; no PDF editing/export was added. Real content text editing, annotation/page-operation writes, signature invalidation UX, supported-font fidelity, T06 persistence and end-to-end acceptance remain T11 gaps. T10 and T11 are parallel tasks that both depend on T07/T08, not on each other. No merge or production enablement performed.
