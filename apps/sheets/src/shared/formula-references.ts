import { FORMULA_REFERENCE_PATTERN } from '@genoffice/xlsx-gateway/gateway/xlsx-structure'

interface ParsedToken {
  readonly startRow: number | null
  readonly endRow: number | null
  readonly startColumn: number | null
  readonly endColumn: number | null
}

function lettersToColumn(letters: string): number {
  let column = 0
  for (const character of letters) {
    column = column * 26 + character.charCodeAt(0) - 64
  }
  return column - 1
}

/// Null bounds mean "whole axis" (A:A or 1:5 references), clamped to the
/// target sheet's used range by the caller.
function parseReferenceToken(token: string): ParsedToken | null {
  const wholeColumn = /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/.exec(token)
  if (wholeColumn) {
    const start = lettersToColumn(wholeColumn[1] ?? 'A')
    const end = lettersToColumn(wholeColumn[2] ?? 'A')
    return {
      startRow: null,
      endRow: null,
      startColumn: Math.min(start, end),
      endColumn: Math.max(start, end),
    }
  }
  const wholeRow = /^\$?([0-9]+):\$?([0-9]+)$/.exec(token)
  if (wholeRow) {
    const start = Number(wholeRow[1]) - 1
    const end = Number(wholeRow[2]) - 1
    return {
      startRow: Math.min(start, end),
      endRow: Math.max(start, end),
      startColumn: null,
      endColumn: null,
    }
  }
  const cells = token.split(':').map((part) => /^\$?([A-Z]{1,3})\$?([0-9]+)$/.exec(part))
  if (cells.some((cell) => cell === null)) return null
  const rows = cells.map((cell) => Number(cell?.[2]) - 1)
  const columns = cells.map((cell) => lettersToColumn(cell?.[1] ?? 'A'))
  return {
    startRow: Math.min(...rows),
    endRow: Math.max(...rows),
    startColumn: Math.min(...columns),
    endColumn: Math.max(...columns),
  }
}

interface FormulaReference {
  readonly qualifier: string | undefined
  readonly token: ParsedToken
}

export function parseFormulaReferences(formula: string): FormulaReference[] {
  const references: FormulaReference[] = []
  const segments = formula.split('"')
  for (let index = 0; index < segments.length; index += 2) {
    for (const match of (segments[index] ?? '').matchAll(FORMULA_REFERENCE_PATTERN)) {
      const token = parseReferenceToken(match[3] ?? '')
      if (token) references.push({ qualifier: match[2], token })
    }
  }
  return references
}

const EXTERNAL_WORKBOOK_PATTERN = /\[(?:\d+|[^[\]]*\.xl\w*)\]/i
/// Excel error literals (`=D2*#REF!` after a deleted column). They are values
/// the engine evaluates, not names; left in place their letters read as a
/// defined name and the formula is wrongly pinned to its (often absent) cache.
/// A sheet qualifier (`Sheet1!#REF!`) goes with it, or it would dangle.
const ERROR_LITERAL_PATTERN =
  /(?:'(?:[^']|'')*'!|[\p{L}\p{N}_.]+!)?#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA)/gu

/// True when the formula uses an identifier that is not a function call —
/// a defined name or an external reference the closure cannot resolve.
export function containsUnresolvedNames(formula: string, resolvedName?: (name: string) => boolean): boolean {
  const segments = formula.split('"')
  for (let index = 0; index < segments.length; index += 2) {
    // [n]Sheet!ref / '[n]Sheet name'!ref / 'C:\dir\[Book.xlsx]Sheet'!ref is
    // an external-workbook reference: the reference pattern would swallow it
    // as an ordinary sheet reference, but the closure can never resolve
    // another workbook.
    if (EXTERNAL_WORKBOOK_PATTERN.test(segments[index] ?? '')) return true
    // Strip references (and their qualifiers) so ref letters don't register.
    const stripped = (segments[index] ?? '')
      .replace(ERROR_LITERAL_PATTERN, ' ')
      .replace(FORMULA_REFERENCE_PATTERN, (_full, lead: string) => `${lead} `)
    for (const match of stripped.matchAll(/[\p{L}_][\p{L}\p{N}_.]*/gu)) {
      const before = match.index === 0 ? '' : (stripped[match.index - 1] ?? '')
      if (/[\p{L}\p{N}_.$'!]/u.test(before)) continue
      const name = match[0]
      if (name === 'TRUE' || name === 'FALSE') continue
      const rest = stripped.slice(match.index + name.length)
      if (!/^\s*\(/.test(rest) && !resolvedName?.(name)) return true
    }
  }
  return false
}
