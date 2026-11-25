import { SPARKLINE_EXT_URI } from './xlsx-sparkline.ts'
import {
  elementText,
  escapeXmlAttribute,
  escapeXmlText,
  extensionUri,
  isElement,
  scopedChildren,
  withBody,
  worksheetRoot,
  X14_CF_EXT_URI,
  X14_XMLNS,
  XM_XMLNS,
  XML_ATTRIBUTE,
  type ScopedElement,
} from './xlsx-worksheet-xml.ts'

type FormulaRewrite = (formula: string) => string
type RangeRewrite = (sqref: string) => string | null

const thresholdCollections = new Set(['colorScale', 'dataBar', 'iconSet'])

/// Rewrites visual formula references on structural edits and sheet renames.
/// The range callback is only supplied when the edited sheet owns the visual.
export function rewriteWorksheetVisualReferences(
  xml: string,
  rewriteFormula: FormulaRewrite,
  rewriteRange?: RangeRewrite,
  preservedSparklineSources?: ReadonlyMap<string, string>,
): string {
  if (!/cfvo|sparklineGroups|conditionalFormattings/.test(xml)) return xml
  const root = worksheetRoot(xml)
  if (!root) return xml
  const rewritten = rewriteChildren(root, (child) => {
    if (isElement(child, 'conditionalFormatting', root.namespace)) {
      return rewriteChildren(child, (rule) =>
        isElement(rule, 'cfRule', root.namespace)
          ? rewriteThresholds(rule, rewriteFormula)
          : rule.xml,
      )
    }
    if (!isElement(child, 'extLst', root.namespace)) return child.xml
    return rewriteChildren(
      child,
      (extension) => {
        if (!isElement(extension, 'ext', root.namespace)) return extension.xml
        switch (extensionUri(extension)) {
          case SPARKLINE_EXT_URI.toUpperCase():
            return rewriteChildren(
              extension,
              (groups) =>
                isElement(groups, 'sparklineGroups', X14_XMLNS)
                  ? rewriteSparklineGroups(
                      groups,
                      rewriteFormula,
                      rewriteRange,
                      preservedSparklineSources,
                    )
                  : groups.xml,
              true,
            )
          case X14_CF_EXT_URI:
            return rewriteChildren(
              extension,
              (blocks) =>
                isElement(blocks, 'conditionalFormattings', X14_XMLNS)
                  ? rewriteExtendedConditionalBlocks(blocks, rewriteFormula, rewriteRange)
                  : blocks.xml,
              true,
            )
          default:
            return extension.xml
        }
      },
      true,
    )
  })
  return rewritten === root.xml
    ? xml
    : xml.slice(0, root.start) + rewritten + xml.slice(root.start + root.xml.length)
}

function rewriteThresholds(rule: ScopedElement, rewriteFormula: FormulaRewrite): string {
  return rewriteChildren(rule, (payload) =>
    payload.namespace === rule.namespace && thresholdCollections.has(payload.local)
      ? rewriteChildren(payload, (threshold) => {
          if (!isElement(threshold, 'cfvo', rule.namespace)) return threshold.xml
          if (rule.namespace === X14_XMLNS) {
            return rewriteChildren(threshold, (field) =>
              rewriteFormulaElement(field, rewriteFormula),
            )
          }
          const formula = threshold.attributes.get('val')
          if (threshold.attributes.get('type') !== 'formula' || formula === undefined) {
            return threshold.xml
          }
          const moved = rewriteFormula(formula)
          if (moved === formula) return threshold.xml
          const opening = threshold.opening.replace(
            XML_ATTRIBUTE,
            (attribute, prefix: string, name: string) =>
              name === 'val' ? `${prefix}"${escapeXmlAttribute(moved)}"` : attribute,
          )
          return opening + threshold.xml.slice(threshold.opening.length)
        })
      : rewriteFormulaElement(payload, rewriteFormula),
  )
}

function rewriteExtendedConditionalBlocks(
  blocks: ScopedElement,
  rewriteFormula: FormulaRewrite,
  rewriteRange: RangeRewrite | undefined,
): string {
  return rewriteChildren(
    blocks,
    (block) =>
      isElement(block, 'conditionalFormatting', X14_XMLNS)
        ? rewriteTargetedEntry(block, rewriteRange, (rule) =>
            isElement(rule, 'cfRule', X14_XMLNS)
              ? rewriteThresholds(rule, rewriteFormula)
              : rule.xml,
          )
        : block.xml,
    true,
  )
}

function rewriteSparklineGroups(
  groups: ScopedElement,
  rewriteFormula: FormulaRewrite,
  rewriteRange: RangeRewrite | undefined,
  preservedSources: ReadonlyMap<string, string> | undefined,
): string {
  return rewriteChildren(
    groups,
    (group) => {
      if (!isElement(group, 'sparklineGroup', X14_XMLNS)) return group.xml
      const items = scopedChildren(group).find((child) => isElement(child, 'sparklines', X14_XMLNS))
      if (!items) return group.xml
      const sparklines = rewriteChildren(
        items,
        (sparkline) => {
          if (!isElement(sparkline, 'sparkline', X14_XMLNS)) return sparkline.xml
          const target =
            preservedSources &&
            scopedChildren(sparkline).find((field) => isElement(field, 'sqref', XM_XMLNS))
          const preserved = target && preservedSources?.get(elementText(target.inner))
          return rewriteTargetedEntry(sparkline, rewriteRange, (field) =>
            rewriteFormulaElement(
              field,
              preserved === undefined
                ? rewriteFormula
                : (formula) => (formula === preserved ? formula : rewriteFormula(formula)),
            ),
          )
        },
        true,
      )
      if (sparklines === '') return ''
      return rewriteChildren(group, (child) =>
        child.start === items.start ? sparklines : rewriteFormulaElement(child, rewriteFormula),
      )
    },
    true,
  )
}

function rewriteTargetedEntry(
  entry: ScopedElement,
  rewriteRange: RangeRewrite | undefined,
  rewriteChild: (field: ScopedElement) => string,
): string {
  const target =
    rewriteRange && scopedChildren(entry).find((field) => isElement(field, 'sqref', XM_XMLNS))
  if (!target || !rewriteRange) return rewriteChildren(entry, rewriteChild)
  const original = elementText(target.inner)
  const moved = rewriteRange(original)
  if (moved === null) return ''
  return rewriteChildren(entry, (field) => {
    if (field.start !== target.start) return rewriteChild(field)
    return moved === original ? field.xml : withBody(field, escapeXmlText(moved))
  })
}

function rewriteFormulaElement(field: ScopedElement, rewriteFormula: FormulaRewrite): string {
  if (!isElement(field, 'f', XM_XMLNS)) return field.xml
  const original = elementText(field.inner)
  const moved = rewriteFormula(original)
  return moved === original ? field.xml : withBody(field, escapeXmlText(moved))
}

function rewriteChildren(
  parent: ScopedElement,
  rewrite: (child: ScopedElement) => string,
  dropWhenEmpty = false,
): string {
  const chunks: string[] = []
  let start = 0
  for (const child of scopedChildren(parent)) {
    const updated = rewrite(child)
    if (updated === child.xml) continue
    chunks.push(parent.inner.slice(start, child.start), updated)
    start = child.start + child.xml.length
  }
  if (!chunks.length) return parent.xml
  chunks.push(parent.inner.slice(start))
  const body = chunks.join('')
  return dropWhenEmpty && !body.trim() ? '' : withBody(parent, body)
}
