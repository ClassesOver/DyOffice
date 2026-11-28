import { readRootStartTag } from './xlsx-namespace.ts'
import { updateWorksheetTagAttribute } from './xlsx-structure.ts'
import { childElements } from './xlsx-style-entries.ts'
import {
  applyPatches,
  escapeXmlAttribute,
  isElement,
  patchElement,
  prefixOf,
  scopedChildren,
  withBody,
  withNamespaces,
  type ScopedElement,
  type XmlPatch,
} from './xlsx-worksheet-xml.ts'

/// Edit the active theme's palette and fonts while preserving other parts of
/// the theme, including non-Latin typefaces.
export class ThemeStateError extends Error {}

export interface WorkbookThemeState {
  /// #RRGGBB values in theme index order [lt1, dk1, lt2, dk2, accent1-6,
  /// hlink, folHlink].
  readonly colors?: { readonly name: string; readonly values: readonly string[] } | undefined
  readonly fonts?:
    { readonly name: string; readonly major: string; readonly minor: string } | undefined
}

/// clrScheme document order, paired with the slot's position in the theme
/// index order the renderer uses (light/dark pairs are swapped).
const SCHEME_SLOTS: readonly (readonly [string, number])[] = [
  ['dk1', 1],
  ['lt1', 0],
  ['dk2', 3],
  ['lt2', 2],
  ['accent1', 4],
  ['accent2', 5],
  ['accent3', 6],
  ['accent4', 7],
  ['accent5', 8],
  ['accent6', 9],
  ['hlink', 10],
  ['folHlink', 11],
]

function themeChild(parent: ScopedElement, name: string): ScopedElement | undefined {
  return scopedChildren(parent).find((child) => isElement(child, name, parent.namespace))
}

function withAttribute(xml: string, name: string, value: string): string {
  const opening = readRootStartTag(xml)
  return updateWorksheetTagAttribute(opening, name, escapeXmlAttribute(value)) +
    xml.slice(opening.length)
}

export function applyThemeState(themeXml: string, state: WorkbookThemeState): string {
  if (state.colors === undefined && state.fonts === undefined) return themeXml
  const [node] = childElements(themeXml)
  const root = node && withNamespaces(node, new Map())
  const elements = root?.local === 'theme' && themeChild(root, 'themeElements')
  if (!root || !elements) throw new ThemeStateError('The workbook theme has no theme elements.')
  const patches: XmlPatch[] = []

  if (state.colors !== undefined) {
    const { name, values } = state.colors
    if (values.length !== 12) throw new ThemeStateError('A theme palette needs 12 colors.')
    const scheme = themeChild(elements, 'clrScheme')
    if (!scheme) throw new ThemeStateError('The theme has no color scheme to rewrite.')
    const slots = scopedChildren(scheme)
    const colorPatches = SCHEME_SLOTS.map(([name, index]) => {
      const hex = (values[index] ?? '').replace(/^#/, '').toUpperCase()
      if (!/^[0-9A-F]{6}$/.test(hex)) {
        throw new ThemeStateError('Theme color ' + name + ' is not a valid #RRGGBB value.')
      }
      const slot = slots.find((child) => isElement(child, name, scheme.namespace))
      if (!slot) throw new ThemeStateError('The theme has no ' + name + ' color scheme slot.')
      const color = '<' + prefixOf(slot.name) + 'srgbClr val="' + hex + '"/>'
      return patchElement(slot, withBody(slot, color))
    })
    const updated = withBody(scheme, applyPatches(scheme.inner, colorPatches))
    patches.push(patchElement(scheme, withAttribute(updated, 'name', name)))
  }

  if (state.fonts !== undefined) {
    const { name, major, minor } = state.fonts
    const scheme = themeChild(elements, 'fontScheme')
    if (!scheme) throw new ThemeStateError('The theme has no font scheme to rewrite.')
    const fontPatches = ([['majorFont', major], ['minorFont', minor]] as const).map(([kind, face]) => {
      const font = themeChild(scheme, kind)
      const latin = font && themeChild(font, 'latin')
      if (!font || !latin) throw new ThemeStateError('The theme has no font scheme to rewrite.')
      const updated = applyPatches(font.inner, [patchElement(latin, withAttribute(latin.xml, 'typeface', face))])
      return patchElement(font, withBody(font, updated))
    })
    const updated = withBody(scheme, applyPatches(scheme.inner, fontPatches))
    patches.push(patchElement(scheme, withAttribute(updated, 'name', name)))
  }

  const updated = withBody(elements, applyPatches(elements.inner, patches))
  const offset = root.start + root.opening.length + elements.start
  return themeXml.slice(0, offset) + updated + themeXml.slice(offset + elements.xml.length)
}
