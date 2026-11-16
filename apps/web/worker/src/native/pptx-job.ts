import {createHash} from 'node:crypto'
import {createPptxSession, type PptxSession} from './pptx-session'

export class PptxJobError extends Error {
  constructor(readonly code: 'BUSY'|'ABORTED'|'INPUT_LIMIT'|'REQUEST_LIMIT'|'INVALID_REQUEST'|'INVALID_OPERATION'|'OUTPUT_LIMIT'|'NATIVE_FAILED') {
    super(code);this.name='PptxJobError'
  }
}
export interface PptxJobOutput {bytes:Uint8Array;localGeneration:number;sha256:string}
const MAX_BYTES=32*1024*1024,MAX_REQUEST=256*1024
function check(signal?:AbortSignal){if(signal?.aborted)throw new PptxJobError('ABORTED')}
function capture(raw:string):{action:'roundtrip'|'setText';ops?:unknown}{
  if(typeof raw!=='string')throw new PptxJobError('INVALID_REQUEST')
  if(raw.length>MAX_REQUEST||Buffer.byteLength(raw,'utf8')>MAX_REQUEST)throw new PptxJobError('REQUEST_LIMIT')
  let value:any
  try{value=JSON.parse(raw)}catch{throw new PptxJobError('INVALID_REQUEST')}
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1)throw new PptxJobError('INVALID_REQUEST')
  if(value.action==='roundtrip'&&Object.keys(value).length===2)return {action:'roundtrip'}
  if(value.action==='setText'&&Object.keys(value).length===3&&Array.isArray(value.ops)&&value.ops.length>0&&value.ops.length<=100)return {action:'setText',ops:value.ops}
  throw new PptxJobError('INVALID_REQUEST')
}
/** Private child-side byte processor, NOT an OS sandbox, HTTP handler or durable save.
 * One active call per instance, no retained sessions/queue. The trusted T08 controller
 * must still provide process isolation, hard CPU/RSS/time limits, authenticated input
 * and fenced T06 commit. Never pass paths, tokens or database credentials here.
 * localGeneration is ephemeral and sha256 identifies bytes, neither acknowledges save.
 */
export function createPptxJobProcessor(){
  let busy=false
  return {async execute(input:Uint8Array,request:string,signal?:AbortSignal):Promise<PptxJobOutput>{
    check(signal)
    if(busy)throw new PptxJobError('BUSY')
    if(!(input instanceof Uint8Array)||input.byteLength<1||input.byteLength>MAX_BYTES)throw new PptxJobError('INPUT_LIMIT')
    const command=capture(request),bytes=Uint8Array.from(input)
    busy=true
    let session:PptxSession|undefined,reopened:PptxSession|undefined
    try{
      session=await createPptxSession(bytes,signal);check(signal)
      let generation=0
      if(command.action==='setText'){
        try{generation=(await session.apply(0,command.ops,signal)).generation}
        catch(error){check(signal);throw new PptxJobError('INVALID_OPERATION')}
      }
      const result=await session.exportBytes(generation,signal);check(signal)
      if(result.bytes.byteLength<1||result.bytes.byteLength>MAX_BYTES)throw new PptxJobError('OUTPUT_LIMIT')
      // Reapply the full ZIP gate and original native parser to the produced archive.
      // This is structural reopen validation, not external PowerPoint acceptance.
      session.close();session=undefined
      reopened=await createPptxSession(result.bytes,signal);check(signal)
      return {bytes:result.bytes,localGeneration:generation,sha256:createHash('sha256').update(result.bytes).digest('hex')}
    }catch(error){
      check(signal)
      if(error instanceof PptxJobError)throw error
      // Native exception messages may contain document material; never forward them.
      throw new PptxJobError('NATIVE_FAILED')
    }finally{session?.close();reopened?.close();busy=false}
  }}
}
