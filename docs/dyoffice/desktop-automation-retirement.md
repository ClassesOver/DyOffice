# Retire desktop automation without removing shared browser coverage

DyOffice has no desktop product. This follow-up removes 141 Electron-only root
end-to-end spec files and their shared Electron launcher. These are tracked
repository tests, not user profiles, local documents, database rows or runtime
storage. No cleanup command is run against a user's computer or data.

## Preserved

- Five standalone Chromium layout suites: AI panel position, Docs header markup,
  Home row menu positioning, PDF outline layout and Slides image selection.
- Their production renderer sources, CSS, test assets and visual baseline files.
- The dedicated apps/web test suites and all engine tests.
- Markdown's existing browser test configuration and CI check.
- The XLSX server engine, including workbook-redactions currently imported from
  apps/sheets/src/main by the Web gateway. A directory name is not a deletion
  boundary.
- Current third-party notices and their generator. The generator still uses the
  historical electron-builder resource inventory; removing that dependency
  requires a separate SaaS distribution inventory first.

## Changed

`npm run test:e2e` now discovers only the five browser suites through the root
Playwright configuration; it does not launch Electron or require desktop builds.
The old Electron CI job, Electron cache downloads, xvfb launcher and AppArmor
sysctl step are removed. The replacement job installs supported Chromium
requirements and executes browser checks without weakening kernel settings.
No host setting was changed while developing this patch.

The main test job builds only the XLSX engine, not the desktop Windows clipboard
helper. Existing SaaS CI workflows and engine regression checks remain intact.

## Verification scope

A static regression checks the exact retained browser suites, absence of the
Electron launcher/CI operations, and presence of shared editor and workbook
sources. Playwright discovery can be checked without launching a browser:

```
npm run test:desktop-retirement
npm run test:e2e -- --list
npm run build
npm run test:web:unit
```

Test discovery is not browser execution. Actual browser execution, operating
system isolation and production acceptance are separate verification stages.
No restricted CLI or external-service test was rerun for this change.

## Remaining retirement work

The historical installer configuration, app main/preload sources, platform
packaging templates and upstream desktop documentation require consumer-by-
consumer extraction. In particular, notices must first describe actual SaaS
artifacts, not lose required license texts when desktop packaging is removed.
This stage does not claim those remaining sources have been deleted.
