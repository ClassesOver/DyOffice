/// Pivot layout growth: when a refresh sends an expanded output area (new row
/// or column items entered the source data), the pivotTableDefinition's
/// <location ref="…"> must be widened to match, and the new cells must be
/// clear of pre-existing non-pivot content.  This guard ensures the file is
/// always consistent on disk — an unupdated ref would confuse Excel about
/// which cells belong to the pivot.

import { columnIndex, columnLabel } from '../domain/cell-address.ts'
import {
  PIVOT_SHOW_DATA_AS_BASE_FIELD,
  PIVOT_SHOW_DATA_AS_BASE_ITEM,
  showDataAsToOoxml,
} from '../domain/pivot-value-modes.ts'
import { relativeTarget, relsPathFor, resolveRelTarget, type MutablePackage } from './xlsx-drawing-add.ts'
import { readRelationshipIdAttribute, readRootStartTag } from './xlsx-namespace.ts'
import { setPivotRefreshOnLoad } from './xlsx-pivot.ts'
import {
  addPivotCacheParts,
  buildCacheDefinitionXml,
  buildPivotTableXml,
  maxCacheId,
  registerWorkbookPivotCache,
  type PivotAddition,
} from './xlsx-pivot-add.ts'
import { parseSlicerState } from './xlsx-slicer.ts'
import {
  decodeAttribute,
  findRelationshipsRoot,
  localPivotWorksheetSource,
  parseRelationships,
  relationshipIdsMatch,
} from './xlsx-sheets.ts'
import {
  findPivotTableLocation,
  readWorksheetTagAttribute,
  updateWorksheetTagAttribute,
} from './xlsx-structure.ts'
import { childElements } from './xlsx-style-entries.ts'
import { isElement, scopedChildren, withNamespaces, worksheetRoot } from './xlsx-worksheet-xml.ts'

export class PivotExpandError extends Error {}

/// Carries the intended new output area for one recomputed pivot.
export interface PivotRefreshUpdate {
  /// xl/pivotCache/pivotCacheDefinitionN.xml
  readonly cachePath: string
  /// Identifies the pivot when several tables share its cache.
  readonly pivotPath?: string | undefined
  /// xl/worksheets/sheetN.xml — the sheet that hosts the pivot output.
  /// May be omitted when the renderer only knows the sheet name; then
  /// planCellEditsToXlsx resolves it from sheetName before calling
  /// applyPivotLayoutExpansions.
  readonly worksheetPath?: string | undefined
  /// Sheet name used when worksheetPath is absent (one of the two is required).
  readonly sheetName?: string | undefined
  /// New full output ref (including header row + grand-total row/col),
  /// e.g. "F1:G7".  May equal the current ref (no-op), larger, or (after a
  /// layout edit) smaller.
  readonly newOutputRef: string
  /// Layout edit (A3): the full edited layout in the pivot-addition shape.
  /// The pivotTableDefinition and pivotCacheDefinition are regenerated from
  /// it. The original name stays, and a shared cache gets a separate cache ID.
  /// Excel rebuilds the edited cache's records on open. The payload's own
  /// `name` is a renderer placeholder and is ignored.
  readonly relayout?: Omit<PivotAddition, 'worksheetPath'> | undefined
}

// ─── Reference helpers ──────────────────────────────────────────────────────

interface CellRef {
  col: number // 0-based column index
  row: number // 0-based row index
}

interface AreaRef {
  start: CellRef
  end: CellRef
}

function parseCellRef(ref: string): CellRef {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase())
  if (!m) throw new PivotExpandError(`Cannot parse cell address "${ref}".`)
  return { col: columnIndex(m[1]!), row: Number(m[2]!) - 1 }
}

function parseAreaRef(ref: string): AreaRef {
  const parts = ref.trim().toUpperCase().split(':')
  if (parts.length !== 2) throw new PivotExpandError(`Cannot parse area ref "${ref}".`)
  return { start: parseCellRef(parts[0]!), end: parseCellRef(parts[1]!) }
}

function areaRefToString(area: AreaRef): string {
  return (
    `${columnLabel(area.start.col)}${area.start.row + 1}` +
    `:${columnLabel(area.end.col)}${area.end.row + 1}`
  )
}

// ─── Package helpers ─────────────────────────────────────────────────────────

