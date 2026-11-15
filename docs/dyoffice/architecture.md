# DyOffice Web 总体架构与关键契约

> 设计版本：1.0 · 2026-11-15。状态：推荐实施方案，不是已实现或已验收声明。
> 代码核对基线：`95804bd90df3f13f0787c0a1f2d73596bfab3f66`，开发分支 `feat/dyoffice-web`。
> 产品约束以 `../../DYOFFICE.md`、`reuse.md` 为准；任务见 [implementation-plan.md](implementation-plan.md)，交付见 [enterprise-delivery.md](enterprise-delivery.md)。

## 1. 目标、边界与现状

目标是将 GenOffice 改造成可企业部署的 Web 原生 Office 工作区，而不是另造一个聊天工具或报告平台。原生格式只支持 DOCX、XLSX、PPTX、PDF；用户拥有彼此隔离的个人工作区。保留数据源、个人偏好、原生编辑器、AI 面板、工具、Skills、模型 Provider 和 Agent Core。所有全局模型、媒体、搜索、重排、服务凭据、HTTP MCP 与默认能力归 Admin。

企业落地增加身份集成、安全、审计、部署、备份、运维和交付流程，不自动增加团队、组织成员、共享文件夹、团队权限、实时多人协同或 Markdown/HTML 产品入口。部署级隔离是技术边界，不是新的组织产品模型。首批优先企业独立部署；共享 SaaS 的跨企业隔离另有上线门槛。

已核对的源码：

| 现有路径 | 已确认内容 | 不能由此推导的结论 |
| --- | --- | --- |
| `apps/web/server/application.mjs`、`store.mjs`、`mcp.mjs` | Node HTTP 原型、JSON 持久化、个人/Admin Token、配置密文、上传下载、HTTP MCP 发现 | 不是多用户生产后端；不是编辑器闭环 |
| `apps/web/package.json` | Web 原型使用 `@modelcontextprotocol/sdk` 的 `^1.25.0` 依赖声明 | 不能认为已支持新版规范；必须检查 lockfile 与实际行为 |
| `packages/agent-core/src/types.ts`、`index.ts` | `AgentTransport.stream(request, callbacks)`、取消句柄、AgentLoop 和 Skills | 不需要为了 Web 重写 Agent 循环 |
| `apps/docs/src/renderer/ai/transport.ts` | 经 `window.desktop` 对接 IPC | Web 需要替换传输和宿主依赖 |
| `apps/docs/src/renderer/ai/docs-skill.ts` | 文档工具持有 Tiptap Editor、选区和文档状态 | 不能整套直接移入无 DOM 的 Node 服务 |
| `packages/ai-provider/src/index.ts` | 模型、媒体、搜索配置和 Provider 流接口 | 不应删减为一两个兼容端点 |
| `apps/sheets/package.json`、`packages/xlsx-gateway/package.json` | Rust 原生 XLSX 组件、Univer、共享 OOXML 写入域逻辑 | 不能假定所有 XLSX 能力都是浏览器 JS |
| `apps/pdf/package.json` | PDF.js、PDFium、pdf-lib 等依赖 | 需要逐项验证 WASM、字体、导出与浏览器兼容 |
| `packages/cli/src/control-protocol.ts`、`agent-mcp.ts` | 桌面定位/选区协议、外部 Agent 的 stdio 注册逻辑 | 本地 socket、文件路径和 stdio 不能直接暴露到公网 |

GenOffice 上游基线是 `19a389b39be75f611ec21dcda4a7b91a658239d2`。sm PR #245 的历史参考提交为 `beeb717b31e2201cc1e541c54b2f750f606d99e2`；它是管理边界和浏览器适配参考，不是本计划对其最新状态或上线能力的背书。只移植经依赖、许可、测试核对的缺失能力，不导入整个 Python/Agno/团队报告体系。

## 2. 方案比较与最终建议

