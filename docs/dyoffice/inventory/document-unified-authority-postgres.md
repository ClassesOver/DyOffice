# Explicit test-only native context bridge

## Deliberately narrow model

The bridge supports one **immutable native read-only snapshot**, with generation
exactly zero, `pptx.roundtrip` native provenance and only `pptx-edit-v1` outline
execution. It does not model interactive editor generations or provide a multi-tenant
ACL. Production assembly is still absent and every profile remains disabled.

Three candidate tables supply facts the current native model does not establish:

1. `document_scope_bindings`: an explicit personal-owner isolation-scope mapping,
   unique by deployment/owner. Its tenant ID is a registered isolation label, not
   the owner/workspace ID and not permission to read any other owner's files.
2. `document_runtime_approvals`: deployment-bound, profile/digest/policy registration,
   explicitly `test-approved`. This is **not** actual OCI/systemd/openEuler runtime
   certification or measured attestation.
3. `document_execution_contexts`: immutable native facts, pinned scope/runtime
   versions, server-built request, generation zero and a fixed expiry. A trusted
   issuer creates this only after real native authorization inside the transaction.

No registry is populated automatically in production. Missing registrations fail.
The trusted test owner registers scope/runtime rows; the restricted issuer cannot
write registries or supply arbitrary unverified native facts. The worker can only
verify a context, not issue one. A future real control plane must establish the
meaning and trustworthy source of each registration before deployment.

## Ownership, versions and anti-replay

The dispatcher supplies a trusted `{id, version}` ContextRef plus the native job
capability. They are captured by the verifier, not selected from document content.
Every phase (`pre`, `before_start`, `post`, `return`) re-reads that exact context,
scope and runtime version with row locks in one PostgreSQL transaction and repeats
native authorization at its end. SQL returns the issuer-built immutable request;
the wrapper validates it and compares all fields against the caller snapshot.

Scope/runtime UPDATE triggers force monotonic versions even if a caller attempts
to set an old version or toggles active off and on. Context permits only active →
revoked with CAS version; changes need a new context. All three tables reject row
DELETE and TRUNCATE so identities cannot be deleted and reinserted to resurrect old
references. These guards protect ordinary control-plane mistakes, not a malicious
migration owner able to disable triggers or replace functions.

The session binding is a domain-separated SHA-256 digest of a fresh PostgreSQL
random UUID plus session identity. It is a context correlation identifier, **not a
credential**, session token digest or job claim hash. Native proof independently
revalidates the actual session and job capability; possessing the digest alone grants
nothing. No credential is sent to the backend or returned in proof errors.

## Time and execution behavior

PostgreSQL checks expiry after all relevant locks, using the minimum of native
job/session/edit validity, context deadline and scope/runtime expiry. The bridge
subtracts round-trip time and a conservative margin. `AuthoritySnapshot.validForMs`
is now required. The coordinator anchors it to the monotonic start of the verify
call, not the later receipt time; extra subtraction of verifier latency is
intentionally conservative. Wall `validUntil` remains only a supplementary check,
never a way to extend the monotonic deadline after clock rollback.

Authority remains revocable immediately after transaction commit. No result is
returned without later phase rechecks, confirmed backend stop and ledger release.
The actual trusted-dispatch and real broker/OS isolation adapters are still absent.
The demonstrated integration uses real PostgreSQL scope/authority/reservations and
a fake outline backend, not an operational document sandbox.

## Candidate installation and tests

`document-unified-authority.candidate.sql` is unregistered. It depends on current
native migrations and `document-native-authority.candidate.sql`. No application
migration manifest, existing database roles, OS security or runtime entrypoint is
changed. Tests install everything under random roles/schema in the dedicated test
cluster and remove only those temporary resources on teardown.

The updated `test/sandbox-pg/document-authority.test.mjs` exercises:

- Explicit scope registration, one scope per personal owner and deployment-bound
  runtime approvals; missing, foreign, expired or wrong-format registrations deny.
- Worker cannot issue contexts/read-write registry tables; issuer cannot approve a
  runtime; immutable context facts cannot be rewritten.
- Version ABA, forbidden identity recycling, concurrent revoke CAS and stale refs.
- Real overlapping verify/revoke transactions in both lock orders, and runtime
  approval expiration while blocked on its row lock.
- Native revocation after issuance and SQL expiry while waiting on registry/context
  row locks.
- Real authority + real reservation ledger + outline coordinator success and
  revocation at each of the four phases, with no business success after revocation.
- Required monotonic duration and proof-consumption delay with wall-clock rollback.

Run from `apps/web` with installed dependencies and a dedicated test database:

```sh
DYOFFICE_TEST_DATABASE_URL=postgresql://testadmin@127.0.0.1:55447/postgres \
  node --experimental-strip-types --test --test-concurrency=1 test/sandbox-pg/*.test.mjs
node --experimental-strip-types --test test/sandbox/*.test.mjs
```

A separate `SET SESSION AUTHORIZATION` test gives the temporary worker both
`session_user` and `current_user`, and proves it cannot switch to the owner role,
write/truncate registries or execute issuer-only revoke. This is not a password or
network authentication-chain test. Temporary cleanup includes the issuer role.

The existing 22 source migrations are test inputs, not added publication files.
Candidate rollback means leaving production disabled and candidates unregistered.
Do not delete live contexts or reservations as a production rollback procedure.
