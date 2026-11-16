# Verification-only object reads (2026-11-16)

Base: `fd42224cc919d580ac699e0038f5229cffe84b8a` (`feat/dyoffice-web`, rechecked before publication).
The candidate uses complete streamed SHA256 + length validation without collecting payloads for import finish and revision commit. Download still collects validated bytes. Transaction/account/file locks, final authority/lease/expiry checks, CAS, quota and idempotency stay unchanged; no admission limit increase.

## Measurements, not capacity acceptance

Node v24.22.1; local disposable PostgreSQL 17.11 and RustFS 1.0.6. Baseline collect and candidate verify alternate against the same source fixture/implementation; collected-byte behavior matches the prior path. Raw observations are adjacent JSON files.

Synthetic object-only benchmark uses fresh child processes, one reused 64KiB chunk, 1 warmup round and 5 measured rounds per mode/size. At 32MiB, observed `arrayBuffers` peak delta median: collect 67,108,864 bytes vs verify 0 bytes; elapsed median 76.638ms vs 23.610ms. This isolates avoided accumulation/concatenation, not total process/S3 memory and not HTTP/DB end-to-end latency. RSS is noisy; no claim of zero memory use.

Real PG/RustFS save benchmark uses one 8,568,141-byte DOCX with random padding and alternating modes, 1 warmup round and only 3 measured samples each. Median commit: collect 47.300ms, verify 45.292ms; object verification: 35.428ms / 28.964ms; same-owner lock waiter: 43.182ms / 41.516ms. Candidate commit samples include 77.285ms. The sample is insufficient to conclude a reliable end-to-end latency gain or p95/SLO/capacity acceptance. The account lock still spans object I/O; shortening it is deliberately deferred for GC/TOCTOU design.

## Reproduction

In `apps/web`, with disposable loopback PostgreSQL/S3 fixtures configured as required by `test/helpers/restricted.mjs` and `test/helpers/s3.mjs`:

```
DYOFFICE_PERFORMANCE_REPORT=/absolute/output.json node --experimental-strip-types test/performance/object-verification-benchmark.mjs
DYOFFICE_RUN_SAVE_BENCHMARK=synthetic-local-only DYOFFICE_SAVE_REPORT=/absolute/save.json node --experimental-strip-types --test --test-concurrency=1 test/performance/save-verification-benchmark.test.mjs
node --experimental-strip-types --test --test-concurrency=1 test/storage/*.test.mjs test/local-integration/files.test.mjs test/local-integration/revision-commit.test.mjs test/local-integration/auth-authority-deadline.test.mjs test/local-integration/authority-write-races.test.mjs
npm test
npx tsc -p server/tsconfig.json
```

## Verification

- Red: verify-only methods absent (2 failed); real PG finish attempted forbidden full-payload collection (1 failed).
- Green: complete related real PostgreSQL + RustFS suite 79/79, zero skips. Includes corruption, missing/oversized/truncated objects, local symlinks, stream errors/premature close and destroyed-body assertions; authority/lease/upload expiry and account-disable races, rollback/CAS/idempotency regression.
- Web suite 240 passed, 1 pre-existing skip; server typecheck passed.
- Independent source review found no new security blocker; recommended S3 stream lifecycle cases were added and passed.
- An initial overlapping web/storage run hit four parser deadline/concurrency failures (CRC/XML, parser deadline, bounded validation concurrency, upstream fixture acceptance). The complete suite above passed when run serially. This is recorded, not hidden or classified as a product fix.
- No full monorepo/browser/systemd acceptance claimed. No production or remote-user data used. No CI success claim.

T05/#54 integration must retain their `checkReady` and `removeUnreferenced` methods alongside `verifyObject`. Do not replace whole storage adapters from either branch. The optimization intentionally makes no cleanup, migration or readiness changes.
