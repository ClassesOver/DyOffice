import { FloatWatch } from './editor/float-watch'
import { scriptFontHtml } from './editor/script-fonts'
import { carryDocSeen } from './ai/tools'
import { DOC_CSS_COMMITTED_EVENT, WRAP_WIDTHS_COMMITTED_EVENT } from './editor/cjk-punct-shrink'
import { justifyShrinkPluginKey } from './editor/justify-shrink'
import { tabReflowMeta } from './editor/decoration-extensions'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, SetStateAction } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { handleDocsControl, type ControlRequest } from './control'
import { DOMParser as PmDOMParser, type Mark as PmMark, Slice as PmSlice } from '@tiptap/pm/model'
import { NodeSelection, TextSelection, type Command, type Transaction } from '@tiptap/pm/state'
import {
  Dropdown,
  ImageViewer,
  aiPanelInitiallyOpen,
  rememberAiPanelOpen,
  createZoomWheelClassifier,
  useAutoSavePref,
  useAiSidebarEnabled,
} from '@genoffice/ui'
import { commentAnchors, commentIdsAt, wordRangeAtCaret } from './editor/comments'
import { isCommandLetter } from './command-letter'
import { setFieldInstr, toggleAllFieldCodes, type FieldRange } from './editor/field-codes'
import { linkTarget } from './editor/link-actions'
import { FieldDialog } from './components/FieldDialog'
import { markdownPasteHtml } from './editor/markdown-paste'
import { pasteTextSlice, singleCellPasteText } from './editor/paste-text'
import {
  imageFilesFromDataTransfer,
  insertImageFilesAtCoords,
  isImageFileDrag,
} from './editor/image-drop'
import {
  caretFontSlots,
  fillMissingRunFonts,
  isForeignPasteHtml,
  pushDownWebInlineStyles,
} from './editor/paste-web-html'
import {
  beginForeignPaste,
  caretParaFormat,
  caretStyleMark,
  consumeForeignPaste,
  defaultPasteMode,
  lastForeignPasteMode,
  mergeFormattingFragment,
  stashPastePayload,
  takeTextReroute,
} from './editor/paste-options'
import { PasteOptionsChip } from './components/PasteOptionsChip'
import {
  BLANK_BULLET_NUM_ID,
  BLANK_ORDERED_NUM_ID,
  DEFAULT_SECTION,
  applyPageNumType,
  customLevelFromNumberingLevel,
  applySectionSettings,
  applySectionStartType,
  applyTitlePg,
  verifyProtectionPassword,
  type Block,
  type CommentInfo,
  type CustomNumberingLevel,
  type NumberingDef,
  type DocProtection,
  type WriteProtection,
  mergeFieldName,
  nextNoteId,
  placeholderText,
  type HeaderFooter,
  type HfPictureEdit,
  type HfImage,
  type NoteInfo,
  type NoteSeparator,
  type TextboxDisplay,
  type ParsedDocFull,
  type SectionInfo,
  type SectionSettings,
  type SourceInfo,
  pendingHeadingLevel,
  pictureWatermarkPreviewImage,
  textWatermarkPreviewImage,
  previewFontSettings,
  type StyleInfo,
  type StyleUpsert,
  type DefaultFonts,
  type ThemeColors,
  type ThemeFonts,
  type PictureWatermarkSpec,
  type Watermark,
  type WatermarkSpec,
  type CommentImage,
} from '@genoffice/docx-engine'
import type {
  AiDocContent,
  AiSettings,
  MenuCommand,
  MergeDataSource,
  OpenDocxResult,
} from '../shared/ipc'
import { AI_PROVIDERS } from '../shared/ipc'
import {
  buildMailMergeFiles,
  type MailMergeRequest,
  type MailMergeResponse,
} from './mail-merge/output'
import { ZoteroDocumentController } from './zotero/controller'
import { AiPanel, aiRevisionAuthor } from './ai/AiPanel'
import type { AiCommentsAccess, AiDocExtras, AiHeaderFooterAccess } from './ai/tools'
import type { AiStyleInfo } from './ai/style-ops'
import { applyResolvedPageSetup, describeSection, type AiPageSetupAccess } from './ai/page-setup'
import {
  dropRemovedPendingSections,
  patchPendingSectPr,
  pendingSectionAt,
  rewritePendingSectPrs,
  sectionIndexAtBlock,
} from './ai/pending-sections'
import { protectedNoteMarkBlock, type AiNotesAccess } from './ai/note-ops'
import { applyHfText, hfEditText } from './editor/hf-text'
import {
  insertHfField,
  insertHfInstrField,
  insertHfPicture,
  mountHfEditor,
  type HfEditorHandle,
} from './editor/hf-editor'
import type { HfAction, HfEditingInfo } from './components/ribbon-hf-tab'
import {
  hfCommitTarget,
  hfLinked,
  hfTextCommit,
  ownHf,
  resolveHf,
  withHfLink,
  withHfPictureEdit,
  type HfSectionState,
} from './hf-sections'
import { installHfFloatEdit, tagHfFloatEl } from './editor/hf-float-edit'
import { hfFooterLine, hfLayoutResolved, hfPhantomSpec, hfWithPhantom } from './hf-phantom'
import { hfVariantHeightsPx, sectionHfHeights } from './hf-heights'
import { makeGapNotesEl, measureNoteHeightDom, noteRowMetrics } from './editor/note-dom'
import { AiAskPopover } from './components/AiAskPopover'
import { EDIT_QUEUE_MAX, selectionForAnchor, type DocsEditQueueItem } from './ai/edit-queue'
import { addQueueAnchor, clearQueueAnchors, removeQueueAnchors } from './editor/ai-queue-anchors'
import {
  asianCharCount,
  countWords,
  documentTextForWordCount,
  nonAsianWordCount,
  selectedWordCount,
} from './word-count'
import { CommentsPanel } from './components/CommentsPanel'
import { EquationModal } from './components/EquationModal'
import { HeaderFooterArea } from './components/HeaderFooterArea'
import { PageFootnotes, PageEndnotes } from './components/PageNoteAreas'
import type { NoteKind } from './note-format'
import { PaginationPreview } from './components/PaginationPreview'
import { imageParaPaginationMeta, paraPaginationMeta, tableWidowOff } from './editor/para-flags'
import {
  comparePlanToBlocks,
  planByElement,
  planDiffHistogram,
  planPropsOf,
  type PlanOf,
  type PlanDiff,
} from './pagination-plan'
import { PrintDialog } from './components/PrintDialog'
import {
  hfVariantOf,
  hfVariantReservedPx,
  bumpLineSampleFontEpoch,
  carryStreamedSamples,
  endnotesAnchorY,
  createLineRectsCache,
  anchorElement,
  lineStartAnchor,
  liveSections,
  nextLineAnchor,
  measureBlocks,
  alignJoinedParagraphs,
  docGridPitchPt,
  type LineAnchor,
  hfPartWidthPx,
  headingPagesOf,
  pageCutSignature,
  pageLeadsOf,
  applyGapLedger,
  pagePaperEdges,
  pageReaderShadow,
  type FlowCarry,
  LEAD_ROW_TOL_PX,
  outerTableRows,
  type PageCut,
  pageNumbers,
  type SliceOutputs,
  tableRowFlags,
  type BlockBox,
  type BlockMeta,
  type PageNoteItem,
  pageAt,
  pageOfY,
  singleCutCell,
  columnLayoutSpecs,
  widthPassGate,
  newWidthPassState,
  resetWidthPassHistory,
  vAlignShiftSpecs,
  verticalTextSpecs,
  blockInlineExtraPx,
  sectionVertical,
  sectionPageStartSpecs,
  wrapWidthSig,
  sectionTopMarginSpecs,
  sectionWidthSpecs,
  mirrorMarginSpecs,
  paperWidthPx,
  pageLeftPx,
  sectionGridPitchPt,
  sectionGridPitchSpecs,
  docCharSpacePt,
  sectionCharSpaceSpecs,
  singleByteCharSpacePt,
  type ColumnBlockPlacement,
  sectionBidi,
  sectionColGeom,
  sectionColumns,
  sectionGeoms,
  sectionPageBox,
  canvasContentTopPx,
  effectiveTopPx,
  effectiveBottomPx,
  singleVariantGeomOf,
  formatPageNumber,
  sectionPageCounts,
  visiblePageCount,
  type SectionGeom,
  type SectionHfHeights,
  isResumePage,
  type PageSlice,
  type PassResume,
  blockGapRects,
} from './pagination'
import { prepareFlow, sliceFlow, type PassContext } from './pagination-pass'
import {
  GAP_BAND,
  alignGapHfStrips,
  alignTableGapFills,
  clearFloatShifts,
  floatFlowChangedMeta,
  insideFloatTable,
  setFloatVShifts,
  floatCarriesOf,
  floatShiftsOf,
  setOversizeClips,
  setPageGaps,
  stampGapFlowTops,
  canvasZoomOf,
  rowFillsSig,
  setRowFills,
  syncAnchorBands,
  syncCutOverlays,
  syncFloatShifts,
  syncPageBorders,
  syncPageSheets,
  clampCellBoxTops,
  clampCellImageTops,
  pinCellBoxesToPage,
  pinPageRelXPictures,
  pinParagraphRelVPictures,
  pageBorderStyleOf,
  type PageGapSpec,
  type GapMetrics,
  LayoutBatch,
  pageFramesFromGaps,
  gapLedgerOf,
  PAGE_TURN_SEL,
  isPageTurn,
  type PageFrame,
} from './editor/pagination-gaps'
import { syncWrapObstacles } from './editor/wrap-obstacles'
import { newObstacleShadow, obstaclePlanDiffs } from './editor/obstacle-plan'
import { MultipageGrid, snapshotCanvas, type CanvasSnapshot } from './components/MultipageGrid'
import { layoutMultipage, multipageColumns, multipageZoomForColumns } from './multipage'
import { setColumnLayout } from './editor/column-layout'
import { pageMargins } from './page-margins'
import { syncLineNumbers } from './editor/line-numbers'
import { formattingMarksPluginKey, sectionBreakMap } from './editor/formatting-marks'
import {
  COMMENT_AREA_W,
  clearMarginAnnotations,
  syncMarginAnnotations,
  type MarginHandlers,
} from './editor/margin-annotations'
import {
  bumpHfProbeFontEpoch,
  hfHasPageField,
  hfHasVisibleContent,
  hfPageNumberOnly,
  hfWithoutPageMarks,
  hfStripGeom,
  hfBodyObstacles,
  makeGapHfEl,
  hfImageHangsOnPara,
  makeHfFloatImgEl,
  type HfFloatBox,
} from './editor/hf-dom'
import {
  estimateFootnoteHeight,
  resolveNoteStyle,
  noteRunStyle,
  footnoteLineHeightPx,
  noteSeparatorPx,
  noteSeparatorRow,
  setNoteSeparatorRows,
  takeSettledMetricFaces,
  textHasCjk,
} from './line-metrics'
import { saveUntilPersisted } from './save-until-persisted'
import { SPELLCHECK_KEY, spellcheckEnabled } from './spellcheck-pref'
import { cachedByDoc } from './doc-cache'
import { useShallowStable, useStableCallbacks } from './use-stable'
import { FindPanel } from './components/FindPanel'
import { ZoomDialog } from './components/ZoomDialog'
import { TrackChangesOptionsDialog } from './components/TrackChangesOptionsDialog'
import {
  loadTrackChangesOptions,
  movesByAuthor,
  saveTrackChangesOptions,
  trackChangesOptionsCss,
  trackChangesOptionsState,
  type TrackChangesOptions,
} from './editor/track-changes-options'
import type { PageLayout } from './editor/goto'
import { Ribbon, type ConvertFormat } from './components/Ribbon'
import {
  AdjustListIndentsDialog,
  DefineBulletDialog,
  DefineMultilevelDialog,
  DefineNumberFormatDialog,
  SetNumberingValueDialog,
  type ListDialogKind,
} from './components/ListDialogs'
import {
  documentListPresets,
  numberPresetLevels,
  recentListPresets,
  rememberListPreset,
} from './list-presets'
import { computeFormatState } from './components/ribbon-format-state'
import {
  IconOutlineView,
  IconStoryView,
  IconPrintLayout,
  IconReadMode,
  IconRedo,
  IconSave,
  IconUndo,
  IconWebLayout,
} from './components/icons'
import { ToastHost } from './components/toast'
import {
  imageSizeOf,
  AI_REWRITE_ACK_KEY,
  LinkInsertModal,
  TableInsertModal,
  applyParagraphStyle,
  clearParagraphFormatting,
  insertImageFromDataUrl,
  insertImageViaDialog,
  insertPageBreakAt,
  setParaAttrs,
  type RevisionDisplayMode,
  type ViewMode,
} from './components/ribbon-tabs'
import { ComparePanel } from './components/ComparePanel'
import {
  EditorContextMenu,
  FontDialog,
  ParagraphDialog,
  type ContextMenuState,
} from './components/ContextMenu'
import { RedactDialog } from './editor/RedactDialog'
import {
  CellMarginsDialog,
  DeleteCellsDialog,
  InsertCellsDialog,
  SplitCellsDialog,
  type TableDialogKind,
} from './components/TableDialogs'
import { TablePropertiesDialog } from './components/TablePropertiesDialog'
import { showToast } from './components/toast-bus'
import { setTableAutoFit, toggleRepeatHeaderRows } from './editor/table-properties'
import { distributeSelectedColumns } from './editor/table-sizing'
import {
  deleteTableColumn,
  distributeRowsEvenly,
  editableOrToast,
  ensureCaretInTable,
  insertRowsOrColumns,
  selectTablePart,
  splitTableAtSelection,
} from './editor/table-ops'
import { deleteRow, deleteTable, mergeCells } from '@tiptap/pm/tables'
import { PromptModal } from './components/PromptModal'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { WordCountDialog, type DocStats } from './components/WordCountDialog'
import { AutoCorrectDialog } from './components/AutoCorrectDialog'
import { PreferencesDialog } from './components/PreferencesDialog'
import { applyCase, nextCaseMode, selectionText } from './editor/case-transform'
import { stepHangingIndent, stepParagraphIndent } from './editor/indent'
import { PasswordDialog } from './components/PasswordDialog'
import { ProtectDialog, type ProtectDialogResult } from './components/ProtectDialog'
import { t, useI18n } from './i18n/locale'
import {
  getActiveSubEditor,
  setActiveSubEditor,
  subscribeSubEditorState,
} from './editor/active-editor'
import { installSelectionBar } from './editor/selection-bar'
import type { CompareEntry } from './editor/compare'
import { collectHeadings } from './editor/headings'
import { updateTocField } from './editor/toc-update'
import { applyTocPageDisplays, backfillTocPageDom } from './editor/toc-refresh'
import { setSelectionAlign } from './editor/direction'

