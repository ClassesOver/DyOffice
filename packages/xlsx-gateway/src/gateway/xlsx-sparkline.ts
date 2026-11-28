/// x14 sparkline writer: appends sparkline groups to a worksheet's extLst
/// (creating extLst / the x14 ext as needed). Existing groups stay verbatim.

import { formatAddress, parseAddress } from '../domain/cell-address.ts'
import { MAX_GRID_COLUMNS, MAX_GRID_ROWS } from '../shared/grid-bounds.ts'
import {
  applyPatches,
  elementText,
  escapeXmlText,
  extensionUri,
  isElement,
  patchElement,
  prefixOf,
  scopedChildren,
  withBody,
  worksheetRoot,
  X14_XMLNS,
  XM_XMLNS,
  type ScopedElement,
} from './xlsx-worksheet-xml.ts'

export class SparklineAddError extends Error {}

export interface SparklineCellAdd {
  readonly cell: string
  /// Sheet-qualified source range, e.g. `Sheet1!A2:F2`.
  readonly sourceRef: string
  /// An added sheet that takes a renamed sheet's former name in this save.
  readonly sourceAddedSheetName?: string
}

export interface SparklineGroupAdd {
  readonly type: 'line' | 'column' | 'stacked'
  readonly color?: string | undefined
  readonly cells: readonly SparklineCellAdd[]
}

export interface SheetSparklineAddition extends SparklineGroupAdd {
  readonly sheetName: string
}

export const SPARKLINE_EXT_URI = '{05C60535-1F16-4fd2-B633-F4F36F0B64E0}'
const DEFAULT_SERIES_ARGB = 'FF376092'
const NEGATIVE_ARGB = 'FFD00000'

function sparklineExtensions(list: ScopedElement | undefined): ScopedElement[] {
  return list
    ? scopedChildren(list).filter(
        (extension) =>
          isElement(extension, 'ext', list.namespace) &&
          extensionUri(extension) === SPARKLINE_EXT_URI.toUpperCase(),
      )
    : []
}

function sparklineCollections(extension: ScopedElement): ScopedElement[] {
  return scopedChildren(extension).filter((child) => isElement(child, 'sparklineGroups', X14_XMLNS))
}

// The caller supplies direct SpreadsheetML worksheet children.
export function worksheetSparklineGroups(children: readonly ScopedElement[]): ScopedElement[] {
  const list = children.find((child) => child.local === 'extLst')
  return sparklineExtensions(list).flatMap((extension) =>
    sparklineCollections(extension).flatMap((groups) =>
      scopedChildren(groups).filter((child) => isElement(child, 'sparklineGroup', X14_XMLNS)),
    ),
  )
}

export function sparklineEntries(group: ScopedElement): ScopedElement[] {
  const items = scopedChildren(group).find((child) => isElement(child, 'sparklines', X14_XMLNS))
  return items
    ? scopedChildren(items).filter((child) => isElement(child, 'sparkline', X14_XMLNS))
    : []
}

export function sparklineTarget(fields: readonly ScopedElement[]): string | undefined {
  const target = fields.find((child) => isElement(child, 'sqref', XM_XMLNS))
  const address = target && elementText(target.inner).trim().split(/\s+/, 1)[0]
  if (!address) return undefined
  try {
    return sparklineCellAddress(address.toUpperCase())
  } catch {
    return undefined
  }
}

function toArgb(color: string | undefined): string {
  if (color === undefined) return DEFAULT_SERIES_ARGB
  if (!/^#[0-9A-Fa-f]{6}$/.test(color.trim())) {
    throw new SparklineAddError(`"${color}" is not a #RRGGBB color.`)
  }
  return `FF${color.trim().slice(1).toUpperCase()}`
}