| 方案 | 优点 | 代价 | 决策 |
| --- | --- | --- | --- |
| 原生 HTTP + JSON 文件继续扩展 | 眼前改动少 | 多用户事务、查询、迁移、审计和恢复难以可靠维护 | 仅保留开发原型和迁移来源 |
| Python/FastAPI 主后端重写 Agent | 便于部分数据处理 | 需跨语言重建现有工具、Provider 和编辑语义 | 不采用；特殊 Worker 可独立引入 |
| Node/TypeScript 模块化单体 + 隔离 Worker | 共用类型与现有包，逐步迁移，部署可控 | 仍需认真拆分浏览器/原生/服务端依赖 | 推荐 |
| 全部 Agent 强制在服务端执行 | 任务持久化集中 | 原生前端工具依赖活跃 Editor，初期重复开发大 | 不作首版前提；仅对已适配的无界面任务使用 |

技术基线：Fastify + TypeScript；PostgreSQL + Drizzle；S3 兼容对象存储；需要持久任务时引入 Redis + BullMQ；React/Vite 复用编辑器；HTTP/SSE 为主要业务与流接口；WS 仅承担确实需要的双向编辑器桥接。使用受支持、与仓库兼容的 Node 版本，先验证现有 `>=22.12.0` 约束，再锁定运行镜像、依赖和原生 ABI，不在本计划中虚构已测试版本。

MinIO 可作为待评估的 S3 实现之一，不成为强制采购或部署前提。企业可使用其已有对象存储。Kubernetes、独立向量数据库、消息总线和微服务拆分均不是 MVP 前提。

```text
浏览器：四格式 Renderer + BrowserHost + 现有 AgentLoop/Skills
  | HTTPS：认证、配置、文件、版本、模型流、任务、审计查询
  | WSS：已打开编辑器注册、远程工具请求、执行回执
  v
Fastify 模块化单体
  Identity / Policy / Files / Revisions / Provider Gateway / MCP Gateway
  Data Sources / Jobs / Events / Audit / Admin
  | PostgreSQL：权威业务状态、幂等记录、outbox
  | S3：不可变文件版本、附件、转换输出
  | Redis/BullMQ：调度、短期通知，不作文件和任务真相源
  v
隔离 Worker：原生 XLSX、渲染/转换、索引、已支持的 headless 工具
```

## 3. HTTP、SSE、WS 的明确分工

### 3.1 不采用“所有操作都走 WS”

HTTP 用于登录、配置、文件上传/下载、保存提交、版本列表、批准/取消、数据源和任务管理。模型单轮流采用 `fetch(POST)` 读取 `text/event-stream`；这样可携带 JSON 请求体、CSRF 信息或标准鉴权头，不依赖原生 EventSource 的接口限制。一次普通 AI 编辑并不天然需要 WS。

WS 用于外部 Harness 或服务端任务向已打开浏览器派发工具调用、定位和选择操作。大文件、完整文档字节、图片和视频不进入 WS；通过 HTTP 上传后传 `artifactId`。前端手工输入在本地文档模型执行，不逐键往返服务端。

WS 不可用时：普通编辑、HTTP 保存和内置 AI 流继续可用；依赖活跃编辑器的远程控制明确显示不可用。首版不同时实现两套完整 WS/SSE 双向总线。需要兼容不支持 WS 的企业网络时，另行建设 HTTP 轮询命令通道，并复用同一命令状态机与验收集。

### 3.2 浏览器模型流契约

拟建：`POST /api/v1/ai/turns`，请求含 `conversationId`、`turnId`、`modelId`、`fileId?`、文档上下文和现有 `AgentStreamRequest`；禁止接收任意 Provider URL、Key 或跨用户标识。服务端校验模型能力、文件授权、输入长度和预算后调用现有 Provider。

