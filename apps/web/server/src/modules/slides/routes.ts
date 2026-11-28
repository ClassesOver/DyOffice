import {editorFileToken,authenticateEditorFile} from '../dsh-edit/http.ts'
import { Readable } from 'node:stream'
import { createBrotliCompress } from 'node:zlib'
import { acceptsBrotli, fastBrotli, minCompressionBytes } from '../../../response-encoding.mjs'
import {MAX_PPTX_ADVANCE_MS, MAX_PPTX_MEDIA_BYTES, MAX_PPTX_RECORDING_BYTES, MAX_PPTX_RECORDING_SLIDES} from '../../../../worker/src/native/pptx-session-host.ts'
import {MAX_INK_PAYLOAD_BYTES} from '../../../../../slides/src/shared/ink-payload'
import {WEB_MODEL3D_MAX_BYTES} from '../../../../../slides/src/shared/model3d-glb'
import type { SlidesSessions } from './service.ts'
import { withDisconnect } from '../request-signal.ts'
import type { SlidesSaveService, SlidesSaveInput } from './save.ts'
import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { uuidSchema, fileParamsSchema, emptyQuerySchema } from '../files/http-schema.ts'

const revisionBody = { revision: uuidSchema, editorId:uuidSchema, leaseEpoch:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER} }
const generationBody = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
/** Session routes speak the renderer contract: revision-pinned, generation-fenced JSON with
 * CSRF + session auth, plus bounded media, binary draft export and T06 save preparation. */
// Ordinary op batches stay small; one analysis picture (addPicture with a data
// URL, at most 5 MiB like the media route) may ride in the same atomic batch
// as its provenance text box.
const SLIDES_APPLY_ORDINARY_LIMIT = 256 * 1024
const SLIDES_APPLY_BODY_LIMIT = SLIDES_APPLY_ORDINARY_LIMIT + 4096 + 7 * 1024 * 1024
/** The larger body is only for one analysis picture (plus its provenance text box); ordinary op batches keep the old limit. */
export function assertApplySize(ops: unknown[]): void {
  // Whole-deck timing updates may include all 200 supported slides.
  if(ops.length>100&&!ops.every(value=>{
    const op=(value as {op?:unknown}|null)?.op
    return op==='setTransition'||op==='setAdvanceTime'
  }))throw Object.assign(new Error('Too many slide operations'),{statusCode:400})
  if (Buffer.byteLength(JSON.stringify(ops)) <= SLIDES_APPLY_ORDINARY_LIMIT) return
  const pictures = ops.filter(op => (op as { op?: unknown } | null)?.op === 'addPicture').length
  if (pictures === 1 && ops.length <= 2) return
  throw Object.assign(new Error('Request body is too large'), { statusCode: 413 })
}

