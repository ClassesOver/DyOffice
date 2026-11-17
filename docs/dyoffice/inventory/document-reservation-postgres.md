# PostgreSQL reservation persistence candidate

## Status and source evidence

This is an **unregistered, test-only SQL/adapter candidate**, not a deployed migration,
not a PostgreSQL principal/lease authorizer, and not proof of production role isolation.
The default document execution factory still refuses all execution. No runtime is wired.

Source inspected at `b9dd28f0ed562e739e79b80dd43a2f9669ebcdab`:
- `server/src/modules/jobs/worker-store.ts`: `pg` Pool, transactional calls to approved
  SQL functions, separate worker runtime admission. JobClaim is not the unified request.
- `server/src/db/migration-manifest.ts`: current native migrations end at `0022`.
- `server/src/db/migrations/0009_job_leases.sql`: job provenance on edit leases is explicit,
  not inferred from editor IDs. Legacy `server/db` is not the native migration location.
- Existing production role design does not permit worker direct table writes.

The candidate uses the existing `pg` dependency in a dedicated test schema. A later
production migration must add `0023` (or next available), manifest entry, restricted
SECURITY DEFINER functions, role grant/audit lists and non-superuser runtime tests.
This change deliberately does none of those installations or permission changes.

## State and invariants

A deployment capacity row serializes every ledger operation. Capacity is **deployment
slots only**, not tenant quotas, RAM, CPU, or storage bytes. Configuration is inserted
by the trusted test owner; it is never accepted from an execution request.

Reservations are deterministic deployment/job/attempt/epoch keys. A private random
owner capability is represented by a SHA-256 digest in the database. Reserve is a
single claim, not a replayable start grant. A durable `reserved -> start_intent` CAS
precedes every backend.start. No `notStarted` release is accepted after that boundary,
including a lost start-intent response. `bound` stores the entire immutable handle.

New epochs fence old start/bind writes but never release old instance capacity. Old
owners can still clean up their exact persisted handle. Recovery claims use version
CAS and rotate ownership with a fresh capability for every takeover, including reuse
of the same adapter instance. Each write captures its expected capability before its
first await, so delayed A→B→A writes cannot regain ownership. Stale writes fail. Recovery enumeration/claim does not use
TTL to free anything and does not start a process. Unknown instances stay quarantined.
A retained tombstone created before reserve prevents late reserve resurrection and
advances the job epoch high-water mark using GREATEST, fencing older admissions
and previously reserved older starts without releasing their capacity. Such
unknown tombstones conservatively count as slots, even above configured capacity:
recording uncertainty must not be rejected for being full; new admission then fails.
Released records remain released after late retain; terminal keys never restart.

Stop observations must be confirmed and match the full persisted handle. XLSX close
or an unknown/missing handle cannot release capacity. A crash before bind may leave
no handle and is intentionally not automatically releasable. Broker-assisted discovery
and authenticated cleanup evidence are a subsequent implementation requirement.

Transactions use fixed lock/statement timeouts and roll back fence writes with failed
reservation writes. Deadline checks use PostgreSQL `clock_timestamp()` after obtaining
capacity locks. They validate only the request deadline, **not** job/edit authorization. Bind records
an already-created instance for cleanup and does not extend execution authority; the
coordinator still checks its deadline before execute and may never treat bind as a
new grant or launch after expiration.
A future real authority adapter must verify PG leases and conservatively map their
remaining validity with round-trip/clock-skew allowance.

Ledger CAS does not prove broker exactly-once launch: an old process paused after
start-intent still needs future broker-side fencing before actual launch. No production
backend is enabled by these tests. Current candidate takes an explicitly trusted
owner-level pool and must never be registered as the application's worker store.

## Tests and commands

`test/sandbox-pg/document-reservations.test.mjs` requires an explicit
`DYOFFICE_TEST_DATABASE_URL` and fails rather than silently skipping absent PG.
It creates a unique disposable schema and drops only that schema on completion.
Use a dedicated test database, not production.

From `apps/web` with dependencies installed:

```sh
DYOFFICE_TEST_DATABASE_URL=postgresql://testadmin@127.0.0.1:55447/postgres \
  node --experimental-strip-types --test test/sandbox-pg/*.test.mjs
node --experimental-strip-types --test test/sandbox/*.test.mjs
```

Local evidence uses PostgreSQL 17.11 in a private test data directory, not the existing
application database. Tests include real concurrent transactions, rollback injection,
capacity persistence, recovery owner rotation, expiry while waiting for locks,
stop/instance mismatch, and the outline coordinator with a real PG ledger and fake
backend/authority. This does not constitute actual systemd/OCI/openEuler acceptance.

Rollback: keep production disabled and leave the candidate unregistered. Only test
schemas are disposable. A future registered migration must preserve unknown ledger
rows rather than dropping tables or reclaiming their capacity blindly.
