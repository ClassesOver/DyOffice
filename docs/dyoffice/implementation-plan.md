# DyOffice Web 完整实施计划

> **面向实施者：** 按 `superpowers:executing-plans` 或 `superpowers:subagent-driven-development` 逐任务执行；所有复选框初始均未完成。先阅读关联架构，不把本计划当成已经实现的功能清单。

**Goal:** 在克隆的 GenOffice 仓库内，完成四格式原生 Web 编辑、AI、个人隔离、HTTP MCP、数据源及企业可部署交付。

**Architecture:** Fastify 模块化单体复用 GenOffice Agent Core/Provider/引擎；浏览器保留活跃编辑工具；HTTP/SSE 服务业务和模型流，WS 桥接远程编辑；PostgreSQL 保存权威状态，S3 保存不可变文档，隔离 Worker 执行重任务。

**Tech Stack:** TypeScript、React/Vite、Fastify、PostgreSQL/Drizzle、S3、Redis/BullMQ（任务阶段引入）、现有 GenOffice 包及官方 MCP SDK；具体版本由 T00 锁定。

**Spec:** [architecture.md](architecture.md)、[local-account-auth.md](local-account-auth.md)、[enterprise-delivery.md](enterprise-delivery.md)、[acceptance-matrix.md](acceptance-matrix.md)。原有约束见 `reuse.md`、`../../DYOFFICE.md`。

## 全局约束

- 只开放 DOCX/XLSX/PPTX/PDF 产品入口；保留必要内部转换依赖。
- 只有个人工作区；企业交付不新增团队/成员/团队权限和多人协同产品。
- 最大复用现有编辑器、AgentLoop、Tools、Skills 和 Provider；不改用 Agno 主栈。
- 全局模型、媒体、搜索、重排、HTTP MCP 和凭据在 Admin；个人偏好不能覆盖安全策略。
- MCP 对用户只开放 HTTP；URL Token 仅隔离开发测试，production 开启即拒绝启动。
- HTTP 持久提交是文件真相；WS ACK、本地编辑和模型回答不是保存成功。
- 所有用户权限由本地账号密码登录产生的服务端会话派生；管理员创建账户、个人独立 workspace；不引入 OIDC/SSO，不接受客户端任意 owner/user/deployment 参数作为授权依据。
- 复用代码保留许可、NOTICE 和来源 SHA；原生 ABI、字体和模型外发策略逐项验收。
- 项目实施分支为 `feat/dyoffice-web`；每任务使用小 PR/提交，禁止把所有阶段合成不可审查的大补丁。

## 审查重点

1. AI 修改与手工输入交错，旧快照保存响应不能把新输入标记已保存：T06/T14。
2. 写入生效但回执丢失，重连不能重复执行命令：T14/T17/T19。
3. 同一数据库连接先服务 A 后服务 B，RLS 上下文不得残留：T04。
4. Admin 禁用模型、用户退出、Token 撤销后，旧流和旧工具审批不能继续越权：T12/T13/T17/T19。
5. 对象存储写成功而数据库失败、以及两者不同时间恢复，不得出现已提交记录指向丢失对象：T06/T24/T26。

## 1. 目录与公共接口

以下为拟建目录；不要误认为已经存在。上游文件只在确有接缝时做小改动。

```text
packages/web-contracts/src/   host.ts api.ts events.ts tools.ts errors.ts
packages/browser-host/src/   index.ts files.ts preferences.ts ai-transport.ts editor-bridge.ts
apps/web/src/                workspace/ admin/ auth/ editors/ components/
apps/web/server/src/
  app.ts config.ts
  modules/auth/ policy/ files/ revisions/ leases/ admin/ providers/
  modules/commands/ realtime/ mcp-client/ mcp-server/ sources/ search/
  modules/jobs/ audit/ usage/
  db/schema.ts db/migrations/ storage/ outbox/ security/
apps/web/worker/src/          main.ts jobs/ native/ sandbox/
apps/web/test/                原有 *.test.mjs 保留；新增 unit/ integration/ e2e/ security/ recovery/
deploy/dyoffice/              compose/ helm/ proxy/ config/ runbooks/
docs/dyoffice/               当前计划及 inventory/ evidence/ adr/
```

公共类型在 T01 定义并在后续任务复用：

- `Principal`：服务端建立的部署、用户、会话、角色、scope。
- `RevisionRef`：`fileId,revision,sha256,size`；revision 为不透明版本标识，不由客户端递增。
- `OpenFileResult`：`RevisionRef + capabilities + downloadEndpoint`。
- `SaveInput`：`fileId,uploadId,baseRevision,idempotencyKey,leaseEpoch,sourceCommandId?`。
- `ToolDescriptor/ToolCall/ToolOutcome`：工具注册、输入、执行效果、修改/提交状态。
- `CommandEnvelope`：`commandId,fileId,baseRevision,editorGeneration,leaseEpoch,argsHash,payload`。
- `JobRef`、`CapabilityCatalog`、`PublicSettings`、`Problem`：任务、无密钥能力、设置及错误。

核心服务签名：`authorize(principal, action, resource): Promise<void>`；`commitRevision(principal, input: SaveInput): Promise<RevisionRef>`；`executeAuthorizedTool(principal, call: ToolCall): Promise<ToolOutcome>`。BrowserHost 上的方法不要求浏览器传 Principal，身份由服务端再次建立。

