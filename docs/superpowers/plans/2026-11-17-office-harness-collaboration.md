# Office 助手与外部 harness 双向协作实施计划（复用优先）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 如需并行代理，先遵循执行会话的授权与仓库约束；本计划不要求委派子代理。

**Goal:** 不同外部 harness 以独立身份加入 Office 文档聊天频道，与现有 Office 助手实时对话、互相委派、追问、返回结果及取消任务。外部接入是可选增强，不成为 Office 自身功能的依赖；dsh 仅为可选适配示例。

**Architecture:** 在现有 Office AgentLoop、Skills、聊天面板、队列、模型通道、Fastify、PostgreSQL 和 T17 实时连接外增加按需启用的协作能力。Office 原有启动、用户消息、工具和保存路径保持独立；协议与任务层不依赖具体 harness，差异集中在连接器适配模块。复用 HTTP 控制接口和 T17 WebSocket；模型推理继续使用现有 SSE，不使用 MCP。

**Tech Stack:** TypeScript、React、Fastify、PostgreSQL/现有 RLS、现有 `ws`、Node test runner、Vitest、现有浏览器测试工具。

**Spec:** 本文件“设计契约”是频道协作执行依据；数据处理和分析按最新 [统一 harness 数据分析子计划](2026-11-17-unified-harness-data-analysis.md) 执行。计划中的待办不代表功能已经交付或真实 harness 接口已经验收。

## 全局约束

### 2026-11-17 工作树实施进度

- 已实现可选频道开关（默认关闭）、邀请/审批/兑换、持久任务与 claim/epoch、防重执行、撤权、取消和暂停；浏览器通知复用 T17，外部 CLI watch 使用 HTTP 轮询。
- Docs、Sheets 参与者栏及委派结果卡片已接入统一头像：Office、内置 Codex、外部 harness 均显示独立头像、名称与来源；没有外部成员时仍保留内置 Codex。头像由本地字符生成，无远程图片依赖。
- 已有真实 PostgreSQL/HTTP 双向委派与 CLI 验收、真实 Codex stdio 测试，以及浅色/深色窄面板组件浏览器验收。详见 `docs/dyoffice/evidence/assistant-channel-bidirectional-integration.md` 和 `assistant-channel-ui-components.md`。
- 频道成员数据授权入口已接通：owner 显式委派 `dataInputs`，当前接收成员按 live claim 兑换统一数据 grant；取消、暂停、离线、换 epoch、会话失效和撤权均禁止继续访问。新增 0031 迁移保存任务范围，CLI run/watch 通过 stdin 交付凭据。真实外部进程已验收冻结下载、计算、产物提交和 Office 用户下载。证据见 `docs/dyoffice/evidence/assistant-channel-data.md`。
- `AgentLoop` 已新增默认关闭的 `allowDelegationYield` / `requestYield(taskIds)` 核心接口：工具结果配对写入后再释放运行槽；错误与取消优先，最多收集 16 个关联任务 ID。当前只完成 loop 核心及单元回归，尚未接入 Office 委派提交、服务端 parent `yieldTask()`、结果 continuation 和编辑器 UI，不能标作 Task 7 完成。
- Office → 外部 Agent 的等待与恢复已接到 Docs/Sheets 原有 AgentLoop：成功提交后请求安全 yield；只有 AgentLoop 明确回报 yielded 且任务已到终态才续跑；续跑携带原委派指令和外部结果，并按各编辑器现有运行门处理。Docs 走原消息队列并保留草稿；Sheets 在运行槽空闲后排入原助手循环；New Chat 清除旧续跑。该实现使用 durable channel root task，不伪造不存在的 Office 服务端父任务，因此任务图仍未实现原计划中的 Office parent `waiting_peer` / 服务端嵌套追问语义。相关 Web client 测试 13 项、agent-core yield 回归 101 项通过；完整 Task 7 尚未完成。
- 尚未据此宣称完整交付：完整 Office 编辑器 E2E、第二种真实 harness 适配器、自动等待后的模型续跑仍需完成；外部文档写入仍按 Task 12 独立实施。组件 fixture 与确定性模型桥测试不能替代这些验收。

- 复用优先：每个新增组件先说明现有代码为何不能直接承担；不引入 Agno、LangGraph、另一套 Agent 循环、第二个实时网关或独立消息中间件。
- 不使用 MCP；不修改任何 harness 的 MCP 注册配置实现本功能。
- 不限 dsh：协议、数据库、Office UI 和任务调度不得按 dsh 分支；Codex、Claude Code、dsh、自定义 Agent 均通过已验证的能力与适配器接入，不预先宣称兼容。
- 外部接入为可选增强：功能关闭、零成员、外部离线、适配器未安装、协作服务不可用时，Office 原有聊天、模型选择、Skills、工具、编辑、保存与取消仍正常工作。
- 原 Office 能力以实施时实际基线为准；不能因外部任务首期只读而限制用户已有写入能力，也不能因协作暂停而锁住用户自身工作。
- 首期面向 Web Docs、Sheets 的当前文档助手；桌面运行时、Slides/PDF 助手、后台无编辑器执行不属于首期。
- 加入的是指定文档的指定频道；不把当前活动标签页当作执行目标。
- 外部发起的 Office 任务首期仅使用实施基线已经支持的只读能力；外部写入集成为后续独立交付，不能通过扩大工具白名单绕过 T14。Office 用户原有能力独立保留。
- 外部来源、身份和权限由服务端确认，不能信任请求体的 `from`、头像、用户 ID 或角色。
- Node/npm 版本遵循仓库 `package.json`：Node `>=22.12.0`、npm `>=10`；具体生产与验收版本记录到证据文件。
- 遵循根 `CLAUDE.md`：UI 使用语义主题 token；文案补齐既有 i18n 分片；不把不稳定的 `t` 放进 hook 依赖。
- 不搬运、覆盖或提交其他工作树的未提交代码。候选依赖必须先由所属工作流交付，再通过明确提交范围整合。
- 已进入实施阶段。实施各阶段均需运行对应检查；不得把模拟 harness 或计划静态审阅记作真实接入通过。

## 最新实施补充：内置与外部平级

- 内置 Codex 是统一注册表中的默认 coding 候选；外部 adapter 使用相同 descriptor、run、取消和容量规则。origin 只用于展示，不参与授权或调度优先级。
- Office 继续使用用户选中的原模型和原 AgentLoop。通过附加 Skill 自行决定是否调用 `delegate_agent_task`；普通文档操作不触发 harness。
- 内置 harness 的每轮模型推理复用 Office 本轮模型配置与同一额度账本；不依赖独立 Codex 登录或另建 coding 额度。外部 harness 使用自己的模型，或在明确授予模型代理能力后使用 Office 网关，不领取上游密钥。
- **数据处理与数据分析全部交给 harness。** SQL 编写、清洗、关联、计算、统计、图表与验证由 harness 自主执行；Office 只提供目标、授权范围、委派及原文档交付。服务端只执行受控查询、冻结/运输数据和保存产物。
- **内外部数据流程归一。** 两者使用同一 task grant、数据客户端、冻结结果引用与产物清单；内置不能直接读取业务库绕过权限入口。结果行下载到各自任务目录，不经过 Office 模型中转。
- 分析 Python/SQL 库纳入 `tools/analysis-runtime/` 依赖锁、wheelhouse 与离线验收。完全无网的数据计算和需要模型端点的 Agent 推理分别验收；不把依赖预装等同于附带离线大模型。
- 不放宽现有 Codex 模型桥的工具限制；完整 coding 执行走独立的懒启动 CLI 适配器。
- 先实现 Office → coding agent → Office 结果的垂直链路。频道邀请、成员头像、外部主动委派 Office、实时进度与持久恢复仍按下文任务实施，不宣称已经完成。
- 依赖已整合：`5357fa9f`、`24709ed0`、`c35b3e70`；最新 PR #132 `415c38f5` 通过 `fd68a721` 合入。PR 的 0023–0026 迁移保留，Skills/个人模型迁移在功能分支顺延为 0027–0028。下文候选状态表保留为原始调研记录，不能据此重复搬运候选代码。

## 0. 基线、事实与依赖

计划基线：`8c89e19745c20225c1b52ceac03f8d95e87c3faa`，2026-11-17。

