import {
  FORMULA_REFERENCE_PATTERN,
  formulaCodeSegments,
  qualifierMatches,
  readDefinedNameText,
  readWorksheetTagAttribute,
  rewriteDefinedNames,
  rewriteWorksheetCore,
  rewriteWorksheetHyperlinks,
  updateWorksheetTagAttribute,
} from './xlsx-structure.ts'
import { chartFormulaElements, rewriteChartReferences } from './xlsx-chart-references.ts'
import { workbookDefinedNameElements, workbookNameParts } from './xlsx-defined-names.ts'
import { rewriteX14DataValidations } from './xlsx-dv.ts'
import { ensureRelationshipNamespace, readRelationshipId, readRelationshipIdAttribute, readRootStartTag, relationshipNamespaceOverride } from './xlsx-namespace.ts'
import { childElements, type ChildElement } from './xlsx-style-entries.ts'
import { rewriteWorksheetVisualReferences } from './xlsx-visual-references.ts'
import {
  applyPatches,
  elementText,
  isElement,
  patchElement,
  prefixOf,
  scopedChildren,
  spreadsheetSheetRoot,
  withBody,
  withNamespaces,
  worksheetRoot,
  type ScopedElement,
} from './xlsx-worksheet-xml.ts'

/// Sheet-level workbook surgery: rename, add, and remove worksheets. Renames
/// rewrite every qualified reference (other sheets' formulas, defined names,
/// chart series, hyperlink anchors); removals fail closed when anything still
/// references the sheet. All operations rebuild workbook.xml's sheet list in
/// the caller-provided final tab order.

export class SheetEditError extends Error {}

export interface SheetEditPlan {
  /// original file name → new name, for sheets already in the package
  readonly renames: readonly { readonly sheetName: string; readonly newName: string }[]
  /// final names of new sheets; a sourceSheetName means the part is seeded by
  /// cloning that sheet's part instead of a blank template
  readonly additions: readonly {
    readonly name: string
    readonly sourceSheetName?: string | undefined
  }[]
  /// original file names of sheets to delete
  readonly removals: readonly string[]
  /// the complete final tab order, as final names
  readonly order: readonly string[]
  /// visibility toggles, keyed by original (pre-rename) or added name
  readonly hiddenChanges?: readonly { readonly sheetName: string; readonly hidden: boolean }[]
  /// True when the tab order differs from the file — calcChain sheet indexes
  /// go stale, so the save drops it for Excel to rebuild.
  readonly orderChanged?: boolean
}

export interface SheetAllocation {
  readonly name: string
  readonly path: string
  readonly sheetId: number
  readonly relationshipId: string
  readonly chartSheetRelationshipType?: string | undefined
}

const INVALID_NAME_CHARACTERS = /[\\/?*[\]:]/

export function validateSheetName(name: string): void {
  if (name.length === 0 || name.length > 31) {
    throw new SheetEditError(`Sheet name "${name}" must be 1-31 characters long.`)
  }
  if (INVALID_NAME_CHARACTERS.test(name)) {
    throw new SheetEditError(
      `Sheet name "${name}" contains a forbidden character (\\ / ? * [ ] :).`,
    )
  }
  if (name.startsWith("'") || name.endsWith("'")) {
    throw new SheetEditError(`Sheet name "${name}" cannot start or end with an apostrophe.`)
  }
}

/// Every per-sheet state names an existing sheet by its original file name and
/// an added sheet by its final name, so a new sheet that takes the old name of
/// a sheet renamed in the same save makes both read as one: cell values, row
/// and column operations, formats and page setup meant for the renamed sheet
/// would land on the new one. Refuse instead of guessing — but only when some
/// state in the save names that sheet; the rename and the addition alone are
/// unambiguous (the CLI's `sheet apply` draws the same line). A new sheet
/// that takes a removed sheet's name is fine: a removed sheet carries no
/// states.
export function assertAddedSheetsKeepRenamedNames(
  plan: SheetEditPlan,
  addressedSheets: ReadonlySet<string>,
): void {
  const renamedAway = new Set(
    plan.renames
      .filter((rename) => rename.newName !== rename.sheetName)
      .map((rename) => rename.sheetName),
  )
  const addressed = (name: string): boolean =>
    addressedSheets.has(name) ||
    (plan.hiddenChanges ?? []).some((change) => change.sheetName === name) ||
    plan.additions.some((addition) => addition.sourceSheetName === name)
  const taken = plan.additions.find(
    (addition) => renamedAway.has(addition.name) && addressed(addition.name),
  )
  if (taken !== undefined) {
    throw new SheetEditError(
      `Sheet "${taken.name}" is renamed while a new sheet takes its old name in the same save — ` +
        'save with the new sheet under another name first, then rename it.',
    )
  }
}

/// Quotes a sheet name for use as a formula qualifier when Excel requires it
/// (non-identifier characters, or a name that parses as a cell reference).
export function formatSheetQualifier(name: string): string {
  const needsQuoting =
    !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ||
    /^[A-Za-z]{1,3}[0-9]+$/.test(name) ||
    /^(?:TRUE|FALSE)$/i.test(name) ||
    /^R[0-9]*C[0-9]*$/i.test(name)
  return needsQuoting ? `'${name.replaceAll("'", "''")}'` : name
}

