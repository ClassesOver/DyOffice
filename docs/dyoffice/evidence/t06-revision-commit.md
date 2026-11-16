# T06 revision commits, history, and single-writer leases

> 2026-11-16 · Development ledger. Not a live PostgreSQL pool and not an XLSX editor. Row-level security for these tables is in T04 migration `0005_rls.sql`.

## Why this slice

T05's local object store is already on `feat/dyoffice-web`. Login and resource-isolation work is proceeding separately. Revision commits need an owner id supplied by the caller; they do not decide who the caller is. The personal development token maps to one fixed principal (`ownerId` `dev-personal`, deployment `dev`, session `dev-editor`). Request bodies cannot choose an owner.

The Web process commits through `createMemoryJournal` / `createFileJournal`. That queue is the transaction: a thrown callback publishes no revision, idempotency row, or outbox event. `server/db/migrations/0004_revisions.sql` is the PostgreSQL shape of the same ledger and is applied by the existing migration runner. This process does not open a database connection to commit a revision. T04 enables and forces row-level security on these tables in `0005_rls.sql`. The dev principal is still supplied by the caller on the journal path. See [t04-row-level-security.md](t04-row-level-security.md).

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

## Closeout

T06's save behavior is complete on the development ledger. The Web process proves the rules below with tests. Items that belong to a later task are listed as deferred instead of left implicit.

### Done

| Behavior | Proof |
| --- | --- |
| `commitRevision` from a staged object, one new head | `revision-commit.test.mjs` concurrent same-base case |
| Same base, two callers: one commit and one `REVISION_CONFLICT` | same test; the conflict does not add an outbox row |
| Stale `leaseEpoch` after takeover or after the 45s TTL | lease test; expired renew is `LEASE_CONFLICT` |
| `acquireLease` while another live session holds the file | `LEASE_HELD`; takeover then advances the epoch |
| `renewLease` extends only the current holder and epoch | lease test |
| Same idempotency key, different bytes | `IDEMPOTENCY_CONFLICT` |
| Lost response, same key and bytes | original revision, no second history or outbox row |
| Object durable, journal transaction fails | no revision or outbox row; retry commits that same object |
| Journal persist fails after the decision | memory ledger stays unchanged; retry commits |
| Missing object | no revision row |
| Restore of history | new revision id, same object; stale base is `REVISION_CONFLICT` and the head stays |
| Late save response versus newer edits | `save-generation.test.mjs` and the generation case in `revision-commit.test.mjs` |
| Replay must not replace a newer file | route test projects the current head; DOCX structural retry keeps the later edit |
| HTTP acquire, renew, takeover, commit, restore, DOCX save | `docx-editor.test.mjs` and the route commit test |
| Another owner | `NOT_FOUND` |
| Restart of the file journal | reload replays the same revision |
| SQL ledger shape, with RLS forced by T04 | `0004_revisions.sql` still creates the tables. `0005_rls.sql` forces the policies |

The route test was red before the head projection change: replaying commit A left A's bytes on disk after B was the head. It is green after the projection reads the head inside the journal queue.

### Deferred

| Item | Owner | Why it is not part of this T06 closeout |
| --- | --- | --- |
| Live PostgreSQL execution of the revision transaction | ops | The policies are in `0005_rls.sql`. The Web process still uses the journal adapter and does not open a database connection. The dev principal is supplied by the caller. |
| More than one process on one data directory | ops | The journal queue is in-process. A second process can overwrite the file. Run one server per data directory. |
| Outbox delivery | T08 | Rows are written in the commit transaction. No dispatcher consumes them. |
| Native Docs ribbon, full editor generation wiring, and four-format round trip | T07 | The paragraph editor and `createSaveGenerationGuard` cover the current DOCX save. Mounting the Docs renderer is T07. |
| Spreadsheet, slide, and PDF editors | later format tasks | This task does not add those save paths. |
