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
| 首页/文件树 | 搜索/清除/空结果、格式筛选、排序、行与全选、批量删除取消、重命名取消、移动取消、树选择、新建文件夹取消、工作区位置导航 | 位置祖先读取失败/迟到已补查；仍缺实体触屏、完整读屏器顺序及跨窗口导航 |
| 页签 | 新建菜单、页签列表、首页与 Word 切换、右键关闭、保存状态/租约释放；真实 Word 编辑保存 | 16个PDF溢出及混合四格式竞态已有mock证据；真实多编辑器复杂内容/保存组合仍待补查 |
| 上传 | 桌面/小屏、拖拽/多选/移除/取消、不支持格式、32 MiB 限制、串行处理、处理中防重入与关闭、真实 PDF 上传后应用内打开 | 同名/混合413/415/连接中断已有mock证据；真实配额耗尽与全部损坏文件格式仍待查 |
| 个人设置 | dirty 拒绝关闭、跨 tab guard、偏好读取保存、密码/会话 pending/unknown 组件保护 | 真实改密轮换/会话撤销完整流程已通过隔离 PG/浏览器；仍需多端复杂并发 |
| 技能 | 37 项目录与分页、中英文搜索/格式筛选、正文预览、真实安装刷新保留/防覆盖、导入分类、unknown 后核对/失败 | 全部技能正文与真实模型工具执行；不将任务说明当能力证明 |
| 用户管理 | 搜索/状态、创建/权限操作组件、dirty 与一次性码切换、408/unknown 保护、小屏滚动 | 隔离 PG 真实管理员创建/激活/重置/禁用/自降权已通过；复杂并发仍待查 |
| 回收站 | 搜索/状态、确认取消、恢复/永久删除组件、unknown fence、内部滚动 | 页码归一化已组件及浏览器模拟验证；真实测试文件删除/恢复/永久删除已通过，原文件夹和收藏保留，测试文件与空目录已清理 |
| 数据连接 | 仅三类数据库、草稿 JSON/友好字段、凭据 retain/replace/clear、保存冲突/unknown、测试/发布组件、结果意图、离开保护 | 浏览器JSON下载已实际接收核对；仍缺外部数据库连通/只读授权的独立真实集成 |
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

## 技能菜单读取恢复与管理弹窗小屏错误可见性

- 独立动态诊断确认：共享AI技能菜单原先把listSkills拒绝显示为“还没有安装技能”，没有加载提示或原位重试。关闭后重开，旧请求迟到失败也会清空新列表。新增回归先红后绿：分离加载/失败/空列表，使用固定多语言错误文案和重试，读取代次隔离旧成功/失败，不反射上游详情。菜单任意控件Escape关闭并恢复添加按钮焦点，重试时焦点转回搜索框，避免移除重试按钮后丢失键盘位置；这两处焦点回归也先红后绿。
- 真实native DOCX及助手桥接的隔离PG浏览器5组通过：GET503区别于空账号、Enter原位重试且pending重复Enter不加GET、成功可选、旧成功及旧失败迟到各自不污染重开结果、错误按钮Escape焦点恢复。全部使用测试fixture并自动清理，无用户部署写入。旧CI首次alice-report菜单超时在旧单项及旧完整native-docs套件未复现，尚无证据将它归因于本次吞错问题；保留远端4405d766的有界状态诊断提交，不放宽断言或超时。
- 320×568真实宿主mock只读审计确认数据连接首次/再次列表503错误原位于长表单末尾y1078..1119。共用错误Alert移到source-body之前，保留原成功提示与unknown/身份核对逻辑；page/dialog两条顺序与刷新恢复回归先红后绿。最终小屏3弹窗复验均通过：数据连接两次失败提示y119.66..160.5首屏可见，无横溢，24步Tab无背景可操作或屏外控件，Escape关闭并回账号入口；用户管理/回收站错误仍可见。业务写入0、pageerror0；浏览器边界BODY焦点过渡未当作背景控件逃逸。
- 最终Shell43文件420项、共享UI26文件214项、Docs534文件6561项通过（另4文件20项按原条件跳过），共享UI/shell/Docs类型检查通过。shell、DOCX、PPTX渲染构建通过；XLSX渲染构建通过但gateway阶段被旧root所有的生成文件阻止，保留该文件为ignored备份后单独gateway构建通过，统一重启HTTP200。无业务源码权限改动。构建仍有既有chunk/Rollup注释提示，DOM仍有CSS解析及canvas未实现日志。边界1335文件0违规、兼容84、工具157、IPC538检查通过。
- 远端4405d766账号CI失败日志为npm下载ECONNRESET（基础单元13项已过、集成未执行），已只重跑失败任务；不改业务代码。远端native-docx与其他长任务尚待最终状态。完整UI、复杂文档交互与跨刷新未知结果恢复目标仍进行中。
- 证据：/tmp/dyoffice-skill-menu-red.log、/tmp/dyoffice-skill-menu-escape-red.log、/tmp/dyoffice-skill-menu-retry-focus-red.log、/tmp/dyoffice-round11-ui-final.log、/tmp/dyoffice-round11-shell.log、/tmp/dyoffice-round11-docs-tests.log；/tmp/dyoffice-ui-audit/native-skills-menu-error/报告及截图；/tmp/dyoffice-ui-audit/management-small-error/旧证据与management-small-error-postfix/最终报告及截图。最终native-docs完整端到端另行记录。
- 最终本地native-docs全套9项中8通过/1按既有外部Provider条件跳过/0失败，67.64秒；真实编辑commit/refresh/保留原parts、延迟保存较新草稿、takeover、未知保存receipt、私有技能Provider Gateway发送等通过，日志/tmp/dyoffice-native-docs-final-suite.log。账号CI网络失败重跑已success，4fbcb680的native-docx也已success；当前4405d766的长任务仍在运行，不将旧提交结果冒充本批新CI。

## 文档内配置入口与 PDF 小屏横滚

