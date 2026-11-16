import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { authError } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { uuidSchema, emptyQuerySchema } from '../files/http-schema.ts'
import type { RecoveredCommand } from './postgres-recovery.ts'
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})
/** Optional trusted composition, deliberately absent from app.ts. Neither route
 * accepts an editor identity, envelope, execution claim or provider descriptor. */
export function registerCommandRecoveryRoutes(
  app: FastifyInstance,
  {
    sessions,
    csrf,
    createRequestRecovery,
  }: {
    sessions: Pick<SessionService, 'authenticate'>
    csrf: Pick<ReturnType<typeof createCsrfService>, 'requireSession'>
    createRequestRecovery: (token: string) => {
      lookup: (fileId: string, commandId: string) => Promise<RecoveredCommand>
      abandon: (
        fileId: string,
        commandId: string,
        observedDigest: string,
      ) => Promise<RecoveredCommand>
    }
  },
) {
  app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session
      if (!token) throw authError(401)
      csrf.requireSession(request, token)
      await sessions.authenticate(token)
    })
    for (const action of ['lookup', 'abandon'] as const)
      api.post(
        '/api/v1/command-recovery/' + action,
        {
          bodyLimit: 1024,
          schema: {
            querystring: emptyQuerySchema,
            body: object({
              fileId: uuidSchema,
              commandId: uuidSchema,
              ...(action === 'abandon' ? { observedDigest: hash } : {}),
            }),
          },
        },
        async (request) => {
          const b = request.body as { fileId: string; commandId: string; observedDigest?: string },
            service = createRequestRecovery(cookies(request).session!),
            r =
              action === 'lookup'
                ? await service.lookup(b.fileId, b.commandId)
                : await service.abandon(b.fileId, b.commandId, b.observedDigest!)
          // Even a misconfigured adapter cannot leak claims/envelopes through this route.
          return {
            fileId: r.fileId,
            commandId: r.commandId,
            digest: r.digest,
            state: r.state,
            ...(r.state === 'committed' && r.revision
              ? {
                  revision: {
                    fileId: r.revision.fileId,
                    revision: r.revision.revision,
                    sha256: r.revision.sha256,
                    size: r.revision.size,
                  },
                }
              : {}),
          }
        },
      )
  })
}
