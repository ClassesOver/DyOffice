import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { authError } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import {ProviderTurnTimeout,type TurnEvent} from './turns.ts'
import {ProviderResponseFailure} from './response-failure.ts'
import {ASSISTANT_MAX_REQUEST_BYTES} from '../../../../../../packages/web-contracts/src/assistant.ts'

export interface TurnRunner {
  run(input: { token: string; modelId: string; turnId: string; request: unknown; signal?: AbortSignal; documentId?:string; continuation?:unknown; admit?:(signal:AbortSignal)=>Promise<void> }, emit: (event: TurnEvent) => Promise<void>): Promise<void>
  cancel(token: string, turnId: string): Promise<boolean>
}
export type AdmitHarnessContinuation = (token:string,modelId:string,input:{taskId:string;documentId:string;revision:string},request:unknown,signal:AbortSignal)=>Promise<void>
const object = (properties: object) => ({type:'object',additionalProperties:false,required:Object.keys(properties),properties})
const id = {type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'}
const documentId={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'}
/** Opt-in adapter only. app.ts does not mount it until T12 authority/secret/budget integration is verified. */
export function registerProviderRoutes(app: FastifyInstance, options: {
  turns: TurnRunner; sessions: Pick<SessionService,'authenticate'>;
  csrf: Pick<ReturnType<typeof createCsrfService>,'requireSession'> & Partial<Pick<ReturnType<typeof createCsrfService>,'requireSessionRead'>>; maxOutputBytes?: number; endpoint?: string; errorMessage?: string
  taskStatus?:(token:string,turnId:string,documentId:string)=>Promise<unknown>
  claimContinuation?:(token:string,turnId:string,input:{documentId:string;revision:string;modelId:string;defer?:boolean})=>Promise<unknown>
  admitContinuation?:AdmitHarnessContinuation
}) {
  const endpoint = options.endpoint ?? '/api/v1/ai/turns'
  if (!['/api/v1/ai/turns','/api/v1/agents/tasks'].includes(endpoint)) throw new Error('Invalid turn endpoint')
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 128 || maxOutputBytes > 32 * 1024 * 1024) throw new Error('Invalid AI output limit')
  app.register(async api => {
    api.addHook('onRequest',async (request,reply) => {
      reply.header('Cache-Control','private, no-store')
      const token=cookies(request).session
      if (!token) throw authError()
      if(request.method==='GET'&&options.csrf.requireSessionRead)options.csrf.requireSessionRead(request,token)
      else options.csrf.requireSession(request,token)
      await options.sessions.authenticate(token)
    })
    const turnRequest={type:'object',additionalProperties:false,required:['system','messages','tools'],properties:{format:{type:'string',enum:['docx','xlsx','pptx','pdf']},system:{type:'string'},messages:{type:'array'},tools:{type:'array'}}}
    const bodySchema=object({turnId:id,modelId:id,request:turnRequest})
    const continuation=object({revision:documentId,checkpoint:{type:'object'}})
    const harnessResume=object({taskId:id,documentId,revision:documentId})
    api.post(endpoint,{bodyLimit:ASSISTANT_MAX_REQUEST_BYTES,schema:{querystring:object({}),body:{...bodySchema,properties:{...bodySchema.properties,...(options.taskStatus?{documentId}:{}),...(options.claimContinuation?{continuation}:{}),...(options.admitContinuation?{harnessResume}:{})}}}},async (request,reply) => {
      const {harnessResume:resume,...body}=request.body as {turnId:string;modelId:string;request:unknown;documentId?:string;continuation?:unknown;harnessResume?:{taskId:string;documentId:string;revision:string}}
      const token=cookies(request).session!
      const controller=new AbortController(), response=reply.raw
      let bytes=0
      const disconnect=()=>{if(!response.writableEnded)controller.abort()}
      response.on('close',disconnect)
      if(response.destroyed)disconnect()
      let streaming=false, rejection:unknown
      const startStream=()=>{
        reply.hijack()
        streaming=true
        response.statusCode=200
        response.setHeader('Content-Type','text/event-stream; charset=utf-8')
        response.setHeader('Cache-Control','private, no-store')
        response.setHeader('X-Accel-Buffering','no')
      }
      const admit=resume?async(signal:AbortSignal)=>{
        try{await options.admitContinuation!(token,body.modelId,resume,body.request,signal)}
        catch(error){rejection=error;throw error}
        startStream()
      }:undefined
      if(!admit)startStream()
      async function write(event:string,value:unknown,terminal=false) {
        if(controller.signal.aborted || response.destroyed) throw Error('Disconnected')
        const frame=`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
        if(!terminal && (bytes+=Buffer.byteLength(frame))>maxOutputBytes)throw Error('Output limit')
        const flowing=response.write(frame)
        // Two fixed, small terminal frames may be queued, but must not hang
        // beyond the coordinator deadline waiting on a non-reading peer.
        if(flowing || terminal)return
        await new Promise<void>((resolve,reject)=>{
          const cleanup=()=>{response.off('drain',drain);response.off('close',closed);response.off('error',closed)}
          const drain=()=>{cleanup();resolve()}
          const closed=()=>{cleanup();reject(Error('Disconnected'))}
          response.once('drain',drain);response.once('close',closed);response.once('error',closed)
        })
      }
      try {
        await options.turns.run({...body,token,signal:controller.signal,admit},async event=>{
          const {type,...data}=event;await write(type,data)
        })
      } catch (error) {
        if(!streaming){
          if(rejection)throw rejection
          return reply.code(503).send({error:'Office model unavailable'})
        }
        const knownFailure=options.errorMessage===undefined
        const failure=knownFailure&&error instanceof ProviderResponseFailure?error:undefined
        const timeout=knownFailure&&error instanceof ProviderTurnTimeout?error:undefined
        const reason=failure?.code??timeout?.code
        const message=options.errorMessage??failure?.guidance??(timeout?'The model response timed out. Try again, shorten the request, or switch models.':'AI stream unavailable')
        if(!response.destroyed && !controller.signal.aborted) await write('error',{message,...(reason?{reason}:{})},true).catch(()=>{})
      } finally {
        if(streaming){
          if(!response.destroyed && !controller.signal.aborted) await write('done',{},true).catch(()=>{})
          response.end()
        }
        response.off('close',disconnect)
      }
    })
    if(options.taskStatus)api.get(endpoint+'/:id/status',{schema:{params:object({id}),querystring:object({documentId})}},request=>
      options.taskStatus!(cookies(request).session!,(request.params as {id:string}).id,(request.query as {documentId:string}).documentId))
    const claim=object({documentId,revision:documentId,modelId:id})
    if(options.claimContinuation)api.post(endpoint+'/:id/continuation',{bodyLimit:1024,schema:{params:object({id}),querystring:object({}),body:{...claim,properties:{...claim.properties,defer:{type:'boolean'}}}}},request=>
      options.claimContinuation!(cookies(request).session!,(request.params as {id:string}).id,request.body as {documentId:string;revision:string;modelId:string;defer?:boolean}))
    api.post(endpoint+'/:id/cancel',{bodyLimit:1024,schema:{params:object({id}),querystring:object({})}},async(request,reply)=>{
      if(request.body!==undefined)throw authError(400)
      await options.turns.cancel(cookies(request).session!,(request.params as {id:string}).id)
      return reply.code(204).send()
    })
  })
}
