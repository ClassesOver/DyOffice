# T13 admin-only composed pipeline (default unmounted)

Dependencies: #68 coordinator/routes/browser; #70 strict SSE parser; #71 separate
personal-owned validation primitive; #73/0020 -> #74/0021 admin secret/budget ->
#76 fixed HTTPS egress. Migration order remains0018,0019,0020,0021. No new migration.
#71 is not misused as deployment-secret authorization: T12 secrets have no personal
owner, so this pipeline relies on actual admin session/RLS/config/claim checks.

## Actual composition
createAdminProviderPipeline is an explicit factory, never imported or mounted by
app.ts. It takes trusted profiles/keyring/transactions, no HTTP-derived endpoints,
key material, roles or pricing. Only config_admin sessions pass live basic auth.
The body builder accepts a bounded OpenAI text/tool subset and server model/token
cap, producing one final canonical byte string and SHA256. That exact digest binds
reserve, claim, credential dispatch and outgoing bytes. Unsupported reasoning
history, images/vendor fields and incomplete tool histories reject, not silently
vanish. Tool schemas are bounded JSON, not semantically validated/approved tools.

The coordinator passes only trusted token/turnId context into its stream dependency.
After reserve/claim, an additional live check precedes DNS/TLS. No DB connection or
lock spans preconnection. The new sendAuthorized path sends no Authorization/body
before peer verification. Then one takeForDispatch commits unknown, and #74's short
credential transaction authorizes/decrypts and consumes ONLY a one-time body-flush
writer. The writer cannot alter the prehashed body or endpoint; authorization and
flush are limited to5 seconds within a total<=30-second turn. Final DB recheck/commit
must finish before early response bytes can be read or delivered. Afterwards the
DB connection is released, including with a business pool of one connection.

Every response chunk and event passes a fresh short live session/admin/config/
revision/profile check, without holding locks across parser or client backpressure.
A one-chunk bridge gives bounded backpressure. Text/reasoning may stream; tool
candidates, usage and stop reason wait for parser DONE, producer success and full
conservative settlement. Tool candidates never approve or execute T14 commands.
Failures before settlement retain unknown/dispatching holds; only unclaimed reserved
state may cancel/refund. Lost delivery after settlement does not refund or reopen
that turn. Revoked sessions may need operator reconciliation of held records.

## Precise revocation and resource semantics
The fixed request flush and a revoke serialize under the short authorization locks.
A revoke committed before final dispatch authorization means zero credential/body
send. An already begun flush may finish first; cancellation/timeout destroys it and
releases the short transaction. No response-streaming lock delays a revoke.
Event acceptance linearizes at its final short check, NOT at eventual network
delivery: a revoke after that check cannot recall the already-accepted event. The
next check rejects. Tests explicitly exercise this gap. Already sent provider input
and client/network buffers cannot be retracted. No instantaneous upstream revoke
claim is made. One active turn per factory, bounded total time, transport's pending
DNS/callback capacity retention, and database lock/statement timeouts remain in force.
There is no distributed rate policy or proven vendor monetary-cost ceiling.

Legacy transport.send and raw credential-consumer factories remain explicit internal
stages, not alternate mounted routes. This composition uses only sendAuthorized and
short flush callbacks. No production mounting is authorized by these tests.

## Evidence and limits
New controlled end-to-end cases use real isolated PostgreSQL17, synthetic encrypted
credentials and mocked DNS/HTTPS (no actual provider traffic). They cover pool1,
exact wire digest, successful settlement and no same-turn replay, truncated SSE,
downstream errors, ordinary-user denial, client-field rejection, stalled response
revocation, explicit cancellation, pre-TLS revoke, short-flush revoke ordering, and
accepted-event delivery across a revoke. The explicit test-only HTTP adapter and
browser SSE transport finish once through the same pipeline. Secret-bearing upstream
errors must yield one generic error/done and no key in console/audit output.

Real DNS/TLS certificate/peer/proxy behavior, real providers, production throughput,
multimodal/vendor protocol completeness, ordinary-member entitlements, distributed
limits and vendor financial guarantees remain unverified. There is no full monorepo
or real-provider acceptance claim. Existing historical stage results are not
silently treated as new end-to-end results.

## Final measured results
- Real isolated PostgreSQL related suite30/30, zero skips:10 budget,9 credential
  and11 composed pipeline cases, including explicit HTTP/browser SSE and secret-safe
  console/audit assertions. First final run was29 pass/1 audit-read fixture failure:
  the business role intentionally lacks audit SELECT. Only the test was changed to
  the trusted migration owner with the verified admin context; no grants changed.
  The complete30-case suite was rerun and passed. PostgreSQL was stopped afterward.
- Entire Web unit directory234/234, zero skips. Independent reviewer personally
  reran the54 new/refactored unit cases and inspected the complete pipeline; they
  did not independently rerun the real PostgreSQL suite.
- Full server and browser TypeScript passed. Boundary graph993 files/0 violations.
- Production blobs reviewed: admin-pipeline d1979489319285535ee9f7097322cfe63dad7ce4,
  pinned-egress8b02d20ee05d2182fc507d6df5f9fbef7aeda529, turns53126438463c86ef0de33d9a312c1599d7bed6fa.
- Ordinary Web suite271 pass/1 explicit MinIO skip (272 total); S3 endpoint was
  unset. This is not a full monorepo, native-suite or real-provider pass.
