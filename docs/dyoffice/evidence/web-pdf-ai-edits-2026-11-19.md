# Web PDF 助手写回检查点

本检查点接通 Web PDF 的原文短文本改写/删除、高亮、下划线、删除线、便签、批注读取和删除。不是四格式全面对齐或 T11 全部验收。

原文编辑由服务端 PDF.js 定位，再复用 PC PDFium 内容流编辑、匹配校验及写后读回。批注复用 PC 标准注释保存逻辑，保留原文。签名、加密、AcroForm，以及当前定位器不支持的倾斜/复杂文本会拒绝修改。

Web 助手先调用 `/pdf/edit-text/uploads` 或 `/pdf/annotate/uploads` 准备字节，再用原始 `commitInput` 调用标准 `/commits`。租约、文件所有权、基准 revision 和输出摘要由现有保存链路检查。提交响应丢失时，当前页面保留原提交并提供“确认保存结果”，不重新生成字节或叠加批注；明确拒绝的提交清理准备结果并解除编辑锁。提交中或结果未知时禁止关闭标签，并提示浏览器离开风险。连续工具调用等待精确的新 revision 完成预览加载；取消信号贯穿客户端、HTTP 路由与处理子进程。

字节处理在可终止的子进程运行，设置 30 秒超时和 256 MiB V8 old-space 限制。它仍不是完整的文件系统/网络 OS 沙箱，也不提供 RSS/WASM 内存硬上限。回执保留范围是当前页面，刷新/关闭后的持久恢复未在本检查点完成。

批注删除使用 `delete_markup` / `delete_note`，先读取当前版本的批注 ID，再经 `/pdf/delete-annotations/uploads` 准备并提交。精确匹配 PDF.js 间接对象 ID（含非零 generation）；删除便签根节点会删除回复及关联弹出窗，拒绝将独立回复、链接或表单当作删除目标。真实 PostgreSQL 集成已验证准备阶段不发布、回执重放、正文保留和旧版本仍保留批注。

DOCX 创建已补齐正文填入与保存确认：Web 上传空白模板后，新标签页消费正文，原生保存及精确版本回执核验完成后才返回工具成功。XLSX 的 PDF 创建已接通同一 PDF 生成/上传链路；Web XLSX 只开放已接通的 XLSX、CSV、DOCX、PDF（CSV 为下载），不开放 Markdown/HTML。Word/XLSX 保留父页面传回的跨 realm 错误信息；Web XLSX 合并附件仅接受当前已接通的 `.xlsx`，其他格式在导入前明确拒绝，PC 能力不变。

同时修复 PDF 创建的列表/表格排版、跨页长表格和中文字形空白。字体空白源于锁定 fontkit 的 TrueType 子集未对齐奇数字节字形；适配器补齐字节，并验证 CFF 和普通复合字形不回归。Poppler 成品渲染已检查中英文、列表和表格。

验证入口：

- `node --import tsx --test apps/web/test/pdf-text-edit.test.mjs apps/web/test/pdf-annotation.test.mjs`：独立重开、原文替换/删除、CJK、批注、保护文档拒绝、取消与源字节保护。
- `node tools/run-web-unit.mjs assistant-client.test.mjs create-ai-pdf.test.mjs pdf-fontkit.test.mjs docs-bridge-save.test.mjs pdf-preview-skill.test.mjs pdf-mutations.test.mjs pdf-edit-routes.test.mjs pdf-edit-service.test.mjs`：工具透传、字体/布局、分阶段保存、断连、取消及未知结果确认。
- shell `document-preview.test.ts`：同一次 React act 内连续旋转、改写、批注，按新 revision 写回。
- disposable PostgreSQL `local-integration/pdf-text-edit.test.mjs`：跨用户/失效租约拒绝、准备阶段不发布、提交回执重放、旧 revision 保留及不重复批注。
- `npm run typecheck:web`、`npm run typecheck:web:shell`、`npx vite build --config apps/web/vite.local-shell.config.mjs` 与 `git diff --check`：本地账号实际使用的 shell 和服务边界验证。

新增验证：`pdf-annotation-delete.test.mjs` 覆盖批注精确删除、便签线程和独立进程；`ai-doc-creation.test.mjs`、`docs-bridge-save.test.mjs` 和 DOCS `created-document-boot.test.ts` 覆盖正文消费、原生保存及版本确认。组合 Web 工具/保存测试 63/63 通过，DOCX 编辑器及实际 local shell 构建通过。

DOCX 真实 Chromium + PostgreSQL 验证已保留在 `apps/web/test/native-docs/create-document.test.mjs`：扣住提交响应时创建仍等待，放行后正文保存且状态干净；模拟 409 时工具明确失败且原存储不含未保存正文；新页面重开后读到已成功生成的正文。这是原生编辑/存储验证，不包含真实模型推理。

新增便签回复/改写与页面操作已接通：`reply_note` / `edit_note` 按当前版本的精确批注 ID 操作，保留作者、位置和回复关系；页面操作支持旋转、删除、排序、插入空白页、调整纸张尺寸与裁剪。裁剪只修改 CropBox，不删除被隐藏内容，不等同脱敏。

主线独立复验：前端工具/保存单测 56/56、便签真实字节测试 7/7、独立 PostgreSQL PDF 集成 3/3 通过。第三个集成测试连续执行旋转、删页、排序、插空白页、调整尺寸和裁剪，并验证准备阶段不发布、提交回执重放、旧版本保持及批注保留。该组合曾发现空白页调整尺寸将缺省 Annots 规范化为空数组导致误报；现改为比较实际批注引用列表，原组合已通过。

共享 PDF 对话基础提示已移除硬编码“只读”，改为仅使用当前提供的工具与技能，编辑/保存必须有成功工具结果支撑；只读 source skill 仍保留不可编辑约束。主线独立复验共享对话与预览 React 测试 7/7、Web 类型检查和最新 local shell 构建通过。

页面提取 `extract_pages` 已接通新文件创建：复用 PC `extractPagesBytes`，独立进程准备新 PDF，再沿 import upload/finish 发布；源文件版本不变。客户端保留未知 finish 的 uploadId，仅恢复同一上传；打开失败保留已创建回执，避免重复提取。主线真实 PostgreSQL `local-integration/pdf-extract-pages.test.mjs` 先因接口缺失失败，后通过，覆盖越权/失效租约/旧版本拒绝、准备不发布、重复 finish、新文件页序/文字/旋转/批注、源字节保持与取消暂存后不可发布。独立前端工具与提取恢复单测 49/49、共享助手与预览组件测试 8/8 通过；初始 finish 或恢复请求的 401/403/404 均保留原上传待确认，避免提交后身份核验失败造成重复创建。真实 Chromium 页面提取恢复用例已通过：确定性上游发出工具调用，真实服务发布后丢弃 finish 响应，页面确认后仅恢复同一上传并打开成品；独立重读内容和源版本，未重复创建。这不是页面提取的真实模型推理验收。提取仅为页面复制，不承诺从底层引用图清除所有未选页面数据。

按页数拆分 `split_pdf` 已接通，使用 PC `splitPdfBytes` 生成至少两份新 PDF，限制总输出 64 MiB；准备失败清理全部已暂存输出，发布沿现有 finish 逐件完成，不承诺跨文件原子发布。客户端逐件保留 receipt/opened 状态，部分失败和取消准确显示已生成 X/Y，恢复不重复准备或打开已完成项。主线真实 PostgreSQL `local-integration/pdf-split.test.mjs` 验证 5 页拆成 2/2/1、部分 finish 重放、源字节保持，以及已发布上传 auth_version 不匹配返回 409、只有未发布过期上传返回 410。客户端因此保留 409 的恢复状态，仅 410 可跳过并以部分失败收尾。独立单测 64/64、共享助手与预览组件 11/11 通过。真实 Chromium 拆分恢复用例已通过：两页各拆一份、第一份 finish 响应丢失后确认原队列，最终只有两份新文件，各 upload 不重复准备，最后一个标签打开第二页内容，源字节保持。该浏览器用例使用确定性模型上游，不替代真实模型拆分任务验收。

网格拆页 `split_pages`（2/4/9 块）和同文件拼版 `merge_pages`（每张 2–16 页、方向与分隔线）已接入单输出 import/finish 和原回执恢复链。源文件保持；拆页按显示区域复制页面与批注，非脱敏；拼版嵌入页面内容，不复制交互批注。遵循现有 Web 文档上限，输出超过 100 页在生成前拒绝。主线 PostgreSQL `local-integration/pdf-page-layout.test.mjs` 验证非零裁剪原点、旋转、空白页、新文件发布重放及源字节保持；前端工具单测 69/69、共享助手与预览组件 13/13 通过。

接入时发现并修复共享 PC helper 的裁剪显示回归：原拼版嵌入完整 MediaBox，重新显示已裁剪隐藏的文字；原网格拆页使用超出 MediaBox 的原始 CropBox，也可能扩大可见区域。两者现共同使用 MediaBox/CropBox 的有效交集，无交集时按 PDF 查看器语义回退 MediaBox。PC 合并/网格拆页专项 13/13，通过新增先失败后通过的旋转/非零原点/越界裁剪测试；Web 字节专项 7/7。Poppler 渲染已人工检查，原裁剪区外红色文字在修复后的拼版和拆页中不再显示，旋转保留。底层引用数据可能仍存在，不承诺脱敏。临时渲染位于 `/tmp/dyoffice-pdf-layout-review/`。Web 类型检查及 local shell 构建通过；额外运行的完整 PC PDF 类型检查未通过，当前环境缺少 Electron、node-forge、vite-plugin-static-copy 等桌面依赖/导出，并伴随相关类型错误，不能宣称完整桌面构建已验收。

真实 Chromium + HTTP + 隔离 PostgreSQL 的提取、按页数拆分、网格拆页、拼版恢复组合 `local-browser/pdf-extraction.test.mjs` **4/4 通过**：确定性模型上游调用实际工具，首次 finish 成功后人为丢失响应，页面确认仅恢复原上传，检查最终标签、文件数量、独立成品文字和源版本。属于真实浏览器/保存链验证，不包含这四个工具的真实模型推理。

PDF 只读表单与敏感信息工具已接通：`list_form_fields` 在 PDF.js 文档销毁前复用 PC 表单目录生成快照，提供名称、类型、页码、当前值和选项；新保存版本加载前清空旧快照，加载失败不再返回旧字段。`find_sensitive_info` 复用 PC 六类确定性模式和首 60 条输出限制；仅查找，`mark:true` 明确拒绝，不宣称遮盖/脱敏或 OCR。

PDF `create_document` 已加入共享对话，支持 PDF 和运行能力允许的 DOCX，不开放 Markdown/HTML。生成字体/正文前绑定发起工作区的 session proof；创建器持有初始绑定，不因组件重绘切到另一账户。PDF 核验发布回执和精确 revision，DOCX 继续等待原生正文序列化保存并核验最终 revision。进入保存后任何未确认结果都会锁住当前创建器，阻止自动重复创建；尚不提供刷新后的持久创建恢复。

主线独立验证：新增创建/表单/敏感工具与既有导出单测 84/84；DocumentPreview 组件 10/10；Web shell 类型检查与构建通过。真实 Chromium/HTTP/PostgreSQL `local-browser/pdf-read-tools.test.mjs` 读取真实文本框、已勾选框、第二页下拉选项并把工具结果送回确定性模型上游，再查找邮箱、拒绝 mark:true、创建新 PDF，独立重开新文件验证正文、保存 ID/revision 与源字节不变。另重跑 `native-docs/create-document.test.mjs` 1/1，确认共享创建桥未破坏 Word 正文保存等待、409 拒绝和重开持久正文。上述浏览器验证使用确定性模型上游，不等于这些新工具的真实模型任务验收。

尚未覆盖全部 PC PDF 工具，如段落级重排、图片编辑、新建表单字段、复杂文字方向、跨文件替换、水印和页眉页脚。各格式真实模型与 Harness 的完整任务验收仍需继续。

PPTX 同轮补齐 AI 历史批次与真实回退：复用原生快照，结束批次更新撤销状态；修复普通 Undo 后编辑污染 AI 检查点的问题。QC 无法建立检查点时不执行自动修整，仅在实际恢复成功后报告回退；开始/结束批次响应未知时保留待收尾状态，下轮先处理。Slides QC/生命周期测试 26 项、native/bridge 47 项通过，主线独立复验 checkpoint/路由/bridge 5 项通过。真实 PostgreSQL 测试 `native-slides/service.test.mjs` 的 `AI checkpoint restoration after a real committed revision is dirty and preserves the saved head` 已通过：保存后恢复旧快照会重新标记未保存，已提交 head 与字节保持不变。Web Slides 类型检查与构建通过。

PPTX 原生会话专项使用显式 `NODE_ENV=test` 的测试进程执行器；未启用该模式会被 `PPTX_OS_ISOLATION_UNAVAILABLE` 拒绝。本轮验证不代表生产 OS 隔离部署已验收。所有改动仍在工作树，未提交，未重启生产服务。

## 真实模型与 Harness 复核及后续验收路径

2026-11-19 再次在独立 PostgreSQL `dyoffice-test-pg`（127.0.0.1:55433）运行既有真实验收；未使用 55432 业务库、3080 服务或现有业务文档。官方 DSH 0.2.2-rc.1 与原默认真实模型先分别通过固定合成文本探测。完整浏览器后台读取首轮在 DSH 配对阶段收到模型 HTTP 404，保留为失败；随后一次完整重跑 **1/1 通过**。这仅证明 DOCX 保存版后台读取，不证明四格式工具或真实双向委派。

成功任务 `1031745c-6295-4646-ae24-6bdccc206cad`，保存版本 `9dd3b284-5372-4f9c-973c-ed060549083f`；DSH 配对会话 `session-3bc2707a-2239-4dfa-a503-1316a709da40`、后台会话 `session-a0c0da80-7288-49ea-8be6-45e8ac6368c9`。日志 `/tmp/dyoffice-real-recheck-6pj0al1f/acceptance-retry.log` 权限 0600。该临时根目录为 0700，配置和复制的凭据文件为 0600；不可将其内容提交或输出。

后台读取现已将 DOCX/XLSX/PPTX/PDF 格式从授权文件元数据贯通 UI、服务、runner、隔离读取 worker 与模型请求。主线独立读取/回答测试 18/18 通过，覆盖四格式真实字节提取、截断提示、非法文件、大小限制与取消；按格式动态导入解析器，保留 10 MiB 输入、128 MiB V8 old-space 与 10 秒超时限制。这里只读取已保存版本，不提供后台编辑工具；四格式后台读取分别取得真实 DSH + 模型浏览器成功证据：首次 XLSX/PDF 通过；DOCX 因 DSH 误读 memberId、PPTX 因最终答复缺少任务标识失败。修正用户连接指引后，两者一次定向复验通过，前次失败保留。详见 [后台读取证据](assistant-background-2026-11-19.md)。这仅覆盖保存版本读取，不代表四格式原生编辑或所有 Harness 工作流。

复用入口为 `apps/web/test/local-browser/assistant-background-http.test.mjs`，私有 JSON 的字段及初始化要求见 `assistant-background-2026-11-19.md`。官方 DSH 二进制 `/tmp/dyoffice-dsh-validation/node_modules/@deepseek-ai/dsh/lib/bin.js`；原用户 profile `/home/junge/.dsh` 只读复制到独立目录，禁止直接改写。复跑命令中只传配置路径，不把秘密放入命令行：

```bash
DYOFFICE_REAL_DSH=on \
DYOFFICE_REAL_DSH_CONFIG=/private/path/acceptance.json \
node --import tsx --test apps/web/test/local-browser/assistant-background-http.test.mjs
```

另由私有启动器注入 `DYOFFICE_TEST_DATABASE_URL`，仅允许 55433 的 `dyoffice_test`；fixture 创建并清理随机数据库/受限账号。不要将私有连接值写进命令、日志或本文。

