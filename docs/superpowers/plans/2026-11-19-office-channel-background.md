# DyOffice Web SaaS 后台任务与频道分享实施计划

> **执行方式**
> 使用 superpowers:executing-plans 按任务实施。各阶段先运行能复现缺失行为的测试，再做最小实现并回归。

**目标**
用户从 DyOffice 登录后的工作区首页直接创建和分享频道、批准 DSH 连接，并查看后台任务。关闭目标文档和浏览器后，已配对的 DSH 仍可发起读取已保存版本的任务，并查询结果。

**范围与验收依据**
延续现有 [助手频道协作方案](2026-11-17-office-harness-collaboration.md) 和 [双向频道验收记录](../../dyoffice/evidence/assistant-channel-bidirectional-integration.md)。本计划增加 DSH → Office 的离线执行，以及工作区入口。Office → DSH 继续走现有外部频道协议，自动接入真实 DSH Web/桌面会话仍需单独联调。

**技术栈**
Fastify、PostgreSQL、现有对象存储、React Web 工作区、DyOffice 模型网关。后台执行在 DyOffice Web 服务进程内启动，队列保存在 PostgreSQL。DSH 使用现有 HTTPS 频道协议。

## 实施进度（2026-11-19）

首页入口、无文档频道、后台队列/执行、任务列表与结果查询已实现；相关类型、协议、组件和 PostgreSQL 集成已验证。详见 [验证记录](../../dyoffice/evidence/assistant-background-2026-11-19.md) 与 [运维说明](../../dyoffice/assistant-background.md)。

完整浏览器登录/关闭/重开流程、隔离测试环境双进程强制终止/恢复及排空演练已完成。另以官方 DSH 0.2.2-rc.1 headless 和既有默认真实模型完成配对、浏览器关闭后后台读取及首页结果核对，任务和版本证据见验证记录。下列计划项均已完成；原 DSH Web/桌面会话自动控制仍属于范围说明中独立的后续集成。

## 用户流程

1. 登录后，工作区首页侧栏直接展示「频道分享」和「后台任务」。两者同级可见。
2. 在「频道分享」点击「创建频道」即可生成和复制邀请。空工作区也可创建、分享和管理多个频道。
3. DSH 用邀请提交连接申请。用户在频道详情看到申请的名称和类型，可点「批准连接」或「拒绝」。批准后，DSH 兑换该频道的成员凭证。现有邀请 5 分钟内有效且只能使用一次。成员凭证最多有效 24 小时，原授权会话也必须有效。此期间可提交多个任务。用户可暂停频道或移除成员。
4. 需要读取文档时，频道所有者再在详情中授权目标文档并开启「允许后台读取已保存版本」。首期每个频道最多关联一个文档，沿用现有任务协议。首期对 DOCX 开放，支持提取文字和基于文字的问答。产品界面展示读取能力和适用格式。
5. DSH 使用现有 `delegate` 动作带上 `execution: "saved-revision"`。Office 按频道后续授权的文档冻结提交时的已保存版本，返回任务 ID，由后台读取和处理。普通频道任务照常由浏览器编辑器领取。
6. 「后台任务」跨文档列出任务，显示文件名、频道、来源成员、提交时间、状态和已保存版本。点击查看结果，或跳到来源频道、打开来源文档。列表和详情读取后台记录，浏览器关闭不影响执行。文档内原有「任务」页也能显示本频道后台任务。
7. 重新打开浏览器后，工作区入口可查看已完成、失败、取消或结果待核对的记录。DSH 使用原有单任务接口查询同一任务 ID 和结果。

## 数据与执行契约

