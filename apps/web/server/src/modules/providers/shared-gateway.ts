import type {FastifyInstance} from 'fastify'
import type {PrincipalTransactions} from '../../db/context.ts'
import type {SessionService} from '../auth/sessions.ts'
import {tokenHash} from '../auth/sessions.ts'
import {cookies,type createCsrfService} from '../auth/csrf.ts'
import {createSecretBox,type SecretKeyring} from '../admin/secrets.ts'
import {createProviderTurns,type TurnPermit} from './turns.ts'
import {registerProviderRoutes} from './routes.ts'
import {resolveLiveProviderProfile} from './live-profile.ts'
import {createPinnedProviderTransport} from './pinned-egress.ts'
import {buildOpenAiChatRequest} from './openai-request.ts'
import {parseOpenAiChatStream} from './openai-stream.ts'
import {assistantReadTools,ASSISTANT_DOCUMENT_TOOLS,ASSISTANT_DELEGATION_TOOLS} from '../../../../../../packages/web-contracts/src/assistant.ts'
import {CODING_MODEL_TOOLS} from '../coding/model-bridge.ts'
import type {HarnessRegistry} from '../coding/registry.ts'
import {randomUUID} from 'node:crypto'
import {authError} from '../auth/sessions.ts'

const fail=()=>new Error('Shared model unavailable')
function bridge() {
 type Item={value:Uint8Array;resolve:()=>void;reject:(error:Error)=>void}
 let slot:Item|undefined,pending:Item|undefined,awake:(()=>void)|undefined,ended=false,error:Error|undefined
 const wake=()=>{awake?.();awake=undefined}
 const close=(failed=false)=>{ended=true;if(failed)error=fail();pending?.reject(fail());pending=undefined;slot=undefined;wake()}
 return {
  close,
  push(value:Uint8Array):Promise<void>{
   if(ended||pending) return Promise.reject(fail())
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
      else await new Promise<void>(resolve=>{awake=resolve})
     }
    }finally{close()}
   },
  },
 }
}

