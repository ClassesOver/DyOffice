import { childElements } from './xlsx-style-entries.ts'
import { scopedChildren, withNamespaces, type ScopedElement } from './xlsx-worksheet-xml.ts'

const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  'http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing',
])
const MARKUP_COMPATIBILITY_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const anchorNames = new Set(['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'])
const compatibilityBranches = new Set(['AlternateContent', 'Choice', 'Fallback'])
const anchorTag = /<(?:[^\s<>/:]+:)?(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)(?=[\s/>])/

export function isDrawingNamespace(namespace: string | undefined): boolean {
  return namespace !== undefined && DRAWING_NAMESPACES.has(namespace)
}

export function isDrawingChild(parent: ScopedElement, node: ScopedElement): boolean {
  return (
    node.namespace === parent.namespace &&
    (parent.namespace !== undefined || node.name.startsWith('xdr:'))
  )
}

export interface DrawingAnchorEntry {
  readonly element: ScopedElement
  readonly start: number
  readonly editable: boolean
  readonly topLevel: boolean
}

/// The native reader numbers physical anchor elements in document order,
/// including alternate-content branches. Inactive slots still count.
export function* drawingAnchorElements(xml: string): Generator<DrawingAnchorEntry> {
  if (!anchorTag.test(xml)) return
  const [element] = childElements(xml)
  if (!element) return
  const root = withNamespaces(element, new Map())
  if (
    root.local !== 'wsDr' ||
    !(
      isDrawingNamespace(root.namespace) ||
      root.namespace === '' ||
      (root.namespace === undefined && root.name === 'xdr:wsDr')
    )
  )
    return

  function* visit(
    parent: ScopedElement,
    start: number,
    topLevel: boolean,
    editablePath: boolean,
  ): Generator<DrawingAnchorEntry> {
    const bodyStart = start + parent.opening.length
    for (const child of scopedChildren(parent)) {
      const offset = bodyStart + child.start
      if (anchorNames.has(child.local)) {
        yield {
          element: child,
          start: offset,
          editable: editablePath && isDrawingChild(root, child),
          topLevel,
        }
      }
      if (anchorTag.test(child.inner)) {
        const branch =
          child.namespace === MARKUP_COMPATIBILITY_NS && compatibilityBranches.has(child.local)
        yield* visit(child, offset, false, editablePath && branch)
      }
    }
  }
  yield* visit(root, root.start, true, true)
}
