import type { MergeDataSource, MergeOutputRequest, MergeOutputResponse } from '../../../docs/src/shared/ipc'
import { BROWSER_MAIL_MERGE_MAX_OUTPUT_BYTES, mergeSourceFromRows } from '../../../docs/src/shared/merge-data'
import { csvRows, decodeCsvBuffer, sniffDelimiter } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { browserFileName, downloadBrowserFile } from './browser-download'

export const MAIL_MERGE_SOURCE_MAX_BYTES = 16 * 1024 * 1024
const ROW_LIMIT = 1001
const COLUMN_LIMIT = 256
const CELL_CHARACTER_LIMIT = 8192
const TOTAL_CHARACTER_LIMIT = 4 * 1024 * 1024
const WORKBOOK_LIMITS = {
  rows: ROW_LIMIT,
  columns: COLUMN_LIMIT,
  cellCharacters: CELL_CHARACTER_LIMIT,
  totalCharacters: TOTAL_CHARACTER_LIMIT,
  zip: { maxParts: 10000, maxPartBytes: 24 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 },
}

export async function readMailMergeSource(file: File, language: string, signal: AbortSignal): Promise<MergeDataSource> {
  const extension = file.name.split('.').pop()?.toLowerCase()
  const en = language === 'en'
  if (extension !== 'csv' && extension !== 'xlsx') {
    throw new Error(en ? 'Choose a CSV or XLSX recipient list.' : '请选择 CSV 或 XLSX 收件人列表。')
  }
  if (file.size === 0 || file.size > MAIL_MERGE_SOURCE_MAX_BYTES) {
    throw new Error(en ? 'Choose a nonempty recipient list up to 16 MiB.' : '请选择不超过 16 MiB 的非空收件人列表。')
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  signal.throwIfAborted()
  const rows: string[][] = []
  try {
    if (extension === 'csv') {
      const csv = decodeCsvBuffer(bytes, language)
      let characters = 0
      for (const row of csvRows(csv, sniffDelimiter(csv), {signal})) {
        characters += row.reduce((sum, cell) => sum + cell.length, 0)
        if (rows.length >= ROW_LIMIT || row.length > COLUMN_LIMIT || characters > TOTAL_CHARACTER_LIMIT ||
            row.some(cell => cell.length > CELL_CHARACTER_LIMIT)) throw new RangeError()
        rows.push(row)
      }
    } else {
      const { readSheetRows } = await import('@genoffice/xlsx-gateway/gateway/xlsx-row-reader')
      rows.push(...await readSheetRows(bytes, undefined, WORKBOOK_LIMITS))
    }
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(en ? 'The recipient list exceeds its limits of 1,000 records, 256 columns, 8,192 characters per cell, or 4 Mi characters total.' : '收件人列表最多支持 1,000 条记录、256 列、每格 8,192 个字符及总计 4,194,304 个字符。')
    }
    throw new Error(en ? 'The recipient list could not be read.' : '无法读取收件人列表。')
  }
  signal.throwIfAborted()
  return mergeSourceFromRows(crypto.randomUUID(), file.name, rows)
}

export async function downloadMailMerge(
  { mode, files }: MergeOutputRequest,
  templateName: string,
  signal: AbortSignal,
): Promise<MergeOutputResponse> {
  signal.throwIfAborted()
  if (!files.length || files.length > ROW_LIMIT - 1 || files.some(file => !file.data.byteLength) ||
      files.reduce((sum, file) => sum + file.data.byteLength, 0) > BROWSER_MAIL_MERGE_MAX_OUTPUT_BYTES) {
    return { ok:false }
  }
  const asDocx = (name: string) => browserFileName(name.replace(/\.docx$/i, ''), 'document') + '.docx'
  if (mode === 'single' || mode === 'labels') {
    if (files.length !== 1) return { ok:false }
    const file = files[0]!
    const name = asDocx(file.name)
    downloadBrowserFile(new Blob([file.data], {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}), name)
    return { ok:true, path:name, count:1 }
  }

  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const used = new Set<string>()
  for (const file of files) {
    const name = asDocx(file.name)
    const stem = name.slice(0, -5)
    let entry = name
    for (let i = 2; used.has(entry.toLowerCase()); i++) entry = `${stem}-${i}.docx`
    used.add(entry.toLowerCase())
    zip.file(entry, file.data)
  }
  const archive = await zip.generateAsync({type:'blob',compression:'STORE'})
  signal.throwIfAborted()
  const name = browserFileName(templateName.replace(/\.docx$/i, ''), 'document') + '-merged.zip'
  downloadBrowserFile(archive, name)
  return { ok:true, path:name, count:files.length }
}
