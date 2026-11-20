# DyOffice：从 Web 原生 Office 到企业落地的完整开发计划

> 版本：1.0 · 2026-11-15
> 状态：方案与可执行任务已编制；产品实现、测试和企业验收仍需按计划完成。
> 仓库：`ClassesOver/DyOffice`；实施分支：`feat/dyoffice-web`。
> 编写时核对的代码基线：`95804bd90df3f13f0787c0a1f2d73596bfab3f66`。

## 1. 阅读入口

| 文档 | 解决的问题 | 主要读者 |
| --- | --- | --- |
| [architecture.md](architecture.md) | 后端选择、HTTP/SSE/WS、Agent 执行位置、宿主接口、权限、保存一致性、MCP 和数据源契约 | 架构师、开发、安全 |
| [local-account-auth.md](local-account-auth.md) | 本地用户名密码、管理员账号管理、Argon2id、服务端会话、密码重置和 API Token | 后端、开发 Agent、安全、企业实施 |
| [ADR-0001](adr/0001-local-account-password-auth.md) | 已确认的不接 OIDC、采用本地账号密码的架构决策及变更门槛 | 架构师、开发 Agent、审查人员 |
| [implementation-plan.md](implementation-plan.md) | T00–T26 共 27 个任务；代码路径、依赖、接口、失败测试、验证、提交与里程碑 | 开发、Codex/其他开发 Agent、QA |
| [enterprise-delivery.md](enterprise-delivery.md) | 页面与业务场景、客户调研、私有部署、本地账号管理、安全、迁移、备份、灰度、运营和商业交付 | 产品、实施、客户、SRE |
| [acceptance-matrix.md](acceptance-matrix.md) | 四格式/身份/AI/MCP/数据源/恢复的验收场景、性能目标、发布门槛和证据模板 | QA、安全、业务验收人 |
| [assistant-background.md](assistant-background.md) | 首页频道分享、后台 DOCX 读取的部署与接入 | 开发、QA、运维 |
| [reuse.md](reuse.md) | 既定的 DyOffice 最大复用方向及全局 Admin 范围 | 所有参与者 |

建议先读本页，再读架构；实施时同时打开任务与验收矩阵；企业交付负责人从第一阶段就参与，不等开发完再补安全和运维。

## 2. 产品目标与不可改变的范围

DyOffice 是基于 DyOffice 的网页版原生 Office 工作区：用户能编辑真实 DOCX、XLSX、PPTX、PDF；AI 能理解文档、提出或执行受控修改；文件可以保存、下载、回滚、追溯；外部 Harness 可以通过用户授权的 HTTP MCP 使用同一套能力。

延续 `../../DYOFFICE.md` 和 reuse.md 的已确认要求：

- 最大复用四个原生编辑器、Agent Core、Provider、工具、Skills、偏好和文件生命周期；sm PR #245 只作浏览器接入/管理边界参考。
- 个人工作区隔离，不建设团队、组织成员、团队权限或多人协同产品。企业部署和身份运维不改变这条边界。
- 保留个人数据源与偏好；模型、媒体、搜索、重排、服务凭据、HTTP MCP 和默认能力统一由 Admin 管理。
- 只开放 DOCX/XLSX/PPTX/PDF；不开放独立 Markdown/HTML 编辑入口；不提供用户任意 stdio/Shell 执行。

本计划新增的技术栈、性能目标、工期窗口和企业运维默认值是推荐设计，不冒称用户已逐项确认。真正签约的 SLA、容量、保留期限和服务边界由试点测量及客户交付参数冻结。

## 3. 深入复核后的关键决定

### 3.1 后端：模块化单体，不先微服务化

Node.js/TypeScript + Fastify，PostgreSQL 管理权威数据，S3 接口管理文件，按需引入 Redis/BullMQ 和隔离 Worker。保持 DyOffice 的 TypeScript 技术资产；不另建 Python/Agno 主后端，不为“企业版”直接增加 Kubernetes、向量数据库和一套自研 AI 循环。

企业优先独立部署，S3 实现可用客户现有服务。MinIO 是候选实现，不是必须使用的产品。资源规格和并发能力用基准压测验证。

### 3.2 通信：HTTP 为主，SSE 与 WS 各有职责

HTTP 管理登录、配置、文件字节、保存、版本和任务；POST fetch SSE 适配既有模型流；WS 用于外部 Harness/服务端与活跃编辑器的双向工具控制。内置 AI 不必为了 Web 化而强制走 WS。

WS 断线后手工编辑、HTTP 保存和普通 AI 流应继续可用；依赖编辑器桥的功能明确不可用。WS ACK 不是文件保存，保存必须以服务端版本事务为准。

### 3.3 Agent：复用不等于整套搬去后端

