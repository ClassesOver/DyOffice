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

export async function readStaticFormFills(bytes: Uint8Array): Promise<StaticFormFillRecord[]> {
  return staticFormFillsFromCatalog(await PDFDocument.load(bytes, { updateMetadata: false }))
}
