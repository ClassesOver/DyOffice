/// Declarative defined-names save: rewrites workbook.xml's `<definedNames>`
/// from the editor's model. Entries the editor never models — `_xlnm.*`
/// built-ins, hidden names, and names it failed to install (`preserveNames`)
/// — stay byte-verbatim.

import { withFutureFunctionMarkers } from './future-functions.ts'
import { childElements } from './xlsx-style-entries.ts'
import {
  applyPatches,
  isElement,
  patchElement,
  prefixOf,
  scopedChildren,
  withBody,
  withNamespaces,
} from './xlsx-worksheet-xml.ts'

export class DefinedNameError extends Error {}

export interface DefinedNameEntry {
  readonly name: string
  readonly formula: string
  /// localSheetId (position in workbook sheet order) for sheet-scoped names.
  readonly sheetIndex?: number | undefined
}

export interface DefinedNamesState {
  readonly names: readonly DefinedNameEntry[]
  readonly preserveNames: readonly string[]
}

/// Excel name rules (simplified): starts with a letter, `_`, or `\`;
/// continues with letters, digits, `_`, `.`, or `\`; must not look like an
/// A1 or R1C1 cell reference. Letters are Unicode — Excel accepts CJK names,
/// and Create from Selection builds them from localized headers, so this
/// must accept everything definedNameFromLabel produces.
const NAME_PATTERN = /^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u
const CELL_REF_PATTERN = /^(?:[A-Za-z]{1,3}[0-9]+|[Rr][0-9]*[Cc][0-9]*)$/

function workbookNameParts(workbookXml: string) {
  const [element] = childElements(workbookXml)
  const root = element && withNamespaces(element, new Map())
  if (root?.local !== 'workbook') return undefined
  const children = scopedChildren(root)
  const section = children.find((node) => isElement(node, 'definedNames', root.namespace))
  const entries = section
    ? scopedChildren(section).filter((node) => isElement(node, 'definedName', root.namespace))
    : []
  return { root, children, section, entries }
}

export function workbookDefinedNameElements(workbookXml: string) {
  return workbookNameParts(workbookXml)?.entries ?? []
}

export function readWorkbookDefinedNameKeys(workbookXml: string): Set<string> {
  return new Set(workbookDefinedNameElements(workbookXml).flatMap((entry) => {
    const name = entry.attributes.get('name')
    return name ? [name.toLowerCase()] : []
  }))
}

export function applyDefinedNamesState(workbookXml: string, state: DefinedNamesState): string {
  const parts = workbookNameParts(workbookXml)
  if (!parts) {
    if (state.names.length === 0) return workbookXml
    throw new DefinedNameError('workbook.xml has no workbook element.')
  }
  const { root, children, section, entries } = parts
  const preserved = new Set(state.preserveNames)
  const preservedKeys = new Set<string>()
  const patches = entries.flatMap((entry) => {
    const name = entry.attributes.get('name') ?? ''
    const hidden = entry.attributes.get('hidden')
    if (!name.startsWith('_xlnm') && hidden !== '1' && hidden !== 'true' && !preserved.has(name)) {
      return [patchElement(entry, '')]
    }
    const scope = entry.attributes.get('localSheetId')?.trim()
    preservedKeys.add(`${name}\u0000${scope && /^\+?\d+$/.test(scope) ? Number(scope) : -1}`)
    return []
  })

  const seen = new Set<string>()
  const prefix = prefixOf(section?.name ?? root.name)
  const additions = state.names.map((entry) => {
    validateName(entry.name)
    const key = `${entry.name}\u0000${entry.sheetIndex ?? -1}`
    if (preservedKeys.has(key)) {
      throw new DefinedNameError(
        `The name "${entry.name}" also exists in a form the editor cannot model — ` +
          'saving would duplicate it.',
      )
    }
    if (seen.has(key)) {
      throw new DefinedNameError(`The name "${entry.name}" is defined twice.`)
    }
    seen.add(key)
    const scope = entry.sheetIndex === undefined ? '' : ` localSheetId="${entry.sheetIndex}"`
    const formula = escapeXmlText(withFutureFunctionMarkers(entry.formula.replace(/^=/, '')))
    return `<${prefix}definedName name="${escapeXmlAttribute(entry.name)}"${scope}>${formula}</${prefix}definedName>`
  }).join('')

  const bodyStart = root.start + root.opening.length
  if (section) {
    const inner = applyPatches(section.inner, patches) + additions
    const offset = bodyStart + section.start
    const replacement = inner.trim() ? withBody(section, inner) : ''
    return workbookXml.slice(0, offset) + replacement + workbookXml.slice(offset + section.xml.length)
  }
  if (!additions) return workbookXml
  const anchor = ['externalReferences', 'functionGroups', 'sheets']
    .map((name) => children.find((node) => isElement(node, name, root.namespace)))
    .find((node) => node !== undefined)
  if (!anchor) throw new DefinedNameError('workbook.xml has no sheets element.')
  const offset = bodyStart + anchor.start + anchor.xml.length
  return workbookXml.slice(0, offset) + `<${prefix}definedNames>${additions}</${prefix}definedNames>` + workbookXml.slice(offset)
}

