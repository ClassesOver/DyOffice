/// Page Layout writer: merges the user's session changes into the worksheet's
/// `<printOptions>`, `<pageMargins>`, `<pageSetup>` (and `sheetView` display
/// attributes), and maintains the sheet-scoped `_xlnm.Print_Area` defined
/// name in workbook.xml. Untouched attributes and elements stay verbatim.

import { columnIndex, columnLabel, parseRange } from '../domain/cell-address.ts'
import { workbookDefinedNameElements, workbookNameParts } from './xlsx-defined-names.ts'
import { parseSheetElements, parseWorkbookTabIndex } from './xlsx-sheets.ts'
import {
  readDefinedNameText,
  readWorksheetTagAttribute,
  splitPrintRangeUnion,
  updateWorksheetTagAttribute,
} from './xlsx-structure.ts'
import { childElements, type ChildElement } from './xlsx-style-entries.ts'
import { isElement, lastWorksheetView, scopedChildren, spreadsheetSheetRoot, worksheetRoot, type ScopedElement } from './xlsx-worksheet-xml.ts'

export class PageSetupError extends Error {}

/// One printed header or footer: Excel's left/center/right sections. Text
/// carries Excel field codes verbatim (&P page, &N pages, &D date, &T time,
/// &F file name, &A sheet name, && literal ampersand).
export interface HeaderFooterParts {
  readonly left?: string | undefined
  readonly center?: string | undefined
  readonly right?: string | undefined
}

export interface SheetPageSetupState {
  readonly sheetName: string
  readonly orientation?: 'portrait' | 'landscape' | undefined
  readonly paperSize?: number | undefined
  readonly scale?: number | undefined
  readonly fitToWidth?: number | undefined
  readonly fitToHeight?: number | undefined
  readonly fitToPage?: boolean | undefined
  readonly margins?: 'normal' | 'wide' | 'narrow' | undefined
  readonly printGridlines?: boolean | undefined
  readonly printHeadings?: boolean | undefined
  readonly showGridlines?: boolean | undefined
  /// Normal-view zoom percent (10-400); 100 drops the attributes.
  readonly zoomScale?: number | undefined
  readonly showFormulas?: boolean | undefined
  readonly showHeadings?: boolean | undefined
  /// Mirrored grid (column A at the right edge of the sheet).
  readonly rightToLeft?: boolean | undefined
  readonly printArea?: string | null | undefined
  readonly printTitles?: string | null | undefined
  readonly clearPrintTitleRows?: true | undefined
  readonly frozenRows?: number | undefined
  readonly frozenColumns?: number | undefined
  /// Printed header/footer; null clears that half, undefined keeps it.
  readonly header?: HeaderFooterParts | null | undefined
  readonly footer?: HeaderFooterParts | null | undefined
  /// Manual page breaks (0-based index of the row/column after the break).
  /// Presence replaces the sheet's break set; [] clears all manual breaks.
  readonly rowBreaks?: readonly number[] | undefined
  readonly colBreaks?: readonly number[] | undefined
}

