# T09 Sheets 实验启动接线

T09 仍在验收中。以下记录启动接线及已执行的检查，不代表完整 T09 验收通过。

## 构建和启用

在仓库根目录使用 Node 22，先构建浏览器和服务器 gateway：

```sh
npm run build:sheets --workspace=@dyoffice/web
```

在本地账户、独立 auth/business 数据库凭据、文件存储和部署 ID 的配置中加入以下环境变量。

```sh
NODE_ENV=development
DYOFFICE_AUTH_MODE=local
DYOFFICE_NATIVE_BINARY=/absolute/path/to/xlsx-sidecar
DYOFFICE_NATIVE_SHA256=<该二进制的实际 SHA-256>
```

该本地运行时仅在 `DYOFFICE_AUTH_MODE=local` 且 `NODE_ENV` 为非 production 时可用。在 Linux 上，服务以 UID 0 运行、存在 `/usr/bin/systemd-run` 且未选择 `DYOFFICE_SANDBOX_MODE=subprocess` 时，原生二进制由 T08 的 systemd 主机沙箱运行。该路径需要相应的 systemd 权限与 cgroup 支持，文档执行无 Docker 依赖。

服务器在文件存储、`apps/web/dist-sheets/.vite/manifest.json` 和 `apps/web/dist-sheets-server/gateway-process.mjs` 齐备且具有执行引擎时自动启用 XLSX。部署管理员可通过 `DYOFFICE_NATIVE_XLSX_DIRECTORY` 和 `DYOFFICE_XLSX_GATEWAY_RUNNER` 调整前端构建目录与网关子进程入口。启用条件缺失时 XLSX 入口不可用。已选原生二进制的哈希校验或沙箱启动失败会阻止服务器启动。

打开 `/native-xlsx/?fileId=<拥有的 XLSX 文件 UUID>`。入口使用 Cookie 登录和文件所有权校验；原生请求使用文件版本引用，不接受服务器路径。保存通过 T06 上传暂存、租约和幂等提交。关闭服务器会取消并等待该运行时的原生调用。

## 当前证据

后续 Web 验收覆盖了文件级查找、外链列表和断开外链，以及工作簿图片保存重开。浏览器验收包中的工作簿已经由 LibreOffice Calc 复开、重算和另存。真实 Microsoft Excel 复开仍待验。[四格式对齐验收](genoffice-web-parity.md)

在固定候选 `d90ea092` 的构建产物上，两项启动回归均通过。首次共用宿主运行触发了旧的 20 秒测试总时限。分段复验核对了数据库准备、工作簿导入、实际服务器监听、能力和文件接口、原生页面及 SIGTERM 退出。测试时限调整为 45 秒后，两项重新通过，服务器入口用例耗时约 27 秒。两轮复验使用本机 PostgreSQL 和 systemd 隔离。

`apps/web/test/native-sheets/runtime.test.mjs` 两项测试通过：

- 实验配置约束、实际隔离程序启动、错误哈希拒绝、工作簿读取、关闭后拒绝新任务。
- 启动真正的 `server/index.mjs`，使用独立 auth/business 数据库角色和文件存储，读取 `xlsx: editable` 能力、拥有文件的原生 metadata 和页面，SIGTERM 后以 0 退出。

浏览器入口、服务器和 worker TypeScript 检查通过。完整原生 Sheets 专项套件 22 项通过（包含 6 个真实 HTTPS/Playwright 场景）；新增接口能力回归后，bridge 两项测试通过。名称直接引用、嵌套引用和大小写引用的真实引擎测试共 3 项通过，均覆盖撤销与重做。整体 API 回归、最终审查和真实 Excel 复开仍需完成。

## 初版草稿记录

以下为初版草稿的实现和当时待验事项。

- 名称依赖刷新问题已修复：补齐原引擎展开名称时丢失的依赖元数据，并使词法缓存识别间接名称变更。真实引擎直接/嵌套名称及撤销/重做测试、Name Manager 修改后保存复开的浏览器测试通过。
- 只读加载问题已修复：在用户命令入口限制编辑，允许原有内部导入、选择和计算写回；双页面只读、显式接管、保存和原编辑器租约失效测试通过。
- 透视表定义刷新、文件级查找、工作簿密码修改、外部链接使用分析和跨工作簿选择当前明确返回不可用。透视表定义读取返回 Promise 拒绝，沿用原编辑器的降级路径，避免未定义方法导致打开流程中断。现有透视表部件仍由原保存链保留；此处不宣称刷新能力。
- 整体 API 回归和最终审查尚未完成。浏览器依赖边界扫描已通过（939 个文件、0 个违规）；扫描器新增通配符导出解析及拒绝 Node 依赖的回归测试。
- 尚无已连接的 Excel 会话，真实 Excel 复开核验未执行。

