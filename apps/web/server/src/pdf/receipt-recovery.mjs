import {authorize} from '../modules/policy/authorize.ts'
import {authError} from '../modules/auth/sessions.ts'
import {loadFile,scope,uuid} from '../modules/files/queries.ts'

/** Read-only business receipt lookup after process loss; no retry capability.
 * Keep identifiers private and use a currently authenticated owner session.
 * This proves a T06 save receipt, NOT rotation semantics. Missing is unresolved,
 * never proof of failure. No upload cleanup, lease restoration or execution.
 * Deliberately unregistered in HTTP/UI; no keys/tokens are logged or returned.
 */
export function createPdfReceiptRecovery({transactions,token}){
  if(typeof token!=='string')throw authError(401)
  const credential=Object.freeze({kind:'session',token})
  return Object.freeze({async lookup(fileId,idempotencyKey){
    const file=uuid(fileId)
    if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))throw authError(400)
    return transactions.withPrincipalTransaction(credential,async(c,p)=>{
      if(p.job)throw authError(404)
      authorize(p,'files:read',{deploymentId:p.deploymentId,ownerId:p.userId})
      authorize(p,'files:write',{deploymentId:p.deploymentId,ownerId:p.userId})
      // Resolve owner/file authority BEFORE querying the secret key. No account
      // creation/reclamation helper: this lookup must not mutate business rows.
      const current=await loadFile(c,p,file)
      if(current.format!=='pdf')throw authError(404)
      const {rows}=await c.query(`SELECT r.id,r.sha256,r.size
        FROM revision_commits rc
        JOIN uploads u ON u.deployment_id=rc.deployment_id AND u.owner_id=rc.owner_id AND u.file_id=rc.file_id AND u.id=rc.upload_id
        JOIN file_revisions r ON r.deployment_id=rc.deployment_id AND r.owner_id=rc.owner_id AND r.file_id=rc.file_id AND r.id=rc.revision_id
        WHERE rc.deployment_id=$1 AND rc.owner_id=$2 AND rc.file_id=$3 AND rc.idempotency_key=$4
          AND rc.job_id IS NULL AND u.job_id IS NULL AND u.kind='revision' AND u.state='committed' AND u.format='pdf'
          AND u.base_revision=rc.base_revision AND u.lease_epoch=rc.lease_epoch AND u.revision_id=r.id
          AND r.source='save' AND r.parent_revision=rc.base_revision AND r.sha256=u.sha256 AND r.size=u.expected_size`,[...scope(p),file,idempotencyKey])
      if(rows.length!==1)return Object.freeze({state:'unresolved'})
      const row=rows[0]
      if(typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)||!Number.isSafeInteger(row.size)||row.size<1)throw authError(409)
      return Object.freeze({state:'committed',revision:Object.freeze({fileId:file,revision:row.id,sha256:row.sha256,size:row.size})})
    })
  }})
}
