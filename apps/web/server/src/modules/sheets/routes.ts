import type {RecalcInput} from '../../../../worker/src/native/xlsx.ts'
import type { createSheetsSaveService, SheetsSaveInput } from './save.ts'
import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { uuidSchema, fileParamsSchema, emptyQuerySchema } from '../files/http-schema.ts'
import type { createSheetsService, SheetRange } from './service.ts'

const revisionBody = { revision: uuidSchema }
export function registerSheetsRoutes(app: FastifyInstance, sheets: ReturnType<typeof createSheetsService>, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>, saves?: ReturnType<typeof createSheetsSaveService>) {
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.originCheck(request, true)
      csrf.requireSession(request, token)
      await sessions.authenticate(token)
    })
    function route<T>(path: string, properties: Record<string, unknown>, operation: (token: string, fileId: string, body: T, signal: AbortSignal) => Promise<unknown>, bodyLimit = 4096) {
      api.post(path, { bodyLimit, schema: { params: fileParamsSchema, querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } } }, async (request, reply) => {
        const controller = new AbortController()
        const abort = () => controller.abort()
        request.raw.once('aborted', abort)
        const onClose = () => { if (!reply.raw.writableFinished) abort() }
        reply.raw.once('close', onClose)
        try {
          if (request.raw.aborted || reply.raw.destroyed) controller.abort()
          return await operation(cookies(request).session ?? '', (request.params as {id: string}).id, request.body as T, controller.signal)
        } finally {
          request.raw.removeListener('aborted', abort)
          reply.raw.removeListener('close', onClose)
        }
      })
    }
    if (saves) route<SheetsSaveInput>('/api/v1/files/:id/sheets/uploads', {
      baseRevision: uuidSchema, editorId: uuidSchema, leaseEpoch: {type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER}, request: {type: 'object'},
    }, (token,id,body,signal) => saves.prepare(token,id,body,signal), 4 * 1024 * 1024)
    const sheetName={type:'string',minLength:1,maxLength:255}
    const range={type:'object',additionalProperties:false,required:['startRow','endRow','startColumn','endColumn'],properties:{startRow:{type:'integer',minimum:0,maximum:1048575},endRow:{type:'integer',minimum:0,maximum:1048575},startColumn:{type:'integer',minimum:0,maximum:16383},endColumn:{type:'integer',minimum:0,maximum:16383}}}
    route<RecalcInput & {revision:string}>('/api/v1/files/:id/sheets/recalculate', {...revisionBody,
      edits:{type:'array',maxItems:10000,items:{type:'object',additionalProperties:false,required:['sheetName','row','column','input'],properties:{sheetName,row:{type:'integer',minimum:0,maximum:1048575},column:{type:'integer',minimum:0,maximum:16383},input:{type:'string',maxLength:32767}}}},
      reads:{type:'array',maxItems:200,items:{type:'object',additionalProperties:false,required:['sheetName','range'],properties:{sheetName,range}}},
    },(token,id,body,signal)=>sheets.recalculate(token,id,body.revision,{edits:body.edits,reads:body.reads},signal),1024*1024)
    route<{revision: string}>('/api/v1/files/:id/sheets/package', revisionBody, (token,id,body,signal) => sheets.readPackage(token,id,body.revision,signal))
    route<{revision: string; sheetName: string; kind: 'formulas' | 'outline'}>('/api/v1/files/:id/sheets/sheet', {...revisionBody,sheetName: {type:'string',minLength:1,maxLength:255},kind: {type:'string',enum:['formulas','outline']}}, (token,id,body,signal) => sheets.readSheet(token,id,body.revision,body.sheetName,body.kind,signal))
    route<{revision: string}>('/api/v1/files/:id/sheets/inspect', revisionBody, (token, id, body, signal) => sheets.inspect(token, id, body.revision, signal))
    route('/api/v1/files/:id/sheets/range', {
      ...revisionBody,
      sheetName: { type: 'string', minLength: 1, maxLength: 255 },
      range: { type: 'object', additionalProperties: false, required: ['startRow','endRow','startColumn','endColumn'], properties: {
        startRow: { type: 'integer', minimum: 0, maximum: 1048575 }, endRow: { type: 'integer', minimum: 0, maximum: 1048575 },
        startColumn: { type: 'integer', minimum: 0, maximum: 16383 }, endColumn: { type: 'integer', minimum: 0, maximum: 16383 },
      } },
    }, (token, id, body: { revision: string; sheetName: string; range: SheetRange }, signal) => sheets.readRange(token, id, body.revision, body.sheetName, body.range, signal))
  })
}
