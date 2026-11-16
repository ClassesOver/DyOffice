# T00 small-sample authenticated API performance baseline

This is an initial measurement instrument, not section 8 production capacity
acceptance. The bounded CI observation below is now recorded; it is not production capacity evidence. It uses real PostgreSQL and the existing restricted runtime
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

Full section 8/T25 performance acceptance cannot be inferred from these three small GET
workloads. T25 must validate the agreed targets on a frozen release environment.

Review caught an initial 1,818-request plan conflicting with the unchanged global
600/minute limiter. A workload-bound regression failed first, then passed after
reducing to 558 total requests. No rate-limit protection was changed or failure
removed. These are intentionally small observations, not a tail-latency SLO proof.

## Verified CI observation (2026-11-16)

- Run: [43815137000](https://github.com/ClassesOver/DyOffice/actions/runs/43815137000), PR #32 head `157cc1c3549cdc2e91371b7b8ee2f1e4a90c7f89`.
- Artifact: `t00-small-api-baseline`, ID `14203275027`, 10,191 ZIP bytes. Independently downloaded ZIP SHA256 `83f0e0fecaf11be50960bf5bdfebe69edd2cac4ef19f6d7e90f9d863d7ea3ad8` equals GitHub's declared digest.
- JSON `gitCommit` is the PR test merge `65a81a49cdeba3b16e9349250fbac08eb88ec586`, whose parents are target `474ce46` and head `157cc1c`. Both test merge and PR head have exact tree `0497e30318ef2776b800ad194631a10dfa060148`; thus this observation is attributable to the candidate source, not an unrelated run.
- Report complete=true; 558 total attempts including first observations and warmups; 0 incorrect/failed responses. This is the report's bounded correctness result, not the conclusion of every workflow/job.
- Node 22.23.5, Linux x64, AMD EPYC 7763, 2 reported logical CPUs, runner image 20261111.370.1, 8,317,935,616 total memory bytes. Observed environment, not reserved or immutable hardware.
- Root lock SHA256 `577f8a9d9953165a78531f8c1062aa43054ee22b2d411648366d8ece43724499`; report retains 13 migration checksums and synthetic fixture SHA `49ec7bb8ced69c5277ae64a46ff1d50166ac7014888004b6df412d7e94a821cf` (4,224 bytes × 10 files).

Each cell below lists all three rounds, not a merged or cherry-picked percentile. Latencies are client-observed milliseconds, not server-only time.

| Route | Concurrency | Round p95 ms (1 / 2 / 3) | Completed requests/s (1 / 2 / 3) |
| --- | --- | --- | --- |
| file metadata | 1 | 6.143 / 9.291 / 7.957 | 204.96 / 192.24 / 205.77 |
| file metadata | 4 | 30.546 / 38.532 / 18.317 | 210.33 / 193.72 / 297.18 |
| files list (10) | 1 | 8.616 / 11.036 / 5.687 | 164.48 / 181.71 / 212.65 |
| files list (10) | 4 | 53.370 / 26.849 / 29.235 | 156.87 / 252.99 / 251.82 |
| personal preferences | 1 | 11.547 / 6.525 / 6.606 | 163.22 / 211.52 / 210.22 |
| personal preferences | 4 | 24.838 / 19.813 / 18.413 | 227.97 / 297.65 / 283.80 |

First observations were 89.122 / 15.360 / 11.052 ms for list/preferences/metadata respectively; fixture setup had already primed state. They are not cold starts. API+client process CPU: 1,936,925 user and 368,737 system microseconds; RSS before/after 170,889,216 / 181,166,080 bytes; peak 205,372 KiB includes setup. PostgreSQL resources excluded.

All eight remaining categories in the report remain not_run or blocked: server-side p95, 100 sessions/25 editors/10 AI runs/4 native tasks, revision commit, four-format opening, approved model workload, revocation timing, 24-hour endurance and recovery RPO/RTO. No capacity or Section 8 threshold is accepted from these numbers. Legacy database conversion is excluded by the owner's current scope and is not a delivery blocker; accidental old-ledger refusal remains a safety gate.

Independent review recomputed all 558 raw sample outcomes and 18 per-round p95/throughput rows, and independently verified the source-tree relationship and ZIP digest. `cgroupCpuMax` and `cgroupMemoryMax` are null in the report: limits were not obtained, not proof of unlimited or measured quotas.
