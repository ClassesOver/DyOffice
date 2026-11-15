# dyoffice Web

This is the Web adaptation inside the cloned GenOffice repository, based on upstream `19a389b39be75f611ec21dcda4a7b91a658239d2`. UI and browser integration reference: ClassesOver/sm PR #245 (`beeb717b31e2201cc1e541c54b2f750f606d99e2`). Upstream engines and license notices remain in place.

## Run

Requires Node 22.12+. From the repository root:

```sh
npm install --prefix apps/web --workspaces=false --ignore-scripts
# Export distinct DYOFFICE_USER_TOKEN and DYOFFICE_ADMIN_TOKEN values,
# plus a persistent DYOFFICE_ENCRYPTION_KEY (see .env.example).
npm run dev:web
```

Open `http://127.0.0.1:3080` for the personal workspace and `/admin` for administration. Use the corresponding access token. Configuration is read from environment variables; `.env.example` is a template and is not loaded automatically. Persist the data directory and encryption key together.

## Current implementation

- Personal file import/download restricted to DOCX, XLSX, PPTX and PDF.
- Personal theme, language, author, autosave and assistant preferences.
- HTTP data-source configuration with encrypted credentials.
- Admin-only model endpoint/key configuration and enabled-model catalog.
- Admin-only Streamable HTTP MCP configuration and real connection/tool discovery using the official MCP SDK. No stdio subprocess transport.
- Separate personal/admin bearer tokens. The admin token manages configuration, but cannot read or modify personal files, preferences or data sources. Secrets encrypted with AES-256-GCM and omitted from read responses.

The development token server refuses startup when `NODE_ENV=production`, before reading or creating its data directory. This guard is not production account authentication or multi-user resource isolation. Production will use **local username/password authentication**, Admin-managed accounts, PostgreSQL-backed server sessions and personal resource ownership. OIDC/Keycloak/SSO are explicitly out of scope. See `docs/dyoffice/local-account-auth.md`. These features are **not implemented yet**.

## Remaining implementation

Native browser editor integration, document save/revision lifecycle, model chat/tool execution, database connectors and query integration, source edit/delete/test UI, file folders/favorites/recent views, multi-user login and deployment hardening. Preference fields for editor features are persisted now and will be applied as each editor is integrated. This is a development foundation, not a completed Office editor.

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
covers BrowserHost, Web contracts and the new Fastify TypeScript modules, not the legacy JavaScript prototype or all
upstream renderer packages. HTTP smoke checks do not replace real browser UI or
native document round-trip acceptance.

### Prototype storage and concurrency boundary

Run exactly one server process/application instance per data directory. The JSON store's queue protects only that instance; starting another instance on the same directory is unsupported and can overwrite metadata, even when both uploads return success. Do not use clustered workers, multiple replicas or rolling overlap with a shared prototype directory. There is currently no inter-process ownership lock.

Admin updates apply supplied sections against the latest state inside the instance queue; omitted sections and omitted keys are preserved. Concurrent updates to the same section remain last-writer-wins, not revision-checked. This is not the planned PostgreSQL CAS, document revision, lease, or idempotency implementation (T04/T06/T12). File endpoints currently import and download originals; they do not implement editing-save transactions.

### T02 请求与错误迁移接缝

每个请求由服务端生成独立 `X-Request-ID`，不信任或回显客户端同名请求头。JSON 错误响应保持原有 HTTP 状态码、`application/json` 和 `error` 文案，增量提供 `type: about:blank`、`title`、`status`、`detail`、`requestId`；成功响应正文不变。错误中不包含请求 URL、查询参数或内部异常详情，500 继续返回通用文案。

Fastify 应用工厂位于 `server/src/app.ts`，`dev:web` / `start:web` 已使用该入口。独立健康模块提供 `/api/v1/health/live` 与 `/api/v1/health/ready`，就绪检查当前只验证开发存储。请求 ID 由服务端生成；按直连 IP 每分钟最多 600 个请求，健康检查豁免，不信任客户端代理头。SIGTERM/SIGINT 停止监听并等待在途请求完成。限流计数只在单进程内存中，不能用于多实例生产部署。

旧接口通过兼容模块继续处理，接管发生在限流之后、正文解析之前，保留既有 JSON/50 MiB 上传限制、权限与错误契约。`createApplication()` 仍保留，供旧回归及回退使用。运行 `npm run test:web:integration` 检查真实 HTTP 的兼容行为、限流与子进程关闭；`typecheck:web` 同时检查新的 TypeScript 服务端。Node 22.12 使用脚本中的 `--experimental-strip-types` 启动 TypeScript。

