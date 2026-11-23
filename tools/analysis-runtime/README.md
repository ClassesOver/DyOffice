# Harness 离线数据处理与分析环境

内置与外部 harness 使用同一份依赖及验收规范。数据处理、SQL 编写、统计和图表由 harness 执行；Office 只负责授权、受控取数、传输和保存。数据库驱动用于已授权的数据处理适配，不向 harness 下发 Office 数据源密码。

## 依赖范围

| 能力 | 依赖 |
|---|---|
| 表格、列式数据、本地 SQL | NumPy、pandas、Polars、DuckDB、PyArrow |
| 统计、回归、机器学习、符号运算 | SciPy、statsmodels、scikit-learn、SymPy |
| 静态与交互图表、图像 | Matplotlib、Seaborn、Plotly、Pillow |
| Excel、ODS、CSV、Parquet、JSON、YAML | openpyxl、XlsxWriter、xlrd、pyxlsb、python-calamine、odfpy、orjson、PyYAML |
| SQL 解析、方言、本地 SQLite、驱动 | SQLAlchemy、SQLGlot、sqlparse、sqlite-utils、psycopg[binary]、PyMySQL |
| 文档与结构化文本 | python-docx、python-pptx、pypdf、ReportLab、lxml、BeautifulSoup、defusedxml |
| 单位、日期、字符串、图计算、输出、编码 | Pint、python-dateutil、pytz、Babel、RapidFuzz、NetworkX、tabulate、Rich、chardet、charset-normalizer |
| 可重复校验 | pytest、Hypothesis |

`pyproject.toml` 声明能力范围；`uv.lock` 固定全部解析结果；`requirements.lock` 固定发行包版本与下载哈希。部署不运行依赖升级。更新依赖时在联网构建机执行：

```sh
cd tools/analysis-runtime
uv lock --python /usr/bin/python3
uv export --frozen --no-dev --no-emit-project --format requirements-txt --output-file requirements.lock
```

仅要求系统预装 **Python 3.12**；不随包下载 Python。首次构建另需联网和 `uv`，安装后分析过程不需要 pip、uv、编译器、数据库服务或网络。当前安装脚本使用 POSIX venv 布局，支持 Linux/macOS；Windows 需要单独适配。外部 harness 可直接消费这份运行包，也可用相同锁文件构建自己的运行环境；不能仅自报“支持 Python”就视为依赖兼容。

## 联网构建，离线安装

在仓库根目录运行：

```sh
python3 tools/analysis-runtime/runtime.py build
python3 tools/analysis-runtime/runtime.py install
python3 tools/analysis-runtime/runtime.py verify
```

也可使用仓库统一入口：`npm run build:analysis-runtime`、`npm run install:analysis-runtime`、`npm run test:analysis-runtime`。构建阶段联网，安装和验收阶段离线；这些命令不会在 Office 启动时自动执行。

默认生成 `.dyoffice-analysis-build/`。可对每个命令传 `--output /absolute/path`。构建产物包含：

- 按锁文件摘要命名的 `wheelhouse-*`：目标平台所有依赖的 wheel。
- `wheelhouse.lock`：实际 wheel 的固定版本及 SHA-256。
- `manifest.json`：Python 主次版本、平台、架构、wheel 文件清单与哈希、uv 与安装锁摘要。
- `uv`：同平台安装工具，目标环境无需另行在线安装。
- `runtime/`：安装命令创建的 Python venv。

少数库只发布源码包（例如 odfpy）。它们仅在联网构建阶段从 `requirements.lock` 验证过的源码包构建 wheel，目标机器不执行源码构建。构建机需要能够获取这些库的构建依赖。产生的 wheel 具有独立哈希，作为这一发布包的离线安装依据；清单用于检测包缺失和损坏，不替代发布签名。

将 `wheelhouse-*`、`wheelhouse.lock`、`manifest.json` 和 `uv` 复制到离线目标机的同一个输出目录，再运行 `install`。仓库中的脚本、锁文件和测试随产品发布。**不要搬运已建 venv**：脚本会在目标路径重建 venv，避免绝对解释器路径失效。wheel 包需针对目标 OS、架构与 Python 3.12 构建；不支持把 Linux x64 包直接部署到 macOS/ARM/Windows。

安装同时启用 `--offline --no-index --require-hashes`，禁用 Python 自动下载，使用无效代理，并在安装前校验所有 wheel。缺包、哈希错误或平台不匹配会失败，不会临时联网补包。只有本地 wheel，目标机器不依赖 PyPI、npm 或用户的 Python 全局安装。`builder/` 是联网构建的辅助环境，无需随包发布。

## 接入内置与外部 harness

内置 harness 默认探测 `.dyoffice-analysis-build/runtime/bin/python`。如部署路径不同，设置：

```sh
export DYOFFICE_ANALYSIS_PYTHON=/opt/dyoffice/analysis/runtime/bin/python
```

服务端只读提供 venv 与解释器，任务目录单独可写；禁止 harness 修改共享依赖。任务进程设置 `MPLBACKEND=Agg`、`PIP_NO_INDEX=1`、`UV_OFFLINE=1`，绘图缓存位于自己的任务目录。外部 harness 同样按平台安装此包，并在加入时提供运行环境能力与版本证据；Office 不向外部运行环境安装任意代码。

离线分析可运行已有 CSV、Excel、Parquet、JSON 或冻结查询结果。DuckDB 核心 SQL 无需网络；需要额外 extension 的语法不能在任务中 `INSTALL` 下载，应单独纳入发布包并验证。当前包不承诺 DuckDB 扩展、远程文件系统、地理引擎、Java、R、浏览器或大模型权重。连接外部数据库或获取新数据仍依赖已授权的服务端数据接口可达。

