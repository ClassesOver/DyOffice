import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {AssistantChannelsPage} from '../../src/shell/AssistantChannelsPage'
import {BackgroundTasksPage} from '../../src/shell/BackgroundTasksPage'
import type {WorkspaceRequest} from '../../src/shell/background-workspace'
const channelId='bc9c6aac-d786-4287-8238-3da680b979d2'
const channel={conversationId:channelId,fileId:null as string|null,paused:false,backgroundAvailable:true,backgroundEnabled:false,members:[] as {kind:string;membershipId:string;displayName:string;expiresAt:string;revoked:boolean}[],tasks:[]}
const task={taskId:'task',conversationId:channelId,fileId:'file',fileName:'预算.docx',createdAt:'2026-11-19T00:00:00Z',state:'succeeded',savedRevision:'a214adf2-e38a-4dbe-8db8-914fb881d9ab',instruction:'列出预算总额和单位',summary:'已保存版本预算为42万元'}
const stress=new URLSearchParams(window.location.search).has('stress')
let created=stress
let failTaskList=new URLSearchParams(window.location.search).has('failure')
const request:WorkspaceRequest=async(path,method,body)=>{
 if(path.includes('/connect'))throw Error('Editor connection must not be created')
 if(path.endsWith('/channels')&&method==='POST'){created=true;return channel as never}
 if(path.endsWith('/channels'))return {items:created?(stress?Array.from({length:30},(_,i)=>({...channel,conversationId:i===0?channelId:'channel-'+i,fileName:'长名称频道-'+i+'-预算'.repeat(12)})):[channel]):[],nextCursor:null} as never
 if(path.endsWith('/dsh-token')&&method==='POST'){
  const expiresAt=new Date(Date.now()+300000).toISOString(),membershipId='member'
  channel.members.push({kind:'dsh',membershipId,displayName:'DSH 验证实例',expiresAt,revoked:false})
  return {memberToken:'synthetic-dsh-token',membershipId,expiresAt} as never
 }
 if(path.startsWith('/api/v1/files?'))return {files:[{id:'file',name:'预算.docx',format:'docx'}]} as never
 if(path.endsWith('/background')){channel.backgroundEnabled=!!(body as {enabled:boolean}).enabled;channel.fileId='file'}
 if(path.endsWith('/background-tasks')&&new URLSearchParams(window.location.search).has('failure')){await new Promise(resolve=>setTimeout(resolve,1000));if(failTaskList){failTaskList=false;throw Error('offline')}}
 if(path.endsWith('/background-tasks'))return {items:stress?Array.from({length:30},(_,i)=>({...task,taskId:'task-'+i,fileName:'LongDocumentName'.repeat(12)+i+'.docx'})):[task],nextCursor:null} as never
 if(path.includes('/background-tasks/'))return {...task,taskId:path.split('/').at(-1),summary:stress?'预算结果'.repeat(500):task.summary} as never
 return channel as never
}
function Preview(){
 const [page,setPage]=useState('channels')
 return <><nav aria-label="工作区入口"><button onClick={()=>setPage('channels')}>频道分享入口</button><button onClick={()=>setPage('tasks')}>后台任务入口</button></nav>{page==='channels'?<AssistantChannelsPage request={request} onOpenDocument={async()=>{}}/>:<BackgroundTasksPage request={request} onOpenDocument={async()=>{}} onOpenChannel={()=>setPage('channels')}/>}</>
}
createRoot(document.getElementById('root')!).render(<Preview/>)
