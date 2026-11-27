/**
 * Effective print settings for the PDF export: the session's Page Layout
 * journal overlaid on the workbook's saved page setup (worksheet pageSetup /
 * pageMargins / printOptions / headerFooter plus the workbook-level
 * _xlnm.Print_Area / _xlnm.Print_Titles defined names).
 */
import { columnLabel, parseRange } from '@genoffice/xlsx-gateway/domain/cell-address'
import {
  encodeHeaderFooterSections, formatPrintTitleSpan, readPrintTitleSpans, type PrintTitleSpan,
} from '@genoffice/xlsx-gateway/gateway/xlsx-page-setup'
import { MAX_GRID_COLUMNS, MAX_GRID_ROWS } from '@genoffice/xlsx-gateway/shared/grid-bounds'
import type { WorkbookPagePrintSettings } from '../shared/desktop-api'
import { shiftPrintTitleSpan, type HeaderFooterParts, type PageSetupJournalState, type StructuralJournalOp } from './edit-journal'
import { matchHeaderFooterFormat } from './print-hf-codes'
import { fileRangeToScreenRange } from './view-transform'

export interface PrintMargins {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly header: number
  readonly footer: number
}

/// A page's printed header and footer (either half may be blank).
export interface HeaderFooterPair {
  readonly header: HeaderFooterParts | null
  readonly footer: HeaderFooterParts | null
}

/// One `&G` picture slot the file declares (legacyDrawingHF); the bytes are
/// fetched through readWorkbookMedia at export time.
export type HeaderFooterPictureSlot = NonNullable<
  WorkbookPagePrintSettings['headerFooterPictures']
>[number]

/// Concrete values the print layout consumes; every field resolved.
export interface EffectivePageSetup {
  readonly orientation: 'portrait' | 'landscape'
  readonly pageOrder: NonNullable<WorkbookPagePrintSettings['pageOrder']>
  /// OOXML paper-size code.
  readonly paperSize: number
  /// Percent; applies only when fitToPage is off.
  readonly scale: number
  /// Pages across / tall; 0 = automatic on that axis. Apply only when
  /// fitToPage is on.
  readonly fitToWidth: number
  readonly fitToHeight: number
  readonly fitToPage: boolean
  /// Inches.
  readonly margins: PrintMargins
  readonly printGridlines: boolean
  readonly printHeadings: boolean
  readonly blackAndWhite: boolean
  readonly draft: boolean
  readonly horizontalCentered: boolean
  readonly verticalCentered: boolean
  /// Starting page number saved in the file, or undefined for automatic numbering.
  readonly firstPageNumber?: number | undefined
  /// Plain A1 ranges to print ([] = the used range).
  readonly printAreas: readonly string[]
  /// Rows repeated at the top of every page ("1:2"), or null.
  readonly printTitles: string | null
  /// Columns repeated at the left of every page ("A:B"), or null; file-only
  /// (the session edits title rows).
  readonly printTitleColumns: string | null
  /// The odd-page (default) header/footer.
  readonly header: HeaderFooterParts | null
  readonly footer: HeaderFooterParts | null
  /// differentFirst: the sheet's first page header/footer, or null when it uses the default.
  readonly firstPage: HeaderFooterPair | null
  /// differentOddEven: even pages' header/footer, or null when off.
  readonly evenPages: HeaderFooterPair | null
  /// scaleWithDoc (Excel's default): header/footer text and pictures follow
  /// the print scale like the sheet does.
  readonly headerFooterScaleWithDoc: boolean
  readonly headerFooterPictures: readonly HeaderFooterPictureSlot[]
}

