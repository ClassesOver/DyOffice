# 内外部 harness 统一数据处理与分析实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 用户已要求拆分任务并行推进；只对文件所有权独立、接口已确定的任务并行。步骤用 checkbox 跟踪，不能把计划或模拟验收标成真实功能完成。

**Goal:** 内置与外部 harness 使用同一套任务、取数、分析、产物交付流程，完整负责数据处理和数据分析；Office 负责目标、授权、调度与原有文档交付。

**Architecture:** 复用 Office 现有 AgentLoop、统一 harness 注册表、PR #132 的受控数据源工具与冻结结果、文件存储及 T17 通知通道。在这些能力外补任务级授权、统一数据客户端和产物清单；内外部 harness 均调用此客户端。计算在 harness 的运行环境中进行，不在 Office 模型或服务端新增分析执行器，不使用 MCP。

**Tech Stack:** TypeScript、现有 Fastify/PostgreSQL/RLS/ObjectStore、现有 CLI、Python 3.12、锁定的 Python/SQL 分析库、uv/pip wheelhouse、Node test runner、既有集成测试。

**Spec:** 本文件设计契约；频道身份与双向任务沿用 [Office harness 协作总计划](2026-11-17-office-harness-collaboration.md)。本文件是总计划的数据子计划；如旧文将中间分析交给 Office 模型，以本文件的最新用户要求为准。

## 1. 约束和当前状态

- 数据处理、数据分析全部交给 harness：SQL 编写、清洗、关联、类型转换、缺失值处理、统计、建模、图表、结果校验均在其职责内。
- Office 助手只理解业务目标、选择授权范围、委派、追问、接收交付物并调用原文档工具。它不逐行接收数据、不执行分析代码、不重新计算 harness 的中间结果。
- Office 服务端只做认证、授权、执行受控查询、冻结/运输数据、验证上传结构和保存产物；不引入 pandas 服务、Notebook 服务、第二套计算引擎或另一套 AgentLoop。
- harness 可以编写 SQL 将筛选、关联或聚合下推到已授权数据源。数据库执行 SQL，harness 决定和校验分析逻辑；这不意味着平台可以放宽只读策略。
- 内外部 harness 平级：同一 task grant、数据操作、产物格式、取消和幂等规则。`origin` 只影响生命周期、运行位置和传输适配，不决定数据权限。
- 内置 Codex 的模型推理复用 Office 本轮选中的模型配置和同一账户额度账本。外部 harness 可使用自己的模型；只有显式授予模型代理能力时才允许经 Office 额度调用，不向其发放上游密钥。
- 数据查询限制和模型额度分别执行。不得因为模型额度充足就扩大数据行数/查询时长，也不得另建一份默认无限的 coding 额度。
- 接入是增强功能：缺依赖、harness 离线、任务失败、额度耗尽不改变原有 Office 模型选择、文档编辑、保存与取消路径。
- 不把数据源连接串、密码、Office 登录 Cookie、原模型密钥交给任何 harness；内置也没有例外。
- 数据内容、列名、文件名和外部报告都是不可信数据；不能成为新增权限或任意命令的来源。
- 仅受控查询和本地数据计算可完全无网执行。Codex 推理仍需要已配置模型端点可达，或部署已验收的本地模型；“离线分析环境”不等于附带离线大模型。

截至 2026-11-17 的实施事实：PR #132 最新提交 `415c38f5` 已通过合并提交 `fd68a721` 整合进功能分支；PR 的 0023–0026 迁移保留，Skills/个人模型迁移顺延为 0027–0028。统一注册表、Office 决策委派、懒启动 Codex 和 coding 结果回传已有工作树实现；共享模型桥、离线分析运行包与只读挂载已实现并通过相应验收，完整真实额度账本验收单独记录。任务级授权、统一 HTTP 数据客户端与任务本地传输、元数据发现与委派范围、产物暂存/原子提交/下载已接入工作树。真实 PG17 共享账本验收通过：Office 与 coding 三轮合计消费同账户 30 单位，第四轮预算拒绝且无上游派发。完整外部邀请、频道头像、持久任务重领与外部主动委派 Office 仍待交付。