- 原共享editor assistant的openSkillsSettings/openAiModelSettings调用当前iframe的location.assign('/')；组件回归初始3项未调用host/未解释standalone，宿主入口初始4项未安装能力，均先红。现用Web专用同源parent能力请求宿主AntD配置弹窗：技能直接选个人技能，模型仅管理员可打开全局配置；限定已挂载文档frame身份，同步会话失效及恢复态拒绝，卸载清理入口。已打开其他配置的dirty/pending closeGuard拒绝时保留原弹窗；同一个人设置切技能不重挂，偏好草稿和技能guard均保留。独立原生/缺宿主/跨源入口显示友好提示，不导航。
- 个人设置受控页签DOM回归确认默认账户页、修改作者后切技能仍同一input节点/值且关闭保护有效；正常从头像重开保持账户页默认。8项真实入口源码绑定/恢复测试通过，API/受控Tabs等专项13项通过。红测摘录/tmp/dyoffice-ui-audit/editor-settings-red/evidence.md注明为已捕获工具输出摘录，不冒充完整初始stdout。
- 320px PDF原始canvas595px使整个预览section横滚；键盘连续ArrowRight可令下载按钮移至x=-181..-93，标题/提示也移走。将PDF宿主限制在卡片内容宽度内独立横滚，新增可聚焦的“PDF 页面”region；新回归先红，7项预览生命周期/重试相关通过，保留abort/destroy清理和下载地址。
- 最终PDF2组与Office4组真实宿主mock浏览器通过：320 PDF从下载Tab到region，ArrowRight仅region left413、外section left0及scrollWidth/clientWidth320；标题/下载不再横向移走。Tab聚焦高region会引起原生纵向显露滚动，横移测试仅重置纵scrollTop，未声称标题吸顶。1440 PDF无需横滚；XLSX两尺寸表内键盘滚动、PPTX两尺寸错误Enter重试通过。0业务写、0pageerror。mock原URL下载均canceled而Blob同字节下载成功，作为模拟链限制单列，不判定产品下载故障。
- 最终Shell45文件427项通过，Web388项中387通过/1既有条件跳过，shell/前后端/Docs类型、shell及DOCX构建、边界1335文件0违规、兼容84/工具157/IPC538通过。构建仍有既有chunk提示，DOM仍有CSS解析日志。共享assistant涉及XLSX，另补Sheets最终构建及重启。
- 远端280b0ee7的boundary-check失败发生在login-history浏览器第三次登录按钮点击前，无第三次业务请求；扫描本身0违规，现有日志不能证明认证服务错误，保留待查。PPTX文件菜单另有SaveAs/PDF/Print/图片导出可达性源码候选，尚未经真实菜单复现，不当作已确认修复。完整入口穷举仍在进行。
- 证据：/tmp/dyoffice-round12-shell.log、/tmp/dyoffice-round12-web.log、/tmp/dyoffice-round12-bindings.log、/tmp/dyoffice-pdf-scroll-red.log；/tmp/dyoffice-ui-audit/document-preview-layout/初始报告、document-preview-layout-pdf-isolation/反例、document-preview-layout-pdf-postfix/与document-preview-layout-office-postfix/最终报告；/tmp/dyoffice-ui-audit/native-menu-readonly-notes.md。
- 最终隔离PG真实Shell+DOCX组合浏览器1/1（3组）通过，pageerror0：可见label关闭自动保存后，三次管理技能均打开父个人技能页，iframe/contentWindow标记与未保存文字不变；每次操作核对服务器revision仍为导入原值、iframe beforeunload仍阻止离站。偏好dirty取消关闭保留设置及文档草稿，普通用户模型兼容入口显示权限提示而不导航。管理员模型弹窗仅入口绑定测试覆盖，不声称真实管理员浏览器流程。报告/tmp/dyoffice-ui-audit/native-shell-assistant-settings/report.md及JSON、final.png；日志/tmp/dyoffice-native-shell-assistant-settings.log。仅隔离fixture写入并清理，无用户部署数据变更。脚本准备时两次个人文件定位/隐藏checkbox点击错误均已定因为测试选择器，不作产品失败。Sheets最终构建及主服务重启HTTP200通过。

## 登录按钮名称与窄屏文件入口补查

- 原登录历史测试在隔离PG单独运行通过，但真实时序诊断发现401后按钮已无loading class/disabled时，AntD退出动效仍含role img、aria-label loading；Playwright ariaSnapshot实际为“loading 登录”。专用真实Login+AntD Chromium回归先红（Expected登录 / Received loading登录），现仅给Login提交按钮显式aria-label（未登录/已认证恢复分别为登录/重新加载工作区）及aria-busy；保留原loading、pending guard、submit和exact-role点击，不改超时。
- 最终源码对应shell构建后，原login-history与新login-accessibility两套2/2通过：原账号隔离/私密投影断言保留；新回归验证pending时名稳定/busy true、重复原点击不加登录调用、401后原点击可重试、已认证恢复名及busy变化。仅证明名称和忙碌语义修复，不将原CI30秒点击超时全部归因于短暂退出动效。保留远端bbbeeb93新增有界诊断及测试，覆盖图标、hidden/inert和点击区域，仅计数/布尔不输出凭据。
- 当前PPTX原生菜单候选经权威服务端约束排除为当前可达入口：buildLocalApp明确拒绝nativeSlidesDirectory/slidesHost，隔离fixture同样启动失败PPTX_OS_ISOLATION_UNAVAILABLE，未绕过边界或修改未来原生菜单。当前应用PPTX预览已另验收。
- 320/390首页文件名并非长名特例，短名也被固定修改时间列挤成0px，名称点击超时，更多初始离屏。Web专用<=680px样式保留checkbox/name/star/more四列，隐藏格式图标和修改时间的显示，桌面/侧栏布局不改；文件格式仍可由名称/筛选确认，收藏与更多操作保留。最初浏览器反例与临时CSS对照均保留。
- 最终无CSS注入、已构建产品浏览器320/390/1440×长短名6/6通过：名称鼠标点击、行Enter、勾选取消、更多/Escape、Space模拟收藏再取消。320名称36px、390名称74.5px，仍受原侧栏空间约束而省略但可点击；行无横溢，更多可见。1440名称618px且原图标/时间可见，几何不变。内容区工具栏仍可能横滚，未声称整个首页已无横溢。0真实业务写/0pageerror，复用storageState无新增登录。
- 证据：/tmp/dyoffice-login-accessibility-red.log、/tmp/dyoffice-login-accessibility-green.log、/tmp/dyoffice-login-history-timing.log、/tmp/dyoffice-login-final-dist.log、/tmp/dyoffice-login-final-evidence/build-evidence.json；/tmp/dyoffice-ui-audit/home-file-entry/原始反例、home-file-entry-css-preserve-star/对照、home-file-entry-postfix/最终报告及三尺寸截图。完整UI穷举仍进行中。
- 整合远端诊断后最终Shell46文件431项、shell类型、登录诊断helper5项、边界及三类清单通过，最终shell构建重启HTTP200通过；仍有既有chunk/CSS解析提示。远端bbbeeb93的boundary-check日志进一步捕获相同状态：第2次login-click前仅1次401请求完成，loadingIcons1、loadingSubmits0、disabled0、hidden/inert0、submitHasBox/submitCenterHit均true、explicitLoginLabelfalse；与实际“loading 登录”时序一致。本批显式名称使图标不再改变按钮可访问名，但不解释动效为何在CI持久残留。日志/tmp/dyoffice-round13-remote-boundary.log、/tmp/dyoffice-round13-final-shell.log、/tmp/dyoffice-round13-diagnostics.log。
## 个人偏好保存结果保护补查

