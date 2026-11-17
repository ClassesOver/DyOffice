# 频道成员统一数据链路验收

日期：2026-11-17。工作树 `feat/assistant-harness-collaboration`。复用现有数据服务、冻结结果、task grant、CLI 数据客户端和产物存储，没有新增分析服务或 MCP。

## 实现边界

- Office 委派时可明确附加 `dataInputs.sourceIds/resultIds`，每种最多 32 个、严格格式、去重。新增 0031 迁移保存范围；列表只展示有界任务预览，完整 claim 返回授权范围。
- 成员不能附加或继承数据范围。邀请批准只授予频道身份，不自动授予数据访问。
- `POST /api/v1/assistant-channels/members/:id/tasks/:taskId/data-grant` 只接受 claimId、connectionEpoch，拒绝自行提供数据范围。服务端从持久任务读取范围，并私下复用原 owner session 授权；返回值不包含该 session 或数据库凭据。
- 必须是 Office 发起、当前成员接收的 running task；channel 未暂停，成员连接、task claim 与 epoch 一致，任务未取消且未过期，文件和 owner session 仍有效。
- 每次统一数据操作执行前后均复查以上绑定。查询执行中取消时可以完成原受控查询，但不会把结果返回已失效的 grant。失效 grant 永久撤销；新 claim 必须重新兑换。
- grant ID 与持久频道 task ID 分开，服务端授权回调绑定二者。原 task 的 grant 默认最多十分钟且不超过任务截止时间。并发限制仍共用原来的每用户 2 个、全局 16 个。新任务准入时清理已结束的远端 grant，无额外清理 daemon。
- CLI run/watch 在 claim 后兑换 grant，经 adapter stdin 的可选 `data` 字段传递；不放入命令参数、日志或频道状态文件。复用同一数据 HTTP API、快照完整性校验、产物 stage/commit 和 owner 下载 API。
- 协作任务卡片展示执行者头像和纯文本结果摘要；普通用户 Office 编辑、模型选择和文档写入仍走现有流程。

## 本次验证

真实 PostgreSQL 17、RLS、Fastify 与 TCP：

```sh
DYOFFICE_TEST_DATABASE_URL=postgresql://office_test@127.0.0.1:55480/dyoffice_test \
node --import tsx --test \
  apps/web/test/local-integration/assistant-channel-data.test.mjs \
  apps/web/test/local-integration/assistant-channel-store.test.mjs \
  apps/web/test/local-integration/assistant-channel-http.test.mjs \
  apps/web/test/local-integration/assistant-channel-cli.test.mjs \
  apps/web/test/local-integration/assistant-channel-bidirectional.test.mjs \
  apps/web/test/local-integration/personal-provider.test.mjs \
  apps/web/test/local-integration/harness-data-access.test.mjs
```

19 项通过、0 失败。新增数据测试覆盖：领取前拒绝兑换、错误 claim 拒绝、范围扩充拒绝、结果权限不反向授予数据源查询、冻结下载、取消后已有 grant 失效；真实 CLI adapter 通过 TCP 下载三行冻结结果，在独立 Node 进程计算合计 60 CNY，提交报告及输入快照证据，Office owner 可以下载且另一个用户收到 404。原个人模型额度测试同时通过。

单元测试覆盖查询过程中授权失效时不返回结果、失效凭据不复活、清理结束 claim 的额度占用、Office 模型工具只发送数据引用、畸形范围拒绝。CLI 测试覆盖 claim 后兑换且仅经 stdin 传递能力；组件测试验证摘要转义和执行者头像。

这里的计算 harness 是确定性的 Node adapter；源数据为明确创建的冻结 fixture，不是实时业务数据库。此验收不代表真实上游模型、第二种真实 harness 适配器或完整 Office 编辑器 E2E 已通过。外部文档写入与等待后自动模型续跑仍为后续工作。

最终检查：频道客户端/契约、数据授权/HTTP 29 项单元测试通过；CLI 28 项测试通过（含独立 helper 打包与运行）；协作控制/面板 7 项组件测试通过。Server、Web Docs 与 CLI 类型检查通过。Docs、Sheets 的 Vite 前端构建通过，仅保留既有大 chunk/第三方注释构建提示。两种主题的 340px 面板组件浏览器检查已复跑，执行者头像与结果摘要可见，无控制台错误或横向溢出，原生草稿未变化。这些检查不替代完整编辑器 E2E。
