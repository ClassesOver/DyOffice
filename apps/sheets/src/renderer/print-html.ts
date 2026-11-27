/// Lays a sheet out as printed pages from the live Univer model — display
/// strings (number formats applied), cell styles, merges, and the sheet's
/// effective page setup (print areas, repeated titles, manual breaks,
/// gridlines, headings, header/footer). Every page is an explicitly sized
/// paper box with its header/footer inside, so the same HTML serves the
/// preview, the system print and the PDF export, and a job may carry
/// several sheets with different paper or orientation.

import { BorderStyleTypes } from '@univerjs/core'
import { htmlLang, type Lang } from '@genoffice/i18n'
import { columnIndex, columnLabel } from '@genoffice/xlsx-gateway/domain/cell-address'
import { parsePrintTitleSpan } from '@genoffice/xlsx-gateway/gateway/xlsx-page-setup'
import { MAX_GRID_COLUMNS } from '@genoffice/xlsx-gateway/shared/grid-bounds'

import type { WorkbookExportPdfRequest } from '../shared/desktop-api'
import type { HeaderFooterParts } from './edit-journal'
import { expandHeaderFooterCodes, headerFooterRuns, type HeaderFooterTheme } from './print-hf-codes'
import {
  bodyColumns,
  bodyRows,
  planPrintPages,
  type IndexSpan,
  type PaginationInput,
  type PrintArea,
  type PrintPage,
} from './print-paginate'
import {
  fitToPageScale,
  MAX_PRINT_SCALE,
  MIN_PRINT_SCALE,
  type PrintAreaHeights,
} from './print-scale'
import type { EffectivePageSetup, HeaderFooterPair, PrintMargins } from './print-settings'
import type { PrintVisual, PrintVisualSnapshot } from './print-visuals'
import { getLang, t } from './i18n/locale'

export class PrintError extends Error {}

/// A `&G` picture resolved to bytes for the print pages.
export interface HeaderFooterPictureImage {
  readonly dataUrl: string
  readonly widthPt: number
  readonly heightPt: number
}

/// Pictures keyed by VML slot: L/C/R × H/F plus an EVEN or FIRST suffix for
/// the page variants (`LH`, `CFFIRST`, `RHEVEN`).
export type HeaderFooterPictures = ReadonlyMap<string, HeaderFooterPictureImage>

/// Pictures for the three sections of one header or footer.
export interface SectionPictures {
  readonly left?: HeaderFooterPictureImage | undefined
  readonly center?: HeaderFooterPictureImage | undefined
  readonly right?: HeaderFooterPictureImage | undefined
}

type PageVariant = 'odd' | 'even' | 'first'

/// Excel prints gridlines as hairlines.
const GRIDLINE_PT = 0.75
/// The row/column heading strip (8.5pt text, padding, border).
const HEADING_ROW_HEIGHT_PT = 14
const HEADING_COLUMN_WIDTH_PT = 24
/// Header/footer text size before scaleWithDoc applies.
const HEADER_FOOTER_FONT_SIZE_PT = 9

/** UI-language CJK fallback for the print stack (mirrors the :lang() variables in styles.css) */
function printCjkFonts(lang: Lang): string {
  switch (lang) {
    case 'ja':
      return "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo'"
    case 'ko':
      return "'Apple SD Gothic Neo', 'Malgun Gothic'"
    case 'zh-TW':
      return "'PingFang TC', 'Microsoft JhengHei'"
    default:
      return "'PingFang SC'"
  }
}

const MAX_PRINT_CELLS = 50_000

/**
 * Univer dimension boundary: a corrupt workbook can report NaN/negative
 * widths/heights, which previously flowed into colgroup styles, left/top
 * accumulators, and scale math as NaNpt. Clamp to a finite positive value.
 */
function finitePt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.min(value, 100000)
}

/// The slice of the Univer facade the layout needs (structural, so the
/// caller passes the FWorksheet through a cast).
export interface PrintWorksheet {
  getLastRow(): number
  getLastColumn(): number
  getMaxRows?(): number
  getMaxColumns?(): number
  getRowHeight(row: number): number
  getColumnWidth(column: number): number
  /// Hidden rows/columns do not print (Excel); absent in older fakes.
  getSheet?(): { getRowVisible(row: number): boolean; getColVisible(column: number): boolean }
  getMergedRanges(): {
    getRow(): number
    getColumn(): number
    getWidth(): number
    getHeight(): number
  }[]
  getRange(
    row: number,
    column: number,
    numRows: number,
    numColumns: number,
  ): {
    getDisplayValues(): string[][]
    getValues(): unknown[][]
  }
  getRange(row: number, column: number): { getCellStyleData(): PrintCellStyle | null }
}

/// The IStyleData fields the layout reads (all optional in Univer).
interface PrintCellStyle {
  readonly bl?: number
  readonly it?: number
  readonly ul?: { s?: number } | null
  readonly st?: { s?: number } | null
  readonly fs?: number
  readonly ff?: string | null
  readonly cl?: { rgb?: string | null } | null
  readonly bg?: { rgb?: string | null } | null
  readonly ht?: number
  readonly vt?: number
  readonly tb?: number
  readonly bd?: Partial<
    Record<'t' | 'b' | 'l' | 'r' | 'tl_br' | 'bl_tr', { s?: number; cl?: { rgb?: string | null } | null } | null>
  > | null
}

/// A NONE edge is the row/column-default blocker (NO_BORDER_STYLE), not a line.
function borderEdge(
  style: PrintCellStyle | null | undefined,
  key: keyof NonNullable<PrintCellStyle['bd']>,
): NonNullable<NonNullable<PrintCellStyle['bd']>['t']> | undefined {
  const edge = style?.bd?.[key]
  return edge == null || edge.s === BorderStyleTypes.NONE ? undefined : edge
}

/// Thin, medium and thick lines use the same 1:2:3 pixel weights as the grid.
export function printBorderWidthPt(style: number | undefined): number {
  switch (style) {
    case BorderStyleTypes.MEDIUM:
    case BorderStyleTypes.MEDIUM_DASHED:
    case BorderStyleTypes.MEDIUM_DASH_DOT:
    case BorderStyleTypes.MEDIUM_DASH_DOT_DOT:
      return 1.5
    case BorderStyleTypes.THICK:
    case BorderStyleTypes.DOUBLE:
      return 2.25
    default:
      return 0.75
  }
}

const BORDER_DASH_PX: Partial<Record<number, readonly number[]>> = {
  [BorderStyleTypes.HAIR]: [1, 1],
  [BorderStyleTypes.DOTTED]: [2, 2],
  [BorderStyleTypes.DASHED]: [3, 3],
  [BorderStyleTypes.MEDIUM_DASHED]: [3, 3],
  [BorderStyleTypes.DASH_DOT]: [5, 2, 2, 2],
  [BorderStyleTypes.MEDIUM_DASH_DOT]: [5, 2, 2, 2],
  [BorderStyleTypes.SLANT_DASH_DOT]: [5, 2, 2, 2],
  [BorderStyleTypes.DASH_DOT_DOT]: [5, 2, 2, 2, 2, 2],
  [BorderStyleTypes.MEDIUM_DASH_DOT_DOT]: [5, 2, 2, 2, 2, 2],
}

