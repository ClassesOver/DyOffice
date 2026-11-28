import { AcroButtonFlags, PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib'
import type { PDFDocument, PDFObject, PDFPage, PDFRef } from 'pdf-lib'

const key = PDFName.of
const unsupported = () => Object.assign(new Error('Unsupported PDF field tree'), { code: 'PDF_EDIT_UNSUPPORTED_STRUCTURE' })

export function setTemporaryPdfEntry(
  dict: PDFDict,
  name: PDFName,
  next: PDFObject | undefined,
  restore: (() => void)[],
): void {
  const previous = dict.get(name)
  if (previous === next) return
  restore.push(() => {
    if (previous) dict.set(name, previous)
    else dict.delete(name)
  })
  if (next) dict.set(name, next)
  else dict.delete(name)
}

function inherited(field: PDFDict, name: PDFName): PDFObject | undefined {
  const value = field.lookup(name)
  if (value !== undefined) return value
  const parent = field.lookup(key('Parent'))
  return parent instanceof PDFDict ? inherited(parent, name) : undefined
}

function subsetButtonValues(
  field: PDFDict, children: PDFObject[], selected: PDFObject[], restore: (() => void)[],
): void {
  if (inherited(field, key('FT')) !== key('Btn')) return
  const flags = inherited(field, key('Ff'))
  const fieldFlags = flags instanceof PDFNumber ? flags.asNumber() : 0
  if (fieldFlags & AcroButtonFlags.PushButton) return
  const all = children.map(raw => field.context.lookup(raw))
  if (!all.every(widget => widget instanceof PDFDict)) throw unsupported()
  if (!all.every(widget => widget.lookup(key('Subtype')) === key('Widget') && !widget.has(key('T')))) return

  const kept = new Set(selected)
  const opt = inherited(field, key('Opt'))
  if (opt !== undefined) {
    if (!(opt instanceof PDFArray) || opt.size() !== all.length || !opt.asArray().every(raw => {
      const value = field.context.lookup(raw)
      return value instanceof PDFString || value instanceof PDFHexString
    })) throw unsupported()
    // Export values and widget references are parallel arrays in a button field.
    setTemporaryPdfEntry(field, key('Opt'), field.context.obj(opt.asArray().filter((_, i) => kept.has(children[i]!))), restore)
  }

  const off = key('Off')
  const appearances = all.map(widget => {
    const ap = widget.lookup(key('AP'))
    const normal = ap instanceof PDFDict ? ap.lookup(key('N')) : undefined
    return normal instanceof PDFDict ? normal : undefined
  })
  for (const name of [key('V'), key('DV')]) {
    const value = inherited(field, name)
    if (!(value instanceof PDFName) || value === off) continue
    const matching = appearances.flatMap((appearance, i) => appearance?.has(value) ? [i] : [])
    const active = name === key('V') ? matching.filter(i => all[i]!.lookup(key('AS')) === value) : []
    if ((active.length ? active : matching).some(i => kept.has(children[i]!))) continue
    if (appearances.some((appearance, i) => !appearance && kept.has(children[i]!))) continue
    setTemporaryPdfEntry(field, name, off, restore)
  }
}

/** Prune the field tree before copying widget references, which also reach their parents. */
export function selectPageForm(
  source: PDFDocument,
  pages: PDFPage[],
  restore: (() => void)[],
  keepAll: boolean,
): PDFDict | undefined {
  const widgets = new Map<PDFDict, PDFRef>()
  for (const page of pages) {
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const annotation = source.context.lookup(ref)
      if (!(annotation instanceof PDFDict) || annotation.lookup(key('Subtype')) !== key('Widget')) continue
      if (widgets.has(annotation)) throw unsupported()
      widgets.set(annotation, page.ref)
    }
  }

  const form = source.catalog.lookup(key('AcroForm'))
  if (form === undefined && widgets.size === 0) return
  if (!(form instanceof PDFDict) || form.has(key('XFA'))) throw unsupported()
  const fields = form.lookup(key('Fields'))
  if (!(fields instanceof PDFArray)) throw unsupported()

  const visited = new Set<PDFDict>()
  const retained = new Set<PDFDict>()
  function keep(raw: PDFObject, parent: PDFDict | undefined, depth: number): boolean {
    const field = source.context.lookup(raw)
    if (depth > 64 || !(field instanceof PDFDict) || visited.has(field) ||
      field.lookup(key('Parent')) !== parent) throw unsupported()
    visited.add(field)
    if (field.lookup(key('FT')) === key('Sig')) {
      throw Object.assign(new Error('PDF signature fields cannot be copied'), { code: 'SIGNATURE_EDIT_REFUSED' })
    }

    if (field.lookup(key('Subtype')) === key('Widget')) {
      if (field.has(key('Kids'))) throw unsupported()
      const page = widgets.get(field)
      if (keepAll) {
        const declared = field.get(key('P'))
        if (!page || (declared !== undefined && declared !== page)) throw unsupported()
      } else {
        if (!page) return false
        setTemporaryPdfEntry(field, key('P'), page, restore)
      }
    } else {
      const kids = field.lookup(key('Kids'))
      if (kids === undefined) return keepAll
      if (!(kids instanceof PDFArray)) throw unsupported()
      const children = kids.asArray()
      const selected = children.filter(child => keep(child, field, depth + 1))
      if (selected.length === 0 && !keepAll) return false
      if (selected.length !== kids.size()) {
        subsetButtonValues(field, children, selected, restore)
        setTemporaryPdfEntry(field, key('Kids'), source.context.obj(selected), restore)
      }
    }
    retained.add(field)
    return true
  }

  const roots = fields.asArray().filter(field => keep(field, undefined, 0))
  for (const widget of widgets.keys()) if (!retained.has(widget)) throw unsupported()
  if (keepAll) return form
  if (roots.length === 0) return

  const subset = form.clone()
  subset.set(key('Fields'), source.context.obj(roots))
  const order = form.lookup(key('CO'))
  if (order !== undefined) {
    if (!(order instanceof PDFArray)) throw unsupported()
    const selected = order.asArray().filter(ref => {
      const field = source.context.lookup(ref)
      return field instanceof PDFDict && retained.has(field)
    })
    if (selected.length) subset.set(key('CO'), source.context.obj(selected))
    else subset.delete(key('CO'))
  }
  return subset
}
