import { isOfficeRelationshipNamespace } from './xlsx-namespace.ts'
import { childElements } from './xlsx-style-entries.ts'
import { scopedChildren, withNamespaces, type ScopedElement } from './xlsx-worksheet-xml.ts'

const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  'http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing',
])
const GRAPHIC_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
])
const CHART_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/chart',
  'http://purl.oclc.org/ooxml/drawingml/chart',
])
const SVG_NS = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main'
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

function findNamespacedChild(
  parent: ScopedElement,
  local: string,
  namespaces: ReadonlySet<string>,
  legacyPrefix: string,
): ScopedElement | undefined {
  return scopedChildren(parent).find(
    (child) => child.local === local &&
      (child.namespace === undefined
        ? child.name === `${legacyPrefix}:${local}`
        : namespaces.has(child.namespace)),
  )
}

export function drawingChild(parent: ScopedElement | undefined, local: string): ScopedElement | undefined {
  return parent && scopedChildren(parent).find(
    (node) => node.local === local && isDrawingChild(parent, node),
  )
}

export function isDrawingMainName(name: string, namespace: string | undefined): boolean {
  return namespace === undefined ? name.startsWith('a:') : GRAPHIC_NAMESPACES.has(namespace)
}

export function drawingMainChildren(parent: ScopedElement): ScopedElement[] {
  return scopedChildren(parent).filter(node => isDrawingMainName(node.name, node.namespace))
}

export function drawingMainChild(parent: ScopedElement | undefined, local: string): ScopedElement | undefined {
  return parent && drawingMainChildren(parent).find(node => node.local === local)
}

export function drawingRelationshipAttribute(
  node: ScopedElement | undefined,
  key: 'id' | 'embed' | 'link',
): string | undefined {
  if (!node) return undefined
  const suffix = ':' + key
  const references = [...node.attributes].filter(
    ([name]) => name !== 'xmlns' + suffix && name.endsWith(suffix) &&
      isOfficeRelationshipNamespace(node.namespaces.get(name.slice(0, -suffix.length))),
  )
  if (references.length > 1) return undefined
  const legacy = node.namespaces.has('r') ? undefined : node.attributes.get('r' + suffix)
  return references[0]?.[1] ?? legacy
}

const nonVisualContainers = new Map([
  ['pic', 'nvPicPr'],
  ['sp', 'nvSpPr'],
  ['cxnSp', 'nvCxnSpPr'],
  ['grpSp', 'nvGrpSpPr'],
  ['graphicFrame', 'nvGraphicFramePr'],
])

export function drawingNonVisualProperties(anchor: ScopedElement) {
  const object = scopedChildren(anchor).find(
    (node) => isDrawingChild(anchor, node) && nonVisualContainers.has(node.local),
  )
  if (!object) return undefined
  const container = drawingChild(object, nonVisualContainers.get(object.local)!)
  const node = drawingChild(container, 'cNvPr')
  if (!container || !node) return undefined
  const start = anchor.opening.length + object.start + object.opening.length +
    container.start + container.opening.length + node.start
  return { node, start }
}

export function readDrawingPicture(anchor: ScopedElement) {
  const picture = drawingChild(anchor, 'pic')
  if (!picture) return undefined
  const fill = drawingChild(picture, 'blipFill')
  // Some legacy drawings put the blip directly under the picture.
  const blip = drawingMainChild(fill ?? picture, 'blip')
  return { picture, fill, blip }
}

export function pictureExtensionBlips(blip: ScopedElement | undefined): ScopedElement[] {
  const list = drawingMainChild(blip, 'extLst')
  if (!list) return []
  return scopedChildren(list).filter(
    (extension) => extension.local === 'ext' && extension.namespace === list.namespace,
  ).flatMap(extension => scopedChildren(extension).filter(
    (child) => child.local === 'svgBlip' && child.namespace === SVG_NS,
  ))
}

export function readDrawingGraphicFrame(
  anchor: ScopedElement,
): { chartRelationshipId?: string | undefined } | undefined {
  const frame = drawingChild(anchor, 'graphicFrame')
  if (!frame) return undefined
  const graphic = drawingMainChild(frame, 'graphic')
  const data = drawingMainChild(graphic, 'graphicData')
  const chart = data && findNamespacedChild(data, 'chart', CHART_NAMESPACES, 'c')
  return { chartRelationshipId: drawingRelationshipAttribute(chart, 'id') }
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
