import type { SlidesSessions } from './service.ts'
import type { SlidesSaveService, SlidesSaveInput } from './save.ts'
import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { uuidSchema, fileParamsSchema, emptyQuerySchema } from '../files/http-schema.ts'

const revisionBody = { revision: uuidSchema, editorId:uuidSchema, leaseEpoch:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER} }
const generationBody = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
/** Session routes speak the renderer contract: revision-pinned, generation-fenced JSON with
 * CSRF + session auth, plus bounded media, binary draft export and T06 save preparation. */
export function registerSlidesRoutes(app: FastifyInstance, slides: SlidesSessions, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>, saves?: SlidesSaveService) {
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.originCheck(request, true)
      csrf.requireSession(request, token)
      await sessions.authenticate(token)
    })
    function route<T>(path: string, properties: Record<string, unknown>, operation: (token: string, fileId: string, body: T & {editorId:string;leaseEpoch:number}, signal: AbortSignal) => Promise<unknown>, bodyLimit = 4096, optionalKeys: string[] = []) {
      api.post(path, { bodyLimit, schema: { params: fileParamsSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: Object.keys(properties).filter(key=>key!=='fitWidthPx'&&!optionalKeys.includes(key)), properties } } }, async (request, reply) => {
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
    route<{revision:string;generation:number;index:number}>('/api/v1/files/:id/slides/notes', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575}}, (token,id,body,signal)=>slides.notes(token,id,body,signal))
    route<{revision:string;generation:number;index:number}>('/api/v1/files/:id/slides/comments', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575}}, (token,id,body,signal)=>slides.comments(token,id,body,signal))
    route<{revision:string;generation:number;index:number;sourceId:string}>('/api/v1/files/:id/slides/chart-data', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575},sourceId:{type:'string',minLength:1,maxLength:256}}, (token,id,body,signal)=>slides.chartData(token,id,body,signal))
    route<{revision:string;generation:number}>('/api/v1/files/:id/slides/chart-color-schemes', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.chartColorSchemes(token,id,body,signal))
    route<{revision:string;generation:number;index:number}>('/api/v1/files/:id/slides/animations', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575}}, (token,id,body,signal)=>slides.animations(token,id,body,signal))
    route<{revision:string;generation:number;index:number}>('/api/v1/files/:id/slides/links', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575}}, (token,id,body,signal)=>slides.links(token,id,body,signal))
    route<{revision:string;generation:number;index:number}>('/api/v1/files/:id/slides/run-links', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575}}, (token,id,body,signal)=>slides.runLinks(token,id,body,signal))
    route<{revision:string;generation:number}>('/api/v1/files/:id/slides/layouts', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.layouts(token,id,body,signal))
    route<{revision:string;generation:number}>('/api/v1/files/:id/slides/slides', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.slides(token,id,body,signal))
    route<{revision:string;generation:number;ops:unknown[];isolation?:'atomic'|'per_op';dryRun?:boolean}>('/api/v1/files/:id/slides/apply', {...revisionBody,generation:generationBody,ops:{type:'array',minItems:1,maxItems:100},isolation:{type:'string',enum:['atomic','per_op']},dryRun:{type:'boolean'}}, (token,id,body,signal)=>slides.apply(token,id,body,signal), 256*1024+4096, ['isolation','dryRun'])
    route<{revision:string;generation:number;slide:number;sourceId:string;patch:Record<string,unknown>;confirmed?:boolean}>('/api/v1/files/:id/slides/chart-edit', {
      ...revisionBody,generation:generationBody,slide:{type:'integer',minimum:0,maximum:1048575},sourceId:{type:'string',minLength:1,maxLength:256},confirmed:{type:'boolean'},
      patch:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['bar','bar3D','barStacked','barPercentStacked','barH','line','area','pie','pie3D','doughnut','scatter','radar','comboBarLine']},barDir:{type:'string',enum:['col','bar']},categories:{type:'array',maxItems:1000,items:{type:'string',maxLength:1024}},series:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,required:['name','values'],properties:{name:{type:'string',maxLength:1024},values:{type:'array',maxItems:1000,items:{type:'number'}}}}},title:{type:'string',maxLength:4096},colorScheme:{type:'string',maxLength:32},legendPos:{type:'string',enum:['b','t','r','l','none']},dataLabels:{type:'boolean'},gridlines:{type:'boolean'},catAxisTitle:{type:'string',maxLength:1024},valAxisTitle:{type:'string',maxLength:1024},gapWidthPct:{type:'number',minimum:0,maximum:500},holeSizePct:{type:'number',minimum:0,maximum:100},switchRowCol:{type:'boolean'},pointColors:{type:'object',maxProperties:100,additionalProperties:{type:'object',maxProperties:100,additionalProperties:{anyOf:[{type:'string',pattern:'^#[0-9A-Fa-f]{6}$'},{type:'null'}]}}}}},
    },(token,id,body,signal)=>slides.editChart(token,id,body,signal),256*1024,['confirmed'])
    route<{revision:string;generation:number;specJson:string;images:Array<{url:string;bytesBase64:string;ext:string}>}>('/api/v1/files/:id/slides/generate-page', {
      ...revisionBody,generation:generationBody,specJson:{type:'string',minLength:2,maxLength:262144},images:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,required:['url','bytesBase64','ext'],properties:{url:{type:'string',minLength:1,maxLength:4096},bytesBase64:{type:'string',minLength:16,maxLength:6990508},ext:{type:'string',enum:['png','jpg','jpeg','gif']}}}},
    },(token,id,body,signal)=>slides.generatePage(token,id,body,signal),22*1024*1024)
    route<{revision:string;generation:number;markers:string[];mode:'replace'|'append'|'replace_at'|'insert_at';atIndex?:number}>('/api/v1/files/:id/slides/generated-pages', {
      ...revisionBody,generation:generationBody,markers:{type:'array',minItems:1,maxItems:200,items:{type:'string',minLength:10,maxLength:128}},mode:{type:'string',enum:['replace','append','replace_at','insert_at']},atIndex:{type:'integer',minimum:0,maximum:200},
    },(token,id,body,signal)=>slides.landGeneratedPages(token,id,body,signal),32*1024,['atIndex'])
    route<{revision:string;generation:number;mode:'insert'|'replace';slide:number;bytesBase64:string;ext:string;xPx?:number;yPx?:number;wPx?:number;hPx?:number;fitWidthPx?:number;sourceId?:string;keepSrcRect?:boolean}>('/api/v1/files/:id/slides/media', {
      ...revisionBody,generation:generationBody,mode:{type:'string',enum:['insert','replace']},slide:{type:'integer',minimum:0,maximum:1048575},bytesBase64:{type:'string',minLength:16,maxLength:6990508},ext:{type:'string',enum:['png','jpg','jpeg','gif']},
      xPx:{type:'number',minimum:-100000,maximum:100000},yPx:{type:'number',minimum:-100000,maximum:100000},wPx:{type:'number',exclusiveMinimum:0,maximum:100000},hPx:{type:'number',exclusiveMinimum:0,maximum:100000},fitWidthPx:fitWidthPx,sourceId:{type:'string',minLength:1,maxLength:256},keepSrcRect:{type:'boolean'},
    }, (token,id,body,signal)=>slides.applyImage(token,id,body as Parameters<SlidesSessions['applyImage']>[2],signal), 7*1024*1024, ['xPx','yPx','wPx','hPx','fitWidthPx','sourceId','keepSrcRect'])
    route<{revision:string;generation:number}>('/api/v1/files/:id/slides/undo', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.undo(token,id,body,signal))
    route<{revision:string;generation:number}>('/api/v1/files/:id/slides/history-batch-begin', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.beginHistoryBatch(token,id,body,signal))
    route<{revision:string;generation:number}>('/api/v1/files/:id/slides/history-batch-end', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.endHistoryBatch(token,id,body,signal))
    route<{revision:string;generation:number;snapshotId:number}>('/api/v1/files/:id/slides/snapshot-restore', {...revisionBody,generation:generationBody,snapshotId:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER}}, (token,id,body,signal)=>slides.restoreSnapshot(token,id,body,signal))
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
