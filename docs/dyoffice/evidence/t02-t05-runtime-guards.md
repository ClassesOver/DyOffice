# T02/T05 runtime guard corrections

## Scope

The upload-finish route reads back and hashes an object, so it uses the same two-slot process-local admission as content transfers and revision commits. A disconnected client cannot release the slot until verification settles. This does not change account locking, authorization, expiry, or storage retention.

Local application readiness now checks identity/schema/bootstrap, a read-only `SELECT 1` through the configured restricted business pool, and the configured object store's read-only probe. Built-in local storage verifies the dedicated directory and process access; S3 uses a bounded HeadBucket request. Custom stores without `checkReady()` fail readiness closed. Liveness remains independent. Readiness does not prove INSERT/UPDATE privileges, all object operations, HA, or production suitability.

Readiness is process-local single-flight, with a five-second response deadline. A dependency that ignores cancellation retains its slot until settlement; subsequent probes return unavailable rather than adding unlimited work. It does not issue identity context changes or write queries on a pooled connection.

## Verification

Before the fix, five concurrent upload-finish requests entered verification; the existing download route admitted two and rejected three. After the fix, finish also admits two and returns 503 for three. A real HTTP disconnect regression confirms capacity stays reserved until object work settles.

Fault-injection tests exercise business-pool failure, store failure/recovery, liveness independence, unknown store probes, and hung dependency coalescing. Built-in tests verify a removed local directory and failed S3 HeadBucket report unavailable, with no object writes. These are route/control-flow and adapter tests, not new real-PostgreSQL or live-S3 outage certification.

## Follow-up real-service verification

The isolated RustFS 1.0.6 storage suite, including new readiness tests, passed 24/24 with zero skips. New cases delete/recreate a disposable loopback bucket and use invalid signing credentials: readiness returns 503 without leaking details, recovers after bucket restoration, and liveness remains 200. The isolated PostgreSQL 17 readiness cases passed 2/2 with zero skips: a working connection returns ready, a closed pool returns unavailable, and the real server rejects a randomly named nonexistent database. Closing the pool is not a database-server outage simulation.

The candidate was rechecked with isolated local dependencies after a shared dependency link changed: Web 234 passed / 1 existing skip, complete Web/server TypeScript checks passed. Earlier missing-S3 prerequisite failures are superseded by the real-service results above. Full monorepo testing remains incomplete: the attempted run stopped at `html2docx/tests/features.test.ts` and `pagebg-restore.test.ts` because Chromium startup was denied by the execution environment. No CI or production-readiness claim is made.

## Integration refresh after #53 and #57

The readiness candidate was overlaid on target `1f3749be62873f5183dbe0acb3bc01ce9cb6559c` without overlapping source edits. The combined snapshot passed `node --import tsx --test --test-concurrency=1 apps/web/test/*.test.mjs apps/web/test/unit/*.test.mjs` (289 passed, 1 existing skip), boundary tests (16/16), and both complete Web/server TypeScript checks. Real RustFS storage tests again passed 24/24; real PostgreSQL readiness, authority-deadline, and idle-guard upgrade tests passed 5/5, all with zero skips. Full monorepo Chromium startup remains environment-blocked as described above; these focused and integration results are not a full-monorepo pass.
