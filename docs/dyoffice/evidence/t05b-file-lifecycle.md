# T05b scoped initial file lifecycle

2026-11-15, baseline `5fdb9d0f`, branch `feat/dyoffice-web`. This connects the T05a storage/validation foundation to experimental, authenticated initial imports. DOCX/XLSX/PPTX/PDF originals can be staged, uploaded, finished, listed, renamed, downloaded, recycled and restored. It does not implement editor saves, lease/CAS/history protocols, native editing, a finished workspace UI or production availability. Production remains guarded; file routes require explicit experimental storage configuration.

## Ownership, storage and transactions

Immutable migration 5 adds `storage_accounts`, `uploads`, `files` and initial `file_revisions`. Every table has deployment/owner FORCE RLS. Workspace/account/file/revision associations use composite ownership keys; a file's current revision must belong to that same file and owner. The deferred current-revision FK permits file and initial revision insertion in one transaction. Object keys are bound to deployment/owner/revision UUIDs. Runtime business grants allow only needed SELECT/INSERT/UPDATE; initial revision rows are SELECT/INSERT only, with no UPDATE/DELETE. Authentication has no file-table rights, and configuration-admin has no implicit personal-file access. SQL migrations own constraints; Drizzle mappings provide typed reads.

The service accepts a session secret, not a caller-supplied principal. Transactions rebuild principal authority under user/session locks, install local context, explicitly filter by owner, and apply policy scopes. Lock order is user/session authority, then per-owner storage account, upload, and file. All quota-changing paths serialize on the storage account. List/open/download only operate within the authenticated owner's namespace; guessed upload/file/revision IDs are denied without names or object keys.

Initial import has three steps:

1. Stage validates name/declared length and reserves expected bytes; server generates upload, file and revision UUIDs. No file exists yet.
2. Receive rechecks owner, captured auth version, state and deadline, claims one receiving attempt, validates actual bytes with the bounded worker and computes SHA-256. It publishes one immutable object, then independently revalidates session/upload authority before marking ready. No file exists even when ready. Concurrent receives have one winner; a second put never overwrites the object.
3. Finish locks authority/account/upload, requires ready state, reads and hashes the actual stored object, then inserts file/revision, consumes upload and transfers quota in one PostgreSQL transaction. It rechecks upload time after object I/O and metadata writes; the transaction wrapper also rechecks session time just before commit. Metadata failure rolls everything back while retaining the immutable ready object for retry. A committed finish retry returns the same initial revision; it does not create another object or file.

Object storage and PostgreSQL are not a distributed transaction. Missing/corrupt objects prevent finish; successful object publication followed by failed/expired/revoked database authority leaves no completed file. Such objects remain tracked by upload identity for later safe collection. There is no eager deletion that could remove a committed revision. A client whose byte transfer stops early leaves its stage empty and may resend before expiry. Once publication begins, ambiguous errors keep the reservation until expiry rather than pretending nothing was written.

Defaults are 1 GiB per owner, at most 16 pending uploads, 15-minute upload TTL and the T05a 32 MiB file limit. Reservations count immediately; trash continues to count. Cancelled/expired ready or ambiguous receiving uploads conservatively transfer reserved bytes into stored usage until reference-aware collection confirms deletion. Empty cancelled/expired stages release reservations. This prevents repeatedly publishing/cancelling objects to bypass capacity. Stored usage therefore includes retained unreferenced objects and can conservatively charge an ambiguous failed write; no reclamation job or hard-delete API is claimed. Reducing configured quota never deletes files or makes another owner visible.

## HTTP and operational boundary

`DYOFFICE_FILE_API=experimental` plus an explicit `DYOFFICE_OBJECT_STORE=local-dev|s3` enables the versioned API. Local development requires a separate `DYOFFICE_OBJECT_DIRECTORY`. S3 requires a precreated private bucket, explicit region, standard AWS SDK credentials/role and optionally a trusted endpoint/path-style setting. Non-loopback custom endpoints require HTTPS; credentials/query secrets in endpoint URLs are rejected. S3 startup checks bucket access; it neither creates a production bucket nor installs IAM/encryption/retention. Without opt-in, local file APIs remain unavailable rather than falling back to the shared prototype JSON store.

All file mutations require exact Origin, CSRF and a server-owned Cookie session before parsing bodies. Upload ID ownership/deadline/declared length is checked before buffering raw bytes. At most two transfer requests hold buffers per API instance; upload/download/HEAD admission remains occupied until both work and response completion/closure settle. A disconnected client does not free a slot while storage work still owns buffers. Partial-body aborts release slots without claiming an object. The separate validator still has its two-worker limit.