计划独立工作树：`/home/junge/.codex/worktrees/c0bf/DyOffice`。观察来源：主工作区 `/home/junge/pros/DyOffice` 以及只读查看的 `/home/junge/.zcode/worktrees/t17-realtime`。

| 现有资产 | 已观察状态 | 复用方式 / 限制 |
|---|---|---|
| `packages/agent-core/src/{loop,skill,types}.ts` | 已提交；AgentLoop、composeSkills、工具事件、取消 | 保留 Agent 核心；仅为异步委派补最小主动让出能力 |
| `packages/ui/src/chat-run-queue.ts` | 已提交；忙时排队、停止后 hold、内存队列 | 扩展元数据与同一执行门；服务端持久记录补偿内存丢失 |
| `apps/docs/src/renderer/ai/AiPanel.tsx` | 已有助手；主工作区有未提交修改 | 复用 runWith、工具展示、快照、取消；不得让外部提交清掉用户草稿 |
| `apps/sheets/src/renderer/ai/AiChatPanel.tsx` | 已有助手；主工作区有未提交修改 | 同一共享控制契约，保留 Sheets 原有执行逻辑 |
| `packages/browser-host/src/ai-transport.ts` | 已提交；模型 SSE | 继续传输模型 token/tool call，不承担成员连接或任务路由 |
| `packages/browser-host/src/assistant.ts`、`packages/web-contracts/src/assistant.ts` | 主工作区未跟踪候选文件 | Web 模型客户端、只读工具白名单；必须先交付依赖 |
| `apps/web/src/editors/assistant.tsx`、`modules/providers/gateway.ts` | 主工作区未跟踪候选文件 | 复用助手装配和服务端白名单，不假设基线已经包含 |
| T17 `modules/realtime/{gateway,routes,tickets,sessions,state,dispatch}.ts` | 另一工作树未提交候选 | 复用 WS、连接容量、心跳、会话校验、重连协调；不是已验收的全能消息总线 |
| T17 `packages/browser-host/src/editor-bridge.ts`、`apps/web/src/editors/editor-realtime.ts` | 同上 | 扩展现有编辑器连接，避免每个面板另建 socket |
| T17 `dispatchToEditor()` | 候选函数明确返回 `unsupported` | 不能当成已支持文档命令或助手调用；新增独立 assistant 消息分派 |
| `packages/web-contracts/src/events.ts` | 已有 HostEvent、256 KiB 大小边界 | 复用版本化事件习惯；助手消息不冒充 `command.request` |
| `modules/commands/*` | 已有命令日志、授权、恢复组件 | 后续写入沿用；任务结果不能取代持久化修订收据 |
| `packages/cli/src/{cli,registry,result,args}.ts` | 已有 CLI 命令注册和输出协议 | 将连接命令放在现有 CLI 中，不另建 CLI 项目 |
| `packages/cli/src/agent-skills.ts` 中 dsh 条目 | 仅识别 DSH_HOME；`skillsTarget: false` | 只复用身份探测；不能据此推断支持插件或会话恢复 |
| `packages/cli/src/agent-mcp.ts` 中 dsh 配置 | 现有 MCP 配置支持 | 本方案不使用 |
| `packages/ai-provider/src/codex-app-server.ts` | Codex 作为受限模型后端 | 不解除原有工具限制，不用它冒充外部完整 harness |

**迁移冲突已发现：** 主工作区候选有 `0023_user_skills.sql`、`0024_personal_provider.sql`；T17 候选也使用 `0023_realtime_tickets.sql`。依赖整合时由最终 manifest 分配唯一顺序，不能复制后直接运行。已经发布的迁移不能改号改摘要；若均未发布，可在整合提交中重新编号并验证从旧基线升级。本功能迁移编号在整合后取下一个连续编号，执行任务同时记录实际文件名。

## 1. 设计契约

### 1.1 加入与退出

1. 用户在当前频道选择“添加 Agent”，默认只授权对话、委派只读任务和接收被明确发送的上下文。
2. 服务端生成 256-bit 随机一次性邀请凭据，5 分钟有效；正文只显示一次，数据库仅保存摘要；不放 URL 查询参数或日志。
3. 外部连接器提交邀请凭据及自报展示信息，换取短期申请凭据；邀请被原子消费。申请只能查询自身状态，不能读取频道。
4. Office 显示 Agent 名称、申请编号、频道和文档、请求能力；用户确认后才激活成员。
5. 连接器使用申请凭据领取一次性的成员访问凭证。若领取响应丢失，由用户撤销该成员并重新邀请，不重复返回明文凭证。
6. 外部使用成员凭证换取短期 WS 票据，主动连接 Office。长期成员凭证不出现在 URL；票据按 T17 的一次性规则消费。
7. 频道显示头像、名称、在线状态。头像首期使用内置类型图标或姓名首字母，不加载任意外部头像 URL。
8. “从已连接 Agent 添加”在初次闭环后实现：复用已授权连接，要求用户为新频道明确授权，并分配独立 harness 会话。
9. 用户移除成员立即撤销凭证和票据，阻断新操作、通知连接关闭、请求取消尚未完成任务。已执行的效果不自动回滚。

成员凭证默认 24 小时有效；到期需重新授权连接。首期不新增 refresh-token 系统。撤销、账户停用、文档权限变化均使有效授权收窄，不能只在 WS 握手时检查一次。

### 1.2 身份、频道与上下文

- 一个 `conversationId` 绑定 owner、`fileId` 和 Office 助手会话，不能由客户端换绑。
- `agentId` 表示一个已配对 Agent；`membershipId` 表示它在一个频道的授权；`connectionId` 和单调增长 `connectionEpoch` 表示当前在线执行实例。
- 每个 membership 分配独立 `harnessSessionId`；跨频道复用 harness 进程可以，但不得复用对话上下文。
- `taskId` 标识任务；`parentTaskId` 标识委派或追问来源；`replyTo` 标识消息回复；`requestId` 用于请求幂等。
- `editorId`、editor generation 绑定真实执行者。两个标签页打开同一文档时，只允许一个频道执行者持有运行 claim。
- 加入只收到加入事件和之后有权查看的消息，不自动导出历史聊天、附件、模型配置或未发送草稿。用户明确选中的上下文单独发送。
- 外部可以读到自己参与的任务和回复；UI 可以汇总频道事件，外部不能因同处频道而读取其他成员的私有任务内容。
- 新建聊天会建立新频道；原频道不把旧任务的迟到结果插入新聊天。关闭文档时取消待执行 Office 任务，并将已执行但结果不明的任务转为待核对。

### 1.3 消息与能力

拟议契约放在 `packages/web-contracts/src/assistant-channel.ts`，以下名称在所有任务中保持一致：

```ts
export type TaskState =
  | 'queued' | 'running' | 'waiting_peer' | 'cancel_requested'
  | 'succeeded' | 'failed' | 'cancelled' | 'unknown_outcome'
export type AgentCapability = 'chat' | 'office.read' | 'harness.execute'
export type AgentAction =
  | {kind: 'message'; content: string; replyTo?: string}
  | {kind: 'delegate'; instruction: string; parentTaskId?: string}
  | {kind: 'result'; taskId: string; claimId: string; connectionEpoch: number; summary: string; outcome: 'succeeded' | 'failed'}
  | {kind: 'cancel'; taskId: string}
export interface SubmitAgentAction {
  requestId: string
  conversationId: string
  to: string
  action: AgentAction
}
export interface AgentReceipt { messageId: string; taskId?: string }
export interface AgentEvent {
  version: 1
  eventId: string
  sequence: number
  conversationId: string
  taskId?: string
  type: 'member' | 'message' | 'task' | 'text' | 'tool' | 'sync_required'
  payload: Record<string, unknown>
}
```

`from`、owner、权限、任务归属由服务端认证生成。上述 `payload` 只表示总 envelope；Task 1 必须为每个事件类型定义严格 schema，未知字段拒绝，不将任意对象透传到工具执行器。

`message` 表示面向指定接收方的对话，若接收方是 Agent，服务端为这次回应创建受限任务并返回 taskId；普通 UI 状态事件不创建任务。`result` 只接受持有 task claim 的执行者，且只能推动关联任务。工具进度、心跳、成员上线不唤起模型。

