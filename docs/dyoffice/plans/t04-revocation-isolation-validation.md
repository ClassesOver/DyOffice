# T03/T04 local-account isolation and revocation test plan

Status: design and test requirements only; no database validation result is claimed.

## Source of truth and scope

Follow [local-account-auth.md](../local-account-auth.md), [architecture.md](../architecture.md) and T03/T04 in [implementation-plan.md](../implementation-plan.md). The local-account decision was introduced in `2983615f86b255f332ad5b2f5003dae5e63ab7af` and developer guidance aligned at `144e06091129e2751fc6d7ae5cfe2665c5398f6f`. Local usernames/passwords and Admin-managed accounts are the approved direction. This document supplements that design with concurrency and isolation tests, not another authentication design or an external IdP proposal.

Current server authentication remains the development-only `personal`/`admin` token boundary and one shared JSON store. It cannot represent two independent users. Do not put the old shared store behind local login and call it isolated. Production must not fall back to development tokens. Do not automatically assign existing JSON files to the first login; T22 requires explicit owner mapping/dry-run.

No DOCX editor, shared contract, dependency lock, CI or application source is changed by this plan. The smallest future vertical validation is local account -> server session -> A/B personal preferences -> revocation, with genuine PostgreSQL behind it. File save capability remains unavailable until T05/T06 are implemented.

## Implementation prerequisites and file boundary

Use the existing planned modules: `server/src/modules/auth/{passwords,sessions,service,routes,throttle,csrf}.ts`, `modules/admin/users/`, `modules/policy/authorize.ts`, `db/context.ts`, and `0001_identity.sql`/`0003_rls.sql`. Add `test/integration/{auth-session,ownership-rls,revocation-race}.test.ts` and disposable PostgreSQL fixtures. Coordinate dependency/CI changes after the current DOCX candidate; do not overwrite its manifests.

Keep the approved password controls unchanged: Argon2id with independent salts and measured resource limits; local normalized username unique within deployment; no default password/public Admin registration; secure server sessions, Origin/CSRF, layered throttle and generic login errors. `users.id` is the stable identity; no email-based merging. Concurrent account creation must use the database uniqueness constraint, not a prior existence check alone. Tests assert only one account/workspace is provisioned for duplicate normalized names.

Auth tokens/password-action tokens stay server secrets: token hashes in DB, restricted lookup permissions, short bounded expiry and cleanup, no raw tokens/passwords/hashes in public DTOs or logs. A session lookup happens before a Principal exists, so the implementation must provide a narrowly scoped auth-table lookup role/helper without a business-data RLS bypass. If SECURITY DEFINER is used, review fixed search_path, ownership, grants and PUBLIC execute revocation. Do not solve bootstrap by broadening the business runtime role to table-owner/superuser/BYPASSRLS.

## Required transaction and lock ordering

A successful early `authenticate()` call is insufficient for a later document/config commit. Before a protected write, `withPrincipalTransaction` must revalidate authority within its database transaction and keep the authority locks until commit/rollback.

Universal order:
1. Lock all involved **user rows in stable UUID order**. Normal writes take SHARE locks; disabling users, password/role changes and auth-version increments take UPDATE locks.
2. Lock **all required credential/action rows** (including the actor session/API Token) in one stable server-defined `(credential kind, ID)` order; do not special-case the actor credential before the global ordering. Normal writes take SHARE locks; revocation/reset consumption takes UPDATE locks.
3. Lock business resources in a documented stable order, then perform scoped mutations.

After locks are held, recheck deployment/user binding, user status, credential revocation, expiry at this validation boundary, scopes and the credential's recorded `auth_version` against the current user version. Do not grant trust from request body owner/user/role/deployment. Set RLS context only from the validated Principal. If validation fails, no business write is allowed.

This gives a testable ordering rule: a writer that already holds authority locks may finish before revoke/disable commits; revoke waits. If revoke/disable commits first, a waiting writer must reject after locked revalidation. **No write using the old authority may commit after revocation commits.** A plain SELECT followed by an unlocked write does not establish this property. Expiry is evaluated at the locked validation boundary, not retroactively after a transaction has committed.

Account disable/password reset/role change increments `auth_version` transactionally and invalidates old sessions/API Tokens as defined by the main auth design. When an Admin operation touches actor and target, acquire user locks by the same stable order; never lock actor session first and later try to lock the target user. Use bounded transaction/lock timeouts and surface failure, not an automatic unauthorized retry.

