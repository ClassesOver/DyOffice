import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,expect,test,vi} from 'vitest'
import {createCodingSkill} from '../../../../packages/agent-core/src/coding-skill'
import {createAssistantWorkspace} from '../../../../packages/browser-host/src/assistant-workspace'
import {SharedEditorAssistant} from '../../src/editors/shared-editor-assistant'

const roots:ReturnType<typeof createRoot>[]=[]
afterEach(async()=>{await act(async()=>roots.splice(0).forEach(root=>root.unmount()));document.body.replaceChildren()})

function fixture(delegate=false){
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
 const run=vi.fn(async()=>({agent:{id:'codex',name:'Codex',origin:'builtin' as const},summary:'done',output:'checked'}))
 const workspace=createAssistantWorkspace({agents:[{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']}],coding:{run,snapshot:()=>[],subscribe:()=>()=>{},cancel:vi.fn()}})
 const stream=vi.fn((_input,callbacks)=>{
  if(delegate&&stream.mock.calls.length===1)callbacks.onToolCall({id:'call-1',name:'delegate_agent_task',input:{instruction:'检查代码'}})
  else callbacks.onDelta(delegate?'检查完成':'流式回答')
  callbacks.onDone();return {cancel(){}}
 })
 const assistant={available:true,transport:{beginRun:()=>false,stream},extraSkills:delegate?[createCodingSkill({run})]:[],selected:()=> 'model-a',workspace:{...workspace, panel:h('div'),isOffice:workspace.isOffice,submit:workspace.submit},api:{skillsList:async()=>[]},modelPicker:h('button',null,'模型选择')} as never
 return {host,root,assistant,run,stream,workspace}
}

test('Office messages stream through the shared assistant transport',async()=>{
 const f=fixture();await act(async()=>f.root.render(h(SharedEditorAssistant,{assistant:f.assistant,lang:'zh'})))
 const input=f.host.querySelector('textarea')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'总结文档');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await act(async()=>f.host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click())
 expect(f.stream).toHaveBeenCalledOnce();expect(f.host.textContent).toContain('流式回答')
})
test('PDF keeps partial text visible and explains a model output limit',async()=>{
 const f=fixture()
 const onLocalEditDone=vi.fn()
 f.stream.mockImplementation((_input,callbacks)=>{
  callbacks.onDelta('这是未完成的摘要')
  callbacks.onStopReason?.('max_tokens')
  callbacks.onDone()
  return {cancel(){}}
 })
 await act(async()=>f.root.render(h(SharedEditorAssistant,{assistant:f.assistant,lang:'zh',onLocalEditDone})))
 const input=f.host.querySelector('textarea')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'总结 PDF');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await act(async()=>f.host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click())
 expect(f.host.textContent).toContain('这是未完成的摘要')
 expect(f.host.querySelector('[role="alert"]')?.textContent).toMatch(/长度上限.*分段/)
 expect(f.stream).toHaveBeenCalledOnce()
 expect(onLocalEditDone).not.toHaveBeenCalled()
})

test.each([false,true])('a completed Harness task resumes when the PDF becomes ready without another task event (stale tasks: %s)',async stale=>{
 const f=fixture();let ready=false
 const checkpoint={chatTurnId:'existing-turn',userIndex:0,turns:0,executedCalls:[],messages:[
  {role:'user',text:'更新 PDF'},{role:'assistant',text:'',toolCalls:[{id:'task-call',name:'delegate_agent_task',input:{instruction:'检查代码'}}]},
 ]}
 const resume=vi.fn(async(id:string)=>{
  if(id==='expired')throw Error('Harness continuation unavailable')
  return {modelId:'model-a',revision:'rev-a',checkpoint,result:{id:'task-call',name:'delegate_agent_task',output:'检查结果'}}
 })
 const fileChat={resume:vi.fn(async()=>({finish:vi.fn(),text:vi.fn()}))}
 const tasks=[
  ...(stale?[{id:'removed-1',continuationModelId:'old-model'},{id:'removed-2',continuationModelId:'old-model'},{id:'expired',continuationModelId:'model-a'}]:[]),
  {id:'task',continuationModelId:'model-a'},
 ]
 const assistant={...(f.assistant as object),catalog:{entries:[{id:'model-a'}]},fileChat,
  coding:{snapshot:()=>tasks,subscribe:()=>()=>{},resume},continuationRevision:()=>ready?'rev-a':undefined,
 } as never
 const render=(context:string)=>act(async()=>f.root.render(h(SharedEditorAssistant,{assistant,lang:'zh',context})))
 await render('loading');expect(resume).not.toHaveBeenCalled()
 ready=true;await render('ready')
 expect(f.stream).toHaveBeenCalledOnce()
 expect(f.stream.mock.calls[0]![0].messages.at(-1)).toEqual({role:'tool',results:[{id:'task-call',name:'delegate_agent_task',output:'检查结果'}]})
 expect(resume.mock.calls.map(([id])=>id)).toEqual(stale?['expired','task']:['task'])
 expect(fileChat.resume).toHaveBeenCalledOnce()
})

test.each([false,true])('an interrupted Office turn restores the draft only before tool execution (tool started: %s)',async mutated=>{
 const f=fixture()
 const executeTool=vi.fn(async()=>({output:'Changed PDF',summary:'Edit',mutated:true}))
 const skill={id:'pdf-edit',systemPrompt:'Edit PDF',tools:[{name:'edit_text',description:'Edit',inputSchema:{type:'object'}}],executeTool}
 const assistant={...(f.assistant as object),extraSkills:[skill]} as never
 f.stream.mockImplementation((_input,callbacks)=>{
  if(mutated&&f.stream.mock.calls.length===1)callbacks.onToolCall({id:'edit',name:'edit_text',input:{}})
  else if(f.stream.mock.calls.length===(mutated?2:1))callbacks.onError('AI stream unavailable')
  else callbacks.onDelta('连接已恢复')
  callbacks.onDone()
  return {cancel(){}}
 })
 await act(async()=>f.root.render(h(SharedEditorAssistant,{assistant,lang:'zh'})))
 const input=f.host.querySelector('textarea')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'更新 PDF');input.dispatchEvent(new Event('input',{bubbles:true}))})
 const send=()=>act(async()=>f.host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click())
 await send()
 expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('AI stream unavailable')
 expect(executeTool).toHaveBeenCalledTimes(mutated?1:0)
 expect(input.value).toBe(mutated?'':'更新 PDF')
 expect(f.stream).toHaveBeenCalledTimes(mutated?2:1)
 if(!mutated){
  await send()
  expect(f.host.textContent).toContain('连接已恢复')
  expect(f.host.querySelector('[role="alert"]')).toBeNull()
  const messages=f.stream.mock.calls.at(-1)![0].messages
  expect(messages.filter((message:{role:string;text:string})=>message.role==='user'&&message.text==='更新 PDF')).toHaveLength(1)
 }
})

