import {preservePdfManagedStamps} from './stamps-job.mjs'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {dirname,join,sep} from 'node:path'
import {openEditablePdf} from './editable-document.mjs'
import {PDF_OPEN_OPTIONS} from '../../../src/editors/pdf-csp.ts'
import {groupPageBlocks} from '../../../../pdf/src/renderer/text-block.ts'
import {joinBlockLines} from '../../../../pdf/src/renderer/text-wrap.ts'
import {viewToPdf} from '../../../../pdf/src/renderer/annotations.ts'
import {indexPdfBlockPage} from './block-edits-job.mjs'
const require=createRequire(import.meta.url),MAX_BYTES=64*1024*1024
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(new Error(code),{code})}
function check(signal){if(signal?.aborted)fail('ABORTED')}
export const pdfBlockMovesSafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_BLOCK_MOVE','PDF_BLOCK_NOT_FOUND','PDF_BLOCK_AMBIGUOUS','PDF_BLOCK_OVERLAP','PDF_BLOCK_MOVE_REFUSED','PDF_BLOCK_MOVE_VERIFY_FAILED','OUTPUT_LIMIT'])
export function validatePdfBlockMoveOperations(input){
 if(!Array.isArray(input)||input.length<1||input.length>20||Reflect.ownKeys(input).length!==input.length+1)fail('INVALID_PDF_BLOCK_MOVE')
 const result=[]
 for(let index=0;index<input.length;index++){
  const descriptor=Object.getOwnPropertyDescriptor(input,String(index));if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)fail('INVALID_PDF_BLOCK_MOVE')
  const op=descriptor.value
  if(!op||typeof op!=='object'||Array.isArray(op)||![Object.prototype,null].includes(Object.getPrototypeOf(op))||Reflect.ownKeys(op).length!==4)fail('INVALID_PDF_BLOCK_MOVE')
  for(const key of Reflect.ownKeys(op)){const d=Object.getOwnPropertyDescriptor(op,key);if(!['page','paragraph_text','dx','dy'].includes(key)||!d||!('value'in d)||!d.enumerable)fail('INVALID_PDF_BLOCK_MOVE')}
  if(!Number.isSafeInteger(op.page)||op.page<1||op.page>100||typeof op.paragraph_text!=='string'||!op.paragraph_text.trim()||op.paragraph_text.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(op.paragraph_text)||!['dx','dy'].every(key=>typeof op[key]==='number'&&Number.isFinite(op[key])&&Math.abs(op[key])<=100000)||(op.dx===0&&op.dy===0))fail('INVALID_PDF_BLOCK_MOVE')
  result.push(Object.freeze({...op,paragraph_text:op.paragraph_text.trim()}))
 }
 return Object.freeze(result)
}
export function parsePdfBlockMovesRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST')
 if(Buffer.byteLength(raw)>128*1024)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!request||Array.isArray(request)||Object.keys(request).sort().join(',')!=='action,operations,version'||request.version!==1||request.action!=='blockMoves')fail('INVALID_REQUEST')
 return validatePdfBlockMoveOperations(request.operations)
}
export async function planPdfBlockMoves(bytes,operations,signal){
 const {validateTextEdits,verifyTextBlockMoves}=await import('../../../../pdf/src/main/text-edit.ts'),{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),root=dirname(require.resolve('pdfjs-dist/package.json'))
 const task=getDocument({data:Uint8Array.from(bytes),...PDF_OPEN_OPTIONS,cMapUrl:join(root,'cmaps')+sep,cMapPacked:true,standardFontDataUrl:join(root,'standard_fonts')+sep})
 try{
  const doc=await task.promise,pages=new Map(),targets=[],claimed=new Set();check(signal)
  for(const op of operations){
   if(op.page>doc.numPages)fail('INVALID_PDF_BLOCK_MOVE')
   let entry=pages.get(op.page)
   if(!entry){const page=await doc.getPage(op.page);entry={page,blocks:groupPageBlocks(indexPdfBlockPage(await page.getTextContent()))};pages.set(op.page,entry)}
   const squash=text=>text.replace(/\s+/g,''),hits=entry.blocks.filter(block=>squash(block.lines.map(line=>line.text).join('')).includes(squash(op.paragraph_text)))
   if(hits.length===0)fail('PDF_BLOCK_NOT_FOUND');if(hits.length!==1)fail('PDF_BLOCK_AMBIGUOUS')
   const block=hits[0],id=op.page+':'+JSON.stringify(block.rect);if(claimed.has(id))fail('PDF_BLOCK_OVERLAP');claimed.add(id)
   const {page}=entry,view=page.view,unit=page.userUnit,rot=((page.rotate%360)+360)%360
   if(!Number.isFinite(unit)||unit<=0||unit>75000||!view.every(Number.isFinite)||![0,90,180,270].includes(rot))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
   const geom={pw:(view[2]-view[0])*unit,ph:(view[3]-view[1])*unit,x0:view[0],y0:view[1],userUnit:unit,rot},a=viewToPdf(geom,0,0),b=viewToPdf(geom,op.dx,op.dy),delta=[b[0]-a[0],b[1]-a[1]],oldText=joinBlockLines(block.lines.map(line=>line.text))
   targets.push({pageIndex:op.page-1,rect:[...block.rect],oldText,newText:block.lines.map(line=>line.text).join('\n'),fontSize:block.fontSize,origin:[block.rect[0]+delta[0],block.lines[0].y+delta[1]],lineLeading:block.lineHeight,align:block.align==='left'?undefined:block.align,blockSource:oldText,translate:delta})
  }
  const valid=await validateTextEdits(bytes,targets);if(valid.length!==targets.length||valid.some(item=>item.reason!==null))fail('PDF_BLOCK_MOVE_REFUSED')
  // Zero-delta copies let the native verifier detect two different blocks owning one object.
  if(!await verifyTextBlockMoves(bytes,bytes,targets.map(target=>({...target,translate:[0,0]}))))fail('PDF_BLOCK_OVERLAP')
  check(signal);return targets
 }finally{await task.destroy()}
}
export function createPdfBlockMovesJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=parsePdfBlockMovesRequest(raw),original=Buffer.from(input);busy=true
  try{
   const before=await openEditablePdf(original),textEdits=await planPdfBlockMoves(original,operations,signal),{applySaveRequest}=await import('../../../../pdf/src/main/save-pdf.ts'),{verifyTextBlockMoves,verifyTextEdits}=await import('../../../../pdf/src/main/text-edit.ts')
   const applied=await applySaveRequest(original,{formValues:[],markups:[],drawings:[],rotations:[],textEdits});check(signal)
   if(applied.skippedTextEdits.length)fail('PDF_BLOCK_MOVE_REFUSED')
   const bytes=Buffer.from(applied.bytes);if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   if(!await verifyTextBlockMoves(original,bytes,textEdits)||(await verifyTextEdits(bytes,textEdits.map(edit=>({pageIndex:edit.pageIndex,newText:edit.newText})))).length)fail('PDF_BLOCK_MOVE_VERIFY_FAILED')
   const after=await openEditablePdf(bytes);if(after.getPageCount()!==before.getPageCount())fail('PDF_BLOCK_MOVE_VERIFY_FAILED');check(signal)
   const preserved=await preservePdfManagedStamps(original,bytes);
   return {bytes:preserved,inputSha256:hash(original),sha256:hash(preserved),size:preserved.length}
  }catch(error){check(signal);if(pdfBlockMovesSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
