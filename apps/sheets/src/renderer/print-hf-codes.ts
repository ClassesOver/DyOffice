/// Excel header/footer field codes → printed text for one page. Handles the
/// stored `&X` forms and the `&[Page]`-style names the Excel UI shows; an
/// unknown code is kept as the literal text Excel prints.

export interface HeaderFooterFields {
  readonly page: number
  readonly total: number
  readonly date: Date
  readonly fileName: string
  readonly sheetName: string
  readonly filePath?: string | undefined
  /// Replaces `&G` (the section picture); nothing when absent.
  readonly picture?: string | undefined
}

const NAMED_CODES: Record<string, string> = {
  page: 'P',
  pages: 'N',
  date: 'D',
  time: 'T',
  file: 'F',
  tab: 'A',
  path: 'Z',
  picture: 'G',
}

export function expandHeaderFooterCodes(text: string, fields: HeaderFooterFields): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const character = text[index] ?? ''
    if (character !== '&') {
      out += character
      index += 1
      continue
    }
    const next = text[index + 1]
    if (next === undefined) {
      out += '&'
      break
    }
    if (next === '&') {
      out += '&'
      index += 2
      continue
    }
    let code = next.toUpperCase()
    let length = 2
    if (next === '[') {
      const close = text.indexOf(']', index + 2)
      const named =
        close === -1 ? undefined : NAMED_CODES[text.slice(index + 2, close).toLowerCase()]
      if (named === undefined) {
        out += '&['
        index += 2
        continue
      }
      code = named
      length = close + 1 - index
    }
    if (code === 'P' || code === 'N') {
      let value = code === 'P' ? fields.page : fields.total
      const suffix = /^[+-]\d+/.exec(text.slice(index + length))?.[0]
      if (suffix !== undefined) {
        const offset = Number(suffix)
        if (Number.isSafeInteger(offset) && Number.isSafeInteger(value + offset)) {
          value += offset
          length += suffix.length
        }
      }
      out += String(value)
      index += length
      continue
    }
    const expanded = expandCode(code, fields)
    if (expanded === null) {
      out += `&${next}`
      index += 2
      continue
    }
    out += expanded
    index += length
  }
  return out
}

function expandCode(code: string, fields: HeaderFooterFields): string | null {
  switch (code) {
    case 'D':
      return fields.date.toLocaleDateString()
    case 'T':
      return fields.date.toLocaleTimeString()
    case 'F':
      return fields.fileName
    case 'A':
      return fields.sheetName
    case 'Z':
      return fields.filePath ?? ''
    case 'G':
      return fields.picture ?? ''
    default:
      return null
  }
}
