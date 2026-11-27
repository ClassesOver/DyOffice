/// Writes a declarative filter snapshot into worksheet XML: the
/// `<autoFilter>` element (with per-column value / custom criteria) plus row
/// visibility inside the filter's row span. Unsupported criteria fail closed.
/// A filter whose range sits inside an Excel table is routed into the table
/// part instead (Excel stores table filters there, never on the worksheet) —
/// see `applyTableFilterState` and `applyRowVisibilityState`.

import { childElements } from './xlsx-style-entries'
import {
  inferWorksheetAddresses, omitWorksheetTagAttributes, updateWorksheetTagAttribute, worksheetChildren,
  worksheetData, worksheetRowPositions,
} from './xlsx-structure'
import { isElement, prefixOf, scopedChildren, withBody, withNamespaces, type ScopedElement } from './xlsx-worksheet-xml'
import { readRootOpening } from './xlsx-namespace'

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

const opaqueCriteria = new Set(['top10', 'dynamicFilter', 'colorFilter', 'iconFilter', 'extLst'])

function scopedRoot(xml: string): ScopedElement | undefined {
  const [root] = childElements(xml)
  return root && withNamespaces(root, new Map())
}

function filterColumns(filter: ScopedElement | undefined): ScopedElement[] {
  return filter ? scopedChildren(filter).filter((child) => isElement(child, 'filterColumn', filter.namespace)) : []
}

function isOpaqueColumn(column: ScopedElement): boolean {
  return scopedChildren(column).some((child) => child.namespace === column.namespace &&
    (opaqueCriteria.has(child.local) || (child.local === 'filters' &&
      scopedChildren(child).some((item) => isElement(item, 'dateGroupItem', child.namespace)))))
}

export function hasUneditableAutoFilter(xml: string, root?: 'table'): boolean {
  const element = scopedRoot(xml)
  const filter = root && element
    ? scopedChildren(element).find((child) => isElement(child, 'autoFilter', element.namespace))
    : element
  return filterColumns(filter).some(isOpaqueColumn)
}

export function applyFilterState(worksheetXml: string, state: SheetFilterState): string {
  const children = worksheetChildren(worksheetXml)
  const existing = children.find((child) => child.local === 'autoFilter')
  const element =
    state.filter === null
      ? ''
      : serializeAutoFilter(
          toRef(state.filter.range),
          state.filter.columns,
          0,
          existing,
          state.preserveUneditable === true,
          prefixOf(readRootOpening(worksheetXml)?.name ?? ''),
        )
  let xml = worksheetXml
  if (existing) {
    xml = worksheetXml.slice(0, existing.start) + element + worksheetXml.slice(existing.start + existing.xml.length)
  } else if (element !== '') {
    xml = insertAfterSheetData(worksheetXml, children, element)
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
  const root = scopedRoot(tableXml)
  if (!root) throw new FilterEditError('The table has no root element.')
  const existing = scopedChildren(root).find((child) => isElement(child, 'autoFilter', root.namespace))
  const start = root.start + root.opening.length
  const replace = (element: string) => {
    const at = start + (existing?.start ?? 0)
    return tableXml.slice(0, at) + element + tableXml.slice(at + (existing?.xml.length ?? 0))
  }
  if (route.headerRowCount === 0) return replace('')
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
    existing,
    filter !== null && preserveUneditable,
    prefixOf(root.name),
  )
  return replace(element)
}

function matchesMixedDateFilter(element: ScopedElement, column: FilterColumnState): boolean {
  if (column.customs || (column.values === undefined && !column.blank)) return false
  const filters = scopedChildren(element).find((child) => isElement(child, 'filters', element.namespace))
  if (!filters) return false
  const items = scopedChildren(filters)
  if (!items.some(child => isElement(child, 'dateGroupItem', filters.namespace))) return false
  const blank = filters.attributes.get('blank')
  if ((blank === '1' || blank === 'true') !== Boolean(column.blank)) return false
  const saved = new Set(items.flatMap(child => {
    if (!isElement(child, 'filter', filters.namespace)) return []
    const value = child.attributes.get('val')
    return value === undefined ? [] : [value]
  }))
  const values = new Set(column.values ?? [])
  return values.size === saved.size && [...values].every(value => saved.has(value))
}

