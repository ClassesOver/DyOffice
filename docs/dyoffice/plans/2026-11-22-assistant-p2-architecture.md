# Office 助手 P2 架构改进方案

2026-11-22。P0（Codex harness 稳健性）和 P1（公开错误码、数据结果删除）已在 #201 实施。本文是 P2 的设计与分阶段计划，实施前需评审；每一阶段都可单独合并和回滚。

## 1. 统一任务运行时

### 现状

| | Codex harness | DSH 频道 | 后台任务 |
|---|---|---|---|
| 状态表 | `harness_task_recovery`（5 种状态） | `assistant_tasks`（8 种状态） | `assistant_background_queue` |
| 租约/续租 | 进程内心跳，30 s 租约 | 频道连接 epoch | 队列认领 |
| 浏览器获知进度 | SSE；断线后 `coding-recovery` 每秒轮询 | `assistant-channel` 每 400 ms `pump()` | 主页列表刷新 |
| 结果回到 Office 对话 | continuation + `harnessResume` | 父任务 continuation | 无 |

三套实现各自处理状态、重试、恢复、取消和授权。P0 修掉的六个缺陷（轮询叠加、续租过脆、授权早于超时过期、邮箱重复处理等）都出在这些各自实现的边界上；DSH 频道仍有同类风险，尚未审查。

### 目标

一个服务端任务运行时（`modules/tasks`），提供：

1. **统一状态机**：`queued → running → (waiting_peer) → succeeded | failed | cancelled | unknown_outcome`，`cancel_requested` 为附加标记。三类任务都映射到这一套状态，任何状态转换都只能用条件 UPDATE 完成（`WHERE state=$expected`）。
2. **统一租约**：`lease_until` 和 `renewed_at` 两列。续租出错时容忍到租约到期前（规则同 P0 的修复），过期由服务端统一回收为 `unknown_outcome`。
3. **统一事件流**：每个任务一个单调递增的 `sequence`，事件包括 progress、activity、state、result；浏览器用同一个 SSE 端点按 `afterSequence` 续读，替代 `coding-recovery` 的轮询和频道的 `pump()`。
4. **统一 continuation**：任务完成后由运行时判断是否回到原 Office 对话，接口沿用现有的 `harnessResume` 校验（文档 revision、模型、调用 ID）。
5. **统一授权和资源**：数据授权的有效期跟随任务租约自动续期，任务结束即撤销；产物配额按"在用"计算（P0 已为 Codex 产物做到）。

### 分阶段

| 阶段 | 内容 | 风险控制 |
|---|---|---|
| T1 | 新建 `assistant_task_events`（task_id, sequence, kind, payload），Codex harness 同时写入新表，旧接口不变 | 只增不改，双写可比对 |
| T2 | 新 SSE 端点 `/api/v1/assistant/tasks/:id/events?after=`，`coding-recovery` 改为订阅它；轮询保留为降级路径 | 浏览器侧有开关，可回退 |
| T3 | DSH 频道任务接入同一事件表，`pump()` 改为订阅 | 先审查 DSH 频道 harness（P0 遗留项） |
| T4 | 后台任务接入；旧状态表改为视图或只读 | 一个版本周期后删除旧表 |

每一阶段的验收：现有 harness/频道集成测试全部通过，再加一个"API 进程被杀后恢复"的用例（参照 `harness-task-recovery` 中已有的用例）。

## 2. 工具动态加载

### 现状

每轮请求都会把该格式的全部工具 schema 发给模型：Word 42 个、Excel 19 个、PPT 20 个、PDF 49 个，此外还有数据源、插入和委派工具。成本按轮计算；工具越多，选错的概率越高，但目前没有数据。

### 方案

先测量，再决定是否改造。

1. **测量（D1）**：扩展 `tools/dyoffice/analysis-eval`，增加"工具选择"场景集。用各格式真实的工具定义（只用定义，执行用桩代替），统计不同模型选对工具的比例，以及每轮的工具 token 数。
2. **按意图分组（D2，仅在 D1 显示有问题时做）**：
   - 把工具分为三组。
     - 常驻：读取上下文、基本编辑、数据源。
     - 按需：样式、页面设置、图表、批注等。
     - 罕用：导出、签名等。
   - 首轮只发常驻工具，外加一个 `load_tools(group)` 元工具；模型调用它后，下一轮再附上对应分组。
   - 现有的 `composeSkills` 和网关的工具裁剪（`scopeAssistantRequest`）都按工具名过滤，只需在两处同时加入分组，不改变执行路径。
3. **验收**：D1 场景成功率不下降，平均每轮工具 token 下降。

## 3. 评测扩展

现有 `analysis-eval` 只覆盖 PostgreSQL 数据分析的 5 个场景（真实模型成功率：gpt-5.6-luna 13/15，gpt-6.1-sol 15/15）。

| 扩展 | 内容 | 前提 |
|---|---|---|
| E1 编辑器工具 | 以真实工具定义加内存文档目标，覆盖插入表格、改样式、批注等常见请求 | 工具定义可脱离 DOM 导入（docs 的 `tools.ts` 目前依赖编辑器，需要先拆出纯定义文件） |
| E2 Codex 委派 | 委派 Python 画图、交付、插入文档，检查产物哈希和插入内容 | 评测环境装 Codex CLI 和分析 Python（CI 中已有 `DYOFFICE_TEST_ANALYSIS_PYTHON`） |
| E3 DSH 协作 | 用现有 DSH fixture 跑委派到恢复的流程 | 复用 `assistant-dsh-delegation` 的 fixture |
| E4 定期运行 | CI 每周用一个小样本跑一次，结果写入验收记录 | 模型网关凭据由 CI secret 提供 |