async function linkedParts(pkg: MutablePackage, partPath: string, kind: string): Promise<string[]> {
  const relsPath = relsPathFor(partPath)
  if (!(await pkg.has(relsPath))) return []
  return parseRelationships(await pkg.readText(relsPath))
    .filter(({ external, type }) => !external && type.endsWith('/' + kind))
    .map(({ target }) => resolveRelTarget(partPath, target))
}

async function findPivotTablePathForRefresh(
  pkg: MutablePackage,
  worksheetPath: string,
  update: PivotRefreshUpdate,
): Promise<string | undefined> {
  const candidates: string[] = []
  for (const tablePath of new Set(await linkedParts(pkg, worksheetPath, 'pivotTable'))) {
    if (update.pivotPath !== undefined && update.pivotPath !== tablePath) continue
    if ((await linkedParts(pkg, tablePath, 'pivotCacheDefinition')).includes(update.cachePath)) {
      candidates.push(tablePath)
    }
  }
  if (update.pivotPath !== undefined && candidates.length === 0) {
    throw new PivotExpandError('The pivot refresh does not match the worksheet and cache relationships.')
  }
  if (candidates.length <= 1) return candidates[0]

  // Older save requests identify the table by its unchanged output origin.
  const { start } = parseAreaRef(update.newOutputRef)
  const matches: string[] = []
  for (const tablePath of candidates) {
    const location = findPivotTableLocation(await pkg.readText(tablePath))
    const ref = location?.attributes.get('ref')
    if (!ref) continue
    const { start: origin } = parseAreaRef(ref)
    if (origin.col === start.col && origin.row === start.row) matches.push(tablePath)
  }
  if (matches.length !== 1) {
    throw new PivotExpandError('The pivot refresh matches an ambiguous output location.')
  }
  return matches[0]
}

// ─── Conflict detection ───────────────────────────────────────────────────────

/// True when the worksheet XML has any non-empty cell in the given area.
function worksheetHasContentInArea(worksheetXml: string, area: AreaRef): boolean {
  const worksheet = worksheetRoot(worksheetXml)
  if (!worksheet) return false
  const namespace = worksheet.namespace
  const data = scopedChildren(worksheet).find((child) => isElement(child, 'sheetData', namespace))
  if (!data) return false

  const { start, end } = area
  let rowIdx = -1
  for (const row of scopedChildren(data)) {
    if (!isElement(row, 'row', namespace)) continue
    const rowNumber = row.attributes.get('r')
    rowIdx = rowNumber === undefined ? rowIdx + 1 : Number(rowNumber) - 1
    if (rowIdx < start.row || rowIdx > end.row) continue

    let colIdx = -1
    for (const cell of scopedChildren(row)) {
      if (!isElement(cell, 'c', namespace)) continue
      const ref = cell.attributes.get('r')
      if (ref === undefined) {
        colIdx += 1
      } else {
        const col = /^([A-Z]+)\d+$/.exec(ref.toUpperCase())?.[1]
        if (!col) continue
        colIdx = columnIndex(col)
      }
      if (colIdx < start.col || colIdx > end.col) continue
      // A formula, including a shared follower, can have no cached value.
      if (scopedChildren(cell).some(({ local, namespace: childNamespace }) =>
        childNamespace === namespace && (local === 'f' || local === 'v' || local === 'is'),
      )) return true
    }
  }
  return false
}

/// Subtract area B from area A, returning the set of sub-areas in A that are
/// not covered by B. Used to identify the newly-added cells when the pivot
/// grows right or down.
function subtractAreas(outer: AreaRef, inner: AreaRef): AreaRef[] {
  // Only handles the case where inner is fully inside outer (which it always
  // is here: old ⊆ new).
  const result: AreaRef[] = []
  if (
    inner.start.col > outer.start.col ||
    inner.end.col < outer.end.col ||
    inner.start.row > outer.start.row ||
    inner.end.row < outer.end.row
  ) {
    // Generic subtraction: rows below old area
    if (inner.end.row < outer.end.row) {
      result.push({
        start: { col: outer.start.col, row: inner.end.row + 1 },
        end: { col: outer.end.col, row: outer.end.row },
      })
    }
    // Columns to the right of old area (in rows covered by old)
    if (inner.end.col < outer.end.col) {
      result.push({
        start: { col: inner.end.col + 1, row: outer.start.row },
        end: { col: outer.end.col, row: Math.min(inner.end.row, outer.end.row) },
      })
    }
  }
  return result
}