- HTTP 408 原先被当作确定拒绝，允许立即重提；保存前发起的旧读取迟到返回，也会解除后续保存结果未知的保护。客户端现在将 408 保持为结果未知，并以写入代次限制读取解锁；失败或畸形读取仍不能解锁。未修改主页或真实用户配置。
- 新增回归最初 7 项中 2 项失败，修复后本轮重跑 7/7 通过；覆盖 408/503、失败及畸形读取、有效读取恢复和旧读取竞态。Web 测试 388 项中 387 通过、1 项既有条件跳过，工作区类型检查通过，边界扫描 1335 文件 0 违规，git diff --check 通过。证据：/tmp/dyoffice-preferences-fence-red.log、/tmp/dyoffice-preferences-fence-green.log、/tmp/dyoffice-commit-preferences-web.log、/tmp/dyoffice-commit-preferences-type.log。本批未补做浏览器端到端验收。
- 并行只读审计仍有待处理问题：小屏排序入口被隐藏；文件/文件夹删除确认可 Tab 到背景，关闭后焦点未恢复；移动选择器焦点循环正常但关闭后焦点未恢复。缺失文件确认存在同类问题，但该入口仅由模拟标志覆盖。证据：/tmp/dyoffice-ui-audit/home-toolbar/coverage.md、/tmp/dyoffice-ui-audit/home-dialog-focus/report.json。搜索、清除、五种格式筛选和批量按钮三尺寸可操作，0 真实业务写入。以上未修复项不计入本次修复范围，完整 UI 穷举未完成。

## 首页文件弹窗键盘焦点保护

- 文件/文件夹删除确认和缺失文件确认原先没有 Tab 循环，真实浏览器可进入背景控件；这三种确认与移动选择器关闭后均未恢复入口焦点。现复用共享 trapTab，确认弹窗激活期间在 window capture 接收 Tab；打开前记录持久的行/文件夹菜单按钮、批量按钮或缺失文件行，关闭后恢复焦点，主页布局不变。
- 初版仅在弹窗节点处理 Tab，静态四场景已通过，但补充 pending 浏览器发现确认按钮禁用后焦点落到 body，事件不再经过弹窗；320/1440 两组均可进入背景。最终改为仅在确认激活期间监听并在关闭/卸载清理，焦点在外时返回首/尾可用按钮。DOM 显式模拟 Chromium 的 body 焦点；jsdom 对已禁用按钮 blur 不模拟此行为，曾据诊断修正测试模拟，未把该 harness 差异当作另一个产品问题。
- 新增最初四条回归全部先失败后通过，补充 pending 回归也先红后绿。最终 Shell 46 文件 436 项、工作区类型、构建、边界检查通过；独立只读复核无阻塞。构建仍有既有 chunk 提示，DOM 仍有既有 CSS 解析日志。证据：/tmp/dyoffice-home-dialog-red.log、/tmp/dyoffice-home-dialog-pending-body-red.log、/tmp/dyoffice-home-dialog-pending-body-green.log、/tmp/dyoffice-dialog-final-shell.log、/tmp/dyoffice-dialog-final-type.log、/tmp/dyoffice-dialog-final-build.log、/tmp/dyoffice-dialog-final-boundary.log。
- 最终构建重启 HTTP200 后真实 Chromium 4+2 组通过：文件/文件夹删除、移动、模拟缺失文件确认的双向 Tab 与立即/循环后 Escape 均保持或恢复焦点；320/1440 批量删除取消和遮罩关闭恢复原按钮，pending Tab 保持弹窗内。四普通场景 0 业务写，pending 两组各 1 条 held mock DELETE 后返回 409，无真实删除、无页面异常。缺失文件标志仅由 mock 投影，不声称真实 API 当前产生此入口。证据：/tmp/dyoffice-ui-audit/home-dialog-focus-postfix/report.json、home-dialog-focus-pending/report.json；最终日志 /tmp/dyoffice-dialog-final-browser.log、/tmp/dyoffice-dialog-final-pending.log。
- 并行更多菜单审计三尺寸通过：重复开关、方向键循环、Escape 焦点恢复及五入口键盘激活；重命名 Escape 后虽然 activeElement 为 body，下一 Tab/Shift+Tab 仍在同一文件行，未据此扩大修复。0 真实业务写、0 页面异常。证据：/tmp/dyoffice-ui-audit/home-more-menu/coverage.md、home-more-menu-rename-focus/report.json。小屏排序入口仍待修复，完整 UI 穷举目标保持进行中。

## 窄屏排序入口与排序字段审计