源码中 DOCX Skills 持有真实 Editor、选区和文档状态。因此活跃文档的 AgentLoop/文档工具先保留在浏览器，服务端托管秘密、Provider 请求、策略与持久化。只有已完成引擎级适配的 headless 工具才运行在 Worker。两种模式用同一个 Agent Core，且每次 run 有唯一执行负责人。

### 3.4 正确性：版本事务、幂等与不确定结果

文件先上传不可变对象，再通过 PostgreSQL CAS 提交 revision、幂等记录和 outbox。单文件单写租约 + fencing + baseRevision 共同防止旧客户端覆盖。AI 修改与用户输入并发时校验 editorGeneration。发生“已应用但回执丢失”时记录 unknown_outcome，不盲目重放写入。

### 3.5 MCP：区分调用外部服务和被外部调用

现有 HTTP MCP 连接/工具发现只是出站基础，不等于入站文档服务。入站 `/mcp` 按用户 Bearer/OAuth 授权，共用工具注册和执行服务。官方 2026-07-28 规范已改变协议会话/流语义，必须锁定 SDK 并验证新旧客户端，不能把旧版连通当新版兼容。

用户要求的 URL Token 测试保留为隔离的非标准测试路由：短期、限定测试用户/文件、默认关闭、production 开启即拒绝启动。正式访问令牌必须在 Authorization 头，不进入 URL。

### 3.6 企业完成：产品、系统和交付都要验收

企业就绪不仅是构建成功，还包括本地账号/密码管理、管理员开户与停用、会话安全、隔离和外发策略、真实模型与数据源验证、可恢复文件、可观测成本、安全扫描、备份恢复演练、灰度回滚、客户 UAT 和运维移交。单机 Compose 不能宣称 HA；没有恢复演练不能宣称备份可靠。

### 3.7 身份方案变更：仅用本地账户密码

用户已明确取消 OIDC/Keycloak/SSO 接入，使用 DyOffice 自带的账号密码管理：管理员创建/停用账号与重置密码，用户通过用户名密码登录自己的工作区，后端持久化独立的服务器会话；外部 Agent 仍使用由用户发放的最小权限 Bearer Token。已有开发双 Token 原型不得直接用于企业生产。实施和安全验收以 [本地账号认证专项设计](local-account-auth.md) 为准；T03、T22 和验收矩阵已同步修改。

## 4. 当前事实与开发增量

仓库已有 Web 原型、个人/Admin 基础界面、Token 边界、配置加密、四格式导入下载、部分偏好、HTTP 数据源配置和官方 SDK MCP 连接/工具发现。仓库说明明确：原生浏览器编辑、AI 编辑链、版本流程和真正多用户企业后端尚未完成。

本计划不是从零重写引擎，而是完成宿主适配、领域边界、用户隔离、事务、持久任务、集成和企业交付。代码事实与证据路径见 architecture.md 第 1 节。本次没有运行四格式浏览器完整验收、真实模型/源、性能或恢复测试，验收记录初始全部为 not_run。

## 5. 推进顺序

| 阶段 | 主要产出 | 放行依据 |
| --- | --- | --- |
| M0 架构可实施 | 依赖/工具清单、共享契约、身份与隔离 | 真实边界测试，不是框图评审 |
| M1 首条闭环 | DOCX 打开、AI 修改、保存、下载、重开 | 文件与版本一致性；失败恢复明确 |
| M2 四格式工作台 | XLSX/PPTX/PDF、完整个人/Admin、原生助手 | 每格式真实原生编辑验收 |
| M3 集成闭环 | 数据源/引用报告、出入站 MCP、WS 桥、审计成本 | 真实源/模型/目标 Harness 全链路 |
| M4 企业候选版 | 安全、部署、迁移、压测、恢复、回滚 | 企业验收矩阵和冻结版本证据 |
| M5 企业生产 | 客户试点、灰度签收、培训、交接与支持 | 业务、安全、技术、运维共同放行 |

建议团队为 2 名编辑器/前端、1 名后端/集成、1 名 QA，配合兼职 SRE/安全及客户业务负责人。完整交付的初始规划窗口 12–20 周，预留 20%–30% 兼容与返工容量；这是规划假设，T00 后校准，不是开发工期承诺。AI 可加速编码，不能代替真实 Office 兼容、客户网络接入和恢复演练。

## 6. 最大风险与应对