import {
  editorExtensions,
  findFloatImageAt,
  runPictureAtEvent,
  resolvedCommentsPluginKey,
  revisionDisplayState,
} from './editor/extensions'
import { resolveDarkPage, writeDarkPagePref } from './dark-page-pref'
import { useDocThemeIsDark, useUiThemeIsDark } from './ui-theme'
import { type InkAnnotation, type InkTool } from './editor/ink'
import { loadInkPresets, saveInkPresets, type InkPreset } from './editor/ink-presets'
import { InkOverlay } from './components/InkOverlay'
import {
  TRACK_IGNORE,
  collectRevisions,
  selectRevision,
  type RevisionRange,
  type TrackChangesStorage,
} from './editor/revisions'
import {
  DEFAULT_REVISION_FILTER,
  authorInkIndex,
  buildReviewEntries,
  filterRevisions,
  revisionAuthorCss,
  revisionAuthors,
  revisionsInSelection,
  type ReviewEntry,
  type RevisionFilter,
  type RevisionScope,
} from './editor/revision-filters'
import { ReviewingPane } from './components/ReviewingPane'
import {
  collectHfRevisions,
  collectNoteRevisions,
  collectTextboxRevisions,
  liveStoryRevision,
  ownHfSlots,
  resolveHfValue,
  resolveNotes,
  resolveTextboxes,
  type StoryRevision,
} from './editor/story-revisions'
import {
  BALLOON_MODE_KEY,
  balloonKindOf,
  balloonRevKinds,
  loadBalloonMode,
  markupPrintsIn,
  noteRunsInView,
  revisionHiddenIn,
  type BalloonMode,
} from './editor/revision-view'
import { setInlineComments } from './editor/balloon-markers'
import { NavPane } from './components/NavPane'
import { loadLeftPane, saveLeftPane, type LeftPane } from './components/pane-width'
import {
  commentsView,
  iconClickTarget,
  loadCommentsMode,
  saveCommentsMode,
  type CommentsMode,
} from './components/comments-mode'
import { StylesPane } from './components/StylesPane'
import { Ruler } from './components/Ruler'
import { docBodyFont, docHasCjk, docLineFactor, docStyleCss, docThemeCss } from './doc-style-css'
import { docFontsCoveredBy } from './font-check'
import { fontAliasAnswers, onFontAliasesChanged } from './system-fonts'
import { isDocDirty, runGuardedCandidate, runGuardedDocumentAction } from './doc-dirty'
import {
  EMPTY_HF_VARIANTS,
  restingHfAreaVariant,
  type DocState,
  type HfVariantKey,
  type HfVariantsState,
  type HfView,
  EMPTY_PENDING_NUMBERING,
  pendingNumberingDirty,
  type PendingNumbering,
} from './doc-state'
import {
  applyAiDocContent as applyAiDocContentImpl,
  exportPdf as exportPdfImpl,
  exportHtml as exportHtmlImpl,
  exportMarkdown as exportMarkdownImpl,
  exportImages as exportImagesImpl,
  loadFile as loadFileImpl,
  newFile as newFileImpl,
  printDoc as printDocImpl,
  save as saveImpl,
  suggestedSaveAsName,
  writeRecoveryCopy as writeRecoveryCopyImpl,
  buildDocBytes,
  type FileActionContext,
  type PendingPdfExport,
} from './file-actions'
import { BlockIndex } from './pagination-index'
import { isPhasedContentPending, waitForFullContent } from './phased-content'
import { sameSectionInfos } from './pagination-sections'
import {
  blocksKeepSlicing,
  firstChangedTopLevelIndex,
  singleInlineEditIndex,
  type FastPassBlock,
} from './editor/pagination-fast-path'
import { FollowUpChain } from './pagination-loop'
import { tabLayoutDiag } from './editor/decoration-extensions'
import { layoutHealth } from './editor/layout-health'

/** min gap between whole-document pagination passes while a phased open streams its tail */
const STREAMING_PASS_GAP_MS = 1500
/** passes wait at least this many times their own duration while streaming */
const STREAMING_PASS_DUTY = 4
const STREAMING_PASS_GAP_MAX_MS = 15_000
/** after an edit, the pass waits this many times its own last duration (300 ms floor) */
const EDIT_PASS_DUTY = 3
const EDIT_PASS_DEBOUNCE_MAX_MS = 2000
/** a pass re-running for its own late-applied widths / suppression: nobody is
 *  typing, so it only waits for the previous pass's DOM writes to commit */
const FOLLOW_UP_PASS_DELAY_MS = 100
const EXPORT_PASS_RETRY_MS = 500
const WORD_COUNT_THROTTLE_MS = 400
/** consecutive follow-up passes a pass may schedule for itself */
import { runHeadlessDocumentExport } from './headless-export'
import { installMcpBridge } from './mcp-bridge'
import {
  clampDocsZoom,
  DOCS_ZOOM_MAX,
  DOCS_ZOOM_MIN,
  nextDocsZoom,
  stepDocsZoom,
  type ZoomFitMode,
} from './wheel-zoom'
import {
  allocateListNumId as allocateListNumIdImpl,
  addPictureBullet,
  changeListLevel as changeListLevelImpl,
  continueNumbering as continueNumberingImpl,
  currentListTarget as currentListTargetImpl,
  currentListValue,
  editListLevel as editListLevelImpl,
  hasPreviousList,
  setNumberingValue as setNumberingValueImpl,
  createCustomListDef as createCustomListDefImpl,
  restartNumbering as restartNumberingImpl,
  type NumberingContext,
} from './numbering-actions'
import {
  addInk as addInkImpl,
  addCommentAt as addCommentAtImpl,
  cancelNewComment as cancelNewCommentImpl,
  clearInks as clearInksImpl,
  commentThreadAtCaret as commentThreadAtCaretImpl,
  compareWithFile as compareWithFileImpl,
  deleteAllComments as deleteAllCommentsImpl,
  deleteComment as deleteCommentImpl,
  deleteCommentAtCaret as deleteCommentAtCaretImpl,
  deleteNote as deleteNoteImpl,
  editComment as editCommentImpl,
  gotoComment as gotoCommentImpl,
  handleRevision as handleRevisionImpl,
  handleRevisionRange as handleRevisionRangeImpl,
  removeInks as removeInksImpl,
  replyToComment as replyToCommentImpl,
  resolveComment as resolveCommentImpl,
  startNewComment as startNewCommentImpl,
  submitNewComment as submitNewCommentImpl,
  submitNote as submitNoteImpl,
  type NotePrompt,
  type ReviewContext,
} from './review-actions'
import { authorName, onAuthorNameChanged } from './author-name'

const IS_MAC = navigator.platform.toLowerCase().includes('mac')

const twipsToPx = (twips: number) => (twips / 1440) * 96

/** tiny stable string hash for decoration keys */
function hashStr(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return h
}

const EMPTY_BLOCKS: Block[] = []

// O(doc) derivations cached by PM doc reference: caret moves and unrelated
// state updates reuse the last result instead of re-walking the whole document
const wordCountOfDoc = cachedByDoc((d) => countWords(documentTextForWordCount(d)))
const revisionsOfDoc = cachedByDoc((d) => collectRevisions(d))

/**
 * Document position of a measured line-start DOM anchor. posAtDOM works from the DOM
 * tree, unlike posAtCoords whose viewport hit-testing returns degenerate positions for
 * lines scrolled off-screen (which misplaced page-break markers into table bodies,
 * inflating the canvas table by a phantom anonymous row and skewing pagination).
 */
