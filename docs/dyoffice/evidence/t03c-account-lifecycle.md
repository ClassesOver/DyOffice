# T03c account lifecycle evidence

This file preserves two independent implementation histories. Their test counts and remaining work describe the recorded commits, not a new merged-tree verification. The runtimes use separate databases and migration journals; accounts, sessions and migrations are not interchangeable. Neither runtime is enabled for production. Current configuration is in [the Web README](../../../apps/web/README.md).

## Modular auth runtime

The following report concerns `server/auth/*.mjs`, `server/db/migrations` and `dyoffice_*` tables. Its later route integration is recorded in [T03 closeout](t03-closeout.md). Historical migration renumbering in that closeout is not permission to rename already-applied migrations or edit their journal; this integration preserves the existing migration files and checksums.

### T03c account lifecycle: verified internal service, not production activation

> Later closeout: login and admin routes are registered by `buildApp({ localAuth })`. See [t03-closeout.md](t03-closeout.md).

> 2026-11-16 · Branch `feat/dyoffice-t03c-account-lifecycle` · Draft PR #10, stacked on PR #8 (which depends on PR #5).
> Verified code commit: `cbd53ed2254bb0981a7cda6e96792a51f9b03592`. This note is a subsequent documentation-only change.

#### Scope and worker ownership

This branch adds an internal account lifecycle service, an additive database migration, focused tests, and a dedicated workflow. It does **not** mount any HTTP route, change Admin UI, relax the development server's production guard, or alter the Fastify entry, DOCX/other editors, source management, file ownership or revision code.

