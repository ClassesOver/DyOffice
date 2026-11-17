# 四格式统一安全隔离 Implementation Plan

范围更新（2026-11-17，按用户最新要求）：本轮仅支持和验收 openEuler x86_64；ARM64 暂不考虑。这是目标范围，不代表 x86_64 已通过实机验收。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 DyOffice 上建立可证明、可恢复、fail-closed 的 XLSX/PPTX/DOCX/PDF 统一执行边界。

**Architecture:** 保留 TS API/编辑器及 PG/T06 权威，新增窄权限 Rust broker，以 zbus 驱动 systemd。四格式仅实现 profile/adapter，不各自复制租约、保存及回收协议；Podman/crun 仅作同契约候选验证。

**Tech Stack:** 现有 TypeScript/Node、pg、S3 SDK、格式引擎；拟新增 Rust、zbus、serde、Tokio、成熟 Unix FD/凭证库；不新增工作流平台。

**Spec:** [统一设计](../specs/2026-11-17-unified-document-isolation-design.md)。读完设计再执行。本 PR 仅提交计划，所有待办均未实施。

## Global Constraints

- 基于 `feat/dyoffice-web@1a4a4ebb9e8e0009708ab567c1bf99117bbabfdd`；开始每个实现 PR 前重新核对目标。
- 成熟库优先；不重写 TS 业务；PG/T06 是授权、租约、版本及回执权威。
- production 默认关闭；不降级普通 fork、worker thread、API 内解析，不兼容旧 gateway 配置。
- openEuler x86_64、SELinux Enforcing、实际 cgroup v2/seccomp/systemd 能力逐项验证。
- CI、当前 systemd 不可用、浏览器/桌面验收暂不阻止关闭态代码合并；不豁免对应生产发布安全门槛。
- 本文 `新增` 路径和接口是拟定实现契约，不是仓内已有能力；迁移编号实施时分配，不修改历史 SQL checksum。

## Review Focus

- 同一 Cookie 不同编辑器与同一用户不同登录不能互接 dirty session：任务 4、6 用真实 lease 与 upload receipt 验证。
- 控制器在启动确认前/提交后/停止确认前崩溃：任务 3、6 验证不重复实例、不重复提交、不提前归还配额。
- 结构合法但高度压缩/超大像素/外链的文档：任务 5、8 验证有限资源、无 egress、明确拒绝。
- 相同字节 hash 来自另一个 upload 或旧 attempt：任务 6 拒绝来源替代，不能丢弃新 dirty draft。
- runtime digest/架构/SELinux 属性变更后旧“通过”记录不能继续解锁：任务 2、8、9 验证重新认证和 fail-closed。

## 交付切分、依赖和执行约定

| PR 切片 | 内容 | 依赖 | 可独立验收 |
|---|---|---|---|
| P0 | Task 1 协议/入口盘点/契约测试 | 计划审阅 | 是，默认关闭 |
| P1 | Task 2 broker/runtime/systemd | P0 | 是，mock与真机分开 |
| P2 | Task 3 持久账本/回收 | P0；接 P1 做联测 | 是，真实 PG |
| P3-X/P/D/F | Task 4/5 四格式适配，各一 PR | P1+P2 | 分格式关闭态验收 |
| P4 | Task 6 T06统一出口 | P2+至少一适配器 | 真实 PG+RustFS |
| P5 | Task 7 渲染边界 | P0；发布依赖P4 | 前端策略/集成 |
| P6 | Task 8 平台/攻击/性能证据 | P1–P5相应切片 | 仅 x86_64 出报告 |
| P7 | Task 9 迁移/上线门禁/运维 | P4+P6 | 单格式小流量开启另行审批 |

P1/P2 与前端 P5 可并行，四格式 adapter 可在协议冻结后并行。schema 编号/manifest、协议、生产装配与特性门禁由一个集成人串行合并，禁止各 PR 独立放开 production。任何合并不等于发布。独立审查须逐个核对信任边界及真实执行日志；不以 mock 数量替代实机。

