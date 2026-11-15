# XLSX original-engine reuse spike

Baseline: `2e403f6e1430ae05f7df9cd92548189107467063`. This is a bounded source-reuse experiment, not T00/T08 acceptance or a writable Web capability.

## What ran

- Original `@genoffice/xlsx-gateway` functions, unchanged: `applyCellEditsToXlsx`, `writeXlsxAtomically`, `mutateXlsxFile`; original `buildEditFixture` for preservation regression coverage.
- `apps/sheets/tests/web-reuse-roundtrip.test.ts`: actual disk save, CRC-checked ZIP reopen, second mutation of reopened bytes, preservation of untouched XML/styles/chart parts, and rejection of an already stale digest without disk modification. Two tests passed.
- Original `shared-formula-materialize.test.ts`: nine tests passed unchanged. Total: 11/11.
- Separate real workbook: original `blankXlsxBuffer('Data')`, then original gateway writes A1=`DyOffice 原生写回`, C2=`37`, B3=`=SUM(C1:C2)`; original atomic writer saves it. Independent **read-only** openpyxl 3.1.5 reopened the saved file and asserted all three values. Python did not generate, modify or save the workbook. Formula text preservation does not establish recalculation correctness.
- The compact `buildEditFixture` is an engine-unit-test fixture, not an interoperable workbook corpus: openpyxl rejects its minimal `<fill/>` stylesheet. The independent-reader check therefore used the original engine's full blank-workbook constructor, not a repaired/reimplemented serializer.

## Reproduction

Run with the repository's Sheets dependencies installed:

```sh
npx vitest run --root apps/sheets tests/web-reuse-roundtrip.test.ts tests/shared-formula-materialize.test.ts
```

The experiment used isolated dependencies (no Electron install and no root/CI manifest edits): JSZip 3.10.1, Zod 4.6.7, numfmt 3.2.6, tsx 4.21.0 and Vitest 4.1.12, linked to the original `xlsx-gateway` and `zip-gate` workspaces. Node 24.22.1. This is not yet a supported production dependency profile.

## Actual blockers and limits

- The original `XlsxSidecarClient.open()` was attempted against the saved workbook and failed with `spawn .../target/release/xlsx-sidecar ENOENT`. Neither Cargo nor rustc is installed on this executor, and no built sidecar is present. Native open/read/recalculate/save/reopen has **not passed**.
- Original Sheets renderer Vite build stops at missing `@vitejs/plugin-react` in the current Web-only install. Univer UI editing has not been exercised.
- `xlsx-gateway` is Electron-free, **not browser-only**: it imports Node filesystem/crypto/streams. Preserve it on the service/worker side; do not pull it into the browser bundle.
- The original hash-before-write check rejects an already stale file but is not an atomic database compare-and-swap. Do not expose it as multi-user revision/lease enforcement. Shared file-service authorization, revision CAS, session isolation and resource quotas remain required.

## Smallest next step

Reuse the original Univer renderer, `XlsxSidecarClient`, Rust engine and gateway unchanged wherever possible. Build the locked Rust sidecar in an isolated server worker, bind session IDs to authenticated file/workspace ownership, and map scoped BrowserHost operations to that session. Feed original edit plans to the original save pipeline, then commit resulting bytes through the shared revision API. Prove native reopen and formula results before advertising XLSX write capability. No replacement spreadsheet engine, Python save path or broad desktop bridge is justified by this spike.
