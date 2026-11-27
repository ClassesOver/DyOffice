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

const FORMAT_CODE = /^&(?:"(?<font>[^"]*)"|(?<size>\d{1,3})|K(?<color>[0-9a-f]{6}|\d{2}\.?[+-]\d{2,3})|(?<toggle>[BIUESXYOH]))/i

export function matchHeaderFooterFormat(text: string, index: number): RegExpExecArray | null {
  return FORMAT_CODE.exec(text.slice(index))
}

interface HeaderFooterStyle {
  fontFamily?: string
  fontSizePt?: number
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: 'single' | 'double'
  strike?: boolean
  baseline?: 'sup' | 'sub'
}

export function* headerFooterRuns(text: string): Iterable<{
  text: string
  style: Readonly<HeaderFooterStyle>
}> {
  const style: HeaderFooterStyle = {}
  let start = 0
  let index = text.indexOf('&')
  while (index !== -1) {
    if (text[index + 1] === '&') {
      index = text.indexOf('&', index + 2)
      continue
    }
    const format = matchHeaderFooterFormat(text, index)
    if (format === null) {
      index = text.indexOf('&', index + 1)
      continue
    }
    if (index > start) yield { text: text.slice(start, index), style: { ...style } }
    const { font, size, color, toggle } = format.groups ?? {}
    if (font !== undefined) {
      const separator = font.lastIndexOf(',')
      const family = (separator === -1 ? font : font.slice(0, separator)).trim()
      if (family === '+' || (family === '-' && separator === -1)) delete style.fontFamily
      else if (family !== '' && family !== '-') style.fontFamily = family
      const face = separator === -1 ? '' : font.slice(separator + 1).trim().toLowerCase()
      if (/^(regular|bold|italic|bold italic|italic bold)$/.test(face)) {
        style.bold = face.includes('bold')
        style.italic = face.includes('italic')
      }
    } else if (size !== undefined && Number(size) > 0) {
      style.fontSizePt = Number(size)
    } else if (color !== undefined) {
      if (/^[0-9a-f]{6}$/i.test(color)) style.color = `#${color.toUpperCase()}`
      else delete style.color
    } else {
      const code = toggle?.toUpperCase()
      switch (code) {
        case 'B':
          style.bold = !style.bold
          break
        case 'I':
          style.italic = !style.italic
          break
        case 'S':
          style.strike = !style.strike
          break
        case 'E':
        case 'U': {
          const underline = code === 'E' ? 'double' : 'single'
          if (style.underline === underline) delete style.underline
          else style.underline = underline
          break
        }
        case 'X':
        case 'Y': {
          const baseline = code === 'X' ? 'sup' : 'sub'
          if (style.baseline === baseline) delete style.baseline
          else if (style.baseline === undefined) style.baseline = baseline
          break
        }
      }
    }
    start = index + format[0].length
    index = text.indexOf('&', start)
  }
  if (start < text.length) yield { text: text.slice(start), style: { ...style } }
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
