import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import type {Pool} from 'pg'
import type {PrincipalTransactions} from '../db/context.ts'
import type {ObjectStore} from '../storage/object-store.ts'
import {createFileService} from '../modules/files/service.ts'
import {createTestPdfLeaseController} from './lease-controller.ts'
function fail(code='PDF_INPUT_DENIED'):never{throw Object.assign(new Error(code),{code})}
/** Control-plane byte snapshot only: no parser, OS isolation, execution grant,
 * runtime registration or T06 output. Objects is trusted service configuration.
 */
export function createTestPdfInputPreparation(options:{transactions:PrincipalTransactions;workerPool:Pool;objects:ObjectStore;deploymentId:string;schema:string;unsafeTestOnly:true}){
 const gate=()=>{if(process.env.NODE_ENV!=='test'||options.unsafeTestOnly!==true)fail()};gate()
 const controller=createTestPdfLeaseController(options),files=createFileService(options)
 return Object.freeze({async prepare(raw:unknown,{signal}:{signal?:AbortSignal}={}){
  gate()
  if(!raw||typeof raw!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(raw))||Reflect.ownKeys(raw).length!==3)fail()
  const captured:Record<string,unknown>={}
  for(const key of ['jobId','epoch','token']){const d=Object.getOwnPropertyDescriptor(raw,key);if(!d||!('value'in d)||!d.enumerable)fail();captured[key]=d.value}
  // Controller validates the captured values before its first await.
  const claim=Object.freeze(captured) as Readonly<{jobId:string;epoch:number;token:string}>
  let deadline=Infinity
  const check=()=>{gate();if(signal?.aborted)fail('PDF_INPUT_ABORTED');if(performance.now()>=deadline)fail()}
  const observe=async()=>{check();const start=performance.now(),value=await controller.prepare(claim);deadline=Math.min(deadline,start+value.remainingMs);check();return value}
  try{
   const initial=await observe()
   const downloaded=await files.readFile({kind:'job',...claim},initial.facts.fileId,initial.facts.baseRevision)
   check();const bytes=Buffer.from(downloaded)
   if(bytes.length!==initial.facts.inputSize||createHash('sha256').update(bytes).digest('hex')!==initial.facts.inputSha256)fail()
   const current=await observe()
   if(current.commandDigest!==initial.commandDigest||Object.keys(initial.facts).some(key=>initial.facts[key as keyof typeof initial.facts]!==current.facts[key as keyof typeof current.facts]))fail()
   check();const remainingMs=Math.floor(deadline-performance.now());if(remainingMs<=0)fail()
   return Object.freeze({scope:'pdf-control-input-snapshot' as const,command:current.command,commandDigest:current.commandDigest,facts:current.facts,remainingMs,copyBytes(){check();const copy=Buffer.from(bytes);check();return copy}})
  }catch(error){if(signal?.aborted)fail('PDF_INPUT_ABORTED');fail()}
 }})
}
