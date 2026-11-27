/// PivotTable definition reader: parses a pivotTable part plus its
/// pivotCacheDefinition into the layout/fields model the recompute engine
/// consumes. Anything outside the supported envelope lands in `unsupported`
/// (with a reason) instead of producing a silently wrong refresh.

import type { PivotFilterDef, PivotValueFilter } from '../domain/pivot-filters.ts'
import { parsePivotFormula } from '../domain/pivot-formula.ts'
import { isValidGrouping, type PivotFieldGrouping } from '../domain/pivot-grouping.ts'
import {
  isPivotAggregation,
  PIVOT_BASE_ITEM_NEXT,
  PIVOT_BASE_ITEM_PREVIOUS,
  showDataAsFromOoxml,
  showDataAsNeedsBaseField,
  showDataAsNeedsBaseItem,
  type PivotShowDataAs,
} from '../domain/pivot-value-modes.ts'

import { MAX_GRID_COLUMNS, MAX_GRID_ROWS } from '../shared/grid-bounds.ts'
import { workbookDefinedNameElements } from './xlsx-defined-names.ts'
import type { MutablePackage } from './xlsx-drawing-add.ts'
import { resolveWorkbookSheetTarget } from './xlsx-workbook-parts.ts'
import { decodeXmlText } from './xlsx-escapes.ts'
import { readRootOpening, readRootStartTag } from './xlsx-namespace.ts'
import { localPivotWorksheetSource, parseRelationships, parseSheetElements, parseWorkbookTabIndex, relationshipIdsMatch, tablePartNames } from './xlsx-sheets.ts'
import { readDefinedNameText, readWorksheetTagAttribute, updateWorksheetTagAttribute } from './xlsx-structure.ts'
import { areaToRef, parseRef, sheetTableParts } from './xlsx-table-add.ts'
import { isElement, scopedChildren, spreadsheetPartRoot, type ScopedElement } from './xlsx-worksheet-xml.ts'

export class PivotParseError extends Error {}

export type { PivotFieldGrouping } from '../domain/pivot-grouping.ts'
export type { PivotFilterDef, PivotLabelFilter, PivotValueFilter } from '../domain/pivot-filters.ts'

export type PivotSharedItem = string | number | boolean | null

export interface PivotFieldItem {
  /// sharedItems index; null for subtotal/function items.
  readonly x: number | null
  readonly hidden: boolean
}

export interface PivotCacheField {
  readonly name: string
  readonly sharedItems: readonly PivotSharedItem[]
  /// Grouped field (date/numeric ranges): when present, sharedItems are group
  /// labels, and refresh groups raw source values before matching. Stored in our
  /// private pivotTable extLst extension (real <fieldGroup> OOXML persistence: see
  /// the TODO in pivot-grouping).
  readonly grouping?: PivotFieldGrouping | undefined
  /// Calculated field (cacheField@formula): not a source data column, takes no
  /// cache records; value is computed by the formula over the grouped aggregates
  /// of other fields (see pivot-formula).
  readonly formula?: string | undefined
}

export interface PivotLayoutLine {
  /// 'data' rows/cols carry members; 'default' = subtotal, 'grand' = total.
  readonly t: string
  /// members fixed by this line: pivotField item index per axis level,
  /// already propagated across the r-attribute repeats.
  readonly members: readonly (number | null)[]
  /// how many leading axis levels the line fixes (subtotal depth).
  readonly depth: number
  /// data-field index this line renders (multi-value pivots).
  readonly dataField: number
}

export type { PivotShowDataAs } from '../domain/pivot-value-modes.ts'

export interface PivotDataField {
  readonly name: string
  readonly field: number
  readonly subtotal: string
  /// "Show values as" mode; undefined = normal (show the aggregate directly).
  readonly showDataAs?: PivotShowDataAs | undefined
  /// Base field index of the "show values as" calculation (cache-field index,
  /// dataField@baseField); present for the base-field modes.
  readonly baseField?: number | undefined
  /// Base item index within the base field's items (dataField@baseItem);
  /// present for difference / percentDiff / percentOf.
  readonly baseItem?: number | undefined
  /// Formula of a calculated field (present when field points at a cacheField
  /// with a formula): each group first SUMs the referenced source fields, then
  /// evaluates the formula.
  readonly formula?: string | undefined
}

