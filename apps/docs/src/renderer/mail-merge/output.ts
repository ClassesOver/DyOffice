import { mergeOutputFileName, type MergeRecord } from '@genoffice/docx-engine'
import type { MergeOutputMode } from '../../shared/ipc'
import { buildDocBytes, type FileActionContext } from '../file-actions'
import type { PmNode } from '../editor/convert'
import { mergeAllRecords, substituteMergeFields } from './template'
import { cellContentOf, labelSheetDoc, layoutSection, type MergePageLayout } from './layout'

/**
 * The output half of the mail merge: the documents the merge writes.
 *
 * The letters are the template with one record's values in it, serialized the
 * way the document itself is serialized — so a merged letter keeps the
 * template's styles, sections, headers and pictures, and carries no field
 * code any more. genoffice#2097.
 */

/** what the user asked the merge to write */
export interface MailMergeRequest {
  /** one document for all the records, or one document per record */
  mode: MergeOutputMode
  /** the records to merge */
  records: readonly MergeRecord[]
  /** the column names of the data source */
  fields: readonly string[]
  /** the field the file names come from; empty takes the first field */
  namePattern: string
  /** the paper the labels or envelopes print on; the label and envelope modes need it */
  layout?: MergePageLayout
}

/** one merged document, ready to be written */
export interface MailMergeFile {
  /** the file name, without a folder */
  name: string
  /** the .docx bytes */
  bytes: Uint8Array
}

/** the answer to a merge: what was written, or what went wrong */
export interface MailMergeResponse {
  ok: boolean
  /** how many documents were written */
  count?: number
  /** the file that was written (one document for all the records) */
  path?: string
  /** the folder the documents went into (one document per record) */
  folder?: string
  /** the user closed the dialog without choosing */
  canceled?: boolean
  error?: string
}

/**
 * The documents a merge writes.
 *
 * One document per record is the letter case: every record gets its own
 * letter, named after the record. One document for all the records is the
 * directory case: the letters follow each other, each on its own page. The
 * label case is one label-sheet document with the records in a grid; the
 * envelope case is one document per record on the envelope's paper.
 */
export async function buildMailMergeFiles(
  ctx: FileActionContext,
  request: MailMergeRequest,
  outputLimit?: { bytes: number; message: string },
): Promise<MailMergeFile[]> {
  const editor = ctx.editor
  if (!editor || request.records.length === 0) return []
  const template = editor.getJSON() as PmNode
  const files: MailMergeFile[] = []
  let outputBytes = 0
  function include(name: string, bytes: Uint8Array) {
    outputBytes += bytes.byteLength
    if (outputLimit && outputBytes > outputLimit.bytes) throw new Error(outputLimit.message)
    files.push({ name, bytes })
  }
  const newStructureCheck = () => outputLimit
    ? makeStructureCheck(outputLimit.bytes / 4, outputLimit.message)
    : undefined
  const checkStructure = newStructureCheck()
  if (request.mode === 'labels' || request.mode === 'envelopes') {
    if (!request.layout) return []
    // the output prints on the layout's paper, not the template's
    const section = layoutSection(request.layout, ctx.section)
    if (request.mode === 'labels') {
      const cells = request.records.map((record) => {
        const content = cellContentOf(substituteMergeFields(template, record))
        checkStructure?.(content)
        return content
      })
      const bytes = await buildDocBytes(ctx, labelSheetDoc(cells, request.layout), section)
      if (bytes) include(mergedDocumentName(ctx), bytes)
      return files
    }
    for (const record of request.records) {
      const merged = substituteMergeFields(template, record)
      newStructureCheck()?.(merged)
      const bytes = await buildDocBytes(ctx, merged, section)
      if (!bytes && outputLimit) return []
      if (!bytes) continue
      include(`${mergeOutputFileName(request.namePattern, record, request.fields)}.docx`, bytes)
    }
    return files
  }
  if (request.mode === 'perRecord') {
    for (const record of request.records) {
      const merged = substituteMergeFields(template, record)
      newStructureCheck()?.(merged)
      const bytes = await buildDocBytes(ctx, merged)
      if (!bytes && outputLimit) return []
      if (!bytes) continue
      include(`${mergeOutputFileName(request.namePattern, record, request.fields)}.docx`, bytes)
    }
    return files
  }
  const bytes = await buildDocBytes(ctx, mergeAllRecords(template, request.records, checkStructure))
  if (bytes) include(mergedDocumentName(ctx), bytes)
  return files
}

/** Stop repeated letters before materializing a large XML document. */
function makeStructureCheck(remaining: number, message: string) {
  function visit(value: unknown) {
    remaining -= typeof value === 'string' ? value.length + 2 : 8
    if (remaining < 0) throw new Error(message)
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child)
    }
  }
  return visit
}

/** the name of the document that holds every letter */
function mergedDocumentName(ctx: FileActionContext): string {
  const base = (ctx.doc?.fileName ?? 'document').replace(/\.docx$/i, '')
  return `${mergeOutputFileName(base, {}, [])}-merged.docx`
}
