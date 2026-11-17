# Explicit analysis insertion and separate Office save

Baseline: PR #134 `05709043`. This slice adds no model call, external `office.write` authority, PNG/SVG/HTML execution, or production test endpoint.

## Boundaries

A mounted Docs/Sheets host registers one local target. A capture is an opaque single-use object tracked by identity, bound to file, base revision, lease epoch and native editor snapshot. Native snapshots retain document identity, edit state and selection privately. A save-specific content/identity fence (separate from insertion selection) remains active through native save queues and serialization, upload preparation, and the final commit fetch including any CSRF retry. A revocation or newer content before submission blocks the commit, not merely its displayed receipt. Before apply and save, the target renews the existing file lease to recheck current file/session authority. After awaits and immediately before mutation, both the UI's original session/action closure and native capture must still match. Unmount disposes the target. Artifacts cannot select targets or tool names.

Only bounded plain text and string tables are supported. All cells remain literal: Docs escapes content before the existing `insert_content` tool; Sheets emits individual `set_cell` operations through the original plan/executor, never `set_range`'s formula promotion. The analysis-only executor option writes explicit STRING cell types so the engine also preserves numeric/date-looking strings such as `0012`. Existing non-analysis operations keep their prior behavior. Sheets writes from the current selection's top-left and may replace existing cell values; its UI must state this. Docs inserts after the current block. Original operation undo behavior is retained. No tool calls are inferred from source text.

An apply result is `applied_uncommitted`, never saved. A local consent hold blocks existing timer/blur/AI-completion automatic saves, without changing AutoSave preferences. Failure or incomplete save retains the hold. A separate explicit native save may clear it only when clean. The target's explicit save verifies a new actual `host.save` / `saveSheets` receipt, matching file/current revision/lease and native accepted/clean state. A current head alone, a boolean success without a new receipt, unknown commit, stale application or newer edits cannot be claimed saved. Original independent Save actions are not retrospectively attributed to a delivery by the panel.

## Verification scope

- Target/registry/literal/consent unit tests: opaque/used/stale captures, changed lease/draft, disposal, revoked UI authority across lease-await, no auto-save before explicit clean save, no invented receipt.
- Real Tiptap + original DOCX serializer/Web bridge: literal hostile-looking text, stale selection and revoked authority rejection; explicit table insertion performs zero writes, separate save writes DOCX containing literal cells and returns the bridge's actual receipt. Existing save-race coverage retained.
- Real headless Univer core command verifies the exact original executor cell payload keeps `=1+1` non-formula and `0012` a string. The first runtime test exposed numeric coercion and failed before the explicit STRING fix. A direct UI-facade headless attempt required unavailable render services; this test does not claim a browser-renderer pass.
- Original Sheets planner: formula-looking strings remain value fields, addresses honor selection; native queue capture rejects changed journal/selection/epoch/identity/authority before write.
- These local tests do not substitute for the normal CI real-browser/PG insertion → explicit save → reopen verification. No local Chromium or blocked model runtime was launched.

- Added delayed-native-save and upload/commit-submission guard tests: later DOCX edit prevents any bridge write; revoked Sheets queued/prepared save sends no commit; DOCX upload revocation or saving-state revocation sends no commit; a refused commit is not retried after revocation.

- A first commit stopped by the trusted guard before network submission is explicitly known-not-sent: its pending entry is cleared and later reconcile cannot submit it. Blocking a retry of an already submitted unknown request retains uncertainty. Guarded reconciliation and pending-save recovery use the same authorization callback. Tests cover zero-submit cancellation → reconcile → no replay, refused CSRF retry, and genuine lost-response recovery.

- Genuine unknown pending state privately retains the originating authorization closure; default reconciliation or a later save cannot replace it with `true`. The closure is not serialized into request bodies or receipts. Save-owned unknown/read-only state is separate from file/session/content authority, so unchanged authorized recovery remains possible.
