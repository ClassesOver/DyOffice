# T05 local immutable object store

> 2026-11-16 · Includes recycle bin, HTTP download, and HTTP stage/finish for the personal dev token · **Partial. Not S3, not RLS. The prototype `/api/files` upload route is unchanged.**

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

`downloadObject` returns finished bytes only to the owning caller. `trashObject` hides them and still counts them against the owner quota. `restoreObject` makes them readable again. `purgeObject` removes a trashed record and frees that quota. The content blob is removed only when no remaining object or unfinished upload references its SHA-256, so one owner cannot delete another owner's copy. The staging record is published before the shared blob is installed, and deletion of that blob takes the same per-hash lock, so a purge cannot remove bytes that a concurrent upload has already claimed.

```sh
node --test apps/web/test/object-recycle.test.mjs
```

Before the methods existed this failed because `downloadObject` and `trashObject` were not functions. After the implementation the file passes.

## HTTP download

`GET /api/v1/objects/:objectId` reads the local store for the personal dev token. The owner id is fixed on the server (`dev-personal`). The request cannot name another owner. Missing, unfinished, trashed, and other-owner ids return JSON `文件不存在` and do not send `Content-Disposition`. A successful response is the stored bytes, with `X-Content-SHA256` set from the verified digest and no `ETag`. Admin receives 403. `POST` receives 405. The prototype `POST /api/files` route still writes the old file directory, not this store.

```sh
node --test apps/web/test/object-download.test.mjs
```

Before the route module existed this failed with `ERR_MODULE_NOT_FOUND`. After the route, the file passes.

## HTTP upload

`POST /api/v1/objects` stages bytes for `dev-personal` only. The response includes the server SHA-256 and `finished: false`. A client `X-Content-SHA256` or `ownerId` query does not change the digest or the owner. `POST /api/v1/objects/uploads/:uploadId/finish` publishes one object id and repeats that id on a second call. The object cannot be downloaded before finish. Another owner's upload id finishes as 404. Empty files, unsafe names, and a DOCX name with non-ZIP bytes return JSON 400. A second object that would exceed the owner quota returns 413 and stores nothing for that call. Admin receives 403. `POST /api/files` still writes the prototype directory.

```sh
node --test apps/web/test/object-upload.test.mjs
```

Before the routes existed both tests received 404 instead of 201. After the routes, the file passes.

## Still open

S3, PostgreSQL file rows, and RLS. Do not check the remaining T05 boxes from this note.