下一步可复用 `fileFixture`、`buildLocalApp`、独立 keyring 与共享模型配置，创建合成 DOCX/XLSX/PPTX/PDF，并让各格式原生 AgentLoop 使用真实共享模型 transport。每个任务须记录实际工具调用、工具失败、取消与版本收据，再独立重新读取成品字节；不能直接调用 bridge 后把结果算作模型验收。DOCX 可从 `native-docs/create-document.test.mjs` 的浏览器/保存/重开夹具扩展；XLSX/PPTX 可复用各自 native suite 与合成 acceptance 文件；PDF 可复用 `local-integration/pdf-text-edit.test.mjs` 的准备/提交/重开验证。PPTX 当前测试进程边界必须如实标为 experimental，不作为生产 OS sandbox 证据。

真实委派还须将 `local-integration/assistant-channel-native-parent.test.mjs` 的人工 transport 换成真实 Office 模型，并接官方 DSH 执行同一任务，核对父子任务、取消、恢复及保存结果。现有 `harness-data-flow.test.mjs` 使用真实 PostgreSQL/HTTP/独立子进程，但明确不含模型推理；本轮 11 项 harness 单测也使用测试执行器。两者均不能替代真实 Harness 验收。安装版内置 Codex 的离线 Python runtime 现已构建并安装，77 包离线校验、分析测试 6/6、真实 Codex CLI 3/3 与隔离 PostgreSQL external/builtin 数据闭环 2/2 通过（详见本文末尾）。这些测试使用确定性模型夹具，四格式真实上游模型到 Harness、原生插入保存的完整任务矩阵仍待验收；原生 XLSX host 先前 `--check` 的 root controller 与测试连接变量缺失记录仍保留，不能据此宣称生产 native sandbox 就绪。


## PDF 已有表单填写验收

Web `apply_ops` 已接入已有 AcroForm 字段的 `setFormValue`，覆盖文本、复选框、单选及选项字段。服务端从授权源版本推断字段类型，整批验证字段存在、只读、长度、选项和重复目标后再写入，通过 `/pdf/form-values/uploads` 暂存并沿现有版本提交。页面操作与表单填写混批仍拒绝；`dry_run` 仅验证当前字段快照，不代表文件保护及可写性验证。新建表单字段不在本次范围。

中文不仅保存字段值，还嵌入字体并显式重建真实外观。源文件或 PC 保存过程要求全局外观刷新时，同时重建未编辑字段和按钮外观，避免清除 `NeedAppearances` 后冻结旧字形。字体缺字明确拒绝。按钮和空签名栏保留，不允许作为填写目标；真实签名、XFA 和加密文档仍拒绝。

主线在最终后端修改后独立验证：

- `node --import tsx --test apps/web/test/pdf-form-values.test.mjs`：4/4，通过独立进程中文外观、无效整批拒绝、签名/XFA、未编辑中文旧外观和按钮保留回归。
- 隔离 PostgreSQL 的 `local-integration/pdf-form-values.test.mjs`：1/1，验证授权/租约、准备不发布、提交重放、字段值与外观、旧版本字节保持。
- 真实 Chromium 的 `local-browser/pdf-form-values.test.mjs`：1/1，确定性模型调用填写工具；服务端提交后丢失响应，点击确认恢复原提交。只暂存一次、提交请求两次，重读字段取得张三/勾选/Done，版本及旧字节独立核实。此项不等于真实模型推理验收。
- local shell 构建通过；`git diff --check` 通过。Poppler 渲染 `/tmp/dyoffice-pdf-form-review/filled.pdf`，已目视确认中文、勾选、单选及选项外观。

首次提交返回 401/403/404 等未知结果时，客户端保留原提交参数，恢复不重新暂存。整体四格式工具对齐仍未完成；本轮未提交、未部署、未重启生产服务。全量服务端类型检查另有 `sources/service.ts` 的 `SourceExecution` 字段错误，不能宣称全仓类型检查通过。


## XLSX 助手展开崩溃修复

用户报告 3080 XLSX 助手打不开，控制台为 React #310。组件回归 `test/shell/sheets-assistant-toggle.test.ts` 在原实现复现 `Rendered more hooks than during the previous render`，定位 `AiChatPanel.tsx` 的 `promptRef` 在关闭面板的提前返回之后。将该 Hook 移到无条件执行区，保持发送时最新草稿保护逻辑；展开、收起、隐藏侧栏及再展开回归通过。XLSX 类型检查、Vite 前端构建通过。随后重载本机 3080 服务以更新启动时缓存的资源清单，`/api/v1/health/ready` 返回 ready。此项不包含真实模型回复验收；日志中的 CSP eval 和 Univer 重复注册警告没有在此修复中宣称消除。


## PDF 文本插入验收

Web `insert_text` 已接 `/pdf/text-inserts/uploads`：保留 PC 的 page/text、anchor_text/placement、x/y、font_size、max_width、align、font、bold/italic、color 参数。服务端从授权版本读取 PDF.js 页面和文字，按实际嵌入字体测量换行与对齐，处理 CropBox、四种旋转及 UserUnit，再复用 PC 写入并验证新增文字。Web 每次直接保存新版本，不返回 PC 尚未保存的 T 编号；暂存文字块的编辑/移动/删除生命周期尚未对齐。交互表单、签名、加密及不支持的文字方向仍拒绝；AcroForm 填写使用独立路径。

主线独立验证：核心 `pdf-text-inserts.test.mjs` 7/7；工具和提交恢复单元测试 42/42；DocumentPreview 12/12。真实隔离 PostgreSQL `local-integration/pdf-text-inserts.test.mjs` 1/1，验证授权、租约、整批失败不发布、准备不发布、回执重放、中文/旋转页文字和旧字节保留。Chromium `local-browser/pdf-text-inserts.test.mjs` 1/1，提交成功后丢弃响应，确认恢复只暂存一次、两次提交同一内容；重新读取张三恰好一次。浏览器模型上游为确定性测试实现，不是真实推理验收。

Poppler 成品 `/tmp/dyoffice-pdf-insert-review/inserted.pdf` 两页已目视检查：姓名旁中文正常，旋转页新增蓝色文字方向、位置正常，旧文字保留。local shell 构建通过；最近一次 shell 类型检查被并行变更的 `local-main.tsx` 向 SourcesPanel 传递不存在的 resultsClient 属性阻挡，不能宣称该次全量类型检查通过。


## XLSX CSP 后续核验

Zod 对动态代码生成的能力探测会触发严格 script-src self 的 eval 违规，即使内部捕获异常且校验仍然有效。Web XLSX 入口最先导入 `zod-csp.ts` 并设置 jitless，保留 CSP、不依赖 node_modules 本地补丁。`local-browser/zod-csp.test.mjs` 先复现一次 eval 违规，再验证有效/无效数据判断不变且零违规；`local-browser/sheets-csp-entry.test.mjs` 对完整旧构建复现两次 eval 违规，对候选新构建零违规。后者以明确未授权界面确认入口模块执行完毕，不宣称打开真实工作簿或真实模型对话验收。XLSX 类型检查及独立目录构建通过，验证后复制候选资源并重载 3080。

`UI_PLUGIN_SHEETS_MENU_ITEM_INPUT_COMPONENT already exists` 源自已有 `installMenuInputEnter` 有意二次注册，为菜单数字输入框提供 Enter 执行；上游发出 warning 后正常替换 Map 中组件，不是 throw。保留这项功能，不修改私有注册表或屏蔽 console。


## PDF 段落原文改写验收

Web `edit_block` 接入 `/pdf/block-edits/uploads` 和 stageBlockEdits，支持唯一 paragraph_text 定位、整段 new_text 改写/空字符串删除、字体/字号/颜色/粗斜体/对齐。授权原版本经 PC groupPageBlocks 定位，再用原文对象实际字体与保留对象 advances 测量换行；测量与写入共用原字体解析。复用 native textEdits 删除/改写真实对象，未使用白块覆盖。重复短词按原对象范围测量，避免凭文本搜索误判。删除后验在原目标矩形中验证原段落不再可匹配，其他段落的相同文字可保留。

主线验证：工具单测21/21、DocumentPreview组件15/15、最终 block 核心7/7；隔离 PostgreSQL及真实Chromium两项测试在最后测量修复后复验2/2。整段改写移除源两行、保留独立页脚，再删除改写段落；各历史版本字节保持。浏览器模拟提交成功后丢失响应，恢复仅重放原提交，重读中文新文并确认原段落消失。上游为确定性模型，不是推理模型验收。Poppler `/tmp/dyoffice-pdf-block-review/rewritten.pdf` 已目视核对换行、蓝色保持与页脚。候选 shell `/tmp/dyoffice-block-shell-build` 构建通过，shell类型检查通过。

本项未发布候选shell或重载3080。原文基线倾斜/竖排、交互表单、加密/签名等沿现有编辑限制拒绝；原文编辑仍不是完整PC能力闭环。PC未保存段落/文字块生命周期、图片工具、水印/页眉页脚、真正擦除、跨文件页面替换等仍待推进。


## PDF 原段落移动验收

Web `move_text_block` 接入 `/pdf/block-moves/uploads` 和 stageBlockMoves，按唯一 paragraph_text 定位原段落，显示空间 dx 向右/dy 向下转换为含 CropBox、Rotate、UserUnit 的原文坐标。复用 native translate 移动原对象，字体、颜色、字距不重绘；保持 PC 的自由位移，不自动裁定碰撞或夹紧到页内，工具提示选择空闲区域。保存前后 native 后验对比全部叶对象的文字/字体/字号/渲染模式/填充/描边、图片原始数据摘要以及有效矩阵/边界，只有目标允许对应位移。

主线独立验证：move核心5/5（含四方向、UserUnit、非零CropBox、双层缩放Form内目标与未涉图像/路径）、工具/提交恢复44/44、DocumentPreview16/16。隔离 PostgreSQL与Chromium两项2/2：授权/租约/失效整批、stage不发布、commit重放、原版本字节、正常及90度页面实际viewport位移；浏览器丢失提交响应后恢复，仅执行一次位移且保存后仍可读取原文。模型上游为确定性夹具，不代表真实模型任务验收。Poppler `/tmp/dyoffice-pdf-move-review/moved.pdf` 两页目视核对字体、蓝色、页脚和绿色矩形。

候选shell `/tmp/dyoffice-move-shell-build` 与shell类型检查通过。第一次构建和类型检查因并行创建中的NativeSettingsPager文件缺失失败；文件到位后复验通过，没有修改该组件。本项未发布候选资源、未重载3080；整个PC工具对齐仍有未实现/未验收项。


## PDF 图片读取、变换、旋转与删除验收

Web 接通 `list_page_images`、`transform_image`、`rotate_image`、`delete_image`。查询指定授权 revision，无需编辑租约，返回显示坐标和每页编号；最多1000个图像，超限拒绝而不截断。客户端按读取时revision及page/image_number绑定目标，写入后使列表失效，拒绝旧编号及晚到查询。写入仍经租约、暂存、版本提交，按源版本定位全部目标；移动缩放保持PC比例与页面fit/clamp，旋转关于中心，删除移除原对象。

桌面像素codec按需动态加载，纯枚举/变换/删除不导入Electron。保存后逐叶对象对比像素raw/decoded摘要、矩阵、边界、文字字体颜色及绘制顺序，验证目标变化、邻对象保持和实际删除。插入、替换、像素处理尚未完成。

主线独立验证：图像及原段落移动核心11/11、前端工具及版本缓存25/25、DocumentPreview17/17、shell类型检查及候选shell构建通过。隔离PostgreSQL `local-integration/pdf-image-edits.test.mjs` 1/1：指定版本授权/租约、暂存不发布、回执重放，连续变换→旋转→删除，验证新几何/层级、未选图像/文本、历史字节与旧版图片目录保持。真实Chromium `local-browser/pdf-image-edits.test.mjs` 1/1：先列图再变换，提交完成后丢弃响应，恢复原提交；只暂存一次/提交两次，重列准确返回x80/y60/120×60，源版本保持。首轮浏览器断言漏解析网关output包装层失败，定位实际结果正确后修正测试再通过；未修改产品输出绕过问题。使用确定性模型上游，不是实际模型推理验收。

Poppler `/tmp/dyoffice-pdf-image-review/rotated.pdf` 已目视确认非对称四色图旋转及位置、另一张图和文字说明保持。候选shell `/tmp/dyoffice-image-shell-build` 未发布到3080，本轮未提交或重启。整体四格式PC能力对齐与真实模型/Harness任务验收继续进行。


## PDF 图片插入与替换验收

Web 增加 `insert_image`、`replace_image`，沿用 PC 的 URL、文字锚点/四方向 placement、显示坐标 x/y、width 和文字层级。HTTPS 图片经已有鉴权媒体接口下载；PNG/JPEG data URL 直接转为图片数据，不把网络或凭据传入独立处理进程。下载开始前绑定源版本，完成后复核版本与待保存状态；替换要求当前版本已经读取图片编号，成功或开始修改后使旧列表失效。新 `/pdf/image-content/uploads` 每次仅接一张图片，保留旧几何编辑接口的 65 KiB/批量限制。PNG/JPEG 运行时解码不依赖 Electron；压缩图最多5 MiB、边长8192、像素缓冲32 MiB，分配前检查。

透明度探测确认 native GetBitmap 不包含 SMask；保存后验证改用一次性副本标准化目标矩阵并通过 GetRenderedBitmap 读取真实 straight BGRA，包括半透明像素。插入遵循PC自然尺寸、半页宽默认限制、页面内fit/clamp、锚点8pt间距及默认below_text；替换保留有效矩阵、边界、绘制顺序并对比新像素，逐叶校验其他对象。

主线验证：图片缓存/工具/提交恢复/媒体单测54/54、DocumentPreview组件18/18、shell类型检查及候选构建通过。隔离PostgreSQL `local-integration/pdf-image-content.test.mjs` 1/1：暂存不发布、提交回放、授权及租约拒绝、旧字节保持，新增3×2半透明图，再用不同像素和尺寸的2×1图片替换；独立native读回逐字节校验BGRA，邻图与几何目录保持。真实Chromium `local-browser/pdf-image-content.test.mjs` 1/1：聊天插入→列表→替换→重列，替换提交成功后丢失响应，确认原提交，仅暂存一次/提交两次；独立读回新图片1×2像素，原文字及历史版本保持。模型上游为确定性夹具，不是真实推理模型验收；浏览器使用PNG data URL，HTTPS下载单测/组件有覆盖，但此项未做真实外网图片下载验收。

Poppler `/tmp/dyoffice-pdf-image-content-review/inserted.pdf` 与 `replaced.pdf` 已分别渲染并目视核验：半透明颜色正确混合蓝色背景，透明像素显示背景，替换拉伸保留原位置与大小，另一图及白色说明文字保持。候选shell `/tmp/dyoffice-image-content-shell-build` 未发布到3080，本轮未提交、未重启。

本次仅接PNG/JPEG，WebP明确拒绝；生成图片完整格式闭环、翻转/透明度/裁剪/去背景、水印/页眉页脚、真实擦除、跨文件页面替换及四格式真实模型/Harness任务验收仍待继续，不代表全面PC对齐完成。

最终后端补齐后主线另行跑过图片内容/已有图片/段落移动核心21/21及PDF路由2/2；内容核心含>1 MiB噪声PNG经独立进程、运行中取消、嵌套Form中的不同尺寸替换、四类JPEG和受保护文档拒写。JPEG带ICC样例有PDF.js缺wasmUrl提示，当前保存解码RGB，未保证精确ICC色彩管理；常规PNG/JPEG像素路径验证通过。后端子任务报告native相关98/98及server类型检查通过，主线未将此报告扩称整个桌面构建通过。


## XLSX 大型合并附件与正文截断隔离

`web-attachments.ts` 对文本抽取截断的 XLSX 保留原 File 与 metadata，供合并使用；`read_attachment` 明确返回失败与 truncated 提示，说明无法提供完整正文，而不把已抽取片段描述成全文。此例外仅适用 XLSX，其他格式截断、解析失败、空文件及50 MiB限额继续拒绝。这里不增加Markdown/HTML创建或编辑能力。

主线独立复验：附件/HTTP路由6/6；Web XLSX merge bridge 1/1，接真实附件存储核对上传同一File与原字节SHA-256、same-origin与CSRF；Sheets files-skill 1/1，以实际Vitest入口验证模型工具得到明确isError及截断原因。误用Node test直接跑Vitest文件曾报测试运行器错误，改用Sheets原有Vitest入口后通过，未为此修改产品代码。以上没有证明超过100万字符的真实工作簿整份引擎合并已验收，也不等于真实模型任务验收。类型检查由子任务通过，未部署或重启。


