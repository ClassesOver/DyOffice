/// Surgical edits to visuals that already live in the file: remove an
/// anchor, or move/resize one by rewriting its from/to markers. Visuals are
/// located by the sidecar's (drawingPath, drawingIndex) pair — the index
/// counts every anchor element in document order, matching visuals.rs.

import { WORKBOOK_CHART_PATH } from '../shared/workbook-chart-path.ts'
import type { WorkbookVisualEdit } from '../shared/edit-schemas.ts'
import {
  appendRelationship,
  outlineXml,
  relsPathFor,
  resolveRelTarget,
  solidFillXml,
  type MutablePackage,
} from './xlsx-drawing-add.ts'
import {
  drawingAnchorElements,
  drawingChild,
  drawingMainChild,
  drawingMainChildren,
  isDrawingMainName,
  drawingNonVisualProperties,
  drawingRelationshipAttribute,
  isDrawingChild,
  pictureExtensionBlips,
  readDrawingGraphicFrame,
  readDrawingPicture,
} from './xlsx-drawing-anchors.ts'
import { hasXmlAttributeValue, OFFICE_RELATIONSHIPS_NAMESPACE, readRelationshipId } from './xlsx-namespace.ts'
import {
  findRelationshipsRoot,
  parseRelationships,
  partPathForRels,
  relationshipIdsMatch,
  removePartOverride,
  removeRelationshipById,
  type ParsedRelationship,
} from './xlsx-sheets.ts'
import { omitWorksheetTagAttributes, updateWorksheetTagAttribute } from './xlsx-structure.ts'
import { childElements } from './xlsx-style-entries.ts'
import { applyPatches, isElement, patchElement, prefixOf, scopedChildren, withBody, withNamespaces, worksheetRoot, type ScopedElement, type XmlPatch } from './xlsx-worksheet-xml.ts'

export class VisualEditError extends Error {}

const CHART_OWNED_RELATIONSHIP_TYPES =
  /\/(?:chartStyle|chartColorStyle|package|oleObject|theme|themeOverride|chartUserShapes|image|externalLink)$/
const CHART_OWNED_PATHS =
  /^xl\/(?:charts|media|embeddings|theme|drawings|externalLinks|oleObjects)\//

type RemovedAnchorRelationship = {
  readonly id: string
  readonly kind: 'chart' | 'image'
}

type OwnedPartRoot = {
  readonly path: string
  readonly recursive: boolean
}

function hyperlinkRelationshipNamespace(element: ScopedElement): string {
  return element.namespace?.startsWith('http://purl.oclc.org/ooxml/')
    ? 'http://purl.oclc.org/ooxml/officeDocument/relationships'
    : OFFICE_RELATIONSHIPS_NAMESPACE
}

