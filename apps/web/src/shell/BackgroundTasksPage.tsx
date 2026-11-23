import {useEffect,useRef,useState} from 'react'
import {channelBase as base,backgroundTaskLabels as labels,type BackgroundTask,type WorkspaceRequest} from './background-workspace'
import './background-workspace.css'
export function BackgroundTasksPage({request,onOpenDocument,onOpenChannel}:{request:WorkspaceRequest;onOpenDocument:(fileId:string,channelId:string)=>Promise<void>;onOpenChannel:(id:string)=>void}){
 const [items,setItems]=useState<BackgroundTask[]>([]),[cursor,setCursor]=useState<string|null>(null),[detail,setDetail]=useState<BackgroundTask|null>(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[filter,setFilter]=useState('all')
 const [loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false)
 const detailElement=useRef<HTMLElement>(null),returnFocus=useRef<HTMLButtonElement|null>(null)
 const alive=useRef(true),selected=useRef<string|null>(null),currentRequest=useRef(request),loadedPages=useRef(1),loadSequence=useRef(0)
 currentRequest.current=request
 const load=async(after?:string)=>{
  if(!alive.current||currentRequest.current!==request)return
  const stamp=++loadSequence.current,items:BackgroundTask[]=[]
  setLoading(true)
  try{
   let next:string|null=after??null
  for(let page=0;page<(after?1:loadedPages.current);page++){
   const reply=await request<{items:BackgroundTask[];nextCursor:string|null}>(base+'/background-tasks'+(next?'?after='+encodeURIComponent(next):''))
   if(!alive.current||currentRequest.current!==request||stamp!==loadSequence.current)return
   items.push(...reply.items);next=reply.nextCursor
   if(!next)break
  }
  if(after)loadedPages.current++
  setItems(prior=>[...new Map((after?[...prior,...items]:items).map(task=>[task.taskId,task])).values()]);setCursor(next);setLoaded(true)
  }finally{if(alive.current&&currentRequest.current===request&&stamp===loadSequence.current)setLoading(false)}
 }
 const read=async(id:string)=>{
  let task:BackgroundTask
  try{task=await request<BackgroundTask>(base+'/background-tasks/'+encodeURIComponent(id))}catch(error){if(alive.current&&currentRequest.current===request&&selected.current===id)setDetail(null);throw error}
  if(alive.current&&currentRequest.current===request&&selected.current===id)setDetail(task)
 }
 const perform=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await work()}catch{if(alive.current&&currentRequest.current===request)setError('任务操作未完成，请刷新后核对。')}finally{if(alive.current&&currentRequest.current===request)setBusy(false)}}
 useEffect(()=>{alive.current=true;selected.current=null;loadedPages.current=1;setDetail(null);setItems([]);setBusy(false);setCursor(null);setLoaded(false);setLoading(true);setError('');void load().catch(()=>{if(alive.current&&currentRequest.current===request)setError('后台任务暂时无法加载。')});return()=>{alive.current=false}},[request])
 useEffect(()=>{
  if(busy||!items.some(t=>['queued','running','waiting_peer','cancel_requested'].includes(t.state)))return
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void load().then(()=>selected.current?read(selected.current):undefined).catch(()=>{})},3000)
  return()=>clearInterval(timer)
 },[items,request,busy])
 useEffect(()=>{if(detail?.taskId){detailElement.current?.focus();detailElement.current?.scrollIntoView?.({block:'start'})}},[detail?.taskId])
 const visibleItems=items.filter(t=>filter==='all'||t.state===filter)
 return <section className="background-workspace" aria-label="后台任务">
  <header><div><h2>后台任务</h2><p>任务在服务器执行，关闭浏览器后仍可继续。</p></div><button disabled={busy} onClick={()=>void perform(async()=>{await load();if(selected.current)await read(selected.current)})}>刷新</button></header>
  {error&&<p role="alert">{error}</p>}
  <label className="background-filter">状态 <select aria-label="任务状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部</option>{Object.entries(labels).map(([state,label])=><option key={state} value={state}>{label}</option>)}</select></label>
  {busy&&selected.current&&!detail&&<p role="status">正在读取任务详情…</p>}
  {detail&&<article ref={detailElement} tabIndex={-1} className="background-task-detail" aria-label="任务详情"><h3>{detail.fileName} · {labels[detail.state]}</h3>
   <div className="background-actions"><button onClick={()=>onOpenChannel(detail.conversationId)}>查看频道</button><button disabled={busy} onClick={()=>void perform(()=>onOpenDocument(detail.fileId,detail.conversationId))}>打开来源文档</button>
   {['queued','running','waiting_peer'].includes(detail.state)&&<button disabled={busy} onClick={()=>void perform(async()=>{await request(base+'/actions','POST',{requestId:crypto.randomUUID(),conversationId:detail.conversationId,to:'office',action:{kind:'cancel',taskId:detail.taskId}});await load();await read(detail.taskId)})}>取消任务</button>}<button onClick={()=>{selected.current=null;setDetail(null);returnFocus.current?.focus()}}>关闭详情</button></div><p>{detail.instruction}</p><p>已保存版本：<code>{detail.savedRevision}</code></p>
   {detail.summary&&<p className="background-result">{detail.summary}</p>}{detail.state==='unknown_outcome'&&<p>任务执行结果尚未确认，请先核对结果再决定是否重新提交。</p>}

  </article>}
  <div className="background-task-list">{visibleItems.map(task=><article key={task.taskId}><div className="background-row"><strong>{task.fileName}</strong><span className="background-state" data-state={task.state}>{labels[task.state]}</span></div><p>{task.instruction}</p><small>{task.sourceName??'频道成员'} · {new Date(task.createdAt).toLocaleString()}</small><p>已保存版本：<code>{task.savedRevision}</code></p><button disabled={busy} onClick={event=>{returnFocus.current=event.currentTarget;void perform(async()=>{selected.current=task.taskId;setDetail(null);await read(task.taskId)})}}>查看结果</button></article>)}</div>
  {loading&&!loaded&&<p role="status">正在加载后台任务…</p>}{loaded&&!loading&&!error&&!items.length&&<p className="background-empty">暂无后台任务。</p>}{loaded&&!loading&&items.length>0&&!visibleItems.length&&<p className="background-empty">没有符合当前状态的任务。<button onClick={()=>setFilter('all')}>查看全部任务</button></p>}{cursor&&<button disabled={busy} onClick={()=>void perform(()=>load(cursor))}>加载更多任务</button>}

 </section>
}
