/// Writes a declarative filter snapshot into worksheet XML: the
/// `<autoFilter>` element (with per-column value / custom criteria) plus row
/// visibility inside the filter's row span. Unsupported criteria fail closed.
/// A filter whose range sits inside an Excel table is routed into the table
/// part instead (Excel stores table filters there, never on the worksheet) —
/// see `applyTableFilterState` and `applyRowVisibilityState`.

import { readRootStartTag } from './xlsx-namespace'
import { findRootChild } from './xlsx-root-tail'
import { decodeAttribute } from './xlsx-sheets'
import { childElements } from './xlsx-style-entries'
import { readWorksheetTagAttribute, updateWorksheetTagAttribute } from './xlsx-structure'
import { prefixOf } from './xlsx-worksheet-xml'

export class FilterEditError extends Error {}

interface CellArea {
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
}

export interface FilterColumnState {
  readonly colId: number
  readonly values?: readonly string[] | undefined
  readonly blank?: boolean | undefined
  readonly customs?:
    | {
        readonly and?: boolean | undefined
        readonly filters: readonly {
          readonly val: string | number
          readonly operator?: string | undefined
        }[]
      }
    | undefined
}

export interface SheetFilterState {
  readonly sheetName: string
  readonly filter: {
    readonly range: CellArea
    readonly columns: readonly FilterColumnState[]
  } | null
  readonly hiddenRows: readonly number[]
  readonly visibilityRange: CellArea
  /** The Web snapshot contains only criteria its editor can represent. */
  readonly preserveUneditable?: boolean | undefined
}

const CUSTOM_OPERATORS = new Set([
  'equal',
  'notEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
])

const AUTO_FILTER = /<((?:[\w.-]+:)?)autoFilter(?=[\s/>])/
const FILTER_COLUMN =
  /<((?:[\w.-]+:)?)filterColumn(?=[\s/>])([^>]*?)(?:\/>|>[\s\S]*?<\/\1filterColumn\s*>)/g
const OPAQUE_CRITERIA =
  /<(?:[\w.-]+:)?(?:top10|dynamicFilter|colorFilter|iconFilter|dateGroupItem|extLst)(?=[\s/>])/

function directAutoFilter(xml: string, root: 'worksheet' | 'table') {
  // A custom sheet view can have its own saved filter, below the worksheet's root.
  return AUTO_FILTER.test(xml) ? findRootChild(xml, root, 'autoFilter') : null
}

export function hasUneditableAutoFilter(xml: string, root?: 'table'): boolean {
  const range = root === undefined ? null : directAutoFilter(xml, root)
  const filter = root === undefined ? xml : range === null ? '' : xml.slice(range.start, range.end)
  return [...filter.matchAll(FILTER_COLUMN)].some(([column]) => OPAQUE_CRITERIA.test(column))
}

export function applyFilterState(worksheetXml: string, state: SheetFilterState): string {
  const existing = directAutoFilter(worksheetXml, 'worksheet')
  const raw = existing ? worksheetXml.slice(existing.start, existing.end) : ''
  const element =
    state.filter === null
      ? ''
      : serializeAutoFilter(
          toRef(state.filter.range),
          state.filter.columns,
          0,
          raw,
          state.preserveUneditable === true,
        )
  let xml = worksheetXml
  if (existing) {
    xml = worksheetXml.slice(0, existing.start) + element + worksheetXml.slice(existing.end)
  } else if (element !== '') {
    xml = insertAfterSheetData(worksheetXml, element)
  }
  return applyRowVisibilityState(
    xml,
    state,
    state.preserveUneditable === true && hasUneditableAutoFilter(element),
  )
}

/// The worksheet half of a table-routed filter: row visibility only. The
/// `<autoFilter>` element itself lives in the table part, and a worksheet
/// element overlapping a table is invalid OOXML that Excel repairs away.
export function applyRowVisibilityState(
  worksheetXml: string,
  state: SheetFilterState,
  preserveHidden = false,
): string {
  return applyRowVisibility(
    worksheetXml,
    state.visibilityRange,
    new Set(state.hiddenRows),
    preserveHidden,
  )
}

/// Geometry of the table part a filter routed into, in final (post-shift)
/// coordinates: the full table ref including the totals band.
export interface TableFilterRoute {
  readonly area: CellArea
  /// headerRowCount/@headerRowCount of the table part (Excel default 1).
  readonly headerRowCount: number
  /// totalsRowCount/@totalsRowCount of the table part (Excel default 0).
  readonly totalsRowCount: number
}

