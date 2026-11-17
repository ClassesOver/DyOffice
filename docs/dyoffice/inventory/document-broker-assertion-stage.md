# Broker assertion provenance, not operating-system stop proof

This candidate is test-only. It verifies a real Ed25519 signature and records a
one-time PostgreSQL challenge/receipt against a held recovery claim. It does not
connect to a broker, inspect a cgroup, create a StopObservation, or release a
reservation. The production factory remains disabled.

## Why this boundary

The existing recovery ledger can prove never-started work safe to collect, but
cannot establish that an unknown live instance stopped. A signature proves which
registered key made an assertion, not whether the asserted OS fact is true.
Every accepted receipt has the distinct classification
`authenticated_assertion_os_unverified`, even for `reportedState=stopped`.
No `confirmed` field exists and no receipt is passed to the release API.

Treating test-approved runtime registration as host certification or adding a fake
Manager stop proof is excluded. There is no external PKI or new crypto algorithm.

## Real cryptography and wire contract

Node built-in Ed25519 uses `sign/verify(null, bytes, key)`, compatible with tested
Node 24; it does not depend on Node 26 context parameters. Reference:
[Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html).

SPKI is exactly 44 bytes, must parse as Ed25519 and re-export identically.
Signatures are exactly 64 bytes. Signed bytes are ASCII
`DYOFFICE_BROKER_ASSERTION_V1` followed by NUL, then UTF-8 canonical JSON of the
ordered validated assertion. Ordering is defined by the snapshot function in
`document-broker-assertion.ts`, not caller insertion order. This is a candidate
Node wire protocol, not an already-integrated Rust protocol.

Fields bind protocol/kind, challenge ID, PG nonce, key ID/version, claim ID/version,
reservation ID, PG expiry and every ExecutionHandle field. Report values are
stopped/unknown. The envelope is an array of the object and canonical base64
signature. Input is bounded to 4,096 bytes before UTF-8 decode/JSON parse. Exact
re-encoding rejects duplicate keys, extra fields, whitespace and noncanonical
forms; object helpers reject accessors. No arbitrary diagnostics or content occur.

## PostgreSQL trust and transaction sequence

The trusted test owner registers public keys; no worker self-registration API
exists. Keys bind deployment and broker boot ID. Every normal update increments a
controlled version; IDs cannot be deleted/reused or reset by TRUNCATE. DB constraints permit only
scope=test-only and os_stop_certified=false. Private keys stay in test memory.

`issueBrokerChallenge(claim, keyId)` requires current ownership, matching claim
version, full persisted handle and completed blocked_uncertified observation.
It locks capacity then key, verifies key status/time and derives identity, nonce,
handle and expiry server-side. Only one challenge per claim is allowed. The fixed
test lifetime is at most 500 ms and capped by key expiry, not a proposed production
timeout. Old challenges are never silently refreshed.

`acceptBrokerAssertion(claim, bytes)` copies/parses the bounded frame before PG
awaits. Under capacity/key locks it rechecks ownership, instance, key version,
status, signature and DB clock after waits. First acceptance AND identical replay
require current key, claim and challenge validity. A differing report on a
consumed nonce fails. The unique receipt write is atomic. Current identical replay
can recover lost commit confirmation, but is not historical authentication.

Accept never changes reservation/version, launch evidence, handle or task.
The observation remains blocked. New recovery ownership fences old receipts.
Receipt/challenge growth follows the existing 64-claims-per-reservation limit.

## Evidence and limits

Real PostgreSQL and Node crypto tests cover signed-stopped-but-unreleased,
wrong signing keys/domains, full identity mutations, malformed/oversized frames,
concurrent nonce consumption, revocation/ABA, old claims, expiry after locks,
both revoke/verify lock orders, receipt rollback and successful COMMIT followed
by injected lost client confirmation. An expiry-replay regression was demonstrated
RED and corrected. Private signing keys are generated in memory for each fixture.

These do not prove real broker identity provisioning, real network packet loss,
OS stop, cgroup emptiness, host certification or production least privilege.
SQL applies only to fresh isolated test schemas, outside the application migration
manifest. Existing fixture stop APIs do not become production authority.

Final review regressions: cascading key-table TRUNCATE is rejected, and receipt
INSERT delayed across challenge expiry rolls back after a final DB-clock check.
Both were reproduced RED against the initial implementation. This is an
accepted-at-final-check provenance record, not a promise that a key/challenge is
still valid at COMMIT, client receipt, or later use. It is never a TTL grant.
