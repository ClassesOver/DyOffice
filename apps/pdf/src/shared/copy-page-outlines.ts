import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib'
import type { PDFDocument, PDFObject, PDFObjectCopier } from 'pdf-lib'
import type { copiedPageDestinationResolver } from './pdf-destination-tree'

const key = PDFName.of
const text = (value: PDFObject | undefined): value is PDFHexString | PDFString =>
  value instanceof PDFHexString || value instanceof PDFString

/** Rebuild links between outline entries without copying the source outline or its page tree. */
export function appendCopiedPageOutlines(
  target: PDFDocument,
  source: PDFDocument,
  resolve: ReturnType<typeof copiedPageDestinationResolver>,
  copier: PDFObjectCopier,
): void {
  const sourceRoot = source.catalog.lookup(key('Outlines'))
  if (!(sourceRoot instanceof PDFDict)) return
  const seen = new Set<PDFDict>()

  function copySiblings(first: PDFObject | undefined, parent: PDFRef, depth: number): { refs: PDFRef[]; visible: number } {
    const refs: PDFRef[] = []
    let visible = 0
    if (depth > 128) return { refs, visible }
    for (let entry = source.context.lookup(first); entry instanceof PDFDict && !seen.has(entry); entry = entry.lookup(key('Next'))) {
      seen.add(entry)
      const title = entry.lookup(key('Title'))
      if (!text(title)) continue
      const action = entry.lookup(key('A'))
      const type = action instanceof PDFDict ? action.lookup(key('S')) : undefined
      const destination = resolve(type === key('GoTo') && action instanceof PDFDict
        ? action.lookup(key('D')) : entry.lookup(key('Dest')))
      const uri = type === key('URI') && action instanceof PDFDict ? action.lookup(key('URI')) : undefined
      const ctx = target.context
      const item = ctx.obj({ Title: copier.copy(title), Parent: parent })
      const ref = ctx.nextRef()
      const children = copySiblings(entry.get(key('First')), ref, depth + 1)
      if (!destination && !text(uri) && !children.refs.length) continue

      if (destination) item.set(key('Dest'), copier.copy(destination))
      else if (text(uri)) {
        const external = ctx.obj({ S: 'URI', URI: copier.copy(uri) })
        if (action instanceof PDFDict && action.lookup(key('IsMap')) === PDFBool.True) external.set(key('IsMap'), PDFBool.True)
        item.set(key('A'), external)
      }
      const color = entry.lookup(key('C')), flags = entry.lookup(key('F'))
      if (color instanceof PDFArray && color.size() === 3 && color.asArray().every(value => value instanceof PDFNumber)) {
        item.set(key('C'), copier.copy(color))
      }
      if (flags instanceof PDFNumber) item.set(key('F'), flags)
      if (children.refs.length) {
        const previousCount = entry.lookup(key('Count'))
        const closed = previousCount instanceof PDFNumber && previousCount.asNumber() < 0
        item.set(key('First'), children.refs[0]!)
        item.set(key('Last'), children.refs.at(-1)!)
        item.set(key('Count'), PDFNumber.of(closed ? -children.visible : children.visible))
        if (!closed) visible += children.visible
      }
      const previous = refs.at(-1)
      if (previous) {
        target.context.lookup(previous, PDFDict).set(key('Next'), ref)
        item.set(key('Prev'), previous)
      }
      target.context.assign(ref, item)
      refs.push(ref)
      visible++
    }
    return { refs, visible }
  }

  const original = target.catalog.get(key('Outlines'))
  const existing = target.context.lookup(original)
  const root = existing instanceof PDFDict ? existing : target.context.obj({ Type: 'Outlines' })
  const rootRef = original instanceof PDFRef && root === existing ? original : target.context.nextRef()
  const { refs, visible } = copySiblings(sourceRoot.get(key('First')), rootRef, 0)
  if (!refs.length) return

  const visited = new Set<PDFDict>()
  let tail: PDFRef | undefined
  let count = 0
  for (let ref = root.get(key('First')); ref instanceof PDFRef;) {
    const entry = target.context.lookup(ref)
    if (!(entry instanceof PDFDict) || visited.has(entry)) break
    visited.add(entry)
    tail = ref
    const descendants = entry.lookup(key('Count'))
    count += 1 + (descendants instanceof PDFNumber ? Math.max(0, descendants.asNumber()) : 0)
    ref = entry.get(key('Next'))
  }
  if (tail) {
    target.context.lookup(tail, PDFDict).set(key('Next'), refs[0]!)
    target.context.lookup(refs[0]!, PDFDict).set(key('Prev'), tail)
  } else root.set(key('First'), refs[0]!)
  root.set(key('Last'), refs.at(-1)!)
  root.set(key('Count'), PDFNumber.of(count + visible))
  target.context.assign(rootRef, root)
  target.catalog.set(key('Outlines'), rootRef)
}
