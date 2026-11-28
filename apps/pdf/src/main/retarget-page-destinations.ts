import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef } from 'pdf-lib'
import type { PDFDocument, PDFObject, PDFPage } from 'pdf-lib'
import { destinationTreeNodes } from '../shared/pdf-destination-tree'

const key = PDFName.of
type Rewrite = (entry: PDFObject | undefined) => PDFObject | undefined

function update(dict: PDFDict, field: PDFName, rewrite: Rewrite): void {
  const current = dict.get(field)
  const next = rewrite(current)
  if (next === current) return
  if (next) dict.set(field, next)
  else dict.delete(field)
}

function retargetGoTo(action: PDFDict, rewrite: Rewrite): PDFDict | undefined {
  if (action.lookup(key('S')) !== key('GoTo')) return action
  const field = key('D')
  const current = action.get(field)
  const next = rewrite(current)
  if (current === next) return action
  if (!next) return
  const updated = action.clone()
  updated.set(field, next)
  return updated
}

function rewriteDestinationTree(
  doc: PDFDocument,
  rewrite: Rewrite,
): void {
  const nodes = Array.from(destinationTreeNodes(doc))
  if (!nodes.length) return
  type Bounds = { first: PDFObject; last: PDFObject }
  const bounds = new Map<PDFDict, Bounds>()
  const removedNames = new Set<PDFDict>()

  for (const node of nodes.slice().reverse()) {
    const names = node.lookup(key('Names'))
    const kids = node.lookup(key('Kids'))
    let changed = false
    let current: Bounds | undefined

    if (names instanceof PDFArray) {
      for (let offset = names.size() - 2; offset >= 0; offset -= 2) {
        const value = names.get(offset + 1)
        const next = rewrite(value)
        if (next === value) continue
        if (next) names.set(offset + 1, next)
        else {
          names.remove(offset + 1)
          names.remove(offset)
          changed = true
        }
      }
      if (names.size() >= 2) current = { first: names.get(0), last: names.get(names.size() - 2) }
    }
    if (kids instanceof PDFArray) {
      const childBounds: Bounds[] = []
      for (let index = kids.size() - 1; index >= 0; index--) {
        const child = kids.lookup(index)
        if (!(child instanceof PDFDict)) continue
        const limit = bounds.get(child)
        if (removedNames.has(child)) {
          changed = true
          if (!limit) kids.remove(index)
        }
        if (limit) childBounds.push(limit)
      }
      if (childBounds.length) {
        current = { first: childBounds.at(-1)!.first, last: childBounds[0]!.last }
      }
    }

    if (current) bounds.set(node, current)
    if (!changed) continue
    removedNames.add(node)
    if (node.has(key('Limits'))) {
      if (current) node.set(key('Limits'), doc.context.obj([current.first, current.last]))
      else node.delete(key('Limits'))
    }
  }

  if (removedNames.has(nodes[0]!) && !bounds.has(nodes[0]!)) {
    const names = doc.catalog.lookup(key('Names'))
    if (names instanceof PDFDict) names.delete(key('Dests'))
  }
}

/** Preserve page identity across a change to the page tree. */
export function retargetPageDestinations(
  doc: PDFDocument,
  originalPages: PDFPage[],
  removedIndices: readonly number[],
  replacementPages: readonly PDFPage[] = [],
): void {
  const changes = new Map(removedIndices.map((originalIndex, index) => [
    originalPages[originalIndex]!.ref,
    replacementPages[index]?.ref,
  ]))
  const rewrite: Rewrite = raw => {
    const destination = doc.context.lookup(raw)
    if (!(destination instanceof PDFArray)) return raw
    const first = destination.get(0)
    const original = first instanceof PDFRef ? first
      : first instanceof PDFNumber ? originalPages[first.asNumber()]?.ref : undefined
    if (!original) return first instanceof PDFNumber ? undefined : raw
    const replacement = changes.has(original) ? changes.get(original) : original
    if (!replacement) return
    if (replacement === first) return raw
    const updated = destination.clone()
    updated.set(0, replacement)
    return updated
  }

  const retargetLinkOrBookmark = (entry: PDFDict) => {
    update(entry, key('Dest'), rewrite)
    update(entry, key('A'), raw => {
      const action = doc.context.lookup(raw)
      if (!(action instanceof PDFDict)) return raw
      const updated = retargetGoTo(action, rewrite)
      return updated === action ? raw : updated
    })
  }

  for (const page of originalPages) {
    if (changes.has(page.ref)) continue
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const entry = doc.context.lookup(ref)
      if (entry instanceof PDFDict && entry.lookup(key('Subtype')) === key('Link')) retargetLinkOrBookmark(entry)
    }
  }

  const root = doc.catalog.lookup(key('Outlines'))
  if (root instanceof PDFDict) {
    const pending = [root.lookup(key('First'))]
    const seen = new Set<PDFDict>()
    while (pending.length) {
      const entry = pending.pop()
      if (!(entry instanceof PDFDict) || seen.has(entry)) continue
      seen.add(entry)
      retargetLinkOrBookmark(entry)
      pending.push(entry.lookup(key('First')), entry.lookup(key('Next')))
    }
  }

  update(doc.catalog, key('OpenAction'), raw => {
    const action = doc.context.lookup(raw)
    if (!(action instanceof PDFDict)) return rewrite(raw)
    const updated = retargetGoTo(action, rewrite)
    return updated === action ? raw : updated
  })

  const rewriteNamed: Rewrite = raw => {
    const entry = doc.context.lookup(raw)
    if (!(entry instanceof PDFDict)) return rewrite(raw)
    const field = key('D')
    const current = entry.get(field)
    const next = rewrite(current)
    if (next === current) return raw
    if (!next) return
    const updated = entry.clone()
    updated.set(field, next)
    return updated
  }

  const legacy = doc.catalog.lookup(key('Dests'))
  if (legacy instanceof PDFDict) {
    for (const field of legacy.keys()) update(legacy, field, rewriteNamed)
  }
  rewriteDestinationTree(doc, rewriteNamed)
}
