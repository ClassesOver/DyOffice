import {expect,test} from 'vitest'
import {createElement as h,act} from 'react'
import {createRoot} from 'react-dom/client'
import {AssistantChannelsPage} from '../../src/shell/AssistantChannelsPage'
import {BackgroundTasksPage} from '../../src/shell/BackgroundTasksPage'

test('empty workspace creates a channel and direct DSH token without file selection or editor connection',async()=>{
 const calls:{path:string;body:unknown}[]=[]
 const request=async(path:string,_method?:string,body?:unknown)=>{
  calls.push({path,body})
  if(path.endsWith('/dsh-token'))return {memberToken:'direct-dsh-token',expiresAt:new Date(Date.now()+300000).toISOString()}
  if(path.endsWith('/channels')&&body)return {conversationId:'one',fileId:null}
  if(path.endsWith('/channels'))return {items:[],nextCursor:null}
  return {conversationId:'one',fileId:null,paused:false,members:[],applications:[],tasks:[]}
 }
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(AssistantChannelsPage,{request:request as never,onOpenDocument:async()=>{}})))
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='创建频道')!.click())
  const toggle=host.querySelector<HTMLInputElement>('input[type=checkbox]')!
  await act(async()=>toggle.click())
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='生成 DSH 授权 Token')!.click())
  expect(host.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe('direct-dsh-token')
  expect(calls.find(c=>c.path.endsWith('/dsh-token'))?.body).toMatchObject({allowCreate:true})
  expect(calls.some(c=>c.path.includes('/connect'))).toBe(false)
  expect((calls.find(c=>c.path.endsWith('/channels')&&c.body)?.body as {fileId?:string}).fileId).toBeUndefined()
 }finally{await act(async()=>root.unmount());host.remove()}
})
test('home task page shows persisted version and result without opening a document',async()=>{
 const task={taskId:'task',conversationId:'channel',fileId:'file',fileName:'预算.docx',createdAt:'2026-11-19T00:00:00Z',state:'succeeded',savedRevision:'saved-version',instruction:'预算',summary:'42 万元'}
 const request=async(path:string)=>path.endsWith('/background-tasks')?{items:[task],nextCursor:null}:task
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(BackgroundTasksPage,{request:request as never,onOpenDocument:async()=>{},onOpenChannel:()=>{}})))
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='查看结果')!.click())
  expect(host.textContent).toContain('42 万元');expect(host.textContent).toContain('saved-version')
 }finally{await act(async()=>root.unmount());host.remove()}
})
test('channel page uses direct authorization and enables four-format background reading without approval',async()=>{
 const calls:{path:string;body:unknown}[]=[]
 const snapshot={conversationId:'one',fileId:null,paused:false,backgroundAvailable:true,backgroundEnabled:false,members:[],applications:[{applicationId:'application',displayName:'DSH laptop',kind:'dsh'}],tasks:[]}
 const request=async(path:string,_method?:string,body?:unknown)=>{
  calls.push({path,body})
  if(path==='/api/v1/files?limit=100')return {files:[{id:'doc',name:'预算.docx',format:'docx'},{id:'sheet',name:'other.xlsx',format:'xlsx'},{id:'slides',name:'deck.pptx',format:'pptx'},{id:'pdf',name:'report.pdf',format:'pdf'},{id:'legacy',name:'legacy.doc',format:'doc'}]}
  if(path.endsWith('/channels'))return {items:[snapshot],nextCursor:null}
  return snapshot
 }
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(AssistantChannelsPage,{request:request as never,initialChannelId:'one',onOpenDocument:async()=>{}})))
  expect(host.textContent).not.toContain('DSH laptop')
  expect(host.textContent).not.toContain('批准连接')
  expect(host.textContent).toContain('生成 DSH 授权 Token')
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='选择授权文档')!.click())
  const select=host.querySelector<HTMLSelectElement>('select[aria-label="授权的文档"]')!
  expect(select.textContent).toContain('预算.docx');expect(select.textContent).toContain('other.xlsx');expect(select.textContent).toContain('deck.pptx');expect(select.textContent).toContain('report.pdf');expect(select.textContent).not.toContain('legacy.doc')
  await act(async()=>{select.value='doc';select.dispatchEvent(new Event('change',{bubbles:true}))})
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='允许后台读取已保存版本')!.click())
  expect(calls.find(c=>c.path.endsWith('/background'))?.body).toEqual({enabled:true,fileId:'doc'})
  expect(calls.some(c=>c.path.includes('/connect'))).toBe(false)
 }finally{await act(async()=>root.unmount());host.remove()}
})
test('task detail disappears when access is revoked and refresh fails',async()=>{
 const task={taskId:'task',conversationId:'channel',fileId:'file',fileName:'预算.docx',createdAt:'2026-11-19T00:00:00Z',state:'succeeded',savedRevision:'saved-version',instruction:'预算',summary:'PRIVATE RESULT'}
 let revoked=false
 const request=async(path:string)=>{
  if(path.endsWith('/background-tasks'))return {items:revoked?[]:[task],nextCursor:null}
  if(revoked)throw Error('404')
  return task
 }
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(BackgroundTasksPage,{request:request as never,onOpenDocument:async()=>{},onOpenChannel:()=>{}})))
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='查看结果')!.click())
  expect(host.textContent).toContain('PRIVATE RESULT');revoked=true
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='刷新')!.click())
  expect(host.textContent).not.toContain('PRIVATE RESULT')
 }finally{await act(async()=>root.unmount());host.remove()}
})
test('changing accounts clears pending task actions and rejects the previous account response',async()=>{
 const task={taskId:'task',conversationId:'channel',fileId:'file',fileName:'private.docx',createdAt:'2026-11-19T00:00:00Z',state:'succeeded',savedRevision:'saved-version',instruction:'预算',summary:'OLD ACCOUNT RESULT'}
 let release:(value:unknown)=>void=()=>{}
 const pending=new Promise(resolve=>{release=resolve})
 const oldRequest=async(path:string)=>path.endsWith('/background-tasks')?{items:[task],nextCursor:null}:pending
 const newRequest=async()=>({items:[],nextCursor:null})
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(BackgroundTasksPage,{request:oldRequest as never,onOpenDocument:async()=>{},onOpenChannel:()=>{}})))
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='查看结果')!.click())
  await act(async()=>root.render(h(BackgroundTasksPage,{request:newRequest as never,onOpenDocument:async()=>{},onOpenChannel:()=>{}})))
  expect([...host.querySelectorAll('button')].find(b=>b.textContent==='刷新')!.disabled).toBe(false)
  await act(async()=>{release(task);await pending})
  expect(host.textContent).not.toContain('OLD ACCOUNT RESULT');expect(host.textContent).not.toContain('private.docx')
 }finally{await act(async()=>root.unmount());host.remove()}
})
test('home task list displays durable states and cancels through the owner channel action',async()=>{
 const states=['queued','running','succeeded','failed']
 const tasks=states.map((state,index)=>({taskId:'task-'+index,conversationId:'channel',fileId:'file',fileName:'预算-'+index+'.docx',createdAt:'2026-11-19T00:00:00Z',state,savedRevision:'saved-version',instruction:'预算',summary:state==='succeeded'?'42万元':null}))
 const calls:{path:string;body:unknown}[]=[]
 const request=async(path:string,_method?:string,body?:unknown)=>{
  calls.push({path,body})
  if(path.endsWith('/actions')){tasks[0]!.state='cancelled';return {taskId:'task-0'}}
  if(path.endsWith('/background-tasks'))return {items:tasks,nextCursor:null}
  return tasks[0]
 }
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(BackgroundTasksPage,{request:request as never,onOpenDocument:async()=>{},onOpenChannel:()=>{}})))
  for(const label of ['排队中','执行中','已完成','失败'])expect(host.querySelector('.background-task-list')?.textContent).toContain(label)
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='查看结果')!.click())
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='取消任务')!.click())
  expect(calls.find(c=>c.path.endsWith('/actions'))?.body).toMatchObject({conversationId:'channel',to:'office',action:{kind:'cancel',taskId:'task-0'}})
  expect(host.querySelector('.background-task-detail')?.textContent).toContain('已取消')
 }finally{await act(async()=>root.unmount());host.remove()}
})
for(const operation of ['pause','dsh-token'])test('switching channels ignores a delayed '+operation+' response from the previous channel',async()=>{
 const snapshot=(id:string)=>({conversationId:id,fileId:null,paused:false,backgroundAvailable:true,members:[],applications:[],tasks:[]})
 let release:(value:unknown)=>void=()=>{}
 const pending=new Promise(resolve=>{release=resolve})
 const request=async(path:string,method?:string)=>{
  if(path.endsWith('/channels'))return {items:[{...snapshot('aaa'),fileName:'Channel A'},{...snapshot('bbb'),fileName:'Channel B'}],nextCursor:null}
  if(method==='POST'&&path.endsWith('/'+operation))return pending
  return snapshot(path.endsWith('/aaa')?'aaa':'bbb')
 }
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(AssistantChannelsPage,{request:request as never,initialChannelId:'aaa',onOpenDocument:async()=>{}})))
  if(operation==='dsh-token')await act(async()=>host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent===(operation==='pause'?'暂停协作':'生成 DSH 授权 Token'))!.click())
  await act(async()=>[...host.querySelectorAll('nav button')].find(b=>b.textContent?.startsWith('Channel B'))!.dispatchEvent(new MouseEvent('click',{bubbles:true})))
  expect(host.querySelector('article code')?.textContent).toBe('bbb')
  await act(async()=>{release(operation==='pause'?{}:{memberToken:'OLD CHANNEL TOKEN',expiresAt:new Date(Date.now()+10000).toISOString()});await pending})
  expect(host.querySelector('article code')?.textContent).toBe('bbb')
  expect(host.querySelector('input[readonly]')).toBeNull()
 }finally{release({});await act(async()=>root.unmount());host.remove()}
})
test('refreshing active tasks preserves the pages the user has loaded',async()=>{
 const task=(id:string)=>({taskId:id,conversationId:'channel',fileId:'file',fileName:id+'.docx',createdAt:'2026-11-19T00:00:00Z',state:'queued',savedRevision:'version',instruction:'read',summary:null})
 const request=async(path:string)=>path.includes('?after=')?{items:[task('second-page')],nextCursor:null}:{items:[task('first-page')],nextCursor:'first-page'}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(BackgroundTasksPage,{request:request as never,onOpenDocument:async()=>{},onOpenChannel:()=>{}})))
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='加载更多任务')!.click())
  expect(host.textContent).toContain('second-page.docx')
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='刷新')!.click())
  expect(host.textContent).toContain('second-page.docx')
 }finally{await act(async()=>root.unmount());host.remove()}
})

