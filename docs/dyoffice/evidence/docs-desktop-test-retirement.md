# Docs desktop-only test retirement

Base #134 `3f5a7550abe61e89e6293d8060c1b26f8fabfc91`.
CI job `133985049621` passed real native DOCX browser/TLS acceptance in this run,
then failed 16 desktop-only renderer-suite cases. This does not establish a fix
for the previously intermittent incomplete-save observation.

Removed two test files, not a skip/filter and not renderer functionality:

- `save-as-default-dir.test.ts` (10 cases) registers Electron main-process IPC,
  drives a native OS Save As dialog, resolves host Documents folders and grants
  arbitrary picked host paths for PDF/HTML/Markdown export. SaaS cannot grant
  these host paths; it uses owner/session-bound revision APIs.
- `updater.test.ts` (6 cases) exercises electron-updater native package downloads,
  desktop update dialogs and quitAndInstall. A browser-deployed SaaS application
  has no desktop application binary to update.

The removed Electron/html2docx driver was not restored. Existing shared main
modules were not broadly deleted because their remaining reuse needs its own
review. A retirement guard asserts the two desktop tests remain absent while
shared/native save races and Web safety/roundtrip suites stay present.

Controlled validation: retirement guard RED before removal, GREEN 4/4 afterward;
SaaS unsupported host-write/unknown-save and bridge contracts 14/14; real native
Tiptap/save/bridge plus metadata-race tests 46/46. Browser roundtrip assertions
are unchanged, including clean/dirty, saved bytes and revision checks. No local
Chromium, external model or previously denied harness invocation was attempted.
The complete local Docs renderer suite also passed: 533 files passed / 4 existing skips; 6537 tests passed / 20 existing skips, exit 0. No new skips were introduced. The downstream DOCX engine and final exact-head browser suites remain subject to normal CI.
