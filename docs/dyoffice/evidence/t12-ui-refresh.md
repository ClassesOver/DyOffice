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

## Follow-up non-native UI acceptance on the unchanged build

The same published source `5d41fded4d8f25375e1f462e202b2ab86dbc87aa` and production asset hash above were exercised further with disposable accounts/PostgreSQL. A test-only HTTP wrapper forwarded requests through the original Fastify app/auth/CSRF/routes; it injected exactly one preference PUT 503 before the route. No production source or authorization setting was changed. The first harness attempt to add a hook after app readiness failed; the harness was corrected before any assertions. This is controlled fault injection, not a claim of a naturally occurring server outage.

- **Failure recovery:** the 503 is displayed and author draft retained. Clicking Save again reports unknown prior outcome; recorded HTTP requests show no second PUT. Explicit reread/discard then editing and saving produces one PUT200 and a confirmed saved state. No automatic replay.
- **Original-byte download:** browser Home downloads match source bytes exactly: DOCX2,970, XLSX4,009, PPTX5,518, PDF14,849 bytes. SHA256 respectively `3165c58fbf4b47be2e75fcb2f646afc9e5bd64f8e21b90688e57db8fed23637f`, `d94493ae46e91d925edaa569fcddd45199e36753f30a8d49fcecfe001db550fb`, `c06cd6e6dd78725433c2258cbdf6881be847880dda8e15c2d155a2415034daf1`, `cbda671ea8a8b7d4f6ac7bc5addf99c217372ad24dc750fae35381b2a38ea28e`. These are original downloads, not editor roundtrips.
- **User isolation UI:** Alice creates a private folder and favorites a file. After logout/login as Bob, root has0items, Recent0/Starred0, no Alice folder, and account menu has no administrator controls. This complements, not replaces, existing API/RLS tests.
- **Single-tab real CAS:** browser retains revision0 and a draft. A separate legitimate fixture-admin transaction commits another disabled configuration at revision1. Browser save receives actual409; its draft remains. Reading latest version1 and explicitly saving yields version2 with both the UI draft and concurrent writer entry present. This verifies the UI's response to a real database conflict; it is **not two-tab browser acceptance**.

All services stopped normally. This follow-up had no new renderer error9, but earlier error9 records remain unresolved. Mobile layout, true two-tab interaction and native editor edit/save/reopen remain outside this acceptance. No new code changes were made after the successful production build.