## XLSX 已有透视表定义读取与刷新

Web bridge 接通 readPivotDefinition，经鉴权且绑定原始revision的服务接口核对 native.inspect 中 pivot path/cachePath 现有配对，再经隔离 gateway_package 调用PC parsePivotDefinition/schema。拒绝任意包内path、缺失pivot/cache及其他用户读取。Node fallback 同时补真实pivotTables/pivotRanges枚举，避免定义服务存在但原有表格永远不会触发加载。

主线在最终实现后独立运行 `test/native-sheets/pivot-definition.test.mjs`：4/4，通过Rust和Node两种experimental subprocess实际fixture；模型工具执行器propose_operations refresh_pivot及真实pivot动作重算250/50/300，真实HTTP planner/保存/新revision重开复核。画布使用轻量facade，未跑真实模型/Harness；测试不代表生产OS隔离。Node既有透视表样式band元数据仍未完全等价，不将此项扩称整体UI对齐。其他用户/admin读取404与非法或缺失部件400反例通过；源会话仍固定旧revision。子任务另报告相邻gateway13项及Web/worker/Sheets类型检查通过；原先root-only测试夹具两项HOST_BACKEND_UNAVAILABLE不得标成通过。未部署或重启。

大型合并缺口后续已补真实验收：主线独立跑 `test/native-sheets/truncated-merge.test.mjs` 1/1。40行各约29900字符的真实工作簿，经PG鉴权HTTP解析返回100万字符/truncated，最后marker不在正文片段中；原File保留且字节SHA相等。真实merge skill及mergeAttachedWorkbooks读入40格，画布命令facade之外使用实际Node subprocess、隔离gateway、HTTP保存，新revision重开第40行完整字符串与尾marker相等。未登录解析请求401。此结果补足前述“真实大型工作簿合并未验收”，仍不是模型推理或生产隔离验收。


## PDF 图片像素处理与资源隔离验收

Web 新增 flip_image、set_image_opacity、crop_image、remove_image_background，通过 image-bakes/uploads 暂存单项操作，再沿租约、原 revision、幂等提交与未知收据恢复链路保存。透明度乘以当前已保存 alpha（连续0.5会成为0.25）；裁剪按真实像素边界取整，无像素变化明确拒绝。复用PC纯像素处理，不依赖Electron。

保存以实际Do出现位置克隆共享Image/Form资源，仅替换选中图像像素或增加局部矩阵Form包装，保留原绘制顺序、clip、透明度、blend和marked content。裸图像源保留自身SMask，避免把出现位置透明度重复烘焙。修复合法资源名#转义二次解码；内容数组按PDFium空格边界拼接，避免换行结束原注释并把隐藏图片错误变成第一个编辑目标。资源回归10/10，含注释中的假图片、真实ordinal保存以及资源名和Do跨流。

主线独立复验：前端像素工具/图片缓存/保存恢复加provider egress共101/101；PPTX并行改动后的shell和server类型检查通过。隔离PostgreSQL及真实Chromium的图片插入替换与像素操作共4/4，浏览器使用确定性模型上游，验证提交成功但响应丢失后仅暂存一次、恢复原提交，独立回读真实像素和历史版本。Poppler渲染flipped/cropped/faded/cutout四个成品，已目视核对蓝色底图、裁剪位置、半透明混合、白背景去除及未涉文字/邻图保持。预览图位于/tmp/dyoffice-pdf-image-bakes-review/contact.png。

普通axis变换支持nested Form的quarterturn/mirror，保留原图形状态。page-level任意旋转/shear采用3px/displaypt栅格化；含ancestor Form、显式clip、非Normal blend、marked content或Group时保守拒绝任意仿射fallback，避免忽略隐式Form BBox剪裁。inline BI、非单Flate内容过滤器、DecodeParms或超深度/大小/像素上限明确拒绝；像素边长8192、单缓冲32MiB，源/输出64MiB，内容累计解压32MiB。尚非全部PC PDF能力闭环。

## PPTX 分析交付目标与原生表格验收

演示编辑器注册PPTX分析交付目标，捕获文稿identity、当前页、selection、generation和尺寸；应用前与异步授权后复核目标。文本以原生textbox、二维字面值以原生table写入，不解释HTML/公式；表格不超过原生每维75，保守容量估算放不下时明确拒绝且不截断。分析交付触发保存保护，timer/blur自动保存暂停，需显式保存后才返回真实commit收据；未知收据确认前不承诺已保存。

主线独立跑native-slides bridge/entry/host-save 48/48，通过授权变化、未知收据仅重放原提交、目标注册/清理等反例。55433隔离PostgreSQL原生table/text专项1/1：真实isolated worker应用后未发布，显式commit后ZIP内含a:tbl，字面<script>和=SUM保持文字。子任务另报告Slides五文件111/111、panel17/17和类型检查/Slides构建通过；此报告不等于真实Harness委派及浏览器父子任务验收。候选shell /tmp/dyoffice-alignment-final-shell-build 构建通过（既有大包警告），未发布、未提交、未重启3080。


最终主线补充复验：图片像素/插入替换/资源隔离核心25/25（任意旋转/shear独立页面渲染，包含0.4透明度），Slides原生分析插入与保存序列13/13。JPEG带ICC仍有缺wasmUrl提示，沿前述色彩限制。server类型检查发现共享树egress地址回调implicit-any，以unknown显式标注后通过；未改变地址验证行为。候选最终shell构建成功，保留既有大包警告。

最终候选shell /tmp/dyoffice-alignment-final-shell-build 再跑图片内容/像素两个真实Chromium用例2/2通过，包括丢失提交响应后的恢复。仍为确定性模型，不扩称真实模型或正式Harness端到端验收。


## Word 个人收藏知识库接入

Web DOCX bridge提供PC知识库的kbList/kbSearch/kbRead及openSourcePath，复用助手登录绑定请求与CSRF。模型的read_knowledge_file/search_knowledge_base同时进入DOCX格式白名单和实际Word入口nativeToolNames；不扩大其他格式白名单、不增加Markdown/HTML创建或编辑。个人收藏目录经RLS和files:read授权，未收藏、回收站、purge及其他用户文件不进入目录。路径只是/files/{fileId}/revisions/{revision}/{encodedName}版本引用，不是服务器文件系统路径。

搜索POST携带本轮目录的paths快照，逐项验证收藏/权限后只搜索对应已保存版本；不会并发保存后悄悄改读新head。读取按PC的24000字符分页，保留请求offset，正文解析前后复核收藏权限；返回匹配正文的snippet，不以文件名命中冒充正文。前端刷新失败/关闭撤销已知引用及晚到响应，搜索拒绝目录外路径。引用读取绑定该版本，点击在复核权限后通过同源父工作区打开该文件当前head，沿PC打开文件语义；不把引用点击说成历史版本编辑器。

主线独立PG回归knowledge.test.mjs 5/5：真实DOCX跨页/末尾读取，提交新版本后旧路径仍读旧正文；其他用户和admin的跨用户读取404；无登录401、搜索缺CSRF403、非法路径/负offset拒绝；取消收藏、删除以及读对象期间取消收藏均拒绝。真实保存DOCX/XLSX/PPTX/PDF均可搜读。超XML预算文档由既有上传校验413拒绝，不绕过校验写测试数据。

独立审阅抓到完整性反例：合法小体积XLSX中32.6MiB的sheet XML注释使extractor的maxChars按XML前缀截断，只返回19字符且没有truncated标志，原实现会漏掉最后一行。新增实际PG回归先失败，改为完整解析后检查正文预算，再跑5/5通过；末行FINAL-KNOWLEDGE-MARKER既能读取也能检索。单文件沿PC50MiB上限，解析正文超过400万字符明确413；目录超过10000项明确413，搜索不返回伪造完整正文或静默部分结果。解析复用file-parse和既有上传ZIP限制，路由共享两槽object-I/O admission；未宣称具备生产OS级解析隔离。

主线前端工具/桥32/32，原Word保存/下载/桥及KB回归36/36通过，shell和server类型检查通过。之后真实浏览器发现第三层nativeToolNames遗漏导致工具虽在skill和server白名单却没发给模型；实际入口捕获参数的新增回归先失败，显式加入两个工具后通过，保留其他工具过滤。新Word候选/tmp/dyoffice-word-kb-inventory-RVuJU7构建及Docs类型检查通过，未覆盖运行资源、未部署或重启。实际模型与正式Harness任务验收仍待继续。


最终主线真实Chromium `local-browser/word-knowledge.test.mjs` 1/1：从正常Web工作区登录并打开原生Word，以确定性模型连续发起search_knowledge_base→read_knowledge_file，检查模型请求真实提供两工具、工具结果含保存文件中的唯一marker，生成精确filenav引用，点击后实际打开来源Word并读到原文；来源和工作文档的历史字节均保持。模型上游是确定性夹具，不是真实推理模型验收。最终入口/桥/保存回归37/37；前述36项之后新增nativeToolNames漏项回归。shell/server/Docs类型检查及Word候选构建通过。本轮未提交、部署或重启。

正文预算补充专项1/1：合法上传的XLSX单元格含400万以上真实字符，保存成功且已收藏，但知识库read/search都明确413，未把前缀作为完整文件或空搜索结果返回；这项验证服务的正文预算，而非仅依赖上传前拒绝。


## PDF 助手管理的水印与页眉页脚（组合编辑验收进行中）

新增 set_watermark / set_header_footer，工具沿实际 DocumentPreview 助手清单进入模型请求，单项配置经 /pdf/stamps/uploads 暂存、租约和 revision 校验后提交。水印继承未提供的样式；页眉页脚支持六位置、页码与占位符。修改/移除只管理本功能写入的 Form 与内容流，私有元数据记录引用及哈希；源水印与批注保留。空文字移除没有受管理记录时明确拒绝，不报告假成功。

主线独立验证：PDF 工具及保存恢复52/52、DocumentPreview20/20、shell类型检查通过。真实55433 PostgreSQL专项1/1验证四种Rotate、非零CropBox、UserUnit2，新增→替换→页眉页码→移除，暂存不发布、重复commit回放、权限/租约反例及历史原字节保持。真实Chromium单项闭环1/1，以确定性模型调用五次工具并故意丢失首次commit响应：总计暂存5次/提交6次，确认原提交而不重复准备。Poppler渲染四种旋转已目视核验，产物/tmp/dyoffice-pdf-stamps-review/contact.png。独立候选shell /tmp/dyoffice-pdf-stamps-shell-candidate构建通过；修复四个入口对不存在ai-dock-theme.css的无效导入。未部署、提交或重启。

后端核心另有原末尾CTM/clip隔离像素比较，并对不能安全解释的inline image、特殊过滤器及不平衡状态保守拒绝。水印和页眉页脚单项闭环不代表全部完成：主线与只读检查均复现本产品insert_text经PDFium合并内容流后仍留下旧metadata，随后移除水印报PDF_STAMP_INTEGRITY_FAILED；正在修复并扩大真实浏览器回归。此问题属于本产品工具组合，不以“外部编辑器改坏元数据”解释。页面重排/增删及其他编辑组合亦须继续验收；真实推理模型/Harness不在上述确定性测试结论内。


组合编辑后续修复：结构操作前验证并剥离助手管理的覆盖层，在完成原文结构修改及独立几何/内容核验后，按保存配置重建覆盖层，重新计算页码与总页数。不会把旧stamp嵌进拼版页后丢失管理能力；新空白页也继承配置。原文/图片工具在消费原生对象编号之后复原PDFium合并流中的独立受管Form调用，保留原绘制位置，恢复引用记录。

主线独立结构/提取/拆分/版式39/39通过，其中新增组合10项覆盖resize、crop、rotate、delete、reorder、blank、extract、split files、merge layout与split layout。七项结构用例在修复前均失败；修复后核对实际保存PDF的当前页码/总数、正文和后续替换/删除。扩大的真实Chromium测试1/1通过，共14次聊天工具调用：原五项单项链之后添加水印→插入正文→移除水印，随后添加水印/页码→插空白页→删原页→移除水印/页码；独立读取每次新revision正文，末尾只保留空白页。水印配置暂存11次，总提交15次（包含首个未知回执的原commit重放），未重复准备。仍使用确定性模型上游，不计真实推理模型验收。


最终PG印章版本专项1/1、server类型检查与全工作树diff-check通过。原生组合独立像素验收覆盖四种Rotate/CropBox/UserUnit的wm+HF→PDFium正文插入：保留native leaf顺序/几何、Poppler全图像素不变，随后替换/删除仍保留新增文字；图片组合与重复原生保存也有回归。本轮仍未更新3080资源、未提交或重启，候选构建路径沿前述目录。


主线最后独立stamps/native/resources/routes 19/19通过（原生font识别有提示，像素/内容断言通过）。额外检查抓到表单误接默认拒绝AcroForm的preserve hook，先见真实form-values 3项失败；移除不适用的hook后重新运行4/4通过，保留原有表单支持。水印工具自身仍拒绝AcroForm文档，不因此放宽保护检查。后端子任务另报告文本/图片/批注相邻回归通过。


## PDF 跨文件替换页面

新增replace_pages，沿PC语义：目标页按原始1-based页码去重排序，删除选中页，在首个被删除位置连续插入用户选定源PDF的全部页面。实际助手入口提供工具，但先等待可见文件选择卡；用户选择本地PDF并点击“确认替换并保存”后才申请租约和上传原始Blob。取消/Abort不修改文件，未选择文件不暂存。前端不把附件抽取正文当源PDF，也不接模型提供的任意本地路径。

后端application/octet-stream源文件与严格query绑定target revision/editor/lease/pages。两份PDF通过长度前缀binary frame进入killable处理进程，各64MiB，输出64MiB/100页；验证双SHA，复用原暂存/commit回执链。目标助手印章先验证剥离再按配置重建并重算页码；源文件可见印章作为原文保留，仅脱离助手管理，确认卡已披露。源文件本身不创建工作区副本、不被修改。保护文档、表单、越界页及无效frame明确拒绝。

主线前端工具/保存恢复54/54，DocumentPreview21/21，shell类型检查与独立候选构建/tmp/dyoffice-pdf-replace-shell-candidate通过。真实55433 PostgreSQL专项1/1：不连续目标[3,1]替换为两页源，commit前head不变、重复回执幂等；最终Source1/Source2/Target2/Target4顺序与MediaBox/CropBox/Rotate逐页相符。目标水印和1/4..4/4页码可移除，源水印仍存在两次；其他用户、失效租约和旧revision拒绝，旧字节保持。真实Chromium1/1：首次取消无上传/提交；第二次选择实际File并确认，commit响应丢失后只上传一次/提交两次，独立native读取顺序与正文、刷新实际PDF显示Source1。确定性模型上游，不扩称真实推理模型或Harness验收。未提交、部署或重启。


## PDF 用户审查后的永久涂黑副本

find_sensitive_info mark:true现在通过revision绑定的隔离原生字符定位查询排队候选，AI不提供apply入口、不直接永久擦除。用户在实际PDF页面看到比例正确的半透明标记，逐项勾选/取消，先点击生成副本，再确认永久涂黑并另存。候选阶段不上传、不提交、不改源文件；期间阻止原文/页面编辑和其他副本操作，避免错用旧坐标。复制请求只提交patterns和稳定candidate IDs，后端按源SHA+revision重算定位，拒绝失效ID。500项以上truncated明确披露并禁复制；旋转文字、跨行或无法安全定位区域披露unsupportedPages，扫描图未执行OCR，不承诺全面脱敏。

后端以PC原生字框定位，page Rotate/CropBox/UserUnit转换显示坐标；正文区域使用PDF用户坐标。确认后只以files.stageUpload生成新fileId，复用现有finish/回执确认/打开链路；源文件不走revision提交。PC applySaveRequest执行清理，native redaction为最后一次序列化，随后仅只读重开、native字符区域和独立PDF.js出现次数校验。保留PC对shared image、含图片Form、Widget和受保护文档的拒绝规则，原managed stamp元数据在清理前脱管理，防按旧配置恢复已删秘密；确认卡披露副本印章成为普通内容。

