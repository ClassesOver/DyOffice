import { syncFileAssistantChat } from './assistant-chat.ts'
import { purgeFile } from './purge.ts'
import { UNSUPPORTED_CAPABILITIES, type CapabilityCatalog } from '../../../../../../packages/web-contracts/src/host.ts'
import { randomUUID } from 'node:crypto'
import { PDFDocument, PageSizes } from 'pdf-lib'
import type { PoolClient } from 'pg'
import type { BusinessPrincipal, McpPrincipalTransactions, PrincipalTransactions, FileCredential, OfficeReadCredential } from '../../db/context.ts'
import type { ObjectStore } from '../../storage/object-store.ts'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import { createFileValidator, validateFileName, validateUpload } from './validation.ts'
import { assertDshUpload, uuid, scope, objectKey, openResult as unsupportedOpenResult, fileDto, lockAccount, lockUpload, loadFile, releaseReservation, runFileTransaction, type FileRow, type Upload } from './queries.ts'
import { assertLiveLease } from '../leases/queries.ts'
import { authError, tokenHash } from '../auth/sessions.ts'
import { reclaimAbandonedUploads } from './reclamation.ts'
import { createWorkbookPasswordCodec } from './workbook-password.ts'
import type { EncryptedOfficeFormat } from './workbook-password-core.ts'
import {createDocumentEditGrants} from './document-edit-grants.ts'

const workbookPasswords = createWorkbookPasswordCodec()
const verifiedOfficeCopy = Symbol()
type ProtectedOffice = { password: string; signal?: AbortSignal; format?:EncryptedOfficeFormat; readAfterImport?:boolean } | {
  [verifiedOfficeCopy]: { format: EncryptedOfficeFormat; sha256: string; size: number; officeSignatureProtected: boolean }
}

function assertProtectedOfficeImport(row: Upload, principal: BusinessPrincipal, format:EncryptedOfficeFormat) {
  if (principal.job || principal.dshEdit) throw authError(404)
  if (row.kind !== 'import' || row.format !== format) throw authError(415)
}

export interface FilePolicy { quotaBytes?: number; maxUploads?: number; uploadTtlMs?: number }

function fitCopyStem(stem: string, ending: string) {
  let fitted = '', size = Buffer.byteLength(ending)
  for (const character of stem) {
    size += Buffer.byteLength(character)
    if (size > 255) break
    fitted += character
  }
  return fitted
}

