# 四格式统一安全隔离设计（待实施）

范围更新（2026-11-17，按用户最新要求）：本轮支持目标为 openEuler x86_64 和 Ubuntu x86_64；ARM64 暂不考虑。两发行版须分别锁定实际 SP/LTS、补丁和 systemd 能力并独立实机验收，不能互相继承结果；当前均未认证。

状态：设计草稿；仅文档，不启用生产能力。核对日期：2026-11-17。
代码基线：`feat/dyoffice-web@1a4a4ebb9e8e0009708ab567c1bf99117bbabfdd`。
配套：[详细实施计划](../plans/2026-11-17-unified-document-isolation.md)。

## 1. 决策与范围

目标是让 XLSX、PPTX、DOCX、PDF 共用任务准入、隔离执行、资源回收、输出验证及 T06 保存契约，不是强行共用一种文档引擎。保留现有 TypeScript API、编辑器、PostgreSQL/RLS、对象存储及 T06 stage/receive/commit。

推荐生产方向为 **TypeScript 控制面 + 窄权限 Rust broker + zbus/systemd 后端**。这是本计划的设计选择，尚未实现或认证。zbus 处理 D-Bus 类型、连接、调用和信号；不负责租户授权、文档解析、安全策略或持久租约。不得把整个 TS 业务重写为 Rust。

成熟组件优先：复用现有 pg、对象存储 SDK、格式引擎、yauzl、fast-xml-parser、pdf-lib；新增 broker 优先 zbus、serde、Tokio 与成熟 Linux FD/peer-credential 封装。版本在实施 PR 中按 MSRV、目标系统和供应链审查锁定，提交 Cargo.lock。当前 zbus 官方文档已包含 wire API 合并变化，不能照抄旧 zvariant/libsystemd-zvariant 组合。

### 方案比较

| 路线 | 用途与取舍 | 本计划决定 |
|---|---|---|
| 现有 TS/systemd CLI | 已有 XLSX 实验基础；业务进程要求 root、shell 工具和动态依赖复制，不适合作为最终特权边界 | 保留关闭的基线作回归参照，逐步替换，不保留旧接口兼容 |
| Rust + zbus/systemd | 小特权面，类型化 unit 属性及生命周期观测；仍共享宿主内核，必须实测 namespace/cgroup/SELinux | 首个生产候选；验收前保持关闭 |
| Podman + crun rootless | 成熟 OCI 生命周期和镜像工具；用户命名空间、subuid/subgid、cgroup delegation、SELinux 均有部署前提 | 使用同一契约做对照实验，达标后单独 ADR 决定是否替换，不自动故障回退 |
| gVisor/Kata | 可提高内核边界，存在兼容/性能/运维成本 | 后续独立评估，不写入首期依赖 |

systemd-run、systemd-nspawn、machinectl 不是同一个隔离方案。普通进程/worker thread/关闭 SELinux/关闭 seccomp 均不是后备路径。rootless 或 OCI 标签本身不等于安全认证。systemd 不可用时可合并关闭态代码，但不能开放不受隔离的解析。

## 2. 当前项目事实与缺口

下面是源代码和既有证据的核对，不是本次重新执行运行时测试。旧 evidence 中的“未合并”等时间性表述应结合本基线解释。

| 现有落点 | 已有能力 | 本计划补齐 |
|---|---|---|
| `apps/web/worker/src/sandbox/host-process.ts` | systemd 隔离、受限命令、资源上限、输出限制；拒绝 production/non-root；XLSX gateway 已移出 API | broker 分权、四格式 profile、完整可信 rootfs、真实平台认证 |
| 同上及 `host-recovery.ts` | 未确认退出时保留进程内 active/memory；回收本 deployment 老旧已停止目录 | 持久资源账本、重启认领与孤儿对账；未知状态不能释放配额 |
| `apps/web/server/src/modules/jobs/worker-store.ts`、`worker/src/main.ts` | PG claim/renew/epoch、通知投递；现有 BullMQ 依赖 | 复用 PG 权威，不另建 Redis-list 任务真相或第二套工作流 |
| `server/src/modules/revisions/service.ts`、T06 migrations | 租约、基线 CAS、幂等回执、不可变版本、事务 outbox | 绑定隔离 attempt/runtime/output provenance，失败恢复贯通 |
| `server/src/modules/sheets/`、`worker/src/native/gateway.ts` | #121 XLSX gateway、关闭态 host；#125 受 capability 控制入口 | 真机隔离、完整保存往返与资源回收 |
| `server/src/modules/slides/`、`worker/src/native/pptx-session-host.ts` | #122 会话/租约/基线围栏、8 步/16 MiB 历史、上传回执来源检查 | 正式 host 接入；当前应用装配拒绝 slidesHost/nativeSlidesDirectory，fork 仅显式测试替身 |
| `server/src/pdf/` | 旋转、私有任务、显式保存及只读回执恢复 | parser/raster/font 子链路隔离，不能把本地对象测试当 OS 隔离 |
| DOCX 编辑器及 T14 | 部分 dirty intent 与 native→T06→PG/对象存储证据 | 枚举所有解析/导出入口、所有持久化编辑，不以个别页属性代替全功能覆盖 |