报告格式沿用 `report.json`：每次调用的输入和失败输出都已记录（#199）。

## 4. 焦点契约

### 现状

共享的助手面板嵌在四种编辑器宿主里，各宿主都有自己的焦点逻辑：Univer 的单元格编辑器、Tiptap、幻灯片画布、PDF 视图。本轮修了三类焦点问题：

- Excel 在延迟渲染时抢走焦点（chrome focus guard）；
- 输入框在面板展开动画中测量高度；
- 任务卡片在切换标签时抢焦点（一次性 focusRequest）。

每一处都是在宿主里单独打补丁。

### 方案

1. 在 `packages/browser-host` 定义 `AssistantFocusScope`：
   - 助手面板挂载时注册自己的根元素；
   - 宿主通过 `scope.holdsKeyboard()` 判断键盘是否属于助手；
   - 宿主在需要重新聚焦编辑器时调用 `scope.yieldTo(editor)`。
2. 宿主只在 `!scope.holdsKeyboard()` 时才允许自动聚焦编辑器。Excel 的 focus guard 改为查询这个接口，不再自己维护选择器列表（目前是 `.copilot, .ai-panel, .ai-dock, input, textarea…`）。
3. 助手面板内部的焦点移动（卡片、标签、输入框）只响应显式请求，沿用 #200 的一次性 focusRequest 规则。
4. 用一个跨四种编辑器的浏览器用例做验收：在面板里输入时触发编辑器重渲染，焦点保持不变；点击编辑器区域，焦点进入编辑器。

## 实施顺序建议

1. T1、T2：Codex 事件流，收益最直接，能替换掉 P0 刚修过的轮询。
2. 审查 DSH 频道 harness（P0 遗留），再做 T3。
3. 焦点契约：范围小，可与 T1、T2 并行。
4. D1、E1：先测量；工具动态加载是否实施，以数据为准。

## 实施进度

- T1 完成：迁移 0052 新建 `harness_task_events`（随恢复行级联删除，单任务最多 4096 条，进度和活动截止于 4000 条，余量留给状态事件）。Codex harness 每 500 ms 批量写入活动和进度，启动、取消和结束的状态事件与恢复行在同一事务中写入。写入失败不影响任务。
- T2 完成：`GET /api/v1/agents/tasks/:id/events?documentId=&after=` 按序号续读。首页在切换为流之前完成授权，所以 404/403 仍是普通 HTTP 错误。流每 500 ms 读取共享日志，任务结束时发 `end`，最长 120 秒后关闭，由客户端续读。浏览器优先订阅；订阅期间 `/status` 只每 10 秒读一次作为兜底，结果和 continuation 仍从 `/status` 读取。端点不存在、返回非 SSE 或连续三次连不上时回退到每秒轮询；`localStorage['dyoffice.harness.events']='off'` 可关闭订阅。
- DSH 频道审查：修复两处缺陷。单次快照刷新失败会中止正在运行的 Office 任务，现在只有 401/403/404 或持续失败 25 秒才中止，其余情况退避重试。刷新进行中收到的通知会丢失，现在会补读一次。T3 可以开始。
- 焦点契约第一步：`@genoffice/ui` 提供 `registerAssistantFocusRoot` / `assistantHoldsKeyboard` / `useAssistantFocusRoot`。共享助手面板和 Excel 助手面板注册根元素，Excel 焦点保护改为查询该接口。
- 焦点契约后续：Word、PPT、PDF 原生助手面板也注册根元素。Word 的拼写刷新与编辑快捷键、幻灯片文本覆盖层的自动定位、PDF 的延迟表单聚焦与文档快捷键会检查键盘归属。面板根节点更换和卸载有回归覆盖；四格式真实浏览器焦点验收仍待完成。
- T3 的频道事件传输已接入。迁移 0053 将已有频道事件的序号、类型和任务 ID 补录到共享事件表，后续事件与原频道事件在同一事务内写入。Office 浏览器使用上次成功读取的快照序号订阅 `/api/v1/assistant-channels/channels/:id/events?after=`，收到变更后读取快照并沿用原有条件领取。空闲频道不再每 400 ms 唤醒调度器；已排队且编辑器忙时保留本地重试。旧服务仍通过工作区通知触发刷新。
- T3 恢复验收：真实 PostgreSQL 上结束原 API 进程后，新 API 能从断线前的快照序号读取 DSH 委派事件，同一任务只有一条记录。
- T4 已将保存版本后台执行和 Codex 执行接入相同的续租监控。频道状态更新按预期旧状态写入；续租暂时失败会重试，明确失去租约立即中止，续租请求挂起也受最后一次确认后的 25 秒上限约束。后台存储兼容迁移和统一状态读取仍在实施。
- D1 新增四格式原生工具选择评测。每种格式以相同请求分别测量携带和不携带工具时的输入 token 数。周度工作流保留逐次选择与测量结果；真实模型采样需配置仓库变量 DYOFFICE_EVAL_BASE_URL、DYOFFICE_EVAL_MODEL 及网关凭据。
- E3 已接入每周和 PR 评测。Word 样本在真实 PostgreSQL 与 Chromium 中通过（60.8 秒）：外部 DSH fixture 交付报告后，原对话恢复，从历史重新取回报告并写入 Word，保存包中可核对正文及哈希，重开仍有报告内容。每次运行生成独立 JSON 结果。
- E1 的 Word 样本已实现。插入两列表格、段落加粗、锚定批注在真实 Tiptap 内存文档中执行，固定输入 3/3 通过。真实模型模式使用相同目标，记录实际调用参数和文档效果；周度采样仍需配置模型网关。
