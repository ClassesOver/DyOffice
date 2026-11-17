import {createHash} from 'node:crypto'
import type {PrincipalTransactions} from '../db/context.ts'
import {authError} from '../modules/auth/sessions.ts'
import {uuid,scope,loadFile,runFileTransaction} from '../modules/files/queries.ts'
import {enqueueTestBoundNativeJob} from '../modules/jobs/service.ts'
import {validatePdfRotationOperations} from '../../../worker/src/sandbox/pdf-rotation-schema.ts'
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
function commandSnapshot(raw:unknown){
 if(!raw||typeof raw!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(raw))||Reflect.ownKeys(raw).length!==3)throw authError(400)
 const data:Record<string,unknown>={}
 for(const key of ['version','action','operations']){const d=Object.getOwnPropertyDescriptor(raw,key);if(!d||!('value'in d)||!d.enumerable)throw authError(400);data[key]=d.value}
 if(data.version!==1||data.action!=='rotatePages')throw authError(400)
 const command=Object.freeze({version:1,action:'rotatePages',operations:validatePdfRotationOperations(data.operations)})
 const json=JSON.stringify(command);return {command,json,digest:sha(json)}
}
/** Candidate native-job command persistence, NOT a command-journal approval,
 * execution authority, native lease, runtime admission or signed ticket.
 * Candidate table is explicitly test-installed. No HTTP or worker registration.
 */
export function createTestPdfCommandQueue({transactions,unsafeTestOnly}:{transactions:PrincipalTransactions;unsafeTestOnly:true}){
 const gate=()=>{if(process.env.NODE_ENV!=='test'||unsafeTestOnly!==true)throw authError(403)};gate()
 function stored(row:{command_json:string;command_digest:string},expected?:ReturnType<typeof commandSnapshot>){
  try{const normalized=commandSnapshot(JSON.parse(row.command_json));if(normalized.json!==row.command_json||normalized.digest!==row.command_digest||(expected&&expected.json!==normalized.json))throw authError(409);return normalized}
  catch{throw authError(409)}
 }
 return Object.freeze({async enqueue(token:string,input:{artifactId:string;command:unknown},idempotencyKey:string){
  gate()
  if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).length!==2)throw authError(400)
  const artifact=Object.getOwnPropertyDescriptor(input,'artifactId'),raw=Object.getOwnPropertyDescriptor(input,'command')
  if(!artifact||!raw||!('value'in artifact)||!('value'in raw)||!artifact.enumerable||!raw.enumerable)throw authError(400)
  const artifactId=uuid(artifact.value),snapshot=commandSnapshot(raw.value)
  if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))throw authError(400)
  const hash=sha(JSON.stringify({type:'pdf.rotate',artifactId,commandDigest:snapshot.digest}))
  return enqueueTestBoundNativeJob({transactions,token,type:'pdf.rotate',artifactId,idempotencyKey,hash,binding:async(c,p,job,created)=>{
   gate()
   if(created)await c.query('INSERT INTO pdf_job_commands(deployment_id,owner_id,job_id,command_json,command_digest) VALUES($1,$2,$3,$4,$5)',[...scope(p),job.id,snapshot.json,snapshot.digest])
   const row=(await c.query('SELECT command_json,command_digest FROM pdf_job_commands WHERE deployment_id=$1 AND owner_id=$2 AND job_id=$3',[...scope(p),job.id])).rows[0]
   if(!row)throw authError(409);stored(row,snapshot)
  }})
 },async read(token:string,jobId:string){
  gate();const id=uuid(jobId)
  return runFileTransaction(transactions,token,'files:write',async(c,p)=>{
   gate();if(p.job)throw authError(404)
   const job=(await c.query('SELECT id,type,file_id,artifact_id,state,request_hash FROM native_jobs WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',[...scope(p),id])).rows[0]
   if(!job)throw authError(404);if(job.type!=='pdf.rotate')throw authError(409)
   const file=await loadFile(c,p,job.file_id)
   if(file.format!=='pdf'||file.current_revision!==job.artifact_id)throw authError(409)
   const row=(await c.query('SELECT command_json,command_digest FROM pdf_job_commands WHERE deployment_id=$1 AND owner_id=$2 AND job_id=$3',[...scope(p),id])).rows[0]
   if(!row)throw authError(409);const normalized=stored(row)
   if(job.request_hash!==sha(JSON.stringify({type:'pdf.rotate',artifactId:job.artifact_id,commandDigest:normalized.digest})))throw authError(409)
   return Object.freeze({job:Object.freeze({id:job.id,state:job.state,fileId:job.file_id,baseRevision:job.artifact_id}),command:normalized.command,digest:normalized.digest})
  })
 }})
}
