# Office harness 编码链路与离线分析环境实施证据

日期：2026-11-17。工作树：`/home/junge/.codex/worktrees/c0bf/DyOffice`；分支：`feat/assistant-harness-collaboration`。

## 已实现

- PR #132 最新 head `415c38f5` 已通过合并提交 `fd68a721` 整合；保留 PR 0023–0026 迁移，将本分支 Skills、个人模型依赖迁移顺延为 0027–0028。没有对运行中的业务数据库执行迁移。旧本分支实验数据库若曾使用另一迁移顺序，不可直接覆盖摘要升级。
- 统一 harness registry：内置 Codex 与可信服务端注册的外部 adapter 使用相同身份、coding 能力、选择、容量和取消接口；origin 只作元数据。默认 coding 候选为 Codex。
- Web Docs/Sheets 只追加可选 delegation Skill，保留原 AgentLoop、所选主模型、原文档工具和保存路径。没有 CLI 启动或模型调用，直到 Office 模型决定委派。
- 编码请求附带 Office 本轮模型 ID；运行中修改模型选择器不会切换当前委派，下次新 run 才采用新模型。
- Codex 使用任务独有的本机 Responses 适配代理；代理转换为现有个人模型网关的 chat 请求。上游地址、模型、密钥解密、DNS/TLS 固定和预算仍由原 provider pipeline 管理。Office 对话与 coding 各有执行容量，但访问同一用户、同一模型配置版本的预算账户；每轮推理使用独立 turn ID。
- Codex 不读取用户原配置或独立登录，只有临时代理凭据。shell 不继承模型密钥或 Office 服务配置；权限 profile 允许 minimal 平台文件、当前任务读写、Codex 安装包和分析 venv 只读。无 sandbox 降级；不支持进程组隔离的平台拒绝该编码任务。
- 取消/超时终止任务进程组，TERM 后 KILL，测试覆盖持有 stdout 的顽固孙进程。每次任务最终清理 scratch 目录。
- Python 3.12 分析运行包：46 项直接依赖；当前 Linux x64 构建出 77 个 wheel。uv.lock、requirements.lock、离线构建/安装/验收脚本纳入源码，生成 wheel/venv 不入 Git。
- 内置 harness 默认发现 `.dyoffice-analysis-build/runtime/bin/python`，也接受服务端 `DYOFFICE_ANALYSIS_PYTHON`。venv 只读；`PIP_NO_INDEX=1`、`UV_OFFLINE=1`，绘图和缓存仅写任务目录。
- `npm run build:saas` 同时生成 `.dyoffice-analysis-build/harness-data.mjs`。仅构建数据助手可用 `npm run build:harness-data-helper`，离线 Python 仍按独立分析运行时安装。缺少数据助手时，任务在启动 Codex 前报告 `HARNESS_DATA_HELPER_UNAVAILABLE`。

## 已验证

- 101 项 Office 客户端、委派、运行器、provider、PR #132 数据源/实时桥相关回归通过；275 项 agent-core 测试通过。
- 模型适配桥新增 7 项测试通过，覆盖固定主模型、每轮新 turn、额度错误无完成/无重试、custom tool 历史、未授权工具、大小/continuation 限制及取消。
- server、browser contracts、Web Docs、Web Sheets、Web shell 的 TypeScript 检查通过；Docs/Sheets 构建通过（有既有大 chunk 提示）。
- 真实安装的 Codex CLI 0.169.0 + 真实权限沙箱 + 确定性模型输出：两轮调用经 Office bridge 执行并校验 Python，未使用独立模型登录。此项不是上游真实模型验收。
- 真实沙箱验证同级任务 sentinel 不可读，当前任务可写。
- 离线环境严格 `--offline --no-index --require-hashes` 安装，禁用索引和有效网络代理；77 包一致性及 6 项真实数据分析测试通过；socket/DNS 被测试阻断。覆盖 pandas/Polars/DuckDB、统计、图表、Excel/Parquet 和 SQL。损坏安装锁在安装前被拒绝。
- 真实 Codex 沙箱使用只读分析 venv 执行 pandas、DuckDB、SciPy、Parquet 和 PNG 图表；输入和计算在 harness 中，不经 Office 模型中转。

## 待交付与限制

- 统一数据分析完整设计见 `docs/superpowers/plans/2026-11-17-unified-harness-data-analysis.md`。外部邀请/频道头像、双向主动委派与持久任务断点恢复尚未实现，不能视为全功能完成。
- 普通 coding 仍收集有界文本；显式 dataInputs 的分析任务只回传摘要与服务端确认的提交收据，禁止自动收集下载数据。图表、代码和报告通过 artifacts.stage/commit 持久保存后提供 owner 附件下载。
- 不等于附带离线大模型。分析计算和依赖安装可离线；推理需要可达的 Office 模型网关或已配置的本地模型。
- 原 PR 冻结结果仍有 1MB/10k 行等边界；该环境不扩大数据库授权或查询限制。
- 上游真实模型端到端验收未完成。用户提供的凭据未写入源码、计划或发布配置；不能将本机确定性模型验收当成该服务已验证。
- 采用隔离 PG17 测试实例通过共享额度及个人模型 4 项、持久产物及来源覆盖 5 项真实测试。原 PG16 不满足既有 MAINTAIN 检查，未修改生产断言绕过限制。

## 统一数据计划并行实施增量

- Office 工具新增元数据发现 `list_agent_data`，委派可带显式 `dataInputs`；内外部使用同一 task grant、受控查询、冻结文件下载和产物提交。
- 任务凭据短期有效，记录随机凭据摘要；每次操作重新认证原会话，跨 owner、task、超范围资源、退出、取消及到期均拒绝。只有原登录凭据保存在服务端，adapter 只收到 task bearer 和可选受限模型代理能力。
- CLI 客户端校验 raw download SHA-256 与原 snapshot 语义 SHA-256，原子发布且拒绝覆盖已有文件。CLI/helper 使用同一实现。
- 产物通过0029迁移的4张FORCE RLS表保存归属、暂存预算、幂等提交收据；对象存储复用现有ObjectStore。真实PG17 5项产物测试通过，覆盖重建服务后持久读取、跨owner/旧claim/注销、列权限、文件数/16MiB额度及不确定上传。
- Office/coding 共用额度真实验收已由主线程复跑：三轮共消费同用户/同模型账户30单位，第四次coding在上游派发前拒绝；原个人模型权限3项同时通过。
- 数据路由支持限时 bearer，不转发用户Cookie。Office产物下载使用原会话/RLS、attachment + sandbox + nosniff。只接受服务端确认的delivery，不信任adapter自报收据。
- Linux Codex的禁网seccomp也禁止Unix connect。因此内置采用任务私有文件mailbox承载HTTP请求/响应，由服务端复用相同app.inject路由；没有平台分析执行器，不扩大shell网络权限。传输和路由单元测试通过，真实Codex完整数据闭环由主线程复跑通过。详见 `unified-harness-data-analysis.md`。
- 本轮已运行的相关回归：100项中97通过、3项真实CLI按环境跳过；随后将真实CLI与数据闭环单独启用验收。Web Docs和服务端类型检查已通过；最终结果见新增统一数据证据。
