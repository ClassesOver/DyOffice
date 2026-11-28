import type { WorkbookRichRun } from '../shared/edit-schemas.ts'
import { decodeXmlText } from './xlsx-escapes.ts'
import { childElements } from './xlsx-style-entries.ts'
import { readWorksheetTagAttribute } from './xlsx-structure.ts'
import { booleanCellValue, decodeCellText, elementText, isElement, isSpreadsheetNamespace, withNamespaces, type ScopedElement } from './xlsx-worksheet-xml.ts'
import { readWorkbookPartPath } from './xlsx-workbook-parts.ts'

export type ReadRunStyle = (propertiesXml: string) => Omit<WorkbookRichRun, 'text'>

export function booleanCellText(value: string): string {
  const decoded = booleanCellValue(value)
  return decoded === null ? '' : decoded ? 'TRUE' : 'FALSE'
}

function hasLiteralMarkup(xml: string): boolean {
  return xml.includes('<![CDATA[') || xml.includes('<!--')
}

export function decodeCellMarkup(xml: string): string {
  return hasLiteralMarkup(xml) ? elementText(xml) : decodeXmlText(xml)
}

export async function readSharedStrings(source: { has(path: string): Promise<boolean>; readText(path: string): Promise<string> }): Promise<readonly string[]> {
  const path = await readWorkbookPartPath(source, 'sharedStrings')
  if (!(await source.has(path))) return []
  return parseSharedStringsXml(await source.readText(path))
}

export async function readSharedTextEntries(
  source: { has(path: string): Promise<boolean>; readText(path: string): Promise<string> },
  readRunStyle?: ReadRunStyle,
): Promise<CellText[]> {
  const path = await readWorkbookPartPath(source, 'sharedStrings')
  if (!(await source.has(path))) return []
  const xml = await source.readText(path)
  return Array.from(sharedStringItems(xml), (item) => parseCellText(item.inner, readRunStyle, item))
}

export function parseSharedStringsXml(xml: string): string[] {
  return Array.from(sharedStringItems(xml), (item) => parseCellText(item.inner, undefined, item).value)
}

function* sharedStringItems(xml: string): Iterable<ScopedElement> {
  const [element] = childElements(xml)
  const sst = element && withNamespaces(element, new Map())
  if (sst?.local !== 'sst' || !isSpreadsheetNamespace(sst.namespace)) return
  for (const node of childElements(sst.inner)) {
    const item = withNamespaces(node, sst.namespaces)
    if (isElement(item, 'si', sst.namespace)) yield item
  }
}

export type CellText = { readonly value: string; readonly rich?: WorkbookRichRun[] }
const plainTextRun = { bold: false, italic: false, underline: false, strikethrough: false }

function cellTextChildren(xml: string, parent?: ScopedElement) {
  return childElements(xml).flatMap(element => {
    const scope = parent && withNamespaces(element, parent.namespaces)
    if (parent && scope?.namespace !== parent.namespace) return []
    return [{ element, name: scope?.local ?? element.name, scope }]
  })
}

export function parseCellText(xml: string, readRunStyle?: ReadRunStyle, scope?: ScopedElement): CellText {
  const runs: WorkbookRichRun[] = []
  let value = ''
  let styled = false
  // Only direct text and rich runs contribute cell content. Phonetic guides do not.
  for (const item of cellTextChildren(xml, scope)) {
    if (item.name !== 't' && item.name !== 'r') continue
    const children = item.name === 'r' ? cellTextChildren(item.element.inner, item.scope) : []
    const node = item.name === 't' ? item.element : children.find(({ name }) => name === 't')?.element
    const preserveSpace = node !== undefined && readWorksheetTagAttribute(node.opening, 'xml:space') === 'preserve'
    const text = decodeCellText(node?.inner ?? '', preserveSpace)
    value += text
    if (readRunStyle) {
      const properties = children.find(({ name }) => name === 'rPr')?.element.xml
      const style = properties === undefined ? plainTextRun : readRunStyle(properties)
      styled ||= properties !== undefined && Object.values(style).some(Boolean)
      runs.push({ text, ...style })
    }
  }
  return runs.length > 1 || styled ? { value, rich: runs } : { value }
}
