import {Alert,Button,Modal,Space,Tag,Typography,Upload} from 'antd'
import {CheckCircleFilled,CloseCircleFilled,CloudUploadOutlined,DeleteOutlined,FileExcelOutlined,FileOutlined,FilePdfOutlined,FilePptOutlined,FileWordOutlined,LoadingOutlined} from '@ant-design/icons'
import {useRef,useState} from 'react'
import './workspace-upload.css'
type UploadItem={id:number;file:File;state:'queued'|'processing'|'success'|'error'|'rejected';error?:string}
type WorkspaceUploadDialogProps={open:boolean;initialFiles?:File[];upload:(file:File)=>Promise<void>;onClose:()=>void}
const maxFileSize=32*1024*1024
const supported=/\.(docx|xlsx|pptx|pdf)$/i
const sizeLabel=(size:number)=>size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(1)} KB`:`${(size/1024/1024).toFixed(1)} MB`
const formatIcons={docx:FileWordOutlined,xlsx:FileExcelOutlined,pptx:FilePptOutlined,pdf:FilePdfOutlined}
export function WorkspaceUploadDialog({open,initialFiles=[],upload,onClose}:WorkspaceUploadDialogProps){
 const sequence=useRef(0),locked=useRef(false)
 function item(file:File):UploadItem{const error=!supported.test(file.name)?'不支持此格式':file.size>maxFileSize?'文件超过 32 MiB 限制':undefined;return {id:sequence.current++,file,state:error?'rejected':'queued',error}}
 const [items,setItems]=useState<UploadItem[]>(()=>initialFiles.map(item)),[busy,setBusy]=useState(false)
 const queued=items.filter(entry=>entry.state==='queued'),completed=items.filter(entry=>entry.state==='success').length,failed=items.filter(entry=>entry.state==='error').length
 function close(){if(!locked.current)onClose()}
 async function start(){
  if(locked.current||!queued.length)return
  locked.current=true;setBusy(true)
  const update=(id:number,state:UploadItem['state'],error?:string)=>setItems(current=>current.map(entry=>entry.id===id?{...entry,state,error}:entry))
  try{for(const entry of queued){update(entry.id,'processing');try{await upload(entry.file);update(entry.id,'success')}catch(error){update(entry.id,'error',error instanceof Error?error.message:'导入未完成。请核对工作区中的文件。')}}}
  finally{locked.current=false;setBusy(false)}
 }
 return <Modal className="workspace-upload-modal" title="上传文件" open={open} centered width={680} mask={{closable:false}} closable={{disabled:busy}} keyboard={!busy} onCancel={close} footer={<div className="workspace-upload-footer"><Typography.Text type="secondary">{busy?'文件正在逐个上传，请稍候':items.length?`已选择 ${items.length} 个 · 已完成 ${completed}${failed?` · 未完成 ${failed}`:''}`:'支持多文件，按顺序上传'}</Typography.Text><Space><Button autoInsertSpace={false} disabled={busy} onClick={close}>{completed||failed?'完成':'取消'}</Button><Button autoInsertSpace={false} type="primary" disabled={busy||!queued.length} loading={busy} onClick={()=>void start()}>{busy?'正在上传…':`开始上传${queued.length?`（${queued.length}）`:''}`}</Button></Space></div>}>
  <Typography.Paragraph type="secondary" className="workspace-upload-intro">将本地文件添加到工作区，上传成功后在文档标签页中打开。</Typography.Paragraph>
  <Upload.Dragger multiple accept=".docx,.xlsx,.pptx,.pdf" showUploadList={false} disabled={busy} beforeUpload={file=>{if(!locked.current)setItems(current=>[...current,item(file)]);return Upload.LIST_IGNORE}}>
   <span className="workspace-upload-drop-icon"><CloudUploadOutlined/></span>
   <span className="workspace-upload-drop-title">点击选择文件，或拖拽到这里</span>
   <span className="workspace-upload-drop-hint">支持 Word、Excel、PowerPoint 和 PDF · 单个文件最大 32 MiB</span>
   <span className="workspace-upload-formats"><Tag>DOCX</Tag><Tag>XLSX</Tag><Tag>PPTX</Tag><Tag>PDF</Tag></span>
  </Upload.Dragger>
  {items.length>0&&<><div className="workspace-upload-list-heading"><Typography.Text strong>文件列表</Typography.Text><Typography.Text type="secondary">{items.length} 个文件</Typography.Text></div><ul className="workspace-upload-list" aria-label="待上传文件">{items.map(entry=>{
   const format=entry.file.name.split('.').pop()?.toLowerCase() as keyof typeof formatIcons,Icon=formatIcons[format]??FileOutlined
   return <li key={entry.id} className={`workspace-upload-item is-${entry.state}`}><span className={`workspace-upload-file-icon format-${format}`}><Icon/></span><div className="workspace-upload-file-detail"><span className="workspace-upload-file-name" title={entry.file.name}>{entry.file.name}</span><span className="workspace-upload-file-meta">{sizeLabel(entry.file.size)}<span className="workspace-upload-item-state">{entry.state==='queued'?'等待上传':entry.state==='processing'?<><LoadingOutlined/> 正在上传并打开…</>:entry.state==='success'?<><CheckCircleFilled/> 已上传并打开</>:entry.state==='rejected'?'无法上传':<><CloseCircleFilled/> 导入未完成</>}</span></span>{entry.error&&<span className="workspace-upload-file-error">{entry.error}</span>}</div>{!busy&&(entry.state==='queued'||entry.state==='rejected')&&<Button type="text" icon={<DeleteOutlined/>} aria-label={`移除 ${entry.file.name}`} onClick={()=>setItems(current=>current.filter(value=>value.id!==entry.id))}/>}</li>
  })}</ul></>}
  {!!failed&&<Alert className="workspace-upload-warning" type="warning" showIcon title="部分文件未完成导入" description="请先核对工作区，确认文件是否已上传，再决定后续操作。"/>}
  <p className="workspace-upload-note">文件按顺序处理。上传期间请保持此窗口打开。</p>
 </Modal>
}
