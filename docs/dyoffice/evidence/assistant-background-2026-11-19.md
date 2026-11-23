# 频道分享和后台任务验证记录

日期：2026-11-19。Node v24.18.0，独立测试 PostgreSQL 容器 `dyoffice-test-pg`（127.0.0.1:55433）；测试夹具为每次运行创建并清理隔离数据库。没有修改用户提到的 55432 业务库。

## 已执行的自动验证

| 范围 | 命令/文件 | 结果 |
| --- | --- | --- |
| 协议、浏览器客户端、后台模型请求 | `node --import tsx --test apps/web/test/unit/assistant-background-runner.test.mjs apps/web/test/unit/assistant-background-answer.test.mjs apps/web/test/unit/assistant-channel-contract.test.mjs apps/web/test/unit/assistant-channel-client.test.mjs` | 50 通过 |
| 后台任务与现有频道、父任务、共享模型回归 | 下列集成命令 | 28 通过，包含实际子进程恢复、排空及编辑器连接生命周期 |
| 真实首页/HTTP/数据库/关闭与重开浏览器 | `apps/web/test/local-browser/assistant-background-http.test.mjs` | 确定性回归通过；另以官方 DSH + 真实模型通过，见下文 |
| 本地与 S3 存储取消及回归 | `read-cancellation`、`object-store`、`verify-only`、`s3-reclamation`、`readiness` | 26 通过，真实 RustFS |
| Chromium 页面交互 | `node --import tsx --test apps/web/test/local-browser/background-workspace-ui.test.mjs` | 1 通过，1280 / 360 像素 |
| 首页频道/任务组件 | `cd apps/web && ../../node_modules/.bin/vitest run --config vitest.shell.config.mjs test/shell/background-workspace.test.ts` | 9 通过 |
| Web 和服务端类型 | `npm run typecheck:web` | 通过 |
| 首页类型 | `npm run typecheck:web:shell` | 通过 |
| SaaS 打包 | `npm run build:saas` | 通过；存在既有大块体积与依赖注释警告 |

集成命令在仓库根目录执行，`DYOFFICE_TEST_DATABASE_URL` 使用独立可丢弃数据库，不在文档中记录密码：

```bash
node --import tsx --test --test-concurrency=1 \
 apps/web/test/local-integration/assistant-channel-background.test.mjs \
 apps/web/test/local-integration/assistant-channel-http.test.mjs \
 apps/web/test/local-integration/assistant-channel-bidirectional.test.mjs \
 apps/web/test/local-integration/assistant-channel-native-parent.test.mjs \
 apps/web/test/local-integration/shared-provider.test.mjs
```

已验证：

- 空工作区创建多个无文档频道、同次创建幂等、配对、所有者权限、后续关联 DOCX、按文件筛选频道。
- 后台任务只有显式授权才入队，重复提交返回同一任务；浏览器不能领取或使用常规结果接口结算后台任务。
- 不建立编辑器连接，真实 PostgreSQL、对象存储和 worker thread 读取 DOCX 后持久结算。两实例竞争只调用一次模型。
- 提交后通过真实版本服务保存新版：新版文字为「99 万元」，后台仍读取被冻结旧版「42 万元」，返回旧版本 ID。
- 运行中取消、关闭读取、暂停、撤销成员、文件进回收站、注销原会话时，迟到模型答案不写入摘要或消息事件，封存凭证被清理。
- 已运行任务租约过期不自动重跑，旧进程写回被拒绝。过期清理领取后再次退出的场景仍可恢复清理。Office 忙时后台任务保持排队；原浏览器任务到期后自动解除阻塞，后台不依赖额外浏览器请求才能继续。
- 后台子任务完成后恢复等待的外部父任务；尚未开始的领取过期取消后也能恢复父任务。执行结果待核对时不擅自继续父任务。
- 应用启动自动调度链路：通过真实 Fastify 成员 HTTP 提交/查询，读取 DOCX、选择所有者默认共享模型、复用凭据派发及结算管道；传输使用确定性 SSE 替身，最终响应包含 42 万元和保存版本。并非真实上游模型调用。
- 调度数据库角色不能直接查询文件表或队列表。首页组件可创建邀请、显示并批准具名申请、选择 DOCX 开启读取，并在权限失效后移除旧任务详情；没有注册编辑器连接。