现有 host 输入/输出 32 MiB；脚本路径允许较大的解释器（160 MiB），无脚本二进制限制 64 MiB，脚本自身 32 MiB。不得沿用“Node 大于 64 MiB 必然无法运行”的旧结论。真正缺口是 `ldd` 从宿主复制依赖、仅 executable/script hash 不覆盖全部库/字体/配置。现有真实 host 三项测试记录为 HOST_BACKEND_UNAVAILABLE，不是通过。

参考仓内证据：
- [XLSX 当前重验](../plans/2026-11-16-xlsx-isolation-current-revalidation.md)
- [T06 事务](../../dyoffice/evidence/t06-revision-transactions.md)
- [PPTX 安全修正](../../dyoffice/evidence/t10-pr113-safety-candidate.md)
- [原 Docker-free 设计](2026-11-16-docker-free-native-design.md)：保留历史；本设计仅更新未来统一隔离方向，不抹去未通过项。

## 3. 威胁模型与信任边界

防护对象：恶意上传者、恶意/损坏文档、被利用的 parser、跨租户或旧会话请求、过期任务、重放输出、崩溃/重启及资源耗尽。
资产：其他租户文件、会话/数据库/对象存储/AI 凭证、版本指针、配额、宿主完整性、可用性。

```text
用户 → TS API（认证/RLS/lease/T06）→ PG 持久任务/配额
                              ↓ 经认证的 broker IPC
                    Rust broker → systemd unit
                                  └─不可信格式引擎/验证器
                              ↓ 有界输出 + 完整来源
                    TS T06 receive/commit → 不可变对象/PG 回执
```

broker 不持有用户 Cookie、PG/S3/AI 密钥，不解析 Office/PDF 内容，不接受任意 executable、参数、unit 属性、环境变量或宿主路径。broker 的 IPC 仅允许专用 worker UID，验证 Unix peer credential；API 无 system bus 管理权。不向 sandbox 挂载 broker socket、D-Bus、Docker/Podman socket、主机 home、SSH agent、云元数据或凭证目录。

同内核方案不能承诺抵抗所有内核漏洞；宿主/root/控制面已被完全控制不在本沙箱单独可防范围。需要更强边界的客户另行评估 Kata/独立节点。恶意文件影响不能以“成熟库”或语言安全免责。

## 4. 统一协议与状态

新增版本化 `DocumentExecutionRequest`（仅内部接口）：`protocolVersion=1, deploymentId, tenantId, actorId, sessionBindingDigest, fileId, editorId, leaseEpoch, baseRevision, generation, jobId, attempt, jobEpoch, inputSha256, inputSize, profileId, runtimeDigest, policyVersion, deadlineAt`。身份字段由控制面从当前授权构造，客户端不能自报 tenant/对象键。broker 只获得必要的不可逆会话绑定，不获得认证 token。输入/输出经 broker 生成的 opaque handle 传递，不接受路径。

格式 profile：`xlsx-edit-v1`、`pptx-edit-v1`、`docx-edit-v1`、`pdf-edit-v1`；parse/validate/export 子命令分别 allowlist。健康探针命令不得出现在生产编辑 profile。schema 对未知字段、命令、格式/operation 组合、过期请求、超限字节数一律拒绝。