## 2. 检查命令与执行纪律

当前已存在 `npm run test:web`、`dev:web`、`start:web`，以及 T02 增加的 `npm run test:web:integration -- <test-file>`。该命令只运行 `apps/web/test/integration/` 下的一个测试文件。`api-compat` 是 HTTP 契约，不连接 PostgreSQL、S3 或 Redis。下表其余脚本仍未创建，不能宣称它们已存在：

| 命令 | 责任 |
| --- | --- |
| `npm run test:web:legacy` | 原有 `apps/web/test/*.test.mjs` 回归 |
| `npm run test:web:unit -- <test-file>` | Web Vitest 单元测试，允许文件筛选 |
| `npm run test:web:integration -- <test-file>` | 运行一个 Web 集成测试文件。当前 `api-compat` 只覆盖 HTTP；PostgreSQL 身份测试仍在 identity workflow，不在此脚本的默认范围内 |
| `npm run test:web:e2e -- <spec-file>` | 浏览器原生编辑与端到端流程 |
| `npm run test:web:security` | 越权、SSRF、注入、上传、Token、安全边界 |
| `npm run test:web:recovery` | 崩溃、断流、备份/恢复、升级回滚 |
| `npm run test:web:load` | 受控环境容量与稳定性测试 |
| `npm run typecheck:web` / `build:web` | Web 类型与生产构建，不隐式启动 Electron |
| `npm run docs:check` | 本地相对链接、Markdown 围栏、任务引用和格式 |

每任务：先写可复现失败测试并记录 RED，再最小实现，运行 GREEN、受影响上游回归、类型检查和 `git diff --check`，最后提交。不能把环境故障当成 RED；不能把 skipped 当成通过。任务内写出的结果均为验收预期，不是本次执行结果。

## 3. 分任务实施

### T00 基线、宿主盘点与构建证据

**依赖：** 无。**负责：** 技术负责人 + 编辑器工程师。

**文件：** 新建 `docs/dyoffice/inventory/host-dependencies.md`、`compatibility.md`、`tools/check-web-boundaries.mjs`；修改根 `package.json`、`apps/web/package.json`、CI 工作流；保留原有脚本行为。

**接口：** 产出每个 IPC 的来源、调用方、Web 实现位置与能力状态；产出锁定依赖/镜像清单。

- [ ] 创建边界检查用例：浏览器入口导入 `node:fs`/Electron 必须报错；所有拟复用工具标记 live/headless/unsupported。
- [ ] 运行检查得到预期违规列表，确认是依赖边界问题而非缺少安装。
- [ ] 盘点四个 renderer/preload/main、原生 Rust、字体和 MCP 实际 lockfile；创建上述测试脚本与 Web 专用 CI，不全面重构上游。
- [ ] 跑现有 `npm run test:web`，保存真实结果；新边界检查和最小 Web 构建为 GREEN。
- [ ] 提交 `chore(web): inventory host boundaries and establish web gates`。

### T01 共享契约与 BrowserHost 骨架

**依赖：** T00。**文件：** 新建 `packages/web-contracts/{package.json,src/host.ts,src/api.ts,src/events.ts,src/tools.ts,src/errors.ts}`、`packages/browser-host/src/index.ts`、`apps/web/test/unit/host-contract.test.ts`。

**接口：** 输出第 1 节全部共享类型和 BrowserHost；`getCapabilities(): Promise<CapabilityCatalog>` 明确区分 unsupported、read_only、editable。

- [ ] 编写未知宿主方法、错误 DTO、缺失版本号、超大事件和 secret 字段泄漏测试。
- [ ] 运行 `npm run test:web:unit -- host-contract.test.ts`，确认契约缺失导致 RED。
- [ ] 实现类型和静态校验；未知功能明确失败，不返回假成功；为 Electron 现有行为保留适配入口。
- [ ] 同命令 GREEN，`typecheck:web` 通过，验证无 Node 依赖混入浏览器包。
- [ ] 提交 `feat(web): define host and transport contracts`。

### T02 模块化 API 与原型迁移接缝

**依赖：** T01。**文件：** 新建 `apps/web/server/src/app.ts`、`config.ts`、`modules/health/routes.ts`、`test/integration/api-compat.test.ts`；逐步替代 `server/application.mjs`、`index.mjs`，保留迁移期原接口适配。

**接口：** `buildApp(config): Promise<FastifyInstance>`，版本化 `/api/v1`，统一 Problem DTO 和请求 ID。

**状态（2026-11-15）：** `dev:web` / `start:web` 已切到 Fastify `buildApp`。偏好、Admin、数据源、文件、DOCX 和静态页面按模块注册，旧 HTTP 契约仍由现有测试保持。健康检查使用静态 Schema；业务请求体继续用模块里的固定校验器，不编译外部输入。限流和关闭只作用于单个进程。没有本地登录、PostgreSQL 就绪检查或多副本限流，不能据此宣称生产认证。证据见 [t02-modular-api.md](evidence/t02-modular-api.md)。

