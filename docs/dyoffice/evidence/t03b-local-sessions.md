# T03b server-owned session checkpoint

2026-11-15, baseline `3f90b5fa`, branch `feat/dyoffice-web`. Local accounts now have a separate experimental HTTP runtime. It does not expose the shared prototype store or make production available. T03c account lifecycle, T04 restricted roles/RLS and later document workflows remain pending.

## Runtime and security boundary

`DYOFFICE_AUTH_MODE=local` selects `buildLocalApp`; default development mode preserves the legacy compatibility server. Local mode requires an already bootstrapped deployment, current explicit migrations, database URL, configured canonical origin and a persistent CSRF key. It rejects development token configuration and refuses production. The current local API has no document/workspace UI; unimplemented authenticated resource routes return 501 and never fall back to JSON.

Implemented `/api/v1/auth/csrf`, `login`, `logout`, `me`, `reauth`, personal `sessions` list and `DELETE sessions/:id`. A five-minute one-use server-stored challenge protects pre-login CSRF. Successful login always creates a new random 256-bit session token; only its SHA-256 is stored. Cookies are `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, without Domain. Session tokens are never returned in JSON. Reauthentication rotates the token and CSRF proof; the prior token stops working. Logout/revocation invalidates database state and clears the current cookie.

Write endpoints require the configured Origin and server-derived CSRF proof; hostile Fetch Metadata, ambiguous Authorization/Cookie headers and duplicate security cookies reject. Trusted static schemas reject extra identity/role fields without coercion. Responses are no-store; safe Problem formatting covers framework/router errors. Origin is configuration, never inferred from an untrusted Host/forwarded header.

Default idle timeout is 8h and absolute lifetime 24h. Authentication locks the user first and credentials in stable ID order, then rechecks status, auth version, token hash, revocation and expiry against database time. Password hashing occurs before locked session creation and status/version is rechecked afterward. This proves session-boundary ordering; it does not yet prove T04 business-write revocation.

PostgreSQL login buckets cover normalized account, direct-peer IP and global KDF admission. Argon concurrency remains bounded. Consecutive bursts increase cooldowns; rejected traffic does not extend an active cooldown. Review-driven fixes gate account allocation behind global/IP eligibility and charge the global budget only for admitted password work. Idle counters expire after a quiet retention window while active cooldowns remain. No raw username or IP is stored in buckets; keys are HMACs under the persistent server key. Explicit auth events record server request UUID, optional account HMAC and affected session UUID, never credentials; successful state changes and their audit intent share a transaction. Audit retention/export is still T20.

## Migration and verification

Version 1 is immutable. Additive `0002_auth_sessions.sql` introduces challenges, throttle state/indexes and correlated security events. Current migrations are verified before local startup; no implicit startup DDL occurs. T04/T05/T06 future files advance to versions 3/4/5 rather than overwriting version 2.

RED: session/API tests failed before the service existed; local startup failed before mode selection existed. A cooldown regression showed successive bursts retaining one-second cooldown. Independent review reproduced blocked-peer global-budget exhaustion and permanent attacker-chosen account rows; both have real PostgreSQL regression cases. Audit correlation was regraded Important because missing request/session linkage violates traceability; the missing-column regression reproduced the gap before the schema and event propagation were added.

Final observed gates:

- `npm run test:web:integration`: 35 passed, 0 failed/skipped, including 20 new session/CSRF/throttle/startup/authority cases and a real version-1 account upgrade/checksum-drift case.
- All Web unit tests: 37 passed, 0 failed/skipped.
- `npm run test:web`: 32 passed, 0 failed/skipped.
- `npm run test:web:build`: 2 passed.
- `npm run test:web:e2e`: 1 real Chromium/TLS/PostgreSQL case passed.
- `npm run typecheck:web`: passed.
- Actual Node 22 run of the 20 session cases, upgrade and browser case: 22 passed, 0 failed/skipped.
- Baseline/CI regressions: 7 passed; compatibility inputs: 84 files, zero drift; browser graph: 22 files, zero violations; `git diff --check`: passed.

Independent read-only review finished before the fix pass. Its Important findings and the regraded audit-correlation finding each have a reproduced failing regression followed by the final green suite. No second review is claimed. The sole deferred minor is documented below. Local gate results are not a GitHub Actions success claim. The browser test uses real Chromium 149, temporary self-signed TLS, browser-managed cookies and real PostgreSQL. Certificate errors are ignored only inside that isolated test context. It verifies cookie accessibility/attributes and login/me/CSRF rejection/logout behavior; it is not a completed login UI or native Office E2E.

Known deferred minor: a caller deleting its current session using an uppercase UUID does revoke server authority but misses the case-sensitive cookie-clear comparison. APIs return canonical lowercase IDs; a CSRF refresh clears an invalid cookie. This is a convenience bug, not retained server access, and remains recorded for a later fix.

## Configuration and remaining gates

For isolated development, bootstrap with `npm run bootstrap:admin`; retain the deployment UUID and database credentials. Set `DYOFFICE_AUTH_MODE=local`, `DYOFFICE_DATABASE_URL`, `DYOFFICE_DEPLOYMENT_ID`, `DYOFFICE_ORIGIN` and a random persistent `DYOFFICE_CSRF_KEY` of at least 32 bytes, and unset development tokens before `npm run dev:web`. Use HTTPS termination matching the exact canonical origin for browser cookies. Loopback HTTP is useful for manual API diagnosis, not evidence that secure cookies work without TLS.

The runtime still uses migration-capable test credentials in current tests. T04 must introduce narrow auth lookup and non-owner/NOBYPASSRLS business connections, ownership policies and protected-write race tests before production. Admin account/activation/reset APIs and a login/workspace UI are later work. External Bearer API tokens and MCP are T19. Do not assign legacy files to the first login; T22 owns explicit migration.

Rollback application code without dropping account/session data; restore the explicit development entry only in development. Downgrading an identity runtime across an unknown schema is rejected rather than silently changing migration records. No production account or user data was touched by these tests.
