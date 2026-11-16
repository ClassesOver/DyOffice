# T09 功能验收与 native 关闭兼容对照（草稿）

日期：2026-11-16。记录 T09 本轮修复、独立副本的 Web/native 回归、办公软件兼容性对照，以及仍未完成的验收门禁。不同软件和不同测试层级分别记录，不将单测或文件解析成功冒充逐功能端到端验收。

## 状态口径

- **已测试 / 通过或失败**：须附本次命令、输入哈希、运行结果及适用软件；不能把解析器、ZIP/XML 检查或其他办公软件结果当作 Excel 通过。
- **待测**：未运行、受阻、或只存在他处历史证据；明确标注引用与负责人。
- **不支持**：产品明确禁用的功能，不写作失败或通过。
- WPS 截图的 `Error occurred` 是**关闭时崩溃**，不能改写成无法打开；是否能正常关闭须以真实 `et` PID / 退出信号为准。Snap wrapper 固定 exit 0 不作为成功证据。

## 安全边界与测试输入

- Repo：`/home/junge/.zcode/worktrees/5f62/DyOffice`，分支 `feat/t09-native-sheets`。
- WPS：Snap `wps-2019-snap` 11.2.0.9505，真实程序 `/snap/wps-2019-snap/current/opt/kingsoft/wps-office/office6/et`；保留 strict confinement，不使用 sudo、不改权限。
- 仅允许独立虚拟 DISPLAY、独立 HOME / XDG 配置、独立工作目录；绝不连接用户 `:0`。关闭仅发送到已核实属于该独立 `et` PID 的窗口。
- 原件只读：`apps/web/test/fixtures/sheets/acceptance.xlsx`；`/home/junge/下载/t09-acceptance(7).xlsx`。仅打开隔离工作目录内副本；公共 writer / 无 chart 文件是对照，不是修复产物。
- 开始前 `pgrep -ax et` 无进程。哈希、隔离路径、真实 PID 和退出信号随运行补录。

## native 关闭兼容对照矩阵

约定：本机 WPS 实际版本 `wps-2019-snap` 11.2.0.9505，真实二进制 `/snap/wps-2019-snap/current/opt/kingsoft/wps-office/office6/et`。用户已亲自在恢复的独立 profile 处理首次协议；随后所有输入均为隔离副本，在独立 `:93` 和 Snap strict confinement 下打开，并对确认 PID 的工作簿窗口发送 `WM_DELETE_WINDOW`。关闭保存提示仅对隔离副本选“不保存”。表内退出码来自各自直接父进程 wait / exit.json，不能以窗口消失或 Snap wrapper exit 0 替代。

