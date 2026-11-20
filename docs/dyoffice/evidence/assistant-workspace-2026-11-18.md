# Office 助手协作区实施与验收

日期：2026-11-18。设计：`docs/design/assistant-workspace.md`。

## 实际实现

- DOCX/XLSX 接入共享 workspace 契约，提供对话、助手、任务视图。切换通过显隐实现，不卸载现有聊天循环。
- 同一输入区可选择 Office、内置/服务端注册 harness、已连接频道 Agent。显式选择直接调用对应执行接口，不依赖模型猜测或提示词模拟路由。
- harness 请求绑定发送时的所选 Office 模型；Office 自身的委派保持原来按 run 固定模型的行为。
- 直接委派仅发送输入文字；有选区、附件或 Skills 时阻止隐式外发并保留草稿。失败或未知提交不清理草稿；执行期间的新草稿不被旧结果清除。
- coding client 的统一会话任务视图同时包含直接委派和 Office 工具委派。显示执行方、来源、状态、详情、输出和取消操作。
- HTTP 拒绝可标记失败；断流、超时或本地取消不能确认远端结果，显示结果待核对。不伪造远端取消确认。
- 频道管理移入助手页，频道任务及原有分析交付移入任务页。邀请、审批、暂停、移除、取消、刷新仍使用原客户端和权限链。取消失败有显式反馈和刷新入口。
- 模型入口适配同一工作区中并行更新的共享 AiModelPicker 弹层；频道 Agent 显示模型由外接端管理。

## 验证

- 定向 shell：5 个测试文件、41 个测试通过，包括真实编辑器工厂 → 显式选择 Codex → 所选模型绑定 → SSE 返回 → 任务结果显示。
- 定向 unit：7 个测试文件通过，覆盖 coding/assistant 客户端、workspace 路由、频道契约/客户端及分析交付。
- Web（含服务端）、Docs、Sheets、shell TypeScript 检查通过。
- DOCX、XLSX 浏览器构建通过。构建仍有已有大分块及第三方注释提示。
- 独立浏览器组件检查：320/360/400px × 浅色/深色，验证视图切换、原聊天显隐、目标选择、模拟 SSE 结果、草稿保留、长模型名和水平溢出。
- 独立代码审阅未发现剩余 Critical/Important 问题；其发现的频道任务取消失败反馈遗漏已先补回归测试、再修复并复查。

可复现命令：

```bash
npm run test:shell --prefix apps/web -- --run test/shell/assistant-workspace-panel.test.ts test/shell/assistant-channel-controls.test.ts test/shell/assistant-channel-panel.test.ts test/shell/editor-assistant-status.test.ts test/shell/analysis-delivery-panel.test.ts
node --import tsx --test apps/web/test/unit/assistant-workspace.test.mjs apps/web/test/unit/coding-workspace.test.mjs apps/web/test/unit/coding-client.test.mjs apps/web/test/unit/assistant-client.test.mjs apps/web/test/unit/assistant-channel-client.test.mjs apps/web/test/unit/assistant-channel-contract.test.mjs apps/web/test/unit/analysis-delivery-client.test.mjs
node --import tsx --test apps/web/test/local-browser/assistant-workspace-ui.test.mjs
npm run typecheck:web
npm run typecheck:web:docs
npm run typecheck:web:sheets
npm run typecheck:web:shell
npm run build:web:docs
npm run build:web:sheets
git diff --check
```

浏览器检查需可启动 Chromium 和本地 loopback 服务；受限沙箱需按实际环境授权。浏览器 fixture 不发送真实模型请求。

## 范围与限制

本次是界面及已有执行链路的接入，不等于当前部署已安装并启用所有 harness。未使用真实模型或真实外接进程完成端到端执行。现有运行服务是否已配置 Codex、外接频道开关及外接端能力仍由服务配置决定，本次增量已将本机 `.dyoffice/local.env` 的 `DYOFFICE_CODING_AGENT` 从 `off` 改为 `on`，需下次服务启动生效；未重启正在运行的服务。

内置任务历史仅保存在本次编辑器会话；刷新不能恢复进程或未确认结果。频道持久状态继续由原服务端维护。现有分析文件下载、支持的插入及保存操作继续使用原有权限和收据，不增加新的自动文档写入行为。


## 团队对话增量验收

