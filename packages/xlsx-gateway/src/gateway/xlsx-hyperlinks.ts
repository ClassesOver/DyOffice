/// Surgical hyperlink editing for a worksheet part and its .rels sibling.
/// External targets live as TargetMode="External" relationships referenced by
/// r:id; internal anchors use the `location` attribute and need no rel.

import { decodeAttribute, nextFreeRelationshipId } from './xlsx-sheets.ts'
import {
  OFFICE_RELATIONSHIPS_NAMESPACE,
  isOfficeRelationshipNamespace,
  readRelationshipId,
  readRootStartTag,
} from './xlsx-namespace.ts'
import { findRootChild } from './xlsx-root-tail.ts'
import { childElements } from './xlsx-style-entries.ts'
import { readWorksheetTagAttribute } from './xlsx-structure.ts'

export { ensureRelationshipNamespace } from './xlsx-namespace.ts'

export class HyperlinkEditError extends Error {}

export interface HyperlinkEdit {
  readonly row: number
  readonly column: number
  /// '#Sheet!A1' = internal anchor (leading '#' stripped into `location`);
  /// anything else = external URL; null removes the link.
  readonly target: string | null
  /// An added sheet that takes a renamed sheet's former name in this save.
  readonly targetAddedSheetName?: string
}

export interface HyperlinkPatch {
  readonly worksheetXml: string
  /// null when the sheet had no rels file and still needs none.
  readonly relsXml: string | null
  readonly relsChanged: boolean
}

const HYPERLINK_REL_TYPE = `${OFFICE_RELATIONSHIPS_NAMESPACE}/hyperlink`
const EMPTY_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '</Relationships>'

function findRelationshipsRoot(xml: string) {
  return childElements(xml).find(({ name }) => name.slice(name.lastIndexOf(':') + 1) === 'Relationships')
}

export function findWorksheetHyperlinkSection(worksheetXml: string) {
  const span = findRootChild(worksheetXml, 'worksheet', 'hyperlinks')
  if (!span) return undefined
  const [element] = childElements(worksheetXml.slice(span.start, span.end))
  return element ? { ...span, element } : undefined
}

export function hyperlinkAnchorReference(reference: string): string {
  return (reference.split(':', 1)[0] ?? '').replaceAll('$', '').toUpperCase()
}

