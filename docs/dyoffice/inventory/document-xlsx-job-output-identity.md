# XLSX durable-job output identity

## Actual seam

Baseline `1c899d80`, existing `worker/src/jobs/xlsx.ts` blob
`61f5e335e0116497bfa108aa1ed56447b6421a3b`. The existing executor already derives a
job credential from the frozen claim, acquires the job's edit lease, reads its
revision, and commits through the real T06 service. SQL, not the supplied claim's
owner fields, authorizes these transactions. This change does not invent a tenant,
interactive generation, unified ArtifactResult, or OS-stop proof.

The native-owned output Buffer was used across the asynchronous stage call, and
the receive receipt was ignored. The controller now requires a nonempty Buffer
within the existing `MAX_OBJECT_BYTES` (32 MiB), copies it before any storage await,
computes SHA-256 with Node crypto, and requires the actual receive receipt's
upload ID, length and hash to match before calling commit. Mismatches are
`NATIVE_FAILED`; oversize is `RESOURCE_LIMIT`. Existing heartbeat, failure cleanup,
job fencing, leases and SQL commit logic are unchanged. This does not add immediate
upload cancellation or replace existing abandoned-upload recovery.

## Real tests and limits

`test/local-integration/xlsx-job-output-identity.test.mjs` uses restricted real PG
roles, real job enqueue/claim and edit leases, RustFS, and the actual executor and
T06 services. Only its native port is test-injected: the existing XLSX gateway
reads/writes a trusted generated workbook with an empty edit plan, with ZIP CRC
reopening. This is **not** the Rust native engine, a production fallback, or an
isolation test. No production routing, enabled job types, broker or runtime factory
is changed. The test enables the existing job type only in its isolated fixture.

Eight tests cover successful byte-exact publication/job completion, mutation of the
native-owned Buffer during stage, each of three mismatching receipt fields,
empty/oversize rejection before stage, and real job cancellation during processing.
Authenticated nonzero file/revision baselines verify no head, revision, receipt or
outbox changes on rejection. Success also verifies terminal job and released edit
lease. Six new assertions failed on the original executor; the normal and
cancellation regression cases already passed. After the fix all eight pass,
alongside the five existing actual XLSX edit/T06 tests (13/13 total).

Run with the repository's real PostgreSQL and S3 test environment configured:

```sh
cd apps/web
node --import tsx --test --test-concurrency=1 \
  test/local-integration/xlsx-job-output-identity.test.mjs \
  test/local-integration/xlsx-save-t06.test.mjs
```

The 68 pure protocol tests and strict targeted TypeScript check also pass. This
partial checkout is not evidence of full repository or certified Ubuntu/openEuler
runtime acceptance. Runtime/rootfs trust and actual isolated native execution
remain separate, unresolved gates.
