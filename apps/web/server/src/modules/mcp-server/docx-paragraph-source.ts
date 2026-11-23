import { XMLValidator } from 'fast-xml-parser'
import type JSZip from 'jszip'
import { resolveRelationshipTargetPath } from '../../../../../../packages/docx-engine/src/parse-package.ts'
import { attrsOf, childrenOf, nameOf, xmlParser, type XNode } from '../../../../../../packages/docx-engine/src/xml-utils.ts'

const wordNamespaces = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
])
const relationshipsNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'
const localName = (node: XNode) => nameOf(node)?.split(':').at(-1)
const elements = (node: XNode) => childrenOf(node).filter(child => nameOf(child) !== undefined)
const namespaceOf = (node: XNode, parent: Record<string, string> = {}) => {
  const prefix = nameOf(node)?.split(':').slice(0, -1).join(':')
  const attribute = prefix ? 'xmlns:' + prefix : 'xmlns'
  return attrsOf(node)[attribute] ?? parent[attribute]
}

function rootOf(xml: string): XNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid DOCX XML')
  const nodes = (xmlParser.parse(xml) as XNode[]).filter(node => {
    const name = nameOf(node)
    return name && !name.startsWith('?')
  })
  if (nodes.length !== 1) throw new Error('Invalid DOCX XML root')
  return nodes[0]!
}

async function relationshipTarget(zip: JSZip, relsPath: string, from: string, kind: string) {
  const entry = zip.file(relsPath)
  if (!entry) return undefined
  const root = rootOf(await entry.async('string'))
  if (localName(root) !== 'Relationships' || namespaceOf(root) !== relationshipsNamespace) {
    throw new Error('Invalid DOCX relationships')
  }
  const matches = elements(root).filter(node => localName(node) === 'Relationship' &&
    namespaceOf(node, attrsOf(root)) === relationshipsNamespace && attrsOf(node).Type?.endsWith('/' + kind))
  if (matches.length === 0) return undefined
  const rel = attrsOf(matches[0]!)
  const path = resolveRelationshipTargetPath(from, rel.Target ?? '')
  if (matches.length !== 1 || rel.TargetMode?.toLowerCase() === 'external' || !path || !zip.file(path)) {
    throw new Error('Ambiguous DOCX relationship')
  }
  return path
}

export async function docxParagraphSource(zip: JSZip): Promise<string> {
  const main = await relationshipTarget(zip, '_rels/.rels', '', 'officeDocument')
  if (!main) throw new Error('DOCX main part is unavailable')
  const rels = main.replace(/([^/]+)$/, '_rels/$1.rels')
  const declaredSettings = await relationshipTarget(zip, rels, main, 'settings')
  const settingsPaths = new Set([declaredSettings, 'word/settings.xml'])
  for (const path of settingsPaths) {
    const file = path && zip.file(path)
    if (!file) continue
    const root = rootOf(await file.async('string'))
    if (localName(root) !== 'settings' || !wordNamespaces.has(namespaceOf(root) ?? '')) {
      throw new Error('Invalid DOCX settings')
    }
    const children = elements(root)
    while (children.length) {
      const node = children.pop()!
      children.push(...elements(node))
      const name = localName(node)
      if (name === 'writeProtection' || name === 'documentProtection' || name === 'trackRevisions' || name === 'removePersonalInformation') {
        const attrs = Object.entries(attrsOf(node))
        const key = name === 'documentProtection' ? 'enforcement' : 'val'
        const flags = attrs.filter(([attr]) => attr.split(':').at(-1) === key).map(([, value]) => value.trim().toLowerCase())
        if (name === 'writeProtection' || flags.length !== 1 || !['0', 'false', 'off'].includes(flags[0]!)) {
          throw new Error('DOCX is protected')
        }
      }
    }
  }
  return main
}

export function assertBodyAnchor(xml: string, index: number) {
  const document = rootOf(xml)
  if (nameOf(document) !== 'w:document' || !wordNamespaces.has(namespaceOf(document) ?? '')) {
    throw new Error('Invalid DOCX document element')
  }
  const bodies = elements(document).filter(node => nameOf(node) === 'w:body')
  const body = bodies[0]
  if (bodies.length !== 1 || !body || namespaceOf(body, attrsOf(document)) !== namespaceOf(document)) {
    throw new Error('Invalid DOCX body element')
  }
  const blocks = elements(body)
  if (!blocks[index] || nameOf(blocks[index]!) !== 'w:p') throw new Error('Invalid DOCX anchor')

  let openFields = 0
  function visit(node: XNode) {
    if (localName(node) === 'txbxContent') return
    if (localName(node) === 'fldChar') {
      const attrs = Object.entries(attrsOf(node)).filter(([key]) => key.split(':').at(-1) === 'fldCharType')
      const type = attrs.length === 1 ? attrs[0]![1] : undefined
      if (type === 'begin') openFields++
      else if (type === 'end' && openFields > 0) openFields--
      else if (type !== 'separate' || openFields === 0) throw new Error('Ambiguous DOCX field')
    }
    for (const child of elements(node)) visit(child)
  }
  for (const block of blocks.slice(0, index)) visit(block)
  if (openFields) throw new Error('DOCX target is inside a field')
}
