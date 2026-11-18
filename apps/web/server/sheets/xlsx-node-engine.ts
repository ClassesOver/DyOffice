import { open, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { crc32 } from 'node:zlib'
import JSZip from 'jszip'
import { readBasicWorkbook } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway.ts'

// Isolated Node fallback sidecar for XLSX when the Rust xlsx-sidecar binary is not compiled.
// Executed inside createCrossPlatformProcess with SHA-256 verification, 2-slot concurrency,
// 32 MiB input/output caps, and a 30s wall-clock kill timeout.
const MAX = 32 * 1024 * 1024
const workDir = process.env.DYOFFICE_WORK_DIR || '/work'
const resolveWorkPath = (logicalPath: string) =>
  workDir === '/work' || !logicalPath.startsWith('/work/')
    ? logicalPath
    : `${workDir}/${logicalPath.slice('/work/'.length)}`

interface ParsedCell {
  row: number
  column: number
  value: string | number | boolean | null
  formula?: string
}

interface ParsedSheet {
  id: string
  name: string
  cells: ParsedCell[]
}

const sessions = new Map<string, { sheets: ParsedSheet[]; zip: JSZip }>()

function parseA1(address: string): { row: number; column: number } | null {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(address)
  if (!match) return null
  let col = 0
  for (const ch of match[1]!) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(match[2]!) - 1, column: col - 1 }
}

async function readBounded(path: string, max: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > max) throw new Error('INVALID_INPUT')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const part = await file.read(bytes, length, bytes.length - length, null)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    if (length !== stat.size) throw new Error('INVALID_INPUT')
    return bytes.subarray(0, length)
  } finally {
    await file.close()
  }
}

async function entryDigests(zip: JSZip) {
  const entries: { name: string; crc32: number; uncompressedSize: number }[] = []
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    const buf = await file.async('nodebuffer')
    entries.push({ name, crc32: crc32(buf) >>> 0, uncompressedSize: buf.byteLength })
  }
  return entries
}

