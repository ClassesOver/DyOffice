# T00 small-sample authenticated API performance baseline

This is an initial measurement instrument, not section 8 production capacity
acceptance. Real measurements are pending exact-commit CI; no numbers are
invented here. It uses real PostgreSQL and the existing restricted runtime
fixtures, local sessions, application HTTP routes and ten synthetic DOCX files.
No customer service, credential, file or production database is used.

## Reproduction

The host CI job provisions pinned test services and installs the exact checkout's
lockfiles. After correctness suites complete:

```sh
cd apps/web
DYOFFICE_RUN_PERFORMANCE_BASELINE=synthetic-ci-only node --import tsx --test test/performance/api-baseline.test.mjs
```

The test also requires GitHub CI and the existing disposable-test database URL.
It creates its own random test database and restricted roles; the existing
fixture cleanup removes only those resources. It cannot accept a remote target
URL. Upload `apps/web/test-results/performance-baseline.json` even on failure.

## Method and resource scope

One authenticated user's file list (10 files), personal preferences and file
metadata GETs; first observed request (NOT a cold-start assertion), 5 warmups per
route, then 3 rounds of 30 requests per route at concurrency 1 and 4. Routes
rotate order each round. Total 558 requests, below the unchanged 600/minute global limiter. Login/setup/import are outside
measurement; the fixture primes some database and application state.

Closed-loop client-observed wall time ends after response-body receipt. Client
and API run in the same Node process over loopback HTTP, without TLS, proxy or
external network. This is NOT Fastify/server-only time or a target-rate/open-loop
load test; no coordinated-omission correction is claimed. At 30 samples, nearest-rank p99 equals the maximum and is not a stable tail
estimate. Reports retain per-round/raw samples, successful and all-response latency,
every error/status, count and wall-clock throughput. Failure never improves a
reported success denominator. Any incorrect response fails the test, after
writing the artifact. No performance threshold is used to relabel correctness.

CPU and RSS cover the combined API/client process; PostgreSQL is excluded, RSS
high-water includes fixture setup. CPU model/count, memory, cgroup limits and
runner version are observations, not reserved resources or an immutable host.
The report includes source SHA, lock hash, actual DB migration checksums and
fixture bytes/hash. No cookies, passwords, connection strings or request bodies
are serialized. The host-runtime artifact complements this report with actual
Node/PG/Redis/RustFS versions.

## Section 8 coverage, not waived requirements

| Requirement | This baseline | Remaining validation |
| --- | --- | --- |
| Metadata/list/preferences server p95 <=300 ms | Different metric: loopback client observations only | Instrument bounded server timings on a representative frozen deployment |
| Revision commit p95 <=500 ms | not_run | Preverified upload, real transaction timing, conflicts and failures retained |
| DOCX/XLSX/PPTX/PDF first usable times | not_run | Representative sized fixtures, browser/network/font/engine provenance |
| 100 sessions,25 editors,10 AI runs,4 native tasks | not_run | Explicit load mix and 1.5x overload with resource/queue/error observations |
| Model gateway delay | blocked | Approved provider/workload and isolated supplier versus gateway timing |
| Revocation propagation | not_run here | Measure live connection behavior separately from ordinary GET latency |
| 24-hour stability | not_run | Dedicated endurance environment and integrity/leak checks |
| RPO/RTO | not_run | T24 actual backup/recovery exercise |

Full T00 performance acceptance cannot be inferred from these three small GET
workloads. T25 must validate the agreed targets on a frozen release environment.

Review caught an initial 1,818-request plan conflicting with the unchanged global
600/minute limiter. A workload-bound regression failed first, then passed after
reducing to 558 total requests. No rate-limit protection was changed or failure
removed. These are intentionally small observations, not a tail-latency SLO proof.
