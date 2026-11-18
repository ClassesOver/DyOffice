# dyoffice Web

This is the Web adaptation inside the cloned DyOffice repository, based on upstream `19a389b39be75f611ec21dcda4a7b91a658239d2`. UI and browser integration reference: ClassesOver/sm PR #245 (`beeb717b31e2201cc1e541c54b2f750f606d99e2`). Upstream engines and license notices remain in place.

The first sections describe the default development-token runtime and its modular account services. The separate PostgreSQL local-account experimental runtime is documented in T03–T08 below; its native DOCX entry uses Cookie sessions and does not read prototype JSON state. Both runtime paths reject production startup.

## Runtime and database boundaries

| Entry | Data and migrations | Administrator bootstrap |
| --- | --- | --- |
| Default `DYOFFICE_AUTH_MODE=development`: `server/src/app.mjs`, development bearer tokens | JSON workspace and single-process revision journal. Optional `buildApp({ localAuth })` services use a separate modular account database: `server/db/migrations/0001`–`0008`, `dyoffice_*` tables, `dyoffice_schema_migrations` journal. The default process does not connect to that database. | `node apps/web/tools/bootstrap-admin.mjs --deployment-id UUID --username LOGIN`, or the `apps/web` package's `bootstrap:admin` script; see the CLI section below. |
| Explicit `DYOFFICE_AUTH_MODE=local`: `server/src/app.ts` → `buildLocalApp` | Dedicated PostgreSQL 17 database: `server/src/db/migrations/0001`–`0012`, unprefixed application tables and `identity_migrations` journal. Separate migration owner, auth, business and optional worker logins. | From the repository root: `npm run provision:runtime`, then interactive `npm run bootstrap:admin` (`tools/dyoffice/bootstrap-admin.ts`), with `DYOFFICE_DEPLOYMENT_ID` set. |

Use different databases for these two account implementations. Each bootstrap command accepts a migration connection through `DYOFFICE_DATABASE_URL`, but initializes only its own schema; it does not import accounts, sessions, revisions or migration history from the other implementation. Local role provisioning revokes database-wide PUBLIC CREATE/TEMP privileges, so it must not target the modular account database or a shared business database. The local runtime's auth/business/worker connections must, in turn, refer to the same dedicated local database and schema.

Keep both migration directories and their existing version numbers and checksums unchanged. Do not combine manifests, renumber applied migrations, remove journal rows, or reuse one journal as an upgrade path for the other. A deployment using an earlier divergent history requires an explicit upgrade plan; these commands do not silently translate it. Both Web entries reject `NODE_ENV=production`. Neither development tokens nor the optional modular auth services grant access to the local runtime's RLS resources.

## Run the original prototype

Use Node 22.x, version 22.12 or newer. From the repository root:

```sh
npm ci --ignore-scripts
# Export distinct DYOFFICE_USER_TOKEN and DYOFFICE_ADMIN_TOKEN values,
# plus a persistent DYOFFICE_ENCRYPTION_KEY (see .env.example).
npm run build:web
npm run dev:web
```

DOCX editing loads `@genoffice/docx-engine` in the server process, so the Web app needs this repository install rather than an `apps/web`-only install. `npm run dev:web` starts Node with `tsx` and does not launch Electron. An `apps/web`-only install can still serve the older shell, but opening a DOCX editor will fail until the workspace packages are installed.

Open `http://127.0.0.1:3080` for the personal workspace and `/admin` for administration. Use the corresponding access token. Configuration is read from environment variables; `.env.example` is a template and is not loaded automatically. Persist the data directory and encryption key together.

## Current implementation

- Personal DOCX open/edit/save. The page edits plain paragraph, heading, and list text. Saves call DyOffice `docx-engine` so unchanged paragraphs, tables, pictures, styles, and headers stay in the original OOXML package. Complex paragraphs (tabs, fields, revisions, content controls) are shown and preserved, not rewritten as plain text.
- Document revisions: a save names the base revision, lease epoch, and idempotency key. The server writes the bytes to the local immutable object store, then commits the base revision, lease, idempotency record, and outbox entry in one in-process journal transaction. A stale base or lease returns 409 and keeps the draft. Repeating the same save returns the original revision. Restoring an older revision creates a new head. The journal is single-process and is the development stand-in for the PostgreSQL transaction in `server/db/migrations/0004_revisions.sql`. The Web process does not open PostgreSQL to commit revisions, and the journal does not enforce row-level security.
- Personal file import/download restricted to DOCX, XLSX, PPTX and PDF. Only DOCX is editable.
- Personal theme, language, author, autosave and assistant preferences.
- HTTP data-source configuration with encrypted credentials.
- Admin-only model endpoint/key configuration and enabled-model catalog.
- Admin-only Streamable HTTP MCP configuration and real connection/tool discovery using the official MCP SDK. No stdio subprocess transport.
- Separate personal/admin bearer tokens. The admin token manages configuration, but cannot read or modify personal files, preferences or data sources. Secrets encrypted with AES-256-GCM and omitted from read responses.