- [x] 固化旧文件/偏好/Admin 接口的授权、状态码和密钥脱敏测试。
- [x] 运行 `npm run test:web:integration -- api-compat.test.ts`，新增 API 未实现应 RED。
- [x] 接入 Fastify、可信静态 Schema、错误边界、限流、优雅关闭、ready/live 区分，原型逻辑逐模块迁移而非大重写。
- [x] 运行 legacy + integration + build；所有旧契约保持或明确提供迁移响应。
- [x] 提交 `refactor(web): introduce modular api without contract regressions`。

### T03 本地账号密码、管理员用户管理与服务端会话

**依赖：** T02。**文件：** 拟建 `server/src/modules/auth/{service,routes,passwords,sessions,throttle,csrf}.ts`、`server/src/modules/admin/users/{routes,service}.ts`、`db/schema.ts`、`db/migrations/0001_identity.sql`、`tools/dyoffice/bootstrap-admin.ts`、`test/integration/{auth-session,admin-users,password-reset}.test.ts`。

**接口：** `authenticate(request): Promise<Principal>`、`createLocalSession(userId)`、`verifyPassword(userId,password)`、`revokeSession(principal,sessionId)`、`disableUser(admin,targetId)`；身份稳定键是数据库中的用户 UUID，`(deploymentId,usernameNormalized)` 唯一，不接受外部身份签名/回调。专门设计和接口约束见 [local-account-auth.md](local-account-auth.md)。

- [ ] **T03a，RED：** 先测试用户名归一化/重复、首次 Admin bootstrap 并发、无默认密码、空/弱/泄露密码拒绝、Argon2id 散列独立盐、用户名不存在与错误密码等成本验证、账号禁用拒绝；在尚无服务时记录失败。
- [ ] **T03a，GREEN：** 加 users/user_roles/password_action_tokens/session 表和约束；Argon2id 起始不少于 19 MiB、t=2、p=1（目标主机基准校准）；单因素密码至少 15 字符、允许长短语/Unicode、无强制复杂度规则；交互式一次性 Admin 初始化，生产拒绝默认密码/开发双 Token。
- [ ] **T03b，RED：** 测试登录、登出、`me`、新会话 ID、Cookie `Secure/HttpOnly/SameSite`、CSRF/Origin、重复 Cookie、密码枚举、IP+账号限流、空闲/绝对超时、登录与撤销并发、生产启动守卫；拒绝错误身份不泄漏存在性。
- [ ] **T03b，GREEN：** 实现本地 `POST /api/v1/auth/login`、`logout`、`GET /api/v1/auth/me`、`reauth` 及个人会话查询/撤销；随机会话令牌只在 Cookie，数据库仅保存散列、`auth_version` 与撤销状态；所有敏感请求建立授权 Principal。
- [ ] **T03c，RED：** 管理员创建/停用/恢复账号、修改角色、短期激活/重置 Token 一次性并发消费、管理员再认证、旧会话/API Token 撤销、管理员不可查看用户个人文件；新建账号不自行拥有管理权限。
- [ ] **T03c，GREEN：** 管理员用户列表、开户、激活、停用、角色修改和密码重置；允许用户校验旧密码后修改密码，失效旧会话与写租约；每个账号初始化个人 workspace；管理操作审计，重置令牌不记日志。
- [ ] 以真实 PostgreSQL + HTTP/浏览器运行以上 GREEN、`npm run test:web`、Web 类型/构建门禁、`git diff --check`；提供失败复现、密码哈希资源压力与撤销时延证据；没有真实 DB 记 blocked 而非通过。
- [ ] 提交一系列可独立复核的小 PR：`feat(auth): add password hashing and admin bootstrap`、`feat(auth): add local login sessions`、`feat(admin): manage local accounts and resets`。未完成 T03/T04 不允许生产写入。

### T04 资源授权与 RLS

**依赖：** T03。**文件：** `modules/policy/authorize.ts`、`db/context.ts`、`db/migrations/0002_rls.sql`、`test/integration/ownership-rls.test.ts`。

**接口：** `withPrincipalTransaction(principal, fn)`、`authorize()`；角色不隐式包含文件所有权。

- [ ] 测试 A/B 交叉访问、同池连接复用、异常回滚、Admin 读取他人文件、跨 owner 外键、后台任务错误主体。
- [ ] integration RED；明确以非 owner 应用账号测试，不拿数据库超级用户做假隔离证明。
- [ ] 加作用域过滤、FORCE RLS、事务内身份设置、复合边界约束和默认拒绝策略。
- [ ] 每种入口和 DB 直连策略测试 GREEN；权限缺失按约定返回无泄漏错误。
- [ ] 提交 `feat(security): enforce ownership across api and database`。

### T05 对象存储、上传与个人文件生命周期

**依赖：** T04。**文件：** `storage/{object-store,s3,local-dev}.ts`、`modules/files/{routes,service,validation}.ts`、`db/migrations/0003_files.sql`、`test/integration/files.test.ts`。

**接口：** `stageUpload(principal, fileMeta)`、`finishUpload(principal,uploadId)`、`openFile()`；上传引用绑定所有者。