export interface PivotDefinition {
  readonly outputRef: string
  readonly firstDataRow: number
  readonly firstDataCol: number
  readonly fields: readonly PivotCacheField[]
  /// per cache field: axis items (empty for pure data fields).
  readonly fieldItems: readonly (readonly PivotFieldItem[])[]
  /// cache-field indexes; -2 marks the data-field position.
  readonly rowFields: readonly number[]
  readonly colFields: readonly number[]
  readonly rowLines: readonly PivotLayoutLine[]
  readonly colLines: readonly PivotLayoutLine[]
  readonly dataFields: readonly PivotDataField[]
  /// page (report-filter) selections: sharedItems index or null for "all".
  readonly pageFields: readonly { readonly field: number; readonly item: number | null }[]
  /// Value/label filters (pivotFilters): members that fail the filter are hidden
  /// entries in fieldItems; refresh re-applies them against the source data
  /// (value filters aggregate first, then filter).
  readonly filters: readonly PivotFilterDef[]
  readonly sourceSheet: string
  readonly sourceRef: string
  /// reasons this pivot cannot be recomputed; empty = refresh supported.
  readonly unsupported: readonly string[]
}

function pivotRoot(xml: string, name: string): ScopedElement | null {
  const root = spreadsheetPartRoot(xml)
  return root?.local === name ? root : null
}

function attr(element: ScopedElement, name: string): string | null {
  return element.attributes.get(name) ?? null
}

function elements(scope: ScopedElement | null, tag: string): ScopedElement[] {
  return scope ? scopedChildren(scope).filter((child) => isElement(child, tag, scope.namespace)) : []
}

function firstElement(scope: ScopedElement | null, tag: string): ScopedElement | null {
  return elements(scope, tag)[0] ?? null
}

function parseSharedItems(cacheField: ScopedElement): PivotSharedItem[] {
  const container = firstElement(cacheField, 'sharedItems')
  if (!container) return []
  const items: PivotSharedItem[] = []
  for (const item of scopedChildren(container)) {
    if (item.namespace !== container.namespace) continue
    const value = attr(item, 'v')
    switch (item.local) {
      case 's':
      case 'd':
        items.push(value ?? '')
        break
      case 'n':
        items.push(Number(value ?? '0'))
        break
      case 'b':
        items.push(value === '1' || value === 'true')
        break
      case 'm':
        items.push(null)
        break
      case 'e':
        items.push(value ?? '#ERROR')
        break
    }
  }
  return items
}

function readFieldItems(field: ScopedElement): PivotFieldItem[] {
  const source = elements(firstElement(field, 'items'), 'item')
  let lastData = -1
  const items = source.map((item, index) => {
    const type = attr(item, 't')
    if (type !== null && type !== 'data') return { x: null, hidden: false }
    lastData = index
    const shared = attr(item, 'x')
    const hidden = attr(item, 'h')
    return { x: shared === null ? null : Number(shared), hidden: hidden === '1' || hidden === 'true' }
  })
  // Row, column and report-filter selections address positions in the XML
  // list. Non-data items before the last member must leave a slot.
  return items.slice(0, lastData + 1)
}

function parseLayoutLines(containerXml: ScopedElement | null, axisFieldCount: number): PivotLayoutLine[] {
  if (!containerXml) {
    // No axis fields: the implicit single line covers everything.
    return [{ t: 'data', members: [], depth: 0, dataField: 0 }]
  }
  const lines: PivotLayoutLine[] = []
  const current: (number | null)[] = new Array(axisFieldCount).fill(null)
  let currentDataField = 0
  for (const line of elements(containerXml, 'i')) {
    const t = attr(line, 't') ?? 'data'
    const repeat = Number(attr(line, 'r') ?? '0')
    const values = elements(line, 'x').map((x) => Number(attr(x, 'v') ?? '0'))
    values.forEach((value, offset) => {
      current[repeat + offset] = value
    })
    const depth = repeat + values.length
    // Levels past the line's depth are stale carries; a data line fixes all.
    for (let level = depth; level < axisFieldCount; level += 1) {
      if (t !== 'data') current[level] = null
    }
    const explicitDataField = attr(line, 'i')
    if (explicitDataField !== null) currentDataField = Number(explicitDataField)
    lines.push({
      t,
      members: [...current],
      depth: t === 'grand' ? 0 : depth,
      dataField: currentDataField,
    })
  }
  return lines
}

