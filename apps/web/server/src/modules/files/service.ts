import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import type { ObjectStore } from '../../storage/object-store.ts'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import { validateFileName, validateUpload } from './validation.ts'
import { authorize } from '../policy/authorize.ts'
import { authError } from '../auth/sessions.ts'
import { UNSUPPORTED_CAPABILITIES } from '../../../../../../packages/web-contracts/src/host.ts'
import type { OfficeFormat, OpenFileResult } from '../../../../../../packages/web-contracts/src/api.ts'

export interface FilePolicy { quotaBytes?: number; maxUploads?: number; uploadTtlMs?: number }
type Upload = { id: string; file_id: string; revision_id: string; workspace_id: string; name: string; format: OfficeFormat; expected_size: number; auth_version: number; state: string; sha256: string | null; attempt_id: string | null; expires_at: Date }
type FileRow = { id: string; name: string; format: OfficeFormat; current_revision: string; deleted_at: Date | null; created_at: Date; updated_at: Date; object_key: string; sha256: string; size: number }
const uuid = (id: string) => { if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw authError(400); return id.toLowerCase() }
const scope = (p: BusinessPrincipal) => [p.deploymentId,p.userId]
const objectKey = (p: BusinessPrincipal, revisionId: string) => `${p.deploymentId}/${p.userId}/objects/${revisionId}`
const openResult = (row: FileRow): OpenFileResult => ({ file: { fileId: row.id, revision: row.current_revision, sha256: row.sha256, size: row.size }, format: row.format,
  downloadEndpoint: `/api/v1/files/${row.id}/content?revision=${row.current_revision}`, capabilities: UNSUPPORTED_CAPABILITIES })
const fileDto = (row: FileRow) => ({ id: row.id, name: row.name, format: row.format, revision: row.current_revision, size: row.size, sha256: row.sha256, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), deletedAt: row.deleted_at?.toISOString() ?? null })

