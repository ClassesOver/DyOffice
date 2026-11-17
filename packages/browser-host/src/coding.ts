import {createCodingSkill,type HarnessDescriptor,type CodingTask,type CodingResult} from '../../agent-core/src/coding-skill.ts'
import {createSseAgentTransport} from './ai-transport.ts'

/** Reuses the bounded SSE transport. No process starts until Office invokes the tool. */
export function createCodingClient(options:{agents:readonly HarnessDescriptor[];defaultId:string;csrfToken:string;getModelId:()=>string|null;dataCatalog?:(input:{sourcesAfter?:string;resultsAfter?:string})=>Promise<unknown>;fetchImpl?:typeof fetch}) {
  let disposed=false
  const active=new Set<{cancel():void}>()
  const agents=options.agents.map(a=>({...a,capabilities:[...a.capabilities]}))
  return {
    skill:createCodingSkill({
      list:()=>disposed?[]:agents,
      ...(options.dataCatalog?{dataCatalog:options.dataCatalog}:{}),
      run(input:CodingTask,signal?:AbortSignal):Promise<CodingResult> {
        if(disposed||signal?.aborted)return Promise.reject(Error('Coding task cancelled'))
        const id=input.agentId??options.defaultId
        if(!agents.some(a=>a.id===id&&a.capabilities.includes('coding')))return Promise.reject(Error('Coding agent unavailable'))
        return new Promise((resolve,reject)=>{
          let text='',error='',settled=false
          const transport=createSseAgentTransport({endpoint:'/api/v1/agents/tasks',modelId:id,getCsrfToken:async()=>options.csrfToken,timeoutMs:615000,...(options.fetchImpl ? {fetchImpl:options.fetchImpl} : {})})
          let handle:{cancel():void}|undefined
          const finish=()=>{
            if(settled)return
            settled=true;signal?.removeEventListener('abort',cancel);if(handle)active.delete(handle)
            if(error){reject(Error(error));return}
            try {
              const value=JSON.parse(text)
              if(!value||typeof value.summary!=='string'||typeof value.output!=='string')throw Error('Invalid coding result')
              const descriptor=agents.find(agent=>agent.id===id)!
              resolve({agent:{id:descriptor.id,name:descriptor.name,origin:descriptor.origin},summary:value.summary,output:value.output,...(value.delivery?{delivery:value.delivery}:{})})
            } catch {reject(Error('Cannot confirm coding result'))}
          }
          const cancel=()=>{error='Coding task cancelled';handle?.cancel();finish()}
          handle=transport.stream({system:'',messages:[{role:'user',text:JSON.stringify({officeModelId:options.getModelId(),instruction:input.instruction,...(input.context===undefined?{}:{context:input.context}),...(input.dataInputs===undefined?{}:{dataInputs:input.dataInputs})})}],tools:[]},
            {onDelta:delta=>{text+=delta},onToolCall:()=>{error='Unexpected coding tool';handle?.cancel();finish()},onError:message=>{error=message},onDone:finish})
          if(!settled)active.add(handle)
          if(!settled)signal?.addEventListener('abort',cancel,{once:true})
          if(signal?.aborted)cancel()
        })
      },
    }),
    dispose(){disposed=true;for(const handle of active)handle.cancel();active.clear()},
  }
}
