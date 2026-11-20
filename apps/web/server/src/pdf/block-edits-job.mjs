import {preservePdfManagedStamps} from './stamps-job.mjs'
import {createHash} from 'node:crypto'
import {openEditablePdf} from './editable-document.mjs'
import {pdfjsDocumentParams} from './pdfjs-open.mjs'
import {groupPageBlocks,reflowOverflows} from '../../../../pdf/src/renderer/text-block.ts'
import {joinBlockLines,wrapTextMeasured} from '../../../../pdf/src/renderer/text-wrap.ts'
const MAX_BYTES=64*1024*1024
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const keys=['page','paragraph_text','new_text','font_size','color','font','bold','italic','align']
function fail(code){throw Object.assign(new Error(code),{code})}
function check(signal){if(signal?.aborted)fail('ABORTED')}
export const pdfBlockEditsSafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_BLOCK_EDIT','PDF_BLOCK_NOT_FOUND','PDF_BLOCK_AMBIGUOUS','PDF_BLOCK_OVERLAP','PDF_BLOCK_REFUSED','PDF_BLOCK_FONT_UNAVAILABLE','PDF_TEXT_VERIFY_FAILED','OUTPUT_LIMIT'])
export function validatePdfBlockEditOperations(input){
 if(!Array.isArray(input)||input.length<1||input.length>20||Reflect.ownKeys(input).length!==input.length+1)fail('INVALID_PDF_BLOCK_EDIT')
 const result=[]
 for(let index=0;index<input.length;index++){
  const descriptor=Object.getOwnPropertyDescriptor(input,String(index));if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)fail('INVALID_PDF_BLOCK_EDIT')
  const op=descriptor.value
  if(!op||typeof op!=='object'||Array.isArray(op)||![Object.prototype,null].includes(Object.getPrototypeOf(op)))fail('INVALID_PDF_BLOCK_EDIT')
  for(const key of Reflect.ownKeys(op)){const d=Object.getOwnPropertyDescriptor(op,key);if(!keys.includes(key)||!d||!('value'in d)||!d.enumerable)fail('INVALID_PDF_BLOCK_EDIT')}
  if(!Number.isSafeInteger(op.page)||op.page<1||op.page>100||typeof op.paragraph_text!=='string'||!op.paragraph_text.trim()||op.paragraph_text.length>2000||typeof op.new_text!=='string'||op.new_text.length>10000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(op.paragraph_text+op.new_text))fail('INVALID_PDF_BLOCK_EDIT')
  if(('font_size'in op&&(typeof op.font_size!=='number'||!Number.isFinite(op.font_size)||op.font_size<=0||op.font_size>1000))||('align'in op&&!['left','center','right'].includes(op.align))||('font'in op&&!['arial','times','courier'].includes(op.font))||('color'in op&&(typeof op.color!=='string'||!/^#?[a-f0-9]{6}$/i.test(op.color))))fail('INVALID_PDF_BLOCK_EDIT')
  for(const key of ['bold','italic'])if(key in op&&typeof op[key]!=='boolean')fail('INVALID_PDF_BLOCK_EDIT')
  result.push(Object.freeze({...op,paragraph_text:op.paragraph_text.trim(),new_text:op.new_text.replace(/\r\n/g,'\n').trim()}))
 }
 return Object.freeze(result)
}
export function parsePdfBlockEditsRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST')
 if(Buffer.byteLength(raw)>1024*1024)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!request||Array.isArray(request)||Object.keys(request).sort().join(',')!=='action,operations,version'||request.version!==1||request.action!=='blockEdits')fail('INVALID_REQUEST')
 return validatePdfBlockEditOperations(request.operations)
}
export function indexPdfBlockPage(content){
 let text='',items=[]
 for(const item of content.items){
  if(typeof item.str!=='string')continue
  if(text.length+item.str.length>1000000)fail('PDF_EDIT_LIMIT')
  if(item.str){if(item.transform){const h=item.height||Math.hypot(item.transform[2]??0,item.transform[3]??0);if(![...item.transform,item.width,h].every(Number.isFinite))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE');items.push({start:text.length,end:text.length+item.str.length,x:item.transform[4]??0,y:item.transform[5]??0,w:item.width??0,h,rot:Math.abs(item.transform[1]??0)>h*0.001,font:item.fontName})}text+=item.str}
  if(item.hasEOL)text+='\n'
 }
 return {text,lower:text.toLowerCase(),items}
}
function measurement(layout,source){
 const sourcePositions=[],layoutPositions=[]
 for(let i=0;i<source.length;i++)if(!/\s/.test(source[i]))sourcePositions.push(i)
 for(let i=0;i<layout.text.length;i++)if(!/\s/.test(layout.text[i]))layoutPositions.push(i)
 if(sourcePositions.length!==layoutPositions.length)fail('PDF_BLOCK_REFUSED')
 const retained=layout.retained.map(run=>{
  const first=layoutPositions.findIndex(position=>position>=run.start),last=layoutPositions.findLastIndex(position=>position<run.end)
  if(first<0||last<first)fail('PDF_BLOCK_REFUSED')
  return {...run,start:sourcePositions[first],end:sourcePositions[last]+1}
 }).sort((a,b)=>a.start-b.start)
 return (text,start)=>{
  const end=start+text.length,chunks=retained.filter(run=>run.start>=start&&run.end<=end)
  let k=start,width=0,previous=null
  const advance=char=>{const width=layout.advances[char];if(width===null||width===undefined)fail('PDF_BLOCK_FONT_UNAVAILABLE');return width}
  for(const run of chunks){
   for(const char of source.slice(k,run.start))width+=advance(char)
   if(previous&&Math.abs(run.y-previous.run.y)<0.5&&run.x>previous.run.x&&/^\s*$/.test(source.slice(previous.run.end,run.start)))width=previous.placed+run.x-previous.run.x
   previous={run,placed:width};width+=run.width;k=run.end
  }
  for(const char of source.slice(k,end))width+=advance(char)
  return width
 }
}
export async function planPdfBlockEdits(bytes,operations,signal){
 const {measureTextEditLayout,listEditFonts,validateTextEdits}=await import('../../../../pdf/src/main/text-edit.ts')
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
 const task=getDocument(pdfjsDocumentParams(bytes))
 try{
  const doc=await task.promise,pages=new Map(),targets=[],claimed=new Set();check(signal)
  for(const op of operations){
   if(op.page>doc.numPages)fail('INVALID_PDF_BLOCK_EDIT')
   if(op.font&&!listEditFonts().includes(op.font))fail('PDF_BLOCK_FONT_UNAVAILABLE')
   let entry=pages.get(op.page)
   if(!entry){const page=await doc.getPage(op.page);entry={page,blocks:groupPageBlocks(indexPdfBlockPage(await page.getTextContent()))};pages.set(op.page,entry)}
   const squash=text=>text.replace(/\s+/g,''),hits=entry.blocks.filter(block=>squash(block.lines.map(line=>line.text).join('')).includes(squash(op.paragraph_text)))
   if(hits.length===0)fail('PDF_BLOCK_NOT_FOUND');if(hits.length!==1)fail('PDF_BLOCK_AMBIGUOUS')
   const block=hits[0],id=op.page+':'+JSON.stringify(block.rect)
   if(claimed.has(id))fail('PDF_BLOCK_OVERLAP');claimed.add(id)
   const unit=entry.page.userUnit;if(!Number.isFinite(unit)||unit<=0)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
   const size=op.font_size===undefined?block.fontSize:op.font_size/unit,leading=block.lineHeight*(size/block.fontSize),width=block.rect[2]-block.rect[0],align=op.align??block.align
   const edit={pageIndex:op.page-1,rect:block.rect,oldText:joinBlockLines(block.lines.map(line=>line.text)),newText:op.new_text,fontSize:block.fontSize,...(op.font_size===undefined?{}:{newFontSize:size}),...(op.color===undefined?{}:{newColor:op.color.replace(/^#/,'').match(/../g).map(part=>parseInt(part,16))}),...(op.font===undefined?{}:{newFont:op.font}),...(op.bold?{newBold:true}:{}),...(op.italic?{newItalic:true}:{}),origin:[block.rect[0],block.lines[0].y],lineLeading:leading,blockSource:op.new_text}
   if(op.new_text){
    const source=op.new_text.split('\n').map(paragraph=>paragraph.trim().replace(/\s+/g,' ')).filter(Boolean).join('\n')
    edit.newText=source
    let converged=false
    for(let pass=0;pass<5;pass++){
     let layout;try{layout=await measureTextEditLayout(bytes,edit)}catch{fail('PDF_BLOCK_FONT_UNAVAILABLE')}
     const measure=measurement(layout,source),lines=[],lineRanges=[]
     let paragraphStart=0
     for(const paragraph of source.split('\n')){
      const wrapped=wrapTextMeasured(paragraph,width,(text,start)=>measure(text,paragraphStart+start))
      let from=paragraphStart
      for(const line of wrapped){const start=source.indexOf(line,from);if(start<0)fail('PDF_BLOCK_REFUSED');lineRanges.push(start);lines.push(line);from=start+line.length}
      paragraphStart+=paragraph.length+1
     }
     const wrapped=lines.join('\n')
     if(lines.length>1000||lines.some((line,index)=>measure(line,lineRanges[index])>width+0.01)||block.lines[0].y-(lines.length-1)*leading-size*0.3<entry.page.view[1]||reflowOverflows({leftPt:block.rect[0],firstBaseline:block.lines[0].y,widthPt:width,bottomPt:block.rect[1]},lines.length,leading,size,entry.blocks,block.rect))fail('PDF_BLOCK_REFUSED')
     if(align!=='left'){edit.align=align;edit.lineXOffsets=lines.map((line,index)=>Math.max(0,(width-measure(line,lineRanges[index]))/(align==='center'?2:1)))}
     edit.newText=wrapped
     if(wrapped===layout.text){converged=true;break}
     check(signal)
    }
    if(!converged)fail('PDF_BLOCK_REFUSED')
   }
   targets.push(edit)
  }
  const valid=await validateTextEdits(bytes,targets);if(valid.length!==targets.length||valid.some(item=>item.reason!==null))fail('PDF_BLOCK_REFUSED');check(signal)
  return targets
 }finally{await task.destroy()}
}
export function createPdfBlockEditsJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=parsePdfBlockEditsRequest(raw),original=Buffer.from(input);busy=true
  try{
   const before=await openEditablePdf(original),textEdits=await planPdfBlockEdits(original,operations,signal),{applySaveRequest}=await import('../../../../pdf/src/main/save-pdf.ts'),{verifyTextEdits,validateTextEdits}=await import('../../../../pdf/src/main/text-edit.ts')
   const applied=await applySaveRequest(original,{formValues:[],markups:[],drawings:[],rotations:[],textEdits});check(signal)
   if(applied.skippedTextEdits.length)fail('PDF_BLOCK_REFUSED')
   const bytes=Buffer.from(applied.bytes);if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   if((await verifyTextEdits(bytes,textEdits.map(edit=>({pageIndex:edit.pageIndex,newText:edit.newText})))).length)fail('PDF_TEXT_VERIFY_FAILED')
   const deletions=textEdits.filter(edit=>!edit.newText.trim())
   if(deletions.length&&(await validateTextEdits(bytes,deletions)).some(result=>result.reason===null))fail('PDF_TEXT_VERIFY_FAILED')
   const after=await openEditablePdf(bytes);if(after.getPageCount()!==before.getPageCount())fail('PDF_TEXT_VERIFY_FAILED');check(signal)
   const preserved=await preservePdfManagedStamps(original,bytes);
   return {bytes:preserved,inputSha256:hash(original),sha256:hash(preserved),size:preserved.length}
  }catch(error){check(signal);if(pdfBlockEditsSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
