# T05 expired pre-publication rejection cleanup

## Bounded correction

The receiving claim can expire before validation fails. The previous failure
handler called `lockAccount` (which moves expired receiving reservations to
stored bytes) and then `lockUpload` (which rejects expiry). This rolled cleanup
back, or left an already committed expiry unchanged. An attempt known never to
have called `putImmutable` therefore retained an uncertain-write marker and
charge, and revision drafts could indefinitely block permanent purge.

Cleanup now reauthenticates through the ordinary principal transaction, locks the
account then the owner-scoped upload, and checks the same job/epoch, auth-version
and revision-session bindings. Only the exact in-memory attempt with no SHA and
no completed file may clear its no-publication marker. Receiving uploads release
the reservation as before. Already expired uploads credit their conservative
stored charge. Proof and credit commit atomically, with an underflow guard.
No object is deleted by this path. Expiry never makes an upload publishable.

## Deliberate exclusions

Once PUT has been invoked, even a failed response remains uncertain and this
cleanup does nothing. Revoked authority, mismatched attempts, SQL/commit failures
and process death before proof commit remain fail-closed. This is not a durable
recovery mechanism for every interrupted upload, a late-write fence, retention
scheduler, bulk empty-trash UI or production enablement. No broker, migration,
runtime gate, S3 versioning or job-dispatch implementation changes are included.

## Verification scope

Target `70e99c3a25c4a0dce4b25718485f4b3896ca23db`: GitHub blob hashes were
individually matched for service, queries, purge, principal context, file and
restricted fixtures, and app package manifest against the isolated snapshot.
The snapshot is the earlier target plus T08 closure, not the PR #138 combined tree.

Real isolated PostgreSQL and local object-store tests cover expiry in the cleanup
transaction and a prior committed sweep; mismatched attempts; revoked sessions;
uncertain PUT success with lost response; revision trash/purge; and rollback after
proof update. The first two expiry regressions failed before the correction.
A failed fixture attempt during workspace disk exhaustion is not counted as a
passing test. Temporary test PG data was moved to a separate temporary volume.
Final test totals are recorded in the handoff, not inferred from historical runs.

Final scoped integration: all 8 new tests passed, including a truly suspended
PUT released only after a committed expiry sweep and rejected purge. The object
really arrives late, remains readable by the internal store, cannot publish, and
is neither reclaimed nor credited; the original revision remains recoverable.
Related real-PG/local-store suite: 73 passed, 2 failed, zero skipped. Both failures
are explicit missing-S3 fixture prerequisites (real S3 import and save), not a
claim of S3 regression acceptance. Web: 356 passed/1 existing optional skip;
unit: 625 passed/3 real-Codex environment skips. Frontend/server typecheck passed.
The root `npm test` was attempted and failed at html2docx browser setup in
`features.test.ts` and `pagebg-restore.test.ts` (Chromium/crashpad launch failure).
It is not a full-suite pass. No production or visible-browser acceptance is claimed.
