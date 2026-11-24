import { XMLParser } from 'fast-xml-parser'
import { relsPathFor, resolveRelTarget } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-drawing-add.ts'
import { decodeAttribute } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-sheets.ts'
import { resolvedStyleEntries } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-style-entries.ts'
import { parseRef } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-table-add.ts'
import { builtinTablePalette, TABLE_PALETTE_KEYS } from '../../../sheets/src/renderer/table-styles'
import type { WorkbookFile } from '../../../sheets/src/shared/desktop-api.ts'

type Table = WorkbookFile['sheets'][number]['tables'][number]
type TablePalette = Pick<Table, (typeof TABLE_PALETTE_KEYS)[number]>
type XmlAttributes = { [name: `@_${string}`]: string | undefined }
type XmlNode = XmlAttributes & { [name: string]: string | XmlNode | XmlNode[] | undefined }
type ResolveColor = (node: XmlAttributes) => { rgb?: string }

const listTags = new Set(['tablePart', 'Relationship', 'tableColumn', 'filterColumn', 'tableStyle', 'tableStyleElement'])
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
  stopNodes: ['worksheet.sheetData', 'worksheet.extLst', 'table.extLst'],
  isArray: name => listTags.has(name),
})

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  const value = node?.[name]
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function children(node: XmlNode | undefined, name: string): XmlNode[] {
  const value = node?.[name]
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []
}

