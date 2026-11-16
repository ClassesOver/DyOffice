import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import type { createCsrfService } from '../auth/csrf.ts'
import { cookies } from '../auth/csrf.ts'
import { authError } from '../auth/sessions.ts'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import type { FileService } from './service.ts'

import { uuidSchema as id, fileParamsSchema as params, emptyQuerySchema as emptyQuery } from './http-schema.ts'
import { registerRevisionRoutes } from '../revisions/routes.ts'
import type { RevisionService } from '../revisions/service.ts'
import type { LeaseService } from '../leases/service.ts'

const token = (request: FastifyRequest) => cookies(request).session ?? ''
export function registerFileRoutes(app: FastifyInstance, files: FileService, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>, saves?: { revisions: RevisionService; leases: LeaseService }) {
  app.register(async api => {
    let activeTransfers = 0
    const admitted = new WeakMap<FastifyRequest, { running: boolean; closed: boolean }>()
    function release(request: FastifyRequest) { if (admitted.delete(request)) activeTransfers-- }
    function close(request: FastifyRequest) {
      const state = admitted.get(request)
      if (state) { state.closed = true; if (!state.running) release(request) }
    }
    async function transfer<T>(request: FastifyRequest, reply: FastifyReply, operation: () => Promise<T>): Promise<T> {
      const state = admitted.get(request)
      if (!state || state.closed || request.raw.aborted || reply.raw.destroyed) throw authError(400)
      state.running = true
      try { return await operation() }
      finally { state.running = false; if (state.closed) release(request) }
    }
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const credential = token(request)
      if (!credential) throw authError(401)
      const mutation = !['GET','HEAD','OPTIONS'].includes(request.method)
      csrf.originCheck(request, mutation)
      if (mutation) csrf.requireSession(request, credential)
      await sessions.authenticate(credential)
      // Hold admission through processing AND response completion. A client
      // disconnect cannot free capacity while object work still owns buffers.
      if ((['PUT','GET','HEAD'].includes(request.method) && request.routeOptions.url?.endsWith('/content')) || (request.method === 'POST' && (request.routeOptions.url?.endsWith('/uploads') || request.routeOptions.url?.endsWith('/purge') || request.routeOptions.url?.endsWith('/finish') || request.routeOptions.url?.endsWith('/commits') || request.routeOptions.url?.endsWith('/restoration-uploads')))) {
        if (request.method === 'PUT') {
          const upload = await files.preflightUpload(credential, (request.params as { id: string }).id)
          const length = request.headers['content-length']
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== upload.size)) throw authError(400)
        }
        if (request.raw.aborted || reply.raw.destroyed) throw authError(400)
        if (activeTransfers >= 2) throw Object.assign(authError(503), { retryAfter: 1 })
        activeTransfers++; admitted.set(request, { running: false, closed: false })
        request.raw.once('aborted', () => close(request))
        reply.raw.once('close', () => close(request))
      }
    })
    api.addHook('onResponse', async request => close(request))
    api.addHook('onError', async request => { if (!admitted.get(request)?.running) release(request) })
    if (saves) registerRevisionRoutes(api,{ ...saves, transfer })
    api.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_OBJECT_BYTES }, (_request, body, done) => done(null, body))
    api.get('/api/v1/capabilities', { schema: { querystring: emptyQuery } }, async () => files.capabilities)
    api.get('/api/v1/storage/usage', { schema: { querystring: emptyQuery } }, request => files.usage(token(request)))
    api.post('/api/v1/files/uploads', { bodyLimit: 4096, schema: { querystring: emptyQuery, body: { type: 'object', additionalProperties: false, required: ['name','size'], properties: { name: { type: 'string', minLength: 1, maxLength: 255 }, size: { type: 'integer', minimum: 1, maximum: MAX_OBJECT_BYTES } } } } }, (request, reply) => transfer(request, reply, async () => {
      const staged = await files.stageUpload(token(request), request.body as { name: string; size: number })
      return reply.code(201).send(staged)
    }))
    api.put('/api/v1/uploads/:id/content', { bodyLimit: MAX_OBJECT_BYTES, schema: { params, querystring: emptyQuery } }, (request, reply) => transfer(request, reply, async () => {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw authError(415)
      return files.receiveUpload(token(request), (request.params as { id: string }).id, request.body as Buffer)
    }))
    api.post('/api/v1/uploads/:id/finish', { bodyLimit: 4096, schema: { params, querystring: emptyQuery } }, (request, reply) => transfer(request, reply, async () => {
      if (request.body !== undefined) throw authError(400)
      return files.finishUpload(token(request), (request.params as { id: string }).id)
    }))
    api.delete('/api/v1/uploads/:id', { schema: { params, querystring: emptyQuery } }, async (request, reply) => {
      await files.cancelUpload(token(request), (request.params as { id: string }).id)
      return reply.code(204).send()
    })
    api.get('/api/v1/files', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { trash: { type: 'string', enum: ['true','false'] }, cursor: id, limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|100)$' } } } } }, request => {
      const query = request.query as { trash?: string; cursor?: string; limit?: string }
      return files.listFiles(token(request), { trash: query.trash === 'true', cursor: query.cursor, limit: query.limit === undefined ? undefined : Number(query.limit) })
    })
    api.get('/api/v1/files/:id', { schema: { params, querystring: emptyQuery } }, request => files.openFile(token(request), (request.params as { id: string }).id))
    api.get('/api/v1/files/:id/content', { schema: { params, querystring: { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: id } } } }, (request, reply) => transfer(request, reply, async () => {
      const result = await files.download(token(request), (request.params as { id: string }).id, (request.query as { revision: string }).revision)
      const name = encodeURIComponent(result.name).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())
      return reply.header('Content-Type', 'application/octet-stream').header('Content-Security-Policy', "sandbox; default-src 'none'")
        .header('Content-Disposition', `attachment; filename="download.${result.format}"; filename*=UTF-8''${name}`).send(result.bytes)
    }))
    api.patch('/api/v1/files/:id', { bodyLimit: 4096, schema: { params, querystring: emptyQuery, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 255 } } } } }, async (request, reply) => {
      await files.renameFile(token(request), (request.params as { id: string }).id, (request.body as { name: string }).name)
      return reply.code(204).send()
    })
    api.delete('/api/v1/files/:id', { schema: { params, querystring: emptyQuery } }, async (request, reply) => {
      await files.trashFile(token(request), (request.params as { id: string }).id)
      return reply.code(204).send()
    })
    api.post('/api/v1/files/:id/purge', { bodyLimit: 4096, schema: { params, querystring: emptyQuery } }, (request, reply) => transfer(request, reply, async () => {
      if (request.body !== undefined) throw authError(400)
      const result = await files.purgeFile(token(request), (request.params as { id: string }).id)
      return reply.code(result.state === 'purged' ? 200 : 202).send(result)
    }))
    api.post('/api/v1/files/:id/restore', { schema: { params, querystring: emptyQuery } }, async (request, reply) => {
      if (request.body !== undefined) throw authError(400)
      await files.restoreFile(token(request), (request.params as { id: string }).id)
      return reply.code(204).send()
    })
  })
}
