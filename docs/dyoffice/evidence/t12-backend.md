# T12 backend-only API foundation

Date: 2026-11-16. Base: `10793fcdc93f033c33a886434be35f3a6d83733d`.
This is the complete backend subset of #52 at
`cc0c6ac61d2949d57f4ba8f4632886ec7bca7591`, not the T12 UI closeout.
The original #52 remains intact and draft for UI/browser acceptance.

## Scope and observable behavior

26 source/test files plus this evidence and an appended backend-only README section.
Includes global configuration/workspace services and routes, their DTOs, server
assembly, migrations/role provisioning, and targeted real API/security/startup tests.
Excludes Home/Settings renderer changes, local shell client/bridges, browser-host
preferences changes, new browser/theme tests and screenshots. All other tracked
base blobs are unchanged.

With a business pool configured, workspace/global configuration HTTP routes are
registered **by default**. This is observable API functionality, not an inert
migration-only patch. Current cookie sessions, CSRF, owner/RLS enforcement,
config_admin authority, revision CAS, encrypted key storage and audit remain intact.
The authenticated public projection does not contain keys or base URLs. Configuration
administration does not grant access to other users' files.

Folder/star/recent persistence exists at the API, but the old UI is unchanged and
retains its prior behavior. There is no claim that UI controls use these APIs.
Configuration checks return `connection: "not_run"`; there is no new outbound
Provider/MCP execution. Secrets remain deployment-level configuration secrets,
not user-owned credentials. No ordinary-user credential consumer or expanded
secret RLS is introduced.

## Migration contract

- Preserve applied 0001–0017 bytes/checksums exactly.
- Add **0018_global_config** and **0019_workspace** together with their manifest,
  runtime roles and services. Keep the reviewed migration contents unchanged.
- Fresh databases and an existing v17 ledger are exercised. ACK function identities,
  T05 purge/session invariants and runtime grants survive the upgrade and a second
  migration invocation is idempotent.
- Do not silently upgrade private forks that applied the old conflicting PR
  0014/0015. Do not bypass checksum enforcement or rewrite prior migrations.
- Keep `node --import tsx` for the server startup tests because the catalog imports
  Provider metadata at runtime. The provisioning CLI keeps native strip-types.

## Fresh verification on this exact backend-only snapshot

- Full real PostgreSQL 17.11 + RustFS 1.0.6 + Redis 8.0.2 related suite:
  **292/292 passed, zero skips**, 317.5s. Covers local-integration, jobs and storage,
  including fresh/v17 migration, ownership, concurrent/revoked authority, workspace,
  configuration rollback/rotation, actual startup and immutable file semantics.
- Additional real-S3 permanent purge/GC, crash/rollback retry, cross-route shared
  admission and ACK deadline collection: **27/27 passed, zero skips**, 47.3s.
- Web/unit: **351 passed, one existing optional skip, zero failures**.
- Unchanged old-client Shell DOM suite: **33/33 passed** (8 files), not browser proof.
- Server, frontend and Shell TypeScript passed. Unchanged old local-shell build
  passed in 2.16s. Boundary scan: **992 files, zero violations**. Compatibility
  input inventory: **84 files, zero changes**; this is not runtime Office parity.
- All databases, roles and buckets were disposable randomized test resources.
  No real user objects were cleaned. PostgreSQL/RustFS/Redis were stopped afterward.

## Prior timeout investigation and acceptance limits

The earlier full-UI integration run had **291/292**, with PostgreSQL `57014 statement
timeout` in the first `take_revision_delivery` call of an existing Redis delivery
test. That result remains a failure in its historical record. Unchanged isolated
retry passed 2/2, then three instrumented repetitions passed 6/6; nine sampled
claim calls took 1.08–3.91ms. A separate one-row EXPLAIN measured 0.046ms execution
and the first end-to-end worker call 56.7ms including admission. The new exact
backend-only 292-test run above also passed without concurrent unit/build work.
These successful runs **do not establish the original timeout's root cause**.
The original query had no contemporaneous lock/scheduler sampling; no SQL timeout,
assertion or security restriction was weakened. Initial diagnostic callback-wrapper
errors were fixed in an unpublished QA probe, not misreported as product failures.

Native DOCX/browser UI acceptance is not part of the passing results. The combined
candidate's independent DOCX build exited 137/Killed during transform even with
768MB heap and workspace TMPDIR. This backend split does not claim a fresh successful
DOCX build, page/theme assertions or roundtrip. Its roundtrip test change aligns only
the server subprocess entry and remains unexercised without that browser/build
prerequisite. Existing server startup paths are exercised separately above.

No full monorepo, desktop, CI, production or T12 UI completion claim. Independent
review and the parent's normal coordination are required before any merge. The
branch remains a draft; no protections are bypassed.
