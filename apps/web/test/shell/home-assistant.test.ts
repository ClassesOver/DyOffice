import React from 'react'
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import {HomeAssistant} from '../../src/shell/HomeAssistant'
let root:Root
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
afterEach(async()=>{await act(async()=>root?.unmount());document.body.innerHTML=''})
async function render(element:React.ReactNode){const host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(element))}
const button=(name:string)=>[...document.querySelectorAll('button')].find(b=>b.textContent===name||b.getAttribute('aria-label')===name)!
async function click(name:string){await act(async()=>button(name).click())}
const proof='a'.repeat(43)
function fixture(entries:unknown[]=[{id:'m1',label:'Model'}]){
 const requests:Array<{url:string;init?:RequestInit}>=[]
 const send=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);requests.push({url,init})
  if(url==='/api/v1/ai/catalog')return Response.json({entries,defaultId:entries.length?'m1':null})
  if(url==='/api/v1/ai/turns')return new Response('event: delta\ndata: {"text":"你好"}\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
  return Response.json({csrfToken:proof})
 })
 const bind=async()=>({proof,request:async<T,>(url:string)=>{const r=await send(url);return await r.json() as T}})
 return {send,bind,requests}
}
it('opens a gated real transport chat, no document or execution tools',async()=>{
 const f=fixture();await render(React.createElement(HomeAssistant,{bind:f.bind,fetchImpl:f.send}));await click('AI 助手')
 expect(document.querySelector('select')).not.toBeNull()
 await act(async()=>{const input=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'你好');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await click('发送')
 expect(document.querySelector('[role=log]')!.textContent).toContain('你好助手你好')
 const call=f.requests.find(r=>r.url==='/api/v1/ai/turns')!;expect(call.init?.headers).toMatchObject({'x-csrf-token':proof})
 expect(JSON.parse(call.init!.body as string).request.tools).toEqual([])
})
it('keeps unavailable catalog visible and prevents sending',async()=>{
 const f=fixture([]);await render(React.createElement(HomeAssistant,{bind:f.bind,fetchImpl:f.send}));await click('AI 助手')
 expect(document.body.textContent).toContain('没有可用模型');expect(button('发送')).toBeUndefined();expect(f.requests.some(r=>r.url.includes('/stream'))).toBe(false)
})
it('shows session failure and retries without hiding the entry',async()=>{
 const f=fixture();const bind=vi.fn().mockRejectedValueOnce(Object.assign(Error('expired'),{status:401})).mockImplementation(f.bind)
 await render(React.createElement(HomeAssistant,{bind,fetchImpl:f.send}));await click('AI 助手')
 expect(document.body.textContent).toContain('登录状态已失效');await click('重试');expect(document.querySelector('select')).not.toBeNull()
})
it('closing while initialization is pending does not reopen or render stale results',async()=>{
 const f=fixture();let release!:(v:Awaited<ReturnType<typeof f.bind>>)=>void
 await render(React.createElement(HomeAssistant,{bind:()=>new Promise(r=>{release=r}),fetchImpl:f.send}));await click('AI 助手');await click('关闭助手')
 await act(async()=>release(await f.bind()));expect(document.querySelector('[role=dialog]')).toBeNull()
})
it('close aborts a pending stream and submits cancellation with original proof',async()=>{
 const f=fixture();let signal:AbortSignal|undefined
 const send:typeof fetch=async(input,init)=>{
  if(String(input)==='/api/v1/ai/turns'){signal=init?.signal as AbortSignal;f.requests.push({url:String(input),init});return new Promise<Response>((_,reject)=>signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))}
  return f.send(input,init)
 }
 await render(React.createElement(HomeAssistant,{bind:f.bind,fetchImpl:send}));await click('AI 助手')
 await act(async()=>{const input=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'test');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await click('发送');expect(button('发送').disabled).toBe(true);await click('关闭助手')
 expect(signal?.aborted).toBe(true);expect(f.requests.find(r=>r.url.endsWith('/cancel'))?.init?.headers).toMatchObject({'x-csrf-token':proof})
})
it('surfaces server denial rather than fabricating an answer',async()=>{
 const f=fixture();const send:typeof fetch=async(input,init)=>String(input)==='/api/v1/ai/turns'?new Response('denied',{status:403}):f.send(input,init)
 await render(React.createElement(HomeAssistant,{bind:f.bind,fetchImpl:send}));await click('AI 助手')
 await act(async()=>{const input=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'test');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await click('发送');expect(document.querySelector('[role=alert]')?.textContent).toBeTruthy();expect(button('发送').disabled).toBe(true)
})
it('real bound session rejects catalog after account cookie changes',async()=>{
 const {createLocalShellClient}=await import('../../src/shell/local-client')
 let swapped=false,turns=0
 const send:typeof fetch=async(input)=>{
  const path=String(input)
  if(path==='/api/v1/ai/catalog'){swapped=true;return Response.json({entries:[{id:'m1',label:'Model'}],defaultId:'m1'})}
  if(path==='/api/v1/ai/turns')turns++
  return Response.json({csrfToken:swapped?'b'.repeat(43):proof})
 }
 const client=createLocalShellClient(send)
 await render(React.createElement(HomeAssistant,{bind:()=>client.bindSession(proof),fetchImpl:send}));await click('AI 助手')
 expect(document.body.textContent).toContain('登录状态已失效');expect(document.querySelector('textarea')).toBeNull();expect(turns).toBe(0)
})

it.each(['expired','logout_failed'])('Root-style %s recovery cancels active home chat, clears text and does not reopen',async(reason)=>{
 const f=fixture();let signal:AbortSignal|undefined
 const send:typeof fetch=async(input,init)=>{
  if(String(input)==='/api/v1/ai/turns'){signal=init?.signal as AbortSignal;return new Promise<Response>((_,reject)=>signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))}
  return f.send(input,init)
 }
 const {createLocalShellClient}=await import('../../src/shell/local-client');const session=createLocalShellClient()
 const view=(recovery:boolean)=>React.createElement('div',{inert:recovery,style:{display:recovery?'none':'contents'}},React.createElement(HomeAssistant,{bind:f.bind,fetchImpl:send,recovery}))
 function RecoveryRoot(){const [recovery,setRecovery]=React.useState(false);React.useEffect(()=>session.onSessionEnded(()=>setRecovery(true)),[]);return view(recovery)}
 await render(React.createElement(RecoveryRoot));await click('AI 助手')
 await act(async()=>{const input=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'private user conversation');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await click('发送');await act(async()=>session.endSession(reason as 'expired'|'logout_failed'))
 expect(signal?.aborted).toBe(true)
 expect(document.querySelector('[role=log]')?.textContent??'').not.toContain('private user conversation')
 await act(async()=>root.render(view(false)));expect(document.querySelector('[role=dialog]')).toBeNull()
 await click('AI 助手');expect(document.querySelector('[role=log]')?.textContent).toBe('')
})

it('Root recovery reaches the actual homepage assistant mount without unmounting document shell',async()=>{
 const {readFileSync}=await import('node:fs');const source=readFileSync('src/shell/local-main.tsx','utf8')
 expect(source).toContain('<Shell recovery={!!recovery}/>');expect(source).toContain('accountEntry:<Account onOpen={setPage} recovery={recovery}/>');expect(source).toContain('bind={bindHomeAssistant} recovery={recovery}/>')
})
it('homepage chat chrome uses existing semantic tokens without raw colors',async()=>{
 const {readFileSync}=await import('node:fs');const css=readFileSync('src/shell/home-assistant.css','utf8');const tokens=readFileSync('../../packages/ui/src/tokens.css','utf8')
 expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/)
 expect(css).toContain('box-shadow:var(--shadow-menu)');expect(css).toContain('color:var(--danger)')
 expect(tokens.match(/--shadow-menu:/g)?.length).toBe(3);expect(tokens.match(/--danger:/g)?.length).toBe(3)
})

it.each(['budget','permission','sse','stop'])('a %s failure before the first token does not poison the next provider request',async mode=>{
 const {buildOpenAiChatRequest}=await import('../../server/src/modules/providers/openai-request')
 const f=fixture();let turns=0,validNext=false
 const send:typeof fetch=async(input,init)=>{
  if(String(input)!=='/api/v1/ai/turns')return f.send(input,init)
  turns++
  if(turns===1){
   if(mode==='budget'||mode==='permission')return new Response('denied',{status:mode==='budget'?429:403})
   if(mode==='sse')return new Response('event: error\ndata: {"message":"AI stream unavailable"}\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
   return new Promise<Response>((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))
  }
  const request=JSON.parse(init!.body as string).request
  buildOpenAiChatRequest(request,{model:'synthetic',maxOutputTokens:128})
  validNext=true
  return new Response('event: delta\ndata: {"text":"recovered answer"}\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }
 const type=async(value:string)=>act(async()=>{const input=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})
 await render(React.createElement(HomeAssistant,{bind:f.bind,fetchImpl:send}));await click('AI 助手');await type('first question');await click('发送')
 if(mode==='stop')await click('停止')
 await type('next question');await click('发送')
 expect(turns).toBe(2);expect(validNext).toBe(true)
 expect(document.querySelector('[role=log]')!.textContent).toContain('recovered answer')
})

it('retains a partial interrupted answer and rejects duplicate submits while running',async()=>{
 const {buildOpenAiChatRequest}=await import('../../server/src/modules/providers/openai-request')
 const f=fixture();let turns=0;let nextHistory:Array<{role:string;text:string}>=[]
 const send:typeof fetch=async(input,init)=>{
  if(String(input)!=='/api/v1/ai/turns')return f.send(input,init)
  if(++turns===1)return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial answer"}\n\n'))}}),{headers:{'content-type':'text/event-stream'}})
  const request=JSON.parse(init!.body as string).request
  buildOpenAiChatRequest(request,{model:'synthetic',maxOutputTokens:128});nextHistory=request.messages
  return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
 }
 const type=async(value:string)=>act(async()=>{const input=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})
 await render(React.createElement(HomeAssistant,{bind:f.bind,fetchImpl:send}));await click('AI 助手');await type('question');await click('发送')
 expect(document.querySelector('[role=log]')!.textContent).toContain('partial answer')
 await act(async()=>{document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})
 expect(turns).toBe(1);await click('停止');await type('continue');await click('发送')
 expect(nextHistory).toContainEqual({role:'assistant',text:'partial answer'})
 expect(document.querySelector('[role=log]')!.textContent).not.toContain('…')
})

it('account-key replacement clears the old chat and ignores its late response',async()=>{
 const f=fixture();let late!:(response:Response)=>void,signal:AbortSignal|undefined
 const send:typeof fetch=async(input,init)=>{
  if(String(input)==='/api/v1/ai/turns'){signal=init?.signal as AbortSignal;return new Promise(resolve=>{late=resolve})}
  return f.send(input,init)
 }
 await render(React.createElement(HomeAssistant,{key:'account-a',bind:f.bind,fetchImpl:send}));await click('AI 助手')
 await act(async()=>{const input=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'private A');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await click('发送')
 await act(async()=>root.render(React.createElement(HomeAssistant,{key:'account-b',bind:f.bind,fetchImpl:f.send})))
 expect(signal?.aborted).toBe(true);await click('AI 助手')
 await act(async()=>late(new Response('event: delta\ndata: {"text":"late private A"}\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})))
 expect(document.querySelector('[role=log]')!.textContent).toBe('')
 expect(document.querySelector('textarea')!.value).toBe('')
})

it('keeps a long multi-turn conversation within the real provider request budget',async()=>{
 const {buildOpenAiChatRequest}=await import('../../server/src/modules/providers/openai-request')
 const f=fixture();let validTurns=0,rejections=0
 const answer='答'.repeat(40000) // 120KB UTF-8, below the single-message and SSE-frame limits.
 const send:typeof fetch=async(input,init)=>{
  if(String(input)!=='/api/v1/ai/turns')return f.send(input,init)
  const body=init!.body as string
  try{
   if(new TextEncoder().encode(body).length>1024*1024)throw Error('HTTP body limit')
   buildOpenAiChatRequest(JSON.parse(body).request,{model:'synthetic',maxOutputTokens:32768})
  }catch{rejections++;return new Response('too large',{status:413})}
  validTurns++
  return new Response(`event: delta\ndata: ${JSON.stringify({text:answer})}\n\nevent: done\ndata: {}\n\n`,{headers:{'content-type':'text/event-stream'}})
 }
 await render(React.createElement(HomeAssistant,{bind:f.bind,fetchImpl:send}));await click('AI 助手')
 for(let i=0;i<10;i++){
  await act(async()=>{const input=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'question '+i);input.dispatchEvent(new Event('input',{bubbles:true}))})
  await click('发送')
 }
 expect(rejections).toBe(0);expect(validTurns).toBe(10)
 expect(document.body.textContent).toContain('对话上下文已缩短')
})

it('rejects an oversized multibyte latest input without dispatch or clearing the draft',async()=>{
 const f=fixture();await render(React.createElement(HomeAssistant,{bind:f.bind,fetchImpl:f.send}));await click('AI 助手')
 const draft='界'.repeat(10923)
 await act(async()=>{const input=document.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,draft);input.dispatchEvent(new Event('input',{bubbles:true}))})
 await click('发送');expect(document.querySelector('textarea')!.value).toBe(draft)
 expect(f.requests.some(r=>r.url==='/api/v1/ai/turns')).toBe(false)
 expect(document.querySelector('[role=alert]')!.textContent).toContain('消息过长')
})
