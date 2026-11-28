import {PDFName} from '../../../../pdf/src/shared/pdf-lib.ts'
import {openEditablePdf} from './editable-document.mjs'
import {capturePdfManagedStamps} from './stamps-job.mjs'
import {REDACT_PATTERNS,findPattern} from '../../../../pdf/src/renderer/redact-patterns.ts'
import {pdfRectToCss} from '../../../../pdf/src/renderer/annotations.ts'
import {validateRedactionRegions} from '../../../../pdf/src/main/redaction.ts'
import {fail,hash} from './job-common.mjs'
const MAX=64*1024*1024
const check=signal=>{if(signal?.aborted)fail('ABORTED')}
export const pdfRedactionsSafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_REDACTION','PDF_REDACTION_STALE_SELECTION','PDF_REDACTION_TRUNCATED','PDF_REDACTION_REFUSED','PDF_REDACTION_VERIFY_FAILED','PDF_STAMP_INTEGRITY_FAILED','OUTPUT_LIMIT'])
export function validatePdfRedactionPatterns(input=REDACT_PATTERNS){
 if(!Array.isArray(input)||input.length<1||input.length>6||input.some(value=>!REDACT_PATTERNS.includes(value)))fail('INVALID_PDF_REDACTION')
 return [...new Set(input)].sort()
}
export function parsePdfRedactionsRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>65536)fail('INVALID_REQUEST')
 let value;try{value=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 const copy=value?.action==='redactedCopy',allowed=copy?['version','action','revision','patterns','ids','regions']:['version','action','revision','patterns']
 if(!value||Object.keys(value).some(key=>!allowed.includes(key))||value.version!==1||!['redactionsQuery','redactedCopy'].includes(value.action)||typeof value.revision!=='string'||!/^[a-f0-9-]{36}$/i.test(value.revision))fail('INVALID_REQUEST')
 if(copy&&'regions'in value){
  if('ids'in value||'patterns'in value)fail('INVALID_PDF_REDACTION')
  try{return {revision:value.revision,regions:validateRedactionRegions(value.regions)}}catch{fail('INVALID_PDF_REDACTION')}
 }
 const patterns=validatePdfRedactionPatterns(value.patterns)
 if(copy&&(!Array.isArray(value.ids)||!value.ids.length||value.ids.length>500||value.ids.some(id=>typeof id!=='string'||! /^[a-f0-9]{64}$/.test(id))||new Set(value.ids).size!==value.ids.length))fail('INVALID_PDF_REDACTION')
 return {revision:value.revision,patterns,...(copy?{ids:value.ids}:{})}
}
async function nativeCharacters(bytes,signal){
 const {chainPdfium,loadPdfium,withDocument}=await import('../../../../pdf/src/main/text-edit.ts')
 return chainPdfium(async()=>{const m=await loadPdfium();return withDocument(m,bytes,async doc=>{
  const pages=[];let total=0
  for(let pageIndex=0;pageIndex<m._FPDF_GetPageCount(doc);pageIndex++){
   check(signal);const page=m._FPDF_LoadPage(doc,pageIndex);if(!page)fail('UNREADABLE')
   const tp=m._FPDFText_LoadPage(page),ptr=m._malloc(32)
   try{
    if(!tp)fail('UNREADABLE');const count=m._FPDFText_CountChars(tp);if(count<0||count>200000||(total+=count)>1000000)fail('PDF_EDIT_LIMIT')
    let text='';const chars=[]
    for(let i=0;i<count;i++){
     const cp=m._FPDFText_GetUnicode(tp,i);if(!Number.isSafeInteger(cp)||cp<0||cp>0x10ffff)fail('UNREADABLE')
     const char=cp?String.fromCodePoint(cp):'\ufffd',start=text.length;text+=char
     const valid=m._FPDFText_GetCharBox(tp,i,ptr,ptr+8,ptr+16,ptr+24),angle=m._FPDFText_GetCharAngle(tp,i),box=valid?[m.HEAPF64[ptr>>3],m.HEAPF64[(ptr+16)>>3],m.HEAPF64[(ptr+8)>>3],m.HEAPF64[(ptr+24)>>3]]:null
     const object=m._FPDFText_GetTextObject(tp,i),invisible=!!object&&m._FPDFTextObj_GetTextRenderMode(object)===3
     chars.push({start,end:text.length,box,angle,invisible})
    }
    pages.push({text,chars})
   }finally{m._free(ptr);if(tp)m._FPDFText_ClosePage(tp);m._FPDF_ClosePage(page)}
  }
  return pages
 })})
}
async function query(bytes,request,signal){
 const doc=await openEditablePdf(bytes),pages=await nativeCharacters(bytes,signal),candidates=[],unsupportedPages=[],scannedPages=[],inputSha256=hash(bytes);let truncated=false
 for(let pageIndex=0;pageIndex<pages.length;pageIndex++){
  scannedPages.push(pageIndex+1);const {text,chars}=pages[pageIndex],matches=new Map(),page=doc.getPage(pageIndex),crop=page.getCropBox(),media=page.getMediaBox(),x0=Math.max(crop.x,media.x),y0=Math.max(crop.y,media.y),x1=Math.min(crop.x+crop.width,media.x+media.width),y1=Math.min(crop.y+crop.height,media.y+media.height),userUnit=page.node.lookup(PDFName.of('UserUnit'))?.asNumber?.()??1,rot=((page.getRotation().angle%360)+360)%360
  if(![x0,y0,x1,y1,userUnit].every(Number.isFinite)||x1<=x0||y1<=y0||userUnit<=0||![0,90,180,270].includes(rot))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  const geom={x0,y0,pw:(x1-x0)*userUnit,ph:(y1-y0)*userUnit,userUnit,rot}
  for(const pattern of request.patterns)for(const [start,end]of findPattern(pattern,text))matches.set(`${start}:${end}`,{start,end})
  for(const {start,end}of [...matches.values()].sort((a,b)=>a.start-b.start||a.end-b.end)){
   const selected=chars.filter(char=>char.end>start&&char.start<end&&text.slice(char.start,char.end).trim()),boxes=selected.map(char=>char.box)
   if(!selected.length||selected.some(char=>char.invisible||!char.box||!char.box.every(Number.isFinite)||char.box[2]<=char.box[0]||char.box[3]<=char.box[1]||Math.abs(char.angle)>1e-5)||/\r|\n/.test(text.slice(start,end))){unsupportedPages.push(pageIndex+1);continue}
   const rect=[Math.min(...boxes.map(box=>box[0])),Math.min(...boxes.map(box=>box[1])),Math.max(...boxes.map(box=>box[2])),Math.max(...boxes.map(box=>box[3]))],height=Math.max(...boxes.map(box=>box[3]-box[1]))
   if(rect[3]-rect[1]>height*1.5||rect[0]<x0||rect[1]<y0||rect[2]>x1||rect[3]>y1){unsupportedPages.push(pageIndex+1);continue}
   if(candidates.length===500){truncated=true;continue}
   const id=hash(Buffer.from(`${request.revision}:${inputSha256}:${pageIndex}:${start}:${end}`))
   candidates.push({id,page:pageIndex+1,text:text.slice(start,end),rect,displayRect:pdfRectToCss(geom,rect,1)})
  }
 }
 return {revision:request.revision,candidates,truncated,scannedPages,unsupportedPages:[...new Set(unsupportedPages)]}
}
async function independentSelectedText(bytes,pages){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true,isEvalSupported:false})
 try{const doc=await task.promise,result=new Map();for(const page of pages){const content=await (await doc.getPage(page)).getTextContent();result.set(page,content.items.map(item=>typeof item.str==='string'?item.str:'').join(''))}return result}finally{await task.destroy()}
}
const occurrences=(text,needle)=>{let count=0,index=0;while((index=text.indexOf(needle,index))>=0){count++;index+=needle.length}return count}
const intersects=(a,b)=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1]
export function createPdfRedactionsJob(action){
 if(!['redactionsQuery','redactedCopy'].includes(action))fail('INVALID_REQUEST')
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY');if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX)fail('INPUT_LIMIT')
  const request=parsePdfRedactionsRequest(raw),original=Buffer.from(input);if((action==='redactedCopy')!==('ids'in request||'regions'in request))fail('INVALID_REQUEST');busy=true
  try{
   const report=request.regions?null:await query(original,request,signal);check(signal)
   if(action==='redactionsQuery'){const bytes=Buffer.from(JSON.stringify(report));return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}}
   if(report?.truncated)fail('PDF_REDACTION_TRUNCATED')
   const selected=request.ids?.map(id=>report.candidates.find(candidate=>candidate.id===id))??[];if(selected.some(value=>!value))fail('PDF_REDACTION_STALE_SELECTION')
   const doc=await openEditablePdf(original)
   const regions=request.regions??selected.map(candidate=>({pageIndex:candidate.page-1,rect:candidate.rect}))
   if(request.regions)for(const {pageIndex,rect} of regions){
    if(pageIndex>=doc.getPageCount())fail('INVALID_PDF_REDACTION')
    const page=doc.getPage(pageIndex),crop=page.getCropBox(),media=page.getMediaBox(),[x0,y0,x1,y1]=rect
    if(x0>=x1||y0>=y1||x0<Math.max(crop.x,media.x)||y0<Math.max(crop.y,media.y)||x1>Math.min(crop.x+crop.width,media.x+media.width)||y1>Math.min(crop.y+crop.height,media.y+media.height))fail('INVALID_PDF_REDACTION')
   }
   // Validate stamp integrity, then detach metadata before the final native cleanup.
   // Reapplying a managed overlay afterwards could reintroduce the redacted text.
   await capturePdfManagedStamps(original)
   for(const page of doc.getPages())page.node.delete(PDFName.of('DyOfficeStamps'))
   const working=Buffer.from(await doc.save({useObjectStreams:false,addDefaultPage:false})),{applySaveRequest}=await import('../../../../pdf/src/main/save-pdf.ts')
   let applied;try{applied=await applySaveRequest(working,{formValues:[],markups:[],drawings:[],rotations:[],redactions:regions})}catch{fail('PDF_REDACTION_REFUSED')}
   const bytes=Buffer.from(applied.bytes);check(signal);if(bytes.length>MAX)fail('OUTPUT_LIMIT')
   const after=await nativeCharacters(bytes,signal);if(after.length!==doc.getPageCount())fail('PDF_REDACTION_VERIFY_FAILED')
   for(const {pageIndex,rect} of regions){const page=after[pageIndex];if(page.chars.some(char=>char.box&&intersects(rect,char.box)&&page.text.slice(char.start,char.end).trim()))fail('PDF_REDACTION_VERIFY_FAILED')}
   const pageNumbers=[...new Set(selected.map(candidate=>candidate.page))],beforeText=await independentSelectedText(original,pageNumbers),afterText=await independentSelectedText(bytes,pageNumbers),groups=new Map()
   for(const candidate of selected){const key=JSON.stringify([candidate.page,candidate.text]),previous=groups.get(key);groups.set(key,{page:candidate.page,text:candidate.text,count:(previous?.count??0)+1})}
   for(const group of groups.values()){const count=occurrences(beforeText.get(group.page),group.text);if(count<group.count||occurrences(afterText.get(group.page),group.text)>count-group.count)fail('PDF_REDACTION_VERIFY_FAILED')}
   check(signal)
   return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfRedactionsSafetyCodes.has(error?.code))throw error;fail('NATIVE_FAILED')}finally{busy=false}
 }}
}
