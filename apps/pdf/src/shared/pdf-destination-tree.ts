import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib'
import type { PDFDocument, PDFObject, PDFPage } from 'pdf-lib'

/** Preorder traversal of the modern destination name tree, tolerant of cyclic PDFs. */
export function* destinationTreeNodes(doc: PDFDocument): Iterable<PDFDict> {
  const names = doc.catalog.lookup(PDFName.of('Names'))
  const root = names instanceof PDFDict ? names.lookup(PDFName.of('Dests')) : undefined
  if (!(root instanceof PDFDict)) return

  const pending = [root]
  const seen = new Set<PDFDict>()
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (seen.has(node)) continue
    seen.add(node)
    yield node

    const children = node.lookup(PDFName.of('Kids'))
    if (!(children instanceof PDFArray)) continue
    for (let index = children.size() - 1; index >= 0; index--) {
      const child = children.lookup(index)
      if (child instanceof PDFDict && !seen.has(child)) pending.push(child)
    }
  }
}

/** Resolve named and numeric local destinations to refs for pages in the copy. */
export function copiedPageDestinationResolver(source: PDFDocument, pages: PDFPage[]) {
  const key = PDFName.of
  const selected = new Set(pages.map(page => page.ref))
  const legacy = source.catalog.lookup(key('Dests'))
  const originals = source.getPages()
  let tree: Map<string, PDFArray> | undefined
  function namedDestinations(): Map<string, PDFArray> {
    const entries = new Map<string, PDFArray>()
    for (const node of destinationTreeNodes(source)) {
      const names = node.lookup(key('Names'))
      if (!(names instanceof PDFArray)) continue
      for (let index = 0; index + 1 < names.size(); index += 2) {
        const name = names.lookup(index), entry = names.lookup(index + 1)
        const destination = entry instanceof PDFDict ? entry.lookup(key('D')) : entry
        if ((name instanceof PDFString || name instanceof PDFHexString) && destination instanceof PDFArray) {
          entries.set(name.decodeText(), destination)
        }
      }
    }
    return entries
  }
  return (value: PDFObject | undefined): PDFArray | undefined => {
    let destination = value
    if (value instanceof PDFName && legacy instanceof PDFDict) {
      const entry = legacy.lookup(value)
      destination = entry instanceof PDFDict ? entry.lookup(key('D')) : entry
    } else if (value instanceof PDFString || value instanceof PDFHexString) {
      tree ??= namedDestinations()
      destination = tree.get(value.decodeText())
    }
    if (!(destination instanceof PDFArray)) return
    const page = destination.get(0)
    if (page instanceof PDFRef) return selected.has(page) ? destination : undefined
    if (!(page instanceof PDFNumber) || !Number.isInteger(page.asNumber())) return
    const ref = originals[page.asNumber()]?.ref
    if (!ref || !selected.has(ref)) return
    const explicit = destination.clone()
    explicit.set(0, ref)
    return explicit
  }
}
