import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions, FileCredential } from '../../db/context.ts'
import type { ObjectStore } from '../../storage/object-store.ts'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import { uuid, scope, objectKey, lockAccount, lockUpload, loadFile, runFileTransaction } from '../files/queries.ts'
import type { FileService, FilePolicy } from '../files/service.ts'
import { assertLiveLease, leaseEpoch } from '../leases/queries.ts'
import { tokenHash, authError } from '../auth/sessions.ts'
import { appendRevisionEvent } from '../../outbox/service.ts'
import type { SaveInput, RevisionRef } from '../../../../../../packages/web-contracts/src/api.ts'

type DraftInput = { size: number; baseRevision: string; leaseEpoch: number; editorId: string }
type History = { id: string; parent_revision: string | null; restored_from: string | null; object_key: string; source: 'import' | 'save' | 'restore'; sha256: string; size: number; created_at: Date }
const shape = (value: object, keys: string[]) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw authError(400) }
const key = (value: string) => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw authError(400); return value }
const revisionRef = (fileId: string, row: { id: string; sha256: string; size: number }): RevisionRef => ({ fileId, revision: row.id, sha256: row.sha256, size: row.size })
const historyDto = (row: History) => ({ revision: row.id, parentRevision: row.parent_revision, restoredFrom: row.restored_from, source: row.source, sha256: row.sha256, size: row.size, createdAt: row.created_at.toISOString() })

