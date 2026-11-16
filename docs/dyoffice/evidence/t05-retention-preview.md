# T05 read-only retention preview (unmounted prerequisite)

## Scope

Adds a pure TypeScript classifier for an already-authorized owner-scoped trash snapshot. It chooses no retention duration: absent/disabled policy yields no candidates. An explicit enabled duration, clock and result limit are required. At most 1,000 input rows and 100 results; candidates sort by deletion time then ID. Foreign-scope, duplicate, malformed, missing or ambiguous typed fields reject the entire snapshot. Future timestamps, live files, begun/completed purges, active jobs, receiving uploads and uncertain uploads are excluded. Results are detached/frozen, contain only IDs/timestamps and are explicitly `review_only`.

This module has no imports, database calls, routes, object store, scheduler or deletion. It does not authorize a caller and must never consume untrusted client claims as authoritative snapshots. A future adapter must read an authorized coherent database snapshot. A preview can become stale immediately; any actual purge must freshly authenticate and recheck current file/upload/job state in the existing locked purge transaction. It must also apply the eventual legal-hold/retention policy, storage-versioning handling and confirmation requirements. This module does not weaken those gates.

## Evidence

- Safe stub returned no candidates; initial 11 assertions exposed missing behavior before implementation.
- Final focused tests: 15/15, zero skipped.
- Strict standalone TypeScript passed. Independent review reran all 15 cases and found no blocker for this pure scope.
- Ordinary Web directory on the same T12 snapshot: 265 passed, 1 optional S3 test skipped, zero failed.
- Combined Web unit directory on isolated existing T12 backend snapshot: 101/101, zero skipped. This is not a claim of current target or full repository integration.
- Actual root `npm test` attempted; stopped in docx-engine with Killed/exit 137. Earlier workspace tests in its log passed; full suite not passed.

## Limits

No real PostgreSQL, S3 or browser tests apply to this pure function, and none were run. No background retention execution, batch-empty UI, lease-state acquisition/verification, legal-hold policy, versioned bucket reclamation or account erasure was implemented. `blocked` counts each row’s first applicable reason only, not every risk. An omitted legal hold or lease in this preparatory schema is not permission to ignore it at execution. No real data was read or deleted. Candidate is prepared for draft publication only, not merged or enabled. Existing application files and migrations are unchanged.
