import { approvedSaveResultSchema, createApprovedOfficeSave, type ApprovedSaveOptions } from './approved-save.ts'
import type { McpExternalCredential } from './credential.ts'
import type { ToolDescriptor } from '../../../../../../packages/web-contracts/src/tools.ts'
import { createPdfSavePreparation } from '../../pdf/save-preparation.mjs'
import { createIsolatedPdfPageOpsJob } from '../../pdf/page-ops-isolated.mjs'
import { authError } from '../auth/sessions.ts'
import { uuid } from '../files/queries.ts'
import { officeReadDescriptor } from './office-read.ts'

const { fileId, revision } = officeReadDescriptor.inputSchema.properties

export const pdfRotationDescriptor = {
  name: 'rotate_pdf_pages',
  schemaVersion: 1,
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['fileId', 'revision', 'pages', 'degrees'],
    properties: {
      fileId, revision,
      pages: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 100 } },
      degrees: { type: 'integer', enum: [-90, 90, 180] },
    },
  },
  outputSchema: approvedSaveResultSchema,
  effect: 'document_write',
  executionMode: 'headless',
  requiresActiveEditor: false,
  requiredScopes: ['files:write'],
  maxDurationMs: 45_000,
} satisfies ToolDescriptor

export function parsePdfRotation(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4) throw authError(400)
  const input = value as Record<string, unknown>
  const { pages, degrees } = input
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 100 || new Set(pages).size !== pages.length ||
    pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > 100) ||
    (degrees !== -90 && degrees !== 90 && degrees !== 180)) throw authError(400)
  return { fileId: uuid(input.fileId as string), revision: uuid(input.revision as string), pages: [...pages].sort((a, b) => a - b), degrees }
}

export function createMcpPdfRotation(options: ApprovedSaveOptions) {
  const processor = createIsolatedPdfPageOpsJob()
  const save = createApprovedOfficeSave(options)
  return async (credential: McpExternalCredential, args: unknown, signal: AbortSignal) => {
    const { fileId, revision, pages, degrees } = parsePdfRotation(args)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(pdfRotationDescriptor.maxDurationMs)])
    return save(credential, { fileId, revision }, { kind: 'pdf.rotate', pages, degrees }, deadline, async input => {
      const { files, leases, revisions, token, fileId, baseRevision, editorId, leaseEpoch, idempotencyKey, signal } = input
      const preparation = createPdfSavePreparation({ files, leases, revisions, processor })
      const staged = await preparation.prepare({
        token, fileId, baseRevision, editorId, leaseEpoch, idempotencyKey,
        request: JSON.stringify({ version: 1, action: 'pageOps', operations: [{ op: 'rotatePages', pages, dir: degrees }] }),
      }, { signal })
      return { uploadId: staged.commitInput.uploadId }
    })
  }
}
