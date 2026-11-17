import {decodeBrokerAssertion,verifyBrokerAssertion,type BrokerAssertion} from './document-broker-assertion.ts'
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
 const recoveryOwners=new Map<string,string>()
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
 const task=async(c:PoolClient,r:Reservation,state:string,claimId:string|null=null)=>{
  await c.query(`INSERT INTO ${table('document_reconcile_tasks')}(reservation_id,state,claim_id) VALUES($1,$2,$3) ON CONFLICT(reservation_id) DO UPDATE SET state=EXCLUDED.state,claim_id=EXCLUDED.claim_id,updated_at=clock_timestamp()`,[r.reservationId,state,claimId])
 }
 const update=async(c:PoolClient,r:Reservation,state:string,handle:ExecutionHandle|null,reason:string|null)=>{await c.query(`UPDATE ${table('document_reservations')} SET state=$2,handle=$3,reason=$4,version=version+1,updated_at=clock_timestamp() WHERE reservation_id=$1`,[r.reservationId,state,handle,reason]);await task(c,r,state==='released'?'completed':'pending')}
 const view=(v:any)=>Object.freeze({reservationId:v.reservation_id,state:v.state,launchEvidence:v.launch_evidence,version:Number(v.version),handle:v.handle,jobId:v.job_id,attempt:Number(v.attempt),jobEpoch:Number(v.epoch)})
 const recoveryClaim=async(c:PoolClient,claim:{reservationId:string;claimId:string;version:number},owner:string)=>{
  const o=(await c.query(`SELECT * FROM ${table('document_reconcile_observations')} WHERE claim_id=$1`,[claim.claimId])).rows[0]
  const v=(await c.query(`SELECT * FROM ${table('document_reservations')} WHERE reservation_id=$1 AND deployment_id=$2`,[claim.reservationId,deployment])).rows[0]
  if(!o||!v||o.reservation_id!==claim.reservationId||o.owner_token!==owner||v.owner_token!==owner||Number(o.claimed_version)!==claim.version||v.state!=='quarantined'||!v.handle||v.launch_evidence!=='may_started'||Number(v.version)!==claim.version+1||o.outcome!=='blocked_uncertified')fail('DOCUMENT_RECOVERY_CONFLICT')
  return {observation:o,reservation:v}
 }
 const copyClaim=(raw:{reservationId:string;claimId:string;version:number})=>{
  gate();const claim=Object.freeze({reservationId:raw.reservationId,claimId:raw.claimId,version:raw.version}),owner=recoveryOwners.get(claim.claimId)
  if(!owner||!Number.isSafeInteger(claim.version)||claim.version<1)fail('DOCUMENT_RECOVERY_OWNER')
  return {claim,owner:owner!}
 }
 const bodyFor=(challenge:any,claim:{reservationId:string;claimId:string;version:number},reportedState:'stopped'|'unknown'):BrokerAssertion=>Object.freeze({
  protocolVersion:1,kind:'test-only-broker-assertion',challengeId:challenge.challenge_id,nonce:challenge.nonce,
  keyId:challenge.key_id,keyVersion:Number(challenge.key_version),claimId:claim.claimId,reservationId:claim.reservationId,
  reservationVersion:claim.version,expiresAt:challenge.expires_at.toISOString(),handle:validateExecutionHandle(challenge.handle),reportedState
 })
 const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
 const brokerSnapshot=(raw:{brokerId:string;brokerBootId:string})=>{
  if(!raw||typeof raw!=='object'||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).length!==2)fail('INVALID_DISPATCH_BROKER')
  const d=Object.getOwnPropertyDescriptors(raw)
  if(Object.keys(d).sort().join(',')!=='brokerBootId,brokerId'||!['brokerId','brokerBootId'].every(k=>'value' in d[k]&&uuid(d[k].value)))fail('INVALID_DISPATCH_BROKER')
  return Object.freeze({brokerId:d.brokerId.value as string,brokerBootId:d.brokerBootId.value as string})
 }
 const dispatchCall=async(c:PoolClient,args:unknown[])=>{
  try{return (await c.query(`SELECT ${table('document_dispatch_core')}($1,$2,$3,$4,$5,$6,$7) value`,args)).rows[0].value}
  catch(e){if(e instanceof Error&&/^(DOCUMENT_|INVALID_DISPATCH)/.test(e.message))fail(e.message);throw e}
 }
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
    await c.query(`INSERT INTO ${table('document_reservations')}(reservation_id,deployment_id,job_id,attempt,epoch,owner_token,state,request,launch_evidence) VALUES($1,$2,$3,$4,$5,$6,'reserved',$7,'not_started')`,[r.reservationId,deployment,r.jobId,r.attempt,r.jobEpoch,owner,request])
    await task(c,r,'pending');return Object.freeze({reservationId:r.reservationId,granted:true as const})
   })
  },
  async prepareDispatch(raw:Reservation,rawBroker:{brokerId:string;brokerBootId:string}){
   const r=snapshot(raw),owner=ownerFor(r),broker=brokerSnapshot(rawBroker)
   return tx(c=>dispatchCall(c,[r.reservationId,owner,broker.brokerId,broker.brokerBootId,null,null,'prepare']))
  },
  async consumeDispatch(raw:Reservation,dispatchId:string,rawBroker:{brokerId:string;brokerBootId:string},challengeId:string){
   const r=snapshot(raw),owner=ownerFor(r),broker=brokerSnapshot(rawBroker)
   if(!uuid(dispatchId)||!uuid(challengeId))fail('INVALID_DISPATCH_ID')
   return tx(c=>dispatchCall(c,[r.reservationId,owner,broker.brokerId,broker.brokerBootId,dispatchId,challengeId,'consume']))
  },
  async observeDispatch(raw:Reservation){const r=snapshot(raw);return tx(c=>dispatchCall(c,[r.reservationId,null,null,null,null,null,'history']))},
  async startIntent(raw:Reservation):Promise<void>{const r=snapshot(raw),owner=ownerFor(r);await tx(async c=>{const v=await owned(c,r,owner);const q=await c.query(`SELECT epoch FROM ${table('document_job_fences')} WHERE deployment_id=$1 AND job_id=$2`,[deployment,r.jobId]);if(!v.request || !(await c.query('SELECT clock_timestamp() < $1::timestamptz AS live',[v.request.deadlineAt])).rows[0].live)fail('DOCUMENT_RESERVATION_EXPIRED');if(v.state!=='reserved'||Number(q.rows[0]?.epoch)!==r.jobEpoch)fail('DOCUMENT_START_FENCED');await c.query(`UPDATE ${table('document_reservations')} SET launch_evidence='may_started' WHERE reservation_id=$1`,[r.reservationId]);await update(c,r,'start_intent',null,null)})},
  async bind(raw:Reservation,rawHandle:ExecutionHandle):Promise<void>{const r=snapshot(raw),owner=ownerFor(r),h=validateExecutionHandle(rawHandle);await tx(async c=>{const v=await owned(c,r,owner);if(v.state!=='start_intent'||v.launch_evidence!=='may_started')fail('DOCUMENT_BIND_STATE');const fence=await c.query(`SELECT epoch FROM ${table('document_job_fences')} WHERE deployment_id=$1 AND job_id=$2`,[deployment,r.jobId]);if(Number(fence.rows[0]?.epoch)!==r.jobEpoch)fail('DOCUMENT_EPOCH_FENCED');if(h.deploymentId!==deployment||h.jobId!==r.jobId||h.attempt!==r.attempt||h.jobEpoch!==r.jobEpoch||h.runtimeDigest!==v.request.runtimeDigest||h.profileId!==v.request.profileId)fail('DOCUMENT_RESERVATION_IDENTITY');await update(c,r,'bound',h,null)})},
  async retain(raw:Reservation,reason:string):Promise<void>{const r=snapshot(raw),owner=ownerFor(r);if(typeof reason!=='string'||reason.length>128)fail('INVALID_RETAIN_REASON');await tx(async c=>{const v=await row(c,r);if(v){if(v.state==='released')return;if(v.owner_token!==owner)fail('DOCUMENT_RESERVATION_OWNER');await update(c,r,'quarantined',v.handle,reason)}else await c.query(`INSERT INTO ${table('document_reservations')}(reservation_id,deployment_id,job_id,attempt,epoch,owner_token,state,reason) VALUES($1,$2,$3,$4,$5,$6,'quarantined',$7)`,[r.reservationId,deployment,r.jobId,r.attempt,r.jobEpoch,owner,reason]);await task(c,r,'pending');await c.query(`INSERT INTO ${table('document_job_fences')} AS fences VALUES($1,$2,$3) ON CONFLICT(deployment_id,job_id) DO UPDATE SET epoch=GREATEST(fences.epoch,EXCLUDED.epoch)`,[deployment,r.jobId,r.jobEpoch])})},
  async release(raw:Reservation,evidence:{notStarted:true}|{stop:StopObservation}):Promise<void>{const r=snapshot(raw),owner=ownerFor(r);const proof:{stop:StopObservation}|{notStarted:boolean}='stop' in evidence?{stop:validateStopObservation(evidence.stop,evidence.stop.handle)}:{notStarted:evidence.notStarted};await tx(async c=>{const v=await owned(c,r,owner);if('stop' in proof){if(!v.handle||!proof.stop.confirmed)fail('DOCUMENT_STOP_UNKNOWN');validateStopObservation(proof.stop,v.handle);if(!['bound','quarantined','released'].includes(v.state))fail('DOCUMENT_RELEASE_STATE')}else if(proof.notStarted!==true||!['reserved','released'].includes(v.state)||v.handle||!v.request||v.launch_evidence!=='not_started')fail('DOCUMENT_START_MAY_HAVE_OCCURRED');if(v.state!=='released')await update(c,r,'released',v.handle,null)})},
  async issueBrokerChallenge(raw:{reservationId:string;claimId:string;version:number},keyId:string){
   const {claim,owner}=copyClaim(raw)
   if(typeof keyId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(keyId))fail('DOCUMENT_BROKER_KEY_DENIED')
   return tx(async c=>{
    const {reservation:v}=await recoveryClaim(c,claim,owner)
    const key=(await c.query(`SELECT * FROM ${table('document_broker_keys')} WHERE key_id=$1 FOR SHARE`,[keyId])).rows[0]
    if(!key||!key.active||key.deployment_id!==deployment||key.broker_boot_id!==v.handle.brokerBootId||key.scope!=='test-only'||key.os_stop_certified)fail('DOCUMENT_BROKER_KEY_DENIED')
    const live=(await c.query('SELECT clock_timestamp() < $1::timestamptz AS live',[key.not_after])).rows[0].live
    if(!live)fail('DOCUMENT_BROKER_KEY_DENIED')
    let challenge=(await c.query(`SELECT * FROM ${table('document_broker_challenges')} WHERE claim_id=$1`,[claim.claimId])).rows[0]
    if(challenge){if(challenge.key_id!==keyId||Number(challenge.key_version)!==Number(key.version))fail('DOCUMENT_BROKER_CHALLENGE_CONFLICT')}
    else challenge=(await c.query(`INSERT INTO ${table('document_broker_challenges')}(claim_id,key_id,key_version,expires_at,handle) VALUES($1,$2,$3,date_trunc('milliseconds',LEAST(clock_timestamp()+interval '500 milliseconds',$4::timestamptz)),$5) RETURNING *`,[claim.claimId,keyId,key.version,key.not_after,v.handle])).rows[0]
    return bodyFor(challenge,claim,'unknown')
   })
  },
  async acceptBrokerAssertion(raw:{reservationId:string;claimId:string;version:number},frame:Uint8Array){
   const {claim,owner}=copyClaim(raw),decoded=decodeBrokerAssertion(frame)
   return tx(async c=>{
    const {reservation:v}=await recoveryClaim(c,claim,owner)
    const body=decoded.body
    const challenge=(await c.query(`SELECT * FROM ${table('document_broker_challenges')} WHERE challenge_id=$1 AND claim_id=$2`,[body.challengeId,claim.claimId])).rows[0]
    if(!challenge)fail('DOCUMENT_BROKER_CHALLENGE_DENIED')
    const key=(await c.query(`SELECT * FROM ${table('document_broker_keys')} WHERE key_id=$1 FOR SHARE`,[challenge.key_id])).rows[0]
    if(!key||!key.active||key.scope!=='test-only'||key.os_stop_certified||key.deployment_id!==deployment||key.broker_boot_id!==v.handle.brokerBootId||Number(key.version)!==Number(challenge.key_version))fail('DOCUMENT_BROKER_KEY_DENIED')
    const expected=bodyFor(challenge,claim,body.reportedState)
    if(JSON.stringify(body)!==JSON.stringify(expected)||JSON.stringify(validateExecutionHandle(v.handle))!==JSON.stringify(expected.handle))fail('DOCUMENT_BROKER_ASSERTION_DENIED')
    verifyBrokerAssertion(key.public_key,body,decoded.signature)
    const receipt=(await c.query(`SELECT * FROM ${table('document_broker_receipts')} WHERE challenge_id=$1`,[challenge.challenge_id])).rows[0]
    const live=(await c.query('SELECT clock_timestamp() < $1::timestamptz AS key_live,clock_timestamp() < $2::timestamptz AS challenge_live',[key.not_after,challenge.expires_at])).rows[0]
    if(!live.key_live)fail('DOCUMENT_BROKER_KEY_DENIED')
    if(!live.challenge_live)fail('DOCUMENT_BROKER_CHALLENGE_EXPIRED')
    if(receipt){if(receipt.receipt_sha256!==decoded.digest)fail('DOCUMENT_BROKER_NONCE_CONSUMED')}
    else {
     await c.query(`INSERT INTO ${table('document_broker_receipts')}(challenge_id,receipt_sha256,reported_state,classification) VALUES($1,$2,$3,'authenticated_assertion_os_unverified')`,[challenge.challenge_id,decoded.digest,body.reportedState])
    }
    const finalLive=(await c.query('SELECT clock_timestamp() < $1::timestamptz AND clock_timestamp() < $2::timestamptz AS live',[key.not_after,challenge.expires_at])).rows[0].live
    if(!finalLive)fail('DOCUMENT_BROKER_CHALLENGE_EXPIRED')
    // Signed provenance is NOT OS stop evidence. No reservation or task is released.
    return Object.freeze({challengeId:challenge.challenge_id,classification:'authenticated_assertion_os_unverified' as const,reportedState:body.reportedState})
   })
  },
  async claimReconcile(raw:Reservation,version:number,claimId:string){
   const r=snapshot(raw)
   if(!Number.isSafeInteger(version)||version<1||typeof claimId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(claimId))fail('INVALID_RECOVERY_CLAIM')
   let owner=recoveryOwners.get(claimId)
   if(!owner){if(recoveryOwners.size>=1024)fail('DOCUMENT_RECOVERY_CAPACITY');owner=freshOwner();recoveryOwners.set(claimId,owner)}
   const expectedOwner=owner
   const result=await tx(async c=>{
    const old=(await c.query(`SELECT * FROM ${table('document_reconcile_observations')} WHERE claim_id=$1`,[claimId])).rows[0]
    if(old){
     if(old.reservation_id!==r.reservationId||old.owner_token!==expectedOwner||Number(old.claimed_version)!==version+1)fail('DOCUMENT_RECOVERY_KEY_REUSED')
     const v=await owned(c,r,expectedOwner)
     if(Number(v.version)!==Number(old.claimed_version)&&old.outcome===null)fail('DOCUMENT_RECOVERY_CONFLICT')
     return Object.freeze({reservationId:r.reservationId,claimId,version:Number(old.claimed_version)})
    }
    const v=await row(c,r)
    if(!v||v.state==='released'||Number(v.version)!==version)fail('DOCUMENT_RECOVERY_CONFLICT')
    const count=await c.query(`SELECT count(*) AS n FROM ${table('document_reconcile_observations')} WHERE reservation_id=$1`,[r.reservationId]);if(Number(count.rows[0].n)>=64)fail('DOCUMENT_RECOVERY_CAPACITY')
    await c.query(`UPDATE ${table('document_reservations')} SET owner_token=$2,state='quarantined',version=version+1,updated_at=clock_timestamp() WHERE reservation_id=$1`,[r.reservationId,expectedOwner])
    await c.query(`INSERT INTO ${table('document_reconcile_observations')}(claim_id,reservation_id,owner_token,claimed_version) VALUES($1,$2,$3,$4)`,[claimId,r.reservationId,expectedOwner,version+1])
    await task(c,r,'claimed',claimId)
    return Object.freeze({reservationId:r.reservationId,claimId,version:version+1})
   })
   owners.set(r.reservationId,expectedOwner)
   return result
  },
  async completeReconcile(raw:{reservationId:string;claimId:string;version:number}){
   gate()
   const claim=Object.freeze({reservationId:raw.reservationId,claimId:raw.claimId,version:raw.version})
   const owner=recoveryOwners.get(claim.claimId)
   if(!owner||!Number.isSafeInteger(claim.version)||claim.version<1)fail('DOCUMENT_RECOVERY_OWNER')
   return tx(async c=>{
    const observation=(await c.query(`SELECT * FROM ${table('document_reconcile_observations')} WHERE claim_id=$1`,[claim.claimId])).rows[0]
    if(!observation||observation.reservation_id!==claim.reservationId||observation.owner_token!==owner||Number(observation.claimed_version)!==claim.version)fail('DOCUMENT_RECOVERY_CONFLICT')
    const v=(await c.query(`SELECT * FROM ${table('document_reservations')} WHERE reservation_id=$1 AND deployment_id=$2`,[claim.reservationId,deployment])).rows[0]
    if(!v||v.owner_token!==owner)fail('DOCUMENT_RECOVERY_OWNER')
    if(observation.outcome!==null){
     if(Number(v.version)!==claim.version+1)fail('DOCUMENT_RECOVERY_CONFLICT')
     return Object.freeze({reservationId:claim.reservationId,claimId:claim.claimId,outcome:observation.outcome as string})
    }
    if(Number(v.version)!==claim.version||v.state!=='quarantined')fail('DOCUMENT_RECOVERY_CONFLICT')
    const r=snapshot({reservationId:v.reservation_id,jobId:v.job_id,attempt:Number(v.attempt),jobEpoch:Number(v.epoch)})
    // Only PG evidence can authorize this no-start decision. No backend is invoked.
    const noStart=v.request!==null&&v.launch_evidence==='not_started'&&v.handle===null
    const outcome=noStart?'released_not_started':v.launch_evidence==='unknown'?'blocked_unknown':'blocked_uncertified'
    await update(c,r,noStart?'released':'quarantined',v.handle,noStart?null:'BROKER_UNCERTIFIED')
    await c.query(`UPDATE ${table('document_reconcile_observations')} SET outcome=$2 WHERE claim_id=$1`,[claim.claimId,outcome])
    await task(c,r,noStart?'completed':'blocked',claim.claimId)
    return Object.freeze({reservationId:claim.reservationId,claimId:claim.claimId,outcome})
   })
  },
  async inspect(raw:Reservation){const r=snapshot(raw);return tx(async c=>{const v=await row(c,r);if(!v)fail('DOCUMENT_RESERVATION_MISSING');return view(v)})},
  async recoverable(){return tx(async c=>(await c.query(`SELECT * FROM ${table('document_reservations')} WHERE deployment_id=$1 AND state<>'released' ORDER BY reservation_id`,[deployment])).rows.map(view))},
  async claimRecovery(raw:Reservation,version:number):Promise<void>{const r=snapshot(raw),owner=freshOwner();if(!Number.isSafeInteger(version)||version<1)fail('INVALID_RECOVERY_VERSION');await tx(async c=>{const v=await row(c,r);if(!v||v.state==='released'||Number(v.version)!==version)fail('DOCUMENT_RECOVERY_CONFLICT');await c.query(`UPDATE ${table('document_reservations')} SET owner_token=$2,state='quarantined',version=version+1,updated_at=clock_timestamp() WHERE reservation_id=$1`,[r.reservationId,owner]);await task(c,r,'pending')});owners.set(r.reservationId,owner)},
 })
}
