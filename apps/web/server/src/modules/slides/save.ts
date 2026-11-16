import { createHash } from 'node:crypto'
import type { FileService } from '../files/service.ts'
import type { LeaseService } from '../leases/service.ts'
import type { RevisionService } from '../revisions/service.ts'
import { authError } from '../auth/sessions.ts'
import type { SlidesSessions } from './service.ts'

export interface SlidesSaveInput { baseRevision: string; leaseEpoch: number; editorId: string; request: { revision: string; generation: number } }

/** Prepare the normal T06 upload from the live slides session export. The browser then
 * commits it with the same idempotent receipt/reconciliation protocol as the other editors.
 * No PPTX parsing or writing happens in the API process: the bytes come from the session's
 * isolated child, and this service only fences, stages and receives them. */
export function createSlidesSaveService({ files, leases, revisions, sessions, maxConcurrent = 2 }: {
  files: FileService; leases: LeaseService; revisions: RevisionService; sessions: SlidesSessions; maxConcurrent?: number
}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid slides concurrency')
  let active = 0
  return {
    async prepare(token: string, fileId: string, input: SlidesSaveInput, signal?: AbortSignal) {
      const request = input.request as SlidesSaveInput['request']
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw authError(400)
      if (Object.keys(request).some(key => !['revision','generation'].includes(key))) throw authError(400)
      if (typeof request.revision !== 'string' || !Number.isSafeInteger(request.generation) || request.generation < 0) throw authError(400)
      if (active >= maxConcurrent) throw Object.assign(authError(429), { retryAfter: 1 })
      active++
      let uploadId: string | undefined
      try {
        signal?.throwIfAborted()
        await leases.renewLease(token, fileId, { editorId: input.editorId, leaseEpoch: input.leaseEpoch })
        const head = await files.openFile(token, fileId)
        if (head.format !== 'pptx') throw authError(415)
        if (head.file.revision !== input.baseRevision) throw authError(409)
        const exported = await sessions.exportForSave(token, fileId, request, signal)
        signal?.throwIfAborted()
        // Staging checks current owner/session, head and lease again after all
        // expensive work. The ordinary commit repeats those checks atomically.
        const upload = await revisions.stageUpload(token, fileId, { size: exported.bytes.length, baseRevision: input.baseRevision, leaseEpoch: input.leaseEpoch, editorId: input.editorId })
        uploadId = upload.uploadId
        await files.receiveUpload(token, uploadId, exported.bytes)
        signal?.throwIfAborted()
        await leases.renewLease(token, fileId, { editorId: input.editorId, leaseEpoch: input.leaseEpoch })
        return { uploadId, baseRevision: input.baseRevision, leaseEpoch: input.leaseEpoch, sha256: createHash('sha256').update(exported.bytes).digest('hex'), size: exported.bytes.length }
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
