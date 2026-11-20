# PDF Canonical Pending Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Follow the dependency order and review each independently testable batch. This document is a design, not evidence that the implementation is complete.

**Goal:** Web PDF 的九项 canonical `apply_ops` 支持跨类别原子批次、一次撤销和待保存预览；只有用户 Save 才将完整待保存状态写为一个新 revision。

**Architecture:** 浏览器持有绑定 `fileId/baseRevision` 的统一 pending snapshot；纯 planner 在副本上校验和归约整批操作，成功后一次替换。保存通过单个隔离 native job 将 snapshot 编译为原始页坐标的 PC save request，再复用现有 lease → prepare → stage upload → commit/receipt recovery 链路。多个 native 内存处理阶段可以存在，但不能调用多个 HTTP mutation 或提交中间 revision。

**Tech Stack:** TypeScript、React、现有 PDF edit registry、PDF.js、pdf-lib、fontkit、PC PDFium writer、Node isolated PDF process、PostgreSQL revision/lease contracts。

**Spec:** 本文包含实施规格；依据 `apps/pdf/src/shared/op-docs.ts`、`apps/pdf/src/renderer/ai/tools.ts` 的 `applyOpsTool`、`apps/pdf/src/renderer/edit-ops/registry.ts` 和 `apps/pdf/src/main/save-pdf.ts` 的现存语义。执行前必须重新核对这些文件，避免把本轮观测当成永久接口。

## Global Constraints

- 本文写于 2026-11-20；下方任务按实施状态逐步推进，未勾选项仍需完整验收。不要把计划、单元测试或 native 测试等同于浏览器完整闭环。
- 模型 canonical vocabulary 恰为九项：`removeMarkup`、`setNoteContents`、`removeTextInsert`、`setFormValue`、`addFormField`、`rotatePages`、`deletePage`、`setPageOrder`、`setMetadata`。
- 每次最多 50 项；共享 contract、模型 schema、HTTP、native 使用同一限制。
- 不扩大到隐藏 canonical ops；saved annotations 继续使用专用 edit/delete 工具。提取、合并、替换、裁剪、缩放等文件级操作不混入本批次。
- 不自动提交代码、部署、重启或修改业务数据库。集成测试只用隔离测试库；本会话使用 `/tmp/dyoffice-test-db-run.py`，端口 55433，禁止业务 55432。
- 不读取业务模型 token；测试采用 synthetic provider/bytes。所有表单旧保护保持：已签名、XFA、不支持结构拒绝；既有空 signature 允许表单设计，不能借此放宽其他 processor 的保护。
- 不引入新的 session 数据库表；浏览器 pending 与现有保存回执恢复已足够。

## 当前行为与语义差异

| 事项 | PC | 当前 Web | 目标 |
| --- | --- | --- | --- |
| `apply_ops` | 全批 pending，一次 undo；Save 才落盘 | page、form values、form fields 分别立即保存，禁止混类 | 一个 pending transaction，用户 Save 一个 revision |
| 标注/便笺 | 新内容有 P IDs；支持 pending 删除/改写 | markup/add_note 立即保存，无 P pending store | 新内容进入统一 store，提供 P IDs 与预览 |
| 文本 | T IDs 为 pending，保存后成为内容流 | 已有 T UUID drafts、局部 history | 保留 T IDs，归入一次全局 undo |
| saved annotation IDs | S IDs 与 pending 明确区分 | `pdf-viewer.ts` 暴露 PDF.js raw ref，例如 `12R` | 阅读结果标为 S，adapter 留存 raw ref；禁止 P 操作误删 saved 内容 |
| 表单赋值 | Map 按字段名覆盖，最后值生效 | 同字段重复被现有 validator 拒绝 | canonical planner 先 last-write-wins，native 接收最终唯一值 |
| 页码 | pending 周期保持原始页身份；排序不重编号 | 每次立即保存后重编号 | Save 前原始页身份稳定，Save 后重新读取 |

源代码核对位置：

