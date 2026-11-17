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
