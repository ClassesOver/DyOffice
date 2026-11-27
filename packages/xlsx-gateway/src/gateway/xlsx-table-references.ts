import { chartFormulaElements } from './xlsx-chart-references.ts'
import { rewriteWorksheetValidations } from './xlsx-dv.ts'
import { findStructuredTableReference, rewriteWorksheetCellFormulas } from './xlsx-structure.ts'
import { childElements } from './xlsx-style-entries.ts'
import { rewriteWorksheetVisualReferences } from './xlsx-visual-references.ts'
import {
  applyPatches,
  elementText,
  escapeXmlText,
  isElement,
  isSpreadsheetNamespace,
  patchElement,
  scopedChildren,
  withBody,
  withNamespaces,
  type XmlPatch,
} from './xlsx-worksheet-xml.ts'

const tableFormulas = new Set(['calculatedColumnFormula', 'totalsRowFormula'])

export function rewriteTableReferencesInPart(
  xml: string,
  kind: 'worksheet' | 'table',
  rewrite: (formula: string) => string,
): string {
  if (!xml.includes('[') && !xml.includes('&#')) return xml
  if (kind === 'worksheet') {
    const cells = rewriteWorksheetCellFormulas(xml, rewrite)
    return rewriteWorksheetVisualReferences(rewriteWorksheetValidations(cells, rewrite), rewrite)
  }

  const [element] = childElements(xml)
  if (!element) return xml
  const root = withNamespaces(element, new Map())
  if (root.local !== 'table' || !isSpreadsheetNamespace(root.namespace)) return xml

  const patches: XmlPatch[] = []
  const bodyStart = root.start + root.opening.length
  for (const columns of scopedChildren(root)) {
    if (!isElement(columns, 'tableColumns', root.namespace)) continue
    const columnsStart = bodyStart + columns.start + columns.opening.length
    for (const column of scopedChildren(columns)) {
      if (!isElement(column, 'tableColumn', root.namespace)) continue
      const columnStart = columnsStart + column.start + column.opening.length
      for (const field of scopedChildren(column)) {
        if (field.namespace !== root.namespace || !tableFormulas.has(field.local)) continue
        const text = elementText(field.inner)
        const replacement = rewrite(text)
        if (replacement === text) continue
        patches.push({
          ...patchElement(field, withBody(field, escapeXmlText(replacement))),
          start: columnStart + field.start,
        })
      }
    }
  }
  return applyPatches(xml, patches)
}

export function findTableReferenceInPart(
  xml: string,
  kind: 'worksheet' | 'table' | 'chart',
  tableNames: ReadonlySet<string>,
): string | undefined {
  if (!xml.includes('[') && !xml.includes('&#')) return undefined
  if (kind === 'chart') {
    for (const { element } of chartFormulaElements(xml)) {
      const found = findStructuredTableReference(elementText(element.inner), tableNames)
      if (found !== undefined) return found
    }
    return undefined
  }
  let found: string | undefined
  rewriteTableReferencesInPart(xml, kind, (formula) => {
    found ??= findStructuredTableReference(formula, tableNames)
    return formula
  })
  return found
}