test('task loading and filtered empty states are distinct and detail receives focus',async()=>{
 let release:(value:unknown)=>void=()=>{}
 const pending=new Promise(resolve=>{release=resolve})
 const task={taskId:'task',conversationId:'channel',fileId:'file',fileName:'预算.docx',createdAt:'2026-11-19T00:00:00Z',state:'succeeded',savedRevision:'version',instruction:'read',summary:'42万元'}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 const request=async(path:string)=>path.endsWith('/background-tasks')?pending:task
 try{
  await act(async()=>root.render(h(BackgroundTasksPage,{request:request as never,onOpenDocument:async()=>{},onOpenChannel:()=>{}})))
  expect(host.textContent).toContain('正在加载后台任务');expect(host.textContent).not.toContain('暂无后台任务')
  await act(async()=>{release({items:[task],nextCursor:null});await pending})
  const select=host.querySelector('select')!
  await act(async()=>{select.value='running';select.dispatchEvent(new Event('change',{bubbles:true}))})
  expect(host.textContent).toContain('没有符合当前状态的任务')
  await act(async()=>{select.value='all';select.dispatchEvent(new Event('change',{bubbles:true}))})
  const trigger=[...host.querySelectorAll('button')].find(b=>b.textContent==='查看结果')!
  await act(async()=>trigger.click())
  const detail=host.querySelector('.background-task-detail')!
  expect(document.activeElement).toBe(detail)
  expect(detail.compareDocumentPosition(host.querySelector('.background-task-list')!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='关闭详情')!.click())
  expect(document.activeElement).toBe(trigger)
 }finally{release({items:[],nextCursor:null});await act(async()=>root.unmount());host.remove()}
})
test('failed initial task fetch shows retry feedback without claiming the queue is empty',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(h(BackgroundTasksPage,{request:(async()=>{throw Error('offline')}) as never,onOpenDocument:async()=>{},onOpenChannel:()=>{}})))
  expect(host.textContent).toContain('后台任务暂时无法加载');expect(host.textContent).not.toContain('暂无后台任务')
 }finally{await act(async()=>root.unmount());host.remove()}
})
