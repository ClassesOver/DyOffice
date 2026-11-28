import type { DocumentTheme } from './preferences.ts'

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'
export type Principal = Readonly<{ userId: string; sessionId: string; deploymentId: string; roles: readonly string[]; scopes: readonly string[] }>
/** Stable job identity only; endpoint-specific status DTOs belong to T08. */
export type JobRef = Readonly<{ id: string }>
export type RevisionRef = Readonly<{ fileId: string; revision: string; sha256: string; size: number }>
export type SaveInput = Readonly<{ fileId: string; uploadId: string; baseRevision: string; idempotencyKey: string; leaseEpoch: number; wordVersion?: number; sourceCommandId?: string }>
export type OpenFileResult = Readonly<{ name?: string; pdfAutoNamePending?: true; autoNamePending?: true; officeSignatureProtected?: true; workbookPasswordProtected?: true; documentPasswordProtected?: true; file: RevisionRef; format: OfficeFormat; downloadEndpoint: string; capabilities: import('./host.ts').CapabilityCatalog }>
export type PublicSettings = Readonly<{ theme: 'light' | 'dark' | 'system'; documentTheme?: DocumentTheme; language: string; authorName?: string; autoSave?: boolean; showAssistant?: boolean }>

export function isRevisionRef(value: unknown): value is RevisionRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return typeof v.fileId === 'string' && v.fileId.length > 0 &&
    typeof v.revision === 'string' && v.revision.length > 0 &&
    typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(v.sha256) &&
    typeof v.size === 'number' && Number.isSafeInteger(v.size) && v.size >= 0
}

export function isSaveInput(value: unknown): value is SaveInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return ['fileId', 'uploadId', 'baseRevision', 'idempotencyKey'].every(k => typeof v[k] === 'string' && (v[k] as string).length > 0) &&
    typeof v.leaseEpoch === 'number' && Number.isSafeInteger(v.leaseEpoch) && v.leaseEpoch >= 0 &&
    (v.wordVersion === undefined || (typeof v.wordVersion === 'number' && Number.isSafeInteger(v.wordVersion) && v.wordVersion >= 0)) &&
    (v.sourceCommandId === undefined || (typeof v.sourceCommandId === 'string' && v.sourceCommandId.length > 0))
}
