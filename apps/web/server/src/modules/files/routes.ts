import {editorFileToken as token,authenticateEditorFile} from '../dsh-edit/http.ts'
import { chatBodySchema } from './assistant-chat.ts'
import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import type { createCsrfService } from '../auth/csrf.ts'
import { authError } from '../auth/sessions.ts'
import { objectTransferAdmission } from './transfer-admission.ts'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import type { FileService } from './service.ts'

import { uuidSchema as id, fileParamsSchema as params, emptyQuerySchema as emptyQuery } from './http-schema.ts'
import { registerRevisionRoutes } from '../revisions/routes.ts'
import type { RevisionService } from '../revisions/service.ts'
import type { LeaseService } from '../leases/service.ts'
import { createAiCsvDocument, createAiXlsxDocument, type AiXlsxInput } from '../sheets/create-document.ts'
import { withDisconnect } from '../request-signal.ts'
import type { EncryptedOfficeFormat } from '../../../../../../packages/web-contracts/src/api.ts'
import { officeDocumentConversionTargets, workspaceConversionTargets, type OfficeDocumentConversionFormat, type WorkspaceConversionFormat } from '../../../../../../packages/web-contracts/src/file-imports.ts'
import { convertOfficeDocument } from './office-import.ts'

const encryptedWorkbookMime = 'application/vnd.dyoffice.encrypted-xlsx'
const encryptedMacroWorkbookMime = 'application/vnd.dyoffice.encrypted-xlsm'
const encryptedDocumentMime = 'application/vnd.dyoffice.encrypted-docx'
const documentPasswordChangeMime = 'application/vnd.dyoffice.docx-password-change'
const maxPasswordBytes = 255 * 4
const passwordPrefixBytes = 2
const contentType = (header: string | undefined) => header?.split(';')[0].trim().toLowerCase()
function encryptedFormat(type: string | undefined):EncryptedOfficeFormat|undefined {
  if(type===encryptedWorkbookMime)return 'xlsx'
  if(type===encryptedMacroWorkbookMime)return 'xlsm'
  if(type===encryptedDocumentMime)return 'docx'
}

// The binary request carries a UTF-8 password length, the password, then the Office bytes.
function encryptedOfficeBody(input: unknown,allowEmptyPassword=false) {
  if (!Buffer.isBuffer(input) || input.length <= passwordPrefixBytes) throw authError(400)
  const length = input.readUInt16BE()
  const offset = passwordPrefixBytes + length
  if ((!length&&!allowEmptyPassword) || length > maxPasswordBytes || offset >= input.length) throw authError(400)
  let password: string
  try { password = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.subarray(passwordPrefixBytes, offset)) }
  catch { throw authError(400) }
  finally { input.fill(0, passwordPrefixBytes, offset) }
  if (password.length > 255) throw authError(400)
  return { password, bytes: input.subarray(offset) }
}

