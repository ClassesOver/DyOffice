# T03c account lifecycle checkpoint

2026-11-15, baseline `de8c2cfa`, branch `feat/dyoffice-web`. This adds account-management and password-action APIs to the experimental local runtime. Production, complete account/workspace UI, restricted runtime roles and business RLS are still unavailable; this is not T03/T04 or enterprise signoff.

## Implemented behavior

- Admin can list accounts with bounded cursor pagination, create a normalized pending personal account, disable/restore an account, change allowed roles, and issue/reissue activation or reset credentials. New accounts have one personal workspace and no implicit Admin role. Password or role fields cannot be smuggled into creation JSON. Lists exclude hashes and action secrets.
- Every sensitive Admin mutation requires the current server-owned session, configured Origin/CSRF and password verification within 15 minutes (initial password login counts). Normal users reject before acquiring administrator update locks. A successful preliminary check is never authority: user status/version, session state and roles are rebuilt after locks.
- Authority order is sorted user UUIDs, then password-action rows, then session rows in UUID order. Mutations include existing administrator guard rows so concurrent self-demotions cannot remove the last usable Admin. Cross-deployment metadata and actions return scoped denial. The locked helper is internal server code, not a client-selectable transaction API.
- Admin creation returns a random 256-bit activation secret once; PostgreSQL stores its SHA-256, purpose, owner, issuing Admin, captured auth version and 15-minute expiry. Pending accounts cannot login before activation. Reissue/status/role changes invalidate previous actions and sessions. Restoring a disabled account does not revive old credentials; a pending account needs fresh activation.
- Reset issuance immediately increments auth version, revokes sessions/actions and sets `password_reset_required`; old-password relogin is blocked even before redemption. An expired reset remains frozen until Admin reissues it. Admin reset of self is refused; use authenticated password change instead.
- Anonymous activation/reset requires same-origin one-use CSRF and the secret in JSON, never a URL. Purpose, expiry, consumption, account state and captured version are checked again under user/action/session locks after real hashing. One concurrent redeemer wins. Password installation, version/session/action invalidation and audit intent commit or roll back together. Redemption does not log the user in automatically.
- Personal password change verifies the old password outside the write transaction, prepares a policy-checked Argon2 hash, revalidates locked authority, revokes every old credential/session, and installs a new Cookie session atomically. A reset committed after hashing prevents the stale change.
- CLI and local runtime now load the same optional approved local password blocklist (regular UTF-8 file, at most 16 MiB). The built-in small list remains a starter, not comprehensive breach coverage. Invalid password input maps to 400; full hash queues map to temporary 503 with Retry-After.
- Audit events contain request/actor/session/subject UUIDs and existing pseudonymous account keys, not passwords or action secrets. Managed account deletion is not offered. Only disposable test databases were changed.

## Verification and fixes

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

## Schema, operation and remaining work

Immutable `0003_account_lifecycle.sql` adds reset-required state, action auth-version binding, audit subject IDs and lifecycle events. Earlier migration checksums remain unchanged; the migration regression preserves an existing v1 account and Cookie session while rejecting checksum drift. Future RLS/files/revisions migrations advance to versions 4/5/6.

Production startup remains guarded. T04 must install separate restricted authentication/business connections, FORCE RLS and owner filtering with non-owner tests. No external API tokens or write leases exist yet: version invalidation is the integration contract for T19/T06, not evidence that those future systems were cancelled. T12 must provide the actual account/workspace UI. T20 must define audit and action-record retention. Legacy prototype files are not assigned to a new account.

Use the existing explicit local mode configuration and `DYOFFICE_PASSWORD_BLOCKLIST_FILE` (prefer an absolute path shared with CLI). Admin responses expose activation/reset secrets once for authorized delivery; no email or message is sent by this implementation. Body-only redemption avoids credential URLs. Losing or expiring a reset secret requires an authorized reissue. Roll back code without dropping identity data; older runtimes reject the newer schema instead of silently changing migration records.
