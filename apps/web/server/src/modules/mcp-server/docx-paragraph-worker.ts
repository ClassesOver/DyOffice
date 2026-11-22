import { parentPort, workerData } from 'node:worker_threads'
import JSZip from 'jszip'
import { assertZipInflatesWithinLimits, parseDocx, saveDocx, type SaveBlock } from '../../../../../../packages/docx-engine/src/index.ts'
import { resolveMainDocumentPath } from '../../../../../../packages/docx-engine/src/parse-package.ts'
import { decodeEntities } from '../../../../../../packages/docx-engine/src/parse-xml-text.ts'
import { patchParagraphTexts } from '../../../../../../packages/docx-engine/src/text-patch.ts'
import { attrsOf, childrenOf, nameOf, xmlParser, type XNode } from '../../../../../../packages/docx-engine/src/xml-utils.ts'
import { docxToText } from '../../../../../../packages/file-parse/src/docx.ts'

import { assertBodyAnchor, docxParagraphSource } from './docx-paragraph-source.ts'

const editableTypes = new Set(['paragraph', 'heading', 'listItem'])
const unsupportedMarkup = /<(?:[\w.-]+:)?(?:sectPr|[\w.-]*Change)(?=[\s/>])|<!|<\?|\sxmlns(?=[:=\s])/u
const rawText = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>/g)]
  .map(match => decodeEntities(match[1]!)).join('')
const textOf = (block: { runs?: { text?: string }[] }) => (block.runs ?? []).map(run => run.text ?? '').join('')

function plainParagraph(xml: string): boolean {
  if (unsupportedMarkup.test(xml)) return false
  const [paragraph] = xmlParser.parse(xml) as XNode[]
  return !!paragraph && nameOf(paragraph) === 'w:p' && childrenOf(paragraph).every(child => {
    const name = nameOf(child)
    if (name === 'w:pPr' || (name === undefined && !String(child['#text'] ?? '').trim())) return true
    return name === 'w:r' && childrenOf(child).every(run => {
      const name = nameOf(run)
      if (name === 'w:rPr' || (name === undefined && !String(run['#text'] ?? '').trim())) return true
      return name === 'w:t' && Object.keys(attrsOf(run)).every(key => key === 'xml:space') &&
        childrenOf(run).every(node => '#text' in node)
    })
  })
}

async function replace(bytes: Uint8Array, edit: { docxIndex: number; expectedText: string; replacement: string }) {
  await assertZipInflatesWithinLimits(bytes, { maxParts: 4_000, maxPartBytes: 24 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 })
  const original = await JSZip.loadAsync(bytes)
  const main = await docxParagraphSource(original)
  if (await resolveMainDocumentPath(original) !== main) throw new Error('DOCX main part is ambiguous')
  // The existing MCP visibility rules also apply to anchors supplied by a caller.
  await docxToText(bytes, { visibleOnly: true })
  const parsed = await parseDocx(bytes)
  if (parsed.protection?.enforced || parsed.writeProtection || parsed.removePersonalInfo || parsed.trackRevisions) throw new Error('DOCX is protected')
  const block = parsed.blocks.find(block => block.docxIndex === edit.docxIndex && !block.hidden)
  const source = parsed.extras.elements[edit.docxIndex]
  if (!block || !source || source.name !== 'w:p' || !editableTypes.has(block.type) || block.sdtShell ||
    block.runs?.some(run => run.commentIds?.length) ||
    !block.originalXml || !plainParagraph(block.originalXml) || rawText(block.originalXml) !== edit.expectedText || textOf(block) !== edit.expectedText) {
    throw new Error('Unsupported or stale DOCX text anchor')
  }
  const before = parsed.internal.documentXml
  assertBodyAnchor(before, edit.docxIndex)
  if (before.slice(source.start, source.end) !== block.originalXml) throw new Error('DOCX anchor mismatch')
  const changed = patchParagraphTexts(block.originalXml, edit.replacement, { preserveSuffixRun: true })
  if (!changed || changed === block.originalXml) throw new Error('DOCX edit could not be applied')
  const plan: SaveBlock[] = parsed.blocks.flatMap(block => block.hidden || block.docxIndex == null ? [] : [
    block.docxIndex === edit.docxIndex
      ? { kind: 'xml', docxIndex: block.docxIndex, xml: changed }
      : { kind: 'original', docxIndex: block.docxIndex },
  ])
  const output = await saveDocx(parsed, plan, { preserveCoreProperties: true })
  const saved = await JSZip.loadAsync(output)
  // The native save can also apply document-wide maintenance. Only the
  // approved paragraph may differ in this scoped operation.
  if (await original.file(main)?.async('string') !== before ||
    await saved.file(main)?.async('string') !== before.slice(0, source.start) + changed + before.slice(source.end)) {
    throw new Error('DOCX body changed outside the target')
  }
  const entries = (zip: JSZip) => Object.values(zip.files).filter(part => !part.dir).map(part => part.name).sort()
  const names = entries(original)
  if (JSON.stringify(names) !== JSON.stringify(entries(saved))) throw new Error('DOCX package structure changed')
  for (const name of names) {
    if (name === main) continue
    const left = await original.file(name)!.async('nodebuffer')
    const right = await saved.file(name)!.async('nodebuffer')
    if (!left.equals(right)) throw new Error('DOCX package part changed')
  }
  const reopened = await parseDocx(output)
  const target = reopened.blocks.find(block => block.docxIndex === edit.docxIndex && !block.hidden)
  if (!target || textOf(target) !== edit.replacement) throw new Error('DOCX reopen verification failed')
  return output
}

try {
  const output = await replace(workerData.bytes, workerData.edit)
  parentPort!.postMessage({ bytes: output })
} catch {
  parentPort!.postMessage({ failed: true })
}
