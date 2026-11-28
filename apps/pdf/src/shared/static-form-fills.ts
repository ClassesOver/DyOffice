import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib'
import type { StaticFormFillRecord } from './ipc'

export const STATIC_FORM_FILLS_KEY = PDFName.of('GenOfficeStaticFormFills')

function validStaticFormFill(value: unknown): value is StaticFormFillRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<StaticFormFillRecord>
  return (
    typeof record.id === 'string' && record.id.length > 0 &&
    (record.kind === 'text' || record.kind === 'check' || record.kind === 'cross') &&
    Number.isSafeInteger(record.pageIndex) && record.pageIndex! >= 0 &&
    Array.isArray(record.rect) && record.rect.length === 4 &&
    record.rect.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) &&
    (record.text === undefined || typeof record.text === 'string') &&
    (record.fontSize === undefined || Number.isFinite(record.fontSize)) &&
    (record.color === undefined || typeof record.color === 'string') &&
    (record.align === undefined || ['left', 'center', 'right'].includes(record.align))
  )
}

export function staticFormFillsFromCatalog(doc: PDFDocument): StaticFormFillRecord[] {
  const value = doc.catalog.get(STATIC_FORM_FILLS_KEY)
  if (!(value instanceof PDFHexString)) return []
  try {
    const parsed: unknown = JSON.parse(value.decodeText())
    return Array.isArray(parsed) ? parsed.filter(validStaticFormFill) : []
  } catch {
    return []
  }
}

/** Null slots represent pages with no records from this source. */
export function remapStaticFormFills(
  doc: PDFDocument,
  order: readonly (number | null)[],
  start = 0,
): StaticFormFillRecord[] {
  const byPage = new Map<number, StaticFormFillRecord[]>()
  for (const fill of staticFormFillsFromCatalog(doc)) {
    const fills = byPage.get(fill.pageIndex)
    if (fills) fills.push(fill)
    else byPage.set(fill.pageIndex, [fill])
  }
  return order.flatMap((original, index) => (
    original === null ? [] : (byPage.get(original) ?? []).map(fill => ({ ...fill, pageIndex: start + index }))
  ))
}

export function writeStaticFormFills(doc: PDFDocument, fills: readonly StaticFormFillRecord[]): void {
  if (!fills.length) {
    doc.catalog.delete(STATIC_FORM_FILLS_KEY)
    return
  }
  // Copying a page twice or combining two versions can repeat a fill identity.
  const reserved = new Set(fills.map(fill => fill.id))
  const used = new Set<string>()
  let next = 0
  const records = fills.map(fill => {
    if (!used.has(fill.id)) {
      used.add(fill.id)
      return fill
    }
    let id: string
    do { id = `static-fill-${++next}` } while (reserved.has(id))
    return { ...fill, id }
  })
  doc.catalog.set(STATIC_FORM_FILLS_KEY, PDFHexString.fromText(JSON.stringify(records)))
}

export async function readStaticFormFills(bytes: Uint8Array): Promise<StaticFormFillRecord[]> {
  return staticFormFillsFromCatalog(await PDFDocument.load(bytes, { updateMetadata: false }))
}
