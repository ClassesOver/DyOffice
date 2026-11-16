# Native DOCX mutation inventory and activation gate

Status: read-only audit plus unmounted primitives. App has NOT been wrapped or enabled. Inventory reviewed independently against App.tsx, file-actions.ts and editor subviews. This is an entry-family inventory, not a claim that a text search proves every dynamic write safe.

## Authoritative save inputs

`file-actions.ts::buildDocBytes` reads the primary PM document/optional override, `doc.parsed` (including original bytes and package relationships), then saveDocx inputs:

- section(s), dirty section indices, trailing section start and page numbering; sectionHfEdits and hfLinks;
- pending numbering, default fonts and style upserts;
- page color, title page, odd/even headers, mirror margins and track revisions;
- comments, protection, write protection and personal-info removal;
- ink images, text/picture watermarks and watermark styling;
- footnotes, endnotes, sources, Zotero document data, theme fonts/colors;
- derived layout pageCount, image parts, chart XML and embedded workbook binary patches.

Dirty booleans select what gets serialized; they are not mutation generations. Repeated edits while already dirty must invalidate approvals separately.

## Entry families requiring a synchronous fence

| Family                        | Real entry/route                                                                                                           | Required treatment before activation                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main PM body                  | typing, paste, ribbon/keyboard commands, AI/control hooks, undo/redo, plugin append transactions                           | shared monotonic clock on transaction; selection changes fence approved scope; post-dispatch compare exact expected doc; unknown if appended mutation differs |
| Direct App metadata           | App-local setters for sections/HF, page numbering, theme, notes, sources, ink, styles, comments, protection                | intercept at the actual mutation source, not only FileActionContext object; use authoritative value+version snapshot                                          |
| Synchronous mirrors           | commentsLiveRef before setCommentsState; Zotero ref; aiNotesMirror before reviewCtx setter; AI style upserts mirror        | invalidate BEFORE mirror write, or consolidate mirror and state in the same store                                                                             |
| Review/AI contexts            | reviewCtx, aiNotesAccess, aiDocExtras, style/watermark/numbering actions, accept/reject story revisions                    | same canonical mutation entry points; old write routes must remain disabled until verified                                                                    |
| DOM-held edits                | table cell/contenteditable, protected-table rendering, textbox sub-editors, HF editors; global ai-docs-commit-tables event | fence input before model commit; flush synchronously then wait for every affected state snapshot; pending sub-story means no T14 apply/save                   |
| Separate story editors        | subscribeSubEditorState; HF commitHfAt/commitHfPictureAt; footnote/endnote panels                                          | unified shared clock before ref/store mutation; main PM listener alone cannot observe them                                                                    |
| Lifecycle and bytes           | file load/new/reparse, docGeneration, setContent, setDoc, source bytes/password state, native returned fullBytes           | revoke old adapter epoch and invalidate shared clock before replacement; reuse no old approval or inverse                                                     |
| Async derived persistent work | settleFontSettings, source package/chart reads, header/footer image work, phased content                                   | owner-specific pending token; capture identity/version and recheck after await; never acknowledge another owner's pending work                                |
| Save/autosave                 | manual save, autosave/blur, ai-docs-run-done, recovery writer, native save response reparse                                | serialize stable snapshot; preserve newer dirty generations; T14 exact stage/bind/commit receipt; save in flight remains a separate gate                      |
| Automation                    | native MCP bridge, __aidocs, __genofficeControl, legacy AI tool registry                                                   | host mode already disables native MCP and assistant; do not re-enable as a shortcut around T14 policy                                                         |
| Layout                        | pageCount enters saved NUMPAGES; font/CSS metrics also affect layout                                                       | distinguish display-only zoom/scroll/CSS from serialized page count; define cache normalization before allowing automatic acknowledgement                     |

## React concurrency finding

A setter-side counter followed by one global layout-effect acknowledgement is insufficient: a high-priority render can commit while lower-priority state updates remain pending. Acknowledging the global counter can incorrectly reopen writes against old metadata. Do not adopt that pattern.

A bounded JSON-only synchronous metadata value/version store with useSyncExternalStore has now been prototyped, with owner-scoped acknowledgement of the actual rendered snapshot. Suspense/transition tests cover both a synchronous external snapshot committing while an unrelated lane waits and a truly suspended field remaining pending until its own commit. Mutable Maps/binary/package models are intentionally rejected rather than silently copied. This requires migration of all persisted setters and synchronous mirrors, and explicit DOM/async/lifecycle ownership. It is not yet installed in App. Unknown/unmigrated mutation owners remain fail-closed.

## Minimum supported command

Only `docs.replace_text.v1`: one top-level plain text paragraph range, exact from/to/expectedText and bounded replacement. No nested/protected containers, marks/stored formatting, structure edits, newline/control characters or malformed Unicode. A dedicated inverse token contains exact inverse PM steps and before/after document identity; generic history undo is forbidden.

The tested primitive uses actual Tiptap/ProseMirror and the native DocParagraph/full editorExtensions stack, but this does not establish full App metadata fencing or a production DOM roundtrip. Production mounting remains blocked until the inventory above has executable coverage and independent sign-off.

## Product impact and implementation size

Safe deliverable now: native single-range PM primitive, shared monotonic mutation clock, serializer-input inventory guard (52 explicit inputs), and JSON-field React concurrency prototype. These are additions, not a migrated App or enabled product feature.

Full activation is a wider App refactor: roughly 50 serializer inputs plus their dirty flags, synchronous mirrors, DOM-held sub-story edits, async package work and save/lifecycle ownership must be routed through common contracts. The JSON prototype cannot own parsed DOCX Maps/bytes or mutable engine objects. New store semantics require specific migration tests for each setter family; do not mechanically replace all useState calls. Existing users see no new editing capability until that work and real browser/editor save tests pass.

## Ownership and concurrency prototype boundaries

Each pending producer receives a unique registered capability; duplicate names and reserved PM ownership are rejected. A capability can acknowledge only its own pending version. The PM clock path cannot clear a metadata/lifecycle token. Stores are created once by the host outside React render, so StrictMode/concurrent abandoned renders cannot duplicate owners; hooks consume existing stores. The same host clock survives adapter reconstruction. Apply and inverse both recheck whole-host readiness after dispatch; a synchronous plugin/listener creating pending metadata causes unknown outcome, even if the PM document changed successfully.

## Verification of this additive prototype

- Real Tiptap/ProseMirror + jsdom focused tests: 14/14 passed, zero skips. Includes exact inverse, stale user edits/selection, reload clock, stored-mark red/green, Unicode/control rejection, nested-container rejection, filtered/appended transactions, external pending/acknowledged mutation during dispatch, read-only and disposal.
- Repository native Vitest configuration: 12/12 passed across native DocParagraph/full extension stack, owner clock, immutable JSON field store, React transition/Suspense/StrictMode and the 52-input serializer inventory guard.
- Focused strict TypeScript passed. Independent final static review found no remaining definite prototype-draft blocker; the reviewer did not rerun this final 14/12 suite.
- Direct Node import of the full native extension module initially failed on CSS module loading; the native checks were moved to the repository's Vite/Vitest loader and passed. One early React lane assertion expected pending even after the external snapshot had actually committed; diagnosis showed the DOM already contained the new value. The corrected tests separately verify that committed snapshots may acknowledge and genuinely suspended snapshots cannot.
- No real browser/system roundtrip, complete App migration, native production build or full repository test run is claimed. Existing App.tsx/file-actions.ts and normal editing paths are unchanged.
