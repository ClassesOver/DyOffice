import {AssistantAvatar} from '@genoffice/ui'
import {useEffect,useRef,useState} from 'react'
import type {ChannelSnapshot} from '../../../../packages/browser-host/src/assistant-channel'
import {defaultDshTokenExpiryMinutes,dshTokenExpiryOptions} from '../../../../packages/web-contracts/src/assistant-channel'
import {channelBase as base,type ChannelEntry,type WorkspaceRequest} from './background-workspace'
import {NativeSettingsDialog} from './NativeSettingsDialog'
import './background-workspace.css'

export function AssistantChannelsPage({request,onOpenDocument,initialChannelId}:{request:WorkspaceRequest;onOpenDocument:(fileId:string,channelId:string)=>Promise<void>;initialChannelId?:string}){
 const [items,setItems]=useState<ChannelEntry[]>([]),[cursor,setCursor]=useState<string|null>(null)
 const [selected,setSelected]=useState(initialChannelId??''),[snapshot,setSnapshot]=useState<(ChannelSnapshot&{backgroundEnabled?:boolean})|null>(null)
 const [dshToken,setDshToken]=useState<{channelId:string;membershipId:string;memberToken:string;expiresAt:string;fromHistory?:boolean}|null>(null),[copied,setCopied]=useState(false)
 const [historyOpen,setHistoryOpen]=useState(false)
 const history=useRef<HTMLDetailsElement>(null),revealSequence=useRef(0),tokenInput=useRef<HTMLInputElement>(null)
 const clearToken=()=>{revealSequence.current++;setDshToken(null);setCopied(false)}
 const [codeMinutes,setCodeMinutes]=useState(defaultDshTokenExpiryMinutes)
 const [allowCreate,setAllowCreate]=useState(false),[allowEdit,setAllowEdit]=useState(false)
 const [files,setFiles]=useState<{id:string;name:string}[]>([]),[fileId,setFileId]=useState('')
 const [mobileDetail,setMobileDetail]=useState(!!initialChannelId),[listLoading,setListLoading]=useState(true)
 const channelList=useRef<HTMLElement>(null),channelDetail=useRef<HTMLElement>(null),returningToList=useRef(false)
 const [deleteTarget,setDeleteTarget]=useState<ChannelEntry|null>(null)
 const [deleteError,setDeleteError]=useState('')
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const alive=useRef(true),sequence=useRef(0),creating=useRef<string|undefined>(undefined),currentRequest=useRef(request),currentSelected=useRef(selected)
 currentRequest.current=request;currentSelected.current=selected
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++}},[])
 const perform=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await work()}catch{if(alive.current&&currentRequest.current===request)setError('操作未完成，请刷新核对后重试。')}finally{if(alive.current&&currentRequest.current===request)setBusy(false)}}
 const load=async(after?:string)=>{
  setListLoading(true)
  try{
  const reply=await request<{items:ChannelEntry[];nextCursor:string|null}>(base+'/channels'+(after?'?after='+encodeURIComponent(after):''))
  if(alive.current&&currentRequest.current===request){setItems(prior=>after?[...prior,...reply.items]:reply.items);setCursor(reply.nextCursor)}
  }finally{if(alive.current&&currentRequest.current===request)setListLoading(false)}
 }
 const refresh=async(id:string)=>{
  if(currentRequest.current!==request||currentSelected.current!==id)return
  const stamp=++sequence.current,next=await request<ChannelSnapshot&{backgroundEnabled?:boolean}>(base+'/channels/'+encodeURIComponent(id))
  if(alive.current&&currentRequest.current===request&&currentSelected.current===id&&stamp===sequence.current)setSnapshot(next)
 }
 useEffect(()=>{setItems([]);setBusy(false);setDeleteTarget(null);setDeleteError('');setDshToken(null);setFiles([]);setError('');creating.current=undefined;void load().catch(()=>{if(alive.current&&currentRequest.current===request)setError('频道暂时无法加载，请刷新重试。')})},[request])
 useEffect(()=>{
  setSnapshot(null);setFileId('');setDshToken(null);setCopied(false);setAllowCreate(false);setHistoryOpen(false)
  if(!selected)return
  void refresh(selected).catch(()=>{if(alive.current&&currentRequest.current===request)setError('频道暂时无法加载，请刷新重试。')})
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh(selected).catch(()=>{})},5000)
  return()=>{clearInterval(timer);sequence.current++}
 },[selected,request])
 useEffect(()=>{if(dshToken?.fromHistory)tokenInput.current?.focus()},[dshToken])
 useEffect(()=>{if(mobileDetail&&snapshot&&window.matchMedia('(max-width:640px)').matches){channelDetail.current?.focus();channelDetail.current?.scrollIntoView?.({block:'start'})}},[mobileDetail,snapshot?.conversationId])
 useEffect(()=>{if(!mobileDetail&&returningToList.current){returningToList.current=false;const target=channelList.current?.querySelector<HTMLButtonElement>('button[aria-current=true]');(target??channelList.current)?.focus()}},[mobileDetail])
 useEffect(()=>{
  if(!dshToken)return
  const expiresAt=Date.parse(dshToken.expiresAt)
  let timer:ReturnType<typeof setTimeout>
  const expire=()=>{
   const remaining=expiresAt-Date.now()
   if(remaining>0)timer=setTimeout(expire,Math.min(remaining,2_147_483_647))
   else setDshToken(current=>current===dshToken?null:current)
  }
  expire()
  return()=>clearTimeout(timer)
 },[dshToken])
 const tokenHistory=snapshot?.members.filter(member=>member.kind==='dsh')??[]
 const visibleToken=dshToken?.channelId===selected&&!tokenHistory.some(member=>member.membershipId===dshToken.membershipId&&member.revoked)?dshToken:null
 const tokenValue=visibleToken&&<div className="background-token-value">
  <label className="background-service-address">DSH 授权 Token<input ref={tokenInput} readOnly value={visibleToken.memberToken} onFocus={event=>event.currentTarget.select()}/></label>
  <p>有效至 <time dateTime={visibleToken.expiresAt}>{new Date(visibleToken.expiresAt).toLocaleString()}</time>。Token 同时受签发者登录会话有效期约束。</p>
  <div className="background-actions">
   <button type="button" disabled={busy} onClick={()=>void perform(async()=>{await navigator.clipboard.writeText(location.origin+'/#dsh='+visibleToken.memberToken)})}>复制 DSH 插件授权码</button>
   <button type="button" disabled={busy} onClick={()=>void perform(async()=>{await navigator.clipboard.writeText(visibleToken.memberToken);if(alive.current&&currentRequest.current===request&&currentSelected.current===selected)setCopied(true)})}>{copied?'已复制授权 Token':'复制授权 Token'}</button>
   <button type="button" onClick={()=>{clearToken();if(visibleToken.fromHistory)history.current?.querySelector<HTMLButtonElement>('[data-reveal-id="'+visibleToken.membershipId+'"]')?.focus()}}>隐藏授权码</button>
  </div>
 </div>
 const action=async(path:string,body:unknown)=>{await request(base+'/channels/'+selected+path,'POST',body);await refresh(selected)}
 const deleteChannel=async()=>{
  if(!deleteTarget||busy)return
  const id=deleteTarget.conversationId
  setBusy(true);setDeleteError('');setError('')
  try{
   await request(base+'/channels/'+encodeURIComponent(id),'DELETE')
   if(!alive.current||currentRequest.current!==request)return
   setDeleteTarget(null)
   setItems(previous=>previous.filter(item=>item.conversationId!==id))
   if(currentSelected.current===id){
    sequence.current++;currentSelected.current=''
    setSnapshot(null);setSelected('');setDshToken(null);returningToList.current=true;setMobileDetail(false)
   }
  }catch{
   if(alive.current&&currentRequest.current===request)setDeleteError('频道删除未获确认，请关闭后刷新列表核对。')
  }finally{
   if(alive.current&&currentRequest.current===request)setBusy(false)
  }
 }
 return <section className="background-workspace" aria-label="频道分享">
  <header><div><h2>频道分享</h2><p>创建频道，与 DSH 或其他 Agent 协作。</p></div><div className="background-actions">
   <button className="background-primary" disabled={busy} onClick={()=>void perform(async()=>{creating.current??=crypto.randomUUID();const created=await request<ChannelEntry>(base+'/channels','POST',{conversationId:creating.current});creating.current=undefined;await load();if(alive.current&&currentRequest.current===request){setSelected(created.conversationId);setMobileDetail(true)}})}>创建频道</button>
   <button disabled={busy} onClick={()=>void perform(async()=>{await load();if(selected)await refresh(selected)})}>刷新</button>
  </div></header>
  {error&&<p role="alert">{error}</p>}
  <div className={`background-columns${mobileDetail?' background-channel-detail-open':''}`}><nav ref={channelList} tabIndex={-1} aria-label="频道列表">{items.map(item=><button key={item.conversationId} aria-current={selected===item.conversationId?'true':undefined} onClick={()=>{if(selected!==item.conversationId)clearToken();setSelected(item.conversationId);setMobileDetail(true)}}>{item.fileName??'协作频道'}<small>{item.conversationId.slice(0,8)} · {item.paused?'已暂停':'可协作'}</small></button>)}{listLoading&&!items.length&&<p role="status">正在加载频道…</p>}{!listLoading&&!error&&!items.length&&<p>暂无频道，可直接创建。</p>}{cursor&&<button disabled={busy} onClick={()=>void perform(()=>load(cursor))}>加载更多频道</button>}</nav>
  {snapshot?<article ref={channelDetail} tabIndex={-1}><button className="background-channel-back" onClick={()=>{clearToken();setHistoryOpen(false);returningToList.current=true;setMobileDetail(false)}}>返回频道列表</button><h3>{snapshot.fileId?'文档协作频道':'协作频道'}</h3><p><code>{snapshot.conversationId}</code></p>
   <div className="background-actions"><button disabled={busy} onClick={()=>void perform(()=>action('/pause',{paused:!snapshot.paused}))}>{snapshot.paused?'恢复协作':'暂停协作'}</button>
   {snapshot.fileId&&<button disabled={busy} onClick={()=>void perform(()=>onOpenDocument(snapshot.fileId!,selected))}>打开文档</button>}
   <button type="button" className="background-danger" disabled={busy} onClick={()=>{setDeleteError('');setDeleteTarget(items.find(item=>item.conversationId===selected)??{...snapshot,createdAt:''})}}>删除频道</button></div>
   <h4>频道成员</h4>{!snapshot.members.length&&<p>暂无成员。</p>}{snapshot.members.map(m=><div className="background-row" key={m.membershipId}><span className="assistant-participant"><AssistantAvatar id={m.kind} name={m.displayName} origin="external"/><span>{m.displayName} · {m.revoked?'已移除':Date.parse(m.expiresAt)<=Date.now()?'授权已过期':m.online?'在线':m.previewActive?'预览连接活跃':'已授权，离线'}</span></span>{!m.revoked&&<button disabled={busy} onClick={()=>void perform(()=>action('/members/'+m.membershipId+'/revoke',{}))}>移除连接</button>}</div>)}
   <h4>后台读取</h4>{snapshot.backgroundAvailable===false&&<p>此部署尚未开启后台执行。</p>}<p>授权成员可以预览已保存的 DOCX、XLSX、PPTX 或 PDF 文字，也可以在浏览器关闭后请求文档问答。表格使用缓存值，预览范围为已保存的文字。</p>
   {!snapshot.paused&&<div className="background-invitation">
    <label className="background-service-address">授权 Token 有效期
     <select disabled={busy} value={codeMinutes} onChange={event=>setCodeMinutes(Number(event.target.value))}>
      {dshTokenExpiryOptions.map(minutes=><option key={minutes} value={minutes}>{minutes<=1440?minutes/60+' 小时':minutes/1440+' 天'}</option>)}
     </select>
    </label>
    <label><input type="checkbox" checked={allowCreate} disabled={busy} onChange={event=>setAllowCreate(event.target.checked)}/> 允许 DSH 在我的工作区创建新文档</label>
    <label><input type="checkbox" checked={allowEdit} disabled={busy} onChange={event=>setAllowEdit(event.target.checked)}/> 允许在 DSH 中免登录编辑文档</label>
    <button disabled={busy||(!allowCreate&&!(allowEdit&&snapshot.fileId)&&(!snapshot.backgroundEnabled||snapshot.backgroundAvailable===false))} onClick={()=>void perform(async()=>{
     const {memberToken,expiresAt,membershipId}=await request<{memberToken:string;expiresAt:string;membershipId:string}>(base+'/channels/'+selected+'/dsh-token','POST',{expiresInMinutes:codeMinutes,allowCreate,allowEdit})
     if(alive.current&&currentRequest.current===request&&currentSelected.current===selected){setDshToken({channelId:selected,membershipId,memberToken,expiresAt});setCopied(false);await refresh(selected)}
    })}>生成 DSH 授权 Token</button>
   </div>}
   <details ref={history} className="background-token-history" open={historyOpen} onToggle={event=>{
    setHistoryOpen(event.currentTarget.open)
    if(!event.currentTarget.open){
     revealSequence.current++
     setDshToken(current=>current?.fromHistory?null:current)
     if(dshToken?.fromHistory)setCopied(false)
    }
   }}>
    <summary>历史授权码（{tokenHistory.length}）</summary>
    {!tokenHistory.length&&<p>暂无 DSH 授权记录。</p>}
    {tokenHistory.map(member=>{
     const expired=Date.parse(member.expiresAt)<=Date.now()
     return <div key={member.membershipId}><div className="background-row">
      <div><strong>{member.revoked?'已撤销':expired?'已过期':member.dshTokenFromOtherSession?'其他登录会话签发':'已授权'} · {member.membershipId.slice(0,8)}</strong>
       <small>{member.issuedAt&&<>签发于 <time dateTime={member.issuedAt}>{new Date(member.issuedAt).toLocaleString()}</time> · </>}
        有效至 <time dateTime={member.expiresAt}>{new Date(member.expiresAt).toLocaleString()}</time></small>
       {!member.issuedAt&&!member.revoked&&!expired&&<small>旧版签发，原码未保存</small>}
      </div>
      {member.canRevealDshToken&&!expired&&<button type="button" data-reveal-id={member.membershipId} disabled={busy} onClick={()=>void perform(async()=>{
       clearToken()
       const stamp=revealSequence.current
       const {memberToken,expiresAt}=await request<{memberToken:string;expiresAt:string}>(base+'/channels/'+selected+'/members/'+member.membershipId+'/dsh-token','POST',{})
       if(alive.current&&currentRequest.current===request&&currentSelected.current===selected&&stamp===revealSequence.current&&history.current?.open)setDshToken({channelId:selected,membershipId:member.membershipId,memberToken,expiresAt,fromHistory:true})
      })}>查看授权码</button>}
     </div>
     {historyOpen&&visibleToken?.fromHistory&&visibleToken.membershipId===member.membershipId&&tokenValue}
     </div>
    })}
   </details>
   {!visibleToken?.fromHistory&&tokenValue}
   <div className="background-access-controls" role="group" aria-label="后台读取授权">{!snapshot.fileId&&<><button disabled={busy} onClick={()=>void perform(async()=>{
    const available:{id:string;name:string}[]=[];let after:string|undefined
    do{const response=await request<{files:{id:string;name:string;format:string}[];nextCursor?:string}>('/api/v1/files?limit=100'+(after?'&cursor='+encodeURIComponent(after):''));available.push(...response.files.filter(f=>['docx','xlsx','pptx','pdf'].includes(f.format)));after=response.nextCursor}while(after)
    if(alive.current&&currentRequest.current===request)setFiles(available)
   })}>选择授权文档</button><select aria-label="授权的文档" value={fileId} onChange={e=>setFileId(e.target.value)}><option value="">请选择文档</option>{files.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></>}
   <button disabled={busy||snapshot.backgroundAvailable===false||(!snapshot.fileId&&!fileId)} onClick={()=>void perform(()=>action('/background',{enabled:!snapshot.backgroundEnabled,...(!snapshot.fileId?{fileId}:{})}))}>{snapshot.backgroundEnabled?'关闭后台读取':'允许后台读取已保存版本'}</button></div>
  </article>:<article><button className="background-channel-back" onClick={()=>{returningToList.current=true;setMobileDetail(false)}}>返回频道列表</button><p>{selected?(error?'频道未能加载，请刷新重试。':'正在加载频道…'):'请选择频道或创建新频道。'}</p></article>}</div>
  {deleteTarget&&<NativeSettingsDialog compact title="删除频道" onClose={()=>{if(!busy)setDeleteTarget(null)}} footer={<>
   <button type="button" className="native-settings-button" disabled={busy} onClick={()=>setDeleteTarget(null)}>取消</button>
   <button type="button" className="native-settings-button is-danger" disabled={busy||!!deleteError} onClick={()=>void deleteChannel()}>{busy?'正在删除…':'确认删除'}</button>
  </>}>
   <p>确定删除「{deleteTarget.fileName??'协作频道'}」（{deleteTarget.conversationId.slice(0,8)}）？</p>
   <p>频道任务和成员记录将被删除，DSH 授权立即失效。源文档和保存版本会保留。此操作无法撤销。</p>
   {deleteError&&<p role="alert">{deleteError}</p>}
  </NativeSettingsDialog>}
 </section>
}
