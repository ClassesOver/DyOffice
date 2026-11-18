import { randomUUID } from 'node:crypto'
import type { createFileService } from '../files/service.ts'
import type { createLeaseService } from '../leases/service.ts'
import type { createRevisionService } from '../revisions/service.ts'
import { authError } from '../auth/sessions.ts'
import { inspectPdf } from '../../pdf/capabilities.mjs'
import { createPdfRotationJob } from '../../pdf/rotation-job.mjs'
import { createPdfSavePreparation } from '../../pdf/save-preparation.mjs'
import { validatePdfRotationOperations, type PdfRotationOperation } from '../../../../worker/src/sandbox/pdf-rotation-schema.ts'

type Files = ReturnType<typeof createFileService>
type Leases = ReturnType<typeof createLeaseService>
type Revisions = ReturnType<typeof createRevisionService>

export interface PdfUploadInput {
  baseRevision: string
  editorId: string
  leaseEpoch: number
  idempotencyKey?: string
  operations: readonly PdfRotationOperation[]
}

export function createPdfService({
  files,
  leases,
  revisions,
}: {
  files: Files
  leases: Leases
  revisions: Revisions
}) {
  const processor = createPdfRotationJob()
  const preparation = createPdfSavePreparation({ files, leases, revisions, processor })

  return {
    async inspect(token: string, fileId: string, revision: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const source = await files.download(token, fileId, revision)
      if (source.format !== 'pdf') throw authError(415)
      signal?.throwIfAborted()
      let report: Awaited<ReturnType<typeof inspectPdf>>
      try {
        report = await inspectPdf(source.bytes)
      } catch (error) {
        const code = (error as { code?: string })?.code
        throw Object.assign(authError(400), { detail: code ?? 'UNREADABLE' })
      }
      signal?.throwIfAborted()
      await files.openFile(token, fileId)
      return report
    },

    async stageRotate(token: string, fileId: string, input: PdfUploadInput, signal?: AbortSignal) {
      let operations: readonly PdfRotationOperation[]
      try {
        operations = validatePdfRotationOperations(input.operations)
      } catch {
        throw authError(400)
      }
      const idempotencyKey = input.idempotencyKey ?? randomUUID()
      const request = JSON.stringify({
        version: 1,
        action: 'rotatePages',
        operations: operations.map(op => ({ page: op.page, degrees: op.degrees })),
      })
      try {
        const prepared = await preparation.prepare(
          {
            token,
            fileId,
            baseRevision: input.baseRevision,
            editorId: input.editorId,
            leaseEpoch: input.leaseEpoch,
            idempotencyKey,
            request,
          },
          { signal },
        )
        return {
          uploadId: prepared.commitInput.uploadId,
          baseRevision: prepared.commitInput.baseRevision,
          leaseEpoch: prepared.commitInput.leaseEpoch,
          idempotencyKey: prepared.commitInput.idempotencyKey,
          sha256: prepared.sha256,
          size: prepared.size,
        }
      } catch (error) {
        if ((error as { statusCode?: number })?.statusCode) throw error
        const code = (error as { code?: string })?.code ?? ''
        if (
          [
            'MAGIC_MISMATCH',
            'PDF_EDIT_LIMIT',
            'INVALID_PDF_ROTATION',
            'PASSWORD',
            'SIGNATURE_EDIT_REFUSED',
            'PDF_EDIT_UNSUPPORTED_STRUCTURE',
            'PDF_FORMAT_REQUIRED',
          ].includes(code)
        ) {
          throw Object.assign(authError(400), { detail: code })
        }
        throw Object.assign(authError(500), { detail: code || 'PDF_PREPARE_FAILED' })
      }
    },

    async rotateAndCommit(token: string, fileId: string, input: PdfUploadInput, signal?: AbortSignal) {
      const staged = await this.stageRotate(token, fileId, input, signal)
      return revisions.commitRevision(token, {
        fileId,
        uploadId: staged.uploadId,
        baseRevision: staged.baseRevision,
        leaseEpoch: staged.leaseEpoch,
        idempotencyKey: staged.idempotencyKey,
      })
    },
  }
}