| 项目 | 约定 |
| --- | --- |
| 任务发起 | 只接收已批准成员发往 `office` 的 `delegate` 动作。可携带现有 `parentTaskId`，沿用链路深度与期限。 |
| 执行位置 | 新增可选 `execution: "saved-revision"`。该值仅允许成员向 Office 发起委派。省略该值表示现有浏览器执行方式。 |
| 授权 | 频道属于创建它的工作区用户。频道可以没有关联文件。设置与审批沿用已登录所有者的会话和 CSRF 校验，成员请求沿用现有 Bearer 和成员有效期。封存授权绑定部署、频道、文件、任务、成员、版本与原授权会话。 |
| 版本 | 入队事务冻结 `current_revision`、大小与 SHA-256。文件 ID、存储位置和版本由服务端解析。结果带版本 ID，供 DSH 和首页核对。 |
| 首期限制 | DOCX 保存版文字，文件上限 10 MiB，抽取文字上限 24,000 字符，任务结果上限 16 KiB UTF-8。图片和布局不参与回答，截断时返回明确说明。 |
| 模型 | 使用所有者可用的 DyOffice 默认模型和现有额度链。模型只接收任务指令和绑定版本的有限文本，工具列表为空。关闭或缺少模型时报出可读错误，不切换其他账号的模型。 |
| 状态 | 沿用频道任务状态。单线程实例领取一个，按频道继续保持 Office 并发约束。尚未领取的任务遵循现有截止时间，已开始而结果未确认的任务进入「结果待核对」。 |
| 部署条件 | 新增 `DYOFFICE_ASSISTANT_BACKGROUND=on`，默认关闭。启用时要求助手频道、对象存储、可用模型网关和独立受限的调度数据库身份。调度逻辑随 Web 服务运行。 |

示例请求体可沿用成员动作接口。服务端首先校验该成员、频道和文档授权，然后才创建后台任务。

```json
{
  "requestId": "d270ba5c-12c1-437a-9c3c-4099d87d4a9d",
  "conversationId": "cc2e5791-966a-4f79-8547-62b2bbe212d2",
  "to": "office",
  "action": {
    "kind": "delegate",
    "instruction": "列出已保存文档中的预算总额和单位。",
    "execution": "saved-revision"
  }
}
```

## 前置任务 · 支持无文档频道

- [x] 允许已登录的工作区用户调用 `POST /api/v1/assistant-channels/channels`，请求体为 `{}`，返回新频道 ID 和 `fileId: null`。每次明确创建均可新增一个频道，重复提交同一次创建时复用同一个客户端生成的 conversationId。原有携带 fileId 的编辑器调用继续生效。
- [x] 迁移放宽 `assistant_channels.file_id` 的非空限制，保留旧频道的文件关联。修改 createConversation、channel 和快照契约，按部署和所有者校验频道，有关联文件时再调用 loadFile。无文档频道可邀请、批准和撤销成员，文档后台任务在尚未授权文件时返回可识别错误，不入队。
- [x] 所有者可通过受 CSRF 保护的频道设置接口关联自己当前可读的文档，首次关联在同一事务校验文件和频道。成员不能设置目标文件，已有文件关联不可用另一文件覆盖。真实 HTTP 测试覆盖空工作区创建两个频道、同一创建重试、跨账号拒绝和旧文档频道兼容。

## 任务 1 · 入队、版本冻结和浏览器领取隔离

文件涉及 `packages/web-contracts/src/assistant-channel.ts`、`apps/web/server/src/modules/assistant-channel/{service,routes}.ts`、`apps/web/server/src/db/{migration-manifest,roles}.ts`、新增数据库迁移和 `packages/browser-host/src/assistant-channel.ts`。当前迁移清单到 `0036`，实施时顺延。