协作任务首期设定：单消息最大 32 KiB、协议帧上限复用 256 KiB、每频道最多 4 个外部成员、最多 32 个未完成任务、委派深度上限 4、单根任务最多 16 个子任务，根任务默认期限 10 分钟。这些限额仅作用于协作请求，不改变 Office 原有用户消息和任务限额。子任务不能延长根期限；大结果转为有权限约束的产物引用，不塞入帧。

### 1.4 任务与死锁处理

```text
queued → running → succeeded / failed
                → waiting_peer → queued（携带子任务结果）→ running
queued → cancelled
running / waiting_peer → cancel_requested → cancelled
running → unknown_outcome（执行者丢失，尚无可靠结果）
unknown_outcome → succeeded / failed / cancelled（经执行记录核对）
```

- 委派工具提交后立即得到 taskId；调用 `AgentLoop.requestYield(taskIds)`，本轮所有已生成的工具调用结算后结束该次 run，返回 `yielded`，释放执行槽位。
- `yielded` 不代表业务任务成功；UI 保留等待卡片，服务端父任务为 waiting_peer。工具错误、用户取消优先于 yield；失败的委派不能留下等待状态。
- 子任务可能在父 run 让出前完成：服务端先持久记录结果，收到父 yield 回执时检查所有依赖；若结果已齐，直接排入 continuation。不能仅依赖一次完成事件，否则会永久等待。
- 不恢复语言模型“调用栈”。子结果到达后，以带父任务 ID、原目标和结构化子结果的 continuation 再调用同一个 AgentLoop。
- 允许 Office A → 外部 Agent B → Office C 的关联追问。C 使用空闲的 Office 执行槽，不等待 A 结束；C 的结果只发回 B。禁止让任务等待自己或祖先任务完成，依赖图必须无环。
- 频道历史继续由原 AgentLoop 管理；恢复任务携带完整任务标识和目标，不能依赖“最后一条 assistant 消息”判断归属。
- 服务端持久任务仅对协作任务权威；Office 原有用户消息不必先创建频道或任务记录才能运行。复用同一 React 队列与执行门，增加 source 元数据和协作准入开关，不新建第二套浏览器轮询调度器。
- 用户消息优先于尚未开始的外部任务；已经运行的文档操作不强制抢占。等待外部结果时释放槽位；外部洪泛、超额和故障不得消耗原生用户任务的准入容量。
- 原聊天 Stop 保留既有取消当前 run / hold 用户队列语义。新增“暂停外部协作”只阻止外部新任务与自动 continuation，用户可以继续聊天；任务卡片“停止此任务”仅作用于对应根任务及子任务。外部 Agent 的 cancel 不能全局暂停 Office 队列。
- at-least-once 事件投递 + 幂等收件；不承诺 exactly-once 外部副作用。执行回执丢失时不自动重跑已开始的 harness 任务。
- 根期限到达后取消尚未执行的子任务、通知运行者停止；有可靠未执行/停止证明才转 cancelled，无法确认的运行任务转 unknown_outcome。不能把网络超时等同于外部进程已终止。

### 1.5 传输与鉴权复用

- 复用 T17 单个 `WebSocketServer` 和统一 upgrade 路由分派；不能再加会拒绝其他 WS 路径的全局 upgrade listener。
- 浏览器继续使用当前 cookie、CSRF、Origin 和 T17 票据；外部使用独立 Bearer 身份与票据 audience。不能关闭浏览器 Origin 检查以兼容 CLI。
- 成员授权事务复用现有 `PrincipalTransactions` 的 RLS、角色和事务复核模式，但增加显式 `agent` credential 分支；不把外部 token 塞进 session 解析器，也不授予它通用文件读写能力。
- 外部 `agent` principal 只能进入协作模块允许的业务事务，其他现有文件/provider 路由仍只接受原有身份。Office 文档工具由在线浏览器会话执行，并同时检查 membership 的任务能力。
- WS 只负责带序号事件和回执；HTTP 负责邀请、批准、提交动作、领取任务、查询快照、取消、移除。事件与任务状态在同一数据库事务中写入。
- 文本流按 taskId、turn 序号与 textRevision 发累计快照，避免把 AgentLoop 累计 `onText` 当增量重复拼接；每 100ms 合并一次，最终文本单独落库。
- 心跳建议 15 秒，45 秒无响应标离线；重连退避 1/2/4/8 秒、最大 30 秒并加抖动。凭证撤销用提交时复查和消息发送前复查，不能等心跳超时才生效。
- 任务事件保留 7 天，成员读取时按权限过滤；游标过旧返回 sync_required，重新取授权快照。离线超过 24 小时未完成的任务也受根任务期限约束，不无限等待。
- 复用 PostgreSQL 持久事件表与 T17 有界补偿查询，先不增加 Redis/BullMQ 消息总线。当前进程提交后立即推送，跨进程有界补偿；正常单实例事件到达 p95 目标 <1 秒，补偿目标 <3 秒，均不包含模型思考时间。

### 1.6 首期与后续

首期完整闭环：邀请任一已验证适配的外部 harness → 确认并显示头像 → Office 委派 → 外部反向索取文档数据 → Office 只读执行 → 外部返回结果 → Office 汇总 → 实时停止/断线恢复/移除验证。实现一个真实适配器即可交付明确标注兼容范围的首个版本；声明多 harness 已兼容前，必须用第二种独立真实 harness 完成同一契约验收，不能用更名的 mock 充数。

写入属于明确的后续阶段：通过 T14 命令授权、lease/generation/baseRevision、持久化修订收据后，才增加 `office.write` 能力。任务 succeeded 和文档已保存是两个不同事实，UI 分别展示。

### 1.7 可选增强与 Office 原功能保护

**装配边界：** 协作模块仅在开关启用且用户主动创建/加入频道后初始化。原 `createEditorAssistant` 和面板挂载不得 await 外部发现、配对、WS 上线或适配器加载。既有模型接口不因协作离线返回不可用；原生请求不需要新增 conversationId。协作初始化异常只使协作入口显示不可用，不中断编辑器与原生助手。

**工具边界：** 保持原有 Skills 和 prompt；仅在启用且存在授权成员时追加委派 Skill。基础工具策略继续由原链路决定；外部任务的额外限制按可信任务来源局部施加。成员离线时仍可查看任务状态，但新委派明确失败或等待，不把原生用户请求整体降级。关闭协作移除附加 Skill，不清空聊天、模型历史、草稿或当前文档。

**执行边界：** 复用的 AgentLoop 默认不启用 yield；仅协作装配显式 opt-in。外部等待、超时、取消、移除只影响对应任务树，不调用全局 reset/dispose/cancel。用户继续原生工作时不等待外部确认；若同一当前 run 含协作步骤，只在该 run 的安全边界结算并释放，不取消无关 run。

**资源边界：** 协作凭证、任务数、连接数、预算准入与超时独立核算；可复用同一底层池与服务，但给协作配置有界并发，不能抢占原生服务的全部容量。协作消息解析或慢客户端错误只关闭该协作连接/订阅。共用 T17 连接时，逻辑退订协作流，不关闭原有文档同步与租约连接；身份整体失效时仍按原机制关闭。

**通用能力协商：** 连接握手提交 protocolVersion、harness kind/version，以及经适配器验证的 resume、stream、cancel、reverseRequest、parallelSessions 能力。服务端权限和能力取交集；缺失能力按实际状态显示，不能伪造“可停止”或“已恢复”。harness kind 是展示与适配选择，不作为授权条件。未知适配器只拒绝该外部连接，不影响其他已连接 Agent 或 Office。

**降级与关闭：** 关闭仅停止外部新准入、取消对应协作任务、撤销协作订阅；原 Office 立即保持可用。未开启时不启动连接器、额外轮询或协作模型调用。计划内任何共享模块改动都必须有关闭状态回归测试；未通过即阻止该增强功能交付。

## 2. 文件布局与复用决策

下列“新增”均为拟议路径；已有候选文件须先整合，不能重复创建。

