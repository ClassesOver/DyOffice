# SaaS-only decoupling: product entrypoints

## Decision and boundary

DyOffice is a SaaS product, not a desktop application. This first stage changes
root product commands; it is not a claim that every desktop dependency has been
removed. It does not enable production isolation or change database migrations,
authentication, document data, or host security settings.

The previous default commands launched Electron and built installers. The new
commands are:

| Command | Current behavior |
| --- | --- |
| `npm run dev` / `npm start` | Existing Web Node entrypoint |
| `npm run build` / `npm run build:all` | Web entry pages, workspace shell, DOCX, XLSX, PPTX and PDF browser bundles plus XLSX server gateway |
| `npm run build:web` | Web shell only, unchanged |
| `npm run build:web:native` | Explicit existing server-side XLSX native runtime build; not automatically installed or enabled |
| `npm run test:saas:entrypoints` | Default command boundary regression |

Root `predev`, `postinstall`, `shell`, `dev:docs`, and `dist:mac/win/linux`
product commands are removed, not renamed as a desktop compatibility offering.
Root `test` runs the shared-package suite, Web HTTP suite, Web unit suite and
entrypoint guard. Root `typecheck` runs shared-package checks and Web, DOCX,
XLSX, PPTX, PDF and browser-shell entrypoint checks. Removed desktop workspace suites
are not silently presented as tested. Real PostgreSQL, Rust worker, end-to-end
browser and sandbox tests retain their explicit dedicated commands.

The default PPTX build also emits the workspace shell for the SaaS build command.
An isolated PPTX build with a separate `--outDir` leaves the default workspace
shell intact; build its companion shell with `vite.local-shell.config.mjs`.

## Installation and dependency boundary

The active workspaces are Web, the three shared Office editor source workspaces,
the shared shell UI workspace, Markdown source workspace consumed by the headless
CLI, and packages. Desktop-only PDF/HTML app workspaces are excluded; their
reusable engines remain packages. Markdown renderer sources are still imported
by CLI conversion and must not lose their declared dependencies. Electron,
electron-builder, electron-vite and electron-updater dependencies and launch/
installer metadata were removed from active workspace manifests. The npm-generated
root lockfile no longer resolves these desktop runtime or packaging packages.
`electron-utils` is retained because browser/editor paths reuse selected helpers;
its legacy desktop-only files are not in the Web build/typecheck closure.
`electron-to-chromium`
is browser-version compatibility data, not an Electron runtime.

A fresh root `npm ci` without `--ignore-scripts` is supported. Explicit build
steps still apply to Rust workers and approved analysis runtimes. Installing
JavaScript dependencies does not activate production isolation or a worker.
Web's unit tests now declare their Tiptap core/pm/document/text/bold imports
explicitly rather than depending on incidental packages from retired workspaces.

## Keep and extract, do not delete wholesale

- `apps/docs/src/renderer`, `apps/sheets/src/renderer` and Slides renderer code
  are reused by Web entrypoints. Keep editor commands, collaboration and UI.
- `apps/sheets/native/xlsx-engine` is a service-side engine used by
  `tools/dyoffice/build-native-sandbox.mjs`. It is not the desktop shell.
- `packages/electron-utils` mixes shared helpers with desktop runtime/type imports
  (for example drop-open, renderer-protocol, app-menu). Its package description
  is not a safe boundary. Shared/desktop export separation must pass the full
  retained package tests and typechecks before this stage is merge-ready.
- Web `local-shell` is browser UI, not the Electron `apps/shell` product.
- CLI/agent-core/analysis-runtime are server or agent components; their ability
  to spawn authorized server tasks does not make them desktop components.

## Next independent stages

1. Move reused renderer/host contracts into clearly named browser/server
   packages. Current relative source paths still reference apps/docs, sheets,
   slides and shell; these paths are not proof that Electron executes.
2. Remove now-inactive desktop main/preload/IPC/auto-update source and obsolete
   release instructions only after tracing every shared consumer. They are not
   supported entrypoints; their on-disk presence is a remaining cleanup item.
3. Validate the full authenticated server/worker flows and browser behavior.
   Bundle builds and unit tests are not Office feature parity or real production
   sandbox acceptance. Existing unsupported runtime capabilities remain closed.

No desktop user profile, local document, production data, database ledger or
remote deployment is deleted by this stage.

## Office 工具对齐的剩余验收项（2026-11-19）

以下是当前工具链路的具体差距，不以构建或单元测试通过代替完成。产品范围为
DOCX、XLSX、PPTX、PDF；不增加 Markdown/HTML 编辑或创建能力。

2026-11-20 复核发现，模型工具名覆盖并不等于执行对齐：

- Word 的思维导图已通过 Chromium 验证：模型调用生成卡片，用户点击后才把图片插入当前文档，本场景没有自动提交新版本。Word/Excel 共用的 PDF 创建实现现保留显式换行、代码缩进、粗体、斜体、下划线和删除线；PDF.js 回读核对了位置、文字变换及绘制指令。Chromium 核对了工具随宿主能力注册：直达 Word 隐藏创建工具，直达 Excel 只提供 CSV，模型省略格式仍能下载实际的 CSV。工作区入口继续注册已支持的格式。
- Excel 在文本预览截断时仍保留原始 XLSX、XLSM、XLS、CSV、TSV；文本读取会明确返回截断错误。Chromium 和隔离 PostgreSQL 验证了同一轮合并 BIFF XLS、截断 XLSX 及截断 CSV，保存并重开后读回 CSV 末行。
- PPTX 的脚本与图片插入按实际渲染宽度转换坐标。原生会话已验证组合子元素移动、导出和重开后的坐标与尺寸。用 AI 生成稿替换整份 4:3 文稿时采用生成稿的 16:9 画布，撤销恢复原尺寸。原生会话回读 PPTX 核对了项目符号、段落间距、径向渐变、描边与合并表格；无效参数不会改变文件。HTTP 和 Web 桥接回归验证了同批编辑、重排后，布局审计定位到移动后的页面并发现越界元素。
- 原生 PDF 的交互式复选框按当前可见页寻址。Chromium 和隔离 PostgreSQL 验证了未保存重排后勾选可见第 1 页，手动保存后另一页没有被修改。纸面静态勾叉随图像草稿保存，重开后可用图片编辑工具选中；Web 不写入桌面专用的静态表单元数据。浏览器核对了模型请求：重排后当前页和选区使用可见页号，输入框取得焦点后仍包含选区，清除后下轮不再带上旧选区。点击助手回复中的页码可跳到正确的可见页面，无效页码只显示文字。
- 扫描页接入本地 OCR。Chromium、隔离 PostgreSQL 和真实 Tesseract 验证了同一份 PDF 内扫描页与原生文本页的读取、识别结果进入助手搜索，以及读取时版本和字节不变。用户显式保存可写入隐形文本层；重开后可提取文字，扫描页和原生文本页的渲染像素均与原件一致。单次最多写入 980 条 OCR 文本，按完整页面计入，不占用普通插字的 20 条额度。自动涂黑不会依据隐形文本推断图像上的位置。正式环境的 OCR 安装和资源隔离仍待验收。

