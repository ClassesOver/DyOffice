# T12 工作区与全局配置实施记录

**目标：** 按既有 T12 范围完成本地账号运行时的个人工作区、个人偏好和管理员全局配置，并留下可复现的本地验收证据。

**基线：** `feat/dyoffice-web` / `6f3702a514fbfdfcecec6746c9614a2ae0784369`。实现前从已登记上游恢复代码，对目标分支全部 7097 个 blob 逐项核对 SHA；本地基线树为 `ba2e2519fda2170ed90b64352a29a21318ecedab`。

收口时目标分支已更新为 `f92e4655299523c97cd9e2fc05687699855ee9cb`。23 个新增/修改文件逐 blob 校验后同步，核对完整目标树 `8c7be2418735ebad397413829b28532f108244b7`；保留其他任务成果，最终验收在该基线上的 T12 变更运行。

最终冻结为后续目标 `e2d922b1369b9e63ee73f10e7918e9936fc53448`（树 `9828a71a8370c70c50e0e9362bc1b71183485485`）：另 3 个独立 T19 文件已逐 blob 验证同步。所有最终汇总以该冻结基线加 T12 变更为准。

**权威规格：** [原实施计划 T12](../implementation-plan.md)、[架构第 6 节](../architecture.md)、[验收矩阵](../acceptance-matrix.md)、仓库 `DYOFFICE.md` 与 `CLAUDE.md`。

## 执行约束

- 复用 TypeScript 本地账号栈、受限 PostgreSQL 连接、服务端 Principal、原 Home 和 Settings UI。
- 保留个人工作区和四格式入口。配置管理员权限不授予他人文件所有权。
- 原开发令牌原型继续隔离；不能用旧 JSON store 测试替代新栈验收。
- 用户已要求闭环既有任务；按原计划直接实施。本轮不以 CI 作为阻断，不启用或修改 Actions。
- 先观察与行为相关的 RED，再最小实现、GREEN、受影响回归、类型/构建检查及独立审查。
- 不执行生产部署或真实用户账户操作；全部数据库与账号由测试临时创建。

## A. 全局配置与秘密

负责目录：`server/src/modules/admin/{catalog,secrets,service,routes}.ts`、共享 `settings.ts`、追加迁移 `0014_global_config.sql`、数据库角色与准入清单。

- [x] 基于 `config_admin` 和锁定会话建立授权；普通用户仅取无秘密的公共能力投影。
- [x] 复用 GenOffice 模型/媒体/搜索元数据，补齐重排及 HTTP MCP 配置目录；桌面专用认证保持不可用。
- [x] `getPublicSettings()`、`saveGlobalConfig(expectedRevision, patch)`；409 冲突原子回滚。
- [x] 省略密钥保留；独立 clear 动作；独立主密钥/keyId/AES-GCM/AAD；轮换和脱敏审计。
- [x] 真 PostgreSQL 证明部署/角色/秘密边界、撤销竞争、回滚和并发版本冲突。

固定接口：`GET /api/v1/settings/public`、`GET/PUT /api/v1/admin/config`、`POST /api/v1/admin/config/check`、`POST /api/v1/admin/config/rotate-key`。

`check` 明确只检查已保存配置和密钥可解密性，返回 `connection: not_run`。真实 Provider/模型/MCP 网络调用属于 T13/T18，不能把配置检查写成连接通过。

## B. 个人工作区

负责目录：`server/src/modules/workspace/`、共享 `workspace.ts`、追加迁移 `0015_workspace.sql`；集成新个人表的 FORCE RLS、复合外键和最小角色权限。

- [x] 持久化收藏、文件夹和真实访问时间；仅移除最近记录不删除文件。
- [x] 文件夹创建、重命名、移动与空目录删除；拒绝跨 owner、非法名、循环和并发成环。
- [x] 复用文件回收/恢复接口，回收内容不在活动目录中；恢复不改变原字节/版本。
- [x] 原 Home 通过新适配器消费真实服务；虚拟根展示全部文件，最近按访问时间排序。
- [x] 真 PostgreSQL 验证 A/B/Admin 隔离、连接池复用、失败回滚与生命周期。

固定接口：`/api/v1/workspace/files`、`/files/:id/{star,open,recent,folder}`、`/api/v1/workspace/folders`。文件夹查询中 `folderId=root` 表示根目录，省略表示全工作区。

## C. 前端和偏好

负责目录：`packages/browser-host/src/preferences.ts`、`apps/web/src/shell/`、原 `SettingsModal` 的 Web 接缝。

- [x] 会话 generation 在退出/换登录时失效，丢弃旧 load/save/check/CSRF 响应。
- [x] 同步双击、面板重挂载不能重复发 save/check；失败保留非秘密草稿，未知写入结果必须显式重新加载核对。
- [x] 独立全局配置管理界面复用原样式及 Provider 元数据；秘密不回读，不放入 URL 或浏览器存储。
- [x] 新增原 Home 的持久收藏/文件夹适配和回收站恢复界面。
- [x] 真实浏览器验证 Cookie+CSRF、配置/冲突/禁用、收藏/目录/回收恢复、退出隔离及主题下下载字节一致。

## D. 收口

- [x] 运行 Web、Shell、T12 真 PostgreSQL、必要既有身份/文件回归，记录 skip/blocked。
- [x] 类型检查、Web/local-shell 生产构建、浏览器依赖边界、`git diff --check`。
- [x] 独立审查整体变更，修复重要问题并复测。
- [x] 同步任务表和 `evidence/t12-settings-workspace.md`，提交可审查分支/PR。

## 本轮裁定

1. 采用新 TS 本地账号栈，旧原型不升级为权威配置存储；否则会绕过已验收身份边界。
2. `check` 不执行外部网络调用；UI 明示其用途，模型流/工具执行禁用传播留给 T13/T18/T19 的实际执行接缝验收。
3. 文件夹删除仅允许空目录；已有文件回收站支持恢复，不在 T12 引入永久销毁对象流程。
4. 按当前原生编辑器能力展示入口。主题验证覆盖四格式工作区/原件下载，并追加 DOCX 原生编辑→保存→下载：浅/深主题下同一编辑的正文 XML 完全相同，所有原始非正文 part 保持字节一致。此证明不扩展为未接入的 XLSX/PPTX/PDF 编辑器保存/导出通过。
