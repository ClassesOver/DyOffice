import {Readable} from 'node:stream'
import {sseDataEvents} from '../../../../../../packages/ai-provider/src/protocols/shared.ts'
import {reasoningSignature} from '../../../../../../packages/ai-provider/src/protocols/openai-responses.ts'
import type {TurnEvent} from './turns.ts'

/** Tool execution is gated by the final response, even if earlier items looked complete. */
export async function* parseResponsesStream(source:AsyncIterable<Uint8Array>,{signal}:{signal:AbortSignal}):AsyncGenerator<TurnEvent>{
 const invalid=()=>Error('Invalid Responses stream')
 const stream=Readable.from(source,{signal})
 let terminal=false,sawText=false
 const finalEvents:TurnEvent[]=[]
 try{
  for await(const frame of sseDataEvents(Readable.toWeb(stream) as ReadableStream<Uint8Array>)){
   if(frame.raw==='[DONE]')continue
   const e=frame.json as Record<string,any>|undefined
   if(!e||typeof e.type!=='string'||terminal||e.type==='error'||e.type==='response.failed')throw invalid()
   if(e.type==='response.output_text.delta'||e.type==='response.reasoning_summary_text.delta'){
    if(typeof e.delta!=='string')throw invalid()
    const type=e.type==='response.output_text.delta'?'delta':'reasoning'
    if(type==='delta'&&e.delta)sawText=true
    if(e.delta)yield {type,text:e.delta}
   }
   if(e.type!=='response.completed'&&e.type!=='response.incomplete')continue
   const r=e.response,cut=e.type==='response.incomplete'
   if(!Array.isArray(r?.output)||r.status!==(cut?'incomplete':'completed')||(cut&&r.incomplete_details?.reason!=='max_output_tokens'))throw invalid()
   terminal=true
   const ids=new Set<string>()
   let signature:string|undefined
   for(const item of r.output){
    if(item.type==='reasoning'&&typeof item.id==='string'&&typeof item.encrypted_content==='string')signature=reasoningSignature(item.id,item.encrypted_content)
    if(item.type==='message'&&!sawText)for(const part of item.content){if(part.type==='output_text'&&typeof part.text==='string')finalEvents.push({type:'delta',text:part.text})}
    if(item.type==='function_call'&&!cut){
     const {call_id:id,name}=item
     if(![id,name].every(s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(s))||ids.has(id)||ids.size>=64||typeof item.arguments!=='string')throw invalid()
     const input=JSON.parse(item.arguments)
     if(!input||typeof input!=='object'||Array.isArray(input))throw invalid()
     ids.add(id);finalEvents.push({type:'tool_call',id,name,input,...(signature?{signature}:{})});signature=undefined
    }
   }
   if(cut)finalEvents.push({type:'stop_reason',reason:'max_tokens'})
   if(r.usage)finalEvents.push({type:'usage',inputTokens:r.usage.input_tokens,outputTokens:r.usage.output_tokens})
  }
  if(!terminal||signal.aborted)throw invalid()
  for(const event of finalEvents)yield event
 }finally{stream.destroy()}
}