- [x] 增加 `assistant-channel-contract.test.mjs` 用例。显式后台模式能解码，相同模式放在 `message` 或 `result` 会失败。成员向非 Office 对象发同类动作时返回拒绝。运行单测并确认缺失协议字段导致失败。
- [x] 在真实 PostgreSQL 的 `assistant-channel-background.test.mjs` 中，导入测试文件，配对成员并发同一请求两次。断言只生成一条队列记录并返回相同任务 ID。断言原浏览器领取接口不能领取该任务。未开启后台读取、成员失效、或格式不支持时，断言不会生成后台记录。
- [x] 在频道表增加后台读取开关，在任务表增加后台执行标记和保存版本证据。新增按租户及所有者约束的后台队列表，保存任务 ID、可调度时间、封存授权和领取租约。队列中不存文档正文。
- [x] 在现有 `submit` 的事务中，完成成员、频道设置、格式和文件大小校验后，使用 `loadFile` 读取当前已保存版本。将任务、队列、事件和幂等回执原子写入。封存授权使用频道密钥分离用途，凭证仅用于服务端恢复和验证原所有者权限。
- [x] 在浏览器队列筛选和服务端 `claim` 两层排除后台任务。后台执行使用独立领取和结算路径，后台 claim ID 无法通过现有浏览器结果、协调或让出接口结算。给任务 DTO 增加可选后台标记和版本 ID，沿用成员单任务查询。
- [x] 通过协议、浏览器客户端和数据库用例。复验普通频道任务、父任务继续和幂等回执。

## 任务 2 · 后台领取、只读执行与状态回传

新增 `apps/web/server/src/modules/assistant-channel/background-{store,runner,read}.ts`。接入 `app.ts`、`index.mjs` 与 providers 现有模型网关。调度权限参照 `0007_jobs.sql` 和 `jobs/worker-store.ts`。

- [x] 先写真实 HTTP、PG 和对象存储用例。全程不开编辑器，由已配对成员发任务。使用确定性模型传输，断言其输入确实包含测试 DOCX 里的预算额，且 DSH 侧查询到终态与冻结版本。另测任务提交后保存新版，后台仍使用旧版本。
- [x] 为队列表增加有待处理记录的索引。调度角色只可调用固定范围的领取、租约与过期处理函数，函数固定 `search_path`，结果仅返回任务身份和封存字段。角色无业务表通用访问。队列用短事务和原子锁领取，获得租约后释放连接，再读文件和调用模型。
- [x] 以原所有者会话进入 `PrincipalTransactions`，确认成员仍有效、频道未暂停且允许后台读取、文件未进回收站、版本身份和任务 claim 一致。使用原有文件权限和对象存储的 `readVerified` 读取该版本，在读正文及发起模型前重新确认授权。解析调用 `@genoffice/file-parse` 的 `docxToText`，在有超时和内存限制的 worker thread 内运行。模型调用通过现有 provider 管道，复用模型鉴权、额度和取消机制。
- [x] 写回前再校验会话、成员、文件、后台开关、租约与任务期限。使用已有任务状态、事件和父任务唤醒逻辑，在同一事务写入结果并清除队列中的封存凭证。暂停、撤销或取消后只保存对应终态，不发布正文。授权失效后由受限调度函数清理剩余队列和封存授权。
- [x] 在进程停止时停止新领取，取消活跃 I/O，并在关闭连接池前等待执行结束。重启继续扫描未领取任务。已开始执行的任务租约丢失后进入「结果待核对」，拒绝旧进程的迟到写回。加入退避，空队列优先采用 1 秒初始轮询并允许延长至 5 秒。
- [x] 验证两个实例只执行一次、撤权时结果不可见、关闭浏览器不影响任务、服务重启能恢复排队项。用模型调用次数和 PostgreSQL 状态验证通路，日志只留任务 ID、状态、耗时和错误码。

## 任务 3 · 工作区入口和频道分享

修改 `apps/web/src/shell/local-main.tsx` 与 `apps/shell/src/renderer/src/Home.tsx`。通过 `HomeProps` 增加一个可选的导航插槽，仅 Web SaaS 注入两个入口。新增 `apps/web/src/shell/AssistantChannelsPage.tsx` 和使用已绑定会话的工作区客户端。

