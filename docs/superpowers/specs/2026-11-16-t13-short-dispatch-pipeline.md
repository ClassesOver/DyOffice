# T13 admin pipeline: short dispatch transaction design

Default unmounted. Dependencies #68 coordinator/routes/browser, #70 parser, #74
admin budget/secret (0018/19 -> #73 0020 ->0021), #76 pinned egress. #71 personal
owner validator remains separate: deployment keys must not gain fabricated owners.

Basic session/admin/config authorization precedes any DNS/TLS preconnection.
Server constructs the final canonical body once; its exact bytes/model/token cap
and digest bind reserve/claim and egress. No provider URL/key/header from the request.

## Linearization and short locks
1. reserve and one-time claim commit before TLS. No DB connection remains held
   during DNS/TLS. The TLS request has no Authorization and is not flushed.
2. After exact authorized peer/IP/443 verification, invoke a server-only authority
   callback. Its first step commits unique takeForDispatch to unknown. Then #74
   locks current principal/config, verifies exact model/revision/provider/profile
   and decrypts. This callback's consume action ONLY sets the Authorization header,
   ends the fixed private body and awaits request finish. It does not parse or
   consume response data. Final DB authorization/commit completes before reading
   any response. A failure after dispatch intent never refunds or retries.
3. Auth/write window is capped at5 seconds including waiting for authorization,
   bounded by total30-second operation timeout. Abort synchronously disables the
   writer and destroys the request. Pending DB/DNS promises retain admission until
   settled. The writer accepts only credential bytes, is single-use, and cannot
   change endpoint/body/headers; calls after callback lifetime/abort/deadline reject.
4. Recheck the exact live TLS socket immediately before end. A closed/replaced or
   unauthenticated peer cannot send. Default certificate hostname/SNI checks stay.
5. Release DB locks/connection after flush authorization commits. Response chunks
   and emitted events get fresh short session/admin/config/revision/profile checks.
   No DB transaction spans response streaming or client backpressure. Thus a
   revocation can commit during a stalled response and the next check rejects.

This linearizes dispatch before or after a concurrent revoke; it does NOT retract
an already sent request or already buffered response. No instantaneous vendor-side
cancel claim. A silent upstream is stopped by the total deadline. Prior-sent data
cannot be undone. Revoked sessions may leave dispatching/unknown holds for operator
reconciliation rather than authorizing an automatic refund.

## Stream and settlement
A one-chunk backpressure bridge feeds the strict parser. No unbounded queue.
Text/reasoning can stream after short checks; tool candidates/usage/terminal reason
are held until parser DONE, producer success and conservative full-charge settlement.
No candidate executes or receives T14 approval. Malformed/canceled output, transport
failure or downstream failure aborts the producer and keeps the hold. Only an
unclaimed reserved record may cancel/refund. Callback/HTTP terminal remains once.

## Test and production gates
Synthetic credentials, real isolated PostgreSQL and mocked DNS/HTTPS only. Cover
single business connection, exact wire digest, duplicate turn/claim, malformed SSE,
errors without key leakage, cancellation cleanup, revocation while response stalls,
and the opposite ordering: in-progress flush holds its short auth lock until abort
or finish. Prove no new send after a revoke committed before dispatch authorization.
HTTP/browser path is explicitly mounted inside the test only. Real resolver/TLS
upstream acceptance, distributed rate limits, ordinary-user entitlements and vendor
financial ceilings remain separate gates. Independent final safety review required.

Event authorization is a bounded acceptance decision at the last short check, not
an atomic network delivery guarantee. A revoke may commit after that check but
before the already-accepted event is delivered. Such an accepted/buffered event
cannot be recalled; subsequent checks reject. Tests explicitly place a revoke in
this gap instead of promising zero post-commit deliveries. No database lock is held
while awaiting client/backpressure delivery to pretend this gap can be eliminated.