本轮浏览器测试模拟模型响应；未部署到 3081。

Web CI 在运行 Chromium 前构建四种原生编辑器与工作区，并准备 XLSX 引擎、绘图和 OCR 依赖。四格式 Harness 刷新续接及 PDF 真实 OCR 保存用例使用明确的构建目录，不会因缺少目录配置而跳过。CI 也启用外接执行器测试替身：四种原生编辑器分别核对委派、父对话续跑、从历史找回交付、手动保存和重开读回。该测试使用固定模型响应；真实模型与正式 Harness 的组合另行验收。

| 范围 | 仍需完成 | 完成证据 |
| --- | --- | --- |
| Word 知识库 | 已接个人收藏 kbList/kbSearch/kbRead、固定版本搜索和分页、Web 引用。Chromium 已用真实 `deepseek-v4-flash-0731` 通过收藏搜索、正文读取、随机编号回答及点击引用打开来源 | [浏览器用例](../../apps/web/test/local-browser/word-knowledge.test.mjs)核对真实搜索和读取请求、回复编号、引用地址、打开来源及两份文档的原字节；隔离 PostgreSQL 测试覆盖分页、固定版本和其他用户拒绝。本次引用打开用例的来源头版本未变化 |
| Word 正文写回 | 已用真实 `deepseek-v4-flash-0731` 在当前 DOCX 写入标题和正文，手动保存后重开可读。固定模型验证了流式草稿期间自动保存不会写入临时正文 | [浏览器用例](../../apps/web/test/native-docs/writer-draft-save.test.mjs)核对保存前版本不变、保存后正文 XML 与历史原件字节。通过 `DYOFFICE_LIVE_WORD_WRITER_CONFIG` 指向私有共享模型配置重跑 |
| XLSX 已有透视表 | 已接通定义读取、Rust/Node 刷新保存重开及样式 band 主题、条纹、汇总行对比；已补 AI 和直接刷新依赖的整批预检。Chromium 加隔离 PostgreSQL 已通过工具栏刷新及真实 `deepseek-v4-flash-0731` 调用 `refresh_pivot` | [浏览器回归用例](../../apps/web/test/local-browser/sheets-pivot-refresh.test.mjs)核对重开后的 `G2:G4 = [150, 50, 200]`、缓存 `refreshOnLoad="1"`、刷新不改版本、手动保存仅新增一版、历史原件字节不变；原生测试覆盖跨用户拒绝 |
| XLSX 全工作簿查找 | 助手可查找未加载到网格的文字、正则匹配和公式错误 | [浏览器回归](../../apps/web/test/local-browser/sheets-find-cells.test.mjs)用固定模型访问真实查找和范围读取 API，核对 `AZ25001`、`AA1001`、`AB1002` 以及文件版本和原始字节均未变；[Node 与 Rust 集成用例](../../apps/web/test/native-sheets/find-cells.test.mjs)验证远端搜索、分页不重叠和跨用户拒绝。真实模型分支需单独配置 |
| Excel 合并附件 | Web 支持 XLSX、XLSM、BIFF XLS、CSV、TSV；旧 XLS 和分隔文本由隔离进程转换，公式导入为计算值，宏部件不继承 | [Chromium 用例](../../apps/web/test/local-browser/sheets-attachment-merge.test.mjs)用固定模型验证同一轮合并 BIFF XLS 和预览截断的 XLSX、手动保存和重开两张表，核对旧表中的文字及数值、长表全部 40 行和历史原件。该用例另有真实模型的 XLSX 分支。[原生服务集成用例](../../apps/web/test/native-sheets/truncated-merge.test.mjs)验证五格式混合导入、CSV 引号、TSV 固定制表符、XLSM 公式缓存值及宏不继承、空附件导致整批终止 |
| PPTX Harness 写回 | 已修复 CSV 的来源说明撑大单元格而阻止小表格插入的问题：原生数据表与来源文本框作为同一事务写入。固定模型和真实 `deepseek-v4-flash-0731` 均用本机 Codex、隔离 PostgreSQL 和 Chromium 验证了委派、暂存、提交、插入、手动保存及重开 | [浏览器用例](../../apps/web/test/native-slides/analysis-live.test.mjs)核对两份交付、插入不改版本、保存新版本、历史原件字节、来源哈希和重开后渲染。真实模型运行已知计算脚本；生产隔离与部署仍待验收 |
| PPTX 整套生成、单页重做及风格模板 | 共享助手生成可编辑幻灯片，也可只重做指定页或把生成风格存成个人模板供后续使用 | [Chromium 用例](../../apps/web/test/local-browser/native-slides-generate.test.mjs)使用固定上游模型，经过真实 Web 会话和原生编辑器。整套生成与单页重做均先进入草稿，手动保存后重开一致；单页重做支持撤销与重做，未改页的 XML 及历史版本字节保留。刷新后经助手读取个人模板并利用保存的风格追加一页，跳过重新生成风格。另已用真实模型验证两页生成、指定页重做、两次手动保存与重开。 |
| PPTX 链接与动画 | 已接形状链接、文字片段链接和动画列表读写；形状链接设置或清除时保留文字片段链接，读取按当前代数串行执行 | [Chromium 用例](../../apps/web/test/native-slides/size-roundtrip.test.mjs)验证编辑器读写、下载、重开及放映时点击第一张幻灯片的文字跳到第三张；隔离 PostgreSQL 和原生会话另验证外链、旧代数、失效租约及其他用户拒绝 |
| 内置 Harness 取消 | 固定模型、真实 Codex 和 Chromium 已验证从 PPTX 对话卡片取消正在执行的任务，随后可启动新任务并保存交付 | [浏览器用例](../../apps/web/test/native-slides/analysis-live.test.mjs)核对指定任务的取消请求返回 204、取消任务无交付、界面保留「结果待核对」，新任务则完成原生写回。未覆盖外接 Harness 或跨会话恢复 |
| Harness 在线任务状态 | 四种原生编辑器可在同一登录会话和页签恢复任务卡片。四种格式均可在同一文件版本续接原 Office 对话中的单次 Harness 调用。服务端同一进程最多保留 32 条任务，完成后最多 10 分钟；服务重启不保留。检查点读取遇到网络错误可自动重试一次。模型容量与权限校验通过后才消费检查点；并发续跑只接受一个请求，其他窗口不会结束共享对话。请求准入后中断不自动重放 | Chromium 和隔离 PostgreSQL 的 [Word](../../apps/web/test/local-browser/native-docx-harness.test.mjs)、[XLSX](../../apps/web/test/local-browser/native-sheets-harness.test.mjs)、[PPTX](../../apps/web/test/local-browser/native-slides-harness.test.mjs) 和 [PDF](../../apps/web/test/local-browser/native-pdf-harness.test.mjs) 回归使用固定模型和任务适配器，验证刷新后只派发一次、原对话继续、关闭自动保存时仅显式保存才产生新版本，并读回成品。PDF 用例还模拟检查点响应丢失，验证当前页面可自动重读并续接同一任务。[HTTP 回归](../../apps/web/test/unit/coding-recovery.test.mjs)验证检查点响应丢失可重读、模型请求准入互斥及版本不符拒绝；[隔离 PostgreSQL 回归](../../apps/web/test/local-integration/harness-task-recovery.test.mjs)核对拒绝跨账号、跨会话、跨文档和回收站文件访问 |
| Harness 续跑期间手工编辑 | 在恢复后的助手首次写入前，如果文档已有新的改动，停止工具执行，并在原对话保留原因 | [XLSX 浏览器回归](../../apps/web/test/local-browser/native-sheets-harness.test.mjs)在模型返回前把 H2 改为 99，验证助手未写入 42、手工值可保存、停止提示刷新前后均只显示一次；另一分支验证无冲突时正常写入和保存 |
| Harness 已提交交付恢复 | 展开「分析交付」时可恢复当前账号最近 10 条已提交回执。刷新 PPTX 后已验证从历史列表插入、保存及重开，未重新执行 Codex | [浏览器用例](../../apps/web/test/native-slides/analysis-live.test.mjs)核对刷新后的历史读取和成品；[隔离数据库用例](../../apps/web/test/local-integration/analysis-delivery-presentation.test.mjs)核对其他账号及旧会话凭据无法读取原账号交付。未完成任务的跨会话状态仍待验收 |
| 外接 DSH 后台读取 | 现行直接签发授权 Token 的流程已通过官方 DSH、真实模型、Chromium 和隔离 PostgreSQL 的四格式验收 | [浏览器用例](../../apps/web/test/local-browser/assistant-background-http.test.mjs)核对关闭浏览器后提交及完成任务、绑定的保存版本、重新登录后的结果与频道成员移除 |
| Office 向外接 DSH 委派及文件写回 | Word、XLSX、PPTX 和 GenOffice 原生 PDF 已通过真实模型委派、官方 DSH 交付、父任务自动续跑、历史交付写回、显式保存及重开。PDF 将文本报告和来源信息作为附录追加到新页；旧 Web 预览页可下载历史交付 | [浏览器用例](../../apps/web/test/local-browser/assistant-dsh-delegation.test.mjs)核对同一父任务续跑、文件哈希、保存前后版本及重开后的成品 |
| GenOffice PDF 界面 | 独立入口直接加载桌面功能区、缩略图和画布，并接入共享 Office 助手。已验证助手分页读取、流式回答、直接改写已有原文、页面旋转、显式保存、保存回执恢复及重开 | [浏览器用例](../../apps/web/test/local-browser/native-pdf-open.test.mjs)核对第二页原文进入工具回执、同页重复文字只改选中一处、仅新增一个版本及原件字节不变。装配原生 PDF 资源后工作区默认进入该编辑器；助手和手工改写都提前校验目标；手工编辑框使用 PC 引擎返回的字形边界和原色 |
| PDF 真实模型改写 | 已用 `deepseek-v4-flash-0731` 在 Chromium 改写已有段落，恢复丢失的保存回执，并重开保存版本；固定模型分支也通过 | [浏览器用例](../../apps/web/test/local-browser/pdf-block-edits.test.mjs)核对一次暂存、两次同次提交请求、替换文字和未改动页脚，以及历史原件字节。通过 `DYOFFICE_LIVE_PDF_BLOCK_CONFIG` 指向私有共享模型配置重跑。此项只验证 PDF 原文段落改写 |
| PDF 受保护文档 | 包含签名结构、XFA 或加密的已有 PDF 保持只读；普通 PDF 仍可编辑。识别签名结构不等于验证签名有效性 | [浏览器用例](../../apps/web/test/local-browser/native-pdf-protection.test.mjs)核对密码错误与正确密码、助手实际读取、编辑工具隐藏、功能区旋转和保存禁用，以及原版本和下载字节不变；普通 PDF 可旋转并进入待保存状态 |
| PDF Harness 混合编辑 | 已验证发现计算代理、委派、用返回值改写原文和已有批注，再显式保存。内置分支使用本机 Codex CLI 0.171.0 实际运行计算，并验证任务卡片的执行进度；真实上游模型与生产 Harness 的组合仍待验收 | [浏览器用例](../../apps/web/test/local-browser/native-pdf-harness.test.mjs)走真实任务 API 和隔离 PostgreSQL，使用固定模型响应；外接分支使用计算适配器，内置分支以 `DYOFFICE_TEST_CODEX_CLI=1` 启用。模拟连续丢失两次保存回执，再点保存会确认同一版本；独立回读并重开，正文和批注面板显示新内容，原作者及历史原件保留 |
| PDF 原文与图片编辑 | 原生功能区手工选图、翻转、裁剪、透明度和去背景已通过 Chromium 与隔离 PostgreSQL 验证，可与原文改写、批注及表单一次保存并恢复丢失回执。同页手工与助手翻转三处共享资源的图片已通过画布及缩略图预览、撤销/重做和成品像素回读。助手像素工具现支持普通 AcroForm；浏览器混合保存验证已有复选框的字段、值、控件和外观未改变，旧版草稿预览保存及加密、已签名和 XFA 拒绝规则也通过回归。兼容入口的移动、插入和替换也已验证读回图片与表单，服务端混批覆盖旋转和删除。原生 PDF 助手的图片翻转、裁剪、透明度和去背景已通过保存前画布与缩略图预览、撤销/重做、显式保存和像素回读；水印/页眉页脚及正文插入、页面结构编辑组合闭环已验证；跨文件替换页已通过实际选择/确认/保存/重开；敏感候选审查→永久涂黑新副本已通过PG/浏览器；新增文字T块及新增图片I块的修改/移动/删除/撤销与统一批量保存已验证，真实像素/回执恢复通过；已有嵌入图片现按PC一目标一项待保存编辑，撤销/放弃及T/I统一保存经真实浏览器和PG验证；普通嵌套Form的复杂旋转/倾斜翻转裁剪已通过像素、PG及聊天工具浏览器保存重开；add_form_mark 静态勾叉草稿及交互式复选框写入已通过聊天工具保存重开，普通AcroForm新增T/I以字段树与外观完整性校验保护；图片搜索/生成已装配到真实模型请求并通过短引用→草稿→保存像素读回浏览器测试，公共服务ready误判已修复；addFormField五类控件/日期/中文外观、原radio追加与空signature后续新增已接通并通过PG/聊天保存重开；生成GIF/WebP（含动画）首帧转PNG已通过实际聊天保存及像素读回；外部GIF/WebP获取→转PNG→与生成图统一保存已通过聊天浏览器及原生像素核对；canonical removeTextInsert 已接待保存文字原子批量删除及一次撤销；九项 `apply_ops` 已接入统一待保存界面，真实 Chromium 与隔离 PostgreSQL 验证混批、预览、撤销/重做、手动保存单版本、回执恢复及重开；含托管水印、页眉页脚和表单的统一保存已通过 Chromium；同页编辑保留水印像素，删页重排更新页码，已有图片像素编辑已接统一预览、撤销和保存，并通过混合保存及像素回读，待保存旋转后的文字及新增图片放置和移动已通过浏览器验证；特殊裁剪、混合模式及 Group 仍有限制；混合编辑尚未用真实模型与 Harness 复验 | 每项通过聊天工具实际调用、保存回执、独立重读或渲染成品；拒绝静默覆盖、错目标或假成功 |
| 四格式模型与 Harness | 四种格式均已有真实模型加本机内置 Codex、官方外接 DSH 的原生写回和保存重开证据；生产隔离下的执行与恢复待验收 | [Word/XLSX 内置 Codex](../../apps/web/test/local-browser/native-word-sheets-codex.test.mjs)、[PPTX 内置 Codex](../../apps/web/test/native-slides/analysis-live.test.mjs)、[PDF 内置 Codex](../../apps/web/test/local-browser/native-pdf-harness.test.mjs)及[外接 DSH](../../apps/web/test/local-browser/assistant-dsh-delegation.test.mjs) |
| 发布与运行隔离 | 本机离线分析运行时77包、真实 Codex CLI 及内外 Harness 数据交付已验证。当前工作树独立构建了 Web、工作区和四种编辑器，原生资源清单与产物一致，Chromium 已实际加载四格式候选 | [四格式浏览器回归](../../apps/web/test/local-browser/office-tool-inventory.test.mjs)、[XLSX CSP 加载](../../apps/web/test/local-browser/sheets-csp-entry.test.mjs)和[健康检查](../../apps/web/test/local-integration/api-compat.test.mjs)通过。无生产凭据启动验证了生产本地模式在监听前拒绝。候选尚未部署，生产文档与 Harness 的运行隔离仍待验收 |

