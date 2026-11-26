import { relsPathFor, type MutablePackage } from './xlsx-drawing-add.ts'
import { readRootStartTag } from './xlsx-namespace.ts'
import { decodeAttribute, relationshipIdsMatch, removePartOverride, removeRelationshipById, tablePartNames } from './xlsx-sheets.ts'
import { childElements } from './xlsx-style-entries.ts'
import { readWorksheetTagAttribute, updateWorksheetTagAttribute } from './xlsx-structure.ts'
import {
  applyPatches,
  isElement,
  patchElement,
  prefixOf,
  scopedChildren,
  withNamespaces,
  worksheetRoot,
  type ScopedElement,
  type XmlPatch,
} from './xlsx-worksheet-xml.ts'
import {
  areaToRef,
  areasOverlap,
  assertNameNotDefined,
  autoFilterRef,
  collectExistingTableNames,
  escapeAttribute,
  parseRef,
  sheetTableParts,
  tableWorksheetConflict,
  worksheetTableParts,
  type LocatedTable,
  type TableArea,
  type TableStyleOptions,
} from './xlsx-table-add.ts'

/// Table Design changes to tables already in the file: the table part is
/// rewritten in place (name, ref, columns, header/totals bands, style info)
/// or unregistered for Convert to Range. Fail-closed like table additions.

export class TableEditError extends Error {}

export interface TableEdit extends TableStyleOptions {
  readonly worksheetPath: string
  /// displayName (or name) of the table part at open time.
  readonly tableName: string
  readonly name?: string | undefined
  readonly area?: TableArea | undefined
  readonly columnNames?: readonly string[] | undefined
  readonly style?: string | undefined
  readonly bandedRows?: boolean | undefined
  readonly remove?: true | undefined
}

const CONTENT_TYPES_PATH = '[Content_Types].xml'
const TABLE_NAME_RULE = /^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u
const CELL_LIKE = /^(\$?[A-Za-z]{1,3}\$?[0-9]+|[rR]\d*[cC]\d*)$/

export async function applyTableEdits(
  pkg: MutablePackage,
  edits: readonly TableEdit[],
  touchedEntries: Set<string>,
  checkWorkbookNames = true,
): Promise<void> {
  if (edits.length === 0) return
  for (const edit of edits) {
    const located = await locateTable(pkg, edit)
    if (edit.remove) {
      await removeTable(pkg, edit.worksheetPath, located, touchedEntries)
      continue
    }
    const rewritten = await rewriteTable(pkg, edit, located, checkWorkbookNames)
    pkg.write(located.path, rewritten)
    touchedEntries.add(located.path)
  }
}

async function locateTable(pkg: MutablePackage, edit: TableEdit): Promise<LocatedTable> {
  const wanted = edit.tableName.toLowerCase()
  for (const part of await sheetTableParts(pkg, edit.worksheetPath)) {
    if (tablePartNames(part.xml).some((name) => name.toLowerCase() === wanted)) return part
  }
  throw new TableEditError(`Table "${edit.tableName}" was not found on its worksheet.`)
}

async function removeTable(
  pkg: MutablePackage,
  worksheetPath: string,
  table: LocatedTable,
  touchedEntries: Set<string>,
): Promise<void> {
  const relsPath = relsPathFor(worksheetPath)
  const rels = await pkg.readText(relsPath)
  const worksheet = await pkg.readText(worksheetPath)
  const withoutRelationship = removeRelationshipById(rels, table.relId)
  const withoutTable = removeTablePart(worksheet, table.relId)
  if (withoutRelationship === rels || withoutTable === worksheet) {
    throw new TableEditError('The table reference could not be removed safely.')
  }
  pkg.write(relsPath, withoutRelationship)
  touchedEntries.add(relsPath)
  pkg.write(worksheetPath, withoutTable)
  touchedEntries.add(worksheetPath)
  pkg.remove(table.path)
  touchedEntries.add(table.path)
  const contentTypes = await pkg.readText(CONTENT_TYPES_PATH)
  const stripped = removePartOverride(contentTypes, table.path)
  if (stripped !== contentTypes) {
    pkg.write(CONTENT_TYPES_PATH, stripped)
    touchedEntries.add(CONTENT_TYPES_PATH)
  }
}

/// Drops one <tablePart>; an emptied <tableParts> container goes with it.
export function removeTablePart(worksheetXml: string, relId: string): string {
  const root = worksheetRoot(worksheetXml)
  const references = root && worksheetTableParts(root)
  if (!root || !references) return worksheetXml
  const { container, entries } = references
  const patches = entries
    .filter(({ id }) => relationshipIdsMatch(id, relId))
    .map(({ entry }) => patchElement(entry, ''))
  if (!patches.length) return worksheetXml
  const inner = applyPatches(container.inner, patches)
  const remaining = entries.length - patches.length
  const keepContainer = remaining > 0 || childElements(inner).length > 0
  const opening = container.attributes.has('count')
    ? updateWorksheetTagAttribute(container.opening, 'count', String(remaining))
    : container.opening
  const replacement = keepContainer
    ? opening + inner + container.xml.slice(container.opening.length + container.inner.length)
    : inner
  const offset = root.start + root.opening.length + container.start
  return worksheetXml.slice(0, offset) + replacement + worksheetXml.slice(offset + container.xml.length)
}

