import {NativeSettingsDialog} from './NativeSettingsDialog'
import {useEffect,useRef,useState} from 'react'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {WorkspaceFile,WorkspaceFileList} from '../../../../packages/web-contracts/src/workspace'
import './workspace-trash.css'
import {ManagementList} from './ManagementList'
import {SettingsListPager} from './SettingsListPager'
const pageSize=10
const sizeLabel=(size:number)=>size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(1)} KB`:`${(size/1024/1024).toFixed(1)} MB`
export function WorkspaceTrash({request,onClose,onChanged,presentation='dialog',onCloseGuardChange}:{request:SettingsRequest;onClose():void;onChanged():void;presentation?:'dialog'|'page';onCloseGuardChange?:(guard:(()=>boolean)|null)=>void}){
 const [files,setFiles]=useState<WorkspaceFile[]>([]),[total,setTotal]=useState(0),[page,setPage]=useState(1)
 const [busy,setBusy]=useState(true),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[search,setSearch]=useState('')
 const [purging,setPurging]=useState<WorkspaceFile[]|null>(null)
 const [selected,setSelected]=useState<Set<string>>(()=>new Set())
 const mounted=useRef(true),pending=useRef(false)
 useEffect(()=>{const prevent=(event:BeforeUnloadEvent)=>{if(pending.current||uncertain){event.preventDefault();event.returnValue=''}};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent)},[uncertain])
 function canClose(){if(pending.current||busy){setError('回收站操作处理中，请完成后再关闭。');return false}if(uncertain){setError('操作结果尚未确认，请重新加载回收站核对后再关闭。');return false}return true}
 useEffect(()=>{onCloseGuardChange?.(busy||uncertain?canClose:null);return()=>onCloseGuardChange?.(null)},[onCloseGuardChange,busy,uncertain])
 async function readPage(nextPage:number):Promise<WorkspaceFileList&{page:number}>{
  const result=await request<WorkspaceFileList>(`/api/v1/workspace/files?view=trash&limit=${pageSize}&offset=${(nextPage-1)*pageSize}`)
  if(!result||!Array.isArray(result.files)||!Number.isSafeInteger(result.total)||result.total<0)throw Error('回收站响应无效。')
  if(!result.files.length&&result.total>0){if(nextPage>1)return readPage(nextPage>Math.ceil(result.total/pageSize)?Math.ceil(result.total/pageSize):1);throw Error('回收站列表已变化，请重新加载核对。')}
  return {...result,page:result.total===0?1:nextPage}
 }
 async function load(nextPage=page){
  if(pending.current)return
  pending.current=true;setBusy(true);setError('');setMessage('');setPurging(null)
  try{
   const result=await readPage(nextPage)
   if(mounted.current){setFiles(result.files);setTotal(result.total);setPage(result.page);setSearch('');setSelected(new Set());setUncertain(false)}
  }catch(failure){if(mounted.current)setError(failure instanceof Error?failure.message:'回收站加载失败，请重新加载。')}
  finally{pending.current=false;if(mounted.current)setBusy(false)}
 }
 useEffect(()=>{mounted.current=true;void load(1);return()=>{mounted.current=false}},[])
 async function mutate(targets:WorkspaceFile[],action:'restore'|'purge'){
  if(pending.current||uncertain)return
  pending.current=true;setBusy(true);setError('');setMessage('');setPurging(null)
  const removed=new Set<string>(),failures:string[]=[]
  let deferred=0,unknown=false,unattempted=0
  try{
   for(const [index,file] of targets.entries()){
    if(!mounted.current)return
    try{
     const result=await request<{state:'purged'|'pending'}|undefined>(`/api/v1/files/${encodeURIComponent(file.id)}/${action}`,'POST')
     if(action==='purge'&&result?.state!=='purged'&&result?.state!=='pending')throw Error('删除结果无效。')
     removed.add(file.id)
     if(result?.state==='pending')deferred++
    }catch(failure){
     const status=(failure as {status?:number})?.status
     unknown=status===undefined||status>=500||status===408
     const reason=unknown?`无法确认${action==='restore'?'恢复':'永久删除'}结果，请重新加载回收站核对，不要重复提交。`:action==='purge'&&status===409?'暂时无法永久删除：此文件可能有关联的进行中任务或未确认的上传。请核对相关任务和上传状态，再重新加载回收站核对；若仍无法删除，请联系管理员。':failure instanceof Error?failure.message:'操作失败。'
     failures.push(targets.length===1?reason:`「${file.name}」：${reason}`)
     if(unknown||status===401||status===403||status===429){
      unattempted=targets.length-index-1
      break
     }
    }
   }
   if(!mounted.current)return
   if(unattempted)failures.push(`其余 ${unattempted} 个文件未处理。`)
   setUncertain(unknown)
   if(removed.size){
    const remaining=Math.max(0,total-removed.size)
    const nextPage=Math.min(page,Math.max(1,Math.ceil(remaining/pageSize)))
    setFiles(current=>current.filter(file=>!removed.has(file.id)))
    setSelected(current=>new Set([...current].filter(id=>!removed.has(id))))
    setTotal(remaining)
    setPage(nextPage)
    onChanged()
    const name=targets[0].name
    setMessage(action==='restore'
     ?`已恢复「${name}」，原始内容、收藏和文件夹归属保持不变。`
     :targets.length>1
      ?`已永久删除 ${removed.size} 个文件。${deferred?`其中 ${deferred} 个文件的存储空间正在后台回收。`:''}`
      :deferred?`「${name}」已不可恢复，存储空间正在后台回收。`:`已永久删除「${name}」。`)
    if(!unknown&&remaining>0){
     try{
      const refreshed=await readPage(nextPage)
      if(mounted.current){
       setFiles(refreshed.files);setTotal(refreshed.total);setPage(refreshed.page)
       setSelected(current=>new Set(refreshed.files.filter(file=>current.has(file.id)).map(file=>file.id)))
       if(targets.length===1){setSearch('');setSelected(new Set())}
      }
     }catch{failures.push('操作已成功，但列表刷新失败。请重新加载列表，不要重复提交。')}
    }
   }
   if(mounted.current)setError(failures.join('\n'))
  }
  finally{pending.current=false;if(mounted.current)setBusy(false)}
 }
 const filtered=files.filter(file=>file.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
 const selection=filtered.filter(file=>selected.has(file.id))
 const allSelected=filtered.length>0&&selection.length===filtered.length
 function changeSearch(value:string){setSearch(value);setSelected(new Set())}
 const content=<div className="trash-content">
  <ManagementList<WorkspaceFile>
   heading="已删除文件" description="找回误删文件，或确认后永久清理不再需要的内容。"
   summary={<><span>回收站 <strong>{total}</strong> 个文件</span><span>当前页 {sizeLabel(files.reduce((sum,file)=>sum+file.size,0))}</span></>}
   toolbar={<><div className="trash-search"><input className="native-settings-input" type="search" aria-label="搜索当前页文件" placeholder="搜索当前页文件名" value={search} disabled={busy} onChange={e=>changeSearch(e.target.value)}/>{search&&<button type="button" className="trash-search-clear" aria-label="清空搜索当前页文件" disabled={busy} onClick={()=>changeSearch('')}>×</button>}</div><button type="button" className="native-settings-button" disabled={busy} onClick={()=>void load()}>重新加载</button><div className="trash-batch">{selection.length>0&&<span role="status">已选 {selection.length} 项</span>}<button type="button" className="native-settings-button is-danger" disabled={busy||uncertain||!selection.length} onClick={()=>setPurging(selection)}>批量永久删除</button></div></>}
   panel={(error||message||busy)?<>{error&&<div role="alert" className="native-settings-notice is-error trash-error">{error}</div>}{message&&<div role="status" className="native-settings-notice is-success">{message}</div>}{busy&&<span role="status" className="trash-processing">正在处理…</span>}</>:undefined}
   footer={<><span className="trash-footnote">仅显示当前账号文件，搜索范围为当前页</span><SettingsListPager page={page-1} pageSize={pageSize} total={total} label="回收站" disabled={busy||uncertain} onPageChange={next=>void load(next+1)}/></>}
   rowKey="id" loading={busy} dataSource={filtered} scrollX={640} locale={{emptyText:<div className="trash-empty">{error?'暂时无法显示回收站，请重新加载。':search?'当前页没有匹配文件':'回收站为空。'}</div>}} columns={[
   {title:<input type="checkbox" className="trash-select" aria-label="全选当前筛选结果" checked={allSelected} ref={input=>{if(input)input.indeterminate=selection.length>0&&!allSelected}} disabled={busy||uncertain||!filtered.length} onChange={()=>setSelected(allSelected?new Set():new Set(filtered.map(file=>file.id)))}/>,key:'selection',width:48,render:(_value,file)=><input type="checkbox" className="trash-select" aria-label={`选择 ${file.name}`} checked={selected.has(file.id)} disabled={busy||uncertain} onChange={event=>{
    const checked=event.currentTarget.checked
    setSelected(current=>{
     const next=new Set(current)
     if(checked)next.add(file.id)
     else next.delete(file.id)
     return next
    })
   }}/>},
   {title:'文件',key:'name',render:(_value,file)=><div className="trash-file"><span className={`trash-file-icon trash-format-${file.format}`}><svg width="20" height="22" viewBox="0 0 20 22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M4 2h8l4 4v14H4Z"/><path d="M12 2v5h4M7 11h6M7 15h6"/></svg></span><div><strong>{file.name}</strong><div className="trash-file-meta"><span className="trash-format-label">{file.format.toUpperCase()}</span><span>{sizeLabel(file.size)}</span></div></div></div>},
   {title:'最后修改',dataIndex:'updatedAt',key:'updatedAt',width:180,render:(value:string)=><time dateTime={value}>{Number.isNaN(Date.parse(value))?'—':new Date(value).toLocaleString()}</time>},
   {title:'操作',key:'actions',width:210,render:(_value,file)=><div className="trash-actions"><button type="button" className="native-settings-button" disabled={busy||uncertain} onClick={()=>void mutate([file],'restore')}>恢复</button><button type="button" className="native-settings-button is-danger" disabled={busy||uncertain} onClick={()=>setPurging([file])}>永久删除</button></div>},
  ]}/>
  {purging&&<NativeSettingsDialog title="永久删除文件？" compact onClose={()=>setPurging(null)} footer={<><button type="button" className="native-settings-button" onClick={()=>setPurging(null)}>取消</button><button type="button" className="native-settings-button is-danger" disabled={busy||uncertain} onClick={()=>void mutate(purging,'purge')}>确认永久删除</button></>}><div className="trash-purge-warning"><strong>此操作无法恢复</strong><p>将永久删除{purging.length===1?`「${purging[0].name}」`:`以下 ${purging.length} 个文件`}及其历史版本。请确认已保存所需副本。</p>{purging.length>1&&<ul className="trash-purge-list">{purging.map(file=><li key={file.id}>{file.name}</li>)}</ul>}</div></NativeSettingsDialog>}
 </div>
 function requestClose(){if(canClose())onClose()}
 if(presentation==='dialog')return <NativeSettingsDialog title="回收站" onClose={requestClose}><div className="trash-dialog-body">{content}</div></NativeSettingsDialog>
 return <div className="workspace-panel-host"><section className="workspace-panel workspace-trash-panel" aria-label="回收站"><div className="workspace-panel-body">{content}</div></section></div>
}