export async function applyVisualEdits(
  pkg: MutablePackage,
  edits: readonly WorkbookVisualEdit[],
  touchedEntries: Set<string>,
): Promise<void> {
  const byPath = new Map<string, WorkbookVisualEdit[]>()
  for (const edit of edits) {
    const group = byPath.get(edit.drawingPath) ?? []
    group.push(edit)
    byPath.set(edit.drawingPath, group)
  }
  for (const [drawingPath, group] of byPath) {
    if (!(await pkg.has(drawingPath))) {
      throw new VisualEditError(`Workbook is missing ${drawingPath}.`)
    }
    const xml = await pkg.readText(drawingPath)
    const anchors = [...drawingAnchorElements(xml)]
    const byIndex = new Map<number, WorkbookVisualEdit>()
    for (const edit of group) {
      if (byIndex.has(edit.drawingIndex)) {
        throw new VisualEditError('Duplicate edits target the same drawing anchor.')
      }
      if (!anchors[edit.drawingIndex]) {
        throw new VisualEditError(
          `Drawing anchor #${edit.drawingIndex} was not found — the file may have changed.`,
        )
      }
      if (!anchors[edit.drawingIndex]?.editable) {
        throw new VisualEditError('The selected drawing anchor is not editable.')
      }
      byIndex.set(edit.drawingIndex, edit)
    }
    const relsPath = relsPathFor(drawingPath)
    const hyperlinkRelIds = new Map<number, string>()
    for (const edit of group) {
      if (!edit.hyperlink || edit.remove) continue
      const relationshipType = hyperlinkRelationshipNamespace(anchors[edit.drawingIndex]!.element) + '/hyperlink'
      hyperlinkRelIds.set(
        edit.drawingIndex,
        await appendRelationship(pkg, relsPath, relationshipType, edit.hyperlink, 'External'),
      )
      touchedEntries.add(relsPath)
    }
    const removedRelationships: RemovedAnchorRelationship[] = []
    const droppedHyperlinkRelIds: string[] = []
    const patched = anchors.map(({ element }, index) => {
      const edit = byIndex.get(index)
      return edit
        ? applyOneEdit(
            element,
            edit,
            removedRelationships,
            hyperlinkRelIds.get(index),
            droppedHyperlinkRelIds,
          )
        : element.xml
    })
    // Document order is z-order. Anchors carrying a zIndex permute among
    // their own slots (sorted by zIndex); every other anchor — and all the
    // markup between anchors, e.g. mc:AlternateContent wrappers — stays put.
    const movable = anchors
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry, index }) =>
          byIndex.get(index)?.zIndex !== undefined && patched[index] !== null && entry.topLevel,
      )
    const sorted = [...movable].sort(
      (left, right) =>
        byIndex.get(left.index)!.zIndex! - byIndex.get(right.index)!.zIndex! ||
        left.index - right.index,
    )
    const placed = [...patched]
    movable.forEach(({ index }, slot) => {
      placed[index] = patched[sorted[slot]!.index]!
    })
    let next = xml
    for (let index = anchors.length - 1; index >= 0; index -= 1) {
      const { element, start } = anchors[index]!
      const text = placed[index]
      if (text === element.xml) continue
      next = next.slice(0, start) + (text ?? '') + next.slice(start + element.xml.length)
    }
    if (removedRelationships.length > 0) {
      await cleanupRemovedAnchorRelationships(
        pkg,
        drawingPath,
        next,
        removedRelationships,
        touchedEntries,
      )
    }
    const orphaned = droppedHyperlinkRelIds.filter((id) => !hasXmlAttributeValue(next, id))
    if (orphaned.length > 0 && (await pkg.has(relsPath))) {
      let relsXml = await pkg.readText(relsPath)
      const links = parseRelationships(relsXml).filter((entry) => entry.type.endsWith('/hyperlink'))
      for (const id of orphaned) {
        if (links.some((entry) => relationshipIdsMatch(entry.id, id))) {
          relsXml = removeRelationshipById(relsXml, id)
        }
      }
      pkg.write(relsPath, relsXml)
      touchedEntries.add(relsPath)
    }
    pkg.write(drawingPath, next)
    touchedEntries.add(drawingPath)
    await cleanupEmptyDrawingHookup(pkg, drawingPath, next, touchedEntries)
  }
}

/**
 * Drop relationship rows no longer referenced by the drawing, then collect
 * their unshared package targets. Chart targets recursively own style, color,
 * embedded-workbook, theme-override, user-shape, and image relationships.
 */
