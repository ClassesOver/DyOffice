/// Sheet tab color: rewrites `<sheetPr><tabColor rgb="FFRRGGBB"/></sheetPr>`
/// on a worksheet or chart sheet, keeping the other sheetPr children verbatim.

import {
  applyPatches,
  isElement,
  patchElement,
  prefixOf,
  scopedChildren,
  spreadsheetSheetRoot,
  withBody,
} from './xlsx-worksheet-xml.ts'

export function applyTabColor(worksheetXml: string, color: string | null): string {
  const rgb = color === null ? null : toArgb(color)
  const root = spreadsheetSheetRoot(worksheetXml)
  if (!root) return worksheetXml
  const sheetPr = scopedChildren(root).find((node) => isElement(node, 'sheetPr', root.namespace))
  const prefix = prefixOf(sheetPr?.name ?? root.name)
  const element = rgb === null ? '' : `<${prefix}tabColor rgb="${rgb}"/>`
  const rootBody = root.start + root.opening.length
  if (!sheetPr) {
    if (rgb === null) return worksheetXml
    const properties = `<${prefix}sheetPr>${element}</${prefix}sheetPr>`
    return worksheetXml.slice(0, root.start) + withBody(root, properties + root.inner) +
      worksheetXml.slice(root.start + root.xml.length)
  }

  const tab = scopedChildren(sheetPr).find((node) => isElement(node, 'tabColor', root.namespace))
  if (!tab && rgb === null) return worksheetXml
  // Schema order: tabColor comes first among sheetPr children.
  const body = tab ? applyPatches(sheetPr.inner, [patchElement(tab, element)]) : element + sheetPr.inner
  const properties = body.trim() || sheetPr.attributes.size ? withBody(sheetPr, body) : ''
  const offset = rootBody + sheetPr.start
  return worksheetXml.slice(0, offset) + properties + worksheetXml.slice(offset + sheetPr.xml.length)
}

function toArgb(color: string): string {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (!hex) throw new Error(`Unsupported tab color "${color}".`)
  return `FF${hex[1]!.toUpperCase()}`
}
