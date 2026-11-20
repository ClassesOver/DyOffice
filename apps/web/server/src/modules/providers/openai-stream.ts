import type { TurnEvent } from './turns.ts'

const invalid = () => new Error('Invalid provider stream')
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const record = (value: unknown): value is Record<string,unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
interface PendingTool { id: string; name: string; json: string; bytes: number }
/** Pure, strict OpenAI chat-completions SSE decoder. No fetch, secrets, authority or tool execution.
 * The caller owns authorized/pinned egress and its absolute request deadline.
 * Accepts [DONE] or a complete finish frame followed by clean EOF.
 * Emits tool candidates only after the entire turn validates.
 */
export async function* parseOpenAiChatStream(source: AsyncIterable<Uint8Array>, options: {
  signal?: AbortSignal; maxBytes?: number; maxFrameBytes?: number
} = {}): AsyncGenerator<TurnEvent> {
  const maxBytes=options.maxBytes ?? 8*1024*1024, maxFrameBytes=options.maxFrameBytes ?? 256*1024
  if(!Number.isSafeInteger(maxBytes)||maxBytes<128||maxBytes>32*1024*1024||!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<128||maxFrameBytes>256*1024)throw invalid()
  if(options.signal?.aborted)throw invalid()
  let iterator: AsyncIterator<Uint8Array> | undefined
  const encoder=new TextEncoder(), decoder=new TextDecoder('utf-8',{fatal:true})
  const tools=new Map<number,PendingTool>()
  let total=0,pending='',frameBytes=0,data:string[]=[],completed=false,finish:string|undefined
  const usage: {inputTokens?:number;outputTokens?:number}={}
  let rejectAbort!:()=>void
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(invalid())})
  void aborted.catch(()=>{})
  options.signal?.addEventListener('abort',rejectAbort,{once:true})
  if(options.signal?.aborted)rejectAbort()
  function accept(raw:string):TurnEvent[] {
    if(raw==='[DONE]'){completed=true;return []}
    const value:unknown=JSON.parse(raw)
    if(!record(value)||value.error)throw invalid()
    if(value.usage!==undefined && value.usage!==null){
      if(!record(value.usage))throw invalid()
      for(const [wire,field] of [['prompt_tokens','inputTokens'],['completion_tokens','outputTokens']] as const){
        const number=value.usage[wire]
        if(number!==undefined && number!==null){if(typeof number!=='number'||!Number.isSafeInteger(number)||number<0)throw invalid();usage[field]=number}
      }
    }
    if(!Array.isArray(value.choices)||value.choices.length>1)throw invalid()
    if(!value.choices.length)return []
    const choice=value.choices[0]
    if(!record(choice)||(choice.index!==undefined&&choice.index!==0)||!record(choice.delta))throw invalid()
    const delta=choice.delta, events:TurnEvent[]=[]
    if(finish && Object.keys(delta).some(key=>['content','reasoning','reasoning_content','tool_calls'].includes(key)))throw invalid()
    for(const [field,type] of [['content','delta'],[delta.reasoning_content!==undefined?'reasoning_content':'reasoning','reasoning']] as const){
      const text=delta[field]
      if(text!==undefined && text!==null){if(typeof text!=='string')throw invalid();if(text)events.push({type,text})}
    }
    if(delta.tool_calls!==undefined){
      if(!Array.isArray(delta.tool_calls)||delta.tool_calls.length>64)throw invalid()
      for(const call of delta.tool_calls){
        if(!record(call)||!Number.isSafeInteger(call.index)||(call.index as number)<0||(call.index as number)>=64||!record(call.function))throw invalid()
        const index=call.index as number,p=tools.get(index)??{id:'',name:'',json:'',bytes:0}
        if(call.id!==undefined&&!(call.id===''&&p.id)){if(!identifier(call.id)||(p.id&&p.id!==call.id))throw invalid();p.id=call.id}
        if(call.function.name!==undefined){
          if(typeof call.function.name!=='string')throw invalid()
          p.name+=call.function.name
          if(p.name.length>128)throw invalid()
        }
        if(call.function.arguments!==undefined){
          if(typeof call.function.arguments!=='string')throw invalid()
          p.bytes+=encoder.encode(call.function.arguments).byteLength
          if(p.bytes>256*1024)throw invalid()
          p.json+=call.function.arguments
        }
        tools.set(index,p)
      }
    }
    if(choice.finish_reason!==undefined && choice.finish_reason!==null){
      if(finish || !['stop','tool_calls','length'].includes(choice.finish_reason as string))throw invalid()
      finish=choice.finish_reason as string
    }
    return events
  }
  try {
    iterator=source[Symbol.asyncIterator]()
    while(!completed){
      if(options.signal?.aborted)throw invalid()
      const next=await Promise.race([Promise.resolve().then(()=>iterator!.next()),aborted])
      if(next.done){pending+=decoder.decode();break}
      if(!(next.value instanceof Uint8Array))throw invalid()
      total+=next.value.byteLength;if(total>maxBytes)throw invalid()
      pending+=decoder.decode(next.value,{stream:true})
      let cut:number
      while(!completed && (cut=pending.indexOf('\n'))!==-1){
        const rawLine=pending.slice(0,cut),line=rawLine.replace(/\r$/,'');pending=pending.slice(cut+1)
        frameBytes+=encoder.encode(rawLine).byteLength+1;if(frameBytes>maxFrameBytes)throw invalid()
        if(line===''){
          if(data.length)for(const event of accept(data.join('\n'))){if(options.signal?.aborted)throw invalid();yield event}
          data=[];frameBytes=0
        }else if(line.startsWith('data:')){let text=line.slice(5);if(text.startsWith(' '))text=text.slice(1);data.push(text)}
      }
      if(!completed && frameBytes+encoder.encode(pending).byteLength>maxFrameBytes)throw invalid()
    }
    if(!completed && (!finish || pending || frameBytes ||
      (finish!=='length' && (finish==='tool_calls')!==(tools.size>0))))throw invalid()
    if(options.signal?.aborted)throw invalid()
    // Validate the complete collection before exposing any candidate to T14.
    // A length-limited batch cannot execute, even if some tool arguments parse.
    const calls:TurnEvent[]=[], ids=new Set<string>()
    if(finish!=='length')for(const [,tool] of [...tools].sort(([a],[b])=>a-b)){
      if(!identifier(tool.id)||!identifier(tool.name)||ids.has(tool.id))throw invalid()
      ids.add(tool.id)
      const input:unknown=JSON.parse(tool.json);if(!record(input))throw invalid()
      calls.push({type:'tool_call',id:tool.id,name:tool.name,input})
    }
    for(const call of calls){if(options.signal?.aborted)throw invalid();yield call}
    if(options.signal?.aborted)throw invalid()
    if(finish==='length')yield {type:'stop_reason',reason:'max_tokens'}
    if(options.signal?.aborted)throw invalid()
    if(Object.keys(usage).length)yield {type:'usage',...usage}
  } catch { throw invalid() }
  finally {
    options.signal?.removeEventListener('abort',rejectAbort)
    // Do not await a broken iterator forever; the owning transport retains its
    // own in-flight admission slot until actual network work has settled.
    try { if(iterator?.return)void Promise.resolve(iterator.return()).catch(()=>{}) } catch { /* best effort */ }
  }
}