Matplotlib/Seaborn 直接生成 PNG/SVG/PDF，不需要浏览器；Plotly 以 `include_plotlyjs=True` 生成自包含 HTML。没有把依赖在线下载 Chrome 的 Kaleido 纳入本包。Matplotlib 自带基础字体；中文排版若要求特定字体，必须在发布包内提供具有分发许可的字体并指定 `FontProperties(fname=...)`，不能运行时下载字体。

模型推理与数据计算分开：Python 分析可以完全离线，Codex 仍需可达的 Office 模型网关。若要求断互联网也能推理，应由管理员为 Office 配置可达的内网/本地模型服务；本依赖包不包含模型服务或权重。

## 验收与限制

`verify` 使用真实库执行：清洗/关联/分组汇总，pandas/Polars/DuckDB 结果一致性；CSV/Excel/Parquet/JSON 往返及空值保留；统计回归、符号运算和单位换算；无界面静态图表及自包含 HTML；SQL 方言解析和 SQLite 查询。测试禁用 socket 连接与 DNS，并禁用索引和有效网络代理。

依赖足够丰富不等于所有分析方法无需数据和资源限制。任务仍沿用 Office 的数据范围、行数/字节限制、超时、CPU/内存和产物容量限制；不把截断快照当成全量数据。网络、权限、产物保留和模型额度由任务协议及运行器约束，库清单本身不是安全沙箱。

2026-11-17 在 Linux x86_64、Python 3.12.3 完成联网构建、严格离线重装和验收：46 项直接依赖，本平台 77 个 wheel；依赖一致性检查通过，6 项真实分析测试通过。另验证了损坏的安装锁在调用安装器前被拒绝。wheelhouse/安装工具约 349 MB，venv 约 1.1 GB，不进入 Git。测试中 statsmodels/pandas 产生第三方前向弃用警告；这些警告没有被过滤，也没有导致计算校验失败。此记录不等同于真实模型推理或外部 harness 加入链路验收。

## 统一数据 helper

`npm run build:analysis-runtime` 联网构建离线依赖包时，同时把统一 Node 数据客户端打包为 `.dyoffice-analysis-build/harness-data.mjs`。单独重建 helper：

```sh
node tools/analysis-runtime/build-harness-data-helper.mjs
node .dyoffice-analysis-build/harness-data.mjs --help
```

helper 仅依赖 Node 22+ 内置模块，不需要目标机器安装 npm 包。内置 Codex 使用服务端注入的 Node 绝对路径执行只读 helper。完整 Office CLI 同时提供 `genoffice data`，两者复用相同客户端与命令实现：

```sh
node /opt/dyoffice/harness-data.mjs execute sources.list
node /opt/dyoffice/harness-data.mjs execute sources.query --args-file query.json
node /opt/dyoffice/harness-data.mjs manifest RESULT_ID
node /opt/dyoffice/harness-data.mjs download RESULT_ID --out input.json
node /opt/dyoffice/harness-data.mjs execute artifacts.stage --args-file artifact.json
node /opt/dyoffice/harness-data.mjs execute artifacts.commit --args-file delivery.json
```

连接由任务启动器注入 `OFFICE_HARNESS_DATA_URL`、`OFFICE_HARNESS_TASK_ID`，外部使用 `OFFICE_HARNESS_DATA_CREDENTIAL`；内置使用任务目录内 0600 凭据文件，由 `OFFICE_HARNESS_DATA_CREDENTIAL_FILE` 指定路径，避免凭据值进入 Codex 进程参数。凭据不接收命令行参数，也不需要 Office 会话 cookie、数据库密码或模型密钥。外部 harness 直接连接已授权 HTTP API；Linux 内置 Codex 的网络禁用沙箱连 Unix `connect` 也禁止，因此使用 `OFFICE_HARNESS_DATA_MAILBOX` 指向本任务专属交换目录，服务端将 HTTP 请求信封转入完全相同的鉴权路由。邮箱只承担传输，不计算数据，也不扩大来源权限。普通 Node 外部环境还可通过可信启动配置 `OFFICE_HARNESS_DATA_SOCKET` 使用 UDS；不会在失败后自动切换传输或重跑查询。

查询、manifest 与提交只返回有界元数据，拒绝 `rows`/`preview`。普通响应上限为 256 KiB，批量查询的响应上限按每条 SQL 256 KiB 计算。下载单个冻结结果最多 4,000,000 字节，分别重算原始字节 SHA-256 和 PR #132 快照语义摘要，验证后写入调用者指定路径，已有文件不覆盖。请求默认最多 40 KiB，`artifacts.stage` 最多 12 MiB（服务端解码文件最多 8 MiB），`artifacts.commit` 最多 80 KiB。大产物通过本地 JSON 参数文件传递，避免 shell argv 长度限制；stage 使用 `bytesBase64` 字段。

内置数据任务不自动收集工作目录文本，防止冻结结果或上传 base64 经普通编码输出回灌 Office 模型。分析代码通过 stage/commit 回传受管产物及输入证据；Office 继续使用原有文档工具。运行器对实际发布 `manifest.json` 原始字节计算 SHA-256，经 `OFFICE_ANALYSIS_RUNTIME_MANIFEST_SHA256` 和任务指令提供给 Codex；缺失时明确报告证据不可用，不生成占位摘要。任务内不能修改共享 venv、helper 或发布清单。