type SheetNameLookup = (name: string) => string | undefined
type ReferenceRewrite = (reference: string) => string

export interface WorksheetRenameExemptions {
  readonly hyperlinkLocations: ReadonlyMap<string, string>
  readonly sparklineSources: ReadonlyMap<string, string>
}

const WORKSHEET_FORMULA =
  /(<(f|formula[12]?)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*?(?<!\/)>)([\s\S]*?)(<\/\2>)/g
const HYPERLINK_LOCATION = /^('(?:[^']|'')+'|[^'!]+)!([\s\S]*)$/
function sheetNameLookup(renames: SheetEditPlan['renames']): SheetNameLookup {
  const names = new Map(renames.map(({ sheetName, newName }) => [sheetName.toLowerCase(), newName]))
  return (name) => names.get(name.toLowerCase())
}

function lookupQualifier(qualifier: string, lookup: SheetNameLookup): string | undefined {
  const name = qualifier.startsWith("'") ? qualifier.slice(1, -1).replaceAll("''", "'") : qualifier
  return lookup(name)
}

/// Rewrite each original qualifier exactly once, even when two sheets
/// exchange names or one sheet takes the former name of another.
export function createSheetReferenceRenamer(renames: SheetEditPlan['renames']) {
  const lookup = sheetNameLookup(renames)
  const formula: ReferenceRewrite = (ref) => renameFormulaSheetNames(ref, lookup)
  const location: ReferenceRewrite = (ref) => {
    const match = HYPERLINK_LOCATION.exec(ref)
    if (!match?.[1] || match[2] === undefined) return ref
    const newName = lookupQualifier(match[1], lookup)
    return newName === undefined ? ref : `${formatSheetQualifier(newName)}!${match[2]}`
  }
  return {
    worksheet: (xml: string, preserve?: WorksheetRenameExemptions) =>
      rewriteWorksheetReferences(xml, formula, location, preserve),
    chart: (xml: string) => rewriteChartReferences(xml, formula),
    definedNames: (xml: string) => rewriteDefinedNames(xml, formula),
    pivotCache: (xml: string) => rewritePivotCacheSource(xml, lookup),
  }
}

/// String literals are left untouched, as are external workbook qualifiers.
function renameFormulaSheetNames(formula: string, lookup: SheetNameLookup): string {
  let result = ''
  for (const { code, literal } of formulaCodeSegments(formula)) {
    result += code.replace(
      FORMULA_REFERENCE_PATTERN,
      (full, lead: string, qualifier: string | undefined, token: string) => {
        if (qualifier === undefined || lead === ']') return full
        const newName = lookupQualifier(qualifier, lookup)
        return newName === undefined ? full : `${lead}${formatSheetQualifier(newName)}!${token}`
      },
    )
    result += literal
  }
  return result
}

export function renameSheetInFormula(formula: string, oldName: string, newName: string): string {
  return renameFormulaSheetNames(formula, sheetNameLookup([{ sheetName: oldName, newName }]))
}

/// True when the formula contains a local reference qualified with sheetName.
export function formulaReferencesSheet(formula: string, sheetName: string): boolean {
  for (const { code } of formulaCodeSegments(formula)) {
    for (const [, lead, qualifier] of code.matchAll(FORMULA_REFERENCE_PATTERN)) {
      if (lead !== ']' && qualifier !== undefined && qualifierMatches(qualifier, sheetName)) {
        return true
      }
    }
  }
  return false
}

function rewriteWorksheetReferences(
  worksheetXml: string,
  rewriteFormula: ReferenceRewrite,
  rewriteLocation: ReferenceRewrite,
  preserve?: WorksheetRenameExemptions,
): string {
  let xml = rewriteWorksheetCore(worksheetXml, (core) =>
    core.replace(
      WORKSHEET_FORMULA,
      (full, opening: string, _tag: string, body: string, closing: string) => {
        const formula = decodeEntities(body)
        const rewritten = rewriteFormula(formula)
        return rewritten === formula ? full : opening + escapeXmlText(rewritten) + closing
      },
    ),
  )
  xml = rewriteWorksheetHyperlinks(xml, (location, cell) =>
    cell !== undefined && preserve?.hyperlinkLocations.get(cell) === location
      ? location
      : rewriteLocation(location),
  )
  xml = rewriteX14DataValidations(xml, rewriteFormula)
  return rewriteWorksheetVisualReferences(
    xml,
    rewriteFormula,
    undefined,
    preserve?.sparklineSources,
  )
}

export function renameSheetReferencesInWorksheet(
  worksheetXml: string,
  oldName: string,
  newName: string,
): string {
  return createSheetReferenceRenamer([{ sheetName: oldName, newName }]).worksheet(worksheetXml)
}

export function renameSheetReferencesInChart(
  chartXml: string,
  oldName: string,
  newName: string,
): string {
  return createSheetReferenceRenamer([{ sheetName: oldName, newName }]).chart(chartXml)
}

export function renameSheetReferencesInDefinedNames(
  workbookXml: string,
  oldName: string,
  newName: string,
): string {
  return createSheetReferenceRenamer([{ sheetName: oldName, newName }]).definedNames(workbookXml)
}

