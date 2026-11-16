import {createHash} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {rotatePdfPages} from './rotate.mjs'

const MAX_BYTES=64*1024*1024, MAX_REQUEST=64*1024
const safetyCodes=new Set(['MAGIC_MISMATCH','PDF_EDIT_LIMIT','INVALID_PDF_ROTATION','PASSWORD','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE'])
function fail(code){throw Object.assign(new Error(code),{code})}
function check(signal){if(signal?.aborted)fail('ABORTED')}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function capture(raw){
  if(typeof raw!=='string')fail('INVALID_REQUEST')
  if(raw.length>MAX_REQUEST||Buffer.byteLength(raw,'utf8')>MAX_REQUEST)fail('REQUEST_LIMIT')
  let command
  try{command=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
  if(!command||Array.isArray(command)||Object.keys(command).sort().join(',')!=='action,operations,version'
    ||command.version!==1||command.action!=='rotatePages'||!Array.isArray(command.operations)
    ||command.operations.length<1||command.operations.length>100)fail('INVALID_REQUEST')
  return command.operations
}

/** Private byte-processing seam, NOT a public API, OS sandbox or durable save.
 * Trusted controller must authorize the source, enforce isolation/time/RSS limits,
 * bind source digest to file/base revision, and use T06 lease/commit fencing.
 * No paths, credentials or revision receipts cross this helper's boundary.
 * Abort only suppresses results at await boundaries; it cannot preempt parsing.
 */
export function createPdfRotationJob(){
  let busy=false
  return {async execute(input,raw,signal){
    check(signal)
    if(busy)fail('BUSY')
    if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
    const operations=capture(raw),bytes=Buffer.from(input),inputSha256=hash(bytes)
    busy=true
    try{
      const output=await rotatePdfPages(bytes,operations);check(signal)
      if(output.length<1||output.length>MAX_BYTES)fail('OUTPUT_LIMIT')
      // Structural reopen only; PDFium fidelity is tested separately, not asserted here.
      const reopened=await PDFDocument.load(output,{updateMetadata:false});check(signal)
      if(reopened.isEncrypted||reopened.getPageCount()<1||reopened.getPageCount()>100)fail('NATIVE_FAILED')
      return {bytes:output,inputSha256,sha256:hash(output),size:output.length}
    }catch(error){
      check(signal)
      if(safetyCodes.has(error?.code)||error?.code==='OUTPUT_LIMIT')fail(error.code)
      // Never pass parser exception details/document material to a controller.
      fail('NATIVE_FAILED')
    }finally{busy=false}
  }}
}
