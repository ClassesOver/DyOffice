# Unified isolation P0: execution-entrypoint inventory

Baseline: `feat/dyoffice-web@d6ab6e4a6dc37234e48acfe9979e8514cf88d8aa` (production code unchanged from `1a4a4ebb`). Reviewed 2026-11-17. This is an auditable **boundary inventory**, not proof of full parser coverage, all-feature desktop fidelity, or OS acceptance. The P0 contract is unconnected; this inventory changes no backend, broker, database, capability switch or existing entrypoint.

## Method and completeness boundary

The complete recursive Git tree was enumerated at the baseline (8,077 entries; not truncated). Candidate discovery used path families `apps/web/server`, `apps/web/worker`, `apps/web/src/editors`, `apps/{docs,sheets,slides}/src`, and `packages/{docx-engine,pptx-engine,xlsx-gateway,zip-gate,cli,doc2docx}`; keywords included `docx|xlsx|pptx|pdf|parse|archive|zip|xml|font|media|thumbnail|import|export|file-actions|headless`.

53 representative source files were read at that exact commit, following imports and exported functions through web entrypoints and package parsing boundaries. The rows below distinguish source-read evidence from tree-only candidates. Test references were verified to exist, not executed by this inventory. All paths are repository-relative. No source-wide text search or call-graph reachability proof was performed; dynamically imported, indirect plugin and desktop-only operations therefore remain explicit review work, not silently certified.

Trust zones: **API** is the trusted application process; **thread** is a Node worker thread, not OS isolation; **host-candidate** is the existing closed experimental systemd execution boundary; **browser** includes renderer/Web Worker and is not the server sandbox; **desktop** and **CLI** are separate launch surfaces, not automatically enabled SaaS features.

## Shared ingress, archive and save boundaries

| Entry / exact source | Observed call chain and trust zone | Required disposition / test reference |
|---|---|---|
| `apps/web/server/src/modules/files/service.ts` | Upload receive calls `validateUpload`; service owns authorization/storage, but parsing is delegated to a thread | Preserve authorization/T06 ownership; isolate complex validation before calling a file ready |
| `apps/web/server/src/modules/files/validation.ts`, `validation-worker.ts`, `validation-core.ts` | API → `Worker` → `validateUploadInternal`; core imports yauzl, fast-xml-parser and pdf-lib. Existing limits: 4,096 entries, 32MiB part, 128MiB total inflated, 4MiB structural XML; DOCTYPE/ENTITY rejection and XML validation | **Important common gap:** upload validation for all four formats remains a thread boundary, not certified OS isolation. Future validate profile must cover it, not only native editors. Reference: `apps/web/test/storage/validation.test.mjs` |
| `packages/zip-gate/src/index.ts` | Metered `assertZipInflatesWithinLimits`, declared-size gates, streaming decompression helpers | Reuse mature existing gate inside sandbox; limit checks do not replace containment; preserve bomb/path/duplicate/size test cases |
| `apps/web/server/src/modules/revisions/service.ts` | PG/T06 current authorization, editing lease, base CAS, immutable upload/receipt ownership (existing exact-baseline review evidence) | Keep trusted control plane. Artifact identity must bind to actual upload/attempt and current lease; no same-hash provenance shortcut |

The shared ingress row is a release blocker for claiming that **all** server-side untrusted parsing is contained. Completing XLSX/PPTX native adapters alone does not close it. Output structure verification has the same requirement: heavy parsing cannot be moved back into the API after sandbox execution.

## XLSX: read, edit planning, save/reopen, media