事件：`delta`、`tool_call`、`phase`、`usage`、`done`、`error`。客户端适配器映射回既有 `AgentStreamCallbacks`。`cancel()` 中止浏览器流并请求服务端取消，清理后仍保证既有接口所需的终态回调且只发一次。不能把部分工具参数当作完整调用执行。

断线后不自动重新收费调用同一轮模型。通过 `turnId` 查询服务端状态；明确标记已中断、可继续或需重新发起。首版不承诺逐 token 精确续流。Provider 返回的推理字段仅在现有协议确有需要时内部传递，默认不进入审计日志或面向用户的解释。

### 3.3 WS 消息与连接

拟建：`/api/v1/realtime`。浏览器使用同源安全会话，严格校验 Origin；另由带 CSRF 防护的 HTTP 接口发放 30 秒单次连接票据，在首帧提交，5 秒内未认证关闭。长期 Token 不放 URL。每条命令仍校验身份、文件、能力和租约，不能只在握手时鉴权。

消息字段：`protocolVersion`、`messageId`、`type`、`sessionId`、`fileId`、`commandId?`、`baseRevision?`、`editorGeneration?`、`leaseEpoch?`、`seq?`、`payload`。不包含可信的客户端 `userId`；用户和部署身份均从认证上下文取得。编辑会话只在授权后注册，不能订阅猜到的其他用户 session。

建议初始控制值：单帧上限 256 KiB；每连接待发送缓冲上限 1 MiB；25 秒心跳、75 秒存活超时；指数退避重连 1–30 秒并加随机抖动。超限合并可替代的进度事件，不能丢掉提交结果或写命令；无法继续时关闭并要求状态重同步。浏览器 WebSocket 不提供自动背压，需要应用自己限流。[S1]

ACK 只表示收到，`applied_uncommitted` 只表示编辑器改变，只有服务端成功提交新版本才是 `committed`。`seq` 用于去重和检查缺口，不宣称端到端 exactly-once。

## 4. Agent 与工具执行位置

### 4.1 活跃编辑模式

保留原有 AI 面板、AgentLoop、Skills、工具参数、选区冻结、修订和撤销机制。AgentLoop 在浏览器工作；模型网络请求改为服务器 Provider Gateway。文档内工具在 BrowserHost 的编辑器适配器执行；数据源、外部 MCP、媒体、搜索等服务能力通过受控 HTTP API 执行。

前端可以篡改工具声明和上下文，因此服务端从不凭前端“审批通过”字段开放权限。每个服务端工具使用注册表中的可信 Schema、能力限制和独立授权。模型结果是建议，不是授权。

### 4.2 无界面任务模式

仅当某项工具已具备经过测试的引擎级或受控原生实现时，Worker 才执行。复用同一 Agent Core 与工具描述，不另建第二套循环。DOM/选区/画布依赖工具声明 `requiresActiveEditor=true`；不存在可用编辑器时返回 `EDITOR_REQUIRED`，不能静默以文件操作冒充同样语义。

每个 run 固定 `executionMode=live_editor|headless` 和唯一执行负责人，不在断线时偷偷把前端任务迁到 Worker。需要切换时完成暂停、保存基线、权限重验和显式恢复。关闭浏览器后，live run 暂停或取消；真正独立的转换/索引任务才可继续。

### 4.3 工具注册与风险策略

拟建统一 `ToolDescriptor`：`name`、`schemaVersion`、`inputSchema`、`outputSchema`、`executor`、`effect=read|document_write|external_write`、`requiresActiveEditor`、`requiredScopes`、`idempotencyClass`、`maxDurationMs`。UI、内置助手、HTTP MCP 共享描述和领域服务，不共享未授权的入口。

普通文档修改提供预览与一次撤销；批量覆盖、永久删除、对外发送和外部写操作需要独立确认。审批绑定 `commandId + fileId + baseRevision + argsHash + expiresAt`，参数或版本变化立即失效，模型不能批准自己的请求。首版不提供任意 Shell/Node/Python 执行，不把上游 CLI 自由执行工具原样暴露给用户。

