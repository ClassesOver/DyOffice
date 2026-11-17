import {createHash,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import type {PrincipalTransactions,BusinessPrincipal} from '../../db/context.ts'
import type {ObjectStore} from '../../storage/object-store.ts'

export interface HarnessArtifactBinding {taskId:string;claimId:string;epoch:number}
export interface HarnessArtifactRef {artifactId:string;taskId:string;name:string;mediaType:string;role:string;inputResultIds:string[];sha256:string;sizeBytes:number}
export interface AnalysisDelivery {taskId:string;claimId:string;connectionEpoch:number;commandId:string;summary:string;artifacts:HarnessArtifactRef[];inputs:unknown[];runtimeManifestSha256:string;limitations:string[];createdAt:string}
export interface HarnessArtifactStage extends HarnessArtifactBinding {name:string;mediaType:string;role:string;inputResultIds:string[];sha256:string}
export interface HarnessArtifactCommit extends HarnessArtifactBinding {commandId:string;summary:string;artifactIds:string[];inputs:unknown[];runtimeManifestSha256:string;limitations:string[]}
const fail=(statusCode=400)=>Object.assign(Error('Analysis artifact unavailable'),{statusCode})
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
function uuid(value:unknown):string {
 if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw fail()
 return value.toLowerCase()
}
function binding(input:HarnessArtifactBinding):HarnessArtifactBinding {
 if(!input||!Number.isSafeInteger(input.epoch)||input.epoch<1||input.epoch>2147483647)throw fail()
 return {taskId:uuid(input.taskId),claimId:uuid(input.claimId),epoch:input.epoch}
}
function sha(value:unknown):string {if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw fail();return value}
function boundedText(value:unknown,max:number):string {if(typeof value!=='string'||Buffer.byteLength(value)>max)throw fail();return value}
function ids(value:unknown,max:number):string[] {
 if(!Array.isArray(value)||value.length>max)throw fail()
 const result=value.map(uuid);if(new Set(result).size!==result.length)throw fail();return result
}
function canonical(value:unknown,depth=0):unknown {
 if(depth>12)throw fail()
 if(value===null||typeof value==='string'||typeof value==='boolean')return value
 if(typeof value==='number'&&Number.isFinite(value))return value
 if(Array.isArray(value))return value.map(item=>canonical(item,depth+1))
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw fail()
 return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical((value as Record<string,unknown>)[key],depth+1)]))
}
type ArtifactRow={artifact_id:string;task_id:string;object_key:string;name:string;media_type:string;role:string;input_result_ids:string[];sha256:string;size_bytes:number;state:string}
const ref=(row:ArtifactRow):HarnessArtifactRef=>({artifactId:row.artifact_id,taskId:row.task_id,name:row.name,mediaType:row.media_type,role:row.role,inputResultIds:row.input_result_ids,sha256:row.sha256,sizeBytes:row.size_bytes})
const scope=(p:BusinessPrincipal)=>[p.deploymentId,p.userId]

/** INTERNAL writer API: only the data-grant service may call stage/commit with
 * its privately bound owner session. Never mount these DTOs directly as HTTP.
 * Objects have a separate 16MiB owner budget; reserved/unknown writes stay
 * charged. Committed receipts and bytes survive runner workspace cleanup.
 */
