import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib'

type PageLabel = { style?: string; prefix: string; number: number }
const pageLabelsKey = PDFName.of('PageLabels')
const numberingStyles = new Set(['D', 'r', 'R', 'a', 'A'])

/** Undefined entries use the ordinary one-based page number in the output. */
export function readPageLabels(doc: PDFDocument): (PageLabel | undefined)[] {
  const labels = new Array<PageLabel | undefined>(doc.getPageCount()).fill(undefined)
  const root = doc.catalog.lookup(pageLabelsKey)
  if (!(root instanceof PDFDict)) return labels

  const ranges = new Map<number, PageLabel>()
  const pending = [root]
  const visited = new Set<PDFDict>()
  while (pending.length) {
    const node = pending.pop()!
    if (visited.has(node)) continue
    visited.add(node)
    const children = node.lookup(PDFName.of('Kids'))
    if (children instanceof PDFArray) {
      for (let i = 0; i < children.size(); i++) {
        const child = children.lookup(i)
        if (child instanceof PDFDict) pending.push(child)
      }
    }
    const entries = node.lookup(PDFName.of('Nums'))
    if (!(entries instanceof PDFArray)) continue
    for (let i = 0; i + 1 < entries.size(); i += 2) {
      const key = entries.lookup(i)
      const value = entries.lookup(i + 1)
      if (!(key instanceof PDFNumber) || !(value instanceof PDFDict)) continue
      const index = key.asNumber()
      if (!Number.isInteger(index) || index < 0 || index >= labels.length) continue
      const styleName = value.lookup(PDFName.of('S'))
      const style = styleName instanceof PDFName ? styleName.decodeText() : undefined
      if (style !== undefined && !numberingStyles.has(style)) continue
      const text = value.lookup(PDFName.of('P'))
      const prefix = text instanceof PDFString || text instanceof PDFHexString ? text.decodeText() : ''
      const start = value.lookup(PDFName.of('St'))
      const number = start instanceof PDFNumber ? start.asNumber() : 1
      ranges.set(index, { style, prefix, number: Number.isSafeInteger(number) && number >= 1 ? number : 1 })
    }
  }

  let current: PageLabel | undefined
  let start = 0
  for (let i = 0; i < labels.length; i++) {
    const range = ranges.get(i)
    if (range) {
      current = range
      start = i
    }
    if (!current) continue
    const number = current.style ? current.number + i - start : 1
    if (current.style === 'D' && !current.prefix && number === i + 1) continue
    labels[i] = { ...current, number }
  }
  return labels
}

export function writePageLabels(doc: PDFDocument, labels: (PageLabel | undefined)[]): void {
  if (!labels.some(label => label !== undefined)) {
    doc.catalog.delete(pageLabelsKey)
    return
  }

  const entries = doc.context.obj([])
  let previous: PageLabel | undefined
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i] ?? { style: 'D', prefix: '', number: i + 1 }
    const continues = previous && label.style === previous.style && label.prefix === previous.prefix &&
      (!label.style || label.number === previous.number + 1)
    if (!continues) {
      const entry = doc.context.obj({})
      if (label.style) {
        entry.set(PDFName.of('S'), PDFName.of(label.style))
        if (label.number !== 1) entry.set(PDFName.of('St'), PDFNumber.of(label.number))
      }
      if (label.prefix) entry.set(PDFName.of('P'), PDFHexString.fromText(label.prefix))
      entries.push(PDFNumber.of(i))
      entries.push(entry)
    }
    previous = label
  }
  doc.catalog.set(pageLabelsKey, doc.context.obj({ Nums: entries }))
}