- PC vocabulary：`apps/pdf/src/shared/op-docs.ts`。
- PC model adapter / P、T prefix / 表单目录：`apps/pdf/src/renderer/ai/tools.ts:3300` 一带及 `collectFields`。
- PC 原子 plan/reduce：`apps/pdf/src/renderer/edit-ops/registry.ts`；类别 reducer：同目录 `ops.ts`。
- PC snapshot/Save payload：`apps/pdf/src/renderer/edit-state.ts`、`apps/pdf/src/renderer/App.tsx` 的 `editsPayload`。
- Web 模型分支：`apps/web/src/shell/pdf-preview-skill.ts`；浏览器 mutation 门禁/toolbar：`apps/web/src/shell/DocumentPreview.tsx`。
- Web T drafts：`apps/web/src/editors/pdf-text-drafts.ts`；阅读来源：`apps/web/src/editors/pdf-viewer.ts`。
- 单次 stage/commit：`apps/web/server/src/pdf/save-preparation.mjs`、`apps/web/src/editors/pdf-mutations.ts`。

## 必须固定的操作语义

1. `removeMarkup` 仅操作 P markup；`setNoteContents` 仅操作 P note/reply；`removeTextInsert` 仅操作 T insert。不能将 raw PDF ref 或 S ID 当作 pending ID。PC 对格式正确但不存在的 pending ID执行 no-op；不能把 dedicated draft tool 的严格查找行为无意带入 canonical reducer。跨 revision 的整个 snapshot 必须拒绝。
2. `setFormValue` 从授权 base PDF catalog 推断 kind，过滤 readOnly/signature；checkbox 用 checked，其他类型用 value，空字符串清除。PC catalog 不包含本批新建但未保存的字段，因此新字段初值使用 `field.value/checked`；不要声称“先 add 再 set 新字段”属于现有 PC 能力。
3. `addFormField` 支持五类、radio 组和既有 radio 追加。模型坐标在批次开始的显示几何中转为原始 PDF rect（包括已有 pending rotation）；同一批后续旋转不重新解释这些坐标。最终 writer 先旋转、后创建 widget，保持 PC 方向语义。
4. 页操作使用原始 1-based 页身份，内部转换原始 0-based 索引。planner 按顺序推进 deleted/order；后续操作不得访问已删除页；至少保留一页。`setPageOrder:null` 恢复原始存活页顺序。
5. metadata 按字段合并、空字符串清除、遗漏保留；`metadata:null` 撤销 pending override，恢复 saved 基线，不是清空已保存 metadata。
6. 已保存字段的名称、值、flags、widget 页归属、原 AP 和未触及 annotation/thread 必须受输出验证保护。只允许请求明确涉及的字段变化。

## 当前并行推进的第一小步

截至本计划落盘，root 正在实现 `removeTextInsert` 的多 T ID 原子删除、一次 undo，并接入已有 assistant/textDrafts；review agent 正在实现九项严格共享 contract。这些是 Batch 1/2 的前置交付，不等于九项全混合 pending 已完成。验收应先证明多个 T 删除只产生一次历史快照、无效整批不留下部分删除、dry_run 不修改状态；通过证据由各实现任务另行报告。本计划不据此预先标记任何测试通过。

## 实施状态（2026-11-20续）

已落地九类共享contract、纯planner和独立history owner，相关组合单测69/69；内部writer的三个定向表单callback与已有规划/AP helper已实现，root实际PDF回归19/19。独立review发现的canonical显式字号/UserUnit差异已红→绿修正。详细命令及限制见 `docs/dyoffice/evidence/web-pdf-ai-edits-2026-11-19.md`。

统一native snapshot编译、删页widget清理、固定进程action、service stage及client单次snapshot/回执恢复已实现。真实PG已验证prepare不增版本、commit及重复确认只增一个版本；root关联native回归40/40。复核修正只读radio追加绕过、共享Opt/Kids数组别名副作用、删除已选radio页与空note作者误拒。带DyOfficeStamps的mixed保存仍显式拒绝；原annotation完整性基线在PDFium T/I重写之后，不等于全流程旧AP像素已验证。详见证据文档。

