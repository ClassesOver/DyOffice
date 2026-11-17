# Safety correction at integration

This historical plan does not establish OS isolation. Ordinary Node fork is test-only; formal PPTX HTTP mounting remains unconditionally fail-closed until a verified isolated host exists. Real systemd/openEuler acceptance is not complete. See docs/dyoffice/evidence/t10-pr113-safety-candidate.md for the corrected boundaries and tests.

# T10 native Slides Web design（实施后修订 2026-11-17）

Goal: mount the original GenOffice Slides renderer in the Web workspace with real PPTX open, edit, save, download, and reopen verification, reusing the T09 lease fencing and T06 commit contracts.

> 修订说明：初稿声称“PPTX 纯 TS、格式层无需 Rust 二进制或 systemd 沙箱”。实施时纠正：解析不可信 PPTX 必须与 API 进程隔离。最终方案为每会话 fork 独立 Node 子进程（serialization:'advanced'），父进程不 import 任何引擎代码；不需要 Rust 二进制，但 OS 级进程隔离必须有。

## Architecture

- `@genoffice/pptx-engine`（parse/save）、`@genoffice/pptx-ops`（registry + runTxn 原子事务）、`@genoffice/pptx-render`（RenderTree）保持为源码消费。
- **进程隔离**：`apps/web/worker/src/native/pptx-session-host.ts` 每会话 fork 一个子进程（`pptx-session-child.ts`），不可信 PPTX 只在子进程解析；每调用 30s 超时（SIGKILL 兜底）；句柄绑定 (fileId, revision)；子进程崩溃全部 pending 拒绝 SESSION_CLOSED；`pptx-md-raw.mjs` 同步 registerHooks 解决 pptx-ops 的 `*.md?raw` 导入。
- 会话层 `pptx-session.ts`：串行队列、generation fencing、ZIP/负载上限（32MiB 输入、256KiB payload）、有界 undo/redo 快照（50 步/16MB 双上限）、`created` echo（供桥定位新增元素/页）。

## Server

- 会话白名单（16 op）：setText/setFill/setStroke/addElement/deleteElement/setTransform/reorderElement/ungroupElement/setFont/setParagraphFormat/findReplace/addBlankSlide/addSlideWithLayout/duplicateSlide/deleteSlide/moveSlide/setNotes，逐 op 字段校验后交 runTxn；组合内编辑支持 `group` 字段（registry 深度校验）。
- `modules/slides/{service,save,routes}.ts`：每次调用经 `files.openFile/download` 重授权（owner RLS）+ 格式 415 + pinned revision 下载；generation 栅栏 409；T06 commit 后自动 adopt（head sha256 匹配则换钉新 revision）；admission 并发上限 + maxSessions 429 + TTL 清扫。
- save：lease 续期 → head/base 校验 → session exportForSave → `revisions.stageUpload` → `receiveUpload` → 再续期 → receipt；失败 cancelUpload。
- routes：`/api/v1/files/:id/slides/{open,slide,slides,apply,undo,redo,export,uploads}`，CSRF+session+no-store，apply bodyLimit 256KiB。
- app.ts：`nativeSlidesDirectory` + `/native-pptx/*` 静态路由（CSP 含 `wasm-unsafe-eval` + `media-src 'self' blob:`）+ capabilities `pptx: editable`；onClose → sessions.closeAll。

## Browser

- **实证修正**：原 Slides 渲染器 `App()` 无任何 props 接缝（Sheets 式 host 是 T09 专属）。在 `apps/slides/src/renderer/App.tsx` 新增真实接缝：`SlidesEditorHandle {saveAndWait,isDirty,reload}` + `SlidesAppHost {readOnly,inPlaceSave,assistantAvailable,onDeckOpened,onOpenFailed,onEditorReady}`；纯增量，桌面路径不受影响。
- `slides-entry.tsx`：`mountSlidesEditor` + `window.slidesApi` 桥 + acquireLease/startRenewal/subscribe + 状态栏（Save and download / Take over / Confirm）+ Ctrl+S 原地保存 + beforeunload 守卫。
- `slides-bridge.ts`：契约 = 会话按 (fileId,revision) 钉定 + generation 栅栏，无 sessionId；每个 body 携带 `{revision,generation}`；apply 回 `{generation,dirty,changed,created?,order?,index?,sections?,history}`；save = `slides/uploads`（服务端 export+stageUpload）→ host T06 commit；下载只绑 confirmed receipt；丢回执挂起 + 本地变异栅栏，confirm 后 adopt 新 head。桌面独占能力显式 unavailable，白名单外渲染能力优雅降级（null/false）。
- `slides/index.html`、`vite.slides.config.ts`、`tsconfig.slides.json`、`build:slides`/`test:native-slides` scripts。
- browser-host：`session-files.ts` 新增 `saveSlides`/`reconcileSlides`（未动 saveSheets）。

## Save

与 T06 sheets 同构：不可变 receipt、幂等、CAS head、lease fencing。结构操作（页增删复制移动）与属性操作（文本/字体/填充/变换）均走同一导出-提交链；bridge 丢回执时冻结本地变异直到确认回执 adopt。

## Tests（本机已验证）

- 引擎级 `apps/slides/tests/pptx-session.test.ts`：17/17（白名单拒绝/接受、undo/redo 生成栅栏、深度上限、notes 保留、created echo）。
- worker 隔离 + 服务端 4 文件 + 浏览器端 3 文件合体：**30/30**（child fork/关闭/击杀/超限、ownership/pinning/adopt/并发/槽位、T06 commit 幂等、customXml 字节级保留、全路由+CSP+CSRF/origin/foreign 404/403、bridge/entry/host-save mock 链）。
- `apps/web` 全量回归：265 过 / 0 挂 / 1 既有跳过；`typecheck`（slides/server/worker）绿；边界检查 1271 文件 0 违规；`build:slides` 产出 dist-slides + `.vite/native-assets.json`。
- **媒体/母版保留回环**（真实隔离会话）：注入图片的 PPTX 经 open → setText → export 后，`ppt/media/*`、`ppt/slideMasters/*`、`ppt/slideLayouts/*` 全部字节 identical，仅被编辑的 slide1.xml 变更，图片元素与 rels 保留、新文本写入。untouched parts 字节保留由此验证。

## Explicit non-goals / 已知边界（如实）

- **图片视觉渲染**：渲染树尚无 media resolver/系统字体——图片字节在保存链路完整保留，但浏览器内图片内容按占位呈现；不属于本次门禁（会话注释明示）。
- **真实浏览器全栈 E2E**（真实服务端 + 真实登录 + 下载附件 + 重开）尚待专项（服务端真实链路已由 service/save/routes 测试覆盖，浏览器侧为 mock 服务端链路）。
- **外部 PowerPoint 复开**未执行，保持未测。
- 桌面独占能力（打印/视频导出/本地字体）显式 unavailable；WPS 现象为 T09 遗留第三方问题，不在本任务范围。