- Office 保持默认协调者，编码技能提示要求将编码、脚本、调试、测试和分析执行交给 harness；这是模型工具调用规则，未宣称确定性的自然语言任务分类。
- DOCX/XLSX 原生对话中按首次观察顺序展示真实 harness/频道任务，状态更新替换原卡片；任务交接与返回结果同处聊天流。发送不跳转任务页。
- @成员选择、助手职责/可用状态、统一任务筛选、任务与对话定位、统一取消错误反馈均已接入。外接直发任务记为用户发起，执行成员通过稳定 ID 区分。
- 内置 harness 配置无环境变量时默认开启，仅显式 off 关闭。已找到本机 Codex CLI，但没有启动真实 Codex/模型任务验证。
- 定向 shell 回归 5 文件 43 项通过；8 个 Node 单元文件通过；agent-core 委派技能 3 项通过。
- 浏览器 320/360/400px × 深浅主题全部通过，检查直接委派结果在对话中显示、原生草稿保留、任务来回定位、模型名省略和无水平溢出。截图位于 `/tmp/dyoffice-assistant-ui-sXkDO7`。浏览器使用模拟 SSE，无真实模型调用。
- 审查发现的筛选被定位重置、菜单按钮 Enter 被输入捕获拦截两项均已补回归并修正。
- 最终增量 DOCX/XLSX/shell 类型检查及 DOCX/XLSX 构建通过；构建仍有既有大包体积提示。

## Codex 任务卡片流式输出

根因：coding route 在 registry 完成后才返回单条 JSON delta，browser coding client 只累积最终 JSON，不提供中间任务通知。已新增独立 progress SSE 事件，模型桥接收到公开 assistant text 时立即上报、harness 固定命令生命周期上报，经过 registry context 和 route 转发到任务卡片。reasoning、工具参数和命令 stdout 不进入该进度流。最终结果仍以独立 JSON delta 解析，仅实际返回结果才能标记完成；中断保留进度和 unknown_outcome。

卡片执行时展开进度，支持跟随最新输出（手动向上滚动后暂停跟随）、执行阶段提示、取消和完成后过程记录。服务端按实际序列化字节限制 progress 为 64KiB，总额度留出原最终结果空间；7000 段单字符进度与 200k 最终结果回归通过。

验证：43 项 shell 回归通过；coding/client/workspace/routes/registry 等 6 个单元文件通过；假 CLI 子进程 7 项与模型桥接 8 项通过（后两者需允许本机进程和 loopback）；web/server、DOCX、XLSX、shell 类型检查通过，DOCX/XLSX 构建通过；浏览器六种窄屏/主题通过，验证完成前已显示进度。截图 `/tmp/dyoffice-assistant-ui-FAhOnf/streaming-360-light.png`。未调用真实模型复现截图中的那次失败，已有 unknown_outcome 不会被伪造为完成；需加载新构建并重启服务后体验新链路。

## 左右对话与固定尺寸任务卡片

用户消息右对齐，增加本地 SVG 用户头像；Office 消息左对齐，头像置于气泡外，保留原生内容及工具操作。harness 卡片统一固定 280px 高，宽度随面板自适应；标题/状态/操作固定，正文和流式输出在内部滚动，执行到完成尺寸保持不变。

43 项 shell 回归及 DOCX/XLSX/shell 类型检查通过；320/360/400px 深浅主题浏览器检查通过，额外验证头像与气泡左右关系、执行中和完成后卡片尺寸一致。截图 `/tmp/dyoffice-assistant-ui-z4ZiBD/streaming-360-light.png`。服务已重启，readiness 返回 ready；该健康状态不等于真实模型调用已成功，先前 AI stream unavailable 尚未用真实模型复现归因。

## Office 写入 Word 修复

用户报告生成文档无法落入 Word。根因是 browser assistant 适配层只允许读取工具，并追加 Document mutation unavailable，原生 write_document/insert_content 等被过滤。现仅对原生 editor 显式启用6个现有DOCX写作/编辑工具：write_document、insert_content、replace_blocks、replace_selection、apply_ops、delete_blocks；普通host默认仍读取，exec等不在白名单。个人/共享gateway历史工具集合同步，续轮不拒绝已完成的写工具历史。Office职责明确文档创作直接使用原生writer，编程/分析才委派harness。

实时可写检查：readonly skill不提供这些写工具、执行入口拒绝写入；流式writer返回及定时draft刷新检查editable，失去编辑权限后不继续写入，允许清理临时草稿。

验证：client回归先失败后修复通过；真实PM+AgentLoop+模拟SSE覆盖规划write_document调用→无工具HTML增量→正文写入→续轮，及readonly/运行中权限丢失。Word writer共15项通过，4个browser-host单元文件、10项shell回归通过；web/server、DOCX、shell类型检查及DOCX/XLSX构建通过。真实共享模型连接检查成功；重启后最小写作请求返回write_document调用（没有执行修改用户文档），服务ready。独立只读审查未发现剩余Important/Critical。