- 320/390 像素下修改时间排序入口被 Web 响应式样式整体隐藏；红测两尺寸均无法找到可见按钮，1440 对照通过。现仅在窄屏表头右侧两个操作列的空间保留原排序按钮，以图标显示、保留可访问名称并提供修改时间 tooltip；隐藏空占位单元格，不占用文件名列，不恢复固定宽度的时间数据列。
- 最终 shell 构建重启 HTTP200，320/390/1440 × 最近/文件夹两视图 6/6 浏览器通过：按钮可见、鼠标选择最早、键盘 Enter/Tab 选择最近、菜单不超视口、表头无横向溢出。文件名宽度仍为 36/74.5/618px，桌面表头高度40px，窄屏表头44px；菜单截图已人工查看。全部业务请求 mock，0 写入、0 页面异常。定向 Home/文件夹菜单 75 项、工作区类型、构建及边界1335文件0违规通过。仍有既有 CSS 解析与构建 chunk 提示。
- 证据：/tmp/dyoffice-sort-entry-red.log、/tmp/dyoffice-sort-entry-final-browser.log、/tmp/dyoffice-sort-entry-shell.log、/tmp/dyoffice-sort-entry-type.log、/tmp/dyoffice-sort-entry-final-build.log、/tmp/dyoffice-sort-entry-boundary.log；/tmp/dyoffice-ui-audit/home-sort-entry-red/report.json、home-sort-entry-final/report.json 及三尺寸两视图截图。本批只恢复入口，不将同序 fixture 排序通过冒充不同时间字段的逻辑修复。
- 并行 55 文件审计排除了“最早只反转前50且无法取得尾页”的猜测：现有 effect 会主动读取尾5条并无重复。但确认另一待修逻辑问题：recent API 以最近打开时间排序，而列表显示的 mtimeMs 来自修改时间；选择修改时间菜单仅 reverse API 顺序，打开与修改顺序相反时，最早/最近均错误。Web 总数没有原 PC 注释所称100条上限，不能靠拉全库再本地排序长期解决。
- 下一修复应保留缺省最近打开顺序，仅在用户显式选择修改时间排序时沿 RecentQuery、Web bridge、WorkspaceFileQuery、route schema、service 传递严格枚举 modified-asc/modified-desc；服务端按固定映射 updated_at ASC/DESC,id 稳定分页，切排序重置第一页并隔离旧响应，Web不再为最早拉全。共享PC行为须保留。需验证打开/修改逆序、55条分页、迟到旧尾页及缺省API不变。当前该逻辑尚未实施，完整UI穷举目标保持进行中。证据：/tmp/dyoffice-ui-audit/home-sort-pagination/coverage.md、report.json及对照截图。

## 修改时间稳定分页排序与排序菜单 Escape

- 已修复上轮确认的字段错用：Web 缺省 recent 继续以最近打开时间排列；首次菜单不虚假标记已选择修改时间。显式选择最近/最早后，RecentQuery、Web bridge、WorkspaceFileQuery、HTTP schema、service 传递严格枚举 modified-desc/modified-asc，SQL 从固定字面量映射 updated_at DESC/ASC,id。切换排序清空第一页、递增既有请求代次，后页和已加载150条刷新均保持同sort；Web不再reverse或为最早主动拉完全部文件。目录既有完整有界列表按mtimeMs/path排序。共享桌面组件只有Web显式capability启用新行为，桌面原查询及反转逻辑保留。主页布局未改。
- 后端新3条回归先合法sort HTTP400失败后修复；与原workspace-paging及workspace共19/19真实隔离PG通过：打开/修改逆序、55条首50/尾5、相同修改时间按id稳定、all/recent/starred/trash、folder/q/ext/count、其他账号隔离、非法枚举直接调用及HTTP拒绝。fixture临时数据库/角色/对象目录teardown正常，无用户部署数据写入。日志/tmp/dyoffice-workspace-sort-red.log、/tmp/dyoffice-workspace-sort-green.log、/tmp/dyoffice-workspace-sort-types.log。
- 前端新增3条及bridge两视图回归均先红后绿：缺省不传sort、显式请求与显示顺序、50+5不主动拉全、旧尾页迟到不混入新序或解除新锁、目录mtime排序与桌面兼容、150条refresh的两次bounded请求sort一致。证据/tmp/dyoffice-sort-home-red.log、/tmp/dyoffice-sort-home-green.log、/tmp/dyoffice-sort-bridge-red.log、/tmp/dyoffice-sort-bridge-green.log。
- 浏览器首轮排序逻辑通过但暴露菜单Escape完全不关闭；未将trigger再次点击替代Escape当成验收。新增DOM回归先红后绿，现纳入Home已有Escape关闭逻辑，关闭后聚焦sort trigger。最终构建重启HTTP200后，320/1440真实Chromium均硬断言Escape关闭且焦点返回，再完整重跑默认recent、显式asc首50无拉全、旧asc尾页hold切desc/迟到隔离、新desc尾页锁释放、asc/desc完整55、Starred分页及目录排序，全部通过。0真实业务写、0页面异常，无新增登录。报告/tmp/dyoffice-ui-audit/home-server-sort-postfix/report.json、coverage.md及截图；红绿/tmp/dyoffice-sort-escape-red.log、/tmp/dyoffice-sort-escape-green.log。
- 扩大全量unit首次发现两处既有测试入口失败：Node原生transform runner不能解析bridge无扩展名file-events导入；端口guard误把仅setContent+addScriptTag且不启动服务器的Login组件测试当作服务fixture。前者补明确.ts扩展，原生runner53项通过；后者新增正/反case先红后绿4/4，仅纯内联且没有listen/goto/serve/buildLocalApp的fixture可无端口，有实际端口的碰撞/无效值/监听与安全origin不一致检查保留。未改登录断言或排除整个检查。证据/tmp/dyoffice-sort-final-unit.log（初次失败）、/tmp/dyoffice-sort-bridge-native-node.log、/tmp/dyoffice-local-browser-ports-red.log、/tmp/dyoffice-local-browser-ports-green.log。
- 最终Shell46文件440项通过、全unit706项中702通过/4条件跳过、Web388项中387通过/1既有跳过，前后端及shell类型、最终shell构建、边界1335文件0违规、兼容84/工具157/IPC538通过。独立完整diff及Escape增量只读复核无阻塞；既有CSS解析与chunk提示保留。日志/tmp/dyoffice-sort-final-shell.log、/tmp/dyoffice-sort-final-unit-green.log、/tmp/dyoffice-sort-final-web.log、/tmp/dyoffice-sort-shell-final-type.log、/tmp/dyoffice-sort-web-final-type.log、/tmp/dyoffice-sort-final-build.log、/tmp/dyoffice-sort-final-boundary.log。本批证明排序相关流程，未将其等同完整UI穷举，复杂文档及触屏/读屏组合等仍需继续审计。

