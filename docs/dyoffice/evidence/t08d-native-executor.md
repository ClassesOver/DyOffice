# T08d：真实原生任务执行与领取续租

本阶段把既有 Rust XLSX 适配器接入 T08c 受限保存事务，增加内部执行处理器；公开任务 API、可启动的常驻 Worker 服务和 revision_outbox 消费仍继续实现，T08 尚未完成。

## 执行路径

`apps/web/worker/src/jobs/xlsx.ts` 只处理实际存在的 `xlsx.roundtrip`。任务领取来自 SQL；执行器复制领取数据，固定 `{kind:'job',jobId,epoch,token}` 能力。通过受限文件服务读取捕获的 artifact，获取任务用途的编辑租约，再在独立原生容器运行既有 Rust `open → save_archive → reopen → close`。原生调用只接收输入字节和 AbortSignal，不接收 SQL/会话/领取凭据、对象存储秘密或宿主路径。

原生处理期间没有长驻身份数据库事务。非重叠 heartbeat 续领 SQL job 和编辑租约；失锁、取消、撤销或数据库拒绝会 abort 原生执行。每次写入仍在事务入口/提交前重新验证权限，不依赖 heartbeat 的乐观判断。heartbeat 默认领取期限的三分之一，允许调用方配置更短核验周期；本阶段端到端测试使用 250ms。

输出沿用 T05 大小/结构校验、不可变发布及 T06 的配额、编辑租约、CAS、回执和 outbox，最后在同一事务标记任务成功。已经提交的成功结果不会因最后一个 heartbeat 看见终态而被改判失败。取消和失锁不能修改另一次领取；可控外部 abort 释放自己的编辑租约并把仍有权限的任务放回 queued，供重启后继续。对队列返回的异常只有固定代码，不把内部数据库/原生诊断作为消息正文。

本阶段是未编辑 archive roundtrip，继续保留原包部件。未声称已有浏览器 XLSX 编辑或计算结果持久化，它们仍属 T09。

## 控制进程死亡后的原生生命周期

新测试让真实测试探针确认已进入睡眠，再 SIGKILL 独立 Node 控制进程。观察到 RED：原来的宿主计时器随进程消失，容器超过期限仍存活。

修复为 Rust supervisor 使用独立单调时钟，接收经过主控校验的 `DYOFFICE_WALL_MS`（500–180000ms），到期杀原生子进程并退出。容器启用并验证 `AutoRemove`，结束后由 Docker 删除，不依赖 Node finally；主控存活时仍保留立即终止和显式清理路径。监督进程的固定状态报告包含 timeout；原有 cgroup-v2 OOM 计数识别继续保留。

这覆盖运行中控制进程死亡的开发环境回收。创建但尚未启动的容器之启动回收、控制端工作目录恢复与守护服务生命周期，随常驻 Worker 继续实现。production 仍拒绝本 Docker backend，不能据此宣称未知原生漏洞下的强隔离或生产验收完成。

## 验证

先观察 6 个执行器测试全部因模块缺失 RED，再实现处理器；首次端到端执行 6/6 GREEN。所有正向 XLSX 输出调用真实 Rust 镜像，没有用另一个 XLSX 库写出结果；JSZip 只做测试 fixture 和独立 ZIP CRC/部件字节比对。

最终测试入口：

```sh
npm run build:web:native -- --with-probe
npm run typecheck:web:worker
npm run test:web:sandbox
npm run test:web:native-jobs
```

后两项要求 Linux Docker/cgroup v2；native-jobs 还要求专用 `DYOFFICE_TEST_DATABASE_URL` 与 `DYOFFICE_TEST_REDIS_URL`。默认读取忽略目录 `.dyoffice-native-build/manifest.json`，也可指定 `DYOFFICE_TEST_NATIVE_MANIFEST`。不要指向业务数据库或 Redis。

- 真实隔离/原生 **9/9**：原有资源、禁网、输出和清理测试，加 SIGKILL 控制进程后独立超时/自动删除。
- AutoRemove 后真实 64MiB OOM 连续 **10/10**，严格 RESOURCE_LIMIT/OOM 断言不变，没有依赖 Docker 偶尔漏报的布尔值。
- 原生执行端到端 **7/7**：SQL 授权输入 → 实际 Rust 输出 → 校验/版本/成功；原生容器暂停超过初始领取期限后仍由 heartbeat 保持领取与编辑租约；取消、会话撤销、失锁均终止已经活跃的容器；新 epoch 独占提交；可控关闭后重领成功；真实 BullMQ 首次与重复提示仅执行一次、持久化一个版本。
- 独立比对每个 ZIP 部件名称和字节，含额外 custom XML，确认真正保存再打开的输出保留原始部件。

CI 的 `native-worker` job 增加固定摘要 PostgreSQL/Redis 和上述端到端测试。CI 覆盖检查先 RED 缺少命令后 GREEN。托管 CI 状态未在本阶段宣称。

最终运行测试使用实际 Node22.23.5：隔离 9/9（17.66s）、原生执行链 7/7（28.07s）、现有 SQL/Redis 任务 31/31（79.90s）均通过；Web/worker 类型检查通过。工具/CI/IPC 15/15，浏览器依赖图 553 模块零违规，84 项兼容性输入无漂移。新增 npm 入口只更新清单脚本 hash，既有 npm/Cargo 锁文件和 Rust 引擎未改变；新镜像更新隔离 supervisor/测试探针，仍以不可变摘要记录原始 sidecar。

T07 外部 Word QA及已披露的原 Docs 冷导入 hook 超时，T09–T26 四格式/AI/安全/部署/恢复/客户验收仍开放。没有为了 worker-only 修改重跑原 Docs 全套。
