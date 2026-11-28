import {workbookExportCsvRequestSchema,type WorkbookExportCsvRequest,type WorkbookExportCsvResult,type WorkbookCreateDocumentRequest,type WorkbookCreateDocumentResult} from '../../../sheets/src/shared/desktop-api'

type CreateApi={createDocument:(input:WorkbookCreateDocumentRequest)=>Promise<WorkbookCreateDocumentResult>}
type CsvRequest={type:'csv';title:string;content:string}
type CsvChoice='csv'|'xlsx'|'cancel'
type DownloadPlatform={document:Pick<Document,'createElement'|'body'>;url:Pick<typeof URL,'createObjectURL'|'revokeObjectURL'>;schedule?:(callback:()=>void)=>unknown}
const csvTitle=(title:string)=>title.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim().slice(0,120).trim()||'Untitled'

function chooseCsvExport(message:string,language:string,hasFormulas:boolean):Promise<CsvChoice>{
 const dialog=document.createElement('dialog')
 dialog.className='web-csv-export-dialog'
 const copy=document.createElement('p');copy.textContent=message
 const actions=document.createElement('div');actions.className='web-csv-export-actions'
 const choices:CsvChoice[]=hasFormulas?['xlsx','csv','cancel']:['csv','cancel']
 const labels=language==='en'?{xlsx:'Save as .xlsx',csv:'Continue as CSV',cancel:'Cancel'}:{xlsx:'另存为 .xlsx',csv:'继续保存为 CSV',cancel:'取消'}
 return new Promise(resolve=>{
  let settled=false
  const finish=(choice:CsvChoice)=>{if(settled)return;settled=true;dialog.close();dialog.remove();resolve(choice)}
  for(const choice of choices){const button=document.createElement('button');button.type='button';button.textContent=labels[choice];button.addEventListener('click',()=>finish(choice));actions.append(button)}
  dialog.append(copy,actions)
  dialog.addEventListener('cancel',event=>{event.preventDefault();finish('cancel')},{once:true})
  dialog.addEventListener('close',()=>finish('cancel'),{once:true})
  document.body.append(dialog)
  dialog.showModal()
  actions.querySelector('button')?.focus()
 })
}

export function confirmWebCsvSave(language:string,offerCopy:boolean):Promise<CsvChoice>{
 const message=language==='en'
  ? 'Keep this file in CSV format? CSV saves the current sheet’s values. Formulas, formatting, and other sheets are lost.'
  : '保留 CSV 格式？CSV 仅保存当前工作表的值，公式、格式和其他工作表会丢失。'
 return chooseCsvExport(message,language,offerCopy)
}

export function downloadWebCsv(input:CsvRequest,platform:DownloadPlatform={document,url:URL}){
 const title=csvTitle(input.title)
 const blob=new Blob([input.content],{type:'text/csv;charset=utf-8'})
 const url=platform.url.createObjectURL(blob),anchor=platform.document.createElement('a')
 anchor.href=url;anchor.download=`${title}.csv`;anchor.hidden=true
 platform.document.body.append(anchor);anchor.click();anchor.remove()
 ;(platform.schedule??(callback=>setTimeout(callback,0)))(()=>platform.url.revokeObjectURL(url))
}

export function createWebWorkbookDocumentApi<T extends CreateApi>(base:T,createCsv:(input:CsvRequest)=>Promise<void>,{language='zh',confirmCsvExport=(message:string)=>window.confirm(message),chooseCsvExport:choose=chooseCsvExport}:{language?:string;confirmCsvExport?:(message:string)=>boolean;chooseCsvExport?:(message:string,language:string,hasFormulas:boolean)=>Promise<CsvChoice>}={}){
 return {
  ...base,
  async exportCsv(input:WorkbookExportCsvRequest):Promise<WorkbookExportCsvResult>{
   const request=workbookExportCsvRequestSchema.parse(input)
   if(request.targetPath!==undefined)throw new Error('Desktop paths are unavailable in the Web editor.')
   const warning=language==='en'
    ? `CSV loses formatting.${request.hasFormulas?' Formulas will be exported as values.':''}${request.activeSheetName?` Only the active sheet (${request.activeSheetName}) will be exported.`:''} Continue downloading CSV?`
    : `CSV 不保留格式。${request.hasFormulas?'公式将导出为计算后的数值。':''}${request.activeSheetName?`仅导出当前工作表（${request.activeSheetName}）。`:''}是否继续下载 CSV？`
   const choice=request.hasFormulas?await choose(warning,language,true):confirmCsvExport(warning)?'csv':'cancel'
   if(choice==='cancel')return {canceled:true}
   if(choice==='xlsx')return {canceled:true,saveAsXlsxInstead:true}
   const title=csvTitle(request.fileName.replace(/\.csv$/i,''))
   await createCsv({type:'csv',title,content:'\uFEFF'+request.content})
   return {canceled:false,path:`${title}.csv`}
  },
  async createDocument(input:WorkbookCreateDocumentRequest):Promise<WorkbookCreateDocumentResult>{
   if(input.type==='csv'){
    if(typeof input.title!=='string'||typeof input.content!=='string')return {ok:false,error:'Invalid CSV export request.'}
    try{await createCsv({type:'csv',title:input.title,content:input.content});return {ok:true,downloaded:true}}
    catch(error){return {ok:false,error:error instanceof Error?error.message:'CSV export failed.'}}
   }
   return base.createDocument(input)
  },
 }
}
