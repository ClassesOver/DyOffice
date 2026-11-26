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
import { rewriteX14DataValidations } from './xlsx-dv.ts'
import { ensureRelationshipNamespace, readRelationshipId, readRootStartTag } from './xlsx-namespace.ts'
import { findRootChild } from './xlsx-root-tail.ts'
import { childElements } from './xlsx-style-entries.ts'
import { rewriteWorksheetVisualReferences } from './xlsx-visual-references.ts'
import {
  applyPatches,
  elementText,
  patchElement,
  prefixOf,
  withBody,
} from './xlsx-worksheet-xml.ts'

/// '>' is legal inside XML attribute values (sheet names can carry it), so
/// element scans consume quoted runs atomically instead of using [^>]*.
const TAG_ATTRIBUTES = `(?:"[^"]*"|'[^']*'|[^>"'])*?`

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
  let droppedPrinterSettings = false
  let result = relsXml
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*?\bType="([^"]+)"[^>]*?\/>\s*/g)) {
    if (/\/hyperlink$/.test(match[1] ?? '')) continue
    if (/\/printerSettings$/.test(match[1] ?? '')) {
      droppedPrinterSettings = true
      result = result.replace(match[0], '')
      continue
    }
    throw new SheetEditError(
      `Sheet "${sourceName}" carries charts, images, tables, or comments — ` +
        'duplicating it is not supported yet.',
    )
  }
  return {
    relsXml: /<Relationship\b/.test(result) ? result : null,
    droppedPrinterSettings,
  }
}

/// Drops pageSetup r:id attributes from a cloned worksheet whose
/// printerSettings relationship was not cloned; the copy falls back to
/// default print settings instead of a dangling reference.
export function stripPageSetupRelIds(worksheetXml: string): string {
  return worksheetXml.replace(
    /(<pageSetup\b[^>]*?)\s+r:id="[^"]*"/g,
    (_full, prefix: string) => prefix,
  )
}

/// A clone must not claim the selected-tab state of its source.
export function sanitizeClonedWorksheetXml(worksheetXml: string): string {
  return worksheetXml.replace(
    /(<sheetView\b[^>]*?)\s+tabSelected="[^"]*"/g,
    (_full, prefix: string) => prefix,
  )
}

