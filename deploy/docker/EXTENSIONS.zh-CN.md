# V2：可选 AI 与宿主原生依赖模板

本扩展不修改应用准入规则，不支持生产，不启用 PPTX/PDF 编辑，不宣称全功能已经跑通。原基础步骤见 README。**两套架构不要混启动**：Docker Web 基线是 localhost HTTP 登录待浏览器验收的 DOCX/文件测试入口；原生 XLSX 必须改用符合要求的宿主 API 和 worker，不能把 root/systemd 塞进 privileged 容器。

## A. 可选 AI（Docker Web 架构）

1. 在基础账号/迁移完成后执行 `python3 ai/generate-keyring.py`，安全备份 `secrets/config_keyring`；已有 keyring 会拒绝覆盖。丢失此文件不能通过生成新密钥恢复已加密凭据。
2. 若首次需要在后台录入加密 provider 配置，可先创建 `ai/provider-profiles.json`，内容为 `[]`。这只挂载 keyring 并开放配置路径，不代表任何模型可调用。
3. 使用以下组合构建/启动；普通基础 Compose 不默认开启 AI：

```sh
docker compose -f compose.yaml -f compose.ai.yaml config --quiet
docker compose -f compose.yaml -f compose.ai.yaml build web
docker compose -f compose.yaml -f compose.ai.yaml up -d web
```

4. 管理界面中填写真实 provider/model/密钥/限额。按 `ai/provider-profiles.json.example` 写真实 JSON，deploymentId、entryId、revision、providerId、model、baseUrl 必须与数据库记录一致。示例故意使用 invalid 域和空 IP，**不能直接使用**。endpoint/baseUrl 必须是同源 HTTPS、无自定义端口/凭据/query/hash；allowedIpv4 必须是代码认可的公网 IPv4 白名单，不可用通配符或内网代理绕过。
5. 重启 Web 载入 profiles。先用小预算测试单请求、取消、上游失败、并发及限额拒绝；验证无密钥输出。供应商流量/计费不由华为 npm 镜像解决，调用须使用自己有权访问的供应商。此包不替你创建供应商账户、购买额度或填秘密。
6. 默认继续关闭代码执行器，不配置 Codex CLI、Python harness 或任意代码工具。channels/source catalog 也不因 AI overlay 自动启用。

## B. 宿主原生 XLSX 实验架构

### 前置条件（缺任一不可启动）

- 独立可信 Linux 宿主，systemd 255+ 为 PID 1、cgroup v2；推荐以 Ubuntu 24.04 amd64 作为待验证目标，而非已认证系统。
- Node 22.23.5 和兼容 npm，Rust edition 2024（仓库记录实测 1.93.0），C 编译器、系统 linker、CA 证书；使用受信源安装。不要执行未知远程脚本。
- `host/ubuntu-noble.sources.example` 给出华为 Ubuntu apt 源，保留官方签名 keyring。审核现有源后人工替换，不能追加冲突源，不能关闭签名校验。arm64/其他系统不可直接套用。
- 可从已审核 apt 源安装 `build-essential pkg-config ca-certificates`；Node/Rust 不假定 Ubuntu 的默认包版本满足要求，须核实实际版本。
- **未核实华为 Rust/rustup/Cargo 镜像可达性**。`host/toolchain.env.example` 对这些留空，`cargo-config.toml.example` 是拒绝直接使用的占位。必须先给出经验证的自有镜像或离线工具链；核对 Cargo index config.json 的 crate 下载 URL，不能只换索引却仍声称全量华为。保留 Cargo.lock 校验、不静默回源。
- 真实、私有 S3 兼容 bucket，API/worker 同 bucket。非 loopback endpoint 必须 HTTPS，证书可信。凭据遵循最小权限；标准 AWS SDK 凭据/角色，并不保证任意 OBS endpoint 协议兼容。先验证 HeadBucket、读写、删除语义。本扩展不伪造 MinIO/OBS 已部署。
- 选用宿主架构即移出旧 local-dev：需要用户明确迁移策略和数据备份，**不能直接更改已有存储后宣称旧文件可用**。推荐新部署 UUID/隔离测试数据验收。

### 基础设施

本节是独立宿主架构模板，不是 Docker-only 全功能。填真实华为 SWR `REDIS_IMAGE`（已同步官方 Redis 7.4）及 PG 镜像后：

```sh
docker compose -f compose.yaml -f compose.host-infra.yaml up -d db redis
```