// ─── Main export ─────────────────────────────────────────────────────────────

/// For each PivotRefreshUpdate whose newOutputRef is larger than the current
/// location ref, this function:
///  1. Checks that the newly-added rows/columns in the *original* worksheet
///     XML are empty (fail-closed on conflict).
///  2. Updates the pivotTableDefinition <location ref="…"> to newOutputRef.
///
/// No-ops (same ref) are silently skipped. Shrinking refs are also silently
/// skipped (the frontend never sends a smaller ref intentionally, but it is
/// not an error).
///
/// Called from planCellEditsToXlsx after structural shifts but before cell
/// edits are applied, so the worksheet XML reflects the pre-edit state and
/// the conflict check sees pre-existing content.
export async function applyPivotLayoutExpansions(
  pkg: MutablePackage,
  updates: readonly PivotRefreshUpdate[],
  touchedEntries: Set<string>,
): Promise<void> {
  for (const update of updates) {
    const { worksheetPath } = update
    if (worksheetPath === undefined) {
      throw new PivotExpandError('Pivot refresh needs a resolved worksheet path.')
    }
    const pivotTablePath = await findPivotTablePathForRefresh(pkg, worksheetPath, update)
    if (!pivotTablePath) {
      // Cache not yet linked to a table (edge case: bare cache from old save) — skip.
      continue
    }

    const pivotTableXml = await pkg.readText(pivotTablePath)
    const location = findPivotTableLocation(pivotTableXml)
    const currentRef = location?.attributes.get('ref')
    if (!location || !currentRef) continue

    const oldArea = parseAreaRef(currentRef)
    const newArea = parseAreaRef(update.newOutputRef)
    const sameArea =
      oldArea.start.col === newArea.start.col &&
      oldArea.start.row === newArea.start.row &&
      oldArea.end.col === newArea.end.col &&
      oldArea.end.row === newArea.end.row

    // Same size and no layout edit: no-op.
    if (sameArea && update.relayout === undefined) continue

    // Moved origin (shouldn't happen on refresh, but fail safe).
    if (oldArea.start.col !== newArea.start.col || oldArea.start.row !== newArea.start.row) {
      throw new PivotExpandError(
        `Pivot "${update.newOutputRef}" cannot change its top-left cell during refresh.`,
      )
    }

    const grows = newArea.end.row > oldArea.end.row || newArea.end.col > oldArea.end.col
    if (grows) {
      // Growth — check added cells for pre-existing content. Shrinking needs
      // no check: the renderer already cleared the leftover cells and saved
      // them as ordinary cell edits.
      const worksheetXml = await pkg.readText(worksheetPath)
      const addedAreas = subtractAreas(newArea, oldArea)
      for (const added of addedAreas) {
        if (worksheetHasContentInArea(worksheetXml, added)) {
          const addedRef = areaRefToString(added)
          throw new PivotExpandError(
            `Pivot expansion into ${addedRef} conflicts with existing worksheet content. ` +
              'Clear the area first or move the pivot.',
          )
        }
      }
    }

    if (update.relayout === undefined) {
      const { start, opening } = location
      const updated = updateWorksheetTagAttribute(opening, 'ref', areaRefToString(newArea))
      const updatedTableXml =
        pivotTableXml.slice(0, start) + updated + pivotTableXml.slice(start + opening.length)
      pkg.write(pivotTablePath, updatedTableXml)
      touchedEntries.add(pivotTablePath)
      continue
    }
    await applyPivotRelayout(pkg, update, pivotTablePath, pivotTableXml, touchedEntries)
  }
}

async function isPivotCacheShared(pkg: MutablePackage, cachePath: string, pivotPath: string) {
  for (const sheetPath of await linkedParts(pkg, 'xl/workbook.xml', 'worksheet')) {
    for (const peer of await linkedParts(pkg, sheetPath, 'pivotTable')) {
      if (peer !== pivotPath &&
        (await linkedParts(pkg, peer, 'pivotCacheDefinition')).includes(cachePath)) return true
    }
  }
  return false
}