## 2. 复用清单与实际边界

2026-11-17 补充进度：频道邀请/审批、内外部头像、持久任务、防重复执行及外部反向只读委派已有实现和相应测试，前述“仍待交付”状态由本段更新。内置 Codex 与外部 harness 的统一数据客户端和授权服务已实现，网络频道成员与 task claim 绑定的数据授权入口现已接通：只有 Office 明确附加的 sourceIds/resultIds 可被领取者兑换；成员自身不能附加或继承范围，取数前后复核 live claim。真实 CLI adapter 冻结下载、外部计算、产物提交与 owner 下载已通过；具体证据见 `docs/dyoffice/evidence/assistant-channel-data.md`。新成员不会因加入而自动获得数据权限。头像与频道任务不扩大数据权限。完整 Office 编辑器 E2E 与真实上游模型验收仍单独跟踪。

| 现有资产 | 复用内容 | 需要补齐的最小能力 |
|---|---|---|
| `packages/agent-core/src/coding-skill.ts` | Office 自主决定委派；结果返回原循环 | 任务增加数据引用及交付物要求；不把数据行塞进 `context` |
| `apps/web/server/src/modules/coding/registry.ts` | 平级 adapter、选择、独立容量、取消 | 统一数据分析能力声明和 task grant 绑定 |
| `modules/sources/tools.ts` | `sources.list/describe/query/read_result/save_result` | 通过任务授权入口复用，收窄到本任务资源；不能直接把浏览器会话 token 发给 harness |
| `modules/sources/service.ts`、`sql-policy.ts` | 既有身份、数据源分配、只读 SQL/网络策略 | 每次操作叠加任务范围，保持原限制 |
| `modules/sources/results.ts` | 只执行一次查询、冻结结果、读分页、下载、保存收据 | 任务输入引用与下载令牌；明确 pending 到期处理 |
| `packages/web-contracts/src/source-results.ts` | typed schema、单位、时区、哈希、截断证据 | 用于统一 data manifest，保持原哈希语义 |
| 文件 API、ObjectStore、上传/提交与存储额度 | 保存报告、表格、代码和图表 | 按任务上传与原子产物清单，不能冒充文档修订提交 |
| 原 CLI 注册与 JSON 输出协议 | 为不同 harness 提供同一数据客户端 | 增加 `data`/`artifacts` 子命令；不建立另一套 CLI 项目 |
| T17 实时连接与重连协调 | 小型状态、进度、任务可取通知 | 只传元数据；数据文件走 HTTP，不挤入 WS 消息 |
| `tools/analysis-runtime/` | Python/SQL 依赖锁、wheelhouse、离线验收 | 在内置 runtime 中显式绑定；外部可装同一包或声明兼容版本 |

冻结结果不是全量导出能力。当前每次源查询默认 1,000 行、最多配置 10,000 行，响应上限 1,000,000 字节；SQL 默认语句超时 5 秒，HTTP 请求超时 10 秒。冻结结果单份上限 1,000,000 字节，pending 默认 15 分钟、最多 8 份/8 MiB；saved 最多 64 份/64 MiB。`read_result` 每页最多 1,000 行，只读取已经捕获的结果，不能找回被截断的行。

首期不修改这些上限。harness 必须检查 `truncated`、行数、单位和时区；截断输入不能支撑“全部数据总计”等结论。它可以在同一授权范围内重新设计有界聚合查询；需要真正大规模导出时另行实现可恢复分块导出，不能循环分页源查询或拼接不同时间的结果假装一致全量快照。

## 3. 统一流程