The development token server refuses startup when `NODE_ENV=production`, before reading or creating its data directory. Local username/password accounts, admin user management, and PostgreSQL sessions are implemented behind `buildApp({ localAuth })`. See `docs/dyoffice/evidence/t03-closeout.md`. The default process does not open that database, and file routes still use the development token until T04. OIDC/Keycloak/SSO stay out of scope. Global model and service settings stay in Admin. Personal files stay on the owning account.

## Remaining implementation

The modular `.mjs` T03 account services implement identity and sessions. The checklist is in `docs/dyoffice/evidence/t03-closeout.md`. `buildApp({ localAuth })` serves login, logout, `me`, reauth, password change, activation/reset, personal session revoke, and admin user create/list/disable/role/reset. The default `dev:web` process still uses the development bearer tokens and still refuses `NODE_ENV=production`. Replacing those tokens on file routes waits for T04 row-level security. External API tokens wait for T19. A full breached-password corpus and host Argon2 benchmarks wait for operations.

The modular runtime implements the T05 object-storage lifecycle described here. Personal objects can be staged, finished, downloaded, trashed, restored, and purged. The server checks SHA-256, enforces quota, expires abandoned uploads, and keeps a file row only after the object exists. An in-process client covers those rules in `npm run test:web`. A MinIO job, [dyoffice-t05-s3.yml](../../.github/workflows/dyoffice-t05-s3.yml), runs the same lifecycle against S3 when `DYOFFICE_S3_ENDPOINT` is set; the test skips when it is not. Row-level security remains T04. Multi-node highly available storage remains an operations concern. The older `/api/files` directory is the development-token prototype, not this store.

A PDF capability gate reports page order, text versus scanned versus blank pages, unembedded fonts, and unverified signatures. It refuses annotation, text edit, page reorder, redaction, cover-text-as-deletion, and trusting a signature. Password-marked files are not readable. PDF tabs mount a read-only PDF.js viewer with same-origin fonts/CMaps and a strict CSP. PDFium is used only by the internal pixel-regression helper, not an exposed rendering API. This is not the original DyOffice PDF editor UI. See `docs/dyoffice/evidence/t11-pdf-capabilities.md` and `docs/dyoffice/evidence/t11-pdf-render.md`.

T06 save transactions, revision history, and single-writer leases are complete for this development server. The done and deferred checklist is in `docs/dyoffice/evidence/t06-revision-commit.md`. `mountDocsEditor` now opens a DOCX, edits a paragraph, undoes that local change, and saves through the host; see `docs/dyoffice/evidence/t07-docs-browser-mount.md`. Mount the DyOffice Docs renderer (ribbon, pagination, comments, tracked changes, and selection) on this DOCX host instead of that surface. Then adapt the other formats the same way, reusing each native editor and keeping non-browser work behind authorized APIs. Model chat/tool execution, database connectors and query integration, source edit/delete/test UI, file folders/favorites/recent views, and deployment hardening are still open. Autosave uses the saved preference; the assistant preference is stored and not yet shown.

Run `npm run test:web` for HTTP access-boundary and persistence tests. Runtime dependencies are scoped to this app so starting the Web server does not install or launch Electron.

## Modular account bootstrap (T03a; CLI only)

The repository now includes a PostgreSQL migration runner, an Argon2id password
hasher and a **trusted-operator-only** one-time administrator bootstrap CLI.
This CLI initializes only the modular `.mjs` account database. The separate
local experimental runtime uses the root TypeScript CLI described below. Browser
login is the optional modular local-auth route set, not this command. Per-user
file RLS remains T04 for these modular services.

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

Install the workspace dependencies needed by the original shell and DOCX engine
without running the root Electron postinstall:

```sh
npm ci --ignore-scripts --include=dev
npm run typecheck:web
npm run build:web
npm run test:web:build
```

The pinned Vite build emits `apps/web/dist/index.html`, `admin.html`, `legacy.html`, hashed browser
assets and a manifest. The smoke test builds into a disposable directory, serves
that output through the API server over HTTP, and checks its pages, every
referenced JS/CSS asset, and same-origin API authorization.
No Electron application or native engine is built or started.

This is a build baseline for the existing personal/Admin prototype, not the
four-format editor integration. `start:web` defaults to built assets. For local
same-origin build/API verification, first run `build:web`, then run `start:web`
with the development credentials described above. Built mode serves only the
configured HTML entries, the retained legacy entry, and
manifest-listed assets, fails startup if the build is absent/incomplete, and does
not expose the manifest, source files, or arbitrary files. GET and HEAD are the
only static methods. Source mode and built mode both retain API authorization.
`NODE_ENV=production` still refuses startup: this seam does not make the temporary
shared-token server production-ready. T04 resource isolation remains required
for that runtime before production deployment. Type checking covers BrowserHost,
Web contracts and the local TypeScript server modules, not the legacy JavaScript prototype or all
upstream renderer packages. HTTP smoke checks do not replace real browser UI or
native document round-trip acceptance.

### Prototype storage and concurrency boundary

Run exactly one server process/application instance per data directory. The JSON store's queue protects only that instance; starting another instance on the same directory is unsupported and can overwrite metadata, even when both uploads return success. Do not use clustered workers, multiple replicas or rolling overlap with a shared prototype directory. There is currently no inter-process ownership lock.