| 路径 | 变更 | 职责 |
|---|---|---|
| `packages/web-contracts/src/assistant-channel.ts` | 新增 | 协作协议、严格解码、状态与限额 |
| `apps/web/server/src/modules/assistant-channel/{service,postgres-store,routes}.ts` | 新增 | 邀请、成员、消息任务和 HTTP 边界；按现有模块组织 |
| `apps/web/server/src/modules/assistant-channel/credentials.ts` | 新增 | 申请/成员凭证、scope、撤销；复用现有密码学工具 |
| `apps/web/server/src/db/{context,roles,migration-manifest}.ts` | 最小修改 | agent 事务身份与协作表权限；新增下一号 migration |
| T17 `modules/realtime/{gateway,routes,tickets,sessions,dispatch}.ts` | 扩展 | 同一网关的 agent audience、助手事件、回放 |
| T17 `packages/browser-host/src/editor-bridge.ts` | 扩展 | 现有编辑器连接接收协作事件 |
| `packages/browser-host/src/assistant-channel.ts` | 新增 | HTTP 协作客户端；注入现有连接，不创建新 socket |
| `packages/ui/src/assistant-control.ts` | 新增 | 框架轻量控制契约、任务上下文与消息元数据 |
| `packages/ui/src/assistant-participants.tsx` | 新增 | 参与者/邀请/确认/移除 UI；复用现有组件与主题 |
| `packages/ui/src/chat-run-queue.ts` | 最小修改 | 必要的任务 ID、去重、hold 与恢复能力 |
| `apps/docs/src/renderer/ai/AiPanel.tsx`、`apps/sheets/src/renderer/ai/AiChatPanel.tsx` | 最小修改 | 对外注册控制器、消息来源、任务卡片、事件映射 |
| `apps/web/src/editors/{assistant,native-docs,sheets-entry}.tsx` | 装配 | 同一频道 client 注入面板与已有 bridge |
| `packages/agent-core/src/delegation-skill.ts` | 新增 | 受控的 list/send/delegate 工具；依赖注入，不引入 HTTP |
| `packages/agent-core/src/{loop,types,index}.ts` | 最小修改 | yield 及导出；既有工具循环语义保持回归覆盖 |
| `packages/cli/src/commands/agent.ts` | 新增 | 现有 CLI 的 agent 子命令 |
| `packages/cli/src/agent-channel/{client,connector,adapters}.ts` | 新增 | 通用出站通信、持久绑定、静态适配器注册；无 MCP |
| `packages/cli/src/agent-channel/adapters/` | 按实证新增模块 | 每个已验证 harness 一个薄适配器；共享契约，不引入插件市场或自动执行下载代码 |
| `packages/cli/src/cli.ts` | 最小修改 | 注册 agent 命令 |
| 各包现有 `package.json` / exports / alias 配置 | 按实际需要修改 | 新入口导出，禁止新增不必要依赖或包 |

## 3. 分阶段任务

每项任务按“行为测试先失败 → 最小实现 → 针对性验证 → 独立审阅”执行；commit 仅包含该任务文件。不得 `git add .` 混入其他工作。下面测试代码是实施时新增的契约示例，不是已经存在或运行的测试。

### Task 0 — 固定 Office 基线与核实候选 harness 能力

**文件：** 新增 `docs/dyoffice/evidence/assistant-channel-baseline.md`、`docs/dyoffice/evidence/harness-channel-capabilities.md`；更新本计划基线记录。

**输入：** 第 0 节列出的主工作区候选、T17 候选与候选 harness 的真实安装/官方源码。**输出：** Office 自身功能回归基线、已交付依赖 commit 清单、迁移编号映射、按 harness/version 划分的能力证据；dsh、Codex、Claude Code 均是候选，不强制选用其中某一项。

- [ ] 记录当前分支 SHA、dirty 状态、Web 助手/T17 所属提交；只整合已提交且已审阅的最小依赖，不复制未提交目录。
- [ ] 核查 T17 的网关容量、心跳、鉴权和重连测试，确认扩展入口。若候选不能复用，记录具体缺陷并先修复候选，不并行实现一套 SSE 或 WS 服务。
- [ ] 记录协作关闭时 Docs/Sheets 原有聊天、模型选择、Skills、读写工具、编辑保存、撤销及取消行为；执行已有测试形成后续回归比较基线，不能用外部只读策略重定义它。
- [ ] 对可用候选 harness 核实精确版本、来源、许可和创建/恢复会话、实时输入、流式事件、取消、自定义工具/插件、接收回复后继续执行能力。
- [ ] 对每项能力记录实际入口、签名、最小命令或源码引用。禁止仅凭 harness 名称或 MCP 支持推断其他接口能力；优先选择可直接复用官方 SDK/API 的适配。
- [ ] 有插件 API 就复用其扩展机制；只有机器可读 CLI/API 时，用现有 genoffice CLI 承载薄适配器；均缺失则仅将该候选标记不支持，继续其他候选，不阻塞 Office 原功能。
- [ ] 处理迁移冲突，运行原有依赖测试，记录失败是否基线已有。形成只涉及基线和能力证据的提交。

只读核查命令（仓库根）：

```bash
git status --short
git log -5 --oneline
git diff --check
rg -n 'registerRealtimeRoutes|dispatchToEditor|ASSISTANT_READ_TOOLS' apps/web packages
command -v dsh codex claude
```

**通过条件：** Office 基线已记录，至少一个候选具有可复现的机器接口证据可进入真实适配。无可用候选时仅完成协议部分，明确真实闭环尚未验收；某个候选失败不得成为其他适配器或 Office 的启动条件。

### Task 1 — 建立严格协议和可测状态转换

**文件：** 新增 `packages/web-contracts/src/assistant-channel.ts`、`apps/web/test/unit/assistant-channel-contract.test.mjs`；按需修改 web-contracts exports。

**接口：** `decodeAgentAction(raw: unknown): SubmitAgentAction`、`decodeAgentEvent(raw: unknown): AgentEvent`、`canTransition(from: TaskState, to: TaskState): boolean`；类型采用第 1.3 节。

- [ ] 为超长内容、未知字段、伪造 from、非法终态迁移编写失败测试。
- [ ] 实现按 action/event type 区分的 schema；result/cancel 的 taskId 与字段集合严格验证。
- [ ] 定义第 1.3 节常量，单测每个限额边界。succeeded/failed/cancelled 不得返回 running。
- [ ] 运行测试并审阅是否混入文档命令语义；提交 `feat(assistant): define channel and task contracts`。

```js
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {decodeAgentAction, canTransition} from '../../../../packages/web-contracts/src/assistant-channel.ts'
test('rejects sender impersonation', () => {
  assert.throws(() => decodeAgentAction({requestId:'r1',conversationId:'c1',to:'office',
    from:'owner',action:{kind:'message',content:'hello'}}))
})
test('terminal task cannot start again', () => {
  assert.equal(canTransition('succeeded', 'running'), false)
  assert.equal(canTransition('running', 'waiting_peer'), true)
})
```

运行：`node --import tsx --test apps/web/test/unit/assistant-channel-contract.test.mjs`。

### Task 2 — 持久化频道、成员、任务和事件

**文件：** 新增下一号 `apps/web/server/src/db/migrations/*_assistant_channel.sql`、`modules/assistant-channel/postgres-store.ts`、`apps/web/test/local-integration/assistant-channel-store.test.mjs`、`apps/web/test/helpers/assistant-channel.mjs`；修改 manifest、roles。

**接口：** store 在已认证事务中操作；`createAssistantChannelService(deps)` 由 Task 3 提供公共动作，测试 fixture `channelFixture(t)` 返回 `{alice,bob,service,channel,member,store}`，其中 alice/bob 为已有身份 fixture 的授权凭据，member 为测试申请确认后的成员凭据，channel 包含 conversationId/fileId。

- [ ] 复用 `fileFixture`/restricted identity 工具创建真实 PostgreSQL fixture，不以 Map 替代 RLS 测试。
- [ ] 建立六类记录：channels、memberships、invitations（含 pending application）、tasks、messages、events。复用 file/user/deployment 外键；membership 包含 agentId、凭证摘要、权限、外部会话绑定与 connectionEpoch。
- [ ] 以 `(membershipId 或用户会话身份, conversationId, requestId)` 唯一索引做幂等；保存规范化 payload 摘要，重复相同请求返回原收据，不同 payload 返回 409。
- [ ] tasks 保存 parent/root、state、assigned membership、claimId/epoch、deadline、outcome。events 按频道单调 sequence；状态和事件原子提交。
- [ ] 所有协作表启用与现有 owner/deployment 一致的 RLS；外部成员还需 membership/channel 范围复核，不授予原文件表泛化读权限。
- [ ] 测试并发重复提交只创建一个任务、跨用户/部署不可读、外键删除清理、从发布基线升级、事务回滚后无事件泄漏。
- [ ] 提交 `feat(assistant): persist scoped channel tasks and events`。

