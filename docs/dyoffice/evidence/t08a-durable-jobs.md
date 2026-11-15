# T08a PostgreSQL 任务权威与 BullMQ 投递

日期：2026-11-15。此为 T08 的内部基础 checkpoint，T08 尚未验收完成。

## 实现与授权边界

migration 7 增加 `native_jobs` 与 `job_outbox`。会话 principal 事务中同原子提交任务和投递意图；用户级 advisory transaction lock 串行化幂等检查与活动任务配额。相同键/请求返回同一任务，输入只能包含 `artifactId`，以本人当前文件版本 UUID 解析文件与基线；不接受 owner、objectKey、路径、URL 或任意命令。调用方不能延长任务的会话窗口：idle 策略从原认证事务 factory 的只读属性继承。

任务捕获真实 session/authVersion。领取、重试、租约、deadline、取消及执行次数都在 PostgreSQL；claim token 只在可信 Worker controller 内存中，数据库只存散列。Worker 领取时按 user → session → job 加锁，随后取得文件共享锁，再重验会话和任务时限。过期 claim 不能续期或覆盖新 epoch，取消和撤销使其失效。数据库锁等待 5 秒、语句 10 秒，异常回滚后连接可复用。

可选第四个 PostgreSQL worker login 仅获五个窄函数 EXECUTE；不能直接读取身份、文件、任务表，也不能执行内部 helper。API auth/business 角色不能领取或全局枚举任务。两张新表保持 FORCE RLS；只有独立非超级用户、无 BYPASSRLS 的迁移/function owner，通过显式内部调度 policy 扫描任务元数据。函数固定 `search_path=pg_catalog`，所有应用关系带 schema，PUBLIC 无执行权。启动 admission 还检查函数 owner、权限转授、角色成员关系和额外表授权。此设计不承诺抵御持有迁移 owner 或任意可信应用 SQL 权限的攻击者。

`DYOFFICE_WORKER_ROLE` 仅供既有 owner provisioning CLI 安装可选角色权限；不创建角色/密码。现有 Web 启动没有新增 Redis 必需项，任务 HTTP 路由与后台 executor 没有伪装启用。

## 投递和恢复

固定 BullMQ 5.81.5、真实 Redis 7.4；两份锁文件均固定，既有已锁依赖版本无变动。消息仅含 `jobId` 与 `deliveryEpoch`。PostgreSQL outbox 先租借提示，实际 Redis add 后确认；确认丢失可重新投递。已确认但仍 queued/领取过期的任务也定期重建提示，因此队列被清空后可从 PostgreSQL 修复。

BullMQ 消息完成只表示提示已处理，不会标记业务成功。Redis 的 jobId 去重不能代替数据库幂等和 fencing，特别是历史消息被移除后。[BullMQ job ID 说明](https://docs.bullmq.io/guide/jobs/job-ids)、[连接配置](https://docs.bullmq.io/guide/connections)。生产端有限请求重试、后台重连，启动有 3 秒期限；消费连接支持重连。没有把全文、会话 token、claim token、对象路径或原生命令放到 Redis。

本地固定摘要 Redis fixture 仅 loopback，非 root、只读根目录、cap-drop、独立 tmpfs，限制 128 MiB/1 CPU。恢复测试只 obliterate 随机自有队列 namespace，不执行全库 FLUSH；另通过 CLIENT KILL 真实断开生产端连接，再验证重连和再次投递。所有队列 namespace 在测试结束后清理。CI 配置相同摘要服务与任务测试；尚无远端 CI 执行结论。

## 实测

使用实际 Node 22.23.5、PostgreSQL 17 的独立非超级用户角色、真实 Redis/BullMQ及临时对象存储。关键失败先出现再修复：

- claim 等待真实文件锁期间，会话或任务 deadline 过期后仍得到 claim；修复为文件锁后重验。
- ACK 的 clock predicate 在等待 outbox 锁前求值，导致过期确认成功；改为锁后检查。
- 真实 Redis 连接断开后生产端永久关闭；加入后台重连与有限请求重试。
- Worker 数据库锁等待无界；增加事务内 lock/statement timeout 和回滚验证。
- 短 idle principal 创建的任务错误继承独立 8 小时默认窗口；改为继承原认证策略。
- 标准无 path Redis URI 被误拒绝；实际连接测试后支持默认 DB 0。

| 检查 | 观察结果 |
| --- | --- |
| 任务/真实队列/升级/角色/CLI/竞态恢复 | 20/20 通过 |
| 原有 PostgreSQL/HTTP 全量 | 114/114 通过 |
| 原生 DOCX Chromium/TLS 与服务入口 | 5/5 通过 |
| 原有会话/文件 Chromium/TLS | 5/5 通过 |
| Web 单元 | 37/37 通过 |
| 原型接口与构建/HTTP | 32/32、2/2 通过 |
| Web 类型检查，含独立 Web 安装 | 通过 |
| Web 独立 npm ci --ignore-scripts | 通过，新锁文件可复现 |
| 基线/CI/IPC 工具回归 | 14/14 通过 |
| 浏览器边界回归 / 实际扫描 | 13/13；553 模块 0 违规 |
| 兼容基线 / IPC 分类 | 84 输入 0 漂移；538 成员表保持当前 |

v6→v7 升级使用真实非超级用户 owner 和真实不可变对象，保留旧账号/会话、两个版本、租约 epoch、幂等回执、revision_outbox 和配额；前六个迁移校验和逐一保持。没有重写历史版本或原件。v7 已在隔离测试源应用，之后的 Worker 能力必须用 v8+ 增量迁移。

## 剩余 T08 工作

尚无公开任务路由、常驻 dispatcher、原生 executor、OS CPU/内存/禁网沙箱、任务输出与 T06 的同事务提交、真实子进程 crash/超时隔离或成功任务 exactly-once 证明。内部测试的 `docx.roundtrip` 是保留类型，控制回调仅验证领取/失败，不冒充原生处理成功。T06 的 revision_outbox 尚未由此消费。

下一阶段必须让真实原生输出的版本回执和 job 成功状态在同一数据库事务完成，验证取消/丢锁/旧基线/重复执行不会写入新版本，并验证原生进程被杀不影响 API。生产、其他格式、AI 和外部 Word QA 门槛仍开放。
