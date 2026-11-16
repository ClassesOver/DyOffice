# T05 completed-publication orphan reclamation

This is a bounded fix, not full T05 lifecycle completion. It does not permanently empty trash, delete referenced revisions, collect ambiguous receiving uploads, or reclaim versioned S3 storage.

## Invariants

- Personal session staging (import and revision) first commits expiry, then performs bounded collection in a separate authorized transaction. Job credentials never receive account-wide reclamation authority.
- Account lock precedes terminal upload locks. Eligible rows are cancelled/expired, have a SHA registered after successful publication, no completed file reference, no revision reference, and no reclamation marker.
- Physically remove only the server-derived owner/revision key. Credit stored bytes and mark reclamation exactly once in the same transaction, retaining upload tombstones/unique key identities.
- A deletion cannot roll back. If the later transaction fails or the process dies, charge/marker roll back; repeated deletion of a missing object is safe. Terminalization is already committed, so retry cannot revive a publishable upload.
- Collection attempts at most one object per staging request. The two S3 commands share a five-second abort signal; this bounds S3 work, not DB-lock waits or the full transaction. Several retries may be needed to free enough quota.
- Storage deletion failures retain charges and do not block uploads with remaining quota. SQL/authorization/transaction failures propagate.
- S3 adapters require an unversioned bucket, reject enabled/suspended versioning, and refuse to credit a delete-marker/version response. Lack of bucket-versioning permission fails closed for reclamation, not ordinary upload.

## Verification

Independent app dependencies were installed from apps/web/package-lock.json using npm ci. Temporary test storage lives in the workspace, not the full /tmp volume.

- Focused control-flow and actual local-store tests: 7 passed.
- Real PostgreSQL 17.11 + actual local/S3-compatible stores: cross-owner filtering, retained history/trash restoration, rollback after deletion, duplicate reclamation, receiving exclusion, committed expiry, and concurrent collector/stale-finish rejection.
- A separate Node process exits with code 77 after physical removal but before commit; live database rollback retains the charge, and retry credits exactly once.
- Real RustFS 1.0.6 tests verify missing-object idempotency and enabled/suspended bucket preservation. This is S3-compatible protocol evidence, not an AWS production deployment claim.
- Related file/revision/job-output plus new GC/storage suite: 57 passed before the final target integration. Final integration results must be appended before publication; do not treat earlier fixture failures as passes.
- Initial attempts without a disposable PostgreSQL URL failed fixture setup. One old quota test was updated to check actual object removal and new reservation after collection, instead of expecting permanently occupied orphan capacity.

## Remaining lifecycle work

Ambiguous receiving uploads need a durable late-write fence/terminal proof; merely waiting longer is not sufficient. The separate [per-file permanent purge](t05-permanent-trash-purge.md) adds an explicit tombstone protocol for revisions, restore provenance, leases, jobs, idempotency receipts and outbox references; it does not reclaim uncertain late PUTs or implement bulk UI/background retention. These are not silently covered by old dyoffice_files lifecycle tests.

## Latest integration

Integrated on `0672c6695057155c5e8eee4b2a9862b56599bb4c` with migration0016, followed by permanent-purge0017. The entire real-service local-integration/jobs/storage repeat passed260/260 with no skips. Web/unit338 passed with one existing optional skip; frontend/server strict types and the browser dependency gate passed. Import and revision stage routes now share the two-slot object-I/O limit because staging can delete an abandoned object. See [final integration evidence and limitations](t05-permanent-trash-purge.md#latest-target-integration-2026-11-16); earlier candidate totals are historical, not additive.