## 5. BrowserHost 与四格式适配

拟建 `packages/web-contracts`、`packages/browser-host`、`apps/web/src`、`apps/web/server/src`、`apps/web/worker/src`。这些是计划路径，不是已存在模块。

`BrowserHost` 提供：`open(fileId)`、`readBytes(fileId, revision)`、`stageSave(input)`、`commitSave(input)`、`getCapabilities()`、`getPreferences()`、`createAgentTransport()`、`registerEditor()`、`notify()`；返回统一 Promise 和错误 DTO。暂可用薄层兼容 `window.desktop` 的已使用子集，但禁止 Proxy 把未知方法统一假装成功。每个旧 IPC 标记为浏览器实现、HTTP 实现、Worker 实现或显式不支持。

| 格式 | 主适配路径 | 必须保留 | 明确难点 |
| --- | --- | --- | --- |
| DOCX | `apps/docs` Renderer + docx-engine | 段落、表格、样式、修订、批注、图片、引用定位 | 分页、字体、页眉页脚、跨节布局、未触碰 OOXML 部件 |
| XLSX | `apps/sheets` + xlsx-gateway + 原生服务适配 | 公式、数值、格式、命名区域、图表、工作表 | Rust sidecar 构建/沙箱、公式重算一致性、不把公式变成显示值 |
| PPTX | `apps/slides` + 现有引擎/ops/render | 文本框、原生形状、图片、页面顺序、母版关联 | 字体、关系文件、动画/嵌入对象保留、操作日志 |
| PDF | `apps/pdf` + PDF.js/PDFium 等既有组件 | 页面、文本、批注、页序和下载 | WASM、文本流真实修改、字体、密码、数字签名失效提示 |

先完成 DOCX 纵向闭环，随后逐格式接入，不能用四个静态预览页冒充四格式完成。没有通过浏览器测试的功能置灰/只读并说明原因；不支持的文件可保留原始字节下载。超出四格式的导入入口关闭，但保留为四格式工作流服务的内部依赖。

主题只影响界面，不能改写文档颜色、打印和导出数据；遵守 `CLAUDE.md` 的语义 Token 和 i18n 规则。Office 格式保存、PDF 导出和系统打印是不同能力，分别验收。

## 6. 身份、权限与数据库

企业身份优先对接客户 OIDC IdP，由成熟身份服务提供 MFA；SAML/LDAP 通过身份网关接入，不能在产品中自造简化协议。浏览器使用 BFF 会话和 HttpOnly/Secure Cookie，写请求有 CSRF 校验；外部 Harness 使用最小权限 Bearer Token。开发双 Token 仅允许开发模式，不作为企业登录。

`Principal={deploymentId,userId,roles,scopes,sessionId}` 只由服务端认证建立。部署标识由受信配置/域名绑定得出，不信任自由填写的 Host 或请求体。角色分为普通用户、配置管理员、运维、审计员；管理员可改配置，不默认拥有个人文件读取权。紧急访问需单独授权、限时、理由和全程审计。

拟建关系：

| 表 | 关键字段/约束 |
| --- | --- |
| users / identities | 稳定 UUID；OIDC `(issuer,subject)` 唯一；disabledAt |
| workspaces | `deploymentId,ownerUserId` 唯一；只实现个人工作区 |
| sessions / api_tokens | 会话撤销；Token 仅存哈希、前缀、权限、到期与使用时间 |
| files | 所有者、工作区、格式、当前 revision、大小、删除状态、分类标签 |
| file_revisions / uploads | 不可变 objectKey、sha256、字节数、提交来源、上传状态 |
| edit_leases / editor_sessions | fileId、sessionId、leaseEpoch、expiresAt、editorGeneration |
| preferences / global_configs / secrets | 个人/全局分表；配置 revision；密钥密文及 keyId |
| conversations / ai_runs / ai_turns | 所有者、模式、状态、预算、模型配置版本 |
| commands / approvals / idempotency_keys | 命令状态、参数哈希、审批有效期、去重结果 |
| jobs / outbox / durable_events | 权威任务、事务事件、允许重放的元数据事件 |
| sources / source_bindings / query_runs | 所有者、只读授权、查询快照和来源定位 |
| audit_events / usage_ledger | 脱敏审计、账实核对；缺失 usage 标记 unknown 而非 0 |