事务测试核心断言示例（fixture 本任务实现）：

```js
const f = await channelFixture(t)
const input = {requestId:'same',conversationId:f.channel.conversationId,to:'office',
  action:{kind:'delegate',instruction:'read the document'}}
const [a,b] = await Promise.all([f.service.submit(f.member,input),f.service.submit(f.member,input)])
assert.equal(a.taskId,b.taskId)
await assert.rejects(f.service.snapshot(f.bob,f.channel.conversationId))
```

运行：`node --import tsx --test apps/web/test/local-integration/assistant-channel-store.test.mjs`；沿用 `DYOFFICE_TEST_DATABASE_URL` 且必须为测试数据库。无真实数据库时记录未执行，不能通过 mock 替代此门槛。

### Task 3 — 邀请、配对、权限与退出

**文件：** 新增 `modules/assistant-channel/{credentials,service}.ts`、`apps/web/test/local-integration/assistant-channel-membership.test.mjs`；修改 `db/context.ts`、roles 和 Task 2 migration（仅在未发布时）。

**接口：** `service.createChannel(owner,{fileId,editorId})`；`invite(owner,{conversationId,capabilities})`；`claimInvite({invitationToken,name,kind})`；`approve(owner,{applicationId})`；`claimCredential(applicationToken)`；`remove(owner,{membershipId})`；`snapshot(credential,conversationId)`。

- [ ] 先测试同一邀请并发认领只有一个成功、过期拒绝、待批准申请不能读取频道、只允许 owner 批准。
- [ ] 复用 `randomBytes`、现有 tokenHash 和数据库事务锁；禁止复用浏览器 session token 作为外部 token。
- [ ] 给 `BusinessCredential` 增加显式 agent 分支时，复核所有调用点；agent scopes 仅协作操作，原文件/provider 路由不能误接受。
- [ ] 邀请不能要求超出当前用户和文档权限的能力；批准时重算权限交集，批准后所有动作再复核。
- [ ] 移除成员同事务撤销凭证、过期票据、取消待执行任务并写 member 事件；运行中任务转 cancel_requested，已发出的外部副作用不能声称已停止。
- [ ] 测试批准期间用户撤权、领取响应丢失、成员过期、旧连接迟到结果；提交 `feat(assistant): pair and revoke external participants`。

```js
const f = await channelFixture(t)
const invite = await f.service.invite(f.alice,{conversationId:f.channel.conversationId,capabilities:['chat','office.read']})
const attempts = await Promise.allSettled([0,1].map(() => f.service.claimInvite({invitationToken:invite.token,name:'Research Agent',kind:'custom'})))
assert.equal(attempts.filter(x => x.status==='fulfilled').length,1)
```

运行：`node --import tsx --test apps/web/test/local-integration/assistant-channel-membership.test.mjs`。

### Task 4 — 扩展现有 HTTP 与 T17 实时连接

**文件：** 新增 `modules/assistant-channel/routes.ts`、`apps/web/test/local-integration/assistant-channel-http.test.mjs`；扩展 T17 gateway/routes/tickets/sessions/dispatch、`packages/web-contracts/src/realtime.ts`、`apps/web/server/src/app.ts`。

**接口：** `registerAssistantChannelRoutes(app,deps)`；`service.submit(credential,input): Promise<AgentReceipt>`；`service.events(credential,{conversationId,after}): Promise<AgentEvent[]>`；`service.claimTask(credential,{taskId,connectionEpoch})` 返回 claimId；结果回传必须带 claimId。

| 方法 / 路径前缀 `/api/v1/assistant` | 使用者 | 行为 |
|---|---|---|
| POST `/channels` | 浏览器用户 | 绑定文档与当前助手会话 |
| POST `/channels/:id/invitations` | 浏览器用户 | 生成邀请 |
| POST `/join` | 邀请凭据 | 申请加入，只返回申请凭据 |
| GET `/applications/:id` | 申请凭据 | 查询自身批准状态 |
| POST `/applications/:id/approve` | 浏览器用户 | 确认申请 |
| POST `/applications/:id/credential` | 申请凭据 | 一次领取成员凭证 |
| DELETE `/channels/:id/members/:memberId` | 浏览器用户 | 移除并撤销 |
| POST `/actions` | 用户或成员 | 对话、委派、结果、取消 |
| POST `/tasks/:id/claim` | 指定执行者 | 获取有 epoch 的执行 claim |
| GET `/channels/:id`、GET `/tasks/:id` | 授权参与方 | 快照 / 任务查询 |
| POST `/realtime-ticket` | 成员 | 获取 agent audience 的 T17 WS 票据 |

结果 action 内必须带第 1.3 节的 claimId 与 connectionEpoch（严格 schema），普通发送者不能伪造成功回执。浏览器来源在实际 onDone/错误回调后提交，不能把请求接受当成完成。

- [ ] 写用户 CSRF、Origin、外部 Bearer audience、重复请求、非执行者伪造结果的失败测试。
- [ ] 使用 Fastify 已有 body/schema/error 边界和生命周期；扩展单一 WS upgrade 分派，不另启端口。
- [ ] 为 assistant 事件增加明确消息类型；复用 heartbeat、容量和关闭路径；不放开现有 document command dispatcher。
- [ ] 使用 sequence/eventId 回放，所有补发按实时权限过滤；新 epoch 使旧连接的 claim/result 失效。
- [ ] 测试慢客户端容量、二进制/超长帧、断线后游标恢复、移除后存量连接不得再收内容；提交 `feat(assistant): route channel traffic through realtime gateway`。

```js
const f = await channelFixture(t)
const receipt = await f.service.submit(f.member,{requestId:'r2',conversationId:f.channel.conversationId,to:'office',action:{kind:'message',content:'hello'}})
await f.service.remove(f.alice,{membershipId:f.member.membershipId})
await assert.rejects(f.service.events(f.member,{conversationId:f.channel.conversationId,after:0}))
assert.ok(receipt.taskId)
```

运行：`node --import tsx --test apps/web/test/local-integration/assistant-channel-http.test.mjs apps/web/test/local-integration/realtime.test.mjs`。

### Task 5 — 给现有助手增加外部控制入口

**文件：** 新增 `packages/ui/src/assistant-control.ts`、`apps/web/test/shell/assistant-control.test.ts`；修改 Docs AiPanel、Sheets AiChatPanel、UI exports、必要的队列元数据。

**接口：**

```ts
export interface AssistantTaskInput {
  taskId: string
  conversationId: string
  source: {agentId: string; name: string}
  instruction: string
  parentTaskId?: string
}
export interface AssistantControl {
  submitTask(input: AssistantTaskInput): 'accepted' | 'queued' | 'unavailable'
  cancelTask(taskId: string): void
  pauseExternal(): void
  resumeExternal(): void
}
```

Task 5 同时定义 `AssistantTaskEvent` 严格 union：started、text（累计文本及 revision）、tool、yielded（childTaskIds）、completed、failed、cancelled。面板通过 `onTaskEvent(event)` 回调向 host 报告；所有事件携带 taskId 和本次 runId。

- [ ] 写外部任务到达时保留输入框草稿、附件、未发送 skill 与选区的测试。
- [ ] 为 runWith 增加明确 source/context 参数或提取其提交前的最小共用函数；UI 用户提交保留原行为，external 提交显式 attachments=[]、scope=null，禁止触发清草稿逻辑。
- [ ] 注册 `onAssistantReady(control|null)`，复用面板 busy/pendingSendRef/队列；不可直接调用 loop.run 绕过 UI 和历史维护。
- [ ] 从现有 onText/onToolStart/onToolExecuted/onDone/onError 映射事件；建立 runId→taskId 映射，禁止靠最后一条气泡路由并行等待结果。
- [ ] 相同 taskId 只接受一次；busy 时入同一队列并保留用户优先准入；外部事件不得解除用户 hold。pauseExternal 只暂停协作项，不调用用户队列全局 hold；unmount 撤销注册并结算可知状态。
- [ ] 外部 cancelTask 必须匹配当前运行的 taskId；取消排队项不得调用 loop.cancel，取消旧任务不得停止用户后来发起的新 run。测试零外部成员时原发送/停止流程与基线一致。
- [ ] 提交 `feat(assistant): expose task control on existing chat panels`。

