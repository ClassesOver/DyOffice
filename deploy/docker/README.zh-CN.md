# Docker Web/DOCX 开发基线（完整容器架构尚未完成）

> 用户目标是整个项目由 Compose 部署，文档处理在容器内部通过 zbus 调用私有 systemd D-Bus。当前文件尚不满足该目标，不能以本 PR 合并代表四格式完成。宿主 API/worker 安装模板仅为历史参考，不是本方案的部署步骤；不要安装它们来绕过容器隔离缺口。见 [完整容器架构与预检](CONTAINER-READINESS.zh-CN.md)。

此目录内置于仓库，提供**隔离测试模板，不是生产发布**。暂不使用 HTTPS；网络绑定、端口和对外 origin 可配置，默认仍是 `127.0.0.1:3080` 与 `http://localhost:3080`。

## 文档任务代理（broker）

Word、XLSX、PPTX 的编辑界面运行在浏览器。镜像的 `web` 构建阶段会使用 Web 服务自身的静态资源加载器，逐项验证三个编辑器的入口、Vite 清单和引用的资源。构建通过只说明这些前端文件可用。

服务端的文档任务需要另一条链路：Web 校验用户、文件版本与编辑租约 → broker 接收被授权的任务 → 通过**容器私有**的 systemd D-Bus 为文档引擎启动受限单元 → 回收结果并清理该单元。Web 不直接接触宿主 systemd 或 Docker socket。

当前 [broker 实现](../../services/document-broker/README.md) 尚不能接收、执行真实任务。`DYOFFICE_DOCUMENT_BACKEND=broker-required` 会在 Web 监听前报 `document broker unavailable`，删除 `docx-only` 则会进入开发子进程路径，两者均不能提供三种编辑器的完整隔离部署。下述启动命令仅对应现有 DOCX 开发基线。隔离环境的前置条件和验收项目见[容器就绪说明](CONTAINER-READINESS.zh-CN.md)。

## HTTP 模式与明确风险

默认 `DYOFFICE_INSECURE_HTTP_DEV=0`：会话仍使用 `__Host-*; HttpOnly; Secure; SameSite=Lax`。本次已用 Chromium 在 localhost 上验证登录和刷新。其他浏览器对 localhost 安全上下文的处理需独立核验。

需要其他设备访问时，在 `.env` 显式设置，例如（IP 必须替换为服务器真实、受控局域网 IP）：

```dotenv
BIND_IP=192.168.1.50
HTTP_PORT=3080
DYOFFICE_ORIGIN=http://192.168.1.50:3080
DYOFFICE_INSECURE_HTTP_DEV=1
```

此开关**默认关闭**，仅 `NODE_ENV=development` 且本地账号模式允许；production/test/未指定开发环境会拒绝开启。不开启时非 loopback HTTP origin 仍被拒绝。`BIND_IP=0.0.0.0` 可监听全部接口，但不推荐，必须自行限制防火墙和访问设备；不要将开发服务暴露公网。origin 必须是浏览器实际访问的精确协议/主机/端口，不得带路径或尾部斜杠。

开启后使用独立 `dyoffice-dev-session` / `dyoffice-dev-login` cookie（无 Secure/__Host），仍保留 HttpOnly、SameSite=Lax、Path=/、无 Domain；严格检查 Host 与 Origin，CSRF 和 WS 同源检查不放宽。不接受其他模式的 cookie，也不信任 Forwarded/X-Forwarded-* 来开启或改变模式。HTTPS 和默认安全 cookie 不会被该开关暗中降级。

**明文风险：局域网监听者/中间人可读取或篡改密码、会话和文档。HttpOnly/CSRF 不能解决链路窃听。仅用隔离网络、独立测试部署 UUID/数据库/账号和虚假数据，不能复用生产密码。** 切换模式后清除浏览器旧 cookie；停用后应撤销全部开发会话，销毁隔离测试库或凭据，不将该库直接升级为生产。dev 凭证有独立 `dev1.` 格式和绑定部署/origin/用途的 MAC，数据库散列完整凭证；改名、去前缀不能重放到安全模式。关闭后拒绝旧 dev 凭证，既有43字符安全凭证保持兼容；这仍不等于删除数据库内的测试会话。

非 localhost 的 HTTP 开发协议已用 Chromium 验证登录、刷新和退出，该测试使用真实认证路由及模拟会话存储。下方另列 localhost 的完整数据库验收。

## 实际支持和依赖

| 路径 | 依赖及支持范围 |
|---|---|
| Docker Web 基线 | Node 22.23.5 bookworm-slim、构建用 Rust 1.93.0 slim-bookworm、root npm lockfile 全 workspace/dev/optional 依赖、PostgreSQL 17、迁移与受限账号、本地对象卷、工作区和 DOCX 前端 |
| AI 可选 overlay | 现有 provider gateway、keyring、匹配真实 DB 配置的 profiles、供应商凭据/预算；见 EXTENSIONS |
| 原生 XLSX / jobs | 现有实现依赖宿主 API/worker；与全容器目标不符，当前 Compose 不提供此能力。须完成容器内受限 broker/runtime 后再接线，不安装宿主模板补齐 |
| PPTX/PDF | 此 Compose 使用 `DYOFFICE_LOCAL_EDITOR_PROFILE=docx-only`，只注册 DOCX；其他部署继续使用其原有的编辑器发现规则 |

