import {createHash,randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import type {Pool} from 'pg'
import {DocumentContractError} from './document-profiles.ts'
import {validateNativeExecutionFacts} from './document-native-authority-pg.ts'
import {validateDocumentExecutionRequest} from './document-contract.ts'
import type {DocumentExecutionPorts} from './document-execution-ports.ts'
export interface TrustedContextRef {id:string;version:number}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const denied=():never=>{throw new DocumentContractError('DOCUMENT_CONTEXT_DENIED')}
function contextRef(raw:TrustedContextRef){
 if(!raw||typeof raw!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(raw))||Reflect.ownKeys(raw).length!==2)denied()
 const id=Object.getOwnPropertyDescriptor(raw,'id'),version=Object.getOwnPropertyDescriptor(raw,'version')
 if(!id||!version)throw new DocumentContractError('DOCUMENT_CONTEXT_DENIED')
 if(!('value'in id)||!('value'in version)||!id.enumerable||!version.enumerable||typeof id.value!=='string'||!uuid.test(id.value)||!Number.isSafeInteger(version.value)||version.value<1)denied()
 return Object.freeze({id:id.value as string,version:version.value as number})
}
function tokenHash(token:string){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))denied();return createHash('sha256').update(token).digest('hex')}
function client(pool:Pool,options:{schema:string;unsafeTestOnly:true}){
 const schema=options.schema,enabled=options.unsafeTestOnly===true
 const gate=()=>{if(process.env.NODE_ENV!=='test'||!enabled||!/^[a-z][a-z0-9_]{0,62}$/.test(schema))denied()};gate()
 return {gate,async call(name:'document_issue_context'|'document_verify_context'|'document_revoke_context',values:unknown[],signal?:AbortSignal){
  gate();if(signal?.aborted)denied();const c=await pool.connect();let discard:Error|undefined
  try{if(signal?.aborted)denied();await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'");await c.query("SET LOCAL statement_timeout='2s'");const out=(await c.query(`SELECT "${schema}".${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,values)).rows[0]?.value;if(signal?.aborted)denied();await c.query('COMMIT');if(signal?.aborted)denied();return out}
  catch{try{await c.query('ROLLBACK')}catch{discard=new Error('Context rollback failed')}denied()}finally{c.release(discard)}
 }}
}
/** Trusted issuer pool only. It cannot register tenant mappings or approve runtimes. */
export function createTestContextIssuer(pool:Pool,options:{schema:string;unsafeTestOnly:true}){
 const db=client(pool,options)
 return Object.freeze({async issue(expected:unknown,jobToken:string,registry:{scopeId:string;scopeVersion:number;runtimeId:string;runtimeVersion:number}){
  db.gate();const facts=validateNativeExecutionFacts(expected),hash=tokenHash(jobToken)
  const scope=contextRef({id:registry.scopeId,version:registry.scopeVersion}),runtime=contextRef({id:registry.runtimeId,version:registry.runtimeVersion}),id=randomUUID()
  try{const result=await db.call('document_issue_context',[id,facts,hash,scope.id,scope.version,runtime.id,runtime.version]);if(!result||Object.keys(result).sort().join(',')!=='context,request')denied();const ref=contextRef(result.context);if(ref.id!==id||ref.version!==1)denied();return Object.freeze({context:ref,request:validateDocumentExecutionRequest(result.request,new Date())})}
  catch{const e=new DocumentContractError('DOCUMENT_CONTEXT_DENIED');Object.assign(e,{contextId:id});throw e}
 },async revoke(raw:TrustedContextRef){db.gate();const ref=contextRef(raw);if(await db.call('document_revoke_context',[ref.id,ref.version])!==true)denied()}})
}
/** Test-only authority bridge. ContextRef and job capability come from trusted dispatch,
 * never from document payload. Production assembly remains absent. */
export function createTestUnifiedAuthority(pool:Pool,options:{schema:string;unsafeTestOnly:true;context:TrustedContextRef;jobToken:string}):DocumentExecutionPorts['authority']{
 const db=client(pool,options),context=contextRef(options.context),hash=tokenHash(options.jobToken)
 return Object.freeze({async verify(raw,phase,signal){
  db.gate();const expected=validateDocumentExecutionRequest(raw,new Date()),started=performance.now()
  if(!['pre','before_start','post','return'].includes(phase)||expected.profileId!=='pptx-edit-v1'||expected.generation!==0)denied()
  const value=await db.call('document_verify_context',[context.id,context.version,hash,phase],signal)
  if(!value||Object.keys(value).sort().join(',')!=='remainingMs,request'||!Number.isSafeInteger(value.remainingMs)||value.remainingMs<=0)denied()
  const request=validateDocumentExecutionRequest(value.request,new Date())
  for(const key of Object.keys(request) as (keyof typeof request)[])if(request[key]!==expected[key])denied()
  const validForMs=Math.floor(value.remainingMs-(performance.now()-started)-5)
  if(validForMs<=0||signal.aborted)denied()
  return Object.freeze({request,validForMs,validUntil:new Date(Math.min(Date.now()+validForMs,Date.parse(request.deadlineAt))).toISOString()})
 }})
}