function borderBackground(
  style: number | undefined,
  widthPt: number,
  color: string,
  side: 'top' | 'bottom' | 'left' | 'right',
): string | undefined {
  const horizontal = side === 'top' || side === 'bottom'
  let gradient: string
  if (style === BorderStyleTypes.DOUBLE) {
    const direction = horizontal ? 'bottom' : 'right'
    gradient = `linear-gradient(to ${direction},${color} 0 0.75pt,transparent 0.75pt 1.5pt,${color} 1.5pt 100%)`
  } else {
    const dash = style === undefined ? undefined : BORDER_DASH_PX[style]
    if (!dash) return undefined
    let positionPt = 0
    const stops = dash.map((lengthPx, index) => {
      const startPt = positionPt
      positionPt += lengthPx * 0.75
      return `${index % 2 === 0 ? color : 'transparent'} ${startPt}pt ${positionPt}pt`
    })
    const direction = horizontal ? 'right' : 'bottom'
    gradient = `repeating-linear-gradient(to ${direction},${stops.join(',')})`
  }
  const size = horizontal ? `100% ${widthPt}pt` : `${widthPt}pt 100%`
  return `${gradient} ${side} / ${size} no-repeat`
}

/// OOXML paper-size code → Electron pageSize (custom sizes in inches).
/// ECMA-376 §18.3.1.70: unmapped codes previously fell back to A4 and
/// mis-scaled B4/B5/Folio/Statement output.
const PAPER_SIZES: Record<number, WorkbookExportPdfRequest['pageSize']> = {
  1: 'Letter',
  2: 'Letter',
  3: 'Tabloid',
  4: { width: 17, height: 11 },
  5: 'Legal',
  6: { width: 5.5, height: 8.5 },
  7: { width: 7.25, height: 10.5 },
  8: 'A3',
  9: 'A4',
  10: 'A4',
  11: 'A5',
  12: { width: 9.84, height: 13.9 },
  13: { width: 7.17, height: 10.12 },
  14: { width: 8.5, height: 13 },
  15: { width: 8.46, height: 10.83 },
  16: { width: 10, height: 14 },
  18: 'Letter',
}

const NAMED_PAPER_INCHES: Record<string, readonly [number, number]> = {
  Letter: [8.5, 11],
  Tabloid: [11, 17],
  Legal: [8.5, 14],
  A3: [11.69, 16.54],
  A4: [8.27, 11.69],
  A5: [5.83, 8.27],
}

export interface PaperGeometry {
  readonly pageSize: WorkbookExportPdfRequest['pageSize']
  readonly landscape: boolean
  /// Oriented paper size.
  readonly widthIn: number
  readonly heightIn: number
}

export function paperGeometry(
  paperSize: number,
  orientation: 'portrait' | 'landscape',
): PaperGeometry {
  const pageSize = PAPER_SIZES[paperSize] ?? 'A4'
  const [portraitWidth, portraitHeight] =
    typeof pageSize === 'string'
      ? (NAMED_PAPER_INCHES[pageSize] ?? NAMED_PAPER_INCHES.A4 ?? [8.27, 11.69])
      : [pageSize.width, pageSize.height]
  const landscape = orientation === 'landscape'
  return {
    pageSize,
    landscape,
    widthIn: landscape ? portraitHeight : portraitWidth,
    heightIn: landscape ? portraitWidth : portraitHeight,
  }
}

export interface SheetPrintOptions {
  readonly chartSheet?: boolean
  readonly rightToLeft?: boolean
  /// Manual page breaks (0-based index of the row/column that starts a page).
  readonly breaks?: { rowBreaks: readonly number[]; colBreaks: readonly number[] } | null
  /// Print this A1 range instead of the sheet's print area (Excel's "Print Selection").
  readonly selection?: string | null
  readonly now?: Date
  readonly headerFooterTheme?: HeaderFooterTheme
}

/// One laid-out page before the job-wide numbering is known.
export interface SheetPrintPageRecord {
  readonly body: string
  readonly page: PrintPage
  readonly offsetLeftIn: number
  readonly offsetTopIn: number
}

/// The sheet's header/footer texts by page variant (null variant = off).
export interface SheetHeaderFooter {
  readonly odd: HeaderFooterPair
  readonly first: HeaderFooterPair | null
  readonly even: HeaderFooterPair | null
}

export interface SheetPrintDocument {
  readonly sheetName: string
  readonly fileName: string
  readonly paper: PaperGeometry
  readonly margins: PrintMargins
  readonly blackAndWhite: boolean
  /// Content scale actually applied (fit-to-page resolved).
  readonly scale: number
  readonly headerFooterScale: number
  readonly headerFooterTheme?: HeaderFooterTheme | undefined
  readonly firstPageNumber?: number | undefined
  readonly pictures: HeaderFooterPictures
  readonly headerFooter: SheetHeaderFooter
  readonly css: string
  readonly pages: readonly SheetPrintPageRecord[]
  readonly now: Date
}

