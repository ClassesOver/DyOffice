# T09 existing lifecycle map

This inventory records actual source boundaries used to implement the T09 plan.

| Stage | Existing source | Web adaptation requirement |
| --- | --- | --- |
| Mount | `apps/sheets/src/renderer/App.tsx:620` | Reuse App and Univer; explicit host context beyond queuedWorkbookAtBoot |
| Open model | `App.tsx:5012` openLazyWorkbook | Preserve native metadata, lazy state, named items, charts and format state |
| Desktop open | `apps/sheets/src/main/sheets-main.ts:5186` openWorkbookSession | Currently snapshots paths, opens Rust, validates workbookFileSchema and maintains session map; extract reusable logic without Electron import |
| Native IPC | `apps/sheets/src/main/xlsx-sidecar-client.ts` | Existing command/result contract; Web execution goes through T08 host runner |
| Read/recalc/save DTOs | `apps/sheets/src/shared/desktop-api.ts` | Reuse existing typed requests and validation, replacing filesystem authority at server boundary |
| Edit/save journal | `apps/sheets/src/renderer/save-actions.ts` handleSave | Preserve edit journal, sheet operations, formulas/cache, styles, names, charts and undo carry |
| Desktop save mapping | `sheets-main.ts:4764` writeWorkbookTo | Maps session sheet IDs and operations to original gateway planner; cannot import the whole Electron main module |
| Package mutation | `packages/xlsx-gateway/src/gateway/xlsx-package-io.ts:183` saveWorkbookViaSidecar | Reuse planner and Rust streaming archive writer; requires safe fixed workspace files, manifest/read/scan/save commands |
| Gateway dependencies | `xlsx-gateway.ts`, `xlsx-package-io.ts` | Runtime fs/path/crypto imports must stay outside browser dependency graph |
| Existing Web seam | `apps/web/src/editors/docs-entry.tsx`, `docs-bridge.ts` | Reuse authentication, file state, lease renewal, conflict/reconciliation conventions |
| Browser acceptance | `apps/web/test/native-docs/roundtrip.test.mjs` | Existing real HTTPS/Fastify/Playwright scaffold can be adapted to Sheets; do not replace with mocked editor acceptance |

T08's current allowlist and fixed input/output session only support an unedited
archive roundtrip. T09 needs bounded native archive entry operations for the
existing save planner as well as native reads. Extend the controlled workspace
interface deliberately; never accept browser-provided contentPath/sourcePath or
arbitrary commands. Persistent native session IDs cannot outlive an invocation
without an explicit server-owned session lifecycle; per-request reopening also
requires deterministic mapping of renderer sheet references.

The real acceptance fixture must represent stale formula caches, source numeric
values and formats, named ranges, charts and unknown ZIP parts. Existing source
includes only `apps/shell/build/shell-new/blank.xlsx` as a tracked XLSX, so build a
deterministic test workbook with retained hash rather than referring to an
unavailable external sample. Production workbook writing remains the original
gateway/Rust path; fixture construction is test-only.