function attribute(node: XmlAttributes | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`]
  return value === undefined ? undefined : decodeAttribute(value)
}

function nonnegativeInteger(value: string | undefined): number | undefined {
  const number = Number(value)
  return value && /^\d+$/.test(value) && Number.isSafeInteger(number) ? number : undefined
}

function enabled(node: XmlNode | undefined, name: string): boolean {
  const value = attribute(node, name)
  return value === '1' || value === 'true'
}

const fillBands: ReadonlyMap<string, keyof TablePalette> = new Map([
  ['wholeTable', 'wholeTableFill'], ['headerRow', 'headerFill'], ['totalRow', 'totalRowFill'],
  ['firstColumn', 'firstColumnFill'], ['lastColumn', 'lastColumnFill'],
  ['firstRowStripe', 'stripeFill'], ['secondRowStripe', 'secondRowStripeFill'],
  ['firstColumnStripe', 'columnStripeFill'], ['secondColumnStripe', 'secondColumnStripeFill'],
])
const fontBands: ReadonlyMap<string, keyof TablePalette> = new Map([
  ['headerRow', 'headerFontColor'], ['totalRow', 'totalRowFontColor'],
  ['firstHeaderCell', 'firstHeaderCellFontColor'],
])

/** Resolve only the differential styles used by table bands. */
export function readCustomTableStyles(stylesXml: string, resolveColor: ResolveColor): ReadonlyMap<string, TablePalette> {
  const palettes = new Map<string, TablePalette>()
  if (!/<(?:[\w.-]+:)?tableStyle\b/.test(stylesXml)) return palettes
  const stylesheet = child(xmlParser.parse(stylesXml), 'styleSheet')
  const styles = children(child(stylesheet, 'tableStyles'), 'tableStyle')
  if (!styles.length) return palettes
  const [, prefix = '', dxfXml = ''] = /<([\w.-]+:)?dxfs\b[^>]*>([\s\S]*?)<\/\1dxfs\s*>/.exec(stylesXml) ?? []
  const dxfs = resolvedStyleEntries(dxfXml, `${prefix}dxf`).map(entry => child(xmlParser.parse(entry), 'dxf'))
  const color = (node: XmlNode | undefined) => node ? resolveColor(node).rgb : undefined

  for (const style of styles) {
    const styleName = attribute(style, 'name')
    if (styleName === undefined) continue
    const palette: TablePalette = {}
    const addBorder = (key: 'wholeTable' | 'innerHorizontal' | 'innerVertical' | 'headerBottom' | 'totalRow', edge: XmlNode | undefined) => {
      const style = attribute(edge, 'style')
      if (!style || style === 'none') return
      palette[`${key}BorderColor`] = color(child(edge, 'color'))
      palette[`${key}BorderStyle`] = style
    }
    for (const band of children(style, 'tableStyleElement')) {
      const type = attribute(band, 'type')
      const index = nonnegativeInteger(attribute(band, 'dxfId'))
      const dxf = index === undefined ? undefined : dxfs[index]
      if (!type || !dxf) continue
      const fillKey = fillBands.get(type), fontKey = fontBands.get(type)
      if (fillKey) {
        const pattern = child(child(dxf, 'fill'), 'patternFill')
        palette[fillKey] = color(child(pattern, 'bgColor') ?? child(pattern, 'fgColor'))
      }
      if (fontKey) palette[fontKey] = color(child(child(dxf, 'font'), 'color'))
      const border = child(dxf, 'border')
      if (type === 'wholeTable') {
        addBorder('wholeTable', child(border, 'left') ?? child(border, 'top'))
        addBorder('innerHorizontal', child(border, 'horizontal'))
        addBorder('innerVertical', child(border, 'vertical'))
      } else if (type === 'headerRow') {
        addBorder('headerBottom', child(border, 'bottom'))
      } else if (type === 'totalRow') {
        addBorder('totalRow', child(border, 'top'))
      }
    }
    palettes.set(styleName, palette)
  }
  return palettes
}

const filterCriteria = ['filters', 'customFilters', 'dynamicFilter', 'top10', 'colorFilter', 'iconFilter']

function readTable(xml: string, themeColors: readonly string[], customStyles?: ReadonlyMap<string, TablePalette>): Table | undefined {
  const table = child(xmlParser.parse(xml), 'table')
  const ref = attribute(table, 'ref')
  if (!ref) return undefined
  let range: Table['range']
  try {
    range = parseRef(ref.toUpperCase())
  } catch {
    return undefined
  }
  if (range.startRow < 0 || range.startColumn < 0 || range.endRow < range.startRow ||
      range.endColumn < range.startColumn || range.endRow >= 1048576 || range.endColumn >= 16384) return undefined

  const style = child(table, 'tableStyleInfo')
  const styleName = attribute(style, 'name')
  const name = attribute(table, 'displayName') ?? attribute(table, 'name')
  const columns = children(child(table, 'tableColumns'), 'tableColumn')
    .map(column => attribute(column, 'name')).filter((column): column is string => column !== undefined)
  const filters = children(child(table, 'autoFilter'), 'filterColumn')
  const custom = styleName === undefined ? undefined : customStyles?.get(styleName)
  const palette: TablePalette = { ...(custom ?? builtinTablePalette(styleName, themeColors)) }
  if (!enabled(style, 'showFirstColumn')) {
    delete palette.firstColumnFill
    delete palette.firstHeaderCellFontColor
  }
  if (!enabled(style, 'showLastColumn')) delete palette.lastColumnFill
  return {
    ...palette, range, name, columns, styleName,
    headerRowCount: nonnegativeInteger(attribute(table, 'headerRowCount')) ?? 1,
    totalsRowCount: nonnegativeInteger(attribute(table, 'totalsRowCount')) ?? 0,
    showRowStripes: enabled(style, 'showRowStripes'),
    showColumnStripes: enabled(style, 'showColumnStripes'),
    filterActive: filters.some(column => filterCriteria.some(criterion => Object.hasOwn(column, criterion))),
  }
}

export async function readWorksheetTables(
  text: (path: string) => Promise<string>,
  worksheetPath: string,
  worksheetXml: string,
  themeColors: readonly string[],
  customStyles?: ReadonlyMap<string, TablePalette>,
): Promise<Table[]> {
  if (!worksheetXml.includes('tableParts')) return []
  const worksheet = child(xmlParser.parse(worksheetXml), 'worksheet')
  const parts = children(child(worksheet, 'tableParts'), 'tablePart')
  if (!parts.length) return []
  const rels = child(xmlParser.parse(await text(relsPathFor(worksheetPath))), 'Relationships')
  const targets = new Map<string, string>()
  for (const rel of children(rels, 'Relationship')) {
    if (!attribute(rel, 'Type')?.endsWith('/table') || attribute(rel, 'TargetMode') === 'External') continue
    const id = attribute(rel, 'Id'), target = attribute(rel, 'Target')
    if (id && target) targets.set(id, target)
  }
  const tables: Table[] = []
  for (const part of parts) {
    const target = targets.get(attribute(part, 'id') ?? '')
    if (!target) continue
    let path: string
    try {
      path = resolveRelTarget(worksheetPath, target)
    } catch {
      continue
    }
    const definition = await text(path)
    const table = definition ? readTable(definition, themeColors, customStyles) : undefined
    if (table) tables.push(table)
  }
  return tables
}
