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
- In-process document revisions: a save names the base revision, lease epoch, and idempotency key. A stale base or lease returns 409 and keeps the draft. Repeating the same save returns the original revision. The previous bytes stay available at the old revision URL. This queue is single-process JSON state, not PostgreSQL CAS.
- Personal file import/download restricted to DOCX, XLSX, PPTX and PDF. Only DOCX is editable.
- Personal theme, language, author, autosave and assistant preferences.
- HTTP data-source configuration with encrypted credentials.
- Admin-only model endpoint/key configuration and enabled-model catalog.
- Admin-only Streamable HTTP MCP configuration and real connection/tool discovery using the official MCP SDK. No stdio subprocess transport.
- Separate personal/admin bearer tokens. The admin token manages configuration, but cannot read or modify personal files, preferences or data sources. Secrets encrypted with AES-256-GCM and omitted from read responses.

The development token server refuses startup when `NODE_ENV=production`, before reading or creating its data directory. This guard is not production account authentication or multi-user resource isolation. Production will use **local username/password authentication**, Admin-managed accounts, PostgreSQL-backed server sessions and personal resource ownership. OIDC/Keycloak/SSO are explicitly out of scope. See `docs/dyoffice/local-account-auth.md`. These features are **not implemented yet**.

## Remaining implementation

Mount the GenOffice Docs renderer (ribbon, pagination, comments, tracked changes, and selection) on this DOCX host instead of the paragraph surface. Then adapt XLSX, PPTX, and PDF the same way, reusing each native editor and keeping non-browser work behind authorized APIs. Model chat/tool execution, database connectors and query integration, source edit/delete/test UI, file folders/favorites/recent views, multi-user login, and deployment hardening are still open. Autosave uses the saved preference; the assistant preference is stored and not yet shown. The revision check above is the single-process bridge, not T06's PostgreSQL transaction.

Run `npm run test:web` for HTTP access-boundary and persistence tests. Runtime dependencies are scoped to this app so starting the Web server does not install or launch Electron.

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
shared-token server production-ready. T02 API migration and T03 identity remain
required before production deployment. Type checking currently
covers BrowserHost and Web contracts, not the legacy JavaScript prototype or all
upstream renderer packages. HTTP smoke checks do not replace real browser UI or
native document round-trip acceptance.

### Prototype storage and concurrency boundary

Run exactly one server process/application instance per data directory. The JSON store's queue protects only that instance; starting another instance on the same directory is unsupported and can overwrite metadata, even when both uploads return success. Do not use clustered workers, multiple replicas or rolling overlap with a shared prototype directory. There is currently no inter-process ownership lock.

Admin updates apply supplied sections against the latest state inside the instance queue; omitted sections and omitted keys are preserved. Concurrent updates to the same section remain last-writer-wins, not revision-checked. This is not the planned PostgreSQL CAS, document revision, lease, or idempotency implementation (T04/T06/T12). DOCX saves replace the current bytes only after the base revision and lease match, and they archive the previous bytes. That check is local to one server process. It is not a multi-replica transaction, and a crash between the file rename and the JSON write can still leave the archive and the current bytes ahead of the idempotency record. Re-open the document before saving again in that case.

### T02 请求与错误迁移接缝

每个请求由服务端生成独立 `X-Request-ID`，不信任或回显客户端同名请求头。JSON 错误响应保持原有 HTTP 状态码、`application/json` 和 `error` 文案，增量提供 `type: about:blank`、`title`、`status`、`detail`、`requestId`；成功响应正文不变。错误中不包含请求 URL、查询参数或内部异常详情，500 继续返回通用文案。

此接缝不代表 T02 完成：Fastify 模块化、完整 `/api/v1` 迁移（当前仅有只读文件桥接）、限流、ready/live 和优雅关闭仍待实施；未实现 T03 本地账号密码/服务端会话撤销，不能用它宣称正式登录或退出能力。
