import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import type {Pool} from 'pg'
import {DocumentContractError} from './document-profiles.ts'
export interface NativeExecutionFacts {
 deploymentId:string;ownerId:string;sessionId:string;authVersion:number;fileId:string;baseRevision:string;
 jobId:string;jobEpoch:number;attempt:number;editorId:string;leaseEpoch:number;inputSha256:string;inputSize:number;jobType:string
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function denied():never{throw new DocumentContractError('DOCUMENT_NATIVE_AUTHORITY_DENIED')}
function facts(input:unknown):Readonly<NativeExecutionFacts>{
 if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))denied()
 const out:Record<string,unknown>={},keys=['deploymentId','ownerId','sessionId','authVersion','fileId','baseRevision','jobId','jobEpoch','attempt','editorId','leaseEpoch','inputSha256','inputSize','jobType']
 if(Reflect.ownKeys(input).length!==keys.length)denied()
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!('value'in d)||!d.enumerable)denied();out[key]=d.value}
 for(const key of ['deploymentId','ownerId','sessionId','fileId','baseRevision','jobId','editorId'])if(typeof out[key]!=='string'||!uuid.test(out[key]))denied()
 for(const key of ['authVersion','jobEpoch','attempt','leaseEpoch','inputSize'])if(!Number.isSafeInteger(out[key])||(out[key] as number)<1)denied()
 if((out.inputSize as number)>33554432||typeof out.inputSha256!=='string'||!/^[0-9a-f]{64}$/.test(out.inputSha256)||typeof out.jobType!=='string'||!/^(docx|xlsx|pptx|pdf)\.[a-z][a-z0-9_]{0,31}$/.test(out.jobType))denied()
 return Object.freeze(out) as unknown as Readonly<NativeExecutionFacts>
}
/** Native facts only, not the unified authority port. No tenant/generation/runtime mapping. */
export function createTestNativeAuthorityVerifier(pool:Pool,options:{schema:string;unsafeTestOnly:true}){
 const schema=options.schema,enabled=options.unsafeTestOnly===true
 const gate=()=>{if(process.env.NODE_ENV!=='test'||!enabled||!/^[a-z][a-z0-9_]{0,62}$/.test(schema))denied()};gate()
 return Object.freeze({async verify(expected:unknown,jobToken:string){
  gate();const snapshot=facts(expected)
  if(typeof jobToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(jobToken))denied()
  const hash=createHash('sha256').update(jobToken).digest('hex'),start=performance.now()
  const c=await pool.connect();let discard:Error|undefined
  try{
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'");await c.query("SET LOCAL statement_timeout='2s'")
   const result=(await c.query(`SELECT "${schema}".document_native_authority($1::jsonb,$2::text) AS evidence`,[snapshot,hash])).rows[0]?.evidence
   if(!result||typeof result!=='object'||Object.keys(result).sort().join(',')!=='facts,observedAt,remainingMs')denied()
   const proven=facts(result.facts);if(JSON.stringify(proven)!==JSON.stringify(snapshot))denied()
   if(typeof result.observedAt!=='string'||!Number.isFinite(Date.parse(result.observedAt))||!Number.isSafeInteger(result.remainingMs)||result.remainingMs<=0)denied()
   await c.query('COMMIT')
   // DB-relative duration minus the entire client round trip and fixed conservative margin.
   // This is instantaneous evidence, revocable immediately; never a lease/grant promise.
   const remainingMs=Math.floor(result.remainingMs-(performance.now()-start)-5)
   if(remainingMs<=0)denied()
   return Object.freeze({scope:'native-job-instant-evidence' as const,facts:proven,observedAt:result.observedAt,remainingMs})
  }catch{try{await c.query('ROLLBACK')}catch{discard=new Error('Native authority rollback failed')}denied()}finally{c.release(discard)}
 }})
}
