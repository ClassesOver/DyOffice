/// Surgical hyperlink editing for a worksheet part and its .rels sibling.
/// External targets live as TargetMode="External" relationships referenced by
/// r:id; internal anchors use the `location` attribute and need no rel.

import { escapeRegExp, nextFreeRelationshipId } from './xlsx-sheets.ts'
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

export function applyHyperlinkEdits(
  worksheetXml: string,
  relsXml: string | null,
  edits: readonly HyperlinkEdit[],
): HyperlinkPatch {
  let rels = relsXml
  let relsChanged = false
  const root = readRootStartTag(worksheetXml)
  const section = findRootChild(worksheetXml, 'worksheet', 'hyperlinks')
  const element = section ? childElements(worksheetXml.slice(section.start, section.end))[0] : undefined
  const parent = element?.opening ?? ''
  const inheritedNamespace = readWorksheetTagAttribute(parent, 'xmlns:r') ?? readWorksheetTagAttribute(root, 'xmlns:r')
  const relationshipBinding = inheritedNamespace !== undefined && !isOfficeRelationshipNamespace(inheritedNamespace)
    ? ` xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}"`
    : ''
  let body = element?.inner ?? ''

  const dropRel = (relId: string): void => {
    if (rels === null) return
    // Quote-agnostic like the id scan in xlsx-sheets.ts: a single-quoted
    // r:id is document-controlled; unescaped it could match every relationship.
    const next = rels.replace(
      new RegExp(`<Relationship\\b[^>]*\\bId=["']${escapeRegExp(relId)}["'][^>]*/>`),
      '',
    )
    if (next !== rels) {
      rels = next
      relsChanged = true
    }
  }
  const allocateRel = (target: string): string => {
    if (rels === null) {
      rels = EMPTY_RELS
      relsChanged = true
    }
    const relId = nextFreeRelationshipId(rels)
    const element =
      `<Relationship Id="${relId}" Type="${HYPERLINK_REL_TYPE}" ` +
      `Target="${escapeXmlAttribute(target)}" TargetMode="External"/>`
    const close = rels.replace('</Relationships>', () => `${element}</Relationships>`)
    if (close !== rels) {
      rels = close
    } else {
      const emptyRoot = /<Relationships\b([^>]*)\/>/.exec(rels)
      if (emptyRoot) {
        rels = rels.replace(
          emptyRoot[0],
          `<Relationships${emptyRoot[1]}>${element}</Relationships>`,
        )
      }
    }
    relsChanged = true
    return relId
  }

  for (const edit of edits) {
    const ref = toA1(edit.row, edit.column)
    const links = childElements(body).filter((link) => link.name === 'hyperlink')
    const existing = links.find((link) => readWorksheetTagAttribute(link.opening, 'ref') === ref)
    if (existing) {
      body = body.slice(0, existing.start) + body.slice(existing.start + existing.xml.length)
      const relId = readRelationshipId(existing.opening, parent, root)
      if (relId !== undefined && !links.some((link) => link !== existing &&
        readRelationshipId(link.opening, parent, root) === relId)) dropRel(relId)
    }
    if (edit.target === null) continue

    body += edit.target.startsWith('#')
      ? `<hyperlink ref="${ref}" location="${escapeXmlAttribute(edit.target.slice(1))}"/>`
      : `<hyperlink ref="${ref}"${relationshipBinding} r:id="${allocateRel(edit.target)}"/>`
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