主线独立前端工具与保存恢复81/81、DocumentPreview和viewer32/32通过；候选shell /tmp/dyoffice-pdf-redaction-shell-candidate构建及shell类型检查通过。55433真实PG专项1/1：四Rotate、CropBox偏移、UserUnit2，候选8处仅选4处chosen邮箱；输出chosen全部删除、keep邮箱/PUBLIC各保留4份，几何保持。其他用户/admin读拒绝、过期候选及租约拒绝；新file暂存不发布，finish回放同一receipt，源revision/字节不变。

真实Chromium1/1：聊天mark两处→页面overlay两框→取消keep邮箱仅一框→两次用户确认→新copy发布后响应丢失→确认原upload并打开同一新fileId；只准备一次、finish两次，工作区仅增加一文件。独立native读取和实际新PDF预览均确认所选chosen邮箱不可见/不可提取，keep/PUBLIC保持，源历史字节和head保持。Poppler已渲染并目视核验四旋转黑块位置及保留文字，产物/tmp/dyoffice-pdf-redactions-review/contact.png。这些浏览器用例使用确定性模型上游，不代表真实模型或Harness验收。

后端子任务报告原生redaction/core保护测试通过；PC工作流套件因工作区缺少Electron模块无法加载，未将其计为通过。本轮未提交、部署或重启。


## 最终预览竞态修复与 Node 透视表样式对齐

只读复核发现查询晚返回时可与替换文件卡同时出现，已在敏感候选查询完成后再次复核replacementPending；组件回归控制延迟查询→打开替换卡→放行查询，确认仅保留替换卡且旧候选明确失败。另旋转重绘缺少取消可能在保存新revision后追加旧页面，现预览统一AbortController，切换渲染/保存回执/卸载均取消旧任务，并在挂载前后复核signal；延迟旧旋转渲染的回归确认保存后旧signal已取消，放行旧任务不会覆盖新画面。组件/viewer最终33/33、shell类型检查、候选/tmp/dyoffice-alignment-reviewed-shell构建通过；此最终候选的替换页+涂黑真实Chromium2/2再次通过。

XLSX Node fallback此前只返回pivot定位与cache引用，缺styled/bands使真实renderer跳过整块透视表样式。本次只扩Node元数据：主题完整slots及sysClr缓存、全部84种PivotStyle内建调色、行列条纹开关、显式rowGrandTotals=false、分组/子分组/数据/小计/总计/空行s/S/d/t/g/b分类；复用既有HSL tint函数，保持原renderer/bridge协议。未知custom style沿PC fallback，不捏造自定义配色。

主线独立native-sheets/pivot-style-metadata.test.mjs 1/1：正常主题+自定义dk1/accent共680种真实pivot组合，Node/Rust逐字段相等；真实Gateway/isolated runtime保存后两个引擎各自重开仍相等，测试fixture含实际pivotParts/relationships/content types且输出区域不重叠。前述最终fixture冻结后已再跑一次。另真实55433 PG原pivot定义/refresh保存重开4/4通过，包含跨用户拒绝和新revision结果250/50/300。真实推理模型与生产OS隔离仍待验收，未将sidecar一致性等同浏览器视觉或全模型闭环。未提交、部署或重启。


## 离线分析 runtime 与内外 Harness 数据链路复验

2026-11-19，`npm run build:analysis-runtime` 成功构建 Linux x86_64 / Python 3.12.3 的 77 个锁定 wheel、manifest、bundled uv 与 `harness-data.mjs`；`npm run install:analysis-runtime && npm run test:analysis-runtime` 完成离线安装及 `uv pip check`，pytest **6/6 通过**（20.21 秒，132 条既有 statsmodels/Pandas 弃用警告）。本地运行目录 `.dyoffice-analysis-build/runtime/bin/python` 已可用；构建产物受 `.gitignore` 忽略，不作为发布包验收。

设置 `DYOFFICE_TEST_CODEX_CLI=1` 与 `DYOFFICE_TEST_ANALYSIS_PYTHON` 指向该离线解释器，运行 `node --import tsx --test apps/web/test/unit/coding-cli.test.mjs`，真实 Codex CLI 0.170.0 的 **3/3 通过，零 skip**（37.13 秒）：Office 模型桥执行代码且无独立 Codex 登录（10.87 秒）、只读 venv 下 pandas/DuckDB/SciPy/Parquet/PNG 分析（15.16 秒）、禁网任务 mailbox（10.87 秒）。CLI 与权限沙箱实际执行，模型端为确定性工具调用夹具，不含真实上游推理。

隔离 PostgreSQL `dyoffice-test-pg`（127.0.0.1:55433）首轮 builtin 数据链路在执行 Harness 前失败：测试仍调用已删除的 `sources.publish`，报 `TypeError: sources.publish is not a function`。核对当前 `create/save` 契约后，仅删除 fixture 中旧发布调用；`create` 已直接写当前配置 version 1，未改产品行为。定向 builtin 复跑 **1/1 通过**（21.30 秒）。随后完整运行 `node --import tsx --test apps/web/test/local-integration/harness-data-flow.test.mjs`，external **1/1**（5.55 秒）、builtin **1/1**（18.27 秒），合计 **2/2，零 skip**（25.41 秒）。连接值由私有启动器注入环境，不写入命令、日志或本文；未使用 55432 业务库。

两分支均验证真实 PG/RLS、HTTP、独立子进程、冻结快照仅查询一次、合计 60 CNY、报告/图表/代码三份产物暂存及持久提交；重启客户端在输入过期后恢复原收据、不重复查询或提交，跨用户、同用户其他任务及撤销任务拒绝访问。external 是确定性 Node 客户端，builtin 是真实 Codex + 离线 Python + 禁网 mailbox，图表分别为 SVG 和真实 PNG。本次没有读取真实 provider token，不将这些结果等同四格式真实模型委派、原生编辑保存或生产发布隔离验收；未提交、部署或重启服务。


主线独立复跑 `npm run test:analysis-runtime`，77 包兼容校验及 pytest **6/6 通过**（5.81 秒，132 条第三方弃用警告）。相邻 `harness-receipt-recovery`、`assistant-channel-data`（2 项）、`analysis-delivery-presentation`、`harness-data-access` 四个 fixture 文件的五项测试也先全部复现同一旧 `sources.publish` TypeError，删除过期 fixture 调用后 **5/5 通过**；仅修正测试与当前直接生效配置契约，不涉及产品行为变更。


## PDF 待保存文字 T 块与批量保存

Web 实际助手入口的 insert_text 现在创建待保存 T 块，提供 PC 同名 list_inserted_text / edit_inserted_text / move_inserted_text / delete_inserted_text；工具结果明确未保存，不能以生成草稿冒充生成 revision。页面显示可选择/拖动的覆盖层，支持文字、字号、颜色、对齐、坐标编辑、删除、撤销和放弃。点击“保存新版本”才将当前最多20个块经既有 text-inserts uploads/commit 一次写入。待保存期间阻止会失效坐标的其他原文/页面写入、副本创建和关闭；未知提交回执期间保留草稿，确认原提交成功后才清空 T IDs 和撤销历史。

新增 POST /files/:id/pdf/text-inserts/query，只读授权 revision，复用同一隔离进程内的实际字体测量、anchor、换行、CropBox/UserUnit/Rotate 和 clamp。返回显示坐标、块尺寸及每行宽度，不申请租约、不上传、不改源文件。已有直接写入接口和原生保存 planner 的输出协议保持；未提供 drafts callback 的独立 skill 消费者仍可使用原立即保存契约，实际 DocumentPreview 采用待保存流程。

只读复核复现了单块预览/整批保存的真实字体分组差异：16pt 的“WWWW iiiii Hello”在 max_width=130 时独立预览两行，加入中文块后同批字体回退使其变一行。现所有增删改移均重算整批，保持 T ID 和各块的 top-left 锚点；删除采用可取消异步查询，失败不修改草稿和历史，撤销恢复整批快照。真实 planner+controller+native 保存回归 1/1 验证插入中文→英文从两行变一行、删除中文→恢复两行、撤销→恢复同批一行，实际 PDFium 保存后的文字行和矩阵坐标与预览一致。

主线验证：工具/状态管理及相邻涂黑/替换单元测试38/38，组件/viewer33/33；真实55433 PG查询权限与只读测试、query布局及既有保存合计9/9。后端子任务 query/save/stamps/routes 12/12，主线 shell/server 类型检查通过。新增组件用例先复现插入立即保存，再确认本地编辑/删除/撤销期间无上传、关闭被挡、其他正文改写拒绝，保存一批仅一次上传/一次提交。

最终候选 /tmp/dyoffice-pdf-text-drafts-final-shell 构建通过（既有大chunk提示）。真实 Chromium 待保存专项1/1：实际聊天插入→修改→移动→删除→用户撤销→真实 pointer capture 拖动20/15显示点；第二页旋转90度并插入中文，第一块同步重排为一行。期间源head/旧bytes不变；5次布局查询，两个块只暂存一次；故意丢失commit响应后草稿保留，确认原提交（总commit2次）后清空并重开。独立native重读两页文字与拖动后的matrix原点90/110，历史原字节保持；再次list返回空，刷新后显示保存正文且没有旧T块。第一次混排用例误以SVG各行textContent间含空格，改为逐行核对两行→一行后通过，未改产品来迁就断言。

同一最终候选上的水印组合、跨文件替换和用户审查涂黑三项真实浏览器回归通过；水印用例已按新增文字需用户保存的语义更新，保存后仍能移除受管理水印并保留新增正文。页面截图 /tmp/dyoffice-pdf-text-drafts-review/pending.png 与输出 saved.pdf，经 Poppler 渲染两页并目视核验。确定性模型上游，未计为真实推理模型验收；未提交、部署或重启。PC 未保存图片块和复杂嵌套仿射保护仍列剩余项。


## PDF 新增图片 I 草稿与文字合并保存

实际 PDF 助手的 insert_image 现在先解析有界 PNG/JPEG 字节，创建未保存的 I 草稿；list_page_images 仍只返回源文件已保存图片，不把本地草稿伪装成已保存对象。页面支持拖动、独立宽高缩放、旋转、翻转、绝对不透明度、裁剪、去背景、替换、删除、撤销和放弃。像素操作复用 PC 算法，裁剪保留剩余像素的显示位置，四分之一旋转保持中心；连续设置 50%→80% 按原透明度基准计算，不叠乘。已有嵌入图片的编辑/替换仍沿既有保存链，不将这次新增图片草稿扩称为所有图片生命周期对齐。

新增只读 image-inserts/query 核对原生几何，draft-inserts/query 在隔离进程生成实际混合 PDF 并以 PDFium 渲染涉及页面，浏览器以原生栅格展示真实图层，SVG 仅处理选框与交互。明确限制图片字节、解码尺寸、批次数量及页面像素预算。图片和文字由 draft-inserts/uploads 合并为一个暂存/提交，新回执生效后一起清空；源 revision 变化、取消和并发处理不能覆盖当前草稿。

本轮主线独立验证：状态/工具/保存恢复及原生混合生成 **82/82**，会话/CSRF/断连取消路由 **2/2**，组件/viewer **34/34**，真实 55433 PostgreSQL 混合保存专项 **1/1**，shell/server 类型检查与 diff-check 通过。原生测试覆盖四种 Rotate、CropBox、UserUnit、独立宽高、文字与原图保留、受管理印章组合及 Poppler 像素比较；PG 验证查询不申请租约、不上传、不修改 head，混合保存一次提交且历史原字节保持。

候选 /tmp/dyoffice-pdf-image-drafts-reviewed-shell 上的文字草稿、水印、跨文件替换、用户审查涂黑四项真实浏览器回归 **4/4**。组件回归还覆盖读取替换图片期间禁保存；交互层修复取消缩放后选择框未复原及鼠标选中后 Delete 未聚焦的问题。新增图片专项的完整浏览器像素与回执恢复验收另记下文；本段不据此提前宣布全部完成。未提交、部署或重启。


完整图片浏览器专项进一步抓到真实故障：rotate/crop 成功，但 flip/opacity/cutout 后的 PNG alpha 始终255，不能把 finally 触发的重新预览视为像素操作成功。根因是原生 ImageData 的 width/height 为原型 getter，三个分支的对象展开未复制尺寸。新增同形原型 getter 回归先失败 undefined !== 2；三个结果改为显式 width/height 后，该套 **12/12** 通过，shell 类型检查与候选 /tmp/dyoffice-pdf-image-drafts-pixels-fixed-shell 构建通过。浏览器用例加强为逐步核对实际 PNG 翻转和 alpha，再检查最终 native 像素，不只等待预览请求。


最终 pixels-fixed-shell 的新增图片真实 Chromium 专项 **1/1，零 skip**（77.52秒，进程81.03秒）通过。测试先确认 list_page_images 仅含原图，再混合插入第二页文字；真实拖动、缩放、pointercancel、键盘聚焦删除、撤销、旋转、翻转、连续透明度、裁剪、去背景、延迟 FileReader 替换及撤销均执行。逐步 PNG 字节确认镜像变化、50% alpha128、80% alpha204、裁剪后3×8、去背景含0/204；原文件 head/旧字节保持且未申请租约。测试素材保留裁剪后的白色边缘，避免 PC 边缘聚类将触边红蓝识别为背景；未改变 PC 算法。

最终13次混合页面预览、一次暂存，第一次提交成功但响应故意丢失，保留锁定草稿直到确认原提交（共两次commit请求），随后清空并刷新重开。独立 native 读取确认最终显示几何135/40/75/200、图片3×8、透明像素0及保留像素204、红蓝主色、原绿色图片与两页原文/新增正文。主线另独立读取最终 PDF 的实际 SMask 流，值确为 **[0,204]**；Poppler 两页渲染和 pending 页面截图已目视核验。

完整日志 /tmp/dyoffice-pdf-image-drafts-review/browser-test.log，待保存截图 pending.png、重开截图 saved.png、成品 saved.pdf、逐步像素及提交计数 geometry.json。同前仍是确定性模型上游，不等同真实推理模型/Harness验收。本轮关闭新增图片待保存生命周期；已有嵌入图片待保存生命周期、复杂嵌套仿射仍保留为剩余项。候选资源未部署，未提交或重启3080服务。


## PDF 已有嵌入图片的待保存编辑

按 PC 每张原图片每次保存前只能接受一项编辑的规则，实际 Web 助手的 transform_image、rotate_image、delete_image、flip_image、set_image_opacity、crop_image、remove_image_background、replace_image 统一创建待保存编辑。原 revision 图片列表仍保留原编号与原几何，pending 标记已被占用的目标；同目标重复编辑拒绝。页面提供待保存编辑清单、撤销和放弃，与已有 T 文字/I 图片在点击“保存新版本”后统一暂存/提交。纯旧消费者仍保留立即保存契约，实际 DocumentPreview 已切换为草稿入口；提示词、工具说明及成功结果均明确未保存，不虚报 revision。

扩展 draft-inserts 的可选 imageEdits，旧 texts/images 请求保持兼容。至多20项已有图片编辑，每目标唯一，替换与插入图片共用20MiB压缩字节限制。原生只读预览先根据源 revision 的 page/image_number 绑定原图片，再在每次内部编辑前按原矩形唯一重定位当前编号，防删除或移动导致排序改变后改错图片；重叠歧义拒绝，不猜测目标。内部复用已验证的几何、像素、替换原生 job，全部完成后再处理 T/I，仅最终输出申请一次暂存；删除页也参与实际栅格预览，受管理印章保持可维护。

主线独立工具/控制器 **42/42**、组件/viewer **34/34**、原生/路由 **10/10**；shell/server类型检查与候选 /tmp/dyoffice-pdf-saved-image-drafts-final-shell 构建通过。组件回归另外控制延迟原生查询，确认期间保存按钮禁用、并发新增文字拒绝，放行后可继续；撤销后恢复原预览，保存前无lease/upload，统一提交后原列表失效。真实55433 PG两个分支 **2/2**：delete-sort 与 replace-crop，验证原编号匹配、真实像素、T/I组合一次stage/commit、历史原字节保持，以及跨用户/admin404、失效租约409、重复目标400、旧revision409。