export function createFileService({ transactions, objects, quotaBytes = 1024 ** 3, maxUploads = 16, uploadTtlMs = 15 * 60_000, capabilities = UNSUPPORTED_CAPABILITIES }: { capabilities?: CapabilityCatalog; transactions: PrincipalTransactions & Partial<Pick<McpPrincipalTransactions, 'withMcpReadTransaction'>>; objects: ObjectStore } & FilePolicy) {
  if (![quotaBytes,maxUploads,uploadTtlMs].every(value => Number.isSafeInteger(value) && value > 0) || quotaBytes > Number.MAX_SAFE_INTEGER / 2 || maxUploads > 1000 || uploadTtlMs > 24 * 3600_000) throw new Error('Invalid file policy')
  const run = <T>(token: FileCredential, action: 'files:read' | 'files:write', fn: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>) => runFileTransaction(transactions,token,action,fn)
  const personal: typeof run = (token,action,fn) => run(token,action,(connection,principal) => {
    if (principal.job || principal.dshEdit) throw authError(404)
    return fn(connection,principal)
  })
  const documentEdits=createDocumentEditGrants()
  const importReads=new Map<string,{sessionHash:string;fileId:string;revision:string;sha256:string;bytes:Buffer;password:string;expiresAt:number;timer:NodeJS.Timeout}>()
  const importReadLifetimeMs=60_000, importReadCapacity=8, importReadByteLimit=64*1024*1024
  function removeImportRead(id:string){
    const grant=importReads.get(id)
    if(grant)clearTimeout(grant.timer)
    importReads.delete(id)
  }
  function prepareImportRead(token:string,row:Upload,sha256:string,bytes:Buffer,password:string){
    const used=[...importReads.values()].reduce((sum,grant)=>sum+grant.bytes.length,0)
    if(importReads.size>=importReadCapacity||used+bytes.length>importReadByteLimit)return
    const id=randomUUID(),timer=setTimeout(()=>removeImportRead(id),importReadLifetimeMs)
    timer.unref()
    importReads.set(id,{sessionHash:tokenHash(token),fileId:row.file_id,revision:row.revision_id,sha256,bytes,password,expiresAt:Date.now()+importReadLifetimeMs,timer})
    return id
  }
  function requireImportRead(token:string,fileId:string,revision:string,id:string){
    const grant=importReads.get(uuid(id))
    if(!grant||grant.expiresAt<=Date.now()||grant.sessionHash!==tokenHash(token)||grant.fileId!==fileId||grant.revision!==revision)throw authError(404)
    return grant
  }
  function authorizeProtectedDocument(token:string,fileId:string,revision:string){
    return personal(token,'files:read',async(connection,principal)=>{
      const file=await loadFile(connection,principal,uuid(fileId))
      if(file.format!=='docx'||!file.office_password_protected)throw authError(415)
      if(file.current_revision!==uuid(revision))throw authError(409)
      return file
    })
  }
  async function sealDocumentDraft(token:string,fileId:string,revision:string,editorId:string,unlockId:string,bytes:Buffer,signal?:AbortSignal) {
    const authorize=async()=>{
      const current=await authorizeProtectedDocument(token,fileId,revision)
      signal?.throwIfAborted()
      return documentEdits.authorize(token,current,uuid(editorId),unlockId)
    }
    const grant=await authorize()
    const sealed=await workbookPasswords.seal(bytes,grant.password,signal,'docx')
    return {sealed,grant,async recheck(){
      if(await authorize()!==grant)throw authError(423)
    }}
  }
  async function documentDraftGrant(token:string,file:FileRow,revision:string,editorId:string,unlockId?:string){
    if(file.format!=='docx')throw authError(415)
    if(file.current_revision!==uuid(revision))throw authError(409)
    await service.assertOfficeWritable(file,file.office_password_protected?'docx':undefined)
    return file.office_password_protected?documentEdits.authorize(token,file,uuid(editorId),unlockId):undefined
  }
  const catalog = Object.freeze({ ...capabilities })
  function readRevision<T>(credential: OfficeReadCredential, fileId: string, revision: string, operation: (connection: PoolClient, principal: BusinessPrincipal) => Promise<T>) {
    if (typeof credential !== 'string' && credential.kind === 'external-token') {
      if (!transactions.withMcpReadTransaction) throw authError()
      return transactions.withMcpReadTransaction(credential, { fileId: uuid(fileId), revision: uuid(revision) }, operation)
    }
    return run(credential, 'files:read', operation)
  }
  async function requireReadableRevision(connection: PoolClient, principal: BusinessPrincipal, fileId: string, revision: string) {
    const file = await loadFile(connection, principal, uuid(fileId))
    const requestedRevision = uuid(revision)
    if (principal.job && requestedRevision !== principal.job.baseRevision) throw authError(404)
    const reference = (await connection.query<{ object_key: string; size: number; sha256: string; office_password_protected: boolean }>(
      'SELECT object_key,size,sha256,office_password_protected FROM file_revisions WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND id=$4',
      [...scope(principal),file.id,requestedRevision],
    )).rows[0]
    if (!reference) throw authError(404)
    return { file, reference }
  }
  const legacySignatureResults = new Map<string, boolean>()
  const legacyInspections = new Map<string, Promise<boolean>>()
  const validateLegacyOffice = createFileValidator({maxConcurrent:1})
  let nextLegacyInspection = Promise.resolve()
  async function signatureProtected(row: FileRow) {
    if (row.format === 'pdf' || row.format === 'csv') return false
    if (typeof row.office_signature_protected === 'boolean') return row.office_signature_protected
    const key = `${row.format}:${row.sha256}:${row.size}`
    const cached = legacySignatureResults.get(key)
    if (cached !== undefined) return cached
    const pending = legacyInspections.get(key)
    if (pending) return pending
    // Keep cold legacy reads on their own bounded queue so they do not consume upload slots.
    if (legacyInspections.size >= 16) throw Object.assign(authError(503), {retryAfter:1})
    const inspection = nextLegacyInspection.then(async () => {
      const bytes = await objects.readVerified({ key: row.object_key, sha256: row.sha256, size: row.size })
      const result = await validateLegacyOffice(bytes, row.name)
      if (result.sha256 !== row.sha256 || result.format !== row.format) throw authError(503)
      if (legacySignatureResults.size >= 256) legacySignatureResults.delete(legacySignatureResults.keys().next().value!)
      legacySignatureResults.set(key, result.officeSignatureProtected)
      return result.officeSignatureProtected
    })
    legacyInspections.set(key, inspection)
    nextLegacyInspection = inspection.then(() => undefined, () => undefined)
    try { return await inspection } finally { legacyInspections.delete(key) }
  }
  const openResult = async (row: FileRow) => ({ ...unsupportedOpenResult(row),capabilities: catalog,
    ...(row.office_password_protected ? row.format==='docx'?{documentPasswordProtected:true as const}:{workbookPasswordProtected:true as const} : {}),
    ...(await signatureProtected(row) ? {officeSignatureProtected:true as const} : {}) })
  const service = {
    capabilities: catalog,
    async assertOfficeLeaseAllowed(row: FileRow, token?:FileCredential, editorId?:string, docxUnlockId?:string) {
      if(await signatureProtected(row))throw authError(423)
      if(row.format==='docx'&&row.office_password_protected){
        if(typeof token!=='string'||token.startsWith('dsh-edit:')||!editorId)throw authError(423)
        documentEdits.authorize(token,row,editorId,docxUnlockId)
      }
    },
    async assertOfficeWritable(row: FileRow, protectedFormat?:EncryptedOfficeFormat) {
      if (row.office_password_protected !== !!protectedFormat || (protectedFormat&&row.format!==protectedFormat) || await signatureProtected(row)) throw authError(423)
    },
    async reclaimAbandonedUploads(token: FileCredential) {
      if (!objects.removeUnreferenced) return { reclaimedBytes: 0, reclaimedUploads: 0 }
      // Commit expiry first; physical deletion cannot roll back. The collector
      // only locks already-terminal rows and never terminalizes new rows.
      const canReclaim = await personal(token, 'files:write', async (connection, principal) => {
        if (principal.mcpRead) return false
        await lockAccount(connection, principal)
        return true
      })
      if (!canReclaim) return { reclaimedBytes: 0, reclaimedUploads: 0 }
      return personal(token, 'files:write', (connection,principal) => reclaimAbandonedUploads(connection,principal,objects))
    },
    async stageUpload(token: FileCredential, metadata: { name: string; size: number; autoName?:boolean }) {
      if (!metadata || typeof metadata !== 'object' || Object.keys(metadata).some(key => !['name','size','autoName'].includes(key))) throw authError(400)
      const name = metadata.name, format = validateFileName(name), size = metadata.size
      if(metadata.autoName!==undefined&&(typeof metadata.autoName!=='boolean'||(metadata.autoName&&(format==='pdf'||format==='csv'||name!=='未命名.'+format))))throw authError(400)
      if (!Number.isSafeInteger(size) || size < (format === 'csv' ? 0 : 1)) throw authError(400)
      if (size > MAX_OBJECT_BYTES) throw authError(413)
      // Separate commit: quota reclamation survives a subsequent quota rejection.
      await service.reclaimAbandonedUploads(token)
      return personal(token, 'files:write', async (connection, principal) => {
        const account = await lockAccount(connection, principal)
        if (account.reservedBytes + account.storedBytes + size > quotaBytes) throw authError(413)
        const pending = await connection.query("SELECT 1 FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND state IN ('staged','receiving','ready')", scope(principal))
        if (pending.rowCount! >= maxUploads) throw Object.assign(authError(429), { retryAfter: 60 })
        const id = randomUUID(), fileId = randomUUID(), revisionId = randomUUID()
        const result = await connection.query("INSERT INTO uploads(id,deployment_id,owner_id,workspace_id,file_id,revision_id,name,format,expected_size,auth_version,state,expires_at,auto_name_pending) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'staged',clock_timestamp()+$11*interval '1 millisecond',$12) RETURNING expires_at", [id,...scope(principal),account.workspaceId,fileId,revisionId,name,format,size,principal.authVersion,uploadTtlMs,metadata.autoName===true])
        await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes+$3 WHERE deployment_id=$1 AND owner_id=$2', [...scope(principal),size])
        return { uploadId: id, fileId, expiresAt: (result.rows[0].expires_at as Date).toISOString() }
      })
    },
    preflightUpload: (token: FileCredential, uploadId: string, encryptedFormat?:EncryptedOfficeFormat) => run(token, 'files:write', async (connection, principal) => {
      const row = await lockUpload(connection, principal, uuid(uploadId))
      if (row.state !== 'staged') throw authError(409)
      if (encryptedFormat) assertProtectedOfficeImport(row, principal,encryptedFormat)
      if (row.kind === 'revision') {
        if (row.office_password_protected || row.office_password_change) throw authError(423)
        await loadFile(connection,principal,row.file_id)
        await assertLiveLease(connection,principal,row.file_id,Number(row.lease_epoch),row.editor_id!)
      }
      return { size: row.expected_size }
    }),
    async receiveProtectedOfficeRevision(token: FileCredential, uploadId: string, sealed: Awaited<ReturnType<typeof workbookPasswords.seal>>) {
      return service.receiveUpload(token,uploadId,sealed.bytes,{[verifiedOfficeCopy]:sealed.file})
    },
    async receiveUpload(token: FileCredential, uploadId: string, input: Buffer, encryptedOffice?: ProtectedOffice): Promise<{uploadId:string;sha256:string;size:number;unlockId?:string}> {
      const id = uuid(uploadId), attempt = randomUUID()
      const verified=encryptedOffice&&verifiedOfficeCopy in encryptedOffice?encryptedOffice[verifiedOfficeCopy]:undefined
      const password=encryptedOffice&&'password' in encryptedOffice?encryptedOffice:undefined
      const claimed = await run(token, 'files:write', async (connection, principal) => {
        await lockAccount(connection, principal)
        const row = await lockUpload(connection, principal, id)
        if (row.state !== 'staged') throw authError(409)
        if (row.kind === 'revision') {
          if (row.office_password_protected !== !!verified || (encryptedOffice && !verified)) throw authError(423)
        } else if (encryptedOffice) assertProtectedOfficeImport(row,principal,verified?.format??password?.format??'xlsx')
        if (row.kind === 'revision') {
          await loadFile(connection,principal,row.file_id)
          await assertLiveLease(connection,principal,row.file_id,Number(row.lease_epoch),row.editor_id!)
        }
        await connection.query("UPDATE uploads SET state='receiving',attempt_id=$4 WHERE deployment_id=$1 AND owner_id=$2 AND id=$3", [...scope(principal),id,attempt])
        return { row, key: objectKey(principal,row.revision_id) }
      })
      let published = false, completedSha: string | undefined
      try {
        if (!Buffer.isBuffer(input) || input.length !== claimed.row.expected_size) throw authError(400)
        const bytes = Buffer.from(input)
        const importedDocument=typeof token==='string'&&password?.format==='docx'&&password.readAfterImport
          ? await workbookPasswords.open(bytes,password.password,password.signal,'docx') : undefined
        const validated = importedDocument?.file ?? (password
          ? await workbookPasswords.verify(bytes,password.password,password.signal,password.format)
          : verified ?? await validateUpload(bytes, claimed.row.name))
        if (validated.format !== claimed.row.format) throw authError(400)
        password?.signal?.throwIfAborted()
        // Once publication starts, an error may mean an object exists. Retain
        // the reservation/row until expiry; never delete an ambiguous object.
        published = true
        // Storage independently hashes its private byte snapshot and checks
        // this assertion; caller-supplied metadata is never proof of integrity.
        const reference = await objects.putImmutable(claimed.key, bytes, { size: validated.size, sha256: validated.sha256 })
        if (reference.key !== claimed.key || reference.size !== validated.size || reference.sha256 !== validated.sha256) throw authError(503)
        completedSha = validated.sha256
        const ready=await run(token, 'files:write', async (connection, principal) => {
          await lockAccount(connection, principal)
          const row = await lockUpload(connection, principal, id)
          if (row.state !== 'receiving' || row.attempt_id !== attempt) throw authError(409)
          if (row.kind === 'revision') {
            await loadFile(connection,principal,row.file_id)
            await assertLiveLease(connection,principal,row.file_id,Number(row.lease_epoch),row.editor_id!)
          }
          await connection.query("UPDATE uploads SET state='ready',sha256=$4,office_signature_protected=$5,office_password_protected=$6 WHERE deployment_id=$1 AND owner_id=$2 AND id=$3", [...scope(principal),id,validated.sha256,validated.officeSignatureProtected,!!encryptedOffice])
          return { uploadId: id, sha256: validated.sha256, size: validated.size }
        })
        if(importedDocument&&password&&typeof token==='string'&&!password.signal?.aborted){
          const unlockId=prepareImportRead(token,claimed.row,reference.sha256,importedDocument.bytes,password.password)
          if(unlockId)return {...ready,unlockId}
        }
        return ready
      } catch (error) {
        // A verified PUT receipt proves that this attempt has finished writing.
        // Preserve it for terminal reclamation without publishing a revision or
        // bypassing the original credential. Ambiguous PUT failures stay fenced.
        if (completedSha) await run(token, 'files:write', async (connection, principal) => {
          await lockAccount(connection, principal)
          const row = (await connection.query<Upload & { completed_file_id: string | null }>(
            'SELECT * FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE', [...scope(principal),id])).rows[0]
          if (!row || (principal.job ? row.job_id !== principal.job.id || Number(row.job_epoch) !== principal.job.epoch : row.job_id !== null)) throw authError(404)
          assertDshUpload(principal,row)
          if (row.auth_version !== principal.authVersion || (row.kind === 'revision' && row.session_id !== principal.sessionId)) throw authError(409)
          if (row.attempt_id !== attempt || row.sha256 !== null || row.completed_file_id !== null) return
          if (row.state === 'receiving') {
            const charged = await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes-$3,stored_bytes=stored_bytes+$3 WHERE deployment_id=$1 AND owner_id=$2 AND reserved_bytes>=$3', [...scope(principal),row.expected_size])
            if (charged.rowCount !== 1) throw authError(503)
          } else if (row.state !== 'expired') return
          await connection.query("UPDATE uploads SET state=CASE WHEN state='receiving' THEN 'cancelled' ELSE state END,sha256=$4 WHERE deployment_id=$1 AND owner_id=$2 AND id=$3", [...scope(principal),id,completedSha])
        }).catch(() => {})
        if (!published) await run(token, 'files:write', async (connection, principal) => {
          await lockAccount(connection, principal)
          // This is proof of *no* publication, not permission to publish an
          // expired upload. Preserve all credential bindings, but allow expiry
          // cleanup after lockAccount has moved the reservation to stored bytes.
          const row = (await connection.query<Upload & { completed_file_id: string | null }>(
            'SELECT * FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE', [...scope(principal),id])).rows[0]
          if (!row || (principal.job ? row.job_id !== principal.job.id || Number(row.job_epoch) !== principal.job.epoch : row.job_id !== null)) throw authError(404)
          assertDshUpload(principal,row)
          if (row.auth_version !== principal.authVersion || (row.kind === 'revision' && row.session_id !== principal.sessionId)) throw authError(409)
          if (row.attempt_id !== attempt || row.sha256 !== null || row.completed_file_id !== null) return
          if (row.state === 'receiving') await releaseReservation(connection, principal, row, 'cancelled')
          else if (row.state === 'expired') {
            const credited = await connection.query('UPDATE storage_accounts SET stored_bytes=stored_bytes-$3 WHERE deployment_id=$1 AND owner_id=$2 AND stored_bytes>=$3', [...scope(principal),row.expected_size])
            if (credited.rowCount !== 1) throw authError(503)
          } else return
          // Same-attempt pre-PUT failure is terminal proof. Clearing it and
          // crediting accounting commit together; retries cannot double credit.
          await connection.query('UPDATE uploads SET attempt_id=NULL WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',[...scope(principal),id])
        }).catch(() => {}) // Revoked authority may not mutate cleanup state; TTL later releases it.
        throw error
      }
    },
    async createBlankPdf(token: string) {
      const pdf = await PDFDocument.create()
      pdf.addPage(PageSizes.A4)
      const bytes = Buffer.from(await pdf.save({useObjectStreams:false}))
      const {uploadId} = await service.stageUpload(token, {name:'未命名.pdf',size:bytes.length})
      try {
        await service.receiveUpload(token,uploadId,bytes)
        return await service.finishUpload(token,uploadId,undefined,{blankPdf:true})
      } catch (error) {
        await service.cancelUpload(token,uploadId).catch(() => {})
        throw error
      }
    },
    async prepareDuplicate(token: FileCredential, fileId: string) {
      const source = await personal(token,'files:write',async (connection,principal) => {
        const row = await loadFile(connection,principal,uuid(fileId))
        const bytes = await objects.readVerified({key:row.object_key,size:row.size,sha256:row.sha256})
        return {row,bytes}
      })
      const {uploadId} = await service.stageUpload(token,{name:source.row.name,size:source.row.size})
      try {
        const format=source.row.format
        const protectedCopy = source.row.office_password_protected && (format==='docx'||format==='xlsx') ? {
          [verifiedOfficeCopy]: {
            format, sha256: source.row.sha256, size: source.row.size,
            officeSignatureProtected: await signatureProtected(source.row),
          },
        } : undefined
        await service.receiveUpload(token,uploadId,source.bytes,protectedCopy)
        return {uploadId,revision:source.row.current_revision}
      } catch (error) {
        await service.cancelUpload(token,uploadId).catch(() => {})
        throw error
      }
    },
    async finishDuplicate(token: FileCredential, fileId: string, uploadId: string, revision: string, language: 'en' | 'zh') {
      if (language !== 'en' && language !== 'zh') throw authError(400)
      return service.finishUpload(token,uploadId,undefined,{copy:{id:uuid(fileId),revision:uuid(revision),suffix:language==='en'?'Copy':'副本'}})
    },
    async finishUpload(token: FileCredential, uploadId: string, authorize?: (connection: PoolClient, principal: BusinessPrincipal) => Promise<void>, options: {blankPdf?: boolean;copy?:{id:string;revision:string;suffix:string}} = {}) {
      const id = uuid(uploadId)
      return personal(token, 'files:write', async (connection, principal) => {
        await authorize?.(connection, principal)
        await lockAccount(connection, principal)
        const row = await lockUpload(connection, principal, id)
        if (row.kind !== 'import') throw authError(409)
        if (row.state === 'committed') {
          const file = await loadFile(connection,principal,row.file_id)
          return openResult({ ...file, current_revision: row.revision_id, object_key:objectKey(principal,row.revision_id), sha256: row.sha256!, size: row.expected_size, office_signature_protected:row.office_signature_protected, office_password_protected:row.office_password_protected })
        }
        if (row.state !== 'ready' || !row.sha256) throw authError(409)
        let name = row.name, folderId: string | null = null
        if (options.copy) {
          const {id:sourceId,revision,suffix} = options.copy
          const source = await loadFile(connection,principal,sourceId)
          if (source.current_revision !== revision || source.sha256 !== row.sha256 || source.format !== row.format || source.size !== row.expected_size) throw authError(409)
          folderId = (await connection.query<{folder_id:string|null}>(
            'SELECT folder_id FROM workspace_file_state WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 FOR SHARE',
            [...scope(principal),sourceId],
          )).rows[0]?.folder_id ?? null
          const dot = source.name.lastIndexOf('.'), stem = source.name.slice(0,dot), extension = source.name.slice(dot)
          const prefix = fitCopyStem(stem,` ${suffix} ${Number.MAX_SAFE_INTEGER}${extension}`)
          const names = (await connection.query<{name:string}>(`SELECT f.name FROM files f
            LEFT JOIN workspace_file_state s ON s.deployment_id=f.deployment_id AND s.owner_id=f.owner_id AND s.file_id=f.id
            WHERE f.deployment_id=$1 AND f.owner_id=$2 AND f.deleted_at IS NULL AND f.purge_started_at IS NULL
              AND s.folder_id IS NOT DISTINCT FROM $3::uuid AND starts_with(f.name,$4)`,
            [...scope(principal),folderId,prefix],
          )).rows
          const occupied = new Set(names.map(item=>item.name))
          for (let index = 1; ;index++) {
            const ending = ` ${suffix}${index===1?'':` ${index}`}${extension}`
            name = fitCopyStem(stem,ending)+ending
            if (!occupied.has(name)) break
          }
        }
        await objects.verifyObject({ key: objectKey(principal,row.revision_id), size: row.expected_size, sha256: row.sha256 })
        await connection.query('INSERT INTO files(id,deployment_id,owner_id,workspace_id,name,format,current_revision,pdf_auto_name_pending,auto_name_pending) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [row.file_id,...scope(principal),row.workspace_id,name,row.format,row.revision_id,options.blankPdf===true,row.auto_name_pending])
        if (options.copy) await connection.query(
          'INSERT INTO workspace_file_state(deployment_id,owner_id,workspace_id,file_id,folder_id,last_opened_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())',
          [...scope(principal),row.workspace_id,row.file_id,folderId],
        )
        await connection.query('INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size,office_signature_protected,office_password_protected) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [row.revision_id,...scope(principal),row.file_id,objectKey(principal,row.revision_id),row.sha256,row.expected_size,row.office_signature_protected,row.office_password_protected])
        await connection.query("UPDATE uploads SET state='committed',completed_file_id=file_id WHERE deployment_id=$1 AND owner_id=$2 AND id=$3", [...scope(principal),id])
        await connection.query('UPDATE storage_accounts SET reserved_bytes=reserved_bytes-$3,stored_bytes=stored_bytes+$3 WHERE deployment_id=$1 AND owner_id=$2', [...scope(principal),row.expected_size])
        const result = await openResult(await loadFile(connection, principal, row.file_id))
        // A locked row does not freeze time. Recheck after object I/O and all
        // metadata writes; an expired initial finish rolls the whole txn back.
        await lockUpload(connection, principal, id, true)
        await authorize?.(connection, principal)
        return result
      })
    },
    purgeFile: (token: FileCredential, fileId: string) => purgeFile(transactions,objects,token,fileId),
    async cancelUpload(token: FileCredential, uploadId: string) {
      const id = uuid(uploadId)
      return run(token, 'files:write', async (connection, principal) => {
        await lockAccount(connection, principal)
        const row = await lockUpload(connection, principal, id)
        if (row.state === 'cancelled') return
        if (row.state === 'committed' || row.state === 'receiving') throw authError(409)
        if (row.state === 'staged' || row.state === 'ready') await releaseReservation(connection, principal, row, 'cancelled')
      })
    },
    syncAssistantChat:(token:string,fileId:string,input:Parameters<typeof syncFileAssistantChat>[3])=>syncFileAssistantChat(transactions,token,fileId,input),
    openFile: (token: FileCredential, fileId: string) => run(token, 'files:read', async (connection, principal) => openResult(await loadFile(connection, principal, uuid(fileId)))),
    async openProtectedDocument(token:string,fileId:string,revision:string,password:string,signal?:AbortSignal,editorId?:string) {
      const file=await authorizeProtectedDocument(token,fileId,revision)
      const bytes=await objects.readVerified({key:file.object_key,size:file.size,sha256:file.sha256},signal)
      const opened=await workbookPasswords.open(bytes,password,signal,'docx')
      const current=await authorizeProtectedDocument(token,fileId,revision)
      signal?.throwIfAborted()
      if(current.sha256!==opened.file.sha256||current.size!==opened.file.size)throw authError(409)
      return {bytes:opened.bytes,editId:documentEdits.open(token,current,editorId,password)}
    },
    async claimDocumentImportRead(token:string,fileId:string,revision:string,unlockId:string,signal?:AbortSignal,editorId?:string){
      const current=await authorizeProtectedDocument(token,fileId,revision)
      signal?.throwIfAborted()
      const grant=requireImportRead(token,current.id,current.current_revision,unlockId)
      if(current.sha256!==grant.sha256)throw authError(409)
      // Check and consume together so concurrent claims cannot both read the payload.
      const editId=documentEdits.open(token,current,editorId,grant.password)
      removeImportRead(uuid(unlockId))
      return {bytes:grant.bytes,editId}
    },
    closeDocumentEdit:documentEdits.close,
    assertPreparedDocumentRevision:documentEdits.assertPrepared,
    async sealDocumentRecovery(token:string,fileId:string,editorId:string,unlockId:string,bytes:Buffer,signal?:AbortSignal){
      const editor=uuid(editorId),id=uuid(fileId)
      const authorize=()=>personal(token,'files:read',async(connection,principal)=>{
        const file=await loadFile(connection,principal,id)
        if(file.format!=='docx')throw authError(415)
        signal?.throwIfAborted()
        // The snapshot belongs to the tab that unlocked the file. A peer save
        // or a lost commit response can advance the head without replacing that draft.
        return documentEdits.recoveryGrant(token,file.id,editor,unlockId)
      })
      const grant=await authorize()
      const sealed=await workbookPasswords.seal(bytes,grant.password,signal,'docx')
      if(await authorize()!==grant)throw authError(423)
      return sealed.bytes
    },
    async sealDocumentRevision(token:string,fileId:string,revision:string,editorId:string,unlockId:string,bytes:Buffer,signal?:AbortSignal){
      const {sealed,grant,recheck}=await sealDocumentDraft(token,fileId,revision,editorId,unlockId,bytes,signal)
      return {...sealed,async rememberSave(){
        await recheck()
        documentEdits.remember(grant,sealed.file.sha256)
      }}
    },
    async prepareDocumentPassword(token:string,fileId:string,revision:string,editorId:string,newPassword:string,unlockId:string|undefined,bytes:Buffer,signal?:AbortSignal){
      const authorize=()=>personal(token,'files:write',async(connection,principal)=>{
        const file=await loadFile(connection,principal,uuid(fileId))
        const grant=await documentDraftGrant(token,file,revision,editorId,unlockId)
        if(!newPassword&&!grant)throw authError(409)
        signal?.throwIfAborted()
        return grant
      })
      const grant=await authorize()
      const sealed=newPassword?await workbookPasswords.seal(bytes,newPassword,signal,'docx'):undefined
      return {sealed,async rememberChange(sha256:string){
        if(await authorize()!==grant)throw authError(423)
        if(grant)documentEdits.remember(grant,sha256,true)
      }}
    },
    async prepareDocumentDraftCopy(token:string,fileId:string,input:{name:string;baseRevision:string;editorId:string;leaseEpoch:number},unlockId:string|undefined,bytes:Buffer,password:string|undefined,signal?:AbortSignal){
      if(validateFileName(input.name)!=='docx')throw authError(415)
      const id=uuid(fileId),editor=uuid(input.editorId)
      const authorize=()=>personal(token,'files:write',async(connection,principal)=>{
        const file=await loadFile(connection,principal,id)
        const grant=await documentDraftGrant(token,file,input.baseRevision,editor,unlockId)
        if(password===undefined&&!grant)throw authError(423)
        await assertLiveLease(connection,principal,id,input.leaseEpoch,editor)
        signal?.throwIfAborted()
        return grant
      })
      const grant=await authorize()
      const copyPassword=password??grant?.password
      const sealed=copyPassword?await workbookPasswords.seal(bytes,copyPassword,signal,'docx'):undefined
      const {uploadId}=await service.stageUpload(token,{name:input.name,size:sealed?.bytes.length??bytes.length})
      try{
        await service.receiveUpload(token,uploadId,sealed?.bytes??bytes,sealed?{[verifiedOfficeCopy]:sealed.file}:undefined)
        if(await authorize()!==grant)throw authError(423)
        return {uploadId}
      }catch(error){
        await service.cancelUpload(token,uploadId).catch(()=>{})
        throw error
      }
    },
    revokeDocumentImportRead(token:string,fileId:string,revision:string,unlockId:string){
      requireImportRead(token,uuid(fileId),uuid(revision),unlockId)
      removeImportRead(uuid(unlockId))
    },
    assertReadableRevision: (token: OfficeReadCredential, fileId: string, revision: string, signal: AbortSignal) =>
      readRevision(token, fileId, revision, async (connection, principal) => {
        signal.throwIfAborted()
        await requireReadableRevision(connection, principal, fileId, revision)
      }),
    download: (token: OfficeReadCredential, fileId: string, revision: string, maxBytes?: number, signal?: AbortSignal) => readRevision(token, fileId, revision, async (connection, principal) => {
      signal?.throwIfAborted()
      const { file, reference } = await requireReadableRevision(connection, principal, fileId, revision)
      if (maxBytes !== undefined && reference.size > maxBytes) throw authError(413)
      signal?.throwIfAborted()
      const bytes = await objects.readVerified({ key: reference.object_key, size: reference.size, sha256: reference.sha256 }, signal)
      return { bytes, name: file.name, format: file.format, ...(reference.office_password_protected && file.format==='xlsx' ? {workbookPasswordProtected:true as const} : {}) }
    }),
    async readFile(token: FileCredential, fileId: string, revision: string, signal?: AbortSignal): Promise<Buffer> { return (await service.download(token,fileId,revision,undefined,signal)).bytes },
    listFiles: async (token: FileCredential, { trash = false, cursor, limit = 50 }: { trash?: boolean; cursor?: string; limit?: number } = {}) => {
      if (typeof trash !== 'boolean' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw authError(400)
      const after = cursor === undefined ? null : uuid(cursor)
      return personal(token, 'files:read', async (connection, principal) => {
        const result = await connection.query<FileRow>('SELECT f.*,r.size,r.sha256 FROM files f JOIN file_revisions r ON r.deployment_id=f.deployment_id AND r.owner_id=f.owner_id AND r.file_id=f.id AND r.id=f.current_revision WHERE f.deployment_id=$1 AND f.owner_id=$2 AND f.purge_started_at IS NULL AND (f.deleted_at IS NOT NULL)=$3 AND ($4::uuid IS NULL OR f.id>$4) ORDER BY f.id LIMIT $5', [...scope(principal),trash,after,limit + 1])
        return { files: result.rows.slice(0,limit).map(fileDto), nextCursor: result.rows.length > limit ? result.rows[limit - 1].id : null }
      })
    },
    async renameFile(token: FileCredential, fileId: string, name: string) {
      const format = validateFileName(name), id = uuid(fileId)
      return personal(token, 'files:write', async (connection, principal) => {
        const row = await loadFile(connection, principal, id, false, 'UPDATE')
        if (format !== row.format) throw authError(400)
        await connection.query('UPDATE files SET name=$4,pdf_auto_name_pending=false,auto_name_pending=false,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),id,name])
      })
    },
    async nameBlankFile(token:FileCredential,fileId:string,revision:string,candidate:string){
      const id=uuid(fileId),rev=uuid(revision)
      // eslint-disable-next-line no-control-regex -- generated filenames must not contain control characters
      const stem=candidate.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().replace(/^\.+|\.+$/g,'').trim()
      if(!stem)return {renamed:false as const}
      return personal(token,'files:write',async(connection,principal)=>{
        await lockAccount(connection,principal)
        const row=await loadFile(connection,principal,id,false,'UPDATE')
        if(!row.auto_name_pending||row.current_revision!==rev||row.name!=='未命名.'+row.format)return {renamed:false as const}
        const original=await connection.query("SELECT 1 FROM file_revisions WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND id=$4 AND source='save'",[...scope(principal),id,rev])
        if(!original.rowCount)return {renamed:false as const}
        const names=new Set((await connection.query<{name:string}>('SELECT name FROM files WHERE deployment_id=$1 AND owner_id=$2 AND deleted_at IS NULL AND id<>$3',[...scope(principal),id])).rows.map(file=>file.name.toLowerCase()))
        const base=Array.from(stem.replace(new RegExp('\\.'+row.format+'$','i'),'')).slice(0,40).join('').trim().replace(/\.+$/g,'').trim()
        if(!base)return {renamed:false as const}
        let name=base+'.'+row.format
        if(name===row.name)return {renamed:false as const}
        for(let i=2;names.has(name.toLowerCase());i++)name=base+'-'+i+'.'+row.format
        try{validateFileName(name)}catch{return {renamed:false as const}}
        await connection.query('UPDATE files SET name=$4,auto_name_pending=false,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',[...scope(principal),id,name])
        return {renamed:true as const,name}
      })
    },
    trashBatch: (token: FileCredential, fileIds: string[], inspectOnly = false) =>
      personal(token, inspectOnly ? 'files:read' : 'files:write', async (connection, principal) => {
        const ids = [...new Set(fileIds.map(uuid))]
        const args = [...scope(principal), ids]
        const rows = await connection.query<{id: string; deleted_at: Date | null}>(
          `SELECT id, deleted_at FROM files WHERE deployment_id=$1 AND owner_id=$2
           AND id=ANY($3::uuid[]) AND purge_started_at IS NULL ORDER BY id
           ${inspectOnly ? '' : 'FOR UPDATE'}`, args)
        if (rows.rowCount !== ids.length) throw authError(404)
        const active = rows.rows.filter(row => !row.deleted_at).map(row => row.id)
        if (!inspectOnly && active.length) {
          const targets = [...scope(principal), active]
          await connection.query('UPDATE edit_leases SET lease_epoch=lease_epoch+1,expires_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND file_id=ANY($3::uuid[])', targets)
          await connection.query('UPDATE files SET deleted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=ANY($3::uuid[])', targets)
        }
        return { active: inspectOnly ? active : [] }
      }),
    trashFile: (token: FileCredential, fileId: string) => personal(token, 'files:write', async (connection, principal) => {
      const id = uuid(fileId)
      await loadFile(connection, principal, id, true, 'UPDATE')
      await connection.query('UPDATE edit_leases SET lease_epoch=lease_epoch+1,expires_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3', [...scope(principal),id])
      await connection.query('UPDATE files SET deleted_at=COALESCE(deleted_at,clock_timestamp()),updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),id])
    }),
    restoreFile: (token: FileCredential, fileId: string) => personal(token, 'files:write', async (connection, principal) => {
      const id = uuid(fileId)
      await loadFile(connection, principal, id, true, 'UPDATE')
      await connection.query('UPDATE files SET deleted_at=NULL,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3', [...scope(principal),id])
    }),
    usage: (token: FileCredential) => personal(token, 'files:read', async (connection, principal) => {
      const account = await lockAccount(connection, principal)
      return { reservedBytes: account.reservedBytes, storedBytes: account.storedBytes, quotaBytes }
    }),
  }
  return service
}
export type FileService = ReturnType<typeof createFileService>
