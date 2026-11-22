import {maintainTaskLease} from '../tasks/lease.ts'
import type {AdmitHarnessContinuation,TurnRunner} from '../providers/routes.ts'
import type {TurnEvent,TurnIdentity} from '../providers/turns.ts'
import {authError} from '../auth/sessions.ts'
import type {HarnessCheckpoint} from '../../../../../../packages/agent-core/src/loop.ts'
import {interruptedFailure,type CodingTaskRecoveryStore,type Continuation,type TaskEvent,type TaskState} from './task-recovery-store.ts'

/** Renewal cadence and the point after which a 30 s lease (task-recovery-store) may have lapsed. */
const HEARTBEAT_MS=10_000
/** How often buffered public events are written for readers on other API instances. */
const EVENT_FLUSH_MS=500

export type AuthorizeTaskDocument=(token:string,id:string)=>Promise<{file:{revision:string}}|void>
type Task={
  modelId:string;instruction?:string;state:TaskState
  activity?:string;progress?:string;result?:unknown;failure?:string
  continuation?:Continuation
}
type Entry=Task&{documentId:string;controller:AbortController;expiresAt:number}
const maxTasks=32,maxRunning=4,retentionMs=10*60_000
const genericFailure='Harness task failed. Check server diagnostics.'
const isChatTurnId=(id:unknown)=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
function taskInput(request:unknown):{instruction?:unknown;context?:unknown;officeModelId?:unknown}|undefined{
  const text=(request as {messages?:{text?:unknown}[]}|null)?.messages?.[0]?.text
  if(typeof text!=='string')return
  try{
    return JSON.parse(text)??undefined
  }catch{/* the normal coding request validator rejects malformed input */}
}
function readContinuation(value:unknown,task:ReturnType<typeof taskInput>,currentRevision:string|undefined):Continuation{
  const {revision,checkpoint}=value as {revision:string;checkpoint:HarnessCheckpoint}
  if(!currentRevision||revision!==currentRevision)throw authError(409)
  if(!checkpoint||Buffer.byteLength(JSON.stringify(checkpoint))>256*1024||typeof task?.officeModelId!=='string'||
    (checkpoint.chatTurnId!==undefined&&!isChatTurnId(checkpoint.chatTurnId))||
    (checkpoint.consumedChatTurnIds!==undefined&&(!Array.isArray(checkpoint.consumedChatTurnIds)||!checkpoint.consumedChatTurnIds.every(isChatTurnId)))||
    !Array.isArray(checkpoint.messages)||checkpoint.messages.length>256||!Number.isSafeInteger(checkpoint.userIndex)||
    !Number.isSafeInteger(checkpoint.turns)||checkpoint.turns<0||!Array.isArray(checkpoint.executedCalls)||
    checkpoint.executedCalls.some(call=>typeof call?.name!=='string'||typeof call.ok!=='boolean')||
    checkpoint.messages.some(message=>message?.role==='user'?typeof message.text!=='string'||message.images!==undefined:
      message?.role==='assistant'?typeof message.text!=='string':message?.role!=='tool'||!Array.isArray(message.results)))throw authError(400)
  const tail=checkpoint.messages.at(-1)
  const call=tail?.role==='assistant'&&Array.isArray(tail.toolCalls)&&tail.toolCalls.length===1?tail.toolCalls[0]:undefined
  if(checkpoint.messages[checkpoint.userIndex]?.role!=='user'||!call||call.name!=='delegate_agent_task'||
    typeof call.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(call.id)||!call.input||
    call.input.instruction!==task.instruction||call.input.context!==task.context)throw authError(400)
  return {revision,modelId:task.officeModelId,checkpoint,callId:call.id}
}

/** Keep live events in memory and checkpoint them in the database when available.
 * Losing an SSE observer does not resubmit or cancel a task. */