个人资源都包含并索引部署/所有者边界，关联采用匹配边界的复合约束，防止跨用户 fileId 关联。应用查询显式带作用域，PostgreSQL RLS 作纵深防护。运行角色不得是 superuser、表 owner 或 BYPASSRLS；必要表启用 FORCE RLS。连接池使用事务内 `SET LOCAL` 注入身份，异常和连接复用测试必须证明不串用户；后台任务也必须用明确的任务主体。[S2]

密钥用独立随机主密钥或 KMS 信封加密，密文关联 deployment/config/provider 的 AAD；有 keyId 和轮换流程。省略新密钥意味着保留；清空须独立动作；读取只返回 hasKey。Admin 配置用 revision/If-Match 防丢更新。Provider 禁用后不能回退到桌面环境变量或其他用户密钥。

## 7. 保存、冲突与恢复：系统正确性核心

### 7.1 不可变版本提交

1. 打开文件时返回 `fileId,revision,sha256,capabilities`，取得写租约。客户端自选的 userId 不参与授权。
2. 浏览器保存捕获 `editorGeneration` 和文档快照；Worker 输出同样生成不可变产物。
3. `POST /files/:id/uploads` 建立有所有者和限制的 staging upload，HTTP 上传字节，服务端验证类型、大小并计算 sha256。客户端声明的哈希不是可信证明；对象存储 ETag 不等同于内容哈希。
4. `POST /files/:id/commits` 携带 `uploadId,baseRevision,idempotencyKey,leaseEpoch,sourceCommandId?`。服务端确认对象完整、所有权、授权和租约，在同一个 PostgreSQL 事务中 CAS 更新当前 revision、插入 revision、幂等记录及 outbox。
5. 仅事务成功才回 `committed`。返回丢失后用同一个幂等键查询/重试返回同一结果；相同键不同 payloadHash 返回冲突。并发基线冲突返回 409，保留本地草稿，不覆盖最新版本。
6. 当快照提交完成时，若用户已继续输入导致 editorGeneration 增长，界面仍为“有未保存更改”，不能把新输入错误标记已保存。

对象存储与数据库不做虚假的分布式原子事务：先完成不可变对象，再原子登记引用。失败对象是可清理孤儿；不能形成指向未完成上传的已提交版本。清理只作用于超过 24 小时、无活动上传、无 revision 引用的 staging 对象；已提交对象由保留策略管理。

### 7.2 单写者而非伪多人协同

首版每个文件一个有效写租约，建议 TTL 45 秒、15 秒续租；第二个页面默认只读或显式接管，接管增加单调 leaseEpoch。旧页面/Worker 即便持有旧锁，也不能提交。Redis 锁不替代 PostgreSQL 的 revision CAS 和 fencing 检查。断网可编辑本地草稿，但没有有效租约不能提交；恢复后先重同步，必要时另存副本。

自动保存默认 2 秒空闲触发、最长 30 秒尝试一次，可由个人偏好调整，但受容量/频率限制。关闭自动保存不等于取消版本控制；开始 AI 写操作前必须有明确的可恢复基线，必要时提示先保存。

### 7.3 AI 与外部命令状态机

`created -> authorized -> awaiting_approval? -> dispatched -> accepted -> applied_uncommitted -> committed`，分支终态有 `rejected|cancelled|failed|conflict|unknown_outcome`。