## 真实 DSH 与真实模型验收

已使用官方 npm `@deepseek-ai/dsh@0.2.2-rc.1` 的 headless profile 完成真实验收，耗时约 54 秒。临时安装独立于 DyOffice 和原 DSH profile，未开发或安装自定义 DSH 插件、连接器或 genoffice。DSH 使用自身原生 shell 工具及 Node HTTP 请求调用协议。

验收模型沿用本机原 DSH 默认配置：`qwen-token-plan-cn / deepseek-v4-flash-0731`，标准 OpenAI-compatible endpoint。DSH 和隔离测试库中的 DyOffice 共享模型配置均使用该模型；实际进行了模型网络请求，没有 mock SSE、DSH 工具或 DyOffice API。凭据只通过私有临时配置加载，不存入仓库或本文。

实测流程：

1. 真实 Chromium 登录空工作区，从首页创建无文档频道并复制邀请。
2. 官方 DSH 读取测试邀请，通过自身 shell 发出连接申请；网页展示「DSH 实测实例 · dsh」，在网页批准。
3. 导入含固定文字「预算总额：42 万元」的 DOCX，并在频道界面授权后台读取。
4. 关闭全部 DyOffice 浏览器上下文。启动第二次 DSH headless 任务，DSH 自行兑换成员凭证、提交 `execution: "saved-revision"` 并轮询同一任务。
5. DyOffice 后台读取保存版本，通过真实模型网关回答；DSH 展示实际任务 ID、版本和摘要。断言结果为 succeeded，摘要包含 42 和万元。
6. 新浏览器上下文重新登录，首页任务详情显示同一摘要及版本，可进入来源频道；随后从界面暂停频道和移除 DSH 成员。真实模型派发记录仅 1 条且已 settled。

| 证据 | 值 |
| --- | --- |
| DSH 配对会话 | `session-9cfe5c80-d3ad-46ee-84e9-7374b51b568a` |
| DSH 后台调用会话 | `session-7016ac04-5a51-47a3-a48e-c7d53151342e` |
| DyOffice 任务 | `83b479af-65f3-4870-900f-9993b4b65d2f` |
| 已保存版本 | `aa314f87-ecef-4bd6-960a-07039ba6bb13` |

重跑真实验收必须显式启用，默认仍运行确定性回归。准备私有 JSON 配置（权限 0600），字段包括 `bin`（官方 dsh/lib/bin.js）、`home`（独立 DSH_HOME）、`patch`（启用既有凭据存储的官方配置 overlay）、`workspaceRoot`（私有临时目录）和 `entry`（现有共享模型配置，id 为 shared-chat）。敏感字段不得提交到仓库。DSH home 需事先初始化并验证默认模型可用。

```bash
DYOFFICE_REAL_DSH=on \
DYOFFICE_REAL_DSH_CONFIG=/private/path/dsh-acceptance.json \
DYOFFICE_TEST_DATABASE_URL=<独立测试库连接> \
node --import tsx --test apps/web/test/local-browser/assistant-background-http.test.mjs
```

测试夹具会清理数据库、临时频道凭证和执行工作目录。实际执行后也清理了临时复制的模型凭据；原 DSH 配置与凭据未被改写。

## 四格式只读扩展复核（同日）

后台读取已扩展为 DOCX、XLSX、PPTX、PDF，格式来自服务端重新授权的文件元数据，沿冻结版本、验证对象读取、隔离 worker 和模型请求传递；不接受成员提供的格式作为依据。调度存储不增加格式副本。四格式均不提供编辑或工具权限。

读取复用 `packages/file-parse` 字节提取器，按实际格式动态加载，未建立临时文件路径。保留 10 MiB 输入、128 MiB worker 老生代、10 秒读取限制和取消终止。完整提取在受限 worker 内进行，统一保留前 24,000 字符并根据真实提取长度标记截断；未提高 PDF 的内存限制。XLSX 使用已保存缓存值，公式不重算、外链不访问；无缓存的公式可能以文字呈现。PDF 扫描件与图片不进行 OCR。上述边界已写入模型提示和授权界面。