1. 用户给出分析目标，Office 将目标、数据范围、输出要求、期限和已有结果引用提交为一个任务。目标可以是“分析季度毛利变化并给出图表”，不是 Office 已经生成的一串 pandas 操作。
2. 服务端为任务分配 agent、claim、scope 与短期 task grant；内置进程和外部连接器走同一个逻辑入口。
3. harness 用统一客户端查看获准数据源及结构，自主决定查询方案；需要扩大数据范围时发出补充授权请求。
4. harness 调用受控查询。服务端执行既有授权/只读/超时/行数校验，返回冻结 `resultId` 与元数据，不将结果行送回 Office 模型。
5. harness 按 `resultId` 将 canonical JSON 下载到自己的任务目录，核验结果哈希、schema、单位、时区及截断标志。内置与外部都通过下载客户端；不能给内置开放“直接读业务数据库”的捷径。
6. harness 用 Python、DuckDB/SQLite 或其兼容工具完成处理与分析，生成代码、报告、图表和必要的派生表；中间文件只存在任务工作区，不逐步回传 Office 模型。
7. harness 上传产物并提交 manifest，报告每项结论对应的输入引用、分析代码与校验结果。平台验证文件、大小、哈希、任务归属及收据，不用 Office 模型重新执行分析。
8. Office 接收摘要和产物引用，可询问业务含义或要求 harness 补充分析；插入/保存文档继续走原工具及原写入边界。上传成功不等于打开的文档已经保存。

### 3.1 同一授权与数据入口

协议层使用任务凭据，而不是 harness 自报 `ownerId`。服务端绑定：部署、owner、conversation、task、agent membership、claim/epoch、资源范围、到期时间和操作集合。每次数据操作、下载、上传、完成任务都重新确认当前 claim、撤销状态和原用户权限。

数据 scope 是可访问范围的上界，不能扩大现有源分配权限。任务可授予源集合或冻结结果集合；固定结果任务不自动获得源查询能力。`sources.list` 也必须过滤到任务范围，避免泄露同账户其他源名称。结果 ID 是标识，不是访问凭证。

内置通过服务端内部派发领取同样的 task grant，外部在频道邀请激活后领取。认证传输可由适配器承担，操作契约与授权策略不得按 `builtin/external` 分叉。外部断线重新领取执行 claim 时，旧 epoch 立即失效。

### 3.2 拟议公共契约

以下展示完整目标契约；当前实现以源码为准，尚未提供持久 AnalysisTaskSpec/重领。已提供 task grant、数据操作和交付收据，放入 `packages/web-contracts/src/harness-data.ts`，复用 `WorkspaceSourceResultArtifact`，不重复定义其哈希语义。

```ts
interface AnalysisTaskSpec {
  taskId: string
  goal: string
  inputs: {sourceIds: string[]; resultIds: string[]}
  outputs: {report: boolean; charts: boolean; code: boolean; tables: boolean}
  modelPolicy: 'office-shared' | 'agent-owned'
  deadlineAt: string
}
type HarnessDataOperation =
  | 'sources.list' | 'sources.describe' | 'sources.query'
  | 'results.get_manifest' | 'results.download'
  | 'artifacts.stage' | 'artifacts.commit' | 'tasks.complete'
interface AnalysisInputRef {
  resultId: string
  sha256: string
  sourceId: string
  sourceVersion: number
  queryHash: string
  rowCount: number
  truncated: boolean
}
interface AnalysisArtifactRef {
  artifactId: string
  name: string
  mediaType: string
  sizeBytes: number
  sha256: string
  role: 'report' | 'chart' | 'code' | 'table' | 'validation'
  inputResultIds: string[]
}
interface AnalysisDelivery {
  taskId: string
  claimId: string
  connectionEpoch: number
  commandId: string
  summary: string
  inputs: AnalysisInputRef[]
  artifacts: AnalysisArtifactRef[]
  runtimeManifestSha256: string
  limitations: string[]
}
```

`AnalysisTaskSpec.inputs` 是服务端验证后的有效范围，不能直接接受 Office 模型任意自报的 owner、workspace、URL、目录或下载目的地。owner会话凭据不进入任务DTO；HarnessDataGrant仅携带限任务的短期随机凭据。客户端下载到调用方明确选择的任务目录；服务端只接受结果/产物 ID，不接受宿主文件路径。

### 3.3 文件与分析可复查性