## 冻结结果下载、触屏与页签并发补查

- 冻结结果 JSON 下载在390/1440各成功、503重试、关闭后迟到三组，共6/6通过。真实接收浏览器下载，UUID.json文件名、373字节与冻结snapshot逐字节一致，中文/emoji/数字及等号开头字符串保持JSON原值。重试只重读同一结果，不重新查询或保存；关闭后释放暂挂读取没有迟到下载。来源/查询/保存/content均mock，0真实业务写、0页面异常，无新增工作区结果入口。证据：`/tmp/dyoffice-ui-audit/source-result-download/{report.json,coverage.md}`、`/tmp/dyoffice-source-result-download.log`。
- 320/390移动touch context的五配置弹窗主轮10/10及Admin/Trash表格纵滑补证4/4通过。真实tap、横/纵touch手势可达Tabs、Select、取消确认和屏外保存入口；四类dirty外点不关闭、X确认拒绝保留值。表格纵滚不移动footer，来源保存入口触滑后可见但未提交。0真实业务写、0页面异常。原生confirm由Playwright响应，不冒充实体手机物理点击。证据：`/tmp/dyoffice-ui-audit/config-touch/coverage.md`及report、`config-touch-table-scroll/report.json`。
- 当前可达DOCX/PDF/XLSX/PPTX混合页签并发6组通过：鼠标/键盘菜单操作后台目标，重复关闭共享guard且拒绝保留正确页签，失败重试加载保护，晚到打开/预览读取不抢焦点或复活已关闭页签，内嵌设置开关后实例与guard保留。PDF/XLSX/PPTX使用真实预览组件，DOCX为生命周期stub，不能证明真实编辑保存/租约；未测试当前不可达原生PPTX菜单。0意外写、0页面异常。证据：`/tmp/dyoffice-ui-audit/tabs-concurrency-current/report.md`及report.json。
- 可访问名称读取覆盖Home、五管理弹窗、个人三子页及全局新草稿/用户创建和角色/连接高级区域，未发现可见交互入口空名；账户安全重复会话未逐一键盘遍历。实际点击确认五个通用偏好label未关联对应控件，另行修复并验证，不能由aria-label正确推断标签可点击。初始证据：`/tmp/dyoffice-ui-audit/accessibility-names/findings.md`及`labels-drafts.json`。

## 用户管理翻页失败保留已加载成员

- 新增组件回归先红：成功读取Alice及下一页cursor，后页读取失败后Alice与下一页入口均消失。390/1440真实Chromium mock重复确认两尺寸相同问题，pageerror/业务写均0。根因为refresh(after)的catch把append失败也按首次加载失败清空users/cursor。
- 最小修复仅在没有after的首列表失败时清空；后页失败保留旧rows/cursor，错误照常显示，pending/unknown锁和首列表/写成功后刷新失败行为保持。组件完整19/19通过，独立只读复核无阻塞。最终构建浏览器两尺寸直接点击原下一页重试成功，Alice+Bob均可见、错误消失、末页入口消失，实际请求序列为首列表/同cursor失败/同cursor重试，无重复首列表读取。证据：`/tmp/dyoffice-admin-paging-{red,green}.log`、`/tmp/dyoffice-admin-paging-browser-{red,green}.log`及`/tmp/dyoffice-ui-audit/admin-pagination-{red,green}/report.json`。
- 期间发现远端新增34dabefa会话绑定偏好修复，已精确对象校验后fast-forward保留；没有覆盖远端改动。合入后本地最终Shell47文件443项、偏好会话路由/生命周期9项、shell类型、构建及边界1336文件0违规通过。仍有既有DOM CSS解析及构建chunk提示。完整UI穷举目标保持进行中。

## 个人偏好标签关联控件

- 五个Form.Item标签原无htmlFor，对应label.control均为null；点击后只聚焦页签容器。控件已有aria-label，不属于空可访问名称。新增实际关联和开关标签点击回归先红后绿，useId隔离实例，分别配对htmlFor/id，未改变偏好读写和dirty逻辑。设置组件6/6通过，包含标签切换只改变草稿而不自动保存。
- 最终构建390/1440浏览器共10个标签均关联且点击聚焦正确控件，两开关实际切换；关闭dirty弹窗拒绝确认后仍保留。0业务写、0页面异常，已目视390偏好截图。测试脚本首次在作者输入后无条件Escape关闭了整个配置弹窗，已改为仅展开Select时Escape并完整重跑，不将该脚本错误记为产品缺陷。证据：`/tmp/dyoffice-ui-audit/settings-label-postfix/report.json`、`/tmp/dyoffice-settings-label-browser.log`，组件红测见本轮工具输出（未另存完整stdout），最终组件结果包含于`/tmp/dyoffice-paging-label-final-shell.log`。

## 共享 Cookie 双页偏好恢复补证

- 同一Chromium context两页、全部API mock，三场景通过：普通权限403两次确定拒绝保留草稿且不误开恢复；A可见密码表单触发mock HttpOnly Cookie轮换，B晚到PUT被拒绝；跨账号Cookie后B晚到GET被拒绝。session-proof依据每次请求实际携带的合成Cookie，未用仅共享变量代替跨页Cookie传播。
- 两轮换场景恢复层阻止后续写网络请求，保留dirty、同一DOCX生命周期stub及0 dispose，Tab/Escape与beforeunload保护保持。0页面异常、0未拦截API，未真实登录/改密/写业务。不将此证明为真实原生编辑器或真实认证服务验收；同页verified rebind的unknown fence另由组件/路由测试覆盖。合成首页列表存在无关读取alert，断言限定设置入口，未据此修改产品。证据：`/tmp/dyoffice-ui-audit/shared-cookie-preferences/{report.md,report.json}`。
- e1508d8c修复发布后补跑Web397项，396通过/1既有条件跳过/0失败，日志`/tmp/dyoffice-paging-label-final-web.log`。此补证不代表完整UI穷举完成，原生PPTX当前不可部署、复杂原生文档和实体移动/读屏组合等证据缺口仍保留。

