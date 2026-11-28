type WorkspacePdfPicker=(signal:AbortSignal)=>Promise<File|null>

function selectPdfSource(titleText:string,hintText:string,confirmText:string,signal?:AbortSignal,english=false,pickWorkspace?:WorkspacePdfPicker):Promise<File|null>{
 signal?.throwIfAborted()
 const dialog=document.createElement('dialog')
 dialog.className='pdf-modal'
 dialog.setAttribute('aria-label',titleText)
 const form=document.createElement('form')
 const title=document.createElement('div')
 title.className='pdf-modal-title'
 title.textContent=titleText
 const hint=document.createElement('p')
 hint.className='pdf-modal-hint'
 hint.textContent=hintText
 const input=document.createElement('input')
 input.type='file'
 input.accept='application/pdf,.pdf'
 input.setAttribute('aria-label',english?'Choose source PDF':'选择来源 PDF')
 const error=document.createElement('p')
 error.setAttribute('role','alert')
 error.hidden=true
 const sourceName=document.createElement('p')
 sourceName.className='pdf-modal-hint'
 sourceName.setAttribute('role','status')
 sourceName.hidden=true
 const workspace=pickWorkspace?document.createElement('button'):undefined
 if(workspace){
  workspace.type='button'
  workspace.className='pdf-modal-btn'
  workspace.textContent=english?'Choose from workspace…':'从工作区选择…'
 }
 const actions=document.createElement('div')
 actions.className='pdf-modal-actions'
 const cancel=document.createElement('button')
 cancel.type='button'
 cancel.className='pdf-modal-btn'
 cancel.textContent=english?'Cancel':'取消'
 const confirm=document.createElement('button')
 confirm.type='submit'
 confirm.className='pdf-modal-btn primary'
 confirm.textContent=confirmText
 confirm.disabled=true
 actions.append(cancel,confirm)
 form.append(title,hint,input)
 if(workspace)form.append(workspace,sourceName)
 form.append(error,actions)
 dialog.append(form)
 return new Promise((resolve,reject)=>{
  let selected:File|null=null
  const lifetime=new AbortController()
  const finish=(file:File|null)=>{
   if(lifetime.signal.aborted)return
   lifetime.abort()
   signal?.removeEventListener('abort',abort)
   dialog.close()
   dialog.remove()
   resolve(file)
  }
  const abort=()=>finish(null)
  const select=(file?:File,fromWorkspace=false)=>{
   selected=file&&/\.pdf$/i.test(file.name)&&file.size>0&&file.size<=64*1024*1024?file:null
   confirm.disabled=!selected
   sourceName.textContent=fromWorkspace&&selected?selected.name:''
   sourceName.hidden=!sourceName.textContent
   error.hidden=!file||!!selected
   error.textContent=english?'Choose a PDF file up to 64 MiB.':'请选择不超过 64 MiB 的 PDF 文件。'
  }
  input.onchange=()=>select(input.files?.[0])
  if(workspace&&pickWorkspace)workspace.onclick=async()=>{
   workspace.disabled=input.disabled=confirm.disabled=true
   error.hidden=true
   try{
    const source=await pickWorkspace(lifetime.signal)
    if(source&&!lifetime.signal.aborted){
     input.value=''
     select(source,true)
    }
   }catch(cause){
    if(!lifetime.signal.aborted){
     error.textContent=cause instanceof Error?cause.message:(english?'Could not read the selected PDF.':'无法读取所选 PDF。')
     error.hidden=false
    }
   }finally{
    if(!lifetime.signal.aborted){
     workspace.disabled=input.disabled=false
     confirm.disabled=!selected
     workspace.focus()
    }
   }
  }
  cancel.onclick=()=>finish(null)
  dialog.oncancel=event=>{event.preventDefault();finish(null)}
  form.onsubmit=event=>{event.preventDefault();if(selected&&!confirm.disabled)finish(selected)}
  document.body.append(dialog)
  try{dialog.showModal()}catch(error){dialog.remove();reject(error);return}
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)abort()
 })
}

export function selectReplacementPdf(pages:readonly number[],signal?:AbortSignal,language='zh',pickWorkspace?:WorkspacePdfPicker):Promise<File|null>{
 if(language==='en'){
  return selectPdfSource(`Replace pages ${pages.join(', ')}`,'All pages from the source PDF will be inserted at the first selected position and saved as a new version.','Replace and save',signal,true,pickWorkspace)
 }
 return selectPdfSource(`替换第 ${pages.join('、')} 页`,'来源 PDF 的全部页面将插入首个被替换的位置，确认后保存为新版本。','确认替换并保存',signal,false,pickWorkspace)
}

export function selectPdfToInsert(afterPageIndex:number,signal?:AbortSignal,language='zh',pickWorkspace?:WorkspacePdfPicker):Promise<File|null>{
 if(language==='en'){
  const position=afterPageIndex===-1?'before the first page':`after page ${afterPageIndex+1}`
  return selectPdfSource('Import PDF pages',`All pages from the source PDF will be inserted ${position} and saved as a new version.`,'Import and save',signal,true,pickWorkspace)
 }
 const position=afterPageIndex===-1?'第一页之前':`第 ${afterPageIndex+1} 页之后`
 return selectPdfSource('导入 PDF 页面',`来源 PDF 的全部页面将插入${position}，并保存为新版本。`,'确认导入并保存',signal,false,pickWorkspace)
}