| 风险 | 影响 | 首要应对/负责人 |
| --- | --- | --- |
| Renderer 深度耦合 Electron | Web 功能不完整或为了移植大改上游 | T00 IPC 清单和逐格式接缝，编辑器负责人 |
| XLSX 原生组件/字体/平台差异 | 保存或展示在客户环境失败 | 锁定 ABI/字体、沙箱镜像与外部复开，原生/QA |
| 双标签、AI 与人工同时编辑 | 静默覆盖/丢失内容 | CAS、租约 fencing、generation、冲突保留，后端/编辑器 |
| MCP 新旧版本差异 | 外部 Harness 连接通但执行失败 | 官方 SDK 版本矩阵与真实客户端联调，集成负责人 |
| 个人数据经模型或搜索外发 | 隐私/客户准入失败 | 分类策略、受控 egress、脱敏与审计，安全负责人 |
| JSON 原型迁移和密钥丢失 | 文件/配置不可恢复 | dry-run、哈希清单、独立密钥恢复、演练，交付/SRE |
| 企业代理阻断 WS/SSE | 流式交互或远程控制失效 | 真实网络测试、分通道降级，不影响文件保存，交付 |
| 模型质量或费用不可预测 | 错误报告/不可控成本 | 证据冻结、数值验证、人工审阅和预算并发控制，产品/QA |
| 只测 mock 不测真实服务 | 演示可用而客户不可用 | blocked 不算通过，生产 gate 强制真实证据，QA/业务 |
| “企业级”范围无限扩张 | 交付延期且维护负担增加 | 个人工作区与四格式边界冻结，额外需求单独变更评估，产品 |

## 7. 交付物和签收标准

交付代码与测试、部署镜像/配置、迁移工具、密钥与配置管理说明、SBOM/NOTICE、用户/Admin/运维手册、支持矩阵、验收原生输出、性能与恢复证据、已知限制、事故和升级回滚手册、客户 UAT 和交接记录。所有制品可追溯到同一个 commit/镜像/schema/config 组合。

成功是用户在自己的权限内完成真实业务，并且发生故障后能恢复和解释；不是创建了多少接口、多少工具或多少页面。各任务/验收必须填写真实结果，不能因为文档存在就标完成。

## 8. 维护规则

范围/关键协议变更写 ADR 并同步四份文档；每个 PR 附测试命令、实际结果、兼容性、迁移和回滚说明。实测目标与计划假设分别记录；不把历史上游或 sm 的成功记录写成 DyOffice 新宿主已通过。

本轮只增加这些计划文档，不修改产品代码、不重写既有 reuse.md、不自动创建生产配置或部署资源。后续实施以 T00 开始，先建立可以证明每一步正确的工程基线。


## 9. 当前代码实施进度（2026-11-16）

以下内容是 2026-11-16 的历史快照；当前 Web SaaS 进度以第 10 节为准。

以下进度只代表实际提交，不等于里程碑完成或企业可用：