**状态（2026-11-16）：完成。** 证据见 [t05-local-object-store.md](evidence/t05-local-object-store.md)。四格式、伪 ZIP、空文件、超额、路径穿越、跨 owner、未完成不可下载、中断不留下完成对象、服务器 SHA-256（不信任 ETag）、配额、回收站、共享 blob、过期暂存、HTTP 暂存/完成/下载/丢弃/恢复/清空、进程内 S3 替身，以及 MinIO 上的同一生命周期，都有测试。`dyoffice_files` 只在对象写入成功后插入。`/api/files` 仍是开发令牌原型目录，不是这套存储。

**明确延期：**

- **T04：** `dyoffice_files` 不启用 RLS。应用层 owner 过滤不是 `FORCE ROW LEVEL SECURITY`。
- **运维：** 多节点高可用对象存储不在本仓库的适配器里。CI 的 MinIO 只证明 S3 兼容协议，不是生产集群。

- [x] 测试四格式类型验证、伪 ZIP、空文件、超额、路径穿越、跨用户 uploadId、未完成上传不能下载。
- [x] 运行 files integration，确认没有元数据/对象分离保障时 RED。
- [x] 实现 S3 adapter、不可变对象键、配额、服务器哈希、回收站与受控下载；开发本地盘 adapter 不进入企业 HA。进程内替身覆盖这些行为。数据库 RLS 仍待 T04。
- [x] 同测试 GREEN；模拟上传中断不产生已完成文件，校验内容哈希而非 ETag。
- [x] 提交 `feat(files): add scoped immutable object storage`。

### T06 保存事务、历史版本和单写者租约

**依赖：** T05。**文件：** `modules/revisions/{service,routes}.ts`、`modules/leases/service.ts`、`outbox/service.ts`、`db/migrations/0004_revisions.sql`、`test/integration/revision-commit.test.ts`、`test/unit/save-generation.test.ts`。

**接口：** `commitRevision()`、`acquireLease()/renewLease()/takeoverLease()`；文件修改基于 T01 SaveInput。

**状态（2026-11-16）：** T06 行为已完成，证据见 [t06-revision-commit.md](evidence/t06-revision-commit.md)。保存先写不可变对象，再在单进程账本事务里提交 revision、幂等记录和 outbox；租约有获取、续期、接管和 45 秒过期。DOCX 段落保存走这组接口。实时 PostgreSQL 连接、RLS、多进程和 outbox 投递不在本任务内，原因写在证据页。没有表格编辑。

- [x] 覆盖并发同基线、旧 leaseEpoch、幂等键不同内容、对象成功 DB 失败、响应丢失、旧保存响应覆盖新编辑状态。
- [x] 对应 unit/integration 覆盖上述失败；客户端保存世代测试仍在 `save-generation`。
- [x] 实现 staged object -> 账本 CAS/revision/idempotency/outbox 单事务；冲突保留草稿，接管租约 fencing；恢复历史创建新版本。开发账本代替尚未接入的 PostgreSQL 连接。
- [x] GREEN；两个并发请求仅一条新当前版本；重试返回原 revision；无缺失对象引用。
- [x] 提交 `feat(files): make commits conflict-safe and idempotent`。

### T07 DOCX 原生浏览器纵向闭环

**依赖：** T01/T06。**文件：** 新建 `packages/browser-host/src/files.ts`、`apps/web/src/editors/docs-entry.tsx`、`apps/web/test/e2e/docs-roundtrip.spec.ts`；小范围修改 `apps/docs/src/renderer` 宿主调用与构建入口。

**接口：** `mountDocsEditor(host,element,fileId)`，输出编辑器注册、序列化和选区能力。

- [ ] E2E 写入打开、段落/表格修改、保存、刷新、下载、再次打开和修订/撤销场景。
- [ ] 浏览器测试在尚未接入时 RED，而非以空白预览页算通过。
- [ ] 复用 Renderer/docx-engine，接入 host 字节、字体、worker、剪贴板替代和分页；保留原始未编辑部件。
- [ ] E2E GREEN；受影响 `@genoffice/docs`、docx-engine 回归；外部 Word 兼容样本由 QA 记录证据。
- [ ] 提交 `feat(docs): deliver native docx web editing roundtrip`。

### T08 持久任务、原生 Worker 与沙箱

**依赖：** T04/T06。**文件：** `modules/jobs/{service,routes}.ts`、`outbox/dispatcher.ts`、`worker/src/{main.ts,native/xlsx.ts,sandbox/process.ts}`、`test/integration/jobs.test.ts`、`test/recovery/job-crash.test.ts`。

**接口：** `enqueueJob(principal,type,input): Promise<JobRef>`、`cancelJob()`；输入仅授权 artifactId，输出通过 T06 提交。

- [ ] 测试 enqueue 事务后投递前崩溃、Redis 重建、Worker 丢锁、重复执行、超时、取消、旧版本写入。
- [ ] 对应测试 RED。
- [ ] PostgreSQL 任务/outbox 为权威；BullMQ 调度；任务隔离工作目录、CPU/内存/超时、有限命令 allowlist、禁网默认。
- [ ] GREEN；原生工具被杀不会击穿 API 进程；已提交任务不重复写版本。
- [ ] 提交 `feat(jobs): add durable isolated native execution`。

### T09 XLSX 原生 Web 适配

**依赖：** T07/T08。**文件：** `apps/web/src/editors/sheets-entry.tsx`、`worker/src/jobs/xlsx.ts`、`test/e2e/sheets-roundtrip.spec.ts`；适配 `apps/sheets/src/renderer` 与现有 xlsx-gateway/native 边界。

