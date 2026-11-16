# T07 原生 DOCX 浏览器接缝

日期：2026-11-15。此记录是实验实现与本地验证证据，不代表整个实施计划、四格式编辑或企业发布完成。

## 实现

`apps/web/src/editors/docs-entry.tsx` 挂载现有 `apps/docs` App/Tiptap；模块解析 Worker、原始 DOCX parser/writer、分页、字体 CSS 和原有保存队列均复用上游实现。`mountDocsEditor(host,element,fileId)` 返回真实选区读取、原生序列化、普通保存和销毁接口；没有以预览页代替编辑器。桌面启动路径不传 Web host，保留原先行为。

会话 BrowserHost 对 UUID 版本读回做实际 SHA-256/长度校验。保存预留绑定已打开的基线和 editor/session 租约，发送字节后提交冻结的 SaveInput。未知提交结果保留同一请求及幂等键，先确认回执；旧续租响应不能清除更新的接管结果，续租不能覆盖未知提交状态。原有 PM 快照与复合 dirty 检查继续决定原生编辑器是否接受保存；保存期间的新输入留在当前草稿中。离页提示读取原生 dirty 状态，pagehide keepalive 在清理宿主前发出租约释放请求。

桥接对象只提供该闭环实际需要的窄接口、明确拒绝的未支持操作及没有桌面推送来源的订阅；没有通用 IPC 代理、文件系统路径授权或浏览器内的模型凭据。路径别名只在当前文件的桥内识别，服务器授权始终使用 Cookie 推导的身份和 UUID。AI 面板暂不挂载；个人语言/主题/作者/自动保存读取已有偏好 DTO。浏览器字体使用已有捆绑资源与浏览器可用能力，不伪造操作系统字体清单。

## 启动与权限

`DYOFFICE_AUTH_MODE=local`、文件实验 API、migration 6 和 HTTPS Origin 是前提。根目录 `npm run build:web:docs` 产生独立的 `apps/web/dist-docs`，再设置 `DYOFFICE_NATIVE_DOCX=experimental`。默认关闭；错误模式、缺少文件 API 或缺失/不安全的构建产物使启动失败。详见 [运行说明](../../../apps/web/README.md)。

`/native-docx/?fileId=UUID` 要求有效会话和本人拥有的未删除 DOCX；资源请求同样要求会话。仅清单和构建时产生的资源 inventory 中的文件可被读取，逐次 realpath 校验，禁止回退到源码。响应 private/no-store、nosniff、限制 CSP。直接下载链接指向已保存的不可变版本，并由既有 content 路由再次授权。新增历史元数据端点只读本人文件的指定版本。

只有加载有效原生构建的实验服务将 DOCX 标记为 editable；其余三格式仍 unsupported。Web 边界扫描跳过编译后消失的显式 type-only 引用，混合/副作用引用仍保留。仅两条已审阅的纯 renderer 工具子路径允许继续遍历，electron-utils 包根和其他桌面导出仍拒绝；负例测试证明纯工具内部新增 Node 依赖仍会失败。

## 验证

当前已观察到的最终结果：

| 检查 | 实际结果 |
| --- | --- |
| Node 22 完整 PostgreSQL/HTTP 集成 | 114/114 通过 |
| Node 22 原生 Chromium/TLS 与实际服务启动 | 5/5 通过 |
| Node 22 Web 单元 | 37/37 通过 |
| 旧 Web 接口 | 32/32 通过 |
| 原型构建/HTTP | 2/2 通过 |
| Web 与原生 Docs 类型检查 | 通过 |
| Node 22 docx-engine 全量 | 219 文件，2238 通过、1 跳过 |
| Node 22 Docs 全量 | 519 文件通过、4 文件跳过；6402 项通过、20 跳过；1 项 beforeEach 超时 |
| 超时文件隔离复跑 | save-as-default-dir 的 10/10 通过 |
| 边界扫描 | 553 个运行模块，0 违规 |
| 兼容基线 | 84 输入文件，0 漂移；只更新根 scripts 对应哈希 |
| 基线/CI/IPC 工具测试 | 13/13 通过 |
| 边界扫描器回归 | 13/13 通过 |

Docs 全量耗时 1794.55 秒。唯一失败位于 `save-as-default-dir.test.ts:53` 的 beforeEach：重置模块并导入未修改的桌面 main 期间超过原有 10 秒，测试正文尚未执行。同一 Node 22 下隔离复跑该文件 10/10 通过（首次 11.19 秒；全量结束后再次复跑 8.13 秒，均含全部 hook），未修改该文件、断言或超时。完整运行仍记录为含一项超时，不能合并复跑结果宣称全量全绿；CI 的独立 Node 22 job 已配置，但尚无远端 CI 执行证据。

- 真实浏览器使用既有 Tiptap DOM 和键盘/原生表格 UI；检查段落、表格、撤销/重做、剪贴板粘贴、保存、下载、重新打开及版本历史。
- 直接检查保存对象的 `word/document.xml` 和原始未编辑 customXml 部件，不仅检查页面文字。
- 延迟成功响应期间继续输入、另一标签页接管、保存响应丢失后确认原回执，均使用真实 PostgreSQL/HTTP 对象链路。
- 页面/资源鉴权、A/B 隔离、源码拒绝、实际服务启动开关，以及默认 unsupported 能力门槛纳入验证。

验证环境使用授权的临时数据、PostgreSQL 17、真实对象存储 fixture、Chromium 149 和 Node 22。TLS 自签名证书与忽略证书错误仅用于测试。Docs 全量回归必须使用项目规定的 Node 22；宿主 Node 26 的全局 localStorage 会干扰既有 DOM 测试。终端 fixture 修复了 EOF 后退出状态尚未回收的竞态，保留原来的总超时、数据库断言与无密码回显检查。

## 未完成的验收

外部 Microsoft Word 兼容样本与人工 QA 尚未执行，T07 验收框不能全部勾选。完整工作区/登录 UI、AI、桌面菜单功能替代、跨崩溃草稿恢复、四格式及企业发布继续按后续任务推进。当前内存边界仅覆盖已有实验检查，原生构建与回归在这台约 2.4 GiB 主机上顺序执行；不据此宣称生产容量、OS 沙箱或恶意内容扫描已验收。production 仍拒绝启动。
