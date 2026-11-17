import { createHash } from 'node:crypto'
import type { FileService } from '../files/service.ts'
import type { LeaseService } from '../leases/service.ts'
import type { RevisionService } from '../revisions/service.ts'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import { authError } from '../auth/sessions.ts'
import type { SlidesSessions } from './service.ts'

export interface SlidesSaveInput { baseRevision: string; leaseEpoch: number; editorId: string; request: { revision: string; generation: number } }

/** Prepare the normal T06 upload from the live slides session export. The browser then
 * commits it with the same idempotent receipt/reconciliation protocol as the other editors.
 * No PPTX parsing or writing happens here: bytes come from the existing session host
 * contract. This consistency boundary does not certify OS isolation or enable a runtime. */
export function createSlidesSaveService({ files, leases, revisions, sessions, maxConcurrent = 2 }: {
  files: FileService; leases: LeaseService; revisions: RevisionService; sessions: SlidesSessions; maxConcurrent?: number
}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid slides concurrency')
  let active = 0
  return {
    async prepare(token: string, fileId: string, input: SlidesSaveInput, signal?: AbortSignal) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw authError(400)
      // Caller-owned objects must not change identity while an authority/storage await runs.
      const { baseRevision, editorId, leaseEpoch } = input
      const source = input.request
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw authError(400)
      if (Object.keys(source).some(key => !['revision','generation'].includes(key))) throw authError(400)
      const request = Object.freeze({ revision: source.revision, generation: source.generation })
      if (typeof baseRevision !== 'string' || typeof editorId !== 'string' || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) throw authError(400)
      if (typeof request.revision !== 'string' || !Number.isSafeInteger(request.generation) || request.generation < 0) throw authError(400)
      if (request.revision !== baseRevision) throw authError(409)
      if (active >= maxConcurrent) throw Object.assign(authError(429), { retryAfter: 1 })
      active++
      let uploadId: string | undefined
      try {
        signal?.throwIfAborted()
        await leases.renewLease(token, fileId, { editorId, leaseEpoch })
        const head = await files.openFile(token, fileId)
        if (head.format !== 'pptx') throw authError(415)
        if (head.file.revision !== baseRevision) throw authError(409)
        const exported = await sessions.exportForSave(token, fileId, {...request,editorId,leaseEpoch}, signal)
        signal?.throwIfAborted()
        if (exported.generation !== request.generation) throw authError(409)
        if (!Buffer.isBuffer(exported.bytes) || exported.bytes.length < 1) throw authError(503)
        if (exported.bytes.length > MAX_OBJECT_BYTES) throw authError(413)
        // One private byte snapshot supplies both receive and the returned identity.
        const bytes = Buffer.from(exported.bytes)
        const size = bytes.length, sha256 = createHash('sha256').update(bytes).digest('hex')
        // Staging checks current owner/session, head and lease again after all
        // expensive work. The ordinary commit repeats those checks atomically.
        const upload = await revisions.stageUpload(token, fileId, { size, baseRevision, leaseEpoch, editorId })
        uploadId = upload.uploadId
        const received = await files.receiveUpload(token, uploadId, bytes)
        if (!received || received.uploadId !== uploadId || received.sha256 !== sha256 || received.size !== size) throw authError(503)
        signal?.throwIfAborted()
        await leases.renewLease(token, fileId, { editorId, leaseEpoch })
        await sessions.bindPreparedUpload(token, fileId, {...request, editorId, leaseEpoch, uploadId}, signal)
        return { uploadId, baseRevision, leaseEpoch, sha256, size }
      } catch (error) {
        // Cancellation never publishes a revision. Abandoned uploads also have
        // the existing T06 expiry/sweep when revocation prevents cleanup here.
        if (uploadId) await files.cancelUpload(token, uploadId).catch(() => {})
        throw error
      } finally { active-- }
    },
  }
}
export type SlidesSaveService = ReturnType<typeof createSlidesSaveService>