/// Give the edited pivot its own cache while preserving peer pivots and their cache.
async function separatePivotCache(
  pkg: MutablePackage,
  update: PivotRefreshUpdate,
  pivotPath: string,
  cacheId: number,
  cacheDefinition: (recordsRelId: string) => string,
  touchedEntries: Set<string>,
): Promise<number> {
  if ((await parseSlicerState(pkg)).some((slicer) => slicer.pivotCacheDefinitionPath === update.cachePath)) {
    throw new PivotExpandError('A layout edit cannot separate a shared pivot cache used by slicers.')
  }
  const pivotRelsPath = relsPathFor(pivotPath)
  const pivotRels = await pkg.readText(pivotRelsPath)
  const root = findRelationshipsRoot(pivotRels)
  const entry = root && childElements(root.inner).find(({ name, opening }) => {
    const type = decodeAttribute(readWorksheetTagAttribute(opening, 'Type') ?? '')
    const target = readWorksheetTagAttribute(opening, 'Target')
    return name.slice(name.lastIndexOf(':') + 1) === 'Relationship' &&
      type.endsWith('/pivotCacheDefinition') && target !== undefined &&
      readWorksheetTagAttribute(opening, 'TargetMode') !== 'External' &&
      resolveRelTarget(pivotPath, decodeAttribute(target)) === update.cachePath
  })
  if (!root || !entry) {
    throw new PivotExpandError('The pivot table has no cache relationship to update.')
  }
  const workbookPath = 'xl/workbook.xml'
  const workbookXml = await pkg.readText(workbookPath)
  const nextId = Math.max(cacheId, maxCacheId(workbookXml)) + 1
  const newCache = await addPivotCacheParts(pkg, EMPTY_PIVOT_RECORDS, cacheDefinition, touchedEntries)
  const workbook = await registerWorkbookPivotCache(pkg, workbookXml, nextId, newCache, touchedEntries)
  pkg.write(workbookPath, workbook)
  touchedEntries.add(workbookPath)

  const offset = root.start + root.opening.length + entry.start
  const updated = updateWorksheetTagAttribute(entry.opening, 'Target', relativeTarget(pivotPath, newCache))
  pkg.write(pivotRelsPath,
    pivotRels.slice(0, offset) + updated + pivotRels.slice(offset + entry.opening.length))
  touchedEntries.add(pivotRelsPath)
  return nextId
}

const EMPTY_PIVOT_RECORDS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<pivotCacheRecords ' +
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'count="0"/>'

async function applyPivotRelayout(
  pkg: MutablePackage,
  update: PivotRefreshUpdate,
  pivotTablePath: string,
  pivotTableXml: string,
  touchedEntries: Set<string>,
): Promise<void> {
  const relayout = update.relayout!
  const cacheXml = await pkg.readText(update.cachePath)
  // Both parts are rebuilt from the model, so refuse before touching either when
  // the original carries content the builders cannot reproduce.
  assertOnlyModelledContent(pivotTableXml, 'table')
  const recordsReference = readRelationshipIdAttribute(readRootStartTag(cacheXml), '', '')
  assertOnlyModelledContent(cacheXml, 'cache', recordsReference?.name)
  const tableOpening = readRootStartTag(pivotTableXml)
  const name = decodeAttribute(readWorksheetTagAttribute(tableOpening, 'name') ?? '')
  const rawCacheId = decodeAttribute(readWorksheetTagAttribute(tableOpening, 'cacheId') ?? '')
  const cacheId = Number(rawCacheId)
  if (!name || !/^\d+$/.test(rawCacheId) || !Number.isInteger(cacheId)) {
    throw new PivotExpandError('The pivot table definition is missing its name or cacheId.')
  }
  const recordsRelId = recordsReference?.value
  if (!recordsRelId) {
    throw new PivotExpandError('The pivot cache definition is missing its records relationship.')
  }
  const cacheRelsPath = relsPathFor(update.cachePath)
  const recordsRelationship = (await pkg.has(cacheRelsPath))
    ? parseRelationships(await pkg.readText(cacheRelsPath)).find(({ id }) =>
        relationshipIdsMatch(id, recordsRelId),
      )
    : undefined
  if (!recordsRelationship || recordsRelationship.external ||
    !recordsRelationship.type.endsWith('/pivotCacheRecords')) {
    throw new PivotExpandError('The pivot cache does not have a valid internal records relationship.')
  }
  const recordsPath = resolveRelTarget(update.cachePath, recordsRelationship.target)
  if (!(await pkg.has(recordsPath))) {
    throw new PivotExpandError('The pivot cache records relationship points to a missing part.')
  }

  const addition: PivotAddition = {
    ...relayout,
    name,
    worksheetPath: update.worksheetPath ?? '',
    location: refToArea(update.newOutputRef),
  }
  const source = localPivotWorksheetSource(cacheXml)?.element
  const namedSource = source?.attributes.has('name') ? source.xml : undefined
  const cacheDefinition = (id: string): string => {
    const rebuilt = buildCacheDefinitionXml(id, addition, 0)
    return setPivotRefreshOnLoad(namedSource === undefined ? rebuilt
      : rebuilt.replace(/<worksheetSource\b[^>]*\/>/, () => namedSource))
  }

  const shared = await isPivotCacheShared(pkg, update.cachePath, pivotTablePath)
  const editedCacheId = shared
    ? await separatePivotCache(pkg, update, pivotTablePath, cacheId, cacheDefinition, touchedEntries)
    : cacheId
  if (!shared) {
    pkg.write(update.cachePath, cacheDefinition(decodeAttribute(recordsRelId)))
    touchedEntries.add(update.cachePath)
    pkg.write(recordsPath, EMPTY_PIVOT_RECORDS)
    touchedEntries.add(recordsPath)
  }
  pkg.write(pivotTablePath, buildPivotTableXml(editedCacheId, addition))
  touchedEntries.add(pivotTablePath)
}

