# T03d: owner-only personal session management

Closeout: [t03-closeout.md](t03-closeout.md). Session routes are registered by `buildApp({ localAuth })`.

Date: 2026-11-16. Branch: `feat/dyoffice-t03c-account-lifecycle`, PR #10.
Base for this slice: `77f107744dece4427dcc4f502f9b6caa30566194`.

## Scope and resumable ledger

This completes the self-session source and tests prepared in the previous turn, rather than starting another implementation. The recovered source blobs are `20cea9f9` (service), `801d9c3a` (HTTP), `edc0e22c` (unit tests), `39240668` (HTTP tests), and `cb0a02d0` (PostgreSQL scenarios). Their bytes are reused unchanged.

Ruling: keep these modules unmounted in the existing owned branch. PR #21 independently changes `apps/web/server/src/**` and its separate migration history; that implementation, the shared Fastify/application entry, other editors and T05/T06 worker files are NOT modified here. This is a bounded delivery/handoff contract, not a second live authentication system.

Ruling: add an immutable migration in this branch's existing `server/db/migrations` line. The `0003`/`0004` identities used by independent file/revision work need explicit reconciliation before branches are integrated. Do not silently rename already applied migration files, merge competing schemas, or force-push another worker's branch.

## Implemented contract

- `createSelfSessionManagement({pool,sessionService,csrfPolicy,deploymentId})`: `list`, `revoke` and `revokeOthers` derive owner and current session ONLY from the server-authenticated identity. A configuration-admin role does not bypass ownership.
- List accepts only `limit` (1–100) and optional owned `before` session ID. Stable descending creation-time/ID pagination returns only session ID, timestamps and the current-session flag. Expired, idle, revoked and obsolete-auth-version sessions are excluded. No token/hash/password/IP/user-agent data is returned; richer device labels are not implemented.
- Revocation requires current DB authentication and CSRF, then repeats authority checks in a transaction under the same deployment advisory-lock order as account reset and password change. Audit and revocation commit together. Audit failure rolls back the mutation; rollback failure discards the connection.
- Revoking foreign, missing or already-revoked targets is indistinguishable. The HTTP adapter returns 204; only committed current-session revocation clears the cookie. A subsequent request using that session is unauthorized.
- Revoke-others preserves the current session and unrelated users. It revokes sessions visible to that statement, not later password logins or already-running work. It does not advance auth_version or claim remote API-token/job/lease revocation.
- Standalone routes: `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/:id`, `POST /api/v1/auth/sessions/revoke-others`. Exact trusted Origin for writes, no CORS, no-store, bounded query values, no request bodies, secret-free errors. Service-layer CSRF is mandatory. These routes are exercised in a test server only; no shared app/UI is activated.

## Database migration

`0007_session_security_events.sql` adds a composite unique identity on `(deployment_id,user_id,id)` in sessions and owner-bound audit FKs for both actor and target sessions. The DB rejects cross-owner audit references. Audit action/target/count shape is constrained. No plaintext session secrets are stored.

No cascading deletion is configured. Session cleanup and audit archival must honor references. Production least-privilege/append-only grants, FORCE RLS, storage bounds and retention remain integration gates. Tests use a disposable privileged PostgreSQL instance, not proof of production RLS.

Four existing identity/login/account/password tests only add the new migration name to their expected list. Earlier migration bytes are untouched.

## Verification procedure and status

Local schema test was observed RED (expected missing-table assertion) then GREEN (1/1). This only checks structure; it is not PostgreSQL execution. This session's local container lacks PostgreSQL and cannot resolve registry.npmjs.org, so full dependency and DB validation must come from CI.

Dedicated workflow: `.github/workflows/dyoffice-self-sessions.yml`.

```sh
node --test apps/web/test/self-session-management.test.mjs \
  apps/web/test/self-session-management-http.test.mjs \
  apps/web/test/session-security-schema.test.mjs
DYOFFICE_TEST_DATABASE_URL=<disposable-db> node --test \
  apps/web/test/integration/self-session-management.postgres.test.mjs
npm run test:web
npm run typecheck:web
npm run test:web:build
git diff --check HEAD^
```

Expected focused coverage: 8 service unit tests, 6 HTTP tests, 1 schema check and 11 PostgreSQL scenario subtests plus their parent. Scenarios include real login/CSRF -> paginated owner-only sessions -> one/others/current revocation, cross-user/admin/cross-deployment denial, idle/absolute/version exclusion, duplicate concurrent revocation, DB audit FK enforcement, audit failure rollback and disable-after-authentication races.

Status when this evidence file is authored: remote checks have not yet run on the new commit. The exact commit's live PR checks and follow-up verification comment are authoritative; previous green runs do not validate this slice.

## Release/integration boundaries

- PR #10 remains Draft and must be independently reviewed. No auto-merge or shared branch writes.
- PR #21's `src/db` schema and PR #19's revision migration cannot be treated as the same migration history. Record an explicit schema/route authority decision and validate a combined branch before integration.
- These DB locks serialize management operations within a deployment. Load/latency benchmarking and optimization are not claimed.
- Browser HTTPS/device UI acceptance, runtime RLS/DB role proof, upstream integration and remote job/lease/API-token revocation are not covered by this implementation.
- Audit retention and session cleanup need a compatible policy; no default password or public registration is added.