- 输入默认 canonical JSON；schema 保留精确数值表示、单位、时区、null 和文本类型。转换成 Parquet/CSV/Excel 由 harness 编写代码并记录转换，不由平台静默转型。
- 产物至少提供报告、实际运行代码、输入引用和校验记录；图表可以为 PNG/SVG，交互 Plotly HTML 自带 JS。SVG/HTML 通过附件下载或隔离预览展示，不能直接注入应用 DOM。
- 代码及结果均不可信。平台验证哈希与归属，不因 `validation.passed=true` 就断言业务结论正确；报告必须区分“harness 声明”与平台已验证的文件/来源事实。
- query snapshot 的 `sha256` 与产物原始文件字节哈希不是同一概念。分别标识并沿用 snapshot 规范，不能把下载字节散列误当现有 snapshot 哈希。
- 完成任务前确认所有列出的上传均已持久化。未完成上传不生成成功 manifest；产物 commit 使用固定 `commandId`，响应丢失时查询该命令收据，不重复上传/保存。
- 不自动永久保存全部中间数据。为可复查性必须保留的输入证据在任务有效期内按原冻结结果保存接口保存；这占原工作区额度。pending 即将到期而尚未保存时，任务先续作/保存授权流程或报告输入过期，不能悄悄重查源覆盖输入。
- 已提交的报告、代码、图表不随临时目录删除；取消仅清理未提交暂存物。任务上传与输入保存权限在建任务时说明，不新增重复的人工确认环节；文档修改仍沿用既有权限/审批。

### 3.4 内外部传输差异

| 环节 | 内置 harness | 外部 harness | 相同约束 |
|---|---|---|---|
| 领取任务 | 服务端启动适配器 | 已配对连接器领取 | task grant、claim、scope、期限 |
| 取数 | 统一客户端写任务目录 | 同客户端写外部任务目录 | canonical snapshot、授权、哈希、限额 |
| 分析 | 固定离线 Python runtime | 同包或经能力检查的自有 runtime | 代码、依赖与验证清单 |
| 模型 | 当前 Office 模型代理 | agent 自有，或显式授权 Office 代理 | 不泄露 Office 原始密钥 |
| 回传 | 客户端上传产物 | 相同上传协议 | 存储额度、幂等、来源、完成收据 |

本地传输可以优化文件复制，但优化必须实现同一个数据客户端接口，仍执行同一授权与校验，不能传业务库连接或任意路径绕过入口。首期先使用相同 HTTP 语义，验证正确后再优化。

## 4. 离线分析运行环境

依赖由 `tools/analysis-runtime/pyproject.toml`、`uv.lock` 和带哈希的 requirements 锁管理，使用 Python 3.12。构建时下载目标平台 wheelhouse；安装时只允许 wheelhouse、固定版本和校验哈希，不访问索引、不从源码构建、不临时安装“模型需要的包”。

覆盖范围：numpy/pandas/polars/pyarrow；DuckDB/SQLite、SQLAlchemy/sqlglot/sqlparse 与 PostgreSQL/MySQL 客户端；scipy/statsmodels/scikit-learn/sympy；matplotlib/seaborn/Plotly/Pillow；CSV/JSON/Parquet/Excel 和常见文档读写、日期/单位/编码、报告输出及校验工具。库覆盖以实际锁文件和离线导入测试为准，不承诺任意 Python 包都预装。数据库驱动供离线文件或经授权场景使用，不代表允许 harness 绕过 Office 直连业务数据源。

内置 runtime 在任务启动时挂为只读，工作目录可写；`PATH` 指向该 venv，缓存/临时目录指向任务目录，`PYTHONNOUSERSITE=1`，不继承用户 site-packages。每个任务不复制整套依赖。外部发布自己的 runtime capability manifest；缺必需库时提前报告，Office 可改派已满足能力的 peer。

图表离线必须可渲染：matplotlib 使用无显示器后端与随包字体；Plotly HTML 嵌入 JS，不依赖 CDN；不把需要首次下载 Chromium 的导出流程作为默认路径。不加入大模型权重、Torch/CUDA 或外部在线服务依赖来冒充“丰富分析库”。

运行环境 manifest 记录 Python、OS/arch、依赖锁 SHA-256、wheel 文件哈希和离线验收结果；产物引用它。不同平台分别构建，Linux wheelhouse 不宣称兼容 Windows/macOS。离线验收必须切断包索引并屏蔽外网，完整跑数据读写、DuckDB 查询、统计、PNG 和 HTML 输出，不能只证明 `import` 成功。