## 位置导航意图取消

- 浏览器确认同一竞态的成功/失败两例：最近文件点击“打开所在文件夹”，暂挂祖先目录读取后用户切树B，释放旧请求会从B回跳A/C；旧503则在B显示旧错误。普通父读取失败后重试可定位，为正常对照。新Home8组与bridge3组先红，再最小加入Web专用AbortController；显式切目录/最近/收藏/筛选/搜索/打开其他文件、新reveal及卸载时同步取消，旧catch不报错。桥接初始和每个await后检查signal，取消后不继续读取、激活Home或派发reveal。桌面调用仍单一路径参数，不把AbortSignal送入IPC。
- Home83/83、bridge57/57、桌面退役边界4/4、shell类型通过。最终shell构建重启HTTP200，三组真实浏览器全部通过：正常重试定位并选中文件；旧成功和旧失败放行后仍选中B、只显示B文件、无旧错误。API全部mock且均GET，0页面异常、0未拦截请求。证据：`/tmp/dyoffice-reveal-{home-green,bridge-green,typecheck,desktop}.log`、`/tmp/dyoffice-reveal-browser-green.log`、`/tmp/dyoffice-ui-audit/home-location-concurrency-postfix/report.json`；初始红观察详见同名无postfix目录report.md，JSON已被最终运行更新。

## 原生 Word 弹窗键盘与 AI 命名能力

- 真实隔离PostgreSQL/HTTP/native DOCX fixture，390/1440打开缩放弹窗点击h2→焦点BODY→Shift+Tab均逃到背景，Tab正向恰好由浏览器顺序进入。新增外焦点正反Tab组件两条先红后绿，现窗口fallback在焦点外时接回trap；独立复核又确认多个同层hook的初版会互抢中间Tab。追加三控件同层红测，稳定挂载顺序且父backdrop位于子层之前，仅最上层处理键盘；补卸载恢复lower与嵌套子effect先挂载回归。相关7文件45项通过；独立DOM复核中间Tab不prevent/抢焦点，嵌套循环正确。
- 最终native构建的隔离fixture四场景全部通过，正反Tab均留弹窗，Escape正常关闭，0页面异常；测试临时数据库/角色/对象目录随fixture清理，没有用户部署数据写入。证据：`/tmp/dyoffice-native-dialog-keyboard-{red,green}.log`、`/tmp/dyoffice-ui-audit/native-dialog-keyboard-{red,green}/report.json`、`/tmp/dyoffice-docs-modal-{keys,stack}-{red,green}.log`、`/tmp/dyoffice-docs-dialogs-final.log`。既有trapTab隐藏/inert控件过滤局限另有诊断，未在本次实际缩放弹窗确认，不据helper探针扩大成实际入口bug。
- DOCX文件菜单“以AI命名…”原先在Web可点击，但缺aiNamingApi时返回空名称并静默退出；后续另存为也无Web实现。正式renderer/mock DOCX及lease复现无命名请求/反馈，0真实业务写。现遵循desktopActionsAvailable禁用Web入口并给中英文说明，PC既有命名行为保留。两语言菜单行为先红后绿，命名/转换9项及Web docs-entry类型通过；最终构建浏览器确认disabled/title/菜单保留，0页面异常。证据：`/tmp/dyoffice-ui-audit/word-capability-readonly/findings.md`、`word-capability-fix/{red.log,green.log,web-docs-typecheck.log}`、`word-capability-postfix/report.json`。全桌面docs类型检查仍因缺少Electron依赖及桌面导出诊断失败，不声称全桌面类型通过。

## 上传异常扩展

- 三组mock浏览器通过：相同文件名按不同队列ID/大小独立处理，413/415及content连接中断只终止当前项、继续尾项；手动重新添加只提交新项，不重发旧成功/失败项。finish已提交但response中断后，在个人文件夹重新GET可核对文件，未打开文件不应出现在recent；无自动重传。关闭上传后旧preview迟到不污染新队列，边界为preview有ERR_ABORTED，不声称正常关闭允许upload finish迟到。
- Space选择器恰好一次、DataTransfer drop及Enter均通过；0真实写、0页面异常，预期网络错误明确记录。未发现新确认问题。证据：`/tmp/dyoffice-ui-audit/upload-recovery-expanded/{coverage.md,report.json}`。

本批最终验证：Shell47文件451项、bridge57项、DOCX全量534文件6567项通过（另4文件20项既有条件跳过），shell/Web DOCX类型、shell/native DOCX构建、边界1336文件0违规、兼容84文件0变更通过。仍有DOM CSS/canvas及构建chunk日志。远端新增6fd21129只包含Provider结算时序测试，已fast-forward保留，隔离PG pipeline21/21通过。其native-docx助手测试远端与本地均120秒超时，不能据当前结果声称原生全套通过；本地roundtrip其他场景仍在运行，助手等待阶段正在补有界诊断，原owner/settled/私人技能/原件断言均保留。

## Native DOCX 助手结算等待修复

- 远端6fd的response.finished新增等待在CI120秒整体超时，本地同样复现；固定阶段诊断将其缩小到first-response-finished。20秒后快照确认stopButtons=0、reservationCount=1、allOwned=true、allSettled=true，网络finished仍pending，未以文本出现当完成。浏览器transport收到SSE done便结束回调并cancel reader，网络EOF不是此客户端的可靠结算屏障。
- 远端随后新增5dede6ec诊断已合入保留，放弃本地重复helper改动；仅把两处finished改为有界终态UI和精确预算数量/owner/state核对，首轮1条、次轮2条；最终原有两条精确settled记录、私有Skill不串账号、模型wire和原件字节断言保持。没有重试或放宽120秒总时限。与远端诊断合并后隔离PG/Chromium单suite1/1通过，8.15秒；此前同一最终产品构建的roundtrip6/6通过。
- 证据：`/tmp/dyoffice-assistant-phase-finished-pending-red.log`、`/tmp/dyoffice-assistant-phase-isolated.log`、`/tmp/dyoffice-navigation-native-docs-suite.log`。这修复测试错误屏障，不宣称新增用户可见能力；本批native-docx CI需以新提交重跑结果为准。

