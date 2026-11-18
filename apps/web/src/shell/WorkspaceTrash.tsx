import {Button,Alert,Empty,Input,Modal,Space,Tag,Typography} from 'antd'
import {FileOutlined,ReloadOutlined,UndoOutlined} from '@ant-design/icons'
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
 const [purging,setPurging]=useState<WorkspaceFile|null>(null)
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
   if(mounted.current){setFiles(result.files);setTotal(result.total);setPage(result.page);setSearch('');setUncertain(false)}
  }catch(failure){if(mounted.current)setError(failure instanceof Error?failure.message:'回收站加载失败，请重新加载。')}
  finally{pending.current=false;if(mounted.current)setBusy(false)}
 }
 useEffect(()=>{mounted.current=true;void load(1);return()=>{mounted.current=false}},[])
 async function mutate(file:WorkspaceFile,action:'restore'|'purge'){
  if(pending.current||uncertain)return
  pending.current=true;setBusy(true);setError('');setMessage('');setPurging(null)
  try{
   const result=await request<{state:'purged'|'pending'}|undefined>(`/api/v1/files/${encodeURIComponent(file.id)}/${action}`,'POST')
   if(action==='purge'&&result?.state!=='purged'&&result?.state!=='pending')throw Error('删除结果无效。')
   if(mounted.current){setFiles(current=>current.filter(item=>item.id!==file.id));setTotal(value=>Math.max(0,value-1));if(total===1)setPage(1);onChanged();setMessage(action==='restore'?`已恢复「${file.name}」，原始内容、收藏和文件夹归属保持不变。`:result?.state==='pending'?`「${file.name}」已不可恢复，存储空间正在后台回收。`:`已永久删除「${file.name}」。`)}
   if(mounted.current&&total>1){
    const nextPage=Math.min(page,Math.ceil((total-1)/pageSize));setPage(nextPage)
    try{const refreshed=await readPage(nextPage);if(mounted.current){setFiles(refreshed.files);setTotal(refreshed.total);setPage(refreshed.page);setSearch('')}}
    catch{if(mounted.current)setError('操作已成功，但列表刷新失败。请重新加载列表，不要重复提交。')}
   }
  }catch(failure){if(mounted.current){const status=(failure as {status?:number})?.status;const unknown=status===undefined||status>=500||status===408;setUncertain(unknown);setError(unknown?`无法确认${action==='restore'?'恢复':'永久删除'}结果，请重新加载回收站核对，不要重复提交。`:action==='purge'&&status===409?'暂时无法永久删除：此文件可能有关联的进行中任务或未确认的上传。请核对相关任务和上传状态，再重新加载回收站核对；若仍无法删除，请联系管理员。':failure instanceof Error?failure.message:'操作失败。')}}
  finally{pending.current=false;if(mounted.current)setBusy(false)}
 }
 const filtered=files.filter(file=>file.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
 const content=<div className="trash-content">
  <ManagementList<WorkspaceFile>
   heading="已删除文件" description="找回误删文件，或确认后永久清理不再需要的内容。"
   summary={<><span>回收站 <strong>{total}</strong> 个文件</span><span>当前页 {sizeLabel(files.reduce((sum,file)=>sum+file.size,0))}</span></>}
   toolbar={<><Input.Search aria-label="搜索当前页文件" placeholder="搜索当前页文件名" value={search} allowClear disabled={busy} onChange={e=>setSearch(e.target.value)}/><Button autoInsertSpace={false} icon={<ReloadOutlined/>} disabled={busy} onClick={()=>void load()}>重新加载</Button></>}
   panel={(error||message||busy)?<>{error&&<Alert type="error" showIcon title={error}/>}{message&&<Alert type="success" showIcon role="status" title={message}/>} {busy&&<span role="status" className="trash-processing">正在处理…</span>}</>:undefined}
   footer={<><Typography.Text type="secondary" className="trash-footnote">仅显示当前账号文件，搜索范围为当前页</Typography.Text><SettingsListPager page={page-1} pageSize={pageSize} total={total} label="回收站" disabled={busy||uncertain} onPageChange={next=>void load(next+1)}/></>}
   rowKey="id" loading={busy} dataSource={filtered} scrollX={640} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error?'暂时无法显示回收站，请重新加载。':search?'当前页没有匹配文件':'回收站为空。'}/>}} columns={[
   {title:'文件',key:'name',render:(_value,file)=><div className="trash-file"><span className={`trash-file-icon trash-format-${file.format}`}><FileOutlined/></span><div><Typography.Text strong>{file.name}</Typography.Text><div><Tag>{file.format.toUpperCase()}</Tag><Typography.Text type="secondary">{sizeLabel(file.size)}</Typography.Text></div></div></div>},
   {title:'最后修改',dataIndex:'updatedAt',key:'updatedAt',width:180,render:(value:string)=><time dateTime={value}>{Number.isNaN(Date.parse(value))?'—':new Date(value).toLocaleString()}</time>},
   {title:'操作',key:'actions',width:210,render:(_value,file)=><Space><Button autoInsertSpace={false} icon={<UndoOutlined/>} disabled={busy||uncertain} onClick={()=>void mutate(file,'restore')}>恢复</Button><Button autoInsertSpace={false} type="text" danger disabled={busy||uncertain} onClick={()=>setPurging(file)}>永久删除</Button></Space>},
  ]}/>
  <Modal title="永久删除文件？" open={!!purging} onCancel={()=>setPurging(null)} destroyOnHidden footer={<Space><Button autoInsertSpace={false} onClick={()=>setPurging(null)}>取消</Button><Button autoInsertSpace={false} danger type="primary" disabled={busy||uncertain} onClick={()=>{if(purging)void mutate(purging,'purge')}}>确认永久删除</Button></Space>}><Alert type="warning" showIcon title="此操作无法恢复" description={`将永久删除「${purging?.name??''}」及其历史版本。请确认已保存所需副本。`}/></Modal>
 </div>
 return <div className={presentation==='page'?'workspace-panel-host':'set-overlay'}><section className={presentation==='page'?'workspace-panel workspace-trash-panel':'set-dialog trash-dialog'} role={presentation==='page'?undefined:'dialog'} aria-modal={presentation==='page'?undefined:true} aria-label="回收站">
 {presentation==='dialog'&&<header className="set-header"><h2 className="set-title">回收站</h2><Button autoInsertSpace={false} disabled={busy} onClick={()=>{if(canClose())onClose()}}>关闭</Button></header>}
 <div className={presentation==='page'?'workspace-panel-body':'trash-dialog-body'}>{content}</div>
 </section></div>
}