// ─── Unmodelled-content guard ──────────────────────────────────────────────────

/// Every element `buildPivotTableXml` / `buildCacheDefinitionXml` can write, as
/// the space-separated attribute and child-element names the builder emits for
/// it. A layout edit regenerates both parts from the model, so any element or
/// attribute outside this table would be silently dropped on save; the guard
/// below fails closed rather than destroying it.
const MODELLED_ELEMENTS: Readonly<Record<string, { attrs: string; children: string }>> = {
  pivotTableDefinition: {
    attrs:
      'name cacheId applyNumberFormats applyBorderFormats applyFontFormats applyPatternFormats ' +
      'applyAlignmentFormats applyWidthHeightFormats dataCaption updatedVersion createdVersion ' +
      'minRefreshableVersion useAutoFormatting itemPrintTitles compact compactData outline ' +
      'outlineData multipleFieldFilters',
    children:
      'location pivotFields rowFields rowItems pageFields colFields colItems dataFields ' +
      'pivotTableStyleInfo filters extLst',
  },
  location: {
    attrs: 'ref firstHeaderRow firstDataRow firstDataCol rowPageCount colPageCount',
    children: '',
  },
  pivotFields: { attrs: 'count', children: 'pivotField' },
  pivotField: { attrs: 'axis showAll compact outline dataField', children: 'items' },
  items: { attrs: 'count', children: 'item' },
  item: { attrs: 'x h t', children: '' },
  rowFields: { attrs: 'count', children: 'field' },
  colFields: { attrs: 'count', children: 'field' },
  field: { attrs: 'x', children: '' },
  rowItems: { attrs: 'count', children: 'i' },
  colItems: { attrs: 'count', children: 'i' },
  i: { attrs: 'r t i', children: 'x' },
  x: { attrs: 'v', children: '' },
  pageFields: { attrs: 'count', children: 'pageField' },
  pageField: { attrs: 'fld item hier', children: '' },
  dataFields: { attrs: 'count', children: 'dataField' },
  dataField: { attrs: 'name fld subtotal showDataAs baseField baseItem numFmtId', children: '' },
  pivotTableStyleInfo: {
    attrs: 'name showRowHeaders showColHeaders showRowStripes showColStripes showLastColumn',
    children: '',
  },
  filters: { attrs: 'count', children: 'filter' },
  filter: { attrs: 'fld type evalOrder id stringValue1 iMeasureFld', children: 'autoFilter' },
  autoFilter: { attrs: 'ref', children: 'filterColumn' },
  filterColumn: { attrs: 'colId', children: 'customFilters top10' },
  customFilters: { attrs: 'and', children: 'customFilter' },
  customFilter: { attrs: 'operator val', children: '' },
  top10: { attrs: 'val', children: '' },
  extLst: { attrs: '', children: 'ext' },
  ext: { attrs: 'uri', children: 'aio:aioPivotGroupings' },
  'aio:aioPivotGroupings': { attrs: 'v', children: '' },
  // refreshOnLoad: set by setPivotRefreshOnLoad on every recompute/relayout
  // save, so a pivot DyOffice itself relaid out carries it on reopen.
  pivotCacheDefinition: {
    attrs:
      'refreshedBy createdVersion refreshedVersion minRefreshableVersion recordCount ' +
      'refreshOnLoad',
    children: 'cacheSource cacheFields',
  },
  cacheSource: { attrs: 'type', children: 'worksheetSource' },
  worksheetSource: { attrs: 'ref sheet name', children: '' },
  cacheFields: { attrs: 'count', children: 'cacheField' },
  cacheField: { attrs: 'name numFmtId formula databaseField', children: 'sharedItems' },
  sharedItems: { attrs: 'count', children: 's' },
  s: { attrs: 'v', children: '' },
}

