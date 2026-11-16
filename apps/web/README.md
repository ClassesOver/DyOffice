# dyoffice Web

This is the Web adaptation inside the cloned GenOffice repository, based on upstream `19a389b39be75f611ec21dcda4a7b91a658239d2`. UI and browser integration reference: ClassesOver/sm PR #245 (`beeb717b31e2201cc1e541c54b2f750f606d99e2`). Upstream engines and license notices remain in place.

## Run

Requires Node 22.12+. From the repository root:

```sh
npm ci --ignore-scripts
# Export distinct DYOFFICE_USER_TOKEN and DYOFFICE_ADMIN_TOKEN values,
# plus a persistent DYOFFICE_ENCRYPTION_KEY (see .env.example).
npm run dev:web
```

DOCX editing loads `@genoffice/docx-engine` in the server process, so the Web app needs this repository install rather than an `apps/web`-only install. `npm run dev:web` starts Node with `tsx` and does not launch Electron. An `apps/web`-only install can still serve the older shell, but opening a DOCX editor will fail until the workspace packages are installed.

Open `http://127.0.0.1:3080` for the personal workspace and `/admin` for administration. Use the corresponding access token. Configuration is read from environment variables; `.env.example` is a template and is not loaded automatically. Persist the data directory and encryption key together.

## Current implementation

- Personal DOCX open/edit/save. The page edits plain paragraph, heading, and list text. Saves call GenOffice `docx-engine` so unchanged paragraphs, tables, pictures, styles, and headers stay in the original OOXML package. Complex paragraphs (tabs, fields, revisions, content controls) are shown and preserved, not rewritten as plain text.
- Document revisions: a save names the base revision, lease epoch, and idempotency key. The server writes the bytes to the local immutable object store, then commits the base revision, lease, idempotency record, and outbox entry in one in-process journal transaction. A stale base or lease returns 409 and keeps the draft. Repeating the same save returns the original revision. Restoring an older revision creates a new head. The journal is single-process and is the development stand-in for the PostgreSQL transaction in `server/db/migrations/0004_revisions.sql`. The Web process does not open PostgreSQL to commit revisions, and the journal does not enforce row-level security.
- Personal file import/download restricted to DOCX, XLSX, PPTX and PDF. Only DOCX is editable.
- Personal theme, language, author, autosave and assistant preferences.
- HTTP data-source configuration with encrypted credentials.
- Admin-only model endpoint/key configuration and enabled-model catalog.
- Admin-only Streamable HTTP MCP configuration and real connection/tool discovery using the official MCP SDK. No stdio subprocess transport.
- Separate personal/admin bearer tokens. The admin token manages configuration, but cannot read or modify personal files, preferences or data sources. Secrets encrypted with AES-256-GCM and omitted from read responses.

The development token server refuses startup when `NODE_ENV=production`, before reading or creating its data directory. Local username/password accounts, admin user management, and PostgreSQL sessions are implemented behind `buildApp({ localAuth })`. See `docs/dyoffice/evidence/t03-closeout.md`. The default process does not open that database, and file routes still use the development token until T04. OIDC/Keycloak/SSO stay out of scope. Global model and service settings stay in Admin. Personal files stay on the owning account.

## Remaining implementation

T03 local accounts are complete for identity and sessions. The checklist is in `docs/dyoffice/evidence/t03-closeout.md`. `buildApp({ localAuth })` serves login, logout, `me`, reauth, password change, activation/reset, personal session revoke, and admin user create/list/disable/role/reset. The default `dev:web` process still uses the development bearer tokens and still refuses `NODE_ENV=production`. Replacing those tokens on file routes waits for T04 row-level security. External API tokens wait for T19. A full breached-password corpus and host Argon2 benchmarks wait for operations.

T05 object storage is complete for this repository. Personal objects can be staged, finished, downloaded, trashed, restored, and purged. The server checks SHA-256, enforces quota, expires abandoned uploads, and keeps a file row only after the object exists. An in-process client covers those rules in `npm run test:web`. A MinIO job, [dyoffice-t05-s3.yml](../../.github/workflows/dyoffice-t05-s3.yml), runs the same lifecycle against S3 when `DYOFFICE_S3_ENDPOINT` is set; the test skips when it is not. Row-level security remains T04. Multi-node highly available storage remains an operations concern. The older `/api/files` directory is the development-token prototype, not this store.

