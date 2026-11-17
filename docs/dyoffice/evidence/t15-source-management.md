# T15 scoped source management — 2026-11-17

Status: implemented and locally verified for HTTP JSON and PostgreSQL. MySQL/StarRocks protocol adapters are present, but no customer MySQL/StarRocks instance or SQL TLS connection has been accepted. Do not treat this as complete customer connector or production acceptance.

## Reference and architecture

The local `smart_reporting/management/data_sources` implementation was reviewed read-only. DyOffice adopts its draft/published split, optimistic expected-version checks, versioned credentials and public-configuration hashes. It uses the existing TypeScript account/owner transaction boundary and FORCE RLS rather than importing the Python management stack.

- `/api/v1/sources`: scoped list/create/detail/CAS update/publish/test/query/delete.
- Only published source versions are queryable. Test-connection operates on the saved draft.
- Credentials are encrypted with AES-256-GCM and AAD binding deployment, owner, source, credential reference and revision. Omitted credentials are retained, null clears a draft, and a new string appends a credential version. Responses never include a DSN, key or encrypted secret.
- No target database users are created or granted privileges by an application migration. Administrators explicitly provision the least-privilege source account.
- Exact egress targets pin endpoint, resolved IP and SQL user/database. DNS and every redirect are checked; metadata addresses remain prohibited. A private address is not globally allowed because another source uses it.
- SQL executes a closed SELECT AST surface through a pinned transport, verifies the target account's read-only authority and enforces time, row, wire-byte and evidence limits. Unknown grant output or unsupported syntax fails closed.
- The Home account menu opens the data-source panel. It separates saved drafts from published revisions, retains non-secret edits on errors/conflicts, clears submitted credentials, fences unknown writes across modal remounts and requires explicit adoption after comparing the latest server version. Query results show provenance, units, timezone and truncation.

## Large result behavior

Default 1,000 rows, configurable up to 10,000. SQL fetches at most the requested row count plus one to detect truncation. HTTP payloads and final evidence are bounded at 1,000,000 bytes; exceeding the byte limit fails, rather than returning an unmarked partial response. SQL wire reads have a separate bounded transport limit before driver parsing. The panel displays at most 100 snapshot rows.

There is no background full-result export, workspace artifact or persistent result cache. The returned QuerySnapshot contains a deterministic hash; the audit stores source version, returned row count, truncation and hash, not full result rows. Source configuration persistence is separate from result persistence. A truncated preview must never be described as a full exported dataset.

## Executed checks

- Initial source integration RED: 0/7 before implementation.
- Source + lifecycle + RLS + old-entry denial + T12 upgrade: 22/22 passed.
- Integrated source + lifecycle repeat: 10/10 passed with real PostgreSQL.
- Source/network/pinned/provider checks: 58 passed, 0 failed, 1 environment skip (`::1` socket routing unavailable). IPv6 normalization and metadata-denial unit cases passed; the skip is not counted as acceptance.
- Management UI behavior: 6/6 passed, covering credential omission/clear, 409/503 draft retention, unknown-write adoption and frozen result metadata.
- Integrated Web regression: 345 passed, 0 failed, 1 existing optional skip.
- Shell/server type checks and local-shell bundle build passed.

Tests are in `apps/web/test/local-integration/{data-sources,source-lifecycle}.test.mjs`, `test/unit/source-*.test.mjs`, `test/unit/pinned-json.test.mjs` and `test/shell/sources-panel.test.ts`. They use disposable databases/roles and loopback test endpoints. Customer source credentials are not used.

## Remaining acceptance

1. Real MySQL/StarRocks server and customer grant-output compatibility, including real SQL TLS.
2. Visible browser validation. The official browser backend rejected the workspace (`Request workspace is not owned by this CLI`); DOM/unit tests and bundle builds do not replace this gate.
3. Production release/deployment admission remains outside the local runtime.
4. Full-result export to a workspace file is not implemented or claimed.
