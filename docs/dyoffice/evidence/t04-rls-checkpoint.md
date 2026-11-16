# T04 restricted connections and ownership checkpoint

2026-11-15, baseline `6258fc33`, branch `feat/dyoffice-web`. This implements a complete owned-preferences transaction seam, not enterprise signoff or document editing. Production remains guarded. Files, background jobs and external API tokens still need their own modules to adopt the boundary.

## Authority and database boundary

The local server entry requires distinct `DYOFFICE_AUTH_DATABASE_URL` and `DYOFFICE_BUSINESS_DATABASE_URL`. It rejects the migration variable `DYOFFICE_DATABASE_URL`; there is no entry-point fallback to an owner connection. Authentication has only the identity grants needed by the current services and INSERT-only workspace provisioning. Business cannot read credential tables and has only workspace SELECT, preference CRUD and EXECUTE on the narrow session-lock function. Both roles must be login identities without superuser, BYPASSRLS, inheritance, memberships, DDL, table ownership, TRUNCATE or grant options. Admission checks required and excess table privileges, effective column rights, column delegation and function delegation. PostgreSQL 17 is the tested baseline, including its MAINTAIN privilege.

The migration owner is a separate NOSUPERUSER/NOBYPASSRLS role. `npm run provision:runtime` migrates and installs grants atomically using that owner; it neither creates roles nor sets passwords. It revokes PUBLIC database CREATE/TEMP and application-schema CREATE, requiring a dedicated application database. Runtime startup checks that both pools share a database/schema and the same database advisory-lock manager. Runtime startup never performs migrations. Configuration steps are in [Web README](../../../apps/web/README.md).

Immutable migration 4 introduces personal preferences and enables FORCE RLS on preferences/workspaces, with deployment/user predicates in USING and WITH CHECK. The composite workspace reference also binds deployment and owner. A transaction accepts only a session secret, hashes it, and calls a narrowly scoped SECURITY DEFINER function. That function has a fixed pg_catalog search path, fully qualified trusted-schema tables, no PUBLIC execution and a checked nonprivileged owner. It validates user and session under user SHARE then session SHARE locks, using database time after waiting; revocation, reset flag, auth version, absolute and idle expiry are rechecked. Locks survive until business commit or rollback.

The resulting principal comes from database rows and configured deployment, never request user/owner parameters. Transaction-local settings are installed on the same connection as the business statements. Authorization and SQL predicates reinforce RLS; configuration-admin does not imply personal-resource ownership. Service routes support GET/PUT `/api/preferences` and `/api/v1/preferences`; mutation requires existing Origin/CSRF/session checks and independent business authority validation. Atomic JSON merge preserves unrelated fields in overlapping patches.

This is an application authorization boundary, not containment of arbitrary SQL execution by a compromised runtime. Runtime roles can set custom GUCs; callers never receive SQL or database credentials. RLS, explicit filtering and server-derived principal protect the supported service entry points. Future workers and tokens must independently derive their own bounded principal. The auth-only programmatic constructor remains for focused T03 tests and exposes no preference service; the actual CLI entry always requires both restricted pools.

## Executed regressions and review

New tests initially failed with missing roles/context services. Additional real failures reproduced default PUBLIC TEMP access and an owner-pool transaction factory, then passed after database privilege restriction and lazy factory admission. Fresh independent read-only review found three Important admission gaps: column-level grants, excess writes on otherwise allowed tables, and function grant options. A real PostgreSQL regression first admitted a business password-hash column grant; the corrected complete privilege matrix now rejects it, auth preference-column leaks, column grant options, excess workspace writes and function delegation. No Critical finding was reported. The review's Minor concurrency-test gap was fixed using two available business connections and an observed row-lock wait, retaining the size-one identity-reuse test separately. No new review finding is deferred; T03c's historical action-token retention Minor remains open.

Tests use randomly created dedicated databases and three actual non-superuser login roles, not a superuser business pool. They prove A/B/Admin ownership, direct-SQL cross-owner denial, composite workspace constraints, no-context invisibility, same-backend A/B/none identity cleanup after commit/callback failure/SQL rollback, ignored forged identity properties, credential/DDL/delegation denial, required-grant admission, real server startup and idempotent provisioning CLI. The test admin only creates and removes disposable infrastructure and observes lock waits. Cleanup waits for clients to exit before normal DROP DATABASE; FORCE termination was removed after reproducing a teardown socket race.

Lock-barrier tests prove both orders: a business write holding authority locks commits before disable/revoke can complete; a disable committed first causes a waiting writer to revalidate and reject without changing data. Independent business validation also rejects expired, idle, revoked, version-mismatched and reset-frozen credentials. Chromium over real local TLS uses independent Cookie contexts for Alice/Bob, saves different preferences, rejects forged owner JSON, and reads isolated values through both aliases. The existing TLS Cookie/logout and account lifecycle cases remain.

Final observed gates:

- `npm run test:web:integration`: 68 passed, zero failures/skips.
- All Web unit tests: 37 passed; legacy Web suite: 32 passed.
- `npm run test:web:build`: 2 passed; `npm run test:web:e2e`: 3 real Chromium/TLS/PostgreSQL cases passed.
- `npm run typecheck:web`: passed, including the new provisioning CLI.
- Actual Node 22 run of ownership/revocation/startup/session/migration/browser tests: 41 passed, zero failures/skips.
- `node --test tools/dyoffice/*.test.mjs`: 12 passed, including baseline/CI and IPC classification regressions.
- Compatibility baseline: 84 files, zero drift. Browser graph: 22 files, zero violations. `git diff --check`: passed.

These are local results, not GitHub Actions or customer acceptance claims. The independent review preceded the correction/regression pass; no second review is claimed.

## Migration and follow-up

Versions 1–3 remain immutable. Migration 4 adds RLS/functions/preferences; files/revisions retain planned versions 5/6. Existing legacy JSON files are not assigned to the first account. Back up a deployment before migration; rollback requires a compatible schema/application recovery plan, not deletion or rewriting of an applied checksum. This change has only touched disposable test databases.

T05 must add owned immutable file storage. T08/T19 must adopt principal transactions for workers/external tokens; T12 must provide the login/workspace UI; T20 must define audit and action-token retention. Native four-format workflows, deployment, recovery and customer gates remain unaccepted. Do not infer completion of T04's future-entry coverage, M0 or the full plan from this checkpoint.
