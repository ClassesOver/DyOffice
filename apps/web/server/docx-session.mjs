/**
 * DOCX text edits go through GenOffice's docx-engine (parseDocx / saveDocx).
 * Untouched blocks are passed through as original OOXML slices. This module
 * does not reimplement the package format. The process must be started with
 * `node --import tsx` so the engine's TypeScript sources can load.
 */

export class DocumentEditError extends Error {
  constructor(status, message, publicCode) {
    super(message)
    this.name = 'DocumentEditError'
    this.status = status
    this.publicCode = publicCode
  }
}

const TEXT_TYPES = new Set(['paragraph', 'heading', 'listItem'])
const COMPLEX_XML = /<(?:w:tab|w:br|w:cr|w:drawing|w:pict|w:object|w:fldChar|w:instrText|w:footnoteReference|w:endnoteReference|w:sym|w:ruby|w:commentRangeStart|w:commentRangeEnd|w:ins|w:del|w:moveFrom|w:moveTo|w:sdt|w:sectPr|w:hyperlink|m:oMath)\b/
const MAX_BLOCKS = 5000
const MAX_TEXT = 100_000

let enginePromise
function loadEngine() {
  enginePromise ??= import('../../../packages/docx-engine/src/index.ts')
  return enginePromise
}

function fail(status, message, publicCode) {
  throw new DocumentEditError(status, message, publicCode)
}

function blockText(block) {
  return (block.runs ?? []).map(run => run.text ?? '').join('')
}

function projectionText(block) {
  if (TEXT_TYPES.has(block.type)) return blockText(block)
  return block.previewText || block.label || ''
}

function runIsComplex(run) {
  return Boolean(run.link || run.math || run.image || run.sym || run.ruby || run.noteRef || run.ins || run.del ||
    run.instrField || run.refField || run.fldBeginXml || run.sdtCheckboxXml || run.xeTerm || run.commentIds?.length || run.rPrChange)
}

/** Plain paragraphs can be rewritten from their text. Everything else stays an original slice. */
export function isPlainTextBlock(block) {
  if (!TEXT_TYPES.has(block.type) || block.hidden || block.docxIndex == null) return false
  if (block.sdtShell || block.pPrChangeInfo || block.paraMarkDel || block.numberingChange || block.sectPrChange) return false
  if (block.commentStarts?.length || block.commentEnds?.length) return false
  if (COMPLEX_XML.test(block.originalXml || '')) return false
  const runs = block.runs ?? []
  if (runs.some(runIsComplex)) return false
  const marks = new Set(runs.map(run => run.rawRPr || ''))
  return marks.size <= 1
}

function visibleBlocks(parsed) {
  return parsed.blocks.filter(block => !block.hidden && block.docxIndex != null)
}

function generatedFrom(block, text) {
  const source = block.runs?.[0]
  const generated = { type: block.type, runs: [source ? { ...source, text } : { text }] }
  for (const key of ['level', 'outlineOnly', 'styleId', 'list', 'format', 'rawPPr', 'bookmarks', 'hiddenBookmarks']) {
    if (block[key] !== undefined) generated[key] = block[key]
  }
  return generated
}

export async function projectDocx(bytes) {
  let parsed
  try {
    const { parseDocx } = await loadEngine()
    parsed = await parseDocx(bytes)
  } catch (error) {
    if (error instanceof DocumentEditError) throw error
    console.error('docx parse failed', error instanceof Error ? error.name : 'Error')
    fail(400, '文件不是可编辑的 DOCX', 'INVALID_DOCUMENT')
  }
  return visibleBlocks(parsed).map(block => ({
    docxIndex: block.docxIndex,
    type: block.type,
    text: projectionText(block),
    editable: isPlainTextBlock(block),
  }))
}

function instructionError(message) {
  fail(400, message, 'INVALID_DOCUMENT')
}

/**
 * Apply a client block list. Every visible original block must appear once.
 * Plain-text changes become generated paragraphs; other blocks keep their bytes.
 */
export async function applyDocxTextEdits(bytes, instructions) {
  if (!Array.isArray(instructions) || instructions.length > MAX_BLOCKS) instructionError('文档结构无效')
  let parsed
  try {
    const { parseDocx, saveDocx } = await loadEngine()
    parsed = await parseDocx(bytes)
    const visible = visibleBlocks(parsed)
    const byIndex = new Map(visible.map(block => [block.docxIndex, block]))
    const seen = new Set()
    const saveBlocks = []
    for (const item of instructions) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) instructionError('文档结构无效')
      const keys = Object.keys(item)
      if (keys.some(key => !['docxIndex', 'text', 'deleted'].includes(key))) instructionError('文档结构无效')
      if (item.docxIndex === undefined) {
        if (item.deleted) instructionError('新建段落不能删除')
        if (typeof item.text !== 'string' || item.text.length > MAX_TEXT) instructionError('段落文本无效')
        saveBlocks.push({ kind: 'generated', block: { type: 'paragraph', runs: [{ text: item.text }] } })
        continue
      }
      if (typeof item.docxIndex !== 'number' || !Number.isSafeInteger(item.docxIndex) || item.docxIndex < 0) instructionError('段落编号无效')
      const block = byIndex.get(item.docxIndex)
      if (!block || seen.has(item.docxIndex)) instructionError('文档结构不完整')
      seen.add(item.docxIndex)
      if (item.deleted) {
        if (!isPlainTextBlock(block)) instructionError('该内容不能删除')
        continue
      }
      const plain = isPlainTextBlock(block)
      if (item.text !== undefined) {
        if (typeof item.text !== 'string' || item.text.length > MAX_TEXT) instructionError('段落文本无效')
        if (!plain && item.text !== blockText(block)) instructionError('该内容不能按纯文本修改')
        if (plain && item.text !== blockText(block)) {
          saveBlocks.push({ kind: 'generated', docxIndex: block.docxIndex, block: generatedFrom(block, item.text) })
          continue
        }
      }
      saveBlocks.push({ kind: 'original', docxIndex: block.docxIndex })
    }
    for (const block of visible) {
      if (!seen.has(block.docxIndex)) instructionError('文档结构不完整')
    }
    return await saveDocx(parsed, saveBlocks)
  } catch (error) {
    if (error instanceof DocumentEditError) throw error
    console.error('docx save failed', error instanceof Error ? error.name : 'Error')
    fail(400, '文档无法保存', 'INVALID_DOCUMENT')
  }
}
