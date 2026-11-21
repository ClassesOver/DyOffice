import type {AdmitHarnessContinuation,TurnRunner} from '../providers/routes.ts'
import type {TurnEvent,TurnIdentity} from '../providers/turns.ts'
import {authError} from '../auth/sessions.ts'
import type {HarnessCheckpoint} from '../../../../../../packages/agent-core/src/loop.ts'

export type AuthorizeTaskDocument=(token:string,id:string)=>Promise<{file:{revision:string}}|void>
type Continuation={revision:string;modelId:string;checkpoint:HarnessCheckpoint;callId:string}

type State='running'|'cancel_requested'|'succeeded'|'failed'|'unknown_outcome'
type Entry={
  documentId:string;modelId:string;instruction?:string;controller:AbortController;state:State
  activity?:string;progress?:string;result?:unknown;failure?:string
  continuation?:Continuation
  expiresAt:number
}
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

/** Retain bounded task events and optional private checkpoints in this process. An SSE connection
 * observes the execution; after admission, only explicit cancel owns abort. */
export function createCodingTaskRecovery(turns:TurnRunner,identity:(token:string)=>Promise<TurnIdentity>,authorizeDocument:AuthorizeTaskDocument){
  const entries=new Map<string,Entry>()
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
      let candidateResult:unknown
      const run=async()=>{
        try {
          await turns.run({...input,signal:entry.controller.signal},async event=>{
            if(event.type==='progress'){
              if(event.kind==='status')entry.activity=event.text.slice(0,200)
              else entry.progress=((entry.progress??'')+event.text).slice(-32000)
            }else if(event.type==='delta'){
              const value:unknown=JSON.parse(event.text)
              if(!value||typeof value!=='object'||!('summary' in value)||typeof value.summary!=='string'||!('output' in value)||typeof value.output!=='string')throw Error('Invalid Harness result')
              candidateResult=value
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
          entry.failure=entry.controller.signal.aborted?'Harness cancellation requested. Check for saved delivery.':genericFailure
          if(observer&&!signal?.aborted){queue.push({type:'error',message:entry.failure});wake()}
        }finally{
          if(entry.state==='running'||entry.state==='cancel_requested')entry.state='unknown_outcome'
          if(entry.state!=='succeeded')delete entry.continuation
          entry.expiresAt=Date.now()+retentionMs
          complete=true;wake()
        }
      }
      signal?.addEventListener('abort',wake,{once:true})
      void run()
      try {
        while(!signal?.aborted&&(!complete||queue.length)){
          const event=queue.shift()
          if(event)await emit(event)
          else await new Promise<void>(resolve=>{notify=resolve})
        }
      }finally{observer=false;queue.length=0;signal?.removeEventListener('abort',wake)}
    },
    async cancel(token,turnId){
      const entry=entries.get(await key(token,turnId))
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
    const entry=await authorizedEntry(token,input.taskId,input.documentId)
    const continuation=entry.continuation
    const messages=(request as {messages:{role:string;results?:{id:string;name:string;isError?:boolean}[]}[]}).messages
    const last=messages.at(-1)?.role==='user'?messages.at(-2):messages.at(-1)
    const result=last?.role==='tool'?last.results:undefined
    if(entry.state!=='succeeded'||!continuation||input.revision!==continuation.revision||modelId!==continuation.modelId||
      !Array.isArray(result)||!result.some(item=>item?.id===continuation.callId&&item.name==='delegate_agent_task'&&!item.isError))throw authError(409)
    if(signal.aborted)throw authError(409)
    // Consume in the same request that starts the model, with no await between check and delete.
    delete entry.continuation
  }
  return {runner,admitContinuation,async status(token:string,turnId:string,documentId:string){
    const entry=await authorizedEntry(token,turnId,documentId)
    const {state,modelId,instruction,activity,progress,result,failure}=entry
    const continuationModelId=state==='succeeded'?entry.continuation?.modelId:undefined
    return {turnId,documentId,agentId:modelId,instruction,state,activity,progress,result,failure,hasContinuation:!!continuationModelId,continuationModelId}
  },async claimContinuation(token:string,turnId:string,input:{documentId:string;revision:string;modelId:string;defer?:boolean}){
    const entry=await authorizedEntry(token,turnId,input.documentId)
    const continuation=entry.continuation
    if(entry.state!=='succeeded'||!continuation||input.revision!==continuation.revision||input.modelId!==continuation.modelId)throw authError(409)
    // Already-open editors from the previous build still consume on this request.
    if(input.defer!==true)delete entry.continuation
    return {checkpoint:continuation.checkpoint,result:{id:continuation.callId,name:'delegate_agent_task',output:JSON.stringify(entry.result)}}
  },dispose(){
    closed=true;clearInterval(timer)
    for(const entry of entries.values())entry.controller.abort()
    entries.clear()
  }}
}