首候选的已有移动、裁剪、替换及新增多图混合专项真实 Chromium **4/4，零skip**（总118.58秒），三项原有用例迁移为用户保存并保留原像素和丢回执恢复断言。混合专项覆盖四个原目标delete/move/opacity/replace、pending列表、重复拒绝、撤销/放弃、旋转第二页新增T/I；14次查询、一次暂存、第一次commit故意丢响应后确认原提交（总两次commit请求），原文和正确图片位置/像素保持。主线已读取完整日志与receipts.json、目视pending截图及Poppler两页成品。最终候选上的原新增I/文字T专项另 **2/2** 通过，包含实际像素与同一提交恢复；确定性模型上游，仍不计真实模型或Harness验收。


最终候选新混合专项 **1/1，零skip**（82.22秒，进程85.78秒）通过，日志 final-browser-test.log；增加保存后再次 list_page_images，确认新revision图片列表不再含pending。首轮追加断言在 onSaved 清空面板后、原预览刷新完成前过早发送读取，得到“PDF尚未就绪”；仅修正测试为等待明确“PDF保存结果已确认”、loading与文档spin结束，未放宽产品保存期间的读写保护。最终 pending.png/saved.png/saved.pdf/receipts.json 已更新，主线重新读取完整终端输出、Poppler渲染并核验。关闭已有图片待保存生命周期差距；复杂仿射、真实模型/Harness四格式闭环及发布/生产隔离仍未宣告完成。未提交、部署或重启。


## PDF 普通嵌套 Form 的复杂仿射翻转与裁剪

复现：原生图层能提供嵌套图片的有效旋转/倾斜矩阵，且 PDFium 无实际 clip，但裸图源的 rasterSafe 因 ancestors.size===0 一律拒绝，导致普通模板内的30°图片无法使用已有显示边界栅格翻转/裁剪。扩展原任意旋转像素比较用例先得到 PDF_IMAGE_BAKE_UNSUPPORTED_TRANSFORM；最小修复只去掉无条件祖先拒绝，保留继承的 Group、非Normal混合、marked content 以及调用端实际发生的 clip 检查。未改变保存协议或桌面处理器。

原生/资源/混合草稿回归 **21/21**：任意旋转用例扩展到0/1/2层Form、页面0/90/180/270°、shear0/20°、opacity1/.4，分别比较水平/垂直翻转、裁剪保存后独立渲染像素，并核对所有相邻图片/文字/绘图的顺序、矩阵和几何。真正越出Form BBox的图片、单独显式clip（无特殊blend）、Group和Multiply仍拒绝。保留原透明度与软掩码，避免重复烘焙。

真实55433 PG：原有delete-sort、replace-crop **2/2**；新增nested-affine单独 **1/1**，实际经过独立原生查询预览、T文字与倾斜半透明嵌套图片裁剪组合、一次stage、幂等commit、数据库最新revision重开及原历史字节保持。首版新增测试误用连续25%边界，改为按现有3px/pt栅格的整数像素取整后检查几何；未放宽产品验证。shell/server类型检查、git diff --check通过。本次未新增真实浏览器仿射专项，不计真实模型/Harness验收；实际裁剪/特殊混合/Group的保守限制仍保留。未提交、部署或重启。

### PPTX 原生尺寸与保存下载专项复核

本轮发现并修复两处实际路径缺口：Ribbon 的“幻灯片大小”调用 `slidesApi.setSlideSize`，Web bridge 原先直接返回空结果，而后端已有原生尺寸操作。现接入同一受租约与版本代数保护的 `setSlideSize` 操作，采用后端尺寸与重绘后的全部幻灯片。真实浏览器随后复现另一个错误：HTTP commit 已成功、bridge 已清洁，但 React 尚未重绘，编辑器 `isDirty()` 仍读到旧值，导致“保存并下载”误报失败且没有下载。Slides App 现让 dirty setter 同步维护 dirty ref，下载与关闭检查立即看到保存后的状态，同时保留 bridge 与 renderer 双重检查。

定向证据（候选工作树，未提交/部署/重启）：

- `node --import tsx --test apps/web/test/native-slides/entry.test.mjs apps/web/test/native-slides/bridge.test.mjs`：44/44。新增 Ribbon 尺寸映射、尺寸采用、脏状态通知和无租约不派发回归；entry 部分仍是 renderer seam 替身，不能算真实浏览器验收。
- `python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/native-slides/save-service.test.mjs`：5/5。使用独立 `55433/dyoffice_test` 派生测试库与真实原生子进程，尺寸操作导出→PostgreSQL 新 revision 提交→关闭原会话→全新会话重开仍为 4:3；旧 revision 字节不变。已有 Harness 分析写回的文字与原生表格用例同轮通过，校验实际 PPTX XML 中的表格和转义文字，不表示调用过真实 Harness。
- `python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/native-slides/size-roundtrip.test.mjs`：1/1，独立 HTTPS 4252。实际 Chromium 加载完整 Slides renderer，经 Design→Slide Size→Standard (4:3)→“保存并下载”，下载 bytes 与数据库已确认新 revision 逐字节一致，XML 尺寸正确；刷新重开仍为 4:3，pageerror 为零。修复前该用例分别证明空桥与保存后下载误判，未用网络替身替代文件提交。
- `npm test --prefix apps/slides -- tests/save-serialization.test.ts tests/apply-ops-tool.test.ts tests/analysis-insert.test.ts`：23/23。
- `npm run build:slides --prefix apps/web`：通过，同时按现有 closeBundle 构建 `dist-local-shell`；`npx tsc --noEmit -p apps/web/tsconfig.shell.json` 与 `git diff --check` 通过。完整 Desktop `npm run typecheck --prefix apps/slides` 未通过：环境缺失 Electron 类型/导出，另有现有测试类型错误；不以 Web 构建代替 Desktop 全量类型检查。

范围与未闭环项：本轮只改 Slides App 脏状态同步、Web slides bridge 尺寸方法及对应 PPTX 测试。未改共享助手、其他格式与模型工具定义。未配置 `DYOFFICE_LIVE_ASSISTANT_TEST_CONFIG`，因此未读取生产 token，也没有声称真实模型或真实 Harness 执行完成。PPTX 子进程使用 `unsafeTestOnly:true`，覆盖真实原生引擎而非生产 OS 隔离认证。排查还见 `setLink`、动画设置等 Web bridge 空实现，尚未本轮修复，故不能宣称 PPTX 与 PC 全面对齐。

### XLSX 透视刷新依赖预检与附件保存专项复核

本轮发现并复现：`proposeOperations` 原先放行尚未加载的 pivot definition；直接 UI `refreshPivotTables` 也在逐个刷新时才检查依赖，第二个透视表定义缺失时已开始读取第一个透视表。混合单元格编辑/刷新或多个透视表可能先发生部分修改，再报依赖错误。现 AI 计划在应用前拒绝缺失定义和源工作表；直接刷新在读取/写入第一个透视表前，整批检查定义、unsupported 和源工作表。该修复针对已知依赖就绪风险，不声称所有聚合/计算异常具备事务原子性。

本轮产品更改仅 `apps/sheets/src/renderer/plan-operations.ts` 与 `pivot-actions.ts`；新增 `apps/sheets/tests/plan-pivot-readiness.test.ts`。新增断言先复现 AI 计划误放行，以及直接刷新先访问第一 pivot 的失败，再确认修复。Sheets 专属浏览器测试更新旧模型下拉选择器为当前模型按钮、展开按钮和指令文本框，新增可选 `DYOFFICE_TEST_SHEETS_PORT`，未改共享助手或其工具定义。

最终验证：

- `cd apps/sheets && npx vitest run --config vitest.config.ts tests/plan-pivot-readiness.test.ts tests/plan-operations-formula-guard.test.ts tests/pivot-engine.test.ts tests/merge-skill.test.ts tests/merge-workbooks.test.ts tests/workbook-skill-tools.test.ts`：6 文件 **126/126**。覆盖未加载定义、源表缺失、unsupported 的整批拒绝和有效定义正向计划，以及相邻公式、合并和工作簿工具回归。
- `python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/native-sheets/pivot-definition.test.mjs apps/web/test/native-sheets/truncated-merge.test.mjs`：独立 **55433/dyoffice_test**，真实 Rust/Node 原生子进程、HTTP bridge、planner 与存档 **5/5**。授权绑定不可变版本读取定义，拒绝其他所有者及任意 part；刷新后保存重开数值为 **250/50/300**、cache `refreshOnLoad="1"`，旧 session 保持旧版本。超过文本提取上限的大 XLSX 附件按原始字节合并，最后一行 marker `FINAL-ROW-40-COMPLETE-ORIGINAL-XLSX` 保存重开保留。聚合执行使用 canvas facade，不能称为完整浏览器验收。
- `DYOFFICE_TEST_SHEETS_PORT=4253 python3 /tmp/dyoffice-test-db-run.py node --import tsx --test --test-name-pattern='XLSX assistant browser flow with recorded synthetic workbook data' apps/web/test/native-sheets/save-download-roundtrip.test.mjs`：真实 Chromium/HTTPS **4253**，**1/1**。完整 Sheets renderer 加载录制工作簿数据，个人 Skill 选择与确定性上游回复成功、其他用户 Skill 不泄漏、预算完成结算、原文件字节不变。早期失败为旧测试选择器不匹配当前 UI，已修正测试后通过；没有用产品改动绕过断言。
- `cd apps/web && npx vite build --config vite.sheets.config.ts`：最新候选通过，保留既有 Zod annotation/大 chunk 提示；本轮限定文件 `git diff --check` 通过。

未通过与边界：真实浏览器 `dirty download submits the latest editor snapshot and downloads those exact native bytes` 在原生 sandbox 启动阶段报 **HOST_BACKEND_UNAVAILABLE**（`host-process.ts:31`），尚未进入编辑器，未用 replay 替代并声称保存链通过。没有 `DYOFFICE_LIVE_ASSISTANT_TEST_CONFIG`，未读取生产 token；浏览器助手验证使用录制 synthetic 单元格及确定性网络上游，不计真实模型或真实 Harness 验收。以上真实存档测试通过不代替这两个缺口，也不表示所有 Web/PC 工具已全面对齐。未提交、部署或重启。

### Word 附件入口、写入权限与正文持久化专项

实际装配比对：Web DOCX 复用 PC 的 Docs skill、ProseMirror 执行器、长文 writer、样式/图表/批注/修订等工具，同时装配 Web 附件和固定 revision 的收藏知识库通道。Web 不装配桌面的 `run_cli`，以服务端提供的 source/coding skill 协作；这不是桌面 CLI 在浏览器执行的验收。当前目标保留 DOCX/XLSX/PPTX/PDF，不将 Markdown/HTML 当作缺口。

本轮确认并最小修复两个行为问题：

- Web 已提供完整附件解析与读取 bridge，但 Word 面板仅因存在 Web transport 就去掉拖放事件。回归先失败 `drag.defaultPrevented=false`；改为按 `addAttachmentPaths` 能力启用后，真实 File 可拖入、解析，并由 `read_attachment` 读到全文。
- 只读保护只覆盖五个基础正文工具，实际对只读 Editor 执行 `insert_chart` 仍成功插入。统一 Word 当前文件 mutation 集合供工具展示与执行门禁复用；图片/水印异步解码后再次检查编辑权，另有回归先证明解码期间失去权限仍可插图。保留“仅允许批注”的显式权限：App 将实时 `reviewCtxRef.current.canComment` 交给批注工具；`host.readOnly` 会使 `writeLocked=true`、`isProtected=true`、`commentsAllowed=false`，批注权限同步关闭。正反向回归覆盖只读正文下允许批注，以及权限关闭后的陈旧批注调用被拒绝且不改 store。

定向验证：

- 在 `apps/docs` 下运行 `npx vitest run --config vitest.config.ts tests/ai-read-only-tools.test.ts tests/ai-doc-writer.test.ts tests/ai-chart-tools.test.ts tests/ai-comment-tools.test.ts tests/ai-revision-tools.test.ts tests/ai-style-floating-tools.test.ts tests/ai-page-setup.test.ts tests/ai-web-drop-attachments.test.ts tests/ai-generate-image.test.ts tests/web-bridge-save-state.test.ts tests/ai-create-document.test.ts tests/created-document-boot.test.ts`：**115/115，12 files**。
- `npm run typecheck:web:docs`、`npm run build:web:docs` 与对应文件 `git diff --check` 通过。构建只作为生成浏览器验收资源的前置，不代替正文验收。
- `python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/native-docs/analysis-delivery.test.mjs apps/web/test/native-docs/create-document.test.mjs`：**2/2，零 skip**；真实 Chromium 覆盖附件拖放→后端解析→bridge 读取、确定性分析产物插入 Word 正文→显式保存新 revision→读取实际 DOCX XML→刷新重开；另测真实 shell 创建 DOCX 在正文保存回执前保持 pending，失败保存不能确认成功，重开读取持久化正文。分析用例同步更新为当前 Model chip 和助手页签导航，未用强制 click 绕开隐藏面板；固定监听 `4251`。
- `python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/local-integration/knowledge.test.mjs`：**6/6**，包括四类 Office 原文件解析、全文分页、固定 revision 检索、星标撤销与超限拒绝。仅使用隔离 `55433/dyoffice_test` 派生库。
- `python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/native-docs/assistant-live.test.mjs`：**1 skipped**，未提供 `DYOFFICE_LIVE_ASSISTANT_TEST_CONFIG`，未读取生产 token。

范围：本轮改动限 Word renderer、Word 专属测试及此证据追加。浏览器分析模型上游与 Harness 产物为明确的 synthetic fixture，不等同真实推理模型或真实 Harness 的四格式闭环；未逐一验证所有 PC Word 工具的全部参数/保护组合，不能据此宣称全面对齐。未提交、部署或重启服务。

### XLSX root host 启动阻塞复核与重开断言增强

续查确认 `HOST_BACKEND_UNAVAILABLE` 由测试启动身份引起：`native-sandbox.mjs` 固定调用 `createHostProcess`，后者在 `host-process.ts:31` 要求控制器为 root 且非 production；当前 uid=1000。宿主 PID1 为 systemd、`systemctl is-system-running` 为 running，因此不能把阻塞归因于缺少 systemd。`sudo -n true` 返回需要密码；现有 `dyoffice*` systemd unit/unit-file 均为零，常见 `/run/dyoffice*` 与 libexec 无可复用接口。历史 p0 证据仅记载用户曾授权 local helper，无路径或协议，当前无法恢复其调用。未查找/读取密码，未改 root guard、未替换成 replay/subprocess，也未重启服务。

`dirty download submits...` 专项已增加：历史 revision 原字节不变、以真实 sandbox worker 再读实际下载 A2=21.25/B2=42.5、浏览器刷新后新 renderer 读取相同值。原有下载 bytes 与已提交新 revision 逐字节一致、公式/图表/自定义 XML 保留断言继续保留。`node --check` 与限定 `git diff --check` 通过。以 4253 和 55433 wrapper 重跑仍在创建 host 时失败（1 failed，0 pass），新增重开断言尚未运行，不计为验收成功。

具备已授权 root 执行入口后，从仓库根目录运行以下精确命令；它仅通过现有 wrapper 读取隔离测试 PG 配置，不在命令行输出凭据，不切换原生后端：

```sh
sudo env DYOFFICE_TEST_SHEETS_PORT=4253 \
  PLAYWRIGHT_BROWSERS_PATH=/home/junge/.cache/ms-playwright \
  /usr/bin/python3 /tmp/dyoffice-test-db-run.py \
  /home/junge/.nvm/versions/node/v24.18.0/bin/node --import tsx --test \
  --test-name-pattern='dirty download submits' \
  apps/web/test/native-sheets/save-download-roundtrip.test.mjs
```

此命令尚未以 root 成功执行；用户如需授权，应使用自己的终端/既有受控入口，不向助手发送密码。该环境阻塞与产品 XLSX 保存正确性分开记录，不能据此断言保存产品已修复或已验收。


### Word 独立元数据编辑的未保存状态复核

继续只读排查确认一个非模型配置差距：Web 保存状态只接受 ProseMirror `onUpdate` 的编辑通知，而 AI 页眉/页脚、页面设置、样式、水印等写入使用独立元数据 store。实际 Chromium 在空闲文档只改 Page Color 后，红色页面已经生效、原 revision 未改变，保存状态仍为 `Editing` / `data-dirty=false`；新增回归先在此断言稳定失败。App 现在复用原有 `isDocDirty`，在 clean→dirty 边沿通知 Web host，保持正文每次更新的原通知路径，不逐个修改元数据工具。