export function createRevisionService({ transactions, objects, files, quotaBytes = 1024 ** 3, maxUploads = 16, uploadTtlMs = 15 * 60_000 }: { transactions: PrincipalTransactions; objects: ObjectStore; files: FileService } & FilePolicy) {
  if (![quotaBytes,maxUploads,uploadTtlMs].every(value => Number.isSafeInteger(value) && value > 0) || quotaBytes > Number.MAX_SAFE_INTEGER / 2 || maxUploads > 1000 || uploadTtlMs > 24 * 3600_000) throw new Error('Invalid file policy')
  const run = <T>(token: FileCredential, action: 'files:read' | 'files:write', operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>) => runFileTransaction(transactions,token,action,operation)
  async function historyRow(connection: PoolClient, principal: BusinessPrincipal, fileId: string, revision: string): Promise<History> {
    if (principal.job) throw authError(404)
    const row = (await connection.query<History>('SELECT * FROM file_revisions WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND id=$4', [...scope(principal),fileId,revision])).rows[0]
    if (!row) throw authError(404)
    return row
  }
  async function reserve(token: FileCredential, fileId: string, input: DraftInput, restoredFrom: string | null = null) {
    const id = uuid(fileId), base = uuid(input.baseRevision), editor = uuid(input.editorId), epoch = leaseEpoch(input.leaseEpoch), size = input.size
    if (!Number.isSafeInteger(size) || size < 1) throw authError(400)
    if (size > MAX_OBJECT_BYTES) throw authError(413)
    // Browser owners may reclaim their abandoned drafts; job capabilities must
    // never gain account-wide reclamation authority.
    if (typeof token === 'string') await files.reclaimAbandonedUploads(token)
    return run(token,'files:write',async (connection, principal) => {
      if (principal.job && (id!==principal.job.fileId || base!==principal.job.baseRevision || editor!==principal.job.id || restoredFrom)) throw authError(404)
      const account = await lockAccount(connection,principal)
      const file = await loadFile(connection,principal,id,false,'UPDATE')
      await assertLiveLease(connection,principal,id,epoch,editor)
      if (file.current_revision !== base) throw authError(409)
      if (restoredFrom) await historyRow(connection,principal,id,restoredFrom)
      if (account.reservedBytes + account.storedBytes + size > quotaBytes) throw authError(413)
      const pending = await connection.query("SELECT 1 FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND state IN ('staged','receiving','ready')",scope(principal))
      if (pending.rowCount! >= maxUploads) throw Object.assign(authError(429), { retryAfter: 60 })
      const uploadId = randomUUID(), revision = randomUUID()
      const result = await connection.query("INSERT INTO uploads(id,deployment_id,owner_id,workspace_id,file_id,revision_id,name,format,expected_size,auth_version,state,expires_at,kind,base_revision,lease_epoch,editor_id,session_id,restored_from,job_id,job_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'staged',clock_timestamp()+$11*interval '1 millisecond','revision',$12,$13,$14,$15,$16,$17,$18) RETURNING expires_at", [uploadId,...scope(principal),file.workspace_id,id,revision,file.name,file.format,size,principal.authVersion,uploadTtlMs,base,epoch,editor,principal.sessionId,restoredFrom,principal.job?.id ?? null,principal.job?.epoch ?? null])
      await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes+$3 WHERE deployment_id=$1 AND owner_id=$2',[...scope(principal),size])
      return { uploadId, fileId: id, expiresAt: (result.rows[0].expires_at as Date).toISOString() }
    })
  }
  return {
    async stageUpload(token: FileCredential, fileId: string, input: DraftInput) {
      shape(input,['size','baseRevision','leaseEpoch','editorId'])
      return reserve(token,fileId,input)
    },
    async stageRestore(token: FileCredential, fileId: string, input: Omit<DraftInput,'size'> & { revision: string }) {
      shape(input,['revision','baseRevision','leaseEpoch','editorId'])
      const id = uuid(fileId), historical = uuid(input.revision)
      const bytes = await run(token,'files:read',async (connection, principal) => {
        await loadFile(connection,principal,id)
        const row = await historyRow(connection,principal,id,historical)
        return objects.readVerified({ key: row.object_key, sha256: row.sha256, size: row.size })
      })
      const upload = await reserve(token,id,{ size: bytes.length, baseRevision: input.baseRevision, leaseEpoch: input.leaseEpoch, editorId: input.editorId },historical)
      await files.receiveUpload(token,upload.uploadId,bytes)
      return upload
    },
    async commitRevision(token: FileCredential, input: SaveInput): Promise<RevisionRef> {
      shape(input,['fileId','uploadId','baseRevision','idempotencyKey','leaseEpoch','sourceCommandId'])
      const fileId = uuid(input.fileId), uploadId = uuid(input.uploadId), base = uuid(input.baseRevision), epoch = leaseEpoch(input.leaseEpoch), idempotencyKey = key(input.idempotencyKey)
      const requestedSource = input.sourceCommandId === undefined ? null : uuid(input.sourceCommandId)
      const requestHash = createHash('sha256').update(JSON.stringify({ fileId, uploadId, baseRevision: base, leaseEpoch: epoch, sourceCommandId: requestedSource })).digest('hex')
      return run(token,'files:write',async (connection, principal) => {
        if (principal.job && (fileId!==principal.job.fileId || base!==principal.job.baseRevision || idempotencyKey!=='job_' + principal.job.id || requestedSource!==null)) throw authError(404)
        await lockAccount(connection,principal)
        const retired = await connection.query('SELECT 1 FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND purge_started_at IS NOT NULL',[...scope(principal),fileId])
        if (retired.rowCount) throw authError(410)
        // A successful retry is a receipt lookup, not a new write authority.
        // It survives a later head/lease change but still requires owner auth.
        const prior = (await connection.query('SELECT c.request_hash,r.id,r.sha256,r.size FROM revision_commits c JOIN file_revisions r ON r.deployment_id=c.deployment_id AND r.owner_id=c.owner_id AND r.file_id=c.file_id AND r.id=c.revision_id WHERE c.deployment_id=$1 AND c.owner_id=$2 AND c.file_id=$3 AND c.idempotency_key=$4',[...scope(principal),fileId,idempotencyKey])).rows[0]
        if (prior) {
          if (principal.job) throw authError(409)
          if (prior.request_hash !== requestHash) throw authError(409)
          return revisionRef(fileId,prior)
        }
        const upload = await lockUpload(connection,principal,uploadId)
        if (upload.kind !== 'revision' || upload.file_id !== fileId || upload.state !== 'ready' || !upload.sha256 || upload.base_revision !== base || Number(upload.lease_epoch) !== epoch || !upload.editor_id) throw authError(409)
        const file = await loadFile(connection,principal,fileId,false,'UPDATE')
        await assertLiveLease(connection,principal,fileId,epoch,upload.editor_id)
        if (file.current_revision !== base) throw authError(409)
        await objects.verifyObject({ key: objectKey(principal,upload.revision_id), size: upload.expected_size, sha256: upload.sha256 })
        const source = upload.restored_from ? 'restore' : 'save'
        await connection.query('INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size,source,parent_revision,restored_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[upload.revision_id,...scope(principal),fileId,objectKey(principal,upload.revision_id),upload.sha256,upload.expected_size,source,base,upload.restored_from])
        const changed = await connection.query('UPDATE files SET current_revision=$4,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND current_revision=$5 RETURNING id',[...scope(principal),fileId,upload.revision_id,base])
        if (changed.rowCount !== 1) throw authError(409)
        await connection.query("UPDATE uploads SET state='committed',completed_file_id=file_id WHERE deployment_id=$1 AND owner_id=$2 AND id=$3",[...scope(principal),uploadId])
        await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes-$3,stored_bytes=stored_bytes+$3 WHERE deployment_id=$1 AND owner_id=$2',[...scope(principal),upload.expected_size])
        await connection.query('INSERT INTO revision_commits(deployment_id,owner_id,file_id,idempotency_key,request_hash,upload_id,revision_id,base_revision,lease_epoch,requested_source_command_id,job_id,job_epoch,job_claim_hash,job_lease_until,job_transaction) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,(SELECT claim_hash FROM native_jobs WHERE id=$11),(SELECT lease_until FROM native_jobs WHERE id=$11),CASE WHEN $11::uuid IS NOT NULL THEN pg_current_xact_id() ELSE NULL END)',[...scope(principal),fileId,idempotencyKey,requestHash,uploadId,upload.revision_id,base,epoch,requestedSource,principal.job?.id ?? null,principal.job?.epoch ?? null])
        await appendRevisionEvent(connection,principal,{ fileId, revision: upload.revision_id, baseRevision: base, source })
        await lockUpload(connection,principal,uploadId,true)
        await assertLiveLease(connection,principal,fileId,epoch,upload.editor_id)
        if (principal.job && typeof token!=='string') {
          await connection.query('UPDATE edit_leases SET expires_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND lease_epoch=$4 AND editor_id=$5 AND job_id=$5',[...scope(principal),fileId,epoch,principal.job.id])
          await connection.query('SELECT complete_native_job($1::uuid,$2::uuid,$3::bigint,$4::text,$5::uuid)',[principal.deploymentId,principal.job.id,principal.job.epoch,tokenHash(token.token),upload.revision_id])
        }
        return { fileId, revision: upload.revision_id, sha256: upload.sha256, size: upload.expected_size }
      })
    },
    async getRevision(token: FileCredential, fileId: string, revision: string) {
      const id = uuid(fileId), rev = uuid(revision)
      return run(token,'files:read',async (connection, principal) => {
        if (principal.job) throw authError(404)
        await loadFile(connection,principal,id)
        return revisionRef(id,await historyRow(connection,principal,id,rev))
      })
    },
    async listRevisions(token: FileCredential, fileId: string, { cursor, limit = 50 }: { cursor?: string; limit?: number } = {}) {
      const id = uuid(fileId), after = cursor === undefined ? null : uuid(cursor)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw authError(400)
      return run(token,'files:read',async (connection, principal) => {
        if (principal.job) throw authError(404)
        await loadFile(connection,principal,id)
        if (after) await historyRow(connection,principal,id,after)
        const result = await connection.query<History>('SELECT * FROM file_revisions WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND ($4::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM file_revisions WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND id=$4)) ORDER BY created_at DESC,id DESC LIMIT $5',[...scope(principal),id,after,limit + 1])
        return { revisions: result.rows.slice(0,limit).map(historyDto), nextCursor: result.rows.length > limit ? result.rows[limit - 1].id : null }
      })
    },
  }
}
export type RevisionService = ReturnType<typeof createRevisionService>
