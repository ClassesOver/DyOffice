import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { uuidSchema, fileParamsSchema, emptyQuerySchema } from '../files/http-schema.ts'
import type { createPdfService, PdfUploadInput } from './service.ts'

type PdfService = ReturnType<typeof createPdfService>

const operationsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['page', 'degrees'],
    properties: {
      page: { type: 'integer', minimum: 1, maximum: 100 },
      degrees: { type: 'integer', multipleOf: 90 },
    },
  },
}

const mutationProperties = {
  baseRevision: uuidSchema,
  editorId: uuidSchema,
  leaseEpoch: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
  operations: operationsSchema,
}

export function registerPdfRoutes(
  app: FastifyInstance,
  pdf: PdfService,
  sessions: SessionService,
  csrf: ReturnType<typeof createCsrfService>,
) {
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.originCheck(request, true)
      csrf.requireSession(request, token)
      await sessions.authenticate(token)
    })

    api.post(
      '/api/v1/files/:id/pdf/inspect',
      {
        bodyLimit: 4096,
        schema: {
          params: fileParamsSchema,
          querystring: emptyQuerySchema,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['revision'],
            properties: { revision: uuidSchema },
          },
        },
      },
      async request => {
        const token = cookies(request).session ?? ''
        const fileId = (request.params as { id: string }).id
        const { revision } = request.body as { revision: string }
        return pdf.inspect(token, fileId, revision)
      },
    )

    api.post(
      '/api/v1/files/:id/pdf/uploads',
      {
        bodyLimit: 65536,
        schema: {
          params: fileParamsSchema,
          querystring: emptyQuerySchema,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['baseRevision', 'editorId', 'leaseEpoch', 'operations'],
            properties: mutationProperties,
          },
        },
      },
      async request => {
        const token = cookies(request).session ?? ''
        const fileId = (request.params as { id: string }).id
        return pdf.stageRotate(token, fileId, request.body as PdfUploadInput)
      },
    )

    api.post(
      '/api/v1/files/:id/pdf/rotate',
      {
        bodyLimit: 65536,
        schema: {
          params: fileParamsSchema,
          querystring: emptyQuerySchema,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['baseRevision', 'editorId', 'leaseEpoch', 'operations'],
            properties: mutationProperties,
          },
        },
      },
      async request => {
        const token = cookies(request).session ?? ''
        const fileId = (request.params as { id: string }).id
        return pdf.rotateAndCommit(token, fileId, request.body as PdfUploadInput)
      },
    )
  })
}