| 输入 | 来源 / SHA-256 | 本机 WPS 11.2.0.9505 | LibreOffice 24.2.7.2 | Microsoft Excel |
| --- | --- | --- | --- | --- |
| Fixture | 逐字节隔离副本；`6834536e6ba5f41215157d12220377f62e218d234552edc2a243feb05f6493fb` | 已测试：打开成功，B2=25/F2=20、柱图可见；真实 et PID 3984413，正常关闭→不保存→**-11 / SIGSEGV**，见 `restart-1794825923/exit.json` | 已测试：headless open→XLSX export exit 0，输出 SHA `6869c14b306d851eab0fc36336433f85f110332f58203c2f5ed90634f293e7f9`；ZIP 有效，chart 保留；cache 仍 999/-1；custom XML 未保留 | 待测，须实际 Excel |
| 用户实际下载副本 | `/home/junge/下载/t09-acceptance(7).xlsx` 只读复制；`dbf6c06e34192a073b3e7a29f06c36273cda6e6b5fe8376e3c198f1303da3b3c` | 已测试：打开成功，A2/B2/F2=21.25/42.5/28.75、柱图可见；PID 4003438，正常关闭→不保存→**-11 / SIGSEGV**，见 `close-download-1794826706/exit.json` | 已测试：headless open→XLSX export exit 0，输出 SHA `485637778e3546904ef4114e0d32f2b07d0a98203591958772be1a831c70396d`；ZIP/chart 有效，A2/B2/F2=21.25/42.5/28.75，custom XML 未保留 | 待测，须真实 Excel；不得由 WPS/LO 代替 |
| 下载副本移除图表对照 | 隔离副本，仅移除 chart/drawing 关系，其他 part 复制；`8d911bf4c45c2cd3da7835b2b604d4901048174162ade63919cfb48e2c17874b` | 已测试：打开成功，无图表；PID 4021748，正常关闭→不保存→**-11 / SIGSEGV**，见 `close-download-no-chart-1794827058/exit.json` | 已测试：headless open→XLSX export exit 0，SHA `a05e68312ea947d427a99b8c38dcb8f8cc963eb1759fe620c3994fd903f4df8f`；ZIP 有效，无 chart；公式值 42.5/28.75；custom XML 未保留 | 待测 |
| 公共 writer 纯表对照 | XlsxWriter 3.3.1 / openpyxl 3.1.5，`b2de64b2d025471efd8ed30242edcefa77812c2659d99ed016963f0e220ae88e` | 已测试通过：打开成功，PID 4013198，正常关闭→真实 **exit 0**，未出现保存提示；见 `close-public-plain-1794826911/exit.json` | 已测试：headless open→XLSX export exit 0，SHA `72ab0fc993501d2e19a76e25f1723f78322bd3c90502bed228fb50d7b8942889`；ZIP 有效 | 待测 |
| 公共 writer 图表对照 | XlsxWriter 3.3.1 / openpyxl 3.1.5，`c457c8f1d26242baedc31fb549a552e24ac8058351f4fcf489c6066ae1eec03b` | 已测试通过：打开成功，柱图可见，PID 4015764，正常关闭→真实 **exit 0**，未出现保存提示；见 `close-public-chart-1794826955/exit.json` | 已测试：headless open→XLSX export exit 0，SHA `95863530538a8a941394cb339a41ec21734c6646ae2d384ce292244a430409ce`；ZIP 有效，chart 保留 | 待测 |
| chart compatible fixture | `apps/web/test/fixtures/sheets/acceptance-chart-compatible.xlsx` 只读复制；`0ef9d042ce8c11a3c339b3f068d9960940a8878442bb1717197cec020ae2b177` | 已测试：打开成功，实心柱图可见；PID 4010968，正常关闭→不保存→**-11 / SIGSEGV**，见 `close-compat-1794826838/exit.json` | 此变体本任务未测 | 待测 |
| Fixture 仅增加 theme 闭包 | 原 fixture 增加公共 writer `xl/theme/theme1.xml` 及必要 workbook rel/CT override；`033fd8cc76b903a5d01e49391322e673d03d6cc60172501441076a897cb012b5` | 已测试：打开成功；PID 4030715，正常关闭→不保存→**-11 / SIGSEGV**，见 `close-fixture-with-theme-1794827214/exit.json` | 未测 | 待测 |
| Fixture 仅移除未知 custom XML | 仅删除 `customXml/t09-preserve.xml`，其余每个 part 解压字节不变；`037d7f084d071494865173f150dfbdbdbeaf76e8165366595367066823c958ec` | 已测试：打开成功；PID 4036838，正常关闭→不保存→**-11 / SIGSEGV**，见 `close-fixture-no-custom-1794827322/exit.json` | 未测 | 待测 |

