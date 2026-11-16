# T03 local-account session settings

This follow-up builds on PR #35's original Home/Settings integration and requires the
new-local `POST /api/v1/auth/sessions/revoke-others` backend candidate. It does not
change the development-token shell or any database migration.

The original Settings account pane lists only the authenticated user's server session
metadata: created/last-used/expiry times and a current-session label. It does not guess
devices/locations or display session cookies. Each revoke asks for confirmation; current
session revocation returns to login only after a confirmed 204. Bulk revocation states
that the current session and future logins are preserved. Both paths fetch current CSRF
immediately before mutation and never use a bearer token. No write retries automatically.

Pending/unknown mutation state lives in a shared client across panel mounts. A valid,
completed list read reconciles prior unknown operations; a failed/malformed read cannot
unlock them. A list started while a write is pending cannot clear that pending lock.
Only HTTP 204 confirms revocation. UI failure retains the old rows and requires refresh,
rather than hiding a session and implying that a failed/unknown revoke succeeded.

Focused tests cover typed session metadata, duplicate IDs, fresh CSRF, exact status,
unknown/reconciliation behavior, confirmation/cancel semantics and current-session
versus bulk behavior. The mandatory real-PostgreSQL/Chromium test
`test/local-browser/session-settings.test.mjs` verifies cross-user list isolation,
missing-CSRF rejection, cancel/no mutation, single-session revocation, bulk revocation,
unchanged current cookie, unrelated user preservation, and self-revoke back to login.
Its screenshot contains metadata only, not credentials. Missing local services are a
blocked acceptance run, not a pass. Exact combined CI must pass before closure/merge.