每任务遵循 RED→最小实现→GREEN→独立 review→小提交。下列命令从仓库根运行；新增测试和脚本由相应任务创建后才存在。已有 scripts 来源 `apps/web/package.json`，当前 `test:sandbox` 同时含真机测试，环境不足时应记录失败/阻断而非删除用例。

## Task 1 / P0：冻结统一协议与完整入口清单

**Files**
- 修改：`apps/web/worker/src/sandbox/contracts.ts`。
- 新增：`apps/web/worker/src/sandbox/document-contract.ts`、`document-profiles.ts`。
- 新增：`apps/web/test/sandbox/document-contract.test.mjs`。
- 新增：`docs/dyoffice/inventory/document-execution-entrypoints.md`、`document-runtime-policy.json`。

**Interfaces**
- `validateDocumentExecutionRequest(value: unknown, now: Date): DocumentExecutionRequest`，字段见设计第 4 节。
- `DocumentFormat = 'xlsx' | 'pptx' | 'docx' | 'pdf'`；`ProfileId` 为设计中四个枚举。
- `ArtifactResult = {kind: 'artifact', handle: ExecutionHandle, outputHandle: string, sha256: string, size: number, generation: number}`；`CommandResult = {kind: 'reply', value: BoundedProfileReply, generation: number} | ArtifactResult`。只有 export 产出 artifact；read/edit 返回受 profile schema 和字节限制的 reply。输出句柄为一次性 broker-owned 引用，不是路径。
- `SandboxBackend.start(request, input: Uint8Array): Promise<ExecutionHandle>`；`execute(handle, command: ProfileCommand): Promise<CommandResult>`；`stop(handle): Promise<StopObservation>`；`inspect(handle): Promise<InstanceObservation>`。异步任务/长会话共享 identity，不能把成功 execute 当 stop。
- `renew(handle: ExecutionHandle, expectedEpoch: number, validUntil: string): Promise<ExecutionHandle>`：只由当前 worker 在 PG 成功续租后调用；broker 将剩余有效期折算为本地 monotonic watchdog，限制最大续租窗口且不越过绝对 deadline，worker/PG断连自动截止。
- `readArtifact(handle: ExecutionHandle, outputHandle: string): AsyncIterable<Uint8Array>` 与 `releaseArtifact(handle, outputHandle): Promise<void>`：只读封存字节、有界累计、绑定身份，失败重读同一对象，释放幂等。T06 receive 完成后才释放，不在读一半时销毁。
- `StopObservation = {confirmed: boolean, instanceId: string, reason: string}`；只有后续受信观测 confirmed 且实例身份一致才归还配额。

- [ ] **RED**：写 `rejects_unknown_profile_fields_and_paths`、`rejects_expired_or_mismatched_identity`、`rejects_probe_commands_in_edit_profile`；断言固定错误码且 start 未调用。
- [ ] 跑 `node --experimental-strip-types --test apps/web/test/sandbox/document-contract.test.mjs`，记录新增规则缺失导致的失败。
- [ ] 实现 schema/规范化，复用现有 UUID/hash 规则；协议版本不匹配直接拒绝。给每个 format/operation 标记输入限额、输出类型、active-content 策略。
- [ ] 盘点 API/worker/浏览器中 ZIP/XML/PDF/font/image/thumbnail/import/export/save/reopen 入口；逐项填实际文件、信任区、现有测试、拟用 profile。不只覆盖主编辑器，未归属入口禁止被宣告已隔离。
- [ ] GREEN：同命令通过，`npm run typecheck:worker --workspace @dyoffice/web` 通过；commit `feat(sandbox): define unified document execution contract`。

## Task 2 / P1：窄权限 broker、可信 runtime 与 systemd adapter

