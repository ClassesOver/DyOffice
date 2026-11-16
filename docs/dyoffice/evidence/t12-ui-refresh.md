# T12 UI integration after backend #72

## Scope and exact baseline

Target `bc7f509deeb32ee84f7ad7e8dcbef8c0cf476fc0` (backend #72); previous UI candidate `cc0c6ac61d2949d57f4ba8f4632886ec7bca7591`. This integration preserves both histories. Backend migrations 0001–0019, role provisioning and HTTP APIs remain byte-identical to the merged backend. No new migration or provider execution path is added.

UI adds the remaining Home/workspace/settings surfaces. Editable XLSX now opens the existing guarded top-level native route, like DOCX; unsupported/read-only formats retain original download behavior. Server authorization and native runtime requirements are unchanged.

## Preference interaction correction

A real browser exposed an author-field blur/save race: saving disabled the enclosing fieldset before the following switch click could be delivered. A busy guard could also discard that second intent. Web preferences now use a local draft and explicit batch save. Only changed fields are submitted. Rapid switches use the latest draft; failure retains edits without automatic replay. Closing, reloading preferences and leaving the page protect unsaved drafts. Language is saved in the same batch and takes effect after refresh. Desktop behavior remains immediate.

Deterministic component tests failed before the correction (three initial failures, plus separate dirty-patch and unload red cases). Final Web Shell suite: **90/90**, 12 files; Shell TypeScript passed. Navigation tests: **12/12**, including authorization failures and download fallback. Browser regression source was updated for explicit save and passed syntax checking; it was not executed as an entire automated browser suite.

## Fresh production-build and actual browser evidence

Original local-shell Vite configuration, `NODE_OPTIONS=--max-old-space-size=384`, `GOMAXPROCS=1`, workspace TMPDIR: **190 modules, 3.58 seconds, exit 0**.

Final SettingsModal SHA256: `994acec3308c2bfcdf66e60698909d7844af3dead348533fdc2eff91b9414de0`.
Built `index-C-XmwOXQ.js` SHA256: `82d89cf5508882cbc772fab2cf7c38f1c7f8ee4f759901a178157bdebddd85d9`.

Actual Chromium controls against disposable PostgreSQL and local temporary object storage, original auth/CSRF/Secure-cookie semantics over localhost HTTP:

- Login and Home; create folder; favorite XLSX; soft-delete and restore through Trash; folder and favorite survive refresh (first UI run).
- Fixed preferences: author edit followed immediately by switch remains an unsaved draft and does not write to PostgreSQL; rapid switching and cancelling close retain intent. Explicit save followed by reload/reopen retains author and switch. Saved language renders English after refresh/recovery (fresh corrected build).
- Ordinary user has no global-config/admin controls.
- Administrator adds an enabled/default configuration and a synthetic noncredential key; save reaches version 1 and key is not echoed into the input. Saved-config check explicitly reports no connectivity test. Disable clears the default and reaches version 2 while retaining the encrypted key. Explicit re-encryption reaches version 3; clearing the synthetic key reaches version 4.

No real provider requests, user credentials, production records or production cleanup were used. Test services stopped normally. This GUI run uses local object storage and must not be described as a RustFS browser test.

## Remaining gates and honest limitations

- Chromium renderer error 9 occurred intermittently, including with no concurrent build. Recovery succeeded, but root cause is not established and browser stability is not certified.
- Two-tab revision-conflict GUI coverage was attempted but interrupted by renderer failure. Backend/component conflict tests do not substitute for that browser assertion.
- Actual HTTP-failure injection, four-format original-byte downloads, mobile layout and complete cross-user UI flow were not repeated on this corrected build. Deterministic failure/retry tests and previous backend RLS tests remain distinct evidence.
- Fresh DOCX production build remains blocked by process termination/heap constraints. No borrowed #61 artifact is counted as this candidate's acceptance.
- Native XLSX runtime requires its root/systemd/host-manifest setup, unavailable in this desktop test environment. No isolation checks were bypassed. Native grid editing/save/reopen is **not verified**.
- Historical screenshots and earlier test results in the prior evidence document are historical, not evidence of this exact candidate. CI is not claimed passed.

Keep this PR draft. Backend #72 is already merged; this PR must not repeat its migrations as new work. Complete remaining isolated UI acceptance before calling T12 end-to-end closed.