| Source-read entry | Current boundary / exact operations | Migration and schema owner |
|---|---|---|
| `apps/web/server/src/modules/sheets/routes.ts`, `service.ts` | Fastify request boundary → authenticated immutable file revision → `SheetsNative`/package reader; service snapshots request and enforces format/ownership | Retain route/service authorization. HTTP schema is not sufficient broker command validation |
| `apps/web/server/sheets/gateway-process.ts` → `gateway.ts` | Host-candidate child accepts only `gateway_package`/`gateway_plan`; fixed input and part paths; gateway imports package readers and save planner | Adapt opaque handles to fixed sandbox-local paths only inside trusted adapter. Never expose host paths in public contract |
| `packages/xlsx-gateway/src/gateway/xlsx-gateway.ts`, `xlsx-package-io.ts` | JSZip/zip-gate package reading and mutation planning; package IO imports zod/edit schemas, and also has filesystem-facing desktop/CLI helpers | Reuse schemas and byte-source planning, not generic filesystem APIs. Inventory standalone file helpers before any worker import widening |
| `apps/web/worker/src/native/xlsx.ts` | `open`, `close`, `read_range`, `read_formula_cells`, `read_row_outline`, `read_media`, `recalc_cells`, `save_archive`; save reopens output before returning bytes | Adapter owns mapping from high-level operation to exact command/payload schema. Keep sheet/range limits, media IDs and fixed output handling; arbitrary command strings prohibited |
| `apps/web/worker/src/native/admission.ts` | Existing native admission budget/cancellation (source read in earlier P0 baseline pass) | Resource queue is not an isolation replacement. Move admission accounting to durable reservation phase without removing current bounds |

Existing evidence references: `apps/web/test/native-sheets/gateway.test.mjs`, `gateway-cancellation.test.mjs`, `native-admission.test.mjs` (last two names relative to that directory), `apps/web/test/unit/gateway-adapter.test.mjs`, `apps/web/test/host-native/gateway.test.mjs`. Real-host tests are separate from pure gateway/mock tests and are not passed by P0.

Tree candidates requiring follow-through: `apps/web/server/src/modules/sheets/save.ts`, `runtime.ts`; `apps/web/src/editors/sheets-bridge.ts`, `sheets-entry.tsx`; `apps/sheets/src/shared/desktop-api.ts`, `workbook-save-plan.ts`; workbook connections/external-links/drawing helpers under `packages/xlsx-gateway/src/gateway/`. Native operations reference these surfaces, but this pass does not certify every helper or external-data behavior.

## PPTX: session, operations, render/export

| Source-read entry | Observed boundary / operations | Required disposition |
|---|---|---|
| `apps/web/server/src/modules/slides/routes.ts`, `service.ts` | Authenticated session/editor/lease/generation/base checks; service has open/read/apply/export interfaces and limits | Preserve pre/post authority checks. Formal app mount remains disabled in current baseline; do not infer enabling from presence of these methods |
| `apps/web/worker/src/native/pptx-session-child.ts`, `pptx-session.ts` | Child protocol dispatches `apply`, `undo`, `redo`, `render`, `renderAll`, `outline`, `export`, `close`; session imports openPptx/savePptx, pptx-ops transaction registry, pptx-render, zip-gate | Build profile-specific protocol; reply schemas differ by operation. Render is not necessarily a file artifact; export is |
| Same session source | Explicit operation switch includes setText/setFill/setStroke/addElement/setTransform/addSlideWithLayout/duplicateSlide/moveSlide/setNotes/reorderElement/setFont/setParagraphFormat/findReplace | Derive payload schemas from the actual registry, not just this name list. Do not forward arbitrary transaction parts, isolation flags or master-part targets |
| `apps/web/worker/src/native/pptx-job.ts` | Calls createPptxSession, returns exported bytes/local generation/hash | Plain function invocation is not proof of OS containment. Bind job epoch, runtime identity and authoritative upload provenance in future adapter |
| `packages/pptx-engine/src/index.ts`, `zip.ts` | open/save package surface; PackageArchive uses JSZip/zip-gate, XMLParser, relationships; rendering imports can reach media/fonts | Entire dependency closure belongs to immutable runtime. ZIP limits and history limits remain defense in depth |

`apps/web/worker/src/native/pptx-session-host.ts` remains the existing session transport/test-host boundary from the exact-baseline review. It is not a production sandbox certificate. Existing native-slides tests must retain history/alias ambiguity/session loss/same-hash different upload cases. Tests for real systemd child-tree exit, cross-tenant filesystem and broker recovery are still missing from P0.

Tree candidates: `packages/pptx-engine/src/embedded-fonts.ts`, `media-insert.ts`, `xml-utils.ts`; `apps/web/src/editors/slides-bridge.ts`, `slides-entry.tsx`; `apps/web/server/src/modules/slides/save.ts`. Their presence does not establish all thumbnail/font/media external-resource policies.

## DOCX: browser parsing and server legacy editing are distinct