/// Marks a pivotCacheDefinition so Excel rebuilds the cache on open — the
/// recomputed output cells and the stale cacheRecords then re-converge.
export function setPivotRefreshOnLoad(cacheDefinitionXml: string): string {
  const root = readRootOpening(cacheDefinitionXml)
  if (!root || root.name.slice(root.name.lastIndexOf(':') + 1) !== 'pivotCacheDefinition') {
    throw new PivotParseError('pivotCacheDefinition part has no root element.')
  }
  const updated = updateWorksheetTagAttribute(root.opening, 'refreshOnLoad', '1')
  return (
    cacheDefinitionXml.slice(0, root.start) +
    updated +
    cacheDefinitionXml.slice(root.start + root.opening.length)
  )
}

type PivotWorkbookSource = Pick<MutablePackage, 'has' | 'readText'>
type PivotSourceRange = Pick<PivotDefinition, 'sourceSheet' | 'sourceRef'>
interface ResolvedPivotSource {
  readonly sourceSheet: string
  readonly sourceRef?: string
}

export async function readPivotDefinitionWithSource(
  pivotXml: string,
  cacheXml: string,
  workbook: PivotWorkbookSource,
): Promise<PivotDefinition> {
  const attributes = localPivotWorksheetSource(cacheXml)?.element.attributes
  const name = attributes?.get('name')
  const range = name ? await resolveNamedSource(workbook, name, attributes?.get('sheet')) : undefined
  return parsePivotDefinition(pivotXml, cacheXml, range?.sourceRef
    ? { sourceSheet: range.sourceSheet, sourceRef: range.sourceRef }
    : undefined)
}

export async function readPivotSourceSheetNames(
  cacheXml: string,
  workbook: PivotWorkbookSource,
  workbookXml: string,
): Promise<string[]> {
  const attributes = localPivotWorksheetSource(cacheXml)?.element.attributes
  const sheet = attributes?.get('sheet')
  const name = attributes?.get('name')
  const resolved = name ? await resolveNamedSource(workbook, name, sheet, workbookXml) : undefined
  return [sheet, resolved?.sourceSheet].filter((value): value is string => !!value)
}

interface PivotSourceSheet {
  readonly name: string
  readonly index: number
  readonly path: string
}

async function resolveNamedSource(
  workbook: PivotWorkbookSource,
  name: string,
  sheetHint: string | undefined,
  currentWorkbookXml?: string,
): Promise<ResolvedPivotSource | undefined> {
  const key = name.toLowerCase()
  const [workbookXml, relsXml] = await Promise.all([
    currentWorkbookXml ?? workbook.readText('xl/workbook.xml'),
    workbook.readText('xl/_rels/workbook.xml.rels'),
  ])
  const relationships = parseRelationships(relsXml).filter((relationship) =>
    !relationship.external && relationship.type.endsWith('/worksheet'),
  )
  const sheets = parseSheetElements(workbookXml).flatMap((sheet, index): PivotSourceSheet[] => {
    const relationship = relationships.find(({ id }) => relationshipIdsMatch(id, sheet.relationshipId))
    return relationship ? [{ name: sheet.name, index,
      path: resolveWorkbookSheetTarget(relationship.target) }] : []
  })
  const hint = sheetHint?.toLowerCase()
  const candidates = hint ? sheets.filter((sheet) => sheet.name.toLowerCase() === hint) : sheets
  if (hint && candidates.length !== 1) return undefined
  const table = await resolveTableSource(workbook, key, candidates)
  if (table !== undefined) return table ?? undefined
  return resolveDefinedNameSource(workbook, workbookXml, key, sheets, hint ? candidates[0]?.index : undefined)
}

