# T03a account-storage foundation checkpoint

> 2026-11-16 · Scope: schema and pure input policy only · Status: **partial, not a completed authentication or database milestone**

## Files delivered

- `apps/web/server/db/migrations/0001_identity.sql`: proposed first PostgreSQL local-identity migration with `dyoffice_users`, `dyoffice_user_roles`, `dyoffice_personal_workspaces`, `dyoffice_sessions`, `dyoffice_password_action_tokens`, and `dyoffice_admin_bootstrap`.
- `apps/web/server/auth/credential-policy.mjs`: ASCII login-name normalization, single-factor password length/prefilter validation, and bounded Argon2id PHC **format inspector**.
- `apps/web/test/credential-policy.test.mjs`: username, password and Argon2id metadata edge cases.
- `apps/web/test/identity-schema.test.mjs`: static SQL structure and no-default-password assertions.

The schema establishes unique usernames per deployment, composite deployment/user foreign keys, no embedded default password, random opaque token **hash** storage, and a single bootstrap marker per deployment. The unique bootstrap marker is a prerequisite for atomic first-admin provisioning; the actual bootstrap transaction/CLI is not yet implemented.

## Verification performed

In an isolated copy of these four files with Node.js v22.16.0:

```sh
node --check apps/web/server/auth/credential-policy.mjs
node --test apps/web/test/credential-policy.test.mjs apps/web/test/identity-schema.test.mjs
# 5 passed, 0 failed
```

Regression red/green: adding trivial-repeat password blocking first made the existing 256-codepoint all-identical emoji passphrase test fail. The test was corrected to distinguish **a valid varied 256-codepoint/1024-byte Unicode passphrase** from repeated-character passwords; the corrected 5/5 suite passed. These tests are picked up automatically by `npm run test:web` (existing `test/*.test.mjs` glob) and the GitHub Web boundary workflow. GitHub CI must still be checked at a final code commit.

**Not tested:** PostgreSQL execution, transaction isolation/concurrent admin bootstrap, real Argon2id hash/verify, migration runner, session cookies, CSRF/Origin protection, login throttling, RLS, production authentication or end-to-end users. Static SQL string checks are not database integration tests.

## Security and sequencing constraints

1. The built-in weak-password list is only a quick prefilter. Before enabling account enrollment, add a vetted offline/common-breached password corpus with a fail-closed check and rate limiting.
2. `inspectArgon2idHash` only checks PHC metadata; **it neither produces nor cryptographically verifies password hashes**. Do not use it for authentication. A reviewed Argon2id implementation, locked dependency and resource-concurrency limits are required; actual values must be benchmarked on deployed hardware.
3. The SQL file is not automatically applied at Web service startup. Apply by a versioned transaction migration only after the PostgreSQL driver and migration runner are introduced, then exercise uniqueness, foreign keys, rollback and parallel bootstrap against actual PostgreSQL.
4. Only an interactive/secure administrator CLI may create the first admin; `dyoffice_admin_bootstrap` and admin user/role/workspace must be written in the same transaction and a second initialization must fail. Do not expose a public HTTP bootstrap or ship a preset password.
5. Keep existing development `DYOFFICE_USER_TOKEN`/`DYOFFICE_ADMIN_TOKEN` host **production-disabled**. No new local-account route has been connected yet. Do not advertise login or multiuser isolation as working.
6. T03b sessions and T04 resource authorization/RLS remain release-blocking. Database roles performing normal operations must not bypass RLS.

## Next work

- Lock and install PostgreSQL + maintained Argon2id dependencies in both applicable npm lockfiles; verify Web-only `npm ci` without Electron.
- Add versioned transactional migration runner and real PostgreSQL test harness.
- Implement and test actual Argon2id hashing/verification and interactive one-time admin bootstrap; include concurrent bootstrap and rollback tests.
- Only after these gates, wire login/logout/me, server-side sessions, admin account actions and per-user resource authorization.

Source of truth: [local-account-auth.md](../local-account-auth.md), [implementation-plan.md](../implementation-plan.md), [acceptance-matrix.md](../acceptance-matrix.md). No OIDC/Keycloak/SSO integration.
