# T00 engineering gates: checkpoint, not completion

Baseline inspected: `31382af2217a6ac32ea3c7208138f1aa8e23f146` on
`feat/dyoffice-web`, plus this checkpoint's CI/type-resolution/baseline changes.
Environment: Linux, Node 24.22.1, Web-only dependency install. This is not a
production or external Office acceptance record.

## Gaps reproduced and corrected

1. The compatibility checker reported `files.package-lock.json` drift after
   `8fc3947` registered Web/BrowserHost/contracts workspaces in the root lock.
   Reviewed change: workspace records and links only; selected npm version/integrity
   records did not change. Regenerated the manifest and confirmed that only the root
   lock file hash/size changed. `npm ci --dry-run --ignore-scripts --no-audit --no-fund`
   exited 0; this does **not** establish full installation or upstream test success.
2. Web CI neither ran the baseline tests/checker nor triggered for a root-lock-only
   change. Added read-only baseline validation, regression execution and trigger
   paths for the root lock, license inputs, checker and baseline. CI never runs
   `--write`; drift requires an explicit reviewed update.
3. A clean Web-only install could run adapter tests but `typecheck:web` failed with
   TS2307 for `@genoffice/agent-core` imported by the SSE adapter. Added a TypeScript
   path mapping to the real existing Agent Core public entry, not an `any` shim or
   copied types. The same typecheck then passed without installing Electron or the
   root workspace dependency graph.

## Commands and observed results

```sh
npm ci --prefix apps/web --workspaces=false --ignore-scripts --include=dev
node --test tools/check-web-boundaries.test.mjs tools/audit-web-host.test.mjs \
  tools/dyoffice/*.test.mjs apps/web/test/unit/*.test.mjs apps/web/test/*.test.mjs
node tools/dyoffice/compatibility-baseline.mjs --check
node tools/check-web-boundaries.mjs
npm run typecheck:web
npm run test:web:build
node tools/audit-web-host.mjs
```

- Targeted regressions: 50 passed, 0 failed, 0 skipped.
- Compatibility inputs: 84 files, zero drift.
- Local browser dependency graph: 20 files, zero forbidden imports.
- BrowserHost/contracts typecheck: passed after reproducing TS2307.
- Web prototype production build and HTTP asset smoke: 2 passed.
- Host inventory: Docs 110 declared / 0 unmatched; Sheets 38 / 58 unmatched;
  Slides 208 / 0; PDF 82 / 0. These are scanner observations, **not** verified
  per-method implementation or runtime compatibility. Sheets remains incomplete.
- `git diff --check`: passed.

Local results do not claim GitHub CI success. Review the run for the exact merged
commit independently. The original upstream suite, native compilation, visual UI,
real model/data-source/Harness and external Office tests are not covered here.

## T00 acceptance still open

| Plan requirement | Evidence now | Still required |
| --- | --- | --- |
| Browser Node/Electron rejection | Direct/transitive local graph regression gate | Computed imports, third-party bundle/runtime boundaries and real editor assets |
| IPC/host inventory | Initial four-editor scan and source map | Complete Sheets extraction; signatures, lifecycle, errors and actual Web target per call |
| Tool execution classification | Agent/MCP migration inventory | Exhaustive tool/skill live/headless/unsupported registry with verified execution ownership |
| Native/fonts/MCP version inputs | Deterministic lock/font/config baseline | Rust toolchain/ABI, PDF WASM/CSP, font rendering and real client compatibility |
| Minimal Web build + old API | Actual scaffold build, HTTP smoke, API regressions | Mounted native editor and real open/edit/save/download/reopen path |
| Reproducible release environment | Web-only install and typecheck | Production image/toolchain/digests, affected upstream suites and real environment evidence |

Do not mark T00 or M0 complete from this checkpoint. Preserve not-run/blocked
statuses; passing scaffold gates is not four-format editing or enterprise readiness.
