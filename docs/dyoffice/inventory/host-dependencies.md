# DyOffice Web host dependency inventory (T00, initial)

> 2026-11-15. Source snapshot: `ClassesOver/DyOffice` branch `feat/dyoffice-web`, baseline `650869569af5e8719f44b4bebdcb862d89e5ccb0`. This is an initial, evidence-based inventory, **not** a completed renderer-by-renderer IPC audit.

## Confirmed seams

| Subsystem | Current source | Confirmed dependency | Required Web seam | Status |
| --- | --- | --- | --- | --- |
| DOCX model streaming | `apps/docs/src/renderer/ai/transport.ts` | `window.desktop.onAiStream`, `aiStream`, `aiStreamCancel`, `createIpcTransport` | `AgentTransport` backed by authenticated POST streaming HTTP (SSE) | Not implemented |
| DOCX agent tools | `apps/docs/src/renderer/ai/docs-skill.ts` | Live Tiptap `Editor`, selection/document state and editor-local tool executor | Keep active-editor tool execution in browser; server authorizes service tools | Not implemented |
| Agent contracts | `packages/agent-core/src/types.ts`, `index.ts` | `AgentTransport.stream(...)`, cancellation and callback semantics | Reuse contract, no parallel agent loop | Existing upstream contract; Web adapter pending |
| LLM/provider | `packages/ai-provider/src/index.ts` | Provider/media/search configuration and stream helpers | Server-side credentials and capability enforcement | Web provider gateway pending |
| XLSX | `apps/sheets/package.json`, `packages/xlsx-gateway/package.json` | Univer, Rust native XLSX build, OOXML gateway | Determine browser-safe portions, isolate native operations in worker | Spike required |
| PDF | `apps/pdf/package.json` | PDF.js, PDFium and pdf-lib | Verify WASM/worker/asset setup and real PDF editing/export | Spike required |
| Desktop CLI | `packages/cli/src/control-protocol.ts`, `agent-mcp.ts` | Local socket/pipe, file path and stdio lifecycle | Do not expose directly; define authorized HTTP MCP tools | Not implemented |
| Web prototype | `apps/web/server/application.mjs`, `store.mjs`, `mcp.mjs` | Node HTTP, local JSON persistence, bearer tokens, encrypted secrets, outbound HTTP MCP discovery | Replace with authenticated multiuser API + DB/storage while preserving tested routes | Prototype only |

## Web-specific boundary gate

The check `node tools/check-web-boundaries.mjs` starts at browser-side roots:
`apps/web/src`, `apps/web/public`, `packages/browser-host/src`, and
`packages/web-contracts/src`. It parses JavaScript/TypeScript syntax using the
Web workspace's pinned TypeScript 5.9.3 dependency, so comments and ordinary
strings are not treated as imports. It follows literal local imports/re-exports,
literal dynamic imports/require, and workspace package exports to detect indirect
Node/Electron imports, including JS-extension imports resolving to TS source.
Cycles are visited once. Unsupported workspace exports and unresolved local code
imports fail closed instead of reporting a clean scan.

The check **does not claim** to analyze computed dynamic imports, tsconfig/bundler
aliases, wildcard/array package exports, third-party dependency graphs, generated
code, asset transforms or runtime globals. Exact workspace exports support the
`browser`, matching `import`/`require`, and `default` conditions in declaration order. Type-only imports
are conservatively checked as well. Browser production builds, runtime tests and a
full importer graph audit remain required. Server/worker roots are not scanned
unless imported from a browser entry; their normal Node use is allowed.

Install the small Web dependency set with
`npm ci --prefix apps/web --workspaces=false --ignore-scripts --include=dev`, then
run `node --test tools/check-web-boundaries.test.mjs`. CI runs these tests and the
scanner without installing Electron, including on changes to shared apps/packages.
This does not replace the existing desktop CI or constitute completed T00 acceptance.

## Remaining T00 audit before T01

- [ ] Enumerate all renderer calls into `window.desktop` / preload APIs for Docs, Sheets, Slides and PDF; record each signature, lifecycle and error mode.
- [ ] Classify every call as `browser-native`, `server-api`, `isolated-worker`, `unsupported` or `desktop-only`. Verify the mapping in code rather than guessing.
- [ ] Check native XLSX Rust sidecar compatibility/ABI and whether production Web needs a server worker; test fixtures and external Excel reopen behavior.
- [ ] Check PDFium WASM/worker bundling and font licensing; preserve genuine text edits versus annotations.
- [ ] Validate stream cancellation, save and user permission semantics against browser reality; do not assume Electron e2e passes prove Web behavior.
- [ ] Lock SDK and Node versions after existing lockfiles are checked; check sm PR #245 independently if used as a reference.
- [ ] Run legacy `npm run test:web`, Web tests, and the upstream impacted suites in a real checkout and record their exit codes.

**Release constraint:** a passing import gate is not permission to enable live editing, multiuser access or enterprise production. T00 is incomplete until this checklist and its evidence are finished.
