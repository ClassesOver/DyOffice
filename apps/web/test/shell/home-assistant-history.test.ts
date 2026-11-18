import {expect,it} from 'vitest'
import {prepareHomeHistory,type HomeMessage} from '../../src/shell/home-assistant-history'
import {serializeTurnRequest} from '../../../../packages/browser-host/src/ai-transport'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant'
const measure=(messages:HomeMessage[])=>new TextEncoder().encode(serializeTurnRequest('0'.repeat(36),'model',{system:'system',messages,tools:[]})).length
it('counts complete escaped UTF8 JSON at exact limit, not characters or text alone',()=>{
 const previous:HomeMessage[]=[{role:'user',text:'old'},{role:'assistant',text:'界😀"\\\n'}],latest={role:'user' as const,text:'新'}
 const exact=measure([...previous,latest])
 expect(prepareHomeHistory(previous,latest.text,measure,exact).truncated).toBe(false)
 expect(prepareHomeHistory(previous,latest.text,measure,exact-1)).toEqual({messages:[latest],truncated:true})
 expect(()=>prepareHomeHistory([],latest.text,measure,measure([latest])-1)).toThrow()
})
it('does not pair a failed user-only interaction with the following answered turn',()=>{
 const previous:HomeMessage[]=[{role:'user',text:'failed'},{role:'user',text:'answered'},{role:'assistant',text:'partial'}]
 const latest={role:'user' as const,text:'next'},expected=[...previous.slice(1),latest]
 expect(prepareHomeHistory(previous,latest.text,measure,measure(expected)).messages).toEqual(expected)
})
it('drops an overlong historical assistant group and keeps the latest input',()=>{
 const previous:HomeMessage[]=[{role:'user',text:'old'},{role:'assistant',text:'界'.repeat(90000)}]
 expect(prepareHomeHistory(previous,'next',measure)).toEqual({messages:[{role:'user',text:'next'}],truncated:true})
 expect(()=>prepareHomeHistory([],'界'.repeat(10923),measure)).toThrow()
 expect(()=>prepareHomeHistory([],'x'.repeat(32768),measure)).not.toThrow()
})
it('retains whole groups under the count cap including interrupted answers',()=>{
 const previous:HomeMessage[]=Array.from({length:11},(_,i)=>[{role:'user' as const,text:'q'+i},{role:'assistant' as const,text:'partial'+i}]).flat()
 const prepared=prepareHomeHistory(previous,'new',measure)
 expect(prepared.messages).toEqual([...previous.slice(2),{role:'user',text:'new'}]);expect(prepared.truncated).toBe(true)
})
it('factory measurement equals the actual normalized dispatched wire bytes',async()=>{
 let wire=''
 const client=await createAssistantClient({request:async<T,>()=>({entries:[{id:'m',label:'Model'}],defaultId:'m'}) as T,csrfToken:'a'.repeat(43),fetchImpl:async(_url,init)=>{wire=init!.body as string;return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})}})
 const input={system:'界😀',messages:[{role:'user' as const,text:'"\\\n界'}],tools:[]}
 const measured=client.requestBytes(input);client.transport.beginRun?.()
 await new Promise<void>(resolve=>client.transport.stream(input,{onDelta(){},onToolCall(){},onError(error){throw Error(error)},onDone:resolve}))
 expect(measured).toBe(new TextEncoder().encode(wire).length);client.dispose()
})
it('enforces the default 512KiB full-envelope boundary at minus one, equal and plus one byte',()=>{
 const previous:HomeMessage[]=[{role:'user',text:'a'},{role:'assistant',text:''},{role:'user',text:'b'},{role:'assistant',text:''}]
 const latest={role:'user' as const,text:'new'}
 const payload=512*1024-measure([...previous,latest])
 previous[1]!.text='x'.repeat(Math.floor(payload/2));previous[3]!.text='y'.repeat(payload-Math.floor(payload/2))
 expect(measure([...previous,latest])).toBe(512*1024)
 expect(prepareHomeHistory(previous,latest.text,measure).truncated).toBe(false)
 previous[3]!.text=previous[3]!.text.slice(1)
 expect(measure([...previous,latest])).toBe(512*1024-1)
 expect(prepareHomeHistory(previous,latest.text,measure).truncated).toBe(false)
 previous[3]!.text+='zz'
 expect(measure([...previous,latest])).toBe(512*1024+1)
 expect(prepareHomeHistory(previous,latest.text,measure).messages).toEqual([...previous.slice(2),latest])
})
