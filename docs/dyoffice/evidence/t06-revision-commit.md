# T06 revision commits, history, and single-writer leases

> 2026-11-16 · Development ledger. Not a live PostgreSQL pool, not RLS, not S3, and not an XLSX editor.

## Why this slice

T05's local object store is already on `feat/dyoffice-web`. Login and resource-isolation work is proceeding separately. Revision commits need an owner id supplied by the caller; they do not decide who the caller is. The personal development token maps to one fixed principal (`personal` / `dev` / `dev-personal`). Request bodies cannot choose an owner.

The Web process commits through `createMemoryJournal` / `createFileJournal`. That queue is the transaction: a thrown callback publishes no revision, idempotency row, or outbox event. `server/db/migrations/0004_revisions.sql` is the PostgreSQL shape of the same ledger and is applied by the existing migration runner. This process does not open a database connection to commit a revision. Row-level security remains T04.

The running server uses the same local object store and `dev-personal` owner as the development object HTTP routes. Revision calls do not choose a different owner.

Only the existing DOCX paragraph editor calls these interfaces. Other formats stay import/download. There is no spreadsheet save path.

## RED cases

`apps/web/test/integration/revision-commit.test.mjs` covers:

- two commits from the same base: one new head, one `REVISION_CONFLICT`, one outbox event
- stale `leaseEpoch` after takeover and after the 45 second TTL
- the same idempotency key with different bytes: `IDEMPOTENCY_CONFLICT`
- object write succeeds, journal transaction throws: no revision points at the object; the retry commits that same object
- a missing object never becomes a revision
- a lost response retried with the same key returns the original revision
- a commit acknowledgement does not mark edits made during that save as saved (`createSaveGenerationGuard`)
- restore creates a new revision id that reuses the historical object
- another owner gets `NOT_FOUND`
- the file journal reloads and replays the same revision

The DOCX HTTP test additionally renews, takes over, fences the old epoch, and restores the original bytes.

## What landed

- `commitRevision(principal, saveInput)`, `restoreRevision`, `acquireLease`, `renewLease`, `takeoverLease`
- `POST /api/v1/files/:id/leases/acquire|renew|takeover`, `POST /api/v1/files/:id/commits`, `POST /api/v1/files/:id/restore`
- DOCX paragraph save, upload commit, and history download use the same ledger
- The paragraph page renews its lease before save and every 15 seconds while it is open
- A DOCX retry is applied to the bytes of its named base revision. Replaying an older revision returns that revision, and the legacy file is rewritten from the current head rather than from the replayed revision
- Outbox rows are recorded inside the commit. Nothing delivers them (that is T08)

Default lease TTL is 45 seconds. Takeover always advances the epoch. A second session cannot acquire a live lease. The development token is one session id, so two browser tabs fence each other by takeover on open, not by a second user id.

## Still open

Live PostgreSQL transactions, row-level security, more than one server process, S3, job dispatch from the outbox, and the native Docs ribbon. Do not treat this ledger as a multi-replica lock.
