# T03 personal password settings UI

Scope: local-account original Home/Settings entry only. The development-token shell,
DyOffice desktop Settings, identity tables and password/session service remain unchanged.
This is a follow-up to PR #32, not a claim that all T03 or production release gates are complete.

The original SettingsModal account slot embeds a small form using its existing `set-*`
styles. It asks for current/new/confirmed password and explains the actual new-stack
contract: successful change revokes all old sessions and issues a replacement cookie
for this browser. The returned CSRF token replaces the in-memory cached value.
Passwords are never put in URLs, storage, logs or screenshots; form fields clear on
submission. Server rejection does not claim success. Transport errors, 5xx or malformed
success DTOs remain unknown and block another password mutation until explicit reload.
The pending/unknown guard lives in the long-lived local client, not only the mounted
form; closing/reopening Settings cannot repeat an uncertain write. No write is retried
automatically. Other account controls can invalidate the cached CSRF after reauthentication.

Focused coverage: rotated CSRF, invalidation after another account operation, duplicate
submission, wrong-current-password response, confirmation mismatch, unknown transport,
malformed 200, and unmount/remount without a second network mutation. Existing original
Settings and PDF UI regressions remain in the full Shell suite.

`test/local-browser/password-settings.test.mjs` is a mandatory real PostgreSQL/Chromium
acceptance test under the existing local-browser CI glob. It exercises the real login,
wrong current password, successful password change, cookie rotation, old/current session
responses, a subsequent preference write, logout and login with the new password. It
uses only disposable test credentials and saves an empty-password-fields screenshot.
Local unit/type/build results are not substitutes for that CI test; missing PostgreSQL
or Chromium is a blocked run, not a skipped pass.

Remaining T03 UI work includes Admin account lifecycle, activation/reset redemption and
session management; these are separate coordinated changes. External API tokens, full
breached-password corpus and production rollout remain outside this slice.