export function layoutSheetPrint(
  worksheet: PrintWorksheet,
  setup: EffectivePageSetup,
  fileName: string,
  sheetName: string,
  pictures: HeaderFooterPictures = new Map(),
  visuals: PrintVisualSnapshot = { visuals: [], css: '' },
  options: SheetPrintOptions = {},
): SheetPrintDocument {
  // On worksheets draft quality suppresses graphics. On chart sheets the
  // same attribute describes printer quality, and the drawing is the page.
  const worksheetDraft = setup.draft && !options.chartSheet
  const rightToLeft = options.rightToLeft === true
  const blackAndWhite = setup.blackAndWhite || worksheetDraft
  const drawings = worksheetDraft ? [] : visuals.visuals
  const sheet = worksheet.getSheet?.()
  const rowHeightPt = (row: number): number =>
    sheet && !sheet.getRowVisible(row) ? 0 : finitePt(worksheet.getRowHeight(row), 20) * 0.75
  const columnWidthPt = (column: number): number =>
    sheet && !sheet.getColVisible(column)
      ? 0
      : finitePt(worksheet.getColumnWidth(column), 64) * 0.75
  const paper = paperGeometry(setup.paperSize, setup.orientation)
  const margins = setup.margins
  const printableWidthPt = Math.max((paper.widthIn - margins.left - margins.right) * 72, 1)
  const printableHeightPt = Math.max((paper.heightIn - margins.top - margins.bottom) * 72, 1)
  const common = {
    sheetName,
    fileName,
    paper,
    margins,
    blackAndWhite,
    headerFooterTheme: options.headerFooterTheme,
    firstPageNumber: setup.firstPageNumber,
    pictures: worksheetDraft ? new Map() : pictures,
    headerFooter: {
      odd: { header: setup.header, footer: setup.footer },
      first: setup.firstPage,
      even: setup.evenPages,
    },
    css: worksheetDraft ? '' : visuals.css,
    now: options.now ?? new Date(),
  }
  if (options.chartSheet) {
    const { body, scale } = layoutChartSheet(drawings, rowHeightPt, columnWidthPt, {
      widthPt: printableWidthPt,
      heightPt: printableHeightPt,
    })
    return {
      ...common,
      scale,
      headerFooterScale: 1,
      pages: [{
        body,
        page: { area: 0, rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        offsetLeftIn: 0,
        offsetTopIn: 0,
      }],
    }
  }
  const explicitAreas =
    options.selection !== undefined && options.selection !== null
      ? [parseArea(options.selection)]
      : setup.printAreas.map(parseArea)
  const dataArea = explicitAreas.length === 0
    ? {
        startRow: 0, startColumn: 0,
        endRow: worksheet.getLastRow(), endColumn: worksheet.getLastColumn(),
      }
    : null
  const areas = dataArea
    ? [areaWithDrawings(dataArea, drawings, rowHeightPt, columnWidthPt)]
    : explicitAreas
  const titleRows = setup.printTitles ? parseTitleSpan(setup.printTitles, 'row') : null
  const titleColumns = setup.printTitleColumns ? parseTitleSpan(setup.printTitleColumns, 'column') : null
  const headings = setup.printHeadings

  let totalCells = 0
  for (const area of areas) {
    const rows = area.endRow - area.startRow + 1
    const columns = area.endColumn - area.startColumn + 1
    if (rows < 1 || columns < 1) throw new PrintError(t('appPrintNothing'))
    totalCells += rows * columns
  }
  if (totalCells > MAX_PRINT_CELLS) throw new PrintError(t('appPrintTooLarge'))

  const headingWidthPt = headings ? HEADING_COLUMN_WIDTH_PT : 0
  const headingHeightPt = headings ? HEADING_ROW_HEIGHT_PT : 0
  const titleRowsHeightPt = spanTotal(titleRows, rowHeightPt)
  const titleColumnsWidthPt = spanTotal(titleColumns, columnWidthPt)

  const baseInput = {
    areas,
    rowHeightPt,
    columnWidthPt,
    titleRows,
    titleColumns,
    headingWidthPt,
    headingHeightPt,
  }
  const areaHeights: PrintAreaHeights[] = []
  let contentWidthPt = 0
  for (const area of areas) {
    const rows = bodyRows(area, baseInput)
    const columns = bodyColumns(area, baseInput)
    areaHeights.push({
      repeatedHeightPt: headingHeightPt + titleRowsHeightPt,
      rowHeightsPt: rows.map(rowHeightPt),
    })
    contentWidthPt = Math.max(
      contentWidthPt,
      headingWidthPt + titleColumnsWidthPt + columns.reduce((sum, c) => sum + columnWidthPt(c), 0),
    )
  }
  const scale = setup.fitToPage
    ? fitToPageScale({
        printableWidthPt,
        printableHeightPt,
        fitToWidth: setup.fitToWidth,
        fitToHeight: setup.fitToHeight,
        contentWidthPt,
        areas: areaHeights,
      })
    : clamp(setup.scale / 100, MIN_PRINT_SCALE, MAX_PRINT_SCALE)

  // Excel ignores manual breaks while fit-to-page decides the scale.
  const breaks = setup.fitToPage ? null : options.breaks
  const plan: PaginationInput = {
    ...baseInput,
    order: setup.pageOrder,
    rowBreaks: breaks?.rowBreaks ?? [],
    colBreaks: breaks?.colBreaks ?? [],
    pageWidthPt: printableWidthPt / scale,
    pageHeightPt: printableHeightPt / scale,
  }
  const pages = planPrintPages(plan)

  // A drawing can extend past the grid allocated by Univer. Its extra
  // rows and columns use the sheet dimensions and have no cell content.
  const modelRows = worksheet.getMaxRows?.() ?? Infinity
  const modelColumns = worksheet.getMaxColumns?.() ?? Infinity
  const hasCell = (row: number, column: number): boolean => row < modelRows && column < modelColumns
  const areaData = areas.map((area) => {
    const rows = Math.min(area.endRow + 1, modelRows) - area.startRow
    const columns = Math.min(area.endColumn + 1, modelColumns) - area.startColumn
    const grid = rows > 0 && columns > 0
      ? worksheet.getRange(area.startRow, area.startColumn, rows, columns)
      : null
    return {
      area,
      display: grid?.getDisplayValues() ?? [],
      raw: grid?.getValues() ?? [],
      // Repeated titles print with their merges even when they sit outside
      // the print area.
      merges: mergeMaps(worksheet, {
        startRow: Math.min(area.startRow, titleRows?.start ?? area.startRow),
        endRow: Math.max(area.endRow, titleRows?.end ?? area.endRow),
        startColumn: Math.min(area.startColumn, titleColumns?.start ?? area.startColumn),
        endColumn: Math.max(area.endColumn, titleColumns?.end ?? area.endColumn),
      }),
    }
  })

  const cellContentAt = (data: (typeof areaData)[number], row: number, column: number) => {
    const { area } = data
    if (
      row >= area.startRow &&
      row <= area.endRow &&
      column >= area.startColumn &&
      column <= area.endColumn
    ) {
      const rowIndex = row - area.startRow
      const columnIndex = column - area.startColumn
      return {
        text: data.display[rowIndex]?.[columnIndex] ?? '',
        raw: data.raw[rowIndex]?.[columnIndex],
      }
    }
    // Titles can print outside the cached area. Read the same raw value and
    // formatted text there without loading the intervening cells.
    const range = hasCell(row, column) ? worksheet.getRange(row, column, 1, 1) : null
    return {
      text: range?.getDisplayValues()[0]?.[0] ?? '',
      raw: range?.getValues()[0]?.[0],
    }
  }

  const styleAt = (row: number, column: number): PrintCellStyle | null =>
    hasCell(row, column) ? worksheet.getRange(row, column).getCellStyleData() : null
  /// Each shared edge has one owner: the upper/left cell paints it unless
  /// only the lower/right neighbour declares a border there. Page edges are
  /// painted by the cell at the edge; the heading strip supplies the outer
  /// top/left of the first row/column.
  interface Neighbours {
    readonly above: number | null
    readonly below: number | null
    readonly leftOf: number | null
    readonly rightOf: number | null
  }
  const cell = (
    data: (typeof areaData)[number],
    row: number,
    column: number,
    span: string,
    heightPt: number,
    near: Neighbours,
    mergedWidthPt?: number,
  ): string => {
    const style = styleAt(row, column)
    const diagonals = style?.bd?.tl_br || style?.bd?.bl_tr
      ? cellDiagonalHtml(style, mergedWidthPt ?? columnWidthPt(column), heightPt, rightToLeft, blackAndWhite)
      : ''
    const { text, raw } = cellContentAt(data, row, column)
    const align = style?.vt === 1 ? 'flex-start' : style?.vt === 2 ? 'center' : 'flex-end'
    const gridlines = setup.printGridlines && !worksheetDraft &&
      (dataArea === null || (row <= dataArea.endRow && column <= dataArea.endColumn))
    const custom = (r: number | null, c: number | null, edge: 't' | 'b' | 'l' | 'r'): boolean =>
      r !== null && c !== null && borderEdge(styleAt(r, c), edge) !== undefined
    const edges = {
      top:
        borderEdge(style, 't') !== undefined
          ? near.above === null || !custom(near.above, column, 'b')
          : gridlines && near.above === null && !headings,
      left:
        borderEdge(style, 'l') !== undefined
          ? near.leftOf === null || !custom(row, near.leftOf, 'r')
          : gridlines && near.leftOf === null && !headings,
      bottom:
        borderEdge(style, 'b') !== undefined || (gridlines && !custom(near.below, column, 't')),
      right: borderEdge(style, 'r') !== undefined || (gridlines && !custom(row, near.rightOf, 'l')),
    }
    return (
      `<td${span}${diagonals ? ' class="has-diagonal"' : ''} style="${cellCss(style, raw, gridlines, blackAndWhite, rightToLeft, edges)}">` +
      diagonals +
      `<div class="c" style="height:${round(heightPt)}pt;align-items:${align}">` +
      `<span${rightToLeft ? ' dir="auto"' : ''}>${escapeHtml(text)}</span></div></td>`
    )
  }

  const records: SheetPrintPageRecord[] = pages.map((page) => {
    const data = areaData[page.area]
    if (!data) throw new PrintError(t('appPrintNothing'))
    const pageRows = bodyRows({ ...data.area, startRow: page.rowStart, endRow: page.rowEnd }, plan)
    const pageColumns = bodyColumns(
      { ...data.area, startColumn: page.colStart, endColumn: page.colEnd },
      plan,
    )
    const titleRowList = titleRows ? spanIndices(titleRows).filter((r) => rowHeightPt(r) > 0) : []
    const titleColumnList = titleColumns
      ? spanIndices(titleColumns).filter((c) => columnWidthPt(c) > 0)
      : []
    const allColumns = [...titleColumnList, ...pageColumns]
    const printedColumns = new Set(allColumns)
    const printedRows = [...titleRowList, ...pageRows]

    const colgroup =
      `<colgroup>${headings ? `<col style="width:${HEADING_COLUMN_WIDTH_PT}pt">` : ''}` +
      allColumns.map((c) => `<col style="width:${round(columnWidthPt(c))}pt">`).join('') +
      `</colgroup>`

    // Merges span within their table section: title rows stay in the head,
    // body rows in the body; columns span every printed column.
    const rowHtml = (row: number, sectionRows: readonly number[], position: number): string => {
      const heightPt = rowHeightPt(row)
      const cells: string[] = []
      if (headings) cells.push(`<th class="hd hd-left">${row + 1}</th>`)
      const inSection = new Set(sectionRows)
      const above = printedRows[position - 1] ?? null
      const rowAfter = (last: number): number | null =>
        printedRows[printedRows.indexOf(last) + 1] ?? null
      const columnAfter = (last: number): number | null =>
        allColumns[allColumns.indexOf(last) + 1] ?? null
      allColumns.forEach((column, index) => {
        const key = `${row}:${column}`
        const near = {
          above,
          below: rowAfter(row),
          leftOf: allColumns[index - 1] ?? null,
          rightOf: columnAfter(column),
        }
        const coveredBy = data.merges.covered.get(key)
        if (coveredBy !== undefined) {
          const [anchorRow, anchorColumn] = coveredBy
          if (inSection.has(anchorRow) && printedColumns.has(anchorColumn)) return
          cells.push(cell(data, row, column, '', heightPt, near))
          return
        }
        const anchor = data.merges.anchors.get(key)
        if (anchor) {
          const spannedRows = sectionRows.filter((r) => r >= row && r < row + anchor.rows)
          const spannedColumns = allColumns.filter(
            (c) => c >= column && c < column + anchor.columns,
          )
          const spanned = spannedRows.reduce((sum, r) => sum + rowHeightPt(r), 0)
          const lastRow = spannedRows[spannedRows.length - 1] ?? row
          const lastColumn = spannedColumns[spannedColumns.length - 1] ?? column
          cells.push(
            cell(
              data,
              row,
              column,
              ` rowspan="${spannedRows.length}" colspan="${spannedColumns.length}"`,
              spanned,
              { ...near, below: rowAfter(lastRow), rightOf: columnAfter(lastColumn) },
              spannedColumns.reduce((sum, c) => sum + columnWidthPt(c), 0),
            ),
          )
          return
        }
        cells.push(cell(data, row, column, '', heightPt, near))
      })
      return `<tr style="height:${round(heightPt)}pt">${cells.join('')}</tr>`
    }

    const headingRow: string[] = []
    if (headings) {
      headingRow.push(
        `<tr style="height:${HEADING_ROW_HEIGHT_PT}pt"><th class="hd hd-top hd-left"></th>` +
          allColumns.map((c) => `<th class="hd hd-top">${columnLabel(c)}</th>`).join('') +
          `</tr>`,
      )
    }
    const head = headingRow.concat(
      titleRowList.map((row, index) => rowHtml(row, titleRowList, index)),
    )
    const body = pageRows.map((row, index) => rowHtml(row, pageRows, titleRowList.length + index))

    const originLeft = headingWidthPt + titleColumnsWidthPt
    const originTop = headingHeightPt + titleRowsHeightPt
    const bodyWidthPt = pageColumns.reduce((sum, c) => sum + columnWidthPt(c), 0)
    const bodyHeightPt = pageRows.reduce((sum, r) => sum + rowHeightPt(r), 0)
    const tableWidthPt = originLeft + bodyWidthPt
    const overlayLayer = drawings.length > 0
      ? printDrawingOverlays(
          drawings,
          printBands(allColumns, columnWidthPt, headingWidthPt),
          printBands(printedRows, rowHeightPt, headingHeightPt),
          columnWidthPt,
          rowHeightPt,
          rightToLeft ? tableWidthPt : undefined,
        )
      : ''
    // table-layout:fixed is ignored while the table's width is auto (CSS 2.1
    // §17.5.2): without an explicit width Chromium falls back to content-based
    // auto layout and the colgroup's saved column widths are lost (text-bearing
    // columns inflate, empty ones shrink). The width is the colgroup sum.
    const table = `<table${rightToLeft ? ' dir="rtl"' : ''} style="width:${round(tableWidthPt)}pt">${colgroup}<thead>${head.join('')}</thead><tbody>${body.join('')}</tbody></table>`
    const spareWidthIn = Math.max(0, printableWidthPt - tableWidthPt * scale) / 72
    return {
      body: table + overlayLayer,
      page,
      offsetLeftIn: setup.horizontalCentered ? spareWidthIn / 2 : rightToLeft ? spareWidthIn : 0,
      offsetTopIn: setup.verticalCentered
        ? Math.max(0, printableHeightPt - (originTop + bodyHeightPt) * scale) / 72 / 2
        : 0,
    }
  })

  return {
    ...common,
    scale,
    headerFooterScale: setup.headerFooterScaleWithDoc ? scale : 1,
    pages: records,
  }
}

/// A chart sheet fits its drawing as a unit inside the printable page.
function layoutChartSheet(
  visuals: readonly PrintVisual[],
  rowHeightPt: (row: number) => number,
  columnWidthPt: (column: number) => number,
  printable: { widthPt: number; heightPt: number },
): { body: string; scale: number } {
  if (visuals.length === 0) return { body: '', scale: 1 }
  const startRow = Math.min(...visuals.map((visual) => visual.fromRow))
  const startColumn = Math.min(...visuals.map((visual) => visual.fromColumn))
  const drawings = visuals.map((visual) => ({
    visual,
    x: spanTotal({ start: startColumn, end: visual.fromColumn - 1 }, columnWidthPt) +
      visualOffsetPt(visual.offsetXPx),
    y: spanTotal({ start: startRow, end: visual.fromRow - 1 }, rowHeightPt) +
      visualOffsetPt(visual.offsetYPx),
    widthPx: Math.max(1, finitePt(visual.widthPx, 1)),
    heightPx: Math.max(1, finitePt(visual.heightPx, 1)),
  }))
  const left = Math.min(...drawings.map(({ x }) => x))
  const top = Math.min(...drawings.map(({ y }) => y))
  const right = Math.max(...drawings.map(({ x, widthPx }) => x + widthPx * 0.75))
  const bottom = Math.max(...drawings.map(({ y, heightPx }) => y + heightPx * 0.75))
  return {
    scale: Math.min(printable.widthPt / (right - left), printable.heightPt / (bottom - top)),
    body: drawings.map(({ visual, x, y, widthPx, heightPx }) =>
      visualOverlayHtml(visual, x - left, y - top, widthPx, heightPx),
    ).join(''),
  }
}

export interface AssembledPrintJob {
  readonly html: string
  /// Index into `documents` for each emitted page.
  readonly pages: readonly { readonly document: number; readonly page: number }[]
}

/// Assemble paper-sized pages with headers and footers. The `include`
/// callback selects by physical position in the job.
export function assemblePrintHtml(
  documents: readonly SheetPrintDocument[],
  include?: (jobPage: number) => boolean,
): AssembledPrintJob {
  const total = documents.reduce((sum, document) => sum + document.pages.length, 0)
  const paperClasses = new Map<string, string>()
  const pageRules: string[] = []
  const pages: string[] = []
  const emitted: { document: number; page: number }[] = []
  let jobPage = 0
  documents.forEach((document, documentIndex) => {
    const paperKey = `${document.paper.widthIn}x${document.paper.heightIn}`
    let paperClass = paperClasses.get(paperKey)
    if (paperClass === undefined) {
      paperClass = `p${paperClasses.size}`
      paperClasses.set(paperKey, paperClass)
      pageRules.push(
        `@page ${paperClass} { size: ${document.paper.widthIn}in ${document.paper.heightIn}in; margin: 0; }` +
          ` .${paperClass} { page: ${paperClass}; }`,
      )
    }
    document.pages.forEach((record, pageIndex) => {
      jobPage += 1
      if (include && !include(jobPage)) return
      const printedPage = document.firstPageNumber === undefined
        ? jobPage
        : document.firstPageNumber + pageIndex
      emitted.push({ document: documentIndex, page: pageIndex })
      pages.push(
        pageHtml(
          document,
          record,
          printedPage,
          total,
          paperClass as string,
          pageVariant(document.headerFooter, pageIndex, printedPage),
        ),
      )
    })
  })
  const css = [...new Set(documents.map((document) => document.css).filter(Boolean))].join('\n')
  const lang = getLang()
  const html =
    `<!doctype html><html lang="${htmlLang(lang)}"><head><meta charset="utf-8"><style>
@page { margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: Calibri, 'Helvetica Neue', Arial, ${printCjkFonts(lang)}, sans-serif; }
.page { position: relative; overflow: hidden; background: #fff; break-after: page; }
.page:last-child { break-after: auto; }
.content { position: absolute; overflow: hidden; }
.hf { position: absolute; display: flex; color: #000; }
.hf > span { flex: 1; min-width: 0; white-space: pre-wrap; }
.hf img { vertical-align: bottom; }
table { border-collapse: separate; border-spacing: 0; table-layout: fixed; }
td, th { padding: 0; border: 0; overflow: hidden; font-size: 11pt; vertical-align: bottom; }
td .c { display: flex; overflow: hidden; padding: 0 2pt; line-height: 1.2; }
td .c > span { width: 100%; }
td.has-diagonal, td.has-diagonal > .c { position: relative; }
.cell-diagonal { display: block; position: absolute; left: 0; transform-origin: left center; print-color-adjust: exact; }
th.hd { background: #f1f1f1; color: #444; font-size: 8.5pt; font-weight: 400;
  text-align: center; vertical-align: middle;
  --heading-end: -0.75pt; --heading-start: 0.75pt;
  box-shadow: inset var(--heading-end) 0 0 #b7b7b7, inset 0 -0.75pt 0 #b7b7b7; }
table[dir="rtl"] th.hd { --heading-end: 0.75pt; --heading-start: -0.75pt; }
th.hd-top { box-shadow: inset var(--heading-end) 0 0 #b7b7b7, inset 0 -0.75pt 0 #b7b7b7, inset 0 0.75pt 0 #b7b7b7; }
th.hd-left { box-shadow: inset var(--heading-end) 0 0 #b7b7b7, inset 0 -0.75pt 0 #b7b7b7, inset var(--heading-start) 0 0 #b7b7b7; }
th.hd-top.hd-left { box-shadow: inset var(--heading-end) 0 0 #b7b7b7, inset 0 -0.75pt 0 #b7b7b7,
  inset 0 0.75pt 0 #b7b7b7, inset var(--heading-start) 0 0 #b7b7b7; }
.ov { position: absolute; overflow: hidden; }
.pv { position: absolute; overflow: hidden; }
.xlsx-print-visual { display: block; width: 100%; height: 100%; }
.page-monochrome .hf span, .page-monochrome .shape-text, .page-monochrome .shape-text * { color: #000 !important; }
.page-monochrome .pv, .page-monochrome .hf img { filter: grayscale(1); }
.page-monochrome .xlsx-shape-drawn svg > path[fill]:not([fill="none"]):not([fill="transparent"]) { fill: #fff !important; }
.page-monochrome .xlsx-shape-drawn svg > path[stroke]:not([stroke="none"]):not([stroke="transparent"]) { stroke: #000 !important; }
${pageRules.join('\n')}
</style>${css ? `<style>${css}</style>` : ''}</head><body>` +
    pages.join('') +
    `</body></html>`
  return { html, pages: emitted }
}

/// differentFirst uses the sheet's first page. differentOddEven follows &P.
export function pageVariant(
  headerFooter: SheetHeaderFooter,
  sheetPageIndex: number,
  printedPage: number,
): PageVariant {
  if (sheetPageIndex === 0 && headerFooter.first !== null) return 'first'
  if (printedPage % 2 === 0 && headerFooter.even !== null) return 'even'
  return 'odd'
}

function pageHtml(
  document: SheetPrintDocument,
  record: SheetPrintPageRecord,
  page: number,
  total: number,
  paperClass: string,
  variant: PageVariant,
): string {
  const { paper, margins } = document
  const pair =
    variant === 'first'
      ? (document.headerFooter.first ?? document.headerFooter.odd)
      : variant === 'even'
        ? (document.headerFooter.even ?? document.headerFooter.odd)
        : document.headerFooter.odd
  const fields = {
    page,
    total,
    date: document.now,
    fileName: document.fileName,
    sheetName: document.sheetName,
  }
  const header = pair.header
    ? headerFooterHtml(
        pair.header,
        'header',
        document,
        fields,
        sectionPictures(document.pictures, 'header', variant),
      )
    : ''
  const footer = pair.footer
    ? headerFooterHtml(
        pair.footer,
        'footer',
        document,
        fields,
        sectionPictures(document.pictures, 'footer', variant),
      )
    : ''
  const contentWidthIn = Math.max(paper.widthIn - margins.left - margins.right, 0.01)
  const contentHeightIn = Math.max(paper.heightIn - margins.top - margins.bottom, 0.01)
  return (
    `<div class="page ${paperClass}${document.blackAndWhite ? ' page-monochrome' : ''}" style="width:${paper.widthIn}in;height:${paper.heightIn}in">` +
    header +
    `<div class="content" style="left:${round(margins.left + record.offsetLeftIn)}in;` +
    `top:${round(margins.top + record.offsetTopIn)}in;` +
    `width:${round(contentWidthIn - record.offsetLeftIn)}in;` +
    `height:${round(contentHeightIn - record.offsetTopIn)}in">` +
    `<div style="zoom:${round4(document.scale)};position:relative">${record.body}</div></div>` +
    footer +
    `</div>`
  )
}

/// The `&G` pictures of one header or footer's three sections, for one page
/// variant (VML slot ids: LH/CH/RH, LF/CF/RF, plus EVEN/FIRST).
export function sectionPictures(
  pictures: HeaderFooterPictures,
  kind: 'header' | 'footer',
  variant: PageVariant,
): SectionPictures {
  const suffix = variant === 'odd' ? '' : variant.toUpperCase()
  const slot = (section: 'L' | 'C' | 'R') =>
    pictures.get(`${section}${kind === 'header' ? 'H' : 'F'}${suffix}`)
  const left = slot('L')
  const center = slot('C')
  const right = slot('R')
  return {
    ...(left === undefined ? {} : { left }),
    ...(center === undefined ? {} : { center }),
    ...(right === undefined ? {} : { right }),
  }
}

const PICTURE_MARK = '￼'

/// One left/center/right header or footer inside the page: Excel offsets it
/// from the paper edge by the header/footer margin and spans the side
/// margins; the text and pictures follow the print scale (scaleWithDoc).
export function headerFooterHtml(
  parts: HeaderFooterParts,
  kind: 'header' | 'footer',
  document: Pick<SheetPrintDocument, 'margins' | 'headerFooterScale' | 'headerFooterTheme'>,
  fields: { page: number; total: number; date: Date; fileName: string; sheetName: string },
  pictures: SectionPictures = {},
): string {
  const sections = [parts.left ?? '', parts.center ?? '', parts.right ?? '']
  if (sections.every((text) => text === '')) return ''
  const sectionPicture = [pictures.left, pictures.center, pictures.right]
  const scale = document.headerFooterScale
  const rendered = sections.map((text, index) =>
    renderHeaderFooterSection(text, fields, sectionPicture[index], scale, document.headerFooterTheme),
  )
  const { margins } = document
  const edge =
    kind === 'header' ? `top:${round(margins.header)}in` : `bottom:${round(margins.footer)}in`
  return (
    `<div class="hf" style="left:${round(margins.left)}in;right:${round(margins.right)}in;${edge};` +
    `font-size:${round(HEADER_FOOTER_FONT_SIZE_PT * scale)}pt">` +
    `<span>${rendered[0]}</span>` +
    `<span style="text-align:center">${rendered[1]}</span>` +
    `<span style="text-align:right">${rendered[2]}</span></div>`
  )
}

/// Field codes resolved for this page, escaped, with `&G` replaced by the
/// section's picture (nothing when the slot has none, like Excel).
export function renderHeaderFooterSection(
  text: string,
  fields: { page: number; total: number; date: Date; fileName: string; sheetName: string },
  picture?: HeaderFooterPictureImage,
  scale = 1,
  theme?: HeaderFooterTheme,
): string {
  const image = picture ? pictureHtml(picture, scale) : ''
  const expandedFields = { ...fields, picture: picture ? PICTURE_MARK : '' }
  let html = ''
  for (const run of headerFooterRuns(text, theme)) {
    const expanded = expandHeaderFooterCodes(run.text, expandedFields)
    if (expanded === '') continue
    let content = expanded.split(PICTURE_MARK).map(escapeHtml).join(image)
    const { fontFamily, fontSizePt, color, bold, italic, underline, strike, baseline } = run.style
    const css: string[] = []
    if (fontFamily) {
      const safeFamily = fontFamily
        .replace(/[\r\n\f]/g, ' ')
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
      css.push(`font-family:"${safeFamily}"`)
    }
    if (fontSizePt !== undefined) css.push(`font-size:${round(fontSizePt * scale)}pt`)
    if (color) css.push(`color:${color}`)
    if (bold) css.push('font-weight:bold')
    if (italic) css.push('font-style:italic')
    if (underline === 'double') {
      css.push('text-decoration-line:underline', 'text-decoration-style:double')
      if (strike) content = `<s>${content}</s>`
    } else if (underline || strike) {
      const lines = [underline && 'underline', strike && 'line-through'].filter(Boolean)
      css.push(`text-decoration-line:${lines.join(' ')}`)
    }
    if (baseline) content = `<${baseline}>${content}</${baseline}>`
    html += css.length === 0 ? content : `<span style="${escapeAttribute(css.join(';'))}">${content}</span>`
  }
  return html
}

/// The picture at its declared size times the print scale (points → CSS px
/// at 96/72). The data URL is built from a validated media type and base64
/// payload; escaping it anyway keeps the attribute closed no matter what.
function pictureHtml(picture: HeaderFooterPictureImage, scale: number): string {
  const width = round((picture.widthPt * scale * 96) / 72)
  const height = round((picture.heightPt * scale * 96) / 72)
  return `<img src="${escapeAttribute(picture.dataUrl)}" style="width:${width}px;height:${height}px">`
}

/// The export/print request for a job: the paper of the first sheet seeds
/// the dialog, the pages carry their own size via @page rules.
export function printRequest(
  documents: readonly SheetPrintDocument[],
  fileName: string,
  include?: (jobPage: number) => boolean,
): WorkbookExportPdfRequest {
  const job = assemblePrintHtml(documents, include)
  if (job.pages.length === 0) throw new PrintError(t('appPrintNothing'))
  const first = documents[job.pages[0]?.document ?? 0] ?? documents[0]
  const paper = first?.paper ?? paperGeometry(9, 'portrait')
  return {
    fileName,
    html: job.html,
    landscape: paper.landscape,
    pageSize: paper.pageSize,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    scale: 1,
  }
}

/// Single-sheet export (headless CLI path and File → Export PDF).
export function buildSheetPrintPayload(
  worksheet: PrintWorksheet,
  setup: EffectivePageSetup,
  fileName: string,
  sheetName: string,
  pictures: HeaderFooterPictures = new Map(),
  visuals: PrintVisualSnapshot = { visuals: [], css: '' },
  options: SheetPrintOptions = {},
): WorkbookExportPdfRequest {
  const baseName = fileName.replace(/\.pdf$/, '')
  return printRequest(
    [layoutSheetPrint(worksheet, setup, baseName, sheetName, pictures, visuals, options)],
    fileName,
  )
}

/// Excel's default print range covers the cells and the drawings over them.
function areaWithDrawings(
  dataArea: PrintArea,
  visuals: readonly PrintVisual[],
  rowHeightPt: (row: number) => number,
  columnWidthPt: (column: number) => number,
): PrintArea {
  let endRow = Math.max(dataArea.endRow, 0)
  let endColumn = Math.max(dataArea.endColumn, 0)
  for (const visual of visuals) {
    const bottom = visualOffsetPt(visual.offsetYPx) + finitePt(visual.heightPx, 1) * 0.75
    const right = visualOffsetPt(visual.offsetXPx) + finitePt(visual.widthPx, 1) * 0.75
    endRow = Math.max(
      endRow,
      visual.toRow,
      visualEndCell(visual.fromRow, bottom, rowHeightPt, MAX_PRINT_CELLS),
    )
    endColumn = Math.max(
      endColumn,
      visual.toColumn,
      visualEndCell(visual.fromColumn, right, columnWidthPt, MAX_GRID_COLUMNS - 1),
    )
  }
  return { ...dataArea, endRow, endColumn }
}

function visualOffsetPt(offsetPx: number): number {
  return (offsetPx < 0 ? -1 : 1) * finitePt(Math.abs(offsetPx), 0) * 0.75
}

/// The last cell covered by the measured drawing edge. Reaching the row
/// limit lets the existing print-cell budget reject an oversized layout.
function visualEndCell(
  start: number,
  distancePt: number,
  sizePt: (index: number) => number,
  limit: number,
): number {
  let index = start
  while (index < limit) {
    distancePt -= sizePt(index)
    if (distancePt <= 1e-7) break
    index += 1
  }
  return index
}

/// The snapshot at its anchor. Columns are laid out at px × 0.75 pt, which
/// is one CSS px per sheet px, so the clone keeps its px box inside a box of
/// the same size stated in pt.
function visualOverlayHtml(
  visual: PrintVisual,
  leftPt: number,
  topPt: number,
  widthPx: number,
  heightPx: number,
): string {
  const style = `left:${round(leftPt)}pt;top:${round(topPt)}pt;width:${round(widthPx * 0.75)}pt;height:${round(heightPx * 0.75)}pt`
  const inner = `width:${round(widthPx)}px;height:${round(heightPx)}px`
  return `<div class="pv" style="${style}"><div style="${inner}">${visual.html}</div></div>`
}

function parseArea(area: string): PrintArea {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7}):\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(area)
  if (!match) throw new PrintError(t('appPrintBadArea', { area }))
  const rows = [Number(match[2]) - 1, Number(match[4]) - 1]
  const columns = [columnIndex(match[1] ?? 'A'), columnIndex(match[3] ?? 'A')]
  return {
    startRow: Math.min(...rows),
    endRow: Math.max(...rows),
    startColumn: Math.min(...columns),
    endColumn: Math.max(...columns),
  }
}