`ExecutionHandle` 绑定 deployment/job/attempt/jobEpoch、brokerBootId、backendInstanceId、invocationId、runtimeDigest。重复启动同一 attempt 返回同一状态或冲突，不能隐式启动第二实例。长会话仍有绝对 deadline 与可续租的短有效期；编辑 lease 和执行 job lease 分离，任一失效禁止提交并停止实例。worker 只有在 PG 成功续租后才可向 broker renew；broker 有独立单调时钟 watchdog，不依赖 worker 主动发 stop。读/编辑返回有界结构回复，export 才返回封存 artifact；artifact 读取/释放也绑定实例身份。首期不跨租户复用运行中的进程或可写文件系统；仅允许预热不可变镜像/页缓存。

持久状态：`reserved → starting → running → output_ready → stopped → released`；异常进入 `stop_pending` 或 `quarantined`，并保留资源占用。业务任务成功与物理资源释放分开记录。不得因为 PG lease 过期、D-Bus 断线或 MainPID=0 就断言整棵进程树退出。重启先对账已知 unit/cgroup 与完整实例身份，再准入新任务；缺失/不一致状态隔离并报警，不按名字杀其他服务。broker 重启时，worker 在 PG 复核 epoch 后经认证 IPC 提交；broker 核对该 epoch、持久管理记录及实际 invocation，原子 adopt并换发当前 bootId 句柄，旧句柄失效，不重复启动。

PG 是权威账本，现有 Redis/BullMQ 只负责可重投通知。使用短事务领取、单调 epoch、数据库时间和 CAS；SKIP LOCKED 不是跨事务租约。多个控制器必须锁定同一容量行，单主内存计数不可作为多进程总配额。

## 5. 运行时与资源策略

不可变 runtime manifest 覆盖 interpreter/native binary、动态库、字体、locale、CA（如确需）、脚本、配置及 rootfs 文件清单；当前仅构建 x86_64 的 digest/SBOM。构建时解析依赖，执行时不再信任宿主 `ldd` 结果。禁止下载任意运行时或自动更新运行中的 profile。

默认无网络、只读根、独立工作目录、最少设备、去 capabilities、NoNewPrivileges、namespace、seccomp、cgroup CPU/memory/PID、墙钟 deadline、协议/日志/输入/输出/临时空间上限。临时空间必须可计量（限额 tmpfs 或受配额卷），不能只限制最终输出。SELinux Enforcing 下验证标签和访问拒绝；DynamicUser 不自动替代 SELinux 或 user namespace 策略。

首轮实验沿用现有 XLSX 限额：32 MiB 输入/输出、8 MiB 协议、512 MiB 内存、64 PID、1 CPU、15 秒 CPU、30 秒墙钟。全局 2 实例/1024 MiB 只作基准配置，不宣称适合所有四格式。新增 profile 在测量后独立锁定，超限明确拒绝；不得静默放大全局限额。公平队列按租户限额避免大文件饿死其他租户。

## 6. 文档与输出策略

OOXML：有界 ZIP entry 数/总展开量/压缩比/单 entry/路径深度；拒绝目录穿越、重复规范化路径、符号链接、加密或不支持的包类型。禁止 XML 外部实体/网络 DTD；限制递归、节点、文本量。宏、OLE、外部关系不执行；能安全保真的内容可作为惰性数据保留，否则明确拒绝操作或提示损失，不能静默删除后宣称保真。

PDF：脚本、Launch、远程资源、嵌入文件不执行；加密、签名、XFA 等不支持操作明确返回 unsupported，编辑签名文件说明签名失效。PDF 页数、像素总量、单页尺寸、字体/图片解码均限额。复杂输出结构校验也运行在隔离进程，不重新把攻击面移回 API。

输出只允许 broker-owned 普通文件，有界读取并拒绝符号链接/设备/硬链接别名/目录逃逸及验证后的替换竞态。封存字节后计算 hash/size，与 input/attempt/epoch/runtime/profile/generation 形成服务端来源记录；这些元数据不能由被攻陷的引擎自行签认。恶意引擎仍可生成不正确内容，结构验证和授权不能替代业务语义验收。