**接口：** `mountSheetsEditor()`；原生解析/保存输出沿用 T06 RevisionRef，不暴露本机路径。

- [ ] 测试公式而非缓存值、日期/百分比、原始数值及单位、命名区域、图表、批量 AI 撤销、未知部件保留。
- [ ] E2E RED，并保存 fixture 原件哈希。
- [ ] 浏览器复用 Univer 与已有工具；必须的原生操作走 T08，禁止用不同库偷偷替代保真链。
- [ ] E2E 与 `@genoffice/xlsx-gateway`、受影响 sheets/native 回归 GREEN；外部 Excel 复开核验。
- [ ] 提交 `feat(sheets): adapt native workbook editing to web`。

### T10 PPTX 原生 Web 适配

**依赖：** T07/T08。**文件：** `apps/web/src/editors/slides-entry.tsx`、`test/e2e/slides-roundtrip.spec.ts`；适配 `apps/slides/src/renderer`、既有引擎/ops/render 接缝。

**接口：** `mountSlidesEditor()`、选中 slide/element 的结构化上下文。

- [ ] 测试文本框、图片、原生图形、页序、母版关系、可编辑对象以及多步撤销。
- [ ] E2E RED，拒绝截图拼接或 HTML 替代原生 PPTX 的假通过。
- [ ] 复用画布和操作链，隔离字体/预览/导出依赖，接入 T06 保存。
- [ ] 原生下载、重开、上游受影响回归 GREEN，外部 PowerPoint 复开。
- [ ] 提交 `feat(slides): preserve native deck editing in browser`。

### T11 PDF 原生 Web 适配

**依赖：** T07/T08。**文件：** `apps/web/src/editors/pdf-entry.tsx`、`worker/src/jobs/pdf-export.ts`、`test/e2e/pdf-roundtrip.spec.ts`；适配 `apps/pdf/src/renderer`。

**接口：** `mountPdfEditor()`，能力区分阅读、批注、文本修改、页操作和导出。

**状态（2026-11-16）：** 能力门已区分文本页、扫描页和空白页，并报告未嵌入字体与未验证签名，见 [t11-pdf-capabilities.md](evidence/t11-pdf-capabilities.md)。PDF 页签挂载 PDF.js 阅读页，CSP 不允许 eval 或内联脚本；PDFium WASM 对未改动的导出字节做像素重开校验，见 [t11-pdf-render.md](evidence/t11-pdf-render.md)。批注、改字、调页、脱敏仍被拒绝；覆盖文字不是删除原文；加密文件不栅格化。真实改字和批注写入仍延期。不依赖 T07 的 DOCX 挂载，也不走 T08 worker。

- [ ] 测试真实文本流修改、批注、页序、密码文件、签名失效提示、缺字/字体、扫描页能力限制。
- [ ] E2E RED；覆盖文字不等同于删除原文的安全性，脱敏能力单独标记。
- [ ] 复用 PDF.js/PDFium/现有写入链，验证 WASM 和 CSP；不支持操作明确拒绝。
- [ ] E2E、文本提取对比及视觉抽检 GREEN；导出打开后所见与预期一致。
- [ ] 提交 `feat(pdf): implement explicit browser pdf capabilities`。

### T12 工作区、个人偏好与 Admin 全局配置

**依赖：** T04/T05/T07。**文件：** `apps/web/src/{workspace,admin}`、`modules/admin/{routes,service,secrets}.ts`、`packages/browser-host/src/preferences.ts`、`test/integration/settings-boundary.test.ts`、`test/e2e/workspace.spec.ts`。

**接口：** `getPublicSettings()`、`saveGlobalConfig(expectedRevision, patch)`、`updatePreferences()`。

- [ ] 测试模型/媒体/搜索/重排目录、保留省略的 Key、显式清空、版本冲突、退出后旧响应、个人字段注入全局配置。
- [ ] unit/integration/E2E RED。
- [ ] 复用 GenOffice settings/provider 元数据和 UI；加入文件夹、最近、收藏、回收站；密钥加密和轮换，不发送完整 AiSettings 到前端。
- [ ] GREEN；暗色主题不改变文档输出；表单失败保留草稿，保存/测试防重复点击。
- [ ] 提交 `feat(settings): separate personal workspace and global admin`。

### T13 Provider Gateway 与原生助手流

**依赖：** T07/T12。**文件：** `modules/providers/{routes,stream,policy}.ts`、`packages/browser-host/src/ai-transport.ts`、`test/unit/ai-transport.test.ts`、`test/integration/provider-stream.test.ts`；适配各编辑器 `ai/transport.ts`。

**接口：** 兼容原有 `AgentTransport.stream()`，取消句柄与 callbacks 不改语义。

- [ ] 测试 delta/tool-call/usage、截断参数、取消终态只一次、超时、断流、禁用模型、客户端注入 baseUrl/Key、usage 缺失为 unknown。
- [ ] 运行对应 unit/integration RED。
- [ ] 用 POST fetch SSE 适配 Provider；服务端解析权威配置并限额；前端继续使用既有 AgentLoop/Skills。
- [ ] Mock 契约 GREEN 后执行客户允许的真实模型用例；无真实凭据标 blocked，不编造成功。
- [ ] 提交 `feat(ai): bridge existing agent transport through server providers`。

