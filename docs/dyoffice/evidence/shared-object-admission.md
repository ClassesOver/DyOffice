# Shared File / Sheets object-I/O admission

Baseline: `feat/dyoffice-web@c33dd65afd8f4426830889e11e1493d54af69fe4`. Runtime source matches `8ab3e1f`; intervening #65 changes only boundary tools and implementation-plan documentation.

## Defect and bounded repair

Native Sheets route groups had independent admission from File API. Two blocked File downloads plus Sheets inspect entered three object reads, all HTTP200; the ordinary third File request was correctly503. Actual Fastify red tests reproduced peak3 in both directions.

A WeakMap keyed by the registering Fastify application now owns the two-slot object budget. File and Sheets groups on the same app share it; different apps remain independent. Authentication/CSRF and existing upload preflight precede admission. Admission precedes request-body parsing. Processing plus response completion owns the slot; disconnecting pending work cannot release early. Errors, validation failures and repeated close events cannot leak or double-release slots. Existing native admission still bounds workers; no auth/lease/quota/purge logic changed.

Both route groups currently receive the same root app in `buildLocalApp`. If future code registers them using distinct encapsulated app objects, it must preserve a common budget rather than assuming path names imply sharing.

## Final local verification

- Mixed route red tests: peak3, observed assertion failures in both directions before repair.
- Route tests (mixed read/save, completion, invalid auth/body/native failures, disconnect, per-app isolation, original finish/stage-GC admission): **10/10**.
- Web + unit: **344 passed, 1 existing optional skip, 0 failed**.
- Server strict TypeScript: passed.
- Real PostgreSQL17.11 + RustFS1.0.6: **17/17, no skips**. Three real owners, valid XLSX imports, actual S3 verified reads, cross-route rejection, invalid CSRF and cross-owner rejection, stage-GC admission and all permanent-purge rollback/retry/concurrency cases.
- Independent read-only review found no blocker and separately ran mixed tests6/6.

The initial PG fixture reused the session held by a paused read, so authentication waited on its lock and returned500 instead of reaching admission. The final fixture uses three owners to test aggregate capacity without conflating authentication locks. Authorization order was not relaxed. This does not claim a fix for same-session long-I/O authentication contention.

Tests use disposable random databases/roles/buckets; no real user data removed. No CI, full monorepo, native sandbox or browser/desktop XLSX acceptance claim. Native adapters in the new admission tests are controlled stubs; object storage and authorization in the17-test repeat are real. Keep PR draft pending coordinated merge review.
