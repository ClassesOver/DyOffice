import { PDFArray, PDFDict, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import type { PDFDocument, PDFObject, PDFObjectCopier } from 'pdf-lib'

type FileName = PDFHexString | PDFString
type Attachment = { name: FileName; file: PDFObject }
const key = PDFName.of
const malformed = () => new Error('The PDF embedded-file name tree is invalid.')

function dictionary(value: PDFObject | undefined): PDFDict | undefined {
  if (value === undefined || value instanceof PDFDict) return value
  throw malformed()
}

function readTree(doc: PDFDocument, root: PDFDict | undefined): Map<string, Attachment> {
  const entries = new Map<string, Attachment>()
  const pending = root ? [root] : []
  const seen = new Set<PDFDict>()
  while (pending.length) {
    const node = pending.pop()!
    if (seen.has(node)) throw malformed()
    seen.add(node)
    const children = node.lookup(key('Kids'))
    if (children !== undefined) {
      if (!(children instanceof PDFArray)) throw malformed()
      for (const ref of children.asArray()) {
        const child = dictionary(doc.context.lookup(ref))
        if (!child) throw malformed()
        pending.push(child)
      }
    }
    const names = node.lookup(key('Names'))
    if (names === undefined) continue
    if (!(names instanceof PDFArray) || names.size() % 2) throw malformed()
    for (let i = 0; i < names.size(); i += 2) {
      const name = names.lookup(i), file = names.get(i + 1)
      if (!(name instanceof PDFHexString || name instanceof PDFString) || !(doc.context.lookup(file) instanceof PDFDict)) {
        throw malformed()
      }
      const label = name.decodeText()
      if (entries.has(label)) throw malformed()
      entries.set(label, { name, file })
    }
  }
  return entries
}

function uniqueLabel(label: string, reserved: Set<string>): string {
  const extension = label.lastIndexOf('.')
  const stem = extension > 0 ? label.slice(0, extension) : label
  const suffix = extension > 0 ? label.slice(extension) : ''
  let index = 2
  while (reserved.has(`${stem} (${index})${suffix}`)) index++
  return `${stem} (${index})${suffix}`
}

/** Copy document attachments for whole-file merges, retaining the compressed file streams. */
export function appendPdfAttachments(target: PDFDocument, source: PDFDocument, copier: PDFObjectCopier): void {
  const sourceNames = dictionary(source.catalog.lookup(key('Names')))
  const incoming = readTree(source, dictionary(sourceNames?.lookup(key('EmbeddedFiles'))))
  if (!incoming.size) return

  const existingNames = dictionary(target.catalog.lookup(key('Names')))
  const targetNames = existingNames ?? target.context.obj({})
  const current = readTree(target, dictionary(targetNames.lookup(key('EmbeddedFiles'))))
  const reserved = new Set([...current.keys(), ...incoming.keys()])
  for (const [label, entry] of incoming) {
    const file = copier.copy(entry.file)
    if (!current.has(label)) {
      current.set(label, { name: copier.copy(entry.name), file })
      continue
    }
    const alias = uniqueLabel(label, reserved)
    const name = PDFHexString.fromText(alias)
    const filespec = target.context.lookup(file, PDFDict).clone()
    filespec.set(key('F'), name)
    filespec.set(key('UF'), name)
    current.set(alias, { name, file: target.context.register(filespec) })
    reserved.add(alias)
  }

  // Name tree keys are ordered by the actual PDF string bytes, including any encoding marker.
  const ordered = [...current.values()].map(entry => ({ ...entry, bytes: entry.name.asBytes() }))
  ordered.sort(({ bytes: left }, { bytes: right }) => {
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      if (left[i] !== right[i]) return left[i]! - right[i]!
    }
    return left.length - right.length
  })
  const names = target.context.obj(ordered.flatMap(entry => [entry.name, entry.file]))
  targetNames.set(key('EmbeddedFiles'), target.context.register(target.context.obj({ Names: names })))
  if (!existingNames) target.catalog.set(key('Names'), target.context.register(targetNames))
}
