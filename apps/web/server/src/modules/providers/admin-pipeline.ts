import type {PrincipalTransactions} from '../../db/context.ts'
import {tokenHash} from '../auth/sessions.ts'
import type {SecretKeyring} from '../admin/secrets.ts'
import {createProviderTurns,type TurnEvent,type TurnPermit} from './turns.ts'
import {createProviderBudgetService,isDefinitiveBudgetDenial,type BudgetBinding} from './budget.ts'
import {createBudgetedAdminCredentialConsumer} from './budgeted-credential.ts'
import {createPinnedProviderTransport,type EgressProfile} from './pinned-egress.ts'
import {parseOpenAiChatStream} from './openai-stream.ts'
import {buildOpenAiChatRequest} from './openai-request.ts'
import {ASSISTANT_READ_TOOLS} from '../../../../../../packages/web-contracts/src/assistant.ts'

export interface AdminPipelineProfile extends EgressProfile {maxOutputTokens:number}
interface Permit extends TurnPermit {profile:Readonly<AdminPipelineProfile>}
const fail=()=>new Error('AI pipeline unavailable')
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
/** Explicit, unmounted, admin-only composition. No real provider is enabled by
 * constructing this factory. Profiles and budget grants are trusted deployment
 * provisioning, not HTTP input. One active turn per factory, total <=30 seconds. */
