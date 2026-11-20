import {preservePdfManagedStamps} from './stamps-job.mjs'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {dirname,join,sep} from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import {openPdfForInserts,assertPdfInsertFormPreserved} from './insert-form-integrity.mjs'
import {PDF_OPEN_OPTIONS} from '../../../src/editors/pdf-csp.ts'
import {viewToPdf,pdfRectToCss,geomDispSize} from '../../../../pdf/src/renderer/annotations.ts'
import {wrapTextMeasured} from '../../../../pdf/src/renderer/text-wrap.ts'
import {foldCase} from '../../../../../packages/ui/src/find-text.ts'
const require=createRequire(import.meta.url),MAX_BYTES=64*1024*1024
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const keys=['page','text','anchor_text','placement','x','y','font_size','color','max_width','align','font','bold','italic']
function fail(code){throw Object.assign(new Error(code),{code})}
function check(signal){if(signal?.aborted)fail('ABORTED')}
export const pdfTextInsertsSafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_TEXT_INSERT','PDF_TEXT_ANCHOR_NOT_FOUND','PDF_TEXT_INSERT_REFUSED','PDF_TEXT_VERIFY_FAILED','PDF_TEXT_FONT_UNAVAILABLE','OUTPUT_LIMIT','PDF_FORM_INSERT_INTEGRITY_FAILED','PDF_STAMP_INTEGRITY_FAILED'])
export function validatePdfTextInsertOperations(input){
 if(!Array.isArray(input)||input.length<1||input.length>20||Reflect.ownKeys(input).length!==input.length+1)fail('INVALID_PDF_TEXT_INSERT')
 const result=[]
 for(let index=0;index<input.length;index++){
  const descriptor=Object.getOwnPropertyDescriptor(input,String(index));if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)fail('INVALID_PDF_TEXT_INSERT')
  const op=descriptor.value
  if(!op||typeof op!=='object'||Array.isArray(op)||![Object.prototype,null].includes(Object.getPrototypeOf(op)))fail('INVALID_PDF_TEXT_INSERT')
  for(const key of Reflect.ownKeys(op)){const d=Object.getOwnPropertyDescriptor(op,key);if(!keys.includes(key)||!d||!('value'in d)||!d.enumerable)fail('INVALID_PDF_TEXT_INSERT')}
  if(!Number.isSafeInteger(op.page)||op.page<1||op.page>100||typeof op.text!=='string'||!op.text.trim()||op.text.length>10000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(op.text))fail('INVALID_PDF_TEXT_INSERT')
  if(('anchor_text'in op&&(typeof op.anchor_text!=='string'||op.anchor_text.length>2000))||('placement'in op&&!['right','below','above'].includes(op.placement))||('align'in op&&!['left','center','right'].includes(op.align))||('font'in op&&!['arial','times','courier'].includes(op.font))||('color'in op&&(typeof op.color!=='string'||!/^#?[a-f0-9]{6}$/i.test(op.color))))fail('INVALID_PDF_TEXT_INSERT')
  for(const key of ['x','y','font_size','max_width'])if(key in op&&(typeof op[key]!=='number'||!Number.isFinite(op[key])||Math.abs(op[key])>100000||(key==='font_size'&&(op[key]<=0||op[key]>1000))||(key==='max_width'&&op[key]<=0)))fail('INVALID_PDF_TEXT_INSERT')
  for(const key of ['bold','italic'])if(key in op&&typeof op[key]!=='boolean')fail('INVALID_PDF_TEXT_INSERT')
  result.push(Object.freeze({...op,text:op.text.replace(/\r\n/g,'\n').trim(),...('anchor_text'in op?{anchor_text:op.anchor_text.trim()}:{})}))
 }
 return Object.freeze(result)
}
export function parsePdfTextInsertsRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST')
 if(Buffer.byteLength(raw)>1024*1024)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!request||Array.isArray(request)||Object.keys(request).sort().join(',')!=='action,operations,version'||request.version!==1||request.action!=='textInserts')fail('INVALID_REQUEST')
 return validatePdfTextInsertOperations(request.operations)
}
const faceKey=op=>`${op.font??''}|${op.bold?1:0}|${op.italic?1:0}`
export function anchorRect(content,query){
 let text='',items=[]
 for(const item of content.items){
  if(typeof item.str!=='string')continue
  if(text.length+item.str.length>1000000)fail('PDF_EDIT_LIMIT')
  const start=text.length;text+=item.str
  if(item.str&&item.transform)items.push({start,end:text.length,item})
  if(item.hasEOL)text+='\n'
 }
 const pos=foldCase(text).indexOf(foldCase(query));if(pos<0)fail('PDF_TEXT_ANCHOR_NOT_FOUND')
 const end=pos+query.length,rects=[]
 for(const {start:lo,end:hi,item}of items){
  if(hi<=pos||lo>=end)continue
  const h=item.height||Math.hypot(item.transform[2],item.transform[3]),[a,b,c,d,x,y]=item.transform
  if(![a,b,c,d,x,y,item.width,h].every(Number.isFinite)||h<=0||Math.abs(b)>h*0.001||a<=0||item.dir==='ttb')fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  rects.push([x+item.width*(Math.max(pos,lo)-lo)/(hi-lo),y,x+item.width*(Math.min(end,hi)-lo)/(hi-lo),y+h])
 }
 if(!rects.length)fail('PDF_TEXT_ANCHOR_NOT_FOUND')
 return [Math.min(...rects.map(r=>r[0])),Math.min(...rects.map(r=>r[1])),Math.max(...rects.map(r=>r[2])),Math.max(...rects.map(r=>r[3]))]
}
/** Plans only from the authorized byte snapshot. No browser font or client geometry is trusted. */
async function planPdfTextInsertDetails(bytes,operations,signal,rotationDeltas){
 const {resolveTextInsertFont,listEditFonts}=await import('../../../../pdf/src/main/text-edit.ts')
 const groups=new Map(),faces=new Map()
 for(const op of operations){if(op.font&&!listEditFonts().includes(op.font))fail('PDF_TEXT_FONT_UNAVAILABLE');const key=faceKey(op);groups.set(key,[...(groups.get(key)??[]),op])}
 for(const [key,group]of groups){
  let resolved;try{resolved=await resolveTextInsertFont({...group[0],text:group.map(op=>op.text.replace(/\n/g,'')).join('')})}catch{fail('PDF_TEXT_FONT_UNAVAILABLE')}
  const face=fontkit.create(resolved.bytes)
  faces.set(key,face);check(signal)
 }
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),root=dirname(require.resolve('pdfjs-dist/package.json'))
 const task=getDocument({data:Uint8Array.from(bytes),...PDF_OPEN_OPTIONS,cMapUrl:join(root,'cmaps')+sep,cMapPacked:true,standardFontDataUrl:join(root,'standard_fonts')+sep})
 try{
  const doc=await task.promise,result=[],blocks=[],pages=new Map();check(signal)
  for(const [index,op] of operations.entries()){
   if(op.page>doc.numPages)fail('INVALID_PDF_TEXT_INSERT')
   let entry=pages.get(op.page)
   if(!entry){const page=await doc.getPage(op.page);entry={page,content:await page.getTextContent()};pages.set(op.page,entry)}
   const {page,content}=entry,unit=page.userUnit,view=page.view,rot=((page.rotate+(rotationDeltas?.[index]??0))%360+360)%360
   if(!Number.isFinite(unit)||unit<=0||unit>75000||!Array.isArray(view)||view.length!==4||!view.every(Number.isFinite)||view[2]<=view[0]||view[3]<=view[1]||![0,90,180,270].includes(rot))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
   const geom={pw:(view[2]-view[0])*unit,ph:(view[3]-view[1])*unit,x0:view[0],y0:view[1],rot,userUnit:unit},size=geomDispSize(geom)
   const face=faces.get(faceKey(op)),fontSize=op.font_size??14,align=op.align??'left',max=op.max_width
   const measure=text=>{let width=0;for(const char of text){const glyph=face.glyphForCodePoint(char.codePointAt(0));if(glyph.id===0&&!/\s/.test(char))fail('PDF_TEXT_FONT_UNAVAILABLE');width+=glyph.advanceWidth}return width/face.unitsPerEm*fontSize}
   const lines=max?op.text.split('\n').flatMap(paragraph=>paragraph.trim()?wrapTextMeasured(paragraph,max,measure):['']):op.text.split('\n')
   const widths=lines.map(measure),blockW=max??Math.max(...widths,1),leading=fontSize*1.2,blockH=leading*lines.length
   if(lines.length>1000||blockW>size.width||blockH>size.height||widths.some(width=>width>blockW+0.01))fail('PDF_TEXT_INSERT_REFUSED')
   let x,y
   if(op.anchor_text){
    const anchor=pdfRectToCss(geom,anchorRect(content,op.anchor_text),1)
    if(op.placement==='above'){x=anchor.left;y=anchor.top-4-blockH}
    else if(op.placement==='below'){x=anchor.left;y=anchor.top+anchor.height+4}
    else{x=anchor.left+anchor.width+4;y=anchor.top+anchor.height-fontSize*1.1}
   }else{x=op.x??(size.width-blockW)/2;y=op.y??72}
   x=Math.min(Math.max(x,0),Math.max(size.width-blockW,0));y=Math.min(Math.max(y,0),Math.max(size.height-blockH,0))
   blocks.push({page:op.page,text:lines.join('\n'),x,y,width:blockW,height:blockH,line_widths:widths,font_size:fontSize,color:'#'+(op.color??'#000000').replace(/^#/,''),align,...('font'in op?{font:op.font}:{}),...('bold'in op?{bold:op.bold}:{}),...('italic'in op?{italic:op.italic}:{}),...('max_width'in op?{max_width:op.max_width}:{})})
   const anchorX=x+(align==='center'?blockW/2:align==='right'?blockW:0)
   result.push({pageIndex:op.page-1,origin:viewToPdf(geom,anchorX,y+fontSize),text:lines.join('\n'),fontSize:fontSize/unit,color:(op.color??'#000000').replace(/^#/,'').match(/../g).map(part=>parseInt(part,16)),font:op.font,bold:op.bold,italic:op.italic,lineLeading:leading/unit,...(align==='left'?{}:{align,lineXOffsets:widths.map(width=>(align==='center'?-width/2:-width)/unit)}),rotate:rot})
   check(signal)
  }
  return {inserts:result,blocks}
 }finally{await task.destroy()}
}
export async function planPdfTextInserts(bytes,operations,signal){return (await planPdfTextInsertDetails(bytes,operations,signal)).inserts}
export function parsePdfTextInsertsQueryRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>1024*1024)fail('INVALID_REQUEST')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(request?.version!==1||request.action!=='textInsertsQuery'||Object.keys(request).some(key=>!['version','action','operations','rotationDeltas'].includes(key)))fail('INVALID_REQUEST')
 const operations=validatePdfTextInsertOperations(request.operations),rotationDeltas=request.rotationDeltas
 if(rotationDeltas!==undefined&&(!Array.isArray(rotationDeltas)||rotationDeltas.length!==operations.length||rotationDeltas.some(delta=>![0,90,180,270].includes(delta))))fail('INVALID_PDF_TEXT_INSERT')
 return {operations,rotationDeltas}
}
export function createPdfTextInsertsQueryJob(){
 return {async execute(input,raw,signal){
  check(signal);if(!Buffer.isBuffer(input)||!input.length||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const {operations,rotationDeltas}=parsePdfTextInsertsQueryRequest(raw),original=Buffer.from(input)
  try{await openPdfForInserts(original,{planning:true});const {blocks,inserts}=await planPdfTextInsertDetails(original,operations,signal,rotationDeltas);check(signal);const bytes=Buffer.from(JSON.stringify({blocks,inserts}));return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}}
  catch(error){check(signal);if(pdfTextInsertsSafetyCodes.has(error?.code))throw error;fail('NATIVE_FAILED')}
 }}
}
export function createPdfTextInsertsJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=parsePdfTextInsertsRequest(raw),original=Buffer.from(input);busy=true
  try{
   const before=await openPdfForInserts(original);check(signal)
   const textInserts=await planPdfTextInserts(original,operations,signal),{applySaveRequest}=await import('../../../../pdf/src/main/save-pdf.ts'),{verifyTextEdits}=await import('../../../../pdf/src/main/text-edit.ts')
   const applied=await applySaveRequest(original,{formValues:[],markups:[],drawings:[],rotations:[],textInserts});check(signal)
   if(applied.skippedTextInserts.length)fail('PDF_TEXT_INSERT_REFUSED')
   const bytes=Buffer.from(applied.bytes);if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   if((await verifyTextEdits(bytes,textInserts.map(insert=>({pageIndex:insert.pageIndex,newText:insert.text})))).length)fail('PDF_TEXT_VERIFY_FAILED')
   const after=await openPdfForInserts(bytes);if(after.getPageCount()!==before.getPageCount())fail('PDF_TEXT_VERIFY_FAILED');check(signal)
   const preserved=await preservePdfManagedStamps(original,bytes,{allowAcroForm:true});
   assertPdfInsertFormPreserved(before,await openPdfForInserts(preserved));
   return {bytes:preserved,inputSha256:hash(original),sha256:hash(preserved),size:preserved.length}
  }catch(error){check(signal);if(pdfTextInsertsSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