async function resolveTableSource(
  workbook: PivotWorkbookSource,
  key: string,
  sheets: readonly PivotSourceSheet[],
): Promise<ResolvedPivotSource | null | undefined> {
  let found: ResolvedPivotSource | undefined
  for (const sheet of sheets) {
    const { path } = sheet
    if (!(await workbook.has(path))) continue
    for (const table of await sheetTableParts(workbook, path)) {
      if (!tablePartNames(table.xml).some((candidate) => candidate.toLowerCase() === key)) continue
      if (found) return null
      // Ownership is useful to structural edits even for a table that cannot
      // supply a valid grid of headers and data to the refresh engine.
      found = { sourceSheet: sheet.name }
      const sourceRef = readTablePivotSourceRef(table.xml)
      if (sourceRef) found = { sourceSheet: sheet.name, sourceRef }
    }
  }
  return found
}

export function readTablePivotSourceRef(tableXml: string): string | undefined {
  const opening = readRootStartTag(tableXml)
  const headers = Number(decodeXmlText(readWorksheetTagAttribute(opening, 'headerRowCount') ?? '1'))
  const totals = Number(decodeXmlText(readWorksheetTagAttribute(opening, 'totalsRowCount') ?? '0'))
  const ref = readWorksheetTagAttribute(opening, 'ref')
  if (headers !== 1 || !Number.isSafeInteger(totals) || totals < 0 || !ref) return undefined
  try {
    const area = parseRef(decodeXmlText(ref))
    const endRow = area.endRow - totals
    if (endRow > area.startRow && area.endColumn >= area.startColumn &&
      area.startRow >= 0 && area.endRow < MAX_GRID_ROWS && area.endColumn < MAX_GRID_COLUMNS) {
      return areaToRef({ ...area, endRow })
    }
  } catch {
    // An unreadable range still belongs to its named table's worksheet.
  }
  return undefined
}

async function resolveDefinedNameSource(
  workbook: PivotWorkbookSource,
  workbookXml: string,
  key: string,
  sheets: readonly PivotSourceSheet[],
  sheetIndex: number | undefined,
): Promise<ResolvedPivotSource | undefined> {
  const matches = workbookDefinedNameElements(workbookXml).filter(
    (entry) => entry.attributes.get('name')?.toLowerCase() === key,
  )
  const local = sheetIndex === undefined ? [] : matches.filter(
    (entry) => parseWorkbookTabIndex(entry.attributes.get('localSheetId')) === sheetIndex,
  )
  const candidates = local.length > 0 ? local : matches.filter((entry) => !entry.attributes.has('localSheetId'))
  const [entry] = candidates
  if (candidates.length !== 1 || !entry) return undefined
  const formula = readDefinedNameText(entry.inner)?.trim().replace(/^=/, '')
  // Use one absolute rectangle on a local worksheet; evaluating a formula,
  // union or relative name would require context the cache does not store.
  const absoluteRange = /^(?:'((?:[^']|'')+)'|([\p{L}\p{N}_.]+))!(\$[A-Z]{1,3}\$[1-9]\d*:\$[A-Z]{1,3}\$[1-9]\d*)$/iu
  const match = formula && absoluteRange.exec(formula)
  if (!match?.[3]) return undefined
  const qualifier = (match[1] ?? match[2] ?? '').replaceAll("''", "'").toLowerCase()
  const sheet = sheets.find((candidate) => candidate.name.toLowerCase() === qualifier)
  if (!sheet || !(await workbook.has(sheet.path))) return undefined
  const area = parseRef(match[3].toUpperCase())
  if (area.endRow <= area.startRow || area.endColumn < area.startColumn ||
    area.endRow >= MAX_GRID_ROWS || area.endColumn >= MAX_GRID_COLUMNS) return { sourceSheet: sheet.name }
  return { sourceSheet: sheet.name, sourceRef: areaToRef(area) }
}

function numericFilterValue(element: ScopedElement | null): number {
  const value = element?.attributes.get('val')?.trim()
  return value ? Number(value) : Number.NaN
}