行为测试示例（使用既有 React 测试挂载方式，本任务提供 `mountAssistantWithDraft` fixture）：

```ts
const panel = mountAssistantWithDraft({text:'尚未发送', attachments:['draft.txt']})
panel.control.submitTask({taskId:'t1',conversationId:'c1',source:{agentId:'external-1',name:'Research Agent'},instruction:'读取标题'})
expect(panel.composerText()).toBe('尚未发送')
expect(panel.composerAttachments()).toEqual(['draft.txt'])
expect(panel.runCount('t1')).toBe(1)
```

运行（`apps/web` 目录）：`npm run test:shell -- test/shell/assistant-control.test.ts`。再运行 Docs/Sheets 现有助手相关测试。

### Task 6 — 接通浏览器与服务端的任务生命周期

**文件：** 新增 `packages/browser-host/src/assistant-channel.ts`、`apps/web/test/unit/assistant-channel-client.test.mjs`；扩展 T17 editor-bridge、editor-realtime、Web assistant.tsx/native-docs/sheets-entry。

**接口：** `createAssistantChannelClient({request,bridge,conversationId,onTask})` 返回 submit/claim/report/dispose；bridge 使用 Task 4 扩展事件订阅，不创建新 socket。`onTask` 在 claim 成功后才调用 Task 5 control。

- [ ] 测试同一事件重发两次只提交一次、重复标签页只有一个 claim 成功、旧 generation 回执拒绝。
- [ ] 注册在线执行者与绑定文档，执行前再次读取频道/编辑器状态；切标签不改目标，重开文件不得复用旧 runId。
- [ ] 将 onTaskEvent 上报；completed 与最终结果事务更新；文本累计快照合并，防止回放产生重复文字。
- [ ] 协作 client 的 dispose 只取消协作订阅和未派发协作任务，不调用整个 editor assistant.dispose 或关闭共享 editor bridge；网络中断不立即伪报失败，重连先查询 task 状态与本地执行记录，未知结果进入 unknown_outcome。
- [ ] 原助手先完成可用装配，协作 client 按需独立初始化；模拟邀请接口 503、WS 失败和适配器不可用，原生用户消息、模型选择及保存仍可执行。
- [ ] 登录切换时销毁原 client，沿用现有 bound session proof，不把旧频道用新 cookie 自动恢复。
- [ ] 提交 `feat(assistant): bind editor task execution to channel sessions`。

```js
// replayFixture 在本测试文件内提供可重复事件源及 submit 计数。
const f = replayFixture()
await f.deliver({eventId:'e1',sequence:1,taskId:'t1'})
await f.deliver({eventId:'e1',sequence:1,taskId:'t1'})
assert.equal(f.submissions('t1'),1)
await f.disconnectAndReconnect()
assert.equal(f.submissions('t1'),1)
```

运行：`node --import tsx --test apps/web/test/unit/assistant-channel-client.test.mjs apps/web/test/unit/editor-bridge-reconnect.test.mjs`。

### Task 7 — 最小让出能力与双向委派 Skill

**文件：** 新增 `packages/agent-core/src/delegation-skill.ts`、`packages/agent-core/tests/delegation-skill.test.ts`、`packages/agent-core/tests/loop-yield.test.ts`；修改 loop/types/index、现有面板 composeSkills；扩展 channel service 的父子任务转换。

**接口：** `AgentLoopOptions.allowDelegationYield?: boolean`（默认 false）；`AgentLoop.requestYield(taskIds: readonly string[]): void`；`AgentRunResult.yielded?: {taskIds: string[]}`；`createDelegationSkill({listAgents,submit,requestYield})` 返回 AgentSkill。工具名固定为 `list_agents`、`send_agent_message`、`delegate_agent_task`，仅向主动启用协作且具有授权成员的会话追加，发送对象仅允许当前频道成员。

- [ ] 用现有 scripted transport 写失败测试：委派返回 taskId 后 loop.busy 变 false，历史中每个 tool_call 都有结果，父业务任务仍 waiting_peer。
- [ ] requestYield 仅允许显式启用的协作 run，未启用时拒绝调用且不改变运行状态；finishTurn 结算该模型回合所有工具后让出。取消与错误覆盖 yield；下一次 run 清空 yield 标记；默认构造的 AgentLoop 与原生普通 run 测试保持通过。
- [ ] 委派 Skill 不等待外部完成，不把服务端地址/凭证暴露给模型，不包含其他 Agent 的未授权私有上下文。
- [ ] 父任务 continuation 由服务端子任务终态触发，requestId 使用确定的父任务+子结果版本；同一子结果只恢复一次。
- [ ] 测试子结果早于父 yield、多个子结果乱序、父请求取消后子结果到达；yield 的事务处理必须读取已保存的依赖终态，避免遗漏唤醒。
- [ ] 对 send_agent_message：等待回复时也使用被返回的 child taskId 让出；纯结果通知不产生新任务，避免自动对话循环。
- [ ] 运行 Office→外部 Agent→Office 的嵌套追问测试；支持根任务期限、深度/数量预算以及取消整棵协作任务树，不取消无关原生任务。
- [ ] 提交 `feat(agent): yield and resume delegated collaboration tasks`。

核心测试期望（fixture 复用现有 loop.test.ts 的 transport 风格）：

```ts
expect(loop.busy).toBe(false)
expect(runResult.yielded?.taskIds).toEqual(['child-1'])
expect(parentTask.state).toBe('waiting_peer')
// 收到 child-1 关联的反向询问后可启动另一个 Office run。
expect(reverseQuestion.state).toBe('running')
expect(parentTask.state).toBe('waiting_peer')
```

运行：`npm run test -w @genoffice/agent-core -- tests/loop-yield.test.ts tests/delegation-skill.test.ts tests/loop.test.ts`。

**授权注意：** 基础工具策略保持实施时已有行为；外部协作任务再按其可信来源收窄权限。新增委派工具单独授权，不能混入 `ASSISTANT_READ_TOOLS` 对所有会话开放。只有请求委派能力或执行外部任务时才携带服务端验证的协作绑定；原生请求不强制新增频道字段，也不依赖协作服务在线。扩展 browser assistant 与 provider gateway，新增 `apps/web/test/local-integration/assistant-channel-provider.test.mjs`，同时验证伪造频道不能扩大工具集合、协作不可用不影响原生模型调用。

### Task 8 — 邀请、头像、任务卡片与用户控制 UI

**文件：** 新增 `packages/ui/src/assistant-participants.tsx`、`apps/web/test/shell/assistant-participants.test.ts`；修改两类面板和各自既有 i18n 分片；样式优先使用现有 tokens 与组件。

**输入：** channel snapshot、AgentEvent、Task 5 control。**输出：** 成员栏、邀请/确认/撤销操作、来源标记、taskId 绑定卡片。

- [ ] 用户可以创建邀请、看待加入身份与权限、批准或拒绝、移除成员；未批准成员不出现在可委派对象中。
- [ ] 当前聊天显示内置头像、名称、来源、在线状态；harness 名称仅为展示值，不授予特殊可信身份。未知类型使用首字母/通用图标，不拒绝符合协议的已授权 Agent。
- [ ] 支持接收方选择，普通输入默认 Office；`@` 若需复杂编辑器改动，首期用现有下拉样式提供接收方选择，不为此引入富文本输入框。
- [ ] 等待外部、停止请求中、已停止、结果待核对具有不同文案；原 Stop 保留既有行为，暂停外部协作允许用户继续本地任务；移除后仅禁用该接收方。
- [ ] 未启用或未连接时保留原聊天布局与默认 Office 接收方，仅显示可选添加入口；外部异常采用任务卡片提示，不用阻塞弹窗或全局错误页覆盖文档。
- [ ] 默认不显示内部 thread ID、claim、token、原始协议；技术详情放开发诊断，不进入常规用户流程。
- [ ] 测试浅色/深色、键盘操作、姓名超长、并发等待卡片、刷新后快照、未发送草稿不丢失；提交 `feat(ui): show channel participants and delegated task controls`。

