import { childElements } from './xlsx-style-entries.ts'
import {
  applyPatches,
  elementText,
  escapeXmlText,
  patchElement,
  scopedChildren,
  withBody,
  withNamespaces,
} from './xlsx-worksheet-xml.ts'

const CHART_FORMULA_TAG = /<(?:[^\s:<>/]+:)?f(?=[\s/>])/
const CHART_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/chart',
  'http://purl.oclc.org/ooxml/drawingml/chart',
])

export function* chartFormulaElements(xml: string) {
  if (!CHART_FORMULA_TAG.test(xml)) return
  const stack = childElements(xml).map((element) => ({
    element: withNamespaces(element, new Map()),
    start: element.start,
  }))
  while (stack.length > 0) {
    const entry = stack.pop()!
    const { element, start } = entry
    if (element.local === 'f') {
      // Standalone c:f fragments may omit the conventional namespace binding.
      const chartNamespace =
        element.namespace === undefined
          ? element.name === 'c:f'
          : CHART_NAMESPACES.has(element.namespace)
      if (chartNamespace && element.inner) yield entry
      continue
    }
    if (!CHART_FORMULA_TAG.test(element.inner)) continue
    const bodyStart = start + element.opening.length
    for (const child of scopedChildren(element)) {
      stack.push({ element: child, start: bodyStart + child.start })
    }
  }
}

export function rewriteChartReferences(xml: string, rewrite: (formula: string) => string): string {
  const patches = []
  for (const { element, start } of chartFormulaElements(xml)) {
    const formula = elementText(element.inner)
    const updated = rewrite(formula)
    if (updated === formula) continue
    patches.push({ ...patchElement(element, withBody(element, escapeXmlText(updated))), start })
  }
  return applyPatches(xml, patches)
}
