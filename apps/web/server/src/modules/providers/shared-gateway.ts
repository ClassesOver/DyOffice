import {createBackgroundAnswer} from '../assistant-channel/background-answer.ts'
import type {FastifyInstance} from 'fastify'
import type {PrincipalTransactions} from '../../db/context.ts'
import type {SessionService} from '../auth/sessions.ts'
import {tokenHash} from '../auth/sessions.ts'
import {cookies,type createCsrfService} from '../auth/csrf.ts'
import {createSecretBox,type SecretKeyring} from '../admin/secrets.ts'
import {createProviderTurns,type TurnPermit,type TurnRequest} from './turns.ts'
import {registerProviderRoutes,type AdmitHarnessContinuation} from './routes.ts'
import {resolveLiveProviderProfile} from './live-profile.ts'
import {createPinnedProviderTransport,type ProviderContentType} from './pinned-egress.ts'
import {buildOpenAiChatRequest} from './openai-request.ts'
import {parseOpenAiChatStream} from './openai-stream.ts'
import {assistantReadTools,ASSISTANT_DOCUMENT_TOOLS,ASSISTANT_DELEGATION_TOOLS,ASSISTANT_MODEL_DEADLINE_MS,scopeAssistantRequest,type AssistantSourceMode} from '../../../../../../packages/web-contracts/src/assistant.ts'
import {openAiEffortFor} from '../../../../../../packages/ai-provider/src/thinking-effort.ts'
import {CODING_MODEL_TOOLS} from '../coding/model-bridge.ts'
import type {HarnessRegistry} from '../coding/registry.ts'
import {randomUUID} from 'node:crypto'
import {authError} from '../auth/sessions.ts'
import {parseResponsesJson,parseResponsesStream} from './responses-stream.ts'
import {OutputCapRejection,ProviderResponseFailure} from './response-failure.ts'
import type {ModelConnectionResult} from '../../../../../../packages/web-contracts/src/settings.ts'

const responsesDecoders = {'text/event-stream':parseResponsesStream,'application/json':parseResponsesJson}
const fail=()=>new Error('Shared model unavailable')
function bridge() {
 type Item={value:Uint8Array;resolve:()=>void;reject:(error:Error)=>void}
 let slot:Item|undefined,pending:Item|undefined,awake:(()=>void)|undefined,ended=false,error:Error|undefined
 let contentType:ProviderContentType='text/event-stream'
 const wake=()=>{awake?.();awake=undefined}
 const waitForData=()=>{
  if(slot||ended)return Promise.resolve()
  return new Promise<void>(resolve=>{awake=resolve})
 }
 const close=(failed=false)=>{ended=true;if(failed)error=fail();pending?.reject(fail());pending=undefined;slot=undefined;wake()}
 return {
  close,
  async contentType(){
   await waitForData()
   if(error)throw error
   return contentType
  },
  push(value:Uint8Array,type:ProviderContentType):Promise<void>{
   if(ended||pending) return Promise.reject(fail())
   contentType=type
   return new Promise((resolve,reject)=>{pending=slot={value:Buffer.from(value),resolve,reject};wake()})
  },
  source:{
   async *[Symbol.asyncIterator](){
    try{
     for(;;){
      if(error)throw error
      if(slot){
       const item=slot;slot=undefined
       try{yield item.value}finally{item.resolve();if(pending===item)pending=undefined}
      }else if(ended)return
      else await waitForData()
     }
    }finally{close()}
   },
  },
 }
}

