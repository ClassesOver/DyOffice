# T03 new-local revoke-other-sessions endpoint

Candidate based on #32 `f0fbb751e3a75e827e1daa405636a30edc5db14f`.
This implements a planned endpoint missing from the new `src/db` local stack;
it does not replace or silently reuse the old `dyoffice_sessions` implementation.

- `POST /api/v1/auth/sessions/revoke-others`, no body (or `{}`), no query fields.
- Uses current session Cookie, exact Origin and session CSRF token. No caller
  chooses user/deployment/target sessions; unknown body/query fields reject.
- Success is `204`, no body, no Set-Cookie. Current token/session and user
  auth_version are unchanged. No additional reauthentication requirement is
  introduced beyond the existing single-session revoke policy.
- Under user UPDATE then ordered credential locks, revalidate the current
  credential and revoke only its deployment/user's other unrevoked sessions.
  Login takes a conflicting user SHARE lock, so later logins are valid future
  sessions rather than being accidentally included in the earlier operation.
- Existing `session_revoked` audit events record each affected session in the
  same transaction. An empty repeat does not duplicate audit. No migration or
  runtime role grant is changed.

HTTP tests with the real Fastify/CSRF boundary first failed for absent route,
then passed 3/3. They stub only the session service and are not database proof.
`local-integration/revoke-others.test.mjs` adds nine real PostgreSQL cases:
owner/current preservation and audit; rejected CSRF/Origin/identity injection;
concurrent same-current idempotency; mutual revocation one winner; later login;
writer-first fencing; revoke-first commit and rollback including audit; revoked
caller rejection. It uses existing restricted roles and real locks, not mock SQL.

Local full Web regression: 216 passed, 1 optional S3 test skipped, 0 failed; Web and server TypeScript checks passed. An initial isolated copy resolved root yauzl 2.10 instead of the existing Web nested 3.4 package; restoring the unchanged Web dependency layout resolved that environment failure. No dependency version was changed.

Real PostgreSQL acceptance remains pending exact-candidate CI. Passing previous
#32 tests is not evidence for this new endpoint. This candidate does not claim
T19 external Token revocation or Agent/tool stream cancellation is implemented.
