# T09 Sheets 实验启动接线

T09 仍在验收中。以下记录启动接线及已执行的检查，不代表完整 T09 验收通过。

## 构建和启用

在仓库根目录使用 Node 22，先构建浏览器和服务器 gateway：

```sh
npm run build:sheets --workspace=@dyoffice/web
```

已有本地账户模式、独立 auth/business 数据库凭据、文件存储和部署 ID 配置后，增加：

```sh
DYOFFICE_NATIVE_XLSX=experimental
DYOFFICE_NATIVE_BINARY=/absolute/path/to/xlsx-sidecar
DYOFFICE_NATIVE_SHA256=<该二进制的实际 SHA-256>
```

`DYOFFICE_AUTH_MODE` 必须为 `local`。程序仍拒绝 production 模式。原生执行使用 T08 的 systemd 主机隔离，需要现有服务权限和 cgroup 支持。没有 Docker 依赖。

默认加载 `apps/web/dist-sheets/` 和 `apps/web/dist-sheets-server/gateway.mjs`。可通过 `DYOFFICE_NATIVE_XLSX_DIRECTORY`、`DYOFFICE_XLSX_GATEWAY_MODULE` 指定由部署管理员控制的构建位置。构建文件缺失、原生程序哈希不符或隔离启动失败会阻止服务器启动。

打开 `/native-xlsx/?fileId=<拥有的 XLSX 文件 UUID>`。入口使用 Cookie 登录和文件所有权校验；原生请求使用文件版本引用，不接受服务器路径。保存通过 T06 上传暂存、租约和幂等提交。关闭服务器会取消并等待该运行时的原生调用。

## 当前证据

`apps/web/test/native-sheets/runtime.test.mjs` 两项测试通过：

- 实验配置约束、实际隔离程序启动、错误哈希拒绝、工作簿读取、关闭后拒绝新任务。
- 启动真正的 `server/index.mjs`，使用独立 auth/business 数据库角色和文件存储，读取 `xlsx: editable` 能力、拥有文件的原生 metadata 和页面，SIGTERM 后以 0 退出。

服务器 TypeScript 检查通过。真实浏览器正常保存和丢失响应后的后续编辑保留测试已通过。完整公式/格式/图表/名称/批量工具撤销验收、剩余接口、整体回归和真实 Excel 复开仍需完成。

## 草稿 PR 的已知未完成项

本实现当前仍为草稿，未闭环 T09：

- Name Manager 更新定义后，依赖公式可能仍使用旧范围。真实浏览器用例保留失败断言，尚未修复。
- 只读加载问题已修复：在用户命令入口限制编辑，允许原有内部导入、选择和计算写回；双页面只读、显式接管、保存和原编辑器租约失效测试通过。
- 剩余原生接口与能力约束、整体回归、边界检查和最终审查尚未完成。
- 尚无已连接的 Excel 会话，真实 Excel 复开核验未执行。

已分别通过的真实浏览器场景包括普通编辑保存与复开、丢失提交响应后的后续编辑保留、公式及数值格式、图表标题编辑，以及原有工具批处理的整体撤销/重做与保存。单项通过不代表当前完整测试套件通过。

## 工作簿媒体读取

图片读取使用拥有文件的不可变版本和图片对象 ID，经原 Rust `read_media` 返回媒体类型和内容。浏览器无需提供路径。与其他读取一致，原生工作结束后再次检查登录和文件可见性。

媒体集成测试使用含 PNG 的真实 OOXML 图片对象，验证返回字节一致；其他用户和管理员访问均为 404，路径参数为 400，缺少 CSRF 为 403。浏览器图片显示验收尚未执行。