### T14 文档工具策略、审批与修改日志

**依赖：** T06/T13。**文件：** `modules/commands/{service,approval,journal}.ts`、`packages/browser-host/src/tool-executor.ts`、`test/integration/command-state.test.ts`、`test/e2e/ai-edit-race.spec.ts`。

**接口：** `executeAuthorizedTool()`、`approveCommand()`、`getCommandOutcome()`；复用 T01 CommandEnvelope。

- [ ] 测试用户改动后旧选区、审批后换参数、重复 commandId、应用后崩溃、已提交后取消、撤销覆盖后续输入。
- [ ] 对应测试 RED。
- [ ] 注册工具效果和运行位置；审批绑定版本/哈希；维护 unknown_outcome；文档写入按批次预览/撤销，提交调用 T06。
- [ ] GREEN；每个 UI 状态能区分生成中、已应用未保存、已保存、冲突和未知结果。
- [ ] 提交 `feat(ai): make document tool execution reviewable and recoverable`。

### T15 HTTP 数据源与只读 SQL 集成

**依赖：** T04/T08/T12。**文件：** `modules/sources/{routes,service,http,sql,provenance}.ts`、`security/egress.ts`、`test/integration/data-sources.test.ts`。

**接口：** `querySource(principal,sourceId,query): Promise<QuerySnapshot>`；QuerySnapshot 类型在本任务新增到 web-contracts，包含 schema/单位/时区/截断/hash。

- [ ] 测试 sourceId 越权、只读角色、恶意多语句/函数、超时/行限、单位丢失、HTTP 重定向私网/元数据地址。
- [ ] integration RED；必须包含真实测试数据库的权限拒绝，不仅 mock AST。
- [ ] 实现 HTTP JSON 和首个客户连接器；精确 allowlist 支持批准的企业私网；管理凭据保留/更新/测试/删除。
- [ ] 测试 GREEN，错误不泄漏连接密码/SQL 敏感参数；记录真实源权限映射。
- [ ] 提交 `feat(sources): add scoped read-only queries with provenance`。

### T16 附件问答、检索引用与报告闭环

**依赖：** T08/T09/T10/T11/T13/T15。**文件：** `modules/search/{index,retrieve,citations}.ts`、`worker/src/jobs/index-file.ts`、`test/e2e/grounded-report.spec.ts`。

**接口：** `searchAuthorizedFiles()`、`resolveCitation(fileId,revision,locator)`；复用现有 attachments/knowledge-base/document Skills。

- [ ] 测试跨用户索引命中、旧 revision 引用、隐藏给 AI 内容、数值单位、数据截断提示、模型幻造来源。
- [ ] E2E/integration RED。
- [ ] 做按权限检索、引用定位、受控重排和脱敏视图；生成四格式中已支持的产物，归档沿用文件版本服务。
- [ ] 真实“查询 -> 证据冻结 -> 报告 -> 下载 -> 归档 -> 重开”通过；格式渲染与模型正确性分别留证。
- [ ] 提交 `feat(knowledge): deliver grounded document and report workflows`。

### T17 WS 编辑器桥与重连

**依赖：** T06/T14。**文件：** `modules/realtime/{gateway,sessions,dispatch}.ts`、`packages/browser-host/src/editor-bridge.ts`、`test/integration/realtime.test.ts`、`test/e2e/reconnect.spec.ts`。

**接口：** `registerEditor()`、`dispatchToEditor(principal,command)`；消息 schema 使用 T01，不复制新状态机。

- [ ] 测试跨用户订阅、错误 Origin、票据重用、撤销会话、缓冲超限、旧 generation、断线重连重复命令、两页争抢租约。
- [ ] 对应测试 RED。
- [ ] 实现同源 WSS、单次票据、逐消息授权、心跳/缓冲限额；断线后查 journal 再协调，不盲重放写入。
- [ ] GREEN；关闭 WS 后 HTTP 保存和内置模型流仍工作；依赖桥接的能力明确降级。
- [ ] 提交 `feat(realtime): add scoped editor command bridge`。

### T18 出站 HTTP MCP 与全局集成控制

**依赖：** T12/T14/T15。**文件：** `modules/mcp-client/{client,catalog,policy}.ts`、`test/integration/mcp-client.test.ts`；迁移已有 `server/mcp.mjs`。

**接口：** `listAuthorizedRemoteTools()`、`callRemoteTool()`；目录缓存按配置版本/身份范围隔离。

- [ ] 测试连接成功但工具无权执行、恶意工具 Schema、超大响应、超时、取消、密钥更新、配置禁用、SSRF。
- [ ] integration RED。
- [ ] 复用官方 SDK，经版本适配调用；工具 schema 作为不可信数据限制解析，禁止直接注册为 Fastify 动态编译路由。
- [ ] 新旧协议测试服务契约 GREEN；发现工具与执行工具分别验收。
- [ ] 提交 `feat(mcp): secure outbound http tools`。

### T19 入站 MCP、用户 Token 与外部 Harness 控制

