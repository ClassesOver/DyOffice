import { columnLabel } from '../domain/cell-address.ts'
import { MAX_GRID_COLUMNS, MAX_GRID_ROWS } from '../shared/grid-bounds.ts'
import { isValidDefinedName } from './xlsx-defined-names.ts'
import {
  allocatePartPath,
  appendRelationship,
  registerContentTypeOverride,
  relativeTarget,
  relsPathFor,
  resolveRelTarget,
  type MutablePackage,
} from './xlsx-drawing-add.ts'
import {
  ensureRelationshipNamespace,
  readRelationshipId,
  readRootStartTag,
  relationshipNamespaceOverride,
} from './xlsx-namespace.ts'
import { decodeAttribute, parseRelationships, relationshipIdsMatch, tablePartNames } from './xlsx-sheets.ts'
import { readWorksheetTagAttribute, updateWorksheetTagAttribute } from './xlsx-structure.ts'
import { isElement, prefixOf, scopedChildren, worksheetRoot, type ScopedElement } from './xlsx-worksheet-xml.ts'

/// Persists tables (ListObjects) created in the editor as brand-new OOXML
/// parts: xl/tables/tableN.xml, the worksheet's <tableParts> element, the
/// worksheet→table relationship, and the [Content_Types].xml override.
/// Fail-closed: name collisions, overlaps with existing tables / the sheet
/// auto-filter / merged cells, and bad column names all abort the save.

export class TableAddError extends Error {}

export interface TableArea {
  readonly startRow: number
  readonly startColumn: number
  readonly endRow: number
  readonly endColumn: number
}

export interface TableAddition {
  readonly worksheetPath: string
  /// 0-based, header row included.
  readonly area: TableArea
  readonly name: string
  /// One per column, in order; must be non-blank and unique (the renderer
  /// sanitizes screen values before recording the add).
  readonly columnNames: readonly string[]
  /// Built-in style name; undefined = TableStyleMedium2.
  readonly style?: string | undefined
  readonly bandedRows: boolean
  readonly options?: TableStyleOptions | undefined
}

/// Excel's Table Style Options; every field defaults to Excel's own default.
export interface TableStyleOptions {
  readonly headerRow?: boolean | undefined
  readonly totalsRow?: boolean | undefined
  readonly firstColumn?: boolean | undefined
  readonly lastColumn?: boolean | undefined
  readonly bandedColumns?: boolean | undefined
  readonly filterButton?: boolean | undefined
}

export interface LocatedTable {
  readonly path: string
  readonly relId: string
  readonly xml: string
}

export function worksheetTableParts(root: ScopedElement) {
  const container = scopedChildren(root).find((entry) => isElement(entry, 'tableParts', root.namespace))
  if (!container) return undefined
  const entries = scopedChildren(container)
    .filter((entry) => isElement(entry, 'tablePart', root.namespace))
    .map((entry) => ({ entry, id: readRelationshipId(entry.opening, container.opening, root.opening) }))
  return { container, entries }
}

/// The table parts referenced by a worksheet, in worksheet order. Shared
/// with the filter save path, which routes table-overlapping filters into
/// the table part instead of the worksheet.
export async function sheetTableParts(
  pkg: MutablePackage,
  worksheetPath: string,
): Promise<readonly LocatedTable[]> {
  const relsPath = relsPathFor(worksheetPath)
  if (!(await pkg.has(relsPath))) return []
  const root = worksheetRoot(await pkg.readText(worksheetPath))
  const references = root && worksheetTableParts(root)
  if (!references) return []
  const relationships = parseRelationships(await pkg.readText(relsPath))
    .filter((entry) => !entry.external && entry.type.endsWith('/table'))
  const parts: LocatedTable[] = []
  for (const { id: relId } of references.entries) {
    if (!relId) continue
    const rel = relationships.find(({ id }) => relationshipIdsMatch(id, relId))
    if (!rel?.target) continue
    const path = resolveRelTarget(worksheetPath, rel.target)
    if (!(await pkg.has(path))) continue
    parts.push({ path, relId, xml: await pkg.readText(path) })
  }
  return parts
}

export const TABLE_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table'
const TABLE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml'
const DEFAULT_TABLE_STYLE = 'TableStyleMedium2'

export async function applyTableAdditions(
  pkg: MutablePackage,
  additions: readonly TableAddition[],
  touchedEntries: Set<string>,
): Promise<void> {
  if (additions.length === 0) return
  const reserved = await collectExistingTableNames(pkg)
  let nextId = await maxExistingTableId(pkg)
  for (const addition of additions) {
    validateAddition(addition)
    const lowerName = addition.name.toLowerCase()
    if (reserved.has(lowerName)) {
      throw new TableAddError(`Table name "${addition.name}" is already taken in this workbook.`)
    }
    reserved.add(lowerName)
    await assertNameNotDefined(pkg, addition.name)
    await assertNoTableOverlap(pkg, addition)
    assertNoSheetConflicts(addition, await pkg.readText(addition.worksheetPath))

    nextId += 1
    const tablePath = await allocatePartPath(pkg, 'xl/tables/table', '.xml')
    pkg.add(tablePath, buildTableXml(nextId, addition))
    touchedEntries.add(tablePath)
    await registerContentTypeOverride(pkg, tablePath, TABLE_CONTENT_TYPE, touchedEntries)
    const relId = await appendRelationship(
      pkg,
      relsPathFor(addition.worksheetPath),
      TABLE_REL_TYPE,
      relativeTarget(addition.worksheetPath, tablePath),
    )
    touchedEntries.add(relsPathFor(addition.worksheetPath))
    pkg.write(
      addition.worksheetPath,
      appendTablePart(await pkg.readText(addition.worksheetPath), relId),
    )
    touchedEntries.add(addition.worksheetPath)
  }
}

