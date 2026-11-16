import type { FastifyInstance } from 'fastify'
import { authError } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import type { TurnEvent } from './turns.ts'

interface TurnRunner {
  run(input: { token: string; modelId: string; turnId: string; request: unknown; signal?: AbortSignal }, emit: (event: TurnEvent) => Promise<void>): Promise<void>
  cancel(token: string, turnId: string): Promise<boolean>
}
const object = (properties: object) => ({type:'object',additionalProperties:false,required:Object.keys(properties),properties})
const id = {type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'}
/** Explicit fixed-prompt, network-capable provider probe. Real configured providers
 * can receive requests and charge usage. No free-form input or tool execution. */
export function registerFixedProviderProbeRoutes(app: FastifyInstance, options: {
  pipeline: {turns: TurnRunner}; authorize(token:string):Promise<void>;
  csrf: Pick<ReturnType<typeof createCsrfService>,'requireSession'>; maxOutputBytes?: number
}) {
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 128 || maxOutputBytes > 32 * 1024 * 1024) throw new Error('Invalid AI output limit')
  app.register(async api => {
    api.addHook('onRequest',async (request,reply) => {
      reply.header('Cache-Control','private, no-store')
      const token=cookies(request).session
      if (!token) throw authError()
      if(request.method!=='GET')options.csrf.requireSession(request,token)
      await options.authorize(token)
    })
    api.post('/api/v1/admin/ai-probe/turns',{bodyLimit:1024*1024,schema:{querystring:object({}),body:object({turnId:id,modelId:id,scenario:{type:'string',enum:['hello']}})}},async (request,reply) => {
      const body=request.body as {turnId:string;modelId:string;scenario:'hello'}
      const controller=new AbortController(), response=reply.raw
      let bytes=0
      const disconnect=()=>{if(!response.writableEnded)controller.abort()}
      response.on('close',disconnect)
      reply.hijack()
      response.statusCode=200
      response.setHeader('Content-Type','text/event-stream; charset=utf-8')
      response.setHeader('Cache-Control','private, no-store')
      response.setHeader('X-Accel-Buffering','no')
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
        await options.pipeline.turns.run({modelId:body.modelId,turnId:body.turnId,request:{system:'Synthetic connectivity probe. Reply only with OK. Do not call tools.',messages:[{role:'user',text:'Synthetic hello probe.'}],tools:[]},token:cookies(request).session!,signal:controller.signal},async event=>{
          if(event.type==='tool_call')throw Error('Unexpected probe tool candidate')
          const {type,...data}=event;await write(type,data)
        })
      } catch {
        if(!response.destroyed && !controller.signal.aborted) await write('error',{message:'AI stream unavailable'},true).catch(()=>{})
      } finally {
        if(!response.destroyed && !controller.signal.aborted) await write('done',{},true).catch(()=>{})
        response.end();response.off('close',disconnect)
      }
    })
    api.post('/api/v1/admin/ai-probe/turns/:id/cancel',{bodyLimit:1024,schema:{params:object({id}),querystring:object({})}},async(request,reply)=>{
      if(request.body!==undefined)throw authError(400)
      await options.pipeline.turns.cancel(cookies(request).session!,(request.params as {id:string}).id)
      return reply.code(204).send()
    })
  })
}
