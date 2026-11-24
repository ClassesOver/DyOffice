import { objectTransferAdmission } from '../files/transfer-admission.ts'
import { withDisconnect } from '../request-signal.ts'
import type {FindInput,RecalcInput} from '../../../../worker/src/native/xlsx.ts'
import type { createSheetsSaveService, SheetsExportInput, SheetsSaveInput } from './save.ts'
import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { uuidSchema, fileParamsSchema, emptyQuerySchema } from '../files/http-schema.ts'
import type { createSheetsService, ExternalLinkBinding, SheetRange } from './service.ts'

const revisionBody = { revision: uuidSchema }
export function registerSheetsRoutes(app: FastifyInstance, sheets: ReturnType<typeof createSheetsService>, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>, saves?: ReturnType<typeof createSheetsSaveService>) {
  const admission = objectTransferAdmission(app)
  app.register(async api => {
    api.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:50*1024*1024},(_request,body,done)=>done(null,body))
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.originCheck(request, true)
      csrf.requireSession(request, token)
      await sessions.authenticate(token)
      // The save endpoint queues for a bounded wait when the shared object-I/O
      // budget is busy with concurrent reads: a user save must not starve
      // behind its own edit-triggered reads (503 starved chart edits, see
      // shared-object-admission evidence). Read routes keep the immediate 503.
      await admission.admit(request, reply, request.routeOptions.url?.endsWith('/sheets/uploads') ? { waitMs: 10_000 } : undefined)
    })
    api.addHook('onResponse', async request => admission.close(request))
    api.addHook('onError', async request => admission.error(request))
    function route<T>(path: string, properties: Record<string, unknown>, operation: (token: string, fileId: string, body: T, signal: AbortSignal) => Promise<unknown>, bodyLimit = 4096, optional:readonly string[] = []) {
      api.post(path, { bodyLimit, schema: { params: fileParamsSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: Object.keys(properties).filter(key=>!optional.includes(key)), properties } } }, async (request, reply) => {
        return withDisconnect(request, reply, signal => admission.transfer(request, reply, () => operation(cookies(request).session ?? '', (request.params as {id: string}).id, request.body as T, signal)))
      })
    }
    if (saves) route<SheetsSaveInput>('/api/v1/files/:id/sheets/uploads', {
      baseRevision: uuidSchema, editorId: uuidSchema, leaseEpoch: {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER}, request: {type: 'object'},
    }, (token,id,body,signal) => saves.prepare(token,id,body,signal), 4 * 1024 * 1024)
    if (saves) route<SheetsExportInput>('/api/v1/files/:id/sheets/export', {
      baseRevision: uuidSchema, editorId: uuidSchema, leaseEpoch: {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER},
      phases: {type: 'array', maxItems: 2, items: {type: 'object'}},
    }, (token,id,body,signal) => saves.exportDraft(token,id,body,signal), 4 * 1024 * 1024)
    route<{revision:string;visualId:string}>('/api/v1/files/:id/sheets/media',{...revisionBody,visualId:{type:'string',minLength:1,maxLength:512,pattern:'^[^/\\\\]+$'}},(token,id,body,signal)=>sheets.readMedia(token,id,body.revision,body.visualId,signal))
    const sheetName={type:'string',minLength:1,maxLength:255}
    route<FindInput & {revision:string;sheetName:string}>('/api/v1/files/:id/sheets/find',{
      ...revisionBody,sheetName,query:{type:'string',minLength:1,maxLength:10000,pattern:'\\S'},matchCase:{type:'boolean'},
      matchEntireCell:{type:'boolean'},lookIn:{type:'string',enum:['values','formulas','formulas_only','both']},wildcards:{type:'boolean'},
      limit:{type:'integer',minimum:1,maximum:100},
      resumeAt:{type:'object',additionalProperties:false,required:['row','column'],properties:{row:{type:'integer',minimum:0,maximum:1048575},column:{type:'integer',minimum:0,maximum:16383}}},
    },(token,id,{revision,sheetName,...request},signal)=>sheets.findCells(token,id,revision,sheetName,request,signal),65536,['resumeAt'])
    const range={type:'object',additionalProperties:false,required:['startRow','endRow','startColumn','endColumn'],properties:{startRow:{type:'integer',minimum:0,maximum:1048575},endRow:{type:'integer',minimum:0,maximum:1048575},startColumn:{type:'integer',minimum:0,maximum:16383},endColumn:{type:'integer',minimum:0,maximum:16383}}}
    route<RecalcInput & {revision:string}>('/api/v1/files/:id/sheets/recalculate', {...revisionBody,
      edits:{type:'array',maxItems:10000,items:{type:'object',additionalProperties:false,required:['sheetName','row','column','input'],properties:{sheetName,row:{type:'integer',minimum:0,maximum:1048575},column:{type:'integer',minimum:0,maximum:16383},input:{type:'string',maxLength:32767}}}},
      reads:{type:'array',maxItems:200,items:{type:'object',additionalProperties:false,required:['sheetName','range'],properties:{sheetName,range}}},
    },(token,id,body,signal)=>sheets.recalculate(token,id,body.revision,{edits:body.edits,reads:body.reads},signal),1024*1024)
    route<{revision:string;path:string;cachePath:string}>('/api/v1/files/:id/sheets/pivot-definition',{
      ...revisionBody,path:{type:'string',maxLength:512,pattern:'^xl/pivotTables/[A-Za-z0-9._-]+\\.xml$'},cachePath:{type:'string',maxLength:512,pattern:'^xl/pivotCache/[A-Za-z0-9._-]+\\.xml$'},
    },(token,id,body,signal)=>sheets.readPivotDefinition(token,id,body.revision,body.path,body.cachePath,signal))
    route<{revision:string}>('/api/v1/files/:id/sheets/external-links',revisionBody,(token,id,body,signal)=>sheets.listExternalLinks(token,id,body.revision,signal))
    route<{revision:string;sources:ExternalLinkBinding[]}>('/api/v1/files/:id/sheets/external-links/preview',{
      ...revisionBody,sources:{type:'array',maxItems:256,items:{
        type:'object',additionalProperties:false,required:['index','fileId','revision'],
        properties:{index:{type:'integer',minimum:1,maximum:256},fileId:uuidSchema,revision:uuidSchema},
      }},
    },(token,id,body,signal)=>sheets.previewExternalLinkRefresh(token,id,body.revision,body.sources,signal),65536)
    route<{revision: string}>('/api/v1/files/:id/sheets/package', revisionBody, (token,id,body,signal) => sheets.readPackage(token,id,body.revision,signal))
    route<{revision: string; sheetName: string; kind: 'formulas' | 'outline'}>('/api/v1/files/:id/sheets/sheet', {...revisionBody,sheetName: {type:'string',minLength:1,maxLength:255},kind: {type:'string',enum:['formulas','outline']}}, (token,id,body,signal) => sheets.readSheet(token,id,body.revision,body.sheetName,body.kind,signal))
    route<{revision: string;openingViewport?:boolean}>('/api/v1/files/:id/sheets/inspect', {...revisionBody,openingViewport:{type:'boolean'}}, (token, id, body, signal) => sheets.inspect(token, id, body.revision, signal,body.openingViewport),4096,['openingViewport'])
    route('/api/v1/files/:id/sheets/range', {
      ...revisionBody,
      sheetName: { type: 'string', minLength: 1, maxLength: 255 },
      range: { type: 'object', additionalProperties: false, required: ['startRow','endRow','startColumn','endColumn'], properties: {
        startRow: { type: 'integer', minimum: 0, maximum: 1048575 }, endRow: { type: 'integer', minimum: 0, maximum: 1048575 },
        startColumn: { type: 'integer', minimum: 0, maximum: 16383 }, endColumn: { type: 'integer', minimum: 0, maximum: 16383 },
      } },
    }, (token, id, body: { revision: string; sheetName: string; range: SheetRange }, signal) => sheets.readRange(token, id, body.revision, body.sheetName, body.range, signal))
    api.post('/api/v1/files/:id/sheets/merge-sources/open',{bodyLimit:50*1024*1024,schema:{params:fileParamsSchema,querystring:{type:'object',additionalProperties:false,required:['revision','name'],properties:{revision:uuidSchema,name:{type:'string',minLength:1,maxLength:255}}}}},async(request,reply)=>{
      return withDisconnect(request,reply,signal=>{
        if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/octet-stream')throw Object.assign(new Error('Unsupported media type'),{statusCode:415})
        return admission.transfer(request,reply,()=>sheets.openMergeWorkbook(cookies(request).session??'',(request.params as {id:string}).id,(request.query as {revision:string}).revision,request.body as Buffer,(request.query as {name:string}).name,signal))
      })
    })
    route<{revision:string;sessionId:string;sheetName:string;range:SheetRange}>('/api/v1/files/:id/sheets/merge-sources/range',{
      ...revisionBody,sessionId:uuidSchema,sheetName:{type:'string',minLength:1,maxLength:255},range:{type:'object',additionalProperties:false,required:['startRow','endRow','startColumn','endColumn'],properties:{startRow:{type:'integer',minimum:0,maximum:1048575},endRow:{type:'integer',minimum:0,maximum:1048575},startColumn:{type:'integer',minimum:0,maximum:16383},endColumn:{type:'integer',minimum:0,maximum:16383}}},
    },(token,id,body,signal)=>sheets.readMergeWorkbookRange(token,id,body.revision,body.sessionId,body.sheetName,body.range,signal))
    route<{revision:string;sessionId:string}>('/api/v1/files/:id/sheets/merge-sources/close',{...revisionBody,sessionId:uuidSchema},(token,id,body)=>sheets.closeMergeWorkbook(token,id,body.revision,body.sessionId))
  })
}