已分别通过的真实浏览器场景包括普通编辑保存与复开、丢失提交响应后的后续编辑保留、公式及数值格式、图表标题编辑，以及原有工具批处理的整体撤销/重做与保存。完整专项套件运行时上述六个浏览器场景均通过；这不代表外部 Excel 验收通过。

## 工作簿媒体读取

图片读取使用拥有文件的不可变版本和图片对象 ID，经原 Rust `read_media` 返回媒体类型和内容。浏览器无需提供路径。与其他读取一致，原生工作结束后再次检查登录和文件可见性。

媒体集成测试使用含 PNG 的真实 OOXML 图片对象，验证返回字节一致；其他用户和管理员访问均为 404，路径参数为 400，缺少 CSRF 为 403。后续 Web 工具专项覆盖了 WebP 图片保存和重开。

## 持续回归

GitHub Actions 增加独立 `native-sheets` 作业：Node 22、主机 PostgreSQL、Chromium、锁定的 Rust 1.93.0，构建原编辑器与 gateway，运行真实原生 Sheets 专项套件、原 XLSX gateway 和名称计算回归。该作业不依赖 Docker。新增工作流覆盖断言已通过；远端作业结果需以 PR checks 为准。

## Runtime 合并与 CI 收口（2026-11-16）

合并 `feat/t08-docker-free-closure`（其 11399380 已完整并入 `feat/dyoffice-web` 线）：TS 服务端为权威，PDF 能力门与原 DOCX 测试保留，browser-host 会话实现收拢至 `session-files.ts` 并保留 `saveSheets` 幂等回执。合并修复：

- `tsconfig.docs.json` 显式包含 `apps/sheets/src/renderer/env.d.ts`，`Window.desktopApi` 全局声明对 native-docx 类型检查可见（此前 TS2551 连锁 TS7006）。
- CI native-sheets 作业按 workspace Playwright 版本安装 Chromium：根仓与 `apps/web` 的 Playwright 版本不同步时，仅按根仓安装会缺少测试进程实际解析的浏览器构建。安装步骤现同时覆盖两者。
- 边界扫描类型擦除采用保守语义：仅整句 type-only 声明（含 import-equals）被擦除；named-type 导入保留并报违规，与 T08 基线测试一致。
- `WorkbookVisuals` 图表编辑器范围对象改为显式回退赋值，消除双类型检查配置下的 TS2783。
- 回环测试在点击保存前轮询依赖公式（B2=42.5）落定：保存载荷经 `readCells` 活读 Univer 模型公式缓存，异步重算窗口内点击会把旧缓存 25 固化进提交字节。

结果：远端 CI 10/10 全绿（含 native-sheets 7m35s、native-docx 22m37s、boundary-check 6m29s）。外部 Excel 复开核验仍未执行，T09 保持草稿直至该人工门禁完成。

## 本地 systemd 验收启动与保存字节核验（2026-11-16）

本地原生构建使用锁定 Cargo.lock、Rust/Cargo 1.98.1（本机已有 stable）和 Node 24.18.0。CI 的 Rust 1.93.0 / Node 22 固定配置未变。构建产物 SHA-256 为 `2edfc39a9b0f7a7a2505c342b67396fc99239601c02dae490c5a0297186c58af`，源码摘要为 `9a7a316022020ea827709d1a35a8f17349d9183962dd3f1ab7139c95d5ca7fac`。

`tools/dyoffice/acceptance-sheets.mjs` 经指定命令 sudo 授权后成功启动：校验原生二进制、实际运行 systemd 非 root 动态用户沙箱、初始化独立数据库角色、导入验收工作簿，并监听 `https://127.0.0.1:3443/`。文档执行不使用 Docker；本次数据库仍使用此前独立测试 PostgreSQL 服务。首次创建数据库因空间不足失败，之后重试成功；未清理其他服务的数据。

通过正常密码登录和 CSRF/Cookie 的独立 HTTP 核验：能力目录、文件列表、原生 inspect/range 和下载均返回 200。历史中有初次导入及一次保存；保存版本 `75914d9c-9f1f-4c07-804f-7465ea6c4f99` 为 3993 字节，SHA-256 为 `9e08733f971143ca504314f5369851a84665bc8867cf983f8c616b911c55e1cb`。下载的 worksheet XML 包含新增 A4 公式 `SUM(A2,A3)` 及缓存 20，B2/F2 公式、C2 日期格式、D2 百分比、E2 单位、Revenue 名称和自定义 XML 内容保留。A2 当前仍为 12.5，没有据此宣称 A2=21.25 场景通过。核验完成后只退出该独立核验会话，保持用户页面会话和服务运行。

已导出已提交工作簿至本地忽略目录 `.dyoffice-native-build/t09-acceptance-saved.xlsx` 供真实 Excel 复开。浏览器自动化受到宿主 `Request workspace is not owned by this CLI` 错误阻塞；图片可见性、外部 Excel 复开及服务退出清理仍未验收。
