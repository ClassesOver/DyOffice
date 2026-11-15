# T03a transaction layer checkpoint — 2026-11-16

> Branch: `feat/dyoffice-web`. **Partial implementation, not ready for production account registration or login.**

## Submitted implementation

- `apps/web/server/db/migrate.mjs`: reads ordered migration files, rejects duplicate version IDs and large/empty SQL files, records each migration name with SHA-256, and applies DDL + journal in one PostgreSQL transaction with an advisory lock; fails closed if an applied migration checksum or name drifts. The caller must supply a PostgreSQL-compatible connection pool. The normal Web server does **not** auto-run migrations.
- `apps/web/server/auth/bootstrap-admin.mjs`: receives a real Argon2id `passwordHasher` dependency and a PostgreSQL pool, validates the deployment ID, username/password and PHC metadata, then creates the first admin, `config_admin` role, personal workspace and bootstrap marker in one transaction. Existing accounts prevent bootstrapping. The unique deployment marker provides the cross-process duplicate-init fence; failures roll back. **No bootstrap HTTP endpoint, default password, CLI, or fake/weak crypto fallback is shipped.**
- `apps/web/test/db-migrations.test.mjs` and `apps/web/test/auth-bootstrap.test.mjs`: 7 tests for idempotency, checksum drift, bad DDL rollback, duplicate version, initial admin initialization/rollback and invalid credentials.
- `apps/web/test/integration/identity-schema.sql`: real PostgreSQL DDL test fixture for unique username, cross-deployment FK, duplicate bootstrap and active user password constraint.
- `.github/workflows/dyoffice-identity-schema.yml`: isolated PostgreSQL 16 CI job runs the 7 transaction tests and the SQL constraint fixture. Uses test-only database/password, no production secret.

## Verification

Local Node 22.16.0 isolated source test:
```sh
node --check apps/web/server/auth/bootstrap-admin.mjs
node --check apps/web/server/db/migrate.mjs
node --test apps/web/test/db-migrations.test.mjs apps/web/test/auth-bootstrap.test.mjs
# 7 passed, 0 failed
```

The fake-pool tests validate **transaction choreography only**; they do not prove PostgreSQL serialization or driver compatibility. **PostgreSQL 16 CI passed** on commit `8594456fef79108e8a2ce152a1adfb831d8d8419`: [identity-schema workflow #43734682872](https://github.com/ClassesOver/DyOffice/actions/runs/43734682872). Its `identity-schema` job shows success for the 7 transaction tests and real PostgreSQL SQL constraints (username uniqueness, cross-deployment FK, duplicate bootstrap marker, active-user password requirement). This is not proof of executing `applyMigrations()` or `bootstrapInitialAdmin()` through a real Node PostgreSQL driver.

## Outstanding blockers

1. The container in which the initial isolated tests ran cannot reach `registry.npmjs.org` (DNS `EAI_AGAIN`) and does not contain PostgreSQL. The Node `pg` driver and maintained Argon2id library **have not been installed or added to npm lockfiles**; real password hash and verify remain unimplemented.
2. A database-backed `bootstrap-admin` CLI must solicit credentials safely (no password in argv, environment, log or shell history), use the actual Argon2id implementation, and require successful migrations. Concurrent bootstrap with two real PostgreSQL connections still requires testing.
3. Password blocklist is only a tiny prefilter; production account creation requires a vetted breached-password screen and bounded hash concurrency.
4. No public login/logout/me or admin-user endpoints, cookie sessions, CSRF, throttling, RLS, file permissions or model/Office access have been enabled. The existing development Bearer-token server continues to reject `NODE_ENV=production`.
5. Before marking T03a complete: run real PostgreSQL migrations via driver twice and with corruption/rollback injection, real Argon2id hash/verify including unicode and wrong passwords, parallel first-admin attempts, legacy Web CI, and an explicit security review.

The adopted design remains [local username/password](../local-account-auth.md); **OIDC/Keycloak are not part of the plan.**