export function createCodingTaskRecovery(turns:TurnRunner,identity:(token:string)=>Promise<TurnIdentity>,authorizeDocument:AuthorizeTaskDocument,store?:CodingTaskRecoveryStore){
  const entries=new Map<string,Entry>()
  const executions=new Set<Promise<void>>()
  let closed=false
  const prune=()=>{const now=Date.now();for(const [key,entry] of entries)if(entry.expiresAt<=now)entries.delete(key)}
  const timer=setInterval(prune,30_000);timer.unref()
  async function key(token:string,turnId:string){
    const {deploymentId,userId,sessionId}=await identity(token)
    if(closed)throw authError(503)
    prune()
    return JSON.stringify([deploymentId,userId,sessionId,turnId])
  }
  const runner:TurnRunner={
    async run(input,emit){
      const {token,turnId,documentId,modelId,signal}=input
      if(!documentId){if(input.continuation!==undefined)throw authError(400);return turns.run(input,emit)}
      const document=await authorizeDocument(token,documentId)
      const task=taskInput(input.request)
      const continuation=input.continuation===undefined?undefined:readContinuation(input.continuation,task,document?.file.revision)
      const taskKey=await key(token,turnId)
      signal?.throwIfAborted()
      if(entries.has(taskKey))throw authError(409)
      if([...entries.values()].filter(task=>task.expiresAt===Infinity).length>=maxRunning)throw authError(429)
      if(entries.size>=maxTasks){
        // Evict the caller's own oldest finished task first, so one user's burst of tasks
        // cannot discard another user's unclaimed result/continuation.
        const owner=(entryKey:string)=>JSON.stringify((JSON.parse(entryKey) as string[]).slice(0,2))
        const callerOwner=owner(taskKey)
        const oldestFinished=(mine:boolean)=>[...entries.entries()].reduce<[string,Entry]|undefined>((oldest,current)=>
          (!mine||owner(current[0])===callerOwner)&&current[1].expiresAt<(oldest?.[1].expiresAt??Infinity)?current:oldest,undefined)
        const evicted=oldestFinished(true)??oldestFinished(false)
        if(evicted)entries.delete(evicted[0])
      }
      const instruction=typeof task?.instruction==='string'?task.instruction.trim().slice(0,1000):undefined
      const entry:Entry={documentId,modelId,instruction,continuation,controller:new AbortController(),state:'running',expiresAt:Infinity}
      entries.set(taskKey,entry)
      const queue:TurnEvent[]=[]
      let notify:(()=>void)|undefined,complete=false,observer=true
      const wake=()=>{notify?.();notify=undefined}
      let candidate:{type:'delta';text:string}|undefined,candidateResult:unknown
      const run=async()=>{
        try{await store?.start(token,documentId,turnId,{modelId,instruction},continuation,
          signal?AbortSignal.any([entry.controller.signal,signal]):entry.controller.signal)}
        catch(error){entries.delete(taskKey);complete=true;wake();throw error}
        const stopLease=store&&maintainTaskLease(entry.controller,HEARTBEAT_MS,()=>store.renew(token,documentId,turnId,{modelId,instruction,activity:entry.activity,progress:entry.progress}))
        // Public events go to the shared event log in small batches. Losing a
        // batch only loses live detail: state and results still come from the
        // recovery row, so append failures never stop the task.
        let buffered:TaskEvent[]=[],flushing:Promise<void>|undefined
        const flush=()=>{
          if(!store||flushing||!buffered.length)return flushing
          const batch=buffered;buffered=[]
          flushing=store.append(token,documentId,turnId,batch).then(()=>undefined,()=>undefined).finally(()=>{flushing=undefined})
          return flushing
        }
        const publisher=store&&setInterval(()=>void flush(),EVENT_FLUSH_MS)
        publisher&&publisher.unref()
        const publish=(event:TaskEvent)=>{if(store&&buffered.length<64)buffered.push(event)}
        try {
          entry.controller.signal.throwIfAborted()
          await turns.run({...input,signal:entry.controller.signal},async event=>{
            if(event.type==='progress'){
              if(event.kind==='status'){entry.activity=event.text.slice(0,200);publish({kind:'activity',payload:{text:entry.activity}})}
              else{entry.progress=((entry.progress??'')+event.text).slice(-32000);for(let at=0;at<Math.min(event.text.length,4000);at+=1000)publish({kind:'progress',payload:{text:event.text.slice(at,Math.min(at+1000,4000))}})}
            }else if(event.type==='delta'){
              const value:unknown=JSON.parse(event.text)
              if(!value||typeof value!=='object'||!('summary' in value)||typeof value.summary!=='string'||!('output' in value)||typeof value.output!=='string')throw Error('Invalid Harness result')
              candidate={type:'delta',text:event.text};candidateResult=value
              return
            }else if(event.type==='error'){
              entry.failure=event.message
              entry.state=event.outcome==='failed'?'failed':'unknown_outcome'
            }
            if(observer){queue.push(event);wake()}
          })
          if(candidateResult&&entry.state==='running'){
            entry.result=candidateResult
            entry.state='succeeded'
          }
        }catch{
          entry.failure=entry.state==='cancel_requested'?'Harness cancellation requested. Check for saved delivery.':entry.controller.signal.aborted?interruptedFailure:genericFailure
          if(observer&&!signal?.aborted){queue.push({type:'error',message:entry.failure});wake()}
        }finally{
          const leaseStopped=stopLease?.()
          if(publisher)clearInterval(publisher)
          await flushing;await flush()
          await leaseStopped
          if(entry.state==='running'||entry.state==='cancel_requested')entry.state='unknown_outcome'
          if(entry.state!=='succeeded')delete entry.continuation
          if(store){
            const {controller:_controller,documentId:_documentId,expiresAt:_expiresAt,...task}=entry
            try{Object.assign(entry,await store.finish(token,documentId,turnId,task))}
            catch{entry.state='unknown_outcome';entry.failure=interruptedFailure}
            if(entry.state!=='succeeded'){delete entry.continuation;delete entry.result}
          }
          if(observer&&candidate){
            if(entry.state==='succeeded')queue.push(candidate)
            else queue.push({type:'error',message:entry.failure??interruptedFailure})
          }
          entry.expiresAt=Date.now()+retentionMs
          complete=true;wake()
        }
      }
      signal?.addEventListener('abort',wake,{once:true})
      const execution=run();executions.add(execution)
      void execution.then(()=>executions.delete(execution),()=>executions.delete(execution))
      try {
        while(!signal?.aborted&&(!complete||queue.length)){
          const event=queue.shift()
          if(event)await emit(event)
          else await new Promise<void>(resolve=>{notify=resolve})
        }
        if(!signal?.aborted)await execution
      }finally{observer=false;queue.length=0;signal?.removeEventListener('abort',wake)}
    },
    async cancel(token,turnId){
      const entry=entries.get(await key(token,turnId))
      if(store&&await store.cancel(token,turnId)){
        if(entry){entry.state='cancel_requested';entry.controller.abort()}
        return true
      }
      if(store&&entry)return false
      if(!entry)return turns.cancel(token,turnId)
      await authorizeDocument(token,entry.documentId)
      if(entry.state!=='running')return false
      entry.state='cancel_requested'
      entry.controller.abort()
      return true
    },
  }
  async function authorizedEntry(token:string,turnId:string,documentId:string){
    const taskKey=await key(token,turnId)
    const entry=entries.get(taskKey)
    if(!entry||entry.documentId!==documentId)throw authError(404)
    const document=await authorizeDocument(token,documentId)
    if(entries.get(taskKey)!==entry||entry.expiresAt<=Date.now())throw authError(404)
    const revision=document?.file.revision
    if(entry.continuation&&revision!==entry.continuation.revision)delete entry.continuation
    return entry
  }
  const admitContinuation:AdmitHarnessContinuation=async(token,modelId,input,request,signal)=>{
    const messages=(request as {messages:{role:string;results?:{id:string;name:string;isError?:boolean}[]}[]}).messages
    const last=messages.at(-1)?.role==='user'?messages.at(-2):messages.at(-1)
    const result=last?.role==='tool'?last.results:undefined
    const check=(entry:Task)=>{
      const continuation=entry.continuation
      if(entry.state!=='succeeded'||!continuation||input.revision!==continuation.revision||modelId!==continuation.modelId||
        !Array.isArray(result)||!result.some(item=>item?.id===continuation.callId&&item.name==='delegate_agent_task'&&!item.isError)||signal.aborted)throw authError(409)
    }
    // A row lock also fences simultaneous resumes on different API instances.
    if(store)return store.access(token,input.documentId,input.taskId,true,entry=>{check(entry);return {value:undefined,consume:true}})
    const entry=await authorizedEntry(token,input.taskId,input.documentId)
    check(entry)
    delete entry.continuation
  }
  function statusFor(entry:Task,turnId:string,documentId:string){
    const {state,modelId,instruction,activity,progress,result,failure}=entry
    const continuationModelId=state==='succeeded'?entry.continuation?.modelId:undefined
    return {turnId,documentId,agentId:modelId,instruction,state,activity,progress,result,failure,hasContinuation:!!continuationModelId,continuationModelId}
  }
  return {runner,admitContinuation,
  /** Shared event log reader (T2); undefined without a recovery store. */
  events:store?(token:string,turnId:string,documentId:string,after:number)=>store.events(token,documentId,turnId,after):undefined,
  async status(token:string,turnId:string,documentId:string){
    if(!store)return statusFor(await authorizedEntry(token,turnId,documentId),turnId,documentId)
    const live=entries.get(await key(token,turnId))
    return store.access(token,documentId,turnId,false,entry=>({value:statusFor(live&&entry.state==='running'&&live.documentId===documentId?
      {...entry,activity:live.activity,progress:live.progress}:entry,turnId,documentId)}))
  },async claimContinuation(token:string,turnId:string,input:{documentId:string;revision:string;modelId:string;defer?:boolean}){
    const read=(entry:Task)=>{
      const continuation=entry.continuation
      if(entry.state!=='succeeded'||!continuation||input.revision!==continuation.revision||input.modelId!==continuation.modelId)throw authError(409)
      return {checkpoint:continuation.checkpoint,result:{id:continuation.callId,name:'delegate_agent_task',output:JSON.stringify(entry.result)}}
    }
    if(store)return store.access(token,input.documentId,turnId,input.defer!==true,entry=>({value:read(entry),consume:input.defer!==true}))
    const entry=await authorizedEntry(token,turnId,input.documentId)
    const result=read(entry)
    // Already-open editors from the previous build still consume on this request.
    if(input.defer!==true)delete entry.continuation
    return result
  },async dispose(){
    closed=true;clearInterval(timer)
    for(const entry of entries.values())entry.controller.abort()
    entries.clear()
    await Promise.allSettled(executions)
  }}
}