**不要运行该组合的无服务名 `up`**，也不要启动 Compose 的 web 来假装宿主 API 已接通。宿主通过 127.0.0.1:5432/6379 访问依赖；端口冲突先调整，不停止未知服务。Redis 示例仅适合可信单用户测试主机，未设认证；其他本机用户/同网络容器可访问。多用户/共享主机必须先增加 ACL/TLS 并完成验证，不能直接使用。远程 Redis 必须 rediss，`redis://redis:6379` 会被应用拒绝。

DB 初始化后，使用 `host/worker-role.sql` 创建受限 worker 角色；密码通过受保护输入传入 psql 变量，不能写命令行或提交源码。以 migration owner 运行原 provision CLI，并设置四个角色变量（auth/business/worker 和 owner URL）；完成 bootstrap。运行中的 API/worker 绝不持有 owner/superuser 账号。

### 构建和服务模板

在独立、可信源码安装目录 `/opt/dyoffice` 上，以非 root 构建账号完成依赖安装及构建；不要让 npm scripts 以 root 在不可信 checkout 上执行。使用基础包 rewrite-lock.mjs 在构建副本重写 npm 源并保留 integrity：

```sh
NPM_REGISTRY=https://repo.huaweicloud.com/repository/npm/ node deploy/docker/rewrite-lock.mjs
npm ci --ignore-scripts --include=dev --registry=https://repo.huaweicloud.com/repository/npm/
npm run build:web
npm run build:web:docs
npm run build:web:sheets
npm run build:web:native -- --with-probe
```

源码、node_modules、gateway bundle、Node 和 native 二进制安装到 root 运行位置后必须由可信管理员控制，不允许低权限账号修改；审阅生成 manifest 的 binary 路径与 sha256，服务配置必须用真实值。

`host/dyoffice-api.service` / `dyoffice-worker.service` 是**未安装的模板**。两个 controller 目前均需 root；真实文档解析由原应用创建 dynamic nonroot、私有网络、资源限额 systemd 单元执行。不要新增绕过隔离的 fallback。`/usr/local/bin/node`、`/opt/dyoffice` 是明确安装路径，按实际位置审核调整。

将 `api.env.example` / `worker.env.example` 的所有 REPLACE 项改为真实值，保存到 `/etc/dyoffice/api.env` 和 `worker.env`，目录 0700、文件 root:root 0600；禁止将这些实际 env 文件放入构建上下文。systemd EnvironmentFile 不是 shell，不使用 `$(...)` 展开。API 使用 auth+business，worker 仅 worker+business；二者共用 S3 bucket 与部署 UUID。API 仅监听 loopback，暂使用 http://localhost:3080。会话仍为 Secure/__Host cookie，只能在支持 localhost 安全上下文特例的浏览器中尝试；未完成真实登录验收，不声称可用。远程 HTTP 不支持，不降低 cookie/CSRF 安全。将来远程部署需要另行配置 HTTPS 和 WebSocket 反代，本包不创建 HTTPS 服务。

先 `systemd-analyze verify` 核对调整后的 unit，再依据仓库 HOST-RUNTIME.md 执行真实 sandbox、gateway、native-jobs 测试。所有必需 PG/Redis/S3 测试使用一次性资源；不得指向业务数据。实际 host gate 成功后再安装/启动服务，不提供一键启动来跳过准入。

### 验收门槛

1. 工具链版本、锁文件下载、binary 和 gateway hash。
2. 原生进程实际 systemd 启动；动态 UID、私有网络、资源限额、取消和恢复。
3. PG 角色/迁移/共享部署身份；Redis 重连与幂等任务；S3 读写/删除。
4. XLSX 打开、读取、修改、重算、保存、并发和失败路径；WebSocket 事件。
5. PPTX 仍由代码 `PPTX_OS_ISOLATION_UNAVAILABLE` 拒绝；PDF 本地能力仍 unsupported。它们不是补基础设施就会支持。

## 来源与验证记录

华为 npm：https://www.huaweicloud.com/zhishi/npm.html
华为 Ubuntu 仓库：https://repo.huaweicloud.com/ubuntu/
华为镜像加速限制：https://support.huaweicloud.com/bulletin-swr/swr_bulletin_0003.html

新增 YAML/Python/Shell 和 unit 文本只做静态检查。未访问真实 provider、未下载全依赖、未拉镜像、未启动 Docker/systemd 服务、未做数据库/对象存储/原生集成测试。Rust 镜像候选通过浏览工具无法验证，因此未提供假定可用的默认地址。本包仍是有明确前置条件的测试模板，不是已实测部署。