执行前检查 baseRevision、editorGeneration、leaseEpoch 和审批哈希。相同 commandId 在同一有效状态下不再执行。编辑器应用后崩溃但没有持久回执时，服务端标记 unknown_outcome，不盲目重放写操作；重新读取服务端版本和本地恢复记录，由用户继续、丢弃或重新生成新命令。网络不可靠时保证的是可识别不确定性与提交幂等，不是魔法式的 exactly-once。

撤销分两种：尚未提交时使用原编辑器的撤销批次；已提交后生成一条新的恢复版本，并校验当前 revision。不能让“撤销 AI”覆盖 AI 之后用户的其他修改。取消只阻止后续工作；已经提交的变化需要独立撤销事务。

## 8. HTTP MCP：出站与入站分开建设

出站：DyOffice 助手调用 Admin 配置的 HTTP MCP。入站：外部 Harness 调用 DyOffice 文档能力。已有 `withMcp()` 连通/发现不等于已完成入站服务，也不等于所有工具已经获得安全授权。

入站统一 `/mcp`；按 Bearer/OAuth 主体隔离，而非给每用户启动一个进程。工具参数使用 `fileId/revision` 和显式的应用级 jobHandle，不接受本机绝对路径。MCP Token 不允许当成下游数据源或 Provider Token 透传。

截至本计划核查，官方最新版入口指向 2026-07-28：它移除了协议级 Session 和独立 GET 流，改为自描述请求，新增头/体一致性要求；旧 2025-11-25 行为不能直接套用。[S3] 建立新版主路径和经明确测试的旧版兼容适配，锁定 SDK 实际版本。新路径不以 Mcp-Session-Id 鉴权；旧路径 session 同样绑定身份且每请求重新鉴权。不能用应用 WS 会话去冒充 MCP 协议会话。

长期任务返回受授权约束的 jobHandle；HTTP MCP 的断流/取消按所协商版本规范处理。新规范请求流关闭视为请求取消；明确脱离请求生命周期的任务必须由独立工具显式创建并提供 status/cancel，不能假装断线后请求仍正常完成。

外部调用 live 工具：鉴权 -> 工具策略 -> 目标编辑会话授权 -> 必要确认 -> command journal -> WS 派发 -> 文档提交 -> MCP 返回。没有活跃编辑器时，只有声明具备 headless 实现的工具可执行，其余返回 EDITOR_REQUIRED。

正式环境 Bearer 必须在 Authorization 头中，官方规范禁止把访问令牌放 URI query。[S4] 保留用户要求的 URL Token 测试能力，但只放在隔离的 `/dev/mcp?test_token=...` 兼容路由：开发/测试模式显式开启，最长 5 分钟、限定测试用户与文件、默认只读、可撤销、请求日志去查询串、禁止真实生产数据。它是非标准测试适配，不宣称规范合规；production 模式只要该开关为 true 就拒绝启动。头与 URL 凭据同时存在时拒绝，不做优先级猜测。

## 9. 数据源、附件问答与可追溯报告

个人数据源保留；Admin 管理全局连接器类型、允许的端点和能力。首版先实现 HTTP JSON 数据源与一个客户实际需要的只读 SQL 连接器，StarRocks 作为候选而非默认已具备。客户端只能提交已授权 sourceId 和受约束查询，不任意填写网络地址。

只读不靠提示词或 SELECT 前缀：数据库只读账号 + 表/视图范围 + AST/语句策略 + 参数绑定 + 连接网络限制 + 查询超时。建议初始限制为 15 秒、10,000 行、10 MiB 结果、每用户 2 个并发；限制可经 Admin 受控调整。禁止多语句、DDL/DML、未批准函数、外部文件/网络访问。HTTP 数据源和 SQL 接入都必须验证真实用户授权，不能借全权限服务账号扩大数据范围。