逐项验证记录在 `evidence/web-pdf-ai-edits-2026-11-19.md` 等现有证据文件中。
此表随实际实现与验收结果更新；表中待完成项尚未全部关闭。

PPTX 的浏览器资源与原生会话后端必须一起配置，否则应用拒绝启动，避免对用户报告可编辑却在打开时失败。当前本地模式使用 Node 子进程，与生产文档隔离分开验收；生产账号模式仍在监听端口之前拒绝启动，日志明确报告文档运行时不可用。

2026-11-20 的 Ubuntu 24.04 只读探测发现本机 Docker 未启用用户命名空间，未运行容器隔离探针。可用 [宿主前置检查](../../tools/dyoffice/audit-ubuntu-docker.py)输出 JSON 复查。仓库的 `manager-preflight` 已读取实际 systemd 255 管理器，核对 UID 0、PID 1，并返回 `execution_available: false`。[拒绝路径回归](../../apps/web/test/native-jobs/broker-required.test.mjs)通过：缺少可用 broker 时，API 和 worker 在读取凭据或连接依赖前拒绝启动。该结果不代表生产隔离已通过。

四格式源代码工具清单核对：157 项定义均有明确分类。四种编辑器中声明的 PC 文档工具均已纳入对应 Web 白名单，桌面专用 `run_cli` 由产品策略排除。该核对只证明白名单覆盖，实际开放仍取决于会话权限、宿主能力和服务配置；工具执行与保存另以浏览器及真实模型验收为准。