/**
 * Append entries to the workbook's `<definedNames>` section, creating the
 * section where there is none.
 *
 * Shared with the redaction mirror (`applyRedactionNameMirror`), which writes
 * into the same section with a different idea of what an entry means. The
 * schema order is the fiddly part — `<definedNames>` follows `<sheets>`, but
 * only after `<functionGroups>` and `<externalReferences>` when those are
 * present — so it is done once here rather than twice.
 */
export function appendDefinedNames(workbookXml: string, additions: string): string {
  const section = /<definedNames\b[^>]*>([\s\S]*?)<\/definedNames>|<definedNames\b[^>]*\/>/.exec(
    workbookXml,
  )
  if (section) {
    const inner = (section[1] ?? '') + additions
    const replacement = inner === '' ? '' : `<definedNames>${inner}</definedNames>`
    return (
      workbookXml.slice(0, section.index) +
      replacement +
      workbookXml.slice(section.index + section[0].length)
    )
  }
  if (additions === '') return workbookXml
  // Schema order: definedNames follows sheets (and functionGroups/externalReferences).
  const anchor = /<\/sheets>|<sheets\b[^>]*\/>/.exec(workbookXml)
  if (!anchor) throw new DefinedNameError('workbook.xml has no sheets element.')
  const groups = /<functionGroups\b[^>]*>[\s\S]*?<\/functionGroups>|<functionGroups\b[^>]*\/>/.exec(
    workbookXml,
  )
  const externals =
    /<externalReferences\b[^>]*>[\s\S]*?<\/externalReferences>|<externalReferences\b[^>]*\/>/.exec(
      workbookXml,
    )
  let at = externals ? externals.index + externals[0].length : anchor.index + anchor[0].length
  // functionGroups only counts when externalReferences is absent: the later
  // element is the one the section must follow
  if (!externals && groups) at = groups.index + groups[0].length
  return `${workbookXml.slice(0, at)}<definedNames>${additions}</definedNames>${workbookXml.slice(at)}`
}

/** Shared by table names, which follow the same rules (minus the `_xlnm` reservation). */
export function isValidDefinedName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    NAME_PATTERN.test(name) &&
    !CELL_REF_PATTERN.test(name) &&
    name.toLowerCase() !== 'true' &&
    name.toLowerCase() !== 'false'
  )
}

function validateName(name: string): void {
  if (!isValidDefinedName(name)) {
    throw new DefinedNameError(`"${name}" is not a valid defined name.`)
  }
  if (name.startsWith('_xlnm')) {
    throw new DefinedNameError('Names starting with "_xlnm" are reserved by Excel.')
  }
}

export function unescapeXml(input: string): string {
  return input
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

export function escapeXmlText(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeXmlAttribute(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