P 批注、便笺及新增 T/I 已接统一待保存界面。九项混合操作经 Chromium 与隔离 PostgreSQL 实测，覆盖干跑、整批拒绝、预览、一次撤销/重做、手动保存只新增一个版本、未知回执确认与重开。已有嵌入图片的像素编辑仍用独立草稿流程；存在此类草稿时禁用工具栏旋转并拒绝助手旋转。待保存旋转后的 T/I 坐标编辑、含托管水印的统一保存及真实模型/Harness 仍需单独处理。

后续复验已关闭托管水印的统一保存缺口：同页编辑保留原水印区域像素，删页和重排后重新计算页码，保留未修改字段的外观。含水印、页脚页码及表单的九项混合场景仍只发布一个版本。旧 standalone 写入保护保持原样。

## Batch 1：共享 contract 与原子 planner（不切换 UI）

**依赖：** 无；先建立与 PC 的差分测试。

**文件：**

- Create: `packages/web-contracts/src/pdf-apply-ops.ts` — 严格九项 wire union、50 项限制、plain own data property 校验。
- Create: `apps/web/src/editors/pdf-pending-ops.ts` — session snapshot、纯 plan/reduce、一次 history transaction。
- Test: `apps/web/test/unit/pdf-pending-ops.test.mjs`。
- Reference: PC `edit-ops/registry.ts`、`ops.ts`、`annotations.ts`；不要直接把 renderer 模块导入服务器。PC registry 的 runtime import 会拉入 `ImageEditLayer.tsx`，应保持 native 依赖边界。

**接口：**

- `validatePdfApplyOperations(input: unknown): readonly PdfApplyOperation[]` 只校验 wire shape，不谎称已检查文件可写。
- `planPdfPendingOps(snapshot, operations, context)` 返回 `{next, touched, focusPage, failures}`；失败时 next 必须是原 snapshot，不提前修改任何 store。
- snapshot 至少含 `fileId/baseRevision/generation`、P markups/notes、T inserts、现有 I/image edits、formValues map、authored fields、rotations、deleted、order、metadata。draft 图像载荷复用现有受限数据类型。
- context 含授权基线页数/几何、saved form catalog；name、kind 不信任模型提供值。

- [ ] 先写红测：混合 remove T、改 P note、重复 form value、旋转、metadata；无效末项使所有前项无效。
- [ ] 加差分样例：原始页码、删除后访问、setPageOrder null、metadata null、pending missing ID no-op、radio 名称上下文推进。
- [ ] 实现纯 reducer，操作在 clone 上执行，一次 push history；不调用任何 mutation endpoint。
- [ ] 验证 getter/symbol/继承属性、稀疏数组、51 项、错误 P/T/S prefix、stale base revision；dry_run 不改变 history/generation。

建议测试断言：

```js
const result = planPdfPendingOps(before, mixedOpsWithInvalidLastItem, context)
assert.equal(result.next, before)
assert.equal(result.failures.length > 0, true)
assert.deepEqual(before, originalSnapshot)
```

## Batch 2：统一浏览器 pending owner 与 P 来源（仍不切换旧保存入口）

**依赖：** Batch 1。

**文件：**

- Modify: `apps/web/src/editors/pdf-text-drafts.ts`、`pdf-image-drafts.ts`、`pdf-saved-image-drafts.ts` — 保留已有布局/图像工具，通过 snapshot owner 读写，移除成为重复所有者的 history。
- Modify: `apps/web/src/shell/DocumentPreview.tsx` — 一个 save lock/generation/history；统一 undo/discard。
- Modify: `apps/web/src/editors/pdf-viewer.ts`、`apps/web/src/shell/pdf-preview-skill.ts` — saved/pending 阅读投影，P IDs。
- Create: `apps/web/src/editors/pdf-annotation-drafts.ts` — anchored markup/note/reply 的候选几何与预览 adapter。
- Create: `apps/web/test/shell/pdf-pending-ops.test.ts`、`apps/web/test/unit/pdf-annotation-drafts.test.mjs`。
- Modify existing annotation native query seam as needed: `apps/web/server/src/pdf/annotation-job.mjs`、service/routes；将现有授权字节的 anchor planning 暴露为 query，不信任客户端注入 PDF quad。

