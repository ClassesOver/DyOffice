# 当前 Web 入口 UI 验收记录

日期：2026-11-18。入口：`DYOFFICE_AUTH_MODE=local` / `http://localhost:3080`。本报告是持续检查记录，**不代表所有 UI、状态和浏览器组合已经穷举完成**。

## 范围和验证方式

检查首页/页签/上传、个人设置（偏好、密码、会话、技能）、用户管理、回收站、数据连接、全局配置，以及应用内 Word 和只读预览。桌面 1440×1000、小屏 390×844、明暗主题均有定向检查。真实业务变更只针对测试创建的文件/技能；管理员失败、凭据、未知写入等边界通过隔离组件或浏览器网络拦截验证，不修改真实密码或服务配置。

## 本轮确认并修复

| 编号 | 元素/触发条件 | 问题与修复 | 证据 |
|---|---|---|---|
| UI-01 | 最近文件行更多操作；键盘 Enter/方向键 | 打开后焦点未进入菜单，方向键触发滚动关闭。Web 菜单增加首项聚焦、方向移动、Esc 返回、Tab 正常退出。 | `home-workspace.test.ts` 新增键盘与 PC 不变回归 |
| UI-02 | 用户管理新建草稿→现有成员操作 | 草稿被无确认覆盖，取消后残留 dirty。切换前确认，确认后同步清理 dirty。 | mock 浏览器复现，`local-admin.test.ts` |
| UI-03 | 创建用户返回一次性码→其他成员操作 | 唯一可见激活码被无确认清除。清除前要求明确确认，拒绝则保留。 | mock 创建浏览器复现，`local-admin.test.ts` |
| UI-04 | 创建用户 HTTP 408 | 未锁后续创建，可能重复提交。归入结果未知状态，明确核对前保持写入保护。 | mock HTTP 408 浏览器复现，`local-admin.test.ts` |
| UI-05 | 未保存/处理中/结果未知时刷新浏览器 | 多个弹窗只有组件关闭保护，reload 可绕过。为全局配置、连接、管理员操作、密码、会话、技能、回收站补齐 beforeunload。仅阻止默认卸载，不额外调用 confirm。 | Sources 浏览器 reload 反例；`account-beforeunload.test.ts` 及各面板测试 |
| UI-06 | 数据连接输入凭据→刷新列表 | 只读操作完成也清空未提交凭据。改为仅提交保存后清理。 | 组件回归先失败后通过；修复后浏览器等待只读刷新完成，凭据保持不变 |
| UI-07 | 数据连接冻结结果保存未确认→再查询/切连接 | 会丢失原保存意图。未核对期间阻止会替换意图的操作，保留原 commandId 的确认入口。 | `sources-panel.test.ts`；修复后 mock 浏览器新查询被禁用，二次确认复用原 commandId（queryCount=1、saveAttempts=2） |
| UI-08 | XLSX 调整表顺序/改名后打开 | 按 ZIP 文件名排序并显示“工作表 N”，与工作簿不符。读取 workbook 及关系索引，遵循真实名称和顺序。 | `document-preview.test.ts` 先失败后通过 |
| UI-09 | PPTX 调整幻灯片顺序后打开 | 按 ZIP 文件名排序，与 presentation 顺序不符。读取 presentation 关系索引，不读取外部目标。 | `document-preview.test.ts` 先失败后通过 |
| UI-10 | 回收站末页恢复/删除唯一条目 | 操作成功后仍读取旧 offset，出现空页。只读重取有效页，确认写成功后读失败明确提示，不重复写。 | `workspace-trash-design.test.ts` 五项回归；浏览器模拟末页恢复/删除后回到有效页 |
| UI-11 | 小屏点击末行更多菜单 | 浏览器自动横向滚动的迟到事件误关新菜单。打开时记录祖先滚动位置，仅实际位置变化时关闭。 | 事件时序证据、`home-workspace.test.ts` 回归先失败后通过 |

## 交互覆盖概览

| 页面 | 已覆盖动作/状态 | 仍需补查 |
|---|---|---|
| 首页/文件树 | 搜索/清除/空结果、格式筛选、排序、行与全选、批量删除取消、重命名取消、移动取消、树选择、新建文件夹取消、工作区位置导航 | 更多层级冲突、触屏、完整读屏器顺序 |
| 页签 | 新建菜单、页签列表、首页与 Word 切换、右键关闭、保存状态/租约释放；真实 Word 编辑保存 | 16 个 PDF 模拟页签已验证溢出、拖动和关闭；仍需跨编辑器组合竞态 |
| 上传 | 桌面/小屏、拖拽/多选/移除/取消、不支持格式、32 MiB 限制、串行处理、处理中防重入与关闭、真实 PDF 上传后应用内打开 | 真实断网/配额耗尽、重复文件名策略、所有损坏文件格式 |
| 个人设置 | dirty 拒绝关闭、跨 tab guard、偏好读取保存、密码/会话 pending/unknown 组件保护 | 真实改密轮换/会话撤销完整流程已通过隔离 PG/浏览器；仍需多端复杂并发 |
| 技能 | 37 项目录与分页、中英文搜索/格式筛选、正文预览、真实安装刷新保留/防覆盖、导入分类、unknown 后核对/失败 | 全部技能正文与真实模型工具执行；不将任务说明当能力证明 |
| 用户管理 | 搜索/状态、创建/权限操作组件、dirty 与一次性码切换、408/unknown 保护、小屏滚动 | 隔离 PG 真实管理员创建/激活/重置/禁用/自降权已通过；复杂并发仍待查 |
| 回收站 | 搜索/状态、确认取消、恢复/永久删除组件、unknown fence、内部滚动 | 页码归一化已组件及浏览器模拟验证；真实测试文件删除/恢复/永久删除已通过，原文件夹和收藏保留，测试文件与空目录已清理 |
| 数据连接 | 仅三类数据库、草稿 JSON/友好字段、凭据 retain/replace/clear、保存冲突/unknown、测试/发布组件、结果意图、离开保护 | 实际外部数据库连通/只读授权、浏览器结果下载 |
| 全局配置 | 类型/服务商/默认值、不可用项禁选、添加/删除确认、密钥清空、保存冲突/unknown、显式核对、配置检查不冒充连通 | 真实轮换密钥/计费模型/搜索/图片/HTTP MCP，不修改真实服务设置 |
| 文档预览 | 真实四格式应用内打开；Word 编辑保存；只读提示；XLSX 缓存值/文本与真实表顺序；PPT 顺序；PDF 页面渲染 | 全部 Ribbon 子菜单及弹窗、复杂公式/图形、超大或加密文档 |