本轮只新增 App 7 行与 Word roundtrip 25 行回归。`tests/web-bridge-save-state.test.ts`、`tests/ai-doc-writer.test.ts`、`tests/ai-read-only-tools.test.ts` 共 **31/31**；`npm run typecheck:web:docs`、`npm run build:web:docs`、限定文件 `git diff --check` 通过。

最终构建后的真实 Chromium roundtrip 前四项通过：正文编辑提交/刷新、延迟保存中的并发正文、其他 tab 接管后的只读与保留草稿、提交丢回执恢复。随后根盘耗尽使剩余三个 fixture 报 PG `53100` / `ENOSPC`，这次整套进程结果为 4 pass / 3 fail，未当作产品验收成功。Root 清理本任务可再生临时依赖并恢复隔离测试 PG 后，仅重跑未完成三项：

```sh
python3 /tmp/dyoffice-test-db-run.py node --import tsx --test \
  --test-name-pattern='actual server entry|page-color edits|standalone Word metadata' \
  apps/web/test/native-docs/roundtrip.test.mjs
```

结果 **3/3，零 skip**。新增用例确认独立元数据编辑立即显示 `Unsaved` / dirty=true、保存前 head 不变、显式保存后恢复 clean、独立读取实际 DOCX XML 含正确背景色、刷新重开仍为红色且 clean；既有保存中修改元数据并在第二次保存保留该变更的回归同轮通过。前四项加恢复后三项覆盖全部七个 roundtrip 场景，但不是单次七项全绿的进程。使用 `55433/dyoffice_test` 派生测试库，未访问业务 55432；该路径无模型调用，不计真实模型/Harness验收。未提交、部署或重启产品服务。

### XLSX 普通 CSV 导出桥接修复（2026-11-20）

续审查发现与透视无关的明确差距：PC `menuActionRef('export-csv')` 调用 `handleExportCsvImpl`，renderer 已等待公式并序列化当前工作表显示值，但 Web `bridge.api.exportCsv` 仍为 unavailable。AI `create_document(type:'csv')` 走另一条已接通的下载路径，不能据此声称普通导出已接通。

最小修复位于 XLSX 专属 `web-ai-document-api.ts` 包装与 `sheets-entry.tsx` 装配：`exportCsv` 验证既有请求 schema、拒绝桌面 targetPath，经本地化确认框说明格式丢失、公式转计算值及多表仅当前表，取消直接返回 canceled；确认后复用现有 `downloadWebCsv`，按 PC 普通导出语义加 UTF-8 BOM，返回实际安全文件名，下载失败继续抛错。AI 创建 CSV 的原下载语义保留。未改共享助手、其他格式或生产 root guard。

红→绿证据：磁盘满时先在 `/dev/shm` 以 `TSX_DISABLE_CACHE=1` 运行测试，原2项通过、新2项因 base exportCsv unavailable 失败；空间恢复后先恢复被失败写入截断的原测试文件，再落新增断言。最终 `node --import tsx --test apps/web/test/unit/web-ai-document-api.test.mjs` **5/5**；覆盖确认消息、取消无下载、拒绝桌面路径、安全文件名、UTF-8字节与失败传播。`cd apps/sheets && npx vitest run --config vitest.config.ts tests/csv-export.test.ts tests/export-formula-settle.test.ts tests/ai-create-document.test.ts` **64/64**；`npx tsc --noEmit --incremental false -p apps/web/tsconfig.sheets.json`、最新 `vite.sheets.config.ts` 构建、限定文件 diff-check 与浏览器测试语法检查通过。

真实 Chromium/HTTPS **4253**：

```sh
DYOFFICE_TEST_SHEETS_PORT=4253 python3 /tmp/dyoffice-test-db-run.py \
  node --import tsx --test --test-name-pattern='XLSX browser CSV bridge' \
  apps/web/test/native-sheets/save-download-roundtrip.test.mjs
```

**1/1**：使用录制 synthetic reader 打开完整 Sheets renderer，实时编辑 A2=21.25、公式 B2=42.5；从浏览器中实际 `desktopApi.exportCsv` 启动系统 confirm，验证格式/公式/当前表警告，取消无 download；继续后实际下载 `工作表.csv`，逐字节等于 `BOM + 项目,金额\r\n21.25,42.5\r\n`，源 XLSX revision/head/原字节不变。该专项验证实际 bridge、原生浏览器确认框和 Blob 下载，不声称由 PC 菜单点击触发，也不替代原生 XLSX 保存重开、真实模型或 Harness 验收。完整原生浏览器保存仍保留前述 root 接口缺失阻塞。未提交、部署或重启。


### PDF 复杂仿射的实际聊天工具浏览器验收

新增 `local-browser/pdf-affine-image-drafts.test.mjs`，使用当前候选真实 Chromium、55433 PostgreSQL 与确定性工具上游，实际聊天调用 list_page_images→flip_image→用户撤销→重新读取列表→crop_image→insert_text→用户保存→刷新重开。一层Form内30°旋转、20°倾斜、0.4透明度图片，翻转/裁剪查询与预览均成功；统一保存一次stage/commit，保存前head不变，保存后裁剪几何与3px/pt整数像素边界一致、原文字保持、新文字存在、旧revision bytes不变，pageerror为零。最终 **1/1、零skip**，37.93秒（进程41.59秒）。成品与截图：`/tmp/dyoffice-pdf-affine-drafts-review/{pending.png,saved.png,saved.pdf,geometry.json}`；Poppler独立渲染saved-page.png已目视核对。

前序试跑暴露测试脚本自身两处问题：未先list导致正确拒绝；普通保存不显示“恢复确认”专用提示，已改为轮询数据库已确认的新revision并等待草稿清空，所有工具结果逐一检查isError。另一次运行因磁盘耗尽导致测试PG退出；清理本任务可再生临时依赖和npm缓存后恢复测试库，再取得上述最终绿结果，未将中断算通过。未使用业务55432，未部署/提交/重启产品服务。仍不代表真实模型或Harness验收，实际clip/Group/特殊混合的保守保护仍保留。


### PPTX 链接与动画读写闭环（2026-11-20）

Web `setLink` / `setAnimations` 原为空实现，本轮接入真实 canonical apply→native child→PPTX OOXML；新增 links/animations 严格请求路由、service generation fence 和原生读取。读取使用元素 durable ID，动画显式返回 PC 字段；全列表替换保留 effect、trigger、duration、delay、paragraph、direction 和 motionPath，拒绝不受控 presetXml/未知字段，链接复用 PC URL 协议白名单。只读/过期代数/跨用户请求不假成功。未扩展 getRunLinks、showTiming 等其他未接通入口，不能声称 PC 全面对齐。

真实浏览器曾暴露单文件服务排他与桥接并发读取冲突：桥接现顺序派发，写成功先采用 generation 再释放下一读取；已排队读取按同一 session 当前 generation 发送，写不重试。重开期间统一拒绝所有非 open 调用，入口与排队唤醒后均检查 opening/session/epoch；snapshot restore 旁路红→绿回归确认不会修改旧 session 并在新 session 假报成功，拒绝后正常读取。独立 reviewer 复验返回 CONFLICT、writes=0、dirty=false。

验证：

- `NODE_ENV=test node --import tsx --test apps/web/test/native-slides/bridge.test.mjs apps/web/test/native-slides/session-host.test.mjs`：**56/56**。包括链接/完整动画 export→fresh child roundtrip、非法链接/字段拒绝、generation 采用、重开 apply 与 snapshot 旁路回归。首次未设 NODE_ENV 的 native 测试被预期 isolation gate 拒绝，按 test 环境重跑后全绿。
- 通过 `python3 /tmp/dyoffice-test-db-run.py` 分别运行 `save-service.test.mjs` 的 `links and animations preserve`、`routes.test.mjs` 的 `PPTX links and animations read routes`：各 **1/1**。真实 PostgreSQL 提交、下载 bytes、新 session 读取两条动画和链接、旧 revision 原样、跨用户404/旧代数409/额外字段400。此前完整 save-service 运行遇到 ENOSPC/存储503而失败，空间恢复后只重跑本轮专项，不将其记为完整套件全绿。
- 最终候选 `python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/native-slides/size-roundtrip.test.mjs`：**1/1**，完整 renderer/HTTPS4252/真实 native child/55433 派生库；实际 Ribbon 改4:3、mounted API 写链接和动画、并发读取、保存并下载 bytes 精确等于 PG 已确认 revision、旧 revision 不变、刷新重开尺寸/链接/动画仍在、pageerror=0。
- `tsc --noEmit` 的 Web slides、worker、server 三个配置通过；`npm run build:slides --prefix apps/web`（含 local-shell）通过；`git diff --check` 通过。

该轮无真实模型或 Harness 调用；`unsafeTestOnly:true` 的测试子进程不代表生产 OS sandbox 已验收。仅使用隔离 55433/dyoffice_test 派生库，未读取生产 token，未提交、部署或重启产品服务。


### XLSX AI 所需 unavailable 桥接复核（2026-11-20）

本轮只读沿真实 PC AI 调用链核查 `readLocalImage`、`listExternalLinks`、`findWorkbookCells`、`refreshWorkbookConnection`，并排除 entry 已包装替换的路径。没有据 stub 数量推导模型工具缺口，也没有新增产品修改。

- `readLocalImage` 仅在 `add_image` 非 http(s)/file 路径预取时调用；PC guide 明确这是用户指定的本机绝对路径或 `~/`，属于桌面 OS 能力。本轮不为 Web 开放宿主路径。AI 搜索图片使用已有 authenticated fetchImage；生成图片的 data URL 已由 entry `createWorkbookImageApi` 转换为编辑器受控 https token，并在 fetchImage 包装中取回 bytes，不走该 stub。
- `listExternalLinks` / `readExternalLinkUsage` 当前调用方是外链管理面板与函数参数的外部范围选择；`refreshWorkbookConnection` 当前调用方是 Data 查询面板。`WORKBOOK_TOOLS` 及其 operation schema 没有外部连接刷新工具；不能把这些原生 UI 能力直接计作 AI 工具漏接。它们仍是 Web/PC 原生功能差异，未据此宣称全面对齐。
- `findWorkbookCells` 确实服务 AI `find_cells`：Web stub 的首请求失败会进入 `readSheetRangeMapped` 分页 fallback，覆盖 journal shadow、结构坐标映射与 redaction。fallback 总 extent 上限为400,000 cells；达到上限时工具明确报告 truncated，禁止模型据此断言全工作簿没有匹配。PC sidecar 路径没有该 extent 上限，故大表搜索能力仍有限制；目前未复现错误成功/静默漏报，不为此扩大服务器搜索接口或抬高内存预算。

定向验证 `cd apps/sheets && npx vitest run --config vitest.config.ts tests/workbook-search.test.ts tests/sidecar-find.test.ts tests/image-skill.test.ts` **39/39**；`TSX_DISABLE_CACHE=1 node --import tsx --test apps/web/test/unit/web-ai-media-api.test.mjs apps/web/test/unit/web-ai-search-api.test.mjs` **5/5**。本轮没有新增文件写入逻辑，未新跑原始 XLSX 保存重开，不把这些单元验证当作浏览器/真实模型/Harness验收。完整 browser native 保存仍受前述 root 执行接口缺失阻塞。未提交、部署或重启。


### PPTX 图表数据与主题配色读取对齐（2026-11-20）

对照 PC 真实调用：AI `edit_chart` 直接走既有 `editChart`，`read_slide` 读取现有 renderer 快照；两项空桥不应误描述为 AI edit_chart 完全失效。明确缺口是 App 选中图表、Chart Data 对话框和样式操作调用 `getChartData` / `getChartColorSchemes`，Web 始终返回 null。`getShapeKeys` 仅供 SlideShow/Audience/video 的 Morph 元素匹配，非当前动画 AI 必需，本轮不扩展。

本轮仅补 PPTX 两个只读能力：bridge→严格 HTTP schema→owner/lease/revision/generation fence→child IPC→原生 engine。数据读取复用 PC `getChartElementData`，先解析 renderer durable ref 为实际 element ID；主题目录复用已有 chartColors，标签复用 PC `tMain`，按用户语言 normalize。仅返回实际存在的 accent 单色方案，新增合法三 accent 主题回归，避免固定六项在部分主题上返回 undefined 颜色。保留前轮顺序派发、写后采用 generation、重开 epoch/统一 opening gate；读不修改代数或 dirty。

原生新增测试先失败于 `session.chartData is not a function`，补链后通过；专项验证当前数据→editChart 改标题/series/配色→export→全新原生 session 读回完整数据，旧代数拒绝。PG `routes.test.mjs` 的 `PPTX chart reads` **1/1**，包含实际新增图表与读取、跨用户404、过期generation/lease409、额外字段400；`save-service.test.mjs` 的 `chart read data survives` **1/1**，真实提交并关闭后重开仍保留完整数据、主题目录与历史 revision 字节。

最终候选的 bridge/native 全套、真实浏览器与类型检查结果见下方追加。本轮没有新增模型工具名，也无真实模型/Harness调用，不能据此宣称全部AI工具/PC放映能力已齐。仅使用55433派生库、HTTPS4252；未提交、部署或重启服务。


最终验证：`NODE_ENV=test node --import tsx --test apps/web/test/native-slides/bridge.test.mjs apps/web/test/native-slides/session-host.test.mjs` **59/59**，含中文标签桥接与三accent边界；`python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/native-slides/size-roundtrip.test.mjs` **1/1**（11492ms，进程15059ms），实际完整renderer新增图表→读Before→读9项主题配色→editChart改Revenue/42,64/mono-accent1→保存下载精确等于PG已确认bytes→刷新读取完整数据与目录相同、pageerror=0，并保留前轮尺寸/链接/动画断言。slides/worker/server三项tsc均通过（末次纯worker accent边界改动后重跑worker仍通过），最终slides+local-shell构建通过，`git diff --check`通过。browser采用真实native child但其unsafeTestOnly模式仍不证明生产OS sandbox；本轮未访问业务55432或生产token。


### Word 流式 writer 临时正文不进入存档

再次逐项核对 Word AI 的真实桥依赖：Web entry 用 `assistant.api` 覆盖基础 bridge 的搜索、媒体与图片下载接口，附件与知识库也有真实通道；基础 bridge 中 `fetchImage: unavailable` 不代表实际 AI 入口不可用。页眉/页脚、页面设置、样式、水印和 notes 由 App 的专属 store 传入执行器，未发现新的可见 AI 工具落到空 OS 桥。未扩展桌面文件选择、打印或 CLI。

另在真实 writer 保存语义找到并复现问题：`DraftLanding` 显示的流式片段带 `aiDraft` meta，但仍在实时 ProseMirror 文档里；blur/timer autosave 会将尚未完成、尚未经过 keep/discard 的半成品写入 DOCX。低层新回归先实际调用 `save(ctx,false,true)`，独立打开 `word/document.xml`，确含 `UNACCEPTED_STREAM_DRAFT`，断言失败。最小修复为 Word writer 记录活跃 draft 的 Editor，`buildDocBytes` 在该阶段返回 null；现有保存路径返回 false 且保留未保存状态，导出/serialize 也不能拿到临时正文。`finish()` 移除临时内容并释放登记后，完整或用户保留的结果才经原正常写入与保存路径落盘。此问题来自 PC/Web 共用的 Word 执行器，不是声称发现新的 Web 空桥。

验证：

- 在 `apps/docs` 下运行 `npx vitest run --config vitest.config.ts tests/web-bridge-save-state.test.ts tests/ai-doc-writer.test.ts tests/ai-create-document.test.ts tests/created-document-boot.test.ts`：**44/44，4 files**。新回归同时确认临时正文期间 serializer 返回 null / autosave false，结束后正常保存成功，并用真实 `parseDocx` 重开确认只含最终接受的正文。
- `npm run typecheck:web:docs`、`npm run build:web:docs` 与限定文件 `git diff --check` 通过。
- `python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/native-docs/writer-draft-save.test.mjs`：**1/1，零 skip**，真实 Chromium、4251、隔离55433。实际第一轮 Office tool call `write_document` 启动第二个流式 writer 请求；人工控制该 SSE 在已有可见正文后暂停，再触发真实 blur autosave。保存结果为 incomplete，head 与原字节均保持；放行后完整 writer 结束，显式 Ctrl+S 保存新 revision，实际 DOCX XML 与刷新重开都包含完整最终正文，pageerror 为零。共三次明确 synthetic 上游请求，未调用真实推理模型或真实 Harness。

