import {shrinkDocument} from '../../../../pdf/src/main/pdf-shrink.ts'
import {hasUnsupportedPdfForm} from '../../../shared/pdf-edit-structure.mjs'
import {openEditablePdf} from './editable-document.mjs'
import {check,fail,hash,requireEnvelope} from './job-common.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'

const MAX_INFLATED_STREAM_BYTES=64*1024*1024
// A PDF result cannot consist of this byte. The IPC expects nonempty output
// even when the best result is keeping the original file.
const unchanged=Buffer.from([0])
export const isUnchangedPdfReduction=bytes=>bytes.length===1&&bytes[0]===unchanged[0]
export const pdfReductionSafetyCodes=new Set(['INVALID_REQUEST','MAGIC_MISMATCH','UNREADABLE','PASSWORD','PDF_EDIT_LIMIT','PDF_EDIT_UNSUPPORTED_STRUCTURE','SIGNATURE_EDIT_REFUSED'])

function parseRequest(raw){
 if(typeof raw!=='string'||raw.length>128)fail('INVALID_REQUEST')
 let command
 try{command=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 requireEnvelope(command,'reduceSize','operations')
 if(!Array.isArray(command.operations)||command.operations.length!==0)fail('INVALID_REQUEST')
 return []
}

export function createPdfReductionJob(){
 return {async execute(input,raw,signal){
  check(signal)
  parseRequest(raw)
  const doc=await openEditablePdf(input,{allowAcroForm:true})
  if(hasUnsupportedPdfForm(doc))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  const pageCount=doc.getPageCount()
  shrinkDocument(doc,undefined,MAX_INFLATED_STREAM_BYTES)
  check(signal)
  const reduced=await doc.save({useObjectStreams:true,updateFieldAppearances:false})
  let bytes=unchanged
  if(reduced.length<input.length){
   bytes=Buffer.from(reduced)
   if((await openEditablePdf(bytes,{allowAcroForm:true})).getPageCount()!==pageCount)fail('UNREADABLE')
  }
  check(signal)
  return {bytes,inputSha256:hash(input),sha256:hash(bytes),size:bytes.length}
 }}
}

export function createIsolatedPdfReductionJob(){
 return createPdfProcessJob('reduceSize',parseRequest,pdfReductionSafetyCodes)
}