## CI 定位

- Web 依赖边界拒绝技能目录的动态 Vite glob：改为明确的静态 raw imports，不放宽边界检查。
- Native DOCX 助手集成旧 fixture 的“report skill”没有办公格式，按新筛选规则不可见：fixture 明确为 Word 任务，继续检查私人技能经 Provider Gateway 传递和账号隔离。隔离真实 PostgreSQL/浏览器测试已通过。
- 本地截图/原始报告位于 `/tmp/dyoffice-ui-audit/`，未作为持久证据提交，也不能替代仓库回归与后续验收。

## 本轮最终验证

- Web shell：32 个测试文件、241 项测试通过；类型检查、生产构建通过。构建有既有大 chunk 提示。
- Web 边界：1334 个文件、0 违规；84 文件兼容基线、157 项工具清单、538 项 IPC 分类检查通过。
- 修复后浏览器：用户管理/回收站 7 项通过，数据连接/全局配置 4 项通过，均无页面错误，业务写入由 mock 拦截。刷新取消后草稿保留。
- Native Sheets CI 的技能 fixture 同样缺少明确办公格式，补充 Excel 描述而不改正文和隔离断言。录制数据的真实浏览器助手流程本地通过；原生 worker 流程本机受 `HOST_BACKEND_UNAVAILABLE` 限制（要求 root），仍需 CI 验证，未绕过隔离。
- 最终构建后的首页只读浏览器复验：17 组通过，包含小屏末行菜单与键盘操作；0 页面错误、0 拦截写入。

## 第二轮补查（持续更新）

- 上传：处理中可通过刷新绕过弹窗关闭保护。新增 beforeunload 保护；回归先失败后通过，真实浏览器取消刷新后原状态保留，模拟拒绝后解除保护。
- XLSX：有效 XML 使用命名空间前缀时无法预览。索引、关系和文本节点按 namespace local name 读取；新增回归先失败后通过。
- 页签：原先不能用键盘聚焦/切换。补齐 tablist/tab、活动状态、单个主焦点与方向/Home/End/Enter/Space 操作，保持关闭按钮与鼠标拖动。最终构建浏览器 9 组通过，含 16 个模拟 PDF 页签及窄屏焦点自动显露，0 页面错误、0 真实写入。
- 登录状态：401 后仍展示旧账号/弹窗，退出结果未知后旧绑定不可用却无恢复入口。已补齐会话失效通知和阻断恢复页，保留旧编辑器 DOM/未保存状态，显式重新加载才离开，不把错误密码或 403 当作会话过期。
- 冻结结果：首次确定 API 拒绝被误记为结果未知而锁死；与写入后的会话校验失败需要区分。仅首次确定业务拒绝允许修正，已有未知历史和 post-proof 失败继续保留原 commandId。新查询失败后的旧结果明确标注为上次成功查询，不冒充新结果。
- 改密：真实隔离测试发现密码成功轮换后会话列表仍保留旧 ID，已修复为成功后重新读取会话，保留密码成功提示；真实隔离会话集成测试通过。
- CI 浏览器旧定位与旧下载流程已适配到 AntD 菜单/页签、上传弹窗、内部文档预览和实际下载按钮；保留真实 PG/HTTP、账号隔离、密钥不泄漏和原始字节断言，不用 mock 替换集成测试。

真实回收站验收 4 项通过（`trash-real/report.json`），本轮仅修改本次明确创建的 QA 文件与目录，均已清理；0 页面错误。录制脚本调试阶段的接口 201/204 与图标 accessible name 定位错误不记为产品缺陷。

第二轮最终证据：

- 合并远端命名空间兼容后，Web shell 34 个文件、294 项通过，类型检查与构建通过。预览采用标准及 Strict OOXML namespace 过滤，保留外部关系/路径/大小限制。
- 真实隔离 PostgreSQL/HTTP/Chromium：8/8 浏览器测试通过，包含账号创建/激活/重置/禁用/自降权、偏好保存、登录历史私密投影、密码轮换、单会话/批量/当前会话撤销、工作区文件/全局配置/技能完整流程；全部原有账号隔离/密钥/字节强断言保留。
- 账号正式模拟浏览器复验 15/15、改密恢复 5/5：六类 API 401/403、退出失败、旧浮层隐藏并不可交互、Tab 焦点限制；改密后 proof 401/403/网络失败无自动导航，显式刷新取消后保留状态。编辑器保留使用模拟 iframe 节点和内存断言，不将其声称为真实 Word 过期保稿验收。
- 冻结结果正式模拟浏览器 13 组通过：首次确定拒绝解锁，未知写入后 403 和 POST 成功后 proof 403 保留原 commandId，恢复核对不重新查询；JSON Blob 特殊字符和公式前缀原样保留，下载 404/413/503 显示错误。无真实配置写入。
- 独立复查发现并修复改密后自动重载、改密真实过期 401 被误当错密、会话撤销 408 清除未知保护三项；会话客户端 7/7 回归通过。没有把客户端重复调用的复现夸大为已经证明通过 UI 关闭/重挂能重复撤销。
- 仍未穷举真实 Word 全部 Ribbon 控件、所有触屏/读屏器组合及跨编辑器竞态，目标继续保持进行中。

