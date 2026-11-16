# T03b local password login service — stacked implementation checkpoint

> 2026-11-16 · Branch `feat/dyoffice-t03b-login-service`. **Depends on PR #5 (session/CSRF core)**. This is **not yet mounted** in the shared application or eligible for production login.

## Isolation and ownership

This work was created from `feat/dyoffice-t03b-session-core` commit `3e4bb784c2b126cb1986faf03a440ed2e5b11303`, so its PR must target that branch, **not** directly `feat/dyoffice-web`. It makes no changes to GenOffice renderers, DOCX, revisions, sources, `apps/web/server/application.mjs`, `apps/web/public`, Fastify T02 migration, or upstream dependency manifests.

## Implemented files and behavior

- `apps/web/server/auth/login-service.mjs`: internal local-password authentication. Normalizes usernames, fetches a tenant-scoped account, checks active/not disabled, runs real Argon2id verification with a freshly generated dummy hash for absent/disabled users, and issues a session **only on success**. Never returns password hashes to the caller. Invalid credentials have the same response category; exhausted attempt budget is distinct (429 at HTTP adapter).
- `apps/web/server/auth/login-throttle.mjs`: shared PostgreSQL transactional attempt budgets with separate deployment, client IP, and normalized account buckets. Keys are HMAC-SHA256 digests, so raw usernames/IP addresses are not stored in the bucket table. Global bucket is claimed first to limit unbounded row creation under brute-force traffic. Connection failures fail closed. All instances **must share the same secret HMAC key** and the route must use a trusted source for client IP.
- `apps/web/server/db/migrations/0002_login_rate_limits.sql`: versioned table and cleanup index for bucket counts. Database maintenance/retention GC and resource tuning are outstanding.
- `apps/web/server/auth/session-core.mjs`: extends `issue()` with optional `expectedAuthVersion`. The SQL `INSERT ... SELECT` verifies the version atomically at session creation, preventing a password-reset/role-change race after the password was verified.
- `apps/web/server/auth/http-auth-adapter.mjs`: **unmounted standalone HTTP handler** for `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` and `GET /api/v1/auth/csrf`. Exact server-configured Origin checks for writes, strict JSON field allowlist, limited login body, socket-IP-based throttle input, secure session cookie on login, authenticated CSRF enforcement on logout, cookie clearing, and generic error responses. It does not replace the shared prototype or the T02 Fastify shell.
- Tests: `login-service.test.mjs`, `login-throttle.test.mjs`, `login-session-fence.test.mjs`, `http-auth-adapter.test.mjs`, `integration/local-login.postgres.test.mjs`. The original `integration/local-identity.test.mjs` migration expectation was updated for the new versioned migration. A separate CI workflow validates everything without editing other workers' CI configurations.

## Verified evidence

[Dedicated login CI](https://github.com/ClassesOver/DyOffice/actions/runs/43774757080) completed **successfully** on commit `cf046a523ef99d7c5c50cb2bb881160089866267`: syntax checks, login/throttle/auth-version and isolated HTTP tests, locked Web install, and real PostgreSQL 16 login+throttling+credential version race. Local Node 22 tests also passed 7/7 for login/throttle mocks and 4/4 for the standalone HTTP boundary.

## Integration and security blockers

1. **Do not mount into `application.mjs` or Fastify until T02 owner provides the integration interface and completes the base Web CI issues.** The existing development token server still rejects `NODE_ENV=production`; this work must not bypass it.
2. Runtime must supply a **least-privilege** PostgreSQL app pool (migration pool is for tests/CLI only), a persistent secret HMAC key, trusted deployment ID from deployment config, HTTPS origin, and trusted client IP resolution. Reverse proxy trust should be configured, not inferred from client `X-Forwarded-For`.
3. T03b still needs session management lifecycle across all routes, session ID rotation on login, logout-from-all-devices, password change and reset, logout audit, CSRF coverage for **every** cookie-authenticated mutating route, and robust fail-closed runtime readiness.
4. T03c administrator account management (creation, disable/restore, reset actions) and T04 RLS/tenant ownership remain absent. No production multiuser access or Office editing should be released on the strength of these tests.
5. Rate-limiter bucket expiration cleanup, bounded storage, trusted client IP handling behind enterprise proxies, safe key rotation, global capacity limits, breached-password screening, and resource usage benchmarks still require release evidence.
6. **PR sequencing**: merge PR #5 only after review; rebase the stacked login PR on its merged head without overwriting concurrent worker files. Keep this PR Draft until API integration and security review.

This implementation follows the user-selected **local username/password** approach only. No OIDC, Keycloak or SSO support is introduced.