**Files**
- 新增独立 crate：`services/document-broker/Cargo.toml`、`Cargo.lock`、`src/{main,protocol,peer_auth,systemd_backend,runtime_manifest}.rs`。
- 新增：`services/document-broker/tests/{protocol,systemd_properties,runtime_manifest}.rs`。
- 新增：`apps/web/worker/src/sandbox/broker-client.ts`、`apps/web/test/sandbox/broker-client.test.mjs`。
- 新增：`deploy/document-broker/{dyoffice-document-broker.service,policy.example.json}`、`tools/document-runtime/build-manifest.mjs`。
- 修改：`apps/web/worker/src/sandbox/host-process.ts` 仅抽取可复用契约；生产装配替换在 Task 9，旧 backend 不自动获生产许可。

**Interfaces**
- Rust wire 对齐 Task 1；Unix socket 长度前缀 JSON，控制帧上限 64 KiB，拒绝未知字段/多余帧，字节传输分块，不把 32 MiB 塞进 JSON。
- `BrokerClient implements SandboxBackend`；客户端只传 allowlisted profile 和 opaque handles，不传 unit property。
- `RuntimeManifest {schemaVersion, arch, profileId, runtimeDigest, files:[{path,size,sha256}], policyDigest}`，只读 rootfs 与配置一起生成摘要。

- [ ] **RED**：peer UID 不匹配、路径注入/任意 ExecStart、超长帧、未知字段、清单替换/符号链接、架构不匹配测试全部拒绝且无 D-Bus 启动。
- [ ] 跑 `cargo test --manifest-path services/document-broker/Cargo.toml` 和 broker-client 定向 Node 测试，记录失败。
- [ ] 锁定通过审查的 zbus/serde/Tokio/FD 库版本及 Rust toolchain；zbus 只连 system manager，固定 unit 属性由 profile 生成；捕获 StartTransientUnit job、unit/invocation 标识与最终状态，断线后重新读取，不仅依赖信号。
- [ ] 实现只读 runtime 清单构建、安装时 owner/mode/digest 验证；封存输入；输出通过 FD 或安全 openat 相对目录读取并校验 inode/类型，不信任引擎返回路径。移除执行时宿主 `ldd` 信任。
- [ ] 配置专用 worker UID 的 socket 权限与 broker 受限访问；broker 的 systemd 管理权限单独安全审查。API 不用 root，不授予通用 systemctl/任意 unit 能力。
- [ ] GREEN：单元和客户端测试通过；`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`（均加 manifest-path）通过。真机测试无环境则记录未通过。commit `feat(sandbox): add bounded zbus broker and pinned runtime`。

## Task 3 / P2：持久资源账本与崩溃对账

**Files**
- 修改：`apps/web/server/src/modules/jobs/worker-store.ts`、`apps/web/worker/src/main.ts`、`apps/web/server/src/db/migration-manifest.ts`。
- 新增下一编号 SQL 于 `apps/web/server/src/db/migrations/`（当前最高 0022，实施时重新取号，不写旧 `server/db/migrations/`）。
- 新增：`apps/web/worker/src/sandbox/reservations.ts`、`reconciler.ts`、`apps/web/test/sandbox/reservations.test.mjs`、`apps/web/test/jobs/sandbox-recovery.test.mjs`。
- 修改：`apps/web/worker/src/sandbox/host-recovery.ts`，保留安全归属检查，替换仅目录老化回收的职责。

**Interfaces**
- `reserveAttempt(claim: JobClaim, request: DocumentExecutionRequest): Promise<Reservation>`。
- `bindInstance(reservationId, expectedEpoch, handle): Promise<boolean>`；`recordStop(reservationId, expectedEpoch, observation): Promise<boolean>`；`reconcileDeployment(deploymentId): Promise<ReconcileReport>`。
- 新表 `sandbox_reservations`：deployment/job/attempt/jobEpoch 唯一，tenant、resource class、memory、runtime/policy、state、backend身份、版本；容量行按 deployment/资源池锁定。仅 worker/broker 控制面存取，业务用户不能改 state/epoch。