T06 在 receive 与 commit 再检查会话、权限、编辑 lease、baseRevision 与绑定 uploadId。结果 hash 相同不等于本次提交成功。提交响应丢失，只读查询确切幂等回执；不重新执行编辑或创建新 idempotencyKey。对象存储与 PG 不是分布式原子事务，未提交输出按现有 T05 引用/保留策略清理，不删除已引用版本。outbox 不冒充对象上传事务。

## 7. 浏览器、AI 与桌面边界

文件渲染采用独立无业务 Cookie 的 origin 与受限 iframe/CSP；消息校验 origin/source/nonce/schema/尺寸/速率。不能把同源 `allow-scripts + allow-same-origin` 当隔离。Web Worker 只改善性能，不提供授权边界。外部媒体由独立受控资源服务处理，默认禁止；SSRF/DNS重绑定/重定向策略不得交给文档引擎。

AI、数据源、MCP、供应商凭证留在现有授权控制面，不放进沙箱；此计划不授权真实模型调用、付费操作或新增对外数据传输。

浏览器/桌面对比暂不作本计划或关闭态代码合并前置；不能因此把交互安全、Office 保真或生产隔离写成通过。发布对应用户能力前需完成相应验收。

## 8. openEuler 与验收门槛

建议验证基线为受支持的 openEuler 24.03 LTS SP，具体 SP/补丁在环境清单中锁定。当前仅验证 x86_64；ARM64 不在本轮支持范围，也不作为验收门槛。记录实际内核、systemd、cgroup v2 controllers/delegation、SELinux policy/enforcing、seccomp、user namespace、runtime digest。没有实机结果不能写“支持已完成”；也不假定所有 openEuler 默认 crun 或 cgroup v2。

证据等级：A 静态/单元与 mock；B 真 PG/对象存储事务；C 真实 OS 隔离/故障注入；D 四格式打开→修改→导出→保存→重开及交互/桌面对比。生产开启至少需对应能力 A+B+C，用户可见编辑还需 D 中相关链路。CI 是否运行不代替证据；当前 systemd 不可用只表示 C 未通过。

发布时每 profile 有能力证书记录环境指纹、测试提交、runtime/policy digest、有效期限与结果。启动必须做能力探测；未知/不匹配/过期证据保持关闭。健康探测不能覆盖全部恶意样本验收。

## 9. 研究文档校正与来源

研究文档作为候选清单，不原样复制其绝对性判断。以下官方资料于 2026-11-17 查阅：
- [zbus](https://docs.rs/zbus/latest/zbus/)：D-Bus 通信库，不是 systemd 或权限引擎；API 随版本变动，实施时锁版本。
- [systemd D-Bus](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html)：StartTransientUnit/属性/信号；生产需对照实际安装版本，不直接照搬 latest 属性。
- [openEuler 24.03 cgroup v2](https://docs.openeuler.org/en/docs/24.03_LTS/docs/Container/iSulad_support_for_cgroup_v2.html)：必须检测配置与支持，不能把 OS 名称当已启用证明。
- [Podman 4.4](https://docs.podman.io/en/v4.4/markdown/podman.1.html)：rootless/cgroup 依赖实际配置；该版本文档不是目标机版本认证。
- [gVisor FAQ](https://gvisor.dev/docs/user_guide/faq/)：SELinux 标签限制需专门评估；不允许以关闭 enforcing 或标签保护偷偷过验收。

本项目无需因统一隔离立即引入 Casbin/OPA、Temporal、Argo 或第二套队列；先复用现有授权与 PG 契约。只有实测发现能力缺口才提出独立 ADR。许可按实际依赖及分发方式审查，不把 MPL/GPL 一概称为“传染”；不以 Docker 名称直接判断安全优劣。

## 双发行版范围补充

当前目标同时包含 openEuler x86_64 与 Ubuntu x86_64，ARM 排除。具体 openEuler SP、Ubuntu LTS 和补丁版本在实机清单中单独锁定；未选择或认证任何 Ubuntu 版本。预检仅识别发行版并记录版本，始终 BLOCKED / productionEligible=false。Rust fixture 显式限制 distribution 为 openEuler 或 ubuntu，systemd-v256 只是 setter 参考 schema，不是发行版能力保证。现有 SELinux Enforcing 要求不因 Ubuntu 默认配置而放宽，AppArmor 不自动替代；缺项应记录阻断，不修改主机设置。