export function registerSlidesRoutes(app: FastifyInstance, slides: SlidesSessions, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>, saves?: SlidesSaveService) {
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      await authenticateEditorFile(request,sessions,csrf,true)
    })
    api.addHook('onSend', async (request,reply,payload) => {
      if (request.routeOptions.url !== '/api/v1/files/:id/slides/open' || reply.statusCode !== 200 ||
          typeof payload !== 'string' || Buffer.byteLength(payload) < minCompressionBytes || reply.hasHeader('content-encoding')) return payload
      reply.header('Vary','Accept-Encoding')
      if (!acceptsBrotli(request.headers)) return payload
      reply.header('Content-Encoding','br')
      reply.removeHeader('content-length')
      return Readable.from([payload]).pipe(createBrotliCompress(fastBrotli))
    })
    function route<T>(path: string, properties: Record<string, unknown>, operation: (token: string, fileId: string, body: T & {editorId:string;leaseEpoch:number}, signal: AbortSignal) => Promise<unknown>, bodyLimit = 4096, optionalKeys: string[] = []) {
      api.post(path, { bodyLimit, schema: { params: fileParamsSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: Object.keys(properties).filter(key=>key!=='fitWidthPx'&&!optionalKeys.includes(key)), properties } } }, async (request, reply) => {
        return withDisconnect(request, reply, signal => operation(editorFileToken(request), (request.params as {id: string}).id, request.body as T & {editorId:string;leaseEpoch:number}, signal))
      })
    }
    function readRoute<T>(path: string, properties: Record<string, unknown>, operation: (token: string, fileId: string, body: T & {editorId:string;leaseEpoch:number}, signal: AbortSignal) => Promise<unknown>) {
      route<T>(path, properties, operation, 4096, ['editorId','leaseEpoch'])
    }
    const fitWidthPx = { type: 'integer', minimum: 320, maximum: 4096 }
    readRoute<{revision:string;generation:number;fitWidthPx?:number}>('/api/v1/files/:id/slides/open', {...revisionBody,generation:generationBody,fitWidthPx}, (token,id,body,signal)=>slides.open(token,id,body,signal))
    route<Parameters<SlidesSessions['unlockEditing']>[2]>('/api/v1/files/:id/slides/unlock-editing',{
      ...revisionBody,generation:generationBody,password:{type:'string',minLength:1,maxLength:255},
    },(token,id,body,signal)=>slides.unlockEditing(token,id,body,signal))
    readRoute<{revision:string;generation:number;index:number;fitWidthPx?:number}>('/api/v1/files/:id/slides/slide', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575},fitWidthPx}, (token,id,body,signal)=>slides.slide(token,id,body,signal))
    readRoute<{revision:string;generation:number;index:number}>('/api/v1/files/:id/slides/notes', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575}}, (token,id,body,signal)=>slides.notes(token,id,body,signal))
    readRoute<{revision:string;generation:number;index:number}>('/api/v1/files/:id/slides/comments', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575}}, (token,id,body,signal)=>slides.comments(token,id,body,signal))
    readRoute<{revision:string;generation:number;index:number;sourceId:string}>('/api/v1/files/:id/slides/chart-data', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575},sourceId:{type:'string',minLength:1,maxLength:256}}, (token,id,body,signal)=>slides.chartData(token,id,body,signal))
    readRoute<{revision:string;generation:number}>('/api/v1/files/:id/slides/chart-color-schemes', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.chartColorSchemes(token,id,body,signal))
    readRoute<{revision:string;generation:number}>('/api/v1/files/:id/slides/slide-info', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.slideInfo(token,id,body,signal))
    readRoute<{revision:string;generation:number;index:number}>('/api/v1/files/:id/slides/animations', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575}}, (token,id,body,signal)=>slides.animations(token,id,body,signal))
    readRoute<{revision:string;generation:number;index:number}>('/api/v1/files/:id/slides/links', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575}}, (token,id,body,signal)=>slides.links(token,id,body,signal))
    readRoute<{revision:string;generation:number;index:number}>('/api/v1/files/:id/slides/run-links', {...revisionBody,generation:generationBody,index:{type:'integer',minimum:0,maximum:1048575}}, (token,id,body,signal)=>slides.runLinks(token,id,body,signal))
    readRoute<{revision:string;generation:number}>('/api/v1/files/:id/slides/layouts', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.layouts(token,id,body,signal))
    readRoute<Parameters<SlidesSessions['customShows']>[2]>('/api/v1/files/:id/slides/custom-shows', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.customShows(token,id,body,signal))
    readRoute<{revision:string;generation:number}>('/api/v1/files/:id/slides/slides', {...revisionBody,generation:generationBody}, (token,id,body,signal)=>slides.slides(token,id,body,signal))
    const clipboardBase={...revisionBody,generation:generationBody}
    const slideIndex={type:'integer',minimum:0,maximum:1048575}
    const modelSource={type:'string',minLength:1,maxLength:256}
    const modelLimit=Math.ceil(WEB_MODEL3D_MAX_BYTES/3)*4,posterLimit=Math.ceil(5*1024*1024/3)*4
    const posterBase64={type:'string',minLength:1,maxLength:posterLimit}
    readRoute<Parameters<SlidesSessions['fontFaces']>[2]>('/api/v1/files/:id/slides/font-faces',{
      ...clipboardBase,
    },(token,id,body,signal)=>slides.fontFaces(token,id,body,signal))
    readRoute<Parameters<SlidesSessions['fontData']>[2]>('/api/v1/files/:id/slides/font-data',{
      ...clipboardBase,sourceId:{type:'string',pattern:'^[0-9a-f]{64}$'},
    },(token,id,body,signal)=>slides.fontData(token,id,body,signal))
    readRoute<Parameters<SlidesSessions['model3dData']>[2]>('/api/v1/files/:id/slides/model3d-data',{
      ...clipboardBase,index:slideIndex,sourceId:modelSource,
    },(token,id,body,signal)=>slides.model3dData(token,id,body,signal))
    route<Omit<Extract<Parameters<SlidesSessions['editModel3d']>[2],{mode:'insert'}>,'mode'>>('/api/v1/files/:id/slides/model3d-insert',{
      ...clipboardBase,slide:slideIndex,fitWidthPx,bytesBase64:{type:'string',minLength:1,maxLength:modelLimit},posterBase64,
      name:{type:'string',minLength:1,maxLength:255},aspect:{type:'number',minimum:1/3,maximum:3},
    },(token,id,body,signal)=>slides.editModel3d(token,id,{...body,mode:'insert'},signal),modelLimit+posterLimit+4096,['posterBase64'])
    const angle={type:'number',minimum:-2160000000,maximum:2160000000}
    route<Omit<Extract<Parameters<SlidesSessions['editModel3d']>[2],{mode:'view'}>,'mode'>>('/api/v1/files/:id/slides/model3d-view',{
      ...clipboardBase,slide:slideIndex,sourceId:modelSource,posterBase64,
      rot:{type:'object',additionalProperties:false,required:['ax','ay','az'],properties:{ax:angle,ay:angle,az:angle}},
    },(token,id,body,signal)=>slides.editModel3d(token,id,{...body,mode:'view'},signal),posterLimit+4096,['posterBase64'])
    const mediaBase64Limit=Math.ceil(MAX_PPTX_MEDIA_BYTES/3)*4
    const mediaCoordinate={type:'number',minimum:-100000,maximum:100000}
    route<Parameters<SlidesSessions['insertMedia']>[2]>('/api/v1/files/:id/slides/embedded-media',{
      ...clipboardBase,slide:slideIndex,kind:{type:'string',enum:['audio','video']},fitWidthPx,
      ext:{type:'string',minLength:3,maxLength:4},bytesBase64:{type:'string',minLength:16,maxLength:mediaBase64Limit},
      name:{type:'string',maxLength:255},centerPx:{type:'object',additionalProperties:false,required:['x','y'],properties:{x:mediaCoordinate,y:mediaCoordinate}},
    },(token,id,body,signal)=>slides.insertMedia(token,id,body,signal),mediaBase64Limit+4096,['name','centerPx'])
    readRoute<Parameters<SlidesSessions['mediaData']>[2]>('/api/v1/files/:id/slides/media-data',{
      ...clipboardBase,index:slideIndex,sourceId:{type:'string',minLength:1,maxLength:256},
    },(token,id,body,signal)=>slides.mediaData(token,id,body,signal))
    const recordingMs={type:'integer',minimum:1,maximum:MAX_PPTX_ADVANCE_MS}
    route<Parameters<SlidesSessions['applyRecording']>[2]>('/api/v1/files/:id/slides/recording',{
      ...clipboardBase,kind:{type:'string',enum:['save','clear']},
      indexes:{type:'array',minItems:1,maxItems:MAX_PPTX_RECORDING_SLIDES,uniqueItems:true,items:slideIndex},
      slides:{type:'array',minItems:1,maxItems:MAX_PPTX_RECORDING_SLIDES,items:{
        type:'object',additionalProperties:false,required:['slideIndex','wavBase64','durationMs','advanceMs'],properties:{
          slideIndex,wavBase64:{type:'string',minLength:64,maxLength:Math.ceil(MAX_PPTX_MEDIA_BYTES/3)*4},
          durationMs:recordingMs,advanceMs:recordingMs,
        },
      }},
    },(token,id,body,signal)=>slides.applyRecording(token,id,body,signal),
    Math.ceil(MAX_PPTX_RECORDING_BYTES/3)*4+64*1024,['slides','indexes'])
    const sourceIds={type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'string',minLength:1,maxLength:256}}
    route<Parameters<SlidesSessions['copyClipboard']>[2]>('/api/v1/files/:id/slides/clipboard-copy',{
      ...clipboardBase,kind:{type:'string',enum:['slides','elements']},index:slideIndex,sourceIds,
      indexes:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:slideIndex},
      cut:{type:'boolean'},pngs:{type:'array',minItems:1,maxItems:100,items:{type:'string',minLength:1,maxLength:7*1024*1024}},
    },(token,id,body,signal)=>slides.copyClipboard(token,id,body,signal),7*1024*1024+32*1024,['editorId','leaseEpoch','index','sourceIds','indexes','cut','pngs'])
    route<Parameters<SlidesSessions['pasteClipboard']>[2]>('/api/v1/files/:id/slides/clipboard-paste',{
      ...clipboardBase,kind:{type:'string',enum:['slides','elements']},index:{...slideIndex,minimum:-1},clipboardId:uuidSchema,fitWidthPx,
      mode:{type:'string',enum:['theme','source','picture']},replace:{type:'boolean'},
    },(token,id,body,signal)=>slides.pasteClipboard(token,id,body,signal),4096,['mode','replace'])
    const delta={type:'number',minimum:-100000,maximum:100000}
    route<Parameters<SlidesSessions['duplicateClipboard']>[2]>('/api/v1/files/:id/slides/clipboard-duplicate',{
      ...clipboardBase,index:slideIndex,sourceIds,fitWidthPx,dxPx:delta,dyPx:delta,
    },(token,id,body,signal)=>slides.duplicateClipboard(token,id,body,signal),32*1024)
    route<{revision:string;generation:number;ops:unknown[];isolation?:'atomic'|'per_op';dryRun?:boolean}>('/api/v1/files/:id/slides/apply', {...revisionBody,generation:generationBody,ops:{type:'array',minItems:1,maxItems:200},isolation:{type:'string',enum:['atomic','per_op']},dryRun:{type:'boolean'}}, (token,id,body,signal)=>{assertApplySize(body.ops);return slides.apply(token,id,body,signal)}, SLIDES_APPLY_BODY_LIMIT, ['isolation','dryRun'])
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
    readRoute<Parameters<SlidesSessions['masterParts']>[2]>('/api/v1/files/:id/slides/master-parts', {
      ...revisionBody,generation:generationBody,fitWidthPx,
    },(token,id,body,signal)=>slides.masterParts(token,id,body,signal))
    route<Parameters<SlidesSessions['applyMaster']>[2]>('/api/v1/files/:id/slides/master-edit', {
      ...revisionBody,generation:generationBody,fitWidthPx,partPath:{type:'string',minLength:1,maxLength:128},operation:{type:'object'},
    },(token,id,body,signal)=>slides.applyMaster(token,id,body,signal),260*1024)
    route<Parameters<SlidesSessions['applyImage']>[2]>('/api/v1/files/:id/slides/media', {
      ...revisionBody,generation:generationBody,mode:{type:'string',enum:['insert','replace','background','fill','ink']},
      slide:{...slideIndex,minimum:-1},bytesBase64:{type:'string',minLength:16,maxLength:6990508},ext:{type:'string',enum:['png','jpg','jpeg','gif','bmp','tif','tiff']},
      placement:{type:'string',enum:['natural']},xPx:{type:'number',minimum:-100000,maximum:100000},yPx:{type:'number',minimum:-100000,maximum:100000},
      wPx:{type:'number',exclusiveMinimum:0,maximum:100000},hPx:{type:'number',exclusiveMinimum:0,maximum:100000},fitWidthPx,
      sourceId:{type:'string',minLength:1,maxLength:256},keepSrcRect:{type:'boolean'},inkPayload:{type:'string',minLength:1,maxLength:MAX_INK_PAYLOAD_BYTES},
      tile:{type:'boolean'},sourceSlide:slideIndex,targets:{type:'array',minItems:1,maxItems:100,items:{
        type:'object',additionalProperties:false,required:['sourceId'],properties:{
          sourceId:{type:'string',minLength:1,maxLength:256},groupId:{type:'string',minLength:1,maxLength:256},
        },
      }},
    }, (token,id,body,signal)=>slides.applyImage(token,id,body,signal), 8*1024*1024,
      ['bytesBase64','ext','placement','xPx','yPx','wPx','hPx','fitWidthPx','sourceId','keepSrcRect','tile','sourceSlide','targets','inkPayload'])
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
    for(const mode of ['export','recover'] as const)api.post('/api/v1/files/:id/slides/'+mode, { bodyLimit: 4096, schema: { params: fileParamsSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: ['revision','generation','editorId','leaseEpoch'], properties: {...revisionBody, generation: generationBody} } } }, async (request, reply) => {
      return withDisconnect(request, reply, async signal => {
        const exported = await (mode==='recover'?slides.recoverDraft:slides.exportDraft)(editorFileToken(request), (request.params as {id: string}).id, request.body as {revision: string; generation: number; editorId:string; leaseEpoch:number}, signal)
        reply.header('Content-Type', 'application/octet-stream')
        reply.header('Content-Disposition', 'attachment; filename="draft.pptx"')
        reply.header('X-Slides-Generation', String(exported.generation))
        return reply.send(exported.bytes)
      })
    })
  })
}
