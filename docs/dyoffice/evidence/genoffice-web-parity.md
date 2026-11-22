# GenOffice 四格式 Web 对齐验收

初始对齐候选为 DyOffice `c87e947a`，后续版本的结果见各项复验记录。GenOffice 功能对照使用仓库已有的复用基线 `19a389b39be75f611ec21dcda4a7b91a658239d2` 和当前保留的编辑器实现。验收范围是个人工作区中的 DOCX、XLSX、PPTX、PDF，覆盖原生编辑、文件保存与重开、助手工具和 Web 权限。宿主专属行为需明确映射到 Web 等价操作或记录能力差异。依据见[复用约定](../reuse.md)和[验收矩阵](../acceptance-matrix.md)。

| 条目 | Web 验收 | 成品核验与差异 |
| --- | --- | --- |
| F01 DOCX | 原生段落、表格、样式、批注，撤销、租约与回执恢复 | 下载后核对实际 OOXML、历史原件和 Word 复开；逐项记录复杂布局与字体的结果 |
| F02 XLSX | 使用 Univer 和原 XLSX 写入链验证公式、格式、定义名称、图表、透视表与批量撤销 | 核对公式、缓存、原始数值和未编辑部件。原功能区支持查看并断开已保存的外部链接。Excel 实际复开待验。工作簿密码、外链刷新和换源仍待对齐 |
| F03 PPTX | 原生文本、形状、图片、图表、页序、撤销与保存 | 复开后继续编辑原生对象并核对母版关系；PowerPoint 实际复开待验。Web 已接母版和版式编辑；部分导出仍不可用 |
| F04 PDF | 原文编辑、批注、页面、表单、扫描页和受保护文档 | 独立提取与渲染核对内容、像素和历史原件。实际签名验证与特殊样本单独记结果 |
| 四格式助手 | 工具按可执行能力注册；真实工具写回、保存、重开，核对委派后的恢复 | 分别记录测试替身、真实模型、本机或外接 Harness、正式隔离环境的结果 |

## 四格式 AI 工具验收

逐工具验收以格式和工具名为单位，保留注册、执行与成品证据。首轮核对涵盖 130 个格式与工具组合、9 个共享工具和桌面 MCP 清单的 Web 对照。[逐工具验收表](office-ai-tool-coverage.md)

定向 Chromium 批次复用 `29415fca` 的原生编辑器产物及更新后的 XLSX 构建和 PowerPoint Worker，四种格式实际注册的 129 个工具组合均返回过成功结果。PDF 兼容名称 `rotate_pages` 由原生 `apply_ops.rotatePages` 覆盖。PPTX 浏览器补测覆盖附件读取、搜索、图片生成与分析、指南和幻灯片脚本，脚本的标题修改、图表值和类型已核对保存后的 XML，问卷选项已进入两页规划和生成流程。DOCX 补测核对下载成品中的连续分节、A5 横向页面、原生页眉和自定义段落样式，并验证批注线程的回复、解决、删除及指定修订的接受与拒绝。另核对应用样式、原生图表、浮动文本框、水印、长文写作、段落替换、选区替换和新建 DOCX。Word 和 PowerPoint 均将 Coding 交付的 PNG 原样写入成品，并保存图像哈希和冻结数据来源。PowerPoint 通过同一个原生事务写入图片和来源文本，按实际幻灯片比例定位。原生进程验证 PNG 和 JPEG 能否在限定像素范围内解码，拒绝损坏图片和空来源说明。通用批操作会引导助手使用已验证的分析图交付入口。9 个共享工具已通过浏览器执行，工作区 5 个数据工具已验证授权与效果。冻结结果写入验证了 Word、Excel 和 PowerPoint 三种原生文件的准确数据、显式保存和重开。[逐工具结果](office-ai-tool-coverage.md)

