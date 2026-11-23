import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions, FileCredential } from '../../db/context.ts'
import { authorize } from '../policy/authorize.ts'
import { authError } from '../auth/sessions.ts'
import { UNSUPPORTED_CAPABILITIES } from '../../../../../../packages/web-contracts/src/host.ts'
import type { OfficeFormat, OpenFileResult } from '../../../../../../packages/web-contracts/src/api.ts'
export type Upload = { id: string; file_id: string; revision_id: string; workspace_id: string; name: string; format: OfficeFormat; expected_size: number; auth_version: number; state: string; sha256: string | null; attempt_id: string | null; expires_at: Date; kind: 'import' | 'revision'; base_revision: string | null; lease_epoch: string | null; editor_id: string | null; session_id: string | null; restored_from: string | null; job_id: string | null; job_epoch: string | null; pdf_auto_name: string | null; auto_name_pending:boolean; office_signature_protected: boolean | null }
export type FileRow = { id: string; workspace_id: string; name: string; format: OfficeFormat; current_revision: string; deleted_at: Date | null; created_at: Date; updated_at: Date; object_key: string; sha256: string; size: number; pdf_auto_name_pending: boolean; auto_name_pending:boolean; office_signature_protected: boolean | null }
export const uuid = (id: string) => { if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw authError(400); return id.toLowerCase() }
export const scope = (p: BusinessPrincipal) => [p.deploymentId,p.userId]
export const objectKey = (p: BusinessPrincipal, revisionId: string) => `${p.deploymentId}/${p.userId}/objects/${revisionId}`
export const openResult = (row: FileRow): OpenFileResult => ({ name: row.name, ...(row.auto_name_pending?{autoNamePending:true as const}:{}), ...(row.pdf_auto_name_pending?{pdfAutoNamePending:true as const}:{}), file: { fileId: row.id, revision: row.current_revision, sha256: row.sha256, size: row.size }, format: row.format,
  downloadEndpoint: `/api/v1/files/${row.id}/content?revision=${row.current_revision}`, capabilities: UNSUPPORTED_CAPABILITIES })
export const fileDto = (row: FileRow) => ({ id: row.id, name: row.name, format: row.format, revision: row.current_revision, size: row.size, sha256: row.sha256, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), deletedAt: row.deleted_at?.toISOString() ?? null })


export function runFileTransaction<T>(transactions: PrincipalTransactions, token: FileCredential, action: 'files:read' | 'files:write', fn: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>) {
  return transactions.withPrincipalTransaction(typeof token==='string' ? { kind: 'session',token } : token, async (connection, principal) => {
    authorize(principal, action, { deploymentId: principal.deploymentId, ownerId: principal.userId })
    return fn(connection, principal)
  })
}
export async function lockAccount(connection: PoolClient, principal: BusinessPrincipal) {
  const values = scope(principal)
  const workspace = (await connection.query('SELECT id FROM workspaces WHERE deployment_id=$1 AND owner_id=$2', values)).rows[0]
  if (!workspace) throw authError(404)
  await connection.query('INSERT INTO storage_accounts(deployment_id,owner_id,workspace_id) VALUES($1,$2,$3) ON CONFLICT(deployment_id,owner_id) DO NOTHING', [...values,workspace.id])
  await connection.query('SELECT 1 FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2 FOR UPDATE', values)
  // One cutoff per cleanup statement makes the expiry index usable. Rows that
  // expire later remain reserved until the next sweep; final authority/upload
  // deadline checks still use wall-clock time. Do not use transaction start time.
  const expired = await connection.query("WITH candidates AS (SELECT id,expected_size,state FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND state IN ('staged','receiving','ready') AND expires_at<=statement_timestamp() ORDER BY id FOR UPDATE) UPDATE uploads u SET state='expired' FROM candidates c WHERE u.deployment_id=$1 AND u.owner_id=$2 AND u.id=c.id RETURNING c.expected_size,c.state AS previous_state", values)
  if (expired.rowCount) await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes-$3,stored_bytes=stored_bytes+$4 WHERE deployment_id=$1 AND owner_id=$2', [...values,expired.rows.reduce((sum, row) => sum + row.expected_size, 0),expired.rows.filter(row => row.previous_state !== 'staged').reduce((sum, row) => sum + row.expected_size, 0)])
  const row = (await connection.query('SELECT * FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2', values)).rows[0]
  return { workspaceId: workspace.id as string, reservedBytes: Number(row.reserved_bytes), storedBytes: Number(row.stored_bytes) }
}
export async function lockUpload(connection: PoolClient, principal: BusinessPrincipal, id: string, requireUnexpired = false) {
  const row = (await connection.query<Upload>('SELECT * FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE', [...scope(principal),id])).rows[0]
  if (!row) throw authError(404)
  if (principal.job ? row.job_id!==principal.job.id || Number(row.job_epoch)!==principal.job.epoch : row.job_id!==null) throw authError(404)
  // Read database time after the row lock; time evaluated before a wait is not authority.
  const now = (await connection.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
  if ((requireUnexpired || row.state !== 'committed') && (row.expires_at <= now || row.state === 'expired')) throw authError(410)
  if (row.auth_version !== principal.authVersion || (row.kind === 'revision' && row.session_id !== principal.sessionId)) throw authError(409)
  return row
}
export async function loadFile(connection: PoolClient, principal: BusinessPrincipal, id: string, includeTrash = false, lock = 'SHARE') {
  if (principal.job && (id!==principal.job.fileId || includeTrash)) throw authError(404)
  if (principal.mcpRead && (id !== principal.mcpRead.fileId || includeTrash)) throw authError(404)
  // Lock the owner-scoped file before joining its head revision. A single
  // locking join can follow a concurrently updated file via EvalPlanQual while
  // its statement snapshot cannot see that transaction's newly inserted revision.
  // A fresh statement after the lock sees the matching committed revision.
  const locked = await connection.query(`SELECT id FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND purge_started_at IS NULL ${includeTrash ? '' : 'AND deleted_at IS NULL'} FOR ${lock}`, [...scope(principal),id])
  if (!locked.rowCount) throw authError(404)
  const row = (await connection.query<FileRow>(`SELECT f.*,r.object_key,r.sha256,r.size,r.office_signature_protected FROM files f JOIN file_revisions r ON r.deployment_id=f.deployment_id AND r.owner_id=f.owner_id AND r.file_id=f.id AND r.id=f.current_revision WHERE f.deployment_id=$1 AND f.owner_id=$2 AND f.id=$3 AND f.purge_started_at IS NULL ${includeTrash ? '' : 'AND f.deleted_at IS NULL'} FOR ${lock} OF f`, [...scope(principal),id])).rows[0]
  if (!row) throw authError(404)
  return row
}
export async function releaseReservation(connection: PoolClient, principal: BusinessPrincipal, upload: Upload, state: 'cancelled') {
  await connection.query('UPDATE uploads SET state=$4 WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),upload.id,state])
  await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes-$3,stored_bytes=stored_bytes+$4 WHERE deployment_id=$1 AND owner_id=$2', [...scope(principal),upload.expected_size,upload.state === 'ready' ? upload.expected_size : 0])
}
