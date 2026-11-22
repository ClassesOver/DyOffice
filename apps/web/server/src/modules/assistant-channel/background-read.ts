import {Worker} from 'node:worker_threads'
import {isBackgroundFormat,type BackgroundFormat} from './background-format.ts'
export const DOCUMENT_READ_MAX_BYTES = 10 * 1024 * 1024
export const DOCUMENT_PARSE_TIMEOUT_MS = 10_000

export function readBackgroundDocument(bytes:Uint8Array,format:BackgroundFormat,signal:AbortSignal,options:{visibleOnly?:boolean} = {}):Promise<{text:string;truncated:boolean}> {
 if(!isBackgroundFormat(format))return Promise.reject(Error('Unsupported background format'))
 if(signal.aborted)return Promise.reject(Error('Document read cancelled'))
 if(bytes.byteLength>DOCUMENT_READ_MAX_BYTES)return Promise.reject(Error('Document exceeds background size limit'))
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./background-read-worker.ts',import.meta.url),{workerData:{bytes,format,visibleOnly:options.visibleOnly===true},resourceLimits:{maxOldGenerationSizeMb:128}})
  let settled=false
  const finish=(error?:Error,result?:{text:string;truncated:boolean})=>{
   if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort)
   void worker.terminate()
   if(error)reject(error);else resolve(result!)
  }
  const abort=()=>finish(Error('Document read cancelled'))
  const timer=setTimeout(()=>finish(Error('Document read timed out')),DOCUMENT_PARSE_TIMEOUT_MS)
  signal.addEventListener('abort',abort,{once:true})
  worker.once('error',()=>finish(Error('Document could not be read')))
  worker.once('exit',()=>{if(!settled)finish(Error('Document reader exited'))})
  worker.once('message',value=>value.error?finish(Error('Document could not be read')):finish(undefined,value))
  if(signal.aborted)abort()
 })
}
