import type {FastifyInstance} from 'fastify'
import type {SessionService} from '../auth/sessions.ts'
import {authError} from '../auth/sessions.ts'
import {cookies,type createCsrfService} from '../auth/csrf.ts'

type SearchService={search(token:string,input:{kind:'web_search'|'image_search';query:string;maxResults:number}):Promise<unknown>}
const bodySchema={type:'object',additionalProperties:false,required:['kind','query','maxResults'],properties:{kind:{type:'string',enum:['web_search','image_search']},query:{type:'string',minLength:1,maxLength:300},maxResults:{type:'integer',minimum:1,maximum:8}}}

export function registerAiSearchRoutes(app:FastifyInstance,{service,sessions,csrf}:{service:SearchService;sessions:Pick<SessionService,'authenticate'>;csrf:Pick<ReturnType<typeof createCsrfService>,'requireSession'>}){
 app.register(async api=>{
  api.addHook('onRequest',async(request,reply)=>{
   reply.header('Cache-Control','private, no-store');reply.header('Vary','Cookie')
   const token=cookies(request).session
   if(!token)throw authError()
   csrf.requireSession(request,token)
   await sessions.authenticate(token)
  })
  api.post('/api/v1/ai/search',{bodyLimit:4096,schema:{querystring:{type:'object',additionalProperties:false,properties:{}},body:bodySchema}},async(request,reply)=>{
   const token=cookies(request).session!
   try{return await service.search(token,request.body as {kind:'web_search'|'image_search';query:string;maxResults:number})}
   catch{return reply.code(503).send({error:'AI search unavailable'})}
  })
 })
}