**依赖：** T08/T14/T17/T18。**文件：** `modules/mcp-server/{handler,auth,tools,legacy,test-route}.ts`、`test/integration/mcp-server.test.ts`、`test/e2e/harness-control.spec.ts`。

**接口：** `/mcp` 使用共享 ToolDescriptor 和执行服务；`/dev/mcp` 为非标准测试兼容入口；jobHandle 绑定所有者。

- [ ] 测试 A Token 访问 B 文件、只读 token 写入、撤销/过期/错误 audience、旧 session 跨人复用、新版 header/body 不一致、无编辑器、URL Token 生产启动拒绝。
- [ ] integration/E2E RED。
- [ ] 先核查实际 SDK/客户端版本，实施 2026-07-28 主路径及明确支持的 2025-11-25 兼容；标准 Bearer/OAuth，限定 URL 测试 token，禁 stdio/任意路径。
- [ ] 用至少两个实际目标客户端版本跑 read/edit/save/cancel/reconnect；失败记为兼容缺口，不因手工 HTTP 请求通就算 Harness 通过。
- [ ] 提交 `feat(mcp): expose scoped office tools to external harnesses`。

### T20 审计、用量和运营控制

**依赖：** T03/T06/T13/T18/T19。**文件：** `modules/audit/{service,export}.ts`、`modules/usage/{ledger,budget}.ts`、`test/integration/audit-budget.test.ts`。

**接口：** `appendAuditEvent()`、`reserveBudget()/settleUsage()`；审计只留脱敏元数据，业务写与审计意图同事务。

- [ ] 测试并发预算预留、unknown usage、任务重试重复计费、审计写入失败、无权导出、导出脱敏。
- [ ] integration RED。
- [ ] 实现调用/Token/存储/转换用量分类、阈值、管理员成本视图、审计导出及保留策略；不承诺模型费用固定。
- [ ] GREEN；故障不会产生“业务成功但无任何审计意图”的静默空洞。
- [ ] 提交 `feat(operations): add audit and accountable usage controls`。

### T21 企业安全加固与出站数据策略

**依赖：** T09–T20 的相关模块完成。**文件：** `security/{headers,uploads,egress,redaction}.ts`、`worker/src/sandbox/policy.ts`、`test/security/*`、`docs/dyoffice/evidence/threat-model.md`。

**接口：** `evaluateDataEgress(principal,classification,provider)` 在模型/媒体/搜索/MCP/重排统一执行。

- [ ] 写入上传炸弹、恶意关系、SSRF DNS 重绑定、提示词注入、工具越权、密钥包扫描、模型外发标签绕过测试。
- [ ] 跑 security suite 记录 RED 和每个威胁对应修复位置。
- [ ] CSP/净化/限流/扫描/沙箱/出站网络/秘密轮换加固；个人隐私模式可禁用浏览器草稿持久化并说明恢复边界。
- [ ] 全部安全门槛 GREEN；外部渗透测试独立留证，高危未关闭不得放行。
- [ ] 提交 `feat(security): harden enterprise document and ai boundaries`。

### T22 本地账号迁移、用户初始化与数据迁移工具

**依赖：** T03/T04/T12/T20。**文件：** `tools/dyoffice/migrate-state.ts`、`tools/dyoffice/validate-migration.ts`、`deploy/dyoffice/config/local-auth.example.yaml`、`test/integration/legacy-migration.test.ts`。

**接口：** `migrateLegacyState(input,dryRun)`，显式将单用户原型映射到指定用户，绝不自动广播给所有用户。

- [ ] 测试重复导入、缺少旧加密 Key、重名文件、损坏对象、未知 owner、停用员工和 Admin 角色错误映射。
- [ ] migration integration RED。
- [ ] 输出预演报告，原文件/密钥先备份；复制校验而非就地破坏；将旧开发数据显式绑定新本地账号 UUID，不自动生成弱密码，不迁移开发 Bearer Token 为生产登录；管理员一次性开户和停用/session 撤销流程可复核。
- [ ] 核对数量/总字节/hash/归属/凭据状态，第二次运行无重复；恢复原环境演练成功。
- [ ] 提交 `feat(delivery): migrate legacy state into scoped local accounts`。

### T23 可观测性、发布包与部署

**依赖：** T08/T17/T20/T21。**文件：** `deploy/dyoffice/{compose,helm,proxy,config}`、`server/src/observability.ts`、`.github/workflows/dyoffice-web.yml`、`test/integration/deployment-smoke.test.ts`。

**接口：** liveness/readiness、指标、脱敏 trace；版本 manifest 对齐前端/API/Worker/DB/引擎。

- [ ] 测试容器重启、代理 SSE 缓冲、WS Upgrade、只读文件系统、缺少密钥、错误迁移版本、依赖失联。
- [ ] 在全新环境执行部署测试 RED，禁止依赖开发机已有 Electron/字体。
- [ ] 非 root 镜像、多阶段构建、镜像签名/SBOM、Compose 试点包、企业 HA 示例和 offline 制品包；配置外置且无默认密码。
- [ ] 全新环境部署 GREEN；测告警能到达负责人；Compose 明确单点，HA 另按验收矩阵测试。
- [ ] 提交 `feat(deploy): package observable enterprise web runtime`。

### T24 备份恢复、保留策略与升级回滚