/// Inches, using the standard margin presets.
const MARGIN_PRESETS = {
  normal: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
  wide: { left: 1, right: 1, top: 1, bottom: 1, header: 0.5, footer: 0.5 },
  narrow: { left: 0.25, right: 0.25, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
} as const

// The tail of CT_Worksheet, in schema order, starting at the first print element.
const PRINT_ELEMENT_ORDER = [
  'printOptions',
  'pageMargins',
  'pageSetup',
  'headerFooter',
  'rowBreaks',
  'colBreaks',
  'customProperties',
  'cellWatches',
  'ignoredErrors',
  'smartTags',
  'drawing',
  'legacyDrawing',
  'legacyDrawingHF',
  'picture',
  'oleObjects',
  'controls',
  'webPublishItems',
  'tableParts',
  'extLst',
] as const
type PrintElement = (typeof PRINT_ELEMENT_ORDER)[number]
const printElementRank = new Map<string, number>(
  PRINT_ELEMENT_ORDER.map((name, rank) => [name, rank]),
)
type PrintElementEdit = (qualifiedName: string, existing?: ScopedElement) => string

/// Limits edits to direct SpreadsheetML sheet children.
function editPrintElements(
  xml: string,
  edits: ReadonlyMap<PrintElement, PrintElementEdit>,
): string {
  if (edits.size === 0) return xml
  const root = spreadsheetSheetRoot(xml)
  if (!root) {
    throw new PageSetupError('Worksheet has no root element.')
  }
  const children = scopedChildren(root).filter((child) => child.namespace === root.namespace)
  const patches: { start: number; end: number; rank: number; text: string }[] = []
  for (const [tag, render] of edits) {
    const rank = printElementRank.get(tag)!
    const matches = children.filter((child) => child.local === tag)
    if (matches.length > 0) {
      matches.forEach((child, index) => {
        const duplicateBreaks = index > 0 && (tag === 'rowBreaks' || tag === 'colBreaks')
        patches.push({
          start: child.start,
          end: child.start + child.xml.length,
          rank,
          text: duplicateBreaks ? '' : render(child.name, child),
        })
      })
    } else {
      const text = render(prefix(root.name) + tag)
      if (text === '') continue
      const anchor = children.find(
        (child) => (printElementRank.get(child.local) ?? -1) > rank,
      )
      const start = anchor?.start ?? root.inner.length
      patches.push({ start, end: start, rank, text })
    }
  }
  let body = root.inner
  // Replace before inserting at the same offset, then insert in reverse schema order.
  patches.sort((a, b) => b.start - a.start || b.end - a.end || b.rank - a.rank)
  for (const patch of patches) {
    body = body.slice(0, patch.start) + patch.text + body.slice(patch.end)
  }
  return replaceElement(xml, root, withChildren(root, body))
}

function mergePrintAttributes(attrs: Record<string, string | null>): PrintElementEdit {
  const entries = Object.entries(attrs)
  return (tag, existing) => {
    if (existing) {
      const opening = entries.reduce(
        (result, [name, value]) => updateWorksheetTagAttribute(result, name, value),
        existing.opening,
      )
      return opening + existing.xml.slice(existing.opening.length)
    }
    const kept = entries.filter(([, value]) => value !== null)
    if (kept.length === 0) return ''
    const attributes = kept.map(([name, value]) => ` ${name}="${value}"`).join('')
    return `<${tag}${attributes}/>`
  }
}

function prefix(name: string): string {
  return name.slice(0, name.lastIndexOf(':') + 1)
}

function localName(name: string): string {
  return name.slice(prefix(name).length)
}

function replaceElement(xml: string, element: ChildElement, replacement: string): string {
  return xml.slice(0, element.start) + replacement + xml.slice(element.start + element.xml.length)
}

function withChildren(element: ChildElement, body: string, opening = element.opening): string {
  if (body === element.inner) return opening + element.xml.slice(element.opening.length)
  if (opening.endsWith('/>')) {
    return `${opening.slice(0, -2)}>${body}</${element.name}>`
  }
  return opening + body + element.xml.slice(element.opening.length + element.inner.length)
}

/// Fit-to-page lives in the worksheet's sheetPr, after tabColor and outlinePr.
function setFitToPage(xml: string, enabled: boolean): string {
  const root = worksheetRoot(xml)
  if (!root) {
    if (!enabled) return xml
    throw new PageSetupError('Worksheet has no root element.')
  }
  const sheetPr = scopedChildren(root).find((child) => isElement(child, 'sheetPr', root.namespace))
  const start = root.start + root.opening.length
  if (sheetPr) {
    const pageSetUpPr = scopedChildren(sheetPr).find((child) =>
      isElement(child, 'pageSetUpPr', sheetPr.namespace),
    )
    if (!pageSetUpPr && !enabled) return xml
    const body = pageSetUpPr
      ? replaceElement(
          sheetPr.inner,
          pageSetUpPr,
          updateWorksheetTagAttribute(pageSetUpPr.opening, 'fitToPage', enabled ? '1' : null) +
            pageSetUpPr.xml.slice(pageSetUpPr.opening.length),
        )
      : `${sheetPr.inner}<${prefix(sheetPr.name)}pageSetUpPr fitToPage="1"/>`
    return replaceElement(xml, { ...sheetPr, start: start + sheetPr.start }, withChildren(sheetPr, body))
  }
  if (!enabled) return xml
  const qualifier = prefix(root.name)
  return (
    xml.slice(0, start) +
    `<${qualifier}sheetPr><${qualifier}pageSetUpPr fitToPage="1"/></${qualifier}sheetPr>` +
    xml.slice(start)
  )
}

function applyWorksheetViewState(xml: string, state: SheetPageSetupState): string {
  const attributes: Record<string, string | null> = {}
  if (state.showGridlines !== undefined) attributes.showGridLines = state.showGridlines ? null : '0'
  if (state.showFormulas !== undefined) attributes.showFormulas = state.showFormulas ? '1' : null
  if (state.zoomScale !== undefined) {
    // zoomScaleNormal is used when the workbook opens in a print view.
    const zoom = state.zoomScale === 100 ? null : String(state.zoomScale)
    attributes.zoomScale = zoom
    attributes.zoomScaleNormal = zoom
  }
  if (state.showHeadings !== undefined) attributes.showRowColHeaders = state.showHeadings ? null : '0'
  if (state.rightToLeft !== undefined) attributes.rightToLeft = state.rightToLeft ? '1' : null

  const replacePane = state.frozenRows !== undefined || state.frozenColumns !== undefined
  if (!replacePane && Object.keys(attributes).length === 0) return xml
  const root = spreadsheetSheetRoot(xml)
  const chartSheet = root?.local === 'chartsheet'
  if (chartSheet && state.zoomScale !== undefined) {
    delete attributes.zoomScaleNormal
    attributes.zoomToFit = '0'
  }
  const changes = Object.entries(attributes)
  const rows = state.frozenRows ?? 0
  const columns = state.frozenColumns ?? 0
  const hasPane = rows > 0 || columns > 0
  const pane = (name: string) => {
    if (!hasPane) return ''
    const active = rows > 0 && columns > 0 ? 'bottomRight' : rows > 0 ? 'bottomLeft' : 'topRight'
    const x = columns > 0 ? ` xSplit="${columns}"` : ''
    const y = rows > 0 ? ` ySplit="${rows}"` : ''
    return `<${prefix(name)}pane${x}${y} topLeftCell="${columnLabel(columns)}${rows + 1}" activePane="${active}" state="frozen"/>`
  }
  const openingWithUpdates = (opening: string) => changes.reduce(
    (current, [name, value]) => updateWorksheetTagAttribute(current, name, value),
    opening,
  )

  const create = hasPane || changes.some(([, value]) => value !== null)
  if (!root) {
    if (!create) return xml
    throw new PageSetupError('Worksheet has no root element.')
  }
  const children = scopedChildren(root).filter((child) => child.namespace === root.namespace)
  const views = children.find((child) => child.local === 'sheetViews')
  const view = lastWorksheetView(views)
  const offset = root.start + root.opening.length
  if (views && view) {
    let body = view.inner
    if (replacePane) {
      // Selections attached to removed panes become invalid. Keep ordinary selections.
      for (const child of scopedChildren(view).reverse()) {
        if (child.namespace === view.namespace && (child.local === 'pane' ||
          (child.local === 'selection' && child.attributes.has('pane')))) {
          body = replaceElement(body, child, '')
        }
      }
      body = pane(view.name) + body
    }
    const updated = withChildren(view, body, openingWithUpdates(view.opening))
    const updatedViews = withChildren(views, replaceElement(views.inner, view, updated))
    return replaceElement(xml, { ...views, start: offset + views.start }, updatedViews)
  }
  if (!create) return xml

  const qualifier = prefix(views?.name ?? root.name)
  const name = qualifier + 'sheetView'
  const newAttributes = changes.flatMap(([key, value]) => value === null ? [] : [` ${key}="${value}"`]).join('')
  const newOpening = `<${name} workbookViewId="0"${newAttributes}`
  const newView = hasPane ? `${newOpening}>${pane(name)}</${name}>` : `${newOpening}/>`
  if (views) {
    return replaceElement(xml, { ...views, start: offset + views.start }, withChildren(views, views.inner + newView))
  }
  const anchor = chartSheet ? children.find(child => child.local !== 'sheetPr')
    : children.find(child => child.local === 'sheetFormatPr' || child.local === 'cols' || child.local === 'sheetData')
  if (!anchor && !chartSheet) throw new PageSetupError('Worksheet has no sheetData element.')
  const at = offset + (anchor?.start ?? root.inner.length)
  return xml.slice(0, at) + `<${qualifier}sheetViews>${newView}</${qualifier}sheetViews>` + xml.slice(at)
}

/// A lone `&` that does not start an Excel code (`&&` literal, section,
/// field, formatting, font size, font spec, `&[Page]` named code) is written
/// as `&&`, the way Excel's own dialog does; anything else stays verbatim.
function escapeStrayAmpersands(text: string): string {
  return text.replace(/&&|&(?![LCRPNDTFAGBIUSEXYZOHK0-9"[])/gi, '&&')
}

/// Left/center/right → Excel's `&L..&C..&R..` code string, empty sections
/// omitted; the caller XML-escapes the result.
export function encodeHeaderFooterSections(parts: HeaderFooterParts): string {
  const sections: readonly (readonly [string, string | undefined])[] = [
    ['&L', parts.left],
    ['&C', parts.center],
    ['&R', parts.right],
  ]
  return sections
    .filter(([, text]) => text !== undefined && text !== '')
    .map(([marker, text]) => marker + escapeStrayAmpersands(text ?? ''))
    .join('')
}

/// Assembles `<headerFooter>` from already-XML-escaped odd header/footer
/// texts; both empty means no element at all ('').
function assembleHeaderFooterXml(oddHeader: string, oddFooter: string): string {
  if (oddHeader === '' && oddFooter === '') return ''
  return (
    '<headerFooter>' +
    (oddHeader === '' ? '' : `<oddHeader>${oddHeader}</oddHeader>`) +
    (oddFooter === '' ? '' : `<oddFooter>${oddFooter}</oddFooter>`) +
    '</headerFooter>'
  )
}

/// Header/footer parts → the worksheet `<headerFooter>` fragment ('' when
/// both are empty). Field codes and literal ampersands alike XML-escape to
/// `&amp;` — Excel reads the parsed `&` back as header/footer code.
export function buildHeaderFooterXml(
  header: HeaderFooterParts | null | undefined,
  footer: HeaderFooterParts | null | undefined,
): string {
  return assembleHeaderFooterXml(
    header ? escapeXml(encodeHeaderFooterSections(header)) : '',
    footer ? escapeXml(encodeHeaderFooterSections(footer)) : '',
  )
}

/// Updates the sheet's odd header/footer and retains the even and first-page variants.
function renderHeaderFooter(
  name: string,
  existing: ScopedElement | undefined,
  header: HeaderFooterParts | null | undefined,
  footer: HeaderFooterParts | null | undefined,
): string {
  let body = existing?.inner ?? ''
  const setSection = (
    tag: 'oddHeader' | 'oddFooter',
    parts: HeaderFooterParts | null | undefined,
  ) => {
    if (parts === undefined) return
    const text = parts === null ? '' : escapeXml(encodeHeaderFooterSections(parts))
    const children = existing
      ? scopedChildren({ ...existing, inner: body }).filter((child) => child.namespace === existing.namespace)
      : childElements(body)
    const previous = children.find((child) => localName(child.name) === tag)
    if (previous) {
      body = replaceElement(body, previous, text === '' ? '' : withChildren(previous, text))
    } else if (text !== '') {
      const qualified = prefix(name) + tag
      const element = `<${qualified}>${text}</${qualified}>`
      // CT_HeaderFooter order: oddHeader, oddFooter, even*, first*.
      const oddHeader =
        tag === 'oddFooter' && children.find((child) => localName(child.name) === 'oddHeader')
      const at = oddHeader ? oddHeader.start + oddHeader.xml.length : 0
      body = body.slice(0, at) + element + body.slice(at)
    }
  }
  setSection('oddHeader', header)
  setSection('oddFooter', footer)
  if (body.trim() === '') {
    const attributes = existing?.opening.slice(name.length + 1).replace(/\/?>$/, '') ?? ''
    return attributes.trim() === '' ? '' : `<${name}${attributes}/>`
  }
  return existing ? withChildren(existing, body) : `<${name}>${body}</${name}>`
}

/// Replaces the manual break set. Excel recomputes cached automatic breaks.
function renderPageBreaks(
  name: string,
  breaks: readonly number[],
  existing?: ScopedElement,
): string {
  const ids = [...new Set(breaks)].filter((id) => id > 0).sort((a, b) => a - b)
  let remaining = existing?.inner ?? ''
  if (existing) {
    for (const child of scopedChildren(existing).reverse()) {
      if (isElement(child, 'brk', existing.namespace)) remaining = replaceElement(remaining, child, '')
    }
  }
  if (ids.length === 0 && remaining.trim() === '') return ''
  const max = localName(name) === 'rowBreaks' ? 16_383 : 1_048_575
  const tag = prefix(name) + 'brk'
  const body = ids.map((id) => `<${tag} id="${id}" max="${max}" man="1"/>`).join('') + remaining
  if (existing) {
    const count = updateWorksheetTagAttribute(existing.opening, 'count', String(ids.length))
    const opening = updateWorksheetTagAttribute(count, 'manualBreakCount', String(ids.length))
    return withChildren(existing, body, opening)
  }
  return `<${name} count="${ids.length}" manualBreakCount="${ids.length}">${body}</${name}>`
}

export function applyPageSetupState(worksheetXml: string, state: SheetPageSetupState): string {
  let xml = applyWorksheetViewState(worksheetXml, state)

  const edits = new Map<PrintElement, PrintElementEdit>()
  const printOptions: Record<string, string | null> = {}
  if (state.printGridlines !== undefined) {
    printOptions.gridLines = state.printGridlines ? '1' : null
    if (state.printGridlines) printOptions.gridLinesSet = null // The schema defaults it to true.
  }
  if (state.printHeadings !== undefined) printOptions.headings = state.printHeadings ? '1' : null
  if (Object.keys(printOptions).length > 0)
    edits.set('printOptions', mergePrintAttributes(printOptions))

  if (state.margins !== undefined) {
    const margins = Object.entries(MARGIN_PRESETS[state.margins]).map(([name, value]) => [
      name,
      String(value),
    ])
    edits.set('pageMargins', mergePrintAttributes(Object.fromEntries(margins)))
  }

  const pageSetup: Record<string, string | null> = {}
  if (state.orientation !== undefined) pageSetup.orientation = state.orientation
  if (state.paperSize !== undefined) pageSetup.paperSize = String(state.paperSize)
  if (state.scale !== undefined) {
    pageSetup.scale = state.scale === 100 ? null : String(state.scale)
  }
  if (state.fitToWidth !== undefined) {
    pageSetup.fitToWidth = state.fitToWidth === 1 ? null : String(state.fitToWidth)
  }
  if (state.fitToHeight !== undefined) {
    pageSetup.fitToHeight = state.fitToHeight === 1 ? null : String(state.fitToHeight)
  }
  if (Object.keys(pageSetup).length > 0) edits.set('pageSetup', mergePrintAttributes(pageSetup))
  if (state.fitToPage !== undefined) xml = setFitToPage(xml, state.fitToPage)

  if (state.header !== undefined || state.footer !== undefined) {
    edits.set('headerFooter', (tag, existing) =>
      renderHeaderFooter(tag, existing, state.header, state.footer),
    )
  }
  const { rowBreaks, colBreaks } = state
  if (rowBreaks !== undefined)
    edits.set('rowBreaks', (tag, existing) => renderPageBreaks(tag, rowBreaks, existing))
  if (colBreaks !== undefined)
    edits.set('colBreaks', (tag, existing) => renderPageBreaks(tag, colBreaks, existing))
  return editPrintElements(xml, edits)
}

const CHART_SHEET_SETUP_FIELDS = new Set([
  'sheetName', 'zoomScale', 'orientation', 'paperSize', 'margins', 'header', 'footer',
])

export function applyChartSheetPageSetupState(xml: string, state: SheetPageSetupState): string {
  if (Object.entries(state).some(([field, value]) => value !== undefined && !CHART_SHEET_SETUP_FIELDS.has(field))) {
    throw new PageSetupError(`This page setup setting is unavailable on chart sheet "${state.sheetName}".`)
  }
  return applyPageSetupState(xml, state)
}

/// Maintains the sheet-scoped `_xlnm.Print_Area` / `_xlnm.Print_Titles`
/// names. localSheetId is positional, so entries follow workbook.xml's final
/// `<sheet>` order.
export function applyPrintAreas(
  workbookXml: string,
  areas: readonly {
    sheetName: string
    printArea?: string | null | undefined
    printTitles?: string | null | undefined
    clearPrintTitleRows?: true | undefined
  }[],
): string {
  let xml = workbookXml
  // Parse elements instead of pattern-matching serialized XML: attribute
  // order and entity encoding vary by producer.
  const sheetOrder = parseSheetElements(xml).map((element) => element.name)
  for (const { sheetName, printArea, printTitles, clearPrintTitleRows } of areas) {
    const sheetIndex = sheetOrder.indexOf(sheetName)
    if (sheetIndex === -1) {
      throw new PageSetupError(`Sheet "${sheetName}" was not found in the workbook.`)
    }
    const quoted = `'${sheetName.replace(/'/g, "''")}'`
    if (printArea !== undefined) {
      xml = setSheetScopedName(
        xml,
        '_xlnm.Print_Area',
        sheetIndex,
        printArea === null ? null : `${quoted}!${toAbsoluteRange(printArea)}`,
      )
    }
    if (printTitles !== undefined || clearPrintTitleRows) {
      const columns =
        clearPrintTitleRows && printTitles === undefined
          ? existingTitleSpans(xml, sheetIndex).cols
          : undefined
      xml = setSheetScopedName(
        xml,
        '_xlnm.Print_Titles',
        sheetIndex,
        typeof printTitles === 'string'
          ? titleReference(xml, quoted, sheetIndex, printTitles)
          : columns === undefined
            ? null
            : `${quoted}!${columns}`,
      )
    }
  }
  return xml
}

function scopedNames(entries: readonly ScopedElement[], name: string, sheetIndex: number) {
  return entries.filter(
    ({ attributes }) =>
      attributes.get('name') === name &&
      parseWorkbookTabIndex(attributes.get('localSheetId')) === sheetIndex,
  )
}

function setSheetScopedName(
  workbookXml: string,
  name: string,
  sheetIndex: number,
  reference: string | null,
): string {
  const makeEntry = (tag: string, body: string) =>
    `<${tag} name="${name}" localSheetId="${sheetIndex}">${body}</${tag}>`
  const body = reference === null ? null : escapeXml(reference)
  const parts = workbookNameParts(workbookXml)
  if (parts?.section) {
    const { bodyStart, section, entries: definedNames } = parts
    const matches = scopedNames(definedNames, name, sheetIndex)
    const first = matches[0]
    let entries = section.inner
    for (const match of matches.reverse()) {
      entries = replaceElement(
        entries,
        match,
        match === first && body !== null ? withChildren(match, body) : '',
      )
    }
    if (!first && body !== null) entries += makeEntry(prefix(section.name) + 'definedName', body)
    return replaceElement(
      workbookXml,
      { ...section, start: bodyStart + section.start },
      entries.trim() ? withChildren(section, entries) : '',
    )
  }
  if (body === null) return workbookXml

  // Schema order: definedNames follows sheets, functionGroups and externalReferences.
  if (!parts) throw new PageSetupError('workbook.xml has no sheets section.')
  const { root, children, bodyStart } = parts
  const anchor = ['externalReferences', 'functionGroups', 'sheets']
    .map((name) => children.find((child) => isElement(child, name, root.namespace)))
    .find((child) => child !== undefined)
  if (!anchor) throw new PageSetupError('workbook.xml has no sheets section.')
  const qualifier = prefix(root.name)
  const element = `<${qualifier}definedNames>${makeEntry(qualifier + 'definedName', body)}</${qualifier}definedNames>`
  const at = bodyStart + anchor.start + anchor.xml.length
  return workbookXml.slice(0, at) + element + workbookXml.slice(at)
}

/// "1:3" → "$1:$3" (title rows), "A:B" → "$A:$B" (title columns), or both
/// comma-separated. Setting one axis keeps the other axis already stored.
function titleReference(
  workbookXml: string,
  quoted: string,
  sheetIndex: number,
  titles: string,
): string {
  const incoming = parseTitleSpans(titles)
  const kept = existingTitleSpans(workbookXml, sheetIndex)
  const rows = incoming.rows ?? kept.rows
  const cols = incoming.cols ?? kept.cols
  const spans: string[] = []
  if (cols !== undefined) spans.push(`${quoted}!${cols}`)
  if (rows !== undefined) spans.push(`${quoted}!${rows}`)
  if (spans.length === 0) throw new PageSetupError(`Invalid print titles "${titles}".`)
  return spans.join(',')
}

function parseTitleSpans(titles: string): { rows?: string; cols?: string } {
  const out: { rows?: string; cols?: string } = {}
  for (const raw of titles.split(',')) {
    const span = raw.trim()
    const rows = /^\$?(\d{1,7}):\$?(\d{1,7})$/.exec(span)
    if (rows) {
      if (Number(rows[1]) > Number(rows[2]) || out.rows !== undefined) {
        throw new PageSetupError(`Invalid print titles "${titles}".`)
      }
      out.rows = `$${rows[1]}:$${rows[2]}`
      continue
    }
    const cols = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/.exec(span)
    if (cols) {
      const first = cols[1]!.toUpperCase()
      const second = cols[2]!.toUpperCase()
      let ordered: boolean
      try {
        ordered = columnIndex(first) <= columnIndex(second)
      } catch {
        ordered = false
      }
      if (!ordered || out.cols !== undefined) {
        throw new PageSetupError(`Invalid print titles "${titles}".`)
      }
      out.cols = `$${first}:$${second}`
      continue
    }
    throw new PageSetupError(`Invalid print titles "${titles}".`)
  }
  return out
}

function existingTitleSpans(
  workbookXml: string,
  sheetIndex: number,
): { rows?: string; cols?: string } {
  const match = scopedNames(workbookDefinedNameElements(workbookXml), '_xlnm.Print_Titles', sheetIndex)[0]
  const formula = match && readDefinedNameText(match.inner)
  if (!formula) return {}
  const out: { rows?: string; cols?: string } = {}
  for (const part of splitPrintRangeUnion(formula)) {
    const ref = part
      .slice(part.lastIndexOf('!') + 1)
      .replace(/\$/g, '')
      .trim()
    const rows = /^(\d{1,7}):(\d{1,7})$/.exec(ref)
    if (rows && Number(rows[1]) <= Number(rows[2]) && out.rows === undefined) {
      out.rows = `$${rows[1]}:$${rows[2]}`
      continue
    }
    const cols = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(ref)
    if (cols && out.cols === undefined) {
      try {
        if (columnIndex(cols[1]!.toUpperCase()) <= columnIndex(cols[2]!.toUpperCase())) {
          out.cols = `$${cols[1]!.toUpperCase()}:$${cols[2]!.toUpperCase()}`
        }
      } catch {
        continue
      }
    }
  }
  return out
}

/// "A1:C10" → "$A$1:$C$10" (already-absolute refs pass through).
function toAbsoluteRange(range: string): string {
  if (!/^[$A-Za-z0-9:]+$/.test(range) || !hasCellRowEnds(range)) {
    throw new PageSetupError(`Invalid print area "${range}".`)
  }
  return range
    .split(':')
    .map((part) => part.replace(/^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/, '$$$1$$$2'))
    .join(':')
}

/// parseRange needs a row on every endpoint, so whole-column ("A:A") and
/// half-open ("A1:B") refs — which Excel rejects inside _xlnm.Print_Area —
/// are refused before the refs are absolutised.
function hasCellRowEnds(range: string): boolean {
  try {
    parseRange(range)
    return true
  } catch {
    return false
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
