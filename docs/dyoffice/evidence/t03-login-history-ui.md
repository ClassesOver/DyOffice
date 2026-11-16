# T03 private login history UI

This is the frontend counterpart to the restricted new-local login-history API.
It extends the original SettingsModal account slot, preserving Home, Admin, password
and session controls. It does not query audit storage directly or change database grants.

`GET /api/v1/auth/login-history` is cookie-authenticated, accepts no caller-selected
account or pagination, and supplies at most 20 `{occurredAt,outcome}` records. The UI
accepts only success/failure/throttled, copies only these two fields, and renders fixed
labels plus time. It neither persists the response nor displays account hashes, request
IDs, session identifiers, IP addresses, user agents or guessed device locations.
Malformed/over-limit responses are errors, not a fake empty history. Failed refreshes
clear prior records; responses arriving after unmount cannot populate another panel.

The scope notice explicitly says early failures may not be included. Existing hash-only
failed-login records cannot safely be attributed across username rename/reuse; this UI
must not be described as complete audit history. Backend ownership/attribution remains
the authenticated server's responsibility, never a frontend filter.

The real PostgreSQL/Chromium acceptance file is
`test/local-browser/login-history.test.mjs`, under the mandatory existing CI glob.
It exercises real wrong-password logins for Alice and Bob, then Alice login, checks
cross-user timestamp markers, forbidden owner selectors, the strict public DTO and
private rendering in original Settings. The screenshot includes no authentication
credentials. Exact combined backend/frontend CI is required; unit tests do not establish
API availability or permission safety.
