# T03b checkpoint: isolated PostgreSQL session core

> Date: 2026-11-16 · Status: **Core implemented and tested; T03b login and production authorization are NOT complete.**

## Worker ownership and integration policy

This checkpoint is developed on branch `feat/dyoffice-t03b-session-core`, based on `feat/dyoffice-web` commit `c7b963bffff303fe7bbea2b9809c7d90cfbb41ca`. It is intended for a separate review PR, **not an immediate merge**. Changes are deliberately limited to new session-core source/test files, a dedicated CI workflow, and this evidence note.

Do not modify or cherry-pick over the concurrently developed DOCX editor PR #3, the already merged server read/source fixes from PR #4, or any other worker's editor, file persistence, data-source, and prototype HTTP router files.

## Implemented

- `apps/web/server/auth/session-core.mjs`: server-only `createSessionService({pool,...})` with `issue()`, `authenticate()`, `revoke()`, `revokeAllForUser()`.
- Issues cryptographically random 256-bit opaque cookie values, writes only their SHA-256 digests to `dyoffice_sessions`; secrets are not returned as a JSON identity DTO.
- Uses a host-only `__Host-` Cookie with `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/`, plus an explicit expired-cookie clearing value. Rejects malformed and duplicate Cookie headers/values before database lookup.
- Authentication is a single conditional PostgreSQL statement that checks user status, `disabled_at`, `auth_version`, deployment, revoked/expired sessions, inactivity timeout and current role membership. Each successful call reads the current roles from PostgreSQL rather than trusting a client-supplied role.
- Logout/revocation is idempotent and deployment-scoped. User-wide session revocation always specifies the trusted `deploymentId` and `userId`.
- `apps/web/test/session-core.test.mjs`: unit tests for 256-bit token secrecy, cookie validation, role refresh, deployment boundaries, expired/disabled users, and revocation.
- `apps/web/test/integration/session-core.postgres.test.mjs`: actual PostgreSQL 16 lifecycle test for issuance, credential-version invalidation, role changes, per-user revocation, idle/absolute expiry, disabled accounts and forged tokens.
- `.github/workflows/dyoffice-t03b-sessions.yml`: focused Node 22 and PostgreSQL 16 CI. It uses only test database credentials and does not change shared Web workflows or root dependencies.

## Validation evidence

[Successful isolated T03b CI](https://github.com/ClassesOver/DyOffice/actions/runs/43772258182): **success**. It passed JavaScript syntax checks, session cookie/DB-boundary unit tests, locked Web dependency installation, and the real PostgreSQL integration test.

An earlier run failed on the CI PostgreSQL service port mapping (`ports: [5432]` allocated a random host port while the test connected to localhost:5432). Mapping `5432:5432` resolved that infrastructure failure. The source was not weakened to pass.

## Security and rollout boundaries

1. **No browser login is connected.** Session issuance must only follow a real Argon2id password check with per-IP/per-account/global throttling, consistent invalid-user behavior and audited authentication actions. Do not expose `issue()` directly to user-submitted user IDs.
2. **No production application pool or RLS has been validated.** The integration test uses the existing privileged migration pool against a disposable PostgreSQL instance. T04 requires a separate least-privilege runtime role, per-user ownership and FORCE RLS.
3. **No CSRF or Origin enforcement has been connected to application routes.** Cookie attributes alone do not make browser writes safe. Login/logout/password changes and Admin operations must have an independently verified CSRF/Origin strategy.
4. **A completed authentication check is not permission to save later.** Long AI runs, WS commands, file saves and background jobs must revalidate user/session/owner/lease at execution and commit. Password changes, role revocation and disabling an account must coordinate `auth_version` changes and session/API-token revocation in the same authorized DB transaction.
5. **Current prototype retains the development Bearer-token login** and refuses `NODE_ENV=production`. This PR must not relax that guard.
6. Additional T03b work: login/logout/me endpoints, password verification with a fake hash for absent users, rate limiting and resource bounds, secure session cookies in HTTP responses, CSRF tokens/Origin validation, logout-from-all-devices and session activity audits.

This work remains compatible with the user-confirmed decision to use **local username/password accounts only**, without OIDC/Keycloak/SSO.

## Continued isolated work: session-bound CSRF / Origin policy

Added two **new files**, without touching the existing Web HTTP router or any native editor:

- `apps/web/server/auth/csrf-policy.mjs`: explicit `createCsrfPolicy({secret,trustedOrigin})`; uses a configured key of at least 32 bytes and SHA-256 HMAC bound to the trusted PostgreSQL-authenticated `deploymentId` and `sessionId`. It requires an exact trusted HTTPS `Origin` (HTTP only for localhost), a matching `X-DyOffice-CSRF` token, and rejects duplicate/malformed Origin and CSRF headers. It does not trust client Host or X-Forwarded-Host.
- `apps/web/test/csrf-policy.test.mjs`: 4 focused tests for valid tokens, session/deployment binding, origin/subdomain spoofing, duplicates, malformed tokens and unsafe configuration.

Isolated Node 22.16.0 check: `node --check apps/web/server/auth/csrf-policy.mjs` and `node --test apps/web/test/csrf-policy.test.mjs` **passed (4/4)**. The dedicated [T03b PostgreSQL session CI](https://github.com/ClassesOver/DyOffice/actions/runs/43773079282) and the [identity CI](https://github.com/ClassesOver/DyOffice/actions/runs/43773079196) have also passed at commit `3cba563ae3e9853cdb95f83bd8159f1a48e4658c`.

**Not yet connected:** Do not call `csrf.issue()` based on browser-supplied principal IDs. A future authenticated `/api/v1/auth/csrf` endpoint may expose it only after validating the server-side session and must send `Cache-Control: no-store`. All cookie-authenticated writes require this policy in the HTTP adapter. Session revocation and write authorization remain mandatory even with a valid CSRF token. This is **not** a completed login/CSRF integration or production-ready authorization flow.

The PR stays in **Draft** so the separately owned DOCX editor and shared Web gate can complete their review before integration.
