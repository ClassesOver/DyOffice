# 双向频道集成验收（确定性模型）

日期：2026-11-17。Node v24.18.0，npm 12.0.1，真实 PostgreSQL 17。

命令：

```bash
DYOFFICE_TEST_DATABASE_URL=postgresql://office_test@127.0.0.1:55480/dyoffice_test \
node --import tsx --test apps/web/test/local-integration/assistant-channel-bidirectional.test.mjs
```

结果：1 个测试通过，0 失败，测试总耗时约 6.2 秒。

该测试运行真实 principal session/RLS、频道 service、Fastify routes、CSRF、loopback HTTP、browser-host `createAssistantChannelClient`、CLI `ChannelClient` 和 `AgentLoop.runScoped`。模型 transport 使用确定性脚本；外部 harness 的动作由测试经 CLI 客户端发出，并非真实外部模型或 CLI harness 运行。

已验证的链路：

1. 浏览器频道客户端启动并注册 Office 执行 control；外部通过邀请、申请、批准和一次领取完成成员授权。
2. Office 委派外部主任务；外部领取后反向委派关联的 Office 子任务，同一 requestId 重放返回同一回执。
3. 浏览器通过频道通知 observe 和 HTTP snapshot 自动领取 Office 子任务，真实 AgentLoop 执行 `read_blocks`，持久结果包含 fixture 文本中的 42 USD。
4. 模型同时发出未授权 `write_document` 调用。AgentLoop 返回工具错误，文档写执行器调用次数为零，模型仅获提供 `read_blocks`。
5. 外部读取子任务结果并提交主任务成功；另一成员无法读取子任务或冒用已知 claim 提交结果。
6. Office 原有历史不变；原生事件、私有上下文构造器均未调用；私有历史、草稿、附件标识和原生 system prompt 不进入协作模型请求。测试持有的草稿对象不变，且未出现在 HTTP 请求中。此项为客户端/AgentLoop 状态隔离验收，未渲染真实编辑器输入框。
7. 反复通知和刷新不重复执行已经完成的 Office 子任务。
8. 重建 service 后，已 running 的外部任务仍持久为 running 且不会自动重跑；外部换连接后转为 unknown_outcome，旧 epoch 结果被 HTTP 409 拒绝。

本证据不代表真实上游模型、真实外部 harness 适配器、完整浏览器 UI、保存或模型端到端互操作已验收。真实 harness 与上游模型验收仍需单独执行。

## 持久状态、心跳与控制通知补验

同日新增 `assistant-channel-store.test.mjs` 中心跳验收。成员表持久保存 `last_seen_at`；成员请求认证成功后更新心跳，连接存在且 45 秒内有心跳才展示在线。频道准入、快照和既有 T17 通知查询顺便限量核对最多四个成员；失联执行者的 running/cancel_requested 任务转 unknown_outcome，清除连接并递增 epoch，保留原 claim 以供有凭据的原执行者核对，不自动重跑。没有新增后台线程或第二个轮询传输。

测试通过数据库时间回拨模拟 46 秒无心跳，不进行实际长等待；验证离线、unknown_outcome、旧 claim 不可重新领取、重连后的 epoch 递增，以及原 claim 的显式 reconcile。另验证成员状态请求续心跳、暂停与恢复均生成持久控制事件并推进频道 sequence，使既有 T17 通知能唤起其他标签页刷新。

频道与成员任务列表是有界预览：活动任务优先，随后按创建时间倒序，最多 64 条；instruction/summary 的 JSON 编码分别限制为 256/512 字节，避免多字节 Unicode 或控制字符转义超过 CLI 的 256 KiB 响应限额。执行 claim 返回完整指令；成员单任务 HTTP 详情返回完整内容，并复查该成员是发送者或接收者。列表预览不可当作执行输入。补验使用 70 条已终结长任务和一个活动任务，验证列表上限、排序、响应体大小、完整详情、完整 claim，以及另一成员不能读取详情。
