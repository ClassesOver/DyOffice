# T14 next real App persistence input: mirror margins

Base 56342af. This bounded slice covers mirrorMargins and mirrorMarginsDirty only, in addition to the already separate page-color input. It is not a whole-App input fence.

## Reproduction and correction

Two regression cases failed on the prior implementation: an intent queued during native save, and an intent already pending when capture began, were marked complete (false saveIncomplete) despite requiring retry. Both failures are retained in the local evidence log.

The existing App boolean pair moves to its own synchronous external store, using the already reviewed page-color pattern without changing that store. Material setters immediately replace an opaque token; a layout commit acknowledges only its current token. Cleanup invalidates that acknowledgement, including unmount. No-op updates retain the token and functional setters read synchronous current state.

FileActionContext supplies an optional mirror-margin state getter. captureSaveMetadata retains all ordinary comparisons and checks the captured/current pair for pending or changed tokens. The original mirrorMarginsDirty ? mirrorMargins : undefined serializer contract and page-layout algorithms are untouched. An older snapshot can still be written; the fix prevents that save from consuming newer intent and lets the existing save-until-persisted path retry.

## Verification

Six focused renderer files: 69/69 passed, zero skips. Includes page-color regression, mirror margins layout tests, store lifecycle, actual React Suspense, metadata races, track-revision flags and save-until-persisted. Additional actual-store/native-save/disk-DOCX test confirms first old bytes remain non-mirrored while new intent stays pending, followed by settled retry producing mirrorMargins=true and clearing dirty. That fixture simulates the render acknowledgement; the separate hook test exercises React itself.

Native Docs entry TypeScript passed, exit 0, 1024 MiB cap. Actual DOCX Vite build passed in 14.75s, 768 MiB cap. The existing large-chunk warning remains, and jsdom canvas warnings are not visual acceptance.

Independent review found no blocking defect and repeated three files 43/43. The subsequent disk-DOCX test was independently repeated: 1 passed, 39 intentionally filtered. This is not a full-suite or full-App claim.

## Limits

Only this pair within one mounted hook is protected. Other metadata, mutable state, cross-App reconstruction, all export paths and full T14 mounting remain outside scope. Browser and desktop acceptance are deferred, not passed. No database migration, new provider, permission expansion or production data change.

## Complete Docs regression

The complete Docs Vitest command with one worker and 768 MiB cap finished: 526 files passed / 4 skipped (530 total), 6456 tests passed / 20 skipped (6476 total), exit 0, 803.75s. No failed tests. Skips are reported rather than counted as passes; the suite is not a browser/desktop acceptance. Full stdout/stderr log retained.
