import { chatBodySchema } from './assistant-chat.ts'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import type { createCsrfService } from '../auth/csrf.ts'
import { cookies } from '../auth/csrf.ts'
import { authError } from '../auth/sessions.ts'
import { objectTransferAdmission } from './transfer-admission.ts'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import type { FileService } from './service.ts'

import { uuidSchema as id, fileParamsSchema as params, emptyQuerySchema as emptyQuery } from './http-schema.ts'
import { registerRevisionRoutes } from '../revisions/routes.ts'
import type { RevisionService } from '../revisions/service.ts'
import type { LeaseService } from '../leases/service.ts'
import { createAiXlsxDocument } from '../sheets/create-document.ts'

const token = (request: FastifyRequest) => cookies(request).session ?? ''
export function registerFileRoutes(app: FastifyInstance, files: FileService, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>, saves?: { revisions: RevisionService; leases: LeaseService }) {
  const admission = objectTransferAdmission(app)
  const { transfer } = admission
  app.register(async api => {
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
      if ((['PUT','GET','HEAD'].includes(request.method) && request.routeOptions.url?.endsWith('/content')) || (request.method === 'POST' && (request.routeOptions.url?.endsWith('/uploads') || request.routeOptions.url?.endsWith('/purge') || request.routeOptions.url?.endsWith('/finish') || request.routeOptions.url?.endsWith('/commits') || request.routeOptions.url?.endsWith('/restoration-uploads') || request.routeOptions.url?.endsWith('/ai/xlsx-documents') || request.routeOptions.url?.endsWith('/files/new-pdf')))) {
        if (request.method === 'PUT') {
          const upload = await files.preflightUpload(credential, (request.params as { id: string }).id)
          const length = request.headers['content-length']
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== upload.size)) throw authError(400)
        }
        admission.admit(request, reply)
      }
    })
    api.addHook('onResponse', async request => admission.close(request))
    api.addHook('onError', async request => admission.error(request))
    if (saves) registerRevisionRoutes(api,{ ...saves, transfer })
    api.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_OBJECT_BYTES }, (_request, body, done) => done(null, body))
    api.get('/api/v1/capabilities', { schema: { querystring: emptyQuery } }, async () => files.capabilities)
    api.get('/api/v1/storage/usage', { schema: { querystring: emptyQuery } }, request => files.usage(token(request)))
    api.post('/api/v1/files/new-pdf', { bodyLimit:4096, schema:{querystring:emptyQuery} }, (request,reply)=>transfer(request,reply,async()=>{
      if(request.body!==undefined)throw authError(400)
      if(files.capabilities.pdfEditor!=='editable')throw authError(415)
      return reply.code(201).send(await files.createBlankPdf(token(request)))
    }))
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
    api.post('/api/v1/ai/xlsx-documents', { bodyLimit: 16*1024*1024, schema: { querystring: emptyQuery, body: { type:'object',additionalProperties:false,required:['title','content'],properties:{title:{type:'string',minLength:1,maxLength:200},sheetName:{type:'string',minLength:1,maxLength:31},content:{type:'string',minLength:1,maxLength:15*1024*1024}} } } }, (request,reply) => transfer(request,reply,async()=>{
      if(files.capabilities.xlsx!=='editable')throw authError(415)
      return createAiXlsxDocument(files,token(request),request.body as {title:string;sheetName?:string;content:string})
    }))
    api.delete('/api/v1/uploads/:id', { schema: { params, querystring: emptyQuery } }, async (request, reply) => {
      await files.cancelUpload(token(request), (request.params as { id: string }).id)
      return reply.code(204).send()
    })
    api.get('/api/v1/files', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { trash: { type: 'string', enum: ['true','false'] }, cursor: id, limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|100)$' } } } } }, request => {
      const query = request.query as { trash?: string; cursor?: string; limit?: string }
      return files.listFiles(token(request), { trash: query.trash === 'true', cursor: query.cursor, limit: query.limit === undefined ? undefined : Number(query.limit) })
    })
    api.post('/api/v1/files/:id/assistant-chat',{bodyLimit:1024*1024,schema:{params,querystring:emptyQuery,body:chatBodySchema}},
      request=>files.syncAssistantChat(token(request),(request.params as {id:string}).id,request.body as Parameters<typeof files.syncAssistantChat>[2]))
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
    const trashBatchSchema = {
      querystring: emptyQuery,
      body: { type: 'object', additionalProperties: false, required: ['ids'],
        properties: { ids: { type: 'array', minItems: 1, maxItems: 10000, items: id } } },
    }
    for (const path of ['/api/v1/files/trash-batch', '/api/v1/files/trash-batch/status']) {
      api.post(path, { bodyLimit: 512 * 1024, schema: trashBatchSchema }, request =>
        files.trashBatch(token(request), (request.body as { ids: string[] }).ids, path.endsWith('/status')))
    }
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
