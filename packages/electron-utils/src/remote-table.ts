/// Fetch a table from a remote source, for a workbook's data connection.
///
/// A workbook's web query names a URL; refreshing it means fetching that
/// address and reading the table out of the answer. (A text query names a local
/// file instead, which the SSRF gate rightly refuses, so only web queries are
/// refreshed for now.) This module does the fetch and the reading, and nothing
/// else: no workbook is touched here, the caller decides where the rows land.
///
/// The fetch goes through the SSRF gate (`fetchWithSsrfGuard`), because the
/// address comes out of a file the app did not write — a workbook could name
/// loopback, a cloud metadata endpoint or a UNC share. The body is capped, and
/// so is the table: a page that answers with a gigabyte of markup must not
/// turn into a gigabyte of cells.
import { fetchWithSsrfGuard } from './safe-remote-url'
import { readBodyCapped } from './remote-image'
import { parseFragment } from 'parse5'

/// A table this large is already past what a spreadsheet shows; the cap keeps
/// a hostile page from turning into an allocation spike.
export const MAX_REMOTE_TABLE_BYTES = 16 * 1024 * 1024
export const MAX_REMOTE_TABLE_ROWS = 50_000
export const MAX_REMOTE_TABLE_COLUMNS = 1_000
/// Cells longer than this are clipped: a page can put a whole document into
/// one cell, and the value would be unreadable in the grid anyway.
export const MAX_REMOTE_TABLE_CELL_CHARS = 32_767
/// A server that trickles its answer must not pin the refresh (and its status
/// bar) forever: the caller has no cancel button, so the fetch owns a deadline.
export const REMOTE_TABLE_TIMEOUT_MS = 30_000

export type RemoteTableSource = 'html' | 'csv'

export interface RemoteTable {
  /// The first row of the source, treated as the header.
  readonly headers: readonly string[]
  /// Data rows, header excluded.
  readonly rows: readonly (readonly string[])[]
  readonly source: RemoteTableSource
  /// The address the table came from.
  readonly url: string
}

interface TextNode {
  readonly nodeName: '#text'
  readonly value: string
}

interface ElementNode {
  readonly nodeName: string
  readonly tagName?: string
  readonly value?: string
  readonly childNodes?: readonly TreeNode[]
}

type TreeNode = TextNode | ElementNode
type TableBudget = { nodes: number; cells: number; characters: number }

function isElement(node: TreeNode): node is ElementNode {
  return node.nodeName !== '#text'
}

function childrenOf(node: TreeNode): readonly TreeNode[] {
  return isElement(node) ? (node.childNodes ?? []) : []
}

/** Visible text of a node: text descendants, whitespace collapsed. */
function textOf(node: TreeNode, budget?: TableBudget): string {
  if (budget && --budget.nodes < 0) throw new RangeError('Table exceeds the node limit')
  if (!isElement(node)) {
    if (budget && (budget.characters -= node.value.length) < 0) throw new RangeError('Table exceeds the text limit')
    return node.value
  }
  let out = ''
  for (const child of childrenOf(node)) out += textOf(child, budget)
  return out
}

function findElements(node: TreeNode, tagName: string, budget?: TableBudget): ElementNode[] {
  if (budget && --budget.nodes < 0) throw new RangeError('Table exceeds the node limit')
  const out: ElementNode[] = []
  if (isElement(node) && node.tagName === tagName) out.push(node)
  for (const child of childrenOf(node)) out.push(...findElements(child, tagName, budget))
  return out
}

function cellsOf(row: ElementNode, budget?: TableBudget): string[] {
  const cells: string[] = []
  for (const cell of childrenOf(row)) {
    if (!isElement(cell)) continue
    if (cell.tagName !== 'td' && cell.tagName !== 'th') continue
    if (budget && --budget.cells < 0) throw new RangeError('Table exceeds the cell limit')
    cells.push(textOf(cell, budget).replace(/\s+/g, ' ').trim())
  }
  return cells
}

function rowsOf(table: ElementNode, budget?: TableBudget): string[][] {
  const rows: string[][] = []
  for (const tr of findElements(table, 'tr', budget)) {
    const cells = cellsOf(tr, budget)
    if (cells.length > 0) rows.push(cells)
    if (rows.length >= MAX_REMOTE_TABLE_ROWS) break
  }
  return rows
}

/**
 * The table a page offers. Excel's web query takes the first table on the page
 * unless the query says otherwise, so that is what this does too — but a page
 * whose first table is a one-cell layout wrapper would be useless, so the
 * widest table wins when the first one is empty.
 */
export function parseHtmlTable(html: string, budget?: TableBudget): RemoteTable | null {
  let fragment: TreeNode
  try {
    fragment = parseFragment(html) as unknown as TreeNode
  } catch {
    return null
  }
  const tables = findElements(fragment, 'table', budget)
  if (tables.length === 0) return null
  const candidate = tables
    .map(table => rowsOf(table, budget))
    .filter((rows) => rows.length > 0)
    .sort((a, b) => b.length - a.length)[0]
  if (!candidate || candidate.length === 0) return null
  const width = Math.min(Math.max(...candidate.map((row) => row.length)), MAX_REMOTE_TABLE_COLUMNS)
  const normalized = candidate.map((row) => row.slice(0, width))
  const [headers, ...rows] = normalized
  return {
    headers: headers ?? [],
    rows,
    source: 'html',
    url: '',
  }
}