function parseTitleSpan(titles: string, axis: 'row' | 'column'): IndexSpan {
  const span = parsePrintTitleSpan(titles)
  if (!span || span.axis !== axis) throw new PrintError(t('appPrintBadTitles', { titles }))
  if (span.end - span.start > 20) throw new PrintError(t('appPrintTitlesLimit'))
  return span
}

function spanIndices(span: IndexSpan): number[] {
  return Array.from({ length: span.end - span.start + 1 }, (_, offset) => span.start + offset)
}

function spanTotal(span: IndexSpan | null, sizeOf: (index: number) => number): number {
  return span ? spanIndices(span).reduce((sum, index) => sum + sizeOf(index), 0) : 0
}

interface PrintBand {
  readonly start: number
  end: number
  readonly positionPt: number
  sizePt: number
}

/// Contiguous source coordinates map to one layer. Repeated titles can
/// reorder the page's rows or columns, so start a new layer at each gap
/// with omitted visible cells.
function printBands(
  indices: readonly number[],
  sizeOf: (index: number) => number,
  originPt: number,
): PrintBand[] {
  const bands: PrintBand[] = []
  let positionPt = originPt
  for (const index of indices) {
    const sizePt = sizeOf(index)
    const previous = bands.at(-1)
    let next = previous ? previous.end + 1 : index
    while (next < index && sizeOf(next) === 0) next += 1
    if (previous && next === index) {
      previous.end = index
      previous.sizePt += sizePt
    } else {
      bands.push({ start: index, end: index, positionPt, sizePt })
    }
    positionPt += sizePt
  }
  return bands
}