function posFromAnchor(view: Editor['view'], anchor: LineAnchor): number | undefined {
  try {
    // element anchors (picture-only lines): address the position before the
    // element via its parent + child index (offset semantics inside an atom
    // leaf's own DOM are undefined)
    const pos =
      anchor.node instanceof Element
        ? anchor.node.parentNode
          ? view.posAtDOM(
              anchor.node.parentNode,
              Array.prototype.indexOf.call(anchor.node.parentNode.childNodes, anchor.node),
            )
          : -1
        : view.posAtDOM(anchor.node, anchor.charOffset)
    return pos >= 0 ? pos : undefined
  } catch {
    return undefined
  }
}

/** Clean pasted Word/web HTML: mso conditional comments, <o:p>, and unwrapping <li><p>x</p></li>;
 *  foreign fragments also get block-level font/size/color pushed down onto
 *  spans so whole-paragraph web copies keep their formatting (r181) */
function cleanPastedHtml(html: string): string {
  const cleaned = unwrapSingleCellTable(
    html
      .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/g, '')
      .replace(/<o:p>[\s\S]*?<\/o:p>/g, '')
      .replace(/<li([^>]*)>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/li>/g, '<li$1>$2</li>'),
  )
  return isForeignPasteHtml(html) ? pushDownWebInlineStyles(cleaned) : cleaned
}

/** Plain text for a text-mode paste whose clipboard carries no text/plain
 *  flavor (some apps write HTML only) — the fragment's text content with
 *  block boundaries as line breaks. */
function htmlFallbackText(html: string): string {
  if (!html) return ''
  try {
    const body = new window.DOMParser().parseFromString(html, 'text/html').body
    for (const block of body.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,br')) {
      block.after(body.ownerDocument.createTextNode('\n'))
    }
    return (body.textContent ?? '').replace(/\n{2,}/g, '\n').trim()
  } catch {
    return ''
  }
}

// The per-paste foreign-HTML handshake (mode selection, chip payload) lives
// in editor/paste-options.ts: the paste DOM handler and the ribbon Paste
// button arm it (the clipboard is parsed BEFORE handlePaste runs, so the
// mode must be decided when the paste event arrives), transformPasted and
// the handlePaste lanes consume it. Our own clipboard HTML keeps its exact
// run marks, plain-text pastes go through pasteTextSlice, and drops never
// arm anything.

/**
 * Word parity: pasting a copy of a SINGLE spreadsheet cell inserts its
 * content as text, not a 1x1 table (a lone cell copied from Sheets/Excel
 * pasted into Docs as a table and flipped the ribbon into table tools). Only a payload whose entire content is one table with one
 * cell unwraps; anything else — multi-cell tables, tables mixed with prose —
 * stays intact.
 */
function unwrapSingleCellTable(html: string): string {
  if (!/<table/i.test(html)) return html
  try {
    const doc = new window.DOMParser().parseFromString(html, 'text/html')
    const body = doc.body
    const tables = body.querySelectorAll('table')
    if (tables.length !== 1) return html
    const table = tables[0]!
    // The table must be the only real content of the paste. Text equality
    // covers prose ANYWHERE outside the table — including inside wrappers
    // that also contain it — and Element.textContent excludes HTML comments,
    // so Excel's StartFragment markers don't block the unwrap.
    if ((body.textContent ?? '').trim() !== (table.textContent ?? '').trim()) return html
    // text-less content outside the table (images, separators) also keeps it
    if (
      [...body.querySelectorAll('img,svg,video,hr')].some((element) => !table.contains(element))
    ) {
      return html
    }
    const cells = table.querySelectorAll('td,th')
    if (cells.length !== 1) return html
    if (cells[0]!.querySelector('table')) return html
    return cells[0]!.innerHTML
  } catch {
    return html
  }
}

/** All runs a footnote/endnote reference may live in: paragraph runs, plus table
 *  cell paragraphs (incl. nested tables) — refs inside cells still print their
 *  note at the page bottom like Word */
function blockNoteScanRuns(b: Block): NonNullable<Block['runs']> {
  const out: NonNullable<Block['runs']> = []
  if (b.runs) out.push(...b.runs)
  const walkTable = (table: NonNullable<Block['table']> | undefined): void => {
    for (const row of table?.rows ?? []) {
      for (const cell of row) {
        for (const p of cell.richParas ?? []) out.push(...p.runs)
        for (const nested of cell.nestedTables ?? []) walkTable(nested)
      }
    }
  }
  if (b.table) walkTable(b.table)
  return out
}

const DEFAULT_SETTINGS: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(
    AI_PROVIDERS.map((p) => [
      p.id,
      { apiKey: '', model: p.defaultModel, baseUrl: p.needsBaseUrl ? '' : undefined },
    ]),
  ) as AiSettings['providers'],
}

/** Table menu items that are plain editor commands (the dialogs and Distribute Rows are handled inline) */
const TABLE_MENU_COMMANDS: Partial<Record<MenuCommand, (widthPx: number) => Command>> = {
  'table-insert-rows-above': (w) => insertRowsOrColumns(1, 'above', w),
  'table-insert-rows-below': (w) => insertRowsOrColumns(1, 'below', w),
  'table-insert-cols-left': (w) => insertRowsOrColumns(1, 'left', w),
  'table-insert-cols-right': (w) => insertRowsOrColumns(1, 'right', w),
  'table-delete-table': () => deleteTable,
  'table-delete-columns': () => deleteTableColumn,
  'table-delete-rows': () => deleteRow,
  'table-select-table': () => selectTablePart('table'),
  'table-select-column': () => selectTablePart('column'),
  'table-select-row': () => selectTablePart('row'),
  'table-select-cell': () => selectTablePart('cell'),
  'table-merge-cells': () => mergeCells,
  'table-split-table': () => splitTableAtSelection(),
  'table-autofit-contents': (w) => setTableAutoFit('contents', w),
  'table-autofit-window': (w) => setTableAutoFit('window', w),
  'table-autofit-fixed': (w) => setTableAutoFit('fixed', w),
  'table-distribute-columns': (w) => distributeSelectedColumns(w),
  'table-repeat-header': () => toggleRepeatHeaderRows(),
}

/** heading level after a define_style patch: null outlineLevel drops heading status, a number sets it, absent keeps the current */
/** An encrypted file is not a document yet: the replace guard waits until the
 *  password prompt has decrypted one (submitDocPwd), so a cancelled or wrong
 *  password never saves or discards the document that is still open. */
function replacesDocument(result: NonNullable<OpenDocxResult>): boolean {
  return !('needsPassword' in result)
}

const warnedPlanClasses = new Set<string>()

/** I9 shadow: plan vs scrape for the measured blocks; disagreements are reported, never applied */
function shadowPlanDiff(
  planOf: PlanOf,
  blocks: BlockBox[],
  metaOf: (docxIndex: number) => BlockMeta | undefined,
): PlanDiff[] {
  const diffs = comparePlanToBlocks(blocks, planOf, metaOf)
  if (import.meta.env.DEV) {
    for (const d of diffs) {
      if (warnedPlanClasses.has(d.cls)) continue
      warnedPlanClasses.add(d.cls)
      console.warn(`[pagination] plan/scrape disagree on ${d.cls}`, d)
    }
  }
  return diffs
}