async function cleanupRemovedAnchorRelationships(
  pkg: MutablePackage,
  drawingPath: string,
  remainingDrawingXml: string,
  removedRelationships: readonly RemovedAnchorRelationship[],
  touchedEntries: Set<string>,
): Promise<void> {
  const relsPath = relsPathFor(drawingPath)
  if (!(await pkg.has(relsPath))) {
    throw new VisualEditError('The drawing is missing its relationships part.')
  }
  let relsXml = await pkg.readText(relsPath)
  const roots: OwnedPartRoot[] = []
  const kindsById = new Map<string, RemovedAnchorRelationship['kind']>()
  for (const removed of removedRelationships) {
    const previous = kindsById.get(removed.id)
    if (previous !== undefined && previous !== removed.kind) {
      throw new VisualEditError('One drawing relationship is used by incompatible visuals.')
    }
    kindsById.set(removed.id, removed.kind)
  }
  for (const [relId, kind] of kindsById) {
    // A second anchor can intentionally reuse the same relationship. Removing
    // one anchor must not break the survivor.
    if (hasXmlAttributeValue(remainingDrawingXml, relId)) continue
    const relationship = parseRelationships(relsXml).find((entry) => relationshipIdsMatch(entry.id, relId))
    if (!relationship) {
      throw new VisualEditError(`The deleted ${kind} has no drawing relationship.`)
    }
    const expectedType = kind === 'chart' ? /\/chart$/ : /\/image$/
    if (!expectedType.test(relationship.type)) {
      throw new VisualEditError(
        `The deleted ${kind} uses an unsupported drawing relationship (${relationship.type}).`,
      )
    }
    const withoutRelationship = removeRelationshipById(relsXml, relId)
    if (withoutRelationship === relsXml) {
      throw new VisualEditError(`The deleted ${kind} relationship could not be removed safely.`)
    }
    relsXml = withoutRelationship
    if (relationship.external) continue
    const targetPath = resolveRelTarget(drawingPath, relationship.target)
    if (kind === 'chart') {
      if (!WORKBOOK_CHART_PATH.test(targetPath) || !(await pkg.has(targetPath))) {
        throw new VisualEditError('The deleted chart relationship has an invalid package target.')
      }
      roots.push({ path: targetPath, recursive: true })
    } else if (/^xl\/media\//.test(targetPath) && (await pkg.has(targetPath))) {
      roots.push({ path: targetPath, recursive: false })
    }
  }
  const removedParts = await collectUnreferencedOwnedParts(
    pkg,
    roots,
    new Map([[relsPath, relsXml]]),
  )
  const contentTypesPath = '[Content_Types].xml'
  let contentTypes = removedParts.size === 0 ? '' : await pkg.readText(contentTypesPath)
  const originalContentTypes = contentTypes
  for (const path of removedParts) contentTypes = removePartOverride(contentTypes, path)

  // All validation and relationship-graph reads above complete before the
  // package overlay is mutated, so unsupported chart dependencies fail closed.
  pkg.write(relsPath, relsXml)
  touchedEntries.add(relsPath)
  for (const path of removedParts) pkg.remove(path)
  if (contentTypes !== originalContentTypes) {
    pkg.write(contentTypesPath, contentTypes)
    touchedEntries.add(contentTypesPath)
  }
}

/**
 * Mirrors sheet-delete's relationship closure/retention pass: collect owned
 * descendants, then pull back any target reached from a surviving package part.
 */
async function collectUnreferencedOwnedParts(
  pkg: MutablePackage,
  roots: readonly OwnedPartRoot[],
  relationshipOverrides: ReadonlyMap<string, string> = new Map(),
): Promise<Set<string>> {
  const closure = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const current = queue.pop() as OwnedPartRoot
    if (closure.has(current.path) || !(await pkg.has(current.path))) continue
    closure.add(current.path)
    const childRelsPath = relsPathFor(current.path)
    if (!(await pkg.has(childRelsPath))) continue
    closure.add(childRelsPath)
    if (!current.recursive) continue
    const childRelationships =
      relationshipOverrides.get(childRelsPath) ?? (await pkg.readText(childRelsPath))
    for (const relationship of parseRelationships(childRelationships)) {
      if (relationship.external) continue
      const targetPath = resolveRelTarget(current.path, relationship.target)
      if (
        !CHART_OWNED_RELATIONSHIP_TYPES.test(relationship.type) ||
        !CHART_OWNED_PATHS.test(targetPath)
      ) {
        throw new VisualEditError(
          `The chart carries an unsupported relationship (${relationship.type}) — deletion aborted.`,
        )
      }
      queue.push({ path: targetPath, recursive: true })
    }
  }

  const retained = new Set<string>()
  const packagePaths = await pkg.paths()
  for (const relsPath of packagePaths) {
    if (!relsPath.endsWith('.rels') || closure.has(relsPath)) continue
    const owner = partPathForRels(relsPath)
    const relationships = relationshipOverrides.get(relsPath) ?? (await pkg.readText(relsPath))
    for (const relationship of parseRelationships(relationships)) {
      if (relationship.external) continue
      const target = resolveRelTarget(owner, relationship.target)
      if (closure.has(target)) retained.add(target)
    }
  }
  const propagate = [...retained]
  while (propagate.length > 0) {
    const source = propagate.pop() as string
    const childRelsPath = relsPathFor(source)
    if (!closure.has(childRelsPath) || retained.has(childRelsPath)) continue
    retained.add(childRelsPath)
    const childRelationships =
      relationshipOverrides.get(childRelsPath) ?? (await pkg.readText(childRelsPath))
    for (const relationship of parseRelationships(childRelationships)) {
      if (relationship.external) continue
      const target = resolveRelTarget(source, relationship.target)
      if (closure.has(target) && !retained.has(target)) {
        retained.add(target)
        propagate.push(target)
      }
    }
  }
  return new Set([...closure].filter((path) => !retained.has(path)))
}