- [ ] **RED**：真实 PG 双控制器同时 reserve 不超 2/1024MiB 基准；过期 epoch 不能改状态；事务回滚无幽灵配额；broker 启动后 bind 前崩溃能认领同一 attempt。
- [ ] 运行 `node --experimental-strip-types --test apps/web/test/jobs/sandbox-recovery.test.mjs`，用现有测试夹具的独立数据库/受限角色，记录失败，禁止使用生产库。
- [ ] 实现短事务/CAS、DB-time 租约、先 reserve 后启动；实例身份由不可伪造的 broker 管理记录绑定。停止未知→quarantined，不能以任务失败释放容量。
- [ ] 补恢复测试：控制器双重恢复、broker 重启、宿主重启、孤儿活进程、重复名字不同 invocation、DB/DBus 单边不可用、worker停止心跳后由broker watchdog杀停。新增 `adopt(reservation: Reservation, expectedInvocationId: string): Promise<ExecutionHandle>`：worker 在 PG 复核 epoch 后经认证 IPC 提交；broker 核对该 epoch、持久管理记录和实际unit/cgroup/invocation（不直连 PG），换发当前 brokerBootId 的句柄并原子登记；旧boot句柄失效，不能重复 start。无法一致确认则隔离并保留容量。重启后账本与存活实例对账完成前不开放准入。
- [ ] GREEN：真实 PG 测试与 `npm run test:jobs --workspace @dyoffice/web` 通过；保留 failed/quarantined 指标和人工安全处置说明。commit `feat(jobs): persist sandbox reservations and recovery fences`。

## Task 4 / P3-X、P3-P：XLSX 与 PPTX 接统一后端

**Files**
- 修改：`apps/web/worker/src/native/{gateway,xlsx,pptx-session-host,pptx-session,pptx-job}.ts`、`apps/web/worker/src/jobs/xlsx.ts`。
- 修改：`apps/web/server/src/modules/sheets/{runtime,service,save}.ts`、`apps/web/server/src/modules/slides/{service,save}.ts`。
- 新增：`apps/web/worker/src/sandbox/adapters/{xlsx,pptx}.ts`、`apps/web/test/native-sheets/unified-backend.test.mjs`、`apps/web/test/native-slides/unified-backend.test.mjs`。

**Interfaces**
- `createXlsxAdapter(backend: SandboxBackend): DocumentAdapter` 与 `createPptxAdapter(backend: SandboxBackend): DocumentAdapter`。
- `DocumentAdapter` 在 Task 1 增补：`open(request,input) → handle`、`command(handle,ProfileCommand) → CommandResult`、`close(handle) → StopObservation`；续租、artifact 读取/释放直接委托统一 Backend，不复制策略。业务身份复核仍由 service 调用，不移给 untrusted engine。

- [ ] **RED**：后端不可用不 fork/本地 parse；同用户不同 session/editor/epoch 无法复用 draft；lease 在执行中撤销则结果丢弃且 stop；PPTX 8 步/16 MiB 历史和 canonical alias 拒绝仍成立。
- [ ] 跑两个新增文件（PPTX 使用 `NODE_ENV=test node --import tsx --test`，XLSX 使用 strip-types），记录失败。
- [ ] XLSX 复用 #121 gateway 操作/资源边界；PPTX 将真实 parser/session 子程序放 runtime；按 profile 限制命令，不把测试 unsafe fork 接回正式装配。
- [ ] 跑 `npm run test:native-sheets --workspace @dyoffice/web`、`npm run test:native-slides --workspace @dyoffice/web`、`npm run typecheck:worker --workspace @dyoffice/web`；缺 host manifest/PG 真机条件单列阻断，不能称全套通过。
- [ ] 分别提交 `feat(sheets): use unified sandbox backend`、`feat(slides): use unified sandbox backend`，生产能力仍关闭；Task 6 验证保存来源后再评估开放。

