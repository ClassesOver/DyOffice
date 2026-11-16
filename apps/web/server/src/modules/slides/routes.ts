import type { SlidesSessions } from './service.ts'
import type { SlidesSaveService, SlidesSaveInput } from './save.ts'
import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { uuidSchema, fileParamsSchema, emptyQuerySchema } from '../files/http-schema.ts'

const revisionBody = { revision: uuidSchema, editorId:uuidSchema, leaseEpoch:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER} }
const generationBody = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
/** Session routes speak the renderer contract: revision-pinned, generation-fenced JSON with
 * CSRF + session auth, plus one octet-stream draft export and the T06 save preparation. */
export function registerSlidesRoutes(app: FastifyInstance, slides: SlidesSessions, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>, saves?: SlidesSaveService) {
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.originCheck(request, true)
      csrf.requireSession(request, token)
      await sessions.authenticate(token)
    })
    function route<T>(path: string, properties: Record<string, unknown>, operation: (token: string, fileId: string, body: T & {editorId:string;leaseEpoch:number}, signal: AbortSignal) => Promise<unknown>, bodyLimit = 4096) {
      api.post(path, { bodyLimit, schema: { params: fileParamsSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: Object.keys(properties).filter(key=>key!=='fitWidthPx'), properties } } }, async (request, reply) => {
        const controller = new AbortController()
        const abort = () => controller.abort()
        request.raw.once('aborted', abort)
        const onClose = () => { if (!reply.raw.writableFinished) abort() }
        reply.raw.once('close', onClose)
        try {
          if (request.raw.aborted || reply.raw.destroyed) controller.abort()
          return await operation(cookies(request).session ?? '', (request.params as {id: string}).id, request.body as T & {editorId:string;leaseEpoch:number}, controller.signal)
        } finally {
          request.raw.removeListener('aborted', abort)
          reply.raw.removeListener('close', onClose)
        }
      })
    }
    const fitWidthPx = { type: 'integer', minimum: 320, maximum: 4096 }
    route<{revision:string;generation:number;fitWidthPx?:number}>('/api/v1/files/:id/slides/open', {...revisionBody,generation:generationBody,fitWidthPx}, (token,id,body,signal)=>slides.open(token,id,body,signal))
    route<{revision:string;generation:number;index:number;fitWidthPx?:number}>('/api/v1/files/:id/slides/slide', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575},fitWidthPx}, (token,id,body,signal)=>slides.slide(token,id,body,signal))
    route<{revision:string;generation:number}>('/api/v1/files/:id/slides/slides', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.slides(token,id,body,signal))
    route<{revision:string;generation:number;ops:unknown[]}>('/api/v1/files/:id/slides/apply', {...revisionBody,generation:generationBody,ops:{type:'array',minItems:1,maxItems:100}}, (token,id,body,signal)=>slides.apply(token,id,body,signal), 256*1024+4096)
    route<{revision:string;generation:number}>('/api/v1/files/:id/slides/undo', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.undo(token,id,body,signal))
    route<{revision:string;generation:number}>('/api/v1/files/:id/slides/redo', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.redo(token,id,body,signal))
    if (saves) route<SlidesSaveInput>('/api/v1/files/:id/slides/uploads', {
      baseRevision: uuidSchema, editorId: uuidSchema, leaseEpoch: {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER},
      request: {type: 'object', additionalProperties: false, required: ['revision','generation'], properties: {revision: uuidSchema, generation: generationBody}},
    }, (token,id,body,signal) => saves.prepare(token,id,body,signal))
    // Current-draft download: binary, generation-fenced, never marks anything saved.
    api.post('/api/v1/files/:id/slides/export', { bodyLimit: 4096, schema: { params: fileParamsSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: ['revision','generation','editorId','leaseEpoch'], properties: {...revisionBody, generation: generationBody} } } }, async (request, reply) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      request.raw.once('aborted', abort)
      const onClose = () => { if (!reply.raw.writableFinished) abort() }
      reply.raw.once('close', onClose)
      try {
        if (request.raw.aborted || reply.raw.destroyed) controller.abort()
        const exported = await slides.exportDraft(cookies(request).session ?? '', (request.params as {id: string}).id, request.body as {revision: string; generation: number; editorId:string; leaseEpoch:number}, controller.signal)
        reply.header('Content-Type', 'application/octet-stream')
        reply.header('Content-Disposition', 'attachment; filename="draft.pptx"')
        reply.header('X-Slides-Generation', String(exported.generation))
        return reply.send(exported.bytes)
      } finally {
        request.raw.removeListener('aborted', abort)
        reply.raw.removeListener('close', onClose)
      }
    })
  })
}