每次查询登记 sourceId、queryHash、参数、时间、schema、单位、时区、截断状态、结果哈希和不可变快照。冻结本次分析证据后生成报告，数值保留原始精度与单位，不通过 AI 任意缩放。引用定位绑定 fileId+revision+页/段/工作表/单元格；旧版本失效时显示版本信息，不跳到现版无关位置。

全文检索与附件问答先做授权过滤，再检索与重排；重排后和打开引用时再校验。索引、缓存和会话历史按所有者隔离。文档内的“隐藏给 AI”不自动约束原始文件读取/CLI/MCP：存在隐藏区域时，AI 使用脱敏视图；无法生成安全视图的 headless/MCP 工具拒绝执行，不泄漏原件作为补偿。

若交付包含查询到报告的流程，必须真实完成“授权查询 -> 引用/单位核验 -> 可编辑文档生成 -> 下载 -> 归档 -> 再次打开”；接口 mock、构建成功或上游测试不能替代这条验收。

## 10. 安全、任务和可观测性边界

所有 Provider、MCP、数据源、图片抓取与 OAuth 元数据请求共用出站策略：公共部署默认拦截 loopback、link-local、云元数据、非批准私网和非 HTTP(S)；企业私网资源通过精确端点/端口 allowlist 放行，逐跳检查重定向与 DNS，结合网络层 egress 控制，不能“一禁私网”导致企业数据库不可用，也不能全开私网。[S5]

上传除扩展名外还校验实际结构、ZIP 条目/展开大小、路径穿越、资源预算；隔离解析与恶意内容扫描；外部关系默认不抓取；文档脚本不执行。Web 主体启用 CSP、HTML/Markdown 展示净化、依赖扫描。Fastify 路由 Schema 是受信应用代码，不把外部 MCP 返回的任意 Schema 直接交给动态编译链。[S6]

任务状态存 PostgreSQL，业务事务与 outbox 同写；dispatcher 投递 BullMQ，Worker 以 jobId+阶段结果哈希去重。Worker 丢锁可能重复执行，所以每一步尤其写文档步骤必须幂等；不可重复的外部操作需要人工确认未知结果。[S7] Redis 丢失后从权威状态重建安全任务，不能重新执行已提交或结果不明的外部写入。

日志串联 traceId/requestId/runId/commandId/fileId/revision，但不记录密钥、全文、原始模型上下文、数据库密码或 URL Token。监控请求延迟、保存冲突/失败、AI 流中断、任务重试、原生进程内存、存储积压、审计写入失败和成本。Admin 写配置、下载、MCP 执行、密钥轮换与紧急访问有脱敏审计记录。

## 11. 必须禁止的捷径

不能以图片/HTML 预览代替原生编辑；不能用共享管理员 Token 模拟多用户；不能把 userId 参数当认证；不能让 WS ACK 表示保存；不能在断线时自动重复 AI 写入；不能把 PostgreSQL、S3、Redis 说成一个原子事务；不能把完整 CLI/stdio 公开；不能以已支持 Provider 名称推断企业密钥可用；不能把单机 Compose 标成 HA；不能把运行备份脚本等同于完成恢复演练。

## 12. 外部核查依据

下列官方文档于 2026-11-15 核查；具体版本在实施任务 T00 中锁定，不随 latest 链接自动升级。

- [S1 MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)：浏览器接口背压限制。
- [S2 PostgreSQL Row Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)：owner/BYPASSRLS 与 FORCE RLS 边界。
- [S3 MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)：新版传输、取消和兼容要求。
- [S4 MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)：Bearer、受众验证、禁止 URI query 令牌。
- [S5 OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)：出站请求防护。
- [S6 Fastify Validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)：受信 Schema 与验证边界。
- [S7 BullMQ Idempotent Jobs](https://docs.bullmq.io/patterns/idempotent-jobs)：重试和幂等。
- [S8 OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)：Origin、逐消息鉴权和安全日志。