export function applyHyperlinkEdits(
  worksheetXml: string,
  relsXml: string | null,
  edits: readonly HyperlinkEdit[],
): HyperlinkPatch {
  let rels = relsXml
  let relsChanged = false
  const root = readRootStartTag(worksheetXml)
  const section = findWorksheetHyperlinkSection(worksheetXml)
  const element = section?.element
  const parent = element?.opening ?? ''
  const inheritedNamespace = readWorksheetTagAttribute(parent, 'xmlns:r') ?? readWorksheetTagAttribute(root, 'xmlns:r')
  const relationshipBinding = inheritedNamespace !== undefined && !isOfficeRelationshipNamespace(inheritedNamespace)
    ? ` xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}"`
    : ''
  let body = element?.inner ?? ''

  const dropRel = (relId: string): void => {
    if (rels === null) return
    const root = findRelationshipsRoot(rels)
    if (!root) return
    const name = root.name.slice(0, -1)
    const entry = childElements(root.inner).find((child) => {
      if (child.name !== name || !readWorksheetTagAttribute(child.opening, 'Type')?.endsWith('/hyperlink')) return false
      const id = readWorksheetTagAttribute(child.opening, 'Id')
      return id !== undefined && decodeAttribute(id) === decodeAttribute(relId)
    })
    if (!entry) return
    const start = root.start + root.opening.length + entry.start
    rels = rels.slice(0, start) + rels.slice(start + entry.xml.length)
    relsChanged = true
  }
  const allocateRel = (target: string): string => {
    if (rels === null) {
      rels = EMPTY_RELS
      relsChanged = true
    }
    const root = findRelationshipsRoot(rels)
    if (!root) throw new HyperlinkEditError('Worksheet has no relationships root element.')
    const relId = nextFreeRelationshipId(rels)
    const element =
      `<${root.name.slice(0, -1)} Id="${relId}" Type="${HYPERLINK_REL_TYPE}" ` +
      `Target="${escapeXmlAttribute(target)}" TargetMode="External"/>`
    const endOfOpening = root.start + root.opening.length
    if (root.opening.endsWith('/>')) {
      rels = rels.slice(0, endOfOpening - 2) + `>${element}</${root.name}>` + rels.slice(endOfOpening)
    } else {
      const close = endOfOpening + root.inner.length
      rels = rels.slice(0, close) + element + rels.slice(close)
    }
    relsChanged = true
    return relId
  }

  for (const edit of edits) {
    const ref = toA1(edit.row, edit.column)
    const links = childElements(body).filter((link) => link.name === 'hyperlink')
    const matches = new Map<(typeof links)[number], string>()
    for (const link of links) {
      const raw = readWorksheetTagAttribute(link.opening, 'ref')
      if (raw === undefined) continue
      const reference = decodeAttribute(raw)
      if (hyperlinkAnchorReference(reference) === ref) matches.set(link, reference)
    }
    if (matches.size > 0) {
      const activeIds = new Set(links.filter((link) => !matches.has(link))
        .map((link) => readRelationshipId(link.opening, parent, root)))
      for (const link of [...matches.keys()].reverse()) {
        body = body.slice(0, link.start) + body.slice(link.start + link.xml.length)
        const id = readRelationshipId(link.opening, parent, root)
        if (id !== undefined && !activeIds.has(id)) dropRel(id)
      }
    }
    if (edit.target === null) continue

    // Earlier saves could append a single-cell link next to its original range.
    const reference = escapeXmlAttribute([...matches.values()].find((value) => value.includes(':')) ?? ref)
    body += edit.target.startsWith('#')
      ? `<hyperlink ref="${reference}" location="${escapeXmlAttribute(edit.target.slice(1))}"/>`
      : `<hyperlink ref="${reference}"${relationshipBinding} r:id="${allocateRel(edit.target)}"/>`
  }

  let xml = worksheetXml
  if (section && element) {
    const replacement = body.trim() === '' ? '' : element.opening.endsWith('/>')
      ? `${element.opening.slice(0, -2)}>${body}</${element.name}>`
      : element.opening + body + element.xml.slice(element.opening.length + element.inner.length)
    xml = worksheetXml.slice(0, section.start) + replacement + worksheetXml.slice(section.end)
  } else if (body !== '') {
    xml = insertHyperlinkSection(worksheetXml, body)
  }
  return { worksheetXml: xml, relsXml: rels, relsChanged }
}

function insertHyperlinkSection(xml: string, body: string): string {
  const section = `<hyperlinks>${body}</hyperlinks>`
  // Schema order: hyperlinks follows dataValidations / conditionalFormatting /
  // mergeCells / sheetData and precedes print-related elements and drawings.
  const anchor =
    /<printOptions\b|<pageMargins\b|<pageSetup\b|<headerFooter\b|<rowBreaks\b|<colBreaks\b|<drawing\b|<legacyDrawing\b|<picture\b|<oleObjects\b|<tableParts\b|<extLst\b/.exec(
      xml,
    )
  if (anchor) {
    return xml.slice(0, anchor.index) + section + xml.slice(anchor.index)
  }
  const end = xml.lastIndexOf('</worksheet>')
  if (end === -1) throw new HyperlinkEditError('Worksheet has no closing element.')
  return xml.slice(0, end) + section + xml.slice(end)
}

function toA1(row: number, column: number): string {
  let letters = ''
  let remaining = column + 1
  while (remaining > 0) {
    remaining -= 1
    letters = String.fromCharCode(65 + (remaining % 26)) + letters
    remaining = Math.floor(remaining / 26)
  }
  return `${letters}${row + 1}`
}

function escapeXmlAttribute(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