/**
 * Once the final anchor is gone, remove the worksheet hookup and empty drawing
 * only when the relationship graph is unambiguous and carries no unsupported
 * relationship rows. Otherwise the empty drawing is preserved.
 */
async function cleanupEmptyDrawingHookup(
  pkg: MutablePackage,
  drawingPath: string,
  drawingXml: string,
  touchedEntries: Set<string>,
): Promise<void> {
  const inner = /<(?:[A-Za-z_][\w.-]*:)?wsDr\b[^>]*>([\s\S]*)<\/(?:[A-Za-z_][\w.-]*:)?wsDr>/.exec(
    drawingXml,
  )?.[1]
  if (inner === undefined || inner.trim() !== '') return
  const drawingRelsPath = relsPathFor(drawingPath)
  if (
    (await pkg.has(drawingRelsPath)) &&
    findRelationshipsRoot(await pkg.readText(drawingRelsPath))?.inner.trim() !== ''
  ) {
    return
  }

  const incoming: {
    owner: string
    relsPath: string
    relationship: ParsedRelationship
  }[] = []
  for (const candidateRelsPath of await pkg.paths()) {
    if (!candidateRelsPath.endsWith('.rels') || candidateRelsPath === drawingRelsPath) continue
    const owner = partPathForRels(candidateRelsPath)
    for (const relationship of parseRelationships(await pkg.readText(candidateRelsPath))) {
      if (!relationship.external && resolveRelTarget(owner, relationship.target) === drawingPath) {
        incoming.push({ owner, relsPath: candidateRelsPath, relationship })
      }
    }
  }
  if (incoming.length !== 1) return
  const incomingReference = incoming[0]
  if (incomingReference === undefined) return
  const { owner, relsPath, relationship } = incomingReference
  if (
    !/^xl\/worksheets\/[^/]+\.xml$/.test(owner) ||
    !/\/drawing$/.test(relationship.type) ||
    relationship.id === undefined ||
    !(await pkg.has(owner))
  ) {
    return
  }
  const worksheetXml = await pkg.readText(owner)
  const root = worksheetRoot(worksheetXml)
  if (!root) return
  const hookups = scopedChildren(root).filter((child) =>
    isElement(child, 'drawing', root.namespace) &&
    relationshipIdsMatch(relationship.id, readRelationshipId(child.opening, '', root.opening)),
  )
  const hookup = hookups[0]
  if (hookups.length !== 1 || !hookup || hookup.inner.trim() !== '') return
  const offset = root.start + root.opening.length + hookup.start
  const withoutHookup = worksheetXml.slice(0, offset) + worksheetXml.slice(offset + hookup.xml.length)
  if (hasXmlAttributeValue(withoutHookup, relationship.id)) return
  const worksheetRels = await pkg.readText(relsPath)
  const withoutRelationship = removeRelationshipById(worksheetRels, relationship.id)
  if (withoutRelationship === worksheetRels) return
  const contentTypesPath = '[Content_Types].xml'
  const contentTypes = await pkg.readText(contentTypesPath)
  const stripped = removePartOverride(contentTypes, drawingPath)

  pkg.write(owner, withoutHookup)
  touchedEntries.add(owner)
  if (findRelationshipsRoot(withoutRelationship)?.inner.trim() !== '') {
    pkg.write(relsPath, withoutRelationship)
    touchedEntries.add(relsPath)
  } else {
    pkg.remove(relsPath)
  }
  pkg.remove(drawingPath)
  if (await pkg.has(drawingRelsPath)) pkg.remove(drawingRelsPath)
  if (stripped !== contentTypes) {
    pkg.write(contentTypesPath, stripped)
    touchedEntries.add(contentTypesPath)
  }
}


const escapeXmlAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/// Sets (or with null removes) one attribute on an opening tag string.
export function setTagAttribute(tag: string, name: string, value: string | null): string {
  const stripped = omitWorksheetTagAttributes(tag, [name])
  if (value === null) return stripped
  const insertAt = stripped.endsWith('/>') ? stripped.length - 2 : stripped.length - 1
  return `${stripped.slice(0, insertAt)} ${name}="${escapeXmlAttribute(value)}"${stripped.slice(insertAt)}`
}