| 扩展验证 | 结果 |
| --- | --- |
| 读取、模型回答、runner 单测 | 21 通过；包含四格式字节提取、缓存值、错误格式/损坏/超限、启动后取消、截断及禁止工具 |
| 真实 PostgreSQL 后台集成 | 24 通过；包含四格式保存版本执行以及取消、撤权、过期、恢复等既有回归 |
| 首页频道、任务和连接指引组件 | 12 通过；授权选择展示四格式并过滤不支持格式；指引中的委派 JSON 通过真实契约解码 |
| 真实 Chromium + HTTP + 隔离数据库 + 确定性上游 | 4 通过；四格式均在关闭全部浏览器上下文后完成，并在重开后查看同一结果和保存版本 |
| 服务端、首页 TypeScript | 均通过 |
| 本地壳构建、git diff --check | 均通过 |
| 官方 DSH + 真实模型四格式首次复核 | 2 通过、2 失败；XLSX/PDF 完整通过，DOCX/PPTX 的 DSH 端失误已定位，见下文；DOCX/PPTX 后续定向复验通过 |
| DOCX/PPTX 定向真实复验 | 2 通过，耗时约 151 秒；保留首次失败，不放宽成功断言或增加超时 |

首次四格式真实运行保留两项失败：DOCX 的 DSH 在兑换成功后，私密保存的上下文结构为 `{memberToken, parsed}`，下一步却读取顶层 `memberId`，请求了 `/members/undefined/actions`，被 UUID 契约正确拒绝为 HTTP 400；没有创建后台任务。之后 DSH 反复探索请求，最终被既有 180 秒阶段上限终止。已用独立测试库、临时 HTTP 服务和替代凭证，重放该两段生成脚本复现：兑换 200、委派 400、任务数 0；现场请求体契约校验通过，失败点确为成员路径。PPTX 的服务任务已返回 `succeeded`，摘要含 42 CNY，但 DSH 最终回复遗漏 taskId 或 savedRevision，现有严格断言判定不通过。

已同步改进用户实际复制的连接/委派指引和验收 helper 提示：原样保存完整兑换响应，每步重读顶层 memberId/memberToken，字段缺失或非 200 立即停止并报告实际失败步骤；最终明确输出 taskId、savedRevision、state 和 summary。未修改服务授权校验，也未放宽真实成功断言。

首次运行的 XLSX/PDF 完整通过，修正指引后只对两失败格式进行一次真实复验，DOCX/PPTX 均通过。因此四格式分别具备官方 DSH + 同一真实模型的成功证据，不宣称首次四格式运行全部成功。成功用例均关闭全部浏览器上下文后由 DSH 自行委派、轮询，服务返回 succeeded，摘要包含 42 及单位；DSH 实际输出 taskId 和 savedRevision；重开浏览器可查看相同结果，模型派发每例仅一条且 settled。没有模拟 DSH、模型或 API。

| 格式 | 成功阶段 | DyOffice 任务 | 保存版本 |
| --- | --- | --- | --- |
| DOCX | 定向复验 | `5b67f826-9db1-4d18-ab5a-d6ab11582bc6` | `76cad49c-a717-4985-9dc8-265daf2cb120` |
| XLSX | 首次四格式运行 | `1b17a9db-3b8f-43b8-97dc-3b74e1e0b603` | `802a0d39-a55a-4e23-88c5-bc265b20d6a1` |
| PPTX | 定向复验 | `e60992e2-5ab4-49cf-bd15-7b71b92654f9` | `d23dec63-afdc-4a79-b891-9bda7e88c0f0` |
| PDF | 首次四格式运行 | `c908d23b-77c3-472f-8ea0-3b3c4601702e` | `49f3c67a-1471-4af7-a60e-08a1e6ccd478` |

测试使用合成预算文字，未读取生产文档或改写原 DSH 配置。原始 DSH 会话、配置与日志只保留在私有临时目录，公开证据仅含状态、计数和无凭证的任务/版本标识。

## 恢复、审查与边界