Downloads are whole, verified originals with private/no-store caching, nosniff, attachment disposition and sandbox CSP. No public/presigned object URL or object key is returned. Revision is required and must match the current owned file. Recycled files cannot open/download until restored; renames change metadata only and cannot change the actual format or overwrite another object's bytes. Editor capabilities remain explicitly unsupported. The existing development-token JSON prototype is a separate mode and is not an account migration.

The worker's JS heap/time/concurrency controls do not substitute for OS/native allocation containment or malware scanning. This opt-in path remains for isolated development with authorized fixtures, not public/customer uploads; T21 containment/F13 and enterprise release gates remain open. Health readiness currently checks identity schema/bootstrap, not continuous S3 availability or HA durability. Backup/recovery, collection/retention, audit completeness, large-file streaming/resume, folders/favorites/recent and the workspace UI remain with their later tasks.

## Executed failures and fixes

The first file tests failed because the service was absent. Initial implementation passed actual four-format imports, RLS and composite references, concurrent quota reservation, exact byte downloads, rollback after a real failing DB trigger, staged object corruption and rename/recycle/restore. HTTP tests first reached the unimplemented-route 501 and then passed after explicit versioned routes were registered. Real local and S3 server-entry tests exercise the actual configured process, including S3 bucket access and shutdown.

Additional RED-to-GREEN tests reproduced cancelled/expired objects reporting zero stored usage, authorization occurring after raw-body size rejection, and session expiry during object I/O still committing. Fixes preserve retained-object quota, check owner/size before buffering, and revalidate session time before business commit. The partial-transfer test initially failed on its expected client ECONNRESET because `events.once(close)` also rejects errors; its close barrier now observes closure directly while preserving the real socket abort and all server-side assertions.

One fresh independent read-only review found two Important issues, no Critical finding: disconnect released transfer admission while publication continued; and upload expiry was checked only before object I/O. Real HTTP/object barriers reproduced both (a third publication admitted with two still live; an expired finish accepted). The single fix pass retains admission until processing and response settle, and rechecks the upload deadline after object verification/metadata writes. Regression tests pass without mocking publication or removing deadline expectations. No T05b review finding is deferred; the historical T03c action-token retention Minor remains open. No second review is claimed.

Both revocation orders are tested: revocation during the unlocked publication phase prevents ready/finish metadata; a finish already holding authority commits before disable can complete, after which the old session is rejected. Real DB-time gates cover session and upload deadlines during reads. Concurrent receives have one winner; concurrent finishes return one file/revision. Business cannot modify revision hashes or hard-delete files. Raw SQL without principal context sees no owned rows, and auth cannot read the new tables.

Chromium over real local TLS logs Alice and Bob into separate Cookie contexts, imports a real repository DOCX, verifies exact downloaded bytes, denies Bob the download, then recycles and restores Alice's file. This proves API/session/browser integration, not a completed UI or native editing. The S3 fixture is the same pinned, disposable RustFS used by T05a; credentials are only for isolated tests. No customer data or production resources were changed.

Final observed gates:

- `npm run test:web:integration`: 89 passed, zero failures/skips, including 19 file lifecycle cases and both actual local/S3 process-entry imports.
- `npm run test:web:storage`: 21 passed against real disk/S3/worker validation.
- All Web unit tests: 37 passed; legacy Web suite: 32 passed; build smoke tests: 2 passed.
- `npm run test:web:e2e`: 4 real Chromium/TLS/PostgreSQL cases passed, including scoped file lifecycle.
- `npm run typecheck:web`: passed.
- Actual Node 22 run of files/startup/session/RLS/revocation/migration/browser suites: 63 passed, zero failures/skips.
- Baseline/CI/IPC regressions: 12 passed. Compatibility baseline: 84 inputs, zero drift. Browser graph: 22 files, zero violations. `git diff --check`: clean.

These are locally executed results, not a GitHub Actions, native-editor, production or customer-acceptance claim. The single review preceded the final fixes/regression pass; no second review or absent gate is implied.

## Migration and next work

Migrations 1–4 are unchanged. Run the nonsuperuser owner provisioning tool before starting a new runtime so migration 5 and its narrow grants are installed; never pass migration credentials into the Web process. Existing accounts/preferences remain usable after the additive migration. Back up first and use a compatible recovery plan for rollback; never delete applied checksum records or pretend reverting source rolls back retained objects.

T06 extends the initial revision table with editing-save CAS, lease fencing, idempotency, history and outbox. It must continue accounting for every retained immutable version and must not reuse the initial-import finish API for edits. T12 supplies the actual workspace/file UI. T20/T24 define bounded metadata/object retention and reference-aware reclamation; collection must prove no active upload or revision reference and respect the architecture's minimum 24-hour staging grace. Production and the full implementation plan remain incomplete.
