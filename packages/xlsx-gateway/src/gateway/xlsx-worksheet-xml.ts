import { decodeXlsxEscapes, decodeXmlText } from './xlsx-escapes.ts'
import { childElements, type ChildElement } from './xlsx-style-entries.ts'

export const X14_CF_EXT_URI = '{78C0D931-6437-407D-A8EE-F0AAD7539E65}'
export const X14_XMLNS = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
export const XM_XMLNS = 'http://schemas.microsoft.com/office/excel/2006/main'
const WORKSHEET_NAMESPACES = new Set([
  '', // The gateway also accepts namespace-less worksheet fragments.
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
])
export const XML_ATTRIBUTE = /(\s([^\s=/>]+)\s*=\s*)(?:"([^"]*)"|'([^']*)')/g

export type Attributes = ReadonlyMap<string, string>
export interface ScopedElement extends ChildElement {
  readonly local: string
  readonly namespace: string | undefined
  readonly attributes: Attributes
  readonly namespaces: Attributes
}
export interface XmlPatch {
  readonly start: number
  readonly length: number
  readonly xml: string
}

export function prefixOf(name: string): string {
  return name.slice(0, name.indexOf(':') + 1)
}

export function withNamespaces(element: ChildElement, inherited: Attributes): ScopedElement {
  const attributes = new Map<string, string>()
  const namespaces = new Map(inherited)
  for (const [, , key, double, single] of element.opening.matchAll(XML_ATTRIBUTE)) {
    const value = decodeXmlText(double ?? single ?? '')
    attributes.set(key!, value)
    if (key === 'xmlns') namespaces.set('', value)
    if (key?.startsWith('xmlns:')) namespaces.set(key.slice(6), value)
  }
  const prefix = prefixOf(element.name)
  const namespace = prefix ? namespaces.get(prefix.slice(0, -1)) : (namespaces.get('') ?? '')
  return { ...element, local: element.name.slice(prefix.length), namespace, attributes, namespaces }
}

export function worksheetRoot(xml: string): ScopedElement | undefined {
  const root = spreadsheetSheetRoot(xml)
  return root?.local === 'worksheet' ? root : undefined
}

export function isSpreadsheetNamespace(namespace: string | undefined): boolean {
  return namespace !== undefined && WORKSHEET_NAMESPACES.has(namespace)
}

export function spreadsheetSheetRoot(xml: string): ScopedElement | undefined {
  const node = childElements(xml)[0]
  const root = node && withNamespaces(node, new Map([['', '']]))
  return (root?.local === 'worksheet' || root?.local === 'chartsheet') &&
    isSpreadsheetNamespace(root.namespace)
    ? root
    : undefined
}

export function scopedChildren(parent: ScopedElement): ScopedElement[] {
  return childElements(parent.inner).map((child) => withNamespaces(child, parent.namespaces))
}

export function isElement(
  element: ScopedElement,
  local: string,
  namespace: string | undefined,
): boolean {
  return element.local === local && element.namespace === namespace
}

export function patchElement(element: ChildElement, xml: string): XmlPatch {
  return { start: element.start, length: element.xml.length, xml }
}

export function applyPatches(xml: string, patches: XmlPatch[]): string {
  return patches
    .sort((left, right) => right.start - left.start || right.length - left.length)
    .reduce(
      (out, patch) => out.slice(0, patch.start) + patch.xml + out.slice(patch.start + patch.length),
      xml,
    )
}

export function withBody(element: ChildElement, body: string): string {
  if (element.opening.endsWith('/>')) {
    return element.opening.slice(0, -2) + '>' + body + '</' + element.name + '>'
  }
  return element.opening + body + element.xml.slice(element.opening.length + element.inner.length)
}

export function elementText(inner: string): string {
  return inner
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)/g)
    .map((text) =>
      text.startsWith('<![CDATA[')
        ? text.slice(9, -3)
        : text.startsWith('<!--')
          ? ''
          : decodeXmlText(text),
    )
    .join('')
}

/// Mirrors the sidecar: raw CRLF folds first so `_x000D_` + LF (Excel's CR LF)
/// ends up as one line break.
export function decodeCellText(input: string, preserveSpace = true): string {
  let text = elementText(input).replace(/\r\n?/g, '\n')
  // The XML whitespace policy applies before escaped spreadsheet characters.
  if (!preserveSpace) text = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
  return decodeXlsxEscapes(text).replace(/\r\n?/g, '\n')
}

export function extensionUri(extension: ScopedElement): string | undefined {
  return extension.attributes.get('uri')?.toUpperCase()
}

export function worksheetExtensions(root: ScopedElement, children: ScopedElement[]) {
  const list = children.find((child) => isElement(child, 'extLst', root.namespace))
  const extensions = list
    ? scopedChildren(list).filter((child) => isElement(child, 'ext', root.namespace))
    : []
  return { list, extensions }
}

export function escapeXmlText(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function escapeXmlAttribute(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\n', '&#10;')
}
