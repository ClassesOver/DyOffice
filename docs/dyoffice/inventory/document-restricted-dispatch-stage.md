# Restricted native-backed dispatch observations

This server-side SaaS candidate adds actual least-privilege PostgreSQL entry
points to the existing dispatch ledger. It is not a registered deployment
migration, OS broker certificate, production execution gateway, or runtime grant.
Rust `ApprovedRuntime` remains unavailable and no document process is started.

## Real identity and single transition implementation

A trusted provisioning owner assigns one reserved row to an immutable issuer and
consumer registration, capturing its current owner capability and version inside
PostgreSQL. Neither caller sees or supplies that capability. Registrations bind a
single database login role OID to deployment and purpose; consumer also fixes the
broker ID/boot ID. Only one-way revocation is allowed, with controlled version
increment, and assignment/native bindings cannot be rewritten or recycled.

The caller check uses the current backend's `pg_stat_activity.usesysid`, matching
its original login identity with `session_user` and a still-existing role of the
same OID/name. SECURITY DEFINER `current_user` is never treated as the caller.
A dropped/recreated role name cannot inherit an old registration. Tests use real
restricted LOGIN connections to the isolated cluster (whose local authentication
policy is unchanged), not `SET ROLE` masquerading as a new login. They do not
certify production network authentication or host broker identity.

An unlocked caller/assignment prefilter precedes all private-credential native
checks. It cannot grant anything: after the existing native principal locking
and deployment capacity serialization, every relevant binding is re-read under
locks. This prevents an unrelated consumer who knows a dispatch UUID from using
stored claim credentials to block the victim's job. Existing native authorization
functions retain their users/session/job/file/lease lock ordering.

The restricted issuer derives native facts from current PG state and compares
owner/actor, deployment/job/epoch/attempt, file/base revision, editor/lease epoch,
input size/SHA and format/profile consistency with the reservation. It then uses
the same private SQL transition core as the original test-owner adapter. The
consumer reruns native authorization from the private binding and checks current
registration/version/boot, ownership, reservation version, epoch fence, request
digest and expiry before the same consume CAS. A final native and deadline check
covers waits and writes. Exact replay yields only `already_consumed`.

`tenantId`, `sessionBindingDigest`, `generation`, `policyVersion`, runtime digest,
and runtime approval are not authenticated by this native wrapper. The
`native_verified_*_observation` classification covers only the listed native
facts at the checked instant, not the complete execution request. COMMIT/return
may occur after a later revocation; no irrevocable authorization interval is
promised. The claim hash retained privately is a service credential, not a public
metadata hash, and is excluded from every return/history shape.

History is a non-authorizing observation of already recorded data. Its current
registration read establishes the observation point; concurrent later revocation
does not retroactively erase that historical read. It does not renew native
permission, recover an owner capability, resubmit, stop or release anything.

## Permissions and verification

All application objects/functions are schema-qualified. SECURITY DEFINER entries
have `search_path=pg_catalog`, are owned by a non-superuser/NOBYPASSRLS role, revoke
PUBLIC EXECUTE and separate issuer from consumer. Caller roles cannot read/write
ledger or native tables, provision assignments, invoke private transition/auth
helpers, create schema objects or SET ROLE to the owner. The trusted owner can
still install/change DDL; this candidate is not a malicious-administrator defense.

Most negative tests populate rows through the actual native migrations to isolate
SQL permission and race conditions. A separate positive test uses actual services:
trusted generated PDF import, session-authenticated enqueue, restricted worker
claim, job-credential lease acquisition, assignment, restricted issue and consume.
No native job/session/lease rows are directly inserted for that positive path.
Its per-attempt request deadline is conservatively min(native deadline, now+20s),
serialized to strict millisecond UTC ISO; validators are not relaxed. This tests
PDF native facts → ledger only, not the PDF execution coordinator or unified
runtime authority, and the job remains running without a save/execute result.

True PG tests cover wrong callers/tokens/registrations, direct-table and helper
ACL rejection, role-name recreation with old and new connections, revoke and
consume in both lock orders, native session/lease/head changes, competing
consumers, recovery fencing, actual COMMIT then client-confirmation failure,
foreign-consumer immediate rejection while victim job is locked, and authoritative
recheck after native/capacity waits. Existing dispatch/reservation tests continue
to cover trigger rollback, expiry and restart history semantics using the shared
core. A test transport pause moved from old direct-DML calls to the equivalent
shared-core SELECT; no test bypasses the new transitions.
