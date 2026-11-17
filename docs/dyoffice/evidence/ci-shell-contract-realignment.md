# Shell CI contract realignment (2026-11-17)

Baseline: PR #134 `c3d0544c7b894667fd6a857997a992518b6fa52e`.
Failure evidence: Actions job `133956811737` on this exact head; preceding job `133948056969` reproduces the same two failures.

## Root causes

- The development-token compatibility shell still opens `legacy.html`. Its old in-process DOCX parsing endpoints were intentionally retired and return HTTP 501 / `DOCUMENT_ISOLATION_UNAVAILABLE` before parsing or writing. The browser test incorrectly expected a working textarea and save roundtrip. Restoring that parser to make CI green would violate the isolation contract.
- Settings now edits a local draft and saves explicitly. Clicking the auto-save switch does not issue a PUT. Failed saves intentionally preserve the draft. The test incorrectly awaited an error immediately after switching, then expected rollback.
- The API path remains `/api/preferences` in this development shell. This was not a route matcher bug.

## Changes and retained coverage

- Browser import/open checks the real 501/code, visible unavailable explanation, absence of editing/save controls and no document commit/upload requests. Home navigation, favourites, tab visibility, theme, template creation, Admin credential separation and PDF CJK checks remain.
- Settings explicitly saves; asserts failed status/error with draft retained; retries and reopens to verify persistence.
- New no-browser contract tests execute the shipped shell frame-close guard: one dirty/unknown veto discards no drafts, closing one tab leaves other tabs untouched, accepted navigation discards only checked frames.

## Evidence / limits

- No Chromium launched or external AI runtime invoked during this fix.
- Local node syntax check passed. Retired-parser plus frame-guard tests: 5/5. SettingsModal DOM tests: 6/6.
- Browser changes still require the permitted CI browser run. These local passes are not browser acceptance.
- The development compatibility shell does **not** regain DOCX editing/save/dirty-document roundtrip. That is an explicit functional gap, not a newly passing feature. The frame-close contract is not equivalent to real editor roundtrip coverage. SaaS native editor acceptance remains its own separate suite; no legacy parser fallback is introduced.