另与本机安装的 GenOffice 0.13.18 发行包核对：四种编辑器打包脚本中，名称及工具定义为字面量的工具分别为 Word 40 项、XLSX 18 项、PPTX 18 项、PDF 46 项。除 Word 的 `run_cli` 外，均能在对应 Web 白名单找到同名工具。Word 的思维导图和两个知识库工具来自 Web 共享助手，未在 Word 编辑器内重复定义。此核对不包含动态拼装的工具，也不证明参数或行为一致。

共享模型网关兼容 PC 已支持的正常收尾方式：模型发出完整的 `finish_reason` 帧并正常结束连接，随后即使没有 `[DONE]`，Office 仍接收该轮工具调用和用量。未正常结束、帧不完整或结束原因与工具调用不一致时，仍不交付候选调用，也不自动重发请求。[解析器回归](../../apps/web/test/unit/provider-openai-stream.test.mjs)和[隔离 PostgreSQL 网关回归](../../apps/web/test/local-integration/shared-provider.test.mjs)验证了解析、实际 Office SSE 和调用状态结算。下述四格式浏览器回归中的 Harness 委派和父对话回复均使用省略 `[DONE]` 的模型响应。

共享助手网关会分别提示模型供应商鉴权失败、限流或额度不足、服务暂时不可用，提示检查配置、重试或改选模型。[隔离 PostgreSQL 回归](../../apps/web/test/local-integration/shared-provider.test.mjs)覆盖 DOCX、XLSX、PPTX 和 PDF 的 SSE 请求：提示使用固定文案，上游响应正文不出现在对话中，不跟随重定向，也不自动重发。管理员设置页「测试连接」只测试已保存的模型，按相同故障类别显示中文建议；无法识别的故障保留通用提示。[四格式 Chromium 回归](../../apps/web/test/local-browser/office-dock-unified.test.mjs)用测试上游返回 429，验证中文对话展示原因、保留输入草稿、用户手动重试后正常响应。四种格式均核对附件及所选个人技能随手动重试发送。较早请求延迟失败时，用户正在写的新草稿不会继承旧请求的附件和技能。

