# T03 closeout: local accounts, sessions, and admin user management

> Scope update, 2026-11-16: Historical old-stack checkpoint (MJS / `dyoffice_schema_migrations`), not acceptance of the new TS local-account runtime. The body below preserves its original evidence. See [current-stack acceptance](t03-t04-current-stack-acceptance.md) for later exact branch evidence and unresolved final-combination gates.

> 2026-11-16. Continues merged PRs #5 (session core) and #8 (login service), and open draft PR #10 (account lifecycle). PR #10 targeted the old login branch and numbered its migrations `0003`–`0005`, which now collide with `0003_files.sql` and `0004_revisions.sql`. This branch keeps that code, renumbers the auth migrations to `0005`–`0008`, and mounts the routes on `buildApp({ localAuth })`.

No row-level security policies were added. `principalContext()` and `canReadPersonalFiles()` are the identity values T04 can pass into `withPrincipalTransaction`. XLSX, the DOCX browser, and PDF were not edited.

## Acceptance

| Item | Result | Evidence |
| --- | --- | --- |
| T03a username normalize / duplicate | Done | `credential-policy.test.mjs`; PostgreSQL unique `(deployment_id, username_normalized)` in `local-identity.test.mjs` |
| T03a concurrent first admin, no default password | Done | `auth-bootstrap.test.mjs` and the PostgreSQL bootstrap race in `local-identity.test.mjs`. CLI rejects password flags. |
| T03a empty / weak / common password | Done | `validateNewPassword` rejects under 15 code points, one-character strings, and the small common-password set. Full breach corpus is deferred. |
| T03a Argon2id independent salt, m=19456, t=2, p=1 | Done | `passwords.mjs`. Local hash prefix `$argon2id$v=19$m=19456,t=2,p=1`. Two hashes of the same password differ. |
| T03a missing user costs the same as a bad password; disabled user rejected | Done | `login-service.mjs` verifies a startup dummy hash. Disabled accounts do not get a session. PostgreSQL login test. |
| T03b login, logout, me, new session, cookie flags | Done | `__Host-dyoffice_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`. `session-core.test.mjs`, `http-auth-adapter.test.mjs`, `local-auth-routes.test.mjs`. |
| T03b CSRF / Origin, duplicate cookies | Done | `csrf-policy.test.mjs`. Duplicate `Cookie` headers return no session. |
| T03b no user enumeration, IP + account throttle | Done | Invalid, missing, and disabled accounts share `INVALID_CREDENTIALS`. Throttle returns `RATE_LIMITED`. HMAC keys, not raw usernames, are stored. |
| T03b idle / absolute timeout, login vs revoke race | Done | `session-core.postgres.test.mjs` and the auth-version fence in `local-login.postgres.test.mjs`. |
| T03b production start guard | Done | `NODE_ENV=production` still throws before `buildApp` and before the development token server reads its directory. `server.test.mjs`, `api-compat.test.mjs`. |
| T03b reauth and personal session list/revoke | Done | `reauth.mjs`, `self-session-management*.test.mjs`, PostgreSQL session suite (11 cases). |
| T03b principal on auth routes | Done | `GET /api/v1/auth/me` returns `principalContext` fields. Legacy file routes still use the development token. |
| T03c create / disable / restore / role change | Done | Unit tests plus PostgreSQL `account-lifecycle.postgres.test.mjs`, including the role-change case added on this branch. |
| T03c one-time activation and reset under concurrency | Done | Two concurrent redemptions: one commit, one `INVALID_ACTION`. Reset token plaintext is not in the audit row. |
| T03c admin reauth | Done | Admin mutations require the current password, CSRF, and a live `config_admin` session. `POST /api/v1/auth/reauth` checks the password and does not rotate `auth_version`. |
| T03c new account is not an admin and gets a workspace | Done | `create_role` inserts `user` only. `dyoffice_personal_workspaces` gets one row. Role injection in the create body is `INVALID_INPUT`. |
| T03c admin cannot read another user's files | Done at the identity layer | `canReadPersonalFiles` is owner equality. `config_admin` does not widen it. The development admin token already receives 403 on personal routes (`server.test.mjs`). SQL `FORCE RLS` is T04. |
| T03c password change revokes old sessions | Done | PostgreSQL password-change suite. Replacement cookie is returned only after commit. |
| T03c write leases | Partial, interface only | `dropWriteLeasesForOwner` advances the epoch and clears `sessionId` for that owner. Password change and account disable call `onCredentialsRevoked` after commit. The default development process does not pass its journal into that callback. |
| T03c API token revocation | Deferred | There is no API token table. `auth_version` increments and browser sessions are revoked. Token revocation is T19. |
| Real PostgreSQL | Done on this machine | PostgreSQL 16. Migrations `0001` through `0008` applied beside the file and revision tables. Identity, session, login, account (13 cases), password change (6), and personal sessions (11) passed. |
| Web gates | Done | `npm run test:web`: 155 passed, 1 skipped (MinIO). `typecheck:web`, `check-web-boundaries.mjs` (124 files, 0 violations), `test:web:build` (2), compatibility baseline (84 files, 0 changes), `git diff --check`. |
| Browser login click-through | Deferred | The default page still posts the development token. No new login screen was added. |

## RED then GREEN for the gaps PR #10 left open

- Role replacement: `account-lifecycle.test.mjs` calls `setRoles`. Before the method existed, that call threw `TypeError`. After the method, duplicate roles are `INVALID_INPUT`, self-change is `SELF_ACTION_FORBIDDEN`, and the assigned roles are `auditor` then `user`. PostgreSQL then stored those roles, wrote `account.role_changed`, and rejected the previous session cookie.
- User list: the same unit test failed closed on a missing `listUsers`. It now returns username, display name, status, and roles, and the serialized page does not contain the password hash that the fake row carried.
- Mount: `local-auth-routes.test.mjs` gets 501 for `POST /api/v1/auth/login` when `localAuth` is absent. With `localAuth`, a missing `Origin` is 403 and a trusted origin sets the session cookie. An extra `role` field on create is 400, so the client cannot grant `config_admin`.
- Migration numbers: applying the old `0003_account_lifecycle_audit.sql` name next to `0003_files.sql` is rejected by the migration runner as a duplicate version. The renamed `0005`–`0008` files apply once and replay as an empty list.

## Deferred, and why

- **T04 RLS.** Policies, `FORCE ROW LEVEL SECURITY`, a non-owner application role, and pool reset are the parallel T04 task. This change only exports the principal.
- **Development-token cutover.** Pointing `/api/files` and object routes at session principals before RLS would let a second account through the same process without a database owner predicate. The token boundary stays until T04.
- **T19 API tokens.** No token table exists to revoke.
- **Operations.** The common-password set is a prefilter, not an offline breach corpus. Argon2 parameters are the OWASP starting point; this run did not publish a host concurrency benchmark. Login-bucket cleanup and trusted-proxy client IP remain configuration, not a new policy.
- **Write-lease attachment.** The helper is tested against the in-memory revision journal. Wiring it into the development server would couple the token process to PostgreSQL, which that process still refuses to do.