Admin updates apply supplied sections against the latest state inside the instance queue; omitted sections and omitted keys are preserved. Concurrent updates to the same section remain last-writer-wins, not revision-checked. This is not PostgreSQL CAS for settings (T12) or row-level security (T04). DOCX saves publish a revision only after the immutable object is stored and the in-process journal accepts the base revision, lease epoch, and idempotency key. That journal is local to one server process. A crash after the object write and before the journal publish leaves an unreferenced object and no new revision; retry the same idempotency key. A crash after the journal publish and before the legacy current-file copy can be repaired by repeating that same request. Do not run two processes on one data directory.

### T02 请求与错误迁移接缝

每个请求由服务端生成独立 `X-Request-ID`，不信任或回显客户端同名请求头。JSON 错误响应保持原有 HTTP 状态码、`application/json` 和 `error` 文案，增量提供 `type: about:blank`、`title`、`status`、`detail`、`requestId`；成功响应正文不变。错误中不包含请求 URL、查询参数或内部异常详情，500 继续返回通用文案。

By default, `dev:web` and `start:web` boot Fastify through `server/src/app.mjs` → `buildApp`. Preferences, admin configuration, data sources, files, DOCX editing, and static pages are registered as modules on that shell. Health probes use static schemas. Business bodies keep the existing module validators. The process rate limit and shutdown cover one process. `NODE_ENV=production` still refuses startup. This default entry does not enable local-account login or resource isolation. Run `npm run test:web:integration -- test/integration/api-compat.test.mjs` and `npm run test:web:integration -- test/integration/route-cutover.test.mjs` for its HTTP contracts. The separate local runtime suite is `npm run test:web:integration:local`.


## Original DyOffice shell entry

Build first (`npm run build:web`), then `npm run start:web`. The start command now
selects built assets by default. The workspace directly imports the original
`apps/shell` AppFrame, Home, TabBar, locale, FileBadge assets, home/tabbar CSS and
shared UI tokens. Desktop defaults are unchanged; optional Home and AppFrame slots
provide the Web account area and DOM editor container instead of WebContentsView.

This checkpoint restores the **entry shell**, not all four editor ribbons. The
already-merged DOCX paragraph editor remains in a retained iframe; XLSX/PPTX/PDF
native renderer migrations remain separate. Import, file listing and preferences
use the existing authenticated Web API. New DOCX/XLSX/PPTX files use the original
DyOffice blank templates. PDF creation and the desktop Ask entry are disabled.
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
The original shell checkpoint reported a local Chromium socket restriction;
that historical limitation is not a result from this integration. Visual
acceptance requires the browser workflow, not an inference from jsdom or Vite.

PR #24 follow-up adds a conservative plain-table-cell projection and a partial Web desktop bridge. New-document, Save As and explicit-target saves reject `UNSUPPORTED` because the bridge has no create/copy/overwrite-policy host operation. Tables containing multiple runs, paragraph identities, bookmarks, tracked changes or other unsupported paragraph structure remain read-only. Unchanged cells retain their original XML bytes. This does not mount the original Docs ribbon.

## Separate local-account experimental runtime

以下 T03–T08 配置仅适用于 `server/src/app.ts` 的 `buildLocalApp` 和 `DYOFFICE_AUTH_MODE=local`。阶段检查点记录当时的开放项；当前 native Worker 状态以下面的 T08 当前运行方式为准。默认开发 Token 入口不会因此连接 PostgreSQL，模块化 `.mjs` 账号库也不会自动迁移到此入口。

### T03a 本地实验账号基础与初始化

`server/src/modules/auth` 与 `server/src/db` 已提供 PostgreSQL 账号/角色/工作区表、Argon2id 密码验证和并发安全的一次性 Admin 初始化。在仓库根目录执行的 `npm run bootstrap:admin`（`tools/dyoffice/bootstrap-admin.ts`）必须在交互终端运行；显式提供 `DYOFFICE_DATABASE_URL` 与稳定 UUID `DYOFFICE_DEPLOYMENT_ID`，密码在终端隐藏输入并确认，不能放命令参数或密码环境变量。可用 `DYOFFICE_PASSWORD_BLOCKLIST_FILE` 加载部署批准的本地密码阻断语料；内置小列表只是起步，不能代表完整泄露密码覆盖。

账号集成测试需要 `DYOFFICE_TEST_DATABASE_URL` 指向隔离的 `dyoffice_test` 或 `dyoffice_test_*` PostgreSQL 数据库；缺少数据库会失败，不会跳过或换成内存实现。Linux/macOS 的 CLI 终端回归还需要 Python 3 标准库。`npm run test:web:integration:local` 运行账号、PTY、Fastify 和文件事务测试；文件用例还需下文的隔离 S3 测试环境变量。CI 提供独立 PostgreSQL 17 与固定摘要的 S3 兼容测试服务。

T03a 是历史基础检查点；当前 Cookie 会话见下文 T03b，账号登录界面尚未接入，也没有接管旧 JSON 个人数据。开发 Token 启动路径及 production 拒绝保持生效；完整进度与实际证据见 `docs/dyoffice/evidence/t03a-account-bootstrap.md`。


### T03b 本地会话实验入口

