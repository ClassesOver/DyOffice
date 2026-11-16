# Indexed expiry sweep cutoff

Base: `fd42224cc919d580ac699e0038f5229cffe84b8a`. Production change: one predicate in `lockAccount` uses `statement_timestamp()` instead of per-row `clock_timestamp()` for opportunistic expired-upload cleanup.

The cleanup query is issued after the account row lock has been acquired. Its cutoff is therefore fresh after waiting for that lock, not the beginning of the surrounding transaction. Uploads that expire during this one cleanup statement are deferred to a later sweep: their capacity stays conservatively reserved. No final upload, session, action or lease deadline checks changed. No locks removed, no quota relaxation, no migration or extra index.

## Reproducible evidence

Real disposable PostgreSQL 17.11; Node v24.22.1. One synthetic owner has 20,000 live staged uploads and no expired rows. `ANALYZE uploads` runs through the owner connection in the actual test database, then the restricted business role executes `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)` in alternating order, one warmup plus three samples per mode.

- Old volatile cutoff: 488 shared-buffer hits; execution 3.083 / 2.990 / 3.150 ms.
- New statement cutoff: existing `uploads_owner_state_expiry` index includes `expires_at` as a range condition; 3 shared-buffer hits; execution 0.023 / 0.022 / 0.021 ms.

These are cleanup-selector measurements, not HTTP/save latency or production throughput. No claims about p95/capacity. Statistics, data distribution and PostgreSQL version affect the planner. A large genuinely expired backlog still requires work; this change does not bound that backlog or alter T05 reclamation.

`upload-expiry-plan.json` retains raw plans. To reproduce in `apps/web` with the disposable loopback test database configured:

```
DYOFFICE_RUN_EXPIRY_BENCHMARK=synthetic-local-only DYOFFICE_EXPIRY_REPORT=/absolute/report.json node --experimental-strip-types --test test/performance/upload-expiry-plan.test.mjs
node --experimental-strip-types --test test/local-integration/upload-expiry-performance.test.mjs
```

## Regression and independent review

- Actual production cleanup UPDATE plan regression fails on old code (expiry not in index range), passes on candidate.
- Mixed staged/receiving/ready accounting and a live reservation are preserved; repeated cleanup does not double credit.
- Deadline is established relative to the same transaction's timestamp and crossed inside that transaction. A deliberate `transaction_timestamp()` mutant fails with 4 reserved rather than 1; restored candidate passes. This prevents accidentally freezing the cutoff at BEGIN.
- Real PostgreSQL + RustFS targeted files/revision/new suite: 39 passed, zero skipped. Server typecheck passed. After the review-only test strengthening, the two targeted tests passed again.
- Independent review found no production blocker. No full-monorepo run, CI success or browser acceptance claimed.

## Integration

This change is independent of #62 streaming verification and #54 readiness. Three-way merge against the inspected local T05 candidate's `queries.ts` was clean; its `purge_started_at` filtering must remain. Separately, #62 and exact #54 storage changes merged textually clean, while later T05 storage adapters require explicit conflict resolution preserving `checkReady`, `verifyObject`, and `removeUnreferenced`. Recheck target and final candidates before merging.