## 切换文档取消位置导航与连接测试状态

- 真实 Chromium/mock API 先复现：Home 的位置读取暂挂期间选择已打开的文档页签，旧成功会抢回 Home，旧失败会在回到 Home 后显示过期错误。现仅 Web 订阅活动页签变化并复用 cancelReveal；后台重命名且 Home 仍活动时不取消，PC 不新增订阅，卸载退订。新增三组回归，Home 86/86通过；最终构建旧成功/失败两组均保留文档页签、无旧错误、无页面异常。DOCX 为生命周期 stub，不代替真实编辑验收。证据：`/tmp/dyoffice-ui-audit/home-location-cross-tab{,-postfix}/report.json`。
- 数据连接测试返回 ok:false 原先显示绿色 success；现按既有 code 显示 error。三类 code 回归先红后绿，之后成功清除错误；Sources32/32通过。最终构建390/1440各三种失败及随后成功通过，0页面异常、0未拦截写请求。全部连接业务 mock，不探测真实数据库。证据：`/tmp/dyoffice-ui-audit/source-test-status-{red,green}/report.json`。
- 独立只读复核 Home、Sources 及 identity fence 共125项通过，无阻塞。最终全 Shell47文件457项、shell类型/构建、Web边界1336文件0违规、兼容输入84文件0变更通过。既有CSS解析及chunk提示保留。

## PDF 多页异步补查

- PDF.js真实worker、三页fixture及业务mock，两组通过：第二页GetPage延迟时切XLSX并从1440缩到320，放行不抢页签；返回PDF可滚到第三页。关闭pending PDF后旧回调不复活，重开三页正常。0页面异常、0真实写。证据：`/tmp/dyoffice-ui-audit/preview-multipage/{coverage.md,report.json}`。不代替任意复杂PDF或实体移动设备验收。

## Word 远程图片粘贴失败恢复

- 正式native renderer/mock文档及lease确认：只有远程img HTML而无bitmap的粘贴，在Web fetchImage拒绝时吞掉URL且产生未处理异常，没有可见提示。现捕获失败并显示本地化恢复说明；无图片插入成功且有纯文本时沿原文本管线保留URL，无文本则明确失败。桌面成功插图路径保留，远程读取期间正文已替换或editor已销毁则不写入。没有增加任意远程抓取能力。
- 定向回归先红后绿；最终paste-remote-images、paste-actions、paste-text-marks三文件19项通过，Web docs类型与生产构建通过。既有canvas及chunk日志保留。证据：`/tmp/dyoffice-ui-audit/word-remote-paste-fix/{red.log,green.log,typecheck.log}`、`/tmp/dyoffice-current-commit-docs-tests.log`。
- 最终构建Chromium硬断言通过：URL保留且错误提示可见；首提示消失后再粘贴无文本HTML，出现新失败提示且正文不变；0页面异常。文档、lease均mock，realtime ticket写请求被阻止，无真实业务写。证据：`/tmp/dyoffice-ui-audit/word-remote-paste-postfix/report.json`。
- 保留远端e6b2ce19精确turn ID助手结算断言和transport回归，transport23/23通过；另移除该远端测试末尾多余空行，修复CI的git diff --check失败。未因此宣称原生助手完整新CI通过。

完整UI穷举仍在进行，本轮专项通过不代表全部控件、复杂文档、多端或读屏组合验收完成。

## Word 本地图片选择失败反馈

- 正式native renderer/mock文档与lease复现：正文“插入→图片”选择超过16 MiB的PNG会产生未处理的“此功能当前不可用”且无可见提示；损坏PNG则静默失败。页眉编辑中的图片入口还会直接泄漏解码异常“Failed to read image”。浏览器红证据：`/tmp/dyoffice-ui-audit/word-picture-picker-red/report.json`、`word-hf-picture-picker-red/report.json`。
- 正文共享insertImageViaDialog捕获选择器拒绝，并检查现有插图函数返回值；页眉/页脚共用图片分支捕获选择/解码拒绝。均复用既有本地化“图片加载失败”toast，不改变可选格式/大小边界。取消继续静默，正常插图继续保留。没有调整主页或新增组件抽象。
- 新增四项回归，其中选择拒绝和解码失败先红；取消与正常插图为正对照。最终图片选择、图片粘贴/拖放、页眉编辑/图片五文件34项通过，Web docs类型/生产构建通过，边界1336文件0违规，git diff --check通过；保留既有canvas和chunk提示。证据：`/tmp/dyoffice-insert-image-dialog-red.log`、`/tmp/dyoffice-insert-image-final-{tests,type,build,boundaries}.log`。
- 最终构建正文/页眉各四场景通过：超限PNG、损坏PNG、WebP均显示错误，正文文本及图片数保持，随后正常PNG成功插入，0页面异常。文档/lease为mock，realtime ticket被阻止，无真实业务写。页眉成功检查限定doc-inline-img并核对准确data URL，排除ProseMirror separator辅助img；最初泛img计数误报不记录为产品缺陷。正文分页的纯空白变化以归一化文本比较处理。证据：`/tmp/dyoffice-ui-audit/word-{,hf-}picture-picker-postfix/report.json`。
- 本轮仅覆盖上述图片入口失败恢复；不把它当作完整Ribbon、复杂文档或多端验收。页脚共用分支已修，未单独将页脚浏览器操作计入通过数量。

## 插入书签、交叉引用与图表弹窗键盘