`DYOFFICE_AUTH_MODE=local` 启用独立的 PostgreSQL 会话 API。先按下文 T04 配置独立数据库账号，并用 CLI 初始化账号。运行服务时设置 `DYOFFICE_AUTH_DATABASE_URL`、`DYOFFICE_BUSINESS_DATABASE_URL`、`DYOFFICE_DEPLOYMENT_ID`、准确的 `DYOFFICE_ORIGIN` 和至少 32 字节的随机持久化 `DYOFFICE_CSRF_KEY`；取消迁移连接变量和开发用户/Admin Token 后启动。它提供登录挑战、登录/退出、`me`、重新认证、个人会话查询/撤销，未启用文件实验 API 时，个人文件及其他未实现的配置路由返回 501，不访问旧 JSON 数据。网页登录/工作区界面尚待接入，工作区/偏好 RLS 已接入，production 仍拒绝启动。

浏览器流程先 GET `/api/v1/auth/csrf`，保留服务端 HttpOnly Cookie，把返回的 `csrfToken` 放入 `X-CSRF-Token` 后 POST `/api/v1/auth/login`；写请求要求准确的同源 Origin。登录响应只返回用户 DTO 与 CSRF proof，实际会话令牌只在 Secure Cookie。使用与 Origin 对齐的 HTTPS 入口验证浏览器，不以手动传 Cookie 代替验证。

`npm run test:web:e2e` 使用真实 Chromium + TLS + PostgreSQL 检查 Cookie 与退出；先运行 `apps/web/node_modules/.bin/playwright install chromium --with-deps`。安全边界、实测结果；大小写 UUID 清 Cookie 问题已由 T03c 修复见 `docs/dyoffice/evidence/t03b-local-sessions.md`。


### T03c 管理员与密码操作 API

本地实验模式增加 `/api/v1/admin/users` 的查询/开户，以及指定账号的状态、角色、激活重发和密码重置操作。敏感操作需最近 15 分钟内的密码验证与 Origin/CSRF；新账号默认仅个人角色。激活/重置秘密只返回一次、15 分钟过期，POST `/api/v1/auth/password-action` 在匿名挑战后用 JSON 消费，不生成凭据 URL，也不发送邮件。重置签发立即冻结旧密码登录并撤销旧会话；过期后需管理员重发。自己的改密使用 `/api/v1/auth/change-password`，验证旧密码后替换会话 Cookie。