本轮隔离 WPS 关闭结果：原 fixture、实际下载副本、chart-compatible fixture、下载副本去图表、仅补 theme、仅移除 custom XML 均正常打开但正常关闭 SIGSEGV；公共 writer 纯表与图表均 exit 0。公共纯表基线替换 fixture workbook/styles 单项均 exit 0，替换 worksheet 后 SIGSEGV（为保持引用合法而移除 drawing、调整 style 索引并等价改名公式）。补 selection/tabSelected/pageMargins、inlineStr/sharedStrings 双向转换、correct stale cache，均未消除 crash。只移除两个 `<f>` 元素、保留其缓存值时 exit 0；fixture 分别只留 `=A2*2`、只留 `=SUM(Revenue)` 均 exit 0；公共 writer 单个 `=1+1` 也 exit 0。反向验证：公共 writer 含两个常量公式 `=1+1` 与 `=2+2`，无名称、引用、图表，仍 SIGSEGV；fixture 将 `=SUM(Revenue)` 改为等价 `=SUM(A2:A3)` 仍 SIGSEGV。故此 Snap WPS 环境中的**多公式关闭触发**是最强、已能用通用文件重现的第三方行为候选；不能断言其内部根因或 OOXML 格式非法。不得通过删除公式“修复”，不得据此改 DyOffice 保存格式；WPS 11.2.0.9505 关闭兼容仍是外部 release blocker，需由产品端升级 WPS 后另行验证。双公式最小复现：`/home/junge/t09-wps-native-gqrplwj0/inputs/public-two-constants.xlsx`，SHA-256 `e805e43c24c33cde9082048ece31ce50b78e147b6459289e3528d30feddde0a0`，日志 `close-public-two-constants-1794829396/exit.json`，真实 PID 4157152 / -11。单公式对照：`/home/junge/t09-wps-native-gqrplwj0/inputs/public-one-plus-one.xlsx`，SHA-256 `36019e803df96ee97e9254edfe8bc3119d21a35a7f6b6fc4e320f68bd80d5209`，日志 `close-public-one-plus-one-1794829239/exit.json`，真实 PID 4148306 / 0。另一有名称单公式比较见 `fixture-name-only`，exit 0；去公式 / 正常退出对照见 `fixture-no-f`，exit 0；正确缓存双公式仍 -11，见 `fixture-correct-cache`。

`LibreOffice` conversion evidence is limited to a successful headless load/export. It is not GUI close validation, WPS compatibility, Excel compatibility, or proof of unknown-part preservation. Both source workbooks include `customXml/t09-preserve.xml`; LO exported copies do not. LO fixture output also retained stale formula caches, so do not use it as formula recalculation proof. Writer control input part lists, exact commands, stdout/stderr, PIDs and output hashes are retained under `/home/junge/t09-wps-native-gqrplwj0/logs/` and `/home/junge/t09-wps-native-gqrplwj0/lo-v2/`.

## 独立 WPS 运行入口与证据索引

- 用户已亲自在恢复的隔离 WPS profile 完成协议并明确回复“好了”；本代理不接受、不绕过任何 EULA，未复制现有用户配置。所有后续对照沿用 `/home/junge/t09-wps-native-gqrplwj0/profiles/fixture/` 下独立 HOME/XDG 目录。
- 恢复 Xvnc PID 为 3984406，display `:93`，VNC 仅 `127.0.0.1:5993`，独立口令文件 `/home/junge/t09-wps-native-gqrplwj0/auth/vnc-password.txt`（0600）。用户可自行通过 Remmina/VNC viewer 查看；本代理不连接 `:0`。
- 恢复脚本 `/tmp/dyoffice-restart-wps-handoff.py` 的直接父 monitor 3984404 记录原 fixture 真实 et 3984413 的 -11 后按脚本正常结束；未被本代理 kill。Xvnc 留存；各次 crash 自动产生的恢复 et 窗口未点击、未关闭、未代替用户决定恢复。
- 新测试使用临时 `/home/junge/t09-wps-native-gqrplwj0/scripts/resume-one.py` 启动 `snap run --shell wps-2019-snap.et` 并 exec 真实 et，父进程 wait 写 `exit.json`。`verified-close.py` 核实 `_NET_WM_PID` 与输入窗口标题后仅发正常 `WM_DELETE_WINDOW`；若提示保存，截图确认工作簿名后仅对该副本点 No，并写 `discard-action.json`。没有发送强制结束信号。
- 以下路径相对 `/home/junge/t09-wps-native-gqrplwj0/logs/`。每个新 run 目录包含 `processes.json`（原件来源、SHA、完整命令、PID/profile）、`opened-windows.json`、`close-action.json`、`exit.json`、`wps.log`、前后截图；出现保存提示的另有 `discard-action.json`。