/// Backstop for the proposal-time check in the renderer: a host past XFD or
/// row 1048576 would make Excel repair the file.
export function sparklineCellAddress(cell: string): string {
  const bounds = parseAddress(cell)
  if (bounds.row + 1 > MAX_GRID_ROWS || bounds.column + 1 > MAX_GRID_COLUMNS) {
    throw new SparklineAddError(`"${cell}" is outside the worksheet grid.`)
  }
  return formatAddress(bounds.row, bounds.column)
}

function buildGroupXml(group: SparklineGroupAdd, bindings: string): string {
  const typeAttribute = group.type === 'line' ? '' : ` type="${group.type}"`
  const sparklines = group.cells
    .map(
      (cell) =>
        `<x14:sparkline><xm:f>${escapeXmlText(cell.sourceRef)}</xm:f>` +
        `<xm:sqref>${sparklineCellAddress(cell.cell)}</xm:sqref></x14:sparkline>`,
    )
    .join('')
  return (
    `<x14:sparklineGroup displayEmptyCellsAs="gap"${typeAttribute}${bindings}>` +
    `<x14:colorSeries rgb="${toArgb(group.color)}"/>` +
    `<x14:colorNegative rgb="${NEGATIVE_ARGB}"/>` +
    `<x14:sparklines>${sparklines}</x14:sparklines></x14:sparklineGroup>`
  )
}

/// Appends one x14:sparklineGroup per addition. A host cell may belong to
/// at most one worksheet sparkline, regardless of its XML spelling.
export function applySparklineAdditions(
  worksheetXml: string,
  additions: readonly SparklineGroupAdd[],
): string {
  if (additions.length === 0) return worksheetXml
  const root = worksheetRoot(worksheetXml)
  if (!root || root.opening.endsWith('/>')) {
    throw new SparklineAddError('Worksheet has no closing element.')
  }
  const children = scopedChildren(root).filter((child) => child.namespace === root.namespace)
  const seen = new Set<string>()
  for (const group of worksheetSparklineGroups(children)) {
    for (const entry of sparklineEntries(group)) {
      const cell = sparklineTarget(scopedChildren(entry))
      if (cell) seen.add(cell)
    }
  }
  for (const group of additions) {
    for (const { cell } of group.cells) {
      const address = sparklineCellAddress(cell)
      if (seen.has(address)) throw new SparklineAddError(`${address} already has a sparkline.`)
      seen.add(address)
    }
  }

  const list = children.find((child) => child.local === 'extLst')
  const extension = sparklineExtensions(list)[0]
  const collection = extension && sparklineCollections(extension)[0]
  const bindings = collection
    ? (collection.namespaces.get('x14') === X14_XMLNS ? '' : ` xmlns:x14="${X14_XMLNS}"`) +
      (collection.namespaces.get('xm') === XM_XMLNS ? '' : ` xmlns:xm="${XM_XMLNS}"`)
    : ''
  const groups = additions.map((group) => buildGroupXml(group, bindings)).join('')
  const wrapped = `<x14:sparklineGroups xmlns:x14="${X14_XMLNS}" xmlns:xm="${XM_XMLNS}">${groups}</x14:sparklineGroups>`
  const prefix = prefixOf((list ?? root).name)
  const extraExtension = `<${prefix}ext uri="${SPARKLINE_EXT_URI}">${wrapped}</${prefix}ext>`
  let body: string
  if (list) {
    let extensions = list.inner + extraExtension
    if (extension) {
      const inner = collection
        ? applyPatches(extension.inner, [
            patchElement(collection, withBody(collection, collection.inner + groups)),
          ])
        : extension.inner + wrapped
      extensions = applyPatches(list.inner, [patchElement(extension, withBody(extension, inner))])
    }
    body = applyPatches(root.inner, [patchElement(list, withBody(list, extensions))])
  } else {
    body = root.inner + `<${prefix}extLst>${extraExtension}</${prefix}extLst>`
  }
  return applyPatches(worksheetXml, [patchElement(root, withBody(root, body))])
}
