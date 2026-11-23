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

/** While a task's event stream is open, /status is still read this often as a safety net. */
const STREAM_SAFETY_POLLS=10
type LiveView={activity?:string;progress?:string;state?:'running'|'cancel_requested'}

export function createCodingRecovery({documentId,storage,fetchImpl=fetch,csrfToken,onStatus,onUnavailable,events=true}:{
  documentId:string;storage?:TaskIdStorage;fetchImpl?:typeof fetch;csrfToken:string;onStatus:(status:RecoveryStatus)=>void
  onUnavailable?:(id:string)=>void
  /** Subscribe to the server's task event stream; polling remains the fallback. */
  events?:boolean
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
  let discoveryTimer:ReturnType<typeof setTimeout>|undefined,discoveryFailures=0
  const terminal=new Set(['succeeded','failed','unknown_outcome'])
  let streamEvents=events
  try{if(storage?.getItem('dyoffice.harness.events')==='off')streamEvents=false}catch{/* storage is optional */}
  const streams=new Map<string,AbortController>(),streamFailures=new Map<string,number>(),noStream=new Set<string>()
  const lastSequence=new Map<string,number>(),live=new Map<string,LiveView>(),latest=new Map<string,RecoveryStatus>()
  let polls=0
  const merged=(status:RecoveryStatus):RecoveryStatus=>{
    const view=live.get(status.turnId)
    if(!view||terminal.has(status.state))return status
    return {...status,...(view.activity!==undefined?{activity:view.activity}:{}),...(view.progress!==undefined?{progress:view.progress}:{}),
      ...(view.state==='cancel_requested'?{state:view.state}:{})}
  }
  function closeStream(id:string){streams.get(id)?.abort();streams.delete(id)}
  function applyEvent(id:string,event:{sequence?:unknown;kind?:unknown;payload?:unknown}){
    if(!Number.isSafeInteger(event.sequence)||(event.sequence as number)<=(lastSequence.get(id)??0))return
    lastSequence.set(id,event.sequence as number)
    const payload=(event.payload&&typeof event.payload==='object'?event.payload:{}) as {text?:unknown;state?:unknown}
    const view=live.get(id)??{}
    if(event.kind==='activity'&&typeof payload.text==='string')view.activity=payload.text.slice(0,200)
    else if(event.kind==='progress'&&typeof payload.text==='string')view.progress=((view.progress??'')+payload.text).slice(-32000)
    else if(event.kind==='state'){
      if(payload.state==='running'||payload.state==='cancel_requested')view.state=payload.state
      // A terminal state: the result and continuation come from /status.
      else if(typeof payload.state==='string'&&terminal.has(payload.state)){closeStream(id);clearTimeout(timer);void poll();return}
    }
    live.set(id,view)
    const base=latest.get(id)
    if(base&&!terminal.has(base.state))onStatus(merged(base))
  }
  function openStream(id:string){
    if(!streamEvents||streams.has(id)||noStream.has(id)||!watched.has(id)||controller.signal.aborted)return
    const stream=new AbortController();streams.set(id,stream)
    void (async()=>{
      let opened=false,frames=0
      try{
        const response=await fetchImpl('/api/v1/assistant/tasks/'+id+'/events'+query+'&after='+(lastSequence.get(id)??0),{
          method:'GET',headers:{...headers,accept:'text/event-stream'},credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',
          signal:AbortSignal.any([controller.signal,stream.signal]),
        })
        // 404 also covers a server without the endpoint: poll instead.
        if(!response.ok||!response.body||!/^text\/event-stream\b/.test(response.headers.get('content-type')??'')){
          if(response.ok||[401,403,404].includes(response.status))noStream.add(id)
          return
        }
        opened=true;streamFailures.delete(id)
        const reader=response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer=''
        for(;;){
          const {value,done}=await reader.read()
          if(done)break
          buffer+=value
          let end:number
          while((end=buffer.indexOf('\n\n'))>=0){
            const frame=buffer.slice(0,end);buffer=buffer.slice(end+2)
            const name=/^event: (.*)$/m.exec(frame)?.[1],data=/^data: (.*)$/m.exec(frame)?.[1]
            if(name==='end'){closeStream(id);clearTimeout(timer);void poll();return}
            frames++
            if(name==='task'&&data){try{applyEvent(id,JSON.parse(data))}catch{/* skip a malformed frame */}}
          }
        }
      }catch{/* the stream is best effort */}
      finally{
        if(streams.get(id)===stream){
          streams.delete(id)
          if(!opened){
            const failures=(streamFailures.get(id)??0)+1;streamFailures.set(id,failures)
            if(failures>=3)noStream.add(id)
          }
          // A stream ends after a bounded time; resume from the last sequence.
          if(watched.has(id)&&!controller.signal.aborted)setTimeout(()=>openStream(id),opened?(frames?0:1000):1000*2**Math.min(streamFailures.get(id)??0,5))
        }
      }
    })()
  }
  function forget(id:string){closeStream(id);live.delete(id);latest.delete(id);lastSequence.delete(id)}
  const get=(path:string)=>fetchImpl(path,{
    method:'GET',headers,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',
    signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]),
  })
  async function discover(){
    const fallback=discovering?saved:[]
    let ids:string[]=[],retry=false,retryAfterMs=0
    try {
      const response=await get(taskPath+query)
      retry=response.status===429||(response.status>=500&&response.status!==501)
      const after=Number(response.headers?.get?.('retry-after'))
      if(retry&&Number.isFinite(after)&&after>0)retryAfterMs=Math.min(after,300)*1000
      if(response.ok){
        const value=await response.json()
        if(Array.isArray(value?.taskIds))ids=value.taskIds.slice(0,limit).filter(validId)
      }
    }catch{retry=true}
    discovering=false
    if(controller.signal.aborted)return
    for(const id of [...new Set([...ids,...fallback])].slice(0,limit))watched.add(id)
    // Back off while the server is overloaded or unreachable instead of asking every second.
    if(retry){
      discoveryFailures++
      clearTimeout(discoveryTimer)
      discoveryTimer=setTimeout(()=>void discover(),Math.max(retryAfterMs,Math.min(60000,1000*2**(discoveryFailures-1))))
    }else discoveryFailures=0
    void poll()
  }
  function forgetUnavailable(id:string){
    forget(id)
    watched.delete(id)
    write(read().filter(saved=>saved!==id))
    observers.get(id)?.()
    onUnavailable?.(id)
  }
  async function poll(){
    if(discovering||pending||controller.signal.aborted||!watched.size)return
    // Exactly one polling loop: drop any scheduled run before starting this one.
    clearTimeout(timer);timer=undefined
    pending=true
    const safety=++polls%STREAM_SAFETY_POLLS===0
    try{
      await Promise.all([...watched].filter(id=>safety||!streams.has(id)).map(async id=>{
        try{
          const response=await get(taskPath+'/'+id+'/status'+query)
          if(controller.signal.aborted)return
          if([401,403,404].includes(response.status)){
            forgetUnavailable(id);return
          }
          if(!response.ok)return
          const value=await response.json() as RecoveryStatus
          if(controller.signal.aborted||!value||value.turnId!==id||value.documentId!==documentId||typeof value.agentId!=='string')return
          if(!terminal.has(value.state)&&value.state!=='running'&&value.state!=='cancel_requested')return
          // A terminal status we cannot use is still terminal: stop polling and fail the waiter fast.
          if(value.state==='succeeded'&&(typeof value.result?.summary!=='string'||typeof value.result.output!=='string')){
            forgetUnavailable(id);return
          }
          if(terminal.has(value.state)){watched.delete(id);forget(id);observers.get(id)?.(value);onStatus(value);return}
          latest.set(id,value)
          onStatus(merged(value))
          openStream(id)
        }catch{/* a transient read failure must not retry execution */}
      }))
    }finally{
      pending=false
      clearTimeout(timer)
      timer=watched.size&&!controller.signal.aborted?setTimeout(()=>void poll(),1000):undefined
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
    dispose(){controller.abort();clearTimeout(timer);clearTimeout(discoveryTimer);watched.clear();streams.clear()},
  }
}