真实 Chromium 151 另在 1280 / 360 像素验证组件交互与页面溢出。隔离测试环境已用两个真实 Node 子进程竞争队列，确认只执行一次；SIGKILL 执行进程后启动新进程，原任务不重跑，进入结果待核对并清理封存凭证；无执行进程期间提交的任务由新进程完成。测试主动回拨数据库租约时间来触发过期，不实际等待 30 秒。另测正常停止活跃进程、关闭频道读取后的队列排空。

代码审查发现并修复了编辑器连接误中断后台任务、旧频道操作响应覆盖新频道、任务刷新丢失已加载页三个问题，均有失败复现及修复后回归，并经独立静态复核。另验证账号切换期间旧请求不覆盖新状态，关停等待领取与心跳完成，取消信号传至本地及 S3 对象读取。

本次验收覆盖官方 DSH headless 和指定真实模型，不代表所有 DSH 版本、既有 Web/桌面会话自动控制、四格式后台写入或生产滚动升级已验收。这些不属于本次保存版只读范围。

使用方法、开关、限制和停用顺序见 [运维说明](../assistant-background.md)。此前 DOCX 阶段的验收项已完成；本次四格式真实验收结论以上述扩展复核记录为准。

2026-11-20 复验：更新浏览器用例及官方 DSH 驱动，使用现行的直接授权 Token 流程。本机 DSH headless 和真实模型四格式均通过。每例在全部浏览器上下文关闭后由 DSH 通过 `/member` 查询身份、提交任务并轮询，核对指定保存版本和预算结果；重新登录可查看同一结果。每例模型派发仅一条且结算完成。该结果覆盖 DSH 发起的保存版读取，未验证 Office 向 DSH 委派或交付写回。

2026-11-20 反向委派验收：新增 [PPTX 浏览器用例](../../../apps/web/test/local-browser/assistant-dsh-delegation.test.mjs)。使用 `DYOFFICE_REAL_DSH=on`、`DYOFFICE_REAL_DSH_CONFIG` 私有配置和 `DYOFFICE_TEST_SLIDES_DIST` 候选构建，在 Chromium 和隔离 PostgreSQL 中运行，1/1 通过。修复前，真实模型从成员列表取了 Harness 内部 ID，委派未发出；修复后，列表给模型的 `agentId` 可以直接用于委派，频道客户端回归测试 40/40 通过。真实模型创建父任务并进入 `waiting_peer`；官方 DSH 通过直接授权 Token 连接、领取指定子任务、提交唯一测试编号，浏览器未手动刷新，原父任务自动续跑并在摘要中返回相同编号。只生成一个子任务，PPTX 保存版本未变。本项仅验证文本回执，文件交付历史和写回仍需独立验收。

2026-11-20 文件交付复验：扩展同一 PPTX 用例，真实模型委派时附带一个冻结结果 ID。官方 DSH 使用原生 shell 执行合成数据测试脚本，凭子任务的领取凭据下载并校验冻结结果，计算总额 60 CNY，提交文本报告和摘要。Chromium 与隔离 PostgreSQL 验收 1/1 通过：父任务自动续跑，刷新后从「历史交付」找回报告并核对哈希，手动插入不改变保存版本，显式保存生成新版本。新版本的幻灯片 XML 同时包含正文和哈希，重开可读到正文，历史原件字节不变。此项覆盖 PPTX 文本报告，其他格式和交付类型仍需独立验收。
2026-11-20 Word / XLSX 复验：同一浏览器用例增加 `DYOFFICE_DSH_FIXTURE=on` 模式，使用固定模型和独立进程走外接执行器 HTTP 协议。DOCX、XLSX 各通过一例：原父任务自动续跑，从历史交付恢复报告并核对哈希，显式保存前版本不变，保存后正文或指定单元格可在重开后读到，历史原件字节不变。此模式未运行真实模型或官方 DSH；私有 DSH 配置可用时使用 `DYOFFICE_REAL_DSH=on` 重跑。

2026-11-20 Word / XLSX 真实复验：`deepseek-v4-flash-0731`、官方 DSH headless、Chromium 与隔离 PostgreSQL 分别通过同一用例的 DOCX 和 XLSX 分支。父任务自动续跑；刷新找回历史报告，插入不改变保存版本；显式保存后核对 DOCX 正文或 XLSX 的 J10 单元格、报告哈希、重开内容以及原版字节。