- 改密 408 的同类问题也由两个失败回归确认：表单与客户端均保持 unknown，禁止重试直到重新加载核对；两文件 23 项专项通过，最终构建/类型通过。真实浏览器模拟 408 两项通过，密码输入清空，刷新取消保留保护，无真实密码修改。
- 纳入远端最新虚拟 Select 键盘测试助手及恢复文件的权威状态断言，该版本完整真实浏览器套件 8/8 通过（134.7 秒），不覆盖远端提交。


## 提交前补充复查

- PDF 关闭/切换时，中止未完成渲染并销毁 worker；异步边界检查取消，避免旧任务向已卸载容器继续写入。包含延迟渲染取消回归。
- 会话过期时同时隐藏并 inert 首页行菜单、文件夹菜单 portal；保留原 DOM 和清理恢复逻辑。真实 DOM 测试覆盖隐藏及恢复。
- Word Ribbon 共享下拉增加 Escape 关闭，不触发转换操作；定向 4 文件 28 测试通过。
- 合并远端主页布局恢复提交后，Web shell 35 文件 300 测试、Web 类型检查、shell 与 Word Web 构建通过。Docs 全量类型检查仍有桌面 electron/electron-updater 等依赖错误，不声称通过。
- 真实 Word 未保存文字遇 401 后保持原 iframe 与内容；显式重载触发 Word 离开提示，取消后保留文字与恢复界面，2 项通过。仅本轮 QA 文件已删除并清理。
- 预览模拟浏览器覆盖关系重排 XLSX、切换、损坏文件、PDF 超限、精确版本下载，页面错误为空；PDF 取消修复以回归测试验证，不声称真实浏览器生命周期验收。
- Word 真实界面已记录 52 个入口动作，另外发现“视图→切换标签”调用缺失 listDocsTabs，以及 390px Ribbon 横向溢出，均待修。本轮 QA Word 已清理。
- 嵌套文件夹新脚本在重命名输入定位处失败，未纳入提交；不能据此认定产品重命名失败，也不能声称完整层级冲突验收通过。穷举目标仍进行中。
- 统一构建并重启后的正式浏览器复验：行菜单、文件夹菜单 2/2 通过，均隐藏、inert、无可访问菜单且不能程序聚焦，0 页面错误。独立只读审查未发现阻塞问题。

## Word 视图与窄屏后续修复

- `listDocsTabs` / `focusDocsTab` 接入父工作区真实 Word 页签，筛除其他格式并校验目标仍存在；切换不打开浏览器新页签，也不重新挂载原编辑器。
- 同文档多实例未受 Web 租约/实例管理支持，原先会调用缺失 `openNewTab` 的按钮现在明确禁用并提示；PC 仍调用原接口。
- 切换标签的独立弹层增加 Escape；列表失败可见，关闭后迟到响应不会重新打开菜单。
- Web Word 在宽度不超过 700px 时顶层 Ribbon 换行，取消桌面窗体按钮预留空间，桌面/PC 样式保持原状。
- 本轮 Web shell 36 文件 310 项通过，类型检查通过；Docs 定向 5 文件 29 项通过，Word Web 构建通过。独立只读审查未发现阻塞问题。
- 构建重启后的真实浏览器 11 项通过：开始/插入/布局/设计/引用/审阅及文件菜单 Escape、切换标签 Escape、实际激活另一 Word、同文档多实例入口禁用、390px 所有顶层入口可见且根宽度 390。0 页面异常，两个本轮测试文件已清理。截图已人工查看。
- 嵌套文件夹真实隔离 PostgreSQL/HTTP/Chromium 测试通过：创建父子目录、重名 409 保留草稿、改名保持父子身份、非空删除 409 保留状态、先删子再删父 204，最终目录为空且无页面异常。此前失败均为测试定位/响应状态假设，已更正，未改产品逻辑。
- 证据：`/tmp/dyoffice-ui-audit/word-followup-verified/report.json`、`mobile-390.png`、`/tmp/dyoffice-folder-conflicts-root-current.log`。此前记录的两个 Word 待修项已在本节关闭；全量控件实际写入、触屏/读屏器与跨编辑器并发仍未穷举。

## 文档写入与异常流补查

- 真实 Word 输入段落、插入超链接和 2×2 表格，原生保存确认后关闭并重开；文字、链接地址、单元格内容均保留，5项通过、0页面异常，QA文件已清理。证据 `/tmp/dyoffice-ui-audit/word-edit-persistence/report.json`。
- 两个 Word 编辑器各自输入不同内容，切换保存并关闭重开，4项检查通过，未串稿。清理其中一份成功；另一份因强制关闭页面中断后台 PUT，产生 receiving/attempt已设但hash未设的草稿，移入回收站成功、purge409。仅该QA草稿的到期时间被提前以核对正常过期清理，过期后仍因未知上传保护拒绝purge，**未彻底清理**，不绕过服务端保护。该边界继续调查。证据 `/tmp/dyoffice-ui-audit/word-two-editors/report.json`。
- Word 桌面与390px共29个真实交互记录：查找前后跳转、单次/全部替换、页码定位、导航标题/结果/页面、缩放应用/取消、边距及纸张取消、字数统计关闭；0页面异常，最后保存200，QA文件删除及purge成功。系统打印与取消在headless下未验证，不计通过。证据 `/tmp/dyoffice-ui-audit/word-dialog-flows/coverage.md`。
- 预览超限Content-Length和HTTP错误分支原先未取消未读响应流；两条DOM/ReadableStream回归先失败后通过，现拒绝时取消响应body。Web shell37文件312项、类型与构建通过。上传格式/大小拒绝、mock503重开、网络错误重开、快速切换及迟到响应保持当前内容已通过浏览器检查，均明确为mock业务接口，无真实业务写入。
- 构建重启后的预览/上传模拟浏览器复验7组通过，包括确认超限响应流cancel回调执行；0页面异常、0真实业务写入，所有mock标签关闭。证据 `/tmp/dyoffice-ui-audit/upload-preview-edge-postfix/report.json`。

## 上传完成证明与永久删除保护