T02 仍需逐领域迁移旧路由与完整 `/api/v1` 契约；本地账号、服务端撤销和工作区/偏好 RLS 接缝已实现，见下文 T03/T04；完整文件隔离和 UI 仍待实现。生产启动守卫保留，不能据此宣称正式登录、生产就绪或企业验收完成。


### T03a 本地账号基础（尚未接入网页登录）

`server/src/modules/auth` 与 `server/src/db` 已提供 PostgreSQL 账号/角色/工作区表、Argon2id 密码验证和并发安全的一次性 Admin 初始化。`npm run bootstrap:admin` 必须在交互终端运行；显式提供 `DYOFFICE_DATABASE_URL` 与稳定 UUID `DYOFFICE_DEPLOYMENT_ID`，密码在终端隐藏输入并确认，不能放命令参数或密码环境变量。可用 `DYOFFICE_PASSWORD_BLOCKLIST_FILE` 加载部署批准的本地密码阻断语料；内置小列表只是起步，不能代表完整泄露密码覆盖。

账号集成测试需要 `DYOFFICE_TEST_DATABASE_URL` 指向隔离的 `dyoffice_test` 或 `dyoffice_test_*` PostgreSQL 数据库；缺少数据库会失败，不会跳过或换成内存实现。Linux/macOS 的 CLI 终端回归还需要 Python 3 标准库。`npm run test:web:integration` 运行账号、PTY 和 Fastify 测试；CI 提供独立 PostgreSQL 17 服务。

这些模块还没有提供 Cookie 会话或账号登录界面，也没有接管旧 JSON 个人数据。开发 Token 启动路径及 production 拒绝保持生效；完整进度与实际证据见 `docs/dyoffice/evidence/t03a-account-bootstrap.md`。


### T03b 本地会话实验入口

`DYOFFICE_AUTH_MODE=local` 启用独立的 PostgreSQL 会话 API。先按下文 T04 配置独立数据库账号，并用 CLI 初始化账号。运行服务时设置 `DYOFFICE_AUTH_DATABASE_URL`、`DYOFFICE_BUSINESS_DATABASE_URL`、`DYOFFICE_DEPLOYMENT_ID`、准确的 `DYOFFICE_ORIGIN` 和至少 32 字节的随机持久化 `DYOFFICE_CSRF_KEY`；取消迁移连接变量和开发用户/Admin Token 后启动。它提供登录挑战、登录/退出、`me`、重新认证、个人会话查询/撤销，未实现的个人文件和其他配置路由返回 501，不访问旧 JSON 数据。网页登录/工作区界面尚待接入，工作区/偏好 RLS 已接入，production 仍拒绝启动。

浏览器流程先 GET `/api/v1/auth/csrf`，保留服务端 HttpOnly Cookie，把返回的 `csrfToken` 放入 `X-CSRF-Token` 后 POST `/api/v1/auth/login`；写请求要求准确的同源 Origin。登录响应只返回用户 DTO 与 CSRF proof，实际会话令牌只在 Secure Cookie。使用与 Origin 对齐的 HTTPS 入口验证浏览器，不以手动传 Cookie 代替验证。

`npm run test:web:e2e` 使用真实 Chromium + TLS + PostgreSQL 检查 Cookie 与退出；先运行 `apps/web/node_modules/.bin/playwright install chromium --with-deps`。安全边界、实测结果；大小写 UUID 清 Cookie 问题已由 T03c 修复见 `docs/dyoffice/evidence/t03b-local-sessions.md`。


### T03c 管理员与密码操作 API

本地实验模式增加 `/api/v1/admin/users` 的查询/开户，以及指定账号的状态、角色、激活重发和密码重置操作。敏感操作需最近 15 分钟内的密码验证与 Origin/CSRF；新账号默认仅个人角色。激活/重置秘密只返回一次、15 分钟过期，POST `/api/v1/auth/password-action` 在匿名挑战后用 JSON 消费，不生成凭据 URL，也不发送邮件。重置签发立即冻结旧密码登录并撤销旧会话；过期后需管理员重发。自己的改密使用 `/api/v1/auth/change-password`，验证旧密码后替换会话 Cookie。

