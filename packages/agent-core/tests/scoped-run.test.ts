import {expect,it} from 'vitest'
import {AgentLoop} from '../src/loop'
it('scoped Office reads isolate native history, context, events and mutating tools',async()=>{
 let contexts=0,events=0,rounds=0
 const requests:any[]=[]
 const loop=new AgentLoop({transport:{stream(request,callbacks){requests.push(request);queueMicrotask(()=>{
  if(rounds++===0)callbacks.onToolCall({id:'read',name:'read_blocks',input:{}})
  else callbacks.onDelta('Peer findings')
  callbacks.onDone()
 });return {cancel(){}}}},skill:{id:'native',systemPrompt:'native private prompt',tools:[{name:'read_blocks',description:'read',inputSchema:{}},{name:'write',description:'write',inputSchema:{}}],buildContext(){contexts++;return 'private draft'},executeTool(call){expect(call.name).toBe('read_blocks');return {output:'Document text',summary:'Read'}}},events:{onText(){events++},onToolStart(){events++},onDone(){events++}}})
 loop.restore([{role:'user',text:'private history'},{role:'assistant',text:'private response'}])
 const before=JSON.stringify(loop.messages)
 const result=await loop.runScoped('Read document',{allowedTools:['read_blocks']})
 expect(result.text).toBe('Peer findings');expect(contexts).toBe(0);expect(events).toBe(0)
 expect(JSON.stringify(loop.messages)).toBe(before)
 expect(requests[0].tools.map((tool:any)=>tool.name)).toEqual(['read_blocks'])
 expect(JSON.stringify(requests)).not.toContain('private history');expect(JSON.stringify(requests)).not.toContain('private draft')
})

it('scoped cancellation restores native state and aborts only its active request', async () => {
  let cancelCount = 0
  const loop = new AgentLoop({
    transport: { stream(_request, callbacks) { return { cancel() { cancelCount++; queueMicrotask(() => callbacks.onDone()) } } } },
    skill: { id: 'native', systemPrompt: '', tools: [], executeTool() { return { output: '', summary: '' } } },
  })
  loop.restore([{ role: 'user', text: 'keep' }, { role: 'assistant', text: 'kept' }])
  const before = JSON.stringify(loop.messages)
  const controller = new AbortController()
  const pending = loop.runScoped('Read', { signal: controller.signal, allowedTools: [] })
  await new Promise(resolve => setTimeout(resolve, 0))
  controller.abort()
  expect((await pending).cancelled).toBe(true)
  expect(cancelCount).toBe(1)
  expect(loop.busy).toBe(false)
  expect(JSON.stringify(loop.messages)).toBe(before)
})

it('reset during scoped execution immediately restores native options for the next run', async () => {
  const requests: any[] = []
  const loop = new AgentLoop({
    transport: { stream(request, callbacks) { requests.push(request); return { cancel() { queueMicrotask(() => callbacks.onDone()) } } } },
    skill: { id: 'native', systemPrompt: 'native system', tools: [], buildContext: () => 'native context', executeTool() { return { output: '', summary: '' } } },
    formatUserMessage: (instruction, context) => `${instruction} ${context} native formatter`,
  })
  const scoped = loop.runScoped('Read', { allowedTools: [] })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(JSON.stringify(requests[0])).not.toContain('native formatter')
  loop.reset()
  loop.run('New user chat')
  await expect(scoped).rejects.toThrow('editor changed')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(requests[1].system).toContain('native system')
  expect(JSON.stringify(loop.messages)).toContain('New user chat')
  loop.reset()
})

it('preserves a model change for the next native run after restoring its transcript', async () => {
  let changed = true
  const requests: any[] = []
  const loop = new AgentLoop({
    transport: {
      beginRun() { const result = changed; changed = false; return result },
      stream(request, callbacks) { requests.push(request); queueMicrotask(() => { callbacks.onDelta('Done'); callbacks.onDone() }); return { cancel() {} } },
    },
    skill: { id: 'native', systemPrompt: '', tools: [], executeTool() { return { output: '', summary: '' } } },
  })
  loop.restore([{ role: 'user', text: 'previous model history' }, { role: 'assistant', text: 'previous model reply' }])
  await loop.runScoped('Peer read', { allowedTools: [] })
  loop.run('New model question')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(JSON.stringify(requests[1])).not.toContain('previous model history')
  expect(JSON.stringify(requests[1])).not.toContain('Peer read')
})