function validateAddition(addition: TableAddition): void {
  const { area, columnNames } = addition
  if (!isValidDefinedName(addition.name)) {
    throw new TableAddError(`"${addition.name}" is not a valid table name.`)
  }
  if (
    area.startRow < 0 ||
    area.startColumn < 0 ||
    area.endRow < area.startRow ||
    area.endColumn < area.startColumn ||
    area.endRow >= MAX_GRID_ROWS ||
    area.endColumn >= MAX_GRID_COLUMNS
  ) {
    throw new TableAddError(`Table "${addition.name}" lies outside the worksheet grid.`)
  }
  const bandRows =
    (addition.options?.headerRow === false ? 0 : 1) + (addition.options?.totalsRow ? 1 : 0)
  if (area.endRow - area.startRow + 1 <= bandRows) {
    throw new TableAddError(
      `Table "${addition.name}" needs a header row plus at least one data row.`,
    )
  }
  const width = area.endColumn - area.startColumn + 1
  if (width !== columnNames.length) {
    throw new TableAddError(
      `Table "${addition.name}" spans ${width} columns but has ${columnNames.length} column names.`,
    )
  }
  const seen = new Set<string>()
  for (const name of columnNames) {
    const normalized = name.trim().toLowerCase()
    if (normalized.length === 0) {
      throw new TableAddError(`Table "${addition.name}" has a blank column name.`)
    }
    if (seen.has(normalized)) {
      throw new TableAddError(`Table "${addition.name}" has duplicate column name "${name}".`)
    }
    seen.add(normalized)
  }
}

/// name= and displayName= of every existing table part, lowercased.
export async function collectExistingTableNames(pkg: MutablePackage): Promise<Set<string>> {
  const names = new Set<string>()
  for (const path of await tablePartPaths(pkg)) {
    for (const name of tablePartNames(await pkg.readText(path))) names.add(name.toLowerCase())
  }
  return names
}

async function maxExistingTableId(pkg: MutablePackage): Promise<number> {
  let max = 0
  for (const path of await tablePartPaths(pkg)) {
    const opening = readRootStartTag(await pkg.readText(path))
    const id = Number(decodeAttribute(readWorksheetTagAttribute(opening, 'id') ?? ''))
    if (Number.isSafeInteger(id)) max = Math.max(max, id)
  }
  return max
}

export async function tablePartPaths(pkg: MutablePackage): Promise<string[]> {
  return (await pkg.paths()).filter((path) => /^xl\/tables\/[^/]+\.xml$/.test(path))
}

/// Table names share Excel's defined-name namespace.
export async function assertNameNotDefined(pkg: MutablePackage, name: string): Promise<void> {
  const workbookXml = await pkg.readText('xl/workbook.xml')
  for (const match of workbookXml.matchAll(/<definedName\b[^>]*\bname="([^"]+)"/g)) {
    if (match[1]?.toLowerCase() === name.toLowerCase()) {
      throw new TableAddError(`Table name "${name}" collides with a defined name in the workbook.`)
    }
  }
}

/// The new table must not overlap any table already on the same worksheet,
/// including additions already linked in this save.
async function assertNoTableOverlap(pkg: MutablePackage, addition: TableAddition): Promise<void> {
  for (const table of await sheetTableParts(pkg, addition.worksheetPath)) {
    const opening = readRootStartTag(table.xml)
    const rawRef = readWorksheetTagAttribute(opening, 'ref')
    const ref = rawRef && decodeAttribute(rawRef)
    if (ref && areasOverlap(addition.area, parseRef(ref))) {
      throw new TableAddError(`Table "${addition.name}" overlaps an existing table (${ref}).`)
    }
  }
}

/// Excel forbids a table overlapping the sheet auto-filter or merged cells.
export function assertNoSheetConflicts(
  addition: Pick<TableAddition, 'name' | 'area'>,
  worksheetXml: string,
): void {
  const root = worksheetRoot(worksheetXml)
  if (!root) return
  const children = scopedChildren(root)
  const filter = children.find((entry) => isElement(entry, 'autoFilter', root.namespace))
  const autoFilterRef = filter?.attributes.get('ref')
  if (autoFilterRef && areasOverlap(addition.area, parseRef(autoFilterRef))) {
    throw new TableAddError(
      `Table "${addition.name}" overlaps the sheet auto-filter (${autoFilterRef}) — clear it first.`,
    )
  }
  const merges = children.find((entry) => isElement(entry, 'mergeCells', root.namespace))
  if (!merges) return
  for (const entry of scopedChildren(merges)) {
    if (!isElement(entry, 'mergeCell', root.namespace)) continue
    const ref = entry.attributes.get('ref')
    if (ref && areasOverlap(addition.area, parseRef(ref))) {
      throw new TableAddError(
        `Table "${addition.name}" overlaps merged cells (${ref}) — unmerge them first.`,
      )
    }
  }
}