```ts
expect(screen.queryByText('已停止')).toBeNull()
// 模拟服务端 cancel_requested，不能提前显示停止成功。
await fixture.emitTaskState('cancel_requested')
expect(screen.getByText('正在停止')).toBeTruthy()
await fixture.emitTaskState('cancelled')
expect(screen.getByText('已停止')).toBeTruthy()
```

运行（apps/web）：`npm run test:shell -- test/shell/assistant-participants.test.ts`；仓库根运行 `npm run check:theme-colors` 和相关包 typecheck。

### Task 9 — 在现有 CLI 中实现通用连接器与薄适配器

**文件：** 新增 `packages/cli/src/commands/agent.ts`、`packages/cli/src/agent-channel/{client,connector,adapters}.ts`、`packages/cli/tests/agent-channel.test.ts`、`packages/cli/tests/harness-adapter-contract.test.ts`；修改 cli.ts、README。具体已验证适配模块放在 `agent-channel/adapters/`，模块名按实际目标命名，如 `dsh.ts`、`codex.ts` 或 `claude-code.ts`；不为尚未验证的目标生成空适配器。

**接口：** 内部 `HarnessAdapter` 只表达已验证能力：

```ts
interface HarnessAdapter {
  readonly descriptor: {
    kind: string
    version: string
    capabilities: {resume: boolean; stream: boolean; cancel: boolean; reverseRequest: boolean; parallelSessions: boolean}
  }
  openSession(binding: {conversationId: string; resumeId?: string}): Promise<{sessionId: string}>
  send(input: {sessionId: string; taskId: string; content: string}): Promise<void>
  cancel(input: {sessionId: string; taskId: string}): Promise<void>
  subscribe(listener: (event: HarnessEvent) => void): () => void
  close(): Promise<void>
}
type HarnessEvent =
  | {type:'text'; sessionId:string; taskId:string; text:string; revision:number}
  | {type:'request_office'; sessionId:string; taskId:string; requestId:string; content:string}
  | {type:'completed'; sessionId:string; taskId:string; summary:string}
  | {type:'failed'; sessionId:string; taskId:string; error:string}
  | {type:'cancelled'; sessionId:string; taskId:string}
```

这是拟议的内部适配契约，不声称任何 harness 原生具有同名 API。send 的成功只表示接受任务，completed 才是完成。resumeId 仅在 resume 能力成立时接受；不支持 cancel 则返回明确的不支持错误，任务保留待核对，不能伪造 cancelled。缺少 reverseRequest 的适配器可以展示有限对话能力，但不得宣称已支持双向委派闭环。

- [ ] 复用 CommandRegistry/CommandResult/退出码，拟议命令：`genoffice agent connect --server <origin> --harness <adapter-id>`；adapter-id 从静态受支持适配器表选择，邀请凭据通过交互输入或专用 stdin 读取，不作为命令行参数。自定义 Agent 也可直接实现公开 HTTP/WS 协议，无须伪装成已知品牌。
- [ ] connect 完成申请后等待 owner 批准，取得凭证并主动连接 T17；持久配置复用 CLI 既有配置目录规则，凭证文件仅当前用户可读；日志不输出明文。
- [ ] 提供 `genoffice agent status`、`genoffice agent disconnect`、`genoffice agent send` 最小操作；send 复用已配对身份，不能凭裸 channel ID 加入。
- [ ] 依据 Task 0 的真实接口实现首个 adapter：每频道独立会话，工具请求映射 Office action，回复按 requestId 回注；核心 service/协议/UI 不出现对该品牌的分支。
- [ ] 适配器按选择惰性加载；某个 SDK 缺失或初始化失败只影响该外部连接。凭证与配置由各适配器管理，不修改 Office 自身模型配置，不在 Office 启动时要求安装外部 CLI。
- [ ] 若目标 harness 等待 Office 回复时阻塞整条会话，连接器使用其允许的并发工具通道或独立关联子会话；不能把反向询问塞进被阻塞输入队列。不具备条件时报告该模式不支持。
- [ ] 用两种不同能力集的假 harness 跑相同契约测试，覆盖会话映射、断线去重、退出、取消确认和恢复；首个真实适配器再执行完整小任务，记录版本与实际调用。
- [ ] 第二种真实适配器复用相同契约测试，新增改动限定于适配模块、注册项、帮助文案和测试；若要求修改频道数据库或 Office 调度，先说明通用契约缺口并修正设计。
- [ ] 不猜造原生命令或插件签名；单个 harness 能力门未通过，仅标记该适配器未支持，不能让其他适配器或 Office 不可用。
- [ ] 提交 `feat(cli): connect external harnesses through shared adapters`。

```ts
const a = await adapter.openSession({conversationId:'channel-a'})
const b = await adapter.openSession({conversationId:'channel-b'})
expect(a.sessionId).not.toBe(b.sessionId)
await adapter.send({sessionId:a.sessionId,taskId:'t1',content:'request office data'})
expect(recordedOfficeRequest.taskId).toBe('t1')
```

运行：`npm run test -w @genoffice/cli -- tests/agent-channel.test.ts tests/harness-adapter-contract.test.ts`。真实验收按 harness/version 使用 Task 0 的可复现命令，不以 mock 测试替代；兼容表分别记录已验证、能力受限和未验证。

### Task 10 — 实时控制、异常恢复与资源回收

**文件：** 扩展 service、连接器、browser client；新增 `apps/web/test/local-integration/assistant-channel-recovery.test.mjs`、`apps/web/test/unit/assistant-channel-recovery.test.mjs`。

**接口：** 沿用 Task 4 claim 与 sequence，不增加第二个恢复协议。增加 `service.reconcile(credential,{taskId,claimId,connectionEpoch,outcome})`，仅接受已记录执行者的可核对结果，终态冲突返回 409。

- [ ] 测试原生 Stop 保留原队列语义；外部任务取消/外部协作暂停不暂停原生用户任务。迟到完成不能重新唤起已取消根任务；已完成结果可记录，但不得覆盖用户取消决策或伪报回滚。
- [ ] 明确 completion/cancel 的事务竞态：成功先提交则取消返回 succeeded；取消先提交且收到同一有效 claim 的完成回执，记录已执行事实并将取消请求结算为 cancelled，附带 outcome 指出取消前或取消过程中已发生的效果。缺少可信回执时转 unknown_outcome，不能静默丢弃执行事实或显示已回滚。
- [ ] 测试断线前已领取、已执行但未回执、服务端重启、浏览器重开、外部进程退出；未知结果不自动重复执行。
- [ ] 测试重连旧 epoch 无法领取/完成任务；游标过期取快照；重复回放不启动模型。
- [ ] 加入 deadline/深度/数量预算、超量队列拒绝、过期邀请与事件清理；复用现有服务生命周期，不新增后台守护服务。
- [ ] 验证发送前撤权复查、已撤销外部 Agent 不再收到文档内容；取消无法确认时维持 unknown_outcome 并提示核对。
- [ ] 在一个 harness 崩溃、满额、断线和 malformed frame 情况下，验证另一 harness 与 Office 原生助手仍可工作；关闭协作不得关闭 T17 原文档同步连接或影响保存。
- [ ] 提交 `fix(assistant): reconcile cancellation and reconnect outcomes`。

运行：`node --import tsx --test apps/web/test/local-integration/assistant-channel-recovery.test.mjs apps/web/test/unit/assistant-channel-recovery.test.mjs`。

### Task 11 — 多 harness 契约验收、Office 回归与默认关闭发布

**文件：** 新增 `apps/web/test/local-browser/assistant-channel.test.mjs`、`apps/web/test/local-browser/assistant-channel-native-regression.test.mjs`、`apps/web/test/local-integration/assistant-channel-isolation.test.mjs`、`docs/dyoffice/evidence/assistant-channel-e2e.md`；更新 CLI README、用户接入说明和现有功能开关装配。