export function App({ host }: { host?: { readOnly: boolean; assistantAvailable: boolean; preferenceScope: string; onEditorReady?(handle: import('./file-actions').DocsEditorHandle | null): void; lifecycle: import('./file-actions').DocsHostLifecycle; onDocumentEdited(): void; onOpenFailed(): void } } = {}) {
  // subscribe to language switches for re-render; strings all go through module-level t, so memoized callbacks never capture stale closures
  const { lang } = useI18n()
  const [doc, setDoc] = useState<DocState | null>(null)
  /** a phased open is still streaming the document tail: editor stays read-only */
  const [docLoading, setDocLoading] = useState(false)
  /** true until the pending-open / new-blank boot checks settle; the start screen stays hidden meanwhile */
  const bootPendingRef = useRef<Promise<[OpenDocxResult, boolean, AiDocContent | null]> | null>(
    null,
  )
  const bootHandledRef = useRef(false)
  /** password prompt for an ECMA-376 encrypted docx; submit retries via openDocxDecrypt */
  const [docPwdPrompt, setDocPwdPrompt] = useState<{
    path: string
    name: string
    value: string
    /** i18n key of the inline failure line ('' = none) */
    errorKey: '' | 'appDocPwdWrong' | 'appDocPwdUnsupported'
    busy: boolean
  } | null>(null)
  /** Review > Protect: the combined Word-style Protect Document dialog */
  const [showProtectDialog, setShowProtectDialog] = useState(false)
  /** prompt for a document with a password to modify (w:writeProtection): enter it or open read-only */
  const [modifyPwdPrompt, setModifyPwdPrompt] = useState<{
    value: string
    errorKey: '' | 'appDocPwdWrong'
  } | null>(null)
  const [_recent, setRecent] = useState<string[]>([])
  const [settings, setSettings] = useState<AiSettings>(DEFAULT_SETTINGS)
  const [showAi, setShowAi] = useState(() => host?.assistantAvailable === false ? false : aiPanelInitiallyOpen('aidocs.showAi'))
  // Settings › "show the AI sidebar" off hides the panel and its rail the way Word
  // treats the Copilot pane: an explicit Ask-AI action (ribbon, context menu,
  // shortcut, preset) still opens the panel for this document, and closing it
  // returns to hidden. The dock stays mounted either way, so panel state and
  // in-flight runs survive; the hook closes it when the switch itself goes off.
  const aiSidebarEnabled = useAiSidebarEnabled(setShowAi)
  const [spellcheck, setSpellcheck] = useState(spellcheckEnabled)
  const [largeDocSpellOff, setLargeDocSpellOff] = useState(false)
  const spellcheckActive = spellcheck && !largeDocSpellOff
  const spellcheckActiveRef = useRef(spellcheckActive)
  spellcheckActiveRef.current = spellcheckActive
  /** Increments on every open/new document: AiPanel remounts by key to reset the conversation and history (save path changes don't bump it, so the session continues) */
  const [aiPanelKey, setAiPanelKey] = useState(0)
  const [ribbonTabRequest, setRibbonTabRequest] = useState<{ tab: string; nonce: number } | null>(
    null,
  )
  const [status, setStatus] = useState('')
  const [zoom, setZoom] = useState(100)
  const scrollContainerRef = useRef<HTMLElement>(null)
  /** bumps after every pagination pass: the canvas' page gaps are in place */
  const [layoutRev, setLayoutRev] = useState(0)
  /** Multiple Pages grid: page index under the live editor, null while single-column */
  const multipageActiveRef = useRef<number | null>(null)
  const mpFramesRef = useRef<PageFrame[]>([])
  // Word-style dark page (editor/dark-page.ts): the shell's document-page-theme
  // setting (genoffice#1811) decides which theme the page follows; a light
  // page theme never shows a dark page, in the dark one it is on by default
  // until the user switches it off, and that choice sticks (dark-page-pref.ts)
  const themeDark = useUiThemeIsDark()
  const docThemeDark = useDocThemeIsDark()
  const [darkPage, setDarkPage] = useState(() => resolveDarkPage(docThemeDark))
  useEffect(() => {
    setDarkPage(resolveDarkPage(docThemeDark))
  }, [docThemeDark])
  // for toggle-by-one in the menu path, whose closure is not re-created per render
  const darkPageRef = useRef(darkPage)
  darkPageRef.current = darkPage
  /** View ▸ Dark Mode (menu and ribbon): remember the choice, then apply it */
  const updateDarkPage = useCallback(
    (next: boolean) => {
      if (docThemeDark) writeDarkPagePref(next)
      setDarkPage(next)
    },
    [docThemeDark],
  )
  const [section, setSection] = useState<SectionSettings | null>(null)
  /** All sections (readSections): pagination/preview use per-section geometry; layout edits apply to the cursor's section */
  const [sections, setSections] = useState<SectionInfo[]>([])
  const [sectionDirty, setSectionDirty] = useState(false)
  /** Index of the cursor's section (maintained by selectionUpdate) */
  const [activeSection, setActiveSection] = useState(0)
  // displayed number of the caret's page: a mirrored document's ruler follows its parity
  const [caretPageNo, setCaretPageNo] = useState(1)
  const locateCaretPageRef = useRef<() => void>(() => {})
  /** Indexes of edited non-final sections (their section-break paragraphs' sectPr is rewritten on save) */
  const [sectionsDirty, setSectionsDirty] = useState<number[]>([])
  /** Start type pending write to the trailing sectPr after inserting a continuous section break */
  const [trailingStartType, setTrailingStartType] = useState<SectionInfo['startType'] | null>(null)
  const [pageColor, setPageColor] = useState<string | null>(null)
  const [pageColorDirty, setPageColorDirty] = useState(false)
  const [header, setHeader] = useState<HeaderFooter | null>(null)
  const [headerDirty, setHeaderDirty] = useState(false)
  const [footer, setFooter] = useState<HeaderFooter | null>(null)
  const [footerDirty, setFooterDirty] = useState(false)
  const [hfVariants, setHfVariants] = useState<HfVariantsState>(EMPTY_HF_VARIANTS)
  const [hfVariantsDirty, setHfVariantsDirty] = useState<HfVariantKey[]>([])
  const [titlePg, setTitlePg] = useState(false)
  const [titlePgDirty, setTitlePgDirty] = useState(false)
  const [evenOddHf, setEvenOddHf] = useState(false)
  const [evenOddHfDirty, setEvenOddHfDirty] = useState(false)
  const [mirrorMargins, setMirrorMargins] = useState(false)
  const [mirrorMarginsDirty, setMirrorMarginsDirty] = useState(false)
  const [pageInfo, setPageInfo] = useState({ current: 1, total: 1 })
  // last page's number for the document-end footer: text for the page marker, num for
  // even/odd parity (section restarts / pageNumberFmt make both differ from the physical count)
  const [lastPageNo, setLastPageNo] = useState<{ text: string; num: number } | null>(null)
  /** SECTIONPAGES of the first and last pages (the canvas's own header and footer strips) */
  const [edgeSectionPages, setEdgeSectionPages] = useState<{ first: number; last: number } | null>(
    null,
  )
  /** Page-number-format dialog + pending final-section pgNumType write (non-final sections rewrite sectPr via pgNumDirtySections) */
  const [pgNumModal, setPgNumModal] = useState<{ fmt: string; start: string } | null>(null)
  const [pgNumEdit, setPgNumEdit] = useState<{ fmt?: string; start?: number } | null>(null)
  const [pgNumDirtySections, setPgNumDirtySections] = useState<number[]>([])
  /** Pending numbering definitions to append (saved via SaveOptions.numbering; restart numbering / new list definitions) */
  const [pendingNumbering, setPendingNumbering] =
    useState<PendingNumbering>(EMPTY_PENDING_NUMBERING)
  const numberingDirty = pendingNumberingDirty(pendingNumbering)
  /** Header/footer edits for non-final sections (key = `${lastBlockIndex}:${kind}`), saved via SaveOptions.sectionHf */
  const [sectionHfEdits, setSectionHfEdits] = useState<Record<string, HeaderFooter>>({})
  /** Link to Previous switched on for `${sectionIdx}:${kind}`: the section's own default reference goes on save */
  const [hfLinks, setHfLinks] = useState<Record<string, true>>({})
  /** the strip whose editor is open (drives the contextual Header & Footer tab) */
  const [hfEditing, setHfEditing] = useState<{
    kind: 'header' | 'footer'
    section: number
    variant: HfView
    /** absolute page index of the strip (formatted numbers repeat across restarted sections) */
    pageIdx: number
    /** section whose part the strip showed when the editor opened */
    owner: number
  } | null>(null)
  const hfEditingRef = useRef(hfEditing)
  hfEditingRef.current = hfEditing
  /** an edge strip commits to the variant its editor opened with, not the view a toggle switched to meanwhile */
  const edgeHfTarget = (kind: 'header' | 'footer', view: HfView) => {
    const open = hfEditingRef.current
    return open?.kind === kind
      ? { variant: open.variant, owner: open.owner }
      : { variant: view, owner: undefined }
  }
  /** bumps on document changes so derived section state follows deleted break paragraphs */
  const [docVersion, setDocVersion] = useState(0)
  const hfEditorRef = useRef<HfEditorHandle | null>(null)
  const [hfAreaEditRequest, setHfAreaEditRequest] = useState<{
    kind: 'header' | 'footer'
    nonce: number
  } | null>(null)
  const multiHf = sections.length > 1
  /** Variant an on-canvas edge area shows/edits: like Word, it follows its page — the header area is page 1 and the footer area the last page */
  const areaView = (kind: 'header' | 'footer'): HfView =>
    restingHfAreaVariant(kind, {
      titlePg,
      evenOddHf,
      pageCount: pageInfo.total,
      ...(lastPageNo ? { lastPageNo: lastPageNo.num } : {}),
    })
  const headerAreaView = areaView('header')
  const footerAreaView = areaView('footer')

  /** the AI header/footer tool edits the strip the matching edge area shows */
  const commitHf = (kind: 'header' | 'footer', next: HeaderFooter, viewOverride?: HfView) => {
    commitHfAt(
      kind === 'header' ? 0 : lastSectionIdx,
      kind,
      viewOverride ?? (kind === 'header' ? headerAreaView : footerAreaView),
      next,
    )
  }
  /** "Different first page" toggle (ribbon checkbox); page 1's header/footer become the first-page variant, as in Word */
  const toggleTitlePg = (on: boolean) => {
    hfEditorRef.current?.exit()
    setTitlePg(on)
    setTitlePgDirty(true)
    setStatus(on ? t('appTitlePgOn') : t('appTitlePgOff'))
  }
  const [showMarks, setShowMarks] = useState(false)
  const [showRuler, setShowRuler] = useState(false)
  const [leftPane, setLeftPane] = useState<LeftPane>(loadLeftPane)
  const showNav = leftPane === 'nav'
  const setShowNav = useCallback((on: boolean) => setLeftPane(on ? 'nav' : null), [])
  const closeNav = useCallback(() => setLeftPane(null), [])
  // Review → Reviewing Pane: the outermost right-edge panel (Word's vertical pane)
  const [showReviewPane, setShowReviewPane] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('print')
  const [readMode, setReadMode] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  const [splitView, setSplitView] = useState(false)
  const [showPagePreview, setShowPagePreview] = useState(false)
  const [splitHtml, setSplitHtml] = useState('')
  const [showFind, setShowFind] = useState(false)
  const [imageDragOver, setImageDragOver] = useState(false)
  const [findFocusInput, setFindFocusInput] = useState(0)
  const [findFocusReplace, setFindFocusReplace] = useState(0)
  const [findFocusGoTo, setFindFocusGoTo] = useState(0)
  // last pagination pass, read by the Go To tab (page / section / line targets)
  const pageLayoutRef = useRef<PageLayout | null>(null)
  /** live section list of the last pass (header obstacles of the next pass) */
  const lastSecListRef = useRef<SectionInfo[] | null>(null)
  const cutsNow = useCallback(() => pageLayoutRef.current?.cuts, [])
  /** runs the debounced pagination pass now (set by the scheduler effect);
   *  `fresh` runs one even when none is pending */
  const flushPaginationRef = useRef<(fresh?: boolean) => void>(() => {})
  /** the current pass's layout, after any pending pass: readers that need
   *  the document as it stands (TOC numbers, the preview snapshot) */
  const layoutNow = useCallback((fresh = false): PageLayout | null => {
    flushPaginationRef.current(fresh)
    return pageLayoutRef.current
  }, [])
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showAutoCorrect, setShowAutoCorrect] = useState(false)
  const [showPreferences, setShowPreferences] = useState(false)
  const ribbonActionsRef = useRef<{
    stepFontSize?: (dir: 1 | -1) => void
    nudgeFontSize?: (dir: 1 | -1) => void
  }>({})
  // Show Comments (Word's top-right toggle): Contextual cards beside the page or the List panel
  const [showComments, setShowComments] = useState(true)
  const [commentsMode, setCommentsModeState] = useState<CommentsMode>(loadCommentsMode)
  const setCommentsMode = useCallback((mode: CommentsMode) => {
    saveCommentsMode(mode)
    setCommentsModeState(mode)
    setShowComments(true)
  }, [])
  // thread popped up from its anchor icon while Show Comments is off
  const [commentPopup, setCommentPopup] = useState<string | null>(null)
  // Contextual mode opens the panel for a composer or a focus the margin cannot host; it stays until closed
  const [commentPanelOpen, setCommentPanelOpen] = useState(false)
  const [showStylesPane, setShowStylesPane] = useState(false)
  const [commentFocus, setCommentFocus] = useState<{
    id: string
    nonce: number
    reply?: boolean
  } | null>(null)
  /** Style definitions pending write-back (key = styleId), saved via SaveOptions.styleUpserts */
  const [defaultFonts, setDefaultFonts] = useState<DefaultFonts>()
  const fontSettingsVersionRef = useRef(0)
  const fontSettingsPendingRef = useRef<Promise<void> | null>(null)
  const [styleUpserts, setStyleUpserts] = useState<Record<string, StyleUpsert>>({})
  const [comments, setCommentsState] = useState<CommentInfo[]>([])
  // Synchronous mirror of the comments state: an agent turn can run several
  // reply_comment calls with no render in between, and each id allocation
  // must see the previous write (stale reads minted duplicate comment ids).
  const commentsLiveRef = useRef<CommentInfo[]>([])
  const setComments = useCallback((action: SetStateAction<CommentInfo[]>) => {
    commentsLiveRef.current =
      typeof action === 'function' ? action(commentsLiveRef.current) : action
    setCommentsState(commentsLiveRef.current)
  }, [])
  const [commentsDirty, setCommentsDirty] = useState(false)
  const [watermark, setWatermark] = useState<string | null>(null)
  const [watermarkDirty, setWatermarkDirty] = useState(false)
  const [watermarkStyle, setWatermarkStyle] = useState<Omit<WatermarkSpec, 'text'> | null>(null)
  const [watermarkPicture, setWatermarkPicture] = useState<PictureWatermarkSpec | null>(null)
  // the pending picture watermark as the header image it will parse back as,
  // sized against the last section's margin box like the save path
  const pendingWatermarkImage = useMemo(() => {
    if (!watermarkDirty) return null
    if (watermarkPicture) {
      const s = sections[sections.length - 1]?.settings ?? section
      const box = s
        ? {
            widthPt: (s.pageWidth - s.marginLeft - s.marginRight) / 20,
            heightPt: (s.pageHeight - s.marginTop - s.marginBottom) / 20,
          }
        : null
      return pictureWatermarkPreviewImage(watermarkPicture, box)
    }
    if (watermark) return textWatermarkPreviewImage({ text: watermark, ...(watermarkStyle ?? {}) })
    return null
  }, [watermarkDirty, watermarkPicture, watermark, watermarkStyle, sections, section])
  /** Design tab / AI set_watermark: pending stores the save path drains */
  const applyWatermark = useCallback((spec: Watermark | null) => {
    const wm = typeof spec === 'string' ? { text: spec } : spec
    if (wm && 'image' in wm) {
      setWatermark(null)
      setWatermarkStyle(null)
      setWatermarkPicture(wm)
    } else if (wm) {
      const { text, ...style } = wm
      setWatermark(text)
      setWatermarkStyle(Object.keys(style).length > 0 ? style : null)
      setWatermarkPicture(null)
    } else {
      setWatermark(null)
      setWatermarkStyle(null)
      setWatermarkPicture(null)
    }
    setWatermarkDirty(true)
  }, [])
  const [inkAnnotations, setInkAnnotations] = useState<InkAnnotation[]>([])
  const [inksDirty, setInksDirty] = useState(false)
  const [inkTool, setInkTool] = useState<InkTool>('select')
  const [inkPresets, setInkPresetsState] = useState<InkPreset[]>(loadInkPresets)
  const [inkActiveId, setInkActiveId] = useState(() => inkPresets[0].id)
  const setInkPresets = useCallback((next: InkPreset[]) => {
    setInkPresetsState(next)
    saveInkPresets(next)
  }, [])
  const inkActive = inkPresets.find((p) => p.id === inkActiveId) ?? inkPresets[0]
  const [footnotes, setFootnotes] = useState<NoteInfo[]>([])
  /** Footnote ids already shown in canvas page gaps (the end-of-document list skips them to avoid duplication) */
  const [gapNoteIds, setGapNoteIds] = useState<Set<string>>(new Set())
  const [endnotes, setEndnotes] = useState<NoteInfo[]>([])
  /** Endnote-area anchor: measured flow-end Y (layout px from the page-wrap top); null until measured */
  const [endnotesAreaTop, setEndnotesAreaTop] = useState<number | null>(null)
  const [notesDirty, setNotesDirty] = useState(false)
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [sourcesDirty, setSourcesDirty] = useState(false)
  const [zoteroDocumentData, setZoteroDocumentDataState] = useState('')
  const [zoteroDocumentDataDirty, setZoteroDocumentDataDirty] = useState(false)
  const zoteroDocumentDataRef = useRef('')
  const setZoteroDocumentData = useCallback((value: string) => {
    zoteroDocumentDataRef.current = value
    setZoteroDocumentDataState(value)
  }, [])
  const [themeFonts, setThemeFonts] = useState<ThemeFonts | null>(null)
  const [themeFontsDirty, setThemeFontsDirty] = useState(false)
  const [themeColors, setThemeColors] = useState<ThemeColors | null>(null)
  const [themeColorsDirty, setThemeColorsDirty] = useState(false)
  const [commentComposing, setCommentComposing] = useState(false)
  const [trackChanges, setTrackChanges] = useState(false)
  // only the document toggle (ribbon / status bar / shortcut) maps to w:trackRevisions
  const [trackRevisionsDirty, setTrackRevisionsDirty] = useState(false)
  const setTrackChangesByUser = useCallback((on: boolean) => {
    setTrackChanges(on)
    setTrackRevisionsDirty(true)
  }, [])
  const toggleTrackChangesByUser = useCallback(() => {
    setTrackChanges((v) => !v)
    setTrackRevisionsDirty(true)
  }, [])
  const [revisionDisplay, setRevisionDisplay] = useState<RevisionDisplayMode>('all')
  /** the user picked a Markup view this session: opening another document keeps it */
  const revisionDisplayRef = useRef(revisionDisplay)
  revisionDisplayRef.current = revisionDisplay
  const [revisionFilter, setRevisionFilter] = useState<RevisionFilter>(DEFAULT_REVISION_FILTER)
  const revisionFilterRef = useRef(revisionFilter)
  revisionFilterRef.current = revisionFilter
  /** Show Markup → Balloons; an application preference like Word's */
  const [balloonMode, setBalloonMode] = useState<BalloonMode>(loadBalloonMode)
  useEffect(() => {
    localStorage.setItem(BALLOON_MODE_KEY, balloonMode)
  }, [balloonMode])
  /** Track Changes Options (Word's Advanced Options): screen markup styling + recorder switches */
  const [tcOptions, setTcOptions] = useState<TrackChangesOptions>(loadTrackChangesOptions)
  const [showTcOptions, setShowTcOptions] = useState(false)
  const tcOptionsStyle = useMemo(() => trackChangesOptionsCss(tcOptions), [tcOptions])
  // the original view restores old formatting via decorations: sync the mode and trigger one repaint
  const balloonsActive = markupPrintsIn(revisionDisplay, viewMode)
  const commentCardsPossible =
    balloonsActive && balloonMode !== 'inline' && revisionDisplay !== 'simple'
  const commentsUi = commentsView(
    showComments,
    commentsMode,
    commentCardsPossible,
    commentPanelOpen,
  )
  useEffect(() => {
    if (commentComposing) setCommentPanelOpen(true)
  }, [commentComposing])
  useEffect(() => {
    if (commentFocus && !commentCardsPossible) setCommentPanelOpen(true)
  }, [commentFocus, commentCardsPossible])
  useEffect(() => {
    revisionDisplayState.mode = revisionDisplay
    revisionDisplayState.balloons = balloonMode
    revisionDisplayState.balloonsActive = balloonsActive
    if (editor) editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionDisplay, balloonMode, balloonsActive])
  // section breaks on tracked-deleted paragraph marks don't break in Word's
  // markup views (only the Original view restores them)
  const delSectBreaks = useMemo(
    () =>
      revisionDisplay === 'original'
        ? undefined
        : new Set(
            (doc?.parsed.blocks ?? [])
              .filter((b) => b.paraMarkDel && b.docxIndex != null)
              .map((b) => b.docxIndex as number),
          ),
    [doc, revisionDisplay],
  )
  const [protection, setProtection] = useState<DocProtection | null>(null)
  const [protectionDirty, setProtectionDirty] = useState(false)
  const [writeProtection, setWriteProtection] = useState<WriteProtection | null>(null)
  const [writeProtectionDirty, setWriteProtectionDirty] = useState(false)
  const [removePersonalInfo, setRemovePersonalInfo] = useState(false)
  const [removePersonalInfoDirty, setRemovePersonalInfoDirty] = useState(false)
  /** modify password entered (or set by the user this session) — false = write-locked, document read-only */
  const [modifyUnlocked, setModifyUnlocked] = useState(true)
  const [compareResult, setCompareResult] = useState<{
    otherName: string
    entries: CompareEntry[]
  } | null>(null)
  const [autoSave, setAutoSave] = useAutoSavePref(host ? `dyoffice.docs.${host.preferenceScope}.autoSave` : 'aidocs.autoSave', window.desktop)
  // tab closed but this renderer kept alive (shell freeze workaround): go inert
  const [tornDown, setTornDown] = useState(false)
  const [aiPreset, setAiPreset] = useState<{
    text: string
    nonce: number
    autoRun?: boolean
  } | null>(null)
  // selection-scoped AI edit queue (anchors live as editor decorations)
  const [editQueue, setEditQueue] = useState<DocsEditQueueItem[]>([])
  const editQueueRef = useRef(editQueue)
  editQueueRef.current = editQueue
  const queueSeqRef = useRef(0)
  // opening/creating a document drops every anchor with setContent; the queue
  // must not leak the previous file's items (they would sit orphaned at the cap)
  useEffect(() => {
    setEditQueue([])
  }, [aiPanelKey])
  const [docCss, setDocCss] = useState('')
  // Live CJK-ness of the body while editing; overrides docCss's --doc-line-factor
  const [liveDocCjk, setLiveDocCjk] = useState<boolean | null>(null)
  // header/footer push-down re-measures after the doc-scoped <style> elements
  // commit: the DOM probe (hfReservedHeightPx) keys on the mounted CSS content,
  // so a value computed in the render pass that introduced new CSS is replaced
  // by a post-commit measure instead of going stale
  const [hfMeasureEpoch, setHfMeasureEpoch] = useState(0)
  // docCss already carries the parse-time factor: the live override only
  // exists once the body's CJK-ness differs from what parsing saw. Keying the
  // commit event on it (not on liveDocCjk) spares the shrink measurers a
  // second whole-document pass when the first live recompute agrees.
  const parsedDocCjk = useMemo(() => (doc ? docHasCjk(doc.parsed) : false), [doc])
  const liveLineFactor =
    doc && liveDocCjk != null && liveDocCjk !== parsedDocCjk
      ? docLineFactor(doc.parsed, liveDocCjk)
      : null
  useEffect(() => {
    setHfMeasureEpoch((e) => e + 1)
    // measurement views that read computed alignment/spacing re-run once the
    // stylesheet is in the DOM (setContent measured against the previous one)
    document.dispatchEvent(new Event(DOC_CSS_COMMITTED_EVENT))
  }, [docCss, liveLineFactor, themeFonts, themeColors, revisionDisplay])
  const [stats, setStats] = useState<DocStats | null>(null)
  const [showLinkModal, setShowLinkModal] = useState(false)
  const [fieldEdit, setFieldEdit] = useState<FieldRange | null>(null)
  const [showTableModal, setShowTableModal] = useState(false)
  const [showZoomDialog, setShowZoomDialog] = useState(false)
  const [showEquationModal, setShowEquationModal] = useState(false)
  const [eqEditTarget, setEqEditTarget] = useState<{
    pos: number
    latex: string
    kind: 'inline' | 'block'
  } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const ctxSeq = useRef(0)
  useEffect(() => {
    window.desktop.armContextMenu?.()
    return window.desktop.onContextMenuRequest?.((req) => {
      setCtxMenu((prev) =>
        prev && prev.seq === req.seq
          ? {
              ...prev,
              spell: req.misspelledWord
                ? { word: req.misspelledWord, suggestions: req.suggestions }
                : null,
            }
          : prev,
      )
    })
  }, [])
  const [viewImage, setViewImage] = useState<string | null>(null)
  useEffect(() => window.desktop.onViewImage?.((src) => setViewImage(src)), [])
  const saveImageAs = useCallback((src: string) => void window.desktop.saveImageAs(src), [])
  const [showFontDialog, setShowFontDialog] = useState(false)
  const [showParaDialog, setShowParaDialog] = useState(false)
  /** label the reader gives a span they are withholding from the model */
  const [redactTarget, setRedactTarget] = useState<{
    from: number
    to: number
    seed: string
  } | null>(null)
  /** Word's table dialogs, shared by the ribbon, the right-click menu and the Table menu */
  const [tableDialog, setTableDialog] = useState<TableDialogKind | null>(null)
  const [tableGridlines, setTableGridlines] = useState(
    () => localStorage.getItem('aidocs.tableGridlines') === '1',
  )
  const toggleTableGridlines = useCallback(
    () =>
      setTableGridlines((on) => {
        localStorage.setItem('aidocs.tableGridlines', on ? '0' : '1')
        return !on
      }),
    [],
  )
  // section content width the table commands / dialogs fit the grid into (same formula as the ribbon)
  const tableSection = sections[activeSection]?.settings ?? section
  const tableSectionWidthPx = tableSection
    ? Math.max(
        1,
        (tableSection.pageWidth - tableSection.marginLeft - tableSection.marginRight) / 15,
      )
    : 624
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  const dirtyRef = useRef(false)
  // serializes save(): overlapping saves (Cmd+S vs autosave timer vs blur) would
  // otherwise race on the write + reparse + setContent sequence
  const saveInFlightRef = useRef(false)
  // set when a save wrote successfully but the editor changed while it was in
  // flight, so the file on disk is already one step behind. save() still counts
  // as succeeded; callers that must not lose data (the close guard) save again.
  const saveIncompleteRef = useRef(false)

  const editorRef = useRef<Editor | null>(null)
  const zoteroControllerRef = useRef<ZoteroDocumentController | null>(null)
  const editor = useEditor({
    extensions: editorExtensions,
    content: { type: 'doc', content: [{ type: 'docParagraph' }] },
    editorProps: {
      // Word checks spelling as you type by default; user toggle in Review → Spelling.
      // useEditor re-applies these options on every render, so the value must
      // be the effective one or a re-render undoes the large-document override
      attributes: { class: 'doc-page', spellcheck: spellcheckActive ? 'true' : 'false' },
      // Word/web HTML cleanup: strip mso comments and <o:p>, unwrap <li><p>x</p></li>
      // (docListItem is an inline container; block-level p would shatter the list)
      transformPastedHTML: cleanPastedHtml,
      // plain-text paste takes the insertion point's formatting like typing
      // (Word Keep Text Only) — the default parser misses storedMarks (r172)
      clipboardTextParser: (text, $context, _plain, view) => pasteTextSlice(text, $context, view),
      handleDOMEvents: {
        paste: (_view, event) => {
          const html = event.clipboardData?.getData('text/html') ?? ''
          const armed = beginForeignPaste(html)
          stashPastePayload(
            armed
              ? {
                  html,
                  text: event.clipboardData?.getData('text/plain') ?? '',
                  mode: defaultPasteMode(),
                }
              : null,
          )
          return false
        },
      },
      // foreign-HTML paste, by the armed mode: 'source' fills runs that still
      // have no concrete font after the parse (generic-only family chains
      // like `sans-serif`) with the insertion point's font slots (r181);
      // 'merge' formats the whole fragment like typing at the insertion
      // point, keeping emphasis and structure; 'text' passes through — the
      // handlePaste reroute below sends it down the plain-text lane
      transformPasted: (slice, view) => {
        const mode = consumeForeignPaste()
        if (!mode || mode === 'text') return slice
        const schema = view.state.schema
        const markType = schema.marks.docTextStyle
        if (!markType) return slice
        const marks = view.state.storedMarks ?? view.state.selection.$from.marks()
        if (mode === 'merge') {
          return new PmSlice(
            mergeFormattingFragment(
              slice.content,
              schema,
              caretStyleMark(marks, schema),
              caretParaFormat(view.state.selection.$from, schema),
            ),
            slice.openStart,
            slice.openEnd,
          )
        }
        const slots = caretFontSlots(marks, markType)
        if (!slots) return slice
        return new PmSlice(
          fillMissingRunFonts(slice.content, slots, schema),
          slice.openStart,
          slice.openEnd,
        )
      },
      // image files dragged from the OS (or a browser) land as inline pictures
      // at the drop point, like Word; other drops keep the default handling
      handleDrop: (_view, event) => {
        const ed = editorRef.current
        const files = imageFilesFromDataTransfer(event.dataTransfer)
        if (!ed || files.length === 0) return false
        return insertImageFilesAtCoords(ed, files, { left: event.clientX, top: event.clientY })
      },
      // clipboard images (screenshots/copied images): become inline images; mixed content
      // with HTML still uses default parsing (text in the HTML takes priority)
      handlePaste: (view, event) => {
        const data = event.clipboardData
        if (!data) return false
        const html = data.getData('text/html')
        // text-mode foreign paste (default setting or chip choice): the whole
        // payload goes down the plain-text lane, formatting like typing
        if (takeTextReroute()) {
          const plain = data.getData('text/plain') || htmlFallbackText(html)
          if (plain) {
            const slice = pasteTextSlice(plain, view.state.selection.$from, view)
            view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
            return true
          }
        }
        // a lone unformatted spreadsheet cell is a text paste (the r146 unwrap
        // turns it into text) and takes the insertion point's formatting like
        // typing (r172) — the HTML lanes below keep no marks for it and would
        // land it in the theme font (r176: Sheets cell → Docs pasted as Aptos)
        if (html) {
          const cellText = singleCellPasteText(html)
          if (cellText !== null) {
            const slice = pasteTextSlice(cellText, view.state.selection.$from, view)
            view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
            return true
          }
        }
        // web-copied images (r139): "Copy image" in a browser puts a bitmap +
        // an <img src="http..."> HTML fragment + often the URL as text/plain
        // on the clipboard. Detect image-only HTML so the bitmap wins over
        // text parsing, and so a bitmap-less copy can fetch the referenced
        // image instead of pasting nothing (our parse rules are data:-only).
        let htmlImgSrcs: string[] = []
        let htmlHasText = false
        if (html) {
          try {
            const imgDom = new window.DOMParser().parseFromString(html, 'text/html')
            htmlImgSrcs = [...imgDom.querySelectorAll('img')]
              .map((img) => img.getAttribute('src') ?? '')
              .filter(Boolean)
            htmlHasText = (imgDom.body.textContent ?? '').trim().length > 0
          } catch {
            /* unparseable html: treat as not-an-image copy */
          }
        }
        // remote-only: in-app data: copies carry data-image-meta and must keep
        // going through the DocProtected parse rules (size/align/wrap round-trip
        // preserved); only web copies divert to bitmap/fetch handling
        const imageOnlyHtml =
          htmlImgSrcs.length > 0 &&
          !htmlHasText &&
          htmlImgSrcs.every((src) => /^https?:\/\//i.test(src))
        // pasting block HTML onto an empty paragraph: replace wholesale (ProseMirror's default
        // first-block merge would demote headings to body text; Word keeps the source block format on empty paragraphs)
        const { $from, empty: selEmpty } = view.state.selection
        if (
          !imageOnlyHtml &&
          html &&
          selEmpty &&
          $from.parent.isTextblock &&
          $from.parent.content.size === 0 &&
          $from.depth === 1
        ) {
          try {
            const dom = new window.DOMParser().parseFromString(cleanPastedHtml(html), 'text/html')
            const parsed = PmDOMParser.fromSchema(view.state.schema).parse(dom.body)
            if (parsed.content.childCount > 0) {
              // this lane re-parses and dispatches itself, bypassing
              // transformPasted — apply the armed paste mode to foreign
              // fragments here too (r181; the empty paragraph's pilcrow
              // memory lives in storedMarks, caret-marks.ts)
              let content = parsed.content
              if (isForeignPasteHtml(html)) {
                const schema = view.state.schema
                const markType = schema.marks.docTextStyle
                const marks = view.state.storedMarks ?? $from.marks()
                if (lastForeignPasteMode() === 'merge') {
                  content = mergeFormattingFragment(
                    content,
                    schema,
                    caretStyleMark(marks, schema),
                    caretParaFormat($from, schema),
                  )
                } else {
                  const slots = markType ? caretFontSlots(marks, markType) : null
                  if (slots) content = fillMissingRunFonts(content, slots, schema)
                }
              }
              view.dispatch(view.state.tr.replaceWith($from.before(1), $from.after(1), content))
              return true
            }
          } catch {
            /* fall back to default paste on parse failure */
          }
        }
        const imageFile = [...data.items]
          .find((item) => item.type.startsWith('image/'))
          ?.getAsFile()
        const text = data.getData('text/plain')
        // image-only copies keep the bitmap even when text/plain carries the
        // source URL (browser "Copy image" does that) — Word pastes the picture
        if (imageFile && (!text.trim() || imageOnlyHtml)) {
          const reader = new FileReader()
          reader.onload = () => {
            const ed = editorRef.current
            if (ed && typeof reader.result === 'string') {
              void insertImageFromDataUrl(ed, reader.result, 'Image (pasted)')
            }
          }
          reader.readAsDataURL(imageFile)
          return true
        }
        // bitmap-less web image copy: fetch the referenced image(s) through the
        // hardened main-process fetcher (SSRF-guarded, CDN headers) and insert
        if (!imageFile && imageOnlyHtml) {
          void (async () => {
            for (const src of htmlImgSrcs.slice(0, 10)) {
              const ed = editorRef.current
              if (!ed) return
              const fetched = await window.desktop.fetchImage(src)
              if (fetched) {
                await insertImageFromDataUrl(
                  ed,
                  `data:${fetched.mime};base64,${fetched.base64}`,
                  'Image (pasted)',
                )
              }
            }
          })()
          return true
        }
        // text/plain-only Markdown (code blocks, terminals, .md files, LLM
        // output): convert and insert as formatted content instead of literal
        // "## Heading" / "**bold**" characters
        if (!html && text) {
          const markdownHtml = markdownPasteHtml(text)
          if (markdownHtml !== null) {
            try {
              // cleanPastedHtml unwraps <li><p>…</p></li> from loose lists —
              // docListItem only allows inline content and would shatter them.
              const dom = new window.DOMParser().parseFromString(
                cleanPastedHtml(markdownHtml),
                'text/html',
              )
              const parser = PmDOMParser.fromSchema(view.state.schema)
              if (
                selEmpty &&
                $from.parent.isTextblock &&
                $from.parent.content.size === 0 &&
                $from.depth === 1
              ) {
                // same wholesale replace as block HTML onto an empty paragraph
                const parsed = parser.parse(dom.body)
                if (parsed.content.childCount > 0) {
                  view.dispatch(
                    view.state.tr.replaceWith($from.before(1), $from.after(1), parsed.content),
                  )
                  return true
                }
              } else {
                view.dispatch(
                  view.state.tr.replaceSelection(parser.parseSlice(dom.body)).scrollIntoView(),
                )
                return true
              }
            } catch {
              /* fall back to default literal paste on parse failure */
            }
          }
        }
        return false
      },
    },
    onSelectionUpdate: () => forceRender(),
    // typing in the main document takes ribbon routing back from any textbox
    onFocus: () => setActiveSubEditor(null),
    onUpdate: () => {
      host?.onDocumentEdited()
      dirtyRef.current = true
      forceRender()
    },
  })
  useEffect(() => {
    saveTrackChangesOptions(tcOptions)
    trackChangesOptionsState.current = tcOptions
    if (!editor) return
    editor.storage.trackChanges.trackMoves = tcOptions.trackMoves
    editor.storage.trackChanges.trackFormatting = tcOptions.trackFormatting
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tcOptions, editor])

  // every header/footer consumer (strips, gaps, heights, preview, AI, save) reads
  // through one resolver, so pending edits, Link to Previous and inheritance agree
  // the section list as Word sees it right now: a deleted break paragraph merges its
  // section into the next, pending breaks are already in `sections`. Derived from the
  // document itself (not the paint-time measurement), so a strip edit lands in the right
  // slot even before the canvas has re-measured
  const hfSectionsMemoRef = useRef<SectionInfo[] | null>(null)
  const hfSections = useMemo(() => {
    if (!editor || sections.length <= 1) return sections
    const present: Array<{ docxIndex: number }> = []
    editor.state.doc.forEach((node) => {
      const di = node.attrs?.docxIndex
      if (typeof di === 'number') present.push({ docxIndex: di })
    })
    const next = liveSections(sections, present as BlockBox[], undefined, delSectBreaks)
    // every transaction re-runs this memo, and a streaming open appends a
    // chunk per frame: a fresh array per chunk re-ran the pagination effect
    // (a synchronous whole-document pass each) for every chunk. Unchanged
    // content keeps the previous identity.
    const prev = hfSectionsMemoRef.current
    if (prev && sameSectionInfos(prev, next)) return prev
    hfSectionsMemoRef.current = next
    return next
    // docVersion: the doc identity is what changes, and it is not a React value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, sections, delSectBreaks, docVersion])
  const hfState = useMemo<HfSectionState>(
    () => ({
      sections: hfSections,
      edits: sectionHfEdits,
      links: hfLinks,
      docStrips: { header, footer, variants: hfVariants },
      parsed: doc?.parsed ?? null,
    }),
    [hfSections, sectionHfEdits, hfLinks, header, footer, hfVariants, doc],
  )
  const hfResolveAt = useCallback(
    (si: number, kind: 'header' | 'footer', variant: HfView) =>
      resolveHf(hfState, si, kind, variant),
    [hfState],
  )
  const hfValueAt = useCallback(
    (si: number, kind: 'header' | 'footer', variant: HfView) =>
      resolveHf(hfState, si, kind, variant).value,
    [hfState],
  )
  const hfLinkedAt = (si: number, kind: 'header' | 'footer', variant: HfView) =>
    hfLinked(hfState, si, kind, variant)
  const lastSectionIdx = Math.max(0, hfSections.length - 1)
  const shownHeader = hfValueAt(0, 'header', headerAreaView)
  const shownFooter = hfValueAt(lastSectionIdx, 'footer', footerAreaView)
  /** images of the strip an edge area shows (logos etc., display-only; floating shapes render separately) */
  const hfImagesOf = (kind: 'header' | 'footer') =>
    hfResolveAt(
      kind === 'header' ? 0 : lastSectionIdx,
      kind,
      kind === 'header' ? headerAreaView : footerAreaView,
    ).images?.filter((img) => !img.floating)
  /**
   * Write an edit made on section `si`'s strip to the part that owns it. `ownerAtOpen`
   * (the owner when the editor opened) refuses a write whose owner moved to an earlier
   * section meanwhile: Link to Previous under an open editor must not overwrite the
   * strip it reconnects to.
   */
  const commitHfAt = (
    si: number,
    kind: 'header' | 'footer',
    variant: HfView,
    next: HeaderFooter,
    ownerAtOpen?: number,
  ): boolean => {
    const target = hfCommitTarget(hfState, si, kind, variant, ownerAtOpen)
    if (!target) return false
    // functional: two commits in one turn (Remove Page Numbers on both strips, an
    // editor exit racing an AI set) must both land
    setSectionHfEdits((m) => ({ ...m, [target.key]: hfTextCommit(m[target.key], next) }))
    return true
  }
  /** a floating header picture moved or resized on section `si`'s strip
   *  (hf-float-edit); false when the strip has no part to take it */
  const commitHfPictureAt = (
    si: number,
    kind: 'header' | 'footer',
    variant: HfView,
    drawing: number,
    edit: HfPictureEdit,
  ): boolean => {
    if (!hfCommitTarget(hfState, si, kind, variant)) return false
    setSectionHfEdits(
      (m) =>
        withHfPictureEdit({ ...hfState, edits: m }, si, kind, variant, drawing, edit)?.edits ?? m,
    )
    return true
  }
  /** pending changes outside the body, refreshed with the revision badge (see storyRevisions memo) */
  const storyRevisionsRef = useRef<StoryRevision[]>([])
  const hfStateRef = useRef(hfState)
  hfStateRef.current = hfState
  // live mirrors: an AI turn applies several decisions between renders
  const footnotesLiveRef = useRef(footnotes)
  footnotesLiveRef.current = footnotes
  const endnotesLiveRef = useRef(endnotes)
  endnotesLiveRef.current = endnotes
  /** accept / reject changes in notes, header / footer parts and textboxes; the count applied */
  const applyStoryRevisions = (
    targets: StoryRevision[],
    mode: 'accept' | 'reject',
    all = false,
  ): number => {
    const live = storyRevisionsRef.current
    const picked = targets
      .map((t) => liveStoryRevision(live, t))
      .filter((r): r is StoryRevision => !!r)
    if (picked.length === 0 && !all) return 0
    const locs = (kind: StoryRevision['story']['kind']) =>
      picked.filter((r) => r.story.kind === kind).map((r) => r.story)
    const nextNotes = { footnote: footnotesLiveRef.current, endnote: endnotesLiveRef.current }
    for (const kind of ['footnote', 'endnote'] as const) {
      const mine = locs(kind)
      if (mine.length === 0 && !all) continue
      // Accept All also clears what the models do not show (paragraph marks): every entry replays
      nextNotes[kind] = all
        ? resolveNotes(nextNotes[kind], mine, mode, true).map((n) =>
            n.revisionsResolved?.some((r) => !r.filter)
              ? n
              : { ...n, revisionsResolved: [...(n.revisionsResolved ?? []), { mode }] },
          )
        : resolveNotes(nextNotes[kind], mine, mode)
      ;(kind === 'footnote' ? setFootnotes : setEndnotes)(nextNotes[kind])
      ;(kind === 'footnote' ? footnotesLiveRef : endnotesLiveRef).current = nextNotes[kind]
      setNotesDirty(true)
    }
    let state = hfStateRef.current
    const slots = new Map<string, StoryRevision[]>()
    for (const r of picked) {
      if (!r.story.hf) continue
      const key = `${r.story.hf.section}:${r.story.hf.kind}:${r.story.hf.variant}`
      slots.set(key, [...(slots.get(key) ?? []), r])
    }
    const hfTargets = all
      ? ownHfSlots(state).map((slot) => ({
          ...slot,
          revs: slots.get(`${slot.si}:${slot.kind}:${slot.variant}`) ?? [],
        }))
      : [...slots.values()].map((revs) => {
          const { section: si, kind, variant } = revs[0].story.hf!
          return { si, kind, variant, value: ownHf(state, si, kind, variant)?.value, revs }
        })
    for (const slot of hfTargets) {
      const { si, kind, variant, revs } = slot
      let value = slot.value
      if (!value) continue
      let pending = Object.values(state.edits).includes(value)
      // a strip editor open on this part would commit its pre-resolution runs on
      // exit: drain what was typed into the value first, then drop the editor
      const open = hfEditingRef.current
      const handle = hfEditorRef.current
      if (handle && open && open.kind === kind && open.owner === si) {
        const typed = handle.changed()
        handle.discard()
        if (typed) {
          value = typed
          pending = true
        }
      }
      const next = resolveHfValue(
        value,
        revs.map((r) => r.story),
        mode,
        pending,
        all,
      )
      const target = hfCommitTarget(state, si, kind, variant)
      if (!target) continue
      commitHfAt(si, kind, variant, next)
      state = { ...state, edits: { ...state.edits, [target.key]: next } }
      hfStateRef.current = state
    }
    if (editor) {
      const tr = editor.state.tr.setMeta(TRACK_IGNORE, true)
      const byPos = new Map<number, StoryRevision[]>()
      for (const r of picked) {
        if (r.story.textbox)
          byPos.set(r.story.textbox.pos, [...(byPos.get(r.story.textbox.pos) ?? []), r])
      }
      for (const [pos, revs] of byPos) {
        const node = tr.doc.nodeAt(pos)
        const boxes = node?.attrs?.textboxes as TextboxDisplay[] | null | undefined
        if (!node || !boxes) continue
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          textboxes: resolveTextboxes(
            boxes,
            revs.map((r) => r.story),
            mode,
          ),
        })
      }
      if (tr.docChanged) editor.view.dispatch(tr)
      // the list a follow-up in the same turn reads must already show the outcome
      storyRevisionsRef.current = [
        ...collectHfRevisions(state),
        ...collectTextboxRevisions(editor.state.doc),
        ...collectNoteRevisions(editor.state.doc, 'footnote', nextNotes.footnote),
        ...collectNoteRevisions(editor.state.doc, 'endnote', nextNotes.endnote),
      ]
    }
    dirtyRef.current = true
    return picked.length
  }
  const setHfLink = (si: number, kind: 'header' | 'footer', variant: HfView, on: boolean) => {
    if (
      on &&
      !window.confirm(t(kind === 'header' ? 'appHfLinkConfirmHeader' : 'appHfLinkConfirmFooter'))
    )
      return
    // the open editor holds the strip being discarded: it must not commit it anywhere
    if (on) hfEditorRef.current?.discard()
    if (!withHfLink(hfState, si, kind, variant, on)) return
    setSectionHfEdits(
      (m) => withHfLink({ ...hfState, edits: m }, si, kind, variant, on)?.edits ?? m,
    )
    setHfLinks((l) => withHfLink({ ...hfState, links: l }, si, kind, variant, on)?.links ?? l)
  }
  const setHfDistance = (si: number, kind: 'header' | 'footer', twips: number) => {
    // `si` indexes the live list; the saved list (what the save rewrites) is matched by its break paragraph
    const live = hfSections[si]
    const saved = live ? sections.findIndex((s) => s.lastBlockIndex === live.lastBlockIndex) : -1
    const cur = (saved >= 0 ? sections[saved].settings : undefined) ?? section
    if (!cur) return
    const next = { ...cur, [kind === 'header' ? 'headerDist' : 'footerDist']: twips }
    if (saved >= 0) editSectionSettings((_s, i) => (i === saved ? next : null))
    if (sections.length <= 1 || saved < 0 || saved === sections.length - 1) {
      setSection(next)
      setSectionDirty(true)
    } else setSectionsDirty((d) => (d.includes(saved) ? d : [...d, saved]))
  }

  // textbox sub-editors: re-render the ribbon on focus/selection changes and
  // mark the document dirty when their content changes
  useEffect(
    () =>
      subscribeSubEditorState((docChanged) => {
        if (docChanged) dirtyRef.current = true
        forceRender()
      }),
    [],
  )

  useEffect(() => {
    void window.desktop.getRecentFiles().then(setRecent)
    const loadSettings = () => void window.desktop.getAiSettings().then(setSettings)
    if (host?.assistantAvailable !== false) loadSettings()
    return host ? undefined : window.desktop.onAiSettingsChanged?.(loadSettings)
  }, [])

  useEffect(() => {
    rememberAiPanelOpen('aidocs.showAi', showAi)
  }, [showAi])

  useEffect(() => {
    saveLeftPane(leftPane)
  }, [leftPane])

  const spellcheckWasOn = useRef(spellcheckActive)
  const respellKickBusy = useRef(false)
  // bumped by the context menu after Add to Dictionary / a language change:
  // the session checker is updated but existing squiggles only refresh on typing
  const [respellNonce, setRespellNonce] = useState(0)
  const respellNonceSeen = useRef(0)
  // spell-diag trace: squiggle losses in the field are intermittent and
  // platform-bound, so the toggle/kick lifecycle leaves a line in
  // userData/spell-diag.log for support to collect (never breaks the app)
  const spellDiag = (line: string) => {
    try {
      window.desktop.spellDiag?.(line)
    } catch {
      /* diagnostics only */
    }
  }
  useEffect(() => {
    let cancelRespellKick = () => {}
    localStorage.setItem(SPELLCHECK_KEY, spellcheck ? '1' : '0')
    spellDiag(
      `toggle spellcheck=${spellcheckActive} platform=${navigator.platform} composing=${editor.view.composing}`,
    )
    // setOptions (not a direct DOM write): ProseMirror re-applies editorProps
    // attributes on every updateState, so only the props route sticks
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: {
          ...(editor.options.editorProps.attributes as Record<string, string>),
          spellcheck: spellcheckActive ? 'true' : 'false',
        },
      },
    })
    // Blink only respells an editable as a consequence of real (trusted)
    // typing of a word-committing character inside it. A retest ruled
    // everything else out pixel by pixel: attribute flips, focus cycles (the
    // first attempt at this fix), script or execCommand edits, fresh DOM
    // nodes, session spellchecker kicks, synthetic clicks and arrow keys —
    // even a typed zero-width space — existing typos stay unmarked. So on the
    // re-enable transition, have the main process type one trusted space at
    // the caret and remove it again by script (a trusted Backspace would work
    // too, but its deletion re-suppresses the caret paragraph's markers).
    // ProseMirror must not see any of it: its DOM observer is paused (no
    // transaction, no history entry, no dirty flag) and a capture-phase key
    // shield keeps its keymap and other key handlers out of the round trip —
    // the same shield also tells us when the keystroke has actually landed.
    const respellRequested = respellNonce !== respellNonceSeen.current
    if (spellcheckActive && (!spellcheckWasOn.current || respellRequested)) {
      let attempts = 0
      // cancel a pending retry/rAF if the effect re-runs (another off/on) or the
      // component unmounts — two overlapping kick chains would each pause the DOM
      // observer and install the key shield, swallowing keystrokes twice
      let cancelled = false
      let rafId = 0
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      cancelRespellKick = () => {
        cancelled = true
        if (rafId) cancelAnimationFrame(rafId)
        if (retryTimer !== undefined) clearTimeout(retryTimer)
      }
      const runKick = () => {
        if (cancelled) return
        const view = editor.view
        const dom = view.dom
        if (!dom.isConnected) return spellDiag('kick abandoned: editor gone')
        if (!spellcheckActiveRef.current) return spellDiag('kick canceled: toggled off again')
        // a live IME composition (French dead keys, CJK input) or an in-flight
        // kick used to make the re-enable return silently, so existing typos
        // were never re-marked (one "the toggle worked only once" path).
        // Retry for a few seconds instead of dropping the kick.
        if (view.composing || respellKickBusy.current) {
          spellDiag(
            `kick deferred composing=${view.composing} busy=${respellKickBusy.current} attempt=${attempts}`,
          )
          if (attempts++ < 8) retryTimer = setTimeout(runKick, 600)
          else spellDiag('kick gave up after retries')
          return
        }
        respellKickBusy.current = true
        spellDiag('kick start')
        const sub = getActiveSubEditor()
        const prev = document.activeElement as HTMLElement | null
        // the caret can sit pages away from the viewport (last edit position);
        // focusing and typing there scrolls it into view and the toggle
        // "jumps to another page". Pin the scroller
        // for the whole round trip: the reset runs inside the scroll event,
        // before paint, so no jump ever shows.
        const scroller = scrollContainerRef.current
        const pinTop = scroller?.scrollTop ?? 0
        const pinLeft = scroller?.scrollLeft ?? 0
        const pinScroll = () => {
          if (!scroller) return
          if (scroller.scrollTop !== pinTop) scroller.scrollTop = pinTop
          if (scroller.scrollLeft !== pinLeft) scroller.scrollLeft = pinLeft
        }
        scroller?.addEventListener('scroll', pinScroll, true)
        view.focus() // puts the DOM caret where the state says it is
        const sel = window.getSelection()
        // typing over a range would replace it — kick from a caret instead;
        // view.focus() below restores the real selection from PM state after
        if (sel && !sel.isCollapsed) sel.collapseToEnd()
        // the kick inserts exactly one space at the caret; snapshot the caret
        // text node so the scrub can restore it byte-identically
        const caretNode = sel?.anchorNode
        const caretText = caretNode instanceof Text ? caretNode : null
        const caretData = caretText?.data ?? null
        let sawKick = false
        let kickDown = false
        let kickPress = false
        // shield: PM's keymap must not see the kick, and the user's own keys
        // must not mutate the DOM while the observer is paused (the dwell
        // below makes that window user-noticeable on Windows) — swallow them.
        // Exactly one space keydown and the keypress it produce…109298 tokens truncated…t: 45_000 })
  await editor.click(); await f.page.keyboard.press('Control+End'); await f.page.keyboard.type('Lost response native draft')
  const commits = []; let drop = true
  await f.page.route('**/commits',async route => {
    commits.push(route.request().postDataJSON())
    if (!drop) return route.continue()
    drop = false
    await route.fetch(); await route.abort('failed')
  })
  await f.page.keyboard.press('Control+s')
  await expect(f.page.getByRole('button',{ name: 'Confirm save outcome' })).toBeVisible({ timeout: 15_000 })
  await expect(editor).toContainText('Lost response native draft')
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  assert.notEqual(current.file.revision,f.opened.file.revision)
  await f.page.getByRole('button',{ name: 'Confirm save outcome' }).click()
  await expect(f.page.getByRole('button',{ name: 'Confirm save outcome' })).toHaveCount(0)
  assert.deepEqual(commits[1],commits[0])
  assert.equal((await f.files.openFile(f.alice.token,f.opened.file.fileId)).file.revision,current.file.revision)
})