/// Degrees clockwise → a:xfrm/@rot (60000ths of a degree in [0, 360°)).
export function rotationAttribute(degrees: number): string | null {
  const normalized = ((Math.round(degrees * 60_000) % 21_600_000) + 21_600_000) % 21_600_000
  return normalized === 0 ? null : String(normalized)
}

/// One anchor's edits applied to its XML text; null when the anchor is
/// removed. Hyperlink relationships are allocated by the caller.
function applyOneEdit(
  element: ScopedElement,
  edit: WorkbookVisualEdit,
  removedRelationships: RemovedAnchorRelationship[],
  hyperlinkRelId: string | undefined,
  droppedHyperlinkRelIds: string[],
): string | null {
  const anchorXml = element.xml
  const kind = element.local
  if (edit.remove) {
    const frame = readDrawingGraphicFrame(element)
    if (frame) {
      const relId = frame.chartRelationshipId
      if (!relId) {
        throw new VisualEditError(
          'This graphic frame is not a chart — deleting it is not supported.',
        )
      }
      removedRelationships.push({ id: escapeXmlAttribute(relId), kind: 'chart' })
    } else {
      const blip = readDrawingPicture(element)?.blip
      for (const image of [blip, ...pictureExtensionBlips(blip)]) {
        for (const key of ['embed', 'link'] as const) {
          const id = drawingRelationshipAttribute(image, key)
          if (id) removedRelationships.push({ id: escapeXmlAttribute(id), kind: 'image' })
        }
      }
    }
    return null
  }
  let patched = edit.anchor ? moveVisualAnchor(element, edit.anchor, edit.anchorSize) : anchorXml
  // Re-applying the current paint rebuilds identical XML.
  if (edit.fillColor !== undefined || edit.lineColor !== undefined) {
    patched = repaintShape(patched, element, edit.fillColor, edit.lineColor)
  }
  if (edit.frameSize || edit.rotation !== undefined || edit.flipH !== undefined || edit.flipV !== undefined) {
    patched = updateFrameTransform(patched, element, edit)
  }
  if (edit.altText !== undefined || edit.hyperlink !== undefined) {
    patched = updateNonVisualProperties(patched, element, edit, hyperlinkRelId, droppedHyperlinkRelIds)
  }
  if (edit.editAs !== undefined) {
    if (kind !== 'twoCellAnchor') {
      throw new VisualEditError('Only two-cell anchors carry a placement mode.')
    }
    const open = /^<[^>]*>/.exec(patched)!
    const tag = setTagAttribute(open[0], 'editAs', edit.editAs === 'twoCell' ? null : edit.editAs)
    patched = tag + patched.slice(open[0].length)
  }
  return patched
}

function updateNonVisualProperties(
  xml: string,
  original: ScopedElement,
  edit: WorkbookVisualEdit,
  hyperlinkRelId: string | undefined,
  droppedHyperlinkRelIds: string[],
): string {
  const anchor = updatedAnchor(xml, original)
  const located = anchor && drawingNonVisualProperties(anchor)
  if (!located) throw new VisualEditError('Drawing anchor has no non-visual properties element.')
  const { node, start } = located
  const wasSelfClosing = node.opening.endsWith('/>')
  let opening = node.opening
  if (edit.altText !== undefined) {
    const description = edit.altText === '' ? null : edit.altText
    opening = node.attributes.has('descr')
      ? updateWorksheetTagAttribute(opening, 'descr', description === null ? null : escapeXmlAttribute(description))
      : setTagAttribute(opening, 'descr', description)
  }
  let inner = node.inner
  let removedClick = false
  if (edit.hyperlink !== undefined) {
    const click = drawingMainChild(node, 'hlinkClick')
    const oldId = drawingRelationshipAttribute(click, 'id')
    if (oldId) droppedHyperlinkRelIds.push(escapeXmlAttribute(oldId))
    let replacement = ''
    if (hyperlinkRelId !== undefined) {
      const strict = node.namespace?.startsWith('http://purl.oclc.org/ooxml/')
      const main = strict ? 'http://purl.oclc.org/ooxml/drawingml/main' : 'http://schemas.openxmlformats.org/drawingml/2006/main'
      const rels = hyperlinkRelationshipNamespace(node)
      replacement = `<a:hlinkClick xmlns:a="${main}" xmlns:r="${rels}" r:id="${escapeXmlAttribute(hyperlinkRelId)}"/>`
    }
    removedClick = click !== undefined && replacement === ''
    inner = click ? applyPatches(inner, [patchElement(click, replacement)]) : replacement + inner
  }
  let updated
  if (wasSelfClosing && inner === '') {
    updated = opening
  } else if (removedClick && inner === '') {
    updated = opening.slice(0, -1) + '/>'
  } else {
    if (wasSelfClosing) opening = opening.slice(0, -2) + '>'
    const close = wasSelfClosing ? `</${node.name}>` : node.xml.slice(node.opening.length + node.inner.length)
    updated = opening + inner + close
  }
  return xml.slice(0, start) + updated + xml.slice(start + node.xml.length)
}