test('closing the shared assistant cancels an in-flight tool before its result can continue the conversation',async()=>{
 const f=fixture();let signal:AbortSignal|undefined,release!:(value:any)=>void
 f.stream.mockImplementation((_input,callbacks)=>{callbacks.onToolCall({id:'image',name:'generate_image',input:{prompt:'Draw'}});callbacks.onDone();return {cancel(){}}})
 const skill={id:'pending-media',systemPrompt:'Generate images',tools:[{name:'generate_image',description:'Generate',inputSchema:{type:'object'}}],executeTool:vi.fn((_call,activeSignal)=>{signal=activeSignal;return new Promise(resolve=>release=resolve)})}
 const assistant={...(f.assistant as object),extraSkills:[skill]} as never
 await act(async()=>f.root.render(h(SharedEditorAssistant,{assistant,lang:'zh'})))
 const input=f.host.querySelector('textarea')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'生成图片');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await act(async()=>f.host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click())
 await vi.waitFor(()=>expect(skill.executeTool).toHaveBeenCalledOnce())
 await act(async()=>f.root.render(null))
 expect(signal?.aborted).toBe(true)
 await act(async()=>release({output:'Late image',summary:'Image'}))
 expect(f.stream).toHaveBeenCalledOnce()
})

test('Office automatically delegates coding to a harness without an execution picker',async()=>{
 const f=fixture(true);await act(async()=>f.root.render(h(SharedEditorAssistant,{assistant:f.assistant,lang:'zh'})))
 expect(f.host.querySelector('.assistant-execution-picker,.assistant-execution-menu,[data-select-target^="harness:"]')).toBeNull()
 const input=f.host.querySelector('textarea')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'检查代码');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await act(async()=>f.host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click())
 await vi.waitFor(()=>expect(f.run).toHaveBeenCalledOnce())
 await vi.waitFor(()=>expect(f.stream).toHaveBeenCalledTimes(2))
 expect(f.stream).toHaveBeenCalledTimes(2)
 expect(f.stream.mock.calls[0]?.[0].messages.at(-1)?.text).toContain('检查代码')
 expect(f.run).toHaveBeenCalledWith({instruction:'检查代码'},expect.any(AbortSignal))
 expect(f.host.textContent).toContain('检查完成')
})

