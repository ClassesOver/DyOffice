# Office 助手：看表、查数与 Coding 实施计划

> **执行方式：** 使用 superpowers:executing-plans 按任务执行；每项用复选框记录验证结果。

**目标：** 用户在同一个 Office 对话中发现有权访问的表和字段、得到有口径的查询结果，并能让 Python 针对刚才的结果计算或画图。

**架构：** Office 负责理解问题、查结构和发起只读查询，数据源服务负责授权、执行和冻结结果。Coding 通过现有任务授权读取指定快照，Office 在收到执行结果后解释结论或展示产物。不增加连接器、数据库表或第二套执行器。

**技术栈：** TypeScript、Fastify、PostgreSQL、AgentSkill、现有 Coding harness、Node test 和 Playwright。

**设计依据：** 本次对话及下列全局约束；现有接口语义见 [工作区数据源工具](../../dyoffice/evidence/workspace-source-tools.md)，已有委派设计见 [统一分析执行计划](2026-11-17-unified-harness-data-analysis.md)。

**验收状态：** 本地实现和四种编辑器验收已完成，真实模型在 Word 的完整流程已通过。数据连接使用独立页面，目录与表支持发现和勾选。启用、回退及客户 StarRocks 的待验收条件见[验收记录](../../dyoffice/evidence/office-assistant-source-analysis.md)。

## 全局约束

- 默认关闭直接源访问。已有 `metadata-only` 仍只列名称和标识；新增显式 `read-only-analysis` 才给 Office 提供看表、查数和分批读取本次结果的工具。这里的模式约束 Office 直连工具；用户在工作区手动查询、显式授权给外部成员等既有产品入口有独立权限，不用这个开关替代它们。
- 以会话确定工作区，使用现有只读源账号、可见表范围、查询限额、结果过期和截断规则。查询产生临时快照，但本期不向 Office 开放永久保存结果、修改源库或配置连接的工具。
- “核对刚才的结果”传 resultId；“刷新”才重新查询。核对按月汇总的快照只能验证汇总后的计算，不能当作独立核对订单明细。
- 不预加载全库元数据，不将 DSN、凭据、原始明细放入委派提示。工作区数据将发给当前选定的 Office 模型；沿用既有请求大小限制，按需返回表、字段和有界预览。
- 顺序：任务 1 → 2 → 3 → 4。各任务先跑新增失败断言，再改实现，最后跑对应回归；不要提交工作树中已有的其他修改。

## 任务 1：服务端声明并执行同一套工具权限

**位置：** `apps/web/server/index.mjs`、`apps/web/server/src/app.ts`、`apps/web/server/src/modules/providers/{gateway,shared-gateway}.ts`、`packages/web-contracts/src/assistant.ts`。沿用现有 `modules/sources/tools.ts` 和 `assistant-catalog.ts` 的两种后端能力。

- [ ] 先扩展 `apps/web/test/local-integration/assistant-source-catalog.test.mjs`，并在单测中覆盖 personal/shared 网关、无 format 和四种 format。配置矩阵：未设置 → 没有直接源工具；metadata-only → 只有 sources_list；read-only-analysis → 只有下列四项；未知配置 → 启动失败。伪造请求添加未开放工具也不能传给模型。
- [ ] 沿用环境变量 `DYOFFICE_ASSISTANT_SOURCE_CATALOG`，不改变已部署值。新增明确的能力字段，兼容只有 `sourceCatalog: true` 的旧服务端和只读旧字段的客户端。只有工作区工具可用且有可用模型时才宣告分析能力。契约建议如下：

  ```ts
  type AssistantSourceMode = 'off' | 'metadata-only' | 'read-only-analysis'
  // 新客户端遇到旧响应：true 解释为 metadata-only，不解释为分析。
  const directAnalysisTools = ['sources_list', 'sources_describe', 'sources_query', 'sources_read_result'] as const
  ```

- [ ] 从同一个契约生成浏览器和两个网关的名称集合。检查 `scopeAssistantRequest` 的 format 分支：与服务端允许集合取交集，不能因为有 sources_list 就推断有 query，也不能改变文档编辑或委派权限。metadata-only 继续使用原来的元数据端点。
- [ ] 运行（仓库根目录）：`node --import tsx --test apps/web/test/{unit,local-integration}/assistant-source-catalog.test.mjs`。集成测试需要 `DYOFFICE_TEST_DATABASE_URL` 指向可创建临时数据库的 dyoffice_test 测试实例。退出码 0、无跳过且上述矩阵通过才进入下一项。

## 任务 2：四种编辑器都真正提供和执行这些工具

**位置：** `packages/browser-host/src/{assistant,source-skill,source-catalog-skill}.ts`、`apps/web/src/editors/{assistant,shared-editor-assistant}.tsx`；沿现有原生编辑器适配层核对最终传入 AgentLoop 的组合。

