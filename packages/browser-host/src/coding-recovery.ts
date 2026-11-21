import type {CodingResult} from '../../agent-core/src/coding-skill.ts'
import type {CodingTaskView} from './coding.ts'
import type {HarnessCheckpoint} from '../../agent-core/src/loop.ts'
import type {AgentToolResult} from '../../agent-core/src/types.ts'

type RecoveryStatus={
  turnId:string;documentId:string;agentId:string;instruction?:string
  state:CodingTaskView['state'];activity?:string;progress?:string;failure?:string;result?:CodingResult
  hasContinuation?:boolean
  continuationModelId?:string
}
type Continuation={checkpoint:HarnessCheckpoint;result:AgentToolResult}
export type TaskIdStorage=Pick<Storage,'getItem'|'setItem'>
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
const limit=8

export function createCodingRecovery({documentId,storage,fetchImpl=fetch,csrfToken,onStatus}:{
  documentId:string;storage?:TaskIdStorage;fetchImpl?:typeof fetch;csrfToken:string;onStatus:(status:RecoveryStatus)=>void
}){
  const key='dyoffice.harness.tasks:'+documentId
  const headers={'x-csrf-token':csrfToken}
  const taskPath='/api/v1/agents/tasks', query='?documentId='+encodeURIComponent(documentId)
  const read=():string[]=>{
    try{const ids=JSON.parse(storage?.getItem(key)??'[]');return Array.isArray(ids)?ids.filter(validId).slice(0,limit):[]}
    catch{return []}
  }
  const write=(ids:string[])=>{try{storage?.setItem(key,JSON.stringify(ids.slice(0,limit)))}catch{/* storage is optional */}}
  const saved=read(),watched=new Set<string>(),controller=new AbortController()
  const observers=new Map<string,(status?:RecoveryStatus)=>void>()
  let discovering=true,pending=false,timer:ReturnType<typeof setTimeout>|undefined
  let discoveryTimer:ReturnType<typeof setTimeout>|undefined
  const terminal=new Set(['succeeded','failed','unknown_outcome'])
  const get=(path:string)=>fetchImpl(path,{
    method:'GET',headers,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',
    signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]),
  })
  async function discover(){
    const fallback=discovering?saved:[]
    let ids:string[]=[],retry=false
    try {
      const response=await get(taskPath+query)
      retry=response.status===429||(response.status>=500&&response.status!==501)
      if(response.ok){
        const value=await response.json()
        if(Array.isArray(value?.taskIds))ids=value.taskIds.slice(0,limit).filter(validId)
      }
    }catch{retry=true}
    discovering=false
    if(controller.signal.aborted)return
    for(const id of [...new Set([...ids,...fallback])].slice(0,limit))watched.add(id)
    if(retry)discoveryTimer=setTimeout(()=>void discover(),1000)
    void poll()
  }
  async function poll(){
    if(discovering||pending||controller.signal.aborted||!watched.size)return
    pending=true
    try{
      await Promise.all([...watched].map(async id=>{
        try{
          const response=await get(taskPath+'/'+id+'/status'+query)
          if(controller.signal.aborted)return
          if([401,403,404].includes(response.status)){
            watched.delete(id);write(read().filter(saved=>saved!==id));observers.get(id)?.();return
          }
          if(!response.ok)return
          const value=await response.json() as RecoveryStatus
          if(controller.signal.aborted||!value||value.turnId!==id||value.documentId!==documentId||typeof value.agentId!=='string')return
          if(!terminal.has(value.state)&&value.state!=='running'&&value.state!=='cancel_requested')return
          // A terminal status we cannot use is still terminal: stop polling and fail the waiter fast.
          if(value.state==='succeeded'&&(typeof value.result?.summary!=='string'||typeof value.result.output!=='string')){
            watched.delete(id);write(read().filter(saved=>saved!==id));observers.get(id)?.();return
          }
          if(terminal.has(value.state)){watched.delete(id);observers.get(id)?.(value)}
          onStatus(value)
        }catch{/* a transient read failure must not retry execution */}
      }))
    }finally{
      pending=false
      if(watched.size&&!controller.signal.aborted)timer=setTimeout(()=>void poll(),1000)
    }
  }
  void discover()
  function watch(id:string){watched.add(id);clearTimeout(timer);void poll()}
  return {
    remember(id:string){write([id,...read().filter(saved=>saved!==id)])},
    watch,
    waitForTerminal(id:string,signal:AbortSignal):Promise<RecoveryStatus|undefined>{
      const lifetime=AbortSignal.any([controller.signal,signal,AbortSignal.timeout(615000)])
      if(lifetime.aborted)return Promise.resolve(undefined)
      return new Promise(resolve=>{
        const finish=(status?:RecoveryStatus)=>{
          lifetime.removeEventListener('abort',abort);observers.delete(id);resolve(status)
        }
        const abort=()=>finish()
        observers.set(id,finish);lifetime.addEventListener('abort',abort,{once:true});watch(id)
      })
    },
    async claim(id:string,revision:string,modelId:string,signal?:AbortSignal):Promise<Continuation>{
      const lifetime=signal?AbortSignal.any([controller.signal,signal]):controller.signal
      const attempt=async()=>{
        lifetime.throwIfAborted()
        let response:Response,value:Continuation|undefined
        try{
          response=await fetchImpl('/api/v1/agents/tasks/'+id+'/continuation',{
            method:'POST',headers:{...headers,'content-type':'application/json'},credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',
            body:JSON.stringify({documentId,revision,modelId,defer:true}),signal:AbortSignal.any([lifetime,AbortSignal.timeout(5000)]),
          })
          if(response.ok)value=await response.json() as Continuation
        }catch{lifetime.throwIfAborted();return}
        if(response.status>=500)return
        if(!response.ok)throw Error('Harness continuation unavailable')
        if(!value||!Array.isArray(value.checkpoint?.messages)||value.result?.name!=='delegate_agent_task'||typeof value.result.output!=='string')throw Error('Invalid Harness continuation')
        return value
      }
      // This read is repeatable. Never retry task execution or resume admission here.
      const checkpoint=await attempt()??await attempt()
      if(!checkpoint)throw Error('Harness continuation unavailable')
      return checkpoint
    },
    async cancel(id:string){
      const response=await fetchImpl('/api/v1/agents/tasks/'+id+'/cancel',{method:'POST',headers,credentials:'same-origin',mode:'same-origin',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])})
      if(!response.ok)throw Error('Harness cancellation could not be confirmed')
    },
    dispose(){controller.abort();clearTimeout(timer);clearTimeout(discoveryTimer);watched.clear()},
  }
}