export function createAdminProviderPipeline({transactions,keyring,profiles,timeoutMs=30_000,audience='admin',personalTools=ASSISTANT_READ_TOOLS}:{
 transactions:PrincipalTransactions;keyring:SecretKeyring;profiles:readonly AdminPipelineProfile[];timeoutMs?:number;audience?:'admin'|'personal';personalTools?:ReadonlySet<string>
}) {
 let disposed=false,cleanupFailed=false
 const active=new Set<AbortController>()
 const keys:Record<string,Uint8Array>={}
 let configured:Readonly<AdminPipelineProfile>[]
 try{
  if(!['admin','personal'].includes(audience)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000||!keyring||!keyring.keys||!Array.isArray(profiles))throw fail()
  for(const [id,value] of Object.entries(keyring.keys)){
   if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)||!(value instanceof Uint8Array)||value.length!==32)throw fail()
   keys[id]=Buffer.from(value)
  }
  if(!keys[keyring.activeKeyId]||Object.keys(keys).length>32)throw fail()
  configured=profiles.map(p=>{
   if(Object.keys(p).length!==9||Object.keys(p).some(k=>!['deploymentId','entryId','revision','providerId','model','baseUrl','endpoint','allowedIpv4','maxOutputTokens'].includes(k))||!Number.isSafeInteger(p.maxOutputTokens)||p.maxOutputTokens<1||p.maxOutputTokens>32768)throw fail()
   return Object.freeze({...p,allowedIpv4:Object.freeze([...p.allowedIpv4])})
  })
 }catch{for(const key of Object.values(keys))key.fill(0);throw fail()}
 const secretKeyring={activeKeyId:keyring.activeKeyId,keys}
 const egressProfiles=configured.map(({maxOutputTokens,...p})=>p)
 let transport:ReturnType<typeof createPinnedProviderTransport>
 try{transport=createPinnedProviderTransport({profiles:egressProfiles,timeoutMs,maxConcurrent:1,authorizationTimeoutMs:Math.min(timeoutMs,5000)})}
 catch{for(const key of Object.values(keys))key.fill(0);throw fail()}
 const budget=createProviderBudgetService({transactions,audience})
 async function lookup(token:string,modelId:string):Promise<Permit>{
  if(disposed)throw fail()
  return transactions.withPrincipalTransaction({kind:'session',token},async(c,p)=>{
   if(disposed||!p.roles.includes(audience==='personal'?'personal':'config_admin'))throw fail()
   const identity={deploymentId:p.deploymentId,userId:p.userId,sessionId:p.sessionId}
   await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(token),String(transactions.sessionIdleMs)])
   await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['dyoffice:global-config:'+p.deploymentId])
   if(!(await c.query('SELECT global_config_authorized($1,$2) AS authorized',[p.deploymentId,audience==='admin'])).rows[0]?.authorized)throw fail()
   const row=(await c.query('SELECT c.revision,e.kind,e.provider_id,e.model,e.base_url,e.enabled FROM global_configs c JOIN global_config_entries e ON e.deployment_id=c.deployment_id WHERE c.deployment_id=$1 AND e.id=$2',[p.deploymentId,modelId])).rows[0]
   const found=configured.filter(x=>x.deploymentId===p.deploymentId&&x.entryId===modelId&&x.revision===row?.revision)
   if(disposed||found.length!==1||!row||row.kind!=='chat'||!row.enabled||row.provider_id!==found[0]!.providerId||row.model!==found[0]!.model||row.base_url!==found[0]!.baseUrl)throw fail()
   return {identity,revision:String(row.revision),profile:found[0]!}
  })
 }
 async function validate(token:string,permit:Permit){
  const fresh=await lookup(token,permit.profile.entryId)
  if(fresh.revision!==permit.revision||fresh.profile!==permit.profile||JSON.stringify(fresh.identity)!==JSON.stringify(permit.identity))throw fail()
 }
 const turns=createProviderTurns<Permit>({
  identity:async token=>transactions.withPrincipalTransaction({kind:'session',token},async(_c,p)=>{
   if(disposed||!p.roles.includes(audience==='personal'?'personal':'config_admin'))throw fail()
   return {deploymentId:p.deploymentId,userId:p.userId,sessionId:p.sessionId}
  }),
  authorize:(token,model)=>lookup(token,model),
  revalidate:validate,
  async *stream(permit,request,signal,{token,turnId}){
   const control=new AbortController(),abort=()=>control.abort()
   active.add(control);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
   const bytes=bridge()
   let producer:Promise<void>|undefined,wire:Buffer|undefined,binding:BudgetBinding|undefined,claimId:string|undefined,reserved=false,settled=false
   let consumer:ReturnType<typeof createBudgetedAdminCredentialConsumer>|undefined
   try{
    if(disposed||control.signal.aborted)throw fail()
    const built=buildOpenAiChatRequest(request,{model:permit.profile.model,maxOutputTokens:permit.profile.maxOutputTokens},audience==='personal'?personalTools:undefined)
    wire=Buffer.from(built.body);built.body.fill(0)
    binding={turnId,entryId:permit.profile.entryId,configRevision:permit.profile.revision,requestDigest:built.digest}
    let reservation:Awaited<ReturnType<typeof budget.reserve>>
    try{reservation=await budget.reserve(token,binding)}
    catch(error){
     // A commit may have succeeded even when its response is lost. The budget
     // adapter intentionally redacts errors, so no safe commit/no-commit distinction
     // is available here. Do not guess a refund or declare a clean shutdown.
     if(!isDefinitiveBudgetDenial(error))cleanupFailed=true
     throw fail()
    }
    if(reservation.state!=='reserved')throw fail()
    reserved=true
    if(control.signal.aborted)throw fail()
    const claim=await budget.claim(token,binding)
    if(!claim.claimId)throw fail()
    claimId=claim.claimId
    if(control.signal.aborted)throw fail()
    await validate(token,permit) // Basic live entitlement before any DNS/TLS probe.
    const {maxOutputTokens,allowedIpv4,...credentialProfile}=permit.profile
    const scope={...credentialProfile,reservationId:claim.id,claimId,requestDigest:built.digest,turnId,signal:control.signal}
    producer=transport.sendAuthorized(scope,wire,async(write,dispatchSignal)=>{
     consumer=createBudgetedAdminCredentialConsumer({budget,transactions,keyring:secretKeyring,profiles:[credentialProfile],audience,
      consume:async credential=>{await write(credential.credential)}})
     try{await consumer.run(token,{...binding!,reservationId:claim.id,claimId:claimId!,signal:dispatchSignal})}
     finally{consumer.dispose();consumer=undefined}
    },async chunk=>{
     await validate(token,permit) // Short transaction; no lock spans bridge/backpressure.
     if(control.signal.aborted)throw fail()
     await bytes.push(chunk)
    })
    void producer.then(()=>bytes.close(),()=>bytes.close(true))
    const terminal:TurnEvent[]=[];let terminalBytes=0
    for await(const event of parseOpenAiChatStream(bytes.source,{signal:control.signal})){
     if(event.type==='delta'||event.type==='reasoning')yield event
     else {terminalBytes+=Buffer.byteLength(JSON.stringify(event));if(terminalBytes>2*1024*1024)throw fail();terminal.push(event)}
    }
    await producer
    if(control.signal.aborted)throw fail()
    await budget.settle(token,binding,claimId);settled=true
    for(const event of terminal){if(control.signal.aborted)throw fail();yield event}
   }catch{throw fail()}
   finally{
    control.abort();bytes.close(true)
    if(producer)await producer.catch(()=>{})
    if(reserved&&!settled&&binding){
     // DB state guards prevent cancellation from refunding a committed claim,
     // including an ambiguous transaction result whose claimId was not returned.
     try{if(claimId)await budget.markUnknown(token,binding,claimId);else await budget.cancel(token,binding)}catch{cleanupFailed=true /* hold for operator reconciliation; never report a clean drain */}
    }
    consumer?.dispose();wire?.fill(0)
    signal.removeEventListener('abort',abort);active.delete(control)
   }
  },
 },{timeoutMs,maxActive:1})
 return {turns,transportActiveCount:transport.activeCount,
 async drain({timeoutMs=35_000}:{timeoutMs?:number}={}){
  if(!disposed||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>35_000)throw new Error('AI pipeline drain unavailable')
  const deadline=performance.now()+timeoutMs
  while(active.size||turns.pendingCount()||transport.activeCount()){
   if(performance.now()>=deadline)throw new Error('AI pipeline drain timed out')
   await new Promise(resolve=>setTimeout(resolve,Math.min(10,Math.max(1,deadline-performance.now()))))
  }
  if(cleanupFailed)throw new Error('AI pipeline drain unavailable')
 },dispose(){disposed=true;turns.dispose();for(const c of active)c.abort();for(const key of Object.values(keys))key.fill(0)}}
}
