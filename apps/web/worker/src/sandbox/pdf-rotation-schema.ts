import { DocumentContractError } from './document-profiles.ts'

function fail(): never { throw new DocumentContractError('INVALID_PDF_ROTATION_SCHEMA') }

export interface PdfRotationOperation {
  readonly page: number
  readonly degrees: number
}

/** Schema-only extraction from server/src/pdf/rotate.mjs at bf38ebad.
 * The real core accepts 1..100 operations, safe integer multiples of 90 degrees,
 * and only PDFs with 1..100 pages. Page <=100 is an early rejection derived from
 * that parsed-page budget; the old operation loop itself only checks page >=1.
 * No angle normalization, parser import, runtime dispatch or permission grant.
 * The old core permits 64MiB input; the candidate document profile permits 32MiB.
 * Neither byte limit is enforced here because this payload contains no bytes.
 * Actual page count, header, encryption, forms and signatures remain sandbox
 * parser checks. Output must use a separately verified sealed-artifact envelope.
 */
export function validatePdfRotationOperations(value: unknown): readonly PdfRotationOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100
    || Reflect.ownKeys(value).length !== value.length + 1) fail()
  const seen = new Set<number>()
  const snapshot: PdfRotationOperation[] = []
  for (let index = 0; index < value.length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))
    if (!item || !('value' in item) || !item.enumerable) fail()
    const operation: unknown = item.value
    if (!operation || typeof operation !== 'object'
      || ![Object.prototype, null].includes(Object.getPrototypeOf(operation))) fail()
    const keys = Reflect.ownKeys(operation)
    if (keys.length !== 2 || !keys.includes('page') || !keys.includes('degrees')) fail()
    const pageProperty = Object.getOwnPropertyDescriptor(operation, 'page')
    const angleProperty = Object.getOwnPropertyDescriptor(operation, 'degrees')
    if (!pageProperty || !angleProperty || !('value' in pageProperty) || !('value' in angleProperty)
      || !pageProperty.enumerable || !angleProperty.enumerable) fail()
    const page: unknown = pageProperty.value, degrees: unknown = angleProperty.value
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 100
      || typeof degrees !== 'number' || !Number.isSafeInteger(degrees) || degrees % 90 !== 0
      || seen.has(page)) fail()
    seen.add(page)
    snapshot.push(Object.freeze({ page, degrees }))
  }
  return Object.freeze(snapshot)
}
