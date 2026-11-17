import {createHash} from 'node:crypto'
import type {PrincipalTransactions} from '../db/context.ts'
import {authorize} from '../modules/policy/authorize.ts'
import {authError} from '../modules/auth/sessions.ts'
import {loadFile,scope,uuid} from '../modules/files/queries.ts'
const unresolved=()=>Object.freeze({state:'unresolved' as const})
/** Read-only reconciliation by a CURRENT owner session, not the completed job's
 * revoked capability. Proves a T06 receipt only, never rotation/runtime trust or
 * permission to retry. No HTTP registration, upload, commit, cleanup or replay.
 */
export function createPdfJobReceiptRecovery({transactions,token}:{transactions:PrincipalTransactions;token:string}){
 if(typeof token!=='string')throw authError(401)
 const credential=Object.freeze({kind:'session' as const,token})
 return Object.freeze({async lookup(fileId:string,jobId:string){
  const file=uuid(fileId),job=uuid(jobId)
  return transactions.withPrincipalTransaction(credential,async(c,p)=>{
   if(p.job)throw authError(404)
   authorize(p,'files:read',{deploymentId:p.deploymentId,ownerId:p.userId})
   authorize(p,'files:write',{deploymentId:p.deploymentId,ownerId:p.userId})
   // Lock the file alone first. If a commit changes current_revision while we
   // wait, the following loadFile join gets a fresh statement snapshot rather
   // than mixing an EPQ-updated file row with the old revision snapshot.
   const locked=await c.query(`SELECT id FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND deleted_at IS NULL AND purge_started_at IS NULL FOR SHARE`,[...scope(p),file])
   if(locked.rowCount!==1)throw authError(404)
   const current=await loadFile(c,p,file)
   if(current.format!=='pdf')throw authError(404)
   // Plain MVCC reads only: do not take a job lock AFTER file SHARE, since real
   // job commit locks job then file. One statement sees a consistent receipt
   // chain; an in-flight commit may be unresolved and must never imply failure.
   const {rows}=await c.query(`SELECT r.id,r.sha256,r.size::text size,rc.upload_id,rc.base_revision,rc.lease_epoch::text lease_epoch,rc.request_hash
    FROM native_jobs j
    JOIN revision_commits rc ON rc.deployment_id=j.deployment_id AND rc.owner_id=j.owner_id AND rc.file_id=j.file_id AND rc.job_id=j.id
    JOIN uploads u ON u.deployment_id=rc.deployment_id AND u.owner_id=rc.owner_id AND u.file_id=rc.file_id AND u.id=rc.upload_id
    JOIN file_revisions r ON r.deployment_id=rc.deployment_id AND r.owner_id=rc.owner_id AND r.file_id=rc.file_id AND r.id=rc.revision_id
    WHERE j.deployment_id=$1 AND j.owner_id=$2 AND j.file_id=$3 AND j.id=$4
     AND j.type='pdf.rotate' AND j.state='succeeded' AND j.finished_at IS NOT NULL
     AND j.result_revision=rc.revision_id AND rc.idempotency_key='job_'||j.id::text
     AND rc.base_revision=j.artifact_id AND rc.job_epoch=j.claim_epoch
     AND rc.job_claim_hash ~ '^[a-f0-9]{64}$' AND rc.job_lease_until IS NOT NULL AND rc.job_transaction IS NOT NULL
     AND rc.requested_source_command_id IS NULL
     AND u.job_id=j.id AND u.job_epoch=rc.job_epoch AND u.editor_id=j.id
     AND u.session_id=j.session_id AND u.auth_version=j.auth_version
     AND u.kind='revision' AND u.state='committed' AND u.format='pdf' AND u.restored_from IS NULL
     AND u.completed_file_id=j.file_id AND u.revision_id=r.id AND u.base_revision=rc.base_revision AND u.lease_epoch=rc.lease_epoch
     AND r.source='save' AND r.parent_revision=rc.base_revision AND r.restored_from IS NULL AND r.reclaimed_at IS NULL
     AND r.sha256=u.sha256 AND r.size=u.expected_size`,[...scope(p),file,job])
   if(rows.length!==1)return unresolved()
   const row=rows[0],size=Number(row.size),epoch=Number(row.lease_epoch)
   if(!Number.isSafeInteger(size)||size<1||String(size)!==row.size||!Number.isSafeInteger(epoch)||epoch<1||String(epoch)!==row.lease_epoch||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))return unresolved()
   const requestHash=createHash('sha256').update(JSON.stringify({fileId:file,uploadId:row.upload_id,baseRevision:row.base_revision,leaseEpoch:epoch,sourceCommandId:null})).digest('hex')
   if(requestHash!==row.request_hash)return unresolved()
   return Object.freeze({state:'committed' as const,revision:Object.freeze({fileId:file,revision:row.id as string,sha256:row.sha256 as string,size})})
  })
 }})
}