## Task 5 / P3-D、P3-F：DOCX/PDF 全入口隔离

**Files**
- 新增：`apps/web/worker/src/sandbox/adapters/{docx,pdf}.ts`、`apps/web/test/sandbox/{docx,pdf}-adapter.test.mjs`。
- 修改：`apps/web/server/src/pdf/{rotate,rotation-job,raster,fonts,save-preparation}.mjs`。
- DOCX 修改文件以 Task 1 清单逐项列入实现 PR；不得仅写“修改 DOCX 引擎”。新统一 server 入口拟为 `apps/web/server/src/documents/docx-execution.ts`，复用现有 docx-engine，不换成保真能力不足的写文件库。

**Interfaces**：两个 `create*Adapter(backend): DocumentAdapter` 对齐 Task 4；只允许已声明操作，unsupported 不静默转普通进程。PDF 现有 pdf-lib 保留适用编辑操作；渲染库依现有引擎与性能/许可结果选择，不为统一形式引入 MuPDF 等新重依赖。

- [ ] **RED**：ZIP bomb/重复路径/XXE/宏外链、PDF JavaScript/Launch/巨幅页/坏字体/嵌入文件在资源上限内拒绝或惰性保留，零网络请求；拒绝不支持的加密/签名编辑，不静默损失内容。
- [ ] 定向执行新增 adapter 测试，记录缺失边界导致失败。
- [ ] 将 API 中重解析与输出重验迁入 runtime，主进程仅做有界元数据检查；DOCX 每个入口清单行必须指到测试或明确 disabled。
- [ ] 每格式建立打开→修改→导出→保存→重开语料；验证内容、关系/样式、计算/布局约束，而不只比较 hash。DOCX 列出所有会持久化的编辑类别，不把 pageColor/mirrorMargins/evenOddHf 三项当全覆盖。
- [ ] GREEN：定向安全与往返测试通过，PDF现有保存/回执回归不退化。按格式各一提交；桌面保真未跑标记 deferred，不写“与桌面完全对齐”。

## Task 6 / P4：有来源证明的 T06 保存出口

**Files**
- 修改：`apps/web/server/src/modules/revisions/service.ts`、`apps/web/server/src/modules/sheets/save.ts`、`apps/web/server/src/modules/slides/save.ts`、`apps/web/server/src/pdf/{save-preparation,save-attempt,receipt-recovery}.mjs`。
- 新增：`apps/web/server/src/documents/output-provenance.ts`、`apps/web/test/native-jobs/document-output-commit.test.mjs`。
- 如需来源列，新 SQL 追加于当前迁移序列并登记 manifest，复用已有 upload/revision 关系，不另建平行 commit API。

**Interfaces**：`bindVerifiedOutput(result: ArtifactResult, request: DocumentExecutionRequest): Promise<PreparedOutput>`，由控制面核实已封存输出、reservation、generation、epoch，返回绑定的 T06 uploadId；commit 保持现有 SaveInput/回执语义。

- [ ] **RED**：同 hash 不同 upload/session/attempt、旧 epoch、过期权限、并发 head 改动都不能提交；输出验完被替换不能进入 ready。
- [ ] 运行 `node --experimental-strip-types --test apps/web/test/native-jobs/document-output-commit.test.mjs`，真实 PG+隔离 RustFS bucket，记录失败。
- [ ] 实现 stage→receive→commit 来源链；旧 commit 回执只读查询可恢复确切结果，response-loss 不重新编辑；保留原始对象和冲突 draft。
- [ ] 故障注入在上传前/后、PG commit 前/后、回执响应前、outbox ack 前；断言最多一个 revision/receipt/outbox、指针不错误推进、未引用对象可追踪、已引用对象不被清理。
- [ ] GREEN：上述实库用例及 `npm run test:native-jobs --workspace @dyoffice/web` 通过；输出验证失败、存储失败与 unknown commit 各自错误码可辨。commit `feat(revisions): bind sandbox output to T06 receipts`。