| 控制变量 | 真实 PID / exit | 日志目录 | 输入 SHA-256 |
| --- | --- | --- | --- |
| 公共纯表基线仅换 fixture workbook.xml | 4066801 / 0 | `close-public-fixture-workbook-1794827850` | `4f5ea1d31f1732a9f6b497806126153e79b42ade28788ab613f916b4b9e55e9c` |
| 公共纯表基线仅换 fixture styles.xml | 4068517 / 0 | `close-public-fixture-styles-1794827878` | 见该目录 `processes.json` 及 `major-part-manifest.json` |
| 公共纯表基线换 fixture worksheet（去 drawing、style3→0、Revenue→SUM(A2:A3)） | 4070179 / -11 | `close-public-fixture-sheet-1794827897` | 见该目录 `processes.json` 及 `major-part-manifest.json` |
| 原 fixture 仅补 selection activeCell/sqref A1 | 4079451 / -11 | `close-fixture-selection-1794828057` | 见该目录 `processes.json` 及 `worksheet-field-manifest.json` |
| 原 fixture 仅补 tabSelected=1 | 4083215 / -11 | `close-fixture-tabselected-1794828120` | 见该目录 `processes.json` 及 `worksheet-field-manifest.json` |
| 原 fixture 仅补标准 pageMargins | 4087117 / -11 | `close-fixture-margins-1794828185` | 见该目录 `processes.json` 及 `worksheet-field-manifest.json` |
| 原 fixture 六个 inlineStr 改 sharedStrings，增加必要 rel/CT 闭包 | 4109166 / -11 | `close-fixture-shared-retry-1794828549` | `c73a2be64d419281cf0bbf5997b96f822cf9a2bc9095f3ae62102501873ca9f0` |
| 公共纯表五个 shared string cell 改 inlineStr，其他 part 字节不动 | 4113160 / 0 | `close-public-inline-1794828618` | `a0a12ad4f4ddde432a32097c38338e19dc87967de2ed2aa5b413b9496d06c466` |
| 原 fixture 仅修缓存为25/20，保留两个公式 | 4122304 / -11 | `close-fixture-correct-cache-1794828780` | `f99948ccdb0f8fbd5ae37e45263f6681e39a04eeb301c0e084b6e2ef6d73c70e` |
| 原 fixture 仅移除两个 f 元素，特意保原v999/-1作单变量（不是修复产物） | 4126144 / 0 | `close-fixture-no-f-1794828846` | `bd5dc4d4a6cec67bf8c4c88c6a3bd6999d907f156b77054c4e688b5f57349249` |
| 公共纯表加 C5*2、SUM(Revenue) 两公式，补合法Revenue名称闭包，cache25/20 | 4133868 / -11 | `close-public-formula-pair-1794828984` | `a910c33832c98dfd3ee2a4ca0352e670bd9c80b661372631f716e66458f05428` |
| 原 fixture 仅移除F2公式，留B2=A2*2 | 4138573 / 0 | `close-fixture-simple-only-1794829067` | `580c6f2a2edb6a8d2bce1be3eda904e7e48c7e13bc17bb52aae2478ca02f3637` |
| 原 fixture 仅移除B2公式，留F2=SUM(Revenue) | 4143099 / 0 | `close-fixture-name-only-1794829146` | `feefb9a06b0531d207e8e7512bda52127861f78fb73e41dd21ac96b4e15b8280` |
| XlsxWriter原生一个公式A1=1+1，cache2 | 4148306 / 0 | `close-public-one-plus-one-1794829239` | `36019e803df96ee97e9254edfe8bc3119d21a35a7f6b6fc4e320f68bd80d5209` |
| XlsxWriter原生两个常量公式A1=1+1、A2=2+2，cache2/4，无名称或引用（最小复现） | 4157152 / -11 | `close-public-two-constants-1794829396` | `e805e43c24c33cde9082048ece31ce50b78e147b6459289e3528d30feddde0a0` |
| 正确缓存fixture仅将SUM(Revenue)改SUM(A2:A3)，名称定义保留、其他part字节不动 | 4162167 / -11 | `close-fixture-direct-sum-1794829482` | `c90d0ffd939b2529b239f1d98c23a1ab5a564740e4b14cf537f96994f1d7cb91` |