type Row={revision:number;id:string;label:string;provider_id:string;model:string;base_url:string;preferred:boolean}
interface Permit extends TurnPermit {row:Row}
export function registerSharedProviderGateway(app:FastifyInstance,options:{transactions:PrincipalTransactions;sessions:SessionService;csrf:ReturnType<typeof createCsrfService>;keyring:SecretKeyring;harnesses?:HarnessRegistry;sourceMode?:AssistantSourceMode;assistantChannels?:boolean;admitContinuation?:AdmitHarnessContinuation}) {
 const outputCaps=new Map<string,number>()
 const active=new Set<AbortController>()
 const box=createSecretBox(options.keyring)
 async function transaction<T>(token:string,work:(c:Parameters<Parameters<PrincipalTransactions['withPrincipalTransaction']>[1]>[0],p:Parameters<Parameters<PrincipalTransactions['withPrincipalTransaction']>[1]>[1])=>Promise<T>) {
  return options.transactions.withPrincipalTransaction({kind:'session',token},async(c,p)=>{
   if(!p.roles.includes('personal'))throw authError(403)
   await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(token),String(options.transactions.sessionIdleMs)])
   return work(c,p)
  })
 }
 async function rows(token:string):Promise<Row[]>{return transaction(token,async c=>(await c.query('SELECT * FROM shared_provider_catalog()')).rows)}
 function pipeline(tools:ReadonlySet<string>,audience:'office'|'coding'){
  // PPTX style, outline and page design stream model text without calling tools.
  const isSlidesGeneration=(request:TurnRequest)=>audience==='office'&&request.format==='pptx'&&!request.tools.length
  async function lookup(token:string,id:string):Promise<Permit>{return transaction(token,async(c,p)=>{
   const row=(await c.query('SELECT * FROM shared_provider_catalog() WHERE id=$1',[id])).rows[0] as Row|undefined
   if(!row)throw fail()
   return {row,revision:String(row.revision),identity:{deploymentId:p.deploymentId,userId:p.userId,sessionId:p.sessionId}}
  })}
  async function validate(token:string,permit:Permit){const fresh=await lookup(token,permit.row.id);if(fresh.revision!==permit.revision||JSON.stringify(fresh.identity)!==JSON.stringify(permit.identity))throw fail()}
  return createProviderTurns<Permit>({identity:async token=>transaction(token,async(_c,p)=>({deploymentId:p.deploymentId,userId:p.userId,sessionId:p.sessionId})),authorize:lookup,revalidate:validate,
   async *stream(permit,request,signal,{token,turnId,timeoutMs}){
    const capKey=JSON.stringify([permit.row.base_url,permit.row.model])
    for(let attempt=0;;attempt++){
     let binding:(string|number)[]|undefined
     let stage='profile_resolution'
     let built:ReturnType<typeof buildOpenAiChatRequest>|undefined
     let control:AbortController|undefined
     let bytes:ReturnType<typeof bridge>|undefined
     let producer:Promise<void>|undefined
     let responseFailure:ProviderResponseFailure|OutputCapRejection|undefined
     let detach: (()=>void)|undefined
     try{
      const profile=await resolveLiveProviderProfile({deploymentId:permit.identity.deploymentId,id:permit.row.id,revision:permit.row.revision,providerId:permit.row.provider_id,model:permit.row.model,baseUrl:permit.row.base_url})
      const scoped=scopeAssistantRequest(request,tools)
      stage='request_build'
      const generation=isSlidesGeneration(request)
      const responses=profile.endpoint.endsWith('/responses')
      const reasoningEffort=generation?openAiEffortFor({model:profile.model,thinking:{[profile.model]:'none'}},responses?'openai-responses':'openai-compatible'):undefined
      const requestBody=buildOpenAiChatRequest(scoped.request,{
       model:profile.model,maxOutputTokens:Math.min(profile.maxOutputTokens,outputCaps.get(capKey)??Infinity),
       ...(reasoningEffort==='none'?{reasoningEffort}:{}),
      },scoped.historicalTools,responses?'responses':profile.providerId==='openai'?'completion-tokens':'chat')
      built=requestBody
      const dispatchId=attempt?randomUUID():turnId
      const receipt=binding=[dispatchId,profile.entryId,profile.revision,requestBody.digest]
      // Claim commits before networking. A lost response cannot silently retry dispatch.
      stage='dispatch_claim'
      await transaction(token,async c=>{await c.query("SELECT shared_provider_dispatch('claim',$1,$2,$3,$4)",receipt)})
      const transport=createPinnedProviderTransport({profiles:[(({maxOutputTokens,...rest})=>rest)(profile)],timeoutMs,maxConcurrent:1,acceptResponsesJson:responses})
      const turnControl=new AbortController(),turnBytes=bridge(),abort=()=>turnControl.abort()
      control=turnControl;bytes=turnBytes
      detach=()=>signal.removeEventListener('abort',abort)
      active.add(turnControl);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
      const {maxOutputTokens,allowedIpv4,...scope}=profile
      stage='provider_dispatch'
      producer=transport.sendAuthorized({...scope,requestDigest:requestBody.digest,turnId:dispatchId,reservationId:randomUUID(),claimId:randomUUID(),signal:turnControl.signal},requestBody.body,async(write,dispatchSignal)=>{
       stage='credential_lookup'
       await transaction(token,async c=>{
        const envelope=(await c.query('SELECT shared_provider_secret($1,$2,$3,$4) AS envelope',receipt)).rows[0]?.envelope
        const credential=Buffer.from(box.unseal(envelope,{deploymentId:profile.deploymentId,configId:profile.entryId,providerId:profile.providerId,kind:'chat'}))
        try{if(dispatchSignal.aborted)throw fail();await write(credential)}finally{credential.fill(0)}
       })
       },async (chunk,type)=>{await validate(token,permit);await turnBytes.push(chunk,type)})
      void producer.then(()=>turnBytes.close(),error=>{
       if(error instanceof ProviderResponseFailure||error instanceof OutputCapRejection)responseFailure=error
       turnBytes.close(true)
      })
      stage='stream_parse'
      // No per-event validate here: createProviderTurns revalidates every yielded event before
      // emitting it, and each network chunk is already validated above.
      const parse=responses
       ? responsesDecoders[await turnBytes.contentType()]
       : parseOpenAiChatStream
      for await(const event of parse(turnBytes.source,{signal:turnControl.signal})){
       if(event.type==='tool_call'&&!scoped.tools.has(event.name))throw fail()
       yield event
      }
      await producer
      stage='dispatch_settle'
      await transaction(token,async c=>{await c.query("SELECT shared_provider_dispatch('settle',$1,$2,$3,$4)",receipt)})
      return
     }catch(cause){
      const error=responseFailure??cause
      if(error instanceof OutputCapRejection&&binding&&!signal.aborted){
       await transaction(token,async c=>{await c.query("SELECT shared_provider_dispatch('settle',$1,$2,$3,$4)",binding)})
       if(!attempt){
        outputCaps.set(capKey,error.ceiling)
        continue
       }
      }
      if(!signal.aborted){
       const rawCode=error&&typeof error==='object'&&'code'in error?(error as {code?:unknown}).code:undefined
       const code=typeof rawCode==='string'&&/^[A-Z0-9_-]{1,64}$/.test(rawCode)?rawCode:'UNCLASSIFIED'
       console.error('dyoffice: shared AI gateway failed',{turnId,stage:responseFailure?'provider_response':stage,code})
      }
      throw error
     }finally{control?.abort();bytes?.close(true);await producer?.catch(()=>{});built?.body.fill(0);detach?.();if(control){active.delete(control)}}
    }
   },
  },{timeoutMs:ASSISTANT_MODEL_DEADLINE_MS,maxActive:8})
 }
 const tools=new Set([...assistantReadTools(options.sourceMode),...ASSISTANT_DOCUMENT_TOOLS,...((options.harnesses||options.assistantChannels)?ASSISTANT_DELEGATION_TOOLS:[])])
 const turns=pipeline(tools,'office')
 const codingTurns=options.harnesses?pipeline(CODING_MODEL_TOOLS,'coding'):undefined
 registerProviderRoutes(app,{...options,turns})
 app.post('/api/v1/admin/config/test-model',{bodyLimit:4096,schema:{body:{type:'object',additionalProperties:false,required:['entryId'],properties:{entryId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$'}}}}},async(request,reply):Promise<ModelConnectionResult>=>{
  reply.header('Cache-Control','private, no-store')
  const token=cookies(request).session??''
  options.csrf.requireSession(request,token)
  if(!(await options.sessions.authenticate(token)).roles.includes('config_admin'))throw authError(403)
  try{
   let answered=false
   await turns.run({token,turnId:randomUUID(),modelId:(request.body as {entryId:string}).entryId,request:{system:'Reply only OK.',messages:[{role:'user',text:'Connection test. Reply OK.'}],tools:[]}},async event=>{if(event.type==='delta'&&event.text.trim())answered=true})
   return {ok:answered}
  }catch(error){return error instanceof ProviderResponseFailure?{ok:false,reason:error.code}:{ok:false}}
 })
 app.get('/api/v1/ai/catalog',async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const token=cookies(request).session??'';options.csrf.requireSessionRead(request,token)
  const entries=await rows(token)
  return {entries:entries.map(e=>({id:e.id,label:e.label,model:e.model,providerId:e.provider_id})),defaultId:entries.find(e=>e.preferred)?.id??entries[0]?.id??null,
   ...(options.harnesses&&entries.length?{agents:options.harnesses.list(),defaultAgentId:options.harnesses.defaultId}:{}),...(options.sourceMode && options.sourceMode !== 'off' && entries.length ? {sourceCatalog:true, sourceMode:options.sourceMode} : {}),...(options.assistantChannels?{assistantChannels:true}:{})}
 })
 const dispose=()=>{turns.dispose();codingTurns?.dispose();for(const control of active)control.abort()}
 app.addHook('preClose',async()=>dispose())
 return {backgroundAnswer:createBackgroundAnswer({defaultModel:async token=>{const available=await rows(token);return (available.find(e=>e.preferred)??available[0])?.id},run:turns.run}),codingTurns,dispose,async drain({timeoutMs=35_000}:{timeoutMs?:number}={}){
  const until=Date.now()+timeoutMs
  while(active.size||turns.pendingCount()||codingTurns?.pendingCount()){if(Date.now()>until)throw fail();await new Promise(resolve=>setTimeout(resolve,10))}
 }}
}
