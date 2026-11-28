import {Alert,Button,Input,Modal,Space,Tag,Typography,Upload} from 'antd'
import {CheckCircleFilled,CloseCircleFilled,CloudUploadOutlined,DeleteOutlined,FileExcelOutlined,FileOutlined,FilePdfOutlined,FilePptOutlined,FileWordOutlined,LoadingOutlined} from '@ant-design/icons'
import {useEffect,useRef,useState} from 'react'
import type {RecentEntry} from '../../../shell/src/shared/home-api'
import {hancomConversionTargets,importPromptField,odfConversionTargets,skipsImportPrompt,workspaceConversionTarget,type ImportPromptField,type ImportPromptPreferences} from '../../../../packages/web-contracts/src/file-imports'
import {IncorrectOfficeUploadPassword} from './local-client'
import {isWorkspaceFileName,type WorkspaceImportFormat,workspaceFileAccept} from './workspace-file-formats'
import './workspace-upload.css'
type UploadItem={id:number;file:File;state:'queued'|'processing'|'success'|'password-required'|'skipped'|'error'|'rejected';error?:string}
type RecentDocument=Pick<RecentEntry,'path'|'name'|'locationLabel'>
type WorkspaceUploadDialogProps={
 open:boolean
 initialFiles?:File[]
 fileImports?:readonly WorkspaceImportFormat[]
 readImportPromptPreferences?:()=>Promise<ImportPromptPreferences>
 rememberImportPrompt?:(field:ImportPromptField)=>Promise<void>
 upload:(file:File,password?:string)=>Promise<void|'password-required'>
 onClose:()=>void
 loadRecent?:()=>Promise<RecentDocument[]>
 openRecent?:(id:string)=>Promise<void>
}
const maxFileSize=32*1024*1024
const sizeLabel=(size:number)=>size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(1)} KB`:`${(size/1024/1024).toFixed(1)} MB`
const formatIcons={docx:FileWordOutlined,xlsx:FileExcelOutlined,xlsm:FileExcelOutlined,csv:FileExcelOutlined,pptx:FilePptOutlined,pdf:FilePdfOutlined}
const conversionDetails={
 xlsx:'数值、日期和兼容的公式会转换，部分样式和图表可能丢失。',
 docx:'正文、标题、列表、表格和图片会转换，部分脚注、批注和文本框可能丢失。',
 pptx:'幻灯片、文本和图片会转换，部分版式、对象和动画可能丢失。',
}
const compoundFileHeader=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]
async function needsOfficePassword(file:File){
 if(!/\.(docx|xlsx|xlsm)$/i.test(file.name)||file.size<compoundFileHeader.length)return false
 const header=new Uint8Array(await file.slice(0,compoundFileHeader.length).arrayBuffer())
 return compoundFileHeader.every((byte,index)=>header[index]===byte)
}
export function WorkspaceUploadDialog({open,initialFiles=[],fileImports=[],readImportPromptPreferences,rememberImportPrompt,upload,onClose,loadRecent,openRecent}:WorkspaceUploadDialogProps){
 const sequence=useRef(0),locked=useRef(false)
 const mounted=useRef(false),answerPassword=useRef<((password:string|null)=>void)|null>(null)
 const answerConversion=useRef<((remember:boolean|null)=>void)|null>(null)
 const [conversionPrompt,setConversionPrompt]=useState<{file:File;target:keyof typeof conversionDetails;kind:'odf'|'legacyOffice'|'hancom'}|null>(null),[rememberConversion,setRememberConversion]=useState(false)
 const [passwordPrompt,setPasswordPrompt]=useState<{file:File;incorrect:boolean}|null>(null)
 const [password,setPassword]=useState('')
 const passwordLabel=passwordPrompt?.file.name.toLowerCase().endsWith('.docx')?'文档密码':'工作簿密码'
 useEffect(()=>{
  mounted.current=true
  return()=>{mounted.current=false;answerPassword.current?.(null);answerPassword.current=null;answerConversion.current?.(null);answerConversion.current=null}
 },[])
 useEffect(()=>{const prevent=(event:BeforeUnloadEvent)=>{if(locked.current){event.preventDefault();event.returnValue=''}};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent)},[])
 function item(file:File):UploadItem{const error=!isWorkspaceFileName(file.name,fileImports)?'不支持此格式':file.size>maxFileSize?'文件超过 32 MiB 限制':undefined;return {id:sequence.current++,file,state:error?'rejected':'queued',error}}
 const [items,setItems]=useState<UploadItem[]>(()=>initialFiles.map(item)),[busy,setBusy]=useState(false)
 const [showRecent,setShowRecent]=useState(false)
 const [recent,setRecent]=useState<RecentDocument[]|null>(null)
 const [recentError,setRecentError]=useState('')
 const [recentAttempt,setRecentAttempt]=useState(0)
 useEffect(()=>{
  if(!open||!showRecent||!loadRecent)return
  let live=true
  setRecent(null)
  setRecentError('')
  void loadRecent().then(entries=>{if(live)setRecent(entries)}).catch(()=>{
   if(live)setRecentError('无法读取最近文件，请重试。')
  })
  return()=>{live=false}
 },[loadRecent,open,recentAttempt,showRecent])
 async function selectRecent(id:string){
  if(locked.current||!openRecent)return
  locked.current=true;setBusy(true);setRecentError('')
  try{await openRecent(id);onClose()}
  catch(error){setRecentError(error instanceof Error?error.message:'无法打开最近文件，请重试。')}
  finally{locked.current=false;setBusy(false)}
 }
 const queued=items.filter(entry=>entry.state==='queued'),completed=items.filter(entry=>entry.state==='success'||entry.state==='password-required').length,failed=items.filter(entry=>entry.state==='error').length,skipped=items.filter(entry=>entry.state==='skipped').length
 function close(){if(!locked.current)onClose()}
 function requestPassword(file:File,incorrect:boolean){
  return new Promise<string|null>(resolve=>{
   answerPassword.current=resolve
   setPasswordPrompt({file,incorrect})
  })
 }
 function submitPassword(value:string|null){
  const answer=answerPassword.current
  if(!answer)return
  answerPassword.current=null
  setPassword('')
  setPasswordPrompt(null)
  answer(value)
 }
 function submitConversion(value:boolean|null){
  const answer=answerConversion.current
  answerConversion.current=null
  setConversionPrompt(null)
  setRememberConversion(false)
  answer?.(value)
 }
 async function uploadFile(file:File){
  const protectedOffice=await needsOfficePassword(file)
  if(!mounted.current)return 'skipped'
  if(!protectedOffice){await upload(file);return 'success'}
  let incorrect=false
  while(mounted.current){
   const value=await requestPassword(file,incorrect)
   if(value===null||!mounted.current)break
   try{return (await upload(file,value))??'success'}
   catch(error){if(!(error instanceof IncorrectOfficeUploadPassword))throw error;incorrect=true}
  }
  return 'skipped'
 }
 async function start(){
  if(locked.current||!queued.length)return
  locked.current=true;setBusy(true)
  let importPreferences:ImportPromptPreferences|undefined
  const update=(id:number,state:UploadItem['state'],error?:string)=>setItems(current=>current.map(entry=>entry.id===id?{...entry,state,error}:entry))
  try{for(const entry of queued){
   if(!mounted.current)break
   update(entry.id,'processing')
   try{
    const extension=entry.file.name.split('.').at(-1)?.toLowerCase()??''
    const preference=importPromptField(extension)
    const target=workspaceConversionTarget(extension)
    if(target&&preference){
     importPreferences??=await readImportPromptPreferences?.().catch(()=>({}))??{}
     if(!mounted.current)break
     if(!skipsImportPrompt(importPreferences,preference)){
      const kind=Object.hasOwn(odfConversionTargets,extension)?'odf':Object.hasOwn(hancomConversionTargets,extension)?'hancom':'legacyOffice'
      const remember=await new Promise<boolean|null>(resolve=>{answerConversion.current=resolve;setConversionPrompt({file:entry.file,target,kind})})
      if(!mounted.current)break
      if(remember===null){update(entry.id,'skipped');continue}
      if(remember){
       importPreferences={...importPreferences,[preference]:true}
       await rememberImportPrompt?.(preference).catch(()=>{})
      }
     }
    }
    const state=await uploadFile(entry.file);if(mounted.current)update(entry.id,state)
   }
   catch(error){if(mounted.current)update(entry.id,'error',error instanceof Error?error.message:'导入未完成。请核对工作区中的文件。')}
  }}finally{locked.current=false;if(mounted.current)setBusy(false)}
 }
 return <Modal className="workspace-upload-modal" title="上传文件" open={open} centered width={680} mask={{closable:false}} closable={{disabled:busy}} keyboard={!busy} onCancel={close} footer={showRecent?<Button autoInsertSpace={false} disabled={busy} onClick={close}>取消</Button>:<div className="workspace-upload-footer"><Typography.Text type="secondary">{passwordPrompt?'等待输入打开密码':conversionPrompt?'等待确认格式转换':busy?'文件正在逐个上传，请稍候':items.length?`已选择 ${items.length} 个 · 已完成 ${completed}${skipped?` · 已跳过 ${skipped}`:''}${failed?` · 未完成 ${failed}`:''}`:'支持多文件，按顺序上传'}</Typography.Text><Space><Button autoInsertSpace={false} disabled={busy} onClick={close}>{completed||failed||skipped?'完成':'取消'}</Button><Button autoInsertSpace={false} type="primary" disabled={busy||!queued.length} loading={busy&&!passwordPrompt&&!conversionPrompt} onClick={()=>void start()}>{passwordPrompt?'等待密码':conversionPrompt?'等待确认':busy?'正在上传…':`开始上传${queued.length?`（${queued.length}）`:''}`}</Button></Space></div>}>
  {loadRecent&&openRecent&&!items.length&&<div className="workspace-open-choices">
   <Space>
    <Button autoInsertSpace={false} type={showRecent?'default':'primary'} aria-pressed={!showRecent} disabled={busy} onClick={()=>setShowRecent(false)}>本地上传</Button>
    <Button autoInsertSpace={false} type={showRecent?'primary':'default'} aria-pressed={showRecent} disabled={busy} onClick={()=>setShowRecent(true)}>最近打开</Button>
   </Space>
  </div>}
  {showRecent?<section aria-label="最近打开的文件">
   {recentError&&<Alert type="error" showIcon title={recentError}/>}
   {!recent&&(recentError
    ?<Button autoInsertSpace={false} onClick={()=>setRecentAttempt(attempt=>attempt+1)}>重试</Button>
    :<Typography.Text role="status" type="secondary">正在读取最近文件…</Typography.Text>)}
   {recent?.length===0&&<Typography.Text type="secondary">暂无最近打开的文件。</Typography.Text>}
   {!!recent?.length&&<ul className="workspace-upload-list" aria-label="最近文件">
    {recent.map(entry=><li key={entry.path}>
     <Button type="text" className="workspace-recent-file" title={entry.name} disabled={busy} onClick={()=>void selectRecent(entry.path)}>
      <span className="workspace-upload-file-name">{entry.name}</span>
      {entry.locationLabel&&<span className="workspace-upload-file-meta">{entry.locationLabel}</span>}
     </Button>
    </li>)}
   </ul>}
  </section>:<>
  {passwordPrompt&&<form className="workspace-upload-password" onSubmit={event=>{event.preventDefault();if(password)submitPassword(password)}}>
   <label htmlFor="workspace-upload-password">输入 {passwordPrompt.file.name} 的{passwordLabel}</label>
   <Input.Password id="workspace-upload-password" autoFocus autoComplete="off" maxLength={255} value={password} onChange={event=>setPassword(event.target.value)} status={passwordPrompt.incorrect?'error':undefined} aria-invalid={passwordPrompt.incorrect||undefined} aria-describedby={passwordPrompt.incorrect?'workspace-upload-password-error':undefined}/>
   {passwordPrompt.incorrect&&<span className="workspace-upload-file-error" id="workspace-upload-password-error" role="alert">{passwordLabel}错误，请重试。</span>}
   <Space><Button autoInsertSpace={false} onClick={()=>submitPassword(null)}>跳过此文件</Button><Button autoInsertSpace={false} type="primary" htmlType="submit" disabled={!password}>确认密码</Button></Space>
  </form>}
  {conversionPrompt&&<section className="workspace-upload-password" aria-label={{odf:'OpenDocument 转换',legacyOffice:'旧版 Office 转换',hancom:'Hancom 转换'}[conversionPrompt.kind]} role="group">
   <Typography.Text strong>转换 {conversionPrompt.file.name}？</Typography.Text>
   <Typography.Text>工作区会创建 {conversionPrompt.target.toUpperCase()} 副本。{conversionPrompt.kind==='hancom'?'正文、表格和图片会转换，公式、脚注和嵌入对象可能丢失。':conversionDetails[conversionPrompt.target]}</Typography.Text>
   {rememberImportPrompt&&<label><input type="checkbox" aria-label="下次直接转换" checked={rememberConversion} onChange={event=>setRememberConversion(event.target.checked)}/> 下次直接转换此格式</label>}
   <Space><Button autoInsertSpace={false} onClick={()=>submitConversion(null)}>跳过此文件</Button><Button autoInsertSpace={false} type="primary" onClick={()=>submitConversion(rememberConversion)}>转换并打开</Button></Space>
  </section>}
  <Typography.Paragraph type="secondary" className="workspace-upload-intro">将本地文件添加到工作区，上传成功后在文档标签页中打开。</Typography.Paragraph>
  <div onKeyDown={event=>{if(event.key===' '&&event.target instanceof HTMLElement&&event.target.getAttribute('role')==='button'){event.preventDefault();if(!locked.current&&!event.repeat)event.target.click()}}}>
  <Upload.Dragger multiple accept={[workspaceFileAccept,...fileImports.map(format=>'.'+format)].join(',')} showUploadList={false} disabled={busy} beforeUpload={file=>{if(!locked.current)setItems(current=>[...current,item(file)]);return Upload.LIST_IGNORE}}>
   <span className="workspace-upload-drop-icon"><CloudUploadOutlined/></span>
   <span className="workspace-upload-drop-title">点击选择文件，或拖拽到这里</span>
   <span className="workspace-upload-drop-hint">支持 Word、Excel、PowerPoint 和 PDF · 单个文件最大 32 MiB</span>
   <span className="workspace-upload-formats"><Tag>DOCX</Tag><Tag>XLSX</Tag><Tag>PPTX</Tag><Tag>PDF</Tag>{fileImports.map(format=>{
    const target=workspaceConversionTarget(format)
    return <Tag key={format}>{format.toUpperCase()}{target&&` 转 ${target.toUpperCase()}`}</Tag>
   })}</span>
  </Upload.Dragger>
  </div>
  {items.length>0&&<><div className="workspace-upload-list-heading"><Typography.Text strong>文件列表</Typography.Text><Typography.Text type="secondary">{items.length} 个文件</Typography.Text></div><ul className="workspace-upload-list" aria-label="待上传文件">{items.map(entry=>{
   const extension=entry.file.name.split('.').pop()?.toLowerCase()??''
   const format=(workspaceConversionTarget(extension)??extension) as keyof typeof formatIcons,Icon=formatIcons[format]??FileOutlined
   return <li key={entry.id} className={`workspace-upload-item is-${entry.state}`}><span className={`workspace-upload-file-icon format-${format}`}><Icon/></span><div className="workspace-upload-file-detail"><span className="workspace-upload-file-name" title={entry.file.name}>{entry.file.name}</span><span className="workspace-upload-file-meta">{sizeLabel(entry.file.size)}<span className="workspace-upload-item-state">{entry.state==='queued'?'等待上传':entry.state==='processing'?passwordPrompt?.file===entry.file?'等待密码':<><LoadingOutlined/> 正在上传并打开…</>:entry.state==='success'?<><CheckCircleFilled/> 已上传并打开</>:entry.state==='password-required'?'已上传，请在编辑器中解锁':entry.state==='skipped'?'已跳过':entry.state==='rejected'?'无法上传':<><CloseCircleFilled/> 导入未完成</>}</span></span>{entry.error&&<span className="workspace-upload-file-error">{entry.error}</span>}</div>{!busy&&(entry.state==='queued'||entry.state==='rejected')&&<Button type="text" icon={<DeleteOutlined/>} aria-label={`移除 ${entry.file.name}`} onClick={()=>setItems(current=>current.filter(value=>value.id!==entry.id))}/>}</li>
  })}</ul></>}
  {!!failed&&<Alert className="workspace-upload-warning" type="warning" showIcon title="部分文件未完成导入" description="请先核对工作区，确认文件是否已上传，再决定后续操作。"/>}
  <p className="workspace-upload-note">文件按顺序处理。上传期间请保持此窗口打开。</p>
  </>}
 </Modal>
}
