import type { FormulaIndexSheet, RecalculatedCell, RecalcResult } from '../../../../worker/src/native/xlsx.ts'
import { containsUnresolvedNames, parseFormulaReferences } from '../../../../../sheets/src/shared/formula-references.ts'
import { qualifierMatches } from '@genoffice/xlsx-gateway/gateway/xlsx-structure'
import type { SheetsWorkbookPlanner } from '../sheets/save.ts'
import type { SheetsNative } from '../sheets/service.ts'

type CellAddress = Pick<RecalculatedCell, 'sheet' | 'row' | 'column'>
const coordinate = ({ sheet, row, column }: CellAddress) => JSON.stringify([sheet, row, column])
const unavailable = new Set(['#NAME?', '#ERROR!'])
const volatile = /(?:^|[^A-Z0-9_])(?:RAND|RANDBETWEEN|RANDARRAY|NOW|TODAY|OFFSET|INDIRECT|INFO|CELL)\s*\(/i

function cacheValue(cell: RecalculatedCell) {
  if (cell.isError) return { error: cell.formatted }
  if (cell.boolean !== undefined) return cell.boolean
  return cell.number ?? cell.formatted
}

function reusable(cell: RecalculatedCell) {
  if (!cell.isFormula || typeof cell.formatted !== 'string') return false
  if (cell.isError) return !unavailable.has(cell.formatted) && cell.formatted.length <= 32
  if (cell.number !== undefined) return Number.isFinite(cell.number)
  return cell.boolean !== undefined || (cell.formatted.length > 0 && cell.formatted.length <= 10_000)
}

function volatileDependents(index: FormulaIndexSheet[]) {
  const formulas = index.flatMap(({ name: sheet, cells }) => cells.map(cell => ({ ...cell, sheet })))
  const canVary = (formula: string) => formula.split('"').some((text, index) => index % 2 === 0 && volatile.test(text))
  let frontier = formulas.filter(cell => canVary(cell.formula))
  const excluded = new Set(frontier.map(coordinate))
  if (!frontier.length) return excluded

  // Independent audits can compute different times or random values. Track
  // references to those cells so time alone cannot rewrite another cache.
  const remaining = formulas.filter(cell => !excluded.has(coordinate(cell))).map(cell => ({
    cell, references: parseFormulaReferences(cell.formula), key: coordinate(cell),
    unresolved: containsUnresolvedNames(cell.formula),
  }))
  let comparisons = 0
  while (frontier.length) {
    const next = []
    for (const { cell, references, key, unresolved } of remaining) {
      if (excluded.has(key)) continue
      if (unresolved || references.some(({ qualifier, token }) => frontier.some(target => {
        if (++comparisons > 500_000) throw new Error('Formula dependency audit exceeded its budget')
        return (qualifier === undefined ? cell.sheet === target.sheet : qualifierMatches(qualifier, target.sheet)) &&
          (token.startRow === null || token.startRow <= target.row) &&
          (token.endRow === null || token.endRow >= target.row) &&
          (token.startColumn === null || token.startColumn <= target.column) &&
          (token.endColumn === null || token.endColumn >= target.column)
      }))) {
        excluded.add(key)
        next.push(cell)
      }
    }
    frontier = next
  }
  return excluded
}

export async function planFormulaCacheRefresh({ source, edited, request, recalculate, readFormulaIndex, plan, signal }: {
  source: Buffer
  edited: Buffer
  request: Record<string, unknown>
  recalculate: NonNullable<SheetsNative['recalculate']>
  readFormulaIndex: NonNullable<SheetsNative['readFormulaIndex']>
  plan: SheetsWorkbookPlanner
  signal?: AbortSignal
}) {
  // The native engine handles cross-sheet dependencies and preserves pinned
  // external formulas, spilled values and caches it cannot reliably calculate.
  async function audit(bytes: Buffer) {
    const result = await recalculate(bytes, { edits: [], reads: [], reportStale: true }, signal) as RecalcResult
    return Array.isArray(result.stale) ? result.stale : undefined
  }

  try {
    const updated = await audit(edited)
    if (!updated?.length) return
    const previous = await audit(source)
    if (!previous) return
    const alreadyStale = new Map(previous.map(cell => [coordinate(cell), JSON.stringify(cacheValue(cell))]))
    const changed = updated.filter(cell => reusable(cell) &&
      alreadyStale.get(coordinate(cell)) !== JSON.stringify(cacheValue(cell)))
    if (!changed.length) return
    const index = await readFormulaIndex(edited, signal)
    const ids = new Map(index.map(sheet => [sheet.name, sheet.id]))
    const indexed = new Set(index.flatMap(({ name: sheet, cells }) => cells.map(cell => coordinate({ ...cell, sheet }))))
    const excluded = volatileDependents(index)
    const formulaValues = changed.flatMap(cell => {
      const sheetId = ids.get(cell.sheet)
      return sheetId && indexed.has(coordinate(cell)) && !excluded.has(coordinate(cell))
        ? [{ sheetId, row: cell.row, column: cell.column, value: cacheValue(cell) }]
        : []
    })
    if (formulaValues.length) return await plan(edited, { ...request, edits: [], formulaValues }, signal)
  } catch {
    signal?.throwIfAborted()
    // Preserve the literal edit if the optional audit or its cache patch is
    // unsupported. The initial save already requested recalculation on open.
  }
}
