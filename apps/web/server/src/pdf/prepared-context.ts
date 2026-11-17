import {createHash,randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import type {Pool} from 'pg'
import {validateNativeExecutionFacts} from '../../../worker/src/sandbox/document-native-authority-pg.ts'
import {snapshotPdfQueueCommand} from './command-queue.ts'
function denied():never{throw Object.assign(new Error('PDF_CONTEXT_DENIED'),{code:'PDF_CONTEXT_DENIED'})}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
function record(value:unknown,keys:string[]):Record<string,any>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length)denied()
 const out:Record<string,any>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)denied();out[key]=d.value}return out
}
function id(value:unknown):string{if(typeof value!=='string'||!uuid.test(value))denied();return value}
function positive(value:unknown):number{if(!Number.isSafeInteger(value)||(value as number)<1)denied();return value as number}
function ref(value:unknown){const r=record(value,['id','version']);return Object.freeze({id:id(r.id),version:positive(r.version)})}
function token(value:unknown){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))denied();return hash(value)}
type Options={schema:string;unsafeTestOnly:true}
function client(pool:Pool,options:Options){
 const schema=options.schema,enabled=options.unsafeTestOnly===true
 const gate=()=>{if(process.env.NODE_ENV!=='test'||!enabled||!/^[a-z][a-z0-9_]{0,62}$/.test(schema))denied()};gate()
 return {gate,async call(name:string,values:unknown[]){
  gate();const start=performance.now(),c=await pool.connect();let discard:Error|undefined
  try{
   gate();await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'");await c.query("SET LOCAL statement_timeout='2s'")
   const r=(await c.query('SELECT current_user AS name,session_user AS login,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0]
   if(!r||r.name!==r.login||['rolsuper','rolbypassrls','rolcreatedb','rolcreaterole','rolreplication','rolinherit'].some(k=>r[k]))denied()
   const value=(await c.query(`SELECT "${schema}".${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,values)).rows[0]?.value
   await c.query('COMMIT');gate();return {value,elapsed:performance.now()-start}
  }catch{try{await c.query('ROLLBACK')}catch{discard=new Error('PDF context rollback failed')}denied()}finally{c.release(discard)}
 }}
}
function observation(value:unknown,elapsed:number){
 const r=record(value,['kind','facts','commandJson','commandDigest','requestHash','tenantId','runtimeDigest','runtimeEnvironment','scopeId','scopeVersion','runtimeId','runtimeVersion','context','remainingMs'])
 if(r.kind!=='command-bound-non-executable'||r.runtimeEnvironment!=='test-approved'||typeof r.commandJson!=='string'||Buffer.byteLength(r.commandJson)>16384)denied()
 const command=snapshotPdfQueueCommand(JSON.parse(r.commandJson)),facts=validateNativeExecutionFacts(r.facts)
 if(facts.jobType!=='pdf.rotate'||command.json!==r.commandJson||command.digest!==r.commandDigest||r.requestHash!==hash(JSON.stringify({type:'pdf.rotate',artifactId:facts.baseRevision,commandDigest:command.digest})))denied()
 id(r.tenantId);id(r.scopeId);id(r.runtimeId);positive(r.scopeVersion);positive(r.runtimeVersion)
 if(typeof r.runtimeDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.runtimeDigest))denied()
 const context=ref(r.context),remainingMs=Math.floor(positive(r.remainingMs)-elapsed-5);if(remainingMs<=0)denied()
 return Object.freeze({kind:'command-bound-non-executable' as const,context,facts,command:command.command,commandDigest:command.digest,requestHash:r.requestHash as string,tenantId:id(r.tenantId),runtimeDigest:r.runtimeDigest as string,runtimeEnvironment:'test-approved' as const,scopeId:id(r.scopeId),scopeVersion:positive(r.scopeVersion),runtimeId:id(r.runtimeId),runtimeVersion:positive(r.runtimeVersion),remainingMs})
}
/** Candidate metadata only, not ExecutionPorts.authority or an executable request.
 * Issuer cannot register scope/runtime: those are explicit test-owner fixtures.
 */
export function createTestPdfPreparedContextIssuer(pool:Pool,options:Options&{deploymentId:string}){
 const db=client(pool,options),deployment=id(options.deploymentId)
 return Object.freeze({async issue(raw:unknown,rawRegistry:unknown){
  db.gate();const c=record(raw,['jobId','epoch','token']),job=id(c.jobId),epoch=positive(c.epoch),claimHash=token(c.token)
  const r=record(rawRegistry,['scopeId','scopeVersion','runtimeId','runtimeVersion']),scope=id(r.scopeId),scopeVersion=positive(r.scopeVersion),runtime=id(r.runtimeId),runtimeVersion=positive(r.runtimeVersion),contextId=randomUUID()
  try{const result=await db.call('pdf_issue_prepared_context',[contextId,deployment,job,epoch,claimHash,scope,scopeVersion,runtime,runtimeVersion]),out=observation(result.value,result.elapsed)
   if(out.context.id!==contextId||out.context.version!==1||out.facts.jobId!==job||out.facts.jobEpoch!==epoch||out.facts.deploymentId!==deployment||out.scopeId!==scope||out.scopeVersion!==scopeVersion||out.runtimeId!==runtime||out.runtimeVersion!==runtimeVersion)denied();return out
  }catch{const error=Object.assign(new Error('PDF_CONTEXT_DENIED'),{code:'PDF_CONTEXT_DENIED',contextId});throw error}
 },async revoke(raw:unknown){db.gate();const r=ref(raw);if((await db.call('pdf_revoke_prepared_context',[r.id,r.version])).value!==true)denied()}})
}
export function createTestPdfPreparedContextReader(pool:Pool,options:Options){
 const db=client(pool,options)
 return Object.freeze({async verify(raw:unknown,jobToken:string){
  db.gate();const r=ref(raw),claimHash=token(jobToken)
  try{const result=await db.call('pdf_verify_prepared_context',[r.id,r.version,claimHash]),out=observation(result.value,result.elapsed);if(out.context.id!==r.id||out.context.version!==r.version)denied();return out}catch{denied()}
 }})
}
