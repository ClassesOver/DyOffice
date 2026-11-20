import type {FastifyInstance} from 'fastify'
import type {SessionService} from '../auth/sessions.ts'
import {authError} from '../auth/sessions.ts'
import {cookies,type createCsrfService} from '../auth/csrf.ts'

type MediaService={generateImage(token:string,input:{prompt:string;aspectRatio?:string;referenceImageUrls?:string[];transparentBackground?:boolean}):Promise<unknown>;analyzeMedia(token:string,input:{mediaUrls:string[];requirements:string}):Promise<unknown>;fetchImage(token:string,url:string):Promise<unknown>}
const generateSchema={type:'object',additionalProperties:false,required:['action','prompt'],properties:{action:{const:'generate_image'},prompt:{type:'string',minLength:1,maxLength:4000},aspectRatio:{type:'string',enum:['1:1','4:3','16:9','9:16','3:4','2:3','3:2','auto']},referenceImageUrls:{type:'array',maxItems:12,items:{type:'string',maxLength:17_000_000}},transparentBackground:{type:'boolean'}}}
const analyzeSchema={type:'object',additionalProperties:false,required:['action','mediaUrls','requirements'],properties:{action:{const:'analyze_media'},mediaUrls:{type:'array',minItems:1,maxItems:12,items:{type:'string',maxLength:17_000_000}},requirements:{type:'string',minLength:1,maxLength:2000}}}
const fetchSchema={type:'object',additionalProperties:false,required:['action','url'],properties:{action:{const:'fetch_image'},url:{type:'string',pattern:'^https://',maxLength:4096}}}

export function registerAiMediaRoutes(app:FastifyInstance,{service,sessions,csrf}:{service:MediaService;sessions:Pick<SessionService,'authenticate'>;csrf:Pick<ReturnType<typeof createCsrfService>,'requireSession'>}){
 app.register(async api=>{
  api.addHook('onRequest',async(request,reply)=>{
   reply.header('Cache-Control','private, no-store');reply.header('Vary','Cookie')
   const token=cookies(request).session
   if(!token)throw authError()
   csrf.requireSession(request,token)
   await sessions.authenticate(token)
  })
  api.post('/api/v1/ai/media',{bodyLimit:24*1024*1024,schema:{querystring:{type:'object',additionalProperties:false,properties:{}},body:{oneOf:[generateSchema,analyzeSchema,fetchSchema]}}},async(request,reply)=>{
   const token=cookies(request).session!,body=request.body as {action:'generate_image';prompt:string;aspectRatio?:string;referenceImageUrls?:string[];transparentBackground?:boolean}|{action:'analyze_media';mediaUrls:string[];requirements:string}|{action:'fetch_image';url:string}
   try{
    if(body.action==='generate_image'){
     const {action,...input}=body
     return await service.generateImage(token,input)
    }
    if(body.action==='fetch_image')return await service.fetchImage(token,body.url)
    const {action,...input}=body
    return await service.analyzeMedia(token,input)
   }catch{return reply.code(503).send({error:'AI media unavailable'})}
  })
 })
}