/// The only pivotTableStyleInfo the builder writes; any other name is a style
/// the model does not carry.
const MODELLED_PIVOT_STYLE = 'PivotStyleLight16'

/// File spellings of the "show values as" modes that reference base fields /
/// base items; only these keep non-zero dataField@baseField/baseItem.
const BASE_FIELD_MODE_OOXML: readonly string[] =
  PIVOT_SHOW_DATA_AS_BASE_FIELD.map(showDataAsToOoxml)
const BASE_ITEM_MODE_OOXML: readonly string[] = PIVOT_SHOW_DATA_AS_BASE_ITEM.map(showDataAsToOoxml)

/// Fail closed when a pivot or cache part carries content the relayout
/// builders cannot reproduce. Without this, editing a layout silently drops
/// styles, sort/subtotal settings, chart formats, conditional formats and
/// extension content that the in-memory model never modelled.
function assertOnlyModelledContent(xml: string, part: 'table' | 'cache', recordsAttribute?: string): void {
  const unmodelled = (detail: string): PivotExpandError =>
    new PivotExpandError(
      `The pivot ${part} has ${detail}, which a layout edit cannot preserve. ` +
        'Re-create the pivot after changing its layout.',
    )
  const roots = childElements(xml)
  const expectedRoot = part === 'table' ? 'pivotTableDefinition' : 'pivotCacheDefinition'
  const [root] = roots
  if (roots.length !== 1 || root?.name !== expectedRoot) throw unmodelled('an invalid root element')
  const pending = [withNamespaces(root, new Map())]
  let tag = pending.pop()
  while (tag) {
    const spec = MODELLED_ELEMENTS[tag.name]
    if (spec === undefined) throw unmodelled(`an unmodelled <${tag.name}> section`)
    const modelledAttributes = spec.attrs.split(' ')
    for (const attribute of tag.attributes.keys()) {
      if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) continue
      if (tag.name === 'pivotCacheDefinition' && attribute === recordsAttribute) continue
      if (!modelledAttributes.includes(attribute)) {
        throw unmodelled(`an unmodelled <${tag.name} ${attribute}="…"> attribute`)
      }
    }
    // Attributes the builders write with a fixed value: a different original
    // value is user content the model does not carry.
    if (tag.name === 'pivotTableStyleInfo') {
      const style = tag.attributes.get('name')
      if (style !== undefined && style !== MODELLED_PIVOT_STYLE) {
        throw unmodelled(`the pivot table style "${style}"`)
      }
    }
    // dataField@baseField/baseItem are modelled only through a supported
    // base-field "show values as" mode; stray non-zero values the model would
    // rewrite to 0 stay fail-closed.
    if (tag.name === 'dataField') {
      const mode = tag.attributes.get('showDataAs')
      const carriesBase = (spellings: readonly string[]): boolean =>
        mode !== undefined && spellings.includes(mode)
      const baseFieldModes = carriesBase(BASE_FIELD_MODE_OOXML)
      const baseItemModes = carriesBase(BASE_ITEM_MODE_OOXML)
      for (const [attribute, modelled] of [
        ['baseField', baseFieldModes],
        ['baseItem', baseItemModes],
      ] as const) {
        const value = tag.attributes.get(attribute)
        if (value !== undefined && value !== '0' && !modelled) {
          throw unmodelled(`a dataField ${attribute}`)
        }
      }
    }
    for (const child of scopedChildren(tag)) pending.push(child)
    tag = pending.pop()
  }
}

function refToArea(ref: string): PivotAddition['location'] {
  const area = parseAreaRef(ref)
  return {
    startRow: area.start.row,
    startColumn: area.start.col,
    endRow: area.end.row,
    endColumn: area.end.col,
  }
}
