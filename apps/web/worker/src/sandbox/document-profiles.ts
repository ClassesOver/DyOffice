/** Experimental contract metadata only. Not a runtime admission certificate. */
export type DocumentFormat = 'xlsx' | 'pptx' | 'docx' | 'pdf'
export type ProfileId = `${DocumentFormat}-edit-v1`
export type DocumentOperation = 'parse' | 'edit' | 'export' | 'validate'
export class DocumentContractError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'DocumentContractError'; this.code = code }
}
export interface DocumentProfile {
  readonly id: ProfileId
  readonly format: DocumentFormat
  readonly policyVersion: 1
  readonly productionEnabled: false
  readonly network: 'deny'
  readonly inputBytes: number
  readonly outputBytes: number
  readonly wallMs: number
  readonly operations: readonly DocumentOperation[]
  readonly activeContent: 'never-execute'
}
const profiles: readonly DocumentProfile[] = Object.freeze(
  (['xlsx', 'pptx', 'docx', 'pdf'] as const).map(format => Object.freeze({
    id: `${format}-edit-v1` as ProfileId, format, policyVersion: 1 as const,
    productionEnabled: false as const, network: 'deny' as const,
    inputBytes: 32 * 1024 * 1024, outputBytes: 32 * 1024 * 1024, wallMs: 30_000,
    operations: Object.freeze(['parse', 'edit', 'export', 'validate'] as const),
    activeContent: 'never-execute' as const,
  })),
)
export function getDocumentProfile(id: unknown): DocumentProfile {
  const profile = profiles.find(value => value.id === id)
  if (!profile) throw new DocumentContractError('DOCUMENT_PROFILE_UNSUPPORTED')
  return profile
}
/** High-level classification only; NOT an engine command/payload validator. */
export function validateDocumentOperation(profileId: unknown, operation: unknown): DocumentOperation {
  const profile = getDocumentProfile(profileId)
  if (typeof operation !== 'string' || !profile.operations.includes(operation as DocumentOperation)) {
    throw new DocumentContractError('DOCUMENT_OPERATION_UNSUPPORTED')
  }
  return operation as DocumentOperation
}
