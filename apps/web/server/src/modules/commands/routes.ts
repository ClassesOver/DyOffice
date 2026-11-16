import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { authError } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { uuidSchema as id, emptyQuerySchema } from '../files/http-schema.ts'
import type { createCommandService } from './service.ts'
import type { CommandUploadBinding } from './postgres-journal.ts'
import type { CommandEnvelope } from '../../../../../../packages/web-contracts/src/tools.ts'
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})
const envelopeSchema = object({
  commandId: id,
  fileId: id,
  baseRevision: id,
  editorGeneration: integer,
  leaseEpoch: { ...integer, minimum: 1 },
  argsHash: hash,
  payload: object({
    toolName: { type: 'string', minLength: 1, maxLength: 128 },
    arguments: { type: 'object' },
  }),
})
type RequestCommands = {
  service: ReturnType<typeof createCommandService>
  bindCommandUpload: (binding: CommandUploadBinding) => Promise<unknown>
}
/** Optional, trusted composition only. Never register with a provider-controlled tool
 * registry. Authentication here is not a substitute for transaction authorization. */
export function registerCommandRoutes(
  app: FastifyInstance,
  {
    sessions,
    csrf,
    createRequestCommands,
  }: {
    sessions: Pick<SessionService, 'authenticate'>
    csrf: ReturnType<typeof createCsrfService>
    createRequestCommands: (context: {
      token: string
      editorId: string
      editorGeneration: number
    }) => RequestCommands
  },
) {
  app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const credential = cookies(request).session
      if (!credential) throw authError(401)
      csrf.requireSession(request, credential)
      await sessions.authenticate(credential)
    })
    const specs = {
      propose: {},
      approve: { digest: hash },
      execute: { digest: hash },
      applied: { claimId: id, generation: integer },
      outcome: {},
      cancel: {},
      undo: {},
      undone: { claimId: id },
      bind: {
        digest: hash,
        uploadId: id,
        sha256: hash,
        size: { ...integer, minimum: 1 },
        idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
      },
    }
    for (const [action, extra] of Object.entries(specs))
      api.post(
        '/api/v1/commands/' + action,
        {
          bodyLimit: 70000,
          schema: {
            querystring: emptyQuerySchema,
            body: object({
              editorId: id,
              currentGeneration: integer,
              envelope: envelopeSchema,
              ...extra,
            }),
          },
        },
        async (request) => {
          const b = request.body as {
            editorId: string
            currentGeneration: number
            envelope: CommandEnvelope
            digest: string
            claimId: string
            generation: number
            uploadId: string
            sha256: string
            size: number
            idempotencyKey: string
          }
          const c = createRequestCommands({
              token: cookies(request).session!,
              editorId: b.editorId,
              editorGeneration: b.currentGeneration,
            }),
            s = c.service,
            e = b.envelope
          switch (action) {
            case 'propose':
              return s.proposeCommand(e)
            case 'approve':
              return s.approveCommand(e, b.digest)
            case 'execute':
              return s.beginExecution(e, b.digest)
            case 'applied':
              return s.reportApplied(e, b.claimId, b.generation)
            case 'outcome':
              return s.getCommandOutcome(e)
            case 'cancel':
              return s.cancelCommand(e)
            case 'undo':
              return s.beginUndo(e)
            case 'undone':
              return s.reportUndone(e, b.claimId)
            case 'bind':
              return c.bindCommandUpload({
                commandId: e.commandId,
                fileId: e.fileId,
                digest: b.digest,
                uploadId: b.uploadId,
                sha256: b.sha256,
                size: b.size,
                idempotencyKey: b.idempotencyKey,
              })
            default:
              throw authError(400)
          }
        },
      )
  })
}