export function buildTableXml(id: number, addition: TableAddition): string {
  const ref = areaToRef(addition.area)
  const name = escapeAttribute(addition.name)
  const options = addition.options ?? {}
  const headerRows = options.headerRow === false ? 0 : 1
  const totalsRows = options.totalsRow ? 1 : 0
  const columns = addition.columnNames
    .map(
      (columnName, index) =>
        `<tableColumn id="${index + 1}" name="${escapeAttribute(columnName)}"/>`,
    )
    .join('')
  const style = escapeAttribute(addition.style ?? DEFAULT_TABLE_STYLE)
  const flag = (on: boolean | undefined): string => (on ? '1' : '0')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    `id="${id}" name="${name}" displayName="${name}" ref="${ref}"` +
    (headerRows === 0 ? ' headerRowCount="0"' : '') +
    (totalsRows === 1 ? ' totalsRowCount="1" totalsRowShown="1"' : ' totalsRowShown="0"') +
    '>' +
    // Excel drops the filter row with the header; the button toggle hides it.
    (headerRows === 1 && options.filterButton !== false
      ? `<autoFilter ref="${autoFilterRef(addition.area, totalsRows)}"/>`
      : '') +
    `<tableColumns count="${addition.columnNames.length}">${columns}</tableColumns>` +
    `<tableStyleInfo name="${style}" showFirstColumn="${flag(options.firstColumn)}" ` +
    `showLastColumn="${flag(options.lastColumn)}" ` +
    `showRowStripes="${flag(addition.bandedRows)}" showColumnStripes="${flag(options.bandedColumns)}"/>` +
    '</table>'
  )
}

/// The filter range stops above the totals band.
export function autoFilterRef(area: TableArea, totalsRows: number): string {
  return areaToRef({ ...area, endRow: area.endRow - totalsRows })
}

/// Schema order puts tableParts after every print/drawing element, before extLst.
function appendTablePart(worksheetXml: string, relId: string): string {
  const xml = ensureRelationshipNamespace(worksheetXml)
  const root = worksheetRoot(xml)
  if (!root || root.opening.endsWith('/>')) throw new TableAddError('The worksheet part is malformed.')
  const references = worksheetTableParts(root)
  const container = references?.container
  const prefix = prefixOf(container?.name ?? root.name)
  const binding = relationshipNamespaceOverride(container?.opening ?? '', root.opening)
  const part = `<${prefix}tablePart${binding} r:id="${escapeAttribute(relId)}"/>`
  const bodyStart = root.start + root.opening.length
  if (references) {
    const { container, entries } = references
    const opening = updateWorksheetTagAttribute(container.opening, 'count', String(entries.length + 1))
    const offset = bodyStart + container.start
    const replacement = opening.endsWith('/>')
      ? opening.slice(0, -2) + '>' + part + `</${container.name}>`
      : opening + container.inner + part + container.xml.slice(container.opening.length + container.inner.length)
    return xml.slice(0, offset) + replacement + xml.slice(offset + container.xml.length)
  }
  const element = `<${prefix}tableParts count="1">${part}</${prefix}tableParts>`
  const ext = scopedChildren(root).find((entry) => isElement(entry, 'extLst', root.namespace))
  const offset = bodyStart + (ext?.start ?? root.inner.length)
  return xml.slice(0, offset) + element + xml.slice(offset)
}

export function areaToRef(area: TableArea): string {
  return (
    `${columnLabel(area.startColumn)}${area.startRow + 1}` +
    `:${columnLabel(area.endColumn)}${area.endRow + 1}`
  )
}

export function parseRef(ref: string): TableArea {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ref.replace(/\$/g, ''))
  if (!match || !match[1] || !match[2]) {
    throw new TableAddError(`Unsupported range reference "${ref}" in the workbook.`)
  }
  const startColumn = labelToIndex(match[1])
  const startRow = Number(match[2]) - 1
  const endColumn = match[3] ? labelToIndex(match[3]) : startColumn
  const endRow = match[4] ? Number(match[4]) - 1 : startRow
  return { startRow, startColumn, endRow, endColumn }
}

function labelToIndex(label: string): number {
  let index = 0
  for (const char of label) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

export function areasOverlap(a: TableArea, b: TableArea): boolean {
  return (
    a.startRow <= b.endRow &&
    b.startRow <= a.endRow &&
    a.startColumn <= b.endColumn &&
    b.startColumn <= a.endColumn
  )
}

export function escapeAttribute(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
