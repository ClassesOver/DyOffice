import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import type {Pool,PoolClient} from 'pg'
import {assertRuntimePool} from '../db/roles.ts'
import {snapshotPdfQueueCommand} from './command-queue.ts'
const id=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function fail():never{throw Object.assign(new Error('PDF_CLAIM_DENIED'),{code:'PDF_CLAIM_DENIED'})}
function record(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length)fail()
 const out:Record<string,unknown>={}
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)fail();out[key]=d.value}
 return out
}
/** Restricted worker control-plane reader; never pass its pool to a native process.
 * Returned facts are an instantaneous observation before edit-lease acquisition,
 * not a lease, execution ticket, runtime approval or future authorization grant.
 */
export function createTestPdfClaimReader({pool,deploymentId,unsafeTestOnly}:{pool:Pool;deploymentId:string;unsafeTestOnly:true}){
 const gate=()=>{if(process.env.NODE_ENV!=='test'||unsafeTestOnly!==true||!id.test(deploymentId))fail()};gate()
 let admitted:ReturnType<typeof assertRuntimePool>|undefined
 return Object.freeze({async read(raw:unknown){
  gate();const claim=record(raw,['jobId','epoch','token'])
  if(typeof claim.jobId!=='string'||!id.test(claim.jobId)||!Number.isSafeInteger(claim.epoch)||(claim.epoch as number)<1||typeof claim.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(claim.token))fail()
  const hash=createHash('sha256').update(claim.token as string).digest('hex'),started=performance.now()
  let c:PoolClient
  try{await(admitted??=assertRuntimePool(pool,'worker'));c=await pool.connect()}catch{fail()}
  let discard:Error|undefined
  try{
   gate();await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'");await c.query("SET LOCAL statement_timeout='2s'")
   const value=(await c.query('SELECT read_pdf_claim_command($1::uuid,$2::uuid,$3::bigint,$4::text) AS value',[deploymentId,claim.jobId,claim.epoch,hash])).rows[0]?.value
   const row=record(value,['commandJson','digest','observedAt','remainingMs','facts'])
   if(typeof row.commandJson!=='string'||Buffer.byteLength(row.commandJson)>16384)fail()
   const command=snapshotPdfQueueCommand(JSON.parse(row.commandJson))
   if(command.json!==row.commandJson||command.digest!==row.digest)fail()
   const facts=record(row.facts,['deploymentId','ownerId','sessionId','authVersion','fileId','baseRevision','jobId','jobEpoch','attempt','inputSha256','inputSize'])
   for(const key of ['deploymentId','ownerId','sessionId','fileId','baseRevision','jobId'])if(typeof facts[key]!=='string'||!id.test(facts[key] as string))fail()
   for(const key of ['authVersion','jobEpoch','attempt','inputSize'])if(!Number.isSafeInteger(facts[key])||(facts[key] as number)<1)fail()
   if(facts.deploymentId!==deploymentId||facts.jobId!==claim.jobId||facts.jobEpoch!==claim.epoch||(facts.inputSize as number)>33554432||typeof facts.inputSha256!=='string'||!/^[a-f0-9]{64}$/.test(facts.inputSha256))fail()
   if(typeof row.observedAt!=='string'||!Number.isFinite(Date.parse(row.observedAt))||!Number.isSafeInteger(row.remainingMs)||(row.remainingMs as number)<=0)fail()
   await c.query('COMMIT');gate()
   const remainingMs=Math.floor((row.remainingMs as number)-(performance.now()-started)-5);if(remainingMs<=0)fail()
   return Object.freeze({command:command.command,digest:command.digest,facts:Object.freeze(facts),observedAt:row.observedAt,remainingMs})
  }catch{try{await c.query('ROLLBACK')}catch{discard=new Error('PDF claim rollback failed')}fail()}finally{c.release(discard)}
 }})
}