- 隔离PG复现：存储PUT已返回有效的key/size/hash，但写ready前文档被移入回收站/租约失效，记录原先遗留receiving且无hash，永久删除一直409；新增回归先失败，原因是状态仍receiving。
- 仅存储返回完全匹配的完成receipt时，失败清理用原凭据重新核对owner/job/auth/session/attempt，原子记录终态hash及reserved→stored计费。expired不重复计费，ready/committed/已有hash不覆盖。没有发布新revision。存储结果未知、权限失效、不同attempt和清理事务失败仍保持原保护。
- 14项真实PG专项通过，包含未知PUT、迟到PUT结束前409、完成后回收、配额只退一次、凭据撤销、不同attempt、receipt不匹配、证明事务回滚、ready提交成功但响应丢失。
- 文件/回收/永久删除39项真实PG集成回归通过（含真实S3）；首次运行缺少S3测试环境未通过，补齐已有本地RustFS环境后完整重跑通过。Web shell314项、前后端及shell类型检查、构建通过；独立只读审查未发现阻塞问题。
- 回收站purge409明确说明可能有关联任务或未确认上传，并提示核对/联系管理员；不改变unknown保护或写入重试。构建后模拟浏览器2项通过，0页面异常，0真实业务写入。
- 不把成功PUT后的本次修复当作历史证据恢复：进程退出、响应丢失或凭据撤销时仍无充分证明。旧QA文件1c2f6ebb-3a02-43e6-a985-cf1a4ef9f8e7仍在回收站，历史未知草稿保持保护，未伪造hash或声称清理成功。
- 证据 `/tmp/dyoffice-postpublication-full.log`、`/tmp/dyoffice-postpublication-regressions-s3.log`、`/tmp/dyoffice-ui-audit/trash-conflict-postfix/report.json`。

## 文件列表搜索与操作意图补查

- 两处真实页面模拟复现：搜索后仍保留已选但隐藏文件的批量工具栏；新查询输入后，旧请求在150ms防抖窗口返回并显示旧结果。搜索开始清除隐藏选择/旧结果，cleanup立即作废旧请求。DOM回归先失败后通过。
- 搜索105条时原先仅100条可访问，无后续入口。新增“加载更多结果”，保留首页结构，支持明确点击后续页、防重复、失败保留已有结果及重试，切换查询作废迟到追加。分页间总数变化、重复或空页时重读首屏，避免重复offset死循环；105→106条插入回归先失败后通过。全部语言字典补齐按钮文本。
- 收藏PUT已提交但响应丢失后，原先再次点击读取最新状态并反转，导致取消首次收藏。当前桥接实例冻结原目标，后续点击先核对，已达成则不再写；否则仍提交原绝对值。明确提示再次点击核对。确定拒绝释放目标；未知读取/写入保留原目标。重命名/移动同资源不同意图的并发改为互斥，相同意图合并。
- 最终Web shell37文件320项、bridge25项、类型与构建通过。独立只读审查发现并修复分页变化边界，复查无该阻塞。
- 构建后模拟浏览器：105条全部可加载（offset0/100），搜索清隐藏选择、拒绝旧响应、收藏首次模拟503后再次核对无反向PUT均通过，0页面异常。所有业务变更为mock，无真实文件需清理。
- 证据 `/tmp/dyoffice-ui-audit/search-pagination-postfix/report.json`、`home-selection-postfix/report.json`、`home-star-recovery/report.json`；桥接测试通过 `node --import tsx --test ...` 运行。直接Node transform不解析旧有无扩展名import，未将该命令失败算作产品缺陷。
- 剩余确认缺口：批量操作中途失败后仍可能重发已完成项；冻结收藏目标限当前桥接实例，未声称跨刷新持久化。批量部分成功/未知的完整核对与恢复仍需继续处理。

## 批量部分成功后的恢复

- 删除、移除最近记录和取消收藏保留当前桥接实例内的批次进度。网络错误、408、5xx 结果未知时，重试先只读核对目标；未达成或读取失败时不重写该项，也不提交后续项。改变选集、单项收藏入口不能绕过该资源的未知保护。确定拒绝允许显式重试失败项。
- 恢复时重新核对先前成功项，处理用户已恢复文件、重新打开或重新收藏的情况；同目标的交叉批次推进完成状态，全成功后释放进度。独立复查实跑发现旧批次残留导致漏操作，追加回归先失败后修复。
- 最终Web shell37文件320项、桥接测试35项、shell类型、前后端类型、构建及边界/兼容清单检查通过。桥接回归覆盖三个入口、读取失败、不同选集、反向操作和批次生命周期。
- 构建重启后的Chromium模拟浏览器2场景通过：A成功、B已提交但503后重试只提交C；B未确认时连续两次重试只读核对、不再提交B/C。0页面异常；全部文件业务读写为mock，无真实文件创建或删除。mock的204响应记录有ERR_ABORTED，未将其声明为全程无请求失败。
- 证据：`/tmp/dyoffice-final-bridge.log`、`/tmp/dyoffice-final-build.log`、`/tmp/dyoffice-ui-audit/home-bulk-delete-retry/report.json`。批次进度与未知保护仍限当前桥接实例，不声称跨刷新持久化；完整UI穷举仍未完成。

## 键盘入口与管理状态隔离补查