/// Resolve an anchor relative to a band, stopping once the drawing cannot
/// intersect it. Hidden cells consume no space.
function drawingOffsetInBand(
  band: PrintBand,
  anchor: number,
  offsetPt: number,
  extentPt: number,
  sizeOf: (index: number) => number,
): number | undefined {
  if (anchor > band.end && offsetPt >= 0) return undefined
  for (let index = anchor; index < band.start && offsetPt + extentPt > 0; index += 1)
    offsetPt -= sizeOf(index)
  for (let index = band.start; index < anchor && offsetPt < band.sizePt; index += 1)
    offsetPt += sizeOf(index)
  return offsetPt < band.sizePt && offsetPt + extentPt > 0 ? offsetPt : undefined
}

function printDrawingOverlays(
  drawings: readonly PrintVisual[],
  columns: readonly PrintBand[],
  rows: readonly PrintBand[],
  columnWidthPt: (column: number) => number,
  rowHeightPt: (row: number) => number,
  mirrorWidthPt?: number,
): string {
  const layers: string[] = []
  for (const row of rows) {
    for (const column of columns) {
      const overlays: string[] = []
      for (const visual of drawings) {
        const widthPx = finitePt(visual.widthPx, 1)
        const heightPx = finitePt(visual.heightPx, 1)
        const x = drawingOffsetInBand(
          column, visual.fromColumn, visualOffsetPt(visual.offsetXPx), widthPx * 0.75, columnWidthPt,
        )
        const y = drawingOffsetInBand(
          row, visual.fromRow, visualOffsetPt(visual.offsetYPx), heightPx * 0.75, rowHeightPt,
        )
        if (x !== undefined && y !== undefined) {
          const left = mirrorWidthPt === undefined ? x : column.sizePt - x - widthPx * 0.75
          overlays.push(visualOverlayHtml(visual, left, y, widthPx, heightPx))
        }
      }
      if (overlays.length === 0) continue
      const left = mirrorWidthPt === undefined
        ? column.positionPt
        : mirrorWidthPt - column.positionPt - column.sizePt
      const style = `left:${round(left)}pt;top:${round(row.positionPt)}pt;width:${round(column.sizePt)}pt;height:${round(row.sizePt)}pt`
      layers.push(`<div class="ov" style="${style}">${overlays.join('')}</div>`)
    }
  }
  return layers.join('')
}

