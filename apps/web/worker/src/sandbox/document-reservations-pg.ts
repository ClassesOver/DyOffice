import {randomBytes,createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {validateDocumentExecutionRequest,type DocumentExecutionRequest} from './document-contract.ts'
import {validateExecutionHandle,validateStopObservation,type ExecutionHandle,type StopObservation} from './document-control.ts'
import type {Reservation,ReservationGrant} from './document-execution-ports.ts'
import {DocumentContractError} from './document-profiles.ts'
const fail=(code:string):never=>{throw new DocumentContractError(code)}
/** Experimental persistence only. Not a PG authorizer, production factory or worker-role adapter.
 * Dedicated test-owner pool is required; no migration/privilege changes are installed here. */
export function createTestPostgresDocumentReservations(pool:Pool,options:{schema:string;deploymentId:string;unsafeTestOnly:true}){
 const gate=()=>{if(process.env.NODE_ENV!=='test'||options.unsafeTestOnly!==true)fail('DOCUMENT_RESERVATION_DISABLED')}
 gate()
 const schema=options.schema,deployment=options.deploymentId
 const owners=new Map<string,string>()
 const freshOwner=()=>createHash('sha256').update(randomBytes(32)).digest('hex')
 // Capture this capability synchronously at operation entry, never after awaiting PG.
 const ownerFor=(r:Reservation)=>{let owner=owners.get(r.reservationId);if(!owner){owner=freshOwner();owners.set(r.reservationId,owner)}return owner}
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema)||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deployment))fail('INVALID_RESERVATION_CONFIG')
 const table=(name:string)=>`"${schema}".${name}`
 function snapshot(raw:Reservation):Reservation{
  gate();const r={reservationId:raw.reservationId,jobId:raw.jobId,attempt:raw.attempt,jobEpoch:raw.jobEpoch}
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.jobId)||![r.attempt,r.jobEpoch].every(n=>Number.isSafeInteger(n)&&n>0)||r.reservationId!==`${deployment}/${r.jobId}/${r.attempt}/${r.jobEpoch}`)fail('INVALID_RESERVATION_KEY')
  return Object.freeze(r)
 }
 async function tx<T>(fn:(c:PoolClient,slots:number)=>Promise<T>):Promise<T>{
  gate();const c=await pool.connect();let discard:Error|undefined
  try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1s'");await c.query("SET LOCAL statement_timeout='2s'");const cap=await c.query(`SELECT slots FROM ${table('document_capacity')} WHERE deployment_id=$1 FOR UPDATE`,[deployment]);if(!cap.rowCount)fail('DOCUMENT_CAPACITY_UNCONFIGURED');const out=await fn(c,cap.rows[0].slots);await c.query('COMMIT');return out}
  catch(e){try{await c.query('ROLLBACK')}catch{discard=new Error('Reservation rollback failed')}throw e}finally{c.release(discard)}
 }
 const row=async(c:PoolClient,r:Reservation)=>{const q=await c.query(`SELECT * FROM ${table('document_reservations')} WHERE reservation_id=$1 AND deployment_id=$2`,[r.reservationId,deployment]);return q.rows[0]}
 const owned=async(c:PoolClient,r:Reservation,owner:string)=>{const v=await row(c,r);if(!v||v.owner_token!==owner)fail('DOCUMENT_RESERVATION_OWNER');return v}
 const update=async(c:PoolClient,r:Reservation,state:string,handle:ExecutionHandle|null,reason:string|null)=>{await c.query(`UPDATE ${table('document_reservations')} SET state=$2,handle=$3,reason=$4,version=version+1,updated_at=clock_timestamp() WHERE reservation_id=$1`,[r.reservationId,state,handle,reason])}
 const view=(v:any)=>Object.freeze({reservationId:v.reservation_id,state:v.state,version:Number(v.version),handle:v.handle,jobId:v.job_id,attempt:Number(v.attempt),jobEpoch:Number(v.epoch)})
 return Object.freeze({
  async reserve(raw:Reservation,input:DocumentExecutionRequest):Promise<ReservationGrant>{
   const r=snapshot(raw),owner=ownerFor(r),request=validateDocumentExecutionRequest(input,new Date())
   if(request.deploymentId!==deployment||request.jobId!==r.jobId||request.attempt!==r.attempt||request.jobEpoch!==r.jobEpoch)fail('DOCUMENT_RESERVATION_IDENTITY')
   return tx(async(c,slots)=>{
    if(!(await c.query('SELECT clock_timestamp() < $1::timestamptz AS live',[request.deadlineAt])).rows[0].live)fail('DOCUMENT_RESERVATION_EXPIRED')
    if(await row(c,r))fail('DOCUMENT_RESERVATION_ALREADY_CLAIMED')
    const fence=await c.query(`SELECT epoch FROM ${table('document_job_fences')} WHERE deployment_id=$1 AND job_id=$2`,[deployment,r.jobId]);if(fence.rowCount&&Number(fence.rows[0].epoch)>=r.jobEpoch)fail('DOCUMENT_EPOCH_FENCED')
    const count=await c.query(`SELECT count(*) AS n FROM ${table('document_reservations')} WHERE deployment_id=$1 AND state<>'released'`,[deployment]);if(Number(count.rows[0].n)>=slots)fail('DOCUMENT_CAPACITY_EXHAUSTED')
    await c.query(`INSERT INTO ${table('document_job_fences')} VALUES($1,$2,$3) ON CONFLICT(deployment_id,job_id) DO UPDATE SET epoch=EXCLUDED.epoch`,[deployment,r.jobId,r.jobEpoch])
    await c.query(`INSERT INTO ${table('document_reservations')}(reservation_id,deployment_id,job_id,attempt,epoch,owner_token,state,request) VALUES($1,$2,$3,$4,$5,$6,'reserved',$7)`,[r.reservationId,deployment,r.jobId,r.attempt,r.jobEpoch,owner,request])
    return Object.freeze({reservationId:r.reservationId,granted:true as const})
   })
  },
  async startIntent(raw:Reservation):Promise<void>{const r=snapshot(raw),owner=ownerFor(r);await tx(async c=>{const v=await owned(c,r,owner);const q=await c.query(`SELECT epoch FROM ${table('document_job_fences')} WHERE deployment_id=$1 AND job_id=$2`,[deployment,r.jobId]);if(!v.request || !(await c.query('SELECT clock_timestamp() < $1::timestamptz AS live',[v.request.deadlineAt])).rows[0].live)fail('DOCUMENT_RESERVATION_EXPIRED');if(v.state!=='reserved'||Number(q.rows[0]?.epoch)!==r.jobEpoch)fail('DOCUMENT_START_FENCED');await update(c,r,'start_intent',null,null)})},
  async bind(raw:Reservation,rawHandle:ExecutionHandle):Promise<void>{const r=snapshot(raw),owner=ownerFor(r),h=validateExecutionHandle(rawHandle);await tx(async c=>{const v=await owned(c,r,owner);if(v.state!=='start_intent')fail('DOCUMENT_BIND_STATE');const fence=await c.query(`SELECT epoch FROM ${table('document_job_fences')} WHERE deployment_id=$1 AND job_id=$2`,[deployment,r.jobId]);if(Number(fence.rows[0]?.epoch)!==r.jobEpoch)fail('DOCUMENT_EPOCH_FENCED');if(h.deploymentId!==deployment||h.jobId!==r.jobId||h.attempt!==r.attempt||h.jobEpoch!==r.jobEpoch||h.runtimeDigest!==v.request.runtimeDigest||h.profileId!==v.request.profileId)fail('DOCUMENT_RESERVATION_IDENTITY');await update(c,r,'bound',h,null)})},
  async retain(raw:Reservation,reason:string):Promise<void>{const r=snapshot(raw),owner=ownerFor(r);if(typeof reason!=='string'||reason.length>128)fail('INVALID_RETAIN_REASON');await tx(async c=>{const v=await row(c,r);if(v){if(v.state==='released')return;if(v.owner_token!==owner)fail('DOCUMENT_RESERVATION_OWNER');await update(c,r,'quarantined',v.handle,reason)}else await c.query(`INSERT INTO ${table('document_reservations')}(reservation_id,deployment_id,job_id,attempt,epoch,owner_token,state,reason) VALUES($1,$2,$3,$4,$5,$6,'quarantined',$7)`,[r.reservationId,deployment,r.jobId,r.attempt,r.jobEpoch,owner,reason]);await c.query(`INSERT INTO ${table('document_job_fences')} AS fences VALUES($1,$2,$3) ON CONFLICT(deployment_id,job_id) DO UPDATE SET epoch=GREATEST(fences.epoch,EXCLUDED.epoch)`,[deployment,r.jobId,r.jobEpoch])})},
  async release(raw:Reservation,evidence:{notStarted:true}|{stop:StopObservation}):Promise<void>{const r=snapshot(raw),owner=ownerFor(r);const proof:{stop:StopObservation}|{notStarted:boolean}='stop' in evidence?{stop:validateStopObservation(evidence.stop,evidence.stop.handle)}:{notStarted:evidence.notStarted};await tx(async c=>{const v=await owned(c,r,owner);if('stop' in proof){if(!v.handle||!proof.stop.confirmed)fail('DOCUMENT_STOP_UNKNOWN');validateStopObservation(proof.stop,v.handle);if(!['bound','quarantined','released'].includes(v.state))fail('DOCUMENT_RELEASE_STATE')}else if(proof.notStarted!==true||!['reserved','released'].includes(v.state)||v.handle)fail('DOCUMENT_START_MAY_HAVE_OCCURRED');if(v.state!=='released')await update(c,r,'released',v.handle,null)})},
  async inspect(raw:Reservation){const r=snapshot(raw);return tx(async c=>{const v=await row(c,r);if(!v)fail('DOCUMENT_RESERVATION_MISSING');return view(v)})},
  async recoverable(){return tx(async c=>(await c.query(`SELECT * FROM ${table('document_reservations')} WHERE deployment_id=$1 AND state<>'released' ORDER BY reservation_id`,[deployment])).rows.map(view))},
  async claimRecovery(raw:Reservation,version:number):Promise<void>{const r=snapshot(raw),owner=freshOwner();if(!Number.isSafeInteger(version)||version<1)fail('INVALID_RECOVERY_VERSION');await tx(async c=>{const v=await row(c,r);if(!v||v.state==='released'||Number(v.version)!==version)fail('DOCUMENT_RECOVERY_CONFLICT');await c.query(`UPDATE ${table('document_reservations')} SET owner_token=$2,state='quarantined',version=version+1,updated_at=clock_timestamp() WHERE reservation_id=$1`,[r.reservationId,owner])});owners.set(r.reservationId,owner)},
 })
}
