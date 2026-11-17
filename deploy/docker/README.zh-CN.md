# Docker 本地开发部署（华为源默认）

此目录内置于仓库，提供**隔离测试模板，不是生产发布**。暂不使用 HTTPS；固定发布 `127.0.0.1:3080`，浏览器只能用 `http://localhost:3080`，不能改成服务器 IP、局域网域名或公网地址。容器内的 `0.0.0.0` 仅用于接收 Docker 转发。

## HTTP 登录的重要限制

应用接受 loopback HTTP origin，但会话始终使用 `__Host-*; HttpOnly; Secure; SameSite=Lax`。本方案**没有删除 Secure、修改 cookie 名称或放宽 CSRF**，production 启动禁令保留。localhost 安全上下文特例取决于浏览器；代码允许 origin 不代表浏览器实际接受 cookie。

**本次没有真实浏览器登录验证，不保证 HTTP 登录成功。** 若浏览器拒收 Secure cookie，当前无 HTTPS 模式被阻断，不提供不安全 fallback。必须在目标浏览器完成登录、刷新保持会话和退出验证后，才能称本地登录可用。不要用 curl 手工带 cookie 作为浏览器成功证据。远程使用可经 SSH 将目标 127.0.0.1:3080 转发到本机 3080，再访问同一 localhost origin，不公开监听。

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

管理员 CLI 必须在交互 TTY 内输入用户名和密码（至少 15 字符），不要把管理员密码放环境或命令行。执行 provision/bootstrap 成功后再启动 Web，访问 `http://localhost:3080`，遵循上述浏览器验收门槛。原生/AI 并不随以上命令启动。

## 数据和安全

- DB 和对象目录均有命名卷。`docker compose down` 不删卷；**不要运行 down -v**，会删除数据。备份 DB、对象卷、部署 UUID 和 secrets 后才升级。
- owner 仅给 provision/admin，不传 Web。auth/business 分离，数据库角色无 superuser/bypassrls/createdb/createrole/replication/inherit。
- 本地 Compose secrets 是文件挂载而非加密 secret 服务。生成目录 0700、文件 0444，让非 root node 用户可读容器挂载；宿主依靠私有父目录限制访问。不要共享/提交密钥。自动生成的十六进制密码可安全组成 URL，手工改密码需 URL 编码。
- 专用 Dockerfile.dockerignore 排除 secrets、实际 env、TLS 和产物。配置目录已忽略密钥；构建上下文仅限干净仓库，不能包含任意额外秘密。
- 旧卷不会重跑 init 脚本或自动改密码；生成器不会覆盖原密钥/UUID。已有数据不能靠重生成密钥恢复。
- 升级前备份并停止 Web，构建后运行 provision，成功再启动；未提供自动回滚。本地对象存储只支持单副本测试。

## 验证与已知限制

执行静态合约：仓库根目录 `node --test deploy/docker/test/contracts.test.mjs`。

本次仅验证 YAML 解析、Shell/Python 语法及部署安全合约、lockfile 重写不变式。没有 Docker Engine，未进行 `docker compose config`、镜像构建、容器启动、数据库初始化或浏览器登录。宿主原生服务和 AI 实调用也未验证。不要把静态通过等同功能可用或生产准入。
