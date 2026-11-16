# T02/T05 runtime guard corrections

## Scope

The upload-finish route reads back and hashes an object, so it uses the same two-slot process-local admission as content transfers and revision commits. A disconnected client cannot release the slot until verification settles. This does not change account locking, authorization, expiry, or storage retention.

Local application readiness now checks identity/schema/bootstrap, a read-only `SELECT 1` through the configured restricted business pool, and the configured object store's read-only probe. Built-in local storage verifies the dedicated directory and process access; S3 uses a bounded HeadBucket request. Custom stores without `checkReady()` fail readiness closed. Liveness remains independent. Readiness does not prove INSERT/UPDATE privileges, all object operations, HA, or production suitability.

Readiness is process-local single-flight, with a five-second response deadline. A dependency that ignores cancellation retains its slot until settlement; subsequent probes return unavailable rather than adding unlimited work. It does not issue identity context changes or write queries on a pooled connection.

## Verification

Before the fix, five concurrent upload-finish requests entered verification; the existing download route admitted two and rejected three. After the fix, finish also admits two and returns 503 for three. A real HTTP disconnect regression confirms capacity stays reserved until object work settles.

Fault-injection tests exercise business-pool failure, store failure/recovery, liveness independence, unknown store probes, and hung dependency coalescing. Built-in tests verify a removed local directory and failed S3 HeadBucket report unavailable, with no object writes. These are route/control-flow and adapter tests, not new real-PostgreSQL or live-S3 outage certification.