function serializeAutoFilter(
  ref: string,
  columns: readonly FilterColumnState[],
  offset: number,
  previous: ScopedElement | undefined,
  preserveUneditable: boolean,
  defaultPrefix = '',
): string {
  const opening = previous?.opening
  const prefix = prefixOf(previous?.name ?? defaultPrefix + 'autoFilter')
  const fileRef = previous?.attributes.get('ref')?.replaceAll('$', '').toUpperCase()
  const snapshot = new Map(columns.map(column => [column.colId + offset, column]))
  const entries = new Map(columns.map(column => [column.colId + offset, serializeFilterColumn(column, offset, prefix)]))
  for (const column of preserveUneditable ? filterColumns(previous) : []) {
    if (!isOpaqueColumn(column)) continue
    const id = column.attributes.get('colId')
    const colId = id !== undefined && /^\d+$/.test(id) ? Number(id) : NaN
    if (!Number.isSafeInteger(colId))
      throw new FilterEditError('The existing filter column has no valid index.')
    const incoming = snapshot.get(colId)
    // A mixed date filter restores its editable values into the Web snapshot.
    // If those values are unchanged, keep the original column and its dates.
    if (incoming && !matchesMixedDateFilter(column, incoming)) continue
    if (fileRef !== ref) {
      throw new FilterEditError('Clear the existing advanced filter before changing its range.')
    }
    entries.set(colId, column.xml)
  }
  let retained = previous?.inner ?? ''
  if (previous) {
    for (const child of scopedChildren(previous).reverse()) {
      if (isElement(child, 'filterColumn', previous.namespace) ||
        (fileRef !== ref && isElement(child, 'sortState', previous.namespace))) {
        retained = retained.slice(0, child.start) + retained.slice(child.start + child.xml.length)
      }
    }
  }
  const body = [...entries]
    .sort(([left], [right]) => left - right)
    .map(([, xml]) => xml)
    .join('') + retained
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
function insertAfterSheetData(worksheetXml: string, children: ScopedElement[], element: string): string {
  const data = children.find((child) => child.local === 'sheetData')
  if (!data) throw new FilterEditError('Worksheet has no sheetData element.')
  const preceding = ['sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios']
  const anchor = children.reverse().find((child) => preceding.includes(child.local)) ?? data
  const at = anchor.start + anchor.xml.length
  return worksheetXml.slice(0, at) + element + worksheetXml.slice(at)
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
  const xml = inferWorksheetAddresses(worksheetXml)
  const data = worksheetData(xml)
  const firstDataRow = range.startRow + 1
  const missing = new Set([...hiddenRows].filter((row) => row >= firstDataRow && row <= range.endRow))
  if (!data) {
    if (missing.size) throw new FilterEditError('Worksheet has no sheetData element.')
    return worksheetXml
  }
  const rows = [...worksheetRowPositions(data)]
  for (const { rowNumber } of rows) missing.delete(rowNumber - 1)
  const pending = [...missing].sort((left, right) => left - right)
  const parts: string[] = []
  const qualifier = prefixOf(data.name)
  let cursor = 0
  let next = 0
  const insertBefore = (rowIndex: number, offset: number) => {
    while (next < pending.length && pending[next]! < rowIndex) {
      parts.push(data.inner.slice(cursor, offset), `<${qualifier}row r="${pending[next]! + 1}" hidden="1"/>`)
      cursor = offset
      next += 1
    }
  }
  for (const { row, rowNumber } of rows) {
    const index = rowNumber - 1
    insertBefore(index, row.start)
    if (index < firstDataRow || index > range.endRow) continue
    const hidden = row.attributes.get('hidden')
    if (preserveHidden && (hidden === '1' || hidden === 'true')) continue
    const kept = omitWorksheetTagAttributes(row.opening, ['hidden'])
    const opening = hiddenRows.has(index)
      ? kept.replace(/(\s*\/?>)$/, (_end, suffix) => ' hidden="1"' + suffix)
      : kept
    if (opening === row.opening) continue
    parts.push(data.inner.slice(cursor, row.start), opening)
    cursor = row.start + row.opening.length
  }
  insertBefore(range.endRow + 1, data.inner.length)
  if (!parts.length) return xml
  const body = parts.join('') + data.inner.slice(cursor)
  return xml.slice(0, data.start) + withBody(data, body) + xml.slice(data.start + data.xml.length)
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
