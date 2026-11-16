# T03 staged local-account administration UI

Base: PR #32 `f0fbb751e3a75e827e1daa405636a30edc5db14f`, full source tree
`8a14f964cc18d2378853cb3f00f53f627f9b8a38`. This is an additive component slice,
not T03 completion and not the legacy development-token Admin page.

## Scope and integration

- Reuses original Settings `set-*` styles, no parallel design system.
- `LocalAdminPanel`: paginated list, create personal account, reissue activation,
  password-reset initiation, enable/disable. Shows explicit target and consequences;
  each mutation requires an administrator password and successful server reauthentication.
- `PasswordActionForm`: signed-out activation/reset redemption; code and password
  go only into same-origin POST bodies, not URL/search/hash/storage. No automatic login.
- Tokens are displayed only in current component memory/DOM, cleared on dismissal;
  no email, clipboard write or other external transmission is automatic.
- Server remains authoritative: config_admin, recent authentication, current deployment,
  last-admin preservation, status/token validity and session revocation are NOT reimplemented
  or waived by client-side visibility.

## Combined follow-up

The candidate now incorporates personal-password PR #34, original-settings entry wiring,
and explicit replacement of the four server-defined roles. Personal is always retained.
Self-role changes warn about forced re-login; successful self-change returns to the login
entry. The server's last-admin constraint remains authoritative. No arbitrary role names
are accepted by the client.

The original Account menu exposes User Management only for config_admin; the original
Settings dialog contains the panel. The signed-out screen explicitly opens activation/reset.
Both shared-client CSRF caches and forms are invalidated appropriately around reauthentication.
This is wiring, not evidence that the real browser acceptance has already passed.

## Safety/verification boundaries

The dedicated client does not cache CSRF. Every mutation obtains a fresh challenge after
any cookie rotation. Redirects are rejected, credentials are same-origin, requests are no-store,
writes are never automatically retried, and user IDs are validated before path interpolation.
Double submits are blocked synchronously, forms erase secret fields before awaiting responses,
and uncertain failures direct the operator to inspect current state rather than repeat blindly.
No raw server error content is reflected into the UI.

Focused client/component tests cover request sequencing, fresh CSRF, failure without retry,
ID rejection, code in POST only, administrator confirmation/reauth/duplicate suppression,
password mismatch, secret clearing and no false success. These use jsdom/mock transport and
are not real PostgreSQL/Chromium acceptance. The source API guard semantics belong to #32's
separately tested server. A real signed-in browser flow must be added/run after entry wiring.

Remaining T03 evidence: real browser create→secure code handoff→activate→login→reset→re-login,
role replacement, last-admin rejection and self-demotion acceptance. The new
test/local-browser/admin-users.test.mjs exercises actual APIs/PG/Chromium, without mocked
routes, on CI's disposable database. It is included by the existing local-browser glob.
Local invocation fails explicitly because DYOFFICE_TEST_DATABASE_URL is absent; this
environment failure is NOT a product RED or a skipped success. No untrusted PG is installed.
Native local-shell build and strict shell types passed. Runtime installation was reused locally;
CI must reproduce installation. Full T03 including session management and other original
acceptance is not declared complete by this component slice.

No role-grant, account creation or credential action has been performed on real users.
Browser fixture credentials and codes stay within the disposable fixture. Screenshot is taken
only after issued action codes are hidden; no trace or token values are intentionally logged.