A PDF capability gate reports page order, text versus scanned versus blank pages, unembedded fonts, and unverified signatures. It refuses annotation, text edit, page reorder, redaction, cover-text-as-deletion, and trusting a signature. Password-marked files are not readable. Browser PDF editing, PDFium, and WASM are not mounted. See `docs/dyoffice/evidence/t11-pdf-capabilities.md`.

T06 save transactions, revision history, and single-writer leases are complete for this development server. The done and deferred checklist is in `docs/dyoffice/evidence/t06-revision-commit.md`. `mountDocsEditor` now opens a DOCX, edits a paragraph, undoes that local change, and saves through the host; see `docs/dyoffice/evidence/t07-docs-browser-mount.md`. Mount the GenOffice Docs renderer (ribbon, pagination, comments, tracked changes, and selection) on this DOCX host instead of that surface. Then adapt the other formats the same way, reusing each native editor and keeping non-browser work behind authorized APIs. Model chat/tool execution, database connectors and query integration, source edit/delete/test UI, file folders/favorites/recent views, and deployment hardening are still open. Autosave uses the saved preference; the assistant preference is stored and not yet shown.

Run `npm run test:web` for HTTP access-boundary and persistence tests. Runtime dependencies are scoped to this app so starting the Web server does not install or launch Electron.

## Local password account bootstrap (T03a; CLI only)

The repository now includes a PostgreSQL migration runner, an Argon2id password
hasher and a **trusted-operator-only** one-time administrator bootstrap CLI.
This CLI is the only bootstrap path. Browser login is the local-auth route
set, not this command. Per-user file RLS remains T04.

Use the locked Web dependencies and an already provisioned PostgreSQL 16+
database. Supply a dedicated *migration* role through `DYOFFICE_DATABASE_URL`
and an explicit deployment UUID. Do not use the migration role for regular app
traffic. Run the command from the repository root:

```sh
npm ci --prefix apps/web --workspaces=false --include=dev
DYOFFICE_DATABASE_URL='postgresql://MIGRATION_USER@db-host/dbname' \
  node apps/web/tools/bootstrap-admin.mjs \
  --deployment-id 'REPLACE-WITH-DEPLOYMENT-UUID' \
  --username admin.local
```

The CLI prompts for the password twice in a TTY without echoing it, runs the
identity migrations transactionally, and creates the initial administrator,
role and personal workspace in a single transaction. It refuses a second
bootstrap in that deployment. For controlled non-interactive installation
only, `--password-stdin` reads one line from a pipe; **never** supply passwords
through argv, environment variables, shell history or logs. There is no
HTTP bootstrap endpoint or default admin password.

Run the identity tests using the dedicated [identity schema CI workflow](../../.github/workflows/dyoffice-identity-schema.yml).
This validates the actual native Argon2id module, PostgreSQL migrations,
concurrent initializations and CLI. Do not point the default development
server at this account store until T04 isolates personal files.

## Web-only build baseline (T00)

Install without the root Electron postinstall:

```sh
npm ci --prefix apps/web --workspaces=false --ignore-scripts --include=dev
npm run typecheck:web
npm run build:web
npm run test:web:build
```

The pinned Vite build emits `apps/web/dist/index.html`, `admin.html`, hashed browser
assets and a manifest. The smoke test builds into a disposable directory, serves
that output through the API server over HTTP, and checks both pages, every
referenced JS/CSS asset, and same-origin API authorization.
No Electron application or native engine is built or started.

This is a build baseline for the existing personal/Admin prototype, not the
four-format editor integration. `start:web` defaults to the source `public/`
interface. For local same-origin build/API verification, first run `build:web`,
then start with `DYOFFICE_ASSET_MODE=built npm run start:web` and the development
credentials described above. Built mode serves only the two HTML entries and
manifest-listed assets, fails startup if the build is absent/incomplete, and does
not expose the manifest, source files, or arbitrary files. GET and HEAD are the
only static methods. Source mode and built mode both retain API authorization.
`NODE_ENV=production` still refuses startup: this seam does not make the temporary
shared-token server production-ready. T04 resource isolation remains required
before production deployment. Type checking currently
covers BrowserHost and Web contracts, not the legacy JavaScript prototype or all
upstream renderer packages. HTTP smoke checks do not replace real browser UI or
native document round-trip acceptance.

