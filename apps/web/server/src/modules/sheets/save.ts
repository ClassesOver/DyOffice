import { createHash } from 'node:crypto'
import type { FileService } from '../files/service.ts'
import type { LeaseService } from '../leases/service.ts'
import type { RevisionService } from '../revisions/service.ts'
import { authError } from '../auth/sessions.ts'
import type { XlsxMutationPlan } from '../../../../worker/src/native/xlsx.ts'

export type SheetsPlanner = (bytes: Buffer, sheets: readonly { id: string; name: string }[], request: unknown, signal?: AbortSignal) => Promise<XlsxMutationPlan>
export type SheetsWorkbookPlanner = (bytes: Buffer, request: unknown, signal?: AbortSignal) => Promise<XlsxMutationPlan>
export interface SheetsSaveNative {
  inspect(input: Uint8Array, signal?: AbortSignal): Promise<unknown>
  savePlan(input: Uint8Array, plan: XlsxMutationPlan, signal?: AbortSignal): Promise<{ bytes: Buffer }>
}
export interface SheetsSaveInput { baseRevision: string; leaseEpoch: number; editorId: string; request: unknown }

/** Prepare the normal T06 upload. The browser then commits it using the same
 * idempotent receipt/reconciliation protocol used by the other editors. */
export function createSheetsSaveService({ files, leases, revisions, native, plan, planFromWorkbook, maxConcurrent = 2 }: {
  files: FileService; leases: LeaseService; revisions: RevisionService; native: SheetsSaveNative; plan: SheetsPlanner; planFromWorkbook?: SheetsWorkbookPlanner; maxConcurrent?: number
}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid sheets concurrency')
  let active = 0
  return {
    async prepare(token: string, fileId: string, input: SheetsSaveInput, signal?: AbortSignal) {
      if (active >= maxConcurrent) throw Object.assign(authError(429), { retryAfter: 1 })
      active++
      let uploadId: string | undefined
      try {
        signal?.throwIfAborted()
        await leases.renewLease(token, fileId, { editorId: input.editorId, leaseEpoch: input.leaseEpoch })
        const head = await files.openFile(token, fileId)
        if (head.format !== 'xlsx') throw authError(415)
        if (head.file.revision !== input.baseRevision) throw authError(409)
        const bytes = await files.readFile(token, fileId, input.baseRevision)
        signal?.throwIfAborted()
        let mutation: XlsxMutationPlan
        if (planFromWorkbook) {
          // Configured only for the isolated gateway. It derives the sheet map
          // and mutation from this same authorized revision's bytes in one ZIP
          // source. Never fall back after failure or trust a browser sheet map.
          mutation = await planFromWorkbook(bytes, input.request, signal)
        } else {
          const metadata = await native.inspect(bytes, signal) as { sheets: {id: string; name: string}[] }
          if (!metadata || !Array.isArray(metadata.sheets) || metadata.sheets.some(sheet => typeof sheet?.id !== 'string' || typeof sheet.name !== 'string')) throw new Error('Invalid workbook metadata')
          mutation = await plan(bytes, metadata.sheets, input.request, signal)
        }
        signal?.throwIfAborted()
        const saved = await native.savePlan(bytes, mutation, signal)
        signal?.throwIfAborted()
        // Staging checks current owner/session, head and lease again after all
        // expensive work. The ordinary commit repeats those checks atomically.
        const upload = await revisions.stageUpload(token, fileId, { size: saved.bytes.length, baseRevision: input.baseRevision, leaseEpoch: input.leaseEpoch, editorId: input.editorId })
        uploadId = upload.uploadId
        await files.receiveUpload(token, uploadId, saved.bytes)
        signal?.throwIfAborted()
        await leases.renewLease(token, fileId, { editorId: input.editorId, leaseEpoch: input.leaseEpoch })
        return { uploadId, touchedEntries: [...mutation.replaced.keys(), ...mutation.added.keys(), ...mutation.addedBinary.keys(), ...mutation.removedEntries], baseRevision: input.baseRevision, leaseEpoch: input.leaseEpoch, sha256: createHash('sha256').update(saved.bytes).digest('hex'), size: saved.bytes.length }
      } catch (error) {
        // Cancellation never publishes a revision. Abandoned uploads also have
        // the existing T06 expiry/sweep when revocation prevents cleanup here.
        if (uploadId) await files.cancelUpload(token, uploadId).catch(() => {})
        throw error
      } finally { active-- }
    },
  }
}

