import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { authError } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import type { createJobService } from './service.ts'
import { uuidSchema as id,fileParamsSchema as params,emptyQuerySchema as querystring } from '../files/http-schema.ts'
const object = (properties: object,required = Object.keys(properties)) => ({ type: 'object',additionalProperties: false,required,properties })
const nullable = (value: object) => ({ anyOf: [value,{ type: 'null' }] })
const timestamp = { type: 'string',maxLength: 40 }
const jobSchema = object({ id,type: { type: 'string',pattern: '^(docx|xlsx|pptx|pdf)\\.[a-z][a-z0-9_]{0,31}$' },artifactId: id,fileId: id,
  state: { type: 'string',enum: ['queued','running','succeeded','failed','cancelled'] },attempts: { type: 'integer',minimum: 0,maximum: 10 },
  errorCode: nullable({ type: 'string',enum: ['CANCELLED','AUTH_REVOKED','TIMEOUT','WORKER_FAILED','ATTEMPTS_EXHAUSTED','STALE_BASE','NATIVE_FAILED','RESOURCE_LIMIT'] }),
  resultRevision: nullable(id),createdAt: timestamp,deadlineAt: timestamp,finishedAt: nullable(timestamp),
})
export function registerJobRoutes(app: FastifyInstance,jobs: ReturnType<typeof createJobService>,sessions: SessionService,csrf: ReturnType<typeof createCsrfService>) {
  app.register(async api => {
    api.addHook('onRequest',async (request,reply) => {
      reply.header('Cache-Control','private, no-store')
      const token = cookies(request).session ?? ''
      if (!token) throw authError()
      const mutation = !['GET','HEAD','OPTIONS'].includes(request.method)
      csrf.originCheck(request,mutation)
      if (mutation) csrf.requireSession(request,token)
      await sessions.authenticate(token)
    })
    api.post('/api/v1/jobs',{ bodyLimit: 4096,schema: { querystring,body: object({ type: { type: 'string',enum: ['xlsx.roundtrip'] },input: object({ artifactId: id }),idempotencyKey: { type: 'string',pattern: '^[A-Za-z0-9_-]{8,128}$' } }),response: { 202: jobSchema } } },async (request,reply) => {
      const body = request.body as { type: string; input: { artifactId: string }; idempotencyKey: string }
      const job = await jobs.enqueueJob(cookies(request).session!,body.type,body.input,body.idempotencyKey)
      return reply.code(202).header('Location','/api/v1/jobs/' + job.id).send(job)
    })
    api.get('/api/v1/jobs',{ schema: { querystring: object({limit: {type: 'string',pattern: '^(?:[1-9][0-9]?|100)$'},after: id},[]),response: { 200: object({ jobs: { type: 'array',maxItems: 100,items: jobSchema }, nextCursor: nullable(id) },['jobs']) } } },request => {
      const query = request.query as {limit?: string; after?: string}, token = cookies(request).session!
      return Object.keys(query).length ? jobs.listJobPage(token,{limit: query.limit === undefined ? undefined : Number(query.limit),after: query.after}) : jobs.listJobs(token)
    })
    api.get('/api/v1/jobs/:id',{ schema: { params,querystring,response: { 200: jobSchema } } },request => jobs.getJob(cookies(request).session!,(request.params as { id: string }).id))
    api.post('/api/v1/jobs/:id/cancel',{ bodyLimit: 1024,schema: { params,querystring,response: { 200: jobSchema } } },request => {
      if (request.body!==undefined) throw authError(400)
      return jobs.cancelJob(cookies(request).session!,(request.params as { id: string }).id)
    })
  })
}