/// Excel clones sheet-scoped defined names when copying a sheet; this save
/// path does not yet, and silently diverging (formulas on the copy resolving
/// to a workbook-level name or #NAME?) is worse than refusing.
export function assertNoSheetScopedDefinedNames(workbookXml: string, sourceName: string): void {
  const index = parseSheetElements(workbookXml).findIndex((sheet) => sheet.name === sourceName)
  if (index < 0) throw new SheetEditError(`Sheet "${sourceName}" was not found in the workbook.`)
  if (new RegExp(`<definedName\\b[^>]*?\\blocalSheetId="${index}"`).test(workbookXml)) {
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
  readonly name: string
  readonly sheetId: string | undefined
  readonly hidden: boolean
  readonly veryHidden: boolean
  readonly relationshipId: string | undefined
}

export function parseSheetElements(workbookXml: string): SheetElement[] {
  const elements: SheetElement[] = []
  const span = findRootChild(workbookXml, 'workbook', 'sheets')
  if (!span) return elements
  const [sheets] = childElements(workbookXml.slice(span.start, span.end))
  if (!sheets) return elements
  const root = readRootStartTag(workbookXml)
  for (const { name: tag, xml, opening } of childElements(sheets.inner)) {
    if (tag.slice(tag.lastIndexOf(':') + 1) !== 'sheet') continue
    const name = readWorksheetTagAttribute(opening, 'name')
    if (name === undefined) continue
    const id = readWorksheetTagAttribute(opening, 'sheetId')
    const state = readWorksheetTagAttribute(opening, 'state')
    elements.push({
      xml,
      name: decodeAttribute(name),
      sheetId: id === undefined ? undefined : decodeAttribute(id),
      hidden: state === 'hidden' || state === 'veryHidden',
      veryHidden: state === 'veryHidden',
      relationshipId: readRelationshipId(opening, sheets.opening, root),
    })
  }
  return elements
}

export function maxSheetIdInWorkbook(workbookXml: string): number {
  let max = 0
  for (const match of workbookXml.matchAll(
    new RegExp(`<sheet\\b${TAG_ATTRIBUTES}\\bsheetId="([0-9]+)"`, 'g'),
  )) {
    max = Math.max(max, Number(match[1]))
  }
  return max
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
  const elements = parseSheetElements(workbookXml)
  const originalNames = elements.map((element) => element.name)
  const renameByOriginal = new Map(plan.renames.map((rename) => [rename.sheetName, rename.newName]))
  const removedSet = new Set(plan.removals)

  const finalElements = new Map<string, { xml: string; hidden: boolean }>()
  for (const element of elements) {
    if (removedSet.has(element.name)) continue
    const newName = renameByOriginal.get(element.name)
    const xml =
      newName === undefined
        ? element.xml
        : element.xml.replace(/\bname="[^"]*"/, () => `name="${escapeXmlAttribute(newName)}"`)
    finalElements.set(newName ?? element.name, { xml, hidden: element.hidden })
  }
  for (const addition of additions) {
    finalElements.set(addition.name, {
      xml: `<sheet name="${escapeXmlAttribute(addition.name)}" sheetId="${addition.sheetId}" r:id="${addition.relationshipId}"/>`,
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

  const sheetsInner = plan.order.map((name) => finalElements.get(name)?.xml ?? '').join('')
  let result = workbookXml.replace(
    /<sheets>[\s\S]*?<\/sheets>/,
    () => `<sheets>${sheetsInner}</sheets>`,
  )

  // Defined-name scopes are positional (localSheetId = tab index).
  const oldIndexToNew = (oldIndex: number): number | null => {
    const originalName = originalNames[oldIndex]
    if (originalName === undefined || removedSet.has(originalName)) return null
    const mapped = plan.order.indexOf(renameByOriginal.get(originalName) ?? originalName)
    return mapped < 0 ? null : mapped
  }
  const definedNames = workbookSection(result, 'definedNames')
  if (definedNames) {
    const patches = workbookSectionEntries(definedNames.section, 'definedName').flatMap((name) => {
      const localId = readTabIndex(name.opening, 'localSheetId')
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
      const inner = applyPatches(definedNames.section.inner, patches)
      result =
        result.slice(0, definedNames.start) +
        (inner.trim() ? withBody(definedNames.section, inner) : '') +
        result.slice(definedNames.end)
    }
  }

  const activeIndex = (oldIndex: number): number => {
    const mapped = oldIndexToNew(oldIndex)
    if (mapped === null) return firstVisible
    const newlyHidden =
      !elements[oldIndex]?.hidden && finalElements.get(plan.order[mapped]!)?.hidden
    return newlyHidden ? firstVisible : mapped
  }
  // The active tab defaults to the original first tab, even without a book view.
  const implicitActiveIndex = activeIndex(0)
  const bookViews = workbookSection(result, 'bookViews')
  if (bookViews) {
    const views = workbookSectionEntries(bookViews.section, 'workbookView')
    const patches = views.flatMap((view) => {
      const index = readTabIndex(view.opening, 'activeTab') ?? 0
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
    const sheets = findRootChild(result, 'workbook', 'sheets')
    if (sheets) {
      const prefix = prefixOf(childElements(result)[0]?.name ?? '')
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

function readTabIndex(
  opening: string,
  attribute: 'localSheetId' | 'activeTab',
): number | undefined {
  const raw = readWorksheetTagAttribute(opening, attribute)
  const value = raw === undefined ? '' : decodeAttribute(raw).trim()
  return /^\+?\d+$/.test(value) ? Number(value) : undefined
}

function workbookSection(workbookXml: string, name: string) {
  const position = findRootChild(workbookXml, 'workbook', name)
  if (!position) return undefined
  const [section] = childElements(workbookXml.slice(position.start, position.end))
  return section ? { ...position, section } : undefined
}

function workbookSectionEntries(section: { inner: string }, name: string) {
  return childElements(section.inner).filter(
    (entry) => entry.name.slice(prefixOf(entry.name).length) === name,
  )
}

function* survivingDefinedNameFormulas(workbookXml: string, removedLocalIds: ReadonlySet<number>) {
  const names = workbookSection(workbookXml, 'definedNames')
  if (!names) return
  for (const name of workbookSectionEntries(names.section, 'definedName')) {
    const localId = readTabIndex(name.opening, 'localSheetId')
    if (localId !== undefined && removedLocalIds.has(localId)) continue
    const formula = readDefinedNameText(name.inner)
    if (formula !== undefined) yield formula
  }
}

/// Toggles a `<sheet>` element's state attribute. A veryHidden sheet stays
/// veryHidden when re-hidden; unhiding clears either state (the renderer
/// never emits that for veryHidden, so only an explicit op reaches here).
function setSheetStateAttribute(sheetXml: string, hidden: boolean): string {
  if (hidden && /\sstate="veryHidden"/.test(sheetXml)) return sheetXml
  const withoutState = sheetXml.replace(/\s+state="[^"]*"/, '')
  if (!hidden) return withoutState
  return withoutState.replace(/^<sheet\b/, '<sheet state="hidden"')
}

export function addWorksheetOverride(contentTypesXml: string, partPath: string): string {
  const override = `<Override PartName="/${partPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  if (!contentTypesXml.includes('</Types>')) {
    throw new SheetEditError('The workbook has no [Content_Types].xml Types element.')
  }
  return contentTypesXml.replace('</Types>', () => `${override}</Types>`)
}

/// Removes the [Content_Types].xml Override for any part path (worksheets,
/// drawings, charts, comments, tables). Parts covered by a Default extension
/// mapping have no Override; the call is a no-op for them.
export function removePartOverride(contentTypesXml: string, partPath: string): string {
  return contentTypesXml.replace(
    new RegExp(`<Override\\b[^>]*PartName="/${escapeRegExp(partPath)}"[^>]*/>\\s*`),
    '',
  )
}

export function addWorksheetRelationship(
  relationshipsXml: string,
  relationshipId: string,
  target: string,
): string {
  const relationship = `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/>`
  if (!relationshipsXml.includes('</Relationships>')) {
    throw new SheetEditError('The workbook has no relationships part.')
  }
  return relationshipsXml.replace('</Relationships>', () => `${relationship}</Relationships>`)
}

export function removeRelationshipById(relationshipsXml: string, relationshipId: string): string {
  return relationshipsXml.replace(
    new RegExp(`<Relationship\\b[^>]*\\bId="${escapeRegExp(relationshipId)}"[^>]*/>\\s*`),
    '',
  )
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
  const root = childElements(relsXml).find(({ name }) => name.slice(name.lastIndexOf(':') + 1) === 'Relationships')
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
  const openTag = /<table\b[^>]*>/.exec(tableXml)?.[0]
  if (!openTag) return undefined
  const name = readAttribute(openTag, 'displayName') ?? readAttribute(openTag, 'name')
  return name === undefined ? undefined : decodeAttribute(name)
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
  const target = sheetName.toLowerCase()
  for (const [element] of cacheXml.matchAll(WORKSHEET_SOURCE)) {
    if (pivotSourceSheet(element)?.toLowerCase() === target) return true
  }
  return false
}

/// Rewrites worksheetSource@sheet in a pivotCacheDefinition part when the
/// pivot's source sheet is renamed — the attribute holds the plain sheet
/// name, so the formula-oriented rename helpers never see it.
export function renameSheetInPivotCacheSource(
  cacheXml: string,
  oldName: string,
  newName: string,
): string {
  return rewritePivotCacheSource(cacheXml, sheetNameLookup([{ sheetName: oldName, newName }]))
}

function rewritePivotCacheSource(cacheXml: string, lookup: SheetNameLookup): string {
  return cacheXml.replace(WORKSHEET_SOURCE, (element) => {
    const sheet = pivotSourceSheet(element)
    const newName = sheet === undefined ? undefined : lookup(sheet)
    return newName === undefined
      ? element
      : updateWorksheetTagAttribute(element, 'sheet', escapeXmlAttribute(newName))
  })
}

const WORKSHEET_SOURCE = new RegExp(`<worksheetSource(?=[\\s/>])${TAG_ATTRIBUTES}/?>`, 'g')

function pivotSourceSheet(element: string): string | undefined {
  const raw = readWorksheetTagAttribute(element, 'sheet')
  return raw === undefined ? undefined : decodeAttribute(raw)
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