function readValueFilter(
  filter: ScopedElement,
  type: string,
  field: number,
  dataField: number,
): PivotValueFilter | undefined {
  const columns = elements(firstElement(filter, 'autoFilter'), 'filterColumn')
  const [column] = columns
  if (columns.length !== 1 || !column) return undefined
  if (type === 'count') {
    const top10 = firstElement(column, 'top10')
    const count = numericFilterValue(top10)
    const top = top10?.attributes.get('top') ?? 'true'
    const percent = top10?.attributes.get('percent') ?? 'false'
    if (Number.isInteger(count) && count >= 1 &&
      (top === 'true' || top === '1') && (percent === 'false' || percent === '0')) {
      return { kind: 'value', field, dataField, op: 'top', count }
    }
    return undefined
  }

  const custom = firstElement(column, 'customFilters')
  const conditions = elements(custom, 'customFilter')
  const [condition] = conditions
  if (type === 'valueGreaterThan' && conditions.length === 1 &&
    condition?.attributes.get('operator') === 'greaterThan') {
    const from = numericFilterValue(condition)
    if (Number.isFinite(from)) return { kind: 'value', field, dataField, op: 'greaterThan', from }
  }
  const conjunction = custom?.attributes.get('and')
  if (type === 'valueBetween' && conditions.length === 2 &&
    (conjunction === 'true' || conjunction === '1')) {
    const from = numericFilterValue(conditions.find((entry) =>
      attr(entry, 'operator') === 'greaterThanOrEqual',
    ) ?? null)
    const to = numericFilterValue(conditions.find((entry) =>
      attr(entry, 'operator') === 'lessThanOrEqual',
    ) ?? null)
    if (Number.isFinite(from) && Number.isFinite(to)) {
      return { kind: 'value', field, dataField, op: 'between', from, to }
    }
  }
  return undefined
}

