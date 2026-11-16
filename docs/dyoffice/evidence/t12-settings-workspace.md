> Latest integration and evidence boundaries: [T12 UI refresh after #72](t12-ui-refresh.md). The dated results and screenshots below are historical unless explicitly restated there.

# T12：个人工作区、个人偏好与管理员全局配置

日期：2026-11-16。范围是 `DYOFFICE_AUTH_MODE=local` 的 TypeScript 本地账号运行时。本轮按用户要求不启用、不修改、不等待 CI；全部结果来自本地实际执行。

## 最新目标复测（10793fc，2026-11-16）

本次从已审 PR #52 `d5f794fad6768efd087707b04e40a54e29b8b0bf` 保留历史整合目标 `10793fcdc93f033c33a886434be35f3a6d83733d`（含 #30/#65/#66）。此前 d86 结果及原始浏览器截图仅为历史，不替代本次复测。

- 目标全部非 T12 blob 经 SHA 核对；`app.ts`/`index.mjs` 两处冲突同时保留 T12 keyring/工作区与 Sheets 配置、启动及关闭。保留 File/Sheets 共用两槽限流。0001–0017 与目标完全一致，0018/0019 不改摘要；不支持私自应用旧 PR 0014/0015 的分叉 ledger。
- 真实 PostgreSQL 17.11 + RustFS 1.0.6 + Redis 8.0.2 全相关回归：**292 项，291 通过、1 失败、0 跳过**。唯一失败为 `jobs/revision-delivery.test.mjs` 第一次 take 在 PostgreSQL 函数内遇到 `57014 statement timeout`。原代码独占复测该文件 **2/2 通过**，未确定初次超时根因，不把首次全套改写为全绿，也不归因于 Redis 故障。
- 另以真实 S3 后端运行永久清理、回滚/进程退出重试、回收、共享 I/O admission 及 ACK 截止期：**27/27 通过，0 跳过**。所有服务只使用新建随机测试数据库/角色/桶；测试后已停止，没有触碰真实用户对象。
- Web+unit：**366 通过、1 既有可选跳过**。Shell DOM：**86/86**。server、frontend、Shell TypeScript 与 local-shell 构建通过；边界 **997 文件/0 违规**；兼容性输入 **84 文件/0 变化**（不是运行时兼容验收）。
- 独立 DOCX 构建采用 768MB heap 和工作区 TMPDIR，仍在 transform 阶段 **exit 137/Killed**，未完成构建；未推定 OOM 根因。本次没有新的 Chromium 页面断言，原环境 Unix socket 权限/跨进程 loopback 限制仍未解除。Shell DOM、桌面 Office 独立实验均不替代当前 Web 页面或 DOCX 主题/往返验收。
- 独立复审未发现整合阻断，允许更新 draft，但不据此认定满足完整合并验收。保持 draft/未合并；不宣称全仓、CI、真实浏览器或原生 DOCX 全绿。全局配置检查仍为 `connection: not_run`，不扩充外部 Provider/MCP 执行权限。

## 历史目标整合（d86ae1a7，2026-11-16）

本轮以 `feat/dyoffice-web@d86ae1a7ecd93859328bc73e25d2357648da2301` 为目标，整合原 PR #52 `b7d7e3d268891a00946d0f6fe2c08af053b10a6e`。以下历史浏览器和原生编辑证据仍属于原基线，不替代新目标的复测。

- 已应用 0001–0017 SQL 字节与目标逐个一致；仅将原 PR 尚未合入的迁移追加为 **0018_global_config / 0019_workspace**。不兼容曾私自应用旧 PR 0014/0015 的分叉 ledger，不绕过 checksum 防护。
- 真实 PG 先红后绿复现修复三项：永久清理 fence/墓碑仍出现在 workspace trash；墓碑 folder 引用使目录永远非空；100 个旧配置替换为 100 个新配置时，200 个审计 ID 违反旧 100 上限。新审计上限为 200，保留完整审计而非截断。
- 文件夹删除只在同一用户 tree 事务锁下解除已不可逆 purge 文件的 folder 引用，保留文件/版本墓碑；普通回收文件依旧阻止目录删除。覆盖 pending/完成以及跨用户拒绝。
- 独立审查还发现祖先查询误加文件 purge 列，已修正并保留原文件夹移动/环路/并发测试。全局配置权限、密钥及原 T05 列级 grant 未放宽。
- 旧启动测试使用原生 strip-types；新 Provider 元数据依赖包含无扩展名 TypeScript import。测试子进程改为仓库既有 `npm start` 的 `node --import tsx`，保留真实服务器启动、拒绝错误权限与干净退出断言。
- Chromium `/usr/bin/chromium` 启动实测被 `socket() failed: Operation not permitted` 阻断。本轮没有运行页面断言，也未重新证明 DOCX 主题编辑；不将原截图或 shell DOM 单测替代新浏览器验收。未改系统安全设置。
- 新目标原生 DOCX 构建尝试在 transform 阶段被环境终止（Killed），未产出 dist-docs；原生 DOCX 浏览器及 roundtrip 不登记为本轮通过。
- 全局检查仍为配置/密钥检查，`connection: not_run`。没有新增 Provider/MCP 外部执行能力、批量清空 UI、版本桶删除或生产部署。

### 历史 d86 目标本地验证结果

- 最终整套 `local-integration/*.test.mjs + jobs/*.test.mjs + storage/*.test.mjs`：**290/290，0失败、0跳过**。真实 PostgreSQL 17.11、RustFS 1.0.6、Redis 8.0.2；使用随机新测试数据库/角色/桶，没有清理真实用户数据。
- 额外实际S3回收、永久清理、跨用户I/O限流及ACK重复验收：**25/25，0失败、0跳过**，包括物理删除后进程退出、回滚重试与精确一次计账。
- Web + unit：**360通过、1个既有可选跳过、0失败**；Shell DOM：**86/86**。前端、server、shell TypeScript通过；local-shell构建通过。浏览器依赖边界609文件/0违规；兼容性输入84文件/0变化；变更renderer CSS颜色检查通过。兼容性输入检查不是原生文档往返验收。
- 失败尝试如实保留：最初直接原生TS运行遇Provider无扩展名导入；初次共享依赖本地化期间有loader缺失；完成依赖后整套287/290，三个旧服务器启动器失败，全部对齐既有tsx启动方式后最终290/290。原生provision-runtime CLI仍保留实际发布的strip-types入口。未削弱权限、退出或数据断言。
- Shell首次因共享依赖外部路径触发Vite Denied ID，仅把依赖复制到此独立快照后重跑86/86，没有放宽安全配置。完整native DOCX构建和新Chromium验收仍阻断，不登记为通过；没有本轮全桌面或CI绿色声明。

## 原 PR 的历史验收记录（非本轮整合复测）

起始目标为 `feat/dyoffice-web@6f3702a514fbfdfcecec6746c9614a2ae0784369`，完整 7097 个 blob 与目标树逐项核对。收口前先同步 `f92e4655299523c97cd9e2fc05687699855ee9cb` 的 23 个增量文件，再同步 `e2d922b1369b9e63ee73f10e7918e9936fc53448` 的 3 个独立 T19 文件，均分别验证 blob SHA。最终冻结基线树为 `9828a71a8370c70c50e0e9362bc1b71183485485`。T01/T03/T04 和 T13/T15/T19 的同期成果保留，最终运行在此基线加 T12 改动上。

本次实现：

- 新增 `0014_global_config.sql`、`0015_workspace.sql`，整合不可变迁移清单、受限角色准入、FORCE RLS 和复合所有权约束。
- 原 Home 使用 `/api/v1/workspace/` 持久化文件夹、收藏、最近打开记录；复用文件回收/恢复与重命名 API。目录只允许空目录删除，含回收文件关联时仍为非空。
- 原 Settings 使用单独的个人偏好适配器，管理员配置独立呈现。个人字段与全局配置不能互相注入；`config_admin` 不授予他人文件所有权。
- 提供公共目录投影、管理员元数据、revision CAS、秘密加密、显式清空、整批密钥轮换及脱敏审计。模型目录复用原 Provider 元数据；生成、图片分析和视频分析分别使用正确的候选与默认模型。
- 请求在退出/登录变化/观察到会话失效后作废；保存与检查同步互斥，未知写入结果必须显式读取核对。失败保留非密钥草稿；旧工作区操作不会清除后来新建的草稿。
- Home 的不透明 ID 保留为路由身份，展示名称从文件及目录元数据解析；创建、重命名、移动、删除和收藏失败有可见错误与可恢复状态。

使用方法、接口与 keyring 轮换步骤见 [Web README 的 T12 段落](../../../apps/web/README.md#t12-个人工作区偏好与全局配置)。

## 安全与一致性证据

公共配置只返回启用的 `id/kind/providerId/label/model`、revision 和有效默认项，不返回 endpoint、`hasKey`、密文或 Key。管理员 GET 只补充元数据与 `hasKey`，不会回填 Key。密钥省略或空白表示保留，只有明确 `clearKey: true` 才清空；更换已有密钥配置的 Provider/类型需要替换或清空原密钥。

秘密采用随机 IV 的 AES-256-GCM，AAD 绑定 deployment、配置 ID、Provider、类型及 keyId。启动读取独立 `DYOFFICE_CONFIG_KEYRING`，验证规范 base64 和 32 字节密钥；无启动时随机主密钥或桌面凭据回退。密钥缺失、错误 AAD 或坏 tag 均失败关闭。轮换任一条失败时，已更新的其他密文、配置 revision 与审计也一并回滚。

权限在 `withPrincipalTransaction` 内由真实会话重新推导并在提交前复核。秘密表策略额外要求当前真实 token hash，伪造 principal GUC 不能冒充管理员。Auth/worker 角色没有秘密表读取权；审计只追加，不允许修改或删除。读取与写入通过部署级共享/独占事务锁串行，防止返回旧 revision 配上新 entries 的混合结果。

工作区结构写使用每用户事务锁，拒绝跨用户目录、非法名称、重名、祖先循环与并发成环。收藏、最近、目录归属分别更新各自字段，不互相覆盖。回收和恢复不改文件字节或 revision。真实 PG 组合同时覆盖 A/B/Admin、连接池复用、直接 SQL/RLS、角色与会话撤销竞争、CAS 和失败回滚。

## 实际运行环境

| 项目 | 实际版本/来源 |
|---|---|
| Node.js | 24.22.1 |
| PostgreSQL | 17.11，每次创建独立临时集群和受限测试角色 |
| Headless Chromium | 153.0.8010.0，`@sparticuz/chromium@153.0.0`；Playwright 1.62.1 驱动 |
| 浏览器二进制 SHA-256 | `53a15d6c3a3d27dfb54c4ba60278b1683136f70cf1e67e989da7dfbd3d451ef0` |
| S3 兼容服务 | SeaweedFS 4.54，官方发布包，master/volume/filer/S3 四进程通过 loopback TCP 运行 |
| SeaweedFS 源码 | `5ef99c1d8dbbeb4a035c055e3b464620506aefac` |
| SeaweedFS 发布包 SHA-256 | `e7424a82eee327809bfa449fda4924c9a0f42f6669a01288eebb1b79674c8196` |

没有修改宿主安全策略。系统 Chromium 的 Unix socket 启动被拒绝，Playwright CDN 下载失败后，改用正常可启动的 npm headless 二进制。MinIO 官方二进制初始化 netlink 被拒绝，之后使用真实 SeaweedFS 的正常 TCP 配置；不是 mock 或内存对象存储。S3 启动检查包含签名 SDK ListBuckets 成功、匿名访问 403。测试结束后临时服务均回收。

## 验证矩阵

| 验证 | 结果与边界 |
|---|---|
| `npm run test:web` | **250/250 通过，0 skip**；为既有 S3 用例配置了真实 SeaweedFS，因此最终运行没有 MinIO 环境跳过 |
| `npm run test:web:unit` | **85/85 通过，0 skip**；包含最新基线的 transport/source 单元及新增偏好/Home 适配器 |
| Web Shell 渲染/交互 | **12 文件、86/86 通过**；含全局配置 26 项、Home 失败/名称/竞态 25 项、偏好双击及回收站恢复 |
| PostgreSQL + S3 六文件组合 | **68/68 通过，0 skip**：files 19、settings-boundary 14、workspace 12、ownership-rls 9、authority-write-races 12、未实现旧入口拒绝 2 |
| 全部本地账号 Chromium + 原生主题 | **8/8 通过，0 skip**：原有账号/改密/会话/历史/Admin 用户管理 5 项，新增 T12 工作区与 Admin 配置 2 项，原生主题 1 项；含桌面宽度及 390px 无横向溢出断言 |
| 原生 DOCX 主题/编辑/保存/下载 | **1/1 通过，0 skip**，详见下节 |
| Web/server 与 Shell TypeScript | 通过 |
| Web、local-shell、native-docs 生产构建 | 通过；存在已知体积提示，不把构建通过当作编辑器接入证明 |
| 浏览器依赖边界 | **608 个文件，0 违规** |
| 兼容性输入基线 | **84 个文件，0 变化**；该命令本身不证明运行时兼容性 |
| 主题颜色检查 / `git diff --check` | 通过 |

68 项组合通过后，先前因为没有真实 S3 而出现的 files 39/40 结果已被补测解决。原 Web 回归的 245 通过/1 skip 和同步 T19 前的 246/246 都是中间结果，最终以带真实 S3、冻结基线上的 250/250 为准。

最后两条 Home 晚到删除/移动回调修复后，重新构建 Web 与 local-shell，并再次执行 T12 工作区及全局配置真实浏览器回归，**2/2 通过、0 skip**；最终 Web Shell 仍为 **86/86 通过**。四张工作区/全局配置截图由此轮运行更新。

### 浏览器实际行为

工作区用真实登录、HttpOnly Cookie、CSRF、PostgreSQL 和对象存储，未 route/mock API：从原 Home 文件选择器依次导入 DOCX/XLSX/PPTX/PDF，收藏、建立目录、移动、刷新、删除、回收站恢复、退出并切换 Bob、再登录 Alice。收藏与目录保留，Bob 看不到 Alice 的内容，非 Admin 无全局配置入口，直接访问也被拒绝。浅/深两主题均通过真实下载逐字节比对四个原件，所有文件 revision 不变。

管理员两页同时读同一 revision，第一页保存成功，第二页实际收到 409，非密钥草稿保留。显式读取新版本后保存，保留另一管理员新增项。停用默认项后公共目录过滤该项且取消默认；空 Key 保留、明确清空删除、轮换成功递增版本。检查返回 `connection: "not_run"`，UI 显示未进行服务连通测试。GET、错误、浏览器 URL/storage 不包含提交的 Key 哨兵；配置管理员读取 Alice 文件返回 404。

### 原生 DOCX 主题证据

`test/native-docs/theme.test.mjs` 使用同一有效 OOXML 包创建两份文件，包含显式 RGB、显式黑色、`auto` 字色、highlight、shading 和未改动 custom XML。分别持久化 light/dark 后，通过 HTTPS 登录进入原生 GenOffice DOCX 编辑器；验证实际 `data-theme`、`.workspace.page-dark` 和渲染颜色不同。

两次执行同样的真实键盘编辑，按 Ctrl+S 等待真实 `/commits`，都产生新 revision，保存 SHA 与原件不同。两份保存后的完整 `word/document.xml` **逐字节一致，没有删除随机 ID、色值或属性来规避差异**；颜色、高亮、底纹与原始值一致，其余全部原始 package part 保持字节相同，包内文件集合不变。浏览器点击下载保存版本，下载字节分别等于已编辑并提交的 revision，刷新仍显示编辑，无 pageerror。

这完成 T07/T12 的 DOCX 主题接缝证明。XLSX/PPTX/PDF 在此入口的证据是原件导入/下载不变，**不代表它们的原生编辑器已接入或保存/导出验收完成**。

### 实际页面截图

全部截图来自上述临时测试账号与测试文件，不包含 Provider Key 或一次性账号秘密。

| 页面 | 浅色/桌面 | 深色/移动 |
|---|---|---|
| 原 Home 工作区 | [浅色](t12/t12-workspace-light.png) | [深色](t12/t12-workspace-dark.png) |
| 全局配置 | [1440px 桌面](t12/t12-global-settings.png) | [390px 移动](t12/t12-global-settings-mobile.png) |
| 原生 DOCX 已编辑并保存 | [浅色](t12/t12-native-docx-light.png) | [深色](t12/t12-native-docx-dark.png) |

## RED、审查与修复记录

- 工作区未注册时，12 项真实 PG HTTP 测试因 501 失败；实现后 12 项及 RLS 组合通过。
- 退出后的旧数据响应、旧 CSRF 继续写入、观察到 401 后其他请求仍生效：3 项 RED 后通过。原 Settings 同轮双击产生两次写入的 RED 已修复。
- Header-only `If-Match` 轮换被 body 校验拒绝，以及 Admin 读取旧 revision/新 entries 混合快照，均有真实 HTTP/PG RED 和回归。
- 轮换更新第一条后第二条坏 tag 的失败测试证明密文、revision、审计整批回滚。
- 独立审查复现相反收藏意图被吞、生成/分析模型推荐混列、不透明 ID 被当作展示名；均已修复并增加行为测试。
- Home 首次保留失败输入的实现又暴露旧成功回调清除新草稿的竞态；以独立渲染 probe 复现，再加入草稿归属保护并回归。
- 真实截图发现新 Admin 面板受原皮肤 `cqw` 内边距挤压。桌面编辑器宽度断言 RED 后，以限定面板的 CSS 修复；桌面宽度和移动无横向溢出通过。
- 新增原生 DOCX 主题回归首次即 GREEN，是验收新增证据，不伪造 RED。

独立复审结论为 Approve，没有提交/PR 阻断项。复审独立运行秘密/桥接 13/13、三个关键渲染文件 49/49，以及未改断言的两条 repo 外晚到响应 probe（RED→GREEN）；与上表集成验收分别计数。复审提出的旧删除/移动成功可能关闭后开同类视图也增加两条 RED→GREEN 回归并修复，采用提交时的确认实例与选择集合身份限定清理；复审独立重跑 Home 25/25，最终再次 Approve。

## 可复现命令

从仓库根目录安装锁定依赖，先准备隔离 PostgreSQL 17 数据库（名称 `dyoffice_test` 或 `dyoffice_test_*`，管理连接可创建/删除测试数据库和角色）、独立 S3 服务，以及可用 Chromium。变量名称及安全约束沿用 README；不要把测试环境指向真实用户数据库/对象桶。

```bash
npm run test:web
npm run test:web:unit
npm run test:shell --prefix apps/web --workspaces=false
npm run typecheck:web
npm run typecheck:shell --prefix apps/web --workspaces=false
npm run build:web
npx --no-install vite build --config apps/web/vite.local-shell.config.mjs
npm run build:web:docs
node tools/check-web-boundaries.mjs
node tools/dyoffice/compatibility-baseline.mjs --check
npm run check:theme-colors
git diff --check
```

在 `apps/web` 内，设置 `DYOFFICE_TEST_DATABASE_URL`、`DYOFFICE_TEST_S3_ENDPOINT`、`DYOFFICE_TEST_S3_ACCESS_KEY`、`DYOFFICE_TEST_S3_SECRET_KEY` 后运行：

```bash
node --import tsx --test --test-concurrency=2 \
  test/local-integration/files.test.mjs \
  test/local-integration/settings-boundary.test.mjs \
  test/local-integration/workspace.test.mjs \
  test/local-integration/ownership-rls.test.mjs \
  test/local-integration/authority-write-races.test.mjs \
  test/local-integration/t04-unimplemented-entrypoints.test.mjs

node --import tsx --test --test-concurrency=2 test/local-browser/*.test.mjs
node --import tsx --test test/native-docs/theme.test.mjs
```

Playwright 默认使用配套浏览器；可用 `DYOFFICE_TEST_CHROMIUM_PATH` 指定实际已安装的 headless Chromium。既有 `s3-minio.test.mjs` 另使用 `DYOFFICE_S3_ENDPOINT`、`DYOFFICE_S3_BUCKET`、`DYOFFICE_S3_ACCESS_KEY_ID`、`DYOFFICE_S3_SECRET_ACCESS_KEY`；最终本地运行将它们指向上述临时 SeaweedFS，不能把测试名称当成服务实现为 MinIO 的证据。

## 保留的范围与额外回归限制

T12 配置检查没有外部 I/O，不验证 Provider/搜索/重排/MCP 连通性，不代表 T13/T16/T18/T19 执行路径通过。旧开发 Token 的 AI/数据源/MCP 入口在本地 Cookie 栈继续默认拒绝。production 启动仍关闭，本轮无生产部署、真实账号操作或历史数据转换。

额外执行了完整桌面 Shell 回归，结果为 114 个文件、1235 个测试通过，另有 3 项失败：control-server Unix socket `EPERM`；window-close-guard 初始化 hook 超时并出现 Electron 下载；MCP headless generator 返回错误并出现 Electron 下载，具体生成器原因未完成定位。没有修改这些桌面基础设施，也不将该完整套件登记为通过。与本轮 Home 直接相关的既有导航、目录树、根目录、重命名、计数回归 53 项通过；最终 Web Shell 与浏览器结果单独登记。

