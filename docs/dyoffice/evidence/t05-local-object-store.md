# T05 local immutable object store

> 2026-11-16 · Includes the recycle-bin slice on `cursor/t05-recycle-bin-afe4` · **Partial. Not S3, not RLS, not wired to HTTP upload.**

## Why this slice

T03b is in progress on PR #5 and PR #8. T03c is in progress on PR #10. T04 depends on that work. T05's owner-scoped bytes and format checks do not need those routes or row-level security. The store takes an owner id from its caller and does not decide who the caller is.

T02 checkboxes were already marked on `feat/dyoffice-web` before this branch.

## RED

```sh
node --test apps/web/test/object-store.test.mjs
```

Node v22.23.4. 3 failed, 0 passed. Each failure was `ERR_MODULE_NOT_FOUND` for `apps/web/server/src/storage/local-dev.mjs`.

## What landed

- `server/src/storage/validation.mjs` accepts DOCX, XLSX, PPTX, and PDF only. OOXML must start with a real ZIP local, empty, or spanned header. PDF must start with `%PDF-`. Empty files, oversized files, other extensions, and names containing a slash, backslash, NUL, or `..` are rejected.
- `server/src/storage/local-dev.mjs` writes one immutable blob per SHA-256. A client `etag` is ignored. `stageUpload` does not make bytes readable. `finishUpload` is owner-scoped and idempotent. Another owner gets `NOT_FOUND` for both the upload id and the object id. A throw after the temp bytes are written deletes that temp file and writes no metadata.
- The current personal upload route is unchanged. This store is not the enterprise S3 adapter and is not safe to treat as highly available.
- Quota reservation and upload completion are serialized per owner. Two concurrent uploads cannot both pass a limit their combined size exceeds, and overlapping `finishUpload` calls return one object id.

## GREEN

```sh
node --test apps/web/test/object-store.test.mjs
# 3 passed, 0 failed
```

`npm run test:web`, `npm run typecheck:web`, and `node tools/check-web-boundaries.mjs` are recorded in the pull request after the full run.

## Recycle bin and download

`downloadObject` returns finished bytes only to the owning caller. `trashObject` hides them and still counts them against the owner quota. `restoreObject` makes them readable again. `purgeObject` removes a trashed record and frees that quota. The content blob is removed only when no remaining object or unfinished upload references its SHA-256, so one owner cannot delete another owner's copy.

```sh
node --test apps/web/test/object-recycle.test.mjs
```

Before the methods existed this failed because `downloadObject` and `trashObject` were not functions. After the implementation the file passes.

## Still open

S3, mounting these operations on the live HTTP routes, PostgreSQL file rows, and RLS. Do not check the remaining T05 boxes from this note.