/// Inches, mirroring the gateway's margin presets.
const MARGIN_PRESETS: Record<'normal' | 'wide' | 'narrow', PrintMargins> = {
  normal: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
  wide: { left: 1, right: 1, top: 1, bottom: 1, header: 0.5, footer: 0.5 },
  narrow: { left: 0.25, right: 0.25, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
}

/// The export wire caps margins at 3in per side.
const MAX_MARGIN_INCHES = 3

export interface FilePrintNames {
  readonly printArea?: string | undefined
  readonly printTitles?: string | undefined
}

/// File-space A1 areas → this session's screen space (envelope semantics,
/// like streamed merges). Fully deleted areas drop out; when nothing
/// survives the caller falls back to the used range.
function mapAreasToScreen(areas: readonly string[], ops: readonly StructuralJournalOp[]): string[] {
  if (ops.length === 0) return [...areas]
  const mapped: string[] = []
  for (const area of areas) {
    let bounds
    try {
      bounds = parseRange(area)
    } catch {
      continue
    }
    const screen = fileRangeToScreenRange(ops, bounds)
    if (screen === null) continue
    mapped.push(
      `${columnLabel(screen.startColumn)}${screen.startRow + 1}` +
        `:${columnLabel(screen.endColumn)}${screen.endRow + 1}`,
    )
  }
  return mapped
}

export function resolveEffectivePageSetup(
  journal: PageSetupJournalState,
  file: WorkbookPagePrintSettings | null,
  names: FilePrintNames | null,
  /// This session's structural edits: file-sourced print names live in
  /// original workbook coordinates and must shift into screen space
  /// (journal-sourced values are already screen space).
  ops: readonly StructuralJournalOp[] = [],
): EffectivePageSetup {
  const clampMargin = (value: number): number => Math.min(Math.max(value, 0), MAX_MARGIN_INCHES)
  const fileMargins = file?.margins
  const margins =
    journal.margins !== undefined
      ? MARGIN_PRESETS[journal.margins]
      : fileMargins !== undefined
        ? {
            left: clampMargin(fileMargins.left),
            right: clampMargin(fileMargins.right),
            top: clampMargin(fileMargins.top),
            bottom: clampMargin(fileMargins.bottom),
            header: clampMargin(fileMargins.header),
            footer: clampMargin(fileMargins.footer),
          }
        : MARGIN_PRESETS.normal
  const fitToPage = journal.fitToPage ?? file?.fitToPage ?? false
  // OOXML default when fitToPage is on and fitToWidth/fitToHeight are
  // absent is 1 page on that axis.
  const fitToWidth = journal.fitToWidth ?? file?.fitToWidth ?? (file?.fitToPage === true ? 1 : 0)
  const fitToHeight = journal.fitToHeight ?? file?.fitToHeight ?? (file?.fitToPage === true ? 1 : 0)
  const printArea =
    journal.printArea !== undefined
      ? journal.printArea === null
        ? []
        : [journal.printArea]
      : mapAreasToScreen(printAreasFromFormula(names?.printArea), ops)
  const printTitles =
    journal.printTitles !== undefined
      ? printTitleRowsFromFormula(journal.printTitles ?? undefined)
      : journal.clearPrintTitleRows
        ? null
        : printTitleRowsFromFormula(names?.printTitles, ops)
  // Use the same encoding for pending edits as on save.
  const decodeOptional = (encoded: string | undefined): HeaderFooterParts | null =>
    encoded === undefined ? null : decodeHeaderFooter(encoded, true)
  const header =
    journal.header === undefined
      ? decodeOptional(file?.oddHeader)
      : journal.header && decodeHeaderFooter(encodeHeaderFooterSections(journal.header), true)
  const footer =
    journal.footer === undefined
      ? decodeOptional(file?.oddFooter)
      : journal.footer && decodeHeaderFooter(encodeHeaderFooterSections(journal.footer), true)
  // The session edits the odd header/footer only.
  const firstPage =
    file?.differentFirst === true
      ? { header: decodeOptional(file.firstHeader), footer: decodeOptional(file.firstFooter) }
      : null
  const evenPages =
    file?.differentOddEven === true
      ? { header: decodeOptional(file.evenHeader), footer: decodeOptional(file.evenFooter) }
      : null
  return {
    orientation: journal.orientation ?? file?.orientation ?? 'portrait',
    pageOrder: file?.pageOrder ?? 'downThenOver',
    paperSize: journal.paperSize ?? file?.paperSize ?? 9,
    scale: journal.scale ?? file?.scale ?? 100,
    fitToWidth,
    fitToHeight,
    fitToPage,
    margins,
    printGridlines: journal.printGridlines ?? file?.printGridlines ?? false,
    printHeadings: journal.printHeadings ?? file?.printHeadings ?? false,
    blackAndWhite: file?.blackAndWhite ?? false,
    draft: file?.draft ?? false,
    horizontalCentered: file?.horizontalCentered ?? false,
    verticalCentered: file?.verticalCentered ?? false,
    firstPageNumber: file?.firstPageNumber,
    printAreas: printArea,
    printTitles,
    printTitleColumns:
      journal.printTitles === null || journal.clearPrintTitleColumns
        ? null
        : printTitleColumnsFromFormula(names?.printTitles, ops),
    header,
    footer,
    firstPage,
    evenPages,
    headerFooterScaleWithDoc: file?.headerFooterFixedSize !== true,
    headerFooterPictures: file?.headerFooterPictures ?? [],
  }
}

/// Splits a defined-name formula on commas outside quoted sheet names.
function splitAreas(formula: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (const character of formula) {
    if (character === "'") quoted = !quoted
    if (character === ',' && !quoted) {
      parts.push(current)
      current = ''
    } else {
      current += character
    }
  }
  parts.push(current)
  return parts
}

/// Strips the (optional) sheet qualifier and `$` anchors of one reference.
function plainReference(part: string): string {
  return part
    .slice(part.lastIndexOf('!') + 1)
    .replace(/\$/g, '')
    .trim()
}

/// `'S 1'!$A$1:$K$84,'S 1'!$M$1:$N$9` → ['A1:K84', 'M1:N9']. Stale `#REF!`
/// parts are skipped (Excel prints the rest); a part the print layout cannot
/// crop to (full-column spans, 3-D refs) yields [] so the export falls back
/// to the used range instead of dropping the columns Excel would print.
export function printAreasFromFormula(formula: string | undefined): string[] {
  if (formula === undefined || formula === '') return []
  const areas: string[] = []
  for (const part of splitAreas(formula)) {
    if (/#REF!/i.test(part.replace(/'(?:[^']|'')*'/g, ''))) continue
    const reference = plainReference(part).toUpperCase()
    if (!/^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/.test(reference)) return []
    const bounds = parseRange(reference)
    if (bounds.endRow >= MAX_GRID_ROWS || bounds.endColumn >= MAX_GRID_COLUMNS) return []
    areas.push(
      `${columnLabel(bounds.startColumn)}${bounds.startRow + 1}:` +
        `${columnLabel(bounds.endColumn)}${bounds.endRow + 1}`,
    )
  }
  return areas
}

function printTitleFromFormula(
  formula: string | undefined,
  axis: PrintTitleSpan['axis'],
  ops: readonly StructuralJournalOp[],
): string | null {
  for (const span of readPrintTitleSpans(formula)) {
    if (span.axis !== axis) continue
    const shifted = shiftPrintTitleSpan(span, ops)
    if (shifted && shifted.end - shifted.start <= 20) return formatPrintTitleSpan(shifted)
  }
  return null
}

/// `'S'!$1:$2` → '1:2', within the print layout's 21-row cap.
export function printTitleRowsFromFormula(
  formula: string | undefined,
  ops: readonly StructuralJournalOp[] = [],
): string | null {
  return printTitleFromFormula(formula, 'row', ops)
}

/// `'S'!$A:$B,'S'!$1:$2` → 'A:B', within the print layout's 21-column cap.
export function printTitleColumnsFromFormula(
  formula: string | undefined,
  ops: readonly StructuralJournalOp[] = [],
): string | null {
  return printTitleFromFormula(formula, 'column', ops)
}

/// Print-title rows repeat atop every page: the layout caps the span at 21 rows.
export const MAX_PRINT_TITLE_ROWS = 21

/**
 * Clamp a 1-based title-row span to the layout cap, anchoring at the start
 * so a tall selection still repeats its top rows instead of being dropped
 * downstream as an over-cap span.
 */
export function clampTitleRows(start: number, end: number): string {
  const safeStart = Number.isFinite(start) ? Math.max(1, Math.floor(start)) : 1
  const safeEnd = Number.isFinite(end) ? Math.floor(end) : safeStart
  return `${safeStart}:${Math.min(Math.max(safeEnd, safeStart), safeStart + MAX_PRINT_TITLE_ROWS - 1)}`
}

/// Excel's encoded header/footer → left/center/right parts. Unmarked text
/// goes in the center. Editing and printing both keep the original codes.
export function decodeHeaderFooter(
  encoded: string,
  preserveFormatting = false,
): HeaderFooterParts | null {
  const sections = { L: '', C: '', R: '' }
  let current: 'L' | 'C' | 'R' = 'C'
  let index = 0
  while (index < encoded.length) {
    const character = encoded[index] ?? ''
    if (character !== '&') {
      sections[current] += character
      index += 1
      continue
    }
    const next = encoded[index + 1]
    if (next === undefined) {
      if (preserveFormatting) sections[current] += '&'
      break
    }
    if (next === '&') {
      sections[current] += '&&'
      index += 2
      continue
    }
    const format = matchHeaderFooterFormat(encoded, index)
    if (format !== null) {
      if (preserveFormatting) sections[current] += format[0]
      index += format[0].length
      continue
    }
    const code = next.toUpperCase()
    if (code === 'L' || code === 'C' || code === 'R') {
      current = code
      index += 2
      continue
    }
    if (preserveFormatting || code !== 'Z') {
      sections[current] += preserveFormatting ? encoded.slice(index, index + 2) : `&${code}`
    }
    index += 2
  }
  if (sections.L === '' && sections.C === '' && sections.R === '') return null
  return {
    ...(sections.L === '' ? {} : { left: sections.L }),
    ...(sections.C === '' ? {} : { center: sections.C }),
    ...(sections.R === '' ? {} : { right: sections.R }),
  }
}