## Task 7 / P5：渲染与外部资源边界

**Files**
- 新增：`apps/web/src/documents/render-channel.ts`、`apps/web/test/document-render-channel.test.mjs`、`deploy/document-broker/render-origin.example.conf`。
- Task 1 清单中的四格式 mount/preview 页面及 server 响应头配置逐项修改，禁止顺便替换 UI 设计。

**Interfaces**：`validateRenderMessage(event, {origin,source,sessionNonce,maxBytes,lastSequence,rateState}): RenderMessage`，消息包含单调 sequence 和 requestId，sessionNonce 绑定本次 mount；重复/倒序 sequence 拒绝，固定 nonce 的正常复用不算重放。per-source rateState 维护有界时间窗计数，重挂载重新建立状态。消息不携带 Cookie/凭证；下载/保存权限留在主 origin。

- [ ] **RED**：错误 origin/source、旧session nonce、重复sequence、过量消息、恶意链接和外部媒体均被拒绝；其他租户窗口不能读写 session。
- [ ] 执行 `node --import tsx --test apps/web/test/document-render-channel.test.mjs`，记录失败。
- [ ] 实现独立 origin、CSP/iframe 限制与协议验证；实际 headers/cookie 范围通过部署示例说明，禁止通配 postMessage targetOrigin。资源访问默认关闭，未来代理独立做 SSRF 策略。
- [ ] GREEN：定向单元与 server header 测试通过；真实浏览器跨 origin/弹窗/下载测试列入 Task 8，未执行不声称通过。commit `feat(render): isolate document origin and message protocol`。

## Task 8 / P6：平台验收、恶意语料、性能

**Files**
- 新增：`tools/document-runtime/probe-host.mjs`、`apps/web/test/host-native/unified-isolation.test.mjs`、`tools/document-runtime/benchmark.mjs`。
- 新增：`docs/dyoffice/evidence/unified-isolation/{environment-matrix,attack-matrix,performance}.md`。
- 修改：`apps/web/test/host-native/{process,recovery,gateway,parts}.test.mjs` 接统一 backend，不删除原失败案例。

- [ ] 先为缺属性/未知 runtime/错误 SELinux 状态写拒绝探针用例，执行并记录 RED；实现只读 probe，不自动改 boot 参数/SELinux/网络设置。
- [ ] 在目标 openEuler SP 的 x86_64 真机运行 `npm run test:sandbox --workspace @dyoffice/web` 及新增 unified-isolation 文件。保留 OS/内核/unit有效属性、AVC、退出状态、cgroup、runtime digest 和命令日志。
- [ ] 攻击矩阵逐项：跨租户读写、宿主敏感文件、网络/DNS/元数据、Unix sockets、fork/PID、OOM、CPU busy、输出/日志洪泛、临时盘耗尽、子孙进程逃逸、timeout/abort、broker/worker/host 重启、DB断线、D-Bus断线。每项指定预期错误与配额/实例最终状态。
- [ ] 真实浏览器验收单列 `docs/dyoffice/evidence/unified-isolation/browser-origin.md`：跨 origin Cookie 不可见、CSP/iframe禁止能力、伪造source/旧nonce/重复sequence、超量postMessage、弹窗与下载授权；记录浏览器版本、两origin部署与实际响应头。当前可 deferred，不阻关闭态合并；在开放对应用户功能前补齐。
- [ ] 与 P1 相同 workload 评估 Podman/crun 候选：cgroup delegation/userns/SELinux/无 socket/无网络/镜像锁定/清理等同契约。结果不足就不启用；禁止回退绕过。不同后端不共享未校验能力证书。
- [ ] 性能语料按小/中/接近32MiB、复杂表格/大幻灯片/长文档/高像素PDF分桶；记录冷/热启动 p50/p95/p99、峰值RSS、临时空间、吞吐、排队时间、取消释放延迟、交叉租户公平性，注明样本数和硬件。至少每桶30次；基准噪声大则增加样本，不用单次结果承诺SLA。
- [ ] 与当前可信可运行实验基线比较，持续回归超过20%先阻断性能放行并诊断（这是拟定工程门槛，不是已达成数值）。安全限额不可为追求性能取消。首期不复用 dirty worker；优先预热只读 runtime、减少复制、流式有界传输。
- [ ] 依赖锁/SBOM、cargo-audit/deny、镜像扫描及关键协议/归档 fuzz 报告落证据；严重未处置漏洞阻断上线。无可用环境填 blocked，不填 passed；commit `test(sandbox): record unified isolation acceptance matrix`。

