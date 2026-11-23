# Docker 依赖审计与构建边界

本记录对应 PR #143 `ea148be6e73432d4bef9259851ad969371857c2c`。这是依赖供应链检查，不是容器或四格式验收。目标仍是 Ubuntu 宿主上的 Docker 内部隔离；不恢复宿主 worker 路线。

## 当前实际覆盖

|层级|当前配置|状态/缺口|
|---|---|---|
|npm|`NPM_REGISTRY` 默认 `https://repo.huaweicloud.com/repository/npm/`，可显式配置 HTTPS 镜像|锁文件 1024 个远端包均有 SHA-512；只改构建副本 URL，不改版本或 integrity。保留 `npm ci --ignore-scripts`。没有完整下载或镜像构建证据。|
|基础镜像|`NODE_IMAGE` / `RUST_IMAGE` / `POSTGRES_IMAGE` 由部署者提供已同步 SWR 地址|没有已验证的公共镜像或 digest。必须记录源镜像、平台、目标 SWR 的实际 `@sha256:…`，不得用伪造 digest 或浮动 tag 宣称可复现。|
|APT|已有 `host/ubuntu-noble.sources.example` 保留 Ubuntu 官方签名 keyring|只是旧宿主配置示例，当前 Node bookworm-slim Dockerfile 不运行 APT；不能把 Ubuntu noble 源应用到 Debian bookworm。尚无 Ubuntu 容器依赖安装阶段。|
|Rust/Cargo|旧模板留空/REPLACE，保留 Cargo.lock|没有经验证的华为 rustup 工具链、Cargo index 和 crate tarball 完整镜像，Dockerfile 使用 Rust 1.93.0 单独编译 WASI runner。不能只配置 index 就称为全华为。|
|原生业务|Dockerfile 调用现有 `build:saas`：Web/PDF 页面、DOCX/XLSX/PPTX 静态资源及 XLSX gateway JavaScript bundle|这些构建产物不等于原生业务运行时。缺少正式 Ubuntu 容器内 zbus/systemd 业务运行时及真实集成验收；不启用 production 或 unsupported 格式。|

## npm 拒绝式校验

`rewrite-lock.mjs` 只接受 lockfile v3；远端依赖必须有标准 SHA-512 integrity。拒绝非 HTTPS、带凭据/query/fragment 的源、非审核来源及源自定义端口；验证失败不会改写文件，JSON 解析失败也使用固定错误，不回显原始输入或 URL/凭据。最终文件写入不是事务性操作，磁盘或 I/O 故障不保证原文件完整，因此仅在可丢弃的构建副本执行。显式镜像覆盖允许 HTTPS 自定义端口，不能把密码/token 放 URL。已有镜像副本可重复执行，第二次无变化；本地 workspace link 保持不变。

```sh
node --test deploy/docker/test/rewrite-lock.test.mjs
# 构建副本内执行。保留原仓库锁文件作为审计基准。
NPM_REGISTRY=https://repo.huaweicloud.com/repository/npm/ node deploy/docker/rewrite-lock.mjs
# 如需明确改回官方源，应从原始锁文件副本开始，不隐式回源。
```

这些校验不能取代 npm 对实际 tarball 的 integrity 验证，不代表已下载全部包。镜像断网、缺包、哈希不匹配都应构建失败，禁止通过删除 integrity、关闭 TLS/签名或静默回源“修复”。

## 后续全依赖验收门槛

1. Ubuntu 版本/架构与 Node/Rust 工具链固定；给出实际 SWR digest，不混用 Debian/Ubuntu APT 源。
2. Ubuntu APT 保留官方 keyring、InRelease 签名、有效期和包 hash 校验；固定包版本并留受控快照/缓存，否则移动镜像无法保证长期可复现。
3. 同时验证 rustup 工具链/组件、Cargo index `config.json` 的 `dl` 和全部 crate。Cargo 使用 `--locked`；离线阶段使用已校验 vendor/cache 和 `--frozen`。禁止未经验证替换 checksum。
4. npm/Cargo/系统包缓存与源码 hash、平台、工具链版本、镜像 digest 绑定；先完成联网受控取件，再断网重复构建，不能用一次 HEAD 200 代替。
5. 完整 Compose config/build/up、数据库迁移、实际文档运行、取消与资源限制在 Ubuntu Docker 上通过后，才可标记相应项完成。

## 本轮证据与限制

- 本地 Node 24.22.1，24 项重写测试通过；其中初始 19 项对旧脚本为 5 通过/14 失败，新脚本通过，另补 2 项边界测试通过。独立复审发现畸形 JSON 错误可能泄露输入，新增 3 项测试先失败，再修正为固定错误后通过。
- PR 原锁 1024 个远端 URL 全部重写，其他所有字段逐项相等；重复运行改动 0。未执行远端包安装。
- `npm test` 在这个按文件提取的独立审计工作区被缺少 `tools/test/saas-entrypoints.test.mjs` 阻断，不能宣称全仓测试通过。
- 2026-11-17 环境对华为 APT InRelease 请求返回 HTTP 200，但正文是 `Site Unavailable` HTML；npm tarball 与 Rust 目录 HEAD 也为 text/html。因此本轮无镜像可达/制品可用证据。
- 未执行 Docker build/up、APT 安装、Cargo 在线镜像取件或离线重建；没有变更运行权限、安全 gate、数据库或镜像发布。


## 四格式静态构建切片（非完整镜像验收）

Dockerfile 复用根 `build:saas` 固定脚本顺序，不单独猜测编辑器命令：`build:web` → `build:web:docs` → `build:web:sheets` → `build:web:slides`。其中 sheets 脚本继续构建 `dist-sheets-server/gateway.mjs` 与 `gateway-process.mjs`。Docker 专用 ignore 排除宿主已有 `dist-sheets-server`，避免把旧的未验证 gateway bundle 当作镜像输入。

构建上下文仍必须是仓库根；`COPY . .` 目标为 `/app`。运行时保留 `tsx` 所需 dev dependencies，继续 `npm ci --ignore-scripts --include=dev` 与原锁完整性校验，默认 npm 华为源未变。最终 `USER node` 与对象目录所有权配置不变；本切片不添加 root worker、privileged、Docker socket、XLSX/PPTX capability 或 production 开关。

Node/PG 基础镜像仍由操作者在自己的 SWR 中固定真实 digest 与平台，当前配置没有自动验证其镜像内容/架构。Ubuntu noble APT 示例不得用于 Node bookworm 镜像；Rust/Cargo 镜像仍未验证，构建 WASI runner 时需显式满足目标组件与锁文件的下载或缓存要求。即使 `build:saas` 成功，也不能证明 Rust binary、systemd/zbus、隔离 rootfs、Redis/S3/数据库、模型服务或四格式保存运行链已包含且可用。