模型显式报告长度上限时，网关保留已收到的文字和用量，丢弃该响应里所有工具候选。PDF 前台保留部分回答并提示分段继续；后台读取和收到外接代理委派的只读任务将截断标为失败。[PDF 浏览器回归](../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)验证截断不创建文件，随后正常请求可创建并保存 PDF 与 DOCX。[隔离 PostgreSQL 后台回归](../../apps/web/test/local-integration/assistant-channel-background.test.mjs)从真实任务 HTTP 接口核对失败状态及一次模型调用，部分结论不会成为交付。

[四格式运行时回归](../../apps/web/test/local-browser/office-tool-inventory.test.mjs)在隔离 PostgreSQL 和 Chromium 中检查模型网关实际发出的工具：仅配置聊天时隐藏媒体工具，配置就绪后按格式开放。修复了允许无密钥的 Custom 图像生成和图像分析配置被误判为不可用的问题。PDF 从工作区打开时可创建独立文件和页面副本，直接打开原生编辑器时隐藏这些依赖工作区的工具。固定模型在四种编辑器中均不指定执行器，测试验证每份文档仅派发一个绑定到该文档的默认 Harness 任务，同一 Office 对话收到结果并继续回复，任务卡片成功；PDF 另验证完成前能看到实时输出。本项不替代真实模型与正式 Harness 的组合验收。

共享 Harness 卡片收到运行输出时默认展开日志。输出追加到固定高度的滚动区，手动折叠后不会被新输出打开；载入已完成任务时默认折叠。[PDF 内置 Codex 回归](../../apps/web/test/local-browser/native-pdf-harness.test.mjs)用真实 CLI 和固定模型验证了命令运行时日志已经可见、追加结果后日志高度不变。原文和已有批注在手动保存前保持草稿，保存回执丢失后重试仍只生成一个新版本，重开后可读回两项修改。

同一回归确认 Excel 助手能处理生图和图片搜索返回的 WebP。生图只向模型返回短引用，下载图片也由浏览器转为 PNG。固定模型将两张图片分别插入 B2 和 D4，浏览器显式保存后重开，再从新版本读取图片。独立检查了锚点、PNG 尺寸、像素及历史原件字节。该用例使用固定媒体响应。

Word 和 PPT 的 `analyze_media` 按就绪的图像及音视频服务分别描述可用输入；Web 不宣称能读取本地文件路径。Chromium 核对了仅图像和仅音视频两种配置发送给上游模型的实际工具说明与参数。Word 在仅配置音视频时，附图仍可随消息发送给聊天模型，工具说明和消息上下文均不再提供用于图像分析的附件索引。[Word 附件用例](../../apps/web/test/native-docs/attachment-media.test.mjs)验证仅图像配置下仍可分析本次附上的图片，但不会继续使用上条消息的图片索引。验收使用固定服务响应。

Web Word 的 `insert_image` 和 `insert_picture` 复用当前编辑器的本地附图引用，未配置图像分析服务也可插图。[Word 图片 Chromium 用例](../../apps/web/test/native-docs/image-media.test.mjs)用固定模型响应验证光标插图、带替代文字的浮动图片、拒绝旧引用且不取网，以及生成图和网页图仍能保存。回读 DOCX 的图片像素与浮动锚点，重开仍显示四张图，源版本字节不变。