export function worksheetReferencesSheet(worksheetXml: string, sheetName: string): boolean {
  let found = false
  rewriteWorksheetReferences(
    worksheetXml,
    (formula) => {
      found ||= formulaReferencesSheet(formula, sheetName)
      return formula
    },
    (location) => {
      const qualifier = HYPERLINK_LOCATION.exec(location)?.[1]
      found ||= qualifier !== undefined && qualifierMatches(qualifier, sheetName)
      return location
    },
  )
  return found
}

export function chartReferencesSheet(chartXml: string, sheetName: string): boolean {
  for (const { element } of chartFormulaElements(chartXml)) {
    if (formulaReferencesSheet(elementText(element.inner), sheetName)) return true
  }
  return false
}

/// Prepares a source sheet's relationships part for its duplicate. Hyperlink
/// relationships clone verbatim (ids are part-scoped, targets are external or
/// workbook-internal anchors). Printer settings reference a part the copy
/// must not share, so they are dropped — the caller strips the matching
/// r:id attributes. Anything else (drawings, tables, comments, pivots) would
/// leave the clone pointing at parts that cannot be shared: fail closed.
export function prepareClonedSheetRels(
  relsXml: string,
  sourceName: string,
): { relsXml: string | null; droppedPrinterSettings: boolean } {
  const root = findRelationshipsRoot(relsXml)
  if (!root) throw new SheetEditError(`Sheet "${sourceName}" has an invalid relationships part.`)
  const printerSettings = []
  let hasHyperlinks = false
  for (const entry of childElements(root.inner)) {
    const rawType = readWorksheetTagAttribute(entry.opening, 'Type')
    const type = rawType === undefined ? '' : decodeAttribute(rawType)
    if (entry.name.slice(entry.name.lastIndexOf(':') + 1) === 'Relationship') {
      if (type.endsWith('/hyperlink')) {
        hasHyperlinks = true
        continue
      }
      if (type.endsWith('/printerSettings')) {
        printerSettings.push(patchElement(entry, ''))
        continue
      }
    }
    throw new SheetEditError(
      `Sheet "${sourceName}" carries charts, images, tables, or comments — ` +
        'duplicating it is not supported yet.',
    )
  }
  return {
    relsXml: hasHyperlinks
      ? applyPatches(relsXml, [patchElement(root, withBody(root, applyPatches(root.inner, printerSettings)))])
      : null,
    droppedPrinterSettings: printerSettings.length > 0,
  }
}

/// Drops pageSetup r:id attributes from a cloned worksheet whose
/// printerSettings relationship was not cloned; the copy falls back to
/// default print settings instead of a dangling reference.
export function stripPageSetupRelIds(worksheetXml: string): string {
  const root = worksheetRoot(worksheetXml)
  const pageSetup = root
    ? scopedChildren(root).find((child) => isElement(child, 'pageSetup', root.namespace))
    : childElements(worksheetXml).find((child) => child.name === 'pageSetup')
  if (!pageSetup) return worksheetXml
  const attribute = readRelationshipIdAttribute(pageSetup.opening, '', root?.opening ?? '')
  if (!attribute) return worksheetXml
  const opening = updateWorksheetTagAttribute(pageSetup.opening, attribute.name, null)
  const offset = (root ? root.start + root.opening.length : 0) + pageSetup.start
  return worksheetXml.slice(0, offset) + opening + worksheetXml.slice(offset + pageSetup.opening.length)
}

/// A clone must not claim the selected-tab state of its source.
export function sanitizeClonedWorksheetXml(worksheetXml: string): string {
  const root = spreadsheetSheetRoot(worksheetXml)
  const children = root
    ? scopedChildren(root)
    : childElements(worksheetXml).map((child) => withNamespaces(child, new Map()))
  const views = children.find((child) => isElement(child, 'sheetViews', root?.namespace ?? ''))
  if (!views) return worksheetXml
  const patches = scopedChildren(views).flatMap((view) => {
    if (!isElement(view, 'sheetView', views.namespace) || !view.attributes.has('tabSelected')) return []
    const opening = updateWorksheetTagAttribute(view.opening, 'tabSelected', null)
    return [patchElement(view, opening + view.xml.slice(view.opening.length))]
  })
  if (patches.length === 0) return worksheetXml
  const offset = (root ? root.start + root.opening.length : 0) + views.start
  const replacement = withBody(views, applyPatches(views.inner, patches))
  return worksheetXml.slice(0, offset) + replacement + worksheetXml.slice(offset + views.xml.length)
}

/// Excel clones sheet-scoped defined names when copying a sheet; this save
/// path does not yet, and silently diverging (formulas on the copy resolving
/// to a workbook-level name or #NAME?) is worse than refusing.
export function assertNoSheetScopedDefinedNames(workbookXml: string, sourceName: string): void {
  const index = parseSheetElements(workbookXml).findIndex((sheet) => sheet.name === sourceName)
  if (index < 0) throw new SheetEditError(`Sheet "${sourceName}" was not found in the workbook.`)
  if (workbookDefinedNameElements(workbookXml).some(({ attributes }) =>
    parseWorkbookTabIndex(attributes.get('localSheetId')) === index,
  )) {
    throw new SheetEditError(
      `Sheet "${sourceName}" has sheet-scoped defined names — duplicating it is ` +
        'not supported yet.',
    )
  }
}

/// Blank worksheet part for added sheets.
export function buildWorksheetPartXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<sheetData/></worksheet>'
  )
}