Parent commits `a38adc8b` (another worker's IPv6 login budget correction) and `c2a211d3` (parent integration) were incorporated through non-forced merge commits, preserving their files unchanged. The only inherited authentication tests modified are the expected migration lists in `local-identity.test.mjs` and `local-login.postgres.test.mjs`: both now explicitly include `0005_account_lifecycle_audit.sql` after the file and revision migrations. Previous migration bytes remain unchanged. No dependency or shared workflow was edited by this work.

#### Implemented operations

| Internal method | Required checks | Atomic effects |
| --- | --- | --- |
| `createAccount(request, input)` | Live session, configured deployment, CSRF, current config-admin membership, attempt budget, fresh password; repeat session/password-version checks under transaction locks | Pending user, ordinary `user` role, one personal workspace, short-lived activation token digest, audit event |
| `issuePasswordReset(request, input)` | Same administrator checks; valid same-deployment target; no self-reset or reset of disabled user | Suspend old credentials (`pending`, hash cleared), increment `auth_version`, revoke browser sessions and old password-action tokens, issue one reset token, audit |
| `setAccountEnabled(request, input)` | Same administrator checks; same-deployment target; self-disable forbidden | Change state/version, revoke sessions and action tokens, audit. Enabling never revives revoked sessions; an account without a password remains pending |
| `redeemPasswordAction(request, input)` | Canonical random token, shared rate budget, live/unused/unrevoked token, allowed target status, password policy and real Argon2id; all token/version conditions rechecked under locks | Consume exactly once, set password, increment version, revoke old sessions/action tokens, audit; require a fresh login rather than auto-sign-in |

Token plaintext is returned only at issuance and is not persisted. The new audit table has typed event metadata and no password, token, or arbitrary client-payload column. Audit writes and credential changes share the transaction: audit failure rolls back both credential changes and token consumption. Failed rollback discards the affected pooled connection.

Administrator reset intentionally suspends the account before the recipient redeems the new link. The eventual UI must explain this effect and obtain explicit confirmation. Issuing a recovery token is a privileged operation that can affect account control; independent approval and secure recipient delivery still require an operational design. This service does not prove that a recovery administrator cannot impersonate a user.

#### Verification performed

All runs below used the code commit `cbd53ed2254bb0981a7cda6e96792a51f9b03592` (PR checks exercise GitHub's generated merge tree against the parent branch):

- [T03c account lifecycle #43777424050](https://github.com/ClassesOver/DyOffice/actions/runs/43777424050): **success**. Syntax checks; 10 focused unit tests; 12 PostgreSQL scenario subtests plus their parent test; actual Argon2id/session/CSRF dependencies; `npm run test:web`; and `git diff --check HEAD^`.
- [Local login #43777424049](https://github.com/ClassesOver/DyOffice/actions/runs/43777424049): **success**. Login/rate-limit/session-version tests and real PostgreSQL password-reset race coverage.
- [Identity schema #43777424036](https://github.com/ClassesOver/DyOffice/actions/runs/43777424036): **success**. Real migration replay, native hashing, bootstrap and schema checks with the added migration.
- [Shared Web boundary #43777424042](https://github.com/ClassesOver/DyOffice/actions/runs/43777424042): still running when this note was written; do not infer its completion from the successful `npm run test:web` step in the T03c job. The PR checks are authoritative for its final result.

The real database test uses an isolated schema in a disposable PostgreSQL 16 database. It covers pending-account creation, activation and actual login, non-admin/CSRF/password rejection, suspension/reset revocation, simultaneous token redemption, disable/restore, expired/foreign-deployment tokens, duplicate usernames, injected audit-storage failure, admin credential-version races, and secret-free audit content.

No local container PostgreSQL result or full desktop test result is claimed here. Verification evidence is from the actual GitHub Actions runs. This is not a third-party security review or a production RLS proof.

#### Regression investigation and fixes

1. The initial PostgreSQL test exposed inconsistent parameter inference (`text` versus `varchar`) in `setAccountEnabled`. Explicit `::varchar` on the status parameter fixed the query; the same failing scenario then passed.
2. Adding migration 0003 exposed the older identity test's exact two-migration assertion. The assertion was expanded to three; migration replay and security assertions were preserved, not removed.
3. Parent integration changed the Web tests to require workspace-hoisted `tsx`. The T03c job initially installed only `apps/web`, so all Web test processes failed before loading tests. The **owned** workflow now performs the same locked root workspace install used by the shared gate (`--ignore-scripts`, no Electron launch), then the existing Web/native-Argon2 install. The whole Web test command passed afterward. No package or lockfile change was required.

#### Integration gates and remaining work

- Keep PR #10 Draft; review and integrate in dependency order PR #5 -> PR #8 -> PR #10. Parent updates must be reconciled without overwriting another worker's files.
- There are no account-management HTTP routes or UI in this slice. The integration owner must supply bounded JSON parsing, strict field allowlists, trusted Origin/IP/deployment configuration, CSRF on cookie writes, no-store responses, and token/password redaction. Token redemption must not accept a user ID from the browser or silently establish a login session.
- Production runtime DB privileges, FORCE RLS and per-user file access remain T04 gates. The test role is privileged and intentionally disposable.
- Revocation here covers **browser sessions and password-action tokens** plus `auth_version`. External API tokens, editor leases, WS commands and background jobs have not been integrated; they must validate current authority at execution and commit.
- Role assignment, paginated administrator user lists, a user password-change flow, administrator recovery, secure activation/reset delivery, audit retention, complete breached-password screening, and deployment resource benchmarks remain outstanding.
- Existing local-password scope is unchanged. No OIDC, SSO or external identity provider was introduced.

## Local experimental runtime

The following checkpoint concerns `server/src/modules/auth/*.ts`, `server/src/db/migrations` and `identity_migrations`. It predates later RLS, files, revisions and native jobs; those later checkpoints are indexed in [the Web README](../../../apps/web/README.md). It does not describe the modular auth runtime above.

### T03c account lifecycle checkpoint

2026-11-15, baseline `de8c2cfa`, branch `feat/dyoffice-web`. This adds account-management and password-action APIs to the experimental local runtime. Production, complete account/workspace UI, restricted runtime roles and business RLS are still unavailable; this is not T03/T04 or enterprise signoff.

#### Implemented behavior

- Admin can list accounts with bounded cursor pagination, create a normalized pending personal account, disable/restore an account, change allowed roles, and issue/reissue activation or reset credentials. New accounts have one personal workspace and no implicit Admin role. Password or role fields cannot be smuggled into creation JSON. Lists exclude hashes and action secrets.
- Every sensitive Admin mutation requires the current server-owned session, configured Origin/CSRF and password verification within 15 minutes (initial password login counts). Normal users reject before acquiring administrator update locks. A successful preliminary check is never authority: user status/version, session state and roles are rebuilt after locks.
- Authority order is sorted user UUIDs, then password-action rows, then session rows in UUID order. Mutations include existing administrator guard rows so concurrent self-demotions cannot remove the last usable Admin. Cross-deployment metadata and actions return scoped denial. The locked helper is internal server code, not a client-selectable transaction API.
- Admin creation returns a random 256-bit activation secret once; PostgreSQL stores its SHA-256, purpose, owner, issuing Admin, captured auth version and 15-minute expiry. Pending accounts cannot login before activation. Reissue/status/role changes invalidate previous actions and sessions. Restoring a disabled account does not revive old credentials; a pending account needs fresh activation.
- Reset issuance immediately increments auth version, revokes sessions/actions and sets `password_reset_required`; old-password relogin is blocked even before redemption. An expired reset remains frozen until Admin reissues it. Admin reset of self is refused; use authenticated password change instead.
- Anonymous activation/reset requires same-origin one-use CSRF and the secret in JSON, never a URL. Purpose, expiry, consumption, account state and captured version are checked again under user/action/session locks after real hashing. One concurrent redeemer wins. Password installation, version/session/action invalidation and audit intent commit or roll back together. Redemption does not log the user in automatically.
- Personal password change verifies the old password outside the write transaction, prepares a policy-checked Argon2 hash, revalidates locked authority, revokes every old credential/session, and installs a new Cookie session atomically. A reset committed after hashing prevents the stale change.
- CLI and local runtime now load the same optional approved local password blocklist (regular UTF-8 file, at most 16 MiB). The built-in small list remains a starter, not comprehensive breach coverage. Invalid password input maps to 400; full hash queues map to temporary 503 with Retry-After.
- Audit events contain request/actor/session/subject UUIDs and existing pseudonymous account keys, not passwords or action secrets. Managed account deletion is not offered. Only disposable test databases were changed.

#### Verification and fixes

New API suites first failed because the lifecycle service was missing. Actual PostgreSQL tests cover normalized duplicate creation, workspace uniqueness, no implicit Admin, recent reauth/CSRF, disable/restore/role invalidation, one-winner activation, token expiry/reissue, reset freeze, password/session replacement and audit-trigger failure rollback. Lock barriers cover a revoked Admin waiting to mutate; concurrent mutual resets complete without deadlock; concurrent self-demotions leave one usable Admin. Cross-deployment target/action tests deny access.

Additional regressions reproduced runtime blocklist omission (204 instead of 400), uppercase self-revocation missing cookie clear, and a personal caller timing out on an Admin row rather than rejecting 403. All were fixed without weakening tests. A gated **real** Argon operation proves a reset committed after hash preparation prevents a stale password write. Test fixture cleanup explicitly removes disposable action rows before users because issuer foreign keys intentionally restrict deletion; production constraints were not weakened for cleanup.

Fresh independent read-only review found no Critical/Important issue in the reviewed scope. One Minor remains: expired/consumed password-action history lacks a bounded cleanup/retention job; repeated privileged reissue grows the rows touched by locking/invalidation. No expired or consumed secret is accepted. Retention/cleanup remains follow-up work; no production-readiness claim is made.

Final observed gates:

- `npm run test:web:integration`: 52 passed, 0 failed/skipped, including 16 lifecycle cases and the fixed canonical-cookie regression.
- All Web unit tests: 37 passed, 0 failed/skipped.
- `npm run test:web`: 32 passed, 0 failed/skipped.
- `npm run test:web:build`: 2 passed.
- `npm run test:web:e2e`: 2 real Chromium/TLS/PostgreSQL cases passed.
- `npm run typecheck:web`: passed, including CLI and server TypeScript.
- Actual Node 22 run of lifecycle/session/upgrade/browser tests: 40 passed, 0 failed/skipped.
- Baseline/CI regressions: 7 passed. Compatibility baseline: 84 files, zero drift. Browser graph: 22 files, zero violations. `git diff --check`: passed.

These are local results, not a GitHub Actions success claim. Independent review preceded the final fix/regression pass; no second review is claimed. Real Chromium/TLS uses two browser contexts to cover Admin create, personal activation/login, denied Admin access, password Cookie rotation and Admin reset invalidation. This is an API/browser-credential test, not a finished login or Admin UI.

#### Schema, operation and remaining work

Immutable `0003_account_lifecycle.sql` adds reset-required state, action auth-version binding, audit subject IDs and lifecycle events. Earlier migration checksums remain unchanged; the migration regression preserves an existing v1 account and Cookie session while rejecting checksum drift. Future RLS/files/revisions migrations advance to versions 4/5/6.

Production startup remains guarded. T04 must install separate restricted authentication/business connections, FORCE RLS and owner filtering with non-owner tests. No external API tokens or write leases exist yet: version invalidation is the integration contract for T19/T06, not evidence that those future systems were cancelled. T12 must provide the actual account/workspace UI. T20 must define audit and action-record retention. Legacy prototype files are not assigned to a new account.

Use the existing explicit local mode configuration and `DYOFFICE_PASSWORD_BLOCKLIST_FILE` (prefer an absolute path shared with CLI). Admin responses expose activation/reset secrets once for authorized delivery; no email or message is sent by this implementation. Body-only redemption avoids credential URLs. Losing or expiring a reset secret requires an authorized reissue. Roll back code without dropping identity data; older runtimes reject the newer schema instead of silently changing migration records.