async function rewriteTable(
  pkg: MutablePackage,
  edit: TableEdit,
  table: LocatedTable,
  checkWorkbookNames: boolean,
): Promise<string> {
  const [element] = childElements(table.xml)
  const root = element && withNamespaces(element, new Map())
  if (root?.local !== 'table') throw new TableEditError(`Table part ${table.path} is malformed.`)
  const currentRef = root.attributes.get('ref')
  if (!currentRef) throw new TableEditError(`Table part ${table.path} has no ref.`)

  let opening = root.opening
  if (edit.name !== undefined) {
    await assertRenameAllowed(pkg, edit, table, checkWorkbookNames)
    const name = escapeAttribute(edit.name)
    opening = updateWorksheetTagAttribute(opening, 'name', name)
    opening = updateWorksheetTagAttribute(opening, 'displayName', name)
  }
  const headerRows =
    edit.headerRow === undefined
      ? Number(root.attributes.get('headerRowCount') ?? '1')
      : Number(edit.headerRow)
  const totalsRows =
    edit.totalsRow === undefined
      ? Number(root.attributes.get('totalsRowCount') ?? '0')
      : Number(edit.totalsRow)
  const previousArea = parseRef(currentRef)
  const area = edit.area ?? previousArea
  if (area.endRow - area.startRow + 1 <= headerRows + totalsRows) {
    throw new TableEditError(
      `Table "${edit.tableName}" needs at least one data row beside its header and totals rows.`,
    )
  }
  if (edit.area) {
    await assertAreaFree(pkg, edit, table, area, previousArea)
    opening = updateWorksheetTagAttribute(opening, 'ref', areaToRef(area))
  }
  opening = updateWorksheetTagAttribute(opening, 'headerRowCount', headerRows === 0 ? '0' : null)
  opening = updateWorksheetTagAttribute(opening, 'totalsRowCount', totalsRows > 0 ? String(totalsRows) : null)
  if (totalsRows > 0 || edit.totalsRow === false) {
    opening = updateWorksheetTagAttribute(opening, 'totalsRowShown', totalsRows > 0 ? '1' : '0')
  }

  const prefix = prefixOf(root.name)
  const children = scopedChildren(root)
  const child = (name: string) => children.find((entry) => isElement(entry, name, root.namespace))
  const patches: XmlPatch[] = []
  const columns = child('tableColumns')
  if (!columns) throw new TableEditError(`Table "${edit.tableName}" has no tableColumns.`)
  const rewrittenColumns = rewriteColumns(columns, edit, area, previousArea)
  if (rewrittenColumns !== columns.xml) patches.push(patchElement(columns, rewrittenColumns))

  const filter = child('autoFilter')
  const wantsFilter = headerRows > 0 && (edit.filterButton ?? (edit.headerRow === true || !!filter))
  const columnsMoved =
    area.startColumn !== previousArea.startColumn || area.endColumn !== previousArea.endColumn
  if (wantsFilter) {
    const ref = autoFilterRef(area, totalsRows)
    const replacement = `<${prefix}autoFilter ref="${ref}"/>`
    if (!filter) {
      patches.push({ start: 0, length: 0, xml: replacement })
    } else if (columnsMoved || edit.headerRow !== undefined) {
      // Criteria are indexed from the old filter's left edge.
      patches.push(patchElement(filter, replacement))
    } else if (filter.attributes.get('ref') !== ref) {
      patches.push(patchElement(filter, updateElementOpening(filter,
        updateWorksheetTagAttribute(filter.opening, 'ref', ref),
      )))
    }
  } else if (filter) {
    patches.push(patchElement(filter, ''))
  }

  const style = child('tableStyleInfo')
  const rewrittenStyle = rewriteStyleInfo(style, prefix, edit)
  if (style) {
    if (rewrittenStyle !== style.xml) patches.push(patchElement(style, rewrittenStyle))
  } else {
    patches.push({ start: child('extLst')?.start ?? root.inner.length, length: 0, xml: rewrittenStyle })
  }

  const closing = root.xml.slice(root.opening.length + root.inner.length)
  return applyPatches(table.xml, [patchElement(root, opening + applyPatches(root.inner, patches) + closing)])
}

function updateElementOpening(element: ScopedElement, opening: string): string {
  return opening + element.xml.slice(element.opening.length)
}