`DYOFFICE_PASSWORD_BLOCKLIST_FILE` 现在同时作用于 CLI 和本地服务的激活/改密。使用受信任的本地 UTF-8 文件（最多 16 MiB，建议绝对路径）；不把内置小列表当完整泄露密码库。真实数据库、锁竞态、回滚与 Chromium API 流程见 `docs/dyoffice/evidence/t03c-account-lifecycle.md`。已消费/过期的密码令牌记录清理仍是已知维护项；完整 Admin UI、文件/任务隔离、外部 Token 与租约仍待后续任务，production 继续关闭。


### T04 受限数据库账号与偏好隔离

本地实验服务要求 PostgreSQL 17、独立的迁移 owner、认证 login 和业务 login。三个角色均为 `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`，运行角色不得拥有表或有任何角色成员关系。使用专用数据库，由迁移 owner 拥有数据库和应用表；密码通过受控秘密管理或 psql 的 `\password` 设置，避免放入命令参数/日志。本工具不创建角色或密码。

1. 运维先创建上述三个角色和专用数据库，分别准备 owner/auth/business 的连接秘密。
2. 仅在迁移终端配置 `DYOFFICE_DATABASE_URL`（owner）、`DYOFFICE_AUTH_ROLE`、`DYOFFICE_BUSINESS_ROLE`，运行 `npm run provision:runtime`。它执行不可变迁移并在事务中安装最小授权；会撤销该数据库 PUBLIC 的 CREATE/TEMP 及应用 schema 的 CREATE，因此不能指向共享业务数据库。
3. 用同一 owner 连接、稳定的 `DYOFFICE_DEPLOYMENT_ID` 和交互终端运行 `npm run bootstrap:admin`，密码隐藏输入。迁移/初始化秘密不交给 Web 进程。
4. 服务环境取消 `DYOFFICE_DATABASE_URL`，改用 `DYOFFICE_AUTH_DATABASE_URL` 与 `DYOFFICE_BUSINESS_DATABASE_URL`，再按上文配置 local 模式、Origin、CSRF Key 和 HTTPS。运行 `npm run dev:web`。启动会检查两角色的权限、函数所有者、FORCE RLS 和同一数据库；旧单连接配置会失败。

`GET/PUT /api/preferences` 和 `/api/v1/preferences` 使用 Cookie 推导个人身份，支持 theme、language、authorName、autoSave、showAssistant。PUT 需要 Origin/CSRF；owner 等额外字段被拒绝。业务事务锁定账号和会话直到提交，停用/撤销与写入有明确提交顺序；Admin 没有他人偏好的所有权。旧 JSON 原型数据不自动迁移给新账号。

集成测试的隔离 PostgreSQL 管理连接需能创建/删除测试数据库和角色；测试在随机专用数据库内使用真实的三个非超级用户角色，不能拿超级用户测试冒充 RLS 验收。详情见 [T04 证据](../../docs/dyoffice/evidence/t04-rls-checkpoint.md)。生产仍关闭；文件、后台任务、外部 Token 和四格式编辑尚未由此交付。

### T05a 对象存储与结构校验基础

已增加单次发布的本地盘/S3 adapter、读回 SHA-256 校验，以及 DOCX/XLSX/PPTX/PDF 结构预检。它们尚未接入文件 HTTP 路由；当前不能用本地账号上传/编辑文件。配额、文件元数据、上传完成事务、回收站与受控下载继续由 T05 实现，production 仍关闭。

`npm run test:web:storage` 运行真实临时磁盘、S3 兼容服务和解析工作线程测试。必须显式配置隔离测试服务的 `DYOFFICE_TEST_S3_ENDPOINT`（仅 loopback）、`DYOFFICE_TEST_S3_ACCESS_KEY`、`DYOFFICE_TEST_S3_SECRET_KEY`；缺少服务会失败，不会跳过或改用内存存储。测试账号只应拥有临时测试服务的权限；测试创建并删除随机 `dyoffice-test-*` bucket。CI 使用固定摘要的 RustFS 服务，仅为兼容性测试，生产对象存储仍由部署方配置。

预检保留原始字节，不执行文档脚本；解析工作线程有并发/超时和 JS 堆限制，但不能替代操作系统内存隔离或恶意内容扫描。完整 F13/T21 安全门槛尚未验收。完整边界、依赖版本和实测记录见 [T05a 证据](../../docs/dyoffice/evidence/t05a-object-storage.md)。
