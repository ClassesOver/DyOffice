# Native PostgreSQL authority evidence candidate

## Delivered boundary

This stage verifies **instantaneous native-job facts**, not a full unified
`AuthoritySnapshot`. It is test-gated, not wired into production. Candidate SQL is
not registered in the migration manifest and no existing runtime role is altered.
No `tenantId`, interactive generation, runtime certification or session-binding
mapping is inferred from owner IDs or public editor IDs. Those remain blocking
requirements for any complete unified authority bridge.

`document_native_authority(jsonb,text)` reuses the existing schema-qualified
`lock_job_principal(..., false)` at both entry and exit. It never permits the
`final=true` succeeded-receipt exception. It preserves the file → lease lock order
and the source `assertLiveLease` rule: job editor ID equals job ID, with exact
`job_id`, `job_epoch`, session, auth version and lease epoch provenance. Revision
metadata must belong to that file and be the current live, unreclaimed head.

The wrapper locks the personal-role row and rechecks authorization after all row
locks. PostgreSQL `clock_timestamp()` supplies observation time and the minimum
remaining job/session absolute/session idle/edit-lease duration. The TS adapter
subtracts the entire observed round trip and a 5 ms conservative margin. It exposes
this only as revocable **instant evidence**, never an irrevocable grant or promised
`validUntil`. Permission can be revoked immediately after the transaction ends.
There is no lease renewal, result commit, parsing or backend start in this stage.

Credentials stay inside the trusted verifier: caller job token is hashed before
SQL invocation; token/hash is never returned in evidence or included in errors.
Returned `inputSha256` is document-content metadata, not the job capability digest.
Source-backed metadata is not proof that object bytes were downloaded and hashed.

## Source and test model

Fixture applies the actual source SQL migrations `0001` through `0022` at
`b9dd28f0ed562e739e79b80dd43a2f9669ebcdab`, not substitute tables. Local copies only
materialize existing repository files and are **not new publication content**.
The exact file list is the repository's `server/src/db/migration-manifest.ts`.

Relevant existing implementations:
- `server/src/db/context.ts`: entry/final job principal rechecks and snapshots.
- `server/src/db/migrations/0008_job_output.sql`: `lock_job_principal`.
- `server/src/modules/leases/queries.ts`: job editor/provenance checks.
- `server/src/db/migrations/0014_session_idle_guard.sql`: current session guard.
- `server/src/db/migrations/0017_permanent_file_purge.sql`: reclamation state.

`document-authority.test.mjs` creates unique disposable schema/roles only inside
the dedicated test PostgreSQL instance. It applies migrations under a NOLOGIN,
NOSUPERUSER, NOBYPASSRLS, NOINHERIT owner; worker and outsider are equally restricted.
Worker receives only schema USAGE plus EXECUTE on the one candidate proof function.
Tests assert actual `current_user`, owner flags, fixed `search_path=pg_catalog`,
PUBLIC execute denial, no table read/write access, no private-helper execute, and
no function/schema creation by the worker. Caller search_path changes do not alter
qualified lookups. Existing production roles and OS/security settings are untouched.
These roles/schemas are removed by the test teardown, including setup failure.

Cases cover all fact mismatches, bad job capability, revoked/expired/idle session,
user disabled/password reset/auth-version change, cancelled job, expired job claim,
wrong edit provenance, same-owner different session, changed current revision,
all three deadline categories expiring behind a real row lock, and input snapshots.
Current source forbids NULL current_revision with NOT NULL. A separate explicit
nullable-schema fault injection demonstrates defensive fail-closed SQL equality;
it is not described as a presently valid application state.

## Running and publication scope

With `pg` installed, from `apps/web` using only an isolated test database:

```sh
DYOFFICE_TEST_DATABASE_URL=postgresql://testadmin@127.0.0.1:55447/postgres \
  node --experimental-strip-types --test --test-concurrency=1 test/sandbox-pg/*.test.mjs
```

The test URL must permit creating/dropping only these disposable test resources.
Do not point this fixture at production. Missing URL fails explicitly, not skip.

New candidate files: `worker/src/sandbox/document-native-authority-pg.ts`,
`document-native-authority.candidate.sql`, `test/sandbox-pg/document-authority.test.mjs`,
and this document. The existing migration copies, dependencies, PG data and logs
are local test inputs/evidence, not changes to publish.

A future deployable stage still needs registered migrations, production role
admission/manifest integration, mappings for all unified request fields, and real
broker/backend fencing. Passing this isolated role fixture does not claim those
steps or production/openEuler isolation acceptance are complete.
