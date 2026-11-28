import type { ZipLimits } from '@genoffice/zip-gate'
import { finiteDecimalCellValue } from '../shared/decimal-cell-value.ts'
import { booleanCellText, decodeCellMarkup, readSharedStrings } from './xlsx-cell-text.ts'
import { decodeXmlText } from './xlsx-escapes.ts'
import { escapeRegExp, parseRelationships, parseSheetElements, relationshipIdsMatch } from './xlsx-sheets.ts'
import { resolvedStyleEntries } from './xlsx-style-entries.ts'
import { isWorkbookSheetRelationship, readWorkbookPartPath, resolveWorkbookSheetTarget } from './xlsx-workbook-parts.ts'
import { decodeCellText, sharedStringAt } from './xlsx-worksheet-xml.ts'
import { createBufferEntrySource } from './xlsx-zip.ts'

interface SheetRowLimits {
  zip: ZipLimits
  rows: number
  columns: number
  cellCharacters: number
  totalCharacters: number
}

/**
 * A worksheet read as plain text rows — the values as the file stores them.
 *
 * The editable model (readBasicWorkbook) keeps a formula as a formula and
 * drops the value Excel cached for it, which is the wrong answer for a reader
 * that wants the data itself: a data source (the recipient list of a mail
 * merge) holds what the file last calculated. So the cell's own <v> is what
 * this reads, exactly like the pivot source reader does.
 *
 * The first sheet is read unless a sheet is named. genoffice#2097.
 */
export async function readSheetRows(buffer: Uint8Array, sheetName?: string, limits?: SheetRowLimits): Promise<string[][]> {
  const zip = await createBufferEntrySource(buffer, limits?.zip)
  const workbookXml = await zip.readText('xl/workbook.xml')
  const sharedStrings = await readSharedStrings(zip)
  const name = sheetName ?? firstSheetName(workbookXml)
  const worksheetXml = await zip.readText(await resolveWorksheetPath(zip, name))
  const stylesPath = await readWorkbookPartPath(zip, 'styles')
  const dateStyles = (await zip.has(stylesPath))
    ? dateStyleIndexes(await zip.readText(stylesPath))
    : new Set<number>()
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbookXml)
  return worksheetRows(worksheetXml, sharedStrings, { dateStyles, date1904 }, limits)
}

/** how a worksheet's numbers read as text */
interface RowTextOptions {
  /** cellXfs indexes whose number format is a date or a time */
  dateStyles: ReadonlySet<number>
  date1904: boolean
}

/** the built-in number formats that are dates or times (ECMA-376 18.8.30) */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
])