- [ ] 复用既有浏览器 fixture，创建合成 DOCX/XLSX 测试文档；模型和各 harness 凭据使用现有授权测试配置，不写进日志/截图。
- [ ] 分别验收：外部主动询问、Office 主动委派、外部关联追问、Office 回复后外部继续、父任务最终汇总。
- [ ] 验收加入确认、头像/来源、接收方选择、不同频道上下文隔离、实时停止、断线重连、移除后旧连接失效。
- [ ] 用首个真实 harness 与真实 Office 模型完成闭环；第二种真实 harness 使用同一验收流程，分别记录精确版本、能力、时间线与结果。只有首个通过时仅发布该适配器兼容声明，不把“协议通用”写成“所有 harness 可用”。
- [ ] 测量消息传输延迟，不把模型生成耗时算作网络延迟；单实例 p95 <1 秒、补偿 <3 秒作为初始目标，记录样本数、环境及未达标原因。
- [ ] 功能默认关闭；开启仅增加协作能力。关闭时拒绝协作新任务、请求取消对应任务、断开外部连接并退订浏览器协作流；保留原编辑器连接、原助手和已记录任务，不全局 dispose。
- [ ] 对关闭、开启但零成员、正常连接、harness 离线、适配器缺失、协作接口 503、协作配额耗尽、关闭正在等待的协作共八种状态，运行 Task 0 的原生功能回归；聊天、模型选择、Skills、工具、编辑保存、撤销、取消均符合原基线。
- [ ] 测量关闭状态不新增协作请求/轮询/模型调用；开启状态协作故障不会把原生任务拒绝或延迟到外部超时后才执行。原生操作时延与 Task 0 基线比较，稳定环境多次样本 p95 回退不超过 10%，超出须定位且不能宣称“不影响”。
- [ ] 运行局部测试、类型检查、构建和既有助手回归；文档标明“增强功能可关闭”“按适配器版本声明支持”“当前文档需打开”“外部首期只读不限制原生能力”“移除不回滚”。
- [ ] 提交 `test(assistant): verify harness interoperability and native isolation`；真实闭环与原生回归都通过才完成首期。

测试命令从仓库根执行：

```bash
node --import tsx --test apps/web/test/local-browser/assistant-channel.test.mjs
node --import tsx --test apps/web/test/local-browser/assistant-channel-native-regression.test.mjs
node --import tsx --test apps/web/test/local-integration/assistant-channel-isolation.test.mjs
npm run test -w @genoffice/agent-core
npm run test -w @genoffice/ui
npm run test -w @genoffice/cli -- tests/agent-channel.test.ts tests/harness-adapter-contract.test.ts
npm run typecheck:web
npm run typecheck:web:docs
npm run typecheck -w @genoffice/agent-core
npm run typecheck -w @genoffice/ui
npm run typecheck -w @genoffice/cli
npm run build:web
npm run build:web:docs
git diff --check
```

Sheets 编辑器另执行现有 `apps/web` 的 `build:sheets` / `test:native-sheets` 及其类型检查配置；需原生依赖时按项目既有流程准备，不把依赖缺失记成测试通过。

### Task 12 — 后续文档写入集成（独立交付）

**文件：** 复用 `modules/commands/{service,approval,journal,postgres-journal,http-service,routes}.ts` 及当前编辑器的执行/保存桥；新增 `apps/web/test/local-integration/assistant-channel-write.test.mjs` 和对应浏览器验收。

- [ ] 先核实 T14 文档命令链已对目标格式真实验收；若尚未完成，保持写入能力不可申请。
- [ ] 为 membership 增加显式 office.write 能力，并在邀请批准、每次派发、命令事务中求权限交集。
- [ ] 将 Office 生成的写工具调用绑定 commandId、argsHash、fileId、baseRevision、editorGeneration、leaseEpoch，走原审批/执行/收据链。
- [ ] 同一文档写入串行；外部结果中的脚本、操作列表或“已修改”声明不能直接变成可信写操作。
- [ ] 分别显示“内容已应用”和“新修订已保存”；使用现有撤销/修订恢复，不设计跨 harness 分布式回滚。
- [ ] 验证旧版本拒绝、审批后撤权、用户编辑冲突、执行回执丢失与断线恢复，真实保存并重新打开文档核对。
- [ ] 独立提交与验收；首期完成不能被解释为本阶段已完成。

## 4. 交付顺序与依赖

```text
Task 0 Office 原生基线、依赖与候选 harness 接口证据
  → Task 1 协议
  → Task 2 持久化 → Task 3 邀请/身份 → Task 4 实时路由
  → Task 5 现有助手控制 → Task 6 浏览器绑定
  → Task 7 双向委派/yield → Task 8 参与者 UI
  → Task 9 通用连接器与已验证薄适配器
  → Task 10 恢复与隔离 → Task 11 真实闭环与 Office 原生回归
  → Task 12 写入（独立后续）
```

按可审阅交付划分：A（0–4）通用协议与连接；B（5–8）现有助手可选增强；C（9–11）真实 harness 双向闭环与 Office 故障隔离；D（12）外部文档写入。C 的首个真实适配器和原生回归通过后可发布明确兼容范围的版本；第二种真实适配器通过后才声明多 harness 已验证。

## 5. 必测验收矩阵

| 场景 | 可观察成功条件 | 任务 |
|---|---|---|
| 首次加入 | 一次邀请只能一个申请、批准前无频道数据、批准后出现身份 | 3/8/11 |
| 双向主动对话 | 两侧均能发起，回复落到原任务/频道 | 4–9/11 |
| 交叉委派追问 | Office 等待时可处理外部关联请求与用户任务，无双向死锁 | 7/9/11 |
| 多 Agent / 多频道 | 显式收件人；任务、会话和数据无串线 | 2–4/9 |
| 用户草稿 | 外部任务不清输入、不带走附件、不读取未授权选区 | 5/8 |
| 重复与掉线 | 重放只更新显示，不重跑工具；不明结果可核对 | 4/6/10 |
| 实时停止 | 停止请求可见、执行者确认后终态；协作暂停仅作用于协作，原生 Stop 保持基线语义 | 5/7/10 |
| 撤权移除 | 存量 WS 不能继续读写；旧 epoch/凭据失效 | 3/4/10 |
| 结果可信度 | 文本声称完成不能替代实际完成事件与保存收据 | 4/11/12 |
| 桌面/原助手回归 | 未启用协作时原聊天、工具、取消、UI 工作正常 | 5/7/11 |
| 多 harness 通用性 | 相同协议/数据库/UI；差异只在已验证适配模块，能力受限明确可见 | 0/1/9/11 |
| 可选增强 | 无适配器、关闭或零成员时原启动和原生模型调用不依赖协作入口 | 5/6/11 |
| 故障隔离 | 外部 503/离线/满额/崩溃不影响 Office 或另一成员 | 6/10/11 |
| 暂停隔离 | 暂停外部/取消旧 task 不停止新用户 run，不清草稿或全局历史 | 5/7/10/11 |
| 原生权限保留 | 外部只读限制只对外部任务生效，用户原有工具能力符合基线 | 0/7/11/12 |

## 6. 执行注意与计划审阅记录

- 基线先合并 Web 助手与 T17 的正式交付，避免在新分支重新开发它们。候选路径是依赖证据，不是批准复制未提交代码。
- 每个 harness 的真实 API 都是独立能力门；dsh 只是候选示例。原生命令和插件签名必须来自 Task 0 实证，不因一个适配器未完成而阻塞 Office 原有功能。
- 同一频道任务历史与模型上下文不等价：持久任务保存目标/关联/最终摘要，模型完整历史仍由现有助手维护。刷新后不得宣称恢复了原模型隐藏状态。
- 不复用不匹配的抽象：模型 SSE 不承载 Agent 会话；文档命令日志不保存聊天；React 内存队列不冒充持久任务表；外部凭证不冒充浏览器会话。
- 若实际代码要求增加未列明包、独立服务或第二个调度器，先回到复用清单说明缺口，再更新对应任务。
- 本次文档核对范围：路径/候选状态、迁移冲突、接口一致性、通用 harness 接入、Office 原功能保护、需求覆盖和关键状态竞态。产品回归与真实 harness 验收均尚未执行。
