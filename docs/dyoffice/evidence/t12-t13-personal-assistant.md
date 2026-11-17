# T12 工作区与 T13 个人助手验收

T12 复用已合入的工作区、个人偏好与全局配置。T13 在本地账号模式下按显式配置启用。部署步骤见 [Provider Gateway README](../../../apps/web/server/src/modules/providers/README.md)；普通用户的额度由部署管理员预先配置，无默认额度。

| 项目 | 证据与范围 |
| --- | --- |
| T12 工作区 | Chromium + PostgreSQL：导入、文件夹、最近、收藏、回收站恢复、切换账号后不可见。浅色与深色主题分别比对 DOCX、XLSX、PPTX、PDF 下载原件，字节和文件版本一致；此用例使用首页下载回退。 |
| T12 全局配置 | Chromium 双标签页真实版本冲突，失败保留草稿并可重读保存；密钥可省略保留、清空和重新加密；禁用配置退出公开目录。对话、图像生成、网页搜索和重排条目经过公开目录验证。设置与工作区的 PostgreSQL 测试 31 项通过，覆盖个人字段越界、配置回滚和租户隔离。“检查配置”不连接供应商。 |
| T12 个人 Skills | 单个 `SKILL.md` 导入、查看和删除；相同名称按部署和账号分开。密码更新后，当前页面仍可查看自己的 Skills，旧会话证明失效；切换账号后原页面也无法读取新账号数据。配置管理员自己的会话读不到他人的 Skills。PostgreSQL 在有效会话之外或会话所有者不匹配时拒绝访问。复用现有账号恢复机制：拥有有效重置码并恢复登录后，仍是同一账号。 |
| T13 网关 | POST SSE 复用原有传输和 AgentLoop；目录只列出启用、匹配固定配置、有密钥且当前用户有额度的模型。按用户、配置版本和会话检查与记账。浏览器端不接收密钥。额度缺失、禁用、撤销或越权时服务端拒绝。助手工具限于明确列出的读取操作，写入仍由 T14 审批处理。 |
| T13 DOCX | 已在 Chromium + Fastify + PostgreSQL 和原生 DOCX 页面接通；使用模拟 DNS/TLS/HTTPS 上游验证流式回复、个人额度和选择的个人 Skill，并确认原 DOCX 字节不变。读取 Skill 时停止可阻止请求；第二条不附加 Skill 的请求不重发上一条的 Skill 正文。运行内固定模型；切换模型时下一次运行不共享旧模型的上下文。 |
| T13 XLSX | Chromium + Fastify + PostgreSQL：真实 Univer 界面读取由 Rust 针对仓库样例生成的固定回放数据。模拟上游验证个人 Skill 正文与只读工具清单；真实 `gpt-5.6-luna` 正确读出样例表格的 A2 值 `12.5`。两次均核对个人额度结算与原件字节。完整原生用例仍需有权限启动 systemd 沙箱的测试宿主；本机的授权脚本固定在旧工作树，启动时有 Node 模块解析错误。 |
| T13 PPTX / PDF | PPTX 的隔离门禁和 PDF 浏览能力测试共 21 项通过。当前 Web 服务拒绝启动缺少 OS 隔离的 PPTX 宿主；PDF 有独立预览能力，但未接入本地账户助手。两种格式的助手验收均未开始。 |
| T13 真实模型 | **DOCX 和 XLSX 回放用例通过。** 用户授权的 OpenAI-compatible 供应商，模型 `gpt-5.6-luna`。DOCX 通过真实 HTTPS 接收 SSE 文本和唯一终态，模型读出自建文档中的随机测试码；XLSX 见上。仅发送了自建样例。 |

Skills 正文在用户主动附加时会发送给所选模型。浏览器不把原文存入本地聊天记录；模型答复有可能引用选中的内容。账号内的旧编辑器在会话被替换后需要重新打开才能发送。

真实模型验收为显式启用：在临时配置文件中填写 `baseUrl`、`model`、`allowedIpv4` 和 `keyFile`（密钥文件路径），设置 `DYOFFICE_LIVE_ASSISTANT_TEST_CONFIG` 与隔离数据库的 `DYOFFICE_TEST_DATABASE_URL`。DOCX 用例为 `node --import tsx --test apps/web/test/native-docs/assistant-live.test.mjs`；XLSX 回放用例为 `node --import tsx --test --test-name-pattern='recorded synthetic' apps/web/test/native-sheets/save-download-roundtrip.test.mjs`。未设置真实配置时真实用例跳过，不会向外发送请求。使用新构建的对应编辑器入口。

真实配置验证暴露出网关把整个 `172/8` 视为私网，以及双栈 DNS 查询包含 IPv6 的问题。修正后只查询 IPv4，继续拒绝 `172.16.0.0/12` 和不在白名单内的地址，连接仍校验 TLS 和固定对端。
