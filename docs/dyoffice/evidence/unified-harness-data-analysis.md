# 内外部 harness 统一数据流程验收

日期：2026-11-17。工作树：`/home/junge/.codex/worktrees/c0bf/DyOffice`，分支：`feat/assistant-harness-collaboration`。以下验收覆盖工作树实现，不表示已发布。

## 验收范围

`apps/web/test/local-integration/harness-data-flow.test.mjs` 对内置与外部两个 origin 使用相同的真实 PostgreSQL 17/RLS、源服务、冻结结果服务、任务授权服务、Fastify 数据路由、产物服务和本地磁盘 ObjectStore。两个任务分别运行，数据处理发生在 harness 的独立进程内。

- 外部：独立 Node 进程使用正式 CLI 数据客户端，经 HTTP 完成取数、下载、求和、SVG 图表生成和三项产物上传/提交。
- 内置：真实安装的 Codex CLI 和真实权限沙箱，经 Office 模型适配桥领取确定性工具调用；脚本使用正式静态数据 helper 和任务专属 mailbox，转入相同 HTTP 路由。Python 离线运行包执行 pandas、DuckDB 求和和 matplotlib PNG 输出，上传报告、PNG 及实际执行的 Python 代码。产物记录实际 runtime manifest SHA-256。
- 模型输出是确定性测试夹具，不是上游模型服务验收；源端是受控 HTTP 测试夹具，不是真实业务数据库查询。PostgreSQL/RLS、Codex CLI、沙箱、Python 依赖、文件上传和磁盘存储均实际运行。

Linux 沙箱禁止任意网络连接；内置传输通过专属目录的请求/响应 mailbox 进入同一个 Fastify API，保留相同任务 bearer、scope、数据操作和完整性校验。外部继续使用 HTTP。该差异仅是传输方式，不扩大内置权限。

## 实际断言

1. 发放 task grant 不执行查询、不泄露源凭据；正式源服务仍控制实际查询。
2. query 响应只提供冻结引用和元数据，不向 Office 模型返回数据行；harness 下载 canonical JSON 后计算。
3. 同一 resultId 两次下载字节完全一致。取数、重复下载、产物提交、最终读取全过程仅访问一次 HTTP 源，不自动重新执行查询。
4. 输入携带截断检查和原始 provenance；本次 3 行金额的总和为 60 CNY，报告由实际计算生成。
5. 外部上传报告、SVG 和执行代码；内置上传报告、PNG 和执行代码。内置 PNG 核验文件签名，外部 SVG 核验实际计算值。
6. 其他用户任务、同一用户其他任务持正确任务凭据也不能读取猜中的 resultId；将一个任务凭据套用到其他 taskId 同样拒绝。
7. 产物上传/提交复用同一任务 grant；Office 只拿摘要、持久产物引用和来源信息。内置数据任务的自动文本收集输出为空，下载快照和上传请求不被回灌模型。
8. grant 撤销后再下载返回 403。删除 harness 工作目录后，已提交报告与图表仍能通过原 owner 身份读取；其他 owner 无法读取产物或提交收据。

## 运行记录

实际执行（测试 PostgreSQL 连接使用一次性测试库，无需业务凭据）：

```bash
DYOFFICE_TEST_DATABASE_URL='postgresql://office_test@127.0.0.1:55480/dyoffice_test' \
DYOFFICE_TEST_CODEX_CLI=1 \
DYOFFICE_TEST_ANALYSIS_PYTHON="$PWD/.dyoffice-analysis-build/runtime/bin/python" \
node --import tsx --test apps/web/test/local-integration/harness-data-flow.test.mjs
```

结果：2 项通过、0 失败、0 跳过。外部约 3.28 秒，内置约 17.91 秒，总约 23.24 秒。未设置 Codex/Python 验收环境变量时，内置用例明确跳过，不能引用这种运行宣称内置闭环通过。

## 边界

本次是数据链路集成验收，未启动 Docs/Sheets UI、未向打开的文档插入或保存内容，也未验收外部频道邀请、头像和主动委派 Office。数据任务使用当前进程内短期授权，不能据此宣称已完成进程重启恢复或可持久重领 claim。源端行数、时长与冻结结果限制沿用既有实现；测试不扩大数据源权限。模型推理的共享预算及原 Office 编辑/保存回归由其他专项验收记录，不由本文件代替。

补充回归：主线程复跑真实授权及双origin共3/3、产物持久化与来源覆盖5/5、共享额度/个人模型4/4；agent-core 275/275。内置任务凭据由0600任务文件提供给helper，不进入Codex参数或模型提示；普通外部客户端仍支持环境凭据。server/Docs/Sheets类型检查通过。完整CLI类型检查存在既有跨provider/renderer错误，新数据客户端/helper的定向类型检查通过；不宣称全仓类型检查全绿。
