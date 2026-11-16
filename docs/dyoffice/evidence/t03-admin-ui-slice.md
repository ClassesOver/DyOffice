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

The entry wiring is deliberately separate from this PR to avoid overwriting the concurrent
personal-password settings work. In local-main only: show the Admin button for config_admin,
mount LocalAdminPanel with currentUserId and onClose; pass the main client's
invalidateCsrf as onSessionRotated. That callback executes even if reauthentication has an
uncertain network outcome, because its cookie may already have rotated. Mount PasswordActionForm
only on the signed-out screen via an explicit activation/reset button. Neither form reads a
token from the browser URL. Do not mount local account components on the legacy dev-token page.

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

Remaining T03 work: role editing and its last-admin/self-demotion UX, full settings/Admin
entry integration, real browser create→secure code handoff→activate→login→reset→re-login,
multi-admin stale-state/revocation coverage, and all original T03 acceptance criteria.
No role-grant, account creation or credential action has been performed on real users.

Local verification: 8 focused client/component tests passed; malformed 2xx regression
was observed failing before DTO guards, then passed. Strict shell TypeScript passed.
A first full-shell run was blocked by Vite resolving a PDF worker through an external
node_modules symlink; copying the existing dependencies locally removed that fixture
path issue. This is dependency reuse, not proof of a new npm installation.

Full original shell test suite: 16 passed, 0 failed (including 8 new tests).