## Task 9 / P7：迁移、发布与回滚

**Files**
- 修改：`apps/web/worker/src/main.ts` 及实际应用装配入口（Task 1 清单确认）、`apps/web/server/src/db/migration-manifest.ts`。
- 新增：`deploy/document-broker/rollout.md`、`docs/dyoffice/evidence/unified-isolation/release-gates.md`、`apps/web/test/sandbox/release-gate.test.mjs`。

- [ ] **RED**：缺 probe、错误架构/digest/policy、未完成恢复、quarantined容量不明、未批准 profile 都不能打开 production；原 gateway/unsafe fork 配置明确报错。
- [ ] 运行新增 release-gate 测试，记录失败；实现按格式默认关闭的能力门禁，不解除当前 production guard 后直接裸跑。
- [ ] 迁移顺序：停止新任务准入→排空旧 worker/持久化不可丢状态→备份/验证→追加 schema→部署关闭态 broker/worker→对账→真机认证→单 profile 灰度。旧 worker 不能并行处理新协议；不做旧响应/旧配置兼容层。部署中断停留关闭态。
- [ ] 升级测试保留既有 revision/upload/receipt/lease/账号状态与对象字节；旧协议遗留任务明确取消或重新授权后新建 attempt，不能无条件重新提交。
- [ ] 回滚测试：关闭对应 profile 准入，保留保存回执/已提交版本，终止或隔离活动实例；回滚至上一个已认证 broker/runtime pair，若无则保持 disabled。schema 保持追加态，不 DROP 持久记录或倒退版本指针；恢复服务不意味着重放未知 commit。
- [ ] GREEN：release-gate/升级/回滚测试和独立审查通过；监控 reservation状态、隔离拒绝、OOM、timeout、cleanup_pending、lease冲突、unknowncommit；只记录ID/hash/错误，不记录正文/凭证。commit `feat(sandbox): gate rollout on verified runtime capability`。

## 最终验收与未解决事项

执行完成报告必须按格式列：代码合并、单元、PG+对象存储、真实 OS、保存往返、浏览器/桌面、生产开关，七列分别给 passed/failed/blocked/deferred。所有格式“用了统一接口”不等于全部可上线。

仍需实施期决策及证据：
1. 实际 openEuler SP、内核/补丁与 x86_64 机器清单：Task 8 产出环境指纹；当前不考虑 ARM64，不作为支持范围或验收门槛。
2. broker 权限/SELinux policy：Task 2 提出最小配置，安全评审通过再安装；本计划不授权修改宿主安全设置。
3. 每格式生产资源/SLA：Task 8 测量后锁定；现值仅实验起点，超限暂拒绝而非绕过。
4. 文档功能保真范围：Task 1/5 逐能力列清单，未知/不支持项不宣传全功能；桌面验收延后不代表免验。
5. 依赖确切版本/MSRV/许可证：Task 2/5 锁定，成熟库不能免除漏洞/许可审查；未经审查不自动换引擎。
6. systemd 与 Podman/crun 的最终部署选择：默认先完成 systemd候选验收，OCI对照单独ADR；不维护两套未经验证的生产回退。

本文 PR 只验证文档链接、路径与基线、内容一致性及独立审查，不声称执行上述未来命令或通过真实隔离。实施在计划审阅后另开切片 PR。