- 移动目录弹窗原先目录行无法键盘聚焦或选择。新增初始搜索焦点、单一目录Tab入口、方向键展开/父子导航、Home/End、Enter/Space选择，以及Tab首尾循环和可见焦点样式；禁用目录仍不可选。搜索后清空恢复可见目录焦点入口。三条DOM回归先失败后通过，保持主页布局。
- 上传拖拽区域底层组件仅响应Enter，Space不打开选择器。局部补Space激活并阻止页面滚动及按住重复，不改依赖；DOM回归先失败后通过。最终构建浏览器1440/390px各Space、Enter、点击均恰好一个filechooser，共6项通过、0页面异常、0业务写。
- 数据连接A写结果未知后，读取并采用B版本原先会解除A保护。持久客户端记录待核对sourceId及实际读取身份，只允许核对原连接；B仍可只读浏览。删除A后列表已无A时保留直接读取A入口，精确404也可明确确认。34项专项通过；最终构建浏览器6项通过，覆盖发布/删除500、B不解锁、关闭保护及删除A消失后的恢复。均为mock业务API，不声称浏览器重挂验收。
- 技能同名导入原先直接覆盖。现在预检后展示替换确认，取消保留原文，明确确认才写；未知结果保留替换草稿并禁止重复提交，刷新仅核对列表。预检读取失败明确尚未提交，不误锁为未知写。Panel/client25项通过。最终构建模拟浏览器4组通过，只有2条mock PUT（成功及503），无真实技能写入。预检仍为GET后无条件PUT，不能保证两请求间并发新建同名时不覆盖；本轮不声称服务端条件写保护。
- 最终Web shell38文件338项、桥接35项、shell及前后端类型、构建、边界与兼容清单通过；独立复查无剩余确定阻塞。构建有既有chunk大小提示，DOM环境有既有CSS解析日志。目录键盘浏览器4项通过，0页面异常，仅1条mock移动写入。
- 证据：`/tmp/dyoffice-ui-round3-shell.log`、`/tmp/dyoffice-ui-round3-final-build.log`及`/tmp/dyoffice-ui-audit/`下`folder-picker-keyboard`、`upload-state-audit`、`upload-keyboard-postfix`、`source-identity-postfix`、`skills-replacement-mock`报告。早期Sources脚本误尝试关闭未知状态弹窗、Skills关闭按钮定位双匹配均已更正，不将脚本错误算产品缺陷。完整UI、复杂文档写入与跨编辑器竞态仍未穷举。

## 大列表刷新与页签改名补查

- 最近/收藏加载超过100条后，Home刷新请求limit=已加载条数，但Web API最多接受100，实际150条浏览器模拟复现400。桥接层现按100及剩余数量分批读取，保留offset/格式/总数，合并完成才交付UI；总数变化、重叠、空后续页明确拒绝，避免发布不完整结果。5条新增回归基线全失败、修复后通过。
- 首页续页增加同步请求锁，防同一tick重复observer追加；旧请求不能清新视图的锁，首屏处理中/失败时不使用旧视图offset，只有当前首屏成功才重新启用滚动续页。分页总数变化、重叠或空页重读首屏，收藏分组续页保留过滤条件。Home最终58项通过，含8项本轮新增回归。
- 首页改名成功后原先已开页签及iframe title仍旧，重开也不更新。现成功PATCH同步标题，重复打开同ID刷新名称但保留原src/format/关闭guard。独立复查发现迟到open可能回退刚确认的新名，增加按文件的改名版本与打开请求序号，覆盖先旧后新/先新后旧及首次打开前改名，标签13项通过。不替换已挂载编辑器。
- 全局配置/偏好追加只读浏览器10项及既有30测试通过，覆盖多项草稿、筛选切换、删除取消、400保存/500读取失败、迟到读取及停用默认项；未复现新问题。所有配置业务读写为mock，无真实配置修改。
- 合并远端`18dc611c`保留其收藏unknown保护、诊断和其他领域提交后，桥接51项、前后端类型、shell/Word Web构建及Docs流式输入18项通过。整合前最终Web shell38文件352项通过；源码整合对本批UI仅追加远端收藏保护一行及10个bridge回归。最初Docs命令使用错误root上下文而未找到setup，改用docs工作目录的npm test后18项通过，不算产品失败。
- 最终构建重启后的模拟浏览器：150条分页/刷新、首屏503不混页与显式刷新恢复4项；页签改名/重开/保留iframe草稿与guard4项。所有文件业务接口mock，Word iframe为stub，仅证明宿主生命周期，不冒充真实Word正文/保存验收。0页面异常，无真实业务写入。
- 证据：`/tmp/dyoffice-recent-browser-red.log`、`/tmp/dyoffice-round4-final-shell.log`、`/tmp/dyoffice-round4-integrated-bridge.log`、`/tmp/dyoffice-round4-integrated-docs.log`，以及`/tmp/dyoffice-ui-audit/`下`recent-refresh`、`document-rename-postfix`、`settings-deep`、`rename-open-order-check.json`报告。完整UI、跨刷新状态恢复及复杂文档交互仍继续验收。

## 视图切换与文件夹菜单键盘补查

- 真实浏览器模拟确认：从最近切到收藏，首屏等待或503时仍显示最近的旧文件，可勾选并打开删除确认（未确认删除）。切换视图/类型/分组时现清除旧列表与总数，空列表按实际状态显示加载或错误重试；同视图刷新失败保留仍匹配的文件。首屏成功才恢复续页，迟到的成功/失败均受当前请求序号隔离。DOM回归先失败后通过，主页布局不变。
- 侧栏文件夹菜单的Enter事件原先冒泡到目录行，菜单项默认点击前就被卸载，无法重命名。目录行现在忽略子元素键盘事件；Web文件夹菜单增加首项焦点、上下键导航、Escape恢复触发器焦点和Tab退出。独立4项回归先红后绿，正式浏览器8项通过，包含真实按Enter进入改名再Escape取消、侧栏与表格菜单。
- PR三项CI失败均来自两个导航测试夹具遗漏新增的reserveOpen接口，合计24项失败；仅补齐夹具后定向38项通过，完整Web API测试380项中379通过、1跳过、0失败。未修改产品页签接口来迁就旧夹具。
- 整合远端bd2de112的诊断测试提交后，最终Web shell39文件359项通过；shell及前后端类型、shell构建通过。构建仍有既有chunk大小提示，DOM测试仍有既有CSS解析日志。首轮全suite恰在并行agent的红测试阶段读取新文件而失败1项，修复完成后重跑上述全suite全部通过。
- 正式构建重启后列表浏览器5场景通过：pending/503无旧行、失败后Retry恢复、快速往返后晚成功及晚失败不覆盖当前视图。独立只读源码审查未发现新的确定性问题。全部文件业务API为mock，0页面异常、0真实业务写入，不冒充真实文档保存验收。
- 发布前远端又新增b1378167导航fixture修复；保留其原样token身份断言，去掉本批对同一fixture的重复修复，仅补齐另一个nonnative fixture；整合后重新运行完整Web API回归，日志/tmp/dyoffice-round5-integrated-web.log。随后保留d74523ac登录失败诊断提交，其新增4项回归通过（/tmp/dyoffice-round5-login-diagnostics.log）。
- 证据：/tmp/dyoffice-round5-final-shell.log、/tmp/dyoffice-round5-final-build.log、/tmp/dyoffice-ci-test-web-fixed.log，以及/tmp/dyoffice-ui-audit/下home-view-transition、home-view-transition-postfix、home-view-transition-recovery、folder-interaction、folder-menu-postfix报告与截图。完整UI穷举仍未完成，复杂文档交互与跨刷新恢复继续验收。