| Source-read entry | Observed call chain / zone | Migration or explicit exclusion |
|---|---|---|
| `apps/web/src/editors/native-docs.tsx`, `docs-bridge.ts` | Browser mounts existing Docs App; bridge binds SessionFileHost and save-generation guard | Browser parsing is not inside server sandbox. Preserve lease-bound saving; independently harden origin/CSP/message channel |
| `apps/docs/src/renderer/file-actions.ts`, `doc-bytes.ts` | Browser open/reopen fetches bytes, calls parseDocxOffThread/parseDocx; saveDocx serializes model/save-plan; markdown/html are additional export surfaces | Track each persistent editing action and byte producer, not just page properties. Existing file-actions route is a shared desktop/web renderer surface |
| `apps/docs/src/renderer/parse-off-thread.ts`, `parse-worker.ts` | Web Worker parses via parseDocx; unsupported/failed worker falls back to renderer inline | This is a browser performance fallback, **not** an approved server containment fallback. Do not reuse it in broker adapters; origin isolation remains required |
| `apps/web/server/src/modules/documents/routes.mjs` → `apps/web/server/document-editing.mjs` → `docx-session.mjs` | Existing legacy route/helper surface projects DOCX and applies text edits via dynamically loaded parseDocx/saveDocx | Source exists in API-side code. Reachable through authenticated development-token assembly; not registered by buildLocalApp, and all documented production assemblies reject startup (details below). Retire this legacy editing path for the future unified runtime rather than revive it for compatibility |
| `packages/docx-engine/src/index.ts`, `parse.ts`, `parse-package.ts`, `zip-load.ts` | parseDocx → metered ZIP/JSZip → XML relationships/styles/parts; library also exposes saveDocx | Reuse parser semantics within approved runtime; validate all import sites. Runtime needs complete dependencies, not merely one JS entry hash |
| `packages/docx-engine/src/font-table.ts`, `metafile.ts`, `tiff.ts`, `lazy-media.ts` | Embedded font reading/deobfuscation/metrics, EMF/WMF conversion, bounded gzip helper, UTIF TIFF decode, lazy media part identifiers | Include font/image decoders in threat and resource budgets. Lazy identifiers are not permission to resolve arbitrary URLs/paths |

Reference tests: `apps/web/test/docx-editor.test.mjs`; package-specific docx-engine tests cover individual behaviors but are not host isolation acceptance. Full editor mutation coverage and desktop comparison remain unfinished; no broad “all DOCX functions tested” claim is justified by this inventory.

## PDF: inspect, rotate, raster, viewer and save

| Source-read entry | Observed zone / operation | Required disposition |
|---|---|---|
| `apps/web/server/src/pdf/capabilities.mjs` | API-side pdf-lib object inspection and zlib inflation; read/unsupported capability decisions | Move complex parsing into validate profile; keep trusted operation authorization outside parser |
| `apps/web/server/src/pdf/rotate.mjs` | Pure Node pdf-lib rotation/export; rejects unsupported input/operations; no route or persistence authority | Isolate parse/edit/export; do not turn a pure function into authorization. Existing PDF policy allows different byte/page limits from proposed P0 experimental profile |
| `apps/web/server/src/pdf/raster.mjs` | Node PDFium WASM loading and renderPdfPages after inspectPdf | WASM does not certify entire process confinement. Bound pages/pixels/fonts/decoded data and runtime wasm integrity |
| `apps/web/server/src/pdf/fonts.mjs` | Serves pinned PDF.js standard font/CMap resources using known names, realpath and extension rules | Keep outside untrusted engine but audit static-resource path scope; do not allow arbitrary font URL resolution |
| `apps/web/src/editors/pdf-entry.ts` | Browser PDF.js worker and local CMap/font resources | Browser isolation separate; worker is not tenant authorization. Review external URLs/JS/embedded action handling with CSP configuration |

Tree candidates tied to existing save evidence: `apps/web/server/src/pdf/rotation-job.mjs`, `save-preparation.mjs`, `save-attempt.mjs`, `receipt-recovery.mjs`, `apps/web/src/editors/pdf-csp.ts`. Preserve explicit prepare/commit, identical-request retry and read-only receipt recovery; isolate their parsing dependencies without moving T06 authority into the engine.