普通 Web 不需要 Redis；本地对象卷不需要 MinIO。只有原生路径需要 Redis 和 S3，所以不默认堆砌无消费者服务。代码执行器关闭，不安装/启用外部 agent CLI。原生解析隔离不通过 privileged 容器绕过。

## 默认华为源

- Docker 运行镜像通过华为云 Debian 源安装 Noto CJK 和 Liberation 替代字体，并在构建时验证字体可用。
- npm 默认 `https://repo.huaweicloud.com/repository/npm/`，可通过 `NPM_REGISTRY` 覆盖。构建副本中重写 npmjs/npmmirror 的锁定下载地址，保留版本与 integrity；未知外链拒绝，绝不静默回源。下载内容通过锁文件的 SHA-512 校验。
- Node/Rust/PostgreSQL（宿主依赖另有 Redis）需用户提前同步官方兼容镜像到**自己的华为 SWR**，填真实镜像地址，建议固定 digest。没有虚构公共镜像或发布好的 DyOffice image。私有 SWR 需预先登录。
- Rust 的 `wasm32-wasip1` 组件默认从华为云下载。华为云 Cargo 公共镜像缺少锁定的 `calamine 0.37.0`，Cargo 保留 crates.io；限制外网时可在 SWR 构建镜像预置与锁文件匹配的 crate 缓存。最终 Node 镜像只接收生成的 XLSX runner。
- 官方 npm 说明：https://www.huaweicloud.com/zhishi/npm.html
- 镜像加速适用限制：https://support.huaweicloud.com/bulletin-swr/swr_bulletin_0003.html

## 初始化（从仓库根目录）

```sh
cd deploy/docker
python3 generate-secrets.py
# 编辑 .env 的 NODE_IMAGE / RUST_IMAGE / POSTGRES_IMAGE，填写已同步的真实 SWR 地址
# 需要 Docker Engine、Compose v2 和足够磁盘；不要复制其他仓库/秘密到构建上下文
docker compose config --quiet
docker compose build web
docker compose up -d db
docker compose run --rm provision
docker compose run --rm admin
docker compose up -d web
docker compose logs --tail=100 web
```

镜像构建时会校验 Node 版本与根目录的 `.nvmrc` 一致。Sheets 打包默认使用 2800 MiB 的 V8 老生代堆上限，容器还需为构建工具和系统留出内存。可用 `docker compose build --build-arg BUILD_HEAP_MIB=4096 web` 调整，此参数仅在构建时生效。

管理员 CLI 必须在交互 TTY 内输入用户名和密码（至少 15 字符），不要把管理员密码放环境或命令行。执行 provision/bootstrap 成功后再启动 Web，访问配置的 `DYOFFICE_ORIGIN`（默认 `http://localhost:3080`），遵循上述浏览器验收门槛。原生/AI 并不随以上命令启动。

## 数据和安全

- DB 和对象目录均有命名卷。`docker compose down` 不删卷；**不要运行 down -v**，会删除数据。备份 DB、对象卷、部署 UUID 和 secrets 后才升级。
- owner 仅给 provision/admin，不传 Web。auth/business 分离，数据库角色无 superuser/bypassrls/createdb/createrole/replication/inherit。
- 本地 Compose secrets 是文件挂载而非加密 secret 服务。生成目录 0700、文件 0444，让非 root node 用户可读容器挂载；宿主依靠私有父目录限制访问。不要共享/提交密钥。自动生成的十六进制密码可安全组成 URL，手工改密码需 URL 编码。
- 专用 Dockerfile.dockerignore 排除 secrets、实际 env、TLS、本地 npm 配置、个人工作区、复现文档、AI 网关实际配置和宿主构建产物。配置目录已忽略密钥；构建上下文仅限干净仓库，不能包含任意额外秘密。
- 旧卷不会重跑 init 脚本或自动改密码；生成器不会覆盖原密钥/UUID。已有数据不能靠重生成密钥恢复。
- 升级前备份并停止 Web，构建后运行 provision，成功再启动；未提供自动回滚。本地对象存储只支持单副本测试。

## 验证与已知限制

执行静态合约：仓库根目录 `node --test deploy/docker/test/contracts.test.mjs`。

本草稿分支在 Linux 上使用官方 Node 22.23.5 bookworm-slim 和 PostgreSQL 17 alpine 镜像验收，npm 使用默认华为源。已通过：

- 30 项 Node 部署与锁文件测试、6 项 Python 预检测试、7 项 HTTP 开发模式测试；另用 BuildKit 验证了实际配置、构建产物与敏感文件示例的上下文过滤。
- Compose 基线与 AI overlay 配置解析、完整镜像构建、独立数据库初始化、运行时角色授权、交互式创建管理员、Web 就绪探针。
- 默认 Secure cookie 模式下，Chromium 在 localhost 登录真实 PostgreSQL 账号并刷新后仍能读取当前会话。

CI 在 PR 的合并结果上构建 Compose 服务、执行数据库迁移、查询就绪状态，并用镜像内的 WASI runner 打开 XLSX 测试工作簿。私有 SWR、AI 供应商和四格式隔离运行时未纳入本次验证。
