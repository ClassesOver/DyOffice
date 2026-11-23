import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import type { createStyleTemplateService } from './service.ts'

export function registerStyleTemplateRoutes(app:FastifyInstance,templates:ReturnType<typeof createStyleTemplateService>,sessions:Pick<SessionService,'authenticate'>,csrf:Pick<ReturnType<typeof createCsrfService>,'requireSession'|'requireSessionRead'>){
 const querystring={type:'object',additionalProperties:false,properties:{name:{type:'string',maxLength:256}}} as const
 const body={type:'object',additionalProperties:false,required:['name','topic','styleSkill','createdAt'],properties:{name:{type:'string',minLength:1,maxLength:256},topic:{type:'string',maxLength:4096},styleSkill:{type:'string',minLength:1,maxLength:262144},createdAt:{type:'string',minLength:1,maxLength:64},layout:{type:'object',additionalProperties:true}}} as const
 app.register(async api=>{
  api.addHook('onRequest',async(request,reply)=>{
   reply.header('Cache-Control','private, no-store');reply.header('Vary','Cookie')
   const token=cookies(request).session??''
   await sessions.authenticate(token)
   if(request.method==='GET')csrf.requireSessionRead(request,token)
   else csrf.requireSession(request,token)
  })
  api.get('/api/v1/ai/style-templates',{schema:{querystring:{type:'object',additionalProperties:false,properties:{}}}},request=>templates.list(cookies(request).session!))
  api.get('/api/v1/ai/style-templates/load',{schema:{querystring:{...querystring,required:['name']}}},request=>templates.load(cookies(request).session!,String((request.query as {name:string}).name)))
  api.put('/api/v1/ai/style-templates',{bodyLimit:300000,schema:{querystring:{type:'object',additionalProperties:false,properties:{}},body}},request=>{
   const {name,...value}=request.body as {name:string;topic:string;styleSkill:string;createdAt:string;layout?:unknown}
   return templates.save(cookies(request).session!,name,value)
  })
 })
}
