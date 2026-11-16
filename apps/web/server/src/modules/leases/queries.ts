import type { PoolClient } from 'pg'
import type { BusinessPrincipal } from '../../db/context.ts'
import { scope } from '../files/queries.ts'
import { authError } from '../auth/sessions.ts'

export type LeaseRow = { file_id: string; session_id: string; auth_version: number; editor_id: string; lease_epoch: string; expires_at: Date; job_id: string | null; job_epoch: string | null }
export function leaseEpoch(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw authError(400)
  return value
}
export async function lockLease(connection: PoolClient, principal: BusinessPrincipal, fileId: string) {
  return (await connection.query<LeaseRow>('SELECT * FROM edit_leases WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 FOR UPDATE', [...scope(principal),fileId])).rows[0]
}
export async function databaseTime(connection: PoolClient): Promise<Date> { return (await connection.query('SELECT clock_timestamp() AS now')).rows[0].now }
export async function assertLiveLease(connection: PoolClient, principal: BusinessPrincipal, fileId: string, epoch: number, editorId: string) {
  if (principal.job && editorId!==principal.job.id) throw authError(404)
  const row = await lockLease(connection,principal,fileId), now = await databaseTime(connection)
  if (principal.job ? row?.job_id!==principal.job.id || Number(row?.job_epoch)!==principal.job.epoch : row?.job_id!=null) throw authError(404)
  if (!row || Number(row.lease_epoch) !== epoch || row.editor_id !== editorId || row.session_id !== principal.sessionId || row.auth_version !== principal.authVersion || row.expires_at <= now) throw authError(409)
  return row
}
