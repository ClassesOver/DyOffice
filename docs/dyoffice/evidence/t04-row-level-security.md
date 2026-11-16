# T04 row-level security and resource authorization

> 2026-11-16 · PostgreSQL 16. The development journal still does not open a database connection.

## Why this slice

T05 left `dyoffice_files` without a policy. T06 left the revision ledger, leases, idempotency, and outbox the same way, and the caller supplied the dev principal. T04 is the database ownership boundary those tasks deferred. T08 needs `authorize(principal, action, resource)` so a job can name an artifact id and nothing else.

There is no open T04 pull request to extend. `0002_rls.sql` in the original file list is already the login-rate migration, so the policies are `server/db/migrations/0005_rls.sql`.

## Principal

`createSessionService.authenticate()` is already on this branch. It returns `{ userId, deploymentId, sessionId, roles, expiresAt }`. `principalFromSession` copies that user id into `ownerId` and ignores any owner supplied beside it. A role, including `config_admin`, does not widen file visibility.

The running `server/index.mjs` does not mount that authenticator. Until it does, Fastify maps the personal development token to `{ userId: 'dev-personal', ownerId: 'dev-personal', deploymentId: 'dev', sessionId: 'dev-editor', roles: ['user'] }` and the admin token to `dev-admin` with `config_admin`. Request bodies and extra headers cannot change those fields. Configuring `auth.authenticate` replaces the development token for that process.

`dyoffice_auth` may read credential tables before a principal exists. It has no grant on files, revisions, workspaces, or the outbox. Session lookup still uses the migration connection, which is the existing T03 pool. This change does not rewrite `session-core.mjs`, because that work is in progress separately. The auth role is ready for that switch.

## What the database does

`withPrincipalTransaction` starts a transaction, runs `SET LOCAL ROLE dyoffice_app`, rejects the connection unless that role is the current user and is not a superuser, table owner, or `BYPASSRLS` role, then calls `set_config('app.current_user', $1, true)` together with the deployment and session settings. The third argument is transaction-local. Commit and rollback clear it before the connection returns to the pool. There is no connection-wide `SET app.current_user`.

Every owned table has `ENABLE` and `FORCE ROW LEVEL SECURITY`: workspaces, files, revision files, revisions, leases, revision uploads, idempotency, outbox, users, roles, sessions, password-action tokens, and admin bootstrap. Policies for `dyoffice_app` match owner and deployment. A missing or empty setting matches no row. `WITH CHECK` rejects an insert or owner change into another scope. `dyoffice_files` references a workspace with `(deployment_id, owner_user_id, workspace_id)`, and revision rows reference `(deployment_id, owner_id, file_id)`. Login-rate buckets have no owner. They are not covered by RLS. `dyoffice_app` has no privilege on them.

The runtime proof uses `dyoffice_rls_login`, a login that is not a superuser and does not bypass row security. The helper then switches to `dyoffice_app`. A superuser connection fails `assertAppRole` before that switch. `SET ROLE` back to a privileged or auth role from `dyoffice_app` is denied.

## RED then GREEN

`node --test apps/web/test/rls-migration.test.mjs` failed first because `0005_rls.sql` did not exist (`ENOENT`). After the migration, that file passes, and the PostgreSQL file passes on PostgreSQL 16 with `DYOFFICE_TEST_DATABASE_URL` set.

The database test covers:

- role flags, table owner, `FORCE` on every owned table, and functions that are not `SECURITY DEFINER`
- `dyoffice_app` cannot read `password_hash`
- `dyoffice_auth` can read a password hash for login and cannot select files or the outbox
- A sees A's file; B sees none of A's files, revisions, or outbox rows, and only B's own user and workspace
- a config admin sees none of A's files
- no setting, or a user setting without a deployment, returns no file rows
- changing a file's owner and inserting a file for another owner raise `42501`
- a file that points at another owner's workspace, and a revision that points at another owner's file, raise `23503`
- a thrown callback and an invalid SQL statement roll back; the same backend process then serves B with B's setting and does not see the abandoned insert
- outside the helper the setting is empty and the login role is current again; `dyoffice_app` with that empty setting sees no files
- `job:enqueue` and `job:cancel` for B or the admin return the same `文件不存在` / `NOT_FOUND` body as a missing id
- an HTTP request authenticated by `createSessionService` allows A, and returns that same body for B, the admin, a forged `ownerId` or `role`, and a missing id

`npm run test:web` without the database URL skips the two PostgreSQL tests. Node v22.23.4:

- `npm run test:web` — 114 passed, 3 skipped (the two ownership tests, and MinIO)
- `DYOFFICE_TEST_DATABASE_URL` set — `ownership-rls.test.mjs` 2 passed
- fresh databases — local identity, local login, and session-core passed with `0005_rls.sql` included
- `npm run typecheck:web` — passed
- `node tools/check-web-boundaries.mjs` — 124 files, 0 violations
- `npm run test:web:build` — 2 passed
- `node tools/dyoffice/compatibility-baseline.mjs --check` — 84 files, 0 changes
- revision-commit 13 passed; api-compat 5 passed; route cutover 1 passed

CI runs the PostgreSQL file in [dyoffice-t04-rls.yml](../../../.github/workflows/dyoffice-t04-rls.yml) against a Postgres 16 service.

## Closeout

| Item | Result |
| --- | --- |
| A/B cross access for files, revisions, outbox, workspaces, and users | Done. `ownership-rls.test.mjs` |
| Same pooled connection, thrown error, SQL error, then the other principal | Done. Backend pid reused, setting not left behind |
| Config admin reads another person's file | Done. SQL and HTTP. Same not-found body as a missing id |
| Cross-owner workspace and revision references | Done. `23503` |
| Background job with the wrong principal | Done. `authorize(..., 'job:enqueue' \| 'job:cancel', { artifactId })` |
| Non-owner, non-superuser, `NOBYPASSRLS` role | Done. `dyoffice_rls_login` then `dyoffice_app` |
| Scope filter, `FORCE RLS`, transaction-local identity, default deny | Done. `0005_rls.sql` and `server/db/context.mjs` |
| Fastify request principal | Done. Development token, or `auth.authenticate` when configured |
| T05 `dyoffice_files` and T06 ledger tables | Policies live in `0005`. `0003` and `0004` are unchanged because they were already applied |

### Deferred

| Item | Owner | Why |
| --- | --- | --- |
| Mounting login on `server/index.mjs` and moving session lookup onto `dyoffice_auth` | T03 | The session interface is consumed. The development server still starts without a database pool. Changing session SQL would overlap the auth work in progress. |
| Two-connection revocation races, reset-token consumption, and lock order | T03 | Those cases revoke credentials. This task does not change session issuance. |
| Preference, source, and conversation rows | later tasks | Those records are still the development JSON store. There is no owned table to protect. |
| Job rows and outbox delivery | T08 | `authorize` checks the artifact id. It does not insert a job. Outbox rows are owner-scoped; nothing delivers them. |
| Login-rate buckets | T03 | The table has no owner. The app role has no privilege. A policy would not express a per-user boundary. |
| Revision commits through PostgreSQL | later runtime work | The Web process still commits on the single-process journal. The SQL policies apply when that path uses `withPrincipalTransaction`. |
| Multi-node object storage | operations | Unchanged from T05. |