export interface SheetElement {
  readonly xml: string
  readonly start: number
  readonly name: string
  readonly sheetId: string | undefined
  readonly hidden: boolean
  readonly veryHidden: boolean
  readonly relationshipId: string | undefined
}

export function parseSheetElements(workbookXml: string): SheetElement[] {
  const list = workbookSection(workbookXml, 'sheets')
  return list ? readSheetElements(list) : []
}

function readSheetElements(list: NonNullable<ReturnType<typeof workbookSection>>): SheetElement[] {
  const { section: sheets, root, start } = list
  const bodyStart = start + sheets.opening.length
  const elements: SheetElement[] = []
  for (const sheet of workbookSectionEntries(sheets, 'sheet')) {
    const { xml, opening, attributes } = sheet
    const name = attributes.get('name')
    if (name === undefined) continue
    const state = attributes.get('state')
    elements.push({
      xml,
      start: bodyStart + sheet.start,
      name,
      sheetId: attributes.get('sheetId'),
      hidden: state === 'hidden' || state === 'veryHidden',
      veryHidden: state === 'veryHidden',
      relationshipId: readRelationshipId(opening, sheets.opening, root.opening),
    })
  }
  return elements
}

function* sheetIdsInWorkbook(workbookXml: string): Iterable<number> {
  for (const { sheetId } of parseSheetElements(workbookXml)) {
    if (sheetId === undefined || !/^[0-9]+$/.test(sheetId)) continue
    const id = Number(sheetId)
    if (Number.isSafeInteger(id)) yield id
  }
}

export function maxSheetIdInWorkbook(workbookXml: string): number {
  let max = 0
  for (const id of sheetIdsInWorkbook(workbookXml)) max = Math.max(max, id)
  return max
}

// Excel requires sheet IDs in 1..65534 (MS-OI29500 2.1.578).
const MAX_EXCEL_SHEET_ID = 65_534

export function nextWorkbookSheetIds(workbookXml: string, count: number): number[] {
  const first = maxSheetIdInWorkbook(workbookXml) + 1
  if (first + count - 1 <= MAX_EXCEL_SHEET_ID) {
    return Array.from({ length: count }, (_, index) => first + index)
  }

  const used = new Set(sheetIdsInWorkbook(workbookXml))
  const ids: number[] = []
  let next = first
  while (ids.length < count) {
    if (next > MAX_EXCEL_SHEET_ID) next = 1
    while (next <= MAX_EXCEL_SHEET_ID && used.has(next)) next += 1
    if (next > MAX_EXCEL_SHEET_ID) throw new SheetEditError('No unused worksheet IDs remain.')
    used.add(next)
    ids.push(next++)
  }
  return ids
}

