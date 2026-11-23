# DSH DyOffice 预览

执行 `/dyoffice word 创建一个活动策划` 后，可以在任务消息里阅读已保存的正文，查看 DSH 交办、DyOffice 交付和后续审阅的记录。底部显示同步状态和消息接收方。点击「编辑器」查看原生编辑器预览，点击「在新窗口打开 DyOffice」编辑同一份文件。XLSX、PPTX、PDF 使用相同入口。

![DSH 任务消息中的 Word 正文与双方消息](../../docs/dyoffice/evidence/dsh-plugin-preview.jpg)

要在聊天中运行应用，需在 DyOffice 服务端设置 `DYOFFICE_DSH_EMBED_ORIGIN=http://localhost:3080`，从这个地址访问 DSH，并在同一浏览器登录 DyOffice。本机示例：DSH 用 localhost:3080，Office 用 localhost:3081。未允许嵌入时，点击新窗口入口启动 Office。历史消息保留正文摘录和打开原文入口；只有当前任务在聊天里运行原生应用。

1. 使用本仓库版本启动 DyOffice，依照[频道与后台任务说明](../../docs/dyoffice/assistant-background.md)开启后台执行。
2. 安装插件并配置授权 Token 文件路径；DyOffice 地址可配置为默认值，也可在授权提示中填写。已有本地源码时，可把下面的 `dsh` 替换为 `node ~/pros/dsh/apps/cli/lib/bin.js`。

   ```bash
   cd ~/pros/DyOffice/integrations/dsh-dyoffice
   export DSH_DYOFFICE_MEMBER_FILE=~/.dsh/dyoffice-token.json
   mkdir -p ~/.dsh
   dsh plugin --profile web add "link:$PWD"
   dsh web
   ```

3. 在 DSH 输入框输入 `/dyoffice`，从 slash 命令菜单选择 DyOffice，再选择格式子命令并填写任务：`/dyoffice word <任务>`、`/dyoffice xlsx <任务>`、`/dyoffice pptx <任务>` 或 `/dyoffice pdf <任务>`。缺少凭据时，输入框会提示授权。
4. 在 DyOffice 选择频道文档并开启「允许后台读取已保存版本」，选择 Token 有效期（1 小时、24 小时、7 天或 30 天，默认 24 小时），生成并复制 DSH 授权 Token。回到 DSH 授权提示填写 DyOffice 服务 URL 并粘贴 Token，点击连接。URL 只填写 HTTPS 服务源地址，或本机回环 HTTP 地址，不带路径和查询参数。Token 本身就是成员凭证，无需申请、批准或兑换；连接成功后，等待授权的任务会自动继续。

Token 受签发者的 DyOffice 登录会话约束。登录会话过期或注销后，需要在 DyOffice 重新生成 Token 并连接。

要创建文件，在频道分享中勾选「允许 DSH 在我的工作区创建新文档」再生成 Token。四种格式用法相同：

- `/dyoffice word 创建一个活动策划`
- `/dyoffice xlsx 创建一个活动预算表`
- `/dyoffice pptx 创建一个项目汇报`
- `/dyoffice pdf 创建一个活动通知`

要传一个 DSH Skill，写成 `/dyoffice word --skill=events 创建活动策划`，把 `events` 换成 DSH 中的 Skill 名称。四种格式都支持。Office 助手收到本次任务的 Skill 正文（最多 24 KB），不会导入脚本、关联文件或权限，也不会把 Skill 正文写进共享聊天记录。

DSH 将需求交给当前文档的 DyOffice 助手。工具由 Office 助手调用，聊天内的小窗口直接显示该应用；下面的对话显示撰写、保存和审阅状态。助手保存新版后，DSH 才会审阅，意见显示在双方对话中。仅需空文件时可用 `/dyoffice xlsx 创建空白文件 demo`，其他格式同理。

`DSH_DYOFFICE_ORIGIN` 可设置为默认服务源地址；同机开发可使用 localhost 或环回 IP 的 HTTP 地址。一个 DSH Web 进程使用一个频道。Token 和所填 URL 仅由 DSH 后端读取，面板只在 DSH 所有者会话显示数据。

支持 `conversation/route-message` 的 DSH Web 会把协作交接和审阅显示在对应的 `/dyoffice` 对话消息里。正文保存后，在同一个 DSH 会话输入普通消息即可继续问 DyOffice 助手；DSH 把消息原文转入当前文档的 Office 助手。首轮和追问都出现在该助手的原生对话中，后续消息沿用同一段对话历史。同一 DSH 页面里切换会话不会关闭正在运行的 Office 窗口；关闭或刷新整个页面会中断其中的任务。点「结束 Office 对话」可切回 DSH。这个会话接续保存在当前浏览器页面，刷新页面后不会自动恢复。可直接要求修改当前文档；写入使用 Office 原生文档工具并检查保存结果。

同一 DyOffice 账号在另一浏览器打开同一文档，可在 Office 助手面板看到新的提问、流式回答和已保存的问答。旁观窗口不会重复发起模型请求。工具参数、工具输出和 DSH 自己的审阅回执不写入这份共享记录。

在另一浏览器打开同一份 Word 时，两边可以同时输入正文。编辑器合并正文修改，由持有保存租约的窗口提交 DOCX。请使用同一份文件链接；下载后重新上传、或打开同名副本，都属于不同文档。这个功能同步 Word 正文；页眉等文档属性以及 XLSX、PPTX、PDF 不使用这套并发合并机制。

也可在 DSH Web 的 `cordis.patch.yml` 中为插件指定地址和 Token 文件路径。授权 Token 只保存在 DSH 服务端，文件权限为仅当前用户可读写；侧栏不会把 Token 放入 URL 或聊天内容。

```yaml
- id: dyoffice-preview
  config:
    memberFile: /absolute/path/to/dyoffice-token.json
```