- [ ] 先写红测：P markup 删除、P note/reply 改写、T 删除与其他类别同一 undo；列表投影包含 pending 值。
- [ ] query 返回原始 PDF geometry，完成后核对 file/revision/generation/signal；迟到结果不能覆盖 undo、切文件或关闭后的状态。
- [ ] 让 creation 工具与 toolbar 都写统一 owner；本批仅在测试 harness 组合新入口，生产仍保留旧入口直至 Batch 4 一次切换，避免新 pending 无法保存。
- [ ] 本地 preview 为旋转/排序/删页提供显示映射；原始页身份不变，批注与字段覆盖层随页移动。

## Batch 3：单次 native snapshot 编译与完整性（不接多次 HTTP）

**依赖：** Batch 1；可与 Batch 2 独立推进。

**文件：**

- Create: `apps/web/server/src/pdf/apply-ops-job.mjs`、`.d.mts`、`apply-ops-isolated.mjs`。
- Modify: `apps/web/server/src/pdf/pdf-edit-worker.mjs`、`pdf-process-job.mjs` — 注册 isolated action；沿用隔离、超时、输出绑定。
- Modify: `apps/web/server/src/pdf/form-fields-job.mjs`、`form-values-job.mjs` — 抽取现有已验证的 plan/targeted AP/verify helper，供 standalone job 与 unified job 同用，不复制整个 processor。
- Modify: `apps/pdf/src/main/save-pdf.ts` — 最小内部 writer seam，允许 native 定向创建字段/刷新 AP；默认 PC 调用行为保持。回调或策略由服务器代码构造，绝不能成为模型/HTTP 任意 hook。
- Test: `apps/web/test/pdf-apply-ops.test.mjs`、现有 `pdf-form-fields.test.mjs`、`pdf-form-inserts.test.mjs`。

**接口：**

- `createPdfApplyOpsJob().execute(inputBytes, rawSnapshotRequest, signal)` 返回现有 `{bytes,inputSha256,sha256,size}`。
- request 为严格 `{version:1,action:'applyOps',snapshot}`；snapshot 所有内容由共享合同重新校验，不能因来自浏览器 owner 就信任它。
- `applySaveRequest` 仍是 PC writer。内部 seam 必须解决 choice eager Helvetica 编码失败、CJK AP 与只刷新触及字段；不能恢复全局 NeedAppearances 兜底冒充完成。

- [ ] 先写红测：同一 bytes 混合表单赋值/新增字段、pending notes/markup、旋转/删页/排序/metadata，完整批次输出验证成功。
- [ ] 批次入口统一签名/XFA/结构检查；空 signature authoring 与已签名检测覆盖 direct/indirect FT、Type、V、ByteRange、Perms；不修改旧 T/I opener 来绕过保护。
- [ ] 将 pending removals 在 reducer 中消解，只将最后留下的内容写入 PDF；source annotation refs 若进入其他 dedicated saved 工具，必须在 PDFium rewrite 前解析绑定，不能套用 PC object-number/rect fallback 到其他 revision。
- [ ] 对原始页数、geometry、existing fields 建基线；累积最终 rotation/deleted/order，所有内容用原始页索引；最终删除/排序后重建输出 pageMap。
- [ ] 验证删除有表单 widget 的页：先用实测固定 PC 行为。输出不能留下指向已移除页的 widget；清理被删 widgets、无widget叶字段和空父组，保留跨页radio其余widgets及合法选中状态。若 PC writer 有同类问题，在共享 seam 修复并加PC回归，不能直接放宽 canonical integrity。
- [ ] watermark/header-footer 复用受验证的 managed-stamp capture/reapply；当前 `capturePdfManagedStamps` 默认拒 AcroForm，组合场景需专门的完整性测试与受限 helper，不能调用旧 page processor 假装支持。
- [ ] 保存后验证原字段树/AP（只投影请求允许的变化）、剩余页内容、annotation/thread、metadata、字段类型和值、radio flags/AS/options、新字段AP与坐标；任何 skipped content 或验证失败都拒绝整批。