export function maxRelationshipId(relationshipsXml: string): number {
  let max = 0
  for (const id of relationshipIds(relationshipsXml)) {
    const match = /^rId(\d+)$/.exec(id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

function relationshipIds(relationshipsXml: string): Set<string> {
  const elements = childElements(relationshipsXml)
  const root = elements.find(({ name }) => name.slice(name.lastIndexOf(':') + 1) === 'Relationships')
  const used = new Set<string>()
  for (const { name, opening } of root ? childElements(root.inner) : elements) {
    if (name.slice(name.lastIndexOf(':') + 1) !== 'Relationship') continue
    const id = readWorksheetTagAttribute(opening, 'Id')
    if (id !== undefined) used.add(decodeAttribute(id))
  }
  return used
}

function firstFreeRelationshipId(used: ReadonlySet<string>): string {
  let index = 1
  while (used.has(`rId${index}`)) index += 1
  return `rId${index}`
}

export function nextFreeRelationshipId(relationshipsXml: string): string {
  return firstFreeRelationshipId(relationshipIds(relationshipsXml))
}

export function nextFreeRelationshipIds(relationshipsXml: string, count: number): string[] {
  const used = relationshipIds(relationshipsXml)
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const id = firstFreeRelationshipId(used)
    used.add(id)
    ids.push(id)
  }
  return ids
}

/// Rebuilds workbook.xml for the plan: sheet elements renamed / added /
/// removed and re-assembled in the final order, definedName localSheetId
/// scopes renumbered (or dropped with their sheet), and the active tab
/// follows its original sheet or moves to the first visible sheet if removed
/// or newly hidden.
export function applySheetPlanToWorkbookXml(
  workbookXml: string,
  plan: SheetEditPlan,
  additions: readonly SheetAllocation[],
): string {
  const sheetList = workbookSection(workbookXml, 'sheets')
  if (!sheetList) throw new SheetEditError('The workbook has no sheet list.')
  const sheetPrefix = prefixOf(sheetList.section.name)
  const relationshipBinding = relationshipNamespaceOverride(sheetList.section.opening, sheetList.root.opening)
  const elements = readSheetElements(sheetList)
  const originalNames = elements.map((element) => element.name)
  const renameByOriginal = new Map(plan.renames.map((rename) => [rename.sheetName, rename.newName]))
  const removedSet = new Set(plan.removals)

  const finalElements = new Map<string, { xml: string; hidden: boolean }>()
  for (const element of elements) {
    if (removedSet.has(element.name)) continue
    const newName = renameByOriginal.get(element.name)
    const opening = readRootStartTag(element.xml)
    const xml = newName === undefined ? element.xml
      : updateWorksheetTagAttribute(opening, 'name', escapeXmlAttribute(newName)) + element.xml.slice(opening.length)
    finalElements.set(newName ?? element.name, { xml, hidden: element.hidden })
  }
  for (const addition of additions) {
    finalElements.set(addition.name, {
      xml: `<${sheetPrefix}sheet name="${escapeXmlAttribute(addition.name)}" sheetId="${addition.sheetId}"${relationshipBinding} r:id="${addition.relationshipId}"/>`,
      hidden: false,
    })
  }
  for (const change of plan.hiddenChanges ?? []) {
    const finalName = renameByOriginal.get(change.sheetName) ?? change.sheetName
    const element = finalElements.get(finalName)
    if (!element) {
      throw new SheetEditError(`Sheet "${change.sheetName}" was not found for a visibility change.`)
    }
    element.hidden = change.hidden
    element.xml = setSheetStateAttribute(element.xml, change.hidden)
  }

  if (
    plan.order.length !== finalElements.size ||
    plan.order.some((name) => !finalElements.has(name))
  ) {
    throw new SheetEditError('The sheet order does not match the final sheet set.')
  }
  const firstVisible = plan.order.findIndex((name) => !finalElements.get(name)?.hidden)
  if (firstVisible === -1) {
    throw new SheetEditError('A workbook needs at least one visible sheet.')
  }

  const ordered = plan.order.map((name) => finalElements.get(name)!.xml)
  const slots = workbookSectionEntries(sheetList.section, 'sheet').filter(({ attributes }) =>
    attributes.has('name'),
  )
  const inner = applyPatches(sheetList.section.inner, slots.map((slot, index) => patchElement(slot, ordered[index] ?? '')))
    + ordered.slice(slots.length).join('')
  let result = workbookXml.slice(0, sheetList.start) + withBody(sheetList.section, inner) + workbookXml.slice(sheetList.end)

  // Defined-name scopes are positional (localSheetId = tab index).
  const oldIndexToNew = (oldIndex: number): number | null => {
    const originalName = originalNames[oldIndex]
    if (originalName === undefined || removedSet.has(originalName)) return null
    const mapped = plan.order.indexOf(renameByOriginal.get(originalName) ?? originalName)
    return mapped < 0 ? null : mapped
  }
  const definedNames = workbookNameParts(result)
  if (definedNames?.section) {
    const { bodyStart, section, entries } = definedNames
    const patches = entries.flatMap((name) => {
      const localId = parseWorkbookTabIndex(name.attributes.get('localSheetId'))
      if (localId === undefined) return []
      const mapped = oldIndexToNew(localId)
      if (mapped === localId) return []
      const updated =
        mapped === null
          ? ''
          : updateWorksheetTagAttribute(name.opening, 'localSheetId', String(mapped)) +
            name.xml.slice(name.opening.length)
      return [patchElement(name, updated)]
    })
    if (patches.length > 0) {
      const inner = applyPatches(section.inner, patches)
      const offset = bodyStart + section.start
      result =
        result.slice(0, offset) +
        (inner.trim() ? withBody(section, inner) : '') +
        result.slice(offset + section.xml.length)
    }
  }

  // Both editors open the first visible sheet when the saved active tab is
  // stale. Resolve that fallback in the old order before remapping it.
  const firstOriginallyVisible = elements.findIndex((element) => !element.hidden)
  const activeIndex = (oldIndex: number): number => {
    const original = elements[oldIndex]?.hidden === false ? oldIndex : firstOriginallyVisible
    const mapped = oldIndexToNew(original)
    if (mapped === null) return firstVisible
    return finalElements.get(plan.order[mapped]!)?.hidden ? firstVisible : mapped
  }
  // A missing workbook view has the same implicit active index as an empty one.
  const implicitActiveIndex = activeIndex(0)
  const bookViews = workbookSection(result, 'bookViews')
  if (bookViews) {
    const views = workbookSectionEntries(bookViews.section, 'workbookView')
    const savedTabs = views.map((view) => view.attributes.get('activeTab'))
    const hasSavedTab = savedTabs.some((tab) => tab !== undefined)
    const patches = views.flatMap((view, viewIndex) => {
      const saved = savedTabs[viewIndex]
      // Both readers choose the last explicit active tab. A synthesized tab
      // on an implicit view could override the workbook's opening sheet.
      if (saved === undefined && hasSavedTab) return []
      const index = parseWorkbookTabIndex(saved) ?? 0
      const mapped = activeIndex(index)
      if (index === mapped) return []
      const opening = updateWorksheetTagAttribute(view.opening, 'activeTab', String(mapped))
      return [patchElement(view, opening + view.xml.slice(view.opening.length))]
    })
    let inner = applyPatches(bookViews.section.inner, patches)
    if (views.length === 0 && implicitActiveIndex !== 0) {
      inner += `<${prefixOf(bookViews.section.name)}workbookView activeTab="${implicitActiveIndex}"/>`
    }
    if (inner !== bookViews.section.inner) {
      result =
        result.slice(0, bookViews.start) +
        withBody(bookViews.section, inner) +
        result.slice(bookViews.end)
    }
  } else if (implicitActiveIndex !== 0) {
    const sheets = workbookSection(result, 'sheets')
    if (sheets) {
      const prefix = prefixOf(sheets.root.name)
      result =
        result.slice(0, sheets.start) +
        `<${prefix}bookViews><${prefix}workbookView activeTab="${implicitActiveIndex}"/></${prefix}bookViews>` +
        result.slice(sheets.start)
    }
  }

  // Added <sheet> elements carry r:id; hosts that bind r per element only
  // would leave the new element's prefix undeclared.
  return additions.length > 0 ? ensureRelationshipNamespace(result) : result
}

export function parseWorkbookTabIndex(raw: string | undefined): number | undefined {
  const value = raw?.trim() ?? ''
  const index = Number(value)
  return /^\+?\d+$/.test(value) && Number.isSafeInteger(index) ? index : undefined
}

function workbookSection(workbookXml: string, name: string) {
  const [element] = childElements(workbookXml)
  const root = element && withNamespaces(element, new Map())
  if (root?.local !== 'workbook') return undefined
  const [section] = workbookSectionEntries(root, name)
  if (!section) return undefined
  const start = root.start + root.opening.length + section.start
  return { root, section, start, end: start + section.xml.length }
}

function workbookSectionEntries(section: ScopedElement, name: string) {
  return scopedChildren(section).filter((entry) => isElement(entry, name, section.namespace))
}

function* survivingDefinedNameFormulas(workbookXml: string, removedLocalIds: ReadonlySet<number>) {
  for (const name of workbookDefinedNameElements(workbookXml)) {
    const localId = parseWorkbookTabIndex(name.attributes.get('localSheetId'))
    if (localId !== undefined && removedLocalIds.has(localId)) continue
    const formula = readDefinedNameText(name.inner)
    if (formula !== undefined) yield formula
  }
}

/// Toggles a `<sheet>` element's state attribute. A veryHidden sheet stays
/// veryHidden when re-hidden; unhiding clears either state (the renderer
/// never emits that for veryHidden, so only an explicit op reaches here).
function setSheetStateAttribute(sheetXml: string, hidden: boolean): string {
  const opening = readRootStartTag(sheetXml)
  const state = readWorksheetTagAttribute(opening, 'state')
  if (hidden && state !== undefined && decodeAttribute(state) === 'veryHidden') return sheetXml
  const withoutState = updateWorksheetTagAttribute(opening, 'state', null)
  const updated = hidden ? withoutState.replace(/^<[^\s/>]+/, '$& state="hidden"') : withoutState
  return updated + sheetXml.slice(opening.length)
}

export function addWorksheetOverride(contentTypesXml: string, partPath: string, isChartSheet = false): string {
  const kind = isChartSheet ? 'chartsheet' : 'worksheet'
  const updated = addContentTypeEntry(
    contentTypesXml, 'Override', `/${partPath}`, `application/vnd.openxmlformats-officedocument.spreadsheetml.${kind}+xml`,
  )
  if (updated === undefined) throw new SheetEditError('The workbook has no [Content_Types].xml Types element.')
  return updated
}

function findTypesRoot(xml: string) {
  return childElements(xml).find(({ name }) => name.slice(name.lastIndexOf(':') + 1) === 'Types')
}

export function addContentTypeEntry(
  xml: string,
  kind: 'Default' | 'Override',
  value: string,
  contentType: string,
): string | undefined {
  const root = findTypesRoot(xml)
  if (!root) return undefined
  const name = root.name.slice(0, -'Types'.length) + kind
  const key = kind === 'Default' ? 'Extension' : 'PartName'
  const exists = childElements(root.inner).some((element) => {
    if (element.name !== name) return false
    const raw = readWorksheetTagAttribute(element.opening, key)
    if (raw === undefined) return false
    const registered = decodeAttribute(raw)
    return kind === 'Default' ? registered.toLowerCase() === value.toLowerCase() : registered === value
  })
  if (exists) return xml
  const element = `<${name} ${key}="${escapeXmlAttribute(value)}" ContentType="${escapeXmlAttribute(contentType)}"/>`
  return appendChildAtRoot(xml, root, element)
}

/// Removes the [Content_Types].xml Override for any part path (worksheets,
/// drawings, charts, comments, tables). Parts covered by a Default extension
/// mapping have no Override; the call is a no-op for them.
export function removePartOverride(contentTypesXml: string, partPath: string): string {
  const root = findTypesRoot(contentTypesXml)
  if (!root) return contentTypesXml
  const name = root.name.slice(0, -'Types'.length) + 'Override'
  const entry = childElements(root.inner).find((element) => {
    if (element.name !== name) return false
    const part = readWorksheetTagAttribute(element.opening, 'PartName')
    return part !== undefined && decodeAttribute(part) === `/${partPath}`
  })
  if (!entry) return contentTypesXml
  const start = root.start + root.opening.length + entry.start
  return contentTypesXml.slice(0, start) + contentTypesXml.slice(start + entry.xml.length)
}

export function addWorksheetRelationship(
  relationshipsXml: string,
  relationshipId: string,
  target: string,
  type = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
): string {
  const added = appendRelationshipRecord(
    relationshipsXml, relationshipId, type, target,
  )
  if (added === undefined) throw new SheetEditError('The workbook has no relationships part.')
  return added
}

export function findRelationshipsRoot(xml: string) {
  return childElements(xml).find(({ name }) => name.slice(name.lastIndexOf(':') + 1) === 'Relationships')
}

export function appendRelationshipRecord(
  xml: string,
  id: string,
  type: string,
  target: string,
  targetMode?: 'External',
): string | undefined {
  const root = findRelationshipsRoot(xml)
  if (!root) return undefined
  const name = root.name.slice(0, -1)
  const element = `<${name} Id="${escapeXmlAttribute(id)}" Type="${escapeXmlAttribute(type)}" ` +
    `Target="${escapeXmlAttribute(target)}"${targetMode ? ` TargetMode="${targetMode}"` : ''}/>`
  return appendChildAtRoot(xml, root, element)
}

function appendChildAtRoot(xml: string, root: ChildElement, element: string): string {
  const endOfOpening = root.start + root.opening.length
  if (root.opening.endsWith('/>')) {
    return xml.slice(0, endOfOpening - 2) + `>${element}</${root.name}>` + xml.slice(endOfOpening)
  }
  const close = endOfOpening + root.inner.length
  return xml.slice(0, close) + element + xml.slice(close)
}

export function relationshipIdsMatch(id: string | undefined, reference: string | undefined): boolean {
  return id !== undefined && reference !== undefined && decodeAttribute(id) === decodeAttribute(reference)
}

export function removeRelationshipById(relationshipsXml: string, relationshipId: string): string {
  const root = findRelationshipsRoot(relationshipsXml)
  if (!root) return relationshipsXml
  const entry = childElements(root.inner).find(({ name, opening }) =>
    name.slice(name.lastIndexOf(':') + 1) === 'Relationship' &&
    relationshipIdsMatch(readWorksheetTagAttribute(opening, 'Id'), relationshipId),
  )
  if (!entry) return relationshipsXml
  const start = root.start + root.opening.length + entry.start
  return relationshipsXml.slice(0, start) + relationshipsXml.slice(start + entry.xml.length)
}

/// Relationship types whose targets never block a sheet removal: hyperlink
/// targets are external (or workbook-internal anchors that die with the
/// sheet's part), and printer settings survive as harmless orphans.
const IGNORABLE_SHEET_RELATIONSHIP_TYPES = /\/(?:hyperlink|printerSettings)$/

/// Relationship types whose targets are owned by the sheet: drawings (with
/// their images and charts), legacy VML, comments, threaded comments, form
/// control properties, tables, and a sheet-background image are anchored on
/// exactly one sheet, so they are cascade-deleted with it.
const OWNED_SHEET_RELATIONSHIP_TYPES =
  /\/(?:drawing|vmlDrawing|comments|threadedComment|ctrlProp|table|image)$/

export interface ParsedRelationship {
  readonly id: string | undefined
  readonly type: string
  readonly target: string
  readonly external: boolean
}

export function parseRelationships(relsXml: string): ParsedRelationship[] {
  const entries: ParsedRelationship[] = []
  const root = findRelationshipsRoot(relsXml)
  for (const { name, opening } of childElements(root?.inner ?? '')) {
    if (name.slice(name.lastIndexOf(':') + 1) !== 'Relationship') continue
    const type = readWorksheetTagAttribute(opening, 'Type')
    const target = readWorksheetTagAttribute(opening, 'Target')
    if (type === undefined || target === undefined) continue
    entries.push({
      id: readWorksheetTagAttribute(opening, 'Id'),
      type: decodeAttribute(type),
      target: decodeAttribute(target),
      external: readWorksheetTagAttribute(opening, 'TargetMode') === 'External',
    })
  }
  return entries
}

/// Inverse of xlsx-drawing-add's relsPathFor; the package-level "_rels/.rels"
/// maps to "".
export function partPathForRels(relsPath: string): string {
  return relsPath.replace(/(^|\/)_rels\/([^/]*)\.rels$/, '$1$2')
}

/// Returns the (unresolved) targets of a removed sheet's owned satellite
/// parts, for the caller to cascade-delete. Relationships that never block a
/// removal are skipped; anything else — pivot tables, slicers, OLE objects —
/// fails closed rather than leave dangling references for Excel to repair.
export function classifyRemovedSheetRels(relsXml: string, sheetName: string): string[] {
  const owned: string[] = []
  for (const entry of parseRelationships(relsXml)) {
    if (entry.external || IGNORABLE_SHEET_RELATIONSHIP_TYPES.test(entry.type)) continue
    if (OWNED_SHEET_RELATIONSHIP_TYPES.test(entry.type)) {
      owned.push(entry.target)
      continue
    }
    const kind = /\/pivotTable$/.test(entry.type)
      ? 'a pivot table'
      : `a part this build cannot delete safely (${entry.type})`
    throw new SheetEditError(
      `Sheet "${sheetName}" carries ${kind} — deleting it is not supported yet.`,
    )
  }
  return owned
}

/// displayName of the table defined in a table part — the token surviving
/// formulas would use in structured references (Table1[Amount]).
export function tableDisplayName(tableXml: string): string | undefined {
  return tablePartNames(tableXml)[0]
}

export function tablePartNames(tableXml: string): string[] {
  const opening = readRootStartTag(tableXml)
  if (!/^<(?:[\w.-]+:)?table[\s/>]/.test(opening)) return []
  return ['displayName', 'name'].flatMap((attribute) => {
    const value = readWorksheetTagAttribute(opening, attribute)
    return value ? [decodeAttribute(value)] : []
  })
}

/// True when a defined name that survives the removal mentions the token
/// (a structured-reference prefix like "DecoTable["). Table names are
/// case-insensitive in Excel, so the match is too. Names scoped to a
/// removed sheet die with it and never block.
export function definedNamesUseToken(
  workbookXml: string,
  token: string,
  removedLocalIds: ReadonlySet<number>,
): boolean {
  const needle = token.toLowerCase()
  for (const formula of survivingDefinedNameFormulas(workbookXml, removedLocalIds)) {
    if (formula.toLowerCase().includes(needle)) return true
  }
  return false
}

/// True when a pivotCacheDefinition part reads its source rows from the
/// sheet (cacheSource/worksheetSource@sheet). Sheet names compare
/// case-insensitively, matching Excel.
export function pivotCacheReadsFromSheet(cacheXml: string, sheetName: string): boolean {
  const source = localPivotWorksheetSource(cacheXml)
  return source?.element.attributes.get('sheet')?.toLowerCase() === sheetName.toLowerCase()
}

/// Rewrites worksheetSource@sheet in a pivotCacheDefinition part when the
/// pivot's source sheet is renamed.
export function renameSheetInPivotCacheSource(
  cacheXml: string,
  oldName: string,
  newName: string,
): string {
  return rewritePivotCacheSource(cacheXml, sheetNameLookup([{ sheetName: oldName, newName }]))
}

function rewritePivotCacheSource(cacheXml: string, lookup: SheetNameLookup): string {
  return rewritePivotWorksheetSource(cacheXml, 'sheet', lookup)
}

export function renameTableInPivotCacheSource(
  cacheXml: string,
  names: ReadonlyMap<string, string>,
): string {
  return rewritePivotWorksheetSource(cacheXml, 'name', (name) => names.get(name.toLowerCase()))
}

function rewritePivotWorksheetSource(
  xml: string,
  attribute: 'sheet' | 'name',
  lookup: (name: string) => string | undefined,
): string {
  const source = localPivotWorksheetSource(xml)
  if (!source) return xml
  const { element, start } = source
  const old = element.attributes.get(attribute)
  const next = old === undefined ? undefined : lookup(old)
  if (next === undefined || next === old) return xml
  const opening = updateWorksheetTagAttribute(element.opening, attribute, escapeXmlAttribute(next))
  return xml.slice(0, start) + opening + xml.slice(start + element.opening.length)
}

export function convertPivotTableSourceToRange(
  xml: string,
  resolve: (name: string, sheet: string | undefined) => { sheet: string; ref: string } | undefined,
): string {
  const source = localPivotWorksheetSource(xml)
  if (!source) return xml
  const { element, start } = source
  const name = element.attributes.get('name')
  const range = name && resolve(name, element.attributes.get('sheet'))
  if (!range) return xml
  let opening = updateWorksheetTagAttribute(element.opening, 'name', null)
  opening = updateWorksheetTagAttribute(opening, 'sheet', escapeXmlAttribute(range.sheet))
  opening = updateWorksheetTagAttribute(opening, 'ref', escapeXmlAttribute(range.ref))
  return xml.slice(0, start) + opening + xml.slice(start + element.opening.length)
}

export function localPivotWorksheetSource(xml: string) {
  if (!xml.includes('worksheetSource')) return undefined
  const [element] = childElements(xml)
  if (!element) return undefined
  const root = withNamespaces(element, new Map())
  const cache = root.local === 'cacheSource' ? root
    : root.local === 'pivotCacheDefinition'
      ? scopedChildren(root).find((entry) => isElement(entry, 'cacheSource', root.namespace))
      : undefined
  if (cache?.attributes.get('type') !== 'worksheet') return undefined
  const source = scopedChildren(cache).find((entry) => isElement(entry, 'worksheetSource', cache.namespace))
  if (!source || readRelationshipId(source.opening, cache.opening, root.opening) !== undefined) {
    return undefined
  }
  const cacheBody = cache === root ? root.start + root.opening.length
    : root.start + root.opening.length + cache.start + cache.opening.length
  return { element: source, start: cacheBody + source.start }
}

/// DefinedNames scoped to a removed sheet are dropped with it, so their
/// bodies referencing the sheet must not block the removal.
export function definedNamesReferenceSheet(
  workbookXml: string,
  sheetName: string,
  removedLocalIds: ReadonlySet<number>,
): boolean {
  for (const formula of survivingDefinedNameFormulas(workbookXml, removedLocalIds)) {
    if (formulaReferencesSheet(formula, sheetName)) return true
  }
  return false
}

export function readAttribute(elementXml: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${escapeRegExp(name)}="([^"]*)"`).exec(elementXml)?.[1]
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  amp: '&',
}

/// Single-pass decode of the XML named entities plus numeric character
/// references (&#dd; / &#xhh;) — producers may encode non-ASCII sheet names
/// as numeric references, which sequential replaceAll would miss.
function decodeEntities(input: string): string {
  return input.replace(
    /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(quot|apos|lt|gt|amp));/g,
    (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (named !== undefined) return NAMED_ENTITIES[named] ?? match
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(dec)
      return code <= 0x10ffff ? String.fromCodePoint(code) : match
    },
  )
}

export function decodeAttribute(input: string): string {
  return decodeEntities(input)
}

function escapeXmlText(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeXmlAttribute(input: string): string {
  return escapeXmlText(input).replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}
