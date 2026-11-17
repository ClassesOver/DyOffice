# Candidate persistent reconciliation stage

This stage is test-only and does not register a production migration or broker.
Existing reservation transactions serialize deployment capacity and rotate owner
capabilities. Recovery currently quarantines a row but loses whether launch intent
was durably recorded. This stage preserves that evidence explicitly.

## Chosen boundary

- Store launch evidence as unknown / not_started / may_started. A tombstone has
  unknown evidence. Once may_started, evidence cannot revert. Complete reservation
  facts with no intent are required for no-start release.
- Maintain a durable task for each reservation; retain wakes pending reconciliation.
  Recovery claim uses the current reservation version and a fresh owner capability.
  It fences the previous coordinator before any decision.
- A claim ID is an idempotency key bound to its owner and reservation. Observations
  bind the claim/version and are committed atomically with the reservation/task.
- Reconcile only releases verified no-start rows. Unknown launch, missing handles,
  or may_started are retained with BROKER_UNCERTIFIED; no backend is called.
  No real stop proof is fabricated. Expiry never releases capacity.
- Replays may return the identical committed result, not overwrite evidence.
  A new claimant fences delayed old observations. Crash/restart uses current CAS
  state, not an old in-memory promise or inferred successful cleanup.

Alternatives rejected: TTL release is unsafe; a simulated Manager stop is not
real evidence; adding a production broker before target acceptance is out of scope.

## Implementation sequence

1. Add real PG negative tests for tombstone/no-start distinction, concurrent claims,
   lost responses, late old claims, atomic rollback and terminal replay.
2. Add candidate schema and reservation adapter methods. Connect existing retain
   and release transitions to task bookkeeping in the same transaction.
3. Add an explicit disabled production factory and test-only reconcile runner with
   no backend API. Exercise coordinator failure → PG task → recovery lifecycle.
4. Run PG suite, TS suite and strict compilation; independent review before publish.

No environment security settings or existing DB roles are changed. Temporary test
schemas are cleaned up. The application migration manifest remains unchanged.

## Implemented interfaces and limits

`document-reservations-pg.ts` now provides `claimReconcile(reservation,
expectedVersion, claimId)` and `completeReconcile(claim)`. The claim is tied to a
fresh owner capability captured before asynchronous work. Claim IDs are bound to
reservation and original expected version. The same adapter can retry a lost claim
response; after process loss, a new adapter reads the current version and takes a
new claim. Old claims cannot write after takeover. No caller supplies an outcome:
the transaction determines it from persisted facts.

Tasks are created with reservation admission, atomically woken by retain, and
completed by release. They are not an autonomous scheduler; calling reconcile is
an explicit trusted test action that fences the current coordinator. The runner
has no broker port and cannot start, execute, observe, or stop a process. The only
new release path is proven no-start. Existing stop-shaped ledger tests remain
trusted fixture tests, not certification of real stopped instances.

Each reservation retains at most 64 claim/observation records; reaching that limit
fails closed without eviction or release. A test adapter also bounds its recovery
owner cache to 1,024 claim IDs. Outcomes are a fixed enum, not arbitrary payloads.
The runner handles one explicit reservation, with no unbounded batch scan. Existing
`recoverable()` remains a diagnostic query, not a bounded production scheduler.

Candidate SQL applies only to fresh isolated schemas. There is no ALTER/backfill
path that would mark existing unknown rows as not_started. Production migration,
restricted-role installation for this ledger, automatic scheduling, real broker
capability authentication and live-instance reconciliation remain unimplemented.

## Verification evidence

Real PostgreSQL 17: 51/51 tests (38 existing + 13 recovery tests) pass. Protocol:
68/68 pass. Tests include both launch-intent/recovery ordering cases, durable
coordinator-stop failure, response replay, cross-claim fencing, observation-write
rollback, terminal retention and bounded-history exhaustion. Initial RED was five
new tests failing on missing claimReconcile, not a database fixture error.

Commands from the repository root after starting the private test cluster:

```sh
DYOFFICE_TEST_DATABASE_URL=<private-test-db-url> node --experimental-strip-types --test --test-concurrency=1 apps/web/test/sandbox-pg/*.test.mjs
node --experimental-strip-types --test apps/web/test/sandbox/*.test.mjs
```

Logs are local validation artifacts, not committed runtime data. No fake stop was
used by the new recovery runner. These results do not prove live broker isolation,
openEuler acceptance, or a complete production recovery service.

Additional fault evidence: task INSERT failure rolls back the tombstone and leaves no epoch fence;
task terminal UPDATE failure rolls back release. A pool wrapper awaits successful
PostgreSQL COMMIT and then throws once to the client, separately for claim and
completion. Retrying the same claim key / observation recovers the committed result.
This injects lost client confirmation, not real network packet loss. Adapter
recreation is not a real operating-system process crash test.

The three added fault tests pass on unchanged implementation. In an isolated
source copy, disabling task writes and claim idempotency made all three fail at
their intended assertions; restoring the original source made all three pass.
This mutation RED/GREEN validates test sensitivity, not a newly discovered bug.
