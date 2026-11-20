import type {FastifyInstance} from 'fastify'
import {parseBytesToText} from '../../../../../../packages/file-parse/src/index.ts'
import type {SessionService} from '../auth/sessions.ts'
import {authError} from '../auth/sessions.ts'
import {cookies,type createCsrfService} from '../auth/csrf.ts'

const MAX_ATTACHMENT_BYTES=50*1024*1024
const MAX_IMAGE_BYTES=5*1024*1024
const MAX_TEXT_CHARS=1_000_000
const allowed=new Set(['txt','md','markdown','csv','tsv','json','yaml','yml','xml','html','htm','log','js','ts','tsx','jsx','py','java','c','h','cpp','go','rs','rb','sh','sql','css','doc','docx','pdf','pptx','ppt','xlsx','xlsm','xls','png','jpg','jpeg','gif','webp'])
const images=new Set(['png','jpg','jpeg','gif','webp'])

export function registerAssistantAttachmentRoutes(app:FastifyInstance,options:{sessions:Pick<SessionService,'authenticate'>;csrf:Pick<ReturnType<typeof createCsrfService>,'originCheck'|'requireSession'>;convertLegacyWorkbook?:(bytes:Buffer,signal:AbortSignal)=>Promise<Buffer>}) {
 app.register(async api=>{
  api.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:MAX_ATTACHMENT_BYTES},(_request,body,done)=>done(null,body))
  api.addHook('onRequest',async(request,reply)=>{
   reply.header('Cache-Control','private, no-store')
   const session=cookies(request).session
   if(!session)throw authError(401)
   options.csrf.originCheck(request,true)
   options.csrf.requireSession(request,session)
   await options.sessions.authenticate(session)
  })
  api.post('/api/v1/ai/attachments/parse',{bodyLimit:MAX_ATTACHMENT_BYTES,schema:{querystring:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',minLength:1,maxLength:255}}}}},async (request,reply)=>{
   if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/octet-stream')throw authError(415)
   const name=(request.query as {name:string}).name
   if(name.length>255||/[\\/\x00-\x1f\x7f]/.test(name))throw authError(400)
   const ext=name.split('.').at(-1)?.toLowerCase()??''
   if(!allowed.has(ext))throw authError(400)
   const bytes=request.body as Buffer
   if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>MAX_ATTACHMENT_BYTES)throw authError(400)
   if(images.has(ext)&&bytes.length>MAX_IMAGE_BYTES)throw authError(413)
   let workbook:Buffer|undefined
   if(ext==='xls'&&options.convertLegacyWorkbook){
    const controller=new AbortController(),onClose=()=>{if(!reply.raw.writableFinished)controller.abort()}
    reply.raw.once('close',onClose)
    try{workbook=await options.convertLegacyWorkbook(bytes,controller.signal)}
    catch(error){
     if(error instanceof Error&&'statusCode' in error&&error.statusCode===400)return {ok:false,kind:'text',error:'Invalid or unsupported XLS workbook.'}
     throw error
    }finally{reply.raw.removeListener('close',onClose)}
   }
   const parsed=await parseBytesToText(workbook?'converted.xlsx':name,workbook??bytes,{maxChars:MAX_TEXT_CHARS})
   const text=parsed.text??''
   return {ok:parsed.ok,kind:parsed.kind,...(parsed.mime?{mime:parsed.mime}:{}),...(parsed.error?{error:parsed.error}:{}),...(parsed.ok&&parsed.kind==='text'?{text:text.slice(0,MAX_TEXT_CHARS),totalChars:text.length,truncated:text.length>=MAX_TEXT_CHARS}:{})}
  })
 })
}
