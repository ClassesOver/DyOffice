# Ubuntu Docker 内 systemd / zbus：无害诊断 profile

**这是待实际执行的诊断，不是四格式闭环或文档隔离认证。** 与应用默认 Compose 完全分开，不给业务 API/worker 安装宿主服务，不接任何用户文档，不给业务服务 D-Bus、Docker socket 或宿主权限。本目录以 #147 固定无害 sleep probe 为唯一执行入口，配合 #149 只读宿主前置审计。

## 架构与严格边界

- 独立 Ubuntu 24.04 amd64 容器以 `/sbin/init` 运行 systemd PID1，dbus.service 创建本容器私有 `/run/dbus/system_bus_socket`。Rust zbus 只连接该总线。
- 只运行 Cargo lib-test 中固定的 `systemd_driver::container_diagnostic::fixed_sleep_unit_times_out`，无命令/路径/文档参数。测试仅建立固定 sleep 30 单元，要求 systemd 两秒期限将其停止。
- 无端口、网络、业务卷、宿主路径/总线/socket/cgroup挂载；无 privileged、cap_add、host PID/network/cgroup、关闭 seccomp/LSM、daemon修改或失败自动重试。
- rootfs只读，只有容器内 `/run` 与 `/tmp` tmpfs；容器受内存/PID/CPU上限约束。默认安全策略保持，额外移除 NET_RAW 并启用 no-new-privileges。
- 不用 Docker API/Bollard，不把 Docker socket授予应用，也不借宿主 systemd执行任务。操作员手动使用 Docker CLI 构建/查看容器不等同业务运行时拿到Docker控制权限。
- `container=docker` 是标准运行环境标识，不是隔离证明。镜像不创建 `/.dockerenv` 或伪造 cgroup/userns事实来通过检测。

## 不能由 Compose 独自解决的前提

#147在任何 mutating D-Bus 调用前核验：Ubuntu24.04、Docker标记、systemd PID1、私有cgroup-v2根视图`0::/`、rw cgroup2挂载、cpu/memory/pids、UID/GID0映射到非宿主0、完整DynamicUser范围61184–65519可映射、seccomp过滤、容器内bus socket、无标准Docker socket。未知/不可读均拒绝。

还必须由操作员独立核查：
1. Docker的userns/rootless映射与安全配置；PID/user/cgroup namespace真实隔离，LSM/seccomp仍生效。
2. 只委派**该容器的子树**可写，宿主与容器systemd之间有合适中间层，不能共同改写宿主根属性。**不能用rw挂载整个宿主 `/sys/fs/cgroup` 解决失败。**
3. cgroup delegation与UID/GID映射同时可用；所需嵌套namespace/mount操作在保留安全策略时确实受支持。
4. 对实际单元从D-Bus `ControlGroup`读取cgroup路径，不按unit名拼接；不能把D-Bus连接成功当作隔离成立。

本profile**不配置/制造可写cgroup委派**。默认rootful Docker通常root未映射，默认cgroup挂载也可能只读；systemd可能无法启动，或probe前置检查拒绝。此时结果就是 UNSUPPORTED，不自动增权。若宿主无法在上述边界内提供条件，此方案仍阻断；需新的审核设计，不是反复重试。

## 输入镜像与依赖

将本目录置于仓库 `deploy/docker/document-runtime-diagnostic`；构建源码必须包含合并后的 #147。复制 `.env.example` 到 `.env`，填写**真实、已审核、digest固定的自有华为SWR镜像**：

- `DIAGNOSTIC_UBUNTU_IMAGE`：Ubuntu24.04 amd64。
- `DIAGNOSTIC_RUST_BUILD_IMAGE`：同Ubuntu24.04 amd64、预装Rust1.93.0且有对应Cargo.lock完整离线缓存的审核builder。没有公共builder地址假设，不从未知来源安装Rust。

构建过程仅在镜像内使用默认华为Ubuntu apt（可覆盖HTTPS地址，保留Ubuntu签名keyring），安装systemd/dbus/coreutils/libssl等实际依赖。Cargo编译阶段`--network=none --offline --locked`，缓存缺失即失败，不静默访问外网。最终镜像不含编译器/cache、仓库、业务密钥或一般文档执行入口，只拷贝test binary及其SHA256。

`probe.sha256`只证明构建产物未意外改变，不是独立供应链认证。apt依赖未逐包冻结，因此两输入镜像digest不代表最终镜像可重现；首次成功构建后还必须审核并固定最终镜像digest。本环境未构建或验证任何镜像，华为Rust镜像未核实，builder准备仍是前置阻塞。

## 操作顺序：审计不等于执行

在选定、获准测试的Ubuntu Docker主机上，从仓库根目录先执行 #149：

```sh
python3 tools/dyoffice/audit-ubuntu-docker.py /tmp/dyoffice-host-audit.json
```

该审计**始终返回unsupported/退出2**，不会启动容器或修改daemon；仔细阅读检查项和unverified，不把退出2屏蔽后算通过，不把JSON当授权证书。核实全部外部条件后，操作员才可单独选择下列诊断步骤：