type Row={revision:number;id:string;label:string;provider_id:string;model:string;base_url:string;preferred:boolean}
interface Permit extends TurnPermit {row:Row}
export function registerSharedProviderGateway(app:FastifyInstance,options:{transactions:PrincipalTransactions;sessions:SessionService;csrf:ReturnType<typeof createCsrfService>;keyring:SecretKeyring;harnesses?:HarnessRegistry;sourceCatalog?:boolean;assistantChannels?:boolean}) {
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
 function pipeline(tools:ReadonlySet<string>){
  async function lookup(token:string,id:string):Promise<Permit>{return transaction(token,async(c,p)=>{
   const row=(await c.query('SELECT * FROM shared_provider_catalog() WHERE id=$1',[id])).rows[0] as Row|undefined
   if(!row)throw fail()
   return {row,revision:String(row.revision),identity:{deploymentId:p.deploymentId,userId:p.userId,sessionId:p.sessionId}}
  })}
  async function validate(token:string,permit:Permit){const fresh=await lookup(token,permit.row.id);if(fresh.revision!==permit.revision||JSON.stringify(fresh.identity)!==JSON.stringify(permit.identity))throw fail()}
  return createProviderTurns<Permit>({identity:async token=>transaction(token,async(_c,p)=>({deploymentId:p.deploymentId,userId:p.userId,sessionId:p.sessionId})),authorize:lookup,revalidate:validate,
   async *stream(permit,request,signal,{token,turnId}){
    const profile=await resolveLiveProviderProfile({deploymentId:permit.identity.deploymentId,id:permit.row.id,revision:permit.row.revision,providerId:permit.row.provider_id,model:permit.row.model,baseUrl:permit.row.base_url})
    const built=buildOpenAiChatRequest(request,{model:profile.model,maxOutputTokens:profile.maxOutputTokens},tools)
    const binding=[turnId,profile.entryId,profile.revision,built.digest]
    // Claim commits before networking. A lost response cannot silently retry dispatch.
    await transaction(token,async c=>{await c.query("SELECT shared_provider_dispatch('claim',$1,$2,$3,$4)",binding)})
    const transport=createPinnedProviderTransport({profiles:[(({maxOutputTokens,...rest})=>rest)(profile)],timeoutMs:30_000,maxConcurrent:1})
    const control=new AbortController(),abort=()=>control.abort(),bytes=bridge()
    active.add(control);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    let producer:Promise<void>|undefined
    try{
     const {maxOutputTokens,allowedIpv4,...scope}=profile
     producer=transport.sendAuthorized({...scope,requestDigest:built.digest,turnId,reservationId:randomUUID(),claimId:randomUUID(),signal:control.signal},built.body,async(write,dispatchSignal)=>{
      await transaction(token,async c=>{
       const envelope=(await c.query('SELECT shared_provider_secret($1,$2,$3,$4) AS envelope',binding)).rows[0]?.envelope
       const credential=Buffer.from(box.unseal(envelope,{deploymentId:profile.deploymentId,configId:profile.entryId,providerId:profile.providerId,kind:'chat'}))
       try{if(dispatchSignal.aborted)throw fail();await write(credential)}finally{credential.fill(0)}
      })
     },async chunk=>{await validate(token,permit);await bytes.push(chunk)})
     void producer.then(()=>bytes.close(),()=>bytes.close(true))
     for await(const event of parseOpenAiChatStream(bytes.source,{signal:control.signal})){await validate(token,permit);yield event}
     await producer
     await transaction(token,async c=>{await c.query("SELECT shared_provider_dispatch('settle',$1,$2,$3,$4)",binding)})
    }finally{control.abort();bytes.close(true);await producer?.catch(()=>{});built.body.fill(0);signal.removeEventListener('abort',abort);active.delete(control)}
   },
  },{timeoutMs:30_000,maxActive:8})
 }
 const tools=new Set([...assistantReadTools(options.sourceCatalog===true),...ASSISTANT_DOCUMENT_TOOLS,...((options.harnesses||options.assistantChannels)?ASSISTANT_DELEGATION_TOOLS:[])])
 const turns=pipeline(tools),codingTurns=options.harnesses?pipeline(CODING_MODEL_TOOLS):undefined
 registerProviderRoutes(app,{...options,turns})
 app.post('/api/v1/admin/config/test-model',{bodyLimit:4096,schema:{body:{type:'object',additionalProperties:false,required:['entryId'],properties:{entryId:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$'}}}}},async(request,reply)=>{
  reply.header('Cache-Control','private, no-store')
  const token=cookies(request).session??''
  options.csrf.requireSession(request,token)
  if(!(await options.sessions.authenticate(token)).roles.includes('config_admin'))throw authError(403)
  try{
   let answered=false
   await turns.run({token,turnId:randomUUID(),modelId:(request.body as {entryId:string}).entryId,request:{system:'Reply only OK.',messages:[{role:'user',text:'Connection test. Reply OK.'}],tools:[]}},async event=>{if(event.type==='delta'&&event.text.trim())answered=true})
   return {ok:answered}
  }catch{return {ok:false}}
 })
 app.get('/api/v1/ai/catalog',async(request,reply)=>{
  reply.header('Cache-Control','private, no-store');const token=cookies(request).session??'';options.csrf.requireSessionRead(request,token)
  const entries=await rows(token)
  return {entries:entries.map(e=>({id:e.id,label:e.label,model:e.model,providerId:e.provider_id})),defaultId:entries.find(e=>e.preferred)?.id??entries[0]?.id??null,
   ...(options.harnesses&&entries.length?{agents:options.harnesses.list(),defaultAgentId:options.harnesses.defaultId}:{}),...(options.sourceCatalog&&entries.length?{sourceCatalog:true}:{}),...(options.assistantChannels?{assistantChannels:true}:{})}
 })
 const dispose=()=>{turns.dispose();codingTurns?.dispose();for(const control of active)control.abort()}
 app.addHook('preClose',async()=>dispose())
 return {codingTurns,dispose,async drain({timeoutMs=35_000}:{timeoutMs?:number}={}){
  const until=Date.now()+timeoutMs
  while(active.size||turns.pendingCount()||codingTurns?.pendingCount()){if(Date.now()>until)throw fail();await new Promise(resolve=>setTimeout(resolve,10))}
 }}
}