首轮浏览器 fixture 将全局 DNS 网络替身提前安装，导致 Playwright 登录前 CSRF 请求超时；已按现有测试顺序移到成功登录后再安装，未修改产品网络路径或放宽断言。候选未提交、部署或重启产品服务。该专项不替代所有 Word 参数组合及真实模型/Harness 四格式闭环验收。


### PDF 表单勾选 add_form_mark 与普通 AcroForm 增量插入（2026-11-20）

补齐 PC 已有而 Web 缺失的 `add_form_mark` 工具。静态印刷方框使用 PC 检测与标记绘制算法，支持坐标或文字锚点定位，生成进入现有 I 图片草稿的勾/叉，可移动、缩放、撤销、放弃，用户保存后才形成新 revision；工具明确报告尚未保存。交互式复选框复用实际表单字段写入，返回已保存结果；按 PC 行为，cross 对交互式 checkbox 同样表示选中。命中只读 widget 或非 checkbox 字段拒绝，避免覆盖字段外观；规划绑定当前源 bytes/revision，异步完成后再次检查取消、文件关闭与源变化。

同页包含普通 AcroForm 与静态标记时，仅纯新增 T/I 路径允许保留表单后插入；保存前后比较规范化表单树、字段值/flags、widget 所属页/矩形/Parent 及外观资源和流哈希。XFA、已签名或未签名 signature 字段、AcroForm 与受管印章组合仍拒绝。原文改写与既有图片编辑保持原保护，不据此放开所有带表单 PDF 的修改。独立复核曾发现 widget Parent 重绑定及间接 /FT signature 两处漏检，均以失败回归复现后修复：Parent 使用稳定树路径，字段类型通过引用解析读取。

最终验证：

- shell 的 document-preview、pdf-viewer、pdf-form-marks 三文件 **85/85**，其中 planner **50** 项，覆盖严格参数校验、几何/锚点定位、widget 保护，以及关闭/取消时不继续插入。
- PDF skill 与 form-mark skill **32/32**，区分草稿与已保存字段，覆盖取消和拒绝。
- native 的 pdf-form-inserts、pdf-existing-image-drafts、pdf-text-inserts、pdf-text-inserts-query、pdf-stamps 五文件 **21/21**；包括普通表单保留、故意修改字段/AP/Parent/页身份的拒绝及间接 signature 保护。
- 实际 Chromium 聊天工具浏览器测试 `apps/web/test/local-browser/pdf-form-marks.test.mjs` **1/1、零 skip**（39.648秒，进程43.270秒）：选中 Approved 交互字段→静态叉号→撤销→Consent 文字锚点勾选→坐标叉号→新增 T 文字→用户统一保存→只读 Locked 请求被拒→刷新重开。共两次 stage/commit（字段一次、草稿统一一次），历史 bytes 保持，Approved=true、Locked=false，pageerror=0。静态标记实际几何分别为 (10,50,12,12)、(98,186,16,16)。产物位于 `/tmp/dyoffice-pdf-form-marks-review/{pending.png,saved.png,saved.pdf,geometry.json}`，成品经 Poppler 独立渲染并目视核对。
- 最终 Web shell/server 类型检查、候选 shell 构建与 diff-check 通过。

浏览器使用确定性 synthetic 工具上游和隔离 55433/dyoffice_test 派生库，未访问业务55432或生产 token；不代表真实模型/Harness验收。未提交、部署或重启产品服务。四格式全面对齐仍未完成，XLSX 原生完整浏览器保存的 root 执行接口与真实模型/Harness验收继续单独跟进。


### PDF apply_ops 文档属性补齐（2026-11-20）

沿 PC 实际 callable apply_ops 核查，确认 Web 缺失 setMetadata。本轮复用既有 pageOps 受控路由、revision/lease、隔离进程与 PC applySaveRequest；仅开放 title、author、subject、keywords 字符串。空串清空，省略保持原文件值；metadata:null 重置同批先前属性补丁，与 PC 待保存覆盖语义一致。允许与旋转/排序/删除原子提交，不允许混入 formValues 或几何缩放/裁剪。未知键、非字符串、控制字符与超限字段整批拒绝，快照复制冻结，不执行 accessor。写后重新打开并检查全部四个属性，关键词按 PC 分隔及规范化语义比较，正文/页引用/批注继续接受原校验。

新增真实 PDF 回归先因 INVALID_PDF_PAGE_OPS 失败，接通后 page-ops 全文件 **14/14**；工具层与form-mark既有用例 **33/33**。shell/server 类型检查退出0；diff-check退出0。隔离55433 PostgreSQL的 `PDF page batches` 集成 **1/1、零skip**：中文标题/作者/关键词与旋转删除排序同一stage，提交前head不变，幂等commit一致，跨用户404/过期lease409，新增空白页后属性仍在，旧revision属性未改，继续缩放裁剪和批注核对通过。无真实模型调用，未新跑浏览器，不将此计作真实模型/Harness验收；未提交、部署或重启。

续审确认另外两项实际待补能力：PC apply_ops addFormField 在 Web 无创建字段链；PC generate_image 在共享搜索skill中明确排除 PDF。尚未据此宣称全部工具对齐。


### PDF 图片搜索/生成接入与公共服务就绪状态修复（2026-11-20）

本轮追踪实际 SharedEditorAssistant 组合：此前 searchApi/mediaApi 虽随 assistant 返回，但 PDF 并无 image_search/generate_image 的 descriptor/executor，且配置过滤额外排除 PDF 生成。现新增 PDF 专属 media skill，在对应默认服务 ready 时开放两工具，沿 PC query/max_results、prompt/aspect_ratio 参数；搜索与生成均明确不修改 PDF，生成后需 insert_image。生成的内联数据由当前编辑器缓存转为短 HTTPS 临时引用，不进入模型对话；PDF insert_image 经同一 adapter 解析为 bytes，再进入既有 I 草稿、预览及统一保存链。缓存4项，清理后引用无效，未知引用不访问服务端；非PDF接口保持原媒体路径，XLSX沿用原工厂别名。

独立复核发现并以红→绿修复两处关闭竞态：外部图片fetch结束后复核disposed/signal，关闭后不返回bytes；SharedEditorAssistant卸载主动loop.cancel，工具signal变为aborted且迟到结果不继续下一轮。DocumentPreview清空adapter后的旧generated-image.invalid引用也不回落到服务器fetch。

实际浏览器首次暴露跨四格式根因：普通用户公共配置通过EXISTS读取受RLS保护的secret表，所有带密钥服务ready均为false，故配置存在仍不提供工具。新增0040_global_config_readiness.sql，仅由验证当前session/deployment的SECURITY DEFINER函数返回启用配置的密钥存在布尔值；REVOKE PUBLIC，并经现有runtime roles显式授予business EXECUTE。公共读取复用部署共享锁，secret表权限/RLS保持不变。真实PG回归先复现false，修复后普通用户/admin看到正确ready、无key服务false、keyless服务按既有规则true、禁用服务隐藏、清key后false；个人用户直接SELECT secrets仍0行，伪造hash/过期session拒绝42501。发布该候选时须一并应用0040与runtime privileges更新，本轮未发布。

验证结果：

- PDF media skill/API/config unit **14/14**，包含参数/能力过滤、失败不泄漏base64、取消及缓存关闭；媒体/搜索server service/routes专项 **10/10**。
- SharedEditorAssistant与DocumentPreview界面测试 **31/31**，包括真实生成短引用→PDF草稿→统一保存，以及卸载时取消未完成工具。
- Root独立重跑global-config-readiness/settings-security **9/9**；子代理另完成shared-provider回归，相关PG/settings/provider合计 **14/14**。shell/server类型检查退出0，最终shell候选构建与diff-check退出0。
- `DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY=/tmp/dyoffice-pdf-media-shell python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/local-browser/pdf-media.test.mjs` 最终 **1/1、零skip**（20.450秒，进程23.953秒）：普通用户HTTP公共配置ready为true→上游请求真实包含两工具→聊天搜索→生成→将返回短引用传insert_image→head在用户保存前不变→保存→实际PDF图片位置/尺寸与原生BGRA像素逐字节一致→刷新重开正文仍在、草稿清空、pageerror=0，旧revision字节不变。测试fixture首轮漏填搜索model/baseUrl、一次使用PC插入工具不支持的height，均修正测试参数；像素期望按原生readImageBitmap的BGRA定义从PNG RGBA转换后通过，未放宽断言。成品与刷新截图 `/tmp/dyoffice-pdf-media-review/{saved.pdf,saved.png}`，已目视核对。

浏览器搜索/生成API响应为Playwright确定性替身，模型工具上游为synthetic；该用例证明真实UI装配、临时图片交付与PDF存档，不证明真实图片提供商推理。鉴权/CSRF/服务端密钥选择由上述server tests覆盖。当前PDF插入仍要求PNG/JPEG与5MiB，WebP/GIF生成提供商结果尚未转换闭环，不能称全部图片提供商格式已对齐。仅使用55433隔离测试库，未访问业务55432或生产token；未提交、部署或重启。addFormField及PC canonical混合批次与真实模型/Harness验收仍待继续。


### PDF addFormField 原生控件创建闭环（2026-11-20）

补齐PC apply_ops真实可调用的addFormField；新严格contract→PDF专属form-fields/uploads路由→既有lease/revision保存准备→固定action隔离进程→PC applyFormFields。模型参数保持PC显示坐标page/x/y/width/height，按有效MediaBox∩CropBox、UserUnit和四种页面旋转转为PDF rect；支持text、checkbox、radio、choice、空signature及日期文本。每批最多50项，字段属性按类型校验；名称/父子冲突、重复radio export、非法预选项、未知键/访问器/超限批次整批拒绝。只开放字段创建同类批次，dry_run明确仅验证参数和页数，不声称已检查已有字段冲突或PDF保护。

已有radio组支持追加选项，允许请求的checked/required变化；既有层级父组可加sibling。保存后先核对所有新字段的实际类型、值、flags、矩形/页、AP与日期双AA脚本，再在内存校验副本中恢复请求允许的radio变化并剥去新增节点，比较原Fields/Kids树、Parent、widget及原AP流完整性。中日韩新文字/下拉选项使用实际嵌入字体生成外观，不依赖NeedAppearances。空signature不是签署：既有空signature也可继续新增字段；direct/indirect FT/Type、非空V、ByteRange、Perms等已签名情况仍拒绝，XFA仍拒绝。原T/I插入guard未改，原有对unsigned signature的保守保护仍在其自身路径。

原生测试及独立复核曾补出多页无Annots页误拒、现有radio追加、层级父组sibling以及空signature后续新增四类边界，均已红→绿。独立review未发现确定阻塞bug，但校验范围需明确：canonical投影保护的是旧AcroForm/Widget，不覆盖所有页面Contents/Resources或非Widget批注；不能仅凭该投影声称整个旧PDF内容一概未变。实际创建路径未见修改旧页面内容的逻辑，浏览器/PG另核对原文及历史bytes。

最终原生+隔离+原插入完整性+skill/routes六文件组合 **51/51**；包含独立child输入hash/输出bytes绑定与取消测试。Root真实55433 PG `local-integration/pdf-form-fields.test.mjs` **1/1、零skip**：五kind/日期/中文值真实保存→新控件再次填写保存→旧只读字段保留→跨用户404/错误lease409/重名及混批400→幂等commit相同→历史bytes不变；末次7.552秒、进程9.830秒。UI技能及路由已验证仅真实writer提供创建、混批拒绝、dry_run不写入、保存失败不宣称成功；界面测试另见后续组合结果。

实际聊天工具浏览器 `local-browser/pdf-form-fields.test.mjs` 最终候选 **1/1、零skip**（15.115秒）：创建中文文字/勾选/下拉并追加已有radio选项→list_form_fields→真实setFormValue填写→重名覆盖请求拒绝无commit→刷新原文保留，实际控件选值、只读原值及两段历史bytes均独立重读正确、pageerror=0。产物 `/tmp/dyoffice-pdf-fields-review/{saved.pdf,saved.png,saved-page.png}`；Poppler独立渲染已目视核对中文“李四”/“完成”、复选框/单选组状态与原Locked值。

聊天上游为synthetic，非真实模型/Harness；仅使用55433派生库。未提交、部署或重启。PC canonical跨类别混合原子批次（如创建字段同时setMetadata/批注修改）仍待对齐，未以本轮同类创建闭环替代全面目标。


### PDF 生成GIF/WebP首帧转换与最终组合验收（2026-11-20）

PC通过浏览器fileToCanvas将生成GIF/WebP静态化；Web先前生成返回这些格式时不能插入。本轮新增PDF专属normalizePdfGeneratedImage，只在PDF媒体adapter的生成缓存前及外部fetch后执行，其他编辑器接口保持原路径。PNG/JPEG直接走既有inspect门禁；GIF扫描全帧descriptor、调色板/数据子块边界，WebP扫描RIFF/chunk、VP8/VP8L/VP8X及动画ANIM/ANMF与帧编码尺寸，在createImageBitmap前限制输入5MiB、边长8192、RGBA32MiB；浏览器取首帧绘制PNG，输出再次限制5MiB并inspect，取消前后复核且finally释放bitmap。动画GIF/WebP与PC一致保留首帧，不因动画单独拒绝。

normalizer新shell **29/29**；包含静态/动画合法文件、晚帧越界、损坏/超限容器、编码失败、取消、资源释放与PNG/JPEG原门禁。独立Chromium直接模块验证静/动GIF、静/动lossless WebP及lossy VP8 WebP五种均正确输出PNG，动画红→蓝仍取红色首帧；该直接模块探针不替代下面实际UI流程。

最终同一候选 `/tmp/dyoffice-pdf-fields-shell`：

```sh
DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY=/tmp/dyoffice-pdf-fields-shell \
 python3 /tmp/dyoffice-test-db-run.py node --import tsx --test --test-concurrency=1 \
 apps/web/test/local-browser/pdf-form-fields.test.mjs \
 apps/web/test/local-browser/pdf-media.test.mjs
```

**6/6、零skip**，进程119.788秒：字段聊天闭环1项；PNG、GIF、WebP、动画GIF、动画WebP生成各1项。所有媒体项实际从Office聊天搜索→生成API确定性响应→短引用→PDF I草稿→用户保存→原生读取图片位置尺寸及BGRA逐字节比对→刷新原文仍在、旧revision bytes原样、pageerror=0；PNG项额外从搜索返回的GIF URL经fetch_image→同normalizer→第二I草稿统一保存并核对像素。模型请求未出现data/base64图片payload。生成图为真实Pillow编码小文件，动画第一帧红/第二帧绿，存档像素确为红首帧。各格式产物 `/tmp/dyoffice-pdf-media-review/{png,gif,webp,animated-gif,animated-webp}/{saved.pdf,saved.png}`。

最终 shell 的 normalizer/DocumentPreview/SharedEditorAssistant **60/60**；shell/server类型检查、最新候选构建及diff-check通过。所有browser模型和媒体响应均为确定性替身，实际PDF存储和原生读取为真；不计真实图片提供商推理或真实模型/Harness验收。外部URL的WebP目前仍受server fetchImage格式白名单拒绝，本轮已闭环的是生成WebP/GIF及既可获取的GIF，不声称所有外部图片格式齐全。仅使用隔离55433派生库，未访问业务55432、未读取生产token，未提交、部署或重启。


### PDF 外部 WebP 获取与统一保存（2026-11-20）

在上一轮生成图片转换基础上，定位外部 WebP 被服务端 fetchImage MIME 白名单拒绝。新增 image/webp 返回支持，保留 HTTPS、5MiB 单图片及既有媒体下载限制；PDF 专属 adapter 将返回的 WebP 转为 PNG，其他编辑器继续执行自身嵌入格式校验。服务测试先复现拒绝，再通过修复；media service/routes **7/7**，包含 HTTP URL、非图片与超限输入拒绝。server 类型检查退出0。