## 搜索恢复、回收站补页与技能原子防覆盖

- 搜索首屏等待原先空白无加载状态；首屏503后无原查询重试入口，Enter或窗口focus也不重搜。索引轮询失败后仍永久显示索引中。现分别显示加载/明确失败与Retry，保留同查询已加载命中，失败时停止索引提示并隐藏未确认的结果总数；Retry重跑当前查询，查询切换拒绝迟到失败。搜索结果role=button补齐Space/Enter激活、阻止滚动和按住重复打开。5条新增DOM回归先红后绿，Home66项通过，保持主页布局。
- 最终构建搜索浏览器4场景通过：pending加载指示、首屏503后同查询Retry、有命中与空partial索引轮询失败后Retry。每次恢复均等待真实新mock GET，不用残留旧行充当恢复证明。索引场景通过Home桥接合约注入pending/scanning（本地bridge自身返回扫描已结束），其余请求使用浏览器路由mock。空partial失败不显示错误的0结果或NoResults。
- 回收站11条时，第一页恢复/永久删除一条后原第11条未补入，而总数变10导致第二页消失。确认成功后现补读有效页，复用并发缩页归一化与补读失败提示；确认写成功后重加载不重复写。新增restore/purge各3条DOM回归先红后绿，Trash17项通过；最终构建浏览器6场景通过，包含10行补齐、第11条可见、补读500仍提示已成功、页2并发缩至5归一页1。另7组失败/unknown/取消审计通过。
- 关闭前轮明确记录的技能GET→PUT同名并发窗口：客户端在非替换导入/安装中传overwrite:false，服务端在原owner事务/配额锁内INSERT ON CONFLICT DO NOTHING，冲突409保留已有description/body；只有明确确认替换或旧调用省略参数仍走原更新行为。无数据库迁移，保留前置GET用于早期提示。隔离真实PostgreSQL4项通过，涵盖并发仅一成功、原文保持、HTTP及service参数校验、显式替换和旧调用兼容；客户端/面板26项通过。这里的服务端原子保护证据来自PG回归，不把mockUI当成原子性证明。
- 最终Web shell40文件371项通过，Web API380项中379通过/1跳过；shell与前后端类型、shell构建、边界及兼容清单通过。独立搜索/技能3文件92项及源码复核通过。构建仍有既有chunk大小提示，DOM仍有既有CSS解析日志。一次新增测试清理试图清除全局stub，导致共享setup的ResizeObserver被删除；移除该多余清理后回收站回归重新通过，非产品失败。
- 本批业务浏览器均mock，无真实业务写入；隔离PG测试使用自动清理的测试数据库。完整UI穷举、复杂文档保存与跨刷新unknown恢复仍未完成。
- 证据：/tmp/dyoffice-search-state-red.log、/tmp/dyoffice-search-partial-red.log、/tmp/dyoffice-search-keyboard-red.log、/tmp/dyoffice-round6-shell.log、/tmp/dyoffice-round6-web.log、/tmp/dyoffice-round6-final-build.log、/tmp/dyoffice-skills-atomic-green.log，以及/tmp/dyoffice-ui-audit/下home-search-recovery、home-search-recovery-postfix、trash-deep、trash-failure、trash-page-postfix、skills-independent-audit的报告与截图。

- 最终技能模拟浏览器10项通过：预检空后另一写者创建同名，条件PUT返回409，原说明/正文保留且显示替换确认；取消零覆盖，明确确认后才一次成功更新。证据/tmp/dyoffice-ui-audit/skills-atomic-browser-audit/report.json及race-conflict-confirmation.png。
- 上传只读补查通过：24个文件含256字长名在390×844与320×568下无横溢，名称省略/title保全名、列表独立滚动；处理中Escape/关闭/取消/重复开始/选择器均有保护，beforeunload阻止。释放后每文件一次mock stage/content400，无finish或真实文件，最终错误与提示可滚动访问、键盘可完成关闭。证据/tmp/dyoffice-ui-audit/upload-long-list-audit/report.json及四张截图。未发现新的确定性上传问题。
- 搜索结果键盘最终浏览器通过（390×640）：Space与Enter各精确1次mock metadata GET及open POST；按住重复不额外打开，window.scrollY与内容滚动位置不变。PDF预览准备阶段的额外读取单列，未混入按键计数。证据/tmp/dyoffice-ui-audit/home-search-keyboard-postfix/report.json及search-focused.png。

## 页签关闭竞态与账号操作恢复补查

