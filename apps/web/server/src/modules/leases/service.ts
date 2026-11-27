import type { PrincipalTransactions, FileCredential } from '../../db/context.ts'
import type { BusinessPrincipal } from '../../db/context.ts'
import { uuid, scope, loadFile, runFileTransaction, type FileRow } from '../files/queries.ts'
import { assertLiveLease, lockLease, databaseTime, leaseEpoch, type LeaseRow } from './queries.ts'
import { authError } from '../auth/sessions.ts'

const dto = (row: LeaseRow) => ({ leaseEpoch: Number(row.lease_epoch), editorId: row.editor_id, expiresAt: row.expires_at.toISOString() })
const shape = (value: object, fields: string[]) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw authError(400) }
const nextEpoch = (epoch: number) => { if (!Number.isSafeInteger(epoch + 1)) throw authError(409); return epoch + 1 }
export function createLeaseService({ transactions, ttlMs = 45_000, assertOfficeWritable }: { transactions: PrincipalTransactions; ttlMs?: number; assertOfficeWritable?: (file:FileRow)=>Promise<void> }) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new Error('Invalid lease lifetime')
  const run = <T>(token: FileCredential, fileId: string, operation: (connection: import('pg').PoolClient, principal: BusinessPrincipal) => Promise<T>, edit = false) => runFileTransaction(transactions,token,'files:write',async (connection, principal) => {
    const file=await loadFile(connection,principal,fileId,false,'UPDATE')
    if(edit)await assertOfficeWritable?.(file)
    return operation(connection,principal)
  })
  const editorAuthority = (p: BusinessPrincipal,id: string) => { if ((p.job && id!==p.job.id) || (p.dshEdit && id!==p.dshEdit.editorId)) throw authError(404) }
  async function install(connection: import('pg').PoolClient, principal: BusinessPrincipal, fileId: string, editorId: string, epoch: number) {
    const row = (await connection.query<LeaseRow>("INSERT INTO edit_leases(deployment_id,owner_id,file_id,session_id,auth_version,editor_id,lease_epoch,job_id,job_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$9,$10,LEAST(COALESCE((SELECT lease_until FROM native_jobs WHERE id=$9),'infinity'::timestamptz),clock_timestamp()+$8*interval '1 millisecond')) ON CONFLICT(deployment_id,owner_id,file_id) DO UPDATE SET session_id=EXCLUDED.session_id,auth_version=EXCLUDED.auth_version,editor_id=EXCLUDED.editor_id,lease_epoch=EXCLUDED.lease_epoch,expires_at=EXCLUDED.expires_at,job_id=EXCLUDED.job_id,job_epoch=EXCLUDED.job_epoch RETURNING *", [...scope(principal),fileId,principal.sessionId,principal.authVersion,editorId,epoch,ttlMs,principal.job?.id ?? null,principal.job?.epoch ?? null])).rows[0]
    return dto(row)
  }
  return {
    async getLease(token: FileCredential, fileId: string) {
      const id = uuid(fileId)
      return run(token,id,async (connection, principal) => {
        const row = await lockLease(connection,principal,id), now = await databaseTime(connection)
        if (!row) return { leaseEpoch: 0, editorId: null, expiresAt: null, active: false, heldByCurrentSession: false }
        return { ...dto(row), active: row.auth_version === principal.authVersion && row.expires_at > now, heldByCurrentSession: row.session_id === principal.sessionId && (!principal.dshEdit || row.editor_id===principal.dshEdit.editorId) && (principal.job ? row.job_id===principal.job.id && Number(row.job_epoch)===principal.job.epoch : row.job_id===null) }
      })
    },
    async acquireLease(token: FileCredential, fileId: string, input: { editorId: string }) {
      shape(input,['editorId'])
      const id = uuid(fileId), editor = uuid(input.editorId)
      return run(token,id,async (connection, principal) => {
        editorAuthority(principal,editor)
        const row = await lockLease(connection,principal,id), now = await databaseTime(connection)
        if (!row) return install(connection,principal,id,editor,1)
        if (row.auth_version === principal.authVersion && row.expires_at > now) {
          if (row.session_id !== principal.sessionId || row.editor_id !== editor || (principal.job ? row.job_id!==principal.job.id : row.job_id!==null)) throw authError(409)
          if (principal.job && Number(row.job_epoch)!==principal.job.epoch) {
            if (Number(row.job_epoch)>principal.job.epoch) throw authError(409)
            return install(connection,principal,id,editor,nextEpoch(Number(row.lease_epoch)))
          }
          return dto(row)
        }
        return install(connection,principal,id,editor,nextEpoch(Number(row.lease_epoch)))
      },true)
    },
    async renewLease(token: FileCredential, fileId: string, input: { editorId: string; leaseEpoch: number }) {
      shape(input,['editorId','leaseEpoch'])
      const id = uuid(fileId), editor = uuid(input.editorId), epoch = leaseEpoch(input.leaseEpoch)
      return run(token,id,async (connection, principal) => {
        await assertLiveLease(connection,principal,id,epoch,editor)
        return install(connection,principal,id,editor,epoch)
      },true)
    },
    async takeoverLease(token: FileCredential, fileId: string, input: { editorId: string; expectedEpoch: number }) {
      shape(input,['editorId','expectedEpoch'])
      const id = uuid(fileId), editor = uuid(input.editorId), expected = leaseEpoch(input.expectedEpoch)
      return run(token,id,async (connection, principal) => {
        if (principal.job || principal.dshEdit) throw authError(404)
        const row = await lockLease(connection,principal,id)
        if (!row || Number(row.lease_epoch) !== expected) throw authError(409)
        return install(connection,principal,id,editor,nextEpoch(expected))
      },true)
    },
    async releaseLease(token: FileCredential, fileId: string, input: { editorId: string; leaseEpoch: number }) {
      shape(input,['editorId','leaseEpoch'])
      const id = uuid(fileId), editor = uuid(input.editorId), epoch = leaseEpoch(input.leaseEpoch)
      return run(token,id,async (connection, principal) => {
        editorAuthority(principal,editor)
        const row = await lockLease(connection,principal,id)
        if (principal.job ? row?.job_id!==principal.job.id || Number(row?.job_epoch)!==principal.job.epoch : row?.job_id!=null) throw authError(404)
        if (!row || Number(row.lease_epoch) !== epoch || row.editor_id !== editor || row.session_id !== principal.sessionId || row.auth_version !== principal.authVersion) throw authError(409)
        await connection.query('UPDATE edit_leases SET expires_at=LEAST(expires_at,clock_timestamp()) WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3', [...scope(principal),id])
      })
    },
  }
}
export type LeaseService = ReturnType<typeof createLeaseService>