Existing test references: `apps/web/test/pdf-capabilities.test.mjs`, `pdf-tokenizer-progress.test.mjs`, `pdf-rotate.test.mjs`, `pdf-rotation-job.test.mjs`, `pdf-raster-limits.test.mjs`, `pdf-render.test.mjs`, `pdf-pages.test.mjs`, `pdf-cmap-safety.test.mjs` (all relative to apps/web/test after the first); `apps/web/test/local-integration/pdf-save-preparation.test.mjs`, `pdf-save-attempt.test.mjs`, `pdf-receipt-recovery.test.mjs` (same directory convention). These were not run in this inventory.

## Desktop/CLI/conversion and thumbnail scope

Source-read `apps/docs/src/renderer/headless-export.ts` and `apps/slides/src/renderer/headless-export.ts` describe hidden-window desktop export using existing GUI export actions/readiness. They are **not** a ready SaaS sandbox export backend.

Tree-only candidate launch surfaces: `apps/docs/src/main/index.ts`; `apps/sheets/src/main/{index.ts,pdf-export.ts,import-registry.ts}`; `apps/slides/src/main/{index.ts,pdf-export.ts,export-images.ts,metafile-fonts.ts,video-export.ts}`; `packages/cli/src/formats/{docx.ts,pptx.ts,xlsx.ts,pdf.ts}`; `packages/doc2docx/src/index.ts`. Do not expose these generic file/network/desktop launchers from the new broker. Legacy .doc conversion is a separate unsupported input until expressly profiled and tested.

No standalone SaaS thumbnail route was certified in this pass. Rendering, slide images, lazy media and raster paths are listed above; the absence of a path containing “thumbnail” is not proof that thumbnail generation has no hidden call site. Before production, search actual imports/callers and classify every thumbnail/preview/image conversion invocation, including any dynamically registered plugin.

## Assembly reachability and disposition (source-proven, not a live deployment test)

The following classifications are based on the exact baseline's registration and guards. “Production-disabled” means the documented application constructors reject `NODE_ENV=production`; it does not prove an operator cannot mislabel an externally exposed development process. The parser helpers themselves are callable library functions, not authorization boundaries.

| Surface | Classification | Exact assembly evidence | Disposition for unified runtime |
|---|---|---|---|
| Shared `validateUpload` worker-thread parsing | **Reachable in non-production local account mode**, when businessPool and objectStore are supplied. Not test-only and independent of native editor flags | `server/index.mjs:25–46` selects local mode and supplies both stores; `server/src/app.ts:129–143` builds FileService and registers routes; `server/src/modules/files/routes.ts:49–51` PUT content calls receiveUpload; `files/service.ts:61–77` calls validateUpload; `files/validation.ts:21–34` constructs/terminates a Worker; `validation-worker.ts:5` invokes the parsing core | Before any production gate is opened, move validation to the approved isolation backend or refuse that operation. Preserve authenticated stage/preflight/T06 state machine and byte/XML/ZIP limits. Native capability flags must not be mistaken for a validation gate |
| Same shared parser through documented production server | **Production-disabled by application assembly**, not by validation.ts itself | `server/index.mjs:26` rejects production local startup; `server/src/app.ts:76` independently rejects production direct buildLocalApp. No exception permits upload validation in production | Add a regression that removing only one guard cannot accidentally enable the public route; preserve both guards until isolated validation is proven. Do not use non-production environment labels as a containment solution |
| Legacy DOCX GET/POST editing and upload parsing | **Reachable in authenticated development-token mode**, not test-only | `server/index.mjs:18–24` calls buildApp by default/development mode; `server/src/app.ts:47–56` creates legacy context; `server/src/app.mjs:125` registers it; `server/src/legacy-dispatch.mjs:35–39,57–66` authenticates and dispatches `/api/v1/files/*`; `server/src/modules/documents/routes.mjs:5–8` invokes editing handler after revision handler (whose `modules/revisions/routes.mjs:16–18,84–89` only matches leases/commits/restore, not docx/uploads); `server/document-editing.mjs:159–163,193–212` parses upload/GET and mutates POST; `server/docx-session.mjs:71–75,139–144,196` calls parseDocx/saveDocx in the API process | Treat as a retired development/prototype surface, not an adapter to preserve. Future unified assembly must not register it. If development editing is retained for explicit testing, label it non-isolated and add negative registration tests for local/production |
| Legacy DOCX in `buildLocalApp` | **Disabled / not registered** in this assembly | `server/src/app.ts:129–153` registers modern file/revision/native routes, not legacy context; `app.ts:218–227` authenticates unmatched API requests then returns 501 rather than invoking legacy JSON routes. Native DOCX assets are a separate browser editor path, not this server text-edit endpoint | Preserve this separation. Test `/api/v1/files/:id/docx` against local assembly returns the unsupported result with valid auth; never silently fall back after broker failure |
| Legacy DOCX via production constructors | **Production-disabled** | `server/src/app.ts:48` buildApp guard; `server/application.mjs:7` compatibility application guard; `server/src/app.mjs:48` calls `assertModularConfig`, whose `server/src/config.mjs:9–17` rejects production process/config environments | Keep all documented constructors closed until release gates; module imports alone do not mean routes are enabled. A direct caller of `serveDocumentEditing` bypasses assembly policy and is not a supported deployment |