/// Rewrites the `<autoFilter>` element inside a table part from the
/// declarative snapshot. Excel keeps the table's filter here, spanning the
/// header row through the last data row (the totals band is excluded), with
/// filterColumn/@colId offsets from the table's left edge. `filter: null`
/// (or a snapshot without criteria) leaves the bare element — Clear Filter
/// semantics; a headerless table cannot carry filter buttons, so its element
/// is dropped like the table-add/table-edit paths do.
export function applyTableFilterState(
  tableXml: string,
  route: TableFilterRoute,
  filter: SheetFilterState['filter'],
  preserveUneditable = false,
): string {
  const existing = directAutoFilter(tableXml, 'table')
  if (route.headerRowCount === 0) {
    return existing ? tableXml.slice(0, existing.start) + tableXml.slice(existing.end) : tableXml
  }
  const [root] = childElements(tableXml)
  if (!root) throw new FilterEditError('The table has no root element.')
  const raw = existing ? tableXml.slice(existing.start, existing.end) : ''
  const ref = toRef({ ...route.area, endRow: route.area.endRow - route.totalsRowCount })
  let offset = 0
  if (filter !== null) {
    offset = filter.range.startColumn - route.area.startColumn
    const width = route.area.endColumn - route.area.startColumn + 1
    for (const column of filter.columns) {
      const colId = column.colId + offset
      if (colId < 0 || colId > width - 1) {
        throw new FilterEditError('A filter column falls outside its table and cannot be saved.')
      }
    }
  }
  const element = serializeAutoFilter(
    ref,
    filter?.columns ?? [],
    offset,
    raw,
    filter !== null && preserveUneditable,
    prefixOf(root.name),
  )
  if (existing) {
    return tableXml.slice(0, existing.start) + element + tableXml.slice(existing.end)
  }
  const insertAt = root.start + root.opening.length
  return tableXml.slice(0, insertAt) + element + tableXml.slice(insertAt)
}

function matchesMixedDateFilter(xml: string, column: FilterColumnState): boolean {
  if (column.customs || (column.values === undefined && !column.blank)) return false
  const [element] = childElements(xml)
  const filters = childElements(element?.inner ?? '').find(child => /(?:^|:)filters$/.test(child.name))
  if (!filters) return false
  const items = childElements(filters.inner)
  if (!items.some(child => /(?:^|:)dateGroupItem$/.test(child.name))) return false
  const blank = readWorksheetTagAttribute(filters.opening, 'blank')
  if ((blank === '1' || blank === 'true') !== Boolean(column.blank)) return false
  const saved = new Set(items.flatMap(child => {
    if (!/(?:^|:)filter$/.test(child.name)) return []
    const value = readWorksheetTagAttribute(child.opening, 'val')
    return value === undefined ? [] : [decodeAttribute(value)]
  }))
  const values = new Set(column.values ?? [])
  return values.size === saved.size && [...values].every(value => saved.has(value))
}

function serializeAutoFilter(
  ref: string,
  columns: readonly FilterColumnState[],
  offset: number,
  previous: string,
  preserveUneditable: boolean,
  defaultPrefix = '',
): string {
  const opening = readRootStartTag(previous)
  const prefix = AUTO_FILTER.exec(opening)?.[1] ?? defaultPrefix
  const raw = preserveUneditable ? previous : ''
  const refAttribute = readWorksheetTagAttribute(opening, 'ref')
  const fileRef = refAttribute === undefined ? undefined : decodeAttribute(refAttribute)
  const snapshot = new Map(columns.map(column => [column.colId + offset, column]))
  const entries = new Map(columns.map(column => [column.colId + offset, serializeFilterColumn(column, offset, prefix)]))
  for (const [part, , attrs] of raw.matchAll(FILTER_COLUMN)) {
    if (!OPAQUE_CRITERIA.test(part)) continue
    const id = /(?:^|\s)colId\s*=\s*(?:"(\d+)"|'(\d+)')/.exec(attrs ?? '')
    const colId = Number(id?.[1] ?? id?.[2])
    if (!Number.isSafeInteger(colId))
      throw new FilterEditError('The existing filter column has no valid index.')
    const incoming = snapshot.get(colId)
    // A mixed date filter restores its editable values into the Web snapshot.
    // If those values are unchanged, keep the original column and its dates.
    if (incoming && !matchesMixedDateFilter(part, incoming)) continue
    if (fileRef?.replaceAll('$', '').toUpperCase() !== ref) {
      throw new FilterEditError('Clear the existing advanced filter before changing its range.')
    }
    entries.set(colId, part)
  }
  const body = [...entries]
    .sort(([left], [right]) => left - right)
    .map(([, xml]) => xml)
    .join('')
  // Keep attributes and local namespace declarations from the original wrapper.
  const header = opening
    ? updateWorksheetTagAttribute(opening, 'ref', ref).replace(/\/?\s*>$/, '')
    : `<${prefix}autoFilter ref="${ref}"`
  return body === '' ? `${header}/>` : `${header}>${body}</${prefix}autoFilter>`
}