function updatedAnchor(xml: string, original: ScopedElement): ScopedElement | undefined {
  if (xml === original.xml) return original
  const node = childElements(xml)[0]
  return node && withNamespaces(node, original.namespaces)
}

function updateFrameTransform(xml: string, original: ScopedElement, edit: WorkbookVisualEdit): string {
  // Moving or repainting can change the frame's offset in the anchor.
  const anchor = updatedAnchor(xml, original)
  const object = anchor && scopedChildren(anchor).find(
    (child) => isDrawingChild(anchor, child) && ['pic', 'sp', 'cxnSp', 'grpSp'].includes(child.local),
  )
  const properties = drawingChild(object, object?.local === 'grpSp' ? 'grpSpPr' : 'spPr')
  const transform = drawingMainChild(properties, 'xfrm')
  if (!anchor || !object || !properties || !transform) {
    throw new VisualEditError(edit.frameSize
      ? 'Drawing anchor has no frame extent — resizing it is not supported.'
      : 'Drawing anchor has no frame transform — rotating it is not supported.')
  }

  let opening = transform.opening
  if (edit.rotation !== undefined)
    opening = updateWorksheetTagAttribute(opening, 'rot', rotationAttribute(edit.rotation))
  if (edit.flipH !== undefined)
    opening = updateWorksheetTagAttribute(opening, 'flipH', edit.flipH ? '1' : null)
  if (edit.flipV !== undefined)
    opening = updateWorksheetTagAttribute(opening, 'flipV', edit.flipV ? '1' : null)

  let frame = transform.xml
  if (edit.frameSize) {
    // The anchor describes the rotated bounds. The extent records the
    // unrotated frame size used to reconstruct the visual on reload.
    const extent = drawingMainChild(transform, 'ext')
    if (!extent) {
      throw new VisualEditError('Drawing anchor has no frame extent — resizing it is not supported.')
    }
    frame = withBody(transform, applyPatches(transform.inner, [resizeExtent(extent, edit.frameSize)]))
  }
  const start = anchor.opening.length + object.start + object.opening.length +
    properties.start + properties.opening.length + transform.start
  return xml.slice(0, start) + opening + frame.slice(transform.opening.length) +
    xml.slice(start + transform.xml.length)
}

function resizeExtent(extent: ScopedElement, size: NonNullable<WorkbookVisualEdit['anchorSize']>): XmlPatch {
  const width = updateWorksheetTagAttribute(extent.opening, 'cx', String(size.width))
  const opening = updateWorksheetTagAttribute(width, 'cy', String(size.height))
  return patchElement(extent, opening + extent.xml.slice(extent.opening.length))
}

function moveVisualAnchor(
  element: ScopedElement,
  anchor: NonNullable<WorkbookVisualEdit['anchor']>,
  size: WorkbookVisualEdit['anchorSize'],
): string {
  if (element.local === 'absoluteAnchor') {
    throw new VisualEditError('This visual uses an absolute anchor — moving it is not supported.')
  }
  const markers = scopedChildren(element).filter((child) => isDrawingChild(element, child))
  const writes: XmlPatch[] = []
  for (const kind of ['from', 'to'] as const) {
    if (kind === 'to' && element.local !== 'twoCellAnchor') break
    const mark = markers.find((child) => child.local === kind)
    if (!mark)
      throw new VisualEditError(
        `Drawing anchor has no ${kind} marker — moving it is not supported.`,
      )
    const values =
      kind === 'from'
        ? [anchor.fromColumn, anchor.fromColumnOffset, anchor.fromRow, anchor.fromRowOffset]
        : [anchor.toColumn, anchor.toColumnOffset, anchor.toRow, anchor.toRowOffset]
    const names = ['col', 'colOff', 'row', 'rowOff']
    const fields = scopedChildren(mark).filter((child) => isDrawingChild(mark, child))
    const ordered = names.map((name) => fields.find((child) => child.local === name))
    const coordinates: XmlPatch[] = []
    const missing = new Map<number, string>()
    for (const [index, name] of names.entries()) {
      const value = String(values[index])
      const field = ordered[index]
      if (field) {
        coordinates.push(patchElement(field, withBody(field, value)))
      } else {
        const start = ordered.slice(index + 1).find(Boolean)?.start ?? mark.inner.length
        const tag = prefixOf(mark.name) + name
        missing.set(start, (missing.get(start) ?? '') + `<${tag}>${value}</${tag}>`)
      }
    }
    for (const [start, xml] of missing) coordinates.push({ start, length: 0, xml })
    writes.push(patchElement(mark, withBody(mark, applyPatches(mark.inner, coordinates))))
  }
  if (element.local === 'oneCellAnchor' && size) {
    const extent = markers.find((child) => child.local === 'ext')
    if (!extent) throw new VisualEditError('Drawing anchor has no extent.')
    writes.push(resizeExtent(extent, size))
  }
  return withBody(element, applyPatches(element.inner, writes))
}

