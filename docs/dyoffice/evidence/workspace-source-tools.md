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

The initial user-authorized customer attempt timed out before authentication over the existing VPN route. A later recheck on 2026-11-17 succeeded after the host route changed independently: StarRocks 3.5.7, database rj, bounded metadata and a one-row customer read were verified. No route/firewall/account/grant changes were executed. The supplied login inherits root and is now correctly refused by the repaired native grant decoder with 403 READONLY_ROLE_REQUIRED; the server also does not support TLS negotiation. Successful product access with a dedicated least-privilege account and secure transport remains open. See [customer recheck evidence](starrocks-customer-acceptance.md).

## Remaining boundaries

Official visible browser control is blocked by the host workspace ownership check; component/protocol tests do not replace that gate. The repository local runtime remains non-production. Exact numeric values unsupported by the current number-based snapshot DTO are rejected instead of silently rounded; a wider decimal/bigint schema is not claimed. PandasAI, autonomous model analysis, T16 retrieval/report generation and a Rust-first multi-database query engine are not added by this increment.

## Target-branch integration and session fencing

This integration preserves the target branch's migrations 1–24 byte-for-byte
(including user skills and personal provider budgets). Source, connector-kind,
realtime and workspace-result additions are appended as 25–28. Existing databases
with #132's earlier divergent 23–26 history are **not automatically upgradeable**:
the migration runner rejects the checksum mismatch without editing the ledger.
Inspect the actual deployment history before rollout; no deployed upgrade is
certified by fresh-database tests, and operators must not rewrite migration digests.

Sources and frozen-result clients are created from the same session-bound request
as workspace identity. Cookie replacement in another tab cannot refresh their
CSRF proof into the new account. Session rotation remounts both panels, and stale
responses cannot repopulate the replacement panel. JSON downloads pass through
the bound request and a mounted-view check before creating a short-lived blob URL;
no direct cookie-only download link remains. Canonical server JSON round-trips
without changing its serialized bytes in the recorded integration test.

The heartbeat integration test now registers its ping observer before awaiting
the first database-backed state frame. Its assertions still require exactly two
pings and actual disconnection; this fixes a test observer race, not the protocol.

The customer StarRocks acceptance gap remains: the recorded login inherited root
and was correctly denied; the endpoint rejected TLS. A dedicated least-privilege
identity and an approved transport configuration are still required. These changes
and repository integration do not establish successful customer end-to-end use,
production capacity, browser/desktop acceptance, or real target-host isolation.
