# T03c account lifecycle: verified internal service, not production activation

> 2026-11-16 · Branch `feat/dyoffice-t03c-account-lifecycle` · Draft PR #10, stacked on PR #8 (which depends on PR #5).
> Verified code commit: `cbd53ed2254bb0981a7cda6e96792a51f9b03592`. This note is a subsequent documentation-only change.

## Scope and worker ownership

This branch adds an internal account lifecycle service, an additive database migration, focused tests, and a dedicated workflow. It does **not** mount any HTTP route, change Admin UI, relax the development server's production guard, or alter the Fastify entry, DOCX/other editors, source management, file ownership or revision code.

Parent commits `a38adc8b` (another worker's IPv6 login budget correction) and `c2a211d3` (parent integration) were incorporated through non-forced merge commits, preserving their files unchanged. The only inherited authentication tests modified are the expected migration lists in `local-identity.test.mjs` and `local-login.postgres.test.mjs`: both now explicitly include `0003_account_lifecycle_audit.sql`. Previous migration bytes remain unchanged. No dependency or shared workflow was edited by this work.

## Implemented operations

| Internal method | Required checks | Atomic effects |
| --- | --- | --- |
| `createAccount(request, input)` | Live session, configured deployment, CSRF, current config-admin membership, attempt budget, fresh password; repeat session/password-version checks under transaction locks | Pending user, ordinary `user` role, one personal workspace, short-lived activation token digest, audit event |
| `issuePasswordReset(request, input)` | Same administrator checks; valid same-deployment target; no self-reset or reset of disabled user | Suspend old credentials (`pending`, hash cleared), increment `auth_version`, revoke browser sessions and old password-action tokens, issue one reset token, audit |
| `setAccountEnabled(request, input)` | Same administrator checks; same-deployment target; self-disable forbidden | Change state/version, revoke sessions and action tokens, audit. Enabling never revives revoked sessions; an account without a password remains pending |
| `redeemPasswordAction(request, input)` | Canonical random token, shared rate budget, live/unused/unrevoked token, allowed target status, password policy and real Argon2id; all token/version conditions rechecked under locks | Consume exactly once, set password, increment version, revoke old sessions/action tokens, audit; require a fresh login rather than auto-sign-in |

Token plaintext is returned only at issuance and is not persisted. The new audit table has typed event metadata and no password, token, or arbitrary client-payload column. Audit writes and credential changes share the transaction: audit failure rolls back both credential changes and token consumption. Failed rollback discards the affected pooled connection.

Administrator reset intentionally suspends the account before the recipient redeems the new link. The eventual UI must explain this effect and obtain explicit confirmation. Issuing a recovery token is a privileged operation that can affect account control; independent approval and secure recipient delivery still require an operational design. This service does not prove that a recovery administrator cannot impersonate a user.

## Verification performed

All runs below used the code commit `cbd53ed2254bb0981a7cda6e96792a51f9b03592` (PR checks exercise GitHub's generated merge tree against the parent branch):

- [T03c account lifecycle #43777424050](https://github.com/ClassesOver/DyOffice/actions/runs/43777424050): **success**. Syntax checks; 10 focused unit tests; 12 PostgreSQL scenario subtests plus their parent test; actual Argon2id/session/CSRF dependencies; `npm run test:web`; and `git diff --check HEAD^`.
- [Local login #43777424049](https://github.com/ClassesOver/DyOffice/actions/runs/43777424049): **success**. Login/rate-limit/session-version tests and real PostgreSQL password-reset race coverage.
- [Identity schema #43777424036](https://github.com/ClassesOver/DyOffice/actions/runs/43777424036): **success**. Real migration replay, native hashing, bootstrap and schema checks with the added migration.
- [Shared Web boundary #43777424042](https://github.com/ClassesOver/DyOffice/actions/runs/43777424042): still running when this note was written; do not infer its completion from the successful `npm run test:web` step in the T03c job. The PR checks are authoritative for its final result.

The real database test uses an isolated schema in a disposable PostgreSQL 16 database. It covers pending-account creation, activation and actual login, non-admin/CSRF/password rejection, suspension/reset revocation, simultaneous token redemption, disable/restore, expired/foreign-deployment tokens, duplicate usernames, injected audit-storage failure, admin credential-version races, and secret-free audit content.

No local container PostgreSQL result or full desktop test result is claimed here. Verification evidence is from the actual GitHub Actions runs. This is not a third-party security review or a production RLS proof.

## Regression investigation and fixes

1. The initial PostgreSQL test exposed inconsistent parameter inference (`text` versus `varchar`) in `setAccountEnabled`. Explicit `::varchar` on the status parameter fixed the query; the same failing scenario then passed.
2. Adding migration 0003 exposed the older identity test's exact two-migration assertion. The assertion was expanded to three; migration replay and security assertions were preserved, not removed.
3. Parent integration changed the Web tests to require workspace-hoisted `tsx`. The T03c job initially installed only `apps/web`, so all Web test processes failed before loading tests. The **owned** workflow now performs the same locked root workspace install used by the shared gate (`--ignore-scripts`, no Electron launch), then the existing Web/native-Argon2 install. The whole Web test command passed afterward. No package or lockfile change was required.

## Integration gates and remaining work

- Keep PR #10 Draft; review and integrate in dependency order PR #5 -> PR #8 -> PR #10. Parent updates must be reconciled without overwriting another worker's files.
- There are no account-management HTTP routes or UI in this slice. The integration owner must supply bounded JSON parsing, strict field allowlists, trusted Origin/IP/deployment configuration, CSRF on cookie writes, no-store responses, and token/password redaction. Token redemption must not accept a user ID from the browser or silently establish a login session.
- Production runtime DB privileges, FORCE RLS and per-user file access remain T04 gates. The test role is privileged and intentionally disposable.
- Revocation here covers **browser sessions and password-action tokens** plus `auth_version`. External API tokens, editor leases, WS commands and background jobs have not been integrated; they must validate current authority at execution and commit.
- Role assignment, paginated administrator user lists, a user password-change flow, administrator recovery, secure activation/reset delivery, audit retention, complete breached-password screening, and deployment resource benchmarks remain outstanding.
- Existing local-password scope is unchanged. No OIDC, SSO or external identity provider was introduced.