async function assertRenameAllowed(
  pkg: MutablePackage,
  edit: TableEdit,
  table: LocatedTable,
  checkWorkbookNames: boolean,
): Promise<void> {
  const name = edit.name ?? ''
  if (
    name.length === 0 ||
    name.length > 255 ||
    !TABLE_NAME_RULE.test(name) ||
    CELL_LIKE.test(name)
  ) {
    throw new TableEditError(`"${name}" is not a valid table name.`)
  }
  const own = new Set(tablePartNames(table.xml).map((value) => value.toLowerCase()))
  const reserved = await collectExistingTableNames(pkg)
  for (const value of own) reserved.delete(value)
  if (reserved.has(name.toLowerCase())) {
    throw new TableEditError(`Table name "${name}" is already taken in this workbook.`)
  }
  if (checkWorkbookNames) await assertNameNotDefined(pkg, name)
}

async function assertAreaFree(
  pkg: MutablePackage,
  edit: TableEdit,
  table: LocatedTable,
  area: TableArea,
  previousArea: TableArea,
): Promise<void> {
  for (const part of await sheetTableParts(pkg, edit.worksheetPath)) {
    if (part.path === table.path) continue
    const rawRef = readWorksheetTagAttribute(readRootStartTag(part.xml), 'ref')
    const ref = rawRef && decodeAttribute(rawRef)
    if (ref && areasOverlap(area, parseRef(ref))) {
      throw new TableEditError(`Table "${edit.tableName}" would overlap table ${ref}.`)
    }
  }
  const conflict = tableWorksheetConflict(await pkg.readText(edit.worksheetPath), area, previousArea)
  if (conflict) throw new TableEditError(`Table "${edit.tableName}" would overlap ${conflict}`)
}

/// Existing <tableColumn> elements follow their sheet column, so a left-edge
/// resize keeps ids, formulas and totals metadata with the right cells.
function rewriteColumns(
  block: ScopedElement,
  edit: TableEdit,
  area: TableArea,
  previousArea: TableArea,
): string {
  const width = area.endColumn - area.startColumn + 1
  const existing = scopedChildren(block).filter((entry) => isElement(entry, 'tableColumn', block.namespace))
  if (edit.columnNames === undefined) {
    if (existing.length !== width) {
      throw new TableEditError(
        `Table "${edit.tableName}" spans ${width} columns but lists ${existing.length} column names.`,
      )
    }
    return block.xml
  }
  if (edit.columnNames.length !== width) {
    throw new TableEditError(
      `Table "${edit.tableName}" spans ${width} columns but has ${edit.columnNames.length} column names.`,
    )
  }
  const seen = new Set<string>()
  for (const name of edit.columnNames) {
    const key = name.trim().toLowerCase()
    if (key.length === 0)
      throw new TableEditError(`Table "${edit.tableName}" has a blank column name.`)
    if (seen.has(key)) {
      throw new TableEditError(`Table "${edit.tableName}" has duplicate column name "${name}".`)
    }
    seen.add(key)
  }
  let nextId = existing.reduce((max, entry) => {
    const id = Number(entry.attributes.get('id'))
    return Number.isSafeInteger(id) ? Math.max(max, id) : max
  }, 0)
  const prefix = prefixOf(block.name)
  const columns = edit.columnNames.map((name, index) => {
    const element = existing[area.startColumn + index - previousArea.startColumn]
    const escaped = escapeAttribute(name)
    if (!element) return `<${prefix}tableColumn id="${++nextId}" name="${escaped}"/>`
    if (element.attributes.get('name') === name) return element.xml
    return updateElementOpening(element, updateWorksheetTagAttribute(element.opening, 'name', escaped))
  })
  const patches = existing.map((entry, index) => patchElement(entry, columns[index] ?? ''))
  const inner = applyPatches(block.inner, patches) + columns.slice(existing.length).join('')
  const opening = updateWorksheetTagAttribute(block.opening, 'count', String(columns.length))
  const closing = block.xml.slice(block.opening.length + block.inner.length)
  return opening + inner + closing
}

function rewriteStyleInfo(existing: ScopedElement | undefined, prefix: string, edit: TableEdit): string {
  const name = edit.style === undefined ? '' : ` name="${escapeAttribute(edit.style)}"`
  let opening = existing?.opening ??
    `<${prefix}tableStyleInfo showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"${name}/>`
  if (existing && edit.style !== undefined) {
    opening = updateWorksheetTagAttribute(opening, 'name', escapeAttribute(edit.style))
  }
  const flags = [
    ['firstColumn', 'showFirstColumn'],
    ['lastColumn', 'showLastColumn'],
    ['bandedRows', 'showRowStripes'],
    ['bandedColumns', 'showColumnStripes'],
  ] as const
  for (const [key, attribute] of flags) {
    const value = edit[key]
    if (value !== undefined) opening = updateWorksheetTagAttribute(opening, attribute, value ? '1' : '0')
  }
  return existing ? updateElementOpening(existing, opening) : opening
}
