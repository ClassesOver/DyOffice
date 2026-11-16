# T10 private one-shot PPTX job seam (local candidate)

## Implemented

`createPptxJobProcessor().execute(bytes, requestJson, signal)` accepts exact version 1 `roundtrip` or `setText` envelopes. It snapshots bytes before its first await, parses a bounded JSON string, delegates only whitelisted native operations to the existing session and returns native archive bytes after structural reopen with the same ZIP gate/native parser. Output includes SHA-256 and clearly named localGeneration, not a durable revision or save acknowledgement.

Limits: 32 MiB input/output, 256 KiB UTF-8 protocol, at most 100 operations via the existing session validator, one active call per instance with BUSY rejection and no queue. Existing session ZIP/history limits still apply. Errors do not propagate native exception text/document content. Cancellation prevents returning output and releases the per-instance active slot.

## Local verification

- New job protocol tests: 15/15.
- Existing PPTX session and native roundtrip: 19/19.
- Combined: 34/34, no skips.
- Strict focused TypeScript for both worker modules passed, using repository ambient declarations.
- RED checkpoint: 14 assertions failed against NOT_IMPLEMENTED placeholder before implementation.
- Original native output reparsed successfully, changed text verified and SHA-256 recomputed independently in tests. Concurrent invocation rejected, mutable input overwritten after call did not affect output, cancellation and error paths released capacity.

## Non-claims

This is NOT formal T08/T06 integration, not an OS isolation mechanism and not a production endpoint. No routes, SQL migrations, host executable configuration or persistent data were changed. Per-instance caps do not bound aggregate factories, hard RSS or CPU; cooperative cancellation cannot interrupt synchronous parser work. Output reopen checks structure, not all rendering or Office compatibility. GUI and desktop acceptance are not performed. See the plan for precise integration dependencies.

Independent review and broad suite results are recorded separately below when complete.

## Independent review and broad-suite limits

Independent reviewer reran initial 14/14 and focused TypeScript, found no blocker in this private-only scope. Added reviewer-requested archive fidelity test: every uncompressed ZIP part equal on roundtrip; all parts except edited slide XML equal after setText. UTF-8 request limit tested using 100000 Chinese characters.

Attempted full Slides `vitest run --maxWorkers=1` with a 768 MiB heap and 90 second wall limit. It timed out (exit 124) after multiple suites failed imports before execution, with missing canvas warnings. This is not a full-suite pass. Reproduced `history.test.ts` alone: cannot resolve `pngjs` from `src/main/tiff-decode.ts`; no tests executed. This dependency failure is separate from a demonstrated product regression. Broad attempt suites reporting zero tests before timeout:

- `tests/edit-fidelity.test.ts`
- `tests/edit-ops.test.ts`
- `tests/slide-script.test.ts`
- `tests/generate-deck.test.ts`
- `tests/slide-media-ipc.test.ts`
- `tests/redact-ui.test.ts`
- `tests/durable-identity.test.ts`
- `tests/stage-refit-follow.test.ts`
- `tests/selection-chrome.test.ts`
- `tests/animation-equation-ops.test.ts`
- `tests/layout-tools.test.ts`
- `tests/pptx-hostile-fuzz.test.ts`
- `tests/pdf-export.test.ts`
- `tests/arrange-ops.test.ts`
- `tests/apply-ops-tool.test.ts`
- `tests/history.test.ts`
- `tests/print-slides-ipc.test.ts`
- `tests/slide-qc.test.ts`
- `tests/data-source-gate.test.ts`
- `tests/table-cell-edit-formatting.test.ts`
- `tests/ai-panel-run-lifecycle.test.ts`
- `tests/read-colors.test.ts`
- `tests/file-naming-save.test.ts`
- `tests/regenerate-slide.test.ts`
- `tests/show-menu-click.test.ts`
- `tests/ai-picture-tools.test.ts`
- `tests/op-docs-examples.test.ts`
- `tests/redact-prompt.test.ts`
- `tests/save-serialization.test.ts`
- `tests/slide-progress.test.ts`
- `tests/scratch-block.test.ts`
- `tests/insert-shape-undo.test.ts`
- `tests/ai-panel-collapse.test.ts`
- `tests/slide-lifecycle-dirty.test.ts`
- `tests/op-docs.test.ts`
- `tests/tiff-decode.test.ts`
- `tests/svg-theme-retint.test.ts`

Final independent reviewer reran the completed 15-test job suite: 15/15 passed, with no blocker in this restricted scope. Implementation unchanged after review; focused TypeScript rerun passed.