- [x] 先写工作区组件用例。不打开文档，从空工作区首页进入「频道分享」，直接创建频道、打开已有频道、复制邀请、批准连接、暂停和移除成员。审核表单显示待连接实例的名称和类型，重复点击有加载状态。
- [x] 增加所有者频道列表 `GET /api/v1/assistant-channels/channels`，可按文件过滤，采用有界游标分页与当前用户 RLS。登录首页复用现有文件选择与打开文档能力。保留多个频道时的选择列表，通过明确的频道 ID 打开频道。已登录用户可查看自己创建的无文档频道及有文件访问权的文档频道。
- [x] 首页创建频道、邀请、批准、暂停和移除直接调用已有接口。页面只管理频道，无需创建或抢占浏览器执行连接。后台读取开关调用新增的所有者路由 `POST /channels/:id/background`。
- [x] 无文档频道提供创建邀请和管理连接操作。已关联文档的频道提供「打开文档」。当用户从频道卡片打开文档时，导航携带明确的 `conversationId`，复用现有 `createConversation` 校验文件与频道的绑定。编辑器已有本地频道记录时仍以用户明确选中的频道为准。展示分享链接时使用无凭证的内部导航地址，复制的一次性邀请沿用现有流程。
- [x] 验证首页可生成邀请、完成连接批准且编辑器注册次数为零。验证刷新与换浏览器都能找到原频道。测试其他账号访问列表、详情、审批和后台开关均不能读取或修改目标频道。

## 任务 4 · 首页后台任务列表和详情

新增 `apps/web/src/shell/BackgroundTasksPage.tsx`，复用现有工作区页面容器。服务端增加所有者专用列表和详情。

- [x] 先写 UI 和真实 HTTP 用例。用户没有打开任何文件即可从首页看到自己的排队、运行、完成和失败记录，打开详情看到已保存版本与最终结果。另一账号的任务不可见。
- [x] 增加 `GET /api/v1/assistant-channels/background-tasks` 与 `GET /api/v1/assistant-channels/background-tasks/:taskId`。列表只返回有界预览，每页最多 50 条，按 `created_at, task_id` 游标排序。详情复查当前文件权限。已删除或失去访问权的文档内容不返回。
- [x] 状态用语沿用文档内「任务」页。首页提供查看详情、定位来源频道、打开来源文档，以及任务仍可取消时的「取消任务」。取消走现有频道 `actions` 权限链。在任务页面可见且有活动任务时刷新，页面离开或身份切换后停止。
- [x] 文档内任务卡使用相同任务 ID、终态和摘要，显示「后台读取 · 已保存版本」。复验首页与文档详情是同一条任务，关闭、刷新或再打开文档不会重复执行。

## 回归与发布验收

- [x] 增加一条真实部署路径验收。用拥有者登录 DyOffice，从空工作区首页创建频道，生成邀请并批准真实 DSH 实例。随后导入测试 DOCX 并授权该频道后台读取。关闭全部 DyOffice 标签页。让 DSH 发起一次 DOCX 读取并显示返回结果。再登录 DyOffice，直接从首页任务详情找到同一任务、来源频道和版本。用含固定测试数据的文档验收。
- [x] 跑 Web 类型检查和本地集成。首次运行用 `DYOFFICE_TEST_DATABASE_URL` 指定可丢弃 PostgreSQL。先跑新增专项用例，再跑现有频道 HTTP、浏览器双向、父任务恢复和共享模型额度用例。
- [x] 在测试环境演练开关关闭、队列清理、进程重启和两实例并行。关闭接收新后台任务后，由已启用的实例完成排空或明确取消，再停掉执行。保留任务记录供用户查询。
- [x] 把接入例子写入 DyOffice 运维文档，说明从首页分享频道、DSH 使用 `execution` 的请求示例、可处理格式、已保存版本范围、取消与查看结果路径。

```bash
node --import tsx --test apps/web/test/unit/assistant-channel-contract.test.mjs apps/web/test/unit/assistant-channel-client.test.mjs
node --import tsx --test apps/web/test/local-integration/assistant-channel-background.test.mjs apps/web/test/local-integration/assistant-channel-http.test.mjs apps/web/test/local-integration/assistant-channel-bidirectional.test.mjs apps/web/test/local-integration/assistant-channel-native-parent.test.mjs apps/web/test/local-integration/shared-provider.test.mjs
npm run typecheck:web
npm run typecheck:web:shell
npm run build:saas
```
