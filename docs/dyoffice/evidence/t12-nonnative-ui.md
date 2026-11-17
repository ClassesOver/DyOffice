# T12 non-native Home/settings UI stage

## Scope

Exact base: `bc7f509deeb32ee84f7ad7e8dcbef8c0cf476fc0` (merged backend #72). This independent stage contains Home folders/favorites/recoverable Trash, personal Web draft/save settings, and administrator global-configuration UI. It does not add migrations, change backend authorization, enable provider execution, or alter native isolation.

The unverified XLSX native jump remains in #52. Stage `local-main.tsx` matches previously reviewed blob `6ebe7670d1916ac5c796ff52568478040b29209f`: existing DOCX top-level navigation stays intact; XLSX/PPTX/PDF use #52's original-download implementation (the target previously rejected non-DOCX opening). XLSX import keeps its completion notice, even if an editable capability is advertised. No new native XLSX navigation is introduced.

No historical screenshots, native theme tests, implementation-plan closure claims, or unrelated progress documents are brought into this stage. Applied backend and worker files are unchanged.

## Exact-stage local verification

- Targeted navigation/local-client/Home bridge/preferences tests: **34/34**.
- Web Shell component suite: **90/90**, 12 files.
- Web and Shell TypeScript: **exit0**.
- Original local-shell production configuration: **exit0**, 190modules,2.56s,384MB heap/GOMAXPROCS1.
- Asset `index-CWP4NOuF.js` SHA256 `48b937386274f367aa3e4e5e7b94949d6da74260d79d99146e6817800d72c307`.
- Independent review: no code blocker, complete UI/client/contracts dependencies. Non-allowlist tracked files match the base. The development native binary symlink was not materialized locally and is retained untouched in the Git tree.

Initial test-command path error and a cross-directory linked PDF worker dependency caused setup failures; same-version dependencies were copied into the isolated stage, without widening Vite or OS permissions. The complete Shell suite then passed. These earlier failures are not represented as passes.

## Related predecessor evidence, not interchangeable with exact-stage coverage

The same Home/settings components in #52 were exercised through real Chromium/PostgreSQL: workspace folder/star/trash/restore; explicit preference save/refresh and language; administrator configuration/default/key metadata/disable/reencryption/clear; controlled503 recovery and single-tab realCAS409 reconciliation; Bob UI isolation; four original-format downloads byte-identical. The predecessor differs in native XLSX navigation. These are related evidence, not a claim that all actions were repeated on this stage.

## Explicit remaining limits

No native DOCX/XLSX editor open/edit/save/reopen certification. No actual two-browser-tab conflict run; single-tab controlledCAS is different evidence. No mobile layout or complete automated browser-suite pass. Historical Chromium renderer error9 remains unexplained and is not silently cleared by a successful smoke test. No CI/full-desktop-monorepo/production deployment pass claim.

This is a scoped UI phase, not full T12 end-to-end closure. Keep #52's native entry and broader browser acceptance work outstanding.

## Exact-stage browser smoke

The freshly built stage was served directly by the original Fastify app against disposable PostgreSQL and local temporary objects, without the preceding fault-injection wrapper. Chromium login, author edit followed by autoSave switch, explicit save, browser reload and reopened preferences all passed (author `Scoped UI stage`, autoSave true). Home XLSX opening downloaded4009bytes identical to the original SHA256 `d94493ae46e91d925edaa569fcddd45199e36753f30a8d49fcecfe001db550fb`; URL remained the Home page, not a native editor. This smoke is exact-stage evidence; it does not repeat the entire predecessor GUI matrix. Services stopped normally.

## Current-target integration (supersedes old navigation exclusions)

Integrated against target `d6ab6e4a6dc37234e48acfe9979e8514cf88d8aa`.
The current capability-gated DOCX/XLSX top-level routes from #125 are retained.
PPTX/PDF and noneditable formats only download an authorized original; the
endpoint must exactly bind the requested file ID and returned revision. No new
native capability, provider execution, or production isolation is enabled.

Home recent/starred/search requests now use server pagination and literal query
filtering. Counts use limit=0; toggle/stat use a single selected file identity.
The workspace query remains authenticated, parameterized and RLS-scoped, with
bounded input. totalAll counts the same view/folder before ext/q filters; direct
ID lookup scopes both rows and counts to that ID before materialization.
Search/count operations can still scan matching user data; offset pagination
under concurrent changes does not provide a multi-request snapshot.
FolderListing is still an unpaged contract: directory enumeration is bounded to
10,000 and fails visibly above that limit. Directory refresh fan-out and database
count-query cost are not claimed solved.

Local validation on the integrated candidate:
- Navigation/client/preferences/Home focused suite: 64/64.
- Web default test command: 345 passed, 1 skipped, 0 failed.
- Shell component suite: 90/90.
- Real disposable PostgreSQL workspace/filter/permissions/concurrency: 16/16.
  Includes same-database cross-deployment ID rejection, same-timestamp stable
  ID ordering, and 200/201-codepoint Unicode query boundaries. Actual EXPLAIN
  ANALYZE used Index Scan with deployment/owner/id predicates and one returned
  row, without forcing planner flags. This is fixture evidence, not a load benchmark.
- Shell, Web and server TypeScript checks and Shell production build are recorded
  separately in the PR completion report.
- Independent frontend review: 46 navigation/Home tests passed, no blocking finding.

Initial linked pdfjs worker dependency produced a Vite denied-path failure;
copying the same dependency into this isolated snapshot resolved it without
changing any security setting. Initial build command path/config mistakes were
corrected, not reported as passes. Browser/desktop/CI and production sandbox
acceptance were not rerun and remain outside this local validation claim.
