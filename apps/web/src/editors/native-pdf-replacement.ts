function selectPdfSource(titleText:string,hintText:string,confirmText:string,signal?:AbortSignal):Promise<File|null>{
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
 input.setAttribute('aria-label','选择来源 PDF')
 const error=document.createElement('p')
 error.setAttribute('role','alert')
 error.hidden=true
 const actions=document.createElement('div')
 actions.className='pdf-modal-actions'
 const cancel=document.createElement('button')
 cancel.type='button'
 cancel.className='pdf-modal-btn'
 cancel.textContent='取消'
 const confirm=document.createElement('button')
 confirm.type='submit'
 confirm.className='pdf-modal-btn primary'
 confirm.textContent=confirmText
 confirm.disabled=true
 actions.append(cancel,confirm)
 form.append(title,hint,input,error,actions)
 dialog.append(form)
 return new Promise((resolve,reject)=>{
  let selected:File|null=null
  const finish=(file:File|null)=>{
   signal?.removeEventListener('abort',abort)
   dialog.close()
   dialog.remove()
   resolve(file)
  }
  const abort=()=>finish(null)
  input.onchange=()=>{
   const file=input.files?.[0]
   selected=file&&/\.pdf$/i.test(file.name)&&file.size>0&&file.size<=64*1024*1024?file:null
   confirm.disabled=!selected
   error.hidden=!file||!!selected
   error.textContent='请选择不超过 64 MiB 的 PDF 文件。'
  }
  cancel.onclick=()=>finish(null)
  dialog.oncancel=event=>{event.preventDefault();finish(null)}
  form.onsubmit=event=>{event.preventDefault();if(selected)finish(selected)}
  document.body.append(dialog)
  try{dialog.showModal()}catch(error){dialog.remove();reject(error);return}
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)abort()
 })
}

export function selectReplacementPdf(pages:readonly number[],signal?:AbortSignal):Promise<File|null>{
 return selectPdfSource(`替换第 ${pages.join('、')} 页`,'来源 PDF 的全部页面将插入首个被替换的位置，确认后保存为新版本。','确认替换并保存',signal)
}

export function selectPdfToInsert(afterPageIndex:number,signal?:AbortSignal):Promise<File|null>{
 return selectPdfSource('导入 PDF 页面',`来源 PDF 的全部页面将插入第 ${afterPageIndex+1} 页之后，并保存为新版本。`,'确认导入并保存',signal)
}