重跑 Word 知识库真实模型测试时，通过 `DYOFFICE_LIVE_WORD_KNOWLEDGE_CONFIG` 提供私有 JSON 文件路径，文件的 `entry` 为已授权的共享聊天模型配置；未设置时走确定性模型。测试使用隔离 PostgreSQL 和自建 DOCX。共享 SSE 解析器允许已有合法工具 ID 的后续分片带空 ID，仍拒绝首帧空 ID 和中途换 ID。

Web 原生 PDF 打开时会检查编辑限制。检测到签名结构或 XFA 后显示只读原因，关闭文档编辑与保存工具，保留页面浏览和助手阅读。[Chromium 与隔离 PostgreSQL 回归](../../apps/web/test/local-browser/native-pdf-protection.test.mjs)用合成签名结构、XFA 和真实 AES-256 密码文件核对助手可读、没有编辑草稿、文件版本与字节不变。加密用例另验证新上传仍被拒绝，隔离库中的既有文件输错密码后可重试，解锁后仍只读。普通 PDF 对照可继续编辑。该项不验证签名真伪或客户 XFA 样本。

PDF 助手支持选择本地文件、粘贴图片及发送前移除附件。当前消息有文本类附件时才开放 `read_attachment`，图片随消息提供给模型；后续空附件消息可继续使用已经读到的结果。任务卡片可继续跟踪委派，但含本地附件的回合不会生成刷新后自动续跑的检查点。[PDF 创建 Chromium 用例](../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)验证实际解析接口、文本读取、图片模型请求、从附件生成独立 PDF、下一条不带附件的消息创建 DOCX，以及原 PDF 版本和字节不变。模型用固定回包。

Web 原生 PDF 的 `insert_image` 和 `replace_image` 可直接使用当条消息的附图。只有处理当条消息的 Office 图片编辑工具能解析该引用，不发起图片下载，也不会在后续消息中指向同名附件。[PDF 图片 Chromium 回归](../../apps/web/test/local-browser/pdf-media.test.mjs)用固定工具响应验证插图、原位替换、有无新附件时拒绝旧引用、保存后读回像素，以及源版本字节不变；同时覆盖原有网页图片和生成图路径。

PDF 的「＋」菜单已与 Word、Excel、PowerPoint 共用，可选择文件，也可搜索和附加当前账号的个人技能。技能正文随选中的这条消息发送，用户消息保留原文和技能名称；发出下一条未选技能的普通消息时不会再次发送旧技能正文。[四格式 Chromium 回归](../../apps/web/test/local-browser/office-dock-unified.test.mjs)另核对 PDF 刷新后技能仍可从账号列表找到，未自动选中。

PPTX 浏览器生成回归可通过 `DYOFFICE_LIVE_SLIDES_GENERATE_CONFIG` 显式启用真实模型，使用同格式私有 JSON（顶层 `entry`）、隔离 PostgreSQL 和自建 PPTX。该分支核对真实工具回执、生成整套与指定页重做先进入草稿、两次手动保存及重开，以及未修改页的 XML 和两个历史版本字节保持原样。未提供该配置时只运行固定模型分支。

Web PPTX 助手引用图片文件名时优先使用当前消息上传的图片，后续仍可复用已发送的图片；草稿和仍在排队的附图不会提前进入图片工具。[Chromium 用例](../../apps/web/test/local-browser/native-slides-attachment.test.mjs)以固定工具响应插入与替换图片，从保存的 PPTX 读取像素和图片框，并比较源版本字节。

PDF 图片混合编辑用例 `apps/web/test/local-browser/native-pdf-open.test.mjs` 通过 `DYOFFICE_LIVE_PDF_IMAGE_CONFIG` 显式启用真实模型，使用同格式私有 JSON、隔离 PostgreSQL 和自建三图表单 PDF。验证模型按列表位置选择中间图、手工与助手草稿同时可见、手动保存后重开像素和表单一致。未提供配置时，仅运行固定模型分支；真实模型及 Harness 验收需分别记录。

原生 Web PDF OCR 使用服务进程 `PATH` 中的 Tesseract，加载英文和简体中文模型。Ubuntu 软件包为 `tesseract-ocr`、`tesseract-ocr-eng`、`tesseract-ocr-chi-sim`。服务没有可执行引擎时，PDF 仍可读取已有文本层。设置 `DYOFFICE_TEST_PDF_OCR=1` 可启用真实引擎回归：`apps/web/test/unit/pdf-ocr.test.mjs` 验证识别与坐标、输入限制和文件授权，`apps/web/test/local-browser/native-pdf-open.test.mjs` 验证助手读取与搜索、显式保存、重开及像素一致。识别在部署侧本地执行，不向外部模型发送页面图像。

Web PDF 的后台索引与助手读取共用 OCR 重试逻辑：首次识别置信度较低时，以较小尺寸重试一次，择优保留结果。真实 Tesseract 与 Chromium 已复验同一文档中的英文扫描页、原生文本页、普通字号及大字号简体中文扫描页。大字号标题可完整识别，显式保存后可独立提取；重开后可按连续汉字词组同时找到两张中文扫描页。四页像素及原生文本均与原件一致。识别结果仍取决于扫描质量。

本机全量回归启用 OCR 时，测试进程的 `PATH` 未包含 Tesseract，扫描页用例报告未识别到文本。给同一候选和同一用例补齐 Tesseract 及 `eng`、`chi_sim` 语言数据后，Chromium 定向复测通过（1/1）；正式部署仍需确认服务进程可以找到引擎和语言数据。
Web CI 在构建前检查两种语言数据，并直接用实际引擎跑 OCR 识别和路由测试，以便区分环境缺失与浏览器回归。