| 工作 | 当前状态 | 证据 |
| --- | --- | --- |
| T00 浏览器依赖边界与宿主盘点 | 部分实现；完整四格式适配审计待完成 | [宿主清单](inventory/host-dependencies.md) |
| T01 BrowserHost 和 Agent SSE 客户端契约 | 基础契约/适配器已提交；尚未接入真实编辑器 | [T01 记录](evidence/t01-browser-host-checkpoint.md) |
| T02 版本化 HTTP 与模块化 API | 默认开发 Token 入口已切到模块化 Fastify；独立 local 实验工厂另行挂载 Cookie/RLS API，均拒绝 production | [模块化 API](evidence/t02-modular-api.md) · [local 接缝历史](evidence/t02-fastify-checkpoint.md) |
| T03 模块化账号、会话与管理员接口 | `.mjs` 服务及可选 `buildApp({ localAuth })` 已实现；默认开发文件入口仍用 Token，尚未接入账号 RLS | [T03 收口](evidence/t03-closeout.md) · [模块化 T03c](evidence/t03c-account-lifecycle.md#modular-auth-runtime) |
| T03 local 实验账号与会话 | `.ts` API、真实数据库/浏览器检查点已实施；完整账号 UI 与生产未开放 | [T03a](evidence/t03a-account-bootstrap.md) · [T03b](evidence/t03b-local-sessions.md) · [local T03c](evidence/t03c-account-lifecycle.md#local-experimental-runtime) |
| T04 local 受限连接与隔离 | 专用数据库的 auth/business 连接、工作区/偏好 FORCE RLS、撤销写入顺序及权限检查已实施；文件、版本和任务见其所属模块 | [T04](evidence/t04-rls-checkpoint.md) |
| T05 对象存储与上传 | 默认开发入口的对象生命周期与 local 实验入口的 PostgreSQL/S3 配额和文件 API 分别实现，不共享账号或元数据 | [开发对象存储](evidence/t05-local-object-store.md) · [local T05a](evidence/t05a-object-storage.md) · [local T05b](evidence/t05b-file-lifecycle.md) |
| T06 保存、历史与租约 | 默认入口使用单进程账本；local 实验入口使用 PostgreSQL 事务、CAS、幂等回执与租约 fencing | [开发保存](evidence/t06-revision-commit.md) · [local 保存](evidence/t06-revision-transactions.md) |
| T07 DOCX 浏览器挂载 | 默认入口提供段落编辑器与原始工作区 shell；local 实验入口可显式启用原始 Docs 渲染器，完整四格式与外部 Word 验收未完成 | [开发挂载](evidence/t07-docs-browser-mount.md) · [local 原生 DOCX](evidence/t07-native-docx.md) |
| T08 local 原生任务 | PostgreSQL/BullMQ、Linux/systemd 受限 XLSX 执行及事务输出已有历史验证，显式实验开关启用；不等于生产或完整四格式完成 | [T08 闭环](evidence/t08-docker-free-closure.md) |
| T07–T26 企业完整交付 | 尚未验收；各模块实测与完整交付范围分别记录 | [任务列表](implementation-plan.md) 与 [验收矩阵](acceptance-matrix.md) |

默认开发入口中，DOCX 已能在浏览器中编辑并保存段落文本。保存先写入不可变对象，再由单进程版本账本提交基线、租约和幂等记录；PostgreSQL 表形在迁移 `0004_revisions.sql`，当前进程不连接数据库做版本提交。这不是完整 Docs 功能。XLSX、PPTX、PDF 仍只导入下载。既有单用户 Bearer + JSON 文件原型不允许用于生产。新客户端不得把 AI 写入或四格式原生编辑显示为已支持。

两套账号数据库、迁移日志和 bootstrap 命令必须区分，见 [运行配置](../../apps/web/README.md#runtime-and-database-boundaries) 和 [认证现状](local-account-auth.md)。`server/db/migrations` 与 `server/src/db/migrations` 保留各自版本与校验和，不重编号已应用迁移，也不自动导入对方数据。local 实验库必须专用；两种 Web 入口均拒绝 production。表中的证据是各提交的历史结果，不是本次合并新增的验证声明。

## 10. Web SaaS 当前实现快照（2026-11-20）

本节按当前分支源码与本轮实际测试更新，不把已合入 PR 或浏览器构建视为企业验收。当前分支包含 Web 四格式实现合并提交 `55a1022b`，本地另有未提交的共享助手工作区改动；本轮新增修复尚未提交。

| 格式/边界 | 当前代码能力 | 尚未闭环 |
| --- | --- | --- |
| DOCX | 原生浏览器编辑器、版本保存、共享 Office 助手；写作工具按编辑权限开放 | 客户样本与外部 Word 复开矩阵、完整格式兼容及恢复验收 |
| XLSX | 原生工作簿编辑、服务端保存适配器、共享 Office 助手 | 公式/图表/外部 Excel 兼容的完整样本验收、性能与恢复门槛 |
| PPTX | 原生幻灯片编辑与版本保存。共享助手支持图表编辑、生成整套和重做单页，生成页可写入当前草稿并撤销 | 母版、嵌入对象和客户样本的完整兼容验收，以及真实模型发起生成后的保存和复开 |
| PDF | 原生 GenOffice 编辑器和共享助手已接正文改写、批注、表单、页面操作及脱敏副本；浏览器用例核对了保存后重开和历史原件 | 签名结构、XFA 和既有密码文件的只读边界已通过浏览器回归；客户样本、签名有效性与正式环境仍待验收，F04 不标记通过 |
| 身份与部署 | 本地账号、隔离和版本服务已有独立实现与历史集成证据；默认开发入口仍是开发令牌 | 两个 Web 启动入口都拒绝 `NODE_ENV=production`；生产部署、备份恢复、客户 UAT 未验收 |

本轮用独立 PostgreSQL 库复现并修复了 PPTX 风格模板迁移后的 SaaS 启动失败。业务角色的权限声明现与迁移授权一致，模板行级权限同时检查当前会话。迁移、角色与个人数据集成 9 项通过，PPTX 接口与服务集成 12 项通过，共享模型与 SSE 网关集成 26 项通过。模型调用使用测试替身。Web 主测试 433 项通过、1 项跳过，Web 单元测试 798 项通过、4 项跳过。真实 Chromium 的助手界面在 320、360、400 像素及浅色、深色组合下通过了交互检查，任务执行使用测试适配器。

DOCX/XLSX/PPTX/PDF 均已接共享助手，并在 Chromium 与隔离 PostgreSQL 验证刷新后接回原 Harness 对话及保存重开。各格式实际工具、真实模型和 Harness 的测试范围见 [SaaS 对齐验收记录](saas-only-decoupling.md)。模拟 SSE、单次真实模型连接和本地健康检查都不能替代正式环境与客户样本验收。F01–F04 与 Release Gate 保持未通过状态。