export function createFileService({ transactions, objects, quotaBytes = 1024 ** 3, maxUploads = 16, uploadTtlMs = 15 * 60_000 }: { transactions: PrincipalTransactions; objects: ObjectStore } & FilePolicy) {
  if (![quotaBytes,maxUploads,uploadTtlMs].every(value => Number.isSafeInteger(value) && value > 0) || quotaBytes > Number.MAX_SAFE_INTEGER / 2 || maxUploads > 1000 || uploadTtlMs > 24 * 3600_000) throw new Error('Invalid file policy')
  const run = <T>(token: string, action: 'files:read' | 'files:write', fn: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>) => transactions.withPrincipalTransaction({ kind: 'session', token }, async (connection, principal) => {
    authorize(principal, action, { deploymentId: principal.deploymentId, ownerId: principal.userId })
    return fn(connection, principal)
  })
  async function lockAccount(connection: PoolClient, principal: BusinessPrincipal) {
    const values = scope(principal)
    const workspace = (await connection.query('SELECT id FROM workspaces WHERE deployment_id=$1 AND owner_id=$2', values)).rows[0]
    if (!workspace) throw authError(404)
    await connection.query('INSERT INTO storage_accounts(deployment_id,owner_id,workspace_id) VALUES($1,$2,$3) ON CONFLICT(deployment_id,owner_id) DO NOTHING', [...values,workspace.id])
    await connection.query('SELECT 1 FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2 FOR UPDATE', values)
    const expired = await connection.query("WITH candidates AS (SELECT id,expected_size,state FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND state IN ('staged','receiving','ready') AND expires_at<=clock_timestamp() ORDER BY id FOR UPDATE) UPDATE uploads u SET state='expired' FROM candidates c WHERE u.deployment_id=$1 AND u.owner_id=$2 AND u.id=c.id RETURNING c.expected_size,c.state AS previous_state", values)
    if (expired.rowCount) await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes-$3,stored_bytes=stored_bytes+$4 WHERE deployment_id=$1 AND owner_id=$2', [...values,expired.rows.reduce((sum, row) => sum + row.expected_size, 0),expired.rows.filter(row => row.previous_state !== 'staged').reduce((sum, row) => sum + row.expected_size, 0)])
    const row = (await connection.query('SELECT * FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2', values)).rows[0]
    return { workspaceId: workspace.id as string, reservedBytes: Number(row.reserved_bytes), storedBytes: Number(row.stored_bytes) }
  }
  async function lockUpload(connection: PoolClient, principal: BusinessPrincipal, id: string, requireUnexpired = false) {
    const row = (await connection.query<Upload>('SELECT * FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE', [...scope(principal),id])).rows[0]
    if (!row) throw authError(404)
    // Read database time after the row lock; time evaluated before a wait is not authority.
    const now = (await connection.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    if ((requireUnexpired || row.state !== 'committed') && (row.expires_at <= now || row.state === 'expired')) throw authError(410)
    if (row.auth_version !== principal.authVersion) throw authError(409)
    return row
  }
  async function loadFile(connection: PoolClient, principal: BusinessPrincipal, id: string, includeTrash = false, lock = 'SHARE') {
    const row = (await connection.query<FileRow>(`SELECT f.*,r.object_key,r.sha256,r.size FROM files f JOIN file_revisions r ON r.deployment_id=f.deployment_id AND r.owner_id=f.owner_id AND r.file_id=f.id AND r.id=f.current_revision WHERE f.deployment_id=$1 AND f.owner_id=$2 AND f.id=$3 ${includeTrash ? '' : 'AND f.deleted_at IS NULL'} FOR ${lock} OF f`, [...scope(principal),id])).rows[0]
    if (!row) throw authError(404)
    return row
  }
  async function releaseReservation(connection: PoolClient, principal: BusinessPrincipal, upload: Upload, state: 'cancelled') {
    await connection.query('UPDATE uploads SET state=$4 WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),upload.id,state])
    await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes-$3,stored_bytes=stored_bytes+$4 WHERE deployment_id=$1 AND owner_id=$2', [...scope(principal),upload.expected_size,upload.state === 'ready' ? upload.expected_size : 0])
  }
  const service = {
    async stageUpload(token: string, metadata: { name: string; size: number }) {
      if (!metadata || typeof metadata !== 'object' || Object.keys(metadata).some(key => !['name','size'].includes(key))) throw authError(400)
      const name = metadata.name, format = validateFileName(name), size = metadata.size
      if (!Number.isSafeInteger(size) || size < 1) throw authError(400)
      if (size > MAX_OBJECT_BYTES) throw authError(413)
      return run(token, 'files:write', async (connection, principal) => {
        const account = await lockAccount(connection, principal)
        if (account.reservedBytes + account.storedBytes + size > quotaBytes) throw authError(413)
        const pending = await connection.query("SELECT 1 FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND state IN ('staged','receiving','ready')", scope(principal))
        if (pending.rowCount! >= maxUploads) throw Object.assign(authError(429), { retryAfter: 60 })
        const id = randomUUID(), fileId = randomUUID(), revisionId = randomUUID()
        const result = await connection.query("INSERT INTO uploads(id,deployment_id,owner_id,workspace_id,file_id,revision_id,name,format,expected_size,auth_version,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'staged',clock_timestamp()+$11*interval '1 millisecond') RETURNING expires_at", [id,...scope(principal),account.workspaceId,fileId,revisionId,name,format,size,principal.authVersion,uploadTtlMs])
        await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes+$3 WHERE deployment_id=$1 AND owner_id=$2', [...scope(principal),size])
        return { uploadId: id, fileId, expiresAt: (result.rows[0].expires_at as Date).toISOString() }
      })
    },
    preflightUpload: (token: string, uploadId: string) => run(token, 'files:write', async (connection, principal) => {
      const row = await lockUpload(connection, principal, uuid(uploadId))
      if (row.state !== 'staged') throw authError(409)
      return { size: row.expected_size }
    }),
    async receiveUpload(token: string, uploadId: string, input: Buffer) {
      const id = uuid(uploadId), attempt = randomUUID()
      const claimed = await run(token, 'files:write', async (connection, principal) => {
        await lockAccount(connection, principal)
        const row = await lockUpload(connection, principal, id)
        if (row.state !== 'staged') throw authError(409)
        await connection.query("UPDATE uploads SET state='receiving',attempt_id=$4 WHERE deployment_id=$1 AND owner_id=$2 AND id=$3", [...scope(principal),id,attempt])
        return { row, key: objectKey(principal,row.revision_id) }
      })
      let published = false
      try {
        if (!Buffer.isBuffer(input) || input.length !== claimed.row.expected_size) throw authError(400)
        const bytes = Buffer.from(input), validated = await validateUpload(bytes, claimed.row.name)
        if (validated.format !== claimed.row.format) throw authError(400)
        // Once publication starts, an error may mean an object exists. Retain
        // the reservation/row until expiry; never delete an ambiguous object.
        published = true
        const reference = await objects.putImmutable(claimed.key, bytes)
        if (reference.key !== claimed.key || reference.size !== validated.size || reference.sha256 !== validated.sha256) throw authError(503)
        return await run(token, 'files:write', async (connection, principal) => {
          await lockAccount(connection, principal)
          const row = await lockUpload(connection, principal, id)
          if (row.state !== 'receiving' || row.attempt_id !== attempt) throw authError(409)
          await connection.query("UPDATE uploads SET state='ready',sha256=$4 WHERE deployment_id=$1 AND owner_id=$2 AND id=$3", [...scope(principal),id,validated.sha256])
          return { uploadId: id, sha256: validated.sha256, size: validated.size }
        })
      } catch (error) {
        if (!published) await run(token, 'files:write', async (connection, principal) => {
          await lockAccount(connection, principal)
          const row = await lockUpload(connection, principal, id)
          if (row.state === 'receiving' && row.attempt_id === attempt) await releaseReservation(connection, principal, row, 'cancelled')
        }).catch(() => {}) // Revoked authority may not mutate cleanup state; TTL later releases it.
        throw error
      }
    },
    async finishUpload(token: string, uploadId: string) {
      const id = uuid(uploadId)
      return run(token, 'files:write', async (connection, principal) => {
        await lockAccount(connection, principal)
        const row = await lockUpload(connection, principal, id)
        if (row.state === 'committed') return openResult(await loadFile(connection, principal, row.file_id))
        if (row.state !== 'ready' || !row.sha256) throw authError(409)
        await objects.readVerified({ key: objectKey(principal,row.revision_id), size: row.expected_size, sha256: row.sha256 })
        await connection.query('INSERT INTO files(id,deployment_id,owner_id,workspace_id,name,format,current_revision) VALUES($1,$2,$3,$4,$5,$6,$7)', [row.file_id,...scope(principal),row.workspace_id,row.name,row.format,row.revision_id])
        await connection.query('INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size) VALUES($1,$2,$3,$4,$5,$6,$7)', [row.revision_id,...scope(principal),row.file_id,objectKey(principal,row.revision_id),row.sha256,row.expected_size])
        await connection.query("UPDATE uploads SET state='committed',completed_file_id=file_id WHERE deployment_id=$1 AND owner_id=$2 AND id=$3", [...scope(principal),id])
        await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes-$3,stored_bytes=stored_bytes+$3 WHERE deployment_id=$1 AND owner_id=$2', [...scope(principal),row.expected_size])
        const result = openResult(await loadFile(connection, principal, row.file_id))
        // A locked row does not freeze time. Recheck after object I/O and all
        // metadata writes; an expired initial finish rolls the whole txn back.
        await lockUpload(connection, principal, id, true)
        return result
      })
    },
    async cancelUpload(token: string, uploadId: string) {
      const id = uuid(uploadId)
      return run(token, 'files:write', async (connection, principal) => {
        await lockAccount(connection, principal)
        const row = await lockUpload(connection, principal, id)
        if (row.state === 'cancelled') return
        if (row.state === 'committed' || row.state === 'receiving') throw authError(409)
        if (row.state === 'staged' || row.state === 'ready') await releaseReservation(connection, principal, row, 'cancelled')
      })
    },
    openFile: (token: string, fileId: string) => run(token, 'files:read', async (connection, principal) => openResult(await loadFile(connection, principal, uuid(fileId)))),
    download: (token: string, fileId: string, revision: string) => run(token, 'files:read', async (connection, principal) => {
      const row = await loadFile(connection, principal, uuid(fileId))
      if (row.current_revision !== uuid(revision)) throw authError(404)
      const bytes = await objects.readVerified({ key: row.object_key, size: row.size, sha256: row.sha256 })
      return { bytes, name: row.name, format: row.format }
    }),
    async readFile(token: string, fileId: string, revision: string): Promise<Buffer> { return (await service.download(token,fileId,revision)).bytes },
    listFiles: async (token: string, { trash = false, cursor, limit = 50 }: { trash?: boolean; cursor?: string; limit?: number } = {}) => {
      if (typeof trash !== 'boolean' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw authError(400)
      const after = cursor === undefined ? null : uuid(cursor)
      return run(token, 'files:read', async (connection, principal) => {
        const result = await connection.query<FileRow>('SELECT f.*,r.size,r.sha256 FROM files f JOIN file_revisions r ON r.deployment_id=f.deployment_id AND r.owner_id=f.owner_id AND r.file_id=f.id AND r.id=f.current_revision WHERE f.deployment_id=$1 AND f.owner_id=$2 AND (f.deleted_at IS NOT NULL)=$3 AND ($4::uuid IS NULL OR f.id>$4) ORDER BY f.id LIMIT $5', [...scope(principal),trash,after,limit + 1])
        return { files: result.rows.slice(0,limit).map(fileDto), nextCursor: result.rows.length > limit ? result.rows[limit - 1].id : null }
      })
    },
    async renameFile(token: string, fileId: string, name: string) {
      const format = validateFileName(name), id = uuid(fileId)
      return run(token, 'files:write', async (connection, principal) => {
        const row = await loadFile(connection, principal, id, false, 'UPDATE')
        if (format !== row.format) throw authError(400)
        await connection.query('UPDATE files SET name=$4,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),id,name])
      })
    },
    trashFile: (token: string, fileId: string) => run(token, 'files:write', async (connection, principal) => {
      const id = uuid(fileId)
      await loadFile(connection, principal, id, true, 'UPDATE')
      await connection.query('UPDATE files SET deleted_at=COALESCE(deleted_at,clock_timestamp()),updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),id])
    }),
    restoreFile: (token: string, fileId: string) => run(token, 'files:write', async (connection, principal) => {
      const id = uuid(fileId)
      await loadFile(connection, principal, id, true, 'UPDATE')
      await connection.query('UPDATE files SET deleted_at=NULL,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),id])
    }),
    usage: (token: string) => run(token, 'files:read', async (connection, principal) => {
      const account = await lockAccount(connection, principal)
      return { reservedBytes: account.reservedBytes, storedBytes: account.storedBytes, quotaBytes }
    }),
  }
  return service
}
export type FileService = ReturnType<typeof createFileService>