test('actual server entry enables only the explicit native build and refuses missing File API or an unknown mode', { timeout: 30_000 },async t => {
  const { spawn,execFile } = await import('node:child_process')
  const { once } = await import('node:events'), { promisify } = await import('node:util')
  const f = await fileFixture(t), opened = await importFile(f,f.alice.token,await docxBytes())
  const cwd = fileURLToPath(new URL('../../',import.meta.url))
  const env = { ...process.env,NODE_ENV: 'development',DYOFFICE_AUTH_MODE: 'local',DYOFFICE_DATABASE_URL: '',DYOFFICE_AUTH_DATABASE_URL: f.urls.auth,DYOFFICE_BUSINESS_DATABASE_URL: f.urls.business,DYOFFICE_DEPLOYMENT_ID: f.deploymentId,DYOFFICE_ORIGIN: 'https://office.example',DYOFFICE_CSRF_KEY: f.csrfKey,DYOFFICE_USER_TOKEN: '',DYOFFICE_ADMIN_TOKEN: '',DYOFFICE_FILE_API: 'experimental',DYOFFICE_OBJECT_STORE: 'local-dev',DYOFFICE_OBJECT_DIRECTORY: f.directory,DYOFFICE_NATIVE_DOCX: 'experimental',DYOFFICE_NATIVE_DOCX_DIRECTORY: '',PORT: '0',HOST: '127.0.0.1' }
  const child = spawn(process.execPath,['--import','tsx','server/index.mjs'],{ cwd,env,stdio: ['ignore','pipe','pipe'] })
  f.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child,'exit') } })
  const exited = once(child,'exit')
  const [output] = await Promise.race([once(child.stdout,'data'),exited.then(() => { throw new Error('Native entry exited before startup') })])
  const address = String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  assert.ok(address)
  const path = address + '/native-docx/?fileId=' + opened.file.fileId, headers = { cookie: '__Host-dyoffice-session=' + f.alice.token }
  assert.equal((await fetch(path)).status,401)
  assert.equal((await fetch(path,{ headers })).status,200)
  assert.equal((await (await fetch(address + '/api/v1/capabilities',{ headers })).json()).docx,'editable')
  child.kill('SIGTERM'); assert.deepEqual(await exited,[0,null])
  for (const invalid of [{ DYOFFICE_NATIVE_DOCX: 'enabled' },{ DYOFFICE_FILE_API: '',DYOFFICE_OBJECT_STORE: '' }]) {
    await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx','server/index.mjs'],{ cwd,env: { ...env,...invalid },timeout: 5000 }),error => {
      assert.equal(error.code,1)
      assert.equal(error.stderr.includes(f.urls.auth),false)
      return true
    })
  }
})

