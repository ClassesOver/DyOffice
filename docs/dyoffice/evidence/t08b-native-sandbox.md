# T08b：真实 XLSX 原生引擎与开发环境 OS 隔离

本阶段是 T08 的执行基础 checkpoint。没有公开任务路由、守护循环或任务输出提交，不将 BullMQ 消息完成当成任务成功。完整计划继续执行。

## 实现

- 原样编译 `apps/sheets/native/xlsx-engine`，使用既有 `Cargo.toml` / `Cargo.lock` 和 `cargo build --locked --release -j 1`。没有修改原生引擎或替换 XLSX 库。
- `worker/src/native/xlsx.ts` 调用真实 `open`、`save_archive`、输出重开和 `close`。本阶段只实现未编辑归档的往返，尚不声明编辑或公式计算结果已保存。
- `worker/src/sandbox/process.ts` 为每次操作创建独立容器与 tmpfs，固定 UID/GID 10001、只读根、无 capability、no-new-privileges、builtin seccomp、禁网、无宿主挂载。限制 CPU 时间/份额、内存且禁 swap、PID、文件大小、协议总字节数、输出文件和 wall deadline。控制进程内最多 2 个容器、配置内存合计最多 1 GiB。
- CLI 只调用固定 Docker socket 和命令，没有 shell。控制进程凭据、session、数据库连接和 Docker socket 不进入原生容器。输入/输出经两种固定 Rust 文件描述符操作传输，拒绝符号链接、非普通输出文件、空文件和超限文件；不把容器归档解压到宿主。
- 所有退出路径清理容器及控制端临时目录。取消、协议溢出和超时杀掉整个容器，输出未提交给数据库。

构建入口 `npm run build:web:native -- --with-probe` 固定：

| 用途 | 镜像 |
| --- | --- |
| 原生构建 | `rust@sha256:7c7d4eb4d05b7781187a327809466cfddf29753f6defdc3d19a0e291951b7a37` |
| 运行基础 | `debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc` |

实际构建器报告 rustc 1.100.0。构建输出为忽略目录中的 manifest，记录原生源、原生二进制、传输 helper、supervisor 的 SHA-256 和本地不可变运行镜像 ID。测试 probe 是单独镜像，不进入原生运行镜像。

## 实测与修复

先观察缺少 sandbox 模块的 RED；真实实现随后暴露 Node22 strip-only 不支持参数属性、只读根上的 Docker archive PUT 被拒绝和 archive GET 看不到 tmpfs。改为显式字段与固定文件描述符 helper，没有放开根写权限或挂载宿主目录。XLSX adapter 删除后也观察了缺少模块的 RED，再重新实现。

CPU 测试暴露容器 PID 1 的信号行为，加入 `--init` 后 CPU 软限制能终止原生子进程。真实内存测试发现 Docker `State.OOMKilled` 偶尔漏掉子进程 OOM，不能把所有退出码 137 猜成 OOM。因此增加微型非 root supervisor：原生 stderr 有界丢弃，只有 supervisor 输出资源状态；在退出前读取仍存活的 cgroup v2 `memory.events` 内核 `oom_kill` 计数。只无特权地提高原生子进程的 OOM score。修复后保持严格 RESOURCE_LIMIT/OOM 断言，真实 64 MiB OOM 连续 10/10 正确识别。

实际 Node22.23.5 最终验证：

- 真实容器/原生测试 **8/8**：身份/权限/秘密隔离、禁网、PID、wall deadline、取消、stdout 溢出、CPU、OOM、输出符号链接、并发准入及启动中取消清理。
- CPU/OOM 操作期间，同一个 Node 进程内真实 Fastify `/api/v1/health/live` 仍返回 200，操作后仍可访问。
- 真实 Rust 打开 fixture 后读 A1=37，既有 IronCalc 算出 B1=74；保存后重开有效。独立 ZIP CRC 检查每个原始部件名称和字节（含 custom XML）完全保留。JSZip 仅用于测试构造/独立比对，运行适配器没有引入另一个 XLSX 写库。
- 现有真实 PostgreSQL/Redis/BullMQ 回归 **20/20**，工具/CI/IPC 检查 **15/15**、边界扫描测试 **13/13**，实际浏览器依赖图 553 模块无违规，84 个兼容性输入无漂移。既有 npm/Cargo 锁文件和原生源码未变化。
- sandbox / XLSX NodeNext typecheck 与现有 Web/server typecheck 通过。原有 PPTX harness 继续使用自己的 Bundler typecheck/CI，本次不更改它的模块解析规则。

CI 新增 `native-worker` job，从锁文件安装 Web 依赖，编译原始 Rust，再运行类型检查和真实 Docker/原生测试。CI 覆盖测试已观察缺少该 job 的 RED 后通过；这里只报告本地执行证据，不声称已跑过托管 CI。

## 开放项

- 后续 T08c：将受限任务身份接入既有文件/租约/上传/CAS/回执路径；输出版本与任务成功状态必须在同一个 T06 数据库事务提交。还需证明失锁、取消、撤销、旧版本、重复执行和提交后崩溃不会产生额外版本。
- 公开任务 API、调度守护循环与 T06 `revision_outbox` 消费仍待实现。
- 此后端要求 Linux Docker、cgroup v2 和 builtin seccomp；`NODE_ENV=production` 明确拒绝使用。普通容器不是未知内核漏洞下的强隔离承诺。生产的控制端权限分离、强化运行时、镜像分发/完整第三方声明、部署与安全验收仍由 T21/T23 等阶段完成。
- T07 外部 Word QA、已披露的原 Docs 冷导入 hook 超时以及完整四格式/企业/客户验收仍开放。本次未为 worker-only 变化重跑 30 分钟的原 Docs UI 套件。