function mergeMaps(worksheet: PrintWorksheet, area: PrintArea) {
  const anchors = new Map<string, { rows: number; columns: number }>()
  const covered = new Map<string, readonly [number, number]>()
  for (const merge of worksheet.getMergedRanges()) {
    const row = merge.getRow()
    const column = merge.getColumn()
    if (row > area.endRow || column > area.endColumn) continue
    if (row + merge.getHeight() - 1 < area.startRow) continue
    if (column + merge.getWidth() - 1 < area.startColumn) continue
    anchors.set(`${row}:${column}`, { rows: merge.getHeight(), columns: merge.getWidth() })
    for (let r = row; r < row + merge.getHeight(); r += 1) {
      for (let c = column; c < column + merge.getWidth(); c += 1) {
        if (r !== row || c !== column) covered.set(`${r}:${c}`, [row, column])
      }
    }
  }
  return { anchors, covered }
}

/// Borders paint as inset shadows or background stripes so they do not
/// change the planned cell geometry. Only the owning cell paints an edge.
function cellCss(
  style: PrintCellStyle | null,
  rawValue: unknown,
  gridlines: boolean,
  blackAndWhite: boolean,
  rightToLeft: boolean,
  edges: { top: boolean; bottom: boolean; left: boolean; right: boolean },
): string {
  const rules: string[] = []
  if (style?.bl === 1) rules.push('font-weight:700')
  if (style?.it === 1) rules.push('font-style:italic')
  const decorations = [
    style?.ul?.s === 1 ? 'underline' : '',
    style?.st?.s === 1 ? 'line-through' : '',
  ].filter(Boolean)
  if (decorations.length > 0) rules.push(`text-decoration:${decorations.join(' ')}`)
  if (style?.fs) rules.push(`font-size:${round(style.fs)}pt`)
  // a font name comes straight from styles.xml; anything outside the whitelist could
  // close the style attribute and inject markup into the exported page
  const family = style?.ff?.replace(/[^\p{L}\p{N} \-_.]/gu, '')
  // fallbacks mirror the body stack: an uninstalled family (e.g. Aptos)
  // must not drop to the browser's serif default in the exported page
  if (family)
    rules.push(
      `font-family:'${family}',Calibri,'Helvetica Neue',Arial,${printCjkFonts(getLang())},sans-serif`,
    )
  if (style?.cl?.rgb) rules.push(`color:${blackAndWhite ? '#000000' : cssColor(style.cl.rgb)}`)
  const fill = !blackAndWhite && style?.bg?.rgb ? cssColor(style.bg.rgb) : undefined
  const align =
    style?.ht === 1
      ? 'left'
      : style?.ht === 2
        ? 'center'
        : style?.ht === 3
          ? 'right'
          : typeof rawValue === 'number'
            ? 'right'
            : typeof rawValue === 'boolean'
              ? 'center'
              : 'left'
  const shadows: string[] = []
  const patternedBorders: string[] = []
  const edge = (
    key: 't' | 'b' | 'l' | 'r',
    draw: boolean,
    side: 'top' | 'bottom' | 'left' | 'right',
    offset: (width: number) => string,
  ): void => {
    const border = borderEdge(style, key)
    if (border && draw) {
      const color = blackAndWhite ? '#000000' : cssColor(border.cl?.rgb ?? '#000000')
      const widthPt = printBorderWidthPt(border.s)
      const pattern = borderBackground(border.s, widthPt, color, side)
      if (pattern) patternedBorders.push(pattern)
      else shadows.push(`inset ${offset(widthPt)} 0 ${color}`)
    } else if (gridlines && draw) {
      shadows.push(`inset ${offset(GRIDLINE_PT)} 0 #c0c0c0`)
    }
  }
  edge('t', edges.top, 'top', (width) => `0 ${width}pt`)
  edge('b', edges.bottom, 'bottom', (width) => `0 -${width}pt`)
  edge('l', edges.left, rightToLeft ? 'right' : 'left', (width) => `${rightToLeft ? -width : width}pt 0`)
  edge('r', edges.right, rightToLeft ? 'left' : 'right', (width) => `${rightToLeft ? width : -width}pt 0`)
  if (patternedBorders.length > 0)
    rules.push(`background:${patternedBorders.join(',')}${fill ? ` ${fill}` : ''}`, 'print-color-adjust:exact')
  else if (fill) rules.push(`background:${fill}`)
  rules.push(`text-align:${align}`)
  rules.push(style?.tb === 3 ? 'white-space:pre-wrap;word-break:break-word' : 'white-space:pre')
  if (shadows.length > 0) rules.push(`box-shadow:${shadows.join(',')}`)
  return rules.join(';')
}

