import {createSseAgentTransport} from '../../../../packages/browser-host/src/ai-transport'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {AssistantCatalog} from '../../../../packages/web-contracts/src/assistant'

export interface HomeHeroCopy {greeting:string;guidance:string}

/** Decorative copy never delays the homepage or receives document context. */
export async function generateHomeHero({request,csrfToken,language,hour,signal,fetchImpl}: {request:SettingsRequest;csrfToken:string;language:string;hour:number;signal:AbortSignal;fetchImpl?:typeof fetch}):Promise<HomeHeroCopy|null>{
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(8000)])
 try{
  const catalog=await request<AssistantCatalog>('/api/v1/ai/catalog','GET',undefined,deadline)
  deadline.throwIfAborted()
  if(!catalog.defaultId||!catalog.entries.some(entry=>entry.id===catalog.defaultId))return null
  const time=hour<6?'night':hour<12?'morning':hour<18?'afternoon':'evening'
  const text=await new Promise<string|null>(resolve=>{
   let output='',failed=false,handle:{cancel():void}|undefined
   const abort=()=>{handle?.cancel();resolve(null)}
   deadline.addEventListener('abort',abort,{once:true})
   handle=createSseAgentTransport({modelId:catalog.defaultId!,getCsrfToken:async()=>csrfToken,timeoutMs:8000,...(fetchImpl?{fetchImpl}:{})}).stream({
    system:'Write brief, warm homepage copy for DyOffice, an office workspace. Return only a JSON object with greeting and guidance string fields. Use the requested language. Greeting: at most 12 Chinese characters or 45 English characters. Guidance: at most 28 Chinese characters or 100 English characters. Each field is one short sentence. Suggest writing, spreadsheets, presentations or PDF work. Do not claim knowledge of user documents, tasks or activity. No names, markdown, links, explanations or line breaks within fields.',
    messages:[{role:'user',text:`Language: ${language}. Time of day: ${time}.`}],tools:[],
   },{
    onDelta:part=>{output+=part;if(output.length>1024){failed=true;handle?.cancel();resolve(null)}},
    onToolCall:()=>{failed=true},onError:()=>{failed=true},
    onDone:()=>{deadline.removeEventListener('abort',abort);resolve(failed?null:output)},
   })
   if(deadline.aborted)abort()
  })
  deadline.throwIfAborted()
  if(!text)return null
  // Bound requests verify the original session before applying a late response.
  await request('/api/v1/auth/session-proof','GET',undefined,deadline)
  deadline.throwIfAborted()
  const value=JSON.parse(text) as HomeHeroCopy
  const plain=(field:unknown,max:number):field is string=>typeof field==='string'&&field.trim().length>0&&field.length<=max&&!/[\r\n\u0000-\u001f]/.test(field)
  if(!value||!plain(value.greeting,45)||!plain(value.guidance,100))return null
  return {greeting:value.greeting.trim(),guidance:value.guidance.trim()}
 }catch{return null}
}