- 当前正式native renderer/mock文档与lease，三个真实可达入口均复现：末控件Tab逃到背景正文，首控件Shift+Tab逃到背景公式按钮，Escape不关闭；交叉引用和图表初始焦点还停在BODY。根代理再次用旧构建独立复现并保留硬断言失败，非仅源码推断。证据：`/tmp/dyoffice-insert-modal-browser-red.log`及`/tmp/dyoffice-ui-audit/word-insert-modal-red-1440/report.json`。子agent首轮原始报告曾被失败补测覆盖，其恢复报告明确标记来源，不将失败补测当新结论；根代理独立红报告不依赖恢复文件。
- 最小修复仅三组件各增加既有useModalKeys调用并绑定backdrop；未修改书签/引用/图表插入和共享dropdown状态。新增每组件两项回归共6项先红后绿，覆盖初始焦点、两向边界、Escape一次关闭且文档JSON不变，以及BODY焦点两向恢复。与共享trap回归共16/16通过。独立只读review未发现与表格/公式或兄弟/嵌套modal栈冲突。
- Web docs类型/生产构建、边界1336文件0违规及git diff --check通过。最终构建1440/390共6个入口场景均硬断言通过：初始及两向Tab焦点在内、Escape关闭、正文归一化文本不变、0页面异常。文档/lease均mock，realtime ticket被阻止，无真实业务写。证据：`/tmp/dyoffice-ui-audit/word-insert-modal-green-{1440,390}/report.json`、`/tmp/dyoffice-insert-modals-{keys-green,type,build,boundaries}.log`。
- PrintDialog的Ctrl+P候选在当前Web页面未进入应用弹窗，不作为可达缺陷修复；保护文档既有Web禁用未绕过。其余引用/密码等弹窗仍有覆盖缺口，不宣称完整Ribbon或全部UI验收。
- 期间磁盘空间耗尽，清理可再生成的npm下载缓存后恢复，保留依赖安装、用户配置、业务数据和既有审计证据。此次环境问题不记为产品UI缺陷。
- 发布时远端推进到2325d939，新增图片选择/远程粘贴的pending document guard与解码竞态回归；已精确校验对象后rebase保留，未覆盖。合并后六文件46项通过，Web docs类型/生产构建通过，新增helper使边界扫描变为1337文件0违规。最终合并构建1440/390六个弹窗入口再次通过，正文图片三类失败与正常插图四场景也通过；0页面异常。证据：`/tmp/dyoffice-insert-modals-merged-{tests,type,build}.log`、`/tmp/dyoffice-ui-audit/word-insert-modal-merged-{1440,390}/report.json`、`/tmp/dyoffice-image-picker-browser-merged.log`。不以普通图片流程通过代替全部真实异步竞态验收。

## 题注与创建引用源弹窗键盘

- 正式native renderer/mock文档与lease，独立浏览器确认两个可达入口初始焦点在背景、首尾Tab逃出、Escape不关。内部Dropdown第一次Escape正确只关下拉；第二次父Escape仍失效。展开下拉后正Tab关下拉并进入输入，反Tab会逃背景。原始证据：`/tmp/dyoffice-ui-audit/word-reference-modal-red/{coverage.md,report.json}`。
- 两个父组件仅接入既有useModalKeys，不改Dropdown自身事件层级和插入/添加来源逻辑。新增4项组件回归先红后绿，和插入弹窗/trap/题注正则回归共23/23通过；Web docs类型、生产构建、边界1337文件0违规通过。独立只读review无阻塞，取消路径不触发正文或源写入。
- 最终构建1440/390各两个入口通过，覆盖初始焦点、两向边界、父Escape、两次Escape先下拉后父、展开下拉正反Tab留在父弹窗。取消后正文归一化文本不变、0页面异常；全部业务写mock/blocked。证据：`/tmp/dyoffice-ui-audit/word-reference-modal-green-{1440,390}/report.json`、`/tmp/dyoffice-references-modals-{red,green,type,build}.log`。默认空草稿未单独验证有效title取消，不将静态路径检查冒充该浏览器场景。
- 发布前保留远端14778d99、8cb04614的剪贴板读取/Blob解码保护，以及79f2e4ad的拖图读取/解码保护，均精确对象校验后rebase；没有覆盖远端产品改动。合入前述剪贴板保护后的两尺寸浏览器仍全部通过，证据`/tmp/dyoffice-ui-audit/word-reference-modal-merged-{1440,390}/report.json`。最终含拖图保护的相关10文件91项通过；日志`/tmp/dyoffice-references-final-integrated-tests.log`。上述保护不视为已穷举所有剪贴板或拖放竞态。

## 密码与页码格式弹窗键盘

- 受保护DOCX fixture触发修改密码提示，及“插入→页码→设置页码格式”真实入口，均先复现两向Tab逃到背景、Escape不关闭；页码初始焦点还停在背景。红证据：`/tmp/dyoffice-ui-audit/word-password-keyboard-1440/report.json`、`/tmp/dyoffice-ui-audit/word-page-number-modal-red/report.json`。
- 两处接入既有useModalKeys；页码仅将原内联UI提取为受控组件，保留原状态和应用逻辑。初始焦点跳过禁用控件，使密码忙碌状态仍可聚焦取消按钮。新增4项组件回归先红后绿，Escape沿既有取消动作，不提交密码或页码。保留远端9ebbdaaa图片粘贴/只读异步保护后，相关6文件41项通过；Web docs类型、生产构建、边界1338文件0违规及git diff --check通过。构建保留既有chunk大小提示。
- 最终合并构建Chromium：密码1440/390两流程通过，Escape后按既有逻辑只读打开；页码1440/320两流程通过，内部下拉第一次Escape仅关下拉、第二次关父，展开下拉正反Tab留在弹窗，取消后正文未变。四流程均0页面异常；文档/lease均mock，其余业务写阻止，无真实密码或配置变更。证据：`/tmp/dyoffice-ui-audit/word-password-keyboard-green-{1440,390}/report.json`、`/tmp/dyoffice-ui-audit/word-page-number-modal-postfix-{1440,320}/report.json`、`/tmp/dyoffice-password-page-final-{tests,type,build}.log`。
- 此次仅上述弹窗专项，不代表全量UI、复杂文档或多端/读屏验收完成。