## 5. 文件职责和实施任务

新增文件名是本计划约定；若既有模块已有同职责，优先扩展并在实施记录中说明替代，不复制第二套框架。

### 任务 A：冻结公共契约与路由边界

**Files:** 新增 `packages/web-contracts/src/harness-data.ts`、`apps/web/test/unit/harness-data-contract.test.mjs`；更新原协作契约和 `coding-skill.ts` 的委派参数。

**Consumes:** 既有 task/claim 身份、`WorkspaceSourceResultArtifact`。**Produces:** `AnalysisTaskSpec`、`AnalysisDelivery` 和统一操作定义。

- [ ] 先测试内外部样例使用相同 DTO；拒绝任意 owner、凭据、URL、宿主路径及未知字段。
- [x] 加入有界 source/result 引用；摘要只带引用，不携带 rows。交付物要求暂随 instruction，未新增结构化 outputs。
- [ ] 将 coding/analysis capability 区分为能力声明，保持统一 `run`/取消接口和原普通 Office 请求形状。
- [x] 运行契约测试、Agent 核心与浏览器类型检查；审查是否不必要地扩展了原只读工具白名单。

### 任务 B：统一任务级数据授权

当前实现使用有界内存 task/claim（epoch 固定为 1）；撤销/过期/退出立即失效，服务重启后不能恢复任务。成员邀请与新 epoch 重领仍依赖总计划，不标作已完成。

**Files:** 新增 `apps/web/server/src/modules/coding/data-access.ts`、`apps/web/test/local-integration/harness-data-access.test.mjs`；扩展总计划的成员/任务授权模块。

**Consumes:** 已验证 membership/task claim、owner 权限、scope。**Produces:** 不含用户原会话凭据的 `HarnessDataAccess` 操作上下文。

- [ ] 先测试 cross-owner、cross-task、旧 epoch、撤销、到期和超范围源/结果均不可读。
- [x] 让内置和外部领取相同逻辑 task grant；每次操作重新校验 claim 与原始权限。
- [x] 对 `sources.list/describe/query` 叠加任务过滤，调用原源服务，不改 SQL 限制和凭据库。
- [x] 验证固定 result-only grant 不能反向查询数据源，猜到 resultId 也不能越权。
- [x] 运行 PostgreSQL/RLS 集成测试；不能用 mocked token 测试替代权限验收。

### 任务 C：冻结结果文件传输和统一客户端

**Files:** 新增 `apps/web/server/src/modules/coding/data-routes.ts`、`packages/cli/src/harness-data.ts`、`apps/web/test/local-integration/harness-data-transfer.test.mjs`；扩展既有 CLI registry。

**Consumes:** 任务 data access 和原冻结结果服务。**Produces:** `office data` 等既有 CLI 下的子命令；内外部相同语义客户端。

- [x] 验证查询一次、重复冻结下载不重查、截断元数据保留；到期与撤销后拒绝新操作。已开始的响应按既有服务超时结束，不宣称逐字节中断。
- [x] 将 canonical JSON 写入调用方任务目录并核验原 snapshot 哈希；不在 Office 模型/SSE/WS 返回 rows。
- [ ] 提供元数据与下载命令；大字节内容走有界 HTTP，状态走原实时通道。
- [x] 原子落盘，失败不留下看似完整的数据文件；重试下载同一 resultId，不能自动重新执行 SQL。
- [x] 用同一验收脚本分别连接内置本地适配器和独立外部测试进程，比较输入字节和元数据。

### 任务 D：离线 Python/SQL 依赖包

**Files:** `tools/analysis-runtime/pyproject.toml`、`uv.lock`、`requirements.lock`、构建/安装/验收脚本和 README；`.gitignore` 仅忽略构建缓存。

**Consumes:** Python 3.12 与目标平台。**Produces:** 可重建 wheelhouse、只读分析 venv、runtime manifest 和离线验收证据。

