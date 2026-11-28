import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { mergeSourceFromRows } from '../shared/merge-data'
import type { MergeDataSource } from '../shared/ipc'
import { decodeCsvBuffer, parseCsv } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { readSheetRows } from '@genoffice/xlsx-gateway/gateway/xlsx-gateway'

/**
 * The data source of a mail merge: the local spreadsheet the records come
 * from. The file is read here, in the main process, because that is where the
 * file system is; the renderer only ever sees the records.
 *
 * The parsing itself belongs to xlsx-gateway (the CSV reader Sheets opens a
 * .csv with, the workbook reader), and the record shape to the docx engine —
 * so a list that opens correctly in Sheets opens correctly here.
 * genoffice#2097.
 */

/** the file extensions a data source may have */
export const MERGE_DATA_SOURCE_EXTENSIONS = ['xlsx', 'csv'] as const

/**
 * Read a local .xlsx or .csv as a mail merge data source.
 *
 * The first sheet of a workbook and the first row of a CSV name the fields;
 * the rows below them are the records.
 */
export async function readMergeDataSource(path: string): Promise<MergeDataSource> {
  const extension = extname(path).toLowerCase()
  const bytes = await readFile(path)
  const rows =
    extension === '.csv'
      ? parseCsv(decodeCsvBuffer(bytes))
      : extension === '.xlsx'
        ? await readSheetRows(bytes)
        : null
  if (!rows) throw new Error(`unsupported data source: ${extension || path}`)
  return mergeSourceFromRows(path, basename(path), rows)
}