`1b71dc9f` 的完整 GitHub Web 门禁通过。Chromium 有 87 项通过、0 项失败、7 项按配置跳过，并通过当次运行的 129 个格式工具组合和 9 个共享工具覆盖门禁。本机全量复跑未能确认 PDF 助手另建文档的保存回执，停止该批次后单独重跑通过，核对原 PDF 字节和修订保持一致，分别生成的 PDF 与 DOCX 具有独立的保存回执，且成品包含指定正文。[GitHub 工具覆盖门禁](https://github.com/ClassesOver/DyOffice/actions/runs/45023136921/job/137210216827) [PDF 新建用例](../../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)

`29415fca` 的 CI 本地集成阶段报出 3 项失败，源于事务崩溃夹具缺少文件服务、元数据并发夹具缺少签名状态、PPTX 签名夹具缺少测试环境。补齐夹具后，在独立 PostgreSQL 上复跑 10 项全部通过，覆盖事务回滚、读取竞态及三格式签名文件原件保护。[原 CI 失败](https://github.com/ClassesOver/DyOffice/actions/runs/45009917486/job/137169747167)

同一固定候选的本机全量 Chromium 跑批共 92 项，82 项通过，3 项失败，7 项按配置跳过。失败项为签名原件下载、PDF 分页副本和 XLSX 单表 CSV 导出。三个旧用例均有定向通过记录，最新全量门禁继续复验。[定向结果](office-ai-tool-coverage.md)

`8346afff` 的 GitHub 门禁有 4 个作业通过，Chromium 步骤共 92 项，84 项通过、1 项失败、7 项跳过。PPTX 使用已保存样式追加单页的步骤在 CI 超时，同一产品构建的定向用例通过。[GitHub Chromium 结果](https://github.com/ClassesOver/DyOffice/actions/runs/45013710258/job/137181389779)

`288f039f` 的完整 Web 门禁通过，Chromium 共 93 项，86 项通过、0 项失败、7 项按配置跳过。同步目标分支后的 `69d80ee9` 完成四格式原生构建，PPTX 原生门禁通过。上游的数据容量迁移保留为 0046，签名保护迁移顺延到 0047。新建与重复运行迁移的集成用例通过。[完整 Web 门禁](https://github.com/ClassesOver/DyOffice/actions/runs/45017342201) [合并后 PPTX 门禁](https://github.com/ClassesOver/DyOffice/actions/runs/45019573006) [合并后 Web 门禁](https://github.com/ClassesOver/DyOffice/actions/runs/45019573071)

`dec77c2d` 的工具清单检查匹配 159 项定义。按四个 GenOffice 编辑器的静态定义核对 Web 策略，DOCX、XLSX、PPTX、PDF 的 Web 允许名单分别为 42、19、20、49 个名称，包含 Web 专用和条件注册的工具。原编辑器定义里唯一被排除的是 DOCX 通用桌面命令 `run_cli`。当前轮实际向模型提供的工具继续按格式、编辑器能力、附件和配置收窄。模型调用未提供的工具会被拒绝。服务端、传输、后台阅读与交接合同共 105 项通过。[GenOffice 工具清单](../inventory/agent-tools.md) [模型工具传输与策略](../../../apps/web/test/unit/assistant-client.test.mjs) [浏览器实际工具注册](../../../apps/web/test/local-browser/office-tool-inventory.test.mjs)

| 格式 | 已通过的代表性浏览器场景，使用测试模型响应 |
| --- | --- |
| DOCX | 原助手机制读取当前附件、插入生成或附加图片，刷新后只恢复一次原 Harness 对话 |
| XLSX | 查找未加载网格中的单元格，合并 XLS、预览截断的 XLSX 和 CSV，保存后重开所有工作表，历史委派交付写回工作簿。用 `propose_operations` 写入 `B2=SUM(A2:A3)`，保存文件保留公式和值 `42`，新会话重开后仍可读取公式及结果 |
| PPTX | 助手生成可编辑演示文稿并重做单页，原生备注交接可保存和追问，刷新时只恢复一次原委派 |
| PDF | 原生助手搜索和改写文本、读写便笺及回复，真实保存回执和原生重开。外接 Harness 适配器和宿主 Codex CLI 0.169.0 分别跑通，计算结果同时写入原文和现有便笺 |

上表的浏览器依据是 `89df7aa6` 的用例结果、`15a0ed5e` 的 Chromium 复跑和在 `dec77c2d` 构建上运行的新增 XLSX 公式断言。真实模型的中文指令四格式写回属于 A14。`gpt-6-sol` 已在四种格式各完成一项代表性原生写入、保存和重开，当前证据覆盖下述单次通过的用例及 PPTX 首轮失败。[A14 验收矩阵](../acceptance-matrix.md) [GitHub 四格式浏览器验证](https://github.com/ClassesOver/DyOffice/actions/runs/45005639852/job/137156502751)

固定候选 `89df7aa6` 的真实 PDF 用例通过，耗时约 39 秒。`gpt-6-sol` 通过自定义 Chat Completions 接口接收中文任务，读取原文的两笔数值，委派宿主 Codex CLI 0.169.0 实际运行代码生成 `total.json`。模型从返回文件取得 `42`，调用 `edit_text` 和 `edit_note` 修改现有原文和便笺。保存与重开后两处内容均正确。测试记录一次委派，并核对同一保存回执和历史原件。[真实 PDF 工具成品用例](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs)

同一候选和模型的 DOCX、XLSX 中文端到端用例均通过。模型委派真实 Codex 计算 `143 + 298`，DOCX 写入一段 `Verified total: 441`，XLSX 将 `441` 写入指定工作表的 H2。检查通过项包括实际工具结果、成品包、历史原件和重开后的内容。两个用例分别耗时约 34 秒和 52 秒。[DOCX 与 XLSX 成品用例](../../../apps/web/test/local-browser/native-word-sheets-codex.test.mjs)

PPTX 在 `89df7aa6` 的英文首轮成功生成、保存并重开两页，第二页重做请求后的标题保持原值，整个用例按失败记录。`9922e244` 重建原生 PPTX 后，中文定向用例通过，耗时约 118 秒。生成的两页含指定标题与周一、周五的正文，包内保留可编辑文本，两个页面均无图片。重做时真实模型调用 `read_slide` 和 `regenerate_slide`，第二页保存并重开后含新标题和发布清单。第一页 XML 字节一致，两个历史版本保留原样。该次生成过程中模型调用了一次澄清工具，测试跳过澄清后继续。[PPTX 成品用例](../../../apps/web/test/local-browser/native-slides-generate.test.mjs)

固定候选 `29415fca` 从源码归档独立构建后，使用同一 `gpt-6-sol` 配置串行运行四格式真实模型用例，4 项通过，0 项失败或跳过。DOCX、XLSX、PPTX、PDF 分别耗时 33.0、54.2、112.9、50.9 秒。PPTX 的追踪确认重做请求已发出，两次历史批次均正常开启和关闭，第一页保持原样；生成阶段仍需跳过一次澄清。这组结果覆盖同一候选的成品效果。后续 XLSX 预加载修复的浏览器构建已独立通过相同的真实模型与宿主 Codex 用例，保存重开 H2 为 441。初次复跑因宿主 CLI 路径配置触发 ENOENT，直接使用与基线相同的宿主二进制后通过。

合并目标分支后的 `69d80ee9` 重新构建四个原生编辑器并使用相同真实模型复跑，四格式 4 项通过，0 项失败或跳过。Word 与 Excel 保存重开核对 441，PDF 原文和现有便笺均核对为 42，PowerPoint 生成可编辑页面，重做第二页后第一页 XML 与重做前一致。

在 `1b71dc9f` 补测了真实模型的只读任务。Excel 中文指令找到了尚未加载到网格的 `AZ25001`，核对模型回复、`find_cells` 返回值和原生查找坐标。Word 读到了收藏文件原文，但回答的链接对部分文件名进行了不同层数的百分号转义，首次复跑失败。仅修复点击路径后的复跑发现，回答校验要求模型重答，随后模型省略了引用。回答校验与点击现共用收藏目录的路径匹配。Chromium 回归重现原链接，确认模型响应保留引用、点击用原始版本路径重新授权，且打开的文件含有来源原文。[Excel 查找用例](../../../apps/web/test/local-browser/sheets-find-cells.test.mjs) [Word 引用用例](../../../apps/web/test/local-browser/word-knowledge.test.mjs)

在 `ee9d364a` 的 Word 构建上运行三次同一只读任务，首次未能定位最终引用，后两次均在完整回答中找到可点击引用。两次点击均以收藏目录的原始版本路径重新授权，并打开有该次随机记录编号的原件。浏览器断言核对实际链接、版本与原文，允许模型自行选择链接文字。随后一次真实模型复验读到正确记录编号，但生成的引用仍有错误的文件名转义，纠正请求超时，该次按失败记录。[Word 真实模型用例](../../../apps/web/test/local-browser/word-knowledge.test.mjs)

Word 的 D05 浏览器回归核对同版本引用以只读方式打开保存原文，并在工作区元数据请求与原生编辑器读取之间实际提交新修订。编辑器提示引用版本失效，未请求新版本的文件内容。显式普通打开成功读取新版本，再点旧引用仍提示失效，历史原件字节一致。标签页回归覆盖已打开编辑器的版本证明、过期标签页恢复和被后续导航取代的引用。PowerPoint 桥接回归覆盖接管前版本已被更新时释放租约、取消重载。[Word 浏览器回归](../../../apps/web/test/local-browser/word-knowledge.test.mjs) [标签页回归](../../../apps/web/test/shell/document-tabs.test.ts) [PowerPoint 桥接回归](../../../apps/web/test/native-slides/bridge.test.mjs)

Web Word 知识库把文件名保留为来源标签，模型收到的引用路径只包含文件和修订 ID。点击仍通过当前收藏目录映射回服务端授权路径。单元回归覆盖同修订改名、更新后旧引用失效，以及拒绝目录外路径和伪造搜索结果。脚本化 Chromium 核对上下文和搜索结果给出的引用，以及点击后的原件和版本失效行为。同一构建使用 `gpt-6-sol` 连续运行三次，分别耗时 25.7、22.9、20.1 秒，三次都用搜索和读取工具核对了独有记录编号，返回精确链接并打开了含该编号的只读原件。[浏览器回归](../../../apps/web/test/local-browser/word-knowledge.test.mjs) [知识库桥接回归](../../../apps/web/test/unit/docs-knowledge.test.mjs)

使用 `4f0ad52c` 的四种原生编辑器和同一真实模型复验写回。首轮 PDF、PPTX 和 XLSX 通过，Word 在委派执行阶段报 `ENOENT` 并失败。同一产品构建单独重跑 Word 通过，首次错误的具体缺失路径未记录。Excel 保存重开后 H2 为 441，Word 重跑后正文为 441，PDF 原文和现有便笺均为 42，PPTX 第二页重做后第一页 XML 字节一致。[Word 与 Excel 写回](../../../apps/web/test/local-browser/native-word-sheets-codex.test.mjs) [PowerPoint 写回](../../../apps/web/test/local-browser/native-slides-generate.test.mjs) [PDF 写回](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs)

后续复现了带数据授权的委派在缺少 `harness-data.mjs` 时于 `realpath` 报 `ENOENT`。当前 SaaS 构建会生成该文件，本机完成了带此步骤的全量构建。缺件时界面收到明确失败，服务端日志保留专用错误码，路径不进入客户端响应。实际安装的 Codex 通过了普通执行和受授权数据邮箱测试，独立 Harness 的 PostgreSQL 集成核对了一次源查询、冻结结果和持久交付回执。真实模型曾在普通算术请求中提交 `dataInputs`，因此工具定义明确了普通文本文件与已提交分析产物两种交付方式。使用新版定义复跑 Word 和 Excel，两项均省略该字段，返回代码执行产生的 `total.json`，保存重开后在 Word 正文和 Excel H2 读回 441。[Harness 回归](../../../apps/web/test/unit/coding-harness.test.mjs) [数据交付回归](../../../apps/web/test/local-integration/harness-data-flow.test.mjs)

`4f0ad52c` 的 CI 有两项相关回归失败。Word 宿主用例仍期待旧引用格式，已更新并通过 17 项宿主定向检查。PDF 深色界面勾选在收到助手回复前超时，定向复跑通过并核对下载原件、勾选位置、相邻页像素及重开。本次保留该用例的响应与工具诊断。另有 `a982cdea` 的外部执行器取消用例未观测到预期的进程消失。夹具改为原子发布 PID，并在短时限内核实进程退出及任务的未知结果状态，PostgreSQL 定向复跑通过。[Word 与 PDF 的 CI](https://github.com/ClassesOver/DyOffice/actions/runs/45027900231) [取消用例的 CI](https://github.com/ClassesOver/DyOffice/actions/runs/45027212874)

`9922e244` 上补测了 XLSX 的中文数据分析任务。`gpt-6-sol` 从临时 PostgreSQL 的合成订单计算 2026 年 1 至 6 月实付金额，并调用 `insert_data_result`。6 个月的标签和数值均与数据库真值一致，7 项断言全部通过。该次试验耗时 14.7 秒，调用工具 5 次，输入 9,655 tokens，输出 328 tokens。评估将表格交给内存文档目标，浏览器保存和重开由独立用例覆盖。[真实模型数据分析评估](../../../tools/dyoffice/analysis-eval/README.md)

同一提交的 DOCX 渠道汇总评估通过 6 项断言。模型调用 `insert_data_result`，三个渠道的订单量、金额和来源标记符合真值，耗时 18.1 秒，调用工具 7 次。评估接收表格的目标为内存文档。[真实模型数据分析评估](../../../tools/dyoffice/analysis-eval/README.md)

`29415fca` 的跨表排名追问评估通过全部 7 项断言。模型先按实付金额对商品类别排名，再按用户追问增加华南条件并保留已付款口径。两轮排名与 PostgreSQL 真值一致，首轮金额逐项正确。该次试验耗时 35.1 秒，调用工具 10 次，工具错误与网关重试均为 0。[跨表排名评估用例](../../../tools/dyoffice/analysis-eval/scenarios.ts)

`15a0ed5e` 的 CI 在 Chromium 步骤通过后，有两项数据源服务端回归失败。合入基线 `7663567e` 后，在 `29415fca` 的真实 PostgreSQL 上定向复跑，两项均通过。覆盖管理员批准和撤销数据源、只读 SQL 与超时、结果限额及凭据隔离。[数据源集成回归](../../../apps/web/test/local-integration/data-sources.test.mjs) [旧候选 CI](https://github.com/ClassesOver/DyOffice/actions/runs/45005639852/job/137156502751)

本机通过锁文件安装依赖，使用 Node `22.23.5`、Playwright Chromium `151.0.7922.34`、隔离 PostgreSQL 夹具及主机 OCR，不使用 Docker。本轮确认助手工具清单的 159 个定义与分类一致，兼容输入基线 84 个文件无漂移。四格式后台读取和回答等基础测试 23 项通过，跳过的真实 OCR 项在安装 Tesseract 及 `eng`、`chi_sim` 数据后单独复跑，OCR 套件 3 项通过。

固定候选 `d90ea092` 的上传校验 9 项全部通过，覆盖上游四格式样本、文件签名和内部类型校验、损坏归档及解析限额。另用 GenOffice 桌面端的 Agile 加密函数生成真实的打开密码 XLSX 对照件。同一工作簿的普通字节通过 Web 上传校验，加密字节在校验层返回 400，输入哈希保持一致，桌面加密模块解密后恢复完全相同的工作簿字节。Web 打开密码工作簿及修改密码仍待对齐。[上传校验用例](../../../apps/web/test/storage/validation.test.mjs)

在 `d8392ce2` 的上传校验上，对浏览器验收包的 DOCX、XLSX、PPTX 成品分别重跑了打开密码对照。三个普通成品均获正确识别。用原 GenOffice Agile 加密模块生成的三个真实打开密码副本均返回 400，输入 SHA-256 保持一致，解密回来的字节与对应成品完全相同。该结果记录三种 OOXML 打开密码文件的当前 Web 上传限制。

F14 的 OOXML 包签名存在保存缺口。在 `e5719120` 上使用 Apache POI 的三个签名样本，分别核对 DOCX 正文、XLSX 工作表和 PPTX 幻灯片的签名摘要。原始部件摘要与签名包清单一致，清单摘要也与 `SignedInfo` 一致，样本自带的公钥可验证 `SignatureValue`。修改被签名的部件并保留签名声明后，三个部件摘要均失配，保存服务仍会接受并切为当前修订。三个历史原件的下载字节保持一致。[Microsoft OPC 签名说明](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/opc/digital-signatures-overview) [Apache POI 原始签名样本](https://github.com/apache/poi/tree/c94ee8ad9096bdb8cf8e5e59d8d12432e950dbf3/test-data/xmldsign)

修复后，服务端识别三种 OOXML 包的签名声明。使用上述真实样本复跑，三个样本的修改上传准备均返回 423，当前修订和下载原件的字节保持一致。PostgreSQL 回归另验证十进制和十六进制 XML 字符引用。迁移前 DOCX 的 5 次并发打开只读取并校验一次原件，旧草稿提交被拒绝。同一所有者的两个登录会话可只读浏览同一 PPTX 并翻页，跨账户翻页返回 404，错误修订返回 409。OOXML 保护依据是包签名声明，签名人信任和证书验证仍待独立验收。[修订保护回归](../../../apps/web/test/local-integration/revision-commit.test.mjs) [签名样本](../../../apps/web/test/fixtures/signed-office/README.md)

`ffab0789` 的首轮浏览器回归发现 BrowserHost 的公开字段清单丢弃了签名保护标记，DOCX 因而显示成编辑租约冲突。`dec77c2d` 将布尔值 `true` 传递给三种 OOXML 编辑器。38 项 BrowserHost 与文件传输测试通过。新构建的 DOCX、XLSX、PPTX 通过同一真实签名样本 Chromium 用例，验证只读提示、禁用保存、下载原件字节一致和修订保留。[BrowserHost 合约回归](../../../apps/web/test/unit/host-contract.test.mjs) [真实签名样本浏览器回归](../../../apps/web/test/local-browser/native-office-signature.test.mjs)

后续修复默认 Node 工作簿执行路径的保护元数据。实际 Node 与 Rust 对照覆盖已有文稿的结构锁、有密码的工作表、允许的格式操作、工作表可编辑区域、锁定单元格及继承的公式隐藏标记。原生读取三项、网关工作表保护十一项均通过。此项覆盖 OOXML 编辑保护。[Node 与 Rust 对照用例](../../../apps/web/test/native-sheets/read.test.mjs)

Chromium 使用隔离 Node 执行路径打开同一工作表中的四类单元格。旧编辑器能修改带密码的允许编辑区域，复用的原生防护现仅豁免无需解锁的区域。新构建中默认锁定格和需密码的区域均拒绝写入，单元格样式明确解锁的单元格和无密码编辑区域可保存。下载与对应新修订字节相同，保护标签和历史原件保持原样，重开后四个数值符合预期。工作表保护单测 8 项及 Web Sheets 类型检查通过。[Chromium 保存重开用例](../../../apps/web/test/native-sheets/entry.test.mjs)

固定候选 `ab22f217` 的无 Docker 宿主隔离专项通过 5 项。真实 Node 工作簿网关在 systemd 隔离中完成解析与保存规划，原生 Rust 打开、保存并重开 XLSX。隔离检查核对动态非 root 身份、私有根目录、能力移除、控制进程凭据不继承及原生输出文件边界。用例见 [网关隔离](../../../apps/web/test/host-native/gateway.test.mjs)和 [Rust 进程隔离](../../../apps/web/test/host-native/process.test.mjs)。

在固定候选 `d90ea092` 上复跑完整的 Node 网关和 Rust 宿主隔离套件，11 项全部通过。除实际 XLSX 保存重开外，复验核对内核限制网络和进程数、CPU/内存/墙钟超限终止、取消清理，以及控制进程被终止后 systemd 回收对应任务。[网关隔离](../../../apps/web/test/host-native/gateway.test.mjs) [Rust 进程隔离](../../../apps/web/test/host-native/process.test.mjs)

同一候选的 DOCX 浏览器套件 12 项全部通过。覆盖段落与表格修改、下载、刷新、保留未编辑部件、保存期间继续编辑、租约接管、回执恢复及元数据保存。用例见 [DOCX 原生浏览器回归](../../../apps/web/test/native-docs/roundtrip.test.mjs)。

固定候选 `d90ea092` 补测 F15 的 DOCX 保存与下载。Chromium 在浅色和深色 UI 下分别通过原生设计功能区设置相同页面背景色并保存。两次下载分别与该次提交的文件字节相同，包内 `w:background` 都是 `FF0000`，未修改的 Custom XML 保留，重开后页面背景色仍正确。两项用例均通过。[DOCX 原生浏览器回归](../../../apps/web/test/native-docs/roundtrip.test.mjs)

同一候选的 F01 样式及批注用例通过。通过原生功能区应用 `Heading1`、选中文字并提交批注。下载成品包含样式引用、批注范围起止、批注引用、对应的 `comments.xml`、部件关系及内容类型，历史原件保持原字节。重开后标题、批注和原文锚点可从原生界面读回。[DOCX 原生浏览器回归](../../../apps/web/test/native-docs/roundtrip.test.mjs)

固定候选 `d90ea092` 的 DOCX 核心套件扩展至 14 项后全通过，包含样式批注和明暗主题保存。初次跑批中的入口用例在 30 秒总时限达到后取消。该用例包括数据库准备、实际服务启动及两次无效配置启动；同一构建的单独复跑约 23 秒通过。将用例的总时限调整为 60 秒后，完整跑批和启动拒绝断言全部通过。[DOCX 原生浏览器回归](../../../apps/web/test/native-docs/roundtrip.test.mjs)

同一 DOCX 构建的 F14 修改密码浏览器用例通过。错误密码提示后可只读打开，键入被阻止，下载仍为原始字节且修订不变。输入正确密码后可编辑并保存新修订，写保护字段及历史原件保持不变。重开仍提示修改密码，只读查看时可读回授权修改。[DOCX 原生浏览器回归](../../../apps/web/test/native-docs/roundtrip.test.mjs)

F12 使用 `d8392ce2` 的构建产物通过 Chromium 定向复验。断网时实际上传请求失败，当前页草稿保持未保存，服务端修订不变。恢复联网后手动保存成功，历史原件字节一致。下载响应发送头部后取消，重试取得同一修订的完整字节且没有重复提交。刷新后读回已保存正文。[DOCX 原生浏览器回归](../../../apps/web/test/native-docs/roundtrip.test.mjs)

该样本 `DyOffice-Word-样式批注-d90ea092.docx` 的 SHA-256 为 `e224c6359f2f522bf3b5f1e1e7637bec4a4d65149015830653813e94eb2fb649`。LibreOffice Writer 24.2.7.2 在隔离网络命名空间打开并另存为 DOCX。另存成品保留 `Heading1`、标题、批注文本和范围起止及引用。Web 下载原件哈希保持一致，桌面 Microsoft Word 仍待验。

同一候选的 XLSX 主题用例两项通过。浅色和深色 UI 均经原生 Univer 编辑并用“保存并下载”提交，下载字节与对应修订一致。两份成品均保留 `B2` 公式 `A2*2`、重算缓存 `42.5`、Revenue 名称、图表数列和原填充色 `4472C4`，未修改的绘图和 Custom XML 部件也保持原样。刷新后原生工作簿读到已保存的 `A2=21.25`。[XLSX 原生浏览器回归](../../../apps/web/test/native-sheets/entry.test.mjs)

固定候选 `ab22f217` 的 DOCX 补跑验证了成品 OOXML、未编辑部件、租约接管和回执丢失恢复。延迟保存用例在补跑中收到 Chromium 对首个 HTTP 请求的 `ERR_ABORTED`，同时编辑器已确认该回执并保留后续草稿。同一构建的定向复验通过，检查第一版只包含保存时的快照，后续编辑保持未保存并提交为子修订。初次网络事件失败单独保留。

同一提交的 GitHub Actions 已完成 [DOCX 原生浏览器与原引擎回归](https://github.com/ClassesOver/DyOffice/actions/runs/44972164512/job/137054101707)、[XLSX 原生浏览器、隔离 Worker 与 gateway 回归](https://github.com/ClassesOver/DyOffice/actions/runs/44972164512/job/137054101587)和 [PPTX 原生会话与包重开回归](https://github.com/ClassesOver/DyOffice/actions/runs/44972164426/job/137054101419)。PPTX 该作业覆盖原生包操作；四格式 Chromium 共用作业随后失败，三个失败均来自同一个工具清单测试文件。无数据源分析的夹具仍把依赖数据源的 `insert_data_result` 计入预期。

当前工作分支补齐 PPTX 手动插入与替换图片。原功能区打开浏览器文件选择器，后续走既有受授权图片变更与原生 PPTX 保存链。桥接回归先因接口不可用失败，再通过；包含取消、只读、无效图片和选择期间文稿变更的边界。最终补丁通过桥接与 Chromium 共 43 项。浏览器验证选择图片、替换后保持原框、下载字节和重开原生图片对象。原图片布局 23 项回归、Web PPTX 类型检查和浏览器依赖边界扫描通过。手动 BMP 已接入同一功能区与原生保存链。Chromium 核对浏览器解码的尺寸和像素、下载包中的原始 BMP 字节，以及重开后的原生图片对象。图片头单元测试 9 项、Web PPTX 与服务器及 Worker 类型检查、Slides 构建和 Web 依赖边界检查通过。

PDF 本机 Chromium 套件 6 项全部通过，覆盖真实 OCR 保存与像素核对、页序和表单、选区与导航、原文与功能区编辑、保存回执恢复及受保护结构只读。使用测试模型响应的场景不计入真实模型验收。

固定候选 `ab22f217` 使用宿主 Codex CLI `0.169.0` 的原生二进制跑通了 Office 模型桥的隔离命令执行，以及 Chromium 中的原生 PDF 原文与审阅便笺修改、显式保存和重开。测试使用合成模型响应。通过 pnpm 启动脚本定位 CLI 时，命令执行因沙箱找不到实际二进制而失败。复验通过 `PATH` 直接定位同版本原生二进制，保留原隔离规则。SaaS 可用 `DYOFFICE_CODEX_PATH` 指定该二进制。

固定候选共用测试中，首页新建空白 PDF 在默认 5 秒断言内仍处于渲染阶段。定向复验沿用该候选的构建产物，为首屏 `ready` 状态使用 20 秒等待，通过了模型连接失败后重试、原文保存和按首个标题命名的检查。

Web 工作区通过 `/native-pdf/` 打开 PDF。缺少原生编辑器资产时，工作区提示下载原件。工作区 PDF 预览和开发原型的 `/pdf.html` 已移除。原生编辑器使用现有 PDF 保存、查询和 OCR 服务。Chromium 原生 PDF 定向用例通过 15 项，覆盖工作区打开、OCR、助手委派、图片编辑、保存回执和重开。原型 HTTP 与浏览器用例分别验证旧入口返回 404、PDF 导入后显示原生编辑器提示。 助手富文本用例已迁入工作区的原生编辑器 iframe，通过 1440px 与 390px 两种视口、明暗主题下的表格和代码块滚动回归。 T12 工作区回归验证已打开的原生 PDF 随设置切换明暗主题，通过文件菜单两次下载，字节与原始文件一致。

PDF 渲染与 OCR 专项复验共 6 项通过。复验核对导出成品的文本及渲染结果、加密文件的渲染限制、旧查看入口返回 404、宿主 OCR 文本定位，以及输入像素上限与修订授权。旧预览的 `/pdfjs/` 字体和字符映射路由已移除。原生编辑器的渲染资源随构建发布在 `/native-pdf/assets/pdfjs/`，由现有会话验证保护。

固定候选 `d90ea092` 的 F15 原生 PDF 用例两项通过。在浅色和深色 UI 分别通过助手在第一页面的印刷方框中加入勾选标记，显式保存并用原生文件菜单下载。下载字节与提交修订一致，PDFium 栅格确认第一页发生变化，含蓝色矩形的未编辑页像素保持一致。重开后勾选标记仍可作为图片对象选中，历史原件字节保留。[PDF 原生浏览器回归](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)

签名样本 `signed-approval.pdf` 由 GenOffice 对一页合成文档使用临时自签证书生成，SHA-256 为 `4536d37d0dbaa4e30f188f486f14e049f91f256851c047085ada1e15a66364db`。Poppler `pdfsig -nocert` 验证签名完整并覆盖整份文档。Chromium 通过原生编辑器打开并由助手读取内容，在原 GenOffice 签名面板显示“签名完整，但签名人不受信任”，同时禁用编辑和保存。签名查询通过现有 PDF 子进程校验固定版本的原始字节。PostgreSQL 集成复验覆盖摘要不匹配、过期版本、跨账户及管理员访问和 CSRF。签名文件的下载字节及修订保持一致。签名面板说明工作区服务器的 TLS 根证书来源与吊销检查限制。更多签名类型、证书签署及其他外部阅读器样本仍待验。

在合入上游后的候选上，补装 Web CI 使用的 `fonts-noto-cjk` 后，PDF 表单生成、图片插入与替换、混合待保存操作和表单单元测试合计 14 项通过。本机原先回退到 Unifont，Fontkit 在计算部分 CJK 字形外观时抛错。该复验使用主机字体与本机子进程。

Chromium 全量复跑中的两条 PDF 用例原先在 5 秒内读取预览或轮询数据库版本。定向诊断确认功能区翻转请求成功后，擦除预览及页面像素可以在该期限之后到达。定向复验等待实际预览响应与提交回执，两条均通过。复验仍核对翻转像素、表单和原始版本，以及导入页内容、保存回执和成品页数。

Poppler 24.02.0 独立复开了三条 Chromium 用例保存的成品。第 1 页可以提取替换后的正文，原句不再出现在文本层。栅格化核对三个翻转后的图像像素。导入页内容与原有页面可提取。经用户确认生成的脱敏副本无法提取选中的邮箱，保留了其他邮箱和公开文字。相关浏览器用例同时核对了保存回执与历史原件。

固定候选的 PDF 仿射图片用例在共用跑批中出现保存失败，定向复验未复现。加入诊断后又用同一产物连续复验三次，三次均通过。复验证明两处图片裁剪只产生一次上传准备和一次提交，保存后可重开。Poppler 可独立提取原文和新增文本，并识别两张图片及其透明蒙版。该用例新增了保存阶段的 HTTP 状态、错误码和编辑器状态诊断。首次保存失败的具体原因仍待定位。

XLSX 本机套件通过 8 项，需真实模型的 1 项按配置跳过。已验证原生编辑保存与重开、透视表刷新、全工作簿查找、名称、图表、批量撤销与租约接管。修正数据源能力预期后，四格式助手工具清单 3 项全部通过。启用真实 PostgreSQL 数据源的浏览器用例及插入工具单元测试共 8 项通过，覆盖启用和未启用数据源时的工具注册边界。此修复的远端共用 CI 尚未运行。

宿主 Rust 补跑通过了下载最新原生快照，以及回执释放后保存后续编辑再下载。结构保存用例在浏览器拦截并重放回执的跑批中曾超时。定向复验通过真实 HTTPS 连接暂缓首个已提交的回执，核对了等待期间直接编辑与工具写入被拒绝、释放后能够继续编辑、后续修订未重放结构操作，以及下载成品中的两个数值。

XLSX 委派交付历史恢复新增了后台公式重算回归。浏览器在用户确认写入后、下载交付物时触发 Univer 公式计算通知，旧版本会拒绝该次写入。新版保持选区、编辑日志、版本和租约校验，同时允许纯计算通知与派生结果完成。新版 Chromium 通过从历史写入 J10、保存、校验 XLSX 原始内容并刷新重开，编辑器定向测试 8 项、Web 类型检查和 XLSX 构建通过。

`d8392ce2` 的四格式委派回归在 XLSX 明确显示“插入结果未确认”，此时 J10 仍是活动选区。应用重新载入视口时会复用常规范围写入命令，已有编辑日志使用载入标记区分这些写入。插入授权现使用同一标记，并继续核对实际编辑、选区、修订和租约。定向测试先复现载入造成的拒绝，修复后 9 项全部通过。[XLSX 插入单测](../../../apps/sheets/tests/analysis-insert.test.ts)

Chromium 回归在交付物下载期间释放真实的工作表载入请求。旧制品拒绝写入，J10 仍是活动选区且没有报告内容。只替换载入判断的临时副本通过。随后使用 `npm --prefix apps/web run build:sheets` 正常构建当前产品源码，再用相同的浏览器用例复跑，1 项通过。报告写入 J10，保存并刷新重开后可读回，A601 的源数据和历史原件均保留。固定候选的四格式全量跑批另行记录。[XLSX 委派交付浏览器回归](../../../apps/web/test/local-browser/assistant-dsh-delegation.test.mjs)

XLSX 的大型多附件合并保留用户当前工作表，避免 Univer 在导入时同步排版长文本。Chromium 的测试模型用例同时合并 BIFF XLS、预览截断的 XLSX 和 CSV，核对当前标签、原始修订、下载文件尾行及所有工作表重开。真实模型用例按配置跳过。定向单元测试 8 项、Web 类型检查及构建通过，原生结构变更保存另行通过 Chromium 复跑。

XLSX 外链保真用例从 Web 编辑普通单元格后保存、下载并重开。成品保留未修改的外链公式及缓存、工作簿中的引用、外链工作表缓存和目标关系部件。独立比较确认原始修订保持原字节。测试中的外部源监听器收到 0 次请求。 Web 的“公式 → 外部链接”复用原面板和工作簿子进程。Chromium 通过了显示链接地址与缓存工作表名称、拒绝跨账户读取和拒绝客户端传入路径，以及保存重开后再次显示同一链接的场景。

断开外链复用工作簿保存与修订链。确认后使用已保存版本的公式缓存写入字面值，并以新版本重开网格。保存、编辑准入及面板定向单测共 51 项通过，包含只读面板仍显示外链信息。网关外链操作回归 8 项通过，覆盖保留其他外链及拒绝会留下悬空引用的断开操作。保存期间新完成的编辑仍留在当前会话中，待单独保存。

Chromium 专项通过 Web 功能区断开外链。确认前文件版本保持不变，确认后只生成一个修订。保存的 `G3` 由外链公式变为数值 `84`，对应关系和缓存部件从新版本移除，其他编辑在重开后仍存在。旧修订保持原字节，外部源监听器收到 0 次请求。真实 PostgreSQL 下，Node 子进程夹具以及 systemd 隔离的宿主 Rust 与工作簿网关分别通过同一用例。

外链列表读取失败现会显示明确提示。专项在断开后的第一次列表读取注入 HTTP 503，确认界面提示读取失败。重新打开面板时验证真实请求成功，才核对空列表。Node 子进程夹具和 systemd 宿主原生路径均通过，网格重开、单个新修订及成品公式缓存检查同时通过。

PPTX 的 View → Slide Master 已接入原 GenOffice 母版与版式编辑，包括文字、形状、位置、填充和描边。原生会话回归 31 项通过，核对继承、事务历史、稳定对象 ID、原生重开和未修改包部件。服务端路由回归通过，检查当前文件租约、版本和编辑代数；Chromium 通过功能区进入母版，鼠标绘制文本框、输入、保存并在下载文件的真实母版 XML 中核对文字。Web 桥接及隔离子进程回归共 66 项通过，同时恢复了 GenOffice 对不完整主题只显示可用强调色的行为。生产隔离与外部 PowerPoint 复开仍待验。

PPTX 文件菜单已支持 PNG/JPG 导出。Web 使用同一套 GenOffice 画布逐页渲染，下载保留原命名顺序的 ZIP。Chromium 验证两种图像格式、隐藏页排除、两倍渲染尺寸、ZIP 条目名和源文档版本及字节保持不变。原图片命名测试 5 项、PPTX 类型检查和 Web 依赖边界检查通过，新增用例已接入 Web CI。

固定候选 `d90ea092` 的 F15 PPTX 两项用例通过。浅色和深色 UI 导出的同格式可见页图片逐字节一致，隐藏页均被排除，导出没有生成文件修订。在两种主题下插入同一填充色的矩形，经原生链路保存并下载。下载成品的 OOXML 均包含真实矩形和色值 `A14173`，未编辑幻灯片、文稿主题及历史原件的字节保持一致。重开后两个矩形都可继续修改填充色。[PPTX 保存与图片导出回归](../../../apps/web/test/native-slides/image-export.test.mjs)

PPTX 的 F14 修改密码保护通过原生会话复验。对照候选 `d8392ce2` 会保留 `p:modifyVerifier` 字段并提交修改后的正文。修复后识别到验证器的演示文稿可渲染和浏览，原生编辑及保存请求返回 403，原件与修订保持一致。原生会话及保存专项 32 项全部通过。Chromium 三项通过，覆盖只读提示、保存按钮禁用、原件下载，以及普通 PPTX 图片导出和原生对象编辑保存。Web 通过修改密码解锁仍待适配。[Microsoft PresentationML 修改保护说明](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.presentation.modificationverifier?view=openxml-3.0.1) [PPTX 原生保存与下载用例](../../../apps/web/test/native-slides/image-export.test.mjs)

在 Node `24.22.3` 上复跑制品、IPC 协议和启动边界，共 43 项通过。使用实际构建的 PPTX 子进程打开带修改密码的合成样本，严格校验后的大纲仅包含 `writeProtected: true`，编辑和导出均返回 `PPTX_WRITE_PROTECTED`。旧格式大纲仍能通过校验。制品清单保留 `runtimeApproved: false`。[PPTX 制品 IPC 用例](../../../apps/web/test/runtime-artifacts/pptx-candidate-ipc.test.mjs) [IPC 协议用例](../../../apps/web/test/sandbox/document-contract.test.mjs)

合入上游 `6e92710c` 后，PPTX 功能区可以选择 TIFF。Web 原生会话复用 GenOffice 解码器生成 PNG 预览，限制解码为 16,777,216 像素、单张 PNG 输出为 8 MiB。Chromium 通过功能区插入 TIFF，核对预览尺寸和像素、下载包中的 TIFF 原始字节和重开结果。同次 Chromium 复跑通过 TIFF 原生往返和 PNG/JPG 导出两项。PPTX 原生会话、解码和识别共 42 项，独立 PPTX CI 夹具本地运行 56 项，Web 桥接及测试子进程共 66 项全部通过。完整 SaaS 构建、服务端及 Web PPTX 类型检查也通过。

固定候选 `d90ea092` 的 `bridge`、`service` 与 `session-host` 套件共 74 项全部通过，覆盖保存身份、母版和原生对象、历史批次及撤销、范围检查、代数与会话限制。该组结果来自 Web 适配和测试宿主，正式执行后端及 PowerPoint 复开另行验收。

运行时制品和执行边界专项在 Node `24.22.3` 上共 44 项全部通过。PPTX 测试验证模块构建、真实 IPC 保存重开、固定制品校验和篡改拒绝。非提升安装布局的测试夹具补齐了 `apps/slides` 的包清单，Node 使用字节已对照且只有一个硬链接的本机副本。PDF 制品与启动边界也通过。候选制品保持未授权状态。正式执行后端缺失时，生产本地入口在监听前拒绝启动。

旧候选的四格式 Chromium 共用套件运行了 109 项，通过 96 项、失败 6 项、跳过 7 项。失败集中在 XLSX 委派交付、附件合并以及 PDF 表单与图片编辑。新版结果以各项定向复验为准。外部 Office 复开仍待验，F01–F04 的状态保持待验。

开发过程中的 Chromium 共用诊断跑批结束，共 87 项，77 项通过、3 项失败、7 项按配置跳过。失败项为 PDF 助手富文本面板、图片预览及页面导入保存。三个场景均已在原生入口上定向复验通过。该次跑批期间工作树和构建产物有更新，单一候选提交的完整复跑仍待完成。

固定候选 `ab22f217` 的四编辑器助手用例在 XLSX 导航等待全页 `load` 时超时。定向复验沿用候选产物，导航等待文档响应提交，随后按各编辑器实际就绪状态验证面板、草稿、交互和连接失败恢复。四个编辑器均通过该用例。

四编辑器数据源用例也在等待 XLSX 全页 `load` 时超时。对同一产物按助手就绪状态复验后通过，覆盖真实 PostgreSQL 中的授权表读取、Python 使用已固定的查询结果生成 PNG、刷新后取得新数据，以及四个编辑器各自提供的数据源工具。

固定候选 `ab22f217` 的完整 Chromium 套件在无 Docker 的宿主环境结束，共 88 项，77 项通过、4 项失败、7 项按配置跳过。失败项为首页空白 PDF 首屏、四编辑器助手交互、四编辑器数据源分析和 PDF 仿射图片保存。四个场景的定向复验均通过，首次仿射图片保存失败尚未定位。跳过的内置 Codex 合成模型场景已单独通过，另 6 项依赖真实模型配置。该跑批早于 XLSX 断开外链和后续测试同步改动，不能作为更新候选的完整通过记录。桌面 Word、Excel 和 PowerPoint 复开仍待验。

固定候选 `d90ea092` 从独立源码归档安装锁定依赖并完成 `npm run build:saas`。随后在无 Docker 的宿主环境串行执行 49 个 Chromium 测试文件，最终 88 项中 81 项通过、0 项失败、7 项跳过。上一候选四个失败场景在同一跑批内全部通过。本轮也通过了 XLSX 外链断开、原生 PDF 永久脱敏副本和 PPTX 画幅、编辑对象及母版保存重开。跳过项为 6 个需真实模型配置的用例和 1 个需显式启用本机 Codex 的用例。F15 和 Word 样式批注补测使用该候选的四格式构建产物。此后加入的 Node XLSX 保护修复单独取证。真实模型、正式执行环境及桌面 Office 复开另取证据。

固定候选 `d8392ce2` 从独立源码归档完成 SaaS 构建，随后串行运行 49 个 Chromium 测试文件。90 项中 82 项通过、1 项失败、7 项跳过。唯一失败是外部委派交付从历史记录写入 XLSX。`2c013293` 的修复通过正常构建的浏览器定向复验。包含新增回归的固定候选 `89df7aa6` 单独执行全量跑批。

`89df7aa6` 的浏览器跑批共 91 项，83 项通过、1 项失败、7 项跳过。XLSX 历史交付回归通过。原生 PDF 助手交接在追问后 15 秒仍处于 `answering`，该次用例失败。沿用同一候选构建产物，原版用例独立复跑通过。带诊断日志的定向复跑也通过，搜索、改写原文、添加便笺和回复四项工具均成功，追问发出 12.21 秒后收到已保存回执。[PDF 交接浏览器用例](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)

PR 候选 `15a0ed5e` 的 GitHub Actions 成功执行了四格式 Chromium 步骤，包含原版 PDF 助手交接用例。这两次候选之间的改动涉及独立 Web 锁文件、验收记录和导航及服务端测试，PDF 助手交接代码与浏览器用例相同。`89df7aa6` 的本地跑批仍保留首次超时记录。[GitHub 四格式 Chromium 验证](https://github.com/ClassesOver/DyOffice/actions/runs/45005639852/job/137156502751)

候选 `d90ea092` 显式启用本机 Codex CLI `0.169.0` 后，跳过的原生 PDF 内置 Codex 用例单独复跑通过。固定模型驱动实际委派和计算，原生编辑器在一次显式保存中提交原文与已有批注的修改，重开后读回结果。此证据使用合成模型响应。[原生 PDF Codex 回归](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs)

候选 `cb95ad42` 的 PostgreSQL 与 RustFS 保存门禁共 71 项全部通过。四格式的保存准备、不可变原件与回执重放分别验证。共用门禁覆盖同基线并发单一胜者、幂等键绑定、事务回滚、对象损坏、历史恢复为子修订、旧租约及撤销会话的拒绝，以及跨账户和配置管理员的 RLS 边界。该结果对应服务端和存储验证，四格式浏览器完整回归与桌面复开分别记录。

固定候选 `d90ea092` 的 PostgreSQL 与 RustFS 保存专项 58 项全部通过，含四格式实际成品存取以及版本提交、租约、回执、权限和历史恢复。XLSX 原生专项初次执行 114 项，112 项通过、1 项失败、1 项真实模型用例跳过。失败项使用的测试夹具缺少 Univer 当前工作表和同步插表接口。补齐夹具后，混合附件用例在同一构建上定向通过，覆盖原 XLS、XLSM、XLSX、CSV 和 TSV 的原始内容、保存重开及保持原工作表选中。

固定候选 `d8392ce2` 的 T09 原生专项串行运行 26 个测试文件，共 117 项，116 项通过，0 项失败，1 项需真实模型配置而跳过。通过项覆盖 Node 和原生 Rust 的 XLSX 工作流、编辑保护、两种主题下公式和图表保存、未提交编辑的下载及回执恢复、混合附件保存重开，以及原生执行边界的所有权和撤销检查。

文件导入和存储专项共 35 项全部通过，含真实 RustFS。四格式按包内结构识别并校验原始字节。伪扩展名、归档路径越界、超额解压、损坏结构及不支持的加密输入被拒绝。解析超时与并发达到上限后，健康文件仍可继续验证。Web 依赖边界扫描检查 1,556 个文件，未发现违规引用。

F16 的 T12 Chromium 用例在固定候选 `d8392ce2` 上通过，覆盖文件夹、收藏、最近打开、回收站恢复及切换账户后的隔离。另有 5 项 PostgreSQL 集成用例通过。把不同内容的两个 DOCX 改为同名并回收、恢复其中一个后，两个文件仍保持各自的原修订与字节。跨账户及配置管理员的重命名被拒绝，文件名中的路径分隔符和异格式扩展名也被拒绝。[工作区 Chromium 用例](../../../apps/web/test/local-browser/t12-workspace-settings.test.mjs) [文件与修订集成用例](../../../apps/web/test/local-integration/files.test.mjs) [工作区权限集成用例](../../../apps/web/test/local-integration/workspace.test.mjs)

对浏览器验收包中的成品补做了独立复开。LibreOffice 24.2.7.2 在隔离目录和断网进程中读取了 DOCX、XLSX 和 PPTX。Writer 渲染结果包含新增段落、原生表格文字和中文剪贴板内容。Calc 读取 `A2=21.25`、`B2=42.5` 和 `G3=84`。在合成控制副本中把 `A2` 改为 `22` 并保留旧公式缓存 `42.5`，强制重算后 `B2=44` 且 `G3=84`。Impress 渲染出三页 4:3 幻灯片，保留标题文字、Revenue 图表和母版文字。Poppler 独立读取 PDF 的原文、新增文本与两张裁剪图片。

三个 OOXML 样本也通过了 LibreOffice 另存。通过系统调用追踪定位了首次 Calc 失败，补齐隔离运行时的 `libsal_textenclo.so` 链接后，上游对照和验收样本均可另存为 XLSX。成品保留 `B2` 公式和值、`G3` 数值以及已断开外链的状态。Writer 另存保留段落与两行可编辑表格，另存产物省略了 Web 成品中的自定义 XML。Impress 另存保留三页 4:3 幻灯片、可编辑图表、文字与母版。三个 Web 成品的原字节均通过 SHA-256 对照。桌面 Microsoft Word、Excel 和 PowerPoint 仍待验。

### 桌面 Office 复开核验

用验收包内的 SHA-256 确认输入。每项记录操作系统、Office 应用版本和构建号、应用是否提示修复、打开后观察到的内容，以及编辑另存并复开副本的结果。

| 样本 | 原生对象和保存核验 |
| --- | --- |
| `Word-saved.docx` | 确认 `Web native paragraph 2026`、中文剪贴板内容和两行表格。对副本修改首格 `Native table cell`，另存后重开，确认单元格可继续编辑。 |
| `Excel-saved.xlsx` | 确认 `A2=21.25`、`B2=42.5`、`G3=84`。在公式栏核对 `B2` 的 `=A2*2`，并确认 `G3` 是常量、工作簿链接列表为空。在副本中把 `A2` 改为 `22` 并重算，确认 `B2=44` 且 `G3=84`，再另存重开。 |
| `PowerPoint-saved.pptx` | 确认三页 4:3、首页的 `Jump to slide three`、Revenue 图表和母版 `CanvasMasterText`。在副本中分别选中文字框和图表，确认可编辑，修改标题后另存重开。 |

上述步骤待桌面 Microsoft Office 实测。独立 LibreOffice 和 Poppler 结果见前文。
