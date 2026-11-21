import {splitPdfReplacePagesFrame} from './replace-pages-job.mjs'
import {fork} from 'node:child_process'
import {fail,hash} from './job-common.mjs'

const MAX_BYTES=64*1024*1024

/** Shared killable process boundary for the fixed PDF edit actions. Caps
 * V8 old-space and wall time, not OS filesystem/network access or WASM RSS. */
export function createPdfProcessJob(action,parseRequest,safetyCodes){
 if(!['applyOpsQuery','annotationsQuery','textEditsQuery','imagePreviewQuery','applyOps','editText','annotateText','deleteAnnotations','updateNotes','pageOps','extractPages','splitPdf','pageLayout','formValues','formFields','textInserts','blockEdits','blockMoves','imageEdits','imageQuery','imageContent','imageBakes','stamps','replacePages','redactionsQuery','redactedCopy','textInsertsQuery','imageInsertsQuery','draftInserts','draftInsertsQuery'].includes(action))fail('INVALID_REQUEST')
 let busy=false
 return {async execute(input,raw,signal){
  if(signal?.aborted)fail('ABORTED')
  if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>(action==='replacePages'?MAX_BYTES*2+4:MAX_BYTES))fail('INPUT_LIMIT')
  const operations=parseRequest(raw),bytes=Buffer.from(input),binding=action==='replacePages'?splitPdfReplacePagesFrame(bytes):{target:bytes},inputSha256=hash(binding.target)
  busy=true
  try{return await new Promise((resolve,reject)=>{
   const child=fork(new URL('./pdf-edit-worker.mjs',import.meta.url),[],{execArgv:['--max-old-space-size=256','--import','tsx'],env:{LANG:'C.UTF-8'},serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']})
   let settled=false
   const finish=(error,result)=>{
    if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted)
    child.kill('SIGKILL')
    if(error)reject(Object.assign(new Error(error),{code:error}));else resolve(result)
   }
   const aborted=()=>finish('ABORTED')
   const timer=setTimeout(()=>finish('TIMEOUT'),30000)
   signal?.addEventListener('abort',aborted,{once:true})
   child.on('error',()=>finish('NATIVE_FAILED'))
   child.on('exit',()=>finish('NATIVE_FAILED'))
   child.on('message',message=>{
    if(message?.error){finish(safetyCodes.has(message.error)?message.error:'NATIVE_FAILED');return}
    const result=message?.result
    if(action==='replacePages'&&result?.sourceSha256!==hash(binding.source)){finish('NATIVE_FAILED');return}
    if(action==='splitPdf'){
     let total=0
     if(!result||result.inputSha256!==inputSha256||!Array.isArray(result.files)||result.files.length<2||result.files.length>100||result.files.some(file=>!Buffer.isBuffer(file?.bytes)||file.bytes.length<1||(total+=file.bytes.length)>MAX_BYTES||file.size!==file.bytes.length||file.sha256!==hash(file.bytes))){finish('NATIVE_FAILED');return}
     finish(undefined,result);return
    }
    if(!result||!Buffer.isBuffer(result.bytes)||result.bytes.length<1||result.bytes.length>MAX_BYTES||result.inputSha256!==inputSha256||result.size!==result.bytes.length||result.sha256!==hash(result.bytes)){finish('NATIVE_FAILED');return}
    finish(undefined,result)
   })
   const command=action==='replacePages'&&operations?.action==='insertPages'?{version:1,...operations}:{version:1,action,...(['applyOps','applyOpsQuery'].includes(action)?{snapshot:operations}:['redactionsQuery','redactedCopy','textInsertsQuery','imageInsertsQuery'].includes(action)?operations:['extractPages','replacePages'].includes(action)?{pages:operations}:action==='splitPdf'?{pagesPerFile:operations}:['pageLayout','imageContent','imageBakes','stamps','draftInserts','draftInsertsQuery'].includes(action)?{operation:operations}:{operations})}
   child.send({input:bytes,raw:JSON.stringify(command)},error=>{if(error)finish('NATIVE_FAILED')})
   if(signal?.aborted)aborted()
  })}finally{busy=false}
 }}
}