- 真实浏览器复现：已打开A→再次打开A请求暂停→关闭A→释放旧响应，A会复活且新建编辑器iframe。另慢A/快B依次打开时，A迟到会抢走B焦点；用户已切回Home也会被旧响应抢回。成功关闭现在记录该文件已有打开请求的序号界限，仅作废关闭前/关闭确认中的旧请求；取消或拒绝关闭不作废。打开请求和显式导航共用顺序，旧请求仍可后台挂载但不抢后来的选择；关闭活动页签的邻居选择也保留。21项页签测试通过，新增竞态先红后绿，含后台关闭不阻其他文件、确认中请求与确认后新打开。
- 用户管理reauth或创建确定拒绝时原先丢失非敏感的新建字段；现在回填username/displayName供修正重试，密码始终清空。create500未知后确认关闭、重开首读500原先丢失保护并可再次POST；稳定管理员client现保留unknown/pending，写端同步拒绝重复，只有明确有效读取核对后释放。读取开始的未知快照与写版本阻止旧GET清除新的未知写。CSRF预读取失败与reauth失败尚未提交业务写，不误锁为unknown。14项新回归先红后绿，Admin新旧共32项通过。保护限当前client实例，不声称跨浏览器刷新持久化。
- 撤销当前会话成功原先立即location.replace，却被自身busy beforeunload拦截，取消离站后仍保留旧撤销按钮。成功后现先释放自身处理锁、清行并显示已撤销终态/禁重复；current revoke与修改自身角色的入口回调统一进入Root登录失效恢复层，保留Shell/编辑器直到用户显式reload，不自动导航，也不解除编辑器未存内容的beforeunload。19项账号组件与2项执行真实入口绑定回归通过；后者最初ownAuthority确实触发旧自动导航，修复后通过。
- 最终Shell41文件394项通过、Web API382项中381通过/1跳过；shell与前后端类型、构建、边界/兼容清单通过。首轮全suite有一处旧文案断言仍期待自动退出，已改为新的重新加载核对语义后全suite通过；不削弱会话确认与当前会话行保留断言。构建chunk提示及DOM CSS解析日志仍存在。
- 最终构建管理员mock浏览器3场景通过（reauth400保草稿/0业务POST，create400保草稿，create500重挂读500仍锁且成功refresh不重发）；页签三竞态修复通过，重复关闭只调用一次guard、切换不关错页、guard拒绝有可见提示也通过。所有业务请求mock，编辑器iframe为stub，不冒充真实正文保存/租约验证。独立只读复查未见本批明确遗漏。
- 新确认尚未修复：native编辑器入口直接返回错误JSON时，无生命周期API，关闭一直被当作加载中，同ID重开也不重新请求iframe，缺恢复入口。实际服务application/json Problem envelope与兼容application/problem+json两种MIME均浏览器采证：同源native URL、scripts0、无脚本/租约请求、pre可解析type/title/status503/detail/requestId；仅证明首次入口未启动场景，不推广到已有编辑器/租约的runtime失败。另密码修改同时撤销其他会话期间，旧会话面板重挂会清局部pending保护，已记录，真实密码轮换本身已撤销旧会话，尚未声称完整解决。完整UI目标仍进行中。
- 证据：/tmp/dyoffice-tab-close-red.log、/tmp/dyoffice-tab-focus-red.log、/tmp/dyoffice-tab-final.log、/tmp/dyoffice-round7-final-shell.log、/tmp/dyoffice-round7-web.log、/tmp/dyoffice-round7-build.log，以及/tmp/dyoffice-ui-audit/下document-close-race、document-close-race-postfix、native-entry-problem、admin-deep、admin-recovery-postfix报告与截图。
- 最终账号恢复浏览器先确认两处附带遗漏并追加修复：隐藏旧AntD Modal后恢复按钮autoFocus被失焦，helper现在先禁用/隐藏旧portal再显式聚焦恢复按钮；管理员自身角色修改成功时旧operation未清，导致保留的隐藏面板仍拦显式reload，现在成功分支先清operation。相应DOM回归均先红后绿，继续保留独立编辑器beforeunload，不将“释放自身锁”当成绕过未保存内容。
- 补修后重新构建/重启、全Shell重跑41文件396项通过，类型通过；最终current revoke/ownAuthority模拟浏览器两完整路径通过：无自动导航、旧portal hidden/inert、stub编辑器实例/正文保留且dispose0、恢复按钮初始焦点/Tab/Escape正常；显式reload触发编辑器beforeunload并可取消，移除编辑器stub guard后无账号/admin自身拦截。current精确1条mock DELETE，ownRoles精确1次reauth/1条mock PATCH，无真实账号变更。证据/tmp/dyoffice-ui-audit/account-security-recovery-final/report.json、report.md与截图，/tmp/dyoffice-account-recovery-final.log；最终构建与全suite日志/tmp/dyoffice-round7-verified-build.log、/tmp/dyoffice-round7-verified-shell.log。
- 发布前核对上一提交0667efa1的GitHub CI：10项工作流检查全部pass，CodeRabbit skipping；此结果不代表本批待提交代码的新CI已通过。

## 编辑器首次入口失败恢复

- 继续处理前轮确认的native入口首次返回错误JSON后无法关闭/重试：DocumentFrame在load时核对同源精确入口URL、application/json或application/problem+json、无脚本、无生命周期API，以及服务端Problem type/title/4xx或5xx结构。只有这个尚未启动编辑器的失败状态显示“重新加载编辑器”，可重新挂载iframe或通过原页签关闭按钮关闭；不显示原始服务端详细信息。
- 首次已收到HTML/脚本或生命周期API后，started永久保留，后续错误JSON不解除保存/关闭保护。独立审查及新增红回归发现，失败后晚出现生命周期时旧失败快照会绕过close/retry，现两入口使用前均重读当前状态；任一生命周期API出现即不允许直接重试，仍要求完整guard。旧load读取当前frame，重复重试同步清entryFailed防重复挂载。iframe失败时显式display:none，避免既有display:block覆盖hidden属性。
- 8项专项通过，最初首次恢复两项先失败，晚出现生命周期回归也先失败后修复；最终全Shell42文件404项、shell及前后端类型、shell构建与边界检查通过。独立只读复核与8项重跑通过。一次中间全suite包含并行添加的late lifecycle红测而失败，完成修复后全suite重跑404项通过；构建chunk提示及DOM CSS解析日志仍存在。
- 本修复仅识别首次入口未启动的错误响应，未把HTML运行时崩溃、已获取租约后的未知状态、网络错误页面或跨源页面强制当成可关闭；这些状态仍保持原生命周期保护。完整UI与复杂文档交互目标继续进行。
- 源码和测试证据：/tmp/dyoffice-frame-red.log、/tmp/dyoffice-frame-lifecycle-red.log、/tmp/dyoffice-frame-final.log、/tmp/dyoffice-round8-final-shell.log、/tmp/dyoffice-round8-final-build.log、/tmp/dyoffice-round8-types.log、/tmp/dyoffice-round8-general-types.log。
- 最终构建真实宿主浏览器首轮6/6通过：两种JSON MIME各首503→Retry200新iframe且恢复拒绝关闭保护、各首503→页签X可关闭；首HTML或已有生命周期后再变JSON均不解锁。全部业务接口/编辑器为mock、无lease请求/意外业务写/页面异常，不声称真实正文保存验收。补查前4项确认错误iframe确实隐藏、提示可见，后两项登录限流而未执行业务，单列而不冒充本次全6重跑；首轮报告从已捕获工具stdout恢复，并记录来源。证据/tmp/dyoffice-ui-audit/native-entry-recovery-postfix/report.json、coverage.md、hidden-supplement-report.json及截图。兼容基线84文件、工具157、IPC538检查通过。

