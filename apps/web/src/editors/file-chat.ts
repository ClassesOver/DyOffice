import {bindFileChat,type AgentMessage,type AgentTransport,type FileChatTurn,type VisibleChatMessage} from '@genoffice/agent-core'

type Message={turnId:string;role:'user'|'assistant';text:string;seq:number;state:'streaming'|'done'|'failed';sender?:'dsh'}
type Stored=Message&{order:number}
type Batch={cursor:number;messages:Stored[];hasMore:boolean}
type Request=<T>(path:string,method:string,body:unknown,signal:AbortSignal)=>Promise<T>
const key=(m:Message)=>m.turnId+':'+m.role
const bounded=(text:string)=>text.replace(/\0/g,'').slice(0,24000).replace(/[\uD800-\uDBFF]$/u,'')

/** The server owns the transcript. Only explicit foreground chat messages are
 * published; receiving messages never submits them to an editor or model. */
export function createFileChat(fileId:string,transport:AgentTransport,request:Request){
  const path='/api/v1/files/'+fileId+'/assistant-chat'
  const lifetime=new AbortController(),listeners=new Set<()=>void>()
  const records=new Map<string,Stored>(),outbox=new Map<string,Message>(),local=new Set<string>()
  const consumed=new WeakMap<object,Set<string>>()
  let cursor=0,closed=false,timer:ReturnType<typeof setTimeout>,active:Promise<void>|undefined
  let remote:Stored[]=[]
  function refresh(){
    if(active)return active
    if(closed)return Promise.resolve()
    clearTimeout(timer)
    active=(async()=>{
      let changed=false
      try{
        for(;;){
          const updates=Array.from(outbox.values()).slice(0,8)
          const batch=await request<Batch>(path,'POST',{after:cursor,updates},lifetime.signal)
          if(closed)return
          for(const u of updates)if(outbox.get(key(u))===u)outbox.delete(key(u))
          for(const m of batch.messages){records.set(key(m),m);if(!local.has(m.turnId))changed=true}
          cursor=batch.cursor
          // Streaming text is paced by the 700 ms timer (each POST row-locks the file);
          // only server pages and final/user messages are flushed back to back.
          if(!batch.hasMore&&![...outbox.values()].some(m=>m.state!=='streaming'))break
        }
      }catch(error){
        if((error as {code?:string}).code==='stale_session'||[401,403,404].includes((error as {status:number}).status)){
          closed=true;outbox.clear();records.clear();changed=true
        }
      }finally{
        if(changed){remote=[...records.values()].filter(m=>!local.has(m.turnId)).sort((a,b)=>a.order-b.order);for(const notify of listeners)notify()}
        active=undefined
        if(!closed)timer=setTimeout(refresh,700)
      }
    })()
    return active
  }
  const put=(m:Message)=>{if(!closed)outbox.set(key(m),m)}
  function attach(turnId:string,loop:object,seq=0,last=''):FileChatTurn {
    const seen=consumed.get(loop)??new Set<string>()
    consumed.set(loop,seen);seen.add(turnId)
    const update=(text:string,state:Message['state'])=>put({turnId,role:'assistant',text:bounded(text),state,seq:++seq})
    return {
      turnId,
      consumedTurns:()=>[...seen],
      restoreConsumedTurns(ids){for(const id of ids)seen.add(id)},
      async history(){
        await refresh()
        const additions:AgentMessage[]=[]
        for(const user of [...records.values()].filter(m=>m.role==='user').sort((a,b)=>a.order-b.order)){
          const answer=records.get(user.turnId+':assistant')
          if(!seen.has(user.turnId)&&answer?.state==='done'&&answer.text){
            seen.add(user.turnId)
            additions.push({role:'user',text:user.text},{role:'assistant',text:answer.text})
          }
        }
        return additions
      },
      text(text){if(text!==last){last=text;update(text,'streaming')}},
      finish(text,failed){update(text||last,failed?'failed':'done');void refresh()},
    }
  }
  function start(message:VisibleChatMessage,loop:object):FileChatTurn {
    const turnId=crypto.randomUUID()
    local.add(turnId)
    put({turnId,role:'user',state:'done',seq:0,text:bounded(message.text),...(message.sender&&{sender:message.sender})})
    put({turnId,role:'assistant',state:'streaming',seq:1,text:''})
    return attach(turnId,loop,1)
  }
  async function resume(turnId:string,loop:object){
    await refresh()
    const user=records.get(turnId+':user'), answer=records.get(turnId+':assistant')
    if(closed||!user||user.sender||answer?.state!=='streaming')return
    return attach(turnId,loop,answer.seq,answer.text)
  }
  const unbind=bindFileChat(transport,start)
  void refresh()
  return {resume,read:()=>remote,subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}},
    dispose(){unbind();closed=true;clearTimeout(timer);lifetime.abort();outbox.clear();listeners.clear()}}
}
