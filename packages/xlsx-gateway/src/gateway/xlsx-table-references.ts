import { rewriteX14DataValidations } from './xlsx-dv.ts'
import { childElements } from './xlsx-style-entries.ts'
import { rewriteWorksheetVisualReferences } from './xlsx-visual-references.ts'
import {
  applyPatches,
  elementText,
  escapeXmlText,
  patchElement,
  scopedChildren,
  withBody,
  withNamespaces,
  type XmlPatch,
} from './xlsx-worksheet-xml.ts'

const formulaTags = /<(?:[\w.-]+:)?(?:f|formula[12]?|calculatedColumnFormula|totalsRowFormula)(?=[\s/>])/
const worksheetFormulas = new Set(['f', 'formula', 'formula1', 'formula2'])
const tableFormulas = new Set(['calculatedColumnFormula', 'totalsRowFormula'])

export function rewriteTableReferencesInPart(
  xml: string,
  kind: 'worksheet' | 'table',
  rewrite: (formula: string) => string,
): string {
  if (!xml.includes('[') && !xml.includes('&#')) return xml
  const [element] = childElements(xml)
  if (!element) return xml
  const root = withNamespaces(element, new Map())
  if (root.local !== kind) return xml

  const patches: XmlPatch[] = []
  const names = kind === 'worksheet' ? worksheetFormulas : tableFormulas
  const stack = [{ node: root, start: root.start }]
  while (stack.length > 0) {
    const { node, start } = stack.pop()!
    if (node.namespace !== root.namespace || node.local === 'extLst') continue
    if (names.has(node.local)) {
      const formula = elementText(node.inner)
      const replacement = rewrite(formula)
      if (replacement !== formula) {
        patches.push({ ...patchElement(node, withBody(node, escapeXmlText(replacement))), start })
      }
    } else if (formulaTags.test(node.inner)) {
      const bodyStart = start + node.opening.length
      for (const child of scopedChildren(node)) stack.push({ node: child, start: bodyStart + child.start })
    }
  }
  const rewritten = applyPatches(xml, patches)
  return kind === 'worksheet'
    ? rewriteWorksheetVisualReferences(rewriteX14DataValidations(rewritten, rewrite), rewrite)
    : rewritten
}