/** Picks the delimiter a delimited file uses, by counting candidates per line. */
export function detectDelimiter(text: string): ',' | '\t' | ';' {
  const sample = text.slice(0, 64 * 1024)
  let best: ',' | '\t' | ';' = ','
  let bestCount = 0
  for (const candidate of [',', '\t', ';'] as const) {
    let count = 0
    let inQuotes = false
    for (let i = 0; i < sample.length; i++) {
      const ch = sample[i]
      if (ch === '"') inQuotes = !inQuotes
      else if (ch === candidate && !inQuotes) count++
    }
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/** One delimited row, with the quoting rules Excel writes. */
export function parseDelimitedRow(line: string, delimiter: string, budget?: TableBudget): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      current += ch
      i++
      continue
    }
    if (ch === '"' && current === '') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      if (budget && --budget.cells < 0) throw new RangeError('Table exceeds the cell limit')
      cells.push(current)
      current = ''
      i++
      continue
    }
    current += ch
    i++
  }
  if (budget && --budget.cells < 0) throw new RangeError('Table exceeds the cell limit')
  cells.push(current)
  return cells
}

/**
 * A delimited file as a table. Excel's web query treats the first row as the
 * header, and so does this.
 */
export function parseDelimitedTable(text: string, delimiter?: string, budget?: TableBudget): RemoteTable | null {
  const body = text.replace(/^\uFEFF/, '')
  const lines = body.split(/\r\n|\n|\r/).filter((line) => line.length > 0)
  if (lines.length === 0) return null
  const sep = delimiter ?? detectDelimiter(body)
  const parsed = lines.slice(0, MAX_REMOTE_TABLE_ROWS).map((line) => parseDelimitedRow(line, sep, budget))
  const width = Math.min(Math.max(...parsed.map((row) => row.length)), MAX_REMOTE_TABLE_COLUMNS)
  const normalized = parsed.map((row) => row.slice(0, width))
  const [headers, ...rows] = normalized
  return { headers: headers ?? [], rows, source: 'csv', url: '' }
}

function clipCell(text: string): string {
  return text.length > MAX_REMOTE_TABLE_CELL_CHARS
    ? `${text.slice(0, MAX_REMOTE_TABLE_CELL_CHARS - 1)}…`
    : text
}

/** Clips every cell and drops a trailing empty row, as a page often ends with one. */
function finish(table: RemoteTable): RemoteTable {
  const clip = (row: readonly string[]): string[] => row.map((cell) => clipCell(cell))
  const rows = table.rows.map(clip)
  while (rows.length > 0 && rows[rows.length - 1]!.every((cell) => cell === '')) rows.pop()
  return { ...table, headers: clip(table.headers), rows }
}

/**
 * Fetches a table over HTTP. Returns null when the address is refused by the
 * SSRF gate, the answer is not a table, or the body cannot be read — the
 * caller shows the same "could not refresh" message for all of them, so the
 * reason stays out of the UI.
 */
export async function fetchRemoteTable(
  rawUrl: string,
  options: {
    readonly fetchImpl?: typeof fetch
    readonly directPublic?: boolean
    readonly signal?: AbortSignal
    readonly maxBytes?: number
    readonly timeoutMs?: number
  } = {},
): Promise<RemoteTable | null> {
  let response: Response | null
  const deadline = AbortSignal.timeout(options.timeoutMs ?? REMOTE_TABLE_TIMEOUT_MS)
  try {
    response = await fetchWithSsrfGuard(rawUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml,text/csv,text/plain;q=0.9,*/*;q=0.5',
      },
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.directPublic ? { directPublic: true } : {}),
      signal: options.signal ? AbortSignal.any([options.signal,deadline]) : deadline,
    })
  } catch {
    return null
  }
  if (!response) return null
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  let bytes: Uint8Array
  try {
    bytes = await readBodyCapped(response, options.maxBytes ?? MAX_REMOTE_TABLE_BYTES)
  } catch {
    return null
  }
  const contentType = response.headers.get('content-type') ?? ''
  const text = new TextDecoder('utf-8').decode(bytes)
  const looksDelimited = /text\/csv|text\/plain|application\/csv/i.test(contentType)
  // A CSV answer sometimes arrives as text/html. Falling back to the delimited
  // reader is only safe while the body does not look like markup — otherwise
  // every page on the web would come back as a one-row table.
  const markupStart = text.search(/<[a-z!/]/i)
  const looksLikeMarkup = markupStart >= 0 && markupStart < text.lastIndexOf('>')
  const budget = options.directPublic ? { nodes: 500_000, cells: 100_000, characters: 2 * 1024 * 1024 } : undefined
  try {
    const table = looksDelimited
      ? parseDelimitedTable(text, undefined, budget)
      : (parseHtmlTable(text, budget) ?? (looksLikeMarkup ? null : parseDelimitedTable(text, undefined, budget)))
    return table ? { ...finish(table), url: rawUrl } : null
  } catch {
    return null
  }
}
