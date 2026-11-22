import type { ToolDescriptor } from '../../../../../../packages/web-contracts/src/tools.ts'
import { authError } from '../auth/sessions.ts'
import { uuid } from '../files/queries.ts'
import { createSlidesSaveService } from '../slides/save.ts'
import { createSlidesService, type SlidesSessionHost } from '../slides/service.ts'
import { approvedSaveResultSchema, createApprovedOfficeSave, type ApprovedSaveOptions } from './approved-save.ts'
import type { McpExternalCredential } from './credential.ts'
import { officeReadDescriptor } from './office-read.ts'

const { fileId, revision } = officeReadDescriptor.inputSchema.properties
const maxText = 2_000
// Notes XML accepts tabs and LF. Reject characters that XML or JSONB cannot store faithfully.
const invalidText = /[\u0000-\u0008\u000B-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u

export const pptxNotesDescriptor = {
  name: 'set_pptx_notes',
  schemaVersion: 1,
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['fileId', 'revision', 'slide', 'text'],
    properties: {
      fileId, revision,
      slide: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Zero-based slide index in the approved revision' },
      text: { type: 'string', maxLength: maxText, description: 'Replacement notes with LF between lines. Omit trailing line breaks. Use an empty string to clear.' },
    },
  },
  outputSchema: approvedSaveResultSchema,
  effect: 'document_write',
  executionMode: 'headless',
  requiresActiveEditor: false,
  requiredScopes: ['files:write'],
  maxDurationMs: 45_000,
} satisfies ToolDescriptor

export function parsePptxNotes(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4) throw authError(400)
  const { fileId, revision, slide, text } = value as Record<string, unknown>
  if (typeof slide !== 'number' || !Number.isSafeInteger(slide) || slide < 0 ||
    typeof text !== 'string' || text.length > maxText || text.endsWith('\n') || invalidText.test(text)) throw authError(400)
  return { fileId: uuid(fileId as string), revision: uuid(revision as string), slide: slide || 0, text }
}

export function createMcpPptxNotes(options: ApprovedSaveOptions, host: SlidesSessionHost) {
  const save = createApprovedOfficeSave(options)
  let active = 0
  return async (credential: McpExternalCredential, args: unknown, signal: AbortSignal) => {
    const { fileId, revision, slide, text } = parsePptxNotes(args)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(pptxNotesDescriptor.maxDurationMs)])
    return save(credential, { fileId, revision }, { kind: 'pptx.notes', slide, text }, deadline, async input => {
      if (active >= 2) throw authError(429)
      active++
      const { files, leases, revisions, token, fileId, baseRevision, editorId, leaseEpoch, signal } = input
      let cancelSession: (() => void) | undefined
      const sessions = createSlidesService({ files, leases, revisions, host: {
        async openSession(source) {
          const handle = await host.openSession(source, signal)
          // This private draft never needs browser-style generation reconciliation.
          cancelSession = () => handle.close()
          signal.addEventListener('abort', cancelSession, { once: true })
          if (signal.aborted) {
            cancelSession()
            signal.throwIfAborted()
          }
          return handle
        },
      } })
      const authority = { revision: baseRevision, editorId, leaseEpoch }
      try {
        const opened = await sessions.openOutline(token, fileId, { ...authority, generation: 0 }, signal)
        if (slide >= opened.count) throw authError(400)
        const result = await sessions.apply(token, fileId, {
          ...authority, generation: opened.generation, isolation: 'atomic',
          ops: [{ op: 'setNotes', target: { slide }, text }],
        }, signal)
        if (!result.transaction.applied) throw authError(409)
        const verified = await sessions.notes(token, fileId, { ...authority, generation: result.generation, index: slide }, signal)
        if (verified.text !== text) throw authError(409)
        const preparation = createSlidesSaveService({ files, leases, revisions, sessions })
        return await preparation.prepare(token, fileId, {
          baseRevision, editorId, leaseEpoch, request: { revision: baseRevision, generation: result.generation },
        }, signal)
      } finally {
        if (cancelSession) signal.removeEventListener('abort', cancelSession)
        sessions.dispose()
        active--
      }
    })
  }
}