WPS 证据已冻结。无后续 XML 试验；仅更新本文件的 WPS 矩阵。

所有列出的 `-11` / `0` 均为直接父 wait，退出时 display_alive=true。selection/tabSelected/pageMargins 各自不足以修复；inline/shared 双向对照也排除“inlineStr 单独必然触发”的解释。原 fixture 与公共 writer baseline 都没有 selection 子元素，不能仅以缺省 selection 判坏。首次 shared-string 尝试 PID4094547 的父 monitor 因 X11 BadWindow 中断而没有 exit.json，**排除该次结果**；后续为临时观察器添加错误处理后，重跑 4109166 才取得 -11。不从 PID 消失或 recovery 子进程存在推断成功/信号。

## 本次运行记录

- fixture 原件 SHA-256 与 `apps/web/test/fixtures/sheets/acceptance.json` 一致；下载副本 SHA `dbf6c06e34192a073b3e7a29f06c36273cda6e6b5fe8376e3c198f1303da3b3c`。
- 原 fixture 与下载副本 part 对照：仅 `xl/charts/chart1.xml`、`xl/drawings/drawing1.xml`、`xl/styles.xml`、`xl/worksheets/sheet1.xml` 不同；其他所有 part 字节一致，无新增/删除 part。下载 `sheet1.xml` 实际包含 A2=21.25、B2 formula/cache=42.5、F2 formula/cache=28.75；图表缓存也已从原值更新。
- 两份原件均只读；每个 WPS / LO 实际输入在 `/home/junge/t09-wps-native-gqrplwj0/inputs/`。
- Snap `snap.yaml` 为 `confinement: strict`。`snap run --shell wps-2019-snap.et` + 原二进制绕过的是静默/固定 exit 0 的壳层 wrapper，保留了 Snap confinement。
- `strace` attach 和 `gdb` attach 因 ptrace / AppArmor 权限失败；未提权、未改权限/系统设置，不把这当作产品失败或要求父代理处理。
- 首轮 EULA 阻塞已由用户亲自处理。实际 `et` 对于通过正常关闭所产生的等待保存确认的对话框，当用户/我选择不保存后，观察到部分工作簿关闭时 SIGSEGV，部分正常退出码为 0；本表按工作簿结果分别记录。Excel 仍未验收，矩阵草稿不宣告整体 T09 通过。

## 功能验收矩阵

下表以本轮实际运行结果填写。独立原生回归日志 `/tmp/dyoffice-t09-native-regression.NBmmk0.log` 为 **8/9 通过**；图表标题保存的单项日志 `/tmp/dyoffice-t09-chart-regression.yOijai.log` 明确失败为 `SANDBOX_BUSY`。新增共享有界 native admission 后，`/tmp/dyoffice-t09-chart-regression.1EyX4F.log` 的该单项 **1/1 通过**。这是分批通过记录，不是最终提交后完整9例同轮通过；完整最新 CI 仍需执行。专项单测282/282、bridge/lease/admission合计37/37和四套TypeScript检查通过。历史参考：`t09-runtime.md`、`../t09-local-acceptance.md`、`../../superpowers/specs/2026-11-16-t09-native-sheets.md`。

