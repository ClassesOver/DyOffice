# Office AI 逐工具验收

基准提交 29415fca。以 Web 允许名单的格式和工具名为单位，同名工具在各格式分别核对。共享工具按实际入口和权限验证。[Web 工具合同](../../../packages/web-contracts/src/assistant.ts) [GenOffice 静态清单](../inventory/agent-tools.md)

范围包括 DOCX 42、XLSX 19、PPTX 20、PDF 49，共 130 个格式与工具组合，另有 9 个数据源与委派共享工具。GenOffice 清单的 159 条定义来自四格式编辑器 119 条、桌面 MCP 25 条和共享代码 15 条。重复定义保留原位置。

候选用例来自工具名检索。读工具验收准确性和授权，写工具验收目标内容和对应原生文件，适用时核对保存重开、未改内容和撤销边界。条件工具按实际配置核对。

首轮定向工具回归共 672 项通过，含 DOCX 71、XLSX 155、PPTX 48、PDF 299、Web 合同与工具 99 项。XLSX 的截断附件提示断言按现有工具文案修正后复跑通过，继续检查读取错误、原件保留和合并用途。[XLSX 截断附件用例](../../../apps/sheets/tests/files-skill.test.ts)

## DOCX

| 工具 | 候选用例 | 执行或效果证据 |
| --- | --- | --- |
| `accept_changes` | [ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts)、[ai-revision-tools.test.ts](../../../apps/docs/tests/ai-revision-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-revision-tools.test.ts) |
| `add_comment` | [ai-comment-tools.test.ts](../../../apps/docs/tests/ai-comment-tools.test.ts)、[ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-comment-tools.test.ts) |
| `analyze_media` | [attachment-media.test.mjs](../../../apps/web/test/native-docs/attachment-media.test.mjs)、[ai-media-routes.test.mjs](../../../apps/web/test/unit/ai-media-routes.test.mjs) | 待逐项核验 |
| `apply_ops` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs) | 待逐项核验 |
| `create_document` | [native-pdf-create-document.test.mjs](../../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)、[ai-create-document.test.ts](../../../apps/docs/tests/ai-create-document.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-create-document.test.ts) |
| `define_style` | [ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts)、[ai-style-floating-tools.test.ts](../../../apps/docs/tests/ai-style-floating-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-style-floating-tools.test.ts) |
| `delete_comment` | [ai-comment-tools.test.ts](../../../apps/docs/tests/ai-comment-tools.test.ts)、[ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-comment-tools.test.ts) |
| `delete_note` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 待逐项核验 |
| `edit_chart` | [ai-chart-tools.test.ts](../../../apps/docs/tests/ai-chart-tools.test.ts)、[ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 待逐项核验 |
| `edit_note` | [native-pdf-harness.test.mjs](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs)、[native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs) | 待逐项核验 |
| `generate_image` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[ai-generate-image.test.ts](../../../apps/docs/tests/ai-generate-image.test.ts) | 待逐项核验 |
| `generate_mindmap` | [mind-map.test.ts](../../../apps/docs/tests/mind-map.test.ts)、[office-tool-inventory.test.mjs](../../../apps/web/test/local-browser/office-tool-inventory.test.mjs) | 待逐项核验 |
| `get_document_context` | [agent-docs.test.ts](../../../apps/docs/tests/agent-docs.test.ts)、[ai-page-setup.test.ts](../../../apps/docs/tests/ai-page-setup.test.ts) | 待逐项核验 |
| `image_search` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[global-config-readiness.test.mjs](../../../apps/web/test/local-integration/global-config-readiness.test.mjs) | 待逐项核验 |
| `insert_analysis_image` | 待定位 | 待逐项核验 |
| `insert_chart` | [ai-chart-tools.test.ts](../../../apps/docs/tests/ai-chart-tools.test.ts)、[ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 待逐项核验 |
| `insert_content` | [native-docx-harness.test.mjs](../../../apps/web/test/local-browser/native-docx-harness.test.mjs)、[native-word-sheets-codex.test.mjs](../../../apps/web/test/local-browser/native-word-sheets-codex.test.mjs) | 真实模型成品复跑通过，[浏览器用例](../../../apps/web/test/local-browser/native-word-sheets-codex.test.mjs) |
| `insert_data_result` | [office-source-analysis.test.mjs](../../../apps/web/test/local-browser/office-source-analysis.test.mjs)、[office-tool-inventory.test.mjs](../../../apps/web/test/local-browser/office-tool-inventory.test.mjs) | 真实模型向内存文档目标写入准确值；浏览器成品待核验，[分析评估](../../../tools/dyoffice/analysis-eval/README.md) |
| `insert_endnote` | [ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 待逐项核验 |
| `insert_footnote` | [ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 待逐项核验 |
| `insert_image` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[agent-docs.test.ts](../../../apps/docs/tests/agent-docs.test.ts) | 待逐项核验 |
| `insert_picture` | [ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts)、[image-media.test.mjs](../../../apps/web/test/native-docs/image-media.test.mjs) | 待逐项核验 |
| `insert_section_break` | [ai-page-setup.test.ts](../../../apps/docs/tests/ai-page-setup.test.ts)、[ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 待逐项核验 |
| `insert_text_box` | [ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts)、[ai-style-floating-tools.test.ts](../../../apps/docs/tests/ai-style-floating-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-style-floating-tools.test.ts) |
| `list_styles` | [ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts)、[assistant-client.test.mjs](../../../apps/web/test/unit/assistant-client.test.mjs) | 待逐项核验 |
| `read_attachment` | [native-pdf-create-document.test.mjs](../../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)、[ai-web-drop-attachments.test.ts](../../../apps/docs/tests/ai-web-drop-attachments.test.ts) | 待逐项核验 |
| `read_blocks` | [agent-docs.test.ts](../../../apps/docs/tests/agent-docs.test.ts)、[ai-deleted-revision-context.test.ts](../../../apps/docs/tests/ai-deleted-revision-context.test.ts) | 待逐项核验 |
| `read_comments` | [ai-comment-tools.test.ts](../../../apps/docs/tests/ai-comment-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-comment-tools.test.ts) |
| `read_knowledge_file` | [word-knowledge.test.mjs](../../../apps/web/test/local-browser/word-knowledge.test.mjs)、[coding-model-bridge.test.mjs](../../../apps/web/test/unit/coding-model-bridge.test.mjs) | 待逐项核验 |
| `read_notes` | 待定位 | 待逐项核验 |
| `read_revisions` | [ai-redline-summary.test.ts](../../../apps/docs/tests/ai-redline-summary.test.ts)、[ai-revision-tools.test.ts](../../../apps/docs/tests/ai-revision-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-revision-tools.test.ts) |
| `reject_changes` | [ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts)、[ai-revision-tools.test.ts](../../../apps/docs/tests/ai-revision-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-revision-tools.test.ts) |
| `replace_blocks` | [agent-docs.test.ts](../../../apps/docs/tests/agent-docs.test.ts)、[ai-deleted-revision-context.test.ts](../../../apps/docs/tests/ai-deleted-revision-context.test.ts) | 待逐项核验 |
| `replace_selection` | [agent-docs.test.ts](../../../apps/docs/tests/agent-docs.test.ts)、[ai-keep-pictures-on-replace.test.ts](../../../apps/docs/tests/ai-keep-pictures-on-replace.test.ts) | 待逐项核验 |
| `reply_comment` | [ai-comment-tools.test.ts](../../../apps/docs/tests/ai-comment-tools.test.ts)、[ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-comment-tools.test.ts) |
| `resolve_comment` | [ai-comment-tools.test.ts](../../../apps/docs/tests/ai-comment-tools.test.ts)、[ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-comment-tools.test.ts) |
| `search_knowledge_base` | [word-knowledge.test.mjs](../../../apps/web/test/local-browser/word-knowledge.test.mjs)、[docs-save-download-entry.test.mjs](../../../apps/web/test/unit/docs-save-download-entry.test.mjs) | 待逐项核验 |
| `set_header_footer` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-hf-tool.test.ts](../../../apps/docs/tests/ai-hf-tool.test.ts) | 待逐项核验 |
| `set_page_setup` | [ai-page-setup.test.ts](../../../apps/docs/tests/ai-page-setup.test.ts)、[ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 待逐项核验 |
| `set_watermark` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-read-only-tools.test.ts](../../../apps/docs/tests/ai-read-only-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/docs/tests/ai-style-floating-tools.test.ts) |
| `web_search` | [t12-workspace-settings.test.mjs](../../../apps/web/test/local-browser/t12-workspace-settings.test.mjs)、[agent-docs.test.ts](../../../apps/docs/tests/agent-docs.test.ts) | 待逐项核验 |
| `write_document` | [ai-doc-writer.test.ts](../../../apps/docs/tests/ai-doc-writer.test.ts)、[assistant-channel-bidirectional.test.mjs](../../../apps/web/test/local-integration/assistant-channel-bidirectional.test.mjs) | 待逐项核验 |

## XLSX

| 工具 | 候选用例 | 执行或效果证据 |
| --- | --- | --- |
| `aggregate_range` | [formula-cost.test.ts](../../../apps/sheets/tests/formula-cost.test.ts)、[plan-operations-formula-guard.test.ts](../../../apps/sheets/tests/plan-operations-formula-guard.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-skill-tools.test.ts) |
| `create_document` | [native-pdf-create-document.test.mjs](../../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)、[ai-create-document.test.ts](../../../apps/sheets/tests/ai-create-document.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/ai-create-document.test.ts) |
| `find_cells` | [sheets-find-cells.test.mjs](../../../apps/web/test/local-browser/sheets-find-cells.test.mjs)、[redact-actions.test.ts](../../../apps/sheets/tests/redact-actions.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-search.test.ts) |
| `generate_image` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[image-skill.test.ts](../../../apps/sheets/tests/image-skill.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/image-skill.test.ts) |
| `get_workbook_context` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-sheets-harness.test.mjs](../../../apps/web/test/local-browser/native-sheets-harness.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-skill-tools.test.ts) |
| `image_search` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[image-skill.test.ts](../../../apps/sheets/tests/image-skill.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/image-skill.test.ts) |
| `insert_data_result` | [office-source-analysis.test.mjs](../../../apps/web/test/local-browser/office-source-analysis.test.mjs)、[office-tool-inventory.test.mjs](../../../apps/web/test/local-browser/office-tool-inventory.test.mjs) | 真实模型向内存文档目标写入准确值；浏览器成品待核验，[分析评估](../../../tools/dyoffice/analysis-eval/README.md) |
| `load_guide` | [workbook-skill-tools.test.ts](../../../apps/sheets/tests/workbook-skill-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-skill-tools.test.ts) |
| `merge_attached_workbooks` | [sheets-attachment-merge.test.mjs](../../../apps/web/test/local-browser/sheets-attachment-merge.test.mjs)、[merge-skill.test.ts](../../../apps/sheets/tests/merge-skill.test.ts) | 待逐项核验 |
| `propose_operations` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-sheets-harness.test.mjs](../../../apps/web/test/local-browser/native-sheets-harness.test.mjs) | 真实模型成品复跑通过，[浏览器用例](../../../apps/web/test/local-browser/native-word-sheets-codex.test.mjs) |
| `read_attachment` | [native-pdf-create-document.test.mjs](../../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)、[files-skill.test.ts](../../../apps/sheets/tests/files-skill.test.ts) | 待逐项核验 |
| `read_cells` | [workbook-skill-tools.test.ts](../../../apps/sheets/tests/workbook-skill-tools.test.ts)、[loop.test.ts](../../../packages/agent-core/tests/loop.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-skill-tools.test.ts) |
| `read_formats` | [workbook-skill-tools.test.ts](../../../apps/sheets/tests/workbook-skill-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-skill-tools.test.ts) |
| `read_range` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[office-dock-unified.test.mjs](../../../apps/web/test/local-browser/office-dock-unified.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-skill-tools.test.ts) |
| `read_sheet_features` | [redact-features.test.ts](../../../apps/sheets/tests/redact-features.test.ts)、[workbook-skill-tools.test.ts](../../../apps/sheets/tests/workbook-skill-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-skill-tools.test.ts) |
| `select_range` | [response-verify.test.ts](../../../apps/sheets/tests/response-verify.test.ts)、[sheet-nav.test.ts](../../../apps/sheets/tests/sheet-nav.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-skill-tools.test.ts) |
| `trace_dependents` | [trace-redaction.test.ts](../../../apps/sheets/tests/trace-redaction.test.ts)、[workbook-skill-tools.test.ts](../../../apps/sheets/tests/workbook-skill-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-skill-tools.test.ts) |
| `trace_precedents` | [trace-redaction.test.ts](../../../apps/sheets/tests/trace-redaction.test.ts)、[workbook-skill-tools.test.ts](../../../apps/sheets/tests/workbook-skill-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/sheets/tests/workbook-skill-tools.test.ts) |
| `web_search` | [t12-workspace-settings.test.mjs](../../../apps/web/test/local-browser/t12-workspace-settings.test.mjs)、[global-config-readiness.test.mjs](../../../apps/web/test/local-integration/global-config-readiness.test.mjs) | 待逐项核验 |

## PPTX

| 工具 | 候选用例 | 执行或效果证据 |
| --- | --- | --- |
| `analyze_media` | [attachment-media.test.mjs](../../../apps/web/test/native-docs/attachment-media.test.mjs)、[ai-media-routes.test.mjs](../../../apps/web/test/unit/ai-media-routes.test.mjs) | 待逐项核验 |
| `apply_ops` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/slides/tests/apply-ops-tool.test.ts) |
| `ask_clarification` | 待定位 | 真实模型调用，界面跳过后继续生成，[浏览器用例](../../../apps/web/test/local-browser/native-slides-generate.test.mjs) |
| `edit_chart` | [data-source-gate.test.ts](../../../apps/slides/tests/data-source-gate.test.ts)、[assistant-client.test.mjs](../../../apps/web/test/unit/assistant-client.test.mjs) | 待逐项核验 |
| `execute_slide_script` | [native-slides-harness.test.mjs](../../../apps/web/test/local-browser/native-slides-harness.test.mjs)、[slide-qc.test.ts](../../../apps/slides/tests/slide-qc.test.ts) | 待逐项核验 |
| `generate_deck` | [native-slides-generate.test.mjs](../../../apps/web/test/local-browser/native-slides-generate.test.mjs)、[apply-ops-tool.test.ts](../../../apps/slides/tests/apply-ops-tool.test.ts) | 真实模型成品复跑通过，[浏览器用例](../../../apps/web/test/local-browser/native-slides-generate.test.mjs) |
| `generate_image` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[image-media.test.mjs](../../../apps/web/test/native-docs/image-media.test.mjs) | 待逐项核验 |
| `image_search` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[global-config-readiness.test.mjs](../../../apps/web/test/local-integration/global-config-readiness.test.mjs) | 待逐项核验 |
| `insert_analysis_image` | 待定位 | 待逐项核验 |
| `insert_data_result` | [office-source-analysis.test.mjs](../../../apps/web/test/local-browser/office-source-analysis.test.mjs)、[office-tool-inventory.test.mjs](../../../apps/web/test/local-browser/office-tool-inventory.test.mjs) | 待逐项核验 |
| `insert_web_image` | [native-slides-attachment.test.mjs](../../../apps/web/test/local-browser/native-slides-attachment.test.mjs)、[ai-picture-tools.test.ts](../../../apps/slides/tests/ai-picture-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/slides/tests/ai-picture-tools.test.ts) |
| `list_style_templates` | [native-slides-generate.test.mjs](../../../apps/web/test/local-browser/native-slides-generate.test.mjs)、[generate-deck.test.ts](../../../apps/slides/tests/generate-deck.test.ts) | 待逐项核验 |
| `load_guide` | 待定位 | 待逐项核验 |
| `plan_deck` | [slide-progress.test.ts](../../../apps/slides/tests/slide-progress.test.ts) | 待逐项核验 |
| `read_attachment` | [native-pdf-create-document.test.mjs](../../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)、[files-skill.test.ts](../../../apps/slides/tests/files-skill.test.ts) | 待逐项核验 |
| `read_slide` | [native-slides-generate.test.mjs](../../../apps/web/test/local-browser/native-slides-generate.test.mjs)、[layout-tools.test.ts](../../../apps/slides/tests/layout-tools.test.ts) | 真实模型成品复跑通过，[浏览器用例](../../../apps/web/test/local-browser/native-slides-generate.test.mjs) |
| `regenerate_slide` | [native-slides-generate.test.mjs](../../../apps/web/test/local-browser/native-slides-generate.test.mjs)、[data-source-gate.test.ts](../../../apps/slides/tests/data-source-gate.test.ts) | 真实模型成品复跑通过，[浏览器用例](../../../apps/web/test/local-browser/native-slides-generate.test.mjs) |
| `replace_image` | [native-slides-attachment.test.mjs](../../../apps/web/test/local-browser/native-slides-attachment.test.mjs)、[pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/slides/tests/ai-picture-tools.test.ts) |
| `save_style_template` | [native-slides-generate.test.mjs](../../../apps/web/test/local-browser/native-slides-generate.test.mjs)、[generate-deck.test.ts](../../../apps/slides/tests/generate-deck.test.ts) | 待逐项核验 |
| `web_search` | [t12-workspace-settings.test.mjs](../../../apps/web/test/local-browser/t12-workspace-settings.test.mjs)、[data-source-gate.test.ts](../../../apps/slides/tests/data-source-gate.test.ts) | 待逐项核验 |

## PDF

| 工具 | 候选用例 | 执行或效果证据 |
| --- | --- | --- |
| `add_form_mark` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `add_note` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `apply_ops` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `confirm_pdf_copies` | [native-pdf-page-copies.test.mjs](../../../apps/web/test/local-browser/native-pdf-page-copies.test.mjs)、[office-tool-inventory.test.mjs](../../../apps/web/test/local-browser/office-tool-inventory.test.mjs) | 待逐项核验 |
| `create_document` | [native-pdf-create-document.test.mjs](../../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `crop_image` | [pdf-affine-image-drafts.test.mjs](../../../apps/web/test/local-browser/pdf-affine-image-drafts.test.mjs)、[pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `crop_pages` | [native-pdf-page-copies.test.mjs](../../../apps/web/test/local-browser/native-pdf-page-copies.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `delete_image` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `delete_inserted_text` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `delete_markup` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `delete_note` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `edit_block` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `edit_inserted_text` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `edit_note` | [native-pdf-harness.test.mjs](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs)、[native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs) | 真实模型成品复跑通过，[浏览器用例](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs) |
| `edit_text` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-pdf-harness.test.mjs](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs) | 真实模型成品复跑通过，[浏览器用例](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs) |
| `extract_pages` | [native-pdf-page-copies.test.mjs](../../../apps/web/test/local-browser/native-pdf-page-copies.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 待逐项核验 |
| `find_sensitive_info` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[pdf-redactions.test.mjs](../../../apps/web/test/local-browser/pdf-redactions.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `flip_image` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[pdf-affine-image-drafts.test.mjs](../../../apps/web/test/local-browser/pdf-affine-image-drafts.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `generate_image` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `get_outline` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `goto_page` | [ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts)、[document-handoff.test.mjs](../../../apps/web/test/unit/document-handoff.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `image_search` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `insert_blank_page` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[native-pdf-page-copies.test.mjs](../../../apps/web/test/local-browser/native-pdf-page-copies.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `insert_image` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `insert_text` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-pdf-create-document.test.mjs](../../../apps/web/test/local-browser/native-pdf-create-document.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `list_form_fields` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 待逐项核验 |
| `list_inserted_text` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `list_page_images` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[pdf-affine-image-drafts.test.mjs](../../../apps/web/test/local-browser/pdf-affine-image-drafts.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `markup_text` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `merge_pages` | [native-pdf-page-copies.test.mjs](../../../apps/web/test/local-browser/native-pdf-page-copies.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 待逐项核验 |
| `move_inserted_text` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `move_text_block` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `read_annotations` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-pdf-harness.test.mjs](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs) | 真实模型成品复跑通过，[浏览器用例](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs) |
| `read_attachment` | [native-pdf-create-document.test.mjs](../../../apps/web/test/local-browser/native-pdf-create-document.test.mjs)、[docs-save-download-entry.test.mjs](../../../apps/web/test/unit/docs-save-download-entry.test.mjs) | 待逐项核验 |
| `read_pages` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-pdf-harness.test.mjs](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs) | 真实模型成品复跑通过，[浏览器用例](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs) |
| `remove_image_background` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `replace_image` | [native-slides-attachment.test.mjs](../../../apps/web/test/local-browser/native-slides-attachment.test.mjs)、[pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `replace_pages` | [ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts)、[assistant-client.test.mjs](../../../apps/web/test/unit/assistant-client.test.mjs) | 待逐项核验 |
| `reply_note` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `rotate_image` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `rotate_pages` | [office-tool-inventory.test.mjs](../../../apps/web/test/local-browser/office-tool-inventory.test.mjs)、[assistant-client.test.mjs](../../../apps/web/test/unit/assistant-client.test.mjs) | 兼容名称。原生操作由 `apply_ops.rotatePages` 执行，[浏览器用例](../../../apps/web/test/local-browser/native-pdf-open.test.mjs) |
| `search_text` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `set_header_footer` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `set_image_opacity` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `set_page_size` | [native-pdf-page-copies.test.mjs](../../../apps/web/test/local-browser/native-pdf-page-copies.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `set_watermark` | [native-pdf-open.test.mjs](../../../apps/web/test/local-browser/native-pdf-open.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |
| `split_pages` | [native-pdf-page-copies.test.mjs](../../../apps/web/test/local-browser/native-pdf-page-copies.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 待逐项核验 |
| `split_pdf` | [native-pdf-page-copies.test.mjs](../../../apps/web/test/local-browser/native-pdf-page-copies.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 待逐项核验 |
| `transform_image` | [pdf-media.test.mjs](../../../apps/web/test/local-browser/pdf-media.test.mjs)、[ai-tools.test.ts](../../../apps/pdf/tests/ai-tools.test.ts) | 通过的单测包含本工具用例；Web 路径待逐项核验，[单测](../../../apps/pdf/tests/ai-tools.test.ts) |

## 共享工具

| 工具 | 候选用例 | 执行或效果证据 |
| --- | --- | --- |
| `delegate_agent_task` | [dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs)、[native-docx-harness.test.mjs](../../../apps/web/test/local-browser/native-docx-harness.test.mjs) | 真实模型调用成功，[浏览器用例](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs) |
| `delegate_channel_task` | [assistant-dsh-delegation.test.mjs](../../../apps/web/test/local-browser/assistant-dsh-delegation.test.mjs)、[dsh-office-handoff.test.mjs](../../../apps/web/test/local-browser/dsh-office-handoff.test.mjs) | 待逐项核验 |
| `list_agent_data` | [coding-client.test.mjs](../../../apps/web/test/unit/coding-client.test.mjs)、[office-tool-inventory.test.mjs](../../../apps/web/test/local-browser/office-tool-inventory.test.mjs) | 待逐项核验 |
| `list_agents` | [native-pdf-harness.test.mjs](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs)、[coding-client.test.mjs](../../../apps/web/test/unit/coding-client.test.mjs) | 真实模型调用成功，[浏览器用例](../../../apps/web/test/local-browser/native-pdf-harness.test.mjs) |
| `list_channel_agents` | [assistant-dsh-delegation.test.mjs](../../../apps/web/test/local-browser/assistant-dsh-delegation.test.mjs)、[assistant-channel-client.test.mjs](../../../apps/web/test/unit/assistant-channel-client.test.mjs) | 待逐项核验 |
| `sources_describe` | [office-source-analysis.test.mjs](../../../apps/web/test/local-browser/office-source-analysis.test.mjs)、[assistant-source-catalog.test.mjs](../../../apps/web/test/local-integration/assistant-source-catalog.test.mjs) | 真实模型调用及数据库真值核验通过，[分析评估](../../../tools/dyoffice/analysis-eval/README.md) |
| `sources_list` | [office-source-analysis.test.mjs](../../../apps/web/test/local-browser/office-source-analysis.test.mjs)、[assistant-source-catalog.test.mjs](../../../apps/web/test/local-integration/assistant-source-catalog.test.mjs) | 真实模型调用及数据库真值核验通过，[分析评估](../../../tools/dyoffice/analysis-eval/README.md) |
| `sources_query` | [office-source-analysis.test.mjs](../../../apps/web/test/local-browser/office-source-analysis.test.mjs)、[assistant-source-catalog.test.mjs](../../../apps/web/test/local-integration/assistant-source-catalog.test.mjs) | 真实模型调用及数据库真值核验通过，[分析评估](../../../tools/dyoffice/analysis-eval/README.md) |
| `sources_read_result` | [assistant-source-catalog.test.mjs](../../../apps/web/test/local-integration/assistant-source-catalog.test.mjs)、[assistant-client.test.mjs](../../../apps/web/test/unit/assistant-client.test.mjs) | 待逐项核验 |

## GenOffice 桌面与共享定义

| 定义 | 清单中的执行位置 | Web 对照 |
| --- | --- | --- |
| [`run_cli`](../../../apps/docs/src/renderer/ai/skills-skill.ts) | `unsupported` | 清单标记为桌面专用；待核对 Web 拒绝路径 |
| [`apply_ops`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`check_document`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `headless` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`convert_document`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `headless` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`create_docx`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `headless` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`fill_template`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `headless` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`get_app_info`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `unsupported` | 清单标记为桌面专用；待核对 Web 拒绝路径 |
| [`insert_content`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`insert_picture`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`open_in_genoffice`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `unsupported` | 清单标记为桌面专用；待核对 Web 拒绝路径 |
| [`read_blocks`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`read_document`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`read_docx`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `headless` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`read_docx_properties`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `headless` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`replace_blocks`](../../../apps/shell/src/main/mcp/tools/document-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`open_documents`](../../../apps/shell/src/main/mcp/tools/open-documents-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`read_pdf`](../../../apps/shell/src/main/mcp/tools/pdf-tools.ts) | `headless` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`create_session`](../../../apps/shell/src/main/mcp/tools/session-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`save_session`](../../../apps/shell/src/main/mcp/tools/session-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`apply_sheet_ops`](../../../apps/shell/src/main/mcp/tools/sheets-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`create_xlsx`](../../../apps/shell/src/main/mcp/tools/sheets-tools.ts) | `headless` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`read_sheet`](../../../apps/shell/src/main/mcp/tools/sheets-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`sheet_links`](../../../apps/shell/src/main/mcp/tools/sheets-tools.ts) | `headless` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`apply_slide_ops`](../../../apps/shell/src/main/mcp/tools/slides-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`create_pptx`](../../../apps/shell/src/main/mcp/tools/slides-tools.ts) | `headless` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`read_deck`](../../../apps/shell/src/main/mcp/tools/slides-tools.ts) | `live` | 桌面 MCP；待检查 Web 对应接口和权限 |
| [`read_attachment`](../../../packages/agent-core/src/attachments-skill.ts) | `headless` | 见 DOCX、XLSX、PPTX、PDF 表 |
| [`load_guide`](../../../packages/agent-core/src/cli-skill.ts) | `headless` | 见 XLSX、PPTX 表 |
| [`run_genoffice`](../../../packages/agent-core/src/cli-skill.ts) | `headless` | 单独执行入口；待核对 Web 能力与权限 |
| [`delegate_agent_task`](../../../packages/agent-core/src/coding-skill.ts) | `headless` | 见共享工具表 |
| [`list_agent_data`](../../../packages/agent-core/src/coding-skill.ts) | `headless` | 见共享工具表 |
| [`list_agents`](../../../packages/agent-core/src/coding-skill.ts) | `headless` | 见共享工具表 |
| [`create_document`](../../../packages/agent-core/src/create-document-skill.ts) | `headless` | 见 DOCX、XLSX、PDF 表 |
| [`read_knowledge_file`](../../../packages/agent-core/src/knowledge-base-skill.ts) | `headless` | 见 DOCX 表 |
| [`search_knowledge_base`](../../../packages/agent-core/src/knowledge-base-skill.ts) | `headless` | 见 DOCX 表 |
| [`generate_mindmap`](../../../packages/agent-core/src/mind-map.ts) | `live` | 见 DOCX 表 |
| [`insert_analysis_image`](../../../packages/browser-host/src/analysis-insert-skill.ts) | `live` | 见 DOCX、PPTX 表 |
| [`insert_data_result`](../../../packages/browser-host/src/analysis-insert-skill.ts) | `live` | 见 DOCX、XLSX、PPTX 表 |
| [`delegate_channel_task`](../../../packages/browser-host/src/assistant-channel.ts) | `live` | 见共享工具表 |
| [`list_channel_agents`](../../../packages/browser-host/src/assistant-channel.ts) | `live` | 见共享工具表 |
| [`sources_list`](../../../packages/browser-host/src/source-catalog-skill.ts) | `headless` | 见共享工具表 |
