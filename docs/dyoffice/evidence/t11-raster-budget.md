# T11 server PDF raster budget

Narrow resource safety change only. Original raster.mjs blob a9c78118979e6d29a05bb9cf8f33eaf743be2dbf matches current target. Server PDFium directly allocated width*height*4 without frontend-equivalent budgets.

Real 5000x4000 PDF reproduced missing rejection (RED). The preflight now rejects >64MiB input, >100 pages, >16 million pixels per page and >64 million pixels cumulatively, before any bitmap allocation. Page handles close in finally.

New real-PDF tests6/6, independently repeated6/6; combined PDF regressions19/19. Normal PDFium and PDF.js still run. Tests use an isolated foundation integration copy plus #91, not an exact clean target checkout.

Full npm test twice failed to start: sandbox /tmp/.git ENOSPC. No unrelated data removed or security changes. Earlier aggregate results are not results for this patch. Ordinary Web:273pass/1fail/1optionalS3skip. The failure is problem.test.mjs revision conflict (404 vs409), reproduced isolated. Its fixture hardcodes /tmp; a diagnostic copy changing only its temporary directory to workspace passes5/5. The repository test remains unchanged, and the broad run remains failed. This points to the full /tmp rather than this raster patch.

This does not bound PDF structure parsing/decompression before bitmap preflight. No GUI/PG retest, write operations, T06 persistence or full T11 closure. Real PDF editing, annotation, page writes and fidelity remain open.

## Current target integration

Rebuilt on exact target b66f2516c113d57d461b323e3b8827affaa28869 after #91 merged. The unchanged 7273 ordinary files were individually verified against its Git tree, and the original raster file also matched before applying this patch. The tracked native XLSX build symlink was not materialized; it is unrelated to this PDF test scope.

On this integration: PDF19/19, independent6/6 and node syntax pass; ordinary Web274pass/1optionalS3skip/0fail; boundary998/0. Previous /tmp-related failure is recorded above, not silently erased. No browser prerequisite is claimed; user deferred browser acceptance, not overall T11 acceptance.

Latest exact-target aggregate npm test did start and reached html2docx: docx-engine2239pass/1skip, pdf2docx825pass/7skip. html2docx features.test.ts and pagebg-restore.test.ts fail Chromium process_singleton socket() Operation not permitted; 41pass/70skip there. Later workspaces not reached, so no full-suite pass. Browser failure is disclosed despite being deferred as a merge prerequisite by the user.