## 只读预览重试与全局配置超时保护

- PDF/XLSX真实宿主模拟浏览器各metadata503/content503共4项确认：原先只有错误提示，无Retry；同ID从首页重开只执行宿主open而不重建预览组件，错误保持。现增加“重新加载预览”，重新读取最新revision元数据，清除旧页/下载地址/错误，复用effect清理来中止旧内容请求与PDF渲染并清空容器。同步loading ref防同tick重复Retry，alive检查拒绝切换后的迟到元数据。4条DOM回归先全失败后通过，覆盖两种失败、最新revision与下载、重复点击、切B后旧A不污染。
- 全局配置原先将HTTP408/503视为确定拒绝，保存按钮仍可提交；实际UI mock408复现两次同expectedRevision PUT。现保存/删除/密钥轮换均将408及5xx保留为unknown，禁止重复写，普通读取/失败或畸形核对不解锁，只有有效显式核对恢复。服务端自产503在事务中回滚，但通用客户端只凭status无法证明它来自源站还是网关，故同样核对；不放宽原CAS保护，也不声称旧bug已证明真实重复提交成功。Global35项通过，新增408/503回归先红后绿。
- 最终全Shell43文件415项、shell与前后端类型、shell构建、边界/兼容清单通过。整合远端bfbf78a7的账号恢复测试辅助与两浏览器流程修改，保留全部远端提交；本批未改主页布局。构建仍有既有chunk提示、DOM仍有既有CSS解析日志。
- 最终Global模拟浏览器11组通过：408保存/删除/轮换、503保存/轮换均unknown禁重提，程序submit不发第二次请求，失败读取不解锁，有效显式核对才恢复且无自动重发；类型/Provider/默认项/dirty/重挂等6组也通过。Sources新增只读5组通过：追加失败保列表/游标、A/B草稿隔离、查询失败旧结果明确标记、发布unknown关闭保护、键盘无背景控件获焦；浏览器边界BODY过渡单列，不误报为焦点逃逸。所有业务请求mock，无真实配置写入。
- 构建覆盖旧静态hash而服务尚未重启的间隙曾使审计登录前拿不到脚本；最终统一build后立即重启HTTP200再复验，未把构建窗口或脚本恢复算成产品失败。完整UI与复杂文档仍在继续验收。
- 证据：/tmp/dyoffice-preview-retry-red.log、/tmp/dyoffice-preview-retry-final.log、/tmp/dyoffice-round9-final-shell.log、/tmp/dyoffice-round9-final-build.log，以及/tmp/dyoffice-ui-audit/下document-preview-recovery、global-config-boundary、global-config-write-fence-final、sources-state报告与截图。
- 预览最终模拟浏览器4/4通过：PDF/XLSX各metadata/content503，Retry再失败后成功；pending重复点击不增请求，切B后释放A不污染B，返回A渲染实际fixture PDF canvas/XLSX文本。成功重试元数据明确更换revision，实际content URL与下载href均为新revision…0099，避免旧版本假恢复。全部文件业务mock，单次登录复用，无页面异常/意外业务写。证据/tmp/dyoffice-ui-audit/document-preview-recovery-postfix/report.json、coverage.md及失败/恢复截图。独立只读源码审查与24项相关回归通过。

## 密码轮换与会话撤销并发保护

- 两条新增回归先红：暂停撤销其他会话请求→修改密码成功→原key重挂卸载会话面板，设置关闭guard错误返回true。改为保持面板实例，用refreshVersion标记读取需求；busy期间不消费版本，原请求结束后读取一次，不丢失revoking/unknown及beforeunload。当前会话撤销成功的ended终态不触发排队刷新。
- 新增成功、unknown且核对读取失败、当前会话撤销三条回归；原有密码成功后刷新当前会话及保留成功提示仍通过。最终Shell43文件418项、shell类型检查、构建、边界1335文件0违规通过；独立只读复核与相关14项通过。构建chunk大小提示和DOM CSS解析日志仍存在。
- 最终构建真实浏览器3组通过：pending期间Escape/关闭及beforeunload均有保护、没有提前GET或重复DELETE；成功后一次读取；unknown后失败读取不解锁，显式成功读取才恢复；当前会话终态进入恢复层且不读取复活。所有密码修改/撤销业务请求mock，无真实密码修改、撤销及配置写入。证据/tmp/dyoffice-rotation-red.log、/tmp/dyoffice-round10-shell.log、/tmp/dyoffice-round10-build.log、/tmp/dyoffice-refresh-version-review.log，以及/tmp/dyoffice-ui-audit/password-session-concurrency/report.json与截图。
- 上一提交9c2f3cd7的远端native-docx检查出现失败，正在独立核查；不以本地Shell通过代替DOCX端到端通过。完整UI与复杂文档交互目标继续，未宣称穷举完成。