XLSX 透视表浏览器用例默认走原生工具栏。设置 `DYOFFICE_LIVE_SHEETS_PIVOT_CONFIG` 为同格式私有 JSON 文件的路径，即可用自建 XLSX 重跑真实模型分支。
XLSX 附件合并用例通过 `DYOFFICE_LIVE_SHEETS_MERGE_CONFIG` 显式启用真实模型，使用同格式私有 JSON 和自建 XLSX。

Web Excel 的 `propose_operations` → `add_image` 可用当条消息的附图。引用在当前编辑器中解析，后续消息使用旧引用会失败，不发起下载。[四格式 Chromium 工具回归](../../apps/web/test/local-browser/office-tool-inventory.test.mjs)以固定模型响应把生成图、网页图和本地附图放到 B2、D4 和 F6；实际手动保存并重开，核对三个锚点、图片像素、旧引用拒绝和历史原件字节。

当前工作树的模型网关与 Harness 服务回归在隔离 PostgreSQL 中通过：15 项覆盖共享模型流式响应、任务续接鉴权、交付回执恢复、外接执行器读取冻结数据和保存交付。默认跳过的内置执行器分支另用本机 Codex CLI 与离线 Python 环境补跑通过（1/1）；源数据只查询一次，生成的报告、图表和代码成功提交，输入过期后仍能恢复原回执。内置分支使用固定模型响应，不能代替真实上游模型与正式 Harness 的组合验收。

PDF 助手附件已通过当前构建的 [Chromium 回归](../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)：从附件菜单选入文本、粘贴图片，模型请求带上图片和附件索引，`read_attachment` 返回的文本进入新建 PDF。下一轮未附文本时不再提供该工具，仍能另建 DOCX；源 PDF 版本和字节保持不变。

四种渲染器重新构建后，通过了共享助手的界面和限流恢复（1/1）、实际模型请求中的工具清单与默认 Harness 委派（2/2），以及外接 DSH 协议替身的四格式交付回归（4/4）。外接回归验证父对话续跑、重新登录后从历史找回交付、手动保存与重开读回；本次使用固定模型响应与协议替身。

原生 PDF 助手可用本轮图片附件插入新图片或替换已有图片。[Chromium 回归](../../apps/web/test/local-browser/pdf-media.test.mjs)在旧构建复现只接受 HTTP 链接的错误，在新构建验证旧引用失效（即使下一轮上传同名图片）、不触发远程媒体请求、保存前版本不变，以及显式保存后的插入和替换像素、历史原件与重开状态。

PDF 刷新恢复会跳过原模型已下线的任务；读取旧任务检查点失败后，也会检查剩余任务。候选必须通过原文档版本检查，且只续跑一个原对话。[助手组件回归](../../apps/web/test/shell/shared-editor-assistant.test.ts)复现了多个过期任务阻塞后续任务，并验证修复后无需等待新任务事件。[Chromium 回归](../../apps/web/test/local-browser/native-pdf-harness.test.mjs)用固定模型和隔离 PostgreSQL 验证刷新后不会重复派发、检查点回执丢失后仍可恢复，以及外接 Harness 和本机 Codex CLI 的结果均可用于修改 PDF 原文与已有批注，手动保存后重开可读回。

Word 和 PPTX 也修复了旧任务阻止后续续跑的情况。组件回归覆盖模型已下线、旧检查点失效和接回原对话；Word 还验证读取检查点期间文档变脏就会停止恢复。[XLSX 浏览器回归](../../apps/web/test/local-browser/native-sheets-harness.test.mjs)确认现有实现会跳过失效任务，在手动保存和重开后维持正确版本；人工编辑与恢复中的工具调用冲突时保留人工结果。

此前的隔离验收配置仍可用。用合成 PDF、当前构建和隔离 PostgreSQL 重跑 [PDF 真实模型和内置 Codex 用例](../../apps/web/test/local-browser/native-pdf-harness.test.mjs)，1/1 通过：模型委派计算，按交付改写原文和已有批注，手动保存后重开读回，历史版本字节不变。这证明真实模型和本机 Codex 的组合，生产进程隔离仍需单独验收。

同一候选的 [真实模型与官方 DSH 回归](../../apps/web/test/local-browser/assistant-dsh-delegation.test.mjs) 4/4 通过。四种格式分别核对模型委派、执行器提交报告、原对话自动续跑、历史交付写回、手动保存和重开读回。另外，[PPTX 真实模型和本机 Codex](../../apps/web/test/native-slides/analysis-live.test.mjs) 及 [XLSX 真实模型跨网格查找](../../apps/web/test/local-browser/sheets-find-cells.test.mjs) 各 1/1 通过。均使用合成文档和独立数据库；没有部署到 3081。

后续真实模型复验中，PDF 按位置翻转中间图片、与两侧手工草稿及表单一起保存通过；XLSX 读回文本预览已截断的附件原始字节，合并保存后重开能读到最后一行。两项 Chromium 各 1/1 通过。此前全量 Chromium 快照共 100 项（94 通过、3 失败、3 跳过）；三项失败是缺少 Tesseract、受保护 PDF 测试未切换到页面功能区和 PDF 附件工具预期过期，均已定向复测通过。全量快照不含后续变更，不能算作当前工作树全量绿灯。

PPTX 真实模型生成复测显示，延长网关时限后，两个页面的设计回合仍因达到 4096 token 上限，只返回推理和结束信号，未交付页面规格。Web 共享网关对 PPTX 无工具的请求采用 PC 单页生成使用的 16,384 token 上限，其他格式及带工具的对话仍用 4096。[隔离 PostgreSQL 网关回归](../../apps/web/test/local-integration/shared-provider.test.mjs) 12/12 通过，验证完整页面规格能返回，并核对普通请求的额度。修复后一次真实模型调用已返回完整页面规格，原生生成接口接受；同批第二页仍在生成时，旧浏览器用例的整轮等待结束。下轮复测继续解决单页设计被长推理占用时限的问题。