const sheetSizes = (maxIndex:number) => ({type:'array',maxItems:maxIndex,items:{type:'array',minItems:2,maxItems:2,items:[{type:'integer',minimum:1,maximum:maxIndex},{type:'number',exclusiveMinimum:0}]}})
const sheetLayout = {type:'object',additionalProperties:false,required:['defaultRowHeight','defaultColumnWidth','rows','columns'],properties:{
  defaultRowHeight:{type:'number',exclusiveMinimum:0},defaultColumnWidth:{type:'number',exclusiveMinimum:0},rows:sheetSizes(1048576),columns:sheetSizes(16384),
}}
const conversionFormats = Object.keys(workspaceConversionTargets) as WorkspaceConversionFormat[]
type FileConverter = (bytes: Buffer, signal: AbortSignal) => Promise<Buffer>
type WorkbookConverters = Partial<Record<'tsv'|'xls'|'ods'|'ots', FileConverter>>
export function registerFileRoutes(app: FastifyInstance, files: FileService, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>, saves?: { revisions: RevisionService; leases: LeaseService; wordCollaboration?: boolean }, workbookConverters: WorkbookConverters = {}, editableCsv = false) {
  const admission = objectTransferAdmission(app)
  const { transfer } = admission
  const converters: Partial<Record<WorkspaceConversionFormat, FileConverter>> = {
    ...(files.capabilities?.xlsx === 'editable' && workbookConverters),
  }
  for (const format of Object.keys(officeDocumentConversionTargets) as OfficeDocumentConversionFormat[]) {
    if (files.capabilities?.[officeDocumentConversionTargets[format]] === 'editable') {
      converters[format] = (bytes, signal) => convertOfficeDocument(bytes, format, signal)
    }
  }
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const mutation = !['GET','HEAD','OPTIONS'].includes(request.method)
      const credential = await authenticateEditorFile(request,sessions,csrf,mutation)
      // Hold admission through processing AND response completion. A client
      // disconnect cannot free capacity while object work still owns buffers.
      const path = request.routeOptions.url
      const convertingFile = conversionFormats.some(format => path === `/api/v1/files/convert-${format}`)
      if ((['PUT','GET','HEAD'].includes(request.method) && path?.endsWith('/content')) || (request.method === 'POST' && (path?.endsWith('/uploads') || path?.endsWith('/purge') || path?.endsWith('/finish') || path?.endsWith('/commits') || path?.endsWith('/restoration-uploads') || path?.endsWith('/ai/xlsx-documents') || path?.endsWith('/ai/csv-documents') || path?.endsWith('/docx/unlock') || path?.endsWith('/docx/import-unlock') || path?.endsWith('/docx/recovery-draft') || path?.endsWith('/files/new-pdf') || convertingFile))) {
        if (request.method === 'PUT') {
          const format = encryptedFormat(contentType(request.headers['content-type']))
          const upload = await files.preflightUpload(credential, (request.params as { id: string }).id, format)
          const length = request.headers['content-length']
          if (length !== undefined) {
            const overhead = Number(length) - upload.size
            if (!/^\d+$/.test(length) || (format
              ? overhead <= passwordPrefixBytes || overhead > passwordPrefixBytes + maxPasswordBytes
              : overhead !== 0)) throw authError(400)
          }
        }
        // Briefly wait for transfers explicitly initiated by the user. The
        // editor's background reads keep their immediate backpressure.
        const interactiveDownload = request.method==='GET' && request.routeOptions.url==='/api/v1/files/:id/content' &&
          (request.query as {download?:string}).download==='1'
        const initialDocumentRead=request.method==='POST'&&request.routeOptions.url==='/api/v1/files/:id/docx/import-unlock'
        await admission.admit(request, reply,
          request.method==='PUT' ? {waitMs:2_000} : interactiveDownload||initialDocumentRead ? {waitMs:10_000} : undefined)
      }
    })
    api.addHook('onResponse', async request => admission.close(request))
    api.addHook('onError', async request => admission.error(request))
    if (saves) registerRevisionRoutes(api,{ ...saves, transfer })
    api.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_OBJECT_BYTES }, (_request, body, done) => done(null, body))
    api.addContentTypeParser([encryptedWorkbookMime,encryptedMacroWorkbookMime,encryptedDocumentMime,documentPasswordChangeMime], { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
    api.get('/api/v1/capabilities', { schema: { querystring: emptyQuery } }, async () => ({
      ...files.capabilities,
      ...(editableCsv && {csvImport:'editable'}),
      ...Object.fromEntries(conversionFormats.filter(format=>converters[format]).map(format=>[`${format}Import`,'editable'])),
    }))
    for (const format of conversionFormats) {
      const convert = converters[format]
      if (!convert) continue
      api.post(`/api/v1/files/convert-${format}`, {bodyLimit:MAX_OBJECT_BYTES,schema:{querystring:emptyQuery}}, (request,reply)=>withDisconnect(request,reply,signal=>transfer(request,reply,async()=>{
        if(contentType(request.headers['content-type'])!=='application/octet-stream')throw authError(415)
        const bytes=await convert(Buffer.isBuffer(request.body)?request.body:Buffer.alloc(0),signal)
        return reply.header('Content-Security-Policy',"sandbox; default-src 'none'").type('application/octet-stream').send(bytes)
      })))
    }
    api.get('/api/v1/storage/usage', { schema: { querystring: emptyQuery } }, request => files.usage(token(request)))
    api.post('/api/v1/files/new-pdf', { bodyLimit:4096, schema:{querystring:emptyQuery} }, (request,reply)=>transfer(request,reply,async()=>{
      if(request.body!==undefined)throw authError(400)
      if(files.capabilities.pdfEditor!=='editable')throw authError(415)
      return reply.code(201).send(await files.createBlankPdf(token(request)))
    }))
    api.post('/api/v1/files/uploads', { bodyLimit: 4096, schema: { querystring: emptyQuery, body: { type: 'object', additionalProperties: false, required: ['name','size'], properties: { name: { type: 'string', minLength: 1, maxLength: 255 }, size: { type: 'integer', minimum: 0, maximum: MAX_OBJECT_BYTES }, autoName:{type:'boolean'}, folderId:id } } } }, (request, reply) => transfer(request, reply, async () => {
      const staged = await files.stageUpload(token(request), request.body as { name: string; size: number; autoName?:boolean;folderId?:string })
      return reply.code(201).send(staged)
    }))
    api.post<{Params:{id:string}}>('/api/v1/files/:id/duplicate/uploads', {bodyLimit:4096,schema:{params,querystring:emptyQuery}}, (request,reply)=>transfer(request,reply,async()=>{
      if (request.body !== undefined) throw authError(400)
      return reply.code(201).send(await files.prepareDuplicate(token(request),request.params.id))
    }))
    api.post<{Params:{id:string;uploadId:string};Body:{revision:string;language:'en'|'zh'}}>('/api/v1/files/:id/duplicate/:uploadId/finish', {bodyLimit:4096,schema:{
      params:{type:'object',additionalProperties:false,required:['id','uploadId'],properties:{id,uploadId:id}},
      querystring:emptyQuery,body:{type:'object',additionalProperties:false,required:['revision','language'],properties:{revision:id,language:{type:'string',enum:['en','zh']}}},
    }}, (request,reply)=>transfer(request,reply,async()=>{
      const {id:fileId,uploadId}=request.params
      const {revision,language}=request.body
      return files.finishDuplicate(token(request),fileId,uploadId,revision,language)
    }))
    api.put('/api/v1/uploads/:id/content', { bodyLimit: MAX_OBJECT_BYTES + passwordPrefixBytes + maxPasswordBytes, schema: { params, querystring: emptyQuery } }, (request, reply) => withDisconnect(request, reply, signal => transfer(request, reply, async () => {
      const { id } = request.params as { id: string }
      const type = contentType(request.headers['content-type'])
      const format=encryptedFormat(type)
      if (format) {
        const { password, bytes } = encryptedOfficeBody(request.body)
        return files.receiveUpload(token(request),id,bytes,{
          password,signal,format,readAfterImport:format==='docx'&&request.headers['x-dyoffice-open-after-import']==='1',
        })
      }
      if (type !== 'application/octet-stream') throw authError(415)
      return files.receiveUpload(token(request), id, (request.body as Buffer | undefined) ?? Buffer.alloc(0))
    })))
    api.post('/api/v1/uploads/:id/finish', { bodyLimit: 4096, schema: { params, querystring: emptyQuery } }, (request, reply) => transfer(request, reply, async () => {
      if (request.body !== undefined) throw authError(400)
      return files.finishUpload(token(request), (request.params as { id: string }).id)
    }))
    api.post('/api/v1/ai/xlsx-documents', { bodyLimit: 16*1024*1024, schema: { querystring: emptyQuery, body: { type:'object',additionalProperties:false,required:['title','content'],properties:{title:{type:'string',minLength:1,maxLength:200},sheetName:{type:'string',minLength:1,maxLength:31},content:{type:'string',minLength:1,maxLength:15*1024*1024},layout:sheetLayout} } } }, (request,reply) => transfer(request,reply,async()=>{
      if(files.capabilities.xlsx!=='editable')throw authError(415)
      return createAiXlsxDocument(files,token(request),request.body as AiXlsxInput)
    }))
    api.post<{Querystring:{title:string}}>('/api/v1/ai/csv-documents', {
      bodyLimit:MAX_OBJECT_BYTES-3,
      schema:{querystring:{type:'object',additionalProperties:false,required:['title'],properties:{title:{type:'string',minLength:1,maxLength:200}}}},
    },(request,reply)=>transfer(request,reply,async()=>{
      if(!editableCsv||contentType(request.headers['content-type'])!=='application/octet-stream')throw authError(415)
      if(!Buffer.isBuffer(request.body))throw authError(400)
      return createAiCsvDocument(files,token(request),request.query.title,request.body)
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
    api.post<{Params:{id:string};Body:{revision:string;password:string;editorId?:string}}>('/api/v1/files/:id/docx/unlock', {bodyLimit:4096,schema:{params,querystring:emptyQuery,body:{
      type:'object',additionalProperties:false,required:['revision','password'],properties:{revision:id,editorId:id,password:{type:'string',minLength:1,maxLength:255}},
    }}}, (request,reply)=>withDisconnect(request,reply,signal=>transfer(request,reply,async()=>{
      const {revision,password,editorId}=request.body
      const {bytes,editId}=await files.openProtectedDocument(token(request),request.params.id,revision,password,signal,editorId)
      if(editId)reply.header('X-DyOffice-Docx-Unlock',editId)
      return reply.header('Content-Security-Policy',"sandbox; default-src 'none'").type('application/octet-stream').send(bytes)
    })))
    api.delete<{Params:{id:string};Body:{unlockId:string}}>('/api/v1/files/:id/docx/unlock',{bodyLimit:4096,schema:{params,querystring:emptyQuery,body:{
      type:'object',additionalProperties:false,required:['unlockId'],properties:{unlockId:id},
    }}},async(request,reply)=>{
      files.closeDocumentEdit(token(request),request.params.id,request.body.unlockId)
      return reply.code(204).send()
    })
    const importReadOptions={bodyLimit:4096,schema:{params,querystring:emptyQuery,body:{
      type:'object',additionalProperties:false,required:['revision','unlockId'],properties:{revision:id,unlockId:id,editorId:id},
    }}}
    type ImportReadRequest={Params:{id:string};Body:{revision:string;unlockId:string;editorId?:string}}
    api.post<ImportReadRequest>('/api/v1/files/:id/docx/import-unlock',importReadOptions,(request,reply)=>withDisconnect(request,reply,signal=>transfer(request,reply,async()=>{
      const {revision,unlockId,editorId}=request.body
      const {bytes,editId}=await files.claimDocumentImportRead(token(request),request.params.id,revision,unlockId,signal,editorId)
      if(editId)reply.header('X-DyOffice-Docx-Unlock',editId)
      return reply.header('Content-Security-Policy',"sandbox; default-src 'none'").type('application/octet-stream').send(bytes)
    })))
    api.delete<ImportReadRequest>('/api/v1/files/:id/docx/import-unlock',importReadOptions,async(request,reply)=>{
      files.revokeDocumentImportRead(token(request),request.params.id,request.body.revision,request.body.unlockId)
      return reply.code(204).send()
    })
    api.post<{Params:{id:string};Querystring:{editorId:string}}>('/api/v1/files/:id/docx/recovery-draft',{
      bodyLimit:MAX_OBJECT_BYTES,schema:{params,querystring:{
        type:'object',additionalProperties:false,required:['editorId'],properties:{editorId:id},
      }},
    },(request,reply)=>withDisconnect(request,reply,signal=>transfer(request,reply,async()=>{
      const unlockId=request.headers['x-dyoffice-docx-unlock']
      if(typeof unlockId!=='string')throw authError(423)
      if(contentType(request.headers['content-type'])!=='application/octet-stream')throw authError(415)
      if(!Buffer.isBuffer(request.body)||!request.body.length)throw authError(400)
      const bytes=await files.sealDocumentRecovery(token(request),request.params.id,request.query.editorId,unlockId,request.body,signal)
      return reply.header('Content-Security-Policy',"sandbox; default-src 'none'").type('application/octet-stream').send(bytes)
    })))
    if(saves)api.post<{Params:{id:string};Querystring:{baseRevision:string;editorId:string;leaseEpoch:string}}>('/api/v1/files/:id/docx/uploads',{bodyLimit:MAX_OBJECT_BYTES,schema:{params,querystring:{
      type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch'],properties:{baseRevision:id,editorId:id,leaseEpoch:{type:'string',pattern:'^[1-9][0-9]{0,15}$'}},
    }}},(request,reply)=>withDisconnect(request,reply,signal=>transfer(request,reply,async()=>{
      const unlockId=request.headers['x-dyoffice-docx-unlock']
      if(typeof unlockId!=='string')throw authError(423)
      if(contentType(request.headers['content-type'])!=='application/octet-stream'||!Buffer.isBuffer(request.body)||!request.body.length)throw authError(400)
      const {editorId,baseRevision}=request.query,leaseEpoch=Number(request.query.leaseEpoch),credential=token(request),fileId=request.params.id
      await saves.leases.renewLease(credential,fileId,{editorId,leaseEpoch,docxUnlockId:unlockId})
      return saves.revisions.prepareProtectedDocx(credential,fileId,{editorId,baseRevision,leaseEpoch},unlockId,request.body,signal)
    })))
    if(saves)api.post<{Params:{id:string};Querystring:{baseRevision:string;editorId:string;leaseEpoch:string}}>('/api/v1/files/:id/docx/password/uploads',{
      bodyLimit:MAX_OBJECT_BYTES+passwordPrefixBytes+maxPasswordBytes,schema:{params,querystring:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch'],properties:{baseRevision:id,editorId:id,leaseEpoch:{type:'string',pattern:'^[1-9][0-9]{0,15}$'}},
      }},
    },(request,reply)=>withDisconnect(request,reply,signal=>transfer(request,reply,async()=>{
      if(contentType(request.headers['content-type'])!==documentPasswordChangeMime)throw authError(415)
      const unlockId=request.headers['x-dyoffice-docx-unlock']
      if(unlockId!==undefined&&typeof unlockId!=='string')throw authError(400)
      const {baseRevision,editorId}=request.query,leaseEpoch=Number(request.query.leaseEpoch),credential=token(request),fileId=request.params.id
      await saves.leases.renewLease(credential,fileId,{editorId,leaseEpoch,docxUnlockId:unlockId})
      const {password,bytes}=encryptedOfficeBody(request.body,true)
      return saves.revisions.prepareDocxPasswordChange(credential,fileId,{baseRevision,editorId,leaseEpoch},password,unlockId,bytes,signal)
    })))
    if(saves)api.post<{Params:{id:string};Querystring:{name:string;baseRevision:string;editorId:string;leaseEpoch:string}}>('/api/v1/files/:id/docx/copy/uploads',{bodyLimit:MAX_OBJECT_BYTES+passwordPrefixBytes+maxPasswordBytes,schema:{params,querystring:{
      type:'object',additionalProperties:false,required:['name','baseRevision','editorId','leaseEpoch'],properties:{
        name:{type:'string',minLength:1,maxLength:255},baseRevision:id,editorId:id,leaseEpoch:{type:'string',pattern:'^[1-9][0-9]{0,15}$'},
      },
    }}},(request,reply)=>withDisconnect(request,reply,signal=>transfer(request,reply,async()=>{
      const unlockId=request.headers['x-dyoffice-docx-unlock']
      if(unlockId!==undefined&&typeof unlockId!=='string')throw authError(400)
      const mime=contentType(request.headers['content-type'])
      if(mime!=='application/octet-stream'&&mime!==documentPasswordChangeMime)throw authError(415)
      if(!Buffer.isBuffer(request.body)||!request.body.length)throw authError(400)
      const {password,bytes}=mime===documentPasswordChangeMime?encryptedOfficeBody(request.body,true):{password:undefined,bytes:request.body}
      if(bytes.length>MAX_OBJECT_BYTES)throw authError(413)
      const {name,baseRevision,editorId}=request.query,leaseEpoch=Number(request.query.leaseEpoch),credential=token(request),fileId=request.params.id
      await saves.leases.renewLease(credential,fileId,{editorId,leaseEpoch,docxUnlockId:unlockId})
      const result=await files.prepareDocumentDraftCopy(credential,fileId,{name,baseRevision,editorId,leaseEpoch},unlockId,bytes,password,signal)
      return reply.code(201).send(result)
    })))

    api.get('/api/v1/files/:id/content', { schema: { params, querystring: { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: id, download: {type:'string',const:'1'} } } } }, (request, reply) => transfer(request, reply, async () => {
      const result = await files.download(token(request), (request.params as { id: string }).id, (request.query as { revision: string }).revision)
      const name = encodeURIComponent(result.name).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())
      return reply.header('Content-Type', 'application/octet-stream').header('Content-Security-Policy', "sandbox; default-src 'none'")
        .header('Content-Disposition', `attachment; filename="download.${result.format}"; filename*=UTF-8''${name}`).send(result.bytes)
    }))
    api.patch('/api/v1/files/:id', { bodyLimit: 4096, schema: { params, querystring: emptyQuery, body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 255 } } } } }, async (request, reply) => {
      await files.renameFile(token(request), (request.params as { id: string }).id, (request.body as { name: string }).name)
      return reply.code(204).send()
    })
    api.post('/api/v1/files/:id/auto-name',{bodyLimit:4096,schema:{params,querystring:emptyQuery,body:{type:'object',additionalProperties:false,required:['revision','candidate'],properties:{revision:id,candidate:{type:'string',minLength:1,maxLength:255}}}}},request=>{
      const {revision,candidate}=request.body as {revision:string;candidate:string}
      return files.nameBlankFile(token(request),(request.params as {id:string}).id,revision,candidate)
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
