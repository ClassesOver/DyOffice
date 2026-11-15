# Agent / MCP host-coupling inventory

## Scope and evidence

This T00 inventory covers reuse of GenOffice's agent loop, editor tools and MCP surfaces. It is not implementation of T13–T19 or acceptance of their security/runtime behavior.

- Initial code inspection: `27a14f53931dd45879a7b1c632ce4a99a7738129`.
- Rechecked through development head `c1bc834c3efb74e85baee6edf3a1b54b529de5d0`. Parallel work added a browser SSE adapter (`packages/browser-host/src/ai-transport.ts`) and mock-stream tests using the public AgentTransport type. This is an implementation seam, not evidence of editor wiring, a working Provider Gateway, or end-to-end cancellation. Other inspected desktop/agent-core sources are unchanged.
- TypeScript AST inspection of all 15 `packages/agent-core/src/*.ts` files found zero non-relative static import/export specifiers. This is a dependency inventory, not proof of browser runtime compatibility or absence of all dynamic dependencies.
- Final publication recheck: `40e5c1be42e9d2d1698740c516eb9f480bc2fedb` adds production-startup and Admin/personal-resource guards to the development token server; its MCP discovery route remains unchanged. These guards do not implement OIDC or multi-user ownership.
- No real model, external MCP client, browser round trip, native CLI or multi-user authorization test was performed for this inventory.

Read alongside [the implementation plan](../implementation-plan.md), [architecture](../architecture.md), [host inventory](host-dependencies.md) and [compatibility baseline](compatibility.md).

## Reuse map

| Surface | Evidence | Keep | Adapt |
| --- | --- | --- | --- |
| Agent loop and skills | `packages/agent-core/src/{loop,skill,types}.ts` | Loop, context/compaction, tool composition, claimed-action verification | Inject Web transports and authorized tool execution; do not replace the loop with a new agent framework |
| Stream transport | `packages/agent-core/src/electron-transport.ts` | Callback-driven lifecycle, correlation, watchdog and cancellation contract | The name says IPC, but the module has no Electron import. Four editor `ai/transport.ts` adapters still bind callbacks to preload globals |
| Shared file/knowledge/CLI skills | `packages/agent-core/src/{attachments-skill,knowledge-base-skill,cli-skill}.ts` | Tool semantics, prompts and injected dependencies | Replace local paths/work directories/output paths with authorized artifact references at the host boundary |
| Editor tools | `apps/{docs,sheets,slides,pdf}/src/renderer/ai/` | Native live-editor executors and selection/context behavior | Route service operations through BrowserHost; retain browser operations in the active editor |
| Desktop MCP tools | `apps/shell/src/main/mcp/tools/` | Existing schema and operation semantics where compatible | Separate path-based/headless operations from live-editor commands; add shared authorization, command journal and revision commit services |
| Existing Web MCP | `apps/web/server/{application,mcp}.mjs` | Official SDK Streamable HTTP client, Admin configuration seam | Current implemented route only connects and lists tools. Discovery is not execution, user authorization or inbound MCP acceptance |

## Prioritized migration gates

### P0: provider and active-editor control

1. **T13:** all four `apps/<editor>/src/renderer/ai/transport.ts` files wire `createIpcTransport` to `window.desktop`, `window.desktopApi`, `window.slidesApi` or `window.pdfApi`. A browser-side `createSseAgentTransport` now exists, but these editor adapters still require wiring to it and the server Provider Gateway/SSE boundary. Keep model credentials and global configuration server-side. Test cancellation, logout, configuration disable/revocation, delayed chunks and stream failures; clearing client UI alone is not cancellation.
2. **T17:** `apps/shell/src/main/mcp/docs-bridge.ts` imports `node:fs` and Electron, tracks readiness and pending commands by `webContents` IDs. The sheets/slides bridges likewise belong to the desktop host. Web routing must bind editor/session/document ownership to the authenticated principal, and use T01/T14 command identities. Reconnection must not repeat a write whose acknowledgement was lost.
3. **T19:** `mcp-server.ts` listens on loopback and stores session transports/servers in maps. Its Host/Origin checks protect a local desktop surface, not SaaS ownership. Do not expose that server unchanged. A MCP session ID is not a user identity: validate token scope, audience, expiry/revocation and artifact ownership on every action and session reuse.

### P0: files, CLI and persisted outcomes

4. **T08/T14/T19:** `tools/document-tools.ts` imports filesystem/path utilities, while `cli-runner.ts` uses `spawn`, inherits process environment and accepts a working directory. The injected CLI seam is reusable, but request-supplied local paths, arbitrary process configuration and desktop environment inheritance must not become Web API capabilities. Use authorized artifact IDs, controlled scratch directories, fixed executable/arguments, resource limits and isolated jobs.
5. **T06/T14:** a CLI/tool success is not a committed revision. Only the authoritative revision service may mark persisted success; approval, command ID, base revision, idempotency and `unknown_outcome` handling must wrap existing executors. The generic `AgentSkill.executeTool(call, signal)` contract alone does not provide those guarantees.

### P1: tool placement and outbound integrations

6. **T12–T16:** classify each tool before adapting it. Direct preload examples include docs/sheets/slides `files-skill.ts` attachment reads; docs `skills-skill.ts` CLI; sheets search/image skills; and slides `slides-skill.ts` search, image generation/media analysis, edit scripts, chart changes and transactions. Separate browser document mutation, server provider/search requests, and worker native operations. Reuse the existing executors rather than migrating the entire UI tool set into a headless server.
7. **T18:** `/api/admin/mcp/:id/test` in `application.mjs` calls `withMcp(... client.listTools())` and returns tool names/descriptions. There is no corresponding authorized remote tool execution route here. Add policy checks, schema/response size limits, SSRF/egress controls, credential rotation, disable/revocation and cancellation tests before exposing invocation. Remote tool schemas remain untrusted data.
8. **T19:** use the shared ToolDescriptor/command services for incoming MCP. Existing desktop tools include DOCX create/read/edit, XLSX create/read/apply, PPTX create/read/apply, PDF read, session creation/save and open-document operations. Capability presence in desktop code does not establish Web support. Validate at least the actual target clients required by the plan, not just handcrafted HTTP requests.

## Task order and acceptance evidence

Proceed through the plan's dependencies, not a parallel rewrite of the same gateway:

`T07/T12 → T13 → T14 → T17`, then complete the relevant `T08/T15/T18` prerequisites before `T19`.

Useful regressions to retain:

- owner A token cannot read/edit/save owner B artifact, including reused MCP sessions;
- readonly token cannot write; revoked token/config cannot continue an old stream or approved command;
- write applies but acknowledgement is lost: reconnect reports the recorded outcome without duplicate mutation;
- editor closes or no authorized editor exists: fail explicitly, without silently selecting another user's tab;
- CLI/object output exists but revision commit fails: no false saved/committed response;
- malicious/oversized remote schema or result, redirect/internal URL, timeout and cancellation fail safely.

This document does not mark any implementation-plan checkbox or acceptance-matrix item passed. Source changes should trigger reinspection; real runtime and security acceptance remains separate work.