`DYOFFICE_PASSWORD_BLOCKLIST_FILE` 现在同时作用于 CLI 和本地服务的激活/改密。使用受信任的本地 UTF-8 文件（最多 16 MiB，建议绝对路径）；不把内置小列表当完整泄露密码库。真实数据库、锁竞态、回滚与 Chromium API 流程见 [本地实验 T03c 记录](../../docs/dyoffice/evidence/t03c-account-lifecycle.md#local-experimental-runtime)。已消费/过期的密码令牌记录清理仍是已知维护项；文件、租约与任务进度分别见下文 T05–T08，完整 Admin UI、外部 Token 与生产放行仍未完成。


### T04 受限数据库账号与偏好隔离

本地实验服务要求 PostgreSQL 17、独立的迁移 owner、认证 login 和业务 login。三个角色均为 `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`，运行角色不得拥有表或有任何角色成员关系。使用专用数据库，由迁移 owner 拥有数据库和应用表；密码通过受控秘密管理或 psql 的 `\password` 设置，避免放入命令参数/日志。本工具不创建角色或密码。

1. 运维先创建上述三个角色和专用数据库，分别准备 owner/auth/business 的连接秘密。
2. 仅在迁移终端配置 `DYOFFICE_DATABASE_URL`（owner）、`DYOFFICE_AUTH_ROLE`、`DYOFFICE_BUSINESS_ROLE`，运行 `npm run provision:runtime`。它执行不可变迁移并在事务中安装最小授权；会撤销该数据库 PUBLIC 的 CREATE/TEMP 及应用 schema 的 CREATE，因此不能指向共享业务数据库。
3. 用同一 owner 连接、稳定的 `DYOFFICE_DEPLOYMENT_ID` 和交互终端运行 `npm run bootstrap:admin`，密码隐藏输入。迁移/初始化秘密不交给 Web 进程。
4. 服务环境取消 `DYOFFICE_DATABASE_URL`，改用 `DYOFFICE_AUTH_DATABASE_URL` 与 `DYOFFICE_BUSINESS_DATABASE_URL`，再按上文配置 local 模式、Origin、CSRF Key 和 HTTPS。运行 `npm run dev:web`。启动会检查两角色的权限、函数所有者、FORCE RLS 和同一数据库；旧单连接配置会失败。

`GET/PUT /api/preferences` 和 `/api/v1/preferences` 使用 Cookie 推导个人身份，支持 theme、language、authorName、autoSave、showAssistant。PUT 需要 Origin/CSRF；owner 等额外字段被拒绝。业务事务锁定账号和会话直到提交，停用/撤销与写入有明确提交顺序；Admin 没有他人偏好的所有权。旧 JSON 原型数据不自动迁移给新账号。

集成测试的隔离 PostgreSQL 管理连接需能创建/删除测试数据库和角色；测试在随机专用数据库内使用真实的三个非超级用户角色，不能拿超级用户测试冒充 RLS 验收。详情见 [T04 证据](../../docs/dyoffice/evidence/t04-rls-checkpoint.md)。生产仍关闭；文件、后台任务、外部 Token 和四格式编辑尚未由此交付。

### T05a 对象存储与结构校验基础

已增加单次发布的本地盘/S3 adapter、读回 SHA-256 校验，以及 DOCX/XLSX/PPTX/PDF 结构预检。该历史阶段尚未接入文件 HTTP 路由；下文 T05b 已在显式实验配置下接入原件导入/下载，编辑仍未实现。配额、文件元数据、上传完成事务、回收站与受控下载继续由 T05 实现，production 仍关闭。

`npm run test:web:storage` 运行真实临时磁盘、S3 兼容服务和解析工作线程测试。必须显式配置隔离测试服务的 `DYOFFICE_TEST_S3_ENDPOINT`（仅 loopback）、`DYOFFICE_TEST_S3_ACCESS_KEY`、`DYOFFICE_TEST_S3_SECRET_KEY`；缺少服务会失败，不会跳过或改用内存存储。测试账号只应拥有临时测试服务的权限；测试创建并删除随机 `dyoffice-test-*` bucket。CI 使用固定摘要的 RustFS 服务，仅为兼容性测试，生产对象存储仍由部署方配置。

预检保留原始字节，不执行文档脚本；解析工作线程有并发/超时和 JS 堆限制，但不能替代操作系统内存隔离或恶意内容扫描。完整 F13/T21 安全门槛尚未验收。完整边界、依赖版本和实测记录见 [T05a 证据](../../docs/dyoffice/evidence/t05a-object-storage.md)。


### T05b 实验文件 API

先用迁移 owner 运行 `npm run provision:runtime` 安装当前全部不可变迁移和新表最小授权，再使用前述两套受限运行连接启动。文件功能默认关闭；在隔离开发环境设置 `DYOFFICE_FILE_API=experimental`，并选择一个存储：

- 本地盘：`DYOFFICE_OBJECT_STORE=local-dev`，显式指定独立目录 `DYOFFICE_OBJECT_DIRECTORY`。不能指向旧原型状态目录，也不用于多副本/HA。
- S3：`DYOFFICE_OBJECT_STORE=s3`、`DYOFFICE_S3_BUCKET`、`DYOFFICE_S3_REGION`；使用标准 AWS SDK 环境凭据或运行角色。可选 `DYOFFICE_S3_ENDPOINT`、`DYOFFICE_S3_FORCE_PATH_STYLE=true|false`。自定义非 loopback endpoint 必须 HTTPS，URL 不允许用户信息或查询秘密。bucket 需预先创建并保持私有，启动检查 HeadBucket；本服务不创建生产 bucket 或 IAM/加密策略。

可用 `DYOFFICE_FILE_QUOTA_BYTES` 设置每用户配额，默认 1 GiB；单文件最多 32 MiB，最多 16 个活动上传，上传 15 分钟过期。回收站和等待安全清理的已发布对象仍计入容量。尚无硬删除/回收任务，因此保守计费的未引用对象不会自动退还额度。变更配额不会删除已有文件。

| 操作 | 版本化接口 |
| --- | --- |
| 预留上传 | `POST /api/v1/files/uploads`，JSON `{name,size}` |
| 发送完整字节 | `PUT /api/v1/uploads/:id/content`，`application/octet-stream` |
| 提交初始文件 | `POST /api/v1/uploads/:id/finish`，空请求体 |
| 取消尚未提交上传 | `DELETE /api/v1/uploads/:id` |
| 列表/回收站 | `GET /api/v1/files?trash=true|false&limit=1..100&cursor=UUID` |
| 打开元数据 | `GET /api/v1/files/:id` |
| 原件下载 | `GET /api/v1/files/:id/content?revision=UUID` |
| 重命名/回收/恢复 | `PATCH /api/v1/files/:id`（JSON `{name}`）、`DELETE /api/v1/files/:id`、`POST /api/v1/files/:id/restore` |
| 容量 | `GET /api/v1/storage/usage` |

所有操作依赖 Cookie 会话；写入还需准确 Origin 和 `X-CSRF-Token`。不接受 owner、objectKey 或客户端哈希作为授权/完整性证明。上传完成前没有可下载文件；finish 失败可在期限内重试，成功重试返回同一初始版本。接收阶段响应丢失时，不要覆盖对象，可尝试 finish 确认是否已就绪。后台对象操作未结束时，客户端断线仍占用传输名额；满额返回临时 503。

T05b 提供原件生命周期；下文 T06 增加受控的版本保存 API。未开启下文 T07 实验入口时，能力目录仍全部 unsupported。完整工作区 UI、其他原生编辑器、操作系统解析隔离与恶意内容扫描、保留清理、完整恢复和企业部署尚未完成，production 继续关闭。仅使用授权测试文件进行隔离开发。真实 PostgreSQL/S3/HTTP/TLS 证据见 [T05b 记录](../../docs/dyoffice/evidence/t05b-file-lifecycle.md)。


### T06 租约、保存提交与历史

实验文件 API 现在支持服务器保存事务。先用独立 migration owner 运行 `npm run provision:runtime` 安装 migration 6 和最小授权，再按上文用 auth/business 受限连接、显式实验存储启动。旧迁移校验和不变，不要删除历史记录来绕过版本检查。

每个编辑器实例应新建 UUID `editorId`，不能因为共享 Cookie 就共享编辑器 ID。租约默认 45 秒，约每 15 秒续租；另一页默认无法取得现有有效租约，需用户明确接管。租约 epoch 单调增加，旧页面、旧会话或已过期的写入不能提交。原生 UI 和 BrowserHost 的新保存传输仍待 T07 接入；现有能力目录没有据此标为 editable。

| 操作 | 接口与请求体 |
| --- | --- |
| 查看/取得租约 | `GET /api/v1/files/:id/lease`；`POST` 同路径，JSON `{editorId}` |
| 续租 | `POST /api/v1/files/:id/lease/renew`，`{editorId,leaseEpoch}` |
| 明确接管 | `POST /api/v1/files/:id/lease/takeover`，`{editorId,expectedEpoch}` |
| 释放 | `DELETE /api/v1/files/:id/lease`，`{editorId,leaseEpoch}` |
| 预留编辑上传 | `POST /api/v1/files/:id/uploads`，`{size,baseRevision,leaseEpoch,editorId}` |
| 发送字节 | 复用 `PUT /api/v1/uploads/:uploadId/content`，完整 `application/octet-stream` |
| 提交保存 | `POST /api/v1/files/:id/commits`，`{fileId,uploadId,baseRevision,idempotencyKey,leaseEpoch,sourceCommandId?}` |
| 历史 | `GET /api/v1/files/:id/revisions?limit=1..100&cursor=revisionUUID` |
| 预留历史恢复 | `POST /api/v1/files/:id/restoration-uploads`，`{revision,baseRevision,leaseEpoch,editorId}` |

取得新版本 uploadId 后调用 commits；不要调用初次导入的 finish，后者会拒绝版本上传。成功返回 `RevisionRef`，只有 DB 事务提交后才算保存。并发旧基线或旧租约返回 409，保留本地草稿；相同成功幂等键/请求重试返回原版本，不再次写对象或事件。幂等键为 8–128 位字母、数字、下划线或连字符，建议随机 UUID。同一成功键换请求会冲突。可选 sourceCommandId 当前仅作为**未验证的客户端请求标签**保存和参与请求哈希，不代表命令已授权/执行；真实命令关联由 T17 接入。

历史恢复接口会校验并复制原件到一个新的 ready 上传；随后用该 uploadId、当前 baseRevision 和有效租约调用 commits。恢复不能覆盖其后发生的新修改，最终产生一个新版本而非把指针倒退。`GET /api/v1/files/:id/content?revision=UUID` 可下载该文件任何保留版本的校验后原件。回收站仍需先恢复文件再访问版本。

所有历史版本、待清理对象继续占配额；尚无自动硬删除或历史回收。outbox 当前只在保存事务内持久记录事件意图，T08 才实现派发，不能把它当外部任务已完成。真实 PostgreSQL/S3/Chromium 测试、升级与已知边界见 [T06 证据](../../docs/dyoffice/evidence/t06-revision-transactions.md)。完整原生编辑、解析 OS 沙箱、生产部署和客户验收仍未完成。


### T07 原生 DOCX 浏览器实验入口

在上述 local 会话、当前全部迁移、文件实验 API 和 HTTPS Origin 配置完成后，使用 Node 22 在仓库根目录执行：

```sh
npm ci --ignore-scripts --include=dev
npm run build:web:docs
# 在已配置 local 模式的服务环境中启用原生入口
export DYOFFICE_NATIVE_DOCX=experimental
npm run dev:web
```

默认只读取 `apps/web/dist-docs` 的构建清单；可用受信任的服务配置 `DYOFFICE_NATIVE_DOCX_DIRECTORY` 指向同类完整输出目录。缺少文件 API 或构建资源会拒绝启动，不回退到源文件服务。通过登录 API 建立 Secure Cookie 后，导入 DOCX，再访问 `/native-docx/?fileId=<文件 UUID>`。该路径要求本人拥有未删除的 DOCX；静态资源也需要有效会话。开启该入口后，能力目录和打开结果只将 DOCX 标记为 editable，其他三格式仍 unsupported。

页面复用 DyOffice 的 Tiptap 渲染器、DOCX parser/writer、分页和字体，通过会话 BrowserHost 保存；Ctrl+S 提交新版本。使用租约续期、显式接管、捕获基线 CAS 与幂等回执。失去租约后只读，未知保存结果保留草稿并先确认原请求；保存期间的新输入不会被旧响应清空。版本下载使用既有 content API，单个历史版本元数据新增 `GET /api/v1/files/:id/revisions/:revision`。

这仍是纵向开发接缝：登录/文件列表 UI、AI、完整桌面功能替代、崩溃草稿恢复与外部 Word QA 尚待后续验收，production 拒绝保持生效。浏览器不能调用桌面文件路径或通用 IPC。测试使用真正的 Chromium + TLS + 独立 PostgreSQL：`npm run test:web:docs` 会先重新构建，需预先安装 Chromium 并配置隔离的 `DYOFFICE_TEST_DATABASE_URL`。类型检查为 `npm run typecheck:web:docs`；现有 Docs 与 docx-engine 测试必须使用 Node 22。

### T08a 持久任务与投递基础（内部接缝）

T08a 建立版本 7 的任务表；下文历史检查点记录到版本 10，当前版本为 T08 运行说明中的 12。新增任务输出、租约用途与受限就绪校验见下文 T08c/T08e。更新服务前用独立非超级用户 owner 执行 `npm run provision:runtime`，安装全部不可变迁移和最小授权。已有 v6 会话、对象版本、租约、幂等回执、outbox 和配额保留；迁移没有重写前六个 SQL 文件。

内部任务服务将 `native_jobs` 和 `job_outbox` 同事务创建，按用户限制活动任务数、按键幂等重试；输入只允许本人文件的版本 UUID `artifactId`，当前基线和会话/authVersion 由服务器捕获。取消、deadline、执行次数、领取 hash/epoch 均以 PostgreSQL 为准。任务继承原认证事务的空闲超时，不授予更长的后台会话。

可由运维额外预建一个 `NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION` 的 worker login，设置 `DYOFFICE_WORKER_ROLE` 后再次运行上述 owner CLI。worker 仅能 EXECUTE 五个固定任务函数（当前另有一个只读 schema 校验函数），没有账号、文件或任务表的直接读取权限；auth/business 角色不能调用领取/派发函数或内部 helper。该可选角色不是生产运行许可，也不创建或更改任何密码。任务表 FORCE RLS；内部跨用户调度仅在受限函数内由独立迁移 owner 扫描任务元数据。

已提供内部 BullMQ 队列/dispatcher：消息只有任务 ID 与投递 epoch。确认丢失会重新投递，已确认的 queued/过期 running 任务也会周期性重建提示，Redis 清空不会抹掉 PostgreSQL 任务。Redis 客户端连接失败有启动期限及有限请求重试，后台连接会重连。已完成 BullMQ 消息不等于业务任务成功；只有下一阶段真实原生输出与 T06 同事务完成后才能标记成功。

此历史 checkpoint **尚未接入公开任务路由、调度守护循环、原生 executor、OS 沙箱或任务输出提交**，现有 Web 启动不要求 Redis，也不在启动时伪造成功任务。`docx.roundtrip` 仅为内部测试保留类型；T08 仍未完成。T06 的 revision_outbox 仍保留意图，不把当前 job dispatcher 当成文档索引事件已消费。

`npm run test:web:jobs` 使用真实独立 PostgreSQL 与 Redis/BullMQ，另需 `DYOFFICE_TEST_REDIS_URL` 指向隔离 loopback Redis。测试仅操作随机专属队列 namespace；恢复测试清空该队列并真实断开客户端连接，不清空共享 Redis。历史 T08a fixture 使用 Redis 7.4 容器；当前测试与 CI 已切换宿主机 Redis。不得将测试连接指向业务服务。具体结果和开放项见 [T08a 证据](../../docs/dyoffice/evidence/t08a-durable-jobs.md)。

### T08 当前运行方式（2026-11-16）

原生 Worker 已切换为无 Docker 的 Linux/systemd 受限进程。构建原始 Rust 引擎后，使用 `host-manifest.json` 中的绝对二进制路径与 SHA-256，分别设置 `DYOFFICE_NATIVE_BINARY` 和 `DYOFFICE_NATIVE_SHA256`。配置和权限要求见 [宿主机运行说明](worker/HOST-RUNTIME.md)。旧 T08a–e 证据记录当时状态，不再作为当前部署步骤。

迁移版本为 12，先用 owner 执行 `npm run provision:runtime`。API 设置 `DYOFFICE_NATIVE_JOBS=experimental`，提供任务入队、列表、查询与取消；入队输入仅含本人 artifactId、类型和幂等键，使用现有 Cookie/Origin/CSRF。独立 Worker 设置 `DYOFFICE_NATIVE_WORKER=experimental`，使用受限 worker/business 连接及相同 deployment、对象存储配置。

Worker 的原生执行、心跳、取消/失锁终止及 T06 同事务输出提交已连通。systemd 独立期限处理控制进程死亡，部署范围内的过期残留由启动与定期回收处理。revision outbox 使用 SQL 租约和确认令牌向 Redis 发布 eventId，支持重复提示和队列丢失后的重建；发布不代表搜索索引已完成。

PostgreSQL、Redis 与测试对象存储采用宿主机独立服务。无 Docker 构建、隔离、任务和存储测试已运行；T08 已通过最终审查与本次全部回归；验收见 [T08 闭环证据](../../docs/dyoffice/evidence/t08-docker-free-closure.md)，production 保持关闭。

### Original Home and Settings with local accounts

Build with `cd apps/web && npx --no-install vite build --config vite.local-shell.config.mjs`.
Opt in with `DYOFFICE_LOCAL_SHELL=experimental` and an explicit
`DYOFFICE_LOCAL_SHELL_DIR=apps/web/dist-local-shell` in `DYOFFICE_AUTH_MODE=local`.
This requires the isolated scoped File API and restricted database pools described
above. Log in with a real local account; no development-token/JSON fallback exists.
The original Home/Settings components use the cookie/CSRF file and preferences APIs.
New/imported DOCX editing additionally requires the native DOCX entry. It opens as
a top-level editor page with browser Back, not a completed multi-tab local workflow.
Admin/account/password UI is not yet connected here; unsupported format creation is
disabled and stars remain page-session-only. Local-account Chromium acceptance lives
in `test/local-browser`, requires real PostgreSQL, and fails when that service is absent.

## T12 backend-only workspace and configuration APIs

This backend batch does **not** ship the T12 Home/Settings UI. The existing client
is retained, including its current UI limitations: persistent folder/star/recent APIs
are available, but the old UI has not been wired to them and retains its prior
page-session behavior. With a `businessPool` configured,
`buildLocalApp` registers the following HTTP APIs by default; lack of UI or a keyring
does not disable those routes:

- `/api/v1/workspace/*`: owner-scoped folders, listing, stars, recent activity and
  membership operations, using current cookie sessions, mutation CSRF and forced RLS.
- `GET /api/v1/settings/public`: authenticated safe catalog/default projection only.
- `/api/v1/admin/config`, `/check`, `/rotate-key`: `config_admin` operations with
  session/CSRF checks, optimistic revision validation, encrypted keys and audit.
  A configuration administrator receives no authority over another user's files.

Apply the unchanged migrations **0018_global_config.sql** and **0019_workspace.sql**
together with this manifest/role provisioning version. Applied 0001–0017 checksums
remain unchanged. Runtime pools must pass the current schema checksum and role
checks. A private deployment that previously applied the old PR's conflicting
0014/0015 is not silently upgraded; never bypass the checksum guard.

`DYOFFICE_CONFIG_KEYRING` accepts JSON with `activeKeyId` and a `keys` mapping of key
IDs to canonical base64-encoded 32-byte keys. Provision it through the deployment's
secret mechanism, independently of CSRF/account credentials. Do not commit/log it.
Without a keyring, catalog/metadata access remains possible but secret writes and
operations requiring decryption fail closed. Blank/omitted keys preserve existing
ciphertext; explicit clearing is separate. Rotation is atomic with revision/audit.

Configuration checks are local validation only and report `connection: "not_run"`.
There is no new outbound Provider/MCP execution, secret-consumer endpoint, automatic
network connection, bulk-purge UI, or production authorization in this batch.
Keep using the declared `node --import tsx` server entry: Provider catalog metadata
contains runtime TypeScript imports. The separate provision-runtime CLI retains
its existing native strip-types contract.

See [backend-only validation](../../docs/dyoffice/evidence/t12-backend.md) for exact
coverage and limits. Backend API tests do not stand in for current browser, UI
session-switch/save-failure, or native DOCX theme/roundtrip acceptance.

## T12 non-native UI stage

This stage wires the original Home to per-user workspace folders, favorites and recoverable Trash, and exposes personal settings and administrator global-configuration controls. Web personal preferences use an explicit draft/save flow; unsupported desktop controls remain disabled.

Existing DOCX navigation is retained. XLSX retains #52’s original-download/import-notification implementation even if a native capability is advertised (the target previously rejected non-DOCX opening): the new unverified XLSX Home jump stays in draft #52. No migrations, native runtime adapters, isolation settings or provider execution paths change here. See [scoped evidence](../../docs/dyoffice/evidence/t12-nonnative-ui.md).

### Required document backend selection (fail closed)

`DYOFFICE_DOCUMENT_BACKEND` is an optional deployment requirement, checked at the
start of the API process, native worker, and Sheets runtime composition:

- Unset: retain existing behavior. Native XLSX/jobs still require their explicit
  `experimental` flags, existing credentials, storage and verified legacy sandbox.
- `legacy-experimental`: explicitly retain that same behavior; this selector does
  not enable any native capability or remove existing production restrictions.
- `broker-required`: refuse startup with `DOCUMENT_BROKER_UNAVAILABLE`. The broker
  has no approved production runtime yet. No fallback to the legacy host sandbox,
  dependency connection, queue consumption or job claim is attempted.
- Any other value (including an explicitly empty value) is a configuration error,
  `DOCUMENT_BACKEND_INVALID`; omit the variable instead of setting it to empty.

The server logs only a fixed bounded reason. It does not print configuration,
credentials, paths or raw errors. This mode does not probe arbitrary binaries,
trust an operator-supplied runtime report, register candidate SQL, enable a
runtime, provide a broker socket, or claim Docker/four-format execution readiness.
An operator can use it to ensure a deployment requiring the future broker cannot
silently start on the experimental legacy backend. Existing deployments that do
not set the new variable retain their original explicit mode checks.

Verification exercises the actual worker/Sheets functions with configuration
access sentinels and socket-connect counters (zero), as well as the real server
entry in a child process (exit 1, fixed reason, no advertised listener). Legacy
negative startup tests remain unchanged. This is startup-denial evidence, not
positive legacy host, Docker, broker execution or production acceptance.