All `server/...` paths in this table are relative to `apps/web/`; line numbers belong to the fixed baseline and must be refreshed when these files change. Key immutable source anchors: [local assembly](https://github.com/ClassesOver/DyOffice/blob/d6ab6e4a6dc37234e48acfe9979e8514cf88d8aa/apps/web/server/src/app.ts#L129-L153), [upload route](https://github.com/ClassesOver/DyOffice/blob/d6ab6e4a6dc37234e48acfe9979e8514cf88d8aa/apps/web/server/src/modules/files/routes.ts#L49-L51), [legacy dispatcher](https://github.com/ClassesOver/DyOffice/blob/d6ab6e4a6dc37234e48acfe9979e8514cf88d8aa/apps/web/server/src/legacy-dispatch.mjs#L35-L39), [production shell guard](https://github.com/ClassesOver/DyOffice/blob/d6ab6e4a6dc37234e48acfe9979e8514cf88d8aa/apps/web/server/src/config.mjs#L9-L17).

### Registration regression work still required

- Instantiate the modern local app with valid disposable PG/object-store configuration, native editors off, and an authorized staged upload: prove the upload route still reaches the validator. This demonstrates why the shared ingress requires migration rather than assuming editor flags disable it.
- Instantiate local app without businessPool or objectStore: assert file routes are absent/unsupported, not silently routed to legacy handlers.
- Exercise each documented constructor under production environment and assert refusal before listening. Existing source guards are confirmed; this inventory did not execute these tests.
- With valid local auth, request the legacy `/api/v1/files/:id/docx` endpoint and assert unsupported rather than parser invocation. In the explicit development-token harness, characterize current endpoint reachability only with synthetic documents, not untrusted live uploads.
- Maintain static import/registration regression for the new unified production assembly: no `document-editing.mjs`/`docx-session.mjs` legacy dispatch and no worker-thread validator used as a substitute for the isolated backend.

No runtime setting, route, parser or production guard was modified for this reachability review. Desktop/CLI launchers and the complete browser graph remain outside this focused assembly proof, so they are still marked candidates above.

## Required closure before marking the boundary complete

1. Replace or explicitly disable shared upload/output **worker-thread** parsing at production boundaries.
2. Preserve the proven local/production exclusion of legacy DOCX, and retire its development editing exposure when migrating the unified runtime. Desktop/CLI helper reachability still needs separate call-site verification; do not add a compatibility bypass.
3. Implement format command and reply schemas from the listed actual operation owners. High-level parse/edit/export/validate labels do not validate nested engine payloads.
4. Bind authenticated tenant mapping, PG lease/epoch, actual input hash/size, runtime certificate and artifact provenance; P0 syntax validation cannot perform these checks.
5. Add real-host tests for archive/font/image/parser attacks, network/socket isolation, cross-tenant paths, child-tree termination, recovery and retained capacity. Existing unit and format tests do not establish these properties.
6. Complete source-wide call-site scan and operation-level feature matrix; verify XML/ZIP policy at every relevant helper, dynamic import and secondary export. Current boundary map is sufficient to assign owners, not to advertise exhaustive semantic coverage.
7. Finalize per-format resource/session policies from measurement. P0 profiles are experimental and production-disabled; 32MiB/30s is not a claim of PDF 64MiB API compatibility or certified long-lived session support.

Implementation tracking must distinguish a schema/type being defined from a broker/backend being implemented. This document does not certify renew/watchdog, recovery/adoption, runtime integrity, browser origins or desktop fidelity merely because a contract names them.

See `document-command-schema-map.md` for the format-by-format default-deny disposition. Complete P0 business command/reply schemas and full parser coverage are not claimed.
