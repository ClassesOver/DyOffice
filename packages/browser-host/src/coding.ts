import {createCodingSkill,HarnessContinuationUnavailable,type HarnessDescriptor,type CodingTask,type CodingResult,type CodingProgress} from '../../agent-core/src/coding-skill.ts'
import {getHarnessCheckpoint} from '../../agent-core/src/loop.ts'
import {createSseAgentTransport,type SseTransportOptions} from './ai-transport.ts'
import {createCodingRecovery,type TaskIdStorage} from './coding-recovery.ts'
import type {AgentMessage} from '../../agent-core/src/types.ts'

export interface CodingTaskView {id:string;restored?:boolean;agent:HarnessDescriptor;instruction:string;initiator:'office'|'user';state:'running'|'cancel_requested'|'succeeded'|'failed'|'unknown_outcome';summary?:string;failure?:string;output?:string;progress?:string;activity?:string;continuationModelId?:string}

/** Reuses the bounded SSE transport. No process starts until Office invokes the tool. */
export function createCodingClient(options:{agents:readonly HarnessDescriptor[];defaultId:string;csrfToken:string;getModelId:()=>string|null;documentId?:string;continuationRevision?:()=>string|undefined;storage?:TaskIdStorage;dataCatalog?:(input:{sourcesAfter?:string;resultsAfter?:string})=>Promise<unknown>;fetchImpl?:typeof fetch;onDelivery?:(hint:unknown,agent:{id:string;name:string;origin:'builtin'|'external'})=>void|Promise<void>}) {
  let disposed=false
  const active=new Set<{cancel():void;detach():void}>()
  const agents=options.agents.map(a=>({...a,capabilities:[...a.capabilities]}))
  const tasks:CodingTaskView[]=[],listeners=new Set<()=>void>(),controllers=new Map<string,AbortController>()
  let pendingResume:{callId:string;taskId:string;documentId:string;revision:string}|undefined
  const notify=()=>{for(const listener of listeners)listener()}
  function reportDelivery(result:CodingResult,agent:HarnessDescriptor){
    if(result.delivery&&options.onDelivery)try{void Promise.resolve(options.onDelivery(result.delivery,{id:agent.id,name:agent.name,origin:agent.origin})).catch(()=>{})}catch{}
  }
  const recovery=options.documentId?createCodingRecovery({...options,documentId:options.documentId,onUnavailable(id){
    if(controllers.has(id))return
    const index=tasks.findIndex(task=>task.id===id&&(task.state==='running'||task.state==='cancel_requested'))
    if(index>=0){tasks.splice(index,1);notify()}
  },onStatus(status){
    let task=tasks.find(task=>task.id===status.turnId)
    if(controllers.has(status.turnId))return
    if(!task){
      const agent=agents.find(agent=>agent.id===status.agentId)
      if(!agent)return
      task={id:status.turnId,restored:true,agent,instruction:typeof status.instruction==='string'?status.instruction:'',initiator:'office',state:status.state}
      tasks.push(task)
    }
    Object.assign(task,{state:status.state,activity:typeof status.activity==='string'?status.activity:undefined,progress:typeof status.progress==='string'?status.progress:undefined,failure:typeof status.failure==='string'?status.failure:undefined,summary:status.result?.summary,output:status.result?.output,continuationModelId:status.hasContinuation===true&&typeof status.continuationModelId==='string'?status.continuationModelId:undefined})
    if(status.state==='succeeded'&&status.result)reportDelivery(status.result,task.agent)
    notify()
  }}):undefined
  const deps={
      list:()=>disposed?[]:agents,
      ...(options.dataCatalog?{dataCatalog:options.dataCatalog}:{}),
      run(turnId:string,input:CodingTask,signal?:AbortSignal,modelId=options.getModelId(),onProgress?:(event:CodingProgress)=>void,continuation?:SseTransportOptions['continuation']):Promise<CodingResult> {
        if(disposed||signal?.aborted)return Promise.reject(Error('Coding task cancelled'))
        const id=input.agentId??options.defaultId
        if(!agents.some(a=>a.id===id&&a.capabilities.includes('coding')))return Promise.reject(Error('Coding agent unavailable'))
        return new Promise((resolve,reject)=>{
          let text='',error='',settled=false,confirmedFailure=false
          const transport=createSseAgentTransport({endpoint:'/api/v1/agents/tasks',modelId:id,...(options.documentId!==undefined?{documentId:options.documentId}:{}),...(continuation?{continuation}:{}),createTurnId:()=>turnId,getCsrfToken:async()=>options.csrfToken,timeoutMs:615000,onConfirmedFailure:()=>{confirmedFailure=true},...(onProgress?{onProgress}:{}),...(options.fetchImpl ? {fetchImpl:options.fetchImpl} : {})})
          let handle:{cancel():void;detach():void}|undefined
          const finish=()=>{
            if(settled)return
            settled=true;signal?.removeEventListener('abort',cancel);if(handle)active.delete(handle)
            if(error){
              // A proxy timeout or 5xx may arrive after the server started work.
              const rejected=confirmedFailure||/^AI stream HTTP 4(?!08|99)\d\d$|^Invalid CSRF proof$/.test(error)
              reject(Object.assign(Error(error),{unknownOutcome:!rejected}));return
            }
            try {
              const value=JSON.parse(text)
              if(!value||typeof value.summary!=='string'||typeof value.output!=='string')throw Error('Invalid coding result')
              const descriptor=agents.find(agent=>agent.id===id)!
              if(!disposed&&!signal?.aborted)reportDelivery(value,descriptor)
              resolve({agent:{id:descriptor.id,name:descriptor.name,origin:descriptor.origin},summary:value.summary,output:value.output,...(value.delivery?{delivery:value.delivery}:{})})
            } catch {reject(Object.assign(Error('Cannot confirm coding result'),{unknownOutcome:true}))}
          }
          const cancel=()=>{error='Coding task cancelled';if(disposed&&recovery)handle?.detach();else handle?.cancel();finish()}
          handle=transport.stream({system:'',messages:[{role:'user',text:JSON.stringify({officeModelId:modelId,instruction:input.instruction,...(input.context===undefined?{}:{context:input.context}),...(input.dataInputs===undefined?{}:{dataInputs:input.dataInputs})})}],tools:[]},
            {onDelta:delta=>{text+=delta},onToolCall:()=>{error='Unexpected coding tool';handle?.cancel();finish()},onError:message=>{error=message},onDone:finish})
          if(!settled)active.add(handle)
          if(!settled)signal?.addEventListener('abort',cancel,{once:true})
          if(signal?.aborted)cancel()
        })
      },
  }
  const cancelledByUser=new Set<string>()
  async function run(input:CodingTask,signal?:AbortSignal,modelId=options.getModelId(),initiator:'office'|'user'='office'):Promise<CodingResult> {
    if(disposed||signal?.aborted)throw Error('Coding task cancelled')
    const agent=agents.find(a=>a.id===(input.agentId??options.defaultId)&&a.capabilities.includes('coding'))
    if(!agent)throw Error('Coding agent unavailable')
    const task:CodingTaskView={id:crypto.randomUUID(),agent,instruction:input.instruction,initiator,state:'running'}
    let observingStatus=false
    const controller=new AbortController(),cancel=()=>{
      controller.abort()
      if(observingStatus&&!disposed)void recovery?.cancel(task.id).catch(()=>{})
    }
    signal?.addEventListener('abort',cancel,{once:true})
    controllers.set(task.id,controller);tasks.unshift(task);notify()
    recovery?.remember(task.id)
    const checkpoint=recovery&&initiator==='office'&&modelId?getHarnessCheckpoint(signal):undefined
    const revision=checkpoint?.chatTurnId?options.continuationRevision?.():undefined
    const continuation=checkpoint&&revision?{checkpoint,revision}:undefined
    let result:CodingResult
    try {
      result=await deps.run(task.id,input,controller.signal,modelId,event=>{
        if(disposed||controller.signal.aborted)return
        if(event.kind==='status')task.activity=event.text.slice(0,200)
        else task.progress=((task.progress??'')+event.text).slice(-32000)
        notify()
      },continuation)
      Object.assign(task,{state:'succeeded',summary:result.summary,output:result.output})
    } catch(error) {
      task.state=controller.signal.aborted||(error as {unknownOutcome?:boolean})?.unknownOutcome===true?'unknown_outcome':'failed'
      task.failure=error instanceof Error?error.message.slice(0,1000):'Task execution failed'
      task.summary=task.state==='unknown_outcome'?'Execution outcome not confirmed; verify before retrying.':'The harness task did not complete.'
      if(continuation&&recovery&&task.state==='unknown_outcome'&&!disposed&&!controller.signal.aborted){
        // Reconnect to the admitted task, leaving the original Office turn open.
        controllers.delete(task.id);observingStatus=true
        const status=await recovery.waitForTerminal(task.id,controller.signal)
        observingStatus=false
        // An observed failure is an ordinary tool failure, exactly as when the stream
        // never dropped; only a result we still cannot confirm ends the Office run.
        if(status?.state==='failed'){
          Object.assign(task,{state:'failed',failure:(status.failure??'Task execution failed').slice(0,1000),summary:'The harness task did not complete.'})
          throw new Error(task.failure)
        }
        if(status?.state!=='succeeded'||!status.result||!status.hasContinuation)throw new HarnessContinuationUnavailable()
        result={...status.result,agent:{id:agent.id,name:agent.name,origin:agent.origin}}
      }else{
        if(!disposed&&task.state==='unknown_outcome')recovery?.watch(task.id)
        // A cancel from the task card is a normal tool failure for the Office run, not a lost
        // continuation: only an outcome we could not observe fails the whole run.
        if(continuation&&task.state==='unknown_outcome'&&!cancelledByUser.has(task.id))throw new HarnessContinuationUnavailable()
        throw error
      }
    } finally {signal?.removeEventListener('abort',cancel);controllers.delete(task.id);cancelledByUser.delete(task.id);notify()}
    if(continuation&&recovery&&modelId){
      const tail=continuation.checkpoint.messages.at(-1)
      const call=tail?.role==='assistant'?tail.toolCalls?.[0]:undefined
      if(!call||disposed||signal?.aborted||options.continuationRevision?.()!==continuation.revision)throw new HarnessContinuationUnavailable()
      pendingResume={callId:call.id,taskId:task.id,documentId:options.documentId!,revision:continuation.revision}
    }
    return result
  }
  return {
    skill:createCodingSkill({...deps,run}),run,
    snapshot:()=>tasks.map(task=>({...task})),
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}},
    resetContinuation(){pendingResume=undefined},
    continuationFor(messages:readonly AgentMessage[]){
      const last=messages.at(-1)?.role==='user'?messages.at(-2):messages.at(-1)
      if(pendingResume&&last?.role==='tool'&&last.results.some(result=>result.id===pendingResume?.callId&&result.name==='delegate_agent_task'&&!result.isError)){
        const {taskId,documentId,revision}=pendingResume
        return {taskId,documentId,revision}
      }
    },
    async resume(id:string,signal:AbortSignal){
      const task=tasks.find(task=>task.id===id),revision=options.continuationRevision?.(),modelId=task?.continuationModelId
      if(disposed||signal.aborted||!recovery||!task||!revision||!modelId)return
      const {checkpoint,result}=await recovery.claim(id,revision,modelId,signal)
      if(disposed||signal.aborted||options.continuationRevision?.()!==revision)return
      pendingResume={callId:result.id,taskId:id,documentId:options.documentId!,revision}
      const {id:agentId,name,origin}=task.agent
      return {revision,modelId,checkpoint,result:{...result,output:JSON.stringify({...JSON.parse(result.output),agent:{id:agentId,name,origin}})}}
    },
    async cancel(id:string){
      const task=tasks.find(task=>task.id===id)
      if(task?.state!=='running')return
      task.state='cancel_requested';notify()
      const controller=controllers.get(id)
      if(controller){cancelledByUser.add(id);controller.abort()}
      else if(recovery)try{await recovery.cancel(id);recovery.watch(id)}catch(error){
        if(task.state==='cancel_requested')task.state='running'
        notify();throw error
      }
    },
    dispose(){disposed=true;recovery?.dispose();for(const controller of controllers.values())controller.abort();for(const handle of active)recovery?handle.detach():handle.cancel();active.clear();listeners.clear()},
  }
}