- [x] 锁定直接与传递依赖，导出带哈希 requirements；为目标平台产出完整 wheelhouse。少数仅发源码包的依赖只在联网构建阶段构建 wheel，离线目标不编译。
- [x] 实现 wheelhouse 构建与严格无网安装；包缺失/哈希不符必须失败，不回退到 PyPI。
- [x] 在禁网环境完成 JSON/CSV/Excel/Parquet 读写、DuckDB join/聚合、统计及 PNG/自包含 HTML 图表验收。
- [x] 验证无显示器、无用户 site-packages、无临时 pip 安装也能运行；记录体积与完整依赖版本。
- [ ] runtime 交付失败只使分析 capability 不可用，不阻断 Office 启动与原有功能。

已交付证据：46 项直接依赖、77 个平台包；离线六项分析验收通过。真实 Codex 权限沙箱内完成 SQL/统计/Parquet/PNG，且验证 venv 不可写。见 `docs/dyoffice/evidence/assistant-harness-coding.md`。

### 任务 E：harness 数据分析运行接入

**Files:** 扩展 `modules/coding/harness.ts`、`registry.ts` 和统一数据客户端；新增 `apps/web/test/unit/harness-analysis-runtime.test.mjs`。

**Consumes:** 任务 spec、统一 data client、runtime manifest。**Produces:** 在独立任务目录运行的分析 agent；没有平台分析引擎。

- [ ] 先测试两种 origin 获得相同数据操作与相同有界输入；内置不能读取他人任务目录。
- [x] 注入任务凭据和数据客户端使用说明，绑定只读分析 runtime/PATH；不继承宿主密钥与业务配置。
- [x] 提示 harness 自主取数、核对截断/单位/时区并执行分析；Office 只给目标和允许的数据范围。
- [ ] 验证取消终止全部任务进程和未完成传输；临时目录清理不删除已经提交产物。
- [x] 验证模型桥每轮走当前 Office 模型与原额度账本，余额不足不启动新推理；原 Office 会话仍可独立结束/取消。

### 任务 F：可持久化分析产物与回传

**Files:** 新增 `modules/coding/artifacts.ts`、`artifact-routes.ts`；复用文件/ObjectStore 模块；新增 `apps/web/test/local-integration/harness-analysis-artifacts.test.mjs`。

**Consumes:** 原文件存储、上传额度与 `AnalysisDelivery`。**Produces:** 二进制产物、来源清单、原子完成收据。

- [x] 先测试二进制及文本产物在退出任务后仍可读；错误哈希、越权 ID、超额和路径注入均拒绝。
- [x] 实现暂存、哈希校验、manifest commit；相同命令幂等，不同内容复用 commandId 拒绝。
- [x] 持久化输入引用、runtime 锁哈希、代码、校验和限制说明；保持 snapshot 哈希与文件哈希语义分离。
- [x] 测试响应丢失后只查收据，不重复保存；取消保留已提交产物、清理未提交暂存物。
- [x] 不把原 snapshot JSONB 表当任意派生表/大文件仓库；不虚构 Office 修订或保存收据。

### 任务 G：Office 交付与恢复

**Files:** 扩展既有 Docs/Sheets 任务展示和工具结果；复用聊天队列、T17 与原文件保存，不新增模型面板。

**Consumes:** 任务事件、摘要和 artifact references。**Produces:** 来源可查的分析交付、显式文档写入与可恢复任务状态。

- [ ] 先测试长分析不清空用户草稿、不切换原模型、不锁住编辑/保存；关闭协作后原功能可用。
- [ ] 显示 harness 身份、任务状态、报告/图表/代码引用、数据截断与限制；数据行不进 Office 模型。
- [ ] 外部离线时保留任务和已提交结果；重连协调 claim/收据，不重放查询或保存命令。
- [ ] 文档插入使用原工具和权限；上传报告与保存文档分别记录结果。

### 任务 H：真实闭环与回归证据

**Files:** 新增 `docs/dyoffice/evidence/unified-harness-data-analysis.md`；增量扩展既有 native Docs/Sheets 测试。

