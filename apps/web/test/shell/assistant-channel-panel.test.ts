import {expect,test} from 'vitest'
import {createElement as h} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {AssistantChannelPanel} from '../../src/editors/assistant-channel-panel'

function client(snapshot:unknown){return {snapshot:()=>snapshot,subscribe:()=>()=>{},error:()=>'',start:async()=>{},invite:async()=>({inviteToken:'secret',expiresAt:''}),approve:async()=>{},remove:async()=>{},pause:async()=>{},send:async()=>{},cancel:async()=>{},refresh:async()=>{}}}
test('optional channel starts with an explicit add button and no invitation or history',()=>{
 const html=renderToStaticMarkup(h(AssistantChannelPanel,{client:client(null) as never,lang:'zh'}))
 expect(html).toContain('添加 Agent');expect(html).not.toContain('secret');expect(html).not.toContain('textarea')
})
test('shows scoped member identities, approvals and task state with escaped content',()=>{
 const snapshot={conversationId:'channel',fileId:'file',paused:false,sequence:1,members:[{membershipId:'member-one',displayName:'<img src=x>',kind:'custom',online:true,revoked:false}],applications:[{applicationId:'application-one',displayName:'Pending Agent',kind:'custom'}],tasks:[{taskId:'task-one',state:'unknown_outcome',instruction:'<script>alert(1)</script>',from:'office',to:'member-one'}]}
 const html=renderToStaticMarkup(h(AssistantChannelPanel,{client:client(snapshot) as never,lang:'zh'}))
 expect(html).toContain('Pending Agent');expect(html).toContain('application-one');expect(html).toContain('结果待核对')
 expect(html).toContain('&lt;img');expect(html).not.toContain('<img');expect(html).not.toContain('<script>')
 expect(html).toContain('暂停协作');expect(html).toContain('移除');expect(html).toContain('批准')
})

test('start is explicit and failures remain visible beside the add button',async()=>{
 const {act}=await import('react');const {createRoot}=await import('react-dom/client')
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 let attempts=0;const fake=client(null);fake.start=async()=>{attempts++;throw Error('private backend details')}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(AssistantChannelPanel,{client:fake as never,lang:'zh'})))
  expect(attempts).toBe(0)
  await act(async()=>host.querySelector('button')!.click())
  expect(attempts).toBe(1);expect(host.querySelector('[role="alert"]')?.textContent).toContain('未完成')
  expect(host.textContent).not.toContain('private backend details')
 } finally {await act(async()=>root.unmount());host.remove()}
})

test('completed tasks show the executing agent avatar and escaped result summary',()=>{
 const snapshot={conversationId:'channel',fileId:'file',paused:false,sequence:1,members:[{membershipId:'analyst',displayName:'Analyst',kind:'custom',online:true,revoked:false}],applications:[],tasks:[{taskId:'analysis',state:'succeeded',instruction:'Analyze metrics',from:'office',to:'analyst',summary:'Total 60 CNY <script>private</script>'}]}
 const html=renderToStaticMarkup(h(AssistantChannelPanel,{client:client(snapshot) as never,lang:'en'}))
 expect(html).toContain('Total 60 CNY &lt;script&gt;private&lt;/script&gt;')
 expect(html).toContain('assistant-channel-result');expect(html.match(/assistant-avatar-external/g)?.length).toBe(2)
 expect(html).not.toContain('<script>')
})

const stateLabels = {queued:'排队中',running:'执行中',waiting_peer:'等待协作方',cancel_requested:'正在取消',succeeded:'已完成',failed:'失败',cancelled:'已取消',unknown_outcome:'结果待核对'} as const
for (const [state,label] of Object.entries(stateLabels)) test(`task card exposes ${state} without fabricating a retry or cancellation`,()=>{
 const snapshot={conversationId:'channel',fileId:'file',paused:false,sequence:1,members:[],applications:[],tasks:[{taskId:'task',state,instruction:'task instruction',from:'office',to:'peer'}]}
 const html=renderToStaticMarkup(h(AssistantChannelPanel,{client:client(snapshot) as never,lang:'zh'}))
 expect(html).toContain(label)
 expect(html.includes('取消任务')).toBe(['queued','running','waiting_peer'].includes(state))
 expect(html).not.toContain('重新执行')
 expect(html).not.toContain('已停止')
 if(state!=='cancelled')expect(html).not.toContain('已取消')
 if(state!=='succeeded')expect(html).not.toContain('已完成')
})

test('cancel acknowledgement shows stopping until the authoritative terminal snapshot arrives',async()=>{
 const {act}=await import('react');const {createRoot}=await import('react-dom/client')
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 let snapshot={conversationId:'channel',fileId:'file',paused:false,sequence:1,members:[],applications:[],tasks:[{taskId:'task',state:'running',instruction:'task instruction',from:'office',to:'peer'}]}
 let notify=()=>{},cancels=0
 const fake={...client(snapshot),snapshot:()=>snapshot,subscribe:(listener:()=>void)=>{notify=listener;return()=>{notify=()=>{}}},cancel:async()=>{cancels++;snapshot={...snapshot,sequence:2,tasks:[{...snapshot.tasks[0],state:'cancel_requested'}]}}}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(AssistantChannelPanel,{client:fake as never,lang:'zh'})))
  await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='取消任务')!.click())
  expect(cancels).toBe(1);expect(host.textContent).toContain('正在取消');expect(host.textContent).not.toContain('已取消')
  expect([...host.querySelectorAll('button')].some(button=>button.textContent==='取消任务')).toBe(false)
  await act(async()=>{snapshot={...snapshot,sequence:3,tasks:[{...snapshot.tasks[0],state:'cancelled'}]};notify()})
  expect(host.textContent).toContain('已取消');expect(host.textContent).not.toContain('正在取消');expect(cancels).toBe(1)
 }finally{await act(async()=>root.unmount());host.remove()}
})