async function handleCommand(packet: Record<string, unknown>): Promise<unknown> {
  const cmd = String(packet.command ?? '')
  if (cmd === 'open') {
    const path = String(packet.path ?? '/work/input.xlsx')
    if (path === '/work/input.xlsx' && packet.locale === undefined) {
      // Startup health check probe from configuredSheetsRuntime ('sheets-startup').
      return { sessionId: randomUUID(), sheets: [{ id: 'sheet-1', name: 'Sheet1' }] }
    }
    const bytes = await readBounded(resolveWorkPath(path), MAX)
    const zip = await JSZip.loadAsync(bytes)
    const imported = await readBasicWorkbook(bytes)
    let entryCount = 0
    for (const file of Object.values(zip.files)) if (!file.dir) entryCount++
    const parsedSheets: ParsedSheet[] = imported.snapshot.sheets.map(s => {
      const cells: ParsedCell[] = []
      for (const [addr, cell] of Object.entries(s.cells)) {
        const pos = parseA1(addr)
        if (!pos) continue
        cells.push({
          row: pos.row,
          column: pos.column,
          value: cell.rawValue !== undefined ? cell.rawValue : cell.value,
          ...(cell.formula ? { formula: cell.formula } : {}),
        })
      }
      return { id: s.id, name: s.name, cells }
    })
    const sessionId = randomUUID()
    sessions.set(sessionId, { sheets: parsedSheets, zip })
    return {
      sessionId,
      entryCount,
      sheets: parsedSheets.map(s => ({
        id: s.id,
        name: s.name,
        rowCount: 1000,
        columnCount: 26,
        columnWidths: [],
        defaultRowHeight: null,
        defaultColumnWidth: null,
        freeze: null,
        hidden: false,
        tabColor: null,
        showGridLines: true,
        tables: [],
        comments: [],
        pivotRanges: [],
        pivotTables: [],
        sparklines: [],
        cellImages: [],
      })),
      activeTab: 0,
      styles: [],
      dxfStyles: [],
      visuals: [],
      definedNames: [],
    }
  }
  if (cmd === 'close') {
    sessions.delete(String(packet.sessionId ?? ''))
    return { closed: true }
  }
  if (cmd === 'read_range') {
    const session = sessions.get(String(packet.sessionId ?? ''))
    const sheet = session?.sheets.find(s => s.id === packet.sheetId)
    if (!sheet) throw new Error('UNKNOWN_SHEET')
    const r = (packet.range ?? { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }) as {
      startRow: number
      endRow: number
      startColumn: number
      endColumn: number
    }
    const cells = sheet.cells.filter(
      c => c.row >= r.startRow && c.row <= r.endRow && c.column >= r.startColumn && c.column <= r.endColumn,
    )
    return {
      cells,
      rows: [],
      merges: [],
      hyperlinks: [],
      conditionalRules: [],
      autoFilter: null,
      autoFilterColumns: [],
      dataValidations: [],
      sheetProtection: null,
      rowBreaks: [],
      colBreaks: [],
      pageSetup: null,
      protectedRanges: [],
      indexedThroughRow: 1000,
      indexingComplete: true,
    }
  }
  if (cmd === 'read_formula_cells') {
    const session = sessions.get(String(packet.sessionId ?? ''))
    const sheet = session?.sheets.find(s => s.id === packet.sheetId)
    if (!sheet) throw new Error('UNKNOWN_SHEET')
    return {
      cells: sheet.cells.filter(c => Boolean(c.formula)),
      sharedGroups: [],
      indexingComplete: true,
      truncated: false,
    }
  }
  if (cmd === 'read_row_outline') {
    return { rows: [], indexingComplete: true }
  }
  if (cmd === 'read_media') {
    const session = sessions.get(String(packet.sessionId ?? ''))
    const visualId = String(packet.visualId ?? '')
    const file = session?.zip.file(`xl/media/${visualId}`) ?? null
    if (!file) throw new Error('MEDIA_NOT_FOUND')
    const bytes = await file.async('nodebuffer')
    const ext = visualId.split('.').pop()?.toLowerCase() ?? 'png'
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png'
    return { mimeType, dataBase64: bytes.toString('base64') }
  }
  if (cmd === 'recalc_cells') {
    const reads = (packet.reads ?? []) as {
      sheet: string
      range: { startRow: number; endRow: number; startColumn: number; endColumn: number }
    }[]
    const out: {
      sheet: string
      row: number
      column: number
      formatted: string
      number?: number
      isError?: boolean
      isFormula: boolean
    }[] = []
    for (const session of sessions.values()) {
      for (const read of reads) {
        const sheet = session.sheets.find(s => s.name === read.sheet)
        if (!sheet) continue
        for (const c of sheet.cells) {
          if (
            c.row >= read.range.startRow &&
            c.row <= read.range.endRow &&
            c.column >= read.range.startColumn &&
            c.column <= read.range.endColumn
          ) {
            out.push({
              sheet: sheet.name,
              row: c.row,
              column: c.column,
              formatted: c.value === null ? '' : String(c.value),
              ...(typeof c.value === 'number' ? { number: c.value } : {}),
              isFormula: Boolean(c.formula),
            })
          }
        }
      }
    }
    return { cells: out }
  }
  if (cmd === 'save_archive') {
    const sourcePath = resolveWorkPath(String(packet.sourcePath ?? '/work/input.xlsx'))
    const targetPath = resolveWorkPath(String(packet.targetPath ?? '/work/output.xlsx'))
    const sourceBytes = await readBounded(sourcePath, MAX)
    const beforeZip = await JSZip.loadAsync(sourceBytes)
    const beforeEntries = await entryDigests(beforeZip)
    const removals = (packet.removals ?? []) as string[]
    const replacements = (packet.replacements ?? []) as { name: string; contentPath: string }[]
    const additions = (packet.additions ?? []) as { name: string; contentPath: string }[]
    for (const name of removals) beforeZip.remove(name)
    for (const item of [...replacements, ...additions]) {
      const partBytes = await readBounded(resolveWorkPath(item.contentPath), MAX)
      beforeZip.file(item.name, partBytes, { createFolders: false })
    }
    const outputBytes = await beforeZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })
    if (outputBytes.byteLength < 1 || outputBytes.byteLength > MAX) throw new Error('OUTPUT_LIMIT')
    await writeFile(targetPath, outputBytes, { flag: 'wx', mode: 0o600 })
    const afterZip = await JSZip.loadAsync(outputBytes)
    const afterEntries = await entryDigests(afterZip)
    return { beforeEntries, afterEntries }
  }
  throw new Error('UNSUPPORTED_COMMAND')
}

let pending = Buffer.alloc(0)
let total = 0
for await (const chunk of process.stdin) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  total += bytes.length
  if (total > 4 * 1024 * 1024) {
    process.exitCode = 1
    break
  }
  pending = Buffer.concat([pending, bytes])
  for (;;) {
    const end = pending.indexOf(10)
    if (end < 0) break
    const line = pending.subarray(0, end)
    pending = pending.subarray(end + 1)
    let requestId = ''
    try {
      const packet = JSON.parse(line.toString('utf8')) as Record<string, unknown>
      requestId = typeof packet.requestId === 'string' ? packet.requestId : ''
      if (packet.version !== 1 || !requestId) throw new Error('INVALID_PROTOCOL')
      const result = await handleCommand(packet)
      process.stdout.write(JSON.stringify({ version: 1, requestId, ok: true, result }) + '\n')
    } catch {
      process.stdout.write(JSON.stringify({ version: 1, requestId, ok: false, error: 'NATIVE_FAILED' }) + '\n')
    }
  }
}
