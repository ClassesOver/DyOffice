# T05 explicit permanent trash purge

Candidate implementation, not deployed. This extends bounded orphan reclamation with an explicit owner-only `POST /api/v1/files/:id/purge` action. It only accepts a trashed file. The route requires the existing authenticated cookie, CSRF token and origin checks, rejects body/query extensions, and shares the two-slot object-I/O admission limit.

## State and guarantees

1. A transaction locks the owner account and selected file. Active jobs and receiving uploads with unresolved publication are rejected with 409. Known staged/ready drafts are cancelled and accounted. An irreversible `purge_started_at` fence is committed, edit leases invalidated and revision outbox deliveries retired before any object is removed.
2. A later authorized transaction removes at most one completed immutable object. It marks that object's reclamation and debits quota atomically after physical success. Missing-object retries are safe. Storage failure returns 202 pending, leaves accounting intact and does not allow restoration. The final collected object results in 200 purged. Clients retry the same explicit action until purged; no unseen background deletion is implied.
3. A crash or rollback after removal leaves the committed fence in place and preserves the charge until a retry completes accounting. The original upload/file/revision IDs, provenance, jobs and commit receipts are retained as audit tombstones, not live content references. They cannot be used to restore, download, acquire a lease, commit or return a successful enqueue receipt for purged content.
4. Database triggers prevent clearing the file fence, attaching new live references or reviving a retired outbox delivery. Runtime grants remain narrow: only revision `reclaimed_at` and the four necessary outbox lifecycle columns gain UPDATE, not immutable revision data or broad DELETE access.
5. Outbox retirement is separate from publication. It increments the epoch and clears the lease; take/ack reject retired deliveries. A dispatcher that already acquired an event may still emit an opaque late hint. That hint conveys no content capability and cannot make a purged file readable. Already-buffered or already-transmitted downloads cannot be withdrawn.

## Deliberate limits

- Objects with uncertain PUT completion are not guessed safe based on age. Active receiving and historical ambiguous expired attempts block purge. A validation failure known to occur before PUT now atomically clears its attempt marker, so a normal rejected draft does not permanently block purge.
- Versioned or suspended S3 buckets are not physically reclaimed by this implementation. The unversioned check and delete response guards remain in place.
- This is per-file explicit permanent purge, not a browser bulk-empty UI or a background retention scheduler. Audit identities and names are retained; it is not an account-erasure/privacy deletion facility.
- This integration uses new migrations 0016/0017 after the applied 0015 revision-ACK deadline repair. Migrations 0001–0015 are unchanged. Future T12 migrations must be rebased onto the resulting ledger.

## Historical candidate evidence

Exact-lockfile app dependencies were installed independently for the bounded candidate and reused unchanged by this isolated candidate. PostgreSQL 17.11 and RustFS 1.0.6 are disposable local test services with randomly created test databases/buckets only. No real user object was removed.

- Final real PostgreSQL + local/S3/Redis related suite: 153/153 passed without skips (files, revisions, purge, ownership, auth/revocation, durable jobs, output, delivery, readiness, storage).
- After synchronizing target fd42224 (#58), real PostgreSQL + RustFS: 13 purge cases plus 2 action-expiry cases passed, 15/15 without skips. Covers crash after physical delete, rollback/retry/accounting, concurrent purge/restore, held outbox delivery, old receipts, immutable metadata privileges, owner/CSRF input boundaries and bounded route admission.
- Review caught normal failed draft misclassification, outbox revival and terminal reference rebinding; failing tests were observed for all three, then passed after correction.
- Web tests: 250 passed, 1 existing skip. Unit tests: 86/86. Web/server typecheck passed with a 1 GiB heap cap after an uncapped run was killed (137).
- Broader regression exposed an unnecessary job-update → file lock edge; a bounded test reproduced statement timeout, then passed after same-reference active-job metadata updates bypassed the redundant lock. Lifecycle trigger now runs as INVOKER, preserving RLS instead of exposing cross-owner retired state.
- Initial broad suite was stopped after discovering that lock regression and missing Redis fixture. It is not counted as passing; the 153-case repeat used all three real isolated services.
- At that historical checkpoint publication was blocked on #54 and ledger reconciliation; no PR or merge had occurred. The integration below supersedes that checkpoint.

## Latest target integration (2026-11-16)

Baseline `0672c6695057155c5e8eee4b2a9862b56599bb4c` includes #54 readiness, #60 ACK deadlines, #62 verification-only object streams and #63 indexed expiry cleanup. Three-way integration retains `checkReady`, `readVerified`, `verifyObject` and `removeUnreferenced`. Applied migrations remain unchanged; new0016 adds abandoned-upload reclamation, new0017 adds the irreversible file lifecycle.

- A real-PG RED test caught the old purge candidate replacing the ACK function without migration0015's lock-before-expiry check. New0017 preserves the row lock, fresh expiry check and retired-event guard; ACK/purge17/17 then passed.
- Independent review found import/revision staging now invokes GC but had not joined object admission. Two Fastify RED cases observed peak3 instead of2; both POST uploads routes now use the same admission/transfer runner. The real cross-owner tests hold two physical deletions and verify the third request gets503, then succeeds after capacity is released.
- Final entire `test/local-integration`, `test/jobs` and `test/storage` suites: **260/260 passed,0 skipped**, using fresh randomly named base/test databases plus real PostgreSQL17.11, RustFS1.0.6 and Redis8.0.2. Includes v15→17 ledger preservation, idempotent migration, worker ACK grants, immutable metadata, rollback, crash retry, owner/CSRF rejection, readiness and verify-only paths.
- Final Web plus unit suites: **338 passed,1 existing optional skip,0 failed**. Frontend/server strict typechecks passed with512MiB Node heap. Local-shell production build passed; this is build/HTTP testing, not a fresh visible-browser acceptance. Boundary602 files/0 violations and compatibility inventory84 inputs/0 changes passed.
- The first expanded run failed12 tests: ten hit an old shared test database's candidate migration checksum, one lacked a built local-shell fixture, and one old job test delayed `readVerified` instead of #62's `verifyObject`. The final repeat used a newly created disposable base database, a built shell, and an execution-asserted delay on `verifyObject`; no migration guard or authority assertion was weakened.
- No full desktop-monorepo, Chromium, CI, systemd or production acceptance is claimed. Runtime service versions are the isolated test versions, not exact production-lock acceptance. No real user content was removed.
- Final repeat with `DYOFFICE_TEST_RECLAMATION_STORE=s3`: orphan GC, permanent purge, cross-owner slow-delete admission and ACK deadline suites **25/25 passed,0 skipped**, against PostgreSQL and actual RustFS. This exercises physical S3 deletion, rollback and process-crash retries rather than relying only on a store stub.
