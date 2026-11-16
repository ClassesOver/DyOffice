# T13 invocation contract stage (unmounted)

Base: feat/dyoffice-web 10793fcdc93f033c33a886434be35f3a6d83733d.
This adds only a pure validator. It does NOT authorize a user, decrypt a key,
reserve money, pin DNS, call a provider, enable a route, or complete T13.
No dependency on unmerged #68/#70. T12 #52 at cc0c6ac61d2949d57f4ba8f4632886ec7bca7591
has no ordinary-user scoped credential-consumption callback.

## Bounded implementation
The server-only validator checks exact deployment/user/session/turn/model/config/revision
bindings across a trusted permit and reservation snapshot; enabled/expiry/reserved
state; user-owned credential reference; a unique same-deployment/revision fixed
HTTPS egress profile; positive safe token ceilings. It projects immutable primitive
fields, forbids extra transport/secret fields, and redacts failures. It holds no
credential material and has no logging or network dependency.
Deployment-shared/admin-owned credentials intentionally fail closed. Their explicit
policy cannot be inferred from administrator configuration visibility.

These are UNTRUSTED DATA if received from HTTP. Calling this validator with matching
client-fabricated records does not authenticate them. A plan is not a capability:
do not accept serialized plans, pass them to an unrestricted fetch, or skip DB
revalidation/claim on the basis of successful validation.

## Required secret and egress integration (not implemented)
A trusted T12 adapter must read model eligibility for the current authenticated
session and exact config revision, under existing tenant/owner restrictions.
It must provide a narrowly scoped server-private callback which decrypts only that
credential and invokes only a reviewed transport; no return-key/admin decrypt API
and no general URL or user-supplied headers. Raw credential material, upstream
headers/errors, and request document content must never enter logs or returned DTOs.
The callback must revalidate revocation/config version at dispatch. Do not broaden
RLS to accommodate it. Current T12 does not provide this authorization path.

The egress adapter must resolve and pin vetted public peer addresses, reject local,
private, link-local and metadata destinations, disable redirects and retries, bound
request/response bytes and time, and connect only to the approved protocol/origin/path.
A URL syntax check is not SSRF protection. This validator deliberately has no
production transport. Real provider calls require credentials and user authorization;
tests here use no real service or user document.

## Persistent budget design (not implemented; no migration claimed)
Use a DB transaction/row lock or equivalent conditional debit to reserve a bounded
worst-case cost in integer currency units before dispatch. Token limits alone are
NOT a monetary cap; bind immutable pricing revision and conservative input/output
ceilings, rejecting missing pricing. Do not release capacity merely on local timeout.
Reservation idempotency key must bind deployment, owner, session, turn, model,
config/pricing revision and canonical request digest; same key with changed inputs
must reject. Concurrent requests must not overspend.

State machine: reserved -> dispatching (single atomic fenced claim) -> settled.
Cancellation before claim can release; after possible dispatch, missing usage,
disconnect, parser error, process crash or lease expiry leads to unknown and holds
the reservation until reconciliation. Never retry provider dispatch automatically.
The durable journal must commit dispatch intent before sending; recovery cannot
infer that no external request happened from an absent local response. Settlement
must be idempotent and reject mismatched/over-ceiling usage instead of silently
refunding. Audit records contain opaque identifiers, never keys or document text.
Unknown records require a bounded operational reconciliation policy, not a TTL refund.

The current validator only checks a snapshot named reserved. It does not prevent
replay/TOCTOU, enforce canonical request binding, or perform durable claim. Production
mounting is blocked on all of the above and real PostgreSQL concurrency/crash tests.

## Verification
RED: valid-plan test failed against deny-all stub (missing feature).
GREEN: 33/33 Node tests, zero skip; strict targeted TypeScript passed.
Tests cover detached projection, all reservation scope dimensions, owner/tenant
mismatch, disabled/expired state, invalid caps, duplicate/missing profiles, secret
and URL injection, malformed input and generic failures.
Only this isolated stage tested; no full repository test pass is claimed.
A side-by-side rerun of #68 route/coordinator/browser tests, #70 parser tests and
this stage passed 90/90, zero skip. These ran against their separate staged files,
not a merged full checkout or full repository suite.