### Prototype storage and concurrency boundary

Run exactly one server process/application instance per data directory. The JSON store's queue protects only that instance; starting another instance on the same directory is unsupported and can overwrite metadata, even when both uploads return success. Do not use clustered workers, multiple replicas or rolling overlap with a shared prototype directory. There is currently no inter-process ownership lock.

Admin updates apply supplied sections against the latest state inside the instance queue; omitted sections and omitted keys are preserved. Concurrent updates to the same section remain last-writer-wins, not revision-checked. This is not PostgreSQL CAS for settings (T12) or row-level security (T04). DOCX saves publish a revision only after the immutable object is stored and the in-process journal accepts the base revision, lease epoch, and idempotency key. That journal is local to one server process. A crash after the object write and before the journal publish leaves an unreferenced object and no new revision; retry the same idempotency key. A crash after the journal publish and before the legacy current-file copy can be repaired by repeating that same request. Do not run two processes on one data directory.

### T02 请求与错误迁移接缝

每个请求由服务端生成独立 `X-Request-ID`，不信任或回显客户端同名请求头。JSON 错误响应保持原有 HTTP 状态码、`application/json` 和 `error` 文案，增量提供 `type: about:blank`、`title`、`status`、`detail`、`requestId`；成功响应正文不变。错误中不包含请求 URL、查询参数或内部异常详情，500 继续返回通用文案。

`dev:web` and `start:web` boot Fastify through `buildApp`. Preferences, admin configuration, data sources, files, DOCX editing, and static pages are registered as modules on that shell. Health probes use static schemas. Business bodies keep the existing module validators. The process rate limit and shutdown cover one process. `NODE_ENV=production` still refuses startup. This is not local-account login or resource isolation.


## Original GenOffice shell entry

Build first (`npm run build:web`), then `npm run start:web`. The start command now
selects built assets by default. The workspace directly imports the original
`apps/shell` AppFrame, Home, TabBar, locale, FileBadge assets, home/tabbar CSS and
shared UI tokens. Desktop defaults are unchanged; optional Home and AppFrame slots
provide the Web account area and DOM editor container instead of WebContentsView.

This checkpoint restores the **entry shell**, not all four editor ribbons. The
already-merged DOCX paragraph editor remains in a retained iframe; XLSX/PPTX/PDF
native renderer migrations remain separate. Import, file listing and preferences
use the existing authenticated Web API. New DOCX/XLSX/PPTX files use the original
GenOffice blank templates. PDF creation and the desktop Ask entry are disabled.
Stars are explicitly page-session-only until a persistent starred API exists.
Unavailable desktop operations report unsupported rather than pretend to succeed.
Admin retains a separate token and route; no Genspark account flow is invoked.

Switching Home/document tabs retains each iframe. Closing tabs or exiting checks
the child editor's dirty/saving/unknown state. Legacy sidebar, return and logout
also check it; refresh uses beforeunload. Pending auto-save timers are disposed on
confirmed discard, and stale saves do not redraw a newer screen.

Verification: `test:shell` mounts the actual components in jsdom (not visual proof),
`typecheck:shell` checks their real sources, and the `DyOffice original shell UI`
workflow runs Chromium against real APIs, verifies import/open/tab return/theme/
Admin separation and canceled dirty navigation, then uploads screenshots/traces.
Local Chromium launch is blocked by this executor's socket restriction; visual
acceptance must wait for that workflow, not be inferred from jsdom or Vite.

PR #24 follow-up adds a conservative plain-table-cell projection and a partial Web desktop bridge. New-document, Save As and explicit-target saves reject `UNSUPPORTED` because the bridge has no create/copy/overwrite-policy host operation. Tables containing multiple runs, paragraph identities, bookmarks, tracked changes or other unsupported paragraph structure remain read-only. Unchanged cells retain their original XML bytes. This does not mount the original Docs ribbon.