进一步复测确认，长推理占用单页生成的时间上限。共享网关沿用已有 OpenAI 兼容模型规则，仅对支持关闭推理的 PPTX 无工具请求选择直接输出；其他模型不发送该参数，带工具的 PPTX 对话、其他格式、Harness 模型调用不更改。Web 类型检查、请求/解析/时限单测 57/57、隔离 PostgreSQL 网关回归 12/12 通过。随后使用同一真实模型和 Chromium，固定模型与真实模型分支各 1/1 通过：真实模型生成指定标题的两页可编辑稿，单独重做第二页，两次手动保存后均可重开；第一页 XML 未被第二轮改变，两个历史版本字节保持原样。三次单页设计回合约 4–5 秒。

[Word 和 XLSX 真实模型与内置 Codex](../../apps/web/test/local-browser/native-word-sheets-codex.test.mjs) 2/2 通过。各自只委派一次，读取 Codex 实际生成的 `total.json`，随后将数值分别写入 Word 正文和 XLSX 的 H2。Chromium 核对写入仅暂存，显式保存后独立读回文件字节、刷新页面重开，且源版本不变。结合此前 PPTX 和 PDF 各 1/1，四种格式均有真实模型加本机内置 Codex 的写回证据；生产进程隔离未在这些用例中验收。

另一轮四格式 Chromium 运行混用了独立构建与测试默认目录的旧资源。两个工具清单用例报错后，用 `DYOFFICE_TEST_OFFICE_ASSETS` 显式指向独立构建复跑，2/2 通过，覆盖 Word/XLSX 创建格式、截断提示、CSV 下载，以及四格式工具开放与 Harness 委派。统一资源目录的全量回归另行运行，本次定向复跑不等同全量通过。

此前一轮真实模型复测确认 `generate_deck` 已被调用，但两个设计请求和各自的修复回合都在 120 秒被中断。PPTX 无工具的生成流现在在浏览器、共享网关和供应商传输层使用同一个 240 秒总上限；单页的 120 秒静默计时会同时响应正文和推理帧，推理内容不写入幻灯片。浏览器传输与隔离 PostgreSQL 网关回归均用模拟时钟验证超过原有两分钟上限仍可返回页面内容；真实模型整套生成和重做的通过结果见上文。

四格式共享对话从文件历史读到未完成的回复时，保留已经收到的正文并标注「未完成」。[PDF Chromium 回归](../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)确认被截断的回复已存为失败、重开显示部分正文和状态、未重新请求模型且未执行截断响应内的创建工具。下一条正常请求仍能创建独立的 PDF 和 DOCX。

跨格式 Chromium 用例统一读取 CI 的工作区和四个编辑器目录变量，避免使用仓库中遗留的渲染产物。用同一次构建的五个目录运行了 11 项用例，覆盖四格式工具清单、数据分析、外接委派、PDF 保存和 XLSX CSP；另隔离工作区首页请求后，DSH 主动打开 XLSX、PPTX、PDF 的交接用例 3/3 通过。后者验证原生写入、保存回执、后续提问及历史恢复。这是定向运行的合计，不能作为一次全量通过。

四格式共用的 Office 模型流到达服务端时限后，已发出的正文不被撤回，且只发送一次超时错误和结束事件。中文页面在服务端或浏览器达到时限时都提示重试、缩短请求或切换模型。现有时限保持不变，模型请求不会自动重发。[HTTP 流回归](../../apps/web/test/provider-stream.test.mjs)和[浏览器传输回归](../../apps/web/test/unit/ai-transport.test.mjs)覆盖部分正文、超时分类和请求次数。

PDF 助手可继续裁剪带原有裁剪路径的斜放图片，包括嵌套在 Form XObject 内的图片。[Poppler 像素回归](../../apps/web/test/pdf-image-bakes.test.mjs)检查保留区域仍在原位、裁掉的区域露出原背景、原有裁剪路径及上层矢量图形保持不变。[Chromium 回归](../../apps/web/test/local-browser/pdf-affine-image-drafts.test.mjs)在原生编辑器和兼容预览中调用 Office 工具，验证了画布预览、与第二项图片裁剪及正文插入一起手动保存、重新打开，以及历史原件字节不变。仿射翻转依然拒绝真实裁剪路径；特殊混合模式及透明度组保护仍保留。

混用资源的 Chromium 全量运行最终为 103 项（94 通过、4 失败、5 跳过）。两项工具清单用统一资源定向复验通过；PDF 已有图片草稿和登录会话管理两个用例分别遇到测试端口占用、PostgreSQL 数据盘空间不足，已用独立测试 PostgreSQL 串行复跑，2/2 通过。该轮因此仍不能作为统一构建下的全量通过证据。

主机重启后重新构建了工作区和四个原生编辑器。后台读取用例改为使用同一工作区构建，在 Chromium 和独立 PostgreSQL 18 上四格式均通过（4/4）；测试关闭全部浏览器上下文，再从授权频道读取已保存的版本。PDF 定向复测验证了独立创建 PDF/DOCX、历史中保留截断回复、刷新恢复 Harness 父任务，以及外接测试执行器和真实内置 Codex CLI 分别改写原文及批注、手动保存后重开。实际 Tesseract 的扫描页识别和可搜索文字层保存也已通过。重启中断的全量回归不计为通过，生产隔离仍需在正式运行环境验收。

同一候选的四格式外接交接与工具清单共 6/6 通过，覆盖委派、续接、历史恢复及 XLSX 图片保存。Web 客户端、服务端及工作区、XLSX、PPTX、PDF 的类型检查通过。

Word 默认通过写入租约保存完整 DOCX。多窗口逐步同步仍需显式设置 `DYOFFICE_WORD_COLLAB=experimental`；图片可能超过该实验接口的单步上限，因此同步暂不默认启用。Office 助手、Harness 交付及原生 DOCX 编辑仍走正常保存链路。已部署的 `DYOFFICE_SOURCES_EGRESS_TARGETS` 出站规则仍优先；移除环境配置前，管理员应在全局设置中录入等价规则。
