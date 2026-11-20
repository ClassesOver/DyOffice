import {editorCapabilityKey,readOpenDocument} from './document-entry-reader'
import type {createDocumentTabs} from './document-tabs'
type Request = <T=unknown>(path:string,method?:string,body?:unknown)=>Promise<T>
/** Only formats with an implemented creation path, never just any editable claim. */
export function localNewFormats(capabilities:Record<string,string>):string[]{
 return ['docx','xlsx','pptx','pdf'].filter(format=>capabilities[editorCapabilityKey(format)]==='editable')
}
type LocalNewDeps={getSessionProof:()=>string|undefined;bindSession:(expectedProof:string)=>Promise<{request:Request}>;open:(id:string,request:Request)=>Promise<void>;changed:()=>void}
type LocalNewTemplateDeps=LocalNewDeps&{fetchTemplate:()=>Promise<Response>}
function createLocalNew(format:'xlsx'|'pptx'|'pdf',busyMessage:string,unsupportedMessage:string,deps:LocalNewDeps,template?:{name:string;fetch:()=>Promise<Response>}){
 let pending=false,unknown=false
 const uncertain=()=>new Error('无法确认上次创建结果，请刷新最近文件核对，不要重复创建；重新加载工作区后再试。')
 return async()=>{
  if(unknown)throw uncertain()
  if(pending)throw new Error(busyMessage)
  pending=true
  try{
   // Pin all writes to the initiating account, including after template loading.
   const proof=deps.getSessionProof()
   if(!proof)throw new Error('登录状态未核验，请重新加载当前工作区。')
   const bound=await deps.bindSession(proof)
   const capabilityKey=editorCapabilityKey(format)
   const requireEditable=async()=>{if((await bound.request<Record<string,string>>('/api/v1/capabilities'))[capabilityKey]!=='editable')throw new Error(unsupportedMessage)}
   await requireEditable()
   let endpoint='/api/v1/files/new-pdf'
   if(template){
    const response=await template.fetch()
    if(!response.ok)throw new Error('原版空白模板不可用')
    const file=new File([await response.arrayBuffer()],template.name)
    if(!file.size||file.size>32*1024*1024)throw new Error('原版空白模板无效')
    await requireEditable()
    const stage=await bound.request<{uploadId:string}>('/api/v1/files/uploads','POST',{name:file.name,size:file.size})
    const upload='/api/v1/uploads/'+encodeURIComponent(stage.uploadId)
    await bound.request(upload+'/content','PUT',file)
    endpoint=upload+'/finish'
   }
   let id:string
   try{
    const result=await bound.request<{file:{fileId:string}}>(endpoint,'POST')
    if(!result?.file?.fileId)throw new Error('Invalid creation receipt')
    id=result.file.fileId
   }catch(error){
    const status=(error as {status?:number}).status
    if(status===undefined||status===408||status>=500){unknown=true;deps.changed();throw uncertain()}
    throw error
   }
   deps.changed()
   try{await deps.open(id,bound.request)}catch{throw new Error('文件已创建，但打开失败。请从最近文件中打开，不要重复创建。')}
  }finally{pending=false}
 }
}
export function createLocalNewSheet(deps:LocalNewTemplateDeps){
 return createLocalNew('xlsx','正在创建电子表格，请稍候。','当前运行环境未启用安全的 XLSX 编辑，暂不支持新建。',deps,{name:'未命名.xlsx',fetch:deps.fetchTemplate})
}
export function createLocalNewSlide(deps:LocalNewTemplateDeps){
 return createLocalNew('pptx','正在创建演示文稿，请稍候。','当前运行环境未启用安全的 PPTX 编辑，暂不支持新建。',deps,{name:'未命名.pptx',fetch:deps.fetchTemplate})
}
export function createLocalNewPdf(deps:LocalNewDeps){
 return createLocalNew('pdf','正在创建 PDF，请稍候。','当前运行环境未启用 PDF 编辑，暂不支持新建。',deps)
}

/** Reuse entry validation and navigation tokens without replacing the issuing session. */
export async function openCreatedDocument(tabs:ReturnType<typeof createDocumentTabs>,capabilities:Record<string,string>,id:string,request:Request){
 const token=tabs.reserveOpen(id)
 const document=await readOpenDocument({bound:{request}},capabilities,id)
 tabs.open(document,token)
}
