# Local account visual review

Evidence baseline: PR #38 `57e72697e50d904b101c26e1ec477afd6a304e5e`, Web run `43806308207`, artifact `14198267793` (`local-account-original-shell`). These are real Chromium outputs, not generated mockups.

Reference: original `apps/shell/src/renderer/src/SettingsModal.tsx`, `settings.css`, Home/AppFrame source, and repository help images `home-screen.en.png` / `settings-general.en.png`. Help images are historical references, not a fresh same-version desktop comparison. Different locale/resolution/data must not be counted as pixel regressions.

## Findings

- Home retains original tabs, sidebar, FileBadge quick cards, filter/search/list structure. Web capability limitations remain visible: disabled creation cards, unavailable desktop folders, and session-only favorites. These are functional limitations, not a full desktop-equivalence claim.
- Reproduce Admin drift: sign in as a configuration administrator, open account menu → 用户管理. `local-shell-admin-complete.png` shows unstyled native text inputs and user-row buttons; close/refresh span the pane because they are direct children of the flex-column `.set-pane`.
- Reproduce account drift: account menu → settings → account. `local-shell-account.png` and `local-shell-sessions.png` show original settings navigation but default bullet session rows, adjacent actions without original button-row spacing, and password fields starting at varying positions because label widths differ.
- Account content requires scrolling after addition of password and sessions; the sessions screenshot is a scrolled view, not proof of missing header. No passwords or one-time action codes are visible in inspected images.
- New Admin/account/session features have no exact desktop equivalent. Reuse original primitives without claiming an original desktop admin design exists.

## Minimal candidate

`LocalAdminPanel.tsx`, `PasswordActionForm.tsx`, and `LocalSessionsPanel.tsx`: use existing `set-input`, `set-btn`, `set-field`, and `set-btn-row` primitives. No new global CSS; no API/auth/session/role behavior changes. Preserve accessible names and test hooks. Admin and session lists now retain semantic list roles but use original settings field rows/stacks and grouped actions instead of default bullets. Password-field alignment remains a recorded follow-up, not claimed fixed.

Verification: new primitive tests failed on both original components, then passed; focused admin + primitives initially 13 tests passed; final complete Shell results are recorded at handoff; shell TypeScript passed. An initial full-suite attempt using symlinked dependencies was rejected by Vite for the PDF worker outside its root. Materializing dependencies locally resolved that environment issue; the complete rerun passed.

Fresh browser screenshots of this candidate remain required before visual acceptance. Existing #38 browser evidence proves only the baseline. Integrator should rerun real PG/Chromium account/admin/password-action flows and capture populated Admin and signed-out action form after controls are loaded, without exposing one-time codes.

Final isolated candidate checks: all 30 Shell tests pass (including three primitive/layout regressions); `typecheck:shell` passes; `vite build --config vite.local-shell.config.mjs` passes with the existing large-chunk warning; Web `npm test` passes 224 with one existing skip. No real browser was run for this style-only increment locally. Two initial build invocations used nonexistent guessed script/config names; the correct workflow command above was subsequently inspected and passed.