export function parsePivotDefinition(
  pivotTableXml: string,
  cacheDefinitionXml: string,
  resolvedSource?: PivotSourceRange,
): PivotDefinition {
  const unsupported: string[] = []

  const table = pivotRoot(pivotTableXml, 'pivotTableDefinition')
  const cache = pivotRoot(cacheDefinitionXml, 'pivotCacheDefinition')
  const location = firstElement(table, 'location')
  if (!location) throw new PivotParseError('pivotTable part has no location element.')
  const outputRef = attr(location, 'ref')
  if (!outputRef) throw new PivotParseError('pivotTable location has no ref.')
  const firstDataRow = Number(attr(location, 'firstDataRow') ?? '1')
  const firstDataCol = Number(attr(location, 'firstDataCol') ?? '1')

  const source = localPivotWorksheetSource(cacheDefinitionXml)?.element.attributes
  const named = !!source?.get('name')
  const sourceSheet = resolvedSource?.sourceSheet ?? (named ? '' : source?.get('sheet') ?? '')
  const sourceRef = resolvedSource?.sourceRef ?? (named ? '' : source?.get('ref') ?? '')
  if (!source) {
    unsupported.push('the data source is not a worksheet range (external/consolidated source)')
  } else if (!sourceSheet || !sourceRef) {
    unsupported.push('the named data source could not be resolved to a local table or fixed worksheet range')
  }

  // Our own grouped-field metadata: stored in a private pivotTable extLst
  // extension (fieldIndex → grouping rule). Corrupt/invalid metadata fails closed.
  const groupingByField = new Map<number, PivotFieldGrouping>()
  const groupingExt = elements(firstElement(table, 'extLst'), 'ext').find(
    (extension) => attr(extension, 'uri') === '{AIO-PIVOT-GROUPINGS}',
  )
  const grouping = groupingExt && scopedChildren(groupingExt).find(
    (child) => isElement(child, 'aioPivotGroupings', 'urn:aioffice:pivot'),
  )
  if (groupingExt) {
    try {
      const entries = JSON.parse(grouping?.attributes.get('v') ?? '') as unknown
      if (!Array.isArray(entries)) throw new Error('not an array')
      for (const entry of entries) {
        const { fieldIndex, ...grouping } = entry as { fieldIndex?: unknown }
        if (typeof fieldIndex !== 'number' || !isValidGrouping(grouping)) {
          throw new Error('bad grouping entry')
        }
        groupingByField.set(fieldIndex, grouping)
      }
    } catch {
      unsupported.push('grouped-field extension metadata cannot be parsed')
    }
  }

  const cacheFieldsBlock = firstElement(cache, 'cacheFields')
  const cacheFields = elements(cacheFieldsBlock, 'cacheField')
  // Calculated fields (cacheField@formula): strip the optional leading = and
  // validate against source field names.
  const formulaByField = new Map<number, string>()
  cacheFields.forEach((fieldXml, index) => {
    const formula = attr(fieldXml, 'formula')
    if (formula !== null) formulaByField.set(index, formula.replace(/^\s*=/, ''))
  })
  const fields: PivotCacheField[] = cacheFields.map((fieldXml, index) => ({
    name: attr(fieldXml, 'name') ?? '',
    sharedItems: parseSharedItems(fieldXml),
    ...(groupingByField.has(index) ? { grouping: groupingByField.get(index)! } : {}),
    ...(formulaByField.has(index) ? { formula: formulaByField.get(index)! } : {}),
  }))
  // Calculated-field formulas must parse and may only reference non-calculated
  // source fields (chained references are unsupported).
  const sourceFieldNames = fields
    .filter((_, index) => !formulaByField.has(index))
    .map((field) => field.name)
  for (const [index, formula] of formulaByField) {
    // The refresh engine assumes cache-field index == source column index:
    // calculated fields must come after all source fields (Excel also appends
    // them at the end); otherwise fail closed.
    if (index < sourceFieldNames.length) {
      unsupported.push(
        `calculated field "${fields[index]?.name}" does not come after the source fields, recompute not supported`,
      )
      continue
    }
    try {
      parsePivotFormula(formula, sourceFieldNames)
    } catch (error) {
      unsupported.push(
        `the formula of calculated field "${fields[index]?.name}" does not support recompute` +
          ` (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }
  cacheFields.forEach((fieldXml, index) => {
    // <fieldGroup> grouping from external (Excel-created) files is still
    // unsupported: we cannot reliably rebuild the semantics of its groupItems and
    // par/base chain; our own grouping goes through extLst metadata.
    if (firstElement(fieldXml, 'fieldGroup') !== null) {
      unsupported.push(`grouped field "${fields[index]?.name}" does not support recompute`)
    }
  })

  const pivotFieldsBlock = firstElement(table, 'pivotFields')
  const pivotFields = elements(pivotFieldsBlock, 'pivotField')
  const fieldItems = pivotFields.map(readFieldItems)

  const readAxis = (tag: string): number[] => {
    const block = firstElement(table, tag)
    if (!block) return []
    return elements(block, 'field').map((field) => Number(attr(field, 'x') ?? '0'))
  }
  const rowFields = readAxis('rowFields')
  const colFields = readAxis('colFields')

  const dataFieldsBlock = firstElement(table, 'dataFields')
  const dataFields: PivotDataField[] = elements(dataFieldsBlock, 'dataField').map((fieldXml) => {
    // showDataAs="normal" (or absent) = normal display, not recorded; the file
    // spelling "percent" maps to our "% Of…" mode. Unsupported display modes
    // only record an unsupported reason, and the mode itself is not carried
    // over (the IPC schema only accepts supported enum values).
    const ooxmlMode = attr(fieldXml, 'showDataAs')
    const showDataAs =
      ooxmlMode === null || ooxmlMode === 'normal' ? null : showDataAsFromOoxml(ooxmlMode)
    if (ooxmlMode !== null && ooxmlMode !== 'normal' && showDataAs === null) {
      unsupported.push(`"show values as" mode "${ooxmlMode}" does not support recompute`)
    }
    const field = Number(attr(fieldXml, 'fld') ?? '0')
    const dataFieldName = attr(fieldXml, 'name') ?? ''
    // Base-field modes: the base field must be a row/column axis field and the
    // base item a concrete member of it — Excel's "(previous)"/"(next)" special
    // values and anything out of range fail closed.
    let baseField: number | undefined
    let baseItem: number | undefined
    if (showDataAs !== null && showDataAsNeedsBaseField(showDataAs)) {
      const candidateField = attr(fieldXml, 'baseField')
      const parsedField = candidateField === null ? null : Number(candidateField)
      const baseFieldOk =
        parsedField !== null &&
        Number.isInteger(parsedField) &&
        fields[parsedField] !== undefined &&
        (rowFields.includes(parsedField) || colFields.includes(parsedField))
      if (!baseFieldOk) {
        unsupported.push(
          `the base field of data field "${dataFieldName}" does not support recompute`,
        )
      } else {
        baseField = parsedField
        if (showDataAsNeedsBaseItem(showDataAs)) {
          const parsedItem = attr(fieldXml, 'baseItem')
          const item = parsedItem === null ? null : Number(parsedItem)
          if (item === PIVOT_BASE_ITEM_PREVIOUS || item === PIVOT_BASE_ITEM_NEXT) {
            unsupported.push(
              `the "(previous)"/"(next)" base item of data field "${dataFieldName}" does not support recompute`,
            )
          } else if (
            item === null ||
            !Number.isInteger(item) ||
            item < 0 ||
            fieldItems[parsedField!]?.[item]?.x == null
          ) {
            unsupported.push(
              `the base item of data field "${dataFieldName}" does not support recompute`,
            )
          } else {
            baseItem = item
          }
        }
      }
    }
    return {
      name: dataFieldName,
      field,
      subtotal: attr(fieldXml, 'subtotal') ?? 'sum',
      ...(showDataAs !== null ? { showDataAs } : {}),
      ...(baseField !== undefined ? { baseField } : {}),
      ...(baseItem !== undefined ? { baseItem } : {}),
      // Data fields pointing at a calculated field carry the formula; refresh
      // evaluates it.
      ...(formulaByField.has(field) ? { formula: formulaByField.get(field)! } : {}),
    }
  })
  for (const dataField of dataFields) {
    if (!isPivotAggregation(dataField.subtotal)) {
      unsupported.push(`aggregation "${dataField.subtotal}" does not support recompute`)
    }
  }
  if (dataFields.length === 0) unsupported.push('this pivot table has no data fields')

  const pageFieldsBlock = firstElement(table, 'pageFields')
  const pageFields = elements(pageFieldsBlock, 'pageField').map(
    (fieldXml) => {
      const item = attr(fieldXml, 'item')
      return {
        field: Number(attr(fieldXml, 'fld') ?? '0'),
        item: item === null ? null : Number(item),
      }
    },
  )

  // Calculated fields may only be data fields: used as a row/column/report-filter
  // dimension they cannot be grouped by formula.
  for (const [index] of formulaByField) {
    if (
      rowFields.includes(index) ||
      colFields.includes(index) ||
      pageFields.some((page) => page.field === index)
    ) {
      unsupported.push(
        `calculated field "${fields[index]?.name}" is used as a dimension, recompute not supported`,
      )
    }
  }

  // Value/label filters (pivotFilters): supports label equals/contains/begins-with
  // plus top N (top10)/greater-than/between; other types (date filters, bottom N,
  // percent…) still fail closed. Filtered-out members are also hidden entries, and
  // refresh drops them via the hidden semantics.
  const LABEL_FILTER_OPS: Record<string, 'equal' | 'contains' | 'beginsWith'> = {
    captionEqual: 'equal',
    captionContains: 'contains',
    captionBeginsWith: 'beginsWith',
  }
  const filters: PivotFilterDef[] = []
  const filtersBlock = firstElement(table, 'filters')
  for (const filterXml of elements(filtersBlock, 'filter')) {
    const type = attr(filterXml, 'type') ?? ''
    const field = Number(attr(filterXml, 'fld') ?? '0')
    const dataField = Number(attr(filterXml, 'iMeasureFld') ?? '0')
    const labelOp = LABEL_FILTER_OPS[type]
    if (labelOp !== undefined) {
      filters.push({
        kind: 'label',
        field,
        op: labelOp,
        value: attr(filterXml, 'stringValue1') ?? '',
      })
      continue
    }
    const valueFilter = readValueFilter(filterXml, type, field, dataField)
    if (valueFilter) filters.push(valueFilter)
    else unsupported.push(
      `value/label filter (pivotFilters) type "${type}" does not support recompute`,
    )
  }

  return {
    outputRef,
    firstDataRow,
    firstDataCol,
    fields,
    fieldItems,
    rowFields,
    colFields,
    rowLines: parseLayoutLines(firstElement(table, 'rowItems'), rowFields.length),
    colLines: parseLayoutLines(firstElement(table, 'colItems'), colFields.length),
    dataFields,
    pageFields,
    filters,
    sourceSheet,
    sourceRef,
    unsupported,
  }
}