/** a custom format code is a date when a date token survives the literals and the colour/condition brackets */
export function isDateFormatCode(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
  if (/[#0?@]/.test(bare) && !/[ymdh]/i.test(bare)) return false
  return /[ymdh]/i.test(bare) || /s/.test(bare)
}

/** the cellXfs indexes whose number format is a date or a time */
export function dateStyleIndexes(stylesXml: string): Set<number> {
  // Entries as the sidecar reads them: a wrapped (mc:AlternateContent) numFmt
  // or xf is one entry, read through its Fallback — a Choice branch may give
  // the same numFmtId another format code.
  const custom = new Set<number>()
  const numFmts = /<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/.exec(stylesXml)?.[1] ?? ''
  for (const numFmt of resolvedStyleEntries(numFmts, 'numFmt')) {
    const attributes = /^<numFmt\b([^>]*?)\/?>/.exec(numFmt)?.[1] ?? ''
    const id = Number(readXmlAttribute(attributes, 'numFmtId'))
    const code = decodeXmlText(readXmlAttribute(attributes, 'formatCode') ?? '')
    if (Number.isFinite(id) && isDateFormatCode(code)) custom.add(id)
  }
  const out = new Set<number>()
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? ''
  for (const [index, xf] of resolvedStyleEntries(cellXfs, 'xf').entries()) {
    const id = Number(readXmlAttribute(/^<xf\b([^>]*?)\/?>/.exec(xf)?.[1] ?? '', 'numFmtId'))
    if (BUILTIN_DATE_FORMATS.has(id) || custom.has(id)) out.add(index)
  }
  return out
}

/** an Excel serial as ISO text: the date, and the time when the serial carries one */
export function serialDateText(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const ms = Math.round((serial + (!date1904 && serial < 60 ? 1 : 0)) * 86_400_000)
  const date = new Date(epoch + ms)
  if (Number.isNaN(date.getTime())) return String(serial)
  const iso = date.toISOString()
  const dayPart = iso.slice(0, 10)
  const timePart = iso.slice(11, 19)
  if (serial < 1) return timePart
  return timePart === '00:00:00' ? dayPart : `${dayPart} ${timePart}`
}

/** the name of the first sheet in workbook.xml */
function firstSheetName(workbookXml: string): string {
  const sheetPattern = /<sheet\b((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g
  const match = sheetPattern.exec(workbookXml)
  const name = match ? readXmlAttribute(match[1] ?? '', 'name') : undefined
  if (!name) throw new Error('Workbook contains no readable worksheets.')
  return decodeXmlText(name)
}

/** the zero-based column an A1 address names */
function columnIndexOf(address: string): number {
  const match = /^\$?([A-Z]+)\$?[0-9]+$/.exec(address)
  if (!match) return -1
  let column = 0
  for (const character of match[1]!) column = column * 26 + character.charCodeAt(0) - 64
  return column - 1
}

/** the text of one cell, whatever the file stored it as */
function cellText(
  body: string,
  type: string | undefined,
  sharedStrings: readonly string[],
  asDate = false,
  date1904 = false,
): string {
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((textMatch) => decodeCellText(textMatch[1] ?? ''))
      .join('')
  }
  const rawValue = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1]
  if (rawValue === undefined) return ''
  if (type === 's') return sharedStringAt(sharedStrings, decodeCellMarkup(rawValue)) ?? ''
  if (type === 'str') return decodeCellText(rawValue)
  if (type === 'b') return booleanCellText(decodeCellMarkup(rawValue))
  // a number keeps the file's own spelling, except that a date-formatted
  // cell reads as a date, not as the serial the file holds
  const text = decodeCellText(rawValue)
  if (asDate && (type === undefined || type === 'n')) {
    const serial = finiteDecimalCellValue(decodeCellMarkup(rawValue))
    if (serial !== null) return serialDateText(serial, date1904)
  }
  return text
}

/** the rows of a worksheet, in file order; a row that is not there is empty */
function worksheetRows(
  worksheetXml: string,
  sharedStrings: readonly string[],
  options: RowTextOptions,
  limits?: SheetRowLimits,
): string[][] {
  const rows: string[][] = []
  let characters = 0
  const rowPattern = /<row\b([^>]*)>([\s\S]*?)<\/row>/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowPattern.exec(worksheetXml)) !== null) {
    const rowNumber = Number(readXmlAttribute(rowMatch[1] ?? '', 'r'))
    const rowIndex = Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber - 1 : rows.length
    if (limits && rowIndex >= limits.rows) throw new RangeError('Recipient list exceeds its row limit.')
    const cells: string[] = []
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellPattern.exec(rowMatch[2] ?? '')) !== null) {
      const attributes = cellMatch[1] ?? ''
      const address = readXmlAttribute(attributes, 'r')
      const column = address ? columnIndexOf(address) : cells.length
      if (column < 0) continue
      if (limits && column >= limits.columns) throw new RangeError('Recipient list exceeds its column limit.')
      const style = Number(readXmlAttribute(attributes, 's'))
      const value = cellText(
        cellMatch[2] ?? '',
        readXmlAttribute(attributes, 't'),
        sharedStrings,
        options.dateStyles.has(style),
        options.date1904,
      )
      characters += value.length
      if (limits && (value.length > limits.cellCharacters || characters > limits.totalCharacters)) {
        throw new RangeError('Worksheet text exceeds its size limit.')
      }
      while (cells.length < column) cells.push('')
      cells[column] = value
    }
    while (rows.length < rowIndex) rows.push([])
    rows[rowIndex] = cells
  }
  return rows
}

export async function resolveWorksheetPath(
  reader: { readText(path: string): Promise<string> },
  sheetName: string,
): Promise<string> {
  const workbookXml = await reader.readText('xl/workbook.xml')
  const relationshipId = parseSheetElements(workbookXml).find((element) => element.name === sheetName)?.relationshipId
  if (relationshipId === undefined)
    throw new Error(`Sheet "${sheetName}" was not found in workbook.xml.`)

  const relationshipsXml = await reader.readText('xl/_rels/workbook.xml.rels')
  const relationship = parseRelationships(relationshipsXml).find(({ id }) => relationshipIdsMatch(id, relationshipId))
  if (!relationship?.target || !isWorkbookSheetRelationship(relationship)) {
    throw new Error(`Worksheet relationship ${relationshipId} was not found.`)
  }
  return resolveWorkbookSheetTarget(relationship.target)
}

function readXmlAttribute(attributes: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${escapeRegExp(name)}="([^"]*)"`).exec(attributes)?.[1]
}