const paintElements = new Set(['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'])

function paintMarkupNamespace(parent: ScopedElement, reference?: ScopedElement): [prefix: string, declaration: string] {
  if (reference) {
    const prefix = prefixOf(reference.name)
    if (parent.namespaces.get(prefix.slice(0, -1)) === reference.namespace) return [prefix, '']
  }
  for (const [prefix, namespace] of parent.namespaces) {
    if (isDrawingMainName('', namespace)) return [prefix ? prefix + ':' : '', '']
  }
  const namespace = reference?.namespace ?? (parent.namespace?.startsWith('http://purl.oclc.org/ooxml/')
    ? 'http://purl.oclc.org/ooxml/drawingml/main' : 'http://schemas.openxmlformats.org/drawingml/2006/main')
  return ['a:', ` xmlns:a="${namespace}"`]
}

function paintPatches(children: ScopedElement[], at: number, xml: string): XmlPatch[] {
  const fills = children.filter(node => paintElements.has(node.local))
  if (!fills.length) return [{ start: at, length: 0, xml }]
  return fills.map((fill, index) => patchElement(fill, index === 0 ? xml : ''))
}

/// Replaces only the shape's own fill and outline paint.
function repaintShape(
  xml: string,
  original: ScopedElement,
  fillColor: string | undefined,
  lineColor: string | undefined,
): string {
  const anchor = updatedAnchor(xml, original)
  const shape = drawingChild(anchor, 'sp')
  if (!anchor || !shape) throw new VisualEditError('Only standalone shapes can be repainted.')
  const properties = drawingChild(shape, 'spPr')
  if (!properties) throw new VisualEditError('Drawing shape has no spPr — repainting it is not supported.')

  const children = drawingMainChildren(properties)
  const fill = children.find(node => paintElements.has(node.local))
  const line = children.find(node => node.local === 'ln')
  const geometry = children.find(node => node.local === 'prstGeom' || node.local === 'custGeom') ??
    children.find(node => node.local === 'xfrm')
  const afterGeometry = geometry ? geometry.start + geometry.xml.length : 0
  const patches: XmlPatch[] = []
  if (lineColor !== undefined) {
    if (line) {
      const lineChildren = drawingMainChildren(line)
      const lineFill = lineChildren.find(node => paintElements.has(node.local))
      const newFill = solidFillXml(lineColor, ...paintMarkupNamespace(line, lineFill ?? line))
      patches.push(patchElement(line, withBody(line, applyPatches(line.inner, paintPatches(lineChildren, 0, newFill)))))
    } else {
      const newLine = outlineXml(lineColor, ...paintMarkupNamespace(properties, fill ?? geometry))
      patches.push({ start: fill ? fill.start + fill.xml.length : afterGeometry, length: 0, xml: newLine })
    }
  }
  if (fillColor !== undefined) {
    const newFill = solidFillXml(fillColor, ...paintMarkupNamespace(properties, fill ?? geometry ?? line))
    patches.push(...paintPatches(children, line?.start ?? afterGeometry, newFill))
  }
  const start = anchor.opening.length + shape.start + shape.opening.length + properties.start
  const updated = withBody(properties, applyPatches(properties.inner, patches))
  return xml.slice(0, start) + updated + xml.slice(start + properties.xml.length)
}