| 功能 / 验收点 | 本轮状态 | 证据或所需检查 | 软件 / 边界 |
| --- | --- | --- | --- |
| 打开原始 fixture，Editing 状态 | 本轮原生 Web E2E 通过 | 独立数据库、TLS、Chromium、systemd 原生沙箱 | Web |
| B2 `=A2*2` 忽略 stale cache 999，初始算出 25 | 本轮 Web E2E 通过 | 初始值与保存缓存分别检查；非空旧缓存必须重算并等待模型应用 | Web；不代表桌面应用验收 |
| A2 改 21.25，B2 重算 42.5 | 本轮 Web E2E 通过 | 立即保存无测试延时；保存 XML、重载与真实下载附件核验 | Web + 已提交 XLSX |
| F2 `=SUM(Revenue)` 名称依赖联动 | 本轮 Web E2E 通过 | 下载测试核验 28.75；晚到编辑用例核验子版本 57 | Web + 已提交 XLSX |
| C2 日期 45292 / 2024-01-01 | 本轮 Web E2E 通过 | raw serial 45292 与日期显示；各外部应用仍单独验收 | Web |
| D2 0.125 / 12.50% | 本轮 Web E2E 通过 | raw 0.125 与显示 12.50% | Web |
| E2 1234.567 / 1234.57 kg | 本轮 Web E2E 通过 | raw 1234.567 与格式显示分别断言 | Web |
| Undo/Redo 与批量工具整体撤销/重做 | 本轮 Web 批处理 E2E 通过；保存后撤销边界另有单测 | 单测不等于每种菜单操作已端到端验收 | Web / shared renderer |
| Ctrl+S 保存，重载仍为已提交编辑 | 本轮原生 Web E2E 通过 | 快速保存、实际已提交字节与重载结果一致 | Web + native save |
| 保存并下载最新编辑快照 | 新增真实附件 E2E 3/3 通过 | dirty 下载、延迟保存回执与晚到编辑 drain、自动保存保留底层 workbook/选择；不是只检查 DB head | Web + File API |
| 名称 Revenue 保留且可编辑 | 本轮 Name Manager E2E 通过 | 修改定义、重算、保存与复开 | Web；外部软件单独记录 |
| 原有图表读取/显示/标题修改/保存 | 公共 writer 和单项原生标题保存复验通过 | LO 空柱实证为裸系列 FillStyle NONE；默认填充后 SOLID 且实际绘柱。标题上传500已定位 native inspect SANDBOX_BUSY，有界调度后单项1/1通过 | Web + LO；不代表 WPS/Excel |
| 图表类型、新增/编辑正确性 | 本轮 writer 聚焦 247 测试通过；并非全部 UI 已测 | 默认类别、cache-less 引用、外置样式/显式填充保留、scatter/date/multilevel 语义；创建与系列替换 | chart writer 专项 |
| 图片字节保留与浏览器可见显示 | 待测 | 原 fixture 仅含 chart；媒体 API 历史测试不能替代显示 | Web；外部软件另测 |
| 未知 ZIP part / custom XML 保留 | 已测试：本次下载字节保留；其他场景待测 | 原 fixture 与下载仅 chart/drawing/styles/sheet 四 part 不同，其他部件逐字节相同；LO 重存则丢弃 custom XML | 仅该下载 SHA 的 ZIP/XML 事实，不证明 UI 流程 |
| 只读 / conflict / lost lease / clean takeover | 本轮原生接管 E2E 通过；租约 barrier 15/15 通过 | 只读命令拒绝、显式接管后首屏 range 就绪才允许编辑、晚到有效 renew 恢复权限、release/takeover fencing；不代表全部未授权矩阵已跑 | Web / T06 |
| 丢失提交响应后的幂等和后续编辑 | 本轮原生 E2E 通过；bridge barrier 9/9 通过 | 原请求幂等回执确认，后续编辑保留；真实下载等待原 save gate 再提交 child revision | Web / T06 |
| 原生读取与保存槽位争用 | 已复现并修复；调度13/13通过，真实图表标题单项1/1通过 | 读取与保存共用两个槽、FIFO最多8等待项、输入快照合计64 MiB；忙时仅执行前可取消有界重试，过载429/到期503含Retry-After；不改变systemd资源限制 | Native admission |
| 结构保存期间晚到非单元格编辑 | 明确受阻，不能标为完整修复 | 已提交结构快照后保留旧运行时/草稿并阻止重复写入；无自动reconciliation/草稿导出，需人工复制修改后重载 | Web / shared renderer |
| 透视表定义刷新 | 不支持（当前 Web host） | 原保存链保留现有部件不等于可刷新 | 不推断 WPS/LO/Excel 不支持 |
| 文件级查找、工作簿密码修改、外部链接使用分析、跨工作簿选择 | 不支持（当前 Web host） | 现有 runtime 文档明确降级；待实现代理确认变更 | 不推断桌面软件能力 |
| WPS 打开 / 正常关闭 / 崩溃定位 | 已复现并缩小到本机旧WPS多公式关闭触发；release blocker，未修复 | fixture/下载/兼容版均正常打开，正常close/No后真实wait -11；公共纯表/图表0。XlsxWriter原生单个1+1为0，原生两个常量1+1与2+2亦-11，无名称/引用/图表；fixture单独任一公式均0，两公式改普通SUM仍-11。通用最小复现与所有PID/hash/close动作见前述索引；不删除公式、不判工作簿非法、不将第三方程序crash当产品已修 | WPS 11.2.0.9505 Snap，此隔离环境；不替代LO/Excel |
| LibreOffice 外部兼容 | 已测试：5/5 headless load/export；GUI 关闭待测 | 独立 UserInstallation，输出 ZIP 可读、预期 chart 数保留；不宣称重算或未知部件保留 | LO 24.2.7.2，不替代 WPS/Excel |
| Microsoft Excel 打开、无修复、保存后复开可编辑 | 待测 / release blocker | 无已连接真实 Excel 会话；必须记录 Excel 版本和下载哈希 | Excel，不能以 CI/ZIP/WPS/LO 代替 |

