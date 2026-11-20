import type {FastifyInstance,FastifyRequest} from 'fastify'
import type {SessionService} from '../auth/sessions.ts'
import {authError} from '../auth/sessions.ts'
import {cookies,type createCsrfService} from '../auth/csrf.ts'
import {emptyQuerySchema} from '../files/http-schema.ts'
import {objectTransferAdmission} from '../files/transfer-admission.ts'
import type {KnowledgeService} from './service.ts'
const token=(request:FastifyRequest)=>cookies(request).session??''
const path={type:'string',minLength:1,maxLength:1500}
export function registerKnowledgeRoutes(app:FastifyInstance,service:KnowledgeService,sessions:SessionService,csrf:ReturnType<typeof createCsrfService>){
 const admission=objectTransferAdmission(app)
 app.register(async api=>{
  api.addHook('onRequest',async(request,reply)=>{
   reply.header('Cache-Control','private, no-store')
   const credential=token(request)
   if(!credential)throw authError(401)
   const mutation=!['GET','HEAD','OPTIONS'].includes(request.method)
   csrf.originCheck(request,mutation)
   if(mutation)csrf.requireSession(request,credential)
   await sessions.authenticate(credential)
   await admission.admit(request,reply)
  })
  api.addHook('onResponse',async request=>admission.close(request))
  api.addHook('onError',async request=>admission.error(request))
  api.get('/api/v1/knowledge/files',{schema:{querystring:emptyQuerySchema}},(request,reply)=>admission.transfer(request,reply,()=>service.list(token(request))))
  api.get('/api/v1/knowledge/read',{schema:{querystring:{type:'object',additionalProperties:false,required:['path'],properties:{path,offset:{type:'string',pattern:'^(?:0|[1-9][0-9]{0,9})$'}}}}},(request,reply)=>admission.transfer(request,reply,()=>{
   const input=request.query as {path:string;offset?:string}
   return service.read(token(request),input.path,input.offset===undefined?0:Number(input.offset))
  }))
  api.post('/api/v1/knowledge/search',{bodyLimit:16*1024*1024,schema:{querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['q','paths'],properties:{q:{type:'string',minLength:1,maxLength:200},limit:{type:'integer',minimum:1,maximum:20},paths:{type:'array',maxItems:10000,uniqueItems:true,items:path}}}}},(request,reply)=>admission.transfer(request,reply,()=>service.search(token(request),request.body as {q:string;limit?:number;paths:string[]})))
 })
}