A password reset consumes its one-time action token and changes password/auth_version in one transaction, with the target user locked before its token. Expensive password hashing may be prepared outside the transaction, but authorization/current-password-version must be revalidated under locks before installation. Concurrent consumption must have one winner; rollback cannot permanently consume a token without its password change.

This plan does not cancel bytes already emitted by SSE/WS. Ongoing streams, worker jobs, leases and API Token scopes require authorization checks at their own sensitive boundaries (T13/T17/T19); do not claim that a cookie deletion or row lock alone cancels them.

## RLS and connection-pool checks

Business queries must explicitly filter deployment/owner and also use RLS USING + WITH CHECK. Enable and FORCE RLS. Runtime role must be non-superuser, non-owner and NOBYPASSRLS, with no DDL/TRUNCATE or privilege escalation. Constraint relationships must carry matching deployment/owner boundaries, not just a bare file/workspace ID. PostgreSQL documents the owner/BYPASSRLS exceptions: [Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

Use parameterized transaction-local `set_config(..., true)` after BEGIN, never a connection-wide SET. COMMIT/ROLLBACK before returning the connection. RLS is defense against omitted scope filtering, not protection against arbitrary SQL execution by a compromised application role; all SQL remains parameterized and unauthorized role switching must be denied.

## Executable test sequence (requirements, not passed results)

Use real PostgreSQL with a migration connection and a separate restricted runtime connection. Create A, B and a config Admin through the planned local-account services. No shared test identity. When this integration suite is requested but PostgreSQL is absent, fail/block explicitly rather than skip or replace it with a map/SQLite.

1. **Role guard:** assert actual runtime role flags, table ownership, FORCE RLS state and grants before any positive tests. Reject an accidentally privileged test connection.
2. **A/B through HTTP and SQL:** different persisted preferences through both legacy-compatible and v1 aliases; A cannot read/update/delete B; missing context exposes no rows; forged owner/deployment/role fields do not redirect access; config Admin cannot read A's personal resources.
3. **Cross-owner constraints:** INSERT/UPDATE into another user's scope fails WITH CHECK; cross-owner workspace/file references fail composite constraints; no existence leak beyond the common unauthorized response.
4. **Pool reuse:** pool size one, A -> B -> no-context on the same backend connection; repeat after callback throw, SQL error and ROLLBACK. Assert backend PID reuse and no leftover identity settings/data.
5. **Two-connection revocation race:** use barriers, not sleeps. Writer acquires SHARE locks; revoke UPDATE must wait; release writer, then revoke commits; subsequent old-credential write fails. Reverse ordering: hold revoke lock, start writer, commit revoke, then writer rejects without changing business rows. Repeat for user disable, auth-version/password/role change and API Token revoke; repeat with rollback to prove recovery.
6. **Reset/activation consumption:** two transactions redeem the same valid token; one password/auth-version update and one consumed record only. Wrong user/purpose/expired/already-consumed tokens reject. Force an error after attempted consumption and verify whole transaction rollback.
7. **Session lifecycle/security:** new token after login/reauth/password change where specified; old tokens revoked, expiry/disabled users reject, duplicate/ambiguous Cookie headers reject, logout invalidates server state; CSRF/Origin failures cannot mutate. Generic error/timing/throttle/Argon resource tests follow the main auth design.
8. **Compatibility:** unchanged development token suite still passes in explicitly dev mode; new local-account mode rejects dev tokens and never serves JSON-store personal state. Password/scopes never substitute for file ownership. Production cannot select the prototype fallback.

## Actual evidence and outstanding infrastructure

Independent security review required explicit lock ordering/race tests, uniqueness under concurrency and restricted short-lived secrets; all are reflected here. Existing development auth/route/legacy tests were rerun, **10/10 passed**. They are not evidence of the planned local-account system.

The current executor has no `docker`, `psql` or `postgres` executable. No real PostgreSQL migration, RLS, local-account login or revocation-race test has been executed. Provision a disposable database/test harness as the first implementation step. All T03/T04 acceptance above remains pending; no fake database or external-IdP acceptance is claimed.


### 后续环境与实现记录（2026-11-15）

上面的无 Docker/PostgreSQL 记录属于本计划初稿时的执行环境。当前执行环境已提供隔离 PostgreSQL 17；T03a/T03b 已跑真实账号、会话、登录期间停用、等待期间撤销和 Chromium TLS 回归，见 [T03b 证据](../evidence/t03b-local-sessions.md)。这些测试仍使用迁移权限连接，不构成这里要求的 T04 受限业务角色、FORCE RLS 或完整业务写入撤销竞态验收。