## 退出状态、失败尝试与收尾

| 进程 / 尝试 | 实际记录 | 正确解释 |
| --- | --- | --- |
| 首次隔离 fixture 探测，真实 et PID 3946594 | `logs/probe-exit.json`：returncode -15 | 本代理清理发出的 SIGTERM；不是关闭崩溃或正常关闭 |
| 公共纯表，真实 et PID 3949260 | `logs/public-plain-result.json`：open=false，close_sent=false，natural_returncode=null，final_returncode=-15 | EULA 阻塞后本代理清理；不能判 pure-sheet WPS 打开/关闭通过 |
| 公共 chart，真实 et PID 3950376 | `logs/public-chart-result.json`：open=false，close_sent=false，natural_returncode=null，final_returncode=-15 | EULA 阻塞后本代理清理；不能据此判 chart 特有缺陷 |
| 第三轮 fixture，真实 et PID 3951667 | `logs/comparison-stopped.json`：已请求 confined SIGTERM；观察父进程 3949214 被先暂停后 SIGKILL，未获得该 et 的 wait status | 停止无人值守推进并转交用户，绝不捏造实际 et 退出码 |
| 保留的 handoff，真实 et PID 3954730 | 等待用户；未主动关闭。`logs/handoff.json` 记录真实二进制命令；退出时 `logs/handoff-exit.json` 由直接父进程写入 | 未退出 / 尚未处理 EULA 均不是关闭验收结果 |
| LO 第一轮，错误使用 SAL_USE_VCLPLUGIN=gen 且 DISPLAY 未设置 | CLI returncode 0，但 stderr 为 Can't open display，未产生输出 | 此轮失败，已排除；再次说明不能仅凭 wrapper 0 判成功 |
| LO 第二轮 SAL_USE_VCLPLUGIN=svp | CLI PID 3953438/3953508/3953594/3953681/3953750 各 exit 0，5 份目标文件均实际生成并 ZIP 校验通过 | headless load/export 已测；未捕获 soffice.bin 单独 wait status，不宣称 GUI native 正常关闭 |

最终核验：原 fixture、用户实际下载及 chart-compatible fixture 原件 SHA 未变；VNC 口令认证保留。用户亲自处理协议后，代理仅在独立 :93 对核实 PID 的测试副本执行正常close/No并取得真实wait状态；未连接 :0、操作用户文档/租约、修改其他代理文件、运行 sudo、改权限策略或 commit/push。Xvnc 3984406 与 crash 自动产生的恢复窗口未关闭；没有未完成的测试工作簿被强制结束。保留临时输入、监控与截图证据供下一步定位，未宣称 WPS 关闭已修复。