export function createHarnessArtifacts({transactions,objects}:{transactions:PrincipalTransactions;objects:ObjectStore}) {
 async function access<T>(token:string,operation:(c:PoolClient,p:BusinessPrincipal)=>Promise<T>):Promise<T> {
  return transactions.withPrincipalTransaction({kind:'session',token},async(c,p)=>{
   if(!p.roles.includes('personal')||p.job)throw fail(404)
   return operation(c,p)
  })
 }
 async function lock(c:PoolClient,p:BusinessPrincipal) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['harness-artifacts:'+scope(p).join(':')])
 }
 async function task(c:PoolClient,p:BusinessPrincipal,b:HarnessArtifactBinding,state='staging') {
  const row=(await c.query('SELECT claim_id,epoch,state FROM harness_artifact_tasks WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),b.taskId])).rows[0]
  if(!row||row.claim_id!==b.claimId||row.epoch!==b.epoch||row.state!==state)throw fail(409)
 }
 return {
  async stage(token:string,input:HarnessArtifactStage,source:Buffer):Promise<HarnessArtifactRef> {
   const b=binding(input),name=boundedText(input.name,240),mediaType=boundedText(input.mediaType,120),role=boundedText(input.role,64),inputResultIds=ids(input.inputResultIds,32),expected=sha(input.sha256)
   if(!name||name.length>200||name!==name.trim()||/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/u.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)||!/^[-a-zA-Z0-9.+]+\/[-a-zA-Z0-9.+]+$/.test(mediaType)||!/^[-a-zA-Z0-9_]{1,64}$/.test(role))throw fail()
   if(!Buffer.isBuffer(source)||source.length<1||source.length>8*1024*1024)throw fail(413)
   const bytes=Buffer.from(source);if(hash(bytes)!==expected)throw fail()
   const artifactId=randomUUID()
   const row=await access(token,async(c,p)=>{
    await lock(c,p)
    await c.query('INSERT INTO harness_artifact_accounts(deployment_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING',scope(p))
    await c.query('INSERT INTO harness_artifact_tasks(task_id,deployment_id,owner_id,claim_id,epoch) VALUES($3,$1,$2,$4,$5) ON CONFLICT DO NOTHING',[...scope(p),b.taskId,b.claimId,b.epoch])
    await task(c,p,b)
    const used=(await c.query('SELECT count(*) AS count,COALESCE(sum(size_bytes),0) AS bytes FROM harness_artifacts WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),b.taskId])).rows[0]
    if(Number(used.count)>=12||Number(used.bytes)+bytes.length>16*1024*1024)throw fail(413)
    const charged=await c.query('UPDATE harness_artifact_accounts SET used_bytes=used_bytes+$3 WHERE deployment_id=$1 AND owner_id=$2 AND used_bytes+$3<=16777216 RETURNING used_bytes',[...scope(p),bytes.length])
    if(!charged.rowCount)throw fail(413)
    return (await c.query<ArtifactRow>('INSERT INTO harness_artifacts(artifact_id,deployment_id,owner_id,task_id,object_key,name,media_type,role,input_result_ids,sha256,size_bytes) VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[...scope(p),artifactId,b.taskId,p.deploymentId+'/'+p.userId+'/objects/'+artifactId,name,mediaType,role,JSON.stringify(inputResultIds),expected,bytes.length])).rows[0]!
   })
   // The committed reservation accounts for ambiguous object writes. Serialize
   // object publication with cancel/commit so removal cannot race an upload.
   return access(token,async(c,p)=>{
    await lock(c,p);await task(c,p,b)
    await objects.putImmutable(row.object_key,bytes,{size:bytes.length,sha256:expected})
    await c.query("UPDATE harness_artifacts SET state='ready' WHERE deployment_id=$1 AND owner_id=$2 AND artifact_id=$3 AND state='reserved'",[...scope(p),artifactId])
    return ref(row)
   })
  },
  async commit(token:string,input:HarnessArtifactCommit):Promise<AnalysisDelivery> {
   const b=binding(input),commandId=uuid(input.commandId),artifactIds=ids(input.artifactIds,12),summary=boundedText(input.summary,16000),runtimeManifestSha256=sha(input.runtimeManifestSha256)
   if(!artifactIds.length||!Array.isArray(input.inputs)||input.inputs.length>32||!Array.isArray(input.limitations)||input.limitations.length>32)throw fail()
   const inputs=canonical(input.inputs) as unknown[],limitations=input.limitations.map(value=>boundedText(value,2000))
   const inputIds=ids(inputs.map(value=>value&&typeof value==='object'&&!Array.isArray(value)?(value as Record<string,unknown>).resultId:undefined),32)
   const params=JSON.stringify(canonical({...b,commandId,artifactIds,summary,inputs,runtimeManifestSha256,limitations}))
   if(Buffer.byteLength(params)>64000)throw fail(413)
   const paramsHash=hash(params)
   return access(token,async(c,p)=>{
    await lock(c,p)
    const prior=(await c.query('SELECT params_hash,receipt FROM harness_analysis_deliveries WHERE deployment_id=$1 AND owner_id=$2 AND command_id=$3',[...scope(p),commandId])).rows[0]
    if(prior){if(prior.params_hash!==paramsHash)throw fail(409);return prior.receipt as AnalysisDelivery}
    await task(c,p,b)
    const rows=(await c.query<ArtifactRow>('SELECT * FROM harness_artifacts WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3 ORDER BY artifact_id',[...scope(p),b.taskId])).rows
    if(rows.length!==artifactIds.length||rows.some(row=>row.state!=='ready'||!artifactIds.includes(row.artifact_id)||row.input_result_ids.some(id=>!inputIds.includes(id))))throw fail(409)
    for(const row of rows)await objects.verifyObject({key:row.object_key,size:row.size_bytes,sha256:row.sha256})
    const artifacts=artifactIds.map(id=>ref(rows.find(row=>row.artifact_id===id)!))
    const delivery:AnalysisDelivery={taskId:b.taskId,claimId:b.claimId,connectionEpoch:b.epoch,commandId,summary,artifacts,inputs,runtimeManifestSha256,limitations,createdAt:new Date().toISOString()}
    await c.query('INSERT INTO harness_analysis_deliveries(deployment_id,owner_id,command_id,task_id,params_hash,receipt) VALUES($1,$2,$3,$4,$5,$6)',[...scope(p),commandId,b.taskId,paramsHash,JSON.stringify(delivery)])
    await c.query("UPDATE harness_artifacts SET state='committed' WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3",[...scope(p),b.taskId])
    await c.query("UPDATE harness_artifact_tasks SET state='committed' WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3",[...scope(p),b.taskId])
    return delivery
   })
  },
  async receipt(token:string,commandId:string):Promise<AnalysisDelivery> {
   const id=uuid(commandId)
   return access(token,async(c,p)=>{
    const row=(await c.query('SELECT receipt FROM harness_analysis_deliveries WHERE deployment_id=$1 AND owner_id=$2 AND command_id=$3',[...scope(p),id])).rows[0]
    if(!row)throw fail(404);return row.receipt as AnalysisDelivery
   })
  },
  async read(token:string,artifactId:string):Promise<HarnessArtifactRef> {
   const id=uuid(artifactId)
   return access(token,async(c,p)=>{
    const row=(await c.query<ArtifactRow>("SELECT * FROM harness_artifacts WHERE deployment_id=$1 AND owner_id=$2 AND artifact_id=$3 AND state='committed'",[...scope(p),id])).rows[0]
    if(!row)throw fail(404);return ref(row)
   })
  },
  async download(token:string,artifactId:string):Promise<{artifact:HarnessArtifactRef;bytes:Buffer}> {
   const id=uuid(artifactId)
   return access(token,async(c,p)=>{
    const row=(await c.query<ArtifactRow>("SELECT * FROM harness_artifacts WHERE deployment_id=$1 AND owner_id=$2 AND artifact_id=$3 AND state='committed'",[...scope(p),id])).rows[0]
    if(!row)throw fail(404)
    return {artifact:ref(row),bytes:await objects.readVerified({key:row.object_key,size:row.size_bytes,sha256:row.sha256})}
   })
  },
  async cancel(token:string,input:HarnessArtifactBinding):Promise<{removed:number}> {
   const b=binding(input)
   return access(token,async(c,p)=>{
    await lock(c,p)
    const current=(await c.query('SELECT claim_id,epoch,state FROM harness_artifact_tasks WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),b.taskId])).rows[0]
    if(!current||current.claim_id!==b.claimId||current.epoch!==b.epoch)throw fail(404)
    if(current.state!=='staging')return {removed:0}
    if(!objects.removeUnreferenced)throw fail(503)
    const rows=(await c.query<ArtifactRow>('SELECT * FROM harness_artifacts WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),b.taskId])).rows
    for(const row of rows)await objects.removeUnreferenced(row.object_key)
    await c.query('DELETE FROM harness_artifacts WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),b.taskId])
    await c.query('UPDATE harness_artifact_accounts SET used_bytes=used_bytes-$3 WHERE deployment_id=$1 AND owner_id=$2',[...scope(p),rows.reduce((sum,row)=>sum+row.size_bytes,0)])
    await c.query("UPDATE harness_artifact_tasks SET state='cancelled' WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3",[...scope(p),b.taskId])
    return {removed:rows.length}
   })
  },
 }
}
