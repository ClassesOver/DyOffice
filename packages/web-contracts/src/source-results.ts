import type { QueryCell, QueryColumn } from './sources.ts'

/** Maximum UTF-8 size of one canonical frozen snapshot, including its SHA-256. */
export const SOURCE_RESULT_MAX_BYTES = 4_000_000

/** Small, frozen JSONB evidence in a personal workspace; never an Office file.
 * A saved result remains readable by its owner after source disable/deletion.
 * Pending evidence is session-bound and expires; it is not an access capability.
 */
export interface WorkspaceSourceResultArtifact {
  resultId: string
  workspaceId: string
  sourceId: string
  sourceVersion: number
  /** SHA-256 only: never raw SQL, a DSN, or a connector credential. */
  queryHash: string
  /** createQuerySnapshot evidence hash, excluding the snapshot's sha256 field. */
  sha256: string
  rowCount: number
  truncated: boolean
  /** UTF-8 bytes of canonical snapshot JSON including its sha256 field. */
  sizeBytes: number
  state: 'pending' | 'saved'
  name: string | null
  createdAt: string
  savedAt: string | null
  expiresAt: string | null
}

export type WorkspaceSourceResultCapture = WorkspaceSourceResultArtifact & {
  state: 'pending'
  name: null
  savedAt: null
  expiresAt: string
}

export interface SaveWorkspaceSourceResultRequest {
  resultId: string
  name: string
  /** Reuse this UUID for retries. One immutable save command per result. */
  commandId: string
}

export interface ListWorkspaceSourceResultsRequest { limit?: number; after?: string }
export interface WorkspaceSourceResultList { items: WorkspaceSourceResultArtifact[]; nextCursor: string | null }
export interface ReadWorkspaceSourceResultRequest { resultId: string; offset?: number; limit?: number }
export interface WorkspaceSourceResultPage {
  artifact: WorkspaceSourceResultArtifact
  schema: readonly QueryColumn[]
  timezone: string
  rows: readonly Readonly<Record<string, QueryCell>>[]
  offset: number
  nextOffset: number | null
  totalRows: number
  sourceTruncated: boolean
  sha256: string
}

export interface WorkspaceSourceResultDownload {
  name: string
  /** Canonical snapshot JSON, not CSV; formula-like strings remain JSON literals. */
  bytes: Uint8Array
  sha256: string
}
