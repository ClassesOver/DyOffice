# Durable dispatch observation ledger (candidate)

This SaaS server-side slice extends the existing test-candidate PostgreSQL
reservation ledger. It does not add an execution endpoint, registered migration,
worker permission, authenticated broker channel or runtime approval. No Rust
LaunchSpec is constructed. A dispatch observation is never an executable grant.

`prepareDispatch` uses the current reservation owner capability, job fence and
validated stored request. Under the existing deployment capacity lock it writes
`may_started`, advances the reservation to `start_intent`, and inserts exactly one
dispatch bound to its resulting version, request digest, broker identity/boot and
expiry. The request digest is SHA-256 of UTF-8 domain
`dyoffice.dispatch.request.v1` followed by NUL and compact JSON of the validated
flat request sorted by ASCII key. Identity is data binding, not authentication.
No caller-supplied digest or expiry is accepted.

`consumeDispatch` checks current ownership/version, live fence, unchanged request,
exact broker incarnation and challenge under the same lock. The first transaction
records a challenge and returns `first_consumed_observation`. The same challenge
can subsequently return only `already_consumed`, never a new first-consumed
result. Different challenge/boot, recovery takeover, expiry or request changes
reject. Consume does not update reservation version; recovery/retain does, so old
receipt replay cannot restore an old owner. Database clock is rechecked after
writes to cover trigger/lock delays; request validation also conservatively checks
application wall time, so this is not a database-clock-only acceptance policy.

Prepare retries reject rather than resetting state. If COMMIT actually succeeded
but its client confirmation was lost, `observeDispatch` finds the historical ID
by deployment/reservation. Reconstructing an adapter does not recover the owner
capability: it may observe history only. No automatic resend or new attempt is
performed. Historical observations omit credentials, owner tokens and the original
request. All consumed/unknown intent remains capacity-charged and cannot be
released by `notStarted` evidence.

The candidate table guards ordinary UPDATE/DELETE/TRUNCATE against identity
replacement and consumption reset. They do not authenticate INSERT authors: the
current adapter uses a trusted test-owner pool with direct table access. A trusted
owner bypassing triggers/DDL or inserting fabricated rows is outside this test
model. Production least-privilege issuer functions and independently authenticated
broker/control-plane admission remain unimplemented. A paused broker may still
send an old request without future broker-side durable fencing; this ledger alone
is not exactly-once process execution or a stop proof.

## Verification

Real isolated PostgreSQL tests cover first/duplicate consumption, competing
prepares/consumes, recovery in both lock orders, epoch advancement, wrong boot,
legacy intents, immutable identity, mutable-input capture, trigger rollback,
write/lock waits across expiry, and actual COMMIT followed by an injected client
exception. A fresh Node process also reconnects, reads history and fails to
consume because it has no old owner capability. This verifies process-separated
recovery observation, not a real network outage or crash at an arbitrary instruction.

Run the new `apps/web/test/sandbox-pg/document-dispatch-pg.test.mjs` together with
`document-reservations.test.mjs`, using a disposable database and
`DYOFFICE_TEST_DATABASE_URL`. The test creates and removes its own random schema.
No RustFS, production database, host settings or runtime process is involved.
