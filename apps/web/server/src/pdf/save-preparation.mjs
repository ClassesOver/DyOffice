import {createHash} from 'node:crypto'
import {uuid} from '../modules/files/queries.ts'
import {authError} from '../modules/auth/sessions.ts'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(new Error(code),{code})}
const check=signal=>{if(signal?.aborted)fail('ABORTED')}

/** Trusted session-side preparation only, not registered as an HTTP route.
 * Processor receives bytes/request/signal, never credentials. It must eventually
 * be supplied by an isolated worker adapter; this seam adds no OS isolation.
 * Does NOT commit or retry. Preserve commitInput for explicit T06 commit/receipt
 * recovery if commit has an unknown outcome; never rerun preparation to retry it.
 */
export function createPdfSavePreparation({files,leases,revisions,processor}){
  return {async prepare(input,{signal}={}){
    if(!input||typeof input!=='object'||Array.isArray(input)
      ||Object.keys(input).sort().join(',')!=='baseRevision,editorId,fileId,idempotencyKey,leaseEpoch,request,token')throw authError(400)
    const {token,request,idempotencyKey,leaseEpoch}=input
    const fileId=uuid(input.fileId),baseRevision=uuid(input.baseRevision),editorId=uuid(input.editorId)
    if(typeof token!=='string'||typeof request!=='string'||!Number.isSafeInteger(leaseEpoch)||leaseEpoch<1
      ||typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))throw authError(400)
    check(signal)
    // getLease requires files:write and verifies ownership before native input.
    const lease=await leases.getLease(token,fileId);check(signal)
    if(!lease.active||!lease.heldByCurrentSession||lease.editorId!==editorId||lease.leaseEpoch!==leaseEpoch)throw authError(409)
    const current=await files.openFile(token,fileId);check(signal)
    if(current.format!=='pdf')fail('PDF_FORMAT_REQUIRED')
    if(current.file.revision!==baseRevision)throw authError(409)
    const source=await files.download(token,fileId,baseRevision);check(signal)
    if(source.format!=='pdf')fail('PDF_FORMAT_REQUIRED')
    const inputSha256=hash(source.bytes)
    if(inputSha256!==current.file.sha256)fail('PDF_OUTPUT_BINDING')
    // Object I/O may outlive the original session/lease/head snapshot. Recheck
    // before exposing bytes to the processor, not only when staging its output.
    // These short transactions deliberately finish before external processing:
    // this narrows the race but is NOT an atomic execution grant or OS isolation.
    const fresh=await files.openFile(token,fileId);check(signal)
    if(fresh.format!=='pdf')fail('PDF_FORMAT_REQUIRED')
    if(fresh.file.revision!==baseRevision)throw authError(409)
    if(fresh.file.sha256!==inputSha256)fail('PDF_OUTPUT_BINDING')
    const freshLease=await leases.getLease(token,fileId);check(signal)
    if(!freshLease.active||!freshLease.heldByCurrentSession||freshLease.editorId!==editorId||freshLease.leaseEpoch!==leaseEpoch)throw authError(409)
    const result=await processor.execute(source.bytes,request,signal);check(signal)
    if(!Buffer.isBuffer(result?.bytes)||result.bytes.length<1||result.bytes.length>64*1024*1024)fail('PDF_OUTPUT_BINDING')
    const output=Buffer.from(result.bytes),sha256=hash(output)
    if(result.inputSha256!==inputSha256||result.sha256!==sha256||result.size!==output.length)fail('PDF_OUTPUT_BINDING')
    let upload
    try{
      // Authoritative fresh revision/lease/auth checks occur again inside T06.
      upload=await revisions.stageUpload(token,fileId,{size:output.length,baseRevision,leaseEpoch,editorId});check(signal)
      await files.receiveUpload(token,upload.uploadId,output);check(signal)
      return Object.freeze({commitInput:Object.freeze({fileId,uploadId:upload.uploadId,baseRevision,leaseEpoch,idempotencyKey}),sha256,size:output.length})
    }catch(error){
      if(upload)await files.cancelUpload(token,upload.uploadId).catch(()=>{})
      throw error
    }
  }}
}