扩展实际聊天浏览器 PNG 场景：搜索结果同时提供外部 GIF/WebP，生成 PNG 后依次获取并插入两种外部图，三张图共同形成待保存草稿，用户一次保存。沿真实 PDF 写入与存储检查三张图的尺寸、位置、BGRA像素，并刷新重开，历史 revision bytes 不变、pageerror=0。命令：

```sh
DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY=/tmp/dyoffice-pdf-fields-shell \
 python3 /tmp/dyoffice-test-db-run.py node --import tsx --test \
 --test-name-pattern='generates png images' apps/web/test/local-browser/pdf-media.test.mjs
```

结果 **1/1、零skip**，测试27.108秒、进程30.582秒。当前只改变PNG场景及服务白名单，未重复运行上一轮已通过的其余四个媒体场景。此结果补齐上一节明确保留的外部 WebP 获取缺口；模型及媒体提供商仍是确定性替身，不计真实模型/Harness验收。未提交、部署或重启产品服务。


### PDF canonical 契约与多文字草稿原子删除（2026-11-20）

新增共享 pdf-apply-ops 契约，按 PC callable vocabulary 严格接收九类操作，保留1-based原始页和显式P/T ID；冻结脱离输入的参数副本，未知键、accessor、错误页序及删除后向该页建字段整批拒绝。契约仅表达参数与顺序，尚未接通全部九类混合runtime。共享契约单测先红后绿，root独立重跑 **9/9**。

实际接入 apply_ops removeTextInsert：复用现有 textDrafts，整批目标一次filter、一次整体字体布局规划、一次history快照；成功后一次undo恢复全部草稿。依PC edit-ops/ops.ts 的filter语义，重复和不存在的正确T ID均幂等，不能误用专用remove的严格存在性检查；专用delete_inserted_text仍保留原来的严格查找。P/S错误前缀、非法批次和与页/表单混合的当前未支持请求不会部分生效。dry_run无查询/上传/状态修改。布局失败、取消、版本变化保留旧草稿与历史。

文字controller/工具测试先复现缺失功能，再修复，组合 **41/41**；shell类型检查退出0，候选shell构建成功。实际 browser/pdf-text-drafts 扩展：聊天创建并编辑/拖动两草稿→canonical批量删除（含重复/不存在T）→一次撤销恢复两个→一次上传保存→刻意丢commit回执→复用原上传确认→原生读取两段文字位置/中文值→刷新重开，历史原件bytes不变。**1/1、零skip**，测试29.325秒、进程32.821秒；保存前0次stage/commit，保存后仅1次stage，确认回执复用commit。产物 `/tmp/dyoffice-pdf-text-drafts-review/{pending.png,saved.pdf}`。

```sh
DYOFFICE_TEST_LOCAL_SHELL_DIRECTORY=/tmp/dyoffice-pdf-fields-shell \
 python3 /tmp/dyoffice-test-db-run.py node --import tsx --test \
 apps/web/test/local-browser/pdf-text-drafts.test.mjs
```

完整mixed pending/native单次保存仍需按 `docs/superpowers/plans/2026-11-20-pdf-canonical-pending-ops.md` 继续实施，不能将此多T同类批次计作全部混合对齐。仅55433测试库、synthetic模型，不证明真实模型/Harness；未提交、部署或重启产品。

独立只读复核补出并经红→绿修正三点：全部未知T删除不再依赖布局查询，离线时仍是本地幂等no-op并保持PC一次历史步骤；draft-only apply_ops参数schema不再广告未提供的页操作；结果按操作数报告，不把重复/未知ID误称实际删除数。最终contract/controller/skill组合 **51/51**，包括离线no-op及真实工具schema断言。

复核修正后的候选浏览器再次 **1/1、零skip**，测试28.891秒、进程32.361秒；最终schema改为明确的type/object、ops 1..50及dry_run声明，避免Record<string,unknown>的类型展开错误，最终shell类型检查退出0，三文件单测仍51/51。


### PDF mixed pending 状态归约与内部表单writer接口（2026-11-20）

本轮按canonical计划分离并实施两个前置环节，尚未切换DocumentPreview的保存入口：

- 新 `pdf-pending-ops.ts` 对九项canonical输入在副本上原子归约，保存fileId/baseRevision/generation；失败next严格为原snapshot，所有bucket不变。复用PC annotations坐标函数，字段按批次开始的几何解释；同字段赋值最后一次生效，P/T missing幂等，表单kind从saved catalog推断，readOnly/signature/button保护，原始页身份及deleted/order/metadata null语义保留。输出为detached深冻结数据，历史不递归放进snapshot。13项红→绿测试覆盖混合九类、无效末项、会话已有页序/删除、radio追加、CropBox/UserUnit及四旋转等。
- 新 `pdf-pending-session.ts` 作为单一历史owner，一次apply记录一个undo，支持redo；undo/redo仍递增generation，避免异步ABA回写。失败/dry_run/取消不记历史，外部revision变更及只读/关闭状态拒绝修改；新修改清除redo；discard清历史并绑定当前revision。5项测试先失败后通过。尚未把既有T/I和P创建入口迁入此owner，不能据此声称UI已统一撤销。
- `applySaveRequest`新增仅内部第三参数三个可选具名callback，分别在原赋值、建字段、外观刷新阶段await，均使用同一PDFDocument；默认PC分支保持。Wire SavePdfRequest及HTTP均无callback。表单job导出既有规划/定向AP helper供后续单次native编译复用。真实PDF测试验证未触及旧AP bytes与dict完整、中文choice真实AP、表单赋值+旋转+metadata，以及三个阶段异常均不返回bytes且source原样。独立review未发现具体回归。

root组合contract/planner/session/既有textDrafts/skill **69/69**；root真实PDF新writer+field+AcroForm插入回归 **19/19**。子代理另完成相关form-values等组合30/30，root证据以自己19项组合为准。shell/server完整类型检查均退出0，diff-check退出0。没有本轮新browser/PG：当前交付是纯状态与内部writer基础，不能当作mixed用户Save已闭环。未提交、部署或重启，未访问业务模型/业务数据库。

独立第二轮review找到并经root红→绿修复显式字号的PC差异：PC canonical addFormField仅将rectangle由显示坐标转为PDF user space，fontSize经rest原样传给writer setFontSize，不随UserUnit缩小。新planner初版沿用了旧Web standalone的/unit，现去除此缩放；UserUnit=2、fontSize=12的测试先复现6≠12，再通过保持12。旧standalone处理未改，不能把本轮新planner修复外推为全部PDF工具的字号语义已一致。复核其余九项及owner未发现第二项有依据的必修问题。修复后planner/session18/18。


### PDF 统一 native snapshot 与单次提交链路（2026-11-20）

新增 apply-snapshot 严格快照校验和 apply-ops native/isolated job，以固定 applyOps action 通过 PC applySaveRequest 一次处理最终存活内容；包括 P markups/notes、T/I、字段赋值/创建、旋转、删页、排序、metadata。内部 image decoder 由服务器构造，HTTP 不接收 callback/path/processor。service /pdf/apply-ops/uploads 复用已有 lease/head/hash/stage 保护；浏览器 mutation 在首个 await 前克隆 snapshot，并在未知 commit 回执时复用原 commitInput，不重新准备。

删除页前按当前文档 refs 清理 widget、空字段/父组、radio Opt/V/DV/AS 和 CO；共享 Opt/Kids/Fields/Annots/CO 数组使用 copy-on-write 或对模糊所有权拒绝。真实 save/reload 回归证明别的 radio 选项、selection、refs 和旧 AP bytes 保持。独立复核修复既有 readonly radio 通过 append checked 绕过保护，并在纯 planner/native 两层拒绝；删除已赋值 radio 选中项所在页后，终验按源 widgets 计算应清空值；重复 export 标签按 pdf-lib 最后匹配项选择语义处理；空 note author 与 writer 默认作者保持一致。

root 关联原生表单/文字/writer回归40/40（包含当时的10项applyOps）；contract/routes/mutation/planner/session组合53/53。root删页清理17项与isolated1项组合18/18。后续重复export标签回归另见本节最终验证补充，不能将前述40项当成已包含该新测试。

真实 PostgreSQL 测试只用55433隔离库：一次混合快照涵盖九项canonical归约、中文赋值/choice AP、便笺、保留T、旋转/删页/排序/metadata，实际查询 file_revisions 得到import=1、prepare后=1、commit及相同回执重试后=2。未授权跨用户404、失效lease409、错file/revision与readonly写入400。保存输出独立读取中文值、跨页radio保留项/选中、便笺内容、原页文字、移除页/移除T消失、Locked旧AP bytes完全一致；历史revision bytes未变。

```sh
python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/local-integration/pdf-apply-ops.test.mjs
```

上述文件新增一项批注位置query后，root重跑2/2、零skip，进程11.687秒：另一项实际授权原始PDF query、不申请lease、不stage/upload/commit，revision数量仍1，原件bytes不变。

原生批注前置query新增固定annotationsQuery隔离action，共享旧standalone的文本锚点定位与payload映射；返回原始PDF坐标的markups/notes，不含P IDs，不写PDF。HTTP仅接收revision/page/text/type/contents/occurrence；拒绝客户端quads/path/action。service在读取前后复核head/hash，响应绑定源字节SHA和report SHA；迟到的新版本结果409。root native query6/6，service+route+mixed-route组合3/3，涵盖权限/CSRF和未知参数拒绝。Query目前保留旧opener门禁：AcroForm仍拒；水平LTR和大小写匹配、note锚点左上角沿用原Web行为，不据此声称所有PC annotation语义已对齐。

限制：带DyOfficeStamps的mixed snapshot仍显式拒绝；进程隔离只限制V8 old-space与wall time，不是完整OS文件/网络sandbox。T终验核最终文本存在，未独立核精确字形坐标；annotation核ref/dict、markup quad与note内容/作者/线程，原annotation基线在PDFium T/I重写之后，未证明此前重写中的AP流/像素完全保持。当前没有新的mixed UI/browser或真实模型/Harness验收；旧立即保存入口未切换。未提交、部署、重启，未访问业务数据库或模型凭据。


最终独立复核后，root重跑mixed native11项+isolated1项+deleted-widget17项+原annotation7项，合计36/36、零skip，包含重复export标签修复。新增批注controller通过annotations/query取得坐标后分配P IDs，appendAnnotations在统一session完成一次history写入；所有校验在替换前结束，失败不部分追加，历史/响应token核fileId/baseRevision/generation并拒绝异步ABA与过时并发结果。原始PDF坐标边界按pw/ph除UserUnit计算，CropBox offset及旋转不重复转换。新controller/session/planner/contract/mutations/routes/service组合root62/62，shell/server类型检查均退出0，diff-check退出0。独立review未发现新必修问题。


最后扩展真实PG第二项：实际授权query→controller生成P草稿→canonical删除markup/改note/旋转/metadata→一次undo恢复整批→redo→单次native stage/commit→独立读取成品，仅保留改后的note、无已删highlight，页旋转和title正确，历史原件bytes不变。root最终本文件2/2、零skip，进程15.289秒；查询阶段仍验证无lease/无新增revision，随后明确申请lease才保存。此为无UI的真实组合验收，不替代浏览器完整交互或真实模型推理。

### PDF 统一待保存界面与浏览器复验（2026-11-20）

新增文字、图片、批注及九项 `apply_ops` 已接入同一待保存会话和预览。已有嵌入图片的像素编辑仍用独立草稿；存在此类草稿时，工具栏与助手都拒绝旋转。助手移除旧 `rotate_pages` 入口，旋转统一由 `apply_ops` 提供。组件回归先复现工具栏可旋转，修复后 27/27 通过；前后端类型检查通过。

PDFium 验证读取仅在确认尾部 ASCII 空格由 PDFium 合成时剔除该后缀，作者输入及默认读取语义保留。最新本地账号界面候选 `/tmp/dyoffice-pdf-rotation-local-shell` 构建通过；Chromium 配合 55433 隔离 PostgreSQL **2/2、零跳过**，进程 70.877 秒。混合场景验证干跑、整批拒绝、预览、撤销/重做、中文表单及旧外观、丢回执确认、历史字节和重开；文字场景验证编辑、拖动、批量删除、撤销、中文位置和恢复原提交。两场景均由用户手动保存，只暂存一次。使用确定性模型替身，真实模型和 Harness 尚待验收，候选未发布。

### 托管水印和表单的混合保存（2026-11-20）

统一保存支持通过完整性校验的托管水印及页眉页脚。页序不变时保留绘制位置；删页或重排时按最终页序重建页码。文字和批注的只读定位接口同样支持该类文件。旧 standalone 写入保护、签名及 XFA 拒绝保持原样。

两条原生回归先复现拒绝。最终相关回归 **35/35**，包括 Poppler 对同页编辑前后的水印和页脚区域逐像素比较、原正文和旧字段外观校验。Chromium 与隔离 PostgreSQL **1/1**，验证带水印和表单的九项混合编辑，预览即反映重排后的页码，保存及回执恢复只新增一个版本，刷新后内容正确。模型仍为确定性替身，候选未发布。

### 页面旋转待保存时的文字编辑（2026-11-20）

只读排版结合源页的 CropBox、UserUnit、原始旋转及各草稿的旋转偏移计算原始 PDF 坐标。先插入的草稿随页面一起旋转，按显示方向移动后保留原生方向；撤销恢复原选框。新文字按当前显示方向放置。

原生和控制器回归通过，DocumentPreview **27/27**，前后端类型检查退出 0。候选在内存盘构建；Chromium 与 55433 隔离 PostgreSQL **1/1**，验证在原始 Rotate=90 的页面待保存再转 90 度后插入中文文字，保存输出 Rotate=180 且原生文字坐标为 (450,96)，原件字节不变，丢回执后复用原提交，刷新可重读。使用确定性模型替身，候选未发布。待保存旋转后的图片编辑仍待处理。

### 页面旋转待保存时的新增图片编辑（2026-11-20）

图片查询按当前显示方向定位，新草稿以原始 PDF 坐标保存。已有新增图片草稿随页旋转，显示选框、移动和缩放按当前方向换算；翻转和裁剪将显示侧映射回图片像素。统一保存接受合法的小于 1 点的图片矩形，表单最小尺寸仍独立限制。

本地候选构建、前后端类型检查及 DocumentPreview **27/27** 通过。Chromium 配合 55433 隔离 PostgreSQL **1/1**，验证待保存旋转后插入非对称图片、选框视图尺寸、键盘移动、成品的页身份和原生坐标；与九项混合操作同批保存，回执恢复只新增一个版本，旧字段外观与历史原件保持。原有嵌入图片的像素编辑仍使用独立草稿。模型使用确定性替身，候选未发布。

### 原有嵌入图片接入统一保存（2026-11-20）

已有图片操作按授权原版本定位目标，统一预览和保存走同一个编译器。页面旋转、批注、新增内容和已有图片共享撤销、重做及放弃入口。多次编辑同一图片仍需先保存或撤销，目标冲突会拒绝整个操作。替换图计入撤销历史的图片内存上限。

相关原生与控制器 **29/29**，前后端类型检查及组件 **27/27**。原生回归在同批编辑中核对透明度、删图、文字、旋转和重排；Chromium 与 55433 隔离 PostgreSQL **1/1**，验证原图删除、移动、透明度及替换与新增文字、图片同批预览，保存与回执恢复只提交一个新版本，成品像素和原件字节独立核对。浏览器模型为确定性替身，候选未发布。

### PDF 保存回执与草稿清理复验（2026-11-20）

旧预览收到有效保存回执后立即结束草稿会话；回执未知时保留草稿并允许确认同一次提交。此前页面开始重绘时会先隐藏选框，助手仍可能把已保存的文字列为草稿。

Chromium 与隔离 PostgreSQL 通过文字草稿、混合批次和已有图片三项回归。文字用例刻意延迟已保存版本的预览下载，旧候选稳定复现，修复后的助手在重绘前已返回空草稿列表；随后独立回读中英文正文与坐标，验证手动保存仅暂存一次、确认后仍只有一个新版本，刷新可读，旧版本字节不变。混合用例另核对表单、水印、旋转与新增图片；已有图片用例核对撤销、放弃和成品像素。原生 PDF 入口也通过一项浏览器回归，覆盖从工作区打开、助手改写、批注和显式保存后的重开。以上浏览器复验使用确定性模型替身。
