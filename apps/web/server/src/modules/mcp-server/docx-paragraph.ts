import { Worker } from 'node:worker_threads'
import type { ToolDescriptor } from '../../../../../../packages/web-contracts/src/tools.ts'
import { DOCUMENT_READ_MAX_BYTES } from '../assistant-channel/background-read.ts'
import { authError } from '../auth/sessions.ts'
import { uuid } from '../files/queries.ts'
import { approvedSaveResultSchema, createApprovedOfficeSave, type ApprovedSaveOptions } from './approved-save.ts'
import type { McpExternalCredential } from './credential.ts'
import { officeReadDescriptor } from './office-read.ts'

const { fileId, revision } = officeReadDescriptor.inputSchema.properties
const maxText = 2_000
const invalidText = /[\u0000-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u

export const docxParagraphDescriptor = {
  name: 'replace_docx_paragraph_text',
  schemaVersion: 1,
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['fileId', 'revision', 'docxIndex', 'expectedText', 'replacement'],
    properties: {
      fileId, revision,
      docxIndex: { type: 'integer', minimum: 0, description: 'Zero-based native body element index in the approved DOCX revision' },
      expectedText: { type: 'string', minLength: 1, maxLength: maxText, description: 'Exact current text of the approved paragraph' },
      replacement: { type: 'string', maxLength: maxText, description: 'Complete replacement text for that paragraph' },
    },
  },
  outputSchema: approvedSaveResultSchema,
  effect: 'document_write',
  executionMode: 'headless',
  requiresActiveEditor: false,
  requiredScopes: ['files:write'],
  maxDurationMs: 45_000,
} satisfies ToolDescriptor

export function parseDocxParagraph(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5) throw authError(400)
  const { fileId, revision, docxIndex, expectedText, replacement } = value as Record<string, unknown>
  if (typeof docxIndex !== 'number' || !Number.isSafeInteger(docxIndex) || docxIndex < 0 ||
    typeof expectedText !== 'string' || !expectedText.length || expectedText.length > maxText || invalidText.test(expectedText) ||
    typeof replacement !== 'string' || replacement.length > maxText || invalidText.test(replacement) || expectedText === replacement) throw authError(400)
  return { fileId: uuid(fileId as string), revision: uuid(revision as string), docxIndex: docxIndex || 0, expectedText, replacement }
}

function runReplacement(bytes: Uint8Array, edit: Omit<ReturnType<typeof parseDocxParagraph>, 'fileId' | 'revision'>, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./docx-paragraph-worker.ts', import.meta.url), {
      workerData: { bytes, edit }, resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    const abort = () => { void worker.terminate() }
    let output: Uint8Array | undefined
    worker.once('message', result => {
      if (result?.bytes instanceof Uint8Array && result.bytes.length <= DOCUMENT_READ_MAX_BYTES) output = result.bytes
      void worker.terminate()
    })
    worker.once('error', () => { void worker.terminate() })
    worker.once('exit', () => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (!output?.length) reject(authError(422))
      else resolve(output)
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

export function createMcpDocxParagraph(options: ApprovedSaveOptions) {
  const save = createApprovedOfficeSave(options)
  let active = 0
  return async (credential: McpExternalCredential, args: unknown, signal: AbortSignal) => {
    const { fileId, revision, ...edit } = parseDocxParagraph(args)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(docxParagraphDescriptor.maxDurationMs)])
    return save(credential, { fileId, revision }, { kind: 'docx.paragraph', ...edit }, deadline, async input => {
      if (active >= 2) throw authError(429)
      active++
      const { files, leases, revisions, token, fileId, baseRevision, editorId, leaseEpoch, signal } = input
      let uploadId: string | undefined
      try {
        const source = await files.download(token, fileId, baseRevision, DOCUMENT_READ_MAX_BYTES, signal)
        if (source.format !== 'docx') throw authError(415)
        await leases.renewLease(token, fileId, { editorId, leaseEpoch })
        const bytes = await runReplacement(source.bytes, edit, signal)
        signal.throwIfAborted()
        const staged = await revisions.stageUpload(token, fileId, { size: bytes.length, baseRevision, leaseEpoch, editorId })
        uploadId = staged.uploadId
        await files.receiveUpload(token, uploadId, Buffer.from(bytes))
        signal.throwIfAborted()
        return { uploadId }
      } catch (error) {
        if (uploadId) await files.cancelUpload(token, uploadId).catch(() => {})
        throw error
      } finally {
        active--
      }
    })
  }
}
