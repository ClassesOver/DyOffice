import {createHash} from 'node:crypto'
import {parsePdfAnnotationRequest,planPdfAnnotations} from './annotation-job.mjs'
import {openPdfForPendingEdits} from './pending-document.mjs'
const MAX_BYTES=64*1024*1024,MAX_REQUEST=64*1024
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(Error(code),{code})}
const check=signal=>{if(signal?.aborted)fail('ABORTED')}
export const annotationsQuerySafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_STAMP_INTEGRITY_FAILED','PDF_ANNOTATION_TEXT_NOT_FOUND','OUTPUT_LIMIT'])
export function parsePdfAnnotationsQueryRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST');if(Buffer.byteLength(raw)>MAX_REQUEST)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(request?.action!=='annotationsQuery')fail('INVALID_REQUEST')
 return parsePdfAnnotationRequest(JSON.stringify({...request,action:'annotateText'}))
}
/** Revision authorization belongs to the host; this processor only returns a bound JSON report. */
export function createPdfAnnotationsQueryJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||!input.length||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=parsePdfAnnotationsQueryRequest(raw),original=Buffer.from(input);busy=true
  try{
   await openPdfForPendingEdits(original);check(signal)
   const report=await planPdfAnnotations(original,operations,signal);check(signal)
   const bytes=Buffer.from(JSON.stringify(report));if(bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(annotationsQuerySafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
