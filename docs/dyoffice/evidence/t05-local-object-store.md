# T05 local immutable object store

> 2026-11-16 · Local store, HTTP stage/finish/download, in-process S3 adapter, and `dyoffice_files` rows · **RLS is pending T04. The in-process blob client is not a live S3 service and is not highly available. The prototype `/api/files` route is unchanged.**

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

## S3-shaped adapter

`createS3ObjectStore` uses a blob client with the same stage, finish, download, trash, restore, and purge operations as the local disk store. `createFakeBlobClient` is the in-process double. Its ETag looks like `W/"not-sha-…"`. The adapter stores and checks SHA-256 of the bytes. A caller-supplied `etag` does not change that digest. If the stored bytes no longer match, download fails with `HASH_MISMATCH`. A throw from `afterBytesWritten` leaves no staging record and no blob. Trash still consumes quota. Purging one owner keeps a blob another owner still references.

```sh
node --test apps/web/test/s3-object-store.test.mjs
```

The file passes against the in-process client. It does not open a network socket.

## File rows

`0003_files.sql` creates `dyoffice_files`. The object key and SHA-256 are constrained. The table references the identity user. The migration comment says row-level security is pending T04, and the executable SQL does not enable RLS or create a policy. `createFileCatalog` inserts a row only after `finishUpload`. If that insert fails, the object can remain and no completed row points at it. Download reads an active row for the requested owner and then checks the stored bytes. Another owner and a trashed row are `NOT_FOUND`. If the row is already trash and the object store update failed, `trashFile` retries the object update instead of returning `NOT_FOUND`. `scope.enforcement` is `pending-t04`.

```sh
node --test apps/web/test/file-catalog.test.mjs apps/web/test/files-schema.test.mjs
```

Those files pass. The schema test reads the migration text and checks that RLS is only named in a comment. The adapter uses the same staged-upload expiry as the local disk store.

## Abandoned staged uploads

An unfinished upload records `stagedAt`. After `stagedUploadTtlMs` (default 24 hours) it no longer counts against the owner quota, `finishUpload` returns `NOT_FOUND` for it, and the owner's next `stageUpload` removes the record under the owner lock. Its blob is removed only if no object or live staged upload still references the SHA-256. Without this, a client that lost its `finish` request kept those bytes on the quota permanently, with no way to discard them. Records written before `stagedAt` existed never expire.

```sh
node --test apps/web/test/object-staging-expiry.test.mjs
```

Before the change all three tests failed (quota stayed full, the expired upload finished, the unshared blob remained). After the change the file passes.

## Still open

Live S3 or MinIO, highly available storage, and T04 row-level security. The application owner filter is not a substitute for `FORCE ROW LEVEL SECURITY`.
