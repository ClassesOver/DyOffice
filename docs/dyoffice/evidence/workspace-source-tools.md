# Personal workspace source tools — 2026-11-17

## Scope and implementation

A source is accessed through the authenticated personal workspace, not a model-provided user/workspace. The current schema has one personal workspace per deployment/owner. This increment reuses that ownership boundary; it does not introduce organization-wide shared source grants or claim an administrator assignment UI.

Model-facing reusable skill: `@dyoffice/browser-host/source-skill` (`createWorkspaceSourceSkill`). Its provider-compatible names map to the internal dot-names below. It can be composed into the existing AgentSkill loop through the session-fenced request adapter. No model API credentials or database DSNs are present in tool arguments or results. Exporting the skill does not by itself enable it in every production assistant entry; trusted assistant composition must explicitly include it.

| Internal tool | Model name | Behavior |
| --- | --- | --- |
| `sources.list` | `sources_list` | Lists only enabled, published sources in the authenticated personal workspace. |
| `sources.describe` | `sources_describe` | Reads bounded published-source extraction metadata or SQL table/column metadata through the same egress/read-only boundary. |
| `sources.query` | `sources_query` | Executes the authorized bounded query once, captures its frozen result and returns resultId + at most 100 preview rows. |
| `sources.save_result` | `sources_save_result` | Saves a captured result into the same workspace; exact commandId/resultId/name retries return the original artifact. |
| `sources.read_result` | `sources_read_result` | Reads a page from the captured result, default 1,000 rows; never re-executes the query. |

Trusted server composition can obtain the facade via `onSourceToolsReady`. HTTP endpoints are `/api/v1/workspace/source-tools`, `/source-tools/execute`, `/data-results`, `/data-results/:id` and `/data-results/:id/content`, all beneath `/api/v1/workspace`. Mutations require cookie session + same-origin CSRF; reads require the live authenticated owner. Tool bodies cannot select an owner/workspace, supply credentials, provide forged result rows or request arbitrary filesystem paths.

## Workspaces and storage

The Home account menu contains **工作区数据结果**. The data-source panel can execute a query and explicitly save that frozen result. Saved datasets are distinct from Office files; they do not masquerade as DOCX/XLSX/PPTX/PDF, and are not inserted into T05 `files` with a false format.

This bounded implementation stores canonical, typed QuerySnapshot JSON in PostgreSQL JSONB with FORCE RLS and workspace/owner/source-version foreign keys. It is not a Rust data engine or full-result object-storage spooling implementation. The original row order, column schema/types, units, timezone, source version, hash and truncation flag are retained. Download returns canonical JSON as an attachment; formula-like strings remain literal JSON data. A result hash identifies evidence, not permission or completeness.

- Default source query limit: 1,000 rows; configured upper bound: 10,000.
- Single captured snapshot: at most 1,000,000 UTF-8 canonical bytes.
- Pending: bound to the originating login session, TTL 15 minutes, at most 8 results / 8 MiB per workspace.
- Saved: at most 64 results / 64 MiB of canonical logical result bytes per workspace.
- These independent logical limits are not charged as T05 physical object bytes. PostgreSQL tuple/WAL/backup overhead is additional; the logical quota is not a physical disk-capacity guarantee.
- Capture/save share a workspace transaction lock, so concurrent sessions cannot exceed count or byte limits. Cleanup removes at most 16 expired pending rows per capture and never removes saved evidence.
- Saved results are immutable and have one permanent save command receipt each. A different command for an already-saved result conflicts; exact retry does not create a second artifact. No rename/delete UI is implemented in this increment.

Source disable/deletion blocks reading or saving pending evidence. An explicitly saved personal materialization remains the owner's workspace data after its source is disabled/logically deleted; every access still needs a live owner session. Revoking the login session blocks subsequent reads. Removing source access cannot retroactively erase data already exported or explicitly materialized; deletion/retention policy is a separate deliberate operation.

Paging operates over a frozen captured result; offsets do not re-run SQL and therefore cannot skip/repeat because the source changes. It pages only the captured bounded rows. When `sourceTruncated=true`, later pages or saving do not recover rows omitted by the source limit. Full-result streaming/spooling, asynchronous whole-dataset exports and results larger than these limits are not implemented or claimed.

## Verification

- Real PostgreSQL source + lifecycle + result service + tool endpoints: **34/34 passed**, no skips.
- That set includes result service **9/9** and complete tool endpoint cases **12/12**: owner/session binding, same source/command names in different owners, Bob/Admin guessing, anonymous/CSRF rejection, owner/workspace/credential injection, save retries, row paging, download/hash preservation, source disable/deletion and exactly one external HTTP query.
- Real PostgreSQL `sources.describe` table/column case passed through the low-privilege SQL channel.
- Reusable assistant skill: **4/4** passed, including provider-safe names, private argument rejection, cancellation and uncertain-save reporting with no automatic write replay.
- Source panel + saved-results UI: **9/9** passed, including identical receipt intent after a lost save response and frozen-result pagination.
- Web top-level: **345 passed, 0 failed, 1 existing optional skip**.
- Browser/server/shell type checks passed; boundary scan **1299 files / 0 violations**; local-shell bundle build passed.

An initial tools test tried to SELECT the append-only audit table using the business role and was correctly denied. The test observer was changed to the isolated fixture's scoped migration-owner connection; application audit permissions were not broadened.

## Customer StarRocks gate

The user-authorized customer endpoint was attempted on 2026-11-17. Connection timed out before database authentication; a separate TCP check also timed out after five seconds. The active route used the existing VPN interface. No route, firewall, account, grants or customer data were modified; no SQL ran and no credential verdict is inferred from this timeout. Credentials were excluded from repository files and this evidence. Customer StarRocks protocol/TLS/read-only grant acceptance remains network-blocked.

## Remaining boundaries

Official visible browser control is blocked by the host workspace ownership check; component/protocol tests do not replace that gate. The repository local runtime remains non-production. Exact numeric values unsupported by the current number-based snapshot DTO are rejected instead of silently rounded; a wider decimal/bigint schema is not claimed. PandasAI, autonomous model analysis, T16 retrieval/report generation and a Rust-first multi-database query engine are not added by this increment.
