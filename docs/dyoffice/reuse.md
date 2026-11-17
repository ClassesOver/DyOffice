# Maximize reuse of DyOffice in DyOffice Web

## User-confirmed direction

Modify the cloned DyOffice repository directly into DyOffice Web. Maximize reuse of DyOffice's functionality, implementation and tests within the supported DOCX, XLSX, PPTX and PDF scope. This includes its native editors, assistant UI, agent execution loop, document tools, skills, model-provider integrations, preferences and file lifecycle.

sm PR #245 is a design and browser-adaptation reference. It is not the primary implementation to transplant. The previously proposed Python/FastAPI/Agno replacement architecture was an assistant proposal, not a user requirement, and is superseded by this direction. Do not replace DyOffice's assistant loop with Agno merely because sm uses it.

Inspected baselines:

- DyOffice: `19a389b39be75f611ec21dcda4a7b91a658239d2`.
- ClassesOver/sm PR #245: `beeb717b31e2201cc1e541c54b2f750f606d99e2`.

## Primary reuse map

| Capability | DyOffice source | Web adaptation |
| --- | --- | --- |
| Native editors | `apps/docs`, `apps/sheets`, `apps/slides`, `apps/pdf` | Preserve renderer features and document operations; adapt preload/main-process interfaces |
| Native engines | Existing `packages/` engines and XLSX native support | Preserve existing parser/writer semantics; execute browser-compatible code in the browser and required native/server operations behind authorized APIs |
| Assistant panels and document tools | The four editors' `src/renderer/ai` directories | Retain panels, selection context, navigation, editing tools, guides and edit queues |
| Assistant execution | `packages/agent-core` | Retain existing execution semantics and tool contracts; adapt Electron-specific transport and streaming boundaries |
| Models and supporting services | `packages/ai-provider`, `packages/ai-search` | Reuse provider implementations; administer global settings and credentials on the server |
| Workspace and settings | `apps/shell`, `packages/project-store`, `packages/ui` | Reuse applicable components and behavior; adapt file storage, navigation and persistence to the Web |
| Skills and prompts | Existing `skills/` and app/package guide assets | Retain supported document workflows; adapt desktop-only instructions to available Web capabilities |
| MCP | Existing applicable DyOffice MCP/tool capabilities | HTTP-only transport; inspect existing contracts before adding new implementations |

## Constraints retained

- Product file support is DOCX, XLSX, PPTX and PDF only. Exclude standalone Markdown/HTML editor entry points and unsupported document formats; retain internal dependencies needed by the four supported formats.
- Personal workspaces only; no team/member management or team permission UI.
- Authentication is first-party username/password with Admin-managed accounts, secure server sessions and per-user workspaces. Do not add OIDC/Keycloak/SSO to the implementation plan; external Harness integrations use independent scoped HTTP API Tokens. See [local-account-auth.md](local-account-auth.md).
- Retain personal preferences. Move models, service credentials and global defaults into Admin; keep secrets server-side.
- Retain data-source management. For capabilities missing from DyOffice, selectively reuse sm's existing adapters after inspecting dependencies and tests, without importing its whole reporting/team architecture.
- Preserve DyOffice licenses and provenance. Record source revisions for any code adopted from sm.
- Existing upstream or sm acceptance is not acceptance of the new Web host. Verify actual browser behavior and native-file round trips after adaptation.
- Current `apps/web` scaffolding is preliminary. Reconcile it with DyOffice contracts rather than expanding duplicate editors, provider implementations or agent loops.

## Next implementation steps

1. Inventory each supported editor's preload/main-process dependencies and identify shared browser-host interfaces.
2. Reuse DyOffice renderers and implement file open/save, settings and event transport adapters.
3. Connect existing agent-core and providers through server-owned Admin credentials, preserving document tool execution and streaming behavior.
4. Add personal data-source integration and HTTP MCP using existing applicable capabilities.
5. Verify four-format editing, save/download, assistant reads/edits, preferences and Admin boundaries with upstream regression tests plus Web integration checks.

This document records architecture direction, not completed integration.

## Global Admin settings (user-confirmed)

All global service configuration belongs to Admin, following sm PR #245's personal/admin separation. DyOffice remains the implementation authority for provider catalogs and behavior; do not reduce its catalog to sm's older supported subset.

Admin groups:

- AI models: providers, custom endpoints, model catalog/availability, global default models, credentials and connection checks.
- Media: image generation, image analysis and video analysis; reuse DyOffice's distinct capability provider selections and shared per-provider keys/base URLs.
- Search: web/image search providers and credentials; global file-search reranking services, model/endpoint settings and enablement where the DyOffice capability is adapted to the Web.
- Integrations: HTTP-only MCP service configuration and authentication; global integration availability switches. Data-source management remains in scope; this does not introduce team grants.
- Global defaults and capability switches: control availability consistently across all four editors and their assistants.

Personal settings retain theme, language, author/document preferences, autosave preferences, assistant appearance/position and personal skill choices. Model selection in a document can choose only Admin-enabled models; it cannot modify global providers, credentials or service defaults.

Implementation requirements:

- Reuse DyOffice `AiSettings`, `AiMediaSettings`, `AiSearchSettings`, provider metadata and applicable SettingsModal sections. Introduce separate secret-free browser DTOs rather than sending the server's full settings object to renderer code.
- Store provider secrets encrypted on the server; GET responses expose configured status, not secret values. Preserve existing keys when an edit omits a replacement.
- Enforce Admin access on APIs as well as navigation. Personal preference writes cannot change global settings.
- Use revision-aware saves to prevent lost updates. Preserve drafts on errors, freeze relevant controls during save/test, and discard stale responses after logout/session changes, following sm's tested behavior.
- Provider calls resolve the authoritative global configuration server-side. Disabled capabilities must not fall back silently to an alternate provider or desktop credential source.
- Reference sm `docs/pr245-personal-admin-settings.md`, `smart_reporting/office/provider_catalog.py`, `provider_settings.py`, `settings.py`, and frontend `office-provider-settings.ts`/`office-admin.ts` for management boundaries and regression scenarios. Reuse applicable management logic without replacing DyOffice's agent or provider runtime.

These are confirmed requirements and integration rules. The initial Web scaffold currently implements only basic model and HTTP MCP configuration; media/search Admin integration remains to be implemented.
