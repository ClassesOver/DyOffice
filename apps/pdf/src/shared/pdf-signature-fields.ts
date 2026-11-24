import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib'
import type { PDFDocument, PDFObject } from 'pdf-lib'

export const lookupDict = (dict: PDFDict, key: string): PDFDict | undefined =>
  dict.lookupMaybe(PDFName.of(key), PDFDict)

export const lookupText = (dict: PDFDict, key: string): string | undefined => {
  const value = dict.lookup(PDFName.of(key))
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined
}

export interface FieldWithValue {
  name: string
  value: PDFDict
  widget: PDFDict
  widgetRef?: PDFRef
}

/** Every signature field that has a value, depth-first through the AcroForm tree */
export function collectSignatureFields(pdf: PDFDocument): FieldWithValue[] {
  const out: FieldWithValue[] = []
  const acroForm = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
  const fields = acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray)
  if (!fields) return out
  const seen = new Set<PDFDict>()

  const visit = (node: PDFObject, parentName: string, inheritedType: string | undefined) => {
    const dict = pdf.context.lookupMaybe(node, PDFDict)
    if (!dict || seen.has(dict)) return
    seen.add(dict)
    const partial = lookupText(dict, 'T')
    const name = partial ? (parentName ? `${parentName}.${partial}` : partial) : parentName
    const ft = dict.lookup(PDFName.of('FT'))
    const type = ft instanceof PDFName ? ft.decodeText() : inheritedType
    const value = lookupDict(dict, 'V')
    if (type === 'Sig' && value && value.has(PDFName.of('ByteRange'))) {
      out.push({ name, value, widget: dict, widgetRef: node instanceof PDFRef ? node : undefined })
    }
    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray)
    if (kids) for (const kid of kids.asArray()) visit(kid, name, type)
  }
  for (const field of fields.asArray()) visit(field, '', undefined)
  return out
}
