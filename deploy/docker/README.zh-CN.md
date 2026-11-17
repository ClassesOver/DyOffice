# Docker 本地开发部署（华为源默认）

此目录内置于仓库，提供**隔离测试模板，不是生产发布**。暂不使用 HTTPS；网络绑定、端口和对外 origin 可配置，默认仍是 `127.0.0.1:3080` 与 `http://localhost:3080`。

## HTTP 模式与明确风险

默认 `DYOFFICE_INSECURE_HTTP_DEV=0`：会话仍使用 `__Host-*; HttpOnly; Secure; SameSite=Lax`。localhost 安全上下文特例取决于浏览器；没有真实浏览器验收，不保证默认 HTTP 登录成功。

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

本次未证明浏览器登录可用：Chromium 实测尝试被执行环境 `socket() Operation not permitted` 阻断。API 注入测试通过不能替代目标浏览器的登录、刷新、退出验收。应用不会在失败时自动放宽安全选项。

## 实际支持和依赖

| 路径 | 依赖及支持范围 |
|---|---|
| Docker Web 基线 | Node 22.23.5 bookworm-slim、root npm lockfile 全 workspace/dev/optional 依赖、PostgreSQL 17、迁移与受限账号、本地对象卷、工作区和 DOCX 前端 |
| AI 可选 overlay | 现有 provider gateway、keyring、匹配真实 DB 配置的 profiles、供应商凭据/预算；见 EXTENSIONS |
| 原生 XLSX / jobs | 需要宿主 API **和** worker 的 root/systemd 255+/cgroup v2 隔离、Rust/C 工具链、Node gateway、PG worker 角色、Redis、S3；不能 Docker-only，见宿主模板 |
| PPTX/PDF | PPTX 无受支持隔离 runtime，代码拒绝；PDF 本地 capability 为 unsupported；不假装可启用 |

普通 Web 不需要 Redis；本地对象卷不需要 MinIO。只有原生路径需要 Redis 和 S3，所以不默认堆砌无消费者服务。代码执行器关闭，不安装/启用外部 agent CLI。原生解析隔离不通过 privileged 容器绕过。

## 默认华为源

- npm 默认 `https://repo.huaweicloud.com/repository/npm/`，可通过 `NPM_REGISTRY` 覆盖。构建副本中重写 npmjs/npmmirror 的锁定下载地址，保留版本与 integrity；未知外链拒绝，绝不静默回源。已核对 1024 个地址，未全量联网下载。
- Node/PostgreSQL（宿主依赖另有 Redis）需用户提前同步官方兼容镜像到**自己的华为 SWR**，填真实镜像地址，建议固定 digest。没有虚构公共镜像或发布好的 DyOffice image。私有 SWR 需预先登录。
- 当前 Docker build 不运行 apt、Cargo 或 rustup；OS 依赖在基础镜像中提供。宿主可选路径的华为 Ubuntu apt 参考及 Rust 镜像未核实阻塞见 EXTENSIONS。不能声称全部原生依赖已可从华为拉取。
- 官方 npm 说明：https://www.huaweicloud.com/zhishi/npm.html
- 镜像加速适用限制：https://support.huaweicloud.com/bulletin-swr/swr_bulletin_0003.html

## 初始化（从仓库根目录）

```sh
cd deploy/docker
python3 generate-secrets.py
# 编辑 .env 的 NODE_IMAGE / POSTGRES_IMAGE，填写已同步的真实 SWR 地址
# 需要 Docker Engine、Compose v2 和足够磁盘；不要复制其他仓库/秘密到构建上下文
docker compose config --quiet
docker compose build web
docker compose up -d db
docker compose run --rm provision
docker compose run --rm admin
docker compose up -d web
docker compose logs --tail=100 web
```

管理员 CLI 必须在交互 TTY 内输入用户名和密码（至少 15 字符），不要把管理员密码放环境或命令行。执行 provision/bootstrap 成功后再启动 Web，访问配置的 `DYOFFICE_ORIGIN`（默认 `http://localhost:3080`），遵循上述浏览器验收门槛。原生/AI 并不随以上命令启动。

## 数据和安全

- DB 和对象目录均有命名卷。`docker compose down` 不删卷；**不要运行 down -v**，会删除数据。备份 DB、对象卷、部署 UUID 和 secrets 后才升级。
- owner 仅给 provision/admin，不传 Web。auth/business 分离，数据库角色无 superuser/bypassrls/createdb/createrole/replication/inherit。
- 本地 Compose secrets 是文件挂载而非加密 secret 服务。生成目录 0700、文件 0444，让非 root node 用户可读容器挂载；宿主依靠私有父目录限制访问。不要共享/提交密钥。自动生成的十六进制密码可安全组成 URL，手工改密码需 URL 编码。
- 专用 Dockerfile.dockerignore 排除 secrets、实际 env、TLS 和产物。配置目录已忽略密钥；构建上下文仅限干净仓库，不能包含任意额外秘密。
- 旧卷不会重跑 init 脚本或自动改密码；生成器不会覆盖原密钥/UUID。已有数据不能靠重生成密钥恢复。
- 升级前备份并停止 Web，构建后运行 provision，成功再启动；未提供自动回滚。本地对象存储只支持单副本测试。

## 验证与已知限制

执行静态合约：仓库根目录 `node --test deploy/docker/test/contracts.test.mjs`。

本次通过部署合约 5/5、HTTP开发模式与既有CSRF测试 11/11、server TypeScript、YAML结构及Shell/Python语法。完整 unit 以 `--experimental-test-module-mocks --import tsx` 运行：635 项中632通过、3跳过、0失败（执行环境Node 24.22.1，不代替镜像Node 22.23.5验收）。新增浏览器协议测试使用真实auth路由但模拟DB/session，不是PostgreSQL全链路；实际启动尝试因socket限制失败。没有 Docker Engine，未进行 `docker compose config`、镜像构建、容器启动、数据库初始化或浏览器登录。宿主原生服务和 AI 实调用也未验证。不要把静态通过等同功能可用或生产准入。