/// `columnOffset` re-bases wire colIds (relative to the snapshot range's
/// first column) onto the element's own left edge; worksheet snapshots pass 0.
function serializeFilterColumn(
  column: FilterColumnState,
  columnOffset: number,
  prefix: string,
): string {
  const colId = column.colId + columnOffset
  if (colId < 0) {
    throw new FilterEditError('A filter column falls outside its range and cannot be saved.')
  }
  const parts: string[] = []
  if (column.values !== undefined || column.blank) {
    const blank = column.blank ? ' blank="1"' : ''
    const values = (column.values ?? [])
      .map((value) => `<${prefix}filter val="${escapeXmlAttribute(value)}"/>`)
      .join('')
    parts.push(`<${prefix}filters${blank}>${values}</${prefix}filters>`)
  }
  if (column.customs) {
    for (const custom of column.customs.filters) {
      if (custom.operator !== undefined && !CUSTOM_OPERATORS.has(custom.operator)) {
        throw new FilterEditError(
          `Filter condition "${custom.operator}" cannot be saved as XLSX yet.`,
        )
      }
    }
    const and = column.customs.and ? ' and="1"' : ''
    const filters = column.customs.filters
      .map((custom) => {
        const operator =
          custom.operator === undefined || custom.operator === 'equal'
            ? ''
            : ` operator="${custom.operator}"`
        return `<${prefix}customFilter${operator} val="${escapeXmlAttribute(String(custom.val))}"/>`
      })
      .join('')
    parts.push(`<${prefix}customFilters${and}>${filters}</${prefix}customFilters>`)
  }
  if (parts.length === 0) return ''
  return `<${prefix}filterColumn colId="${colId}">${parts.join('')}</${prefix}filterColumn>`
}

/// Schema order places autoFilter after sheetData (and after the protection
/// block when present).
function insertAfterSheetData(worksheetXml: string, element: string): string {
  let insertAt = -1
  for (const pattern of [
    /<sheetData\s*\/>|<\/sheetData>/,
    /<sheetProtection\b[^>]*\/>/,
    /<protectedRanges\b[^>]*\/>|<\/protectedRanges>/,
    /<\/scenarios>/,
  ]) {
    const match = pattern.exec(worksheetXml)
    if (match) insertAt = Math.max(insertAt, match.index + match[0].length)
  }
  if (insertAt < 0) throw new FilterEditError('Worksheet has no sheetData element.')
  return worksheetXml.slice(0, insertAt) + element + worksheetXml.slice(insertAt)
}

/// Declarative row visibility inside the filter's data rows: listed rows are
/// hidden, every other row in the span is unhidden (matching how Excel
/// re-evaluates a filter). The header row is never touched.
function applyRowVisibility(
  worksheetXml: string,
  range: CellArea,
  hiddenRows: ReadonlySet<number>,
  preserveHidden: boolean,
): string {
  const firstDataRow = range.startRow + 1
  const seen = new Set<number>()
  let xml = worksheetXml.replace(
    /<row\b([^>]*?)(\/>|>)/g,
    (full, attributes: string, close: string) => {
      const rowNumber = /(?:^|\s)r="([0-9]+)"/.exec(attributes)?.[1]
      if (rowNumber === undefined) return full
      const rowIndex = Number(rowNumber) - 1
      if (rowIndex < firstDataRow || rowIndex > range.endRow) return full
      seen.add(rowIndex)
      // The Web cannot re-evaluate the retained criteria, so keep rows the
      // file already hid and add the rows hidden by the new snapshot.
      if (preserveHidden && /(?:^|\s)hidden="(?:1|true)"/.test(attributes)) return full
      const withoutHidden = attributes.replace(/\s*hidden="[^"]*"/, '')
      const hidden = hiddenRows.has(rowIndex) ? ' hidden="1"' : ''
      return `<row${withoutHidden}${hidden}${close}`
    },
  )
  const missing = [...hiddenRows]
    .filter(
      (rowIndex) => !seen.has(rowIndex) && rowIndex >= firstDataRow && rowIndex <= range.endRow,
    )
    .sort((left, right) => left - right)
  for (const rowIndex of missing) {
    xml = insertEmptyHiddenRow(xml, rowIndex + 1)
  }
  return xml
}

function insertEmptyHiddenRow(worksheetXml: string, rowNumber: number): string {
  const newRow = `<row r="${rowNumber}" hidden="1"/>`
  const rowStartPattern = /<row\b[^>]*?\br="([1-9][0-9]*)"/g
  let match: RegExpExecArray | null
  while ((match = rowStartPattern.exec(worksheetXml)) !== null) {
    if (Number(match[1]) > rowNumber) {
      return worksheetXml.slice(0, match.index) + newRow + worksheetXml.slice(match.index)
    }
  }
  if (worksheetXml.includes('</sheetData>')) {
    return worksheetXml.replace('</sheetData>', () => `${newRow}</sheetData>`)
  }
  const emptySheetData = /<sheetData\s*\/>/
  if (emptySheetData.test(worksheetXml)) {
    return worksheetXml.replace(emptySheetData, () => `<sheetData>${newRow}</sheetData>`)
  }
  throw new FilterEditError('Worksheet has no sheetData element.')
}

function toRef(range: CellArea): string {
  return (
    `${columnToLetters(range.startColumn)}${range.startRow + 1}` +
    `:${columnToLetters(range.endColumn)}${range.endRow + 1}`
  )
}

function columnToLetters(column: number): string {
  let letters = ''
  let remaining = column + 1
  while (remaining > 0) {
    remaining -= 1
    letters = String.fromCharCode(65 + (remaining % 26)) + letters
    remaining = Math.floor(remaining / 26)
  }
  return letters
}

function escapeXmlAttribute(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