## Batch 4：统一 stage/commit 与一次切换

**依赖：** Batch 2、3。

**文件：**

- Modify: `apps/web/server/src/modules/pdf/service.ts`、`routes.ts` — 新 unified preparation，复用 `createPdfSavePreparation`。
- Modify: `apps/web/src/editors/pdf-mutations.ts` — unified snapshot mutation action，复用原 `commitInput` recovery。
- Modify: `apps/web/src/shell/DocumentPreview.tsx`、`pdf-preview-skill.ts` — 一次切换九项 canonical 到 pending callback；移除 homogeneous-only 限制与“apply后已保存”提示。
- Test: `apps/web/test/local-integration/pdf-apply-ops.test.mjs`、`apps/web/test/local-browser/pdf-pending-ops.test.mjs`。

- [ ] 先写真实PG红测：prepare 不增加 revision；commit 后恰好加一；跨类别不能产生中间revision。
- [ ] 用户 Save 冻结 snapshot 与对应 generation，在锁内只读；native完成后 stage一次，commit一次。成功 receipt/reload 后清除恰好已消费的snapshot，重新读取页/fields/IDs。
- [ ] 失败/取消/冲突不丢 pending；准备阶段取消删除暂存upload并释放lease。
- [ ] commit发起后取消或网络未知必须保留同一个commitInput和冻结snapshot，只提供确认结果；不得rerun native或重新分配idempotencyKey。成功但reload失败按已确认receipt处理，不能重复保存。
- [ ] saved annotation 专用工具及其他立即保存工具遇到 pending 时明确要求用户保存或放弃，不能静默flush用户内容。
- [ ] 浏览器验收：读→混批→预览→一次undo→重做→Save→重开/历史/输出bytes读回，确认九项工具都由实际能力控制且文案准确。

## 建议验收命令

以下新文件名是计划交付物，文件创建后再运行；现有基线命令可先运行。不要为跑命令创建空测试或把未执行标成通过。

```bash
# 现有 native 基线；不会访问数据库
node --import tsx --test apps/web/test/pdf-form-fields.test.mjs apps/web/test/pdf-form-inserts.test.mjs apps/web/test/pdf-text-inserts.test.mjs

# Batch 1 / 3 新增合同与native验证
node --import tsx --test apps/web/test/unit/pdf-pending-ops.test.mjs apps/web/test/pdf-apply-ops.test.mjs

# Batch 2 shell adapter与取消/undo
npm --prefix apps/web run test:shell -- test/shell/pdf-pending-ops.test.ts

# Batch 4 仅隔离55433测试库，含browser测试自己的隔离fixture
python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/local-integration/pdf-apply-ops.test.mjs
python3 /tmp/dyoffice-test-db-run.py node --import tsx --test apps/web/test/local-browser/pdf-pending-ops.test.mjs

# 类型与最终构建（顺序执行，避免磁盘空间压力）
npm --prefix apps/web run typecheck:shell
node node_modules/typescript/bin/tsc --project apps/web/server/tsconfig.json --noEmit
npm --prefix apps/web run build
```

## 交付判定

只有九项canonical可在同一pending批次成功/失败、一次undo、用户Save产生一个revision，并通过取消/未知回执恢复及实际PDF输出完整性测试，才可声明本目标闭环。仅增加混合operation allowlist、逐个调用旧保存接口，或统一工具文案，均不构成完成。