test('page-color edits during a delayed native commit remain dirty and persist on the next save', { timeout: 120_000 },async t => {
  const f = await fixture(t)
  await f.page.goto(f.origin + '/native-docx/?fileId=' + f.opened.file.fileId)
  await f.page.locator('.tiptap.doc-page[contenteditable="true"]').waitFor({ timeout: 45_000 })
  let reached, release, first = true
  const started = new Promise(resolve => { reached = resolve }), gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  await f.page.route('**/commits',async route => {
    if (!first) return route.continue()
    first = false
    const response = await route.fetch()
    reached(); await gate; await route.fulfill({ response })
  })
  await f.page.keyboard.press('Control+s'); await started
  await f.page.getByRole('button',{ name: 'Design',exact: true }).click()
  await f.page.getByRole('button',{ name: 'Page Color',exact: true }).click()
  await f.page.getByRole('gridcell',{ name: 'Red',exact: true }).click()
  release()
  await expect(f.page.locator('.dyoffice-docs-state')).toHaveText('Download saved version')
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg','#FF0000')
  const next = f.page.waitForResponse(reply => reply.url().endsWith('/commits') && reply.status() === 200)
  await f.page.keyboard.press('Control+s'); await next
  await expect(f.page.locator('.dyoffice-docs-state')).toHaveText('EditingDownload saved version')
  const current = await f.files.openFile(f.alice.token,f.opened.file.fileId)
  const zip = await JSZip.loadAsync(await f.files.readFile(f.alice.token,current.file.fileId,current.file.revision))
  assert.match(await zip.file('word/document.xml').async('string'),/w:background[^>]*w:color="FF0000"/)
  await f.page.reload()
  await expect(f.page.locator('.doc-zoom').first()).toHaveCSS('--page-bg','#FF0000',{ timeout: 45_000 })
})