/// Draw the two diagonals behind the text. The line box uses the full
/// printed cell extent, including any merged rows and columns.
function cellDiagonalHtml(
  style: PrintCellStyle,
  widthPt: number,
  heightPt: number,
  rightToLeft: boolean,
  blackAndWhite: boolean,
): string {
  const lengthPt = round(Math.hypot(widthPt, heightPt))
  const angle = round4(Math.atan2(heightPt, widthPt))
  const lines: string[] = []
  for (const descending of [true, false]) {
    const border = borderEdge(style, descending === rightToLeft ? 'bl_tr' : 'tl_br')
    if (!border) continue
    const color = blackAndWhite ? '#000000' : cssColor(border.cl?.rgb ?? '#000000')
    const lineWidthPt = printBorderWidthPt(border.s)
    const background = borderBackground(border.s, lineWidthPt, color, 'top') ?? color
    const topPt = descending ? 0 : round(heightPt)
    const rotation = descending ? angle : -angle
    lines.push(
      `<span class="cell-diagonal" aria-hidden="true" style="top:${topPt}pt;width:${lengthPt}pt;height:${lineWidthPt}pt;` +
        `transform:translateY(-50%) rotate(${rotation}rad);background:${background}"></span>`,
    )
  }
  return lines.join('')
}

function cssColor(rgb: string): string {
  return /^(#[0-9a-fA-F]{3,8}|rgba?\([\d ,.%]+\))$/.test(rgb) ? rgb : '#000'
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