**依赖：** T06/T08/T22/T23。**文件：** `deploy/dyoffice/runbooks/{backup,restore,upgrade,incident}.md`、`tools/dyoffice/verify-backup.ts`、`test/recovery/{restore,upgrade}.test.ts`。

**接口：** 恢复清单包含数据库恢复点、对象清单、keyId、镜像摘要、配置版本；脚本只操作授权环境。

- [ ] 测试误删、DB/S3 不一致恢复、KMS Key 缺失、旧 Worker 访问新 schema、升级中断、队列重新投递。
- [ ] 在隔离恢复环境演练，缺少任一依赖应显式 RED，不返回假恢复成功。
- [ ] PostgreSQL 基础备份/WAL、对象版本/副本、独立密钥恢复；expand-contract 迁移、前后版本兼容和恢复点选择。
- [ ] 校验引用对象全部存在、四格式可重开、用户隔离不变、审计/任务不重复；测得 RPO/RTO 达成约定目标。
- [ ] 提交 `feat(recovery): verify backup restore and safe upgrades`。

### T25 全链路验收与容量校准

**依赖：** T09–T24。**文件：** `test/e2e/enterprise-journeys.spec.ts`、`test/load/workload.ts`、`docs/dyoffice/evidence/release-candidate.md`。

**接口：** [acceptance-matrix.md](acceptance-matrix.md) 所有 P0 用例和证据格式。

- [ ] 固化客户脱敏 fixture、真实模型/源/客户端版本、硬件、并发、弱网和 24 小时稳定性场景。
- [ ] 运行完整验收，先记录失败/blocked，不删测试以得到绿色。
- [ ] 修复根因，按冻结版本重复执行；把支持/只读/不支持能力表与 UI 对齐。
- [ ] 安全、文件完整性、模型可用、恢复和关键性能门槛全部达标；未支持项有明确排除，不能排除核心四格式闭环。
- [ ] 提交 `test(release): record enterprise acceptance evidence`；证据必须来自实际执行。

### T26 客户试点、生产上线与移交

**依赖：** T25。**文件：** `docs/dyoffice/evidence/{pilot-uat,production-gate,handover}.md`、客户交付参数清单（不含秘密）。

**接口：** 客户验收、上线回退条件和运维交接按 enterprise-delivery 执行。

- [ ] 建立真实业务基准、负责人、用户清单、数据许可、变更窗口和紧急回退流程。
- [ ] 用 5–20 名代表用户执行至少 10 个工作日试点；记录实际成功率、人工修正和成本，不只收集演示反馈。
- [ ] 关闭 P0/P1；完成培训、管理员操作、恢复和客服演练，形成双方确认的功能边界。
- [ ] 小范围灰度 -> 扩围 -> 生产签收；每阶段核对安全、保存、错误率、成本与支持工单。
- [ ] 交付 release manifest、部署包、手册、证据和已知限制；进入约定保障期，不以代码合并代替交付完成。

## 4. 里程碑、并行安排与工作量

| 门槛 | 必须完成 | 可交付物 | 禁止越级 |
| --- | --- | --- | --- |
| M0 架构可实施 | T00–T04 | 依赖地图、契约、身份/隔离最小验证 | 不导入真实敏感数据 |
| M1 首条闭环 | T05–T08、T12/T13 的 DOCX 路径 | 单用户原生 DOCX + AI + 保存下载 + 可恢复版本 | 不宣传四格式企业可用 |
| M2 四格式工作台 | T09–T14 | 四格式编辑、原生助手、Admin 完整能力目录 | 不以仅预览功能签收 |
| M3 集成闭环 | T15–T20 | 数据源/引用/报告、出入站 MCP、外部控制、审计成本 | 不跳过实际客户端联调 |
| M4 企业候选版 | T21–T25 | 安全、部署、迁移、恢复、容量和验收证据 | 未恢复演练不得上生产 |
| M5 客户生产 | T26 | 试点签收、灰度、交接、支持机制 | 未关闭 P0/P1 不扩围 |

关键路径是 BrowserHost -> 保存一致性 -> 四格式真实写回 -> AI 工具安全 -> 企业验收，不是先上 Kubernetes。T08 可与 DOCX 接入并行；T09/T10/T11 在契约稳定后可分工；企业安全/交付负责人从 M0 参与，不能最后才补权限。

规划假设：2 名编辑器/前端、1 名后端/集成、1 名 QA/自动化，加兼职 SRE/安全及客户业务负责人；预留 20%–30% 的兼容与返工容量。建议按双周迭代管理，完整企业交付的初始预算窗口为 12–20 周，属于排期假设而非承诺，T00 的原生/保真评估后重估。单人配合 AI 可以逐步实现，但不能把生成代码速度等同于兼容测试、客户审批和恢复演练速度。

## 5. 变更与完成定义

每个 PR 必须写明基线、范围、接口变化、迁移影响、失败复现、通过命令/环境、证据位置、剩余风险和回滚方法。职责边界或协议变化增加 ADR；不因工具建议擅自改变用户已确认范围。

任务完成需要代码、测试、可复现证据和文档同步。里程碑完成还需要端到端演示与 gate 审核。企业完成还需要客户环境验收、恢复演练、运营可见性与负责人签收。本次仅编写计划，以上任务没有因文档创建而被标记为完成。
