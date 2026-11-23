import {createPdfApplyOpsJob,parsePdfApplyOpsRequest,pdfApplyOpsSafetyCodes} from './apply-ops-job.mjs'
import {fail} from './job-common.mjs'
export const pdfApplyOpsQuerySafetyCodes=pdfApplyOpsSafetyCodes
export function parsePdfApplyOpsQueryRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST');if(Buffer.byteLength(raw)>32*1024*1024)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(request?.action!=='applyOpsQuery')fail('INVALID_REQUEST')
 return parsePdfApplyOpsRequest(JSON.stringify({...request,action:'applyOps'}))
}
/** Exactly the unified compiler's protection and writer; its result remains temporary bytes. */
export function createPdfApplyOpsQueryJob(){
 const compiler=createPdfApplyOpsJob()
 return {async execute(input,raw,signal){
  if(signal?.aborted)fail('ABORTED')
  const snapshot=parsePdfApplyOpsQueryRequest(raw)
  return compiler.execute(input,JSON.stringify({version:1,action:'applyOps',snapshot}),signal)
 }}
}
