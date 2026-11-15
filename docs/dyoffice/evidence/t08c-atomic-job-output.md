# T08c：任务权限与同事务输出提交

本 checkpoint 完成受限任务身份和 T06 保存核心的连接。它尚未把 T08b 的真实 Rust 适配器接入常驻执行循环；不据此宣称完整原生后台任务或 T08 已完成。

## 权限与事务

`createPrincipalTransactions` 支持内部 `{kind:'job',jobId,epoch,token}` 凭据。凭据在任何异步操作前复制并冻结；身份、会话、authVersion、文件、基线均由锁定的 PostgreSQL 记录推导。调用方不能指定 owner。初始验证和提交前复核都检查账号/会话/角色、任务 deadline、领取 hash/epoch 和领取租约。授权锁顺序沿用 user → session → job，再进入文件/配额/编辑租约路径。

此凭据只允许捕获文件的必要操作。下载限于捕获 artifact；不能列举文件、读取其他历史版本、导入、重命名、回收/恢复、查询用户总用量、管理偏好或创建其他任务。编辑 ID 固定为任务 ID；不能隐式接管浏览器租约。上传同时绑定 job ID 和 attempt epoch，另一任务、旧 attempt、普通会话都不能接续它。

沿用唯一的 `RevisionService.commitRevision` 保存路径：检查租约、基线 CAS、不可变对象 hash/大小、配额，追加版本、幂等回执和 revision outbox，然后调用 `complete_native_job`，在同一数据库事务标记任务成功并释放该任务的编辑租约。完成失败会回滚全部元数据。没有第二个未检查的任务版本写入器。

新增不可变迁移：

| 迁移 | 内容 |
| --- | --- |
| 0008 | 上传 job/epoch；append-only 回执的 job/epoch/claim hash/领取期限/事务 xid8；每任务唯一完成回执；两个 business-only 固定函数 |
| 0009 | 编辑租约的 job/epoch 用途标记，保留旧租约为浏览器用途 |

成功后 claim hash/租约被清空，原凭据不能进入新事务。提交前最后复核仅允许当前 `pg_current_xact_id()` 刚封存的匹配回执；上一事务的成功凭据即使调用 final-check 模式也被拒绝。任务提交的来源字段不能由调用方伪装为另一个 source command。

新函数 `lock_job_principal` / `complete_native_job` 仅 business 可执行，auth/worker 不可执行，PUBLIC 不可执行；固定 `search_path=pg_catalog`，由独立非超级用户迁移 owner 拥有，无 grant option。worker 保持原五个调度函数的 EXECUTE 权限，继续没有表访问权限。运行时准入验证覆盖新增函数。

编辑租约显式区分浏览器与任务用途，不能根据公开的 editor UUID 猜测来源。复制 job UUID 也不能共享两类租约。任务租约期限不超过领取期限；同任务重领后推进编辑 epoch，隔离旧上传；取消只释放该任务用途的租约，显式浏览器接管仍需匹配 epoch。升级不会把已有浏览器租约误判成任务租约。

## 实测

所有数据库/存储操作使用真实隔离 PostgreSQL 和本地不可变对象存储，角色为独立非超级用户。

- 最初输出测试观察到 session-only 边界导致的 RED，再实现任务身份和原路径提交。随后检查 mutable credential，在 callback 内换成另一个有效任务造成最后复核换身份，观察 RED 后修为异步前快照。
- 完成后租约仍 active 的独立测试 RED → GREEN，修为同事务释放，失败回滚仍保留原租约。
- 相同公开 editorId 令浏览器租约被任务复用的测试 RED → GREEN，引入真实用途/epoch 标记。普通 Cookie 不能续租或释放任务用途租约；任务不能隐式共享浏览器租约。
- **31/31** 任务测试通过，包含既有真实 Redis/BullMQ 恢复、角色边界和新事务检查。新增覆盖：跨用户/文件/任务/attempt、取消/撤销/期限、旧基线与浏览器接管、对象 I/O 越过 deadline、同事务完成故障回滚、已完成凭据与 final 模式重放。
- 实际独立 Node 控制进程在真实 PostgreSQL `COMMIT` 返回后立即 `process.exit(86)`，不给调用方确认，也不执行 finally。父进程核实任务已成功、版本/回执/outbox 仅增加一次；重新领取返回 null，旧能力重试不能新增版本。此用例证明提交后控制进程死亡的 SQL 真相，不把它写成已完成整个 Redis→原生工具执行链。
- 从原 v6 文件/会话/配额/版本/租约/回执/outbox 和 v7 queued/running 任务、leased delivery intent 升级到 8/9，前七个 checksum、原始对象字节、领取 epoch 和投递租约保留，原 worker 能续领。

最终版本在实际 Node22.23.5 验证：任务 **31/31**（79.85s），完整 API **114/114**（169.99s），真实 Chromium DOCX TLS **5/5**（52.00s），unit **37/37**，legacy **32/32**，Web/server typecheck 通过。工具/CI/IPC 检查 **15/15**；浏览器依赖图 553 模块零违规；84 项兼容性输入无漂移。没有改既有 npm/Cargo 锁文件或原生引擎源码。本阶段没有重新运行与 server-only 改动无关的原 Docs 全套；T07 已披露的冷导入 hook 超时和外部 Word QA 仍开放。

## 使用与剩余范围

当前迁移版本 9。更新实验环境前停止旧进程，以独立非超级用户 owner 运行既有 `npm run provision:runtime`，包含预建 auth/business 和可选 worker 角色，然后重启。新的 business 函数授权也必须安装；缺少权限会被准入拒绝。连接秘密不进入命令参数/日志，owner 凭据不交给运行服务。已有旧租约保持浏览器用途；没有从猜测 UUID 推导权限的迁移。

后续仍需真实原生执行 controller、领取与编辑租约 heartbeat、取消/撤销杀容器、输出链全程测试、公开任务 API 和守护循环。T06 revision_outbox 的实际消费仍开放。production、四格式完整写回、Word/PowerPoint 等外部 QA、安全/部署/恢复及客户验收仍由全计划后续步骤完成。