```sh
cd deploy/docker/document-runtime-diagnostic
# 填好.env里的真实digest镜像，核对镜像来源/架构/工具链及离线缓存
docker compose --profile document-runtime-diagnostic config --quiet
docker compose --profile document-runtime-diagnostic build --no-cache document-runtime-diagnostic
docker compose --profile document-runtime-diagnostic up -d document-runtime-diagnostic
docker compose exec -T document-runtime-diagnostic /opt/dyoffice-diagnostic/manager-preflight --container
docker compose logs --no-color document-runtime-diagnostic
docker compose exec -T document-runtime-diagnostic systemctl show dyoffice-probe.service -p ActiveState -p SubState -p Result -p ExecMainStatus
```

不要无条件串联审计和启动，不要自动放宽条件。systemd未启动/容器退出时exec会失败，此失败需要保留。`up -d`、容器running、PID1存活或probe服务状态都不能单独证明诊断通过，须读取真实probe断言与结构化输出。固定probe即使成功，也只输出 `execution_available=false`、`isolation_certified=false`。

出现提交后错误、超时或不确定结果，要保存日志并人工检查固定 `dyoffice-container-probe.service` 与真实ControlGroup；不要盲目重试、自动清理或声称已停止。未启动/前置检查拒绝与提交后的不确定性分开记录。诊断profile不自动重试或reset-failed。完成记录后由操作员明确停止/删除这个诊断容器，不触碰其他服务。

## 四格式真正闭环仍需的验收

固定sleep只是第一步。后续必须实测CPU/内存/PID耗尽、禁止网络、不可访问宿主与broker数据、后代进程/cgroup清空、broker SIGKILL、容器重启恢复身份及固定runtime来源；然后才可讨论受限broker接口和DOCX/XLSX/PPTX/PDF逐格式读写验收。目前 ApprovedRuntime仍不可构造，正常broker退出78，任何业务路径不得消费此probe作为准入。

## 本次验证

静态测试：`python3 -m unittest discover -s deploy/docker/document-runtime-diagnostic/tests -v`（需要PyYAML，仅测试解析Compose）；Shell/Python语法检查。未运行Docker build/config/up、未观察systemd PID1、私有DBus或cgroup委派，没有真实容器单元成功证据。不能将只读审计或静态测试称为闭环。

## 可复验只读证据收集

构建前新增必填 `DIAGNOSTIC_SOURCE_COMMIT`，为干净、已审核构建源码的完整40位提交。
最终镜像保留 `org.opencontainers.image.revision` 标签。标签是构建者声明，不是签名、
远程证明或自动确认构建上下文干净；须由操作员独立审核源码和最终镜像。

在操作员已明确启动诊断容器之后，使用宿主 Python3（仅标准库）收集：

```sh
python3 deploy/docker/document-runtime-diagnostic/collect-evidence.py \
  --container-id <完整64位容器ID> \
  --image-id sha256:<审核后的最终本地镜像64位内容ID> \
  --source-commit <完整40位提交> > /tmp/dyoffice-diagnostic-evidence.json
```

这里的 `image-id` 是 `docker image inspect` 的最终镜像配置内容摘要 `.Id`，不是可变tag，
也不是仓库 manifest 的 RepoDigest。不要仅为让检查通过而现场把期望值替换成任意当前值。
这三个期望值应来自已审核部署记录。信任本机 Docker CLI/daemon 及该镜像构建者，
不把恶意 daemon/镜像自己报告的标签和日志当可信认证。

该命令只调用 Docker inspect 和固定 `systemctl show` / `journalctl` 读取命令，
不 build/up/start/stop/restart/清理、不传入业务文档、不修改权限；每次读取8秒和128KiB上限，
超时只终止读取CLI，不停止容器。只接受当前 probe InvocationID 的日志，前后核对容器/单元
身份与状态，不把历史成功和本次失败拼成成功。报告不输出原始日志，只保留日志哈希。

结果：
- `fixed_probe_passed` / 退出0：固定sleep诊断标记、单个测试成功、probe正常退出，且读取到
  sleep单元timeout/MainPID=0。**不是生产运行可用，也不是所有后代进程/cgroup已清空证明。**
- `failed` / 退出2：当前probe明确失败；可能已提交，不能据此自动重试。
- `unknown` / 退出2：缺字段/标记/日志、镜像或提交不符、超时、日志过大、容器已退出、单元
  尚未结束或观察期间发生变化。包括无法观察的启动失败，不猜测为“从未提交”。保留环境人工核查。

所有报告始终 `execution_available=false`、`isolation_certified=false`。这是点时观察，不保证
报告返回后容器不变化。只读命令失败不会触发重试、清理或降级。旧镜像没有revision标签将拒绝判通过。

本工具在开发环境仅完成合成证据分支及真实子进程读取上限测试；没有Docker build/up、
Ubuntu容器/systemd实机正例，测试中的 `fixed_probe_passed` 不是实机验收结果。