test.each([false,true])('shared assistant derives PDF permissions from the offered source skill (writer: %s)',async writer=>{
 const f=fixture()
 const sourceSkill={id:'pdf-test',systemPrompt:writer?'Use edit_text to edit this PDF; only successful saves confirm mutations.':'This PDF is read-only. Editing and saving are unavailable.',tools:[{name:writer?'edit_text':'read_pages',description:'PDF tool',inputSchema:{type:'object'}}],executeTool:vi.fn(async()=>({output:'Confirmed',summary:'PDF tool',mutated:writer}))}
 const assistant={...(f.assistant as object),extraSkills:[sourceSkill]} as never
 await act(async()=>f.root.render(h(SharedEditorAssistant,{assistant,lang:'zh'})))
 const input=f.host.querySelector('textarea')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'处理文档');input.dispatchEvent(new Event('input',{bubbles:true}))})
 await act(async()=>f.host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click())
 expect(f.stream).toHaveBeenCalledOnce()
 const request=f.stream.mock.calls[0]![0]
 expect(request.system).toMatch(/only.*(provided|offered).*tools/i)
 expect(request.system).toMatch(/(edit|sav).*successful tool result/i)
 expect(request.tools.map((tool:{name:string})=>tool.name)).toEqual([writer?'edit_text':'read_pages'])
 if(writer)expect(request.system).not.toMatch(/You are read-only|never claim to edit/)
 else expect(request.system).toContain('Editing and saving are unavailable.')
})

test('assistant dock collapse preserves the draft and returns focus when reopened',async()=>{
 const f=fixture();await act(async()=>f.root.render(h(SharedEditorAssistant,{assistant:f.assistant,lang:'zh'})))
 const input=f.host.querySelector('textarea')!
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'保留这份草稿');input.dispatchEvent(new Event('input',{bubbles:true}))})
 const collapse=f.host.querySelector<HTMLButtonElement>('[aria-label="收起 AI 助手"]')!
 expect(collapse).not.toBeNull()
 await act(async()=>collapse.click())
 expect(f.host.querySelector('.shared-editor-assistant')?.hasAttribute('hidden')).toBe(true)
 const expand=f.host.querySelector<HTMLButtonElement>('[aria-label="展开 AI 助手"]')!
 expect(document.activeElement).toBe(expand)
 await act(async()=>expand.click())
 expect(input.value).toBe('保留这份草稿');expect(document.activeElement).toBe(input)
 expect(f.stream).not.toHaveBeenCalled()
})
