import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { LeaseService } from '../leases/service.ts'
import type { RevisionService } from './service.ts'
import { uuidSchema as id, fileParamsSchema as params, emptyQuerySchema as querystring } from '../files/http-schema.ts'
import { cookies } from '../auth/csrf.ts'
import { authError } from '../auth/sessions.ts'
import { uuid } from '../files/queries.ts'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import type { SaveInput } from '../../../../../../packages/web-contracts/src/api.ts'

export type TransferRunner = <T>(request: FastifyRequest, reply: FastifyReply, operation: () => Promise<T>) => Promise<T>
const epoch = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const
const editor = { editorId: id }, base = { baseRevision: id, leaseEpoch: epoch, ...editor }
const object = (properties: object, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties })
const token = (request: FastifyRequest) => cookies(request).session ?? ''
const fileId = (request: FastifyRequest) => (request.params as { id: string }).id
export function registerRevisionRoutes(api: FastifyInstance, { leases, revisions, transfer }: { leases: LeaseService; revisions: RevisionService; transfer: TransferRunner }) {
  api.get('/api/v1/files/:id/lease', { schema: { params, querystring } }, request => leases.getLease(token(request),fileId(request)))
  api.post('/api/v1/files/:id/lease', { bodyLimit: 4096, schema: { params, querystring, body: object(editor) } }, request => leases.acquireLease(token(request),fileId(request),request.body as { editorId: string }))
  api.post('/api/v1/files/:id/lease/renew', { bodyLimit: 4096, schema: { params, querystring, body: object({ ...editor, leaseEpoch: epoch }) } }, request => leases.renewLease(token(request),fileId(request),request.body as { editorId: string; leaseEpoch: number }))
  api.post('/api/v1/files/:id/lease/takeover', { bodyLimit: 4096, schema: { params, querystring, body: object({ ...editor, expectedEpoch: epoch }) } }, request => leases.takeoverLease(token(request),fileId(request),request.body as { editorId: string; expectedEpoch: number }))
  api.delete('/api/v1/files/:id/lease', { bodyLimit: 4096, schema: { params, querystring, body: object({ ...editor, leaseEpoch: epoch }) } }, async (request, reply) => {
    await leases.releaseLease(token(request),fileId(request),request.body as { editorId: string; leaseEpoch: number })
    return reply.code(204).send()
  })
  api.post('/api/v1/files/:id/uploads', { bodyLimit: 4096, schema: { params, querystring, body: object({ ...base, size: { type: 'integer', minimum: 1, maximum: MAX_OBJECT_BYTES } }) } }, (request, reply) => transfer(request, reply, async () => {
    const upload = await revisions.stageUpload(token(request),fileId(request),request.body as { baseRevision: string; leaseEpoch: number; editorId: string; size: number })
    return reply.code(201).send(upload)
  }))
  api.post('/api/v1/files/:id/restoration-uploads', { bodyLimit: 4096, schema: { params, querystring, body: object({ ...base, revision: id }) } }, (request, reply) => transfer(request,reply,async () => {
    const upload = await revisions.stageRestore(token(request),fileId(request),request.body as { revision: string; baseRevision: string; leaseEpoch: number; editorId: string })
    return reply.code(201).send(upload)
  }))
  api.post('/api/v1/files/:id/commits', { bodyLimit: 4096, schema: { params, querystring, body: object({ fileId: id, uploadId: id, baseRevision: id, leaseEpoch: epoch, idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' }, sourceCommandId: id }, ['fileId','uploadId','baseRevision','leaseEpoch','idempotencyKey']) } }, (request, reply) => transfer(request,reply,async () => {
    const body = request.body as SaveInput
    if (uuid(body.fileId) !== uuid(fileId(request))) throw authError(400)
    return revisions.commitRevision(token(request),body)
  }))
  api.get('/api/v1/files/:id/revisions/:revision', { schema: { params: object({ id, revision: id }), querystring } }, request => revisions.getRevision(token(request),fileId(request),(request.params as { revision: string }).revision))
  api.get('/api/v1/files/:id/revisions', { schema: { params, querystring: object({ cursor: id, limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|100)$' } },[]) } }, request => {
    const query = request.query as { cursor?: string; limit?: string }
    return revisions.listRevisions(token(request),fileId(request),{ cursor: query.cursor, limit: query.limit === undefined ? undefined : Number(query.limit) })
  })
}