- [ ] 在 `apps/web/test/unit/{assistant-client,workspace-source-skill}.test.mjs` 记录实际发出的模型请求和执行工具的请求。逐格式断言四个名称各出现一次；不仅检查 catalog。断言执行端直接收到未暴露的 sources_save_result 调用时拒绝，且没有发出 HTTP 请求。
- [ ] 用一个入口组装源技能：metadata-only 注入目录技能；分析模式从已有工作区技能选择四个工具，定义与调度共用同一允许集合；关闭时两者均不注入。沿用绑定原会话的 request，补上已销毁客户端或已取消调用不得再发请求的断言。
- [ ] 优先沿用所有入口共有的技能集合；排查 Word/Excel 的专用 sourceSkill 插槽、Slides 的 extraSkills、PDF 原生与共享预览的实际调用者。迁移时移除重复注册；若某一适配器未透传，只修该适配器。保留纯文档任务及各格式原有读写权限。
- [ ] 复用 `apps/web/test/local-integration/source-tools.test.mjs`：SQL 源列可见表、指定表返回字段；HTTP 源返回配置的提取信息；其他账号的标识、不可见表、旧会话、写 SQL 都不能取得数据。执行 `node --import tsx --test apps/web/test/unit/{assistant-client,workspace-source-skill}.test.mjs apps/web/test/local-integration/source-tools.test.mjs`。已覆盖的服务端行为不重复实现。

## 任务 3：让分析、委派和后续追问使用正确的数据

**位置：** `packages/agent-core/src/coding-skill.ts`、`packages/browser-host/src/{source-skill,assistant,coding}.ts`；复用 `apps/web/server/src/modules/coding/{routes,data-access}.ts` 的现有授权。这里要消除现有“SQL 和统计一律委派”的提示冲突。

- [ ] 明确分工：问结构只调用 describe；有明确口径的聚合交给数据库；需清洗、复算、编程或绘图才委派。订单金额和实收金额都合理且无上下文时询问口径。预览行数不代表总体；截断时可改用源端聚合，仍不能确认完整性则在结论中说明。
- [ ] 测试委派的实际载荷。指定上次结果时只发 `dataInputs: {sourceIds: [], resultIds: [resultId]}`，其中 resultId 来自成功查询响应的 `artifact.resultId`；不填明细 context。纯编程省略 dataInputs。结果不唯一且上下文无法区分时请用户选择；过期、注销或授权失败时不自动切换为源授权、重新查询或永久保存。
- [ ] 验证现有 list_agent_data 和显式数据授权是独立入口。测试普通无数据编程仍可委派；“核对刚才的数据”不枚举其他数据或给任务附上整个源。若 Coding 不可用，保留直接查询，准确说明未运行 Python。只有拿到执行回执才说“已运行”，只有拿到有效产物引用才展示图或下载入口。
- [ ] 扩展 `apps/web/test/unit/coding-client.test.mjs` 和 `apps/web/test/local-integration/harness-data-flow.test.mjs`，验证任务只可读获准的快照、不可读其他结果或查源；取消与未知结果不能被显示为成功。命令：`node --import tsx --test apps/web/test/unit/coding-client.test.mjs apps/web/test/local-integration/harness-data-flow.test.mjs`。

## 任务 4：用一次可复查的对话验收，再单独核对客户环境

- [ ] 新增 `apps/web/test/local-browser/office-source-analysis.test.mjs`，复用同目录 `office-dock-unified.test.mjs` 的挂载方式。用受限 PostgreSQL 测试源：orders 有 paid_at、order_amount、paid_amount，以 UTC 自然月、CNY 实收为约定口径。一月实收 10 和 20，二月 40；另设不可见表 payroll。订单金额与实收不同，使选错字段一定导致测试失败。
- [ ] 用可重复的模型工具调用驱动一条真实面板 → 网关 → 数据源 → Coding → 展示的流程；替身仅用来稳定模型决策，不伪造查询结果、Python 计算和产物。四种格式均检查实际工具清单，选一种跑完整对话。依次提问“有哪些表”“订单表有哪些字段”“按月汇总实收”“用 Python 复核并画图”。用测试数据所有者在第三、四问之间给一月追加 5 元。核对下表，同时验证图表文件可打开且系列值正确。

  | 时点 | 数值断言 | 调用断言 |
  |---|---|---|
  | SQL 首次汇总 | 一月 30、二月 40 | 可见表不含 payroll；记录返回的 resultId 和哈希 |
  | Python 复核 | 总数 70；图上两点为 30、40 | 使用同一 resultId 和哈希，源端无第二次业务查询 |
  | 用户明确说“刷新” | 一月 35、二月 40、合计 75 | 出现新的查询和快照，旧结果仍指向原数据 |

- [ ] 运行 `node --import tsx --test apps/web/test/local-browser/office-source-analysis.test.mjs`。准备可用浏览器、相应编辑器构建产物、测试数据库和 Python 分析运行环境；缺哪项就记录哪项未验收。再用已配置的真实模型跑一次同样的自然语言对话，记录选用字段、SQL 口径、去敏后的结果引用、执行回执和图表。自动测试验证管线，真实模型验证它能自行选择正确工具，两种证据分别报告。
- [ ] 将运行日期、版本、模式、通过与未通过项写入新文件 `docs/dyoffice/evidence/office-assistant-source-analysis.md`。客户 StarRocks 独立记录：根据[历史验收](../../dyoffice/evidence/starrocks-customer-acceptance.md)，先核实专用只读账号与传输条件，再从实际 Office 入口跑一个经授权的小查询。没有条件则标记“客户库未验收”，不以测试库通过或诊断直连代替。
- [ ] 发布时仅在验收环境显式开启 read-only-analysis。出现问题可退回 metadata-only 或移除配置并重启，重新打开编辑器确认工具列表收窄、旧页面下一次模型请求也不能使用新增工具。开关回退不删除已有工作区结果，不冒充对已交付数据的撤回。
