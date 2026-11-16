# T08e：任务 API、常驻 Worker 与受限启动校验

本阶段将已验证的任务服务公开为实验 Cookie API，并补齐业务/Worker 角色的启动版本校验。可启动的常驻 Worker 已接入；创建中断后的启动回收和 revision_outbox 消费继续实现，T08 未完成。

## API

在现有 local 账号、受限 auth/business 连接和实验 File API 配置上设置 `DYOFFICE_NATIVE_JOBS=experimental`。其他非空值或 development 认证模式会拒绝启动；缺少 File API 也会拒绝。默认关闭，保持既有路由行为。API 不依赖 Redis 在线，接受的是 PostgreSQL 持久任务意图。

| 请求 | 行为 |
| --- | --- |
| `POST /api/v1/jobs` | JSON 只允许 type、input、idempotencyKey；type 为 `xlsx.roundtrip`，input 只含本人文件版本 UUID artifactId；返回 202 和 Location |
| `GET /api/v1/jobs` | 最近最多 100 个本人任务 |
| `GET /api/v1/jobs/:id` | 本人任务当前 SQL 状态 |
| `POST /api/v1/jobs/:id/cancel` | 无请求体，幂等取消并释放该任务用途租约 |

所有路由先校验 Cookie 会话与 Origin/Fetch-Site，写请求还需正确 CSRF；业务事务再次从 SQL 推导身份并复核权限。返回 `private, no-store`。参数/请求体均使用应用持有的静态 schema，额外 owner/path/epoch 等字段被拒绝，不能选择未实现的 DOCX 或 shell executor。

响应有静态字段白名单：只包含 job ID/type、artifact/file、状态、尝试次数、固定错误代码、结果版本和时间。不返回领取凭据、hash/epoch、会话、owner、认证版本、对象键或 SQL request hash。Admin 不获得别人任务的所有权。

## 启动就绪校验

原来的运行角色检查能确认权限、函数 owner/search_path 和 FORCE RLS，但 Worker 没有读取 `identity_migrations` 的权限，不能发现 checksum 已变的部署。新测试复现 RED：修改 checksum 后，旧检查仍然接受 Worker。

新增不可变 `0010_native_readiness.sql`：固定 schema、`STABLE SECURITY DEFINER SET search_path=pg_catalog` 的 `native_schema_matches(jsonb)` 只返回布尔值，将本地预期版本/checksum 清单和数据库记录精确比较。缺失、多余、不同 hash、重复版本或畸形清单不匹配。PUBLIC/auth 不可执行；仅 business/worker 可执行，仍不给它们迁移表 SELECT，不增加账号或会话表权限。

`assertRuntimePool` 先验证此函数与原有函数的 owner/安全配置/授权，再要求清单匹配。迁移 loader 抽到纯 Node 内置模块的 `migration-manifest.ts`，迁移、普通 identity 校验和受限角色校验使用同一份版本顺序及 SHA-256 算法。没有第二份手写版本号替代 checksum 校验。Worker 仍不需要 auth 或 owner 数据库凭据。

当前版本 **10**。更新实验服务前停止旧进程，以独立非超级用户 owner 运行既有 `npm run provision:runtime` 安装迁移和新增函数授权，然后重启。迁移 1–9 没有改写。Worker 的应用级授权现在是原 5 个任务函数加 1 个只读 schema 校验函数，仍无应用表直接读写权限。

## 常驻服务

独立服务入口 `npm run start:web:worker` 使用 `worker/src/main.ts`，要求：

- `DYOFFICE_NATIVE_WORKER=experimental`，非 production 环境。
- `DYOFFICE_WORKER_DATABASE_URL`、`DYOFFICE_BUSINESS_DATABASE_URL` 与 API 相同的 `DYOFFICE_DEPLOYMENT_ID`。
- `DYOFFICE_REDIS_URL`（loopback redis 或 TLS rediss）。
- `DYOFFICE_NATIVE_IMAGE` 为构建 manifest 的不可变 nativeImage SHA-256 ID。
- 与 API 一致的实验 File API/S3 配置。当前 root host controller 仅接受 `DYOFFICE_OBJECT_STORE=s3`，不能与非 root API 共享 `local-dev` 的 `0600` 对象；独立 API 仍可使用单服务账户本地存储。当前运行要求以 [HOST-RUNTIME.md](../../../apps/web/worker/HOST-RUNTIME.md) 为准。

Worker 不接受 owner/auth 数据库 URL 或旧开发 user/admin token。启动检查受限角色、完整迁移 checksum、同一数据库锁管理器、对象存储以及真实隔离原生程序的启动/退出，再连真实 Redis 消费。启动探针不解析文档、不创建任务或伪造输出。

连接池设置连接期限 5s、服务端 SQL 期限 10s、客户端查询期限 12s、闲置事务期限 30s。服务每秒轮询持久 outbox，每轮最多 16 个提示；消费并发为 1，实际任务 heartbeat 为 1 秒。依赖暂时错误只产生限频固定提示并重试，不把内存队列当数据库真相。SIGTERM/SIGINT 停止派发、abort 活跃执行，暂停消费并等待处理器结束，最后关闭队列、存储和连接池；已进入工作的正常关闭使用 graceful consumer close。关闭错误不会被当成正常退出。创建未启动容器及旧控制目录的启动回收仍待后续实现。

## 验证

- HTTP 测试先观察未接线路由的 RED，再 **3/3 GREEN**（随后增加真实服务入口用例）：202/Location、幂等入队、读取/列表/取消、A/B/Admin 隔离、CSRF/跨站、未知执行器与伪造身份拒绝、撤销和默认关闭。使用真实 PostgreSQL，不用 Redis 假成功响应。
- 版本检查测试先 **2/2 RED**，再 **2/2 GREEN**：真实受限角色不能直接读迁移表；正确清单匹配，checksum 改动、遗漏、未知版本、重复或畸形输入被拒绝。
- 实际 Node22.23.5 完整 API **118/118**（184.91s），包括真实服务入口用显式配置通过 HTTP 接受排队、无 Redis、正常 SIGTERM，任务/Redis **33/33**（85.62s）。
- 既有 7 项原生端到端 fixture 现在通过新 Cookie API 入队，再进入实际 Redis/SQL 领取、原生 Rust、输出校验和同事务提交；保留取消/撤销/失锁/关闭恢复与 ZIP 部件比对。新增独立常驻进程真实消费并提交、正常退出，以及 production/owner/auth 凭据/错误 schema 拒绝用例；最终原生/daemon **9/9**（40.23s）。
- 真实 Chromium DOCX TLS **5/5**（52.64s），Web/server 和 Worker typecheck 通过。

unit **37/37**、legacy **32/32**、工具/CI/IPC **15/15**，浏览器依赖图 553 模块零违规，84 项兼容性输入无漂移。仅新增启动脚本改变 package 清单 hash，无 npm/Cargo 锁文件、原始 Rust 引擎或浏览器编辑器源码变化，不需要为了此后端修改重跑原 Docs 30 分钟全套。T07 已披露的原 Docs 冷导入 hook 超时和外部 Word QA 继续开放。

## 下一步

继续验证中断创建的自有过期资源启动回收、异常重启/依赖故障路径，再实现 revision_outbox 的实际消费。当前 API 会保存排队意图；只有已验证的实际执行器提交结果后，SQL 任务才成功。没有根据消息投递或 HTTP 接受就返回伪成功。

production、T09–T26 的四格式完整编辑、AI、安全、部署、备份恢复与客户验收仍开放。