- [x] 相同数据任务分别由内置 Codex/Python/DuckDB 和外部 Node fixture：取数 → 冻结下载 → 处理 → 图表/报告/代码上传 → 服务端交付收据。Office UI 插入/保存仍另验。
- [x] 输入/输出、模型/额度、依赖 manifest、任务和产物收据完整留证；模型模拟、网络模拟和真实测试分别标明。
- [ ] 验证截断输入不会宣称全量结论；pending 到期不会静默重新取数；旧 task/epoch 结果不混入新聊天。
- [ ] 外网关闭但模型端点可达时运行完整任务；纯数据脚本在完全无网下通过。两种离线验收分别记录。
- [ ] 原模型选择、文档读取/编辑/保存/取消、数据源管理和 T17 相关回归通过后再宣称交付。

## 6. 并行安排与完成标准

本轮实际并行：统一授权及真实权限验收、数据客户端/CLI/内置传输、产物服务/迁移/回归审查；主线程负责公共契约、Office 元数据发现、路由及服务装配。B 依赖 A；C 依赖 B；E 依赖 C+D；F 在 A 确定后可与 B/C 并行；G 依赖 E+F；H 是最终集成。每项任务独占文件范围，跨模块接口先由集成人确认后变更，避免不同 worker 写出两套数据入口。

完成定义：同一任务规范与客户端能驱动内外部 harness，所有分析发生在 harness，平台只履行数据与权限职责；分析文件可持久化并可追溯，离线依赖有实际运行证据，原 Office 功能不因增强功能改变。仅交付计划、通过 import 测试、临时目录里生成图表、或外部 adapter 能返回字符串，都不满足此完成定义。

## 7. 当前可调用接口与未完范围（实施增量）

- Office 的 `list_agent_data` 仅列出数据源/冻结结果元数据；`delegate_agent_task` 可附 `dataInputs:{sourceIds,resultIds}`。任务边界内没有源权限时无法反向查询源。
- 数据客户端：`genoffice data execute <operation> --args <json>`、`data manifest <resultId>`、`data download <resultId> --out <file>`。授权通过 `OFFICE_HARNESS_DATA_URL`、`OFFICE_HARNESS_TASK_ID`、`OFFICE_HARNESS_DATA_CREDENTIAL` 注入，不出现在命令行参数。
- 同一 HTTP 语义：`POST /api/v1/agents/tasks/:taskId/data/execute` 和 `GET /api/v1/agents/tasks/:taskId/data/results/:resultId/content`。只接受 task bearer。内置 Linux 沙箱经任务专属文件 mailbox 转发到相同 HTTP 路由，外部经 HTTPS；shell 保持禁网。CLI 可选 Unix socket 传输仅用于允许本地连接的环境；Linux 默认禁网沙箱的 seccomp 会拒绝 connect，因此服务端内置默认只装配 mailbox。
- `artifacts.stage` 接受有界 base64 文件、文件名/类型/角色、来源 ID 和文件摘要；`artifacts.commit` 注入服务端 owner/claim 并核验冻结来源，固定 commandId 幂等提交。产物使用独立 16MiB/owner 预算（每任务最多12文件、每文件8MiB），不占用 Office 文档修订路径。
- Office 通过 `GET /api/v1/agents/deliveries/:commandId` 查询已提交收据，通过 `/api/v1/agents/artifacts/:artifactId/content` 下载附件；文件始终以附件并附 sandbox/nosniff，HTML/SVG 不直接插入 DOM。
- 外部 adapter 仅收到 task grant 和受限模型桥的打开能力，不收到原用户 Cookie/上游密钥。可信收据由服务端附回 Office，忽略 adapter 自报的 delivery。
- 尚未实现：频道邀请/头像、外部主动委派、持久任务/epoch重领、后台重连恢复、结构化输出需求、专用产物展示面板、全量导出及扩大原冻结数据限制。

真实闭环最终证据见 [统一数据验收](../../dyoffice/evidence/unified-harness-data-analysis.md)：主线程已复跑 PG17 真实授权与双 origin 数据闭环，3 项全部通过、无跳过；上游模型仍为确定性夹具。

构建与验证限制：完整 CLI 的既有跨包 TypeScript 错误尚未处理；新 data/client/helper 已做定向类型检查。mailbox 目录由任务可写，其磁盘/文件数仍依赖宿主任务资源限制，本实现不新增 OS 磁盘配额。