it('composed scoped execution routes through the owning skill without native selection context', async () => {
  const {composeSkills}=await import('../src/skill')
  let turn=0,nativeCalls=0,scopedCalls=0
  const requests:any[]=[]
  const skill=composeSkills('composed','', [{
    id:'document',systemPrompt:'',tools:[{name:'read_blocks',description:'',inputSchema:{}}],
    executeTool(){nativeCalls++;return {output:'private selection',summary:'native'}},
    executeScopedTool(){scopedCalls++;return {output:'document content',summary:'read'}},
  }])
  const loop=new AgentLoop({skill,transport:{stream(request,callbacks){requests.push(request);queueMicrotask(()=>{if(turn++===0)callbacks.onToolCall({id:'read',name:'read_blocks',input:{}});else callbacks.onDelta('Done');callbacks.onDone()});return {cancel(){}}}}})
  await loop.runScoped('Read',{allowedTools:['read_blocks']})
  expect(scopedCalls).toBe(1)
  expect(nativeCalls).toBe(0)
  expect(JSON.stringify(requests)).not.toContain('private selection')
  expect(JSON.stringify(requests)).toContain('document content')
})

it('document handoffs continue the visible Office conversation and retain the document tool boundary',async()=>{
 const requests:any[]=[],visible:string[]=[]
 const loop=new AgentLoop({skill:{id:'native',systemPrompt:'Office instructions',tools:['read_blocks','delegate'].map(name=>({name,description:'',inputSchema:{}})),buildContext:()=>'Current selection',executeTool:()=>({output:'',summary:''})},
   transport:{stream(request,callbacks){requests.push(request);queueMicrotask(()=>{callbacks.onDelta('Office response');callbacks.onDone()});return {cancel(){}}}},
   events:{onText:text=>visible.push(text)}})
 const options={signal:new AbortController().signal,check:()=>true,tools:['read_blocks'],onTool:()=>{},onText:()=>{}}
 await loop.runDocumentHandoff('First request',{...options,skill:{name:'events',content:'Include event owner'}})
 expect(JSON.stringify(requests[0].messages)).toContain('Include event owner')
 expect(JSON.stringify(requests[0].system)).not.toContain('Include event owner')
 await loop.runDocumentHandoff('Follow up',options)
 expect(visible).toEqual(['Office response','Office response'])
 expect(JSON.stringify(requests[1].messages)).toContain('First request')
 expect(JSON.stringify(requests[1].messages)).not.toContain('Include event owner')
 expect(JSON.stringify(requests[1].messages)).toContain('Current selection')
 expect(requests[1].tools.map((x:any)=>x.name)).toEqual(['read_blocks'])
 expect(loop.messages.at(-1)).toMatchObject({role:'assistant',text:'Office response'})
})

it('publishes only visible foreground messages and restores completed remote replies without executing them',async()=>{
 const {bindFileChat}=await import('../src/file-chat')
 const starts:string[]=[],replies:string[]=[],requests:any[]=[]
 const transport={stream:(request:any,cb:any)=>{requests.push(request);queueMicrotask(()=>{cb.onDelta('Visible answer');cb.onDone()});return {cancel(){}}}}
 const unbind=bindFileChat(transport,({text})=>{
   starts.push(text)
   return {history:async()=>[{role:'user',text:'Remote question'},{role:'assistant',text:'Remote answer'}],
     text(){},finish(text){replies.push(text)}}
 })
 const loop=new AgentLoop({transport,skill:{id:'office',systemPrompt:'',tools:[],buildContext:()=>'private selection',executeTool(){throw Error()}}})
 try{
   loop.run('instruction with hidden skill',[],undefined,{text:'Displayed question'})
   await new Promise(resolve=>setTimeout(resolve,0))
   expect(starts).toEqual(['Displayed question'])
   expect(replies).toEqual(['Visible answer'])
   expect(requests[0].messages).toContainEqual({role:'assistant',text:'Remote answer'})
   expect(requests).toHaveLength(1)
   await loop.runScoped('private peer task',{allowedTools:[]})
   expect(starts).toHaveLength(1)
   expect(replies).toHaveLength(1)
 }finally{unbind()}
})
