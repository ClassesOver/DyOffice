import {matchesContinuation,type ContinuationOrigin} from '../../../../../../packages/web-contracts/src/task-continuation.ts'
import {isBackgroundFormat} from './background-format.ts'
import {createHash,createHmac,timingSafeEqual,randomUUID,randomBytes,hkdfSync,createCipheriv,createDecipheriv} from 'node:crypto'
import type {PoolClient} from 'pg'
import type {PrincipalTransactions,BusinessPrincipal} from '../../db/context.ts'
import {loadFile,uuid,scope} from '../files/queries.ts'
import type {FileService} from '../files/service.ts'
import {blankChannelDocument} from './blank-document.ts'
import {decodeDelegationOrigin,decodeContinuationOrigin,type DelegationOrigin,decodeAgentAction,decodeChannelDataInputs,defaultDshTokenExpiryMinutes,dshTokenExpiryOptions,type SubmitAgentAction,type ChannelTask} from '../../../../../../packages/web-contracts/src/assistant-channel.ts'

export type ChannelCredential={kind:'owner'|'member';token:string}
type Sealed={kind:'invite'|'application'|'member'|'background';session:string;conversationId:string;id:string;nonce:string;allowCreate?:true}
type Actor={id:string;member?:Record<string,any>}
const fail=(statusCode=400)=>Object.assign(Error('Assistant channel unavailable'),{statusCode})
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const terminal=(state:string)=>['succeeded','failed','cancelled'].includes(state)
function text(value:unknown,max=32768):string {if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max||value.includes('\0'))throw fail();return value}
function descriptor(input:{displayName:string;kind:string}) {
 if(!input||Object.keys(input).some(k=>!['displayName','kind'].includes(k)))throw fail()
 const displayName=text(input.displayName,160).trim(),kind=text(input.kind,64).trim()
 if(/[\u0000-\u001f\u007f-\u009f]/u.test(displayName)||!/^[-a-zA-Z0-9_. ]+$/.test(kind))throw fail()
 return {displayName,kind}
}
function taskDto(r:Record<string,any>):ChannelTask {return {...(r.continuation_origin?{continuationOrigin:r.continuation_origin}:{}),taskId:r.task_id,conversationId:r.conversation_id,parentTaskId:r.parent_task_id,rootTaskId:r.root_task_id,state:r.state,from:r.sender,to:r.recipient,instruction:r.instruction,claimId:r.claim_id,connectionEpoch:r.connection_epoch,deadlineAt:r.deadline_at.toISOString(),summary:r.summary,...(r.data_inputs?{dataInputs:decodeChannelDataInputs(r.data_inputs)}:{}),...(r.execution?{execution:r.execution,savedRevision:r.saved_revision}:{}),...(r.outcome?{outcome:r.outcome}:{})}}
function taskPreview(r:Record<string,any>):ChannelTask {
 const result=taskDto(r)
 delete result.dataInputs
 const bounded=(value:string,bytes:number)=>{
  let preview=value.slice(0,bytes)
  while(Buffer.byteLength(JSON.stringify(preview))>bytes)preview=preview.slice(0,-1)
  // Avoid emitting a split UTF-16 surrogate at the preview boundary.
  if(/[\uD800-\uDBFF]$/.test(preview))preview=preview.slice(0,-1)
  return preview
 }
 return {...result,instruction:bounded(result.instruction,256),summary:result.summary===null?null:bounded(result.summary,512)}
}
function memberDto(r:Record<string,any>,paused=false) {
 const now=Date.now(),recent=!r.revoked_at&&r.expires_at.getTime()>now&&!!r.last_seen_at&&r.last_seen_at.getTime()>=now-45000
 return {membershipId:r.membership_id,agentId:r.agent_id,harnessSessionId:r.harness_session_id,capabilities:['chat','office.read','harness.execute'],displayName:r.display_name,kind:r.kind,connectionEpoch:r.connection_epoch,online:!!r.connection_id&&recent,previewActive:r.kind==='dsh'&&!paused&&recent,revoked:!!r.revoked_at,expiresAt:r.expires_at.toISOString()}
}

/** Credentials are sealed only for routing to the original owner's session.
 * The database hash, live membership, live file and live session remain authority.
 * Never pass these credentials to general-purpose authenticated routes.
 */
export function createAssistantChannelService({transactions,credentialKey,backgroundEnabled=false}:{transactions:PrincipalTransactions;credentialKey:string;backgroundEnabled?:boolean}) {
 if(typeof credentialKey!=='string'||credentialKey.length<32)throw Error('Channel credential key required')
 const key=Buffer.from(hkdfSync('sha256',credentialKey,'dyoffice','assistant-channel-v1',32))
 const historyKey=Buffer.from(hkdfSync('sha256',credentialKey,'dyoffice','dsh-token-history-v1',32))
 const backgroundKey=Buffer.from(hkdfSync('sha256',credentialKey,'dyoffice','assistant-background-v1',32))
 const documentPreviewKey=Buffer.from(hkdfSync('sha256',credentialKey,'dyoffice','assistant-created-preview-v1',32))
 const documentPreviewProof=(token:string,fileId:string)=>createHmac('sha256',documentPreviewKey)
  .update('created-document-preview-v1:'+hash(token)+':'+fileId).digest()
 function draftOrigin(value:unknown) {
  if(typeof value!=='string'||value.length>255)throw fail(400)
  let url:URL
  try {url=new URL(value)} catch {throw fail(400)}
  if(url.origin!==value||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw fail(400)
  return value
 }
 const draftSignature=(p:BusinessPrincipal,fileId:string,origin:string,expires:number,write=false)=>createHmac('sha256',documentPreviewKey)
  .update(JSON.stringify([write?'word-write-v1':'word-draft-v1',...scope(p),fileId,origin,expires])).digest('base64url')
 async function savedPreview(c:PoolClient,p:BusinessPrincipal,fileId:string) {
  const file=await loadFile(c,p,fileId)
  if(!isBackgroundFormat(file.format)||file.size>10*1024*1024)throw fail(400)
  const edit=(await c.query(`SELECT EXISTS (
   SELECT 1 FROM uploads u WHERE u.deployment_id=l.deployment_id AND u.owner_id=l.owner_id
    AND u.file_id=l.file_id AND u.lease_epoch=l.lease_epoch AND u.editor_id=l.editor_id
    AND u.kind='revision' AND u.state='receiving' AND u.base_revision=$5 AND u.expires_at>clock_timestamp()
   ) AS saving FROM edit_leases l WHERE l.deployment_id=$1 AND l.owner_id=$2 AND l.file_id=$3
    AND l.auth_version=$4 AND l.expires_at>clock_timestamp()`,[...scope(p),file.id,p.authVersion,file.current_revision])).rows[0]
  const activity=edit ? (edit.saving ? 'saving' : 'editing') : 'saved'
  return {fileId:file.id,name:file.name,format:file.format,revision:file.current_revision,activity,
   reference:{key:file.object_key,sha256:file.sha256,size:Number(file.size)}}
 }
 function seal(kind:Sealed['kind'],session:string,conversationId:string,id:string,allowCreate=false):string {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',kind==='background'?backgroundKey:key,iv)
  const bytes=Buffer.concat([cipher.update(JSON.stringify({kind,session,conversationId,id,nonce:randomBytes(32).toString('base64url'),...(allowCreate?{allowCreate:true}:{})})),cipher.final()])
  return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url')
 }
 function unseal(token:string,kind:Sealed['kind']):Sealed {
  try {
   if(typeof token!=='string'||token.length>2048||!/^[A-Za-z0-9_-]+$/.test(token))throw fail(401)
   const bytes=Buffer.from(token,'base64url'),decipher=createDecipheriv('aes-256-gcm',kind==='background'?backgroundKey:key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28))
   const value=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString()) as Sealed
   if(value.kind!==kind||typeof value.session!=='string')throw fail(401)
   uuid(value.conversationId);uuid(value.id);return value
  }catch {throw fail(401)}
 }
 function tokenHistoryAad(p:BusinessPrincipal,conversationId:string,membershipId:string) {
  return Buffer.from(JSON.stringify([...scope(p),p.sessionId,conversationId,membershipId]))
 }
 function protectDshToken(token:string,p:BusinessPrincipal,conversationId:string,membershipId:string) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',historyKey,iv)
  cipher.setAAD(tokenHistoryAad(p,conversationId,membershipId))
  const bytes=Buffer.concat([cipher.update(token),cipher.final()])
  return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url')
 }
 async function owner<T>(token:string,fn:(c:PoolClient,p:BusinessPrincipal)=>Promise<T>):Promise<T> {
  return transactions.withPrincipalTransaction({kind:'session',token},async(c,p)=>{
   if(!p.roles.includes('personal')||p.job)throw fail(404)
   return fn(c,p)
  })
 }
 async function channel(c:PoolClient,p:BusinessPrincipal,conversationId:string) {
  const row=(await c.query('SELECT * FROM assistant_channels WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 FOR UPDATE',[...scope(p),uuid(conversationId)])).rows[0]
  if(!row)throw fail(404)
  if(row.file_id)await loadFile(c,p,row.file_id)
  return row
 }
 async function consumeInvite(c:PoolClient,p:BusinessPrincipal,sealed:Sealed,code:string) {
  const result=await c.query('UPDATE assistant_invites SET consumed_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND conversation_id=$4 AND token_hash=$5 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id',[...scope(p),sealed.id,sealed.conversationId,hash(code)])
  if(!result.rowCount)throw fail(410)
 }
 async function createMember(c:PoolClient,p:BusinessPrincipal,conversationId:string,d:{displayName:string;kind:string},expiresInMinutes=1440) {
  const {count}=(await c.query('SELECT count(*) FROM assistant_members WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[...scope(p),conversationId])).rows[0]
  if(Number(count)>=4)throw fail(429)
  const id=randomUUID()
  await c.query("INSERT INTO assistant_members(membership_id,deployment_id,owner_id,conversation_id,agent_id,harness_session_id,display_name,kind,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+make_interval(mins => $9))",[id,...scope(p),conversationId,randomUUID(),randomUUID(),d.displayName,d.kind,expiresInMinutes])
  return id
 }
 async function liveMember(c:PoolClient,p:BusinessPrincipal,sealed:Sealed,token:string) {
  const member=(await c.query('SELECT * FROM assistant_members WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND membership_id=$4 AND token_hash=$5 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[...scope(p),sealed.conversationId,sealed.id,hash(token)])).rows[0]
  if(!member)throw fail(401)
  return member
 }
 async function withCreatedDocument<T>(token:string,fileId:string,proof:unknown,read:(c:PoolClient,p:BusinessPrincipal,id:string)=>Promise<T>) {
  const sealed=unseal(token,'member'),id=uuid(fileId)
  if(sealed.allowCreate!==true||typeof proof!=='string'||!(/^[a-f0-9]{64}$/u.test(proof))||
     !timingSafeEqual(Buffer.from(proof,'hex'),documentPreviewProof(token,id)))throw fail(403)
  return owner(sealed.session,async(c,p)=>{
   const ch=await channel(c,p,sealed.conversationId)
   await liveMember(c,p,sealed,token)
   if(ch.paused)throw fail(403)
   return read(c,p,id)
  })
 }
 async function run<T>(credential:ChannelCredential,conversationId:string,fn:(c:PoolClient,p:BusinessPrincipal,ch:Record<string,any>,actor:Actor)=>Promise<T>,renewPresence=true):Promise<T> {
  const captured={...credential},sealed=captured.kind==='member'?unseal(captured.token,'member'):null
  if(!['owner','member'].includes(captured.kind)||sealed&&sealed.conversationId!==conversationId)throw fail(401)
  return owner(sealed?sealed.session:captured.token,async(c,p)=>{
   const ch=await channel(c,p,conversationId)
   let actor:Actor={id:'office'}
   if(sealed) {
    const member=await liveMember(c,p,sealed,captured.token)
    actor={id:member.membership_id,member}
   }
   await reapDisconnected(c,p,conversationId)
   if(actor.member&&renewPresence) {
    const member=(await c.query('UPDATE assistant_members SET last_seen_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND membership_id=$3 RETURNING *',[...scope(p),actor.id])).rows[0]
    actor.member=member
    if(member.connection_id)await c.query(`UPDATE task_runtime_channel
     SET renewed_at=$7,lease_until=LEAST(deadline_at,$7::timestamptz+interval '45 seconds')
     WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient=$4
       AND connection_id=$5 AND connection_epoch=$6 AND state='running' AND execution IS NULL`,
     [...scope(p),conversationId,actor.id,member.connection_id,member.connection_epoch,member.last_seen_at])
   }
   return fn(c,p,ch,actor)
  })
 }
 async function event(c:PoolClient,p:BusinessPrincipal,id:string,type:string,payload:unknown,audience='office',taskId:string|null=null) {
  const sequence=(await c.query('UPDATE assistant_channels SET sequence=sequence+1 WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 RETURNING sequence',[...scope(p),id])).rows[0].sequence
  const eventId=randomUUID()
  await c.query('INSERT INTO assistant_events(event_id,deployment_id,owner_id,conversation_id,sequence,task_id,audience,type,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[eventId,...scope(p),id,sequence,taskId,audience,type,JSON.stringify(payload)])
  return eventId
 }
 async function task(c:PoolClient,p:BusinessPrincipal,id:string,taskId:string) {
  const row=(await c.query('SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND task_id=$4',[...scope(p),id,uuid(taskId)])).rows[0]
  if(!row)throw fail(404);return row
 }
 async function state(c:PoolClient,p:BusinessPrincipal,id:string,row:Record<string,any>,value:string) {
  const updated=await c.query('UPDATE task_runtime SET state=$4,cancel_requested=cancel_requested OR $5 WHERE deployment_id=$1 AND owner_id=$2 AND runtime_id=$3 AND state=$6 AND tableoid=$7::regclass',[...scope(p),row.runtime_id,value,value==='cancel_requested',row.state,'task_runtime_channel'])
  if(updated.rowCount!==1)throw fail(409)
  Object.assign(row,await task(c,p,id,row.task_id))
  await event(c,p,id,'task',taskDto(row),row.recipient,row.task_id)
 }
 async function reapDisconnected(c:PoolClient,p:BusinessPrincipal,id:string) {
  // At most four members and 32 active tasks; reuse requests/snapshots instead
  // of a second timer. Expired executors retain their claim for reconciliation.
  const members=(await c.query("UPDATE assistant_members SET connection_id=NULL,connection_epoch=connection_epoch+1 WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND connection_id IS NOT NULL AND (last_seen_at IS NULL OR last_seen_at<clock_timestamp()-interval '45 seconds' OR expires_at<=clock_timestamp()) RETURNING membership_id",[...scope(p),id])).rows
  for(const member of members) {
   const rows=(await c.query("SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient=$4 AND state IN ('running','cancel_requested') LIMIT 32",[...scope(p),id,member.membership_id])).rows
   for(const row of rows)await state(c,p,id,row,'unknown_outcome')
   await event(c,p,id,'member',{membershipId:member.membership_id,state:'offline'})
  }
 }
 async function expire(c:PoolClient,p:BusinessPrincipal,id:string) {
  const rows=(await c.query("SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND deadline_at<=clock_timestamp() AND state IN ('queued','running','waiting_peer','cancel_requested')",[...scope(p),id])).rows
  for(const row of rows)await state(c,p,id,row,row.state==='queued'?'cancelled':'unknown_outcome')
 }
 async function cancelTree(c:PoolClient,p:BusinessPrincipal,id:string,row:Record<string,any>) {
  const rows=(await c.query('WITH RECURSIVE tree AS (SELECT task_id FROM task_runtime_channel WHERE task_id=$4 AND deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 UNION ALL SELECT t.task_id FROM task_runtime_channel t JOIN tree ON t.parent_task_id=tree.task_id WHERE t.deployment_id=$1 AND t.owner_id=$2 AND t.conversation_id=$3) SELECT t.* FROM task_runtime_channel t JOIN tree USING(task_id)',[...scope(p),id,row.task_id])).rows
  for(const item of rows)if(!terminal(item.state)&&item.state!=='unknown_outcome')await state(c,p,id,item,item.state==='queued'?'cancelled':'cancel_requested')
 }
 async function wake(c:PoolClient,p:BusinessPrincipal,id:string,parentId:string|null) {
  if(!parentId)return
  const parent=await task(c,p,id,parentId)
  if(parent.state!=='waiting_peer')return
  const children=parent.child_task_ids as string[]
  if(!children.length)return
  const rows=(await c.query('SELECT state FROM task_runtime_status WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND task_id=ANY($4::text[])',[...scope(p),id,children])).rows
  if(rows.length===children.length&&rows.every(r=>terminal(r.state)))await state(c,p,id,parent,'queued')
 }
 async function claimDto(c:PoolClient,p:BusinessPrincipal,conversationId:string,row:Record<string,any>):Promise<ChannelTask> {
  const result=taskDto(row)
    const ids=row.child_task_ids as string[]
    if(ids.length){
     const children=(await c.query('SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND parent_task_id=$4 AND task_id=ANY($5::uuid[])',[...scope(p),conversationId,row.task_id,ids])).rows
     if(children.length!==ids.length||children.some(child=>!terminal(child.state)))throw fail(409)
     result.continuation={parentTaskId:row.task_id,untrusted:true,children:ids.map(id=>{
      const child=children.find(row=>row.task_id===id)!,preview=taskPreview(child)
      return {taskId:id,state:child.state,summary:preview.summary,outcome:child.outcome??null,summaryTruncated:preview.summary!==child.summary}
     })}
    }
    return result
 }
 const capturedCredential=(credential:ChannelCredential,conversationId:string,taskId:string)=>seal('background',credential.token,conversationId,taskId)
 const service={
  async createConversation(token:string,input:{fileId?:string;conversationId?:string}) {
   const fileId=input.fileId===undefined?null:uuid(input.fileId),conversationId=input.conversationId?uuid(input.conversationId):randomUUID()
   return owner(token,async(c,p)=>{
    if(fileId)await loadFile(c,p,fileId)
    await c.query('INSERT INTO assistant_channels(conversation_id,deployment_id,owner_id,file_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[conversationId,...scope(p),fileId])
    const ch=await channel(c,p,conversationId);if(ch.file_id!==fileId)throw fail(409)
    return {conversationId,fileId,paused:ch.paused}
   })
  },
  // Server-only execution capability. Never expose the recovered session through HTTP.
  async backgroundStep(claim:{taskId:string;conversationId:string;credential:string;claimId:string;token:string},phase:'begin'|'check'|'finish',result?:{summary:string;outcome:'succeeded'|'failed'}) {
   const captured=unseal(claim.credential,'background')
   if(captured.conversationId!==claim.conversationId||captured.id!==claim.taskId)throw fail(401)
   const memberToken=captured.session
   const sealed=unseal(memberToken,'member')
   return run({kind:'member',token:memberToken},claim.conversationId,async(c,p,ch,actor)=>{
    if(phase==='begin')await expire(c,p,claim.conversationId)
    const row=await task(c,p,claim.conversationId,claim.taskId)
    const queue=(await c.query('SELECT q.*,t.lease_until FROM task_background_claims q JOIN task_runtime_channel t USING(deployment_id,owner_id,conversation_id,task_id) WHERE q.deployment_id=$1 AND q.owner_id=$2 AND q.task_id=$3 FOR UPDATE OF q,t',[...scope(p),row.task_id])).rows[0]
    if(!queue||queue.claim_id!==claim.claimId||queue.claim_hash!==hash(claim.token)||!queue.credential||queue.lease_until.getTime()<=Date.now())throw fail(409)
    if(row.sender!==actor.id||row.execution!=='saved-revision'||row.deadline_at.getTime()<=Date.now()||!ch.background_enabled||ch.paused||row.cancel_requested)throw fail(409)
    if(phase==='begin'){
     if(row.state!=='queued')throw fail(409)
     const busy=(await c.query("SELECT 1 FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient='office' AND state IN ('running','cancel_requested')",[...scope(p),claim.conversationId])).rowCount
     if(busy){
      await c.query('UPDATE task_background_claims SET claim_id=NULL,claim_hash=NULL WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id])
      await c.query('UPDATE task_runtime_channel SET lease_until=NULL WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id])
      return null
     }
     await c.query('UPDATE task_runtime_channel SET claim_id=$4,connection_id=$4,connection_epoch=1 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id,claim.claimId])
     await state(c,p,claim.conversationId,row,'running')
    }else if(row.state!=='running'||row.claim_id!==claim.claimId)throw fail(409)
    const file=await loadFile(c,p,ch.file_id)
    if(!isBackgroundFormat(file.format))throw fail(400)
    const revision=(await c.query('SELECT r.object_key,r.sha256,r.size FROM file_revisions r WHERE r.deployment_id=$1 AND r.owner_id=$2 AND r.file_id=$3 AND r.id=$4 AND r.reclaimed_at IS NULL',[...scope(p),ch.file_id,row.saved_revision])).rows[0]
    if(!revision||Number(revision.size)>10*1024*1024||revision.sha256!==row.saved_sha256||Number(revision.size)!==Number(row.saved_size))throw fail(409)
    if(phase==='finish'){
     if(!result)throw fail()
     const summary=text(result.summary,16*1024)
     await c.query('UPDATE task_runtime_channel SET summary=$4,outcome=$5 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id,summary,result.outcome])
     row.summary=summary;row.outcome=result.outcome
     await state(c,p,claim.conversationId,row,result.outcome)
     await event(c,p,claim.conversationId,'message',{from:'office',to:row.sender,content:summary,taskId:row.task_id},row.sender,row.task_id)
     await wake(c,p,claim.conversationId,row.parent_task_id)
     await c.query('UPDATE task_background_claims SET credential=NULL,claim_hash=NULL WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id])
     await c.query('UPDATE task_runtime_channel SET lease_until=NULL WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id])
    }else await c.query("UPDATE task_runtime_channel SET renewed_at=clock_timestamp(),lease_until=clock_timestamp()+interval '30 seconds' WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3",[...scope(p),row.task_id])
    return {token:sealed.session,instruction:row.instruction,revision:row.saved_revision,format:file.format,reference:{key:revision.object_key,sha256:revision.sha256,size:Number(revision.size)},deadlineAt:row.deadline_at.toISOString()}
   })
  },
  async deleteConversation(token:string,conversationId:string) {
   const id=uuid(conversationId)
   return owner(token,async(c,p)=>{
    const params=[...scope(p),id]
    const where=' WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3'
    const channel=await c.query('SELECT conversation_id FROM assistant_channels'+where+' FOR UPDATE',params)
    if(!channel.rowCount)throw fail(404)
    // The queue references both the channel and its tasks. Remove it first so
    // a worker holding an old claim can no longer read or commit a result.
    for(const table of ['task_background_claims','task_runtime_channel','assistant_events','assistant_requests','assistant_applications','assistant_invites','assistant_members','assistant_channels']){
     await c.query('DELETE FROM '+table+where,params)
    }
   })
  },
  async listChannels(token:string,after?:string,fileId?:string) {
   const cursor=after?uuid(after):null
   const file=fileId?uuid(fileId):null
   return owner(token,async(c,p)=>{
    const rows=(await c.query('SELECT ch.*,f.name AS file_name FROM assistant_channels ch LEFT JOIN files f ON f.deployment_id=ch.deployment_id AND f.owner_id=ch.owner_id AND f.id=ch.file_id WHERE ch.deployment_id=$1 AND ch.owner_id=$2 AND ($3::uuid IS NULL OR ch.conversation_id>$3) AND ($4::uuid IS NULL OR ch.file_id=$4) AND (ch.file_id IS NULL OR (f.deleted_at IS NULL AND f.purge_started_at IS NULL AND f.id IS NOT NULL)) ORDER BY ch.conversation_id LIMIT 51',[...scope(p),cursor,file])).rows
    return {items:rows.slice(0,50).map(r=>({conversationId:r.conversation_id,fileId:r.file_id,fileName:r.file_name,paused:r.paused,backgroundEnabled:r.background_enabled,createdAt:r.created_at.toISOString()})),nextCursor:rows.length>50?rows[49].conversation_id:null}
   })
  },
  async configureBackground(token:string,conversationId:string,input:{enabled:boolean;fileId?:string}) {
   if(typeof input.enabled!=='boolean'||input.enabled&&!backgroundEnabled)throw fail(400)
   return run({kind:'owner',token},conversationId,async(c,p,ch)=>{
    const fileId=input.fileId?uuid(input.fileId):ch.file_id
    if(ch.file_id&&fileId!==ch.file_id)throw fail(409)
    if(input.enabled&&!fileId)throw fail(400)
    if(fileId){const file=await loadFile(c,p,fileId);if(input.enabled&&!isBackgroundFormat(file.format))throw fail(400)}
    await c.query('UPDATE assistant_channels SET file_id=$4,background_enabled=$5 WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3',[...scope(p),conversationId,fileId,input.enabled])
    if(!input.enabled){
     const rows=(await c.query("SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND execution='saved-revision' AND state IN ('queued','running','waiting_peer')",[...scope(p),conversationId])).rows
     for(const row of rows)await cancelTree(c,p,conversationId,row)
    }
    await event(c,p,conversationId,'member',{state:'background',enabled:input.enabled})
    return {conversationId,fileId,backgroundEnabled:input.enabled}
   })
  },
  async backgroundTasks(token:string,after?:string) {
   const cursor=after?uuid(after):null
   return owner(token,async(c,p)=>{
    const rows=(await c.query("SELECT t.*,f.name AS file_name,ch.file_id,m.display_name FROM task_runtime_channel t JOIN assistant_channels ch USING(deployment_id,owner_id,conversation_id) JOIN files f ON f.deployment_id=ch.deployment_id AND f.owner_id=ch.owner_id AND f.id=ch.file_id LEFT JOIN assistant_members m ON m.deployment_id=t.deployment_id AND m.owner_id=t.owner_id AND m.membership_id::text=t.sender WHERE t.deployment_id=$1 AND t.owner_id=$2 AND t.execution='saved-revision' AND f.deleted_at IS NULL AND f.purge_started_at IS NULL AND ($3::uuid IS NULL OR (t.created_at,t.task_id)<(SELECT created_at,task_id FROM task_runtime_channel WHERE task_id=$3 AND deployment_id=$1 AND owner_id=$2)) ORDER BY t.created_at DESC,t.task_id DESC LIMIT 51",[...scope(p),cursor])).rows
    return {items:rows.slice(0,50).map(r=>({...taskPreview(r),fileId:r.file_id,fileName:r.file_name,sourceName:r.display_name,createdAt:r.created_at.toISOString()})),nextCursor:rows.length>50?rows[49].task_id:null}
   })
  },
  async backgroundTask(token:string,taskId:string) {
   return owner(token,async(c,p)=>{
    const row=(await c.query("SELECT t.*,ch.file_id,f.name AS file_name FROM task_runtime_channel t JOIN assistant_channels ch USING(deployment_id,owner_id,conversation_id) JOIN files f ON f.deployment_id=ch.deployment_id AND f.owner_id=ch.owner_id AND f.id=ch.file_id WHERE t.deployment_id=$1 AND t.owner_id=$2 AND t.task_id=$3 AND t.execution='saved-revision' AND f.deleted_at IS NULL AND f.purge_started_at IS NULL",[...scope(p),uuid(taskId)])).rows[0]
    if(!row)throw fail(404)
    return {...taskDto(row),fileId:row.file_id,fileName:row.file_name,createdAt:row.created_at.toISOString()}
   })
  },
  async invite(token:string,conversationId:string,expiresInMinutes:unknown=5) {
   if(typeof expiresInMinutes!=='number'||(!dshTokenExpiryOptions.includes(expiresInMinutes)&&![5,15,30].includes(expiresInMinutes)))throw fail(400)
   return owner(token,async(c,p)=>{
    const ch=await channel(c,p,conversationId)
    const id=randomUUID(),inviteToken=seal('invite',token,conversationId,id)
    const row=(await c.query("INSERT INTO assistant_invites(id,deployment_id,owner_id,conversation_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(mins => $6)) RETURNING expires_at",[id,...scope(p),conversationId,hash(inviteToken),expiresInMinutes])).rows[0]
    return {inviteToken,expiresAt:row.expires_at.toISOString()}
   })
  },
  async issueDshToken(token:string,conversationId:string,expiresInMinutes:unknown=defaultDshTokenExpiryMinutes,allowCreate:unknown=false) {
   if(typeof expiresInMinutes!=='number'||!dshTokenExpiryOptions.includes(expiresInMinutes)||typeof allowCreate!=='boolean')throw fail(400)
   return owner(token,async(c,p)=>{
    const ch=await channel(c,p,conversationId)
    if(ch.paused||(!allowCreate&&(!backgroundEnabled||!ch.background_enabled||!ch.file_id)))throw fail(403)
    const membershipId=await createMember(c,p,conversationId,{displayName:'DSH DyOffice',kind:'dsh'},expiresInMinutes)
    const memberToken=seal('member',token,conversationId,membershipId,allowCreate)
    const {rows:[member]}=await c.query('UPDATE assistant_members SET token_hash=$4,dsh_token_issued_at=clock_timestamp(),dsh_token_session_id=$5,dsh_token_envelope=$6 WHERE deployment_id=$1 AND owner_id=$2 AND membership_id=$3 RETURNING *',[...scope(p),membershipId,hash(memberToken),p.sessionId,protectDshToken(memberToken,p,conversationId,membershipId)])
    await event(c,p,conversationId,'member',{membershipId,state:'authorized'})
    return {memberToken,expiresAt:member.expires_at.toISOString(),membershipId}
   })
  },
  async revealDshToken(token:string,conversationId:string,membershipId:string) {
   return owner(token,async(c,p)=>{
    await channel(c,p,conversationId)
    const member=(await c.query("SELECT token_hash,expires_at,dsh_token_envelope FROM assistant_members WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND membership_id=$4 AND kind='dsh' AND dsh_token_session_id=$5 AND revoked_at IS NULL AND expires_at>clock_timestamp()",[...scope(p),conversationId,uuid(membershipId),p.sessionId])).rows[0]
    if(!member?.dsh_token_envelope||!member.token_hash)throw fail(404)
    try{
     const bytes=Buffer.from(member.dsh_token_envelope,'base64url')
     const decipher=createDecipheriv('aes-256-gcm',historyKey,bytes.subarray(0,12))
     decipher.setAAD(tokenHistoryAad(p,conversationId,membershipId))
     decipher.setAuthTag(bytes.subarray(12,28))
     const memberToken=Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString()
     if(hash(memberToken)!==member.token_hash||unseal(memberToken,'member').session!==token)throw fail(404)
     return {memberToken,expiresAt:member.expires_at.toISOString()}
    }catch{throw fail(404)}
   })
  },
  async createMemberDocument(token:string,files:FileService,input:{format:unknown;title:unknown}) {
   const sealed=unseal(token,'member')
   const authorize=async(c:PoolClient,p:BusinessPrincipal)=>{
    const ch=await channel(c,p,sealed.conversationId)
    await liveMember(c,p,sealed,token)
    if(ch.paused||sealed.allowCreate!==true)throw fail(403)
   }
   await owner(sealed.session,authorize)
   const {name,bytes}=await blankChannelDocument(input)
   const upload=await files.stageUpload(sealed.session,{name,size:bytes.length})
   try{
    await files.receiveUpload(sealed.session,upload.uploadId,bytes)
    const created=await files.finishUpload(sealed.session,upload.uploadId,authorize)
    return {fileId:created.file.fileId,baseRevision:created.file.revision,name:created.name,format:created.format,
     previewProof:documentPreviewProof(token,created.file.fileId).toString('hex')}
   }catch(error){
    await files.cancelUpload(sealed.session,upload.uploadId).catch(()=>{})
    throw error
   }
  },
  async apply(inviteToken:string,input:{displayName:string;kind:string}) {
   const sealed=unseal(inviteToken,'invite'),d=descriptor(input)
   return owner(sealed.session,async(c,p)=>{
    await channel(c,p,sealed.conversationId)
    await consumeInvite(c,p,sealed,inviteToken)
    const applicationId=randomUUID(),applicationToken=seal('application',sealed.session,sealed.conversationId,applicationId)
    await c.query("INSERT INTO assistant_applications(id,deployment_id,owner_id,conversation_id,token_hash,display_name,kind,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '5 minutes')",[applicationId,...scope(p),sealed.conversationId,hash(applicationToken),d.displayName,d.kind])
    await event(c,p,sealed.conversationId,'member',{applicationId,...d,state:'pending'})
    return {applicationId,applicationToken,conversationId:sealed.conversationId}
   })
  },
  async applicationStatus(applicationToken:string) {
   const sealed=unseal(applicationToken,'application')
   return owner(sealed.session,async(c,p)=>{
    await channel(c,p,sealed.conversationId)
    const row=(await c.query('SELECT state FROM assistant_applications WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND token_hash=$4 AND expires_at>clock_timestamp()',[...scope(p),sealed.id,hash(applicationToken)])).rows[0]
    if(!row)throw fail(401);return {applicationId:sealed.id,state:row.state}
   })
  },
  async approve(token:string,conversationId:string,applicationId:string,input:{approved:boolean}) {
   if(typeof input?.approved!=='boolean')throw fail()
   return owner(token,async(c,p)=>{
    await channel(c,p,conversationId)
    const row=(await c.query("SELECT * FROM assistant_applications WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND id=$4 AND state='pending' AND expires_at>clock_timestamp()",[...scope(p),conversationId,uuid(applicationId)])).rows[0]
    if(!row)throw fail(409)
    const membershipId=input.approved?await createMember(c,p,conversationId,{displayName:row.display_name,kind:row.kind}):null
    await c.query('UPDATE assistant_applications SET state=$4,membership_id=$5 WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',[...scope(p),applicationId,input.approved?'approved':'rejected',membershipId])
    await event(c,p,conversationId,'member',{applicationId,membershipId,state:input.approved?'approved':'rejected'})
    return {applicationId,membershipId,state:input.approved?'approved':'rejected'}
   })
  },
  async redeem(applicationToken:string) {
   const sealed=unseal(applicationToken,'application')
   return owner(sealed.session,async(c,p)=>{
    await channel(c,p,sealed.conversationId)
    const row=(await c.query("UPDATE assistant_applications SET state='redeemed' WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND token_hash=$4 AND state='approved' AND expires_at>clock_timestamp() RETURNING membership_id",[...scope(p),sealed.id,hash(applicationToken)])).rows[0]
    if(!row)throw fail(409)
    const memberToken=seal('member',sealed.session,sealed.conversationId,row.membership_id)
    const member=(await c.query('UPDATE assistant_members SET token_hash=$4 WHERE deployment_id=$1 AND owner_id=$2 AND membership_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING *',[...scope(p),row.membership_id,hash(memberToken)])).rows[0]
    if(!member)throw fail(401)
    return {memberToken,member:memberDto(member),conversationId:sealed.conversationId}
   })
  },
  async snapshot(token:string,conversationId:string) {
   return run({kind:'owner',token},conversationId,async(c,p,ch)=>{
    await expire(c,p,conversationId)
    const members=(await c.query('SELECT * FROM assistant_members WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 ORDER BY dsh_token_issued_at DESC NULLS LAST,membership_id',[...scope(p),conversationId])).rows.map(row=>({
     ...memberDto(row,ch.paused),
     ...(row.kind==='dsh'?{
      issuedAt:row.dsh_token_issued_at?.toISOString()??null,
      canRevealDshToken:!!row.dsh_token_envelope&&row.dsh_token_session_id===p.sessionId&&!row.revoked_at&&row.expires_at.getTime()>Date.now(),
      dshTokenFromOtherSession:!!row.dsh_token_session_id&&row.dsh_token_session_id!==p.sessionId,
     }:{}),
    }))
    const applications=(await c.query("SELECT id AS \"applicationId\",display_name AS \"displayName\",kind,state FROM assistant_applications WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND state='pending' AND expires_at>clock_timestamp()",[...scope(p),conversationId])).rows
    const tasks=(await c.query("SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 ORDER BY (state IN ('queued','running','waiting_peer','cancel_requested','unknown_outcome')) DESC,created_at DESC,task_id LIMIT 64",[...scope(p),conversationId])).rows.map(taskPreview)
    const sequence=Number((await c.query('SELECT sequence FROM assistant_channels WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3',[...scope(p),conversationId])).rows[0].sequence)
    return {conversationId,fileId:ch.file_id,paused:ch.paused,backgroundEnabled:ch.background_enabled,backgroundAvailable:backgroundEnabled,sequence,members,applications,tasks}
   })
  },
  async memberSnapshot(token:string) {
   const sealed=unseal(token,'member')
   return run({kind:'member',token},sealed.conversationId,async(c,p,ch,actor)=>{
    await expire(c,p,sealed.conversationId)
    const tasks=(await c.query("SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND (sender=$4 OR recipient=$4) ORDER BY (state IN ('queued','running','waiting_peer','cancel_requested','unknown_outcome')) DESC,created_at DESC,task_id LIMIT 64",[...scope(p),sealed.conversationId,actor.id])).rows.map(taskPreview)
    const sequence=Number((await c.query('SELECT sequence FROM assistant_channels WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3',[...scope(p),sealed.conversationId])).rows[0].sequence)
    return {conversationId:sealed.conversationId,fileId:ch.file_id,paused:ch.paused,canCreate:!ch.paused&&sealed.allowCreate===true,member:memberDto(actor.member!,ch.paused),tasks,sequence}
   })
  },
  async memberPreview(token:string,memberId:string) {
   const sealed=unseal(token,'member')
   if(sealed.id!==uuid(memberId))throw fail(403)
   return run({kind:'member',token},sealed.conversationId,async(c,p,ch)=>{
    if(!backgroundEnabled||!ch.background_enabled||ch.paused||!ch.file_id)throw fail(403)
    return savedPreview(c,p,ch.file_id)
   })
  },
  async createdDocumentPreview(token:string,fileId:string,proof:unknown) {
   return withCreatedDocument(token,fileId,proof,savedPreview)
  },
  async issueDraftSync(token:string,fileId:string,proof:unknown,originValue:unknown,write:unknown=false) {
   if(typeof write!=='boolean')throw fail(400)
   const origin=draftOrigin(originValue)
   return withCreatedDocument(token,fileId,proof,async(c,p,id)=>{
    if(!isBackgroundFormat((await loadFile(c,p,id)).format))throw fail(403)
    const expires=Date.now()+60000
    return {ticket:expires+'.'+draftSignature(p,id,origin,expires,write)}
   })
  },
  async verifyDraftSync(token:string,fileId:string,originValue:unknown,ticket:unknown) {
   const origin=draftOrigin(originValue), id=uuid(fileId)
   const match=typeof ticket==='string'&&/^(\d{13})\.([A-Za-z0-9_-]{43})$/u.exec(ticket)
   if(!match||Number(match[1])<=Date.now())throw fail(403)
   return owner(token,async(c,p)=>{
    const expires=Number(match[1]),signature=Buffer.from(match[2])
    const write=timingSafeEqual(signature,Buffer.from(draftSignature(p,id,origin,expires,true)))
    if(!write&&!timingSafeEqual(signature,Buffer.from(draftSignature(p,id,origin,expires))))throw fail(403)
    if(!isBackgroundFormat((await loadFile(c,p,id)).format))throw fail(403)
    return {expires,...(write&&{write})}
   })
  },
  async memberTask(token:string,taskId:string) {
   const sealed=unseal(token,'member'),id=uuid(taskId)
   return run({kind:'member',token},sealed.conversationId,async(c,p,_ch,actor)=>{
    await expire(c,p,sealed.conversationId)
    const row=await task(c,p,sealed.conversationId,id)
    if(row.sender!==actor.id&&row.recipient!==actor.id)throw fail(404)
    return taskDto(row)
   })
  },
  // Server-only capability binding. Never serialize ownerToken to a member.
  async authorizeDataClaim(token:string,input:{taskId:string;claimId:string;connectionEpoch:number},renewPresence=true) {
   const sealed=unseal(token,'member')
   return run({kind:'member',token},sealed.conversationId,async(c,p,ch,actor)=>{
    const row=await task(c,p,sealed.conversationId,uuid(input.taskId))
    if(ch.paused||row.state!=='running'||row.cancel_requested||row.deadline_at.getTime()<=Date.now()||
      (row.lease_until && row.lease_until.getTime()<=Date.now())||row.sender!=='office'||row.recipient!==actor.id||!row.data_inputs||row.claim_id!==uuid(input.claimId)||
      row.connection_epoch!==input.connectionEpoch||actor.member!.connection_epoch!==input.connectionEpoch||
      !actor.member!.connection_id||row.connection_id!==actor.member!.connection_id)throw fail(403)
    return {ownerToken:sealed.session,agentId:actor.member!.agent_id as string,inputs:decodeChannelDataInputs(row.data_inputs),deadlineAt:row.deadline_at.toISOString(),leaseUntil:Math.min(row.deadline_at.getTime(),row.lease_until?.getTime()??actor.member!.last_seen_at.getTime()+45_000)}
   },renewPresence)
  },
  async ownerEventPage(token:string,conversationId:string,after:number,taskId?:string) {
   if(!Number.isSafeInteger(after)||after<0)throw fail()
   return owner(token,async(c,p)=>{
    const args=[...scope(p),uuid(conversationId)]
    const channel=(await c.query('SELECT file_id FROM assistant_channels WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3',args)).rows[0]
    if(!channel)throw fail(404)
    if(channel.file_id)await loadFile(c,p,channel.file_id)
    if(taskId!==undefined){
     const current=await task(c,p,conversationId,taskId)
     const {rows}=await c.query(`SELECT e.channel_sequence AS sequence,e.channel_kind AS type,
       a.payload->>'state' AS state,a.payload->>'from' AS sender
       FROM harness_task_events e JOIN assistant_events a ON a.event_id=e.channel_event_id
       WHERE e.deployment_id=$1 AND e.owner_id=$2 AND e.conversation_id=$3 AND e.channel_task_id=$4 AND e.channel_sequence>$5
       ORDER BY e.channel_sequence LIMIT 256`,[...args,taskId,after])
     const events=rows.map(row=>{
      const sequence=Number(row.sequence)
      if(row.type==='task')return {sequence,taskId,kind:'state',payload:{state:row.state}}
      if(row.type==='message'&&row.sender===current.recipient&&current.sender!==current.recipient)return {sequence,taskId,kind:'result',payload:{taskId}}
      return {sequence,taskId,kind:'activity',payload:{type:row.type}}
     })
     return {state:String(current.state),events}
    }
    const {rows}=await c.query('SELECT channel_sequence AS sequence,channel_kind AS type,channel_task_id AS task_id FROM harness_task_events WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND channel_sequence>$4 ORDER BY channel_sequence LIMIT 256',[...args,after])
    return {events:rows.map(row=>({sequence:Number(row.sequence),kind:row.type,taskId:row.task_id??undefined}))}
   })
  },
  async events(credential:ChannelCredential,conversationId:string,after=0) {
   if(!Number.isSafeInteger(after)||after<0)throw fail()
   return run(credential,conversationId,async(c,p,_ch,actor)=>{
    const rows=(await c.query("SELECT * FROM assistant_events WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND sequence>$4 AND ($5='office' OR audience=$5 OR task_id IN (SELECT task_id FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND (sender=$5 OR recipient=$5))) ORDER BY sequence LIMIT 256",[...scope(p),conversationId,after,actor.id])).rows
    return {events:rows.map(r=>({version:1,eventId:r.event_id,sequence:Number(r.sequence),conversationId,taskId:r.task_id??undefined,type:r.type,payload:r.payload}))}
   })
  },
  async revoke(token:string,conversationId:string,membershipId:string) {
   return run({kind:'owner',token},conversationId,async(c,p)=>{
    const row=(await c.query('UPDATE assistant_members SET revoked_at=COALESCE(revoked_at,clock_timestamp()),token_hash=NULL,dsh_token_envelope=NULL,connection_id=NULL,connection_epoch=connection_epoch+1 WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND membership_id=$4 RETURNING *',[...scope(p),conversationId,uuid(membershipId)])).rows[0]
    if(!row)throw fail(404)
    const tasks=(await c.query("SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND (sender=$4 OR recipient=$4) AND state IN ('queued','running','waiting_peer','cancel_requested')",[...scope(p),conversationId,membershipId])).rows
    for(const item of tasks)await cancelTree(c,p,conversationId,item)
    await event(c,p,conversationId,'member',{membershipId,state:'revoked'})
    return {membershipId,revoked:true}
   })
  },
  async setPaused(token:string,conversationId:string,paused:boolean) {
   if(typeof paused!=='boolean')throw fail()
   return run({kind:'owner',token},conversationId,async(c,p)=>{
    await c.query('UPDATE assistant_channels SET paused=$4 WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3',[...scope(p),conversationId,paused])
    if(paused) {
     const tasks=(await c.query("SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND state IN ('queued','running','waiting_peer')",[...scope(p),conversationId])).rows
     for(const item of tasks)await cancelTree(c,p,conversationId,item)
    }
    await event(c,p,conversationId,'member',{state:'control',paused})
    return {paused}
   })
  },
  async connect(credential:ChannelCredential,conversationId:string,input:{connectionId:string;editorId?:string;editorGeneration?:number}) {
   const connectionId=uuid(input.connectionId)
   if(credential.kind==='owner'&&(!input.editorId||!Number.isSafeInteger(input.editorGeneration)||input.editorGeneration!<1))throw fail()
   const editorId=input.editorId?uuid(input.editorId):null
   return run(credential,conversationId,async(c,p,ch,actor)=>{
    // A new executor fences old claims. Never automatically rerun lost work.
    const previous=actor.member?actor.member.connection_id:ch.office_connection_id
    if(previous===connectionId)return {connectionEpoch:actor.member?actor.member.connection_epoch:ch.office_epoch}
    const rows=(await c.query("SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient=$4 AND execution IS NULL AND state IN ('running','cancel_requested')",[...scope(p),conversationId,actor.id])).rows
    for(const row of rows)await state(c,p,conversationId,row,'unknown_outcome')
    const result=actor.member
     ?await c.query('UPDATE assistant_members SET connection_id=$4,connection_epoch=connection_epoch+1,last_seen_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND membership_id=$3 RETURNING connection_epoch AS epoch',[...scope(p),actor.id,connectionId])
     :await c.query('UPDATE assistant_channels SET office_connection_id=$4,office_epoch=office_epoch+1,editor_id=$5,editor_generation=$6 WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 RETURNING office_epoch AS epoch',[...scope(p),conversationId,connectionId,editorId,input.editorGeneration])
    await event(c,p,conversationId,'member',{membershipId:actor.id,state:'online',connectionEpoch:result.rows[0].epoch},actor.id)
    return {connectionEpoch:result.rows[0].epoch}
   })
  },
  async disconnect(credential:ChannelCredential,conversationId:string,input:{connectionId:string;connectionEpoch:number}) {
   return run(credential,conversationId,async(c,p,ch,actor)=>{
    const current=actor.member??ch
    if((actor.member?current.connection_id:current.office_connection_id)!==uuid(input.connectionId)||(actor.member?current.connection_epoch:current.office_epoch)!==input.connectionEpoch)throw fail(409)
    const rows=(await c.query("SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient=$4 AND execution IS NULL AND state IN ('running','cancel_requested')",[...scope(p),conversationId,actor.id])).rows
    for(const row of rows)await state(c,p,conversationId,row,'unknown_outcome')
    if(actor.member)await c.query('UPDATE assistant_members SET connection_id=NULL WHERE deployment_id=$1 AND owner_id=$2 AND membership_id=$3',[...scope(p),actor.id])
    else await c.query('UPDATE assistant_channels SET office_connection_id=NULL WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3',[...scope(p),conversationId])
    return {disconnected:true}
   })
  },
  async submit(credential:ChannelCredential,input:SubmitAgentAction) {
   input=decodeAgentAction(input)
   const requestId=uuid(input.requestId),conversationId=uuid(input.conversationId),to=input.to==='office'?'office':uuid(input.to),action=input.action
   if(!action||!['message','delegate','result','cancel'].includes(action.kind))throw fail()
   const paramsHash=hash(JSON.stringify({to,action}))
   return run(credential,conversationId,async(c,p,ch,actor)=>{
    await expire(c,p,conversationId)
    if(action.kind==='delegate'&&action.dataInputs!==undefined&&(actor.id!=='office'||to==='office'))throw fail(403)
    const prior=(await c.query('SELECT * FROM assistant_requests WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND actor=$4 AND request_id=$5',[...scope(p),conversationId,actor.id,requestId])).rows[0]
    if(prior){if(prior.params_hash!==paramsHash)throw fail(409);return prior.receipt as {messageId:string;taskId?:string}}
    let taskId:string|undefined,messageId:string
    if(action.kind==='result') {
     const row=await task(c,p,conversationId,action.taskId)
     const epoch=actor.member?actor.member.connection_epoch:ch.office_epoch
     const connection=actor.member?actor.member.connection_id:ch.office_connection_id
     if(row.execution||row.recipient!==actor.id||row.claim_id!==uuid(action.claimId)||row.connection_epoch!==action.connectionEpoch||epoch!==action.connectionEpoch||connection!==row.connection_id||!['running','cancel_requested'].includes(row.state))throw fail(409)
     if(!['succeeded','failed'].includes(action.outcome))throw fail()
     const summary=text(action.summary),next=row.state==='cancel_requested'?'cancelled':action.outcome
     await c.query('UPDATE task_runtime_channel SET summary=$4,outcome=$5 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id,summary,action.outcome]);row.summary=summary;row.outcome=action.outcome
     await state(c,p,conversationId,row,next);await wake(c,p,conversationId,row.parent_task_id)
     taskId=row.task_id;messageId=await event(c,p,conversationId,'message',{from:actor.id,to:row.sender,content:summary,taskId},row.sender,taskId!)
    }else if(action.kind==='cancel') {
     const row=await task(c,p,conversationId,action.taskId)
     if(actor.member&&row.sender!==actor.id&&row.recipient!==actor.id)throw fail(404)
     await cancelTree(c,p,conversationId,row);taskId=row.task_id
     messageId=await event(c,p,conversationId,'task',taskDto(await task(c,p,conversationId,row.task_id)),row.recipient,taskId!)
    }else {
     if(ch.paused)throw fail(409)
     if(to===actor.id)throw fail()
     if(to!=='office') {
      const target=(await c.query('SELECT 1 FROM assistant_members WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND membership_id=$4 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND token_hash IS NOT NULL',[...scope(p),conversationId,to])).rows[0]
      if(!target)throw fail(404)
     }
     const instruction=text(action.kind==='message'?action.content:action.instruction)
     const background=action.kind==='delegate'&&action.execution==='saved-revision'
     let saved:Awaited<ReturnType<typeof loadFile>>|undefined
     if(background){
      if(!backgroundEnabled||!actor.member||to!=='office'||!ch.background_enabled||!ch.file_id)throw fail(403)
      saved=await loadFile(c,p,ch.file_id)
      if(!isBackgroundFormat(saved.format)||saved.size>10*1024*1024)throw fail(400)
     }
     const parentId=action.kind==='delegate'&&action.parentTaskId?uuid(action.parentTaskId):null
     let rootId:string,depth=0,deadline:Date
     taskId=randomUUID();rootId=taskId;deadline=new Date(Date.now()+600000)
     if(parentId) {
      const parent=await task(c,p,conversationId,parentId)
      if(parent.recipient!==actor.id||!['running','waiting_peer'].includes(parent.state))throw fail(409)
      rootId=parent.root_task_id;depth=parent.depth+1;deadline=parent.deadline_at
      if(depth>4)throw fail(429)
      const count=(await c.query('SELECT count(*) FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND root_task_id=$4',[...scope(p),conversationId,rootId])).rows[0].count
      if(Number(count)>=17)throw fail(429)
     }
     if(deadline.getTime()<=Date.now())throw fail(410)
     const active=(await c.query("SELECT count(*) FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND state IN ('queued','running','waiting_peer','cancel_requested','unknown_outcome')",[...scope(p),conversationId])).rows[0].count
     if(Number(active)>=32)throw fail(429)
     const row=(await c.query('INSERT INTO task_runtime_channel(task_id,deployment_id,owner_id,conversation_id,root_task_id,parent_task_id,depth,sender,recipient,instruction,deadline_at,data_inputs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[taskId,...scope(p),conversationId,rootId,parentId,depth,actor.id,to,instruction,deadline,action.kind==='delegate'&&action.dataInputs!==undefined?JSON.stringify(action.dataInputs):null])).rows[0]
     if(saved){
      await c.query("UPDATE task_runtime_channel SET execution='saved-revision',saved_revision=$4,saved_sha256=$5,saved_size=$6 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3",[...scope(p),taskId,saved.current_revision,saved.sha256,saved.size])
      Object.assign(row,{execution:'saved-revision',saved_revision:saved.current_revision})
      await c.query('INSERT INTO task_background_claims(task_id,deployment_id,owner_id,conversation_id,credential) VALUES($1,$2,$3,$4,$5)',[taskId,...scope(p),conversationId,capturedCredential(credential,conversationId,taskId)])
     }
     messageId=await event(c,p,conversationId,'message',{from:actor.id,to,content:instruction,taskId,...(action.kind==='message'&&action.replyTo?{replyTo:uuid(action.replyTo)}:{})},to,taskId)
     await event(c,p,conversationId,'task',taskDto(row),to,taskId)
    }
    const receipt={messageId,taskId}
    await c.query('INSERT INTO assistant_requests(deployment_id,owner_id,conversation_id,actor,request_id,params_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',[...scope(p),conversationId,actor.id,requestId,paramsHash,JSON.stringify(receipt)])
    return receipt
   })
  },
  /** Opt-in ledger entry for an Office run that is about to delegate. Native
   * chat remains independent of this service; no model work starts here. */
  async beginOfficeTask(token:string,conversationId:string,input:{requestId:string;connectionId:string;connectionEpoch:number;instruction:string;origin?:DelegationOrigin}) {
   const requestId=uuid(input.requestId),connectionId=uuid(input.connectionId),instruction=text(input.instruction)
   const origin=input.origin&&decodeDelegationOrigin(input.origin)
   const paramsHash=hash(JSON.stringify({operation:'begin-office',connectionId,connectionEpoch:input.connectionEpoch,instruction,origin}))
   return run({kind:'owner',token},conversationId,async(c,p,ch)=>{
    await expire(c,p,conversationId)
    if(ch.paused||ch.office_connection_id!==connectionId||ch.office_epoch!==input.connectionEpoch)throw fail(409)
    // A replay returns the recorded task even if the document has been saved
    // since; the revision binds only new requests.
    const prior=(await c.query("SELECT * FROM assistant_requests WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND actor='office' AND request_id=$4",[...scope(p),conversationId,requestId])).rows[0]
    if(prior){if(prior.params_hash!==paramsHash)throw fail(409);return taskDto(await task(c,p,conversationId,prior.receipt.taskId))}
    const revision=origin&&ch.file_id?(await loadFile(c,p,ch.file_id)).current_revision:undefined
    if(origin&&(!revision||(origin.revision!==null&&origin.revision!==revision)))throw fail(409)
    const busy=(await c.query("SELECT 1 FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient='office' AND state IN ('running','cancel_requested')",[...scope(p),conversationId])).rowCount
    if(busy)throw fail(409)
    const active=(await c.query("SELECT count(*) FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND state IN ('queued','running','waiting_peer','cancel_requested','unknown_outcome')",[...scope(p),conversationId])).rows[0].count
    if(Number(active)>=32)throw fail(429)
    const taskId=randomUUID(),claimId=randomUUID()
    const row=(await c.query("INSERT INTO task_runtime_channel(task_id,deployment_id,owner_id,conversation_id,root_task_id,depth,sender,recipient,instruction,state,claim_id,connection_id,connection_epoch,deadline_at,continuation_origin) VALUES($1,$2,$3,$4,$1,0,'office','office',$5,'running',$6,$7,$8,clock_timestamp()+interval '10 minutes',$9) RETURNING *",[taskId,...scope(p),conversationId,instruction,claimId,connectionId,input.connectionEpoch,origin?{...origin,revision}:null])).rows[0]
    const messageId=await event(c,p,conversationId,'task',taskDto(row),'office',taskId)
    await c.query("INSERT INTO assistant_requests(deployment_id,owner_id,conversation_id,actor,request_id,params_hash,receipt) VALUES($1,$2,$3,'office',$4,$5,$6)",[...scope(p),conversationId,requestId,paramsHash,JSON.stringify({messageId,taskId})])
    return taskDto(row)
   })
  },
  async claim(credential:ChannelCredential,conversationId:string,input:{taskId:string;connectionId:string;connectionEpoch:number;requestId?:string;origin?:ContinuationOrigin}) {
   const connectionId=uuid(input.connectionId),taskId=uuid(input.taskId),requestId=input.requestId===undefined?undefined:uuid(input.requestId)
   const origin=input.origin&&decodeContinuationOrigin(input.origin)
   const paramsHash=hash(JSON.stringify({operation:'claim',taskId,connectionId,connectionEpoch:input.connectionEpoch,origin}))
   return run(credential,conversationId,async(c,p,ch,actor)=>{
    await expire(c,p,conversationId)
    if(ch.paused)throw fail(409)
    const epoch=actor.member?actor.member.connection_epoch:ch.office_epoch,current=actor.member?actor.member.connection_id:ch.office_connection_id
    if(current!==connectionId||epoch!==input.connectionEpoch)throw fail(409)
    const prior=requestId?(await c.query('SELECT * FROM assistant_requests WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND actor=$4 AND request_id=$5',[...scope(p),conversationId,actor.id,requestId])).rows[0]:undefined
    if(prior&&prior.params_hash!==paramsHash)throw fail(409)
    const row=await task(c,p,conversationId,taskId)
    // The origin was checked when this claim was recorded; a replay of the
    // same claim must not fail because the document was saved since.
    if(prior){
     if(row.recipient!==actor.id||row.state!=='running'||row.claim_id!==prior.receipt.claimId||row.connection_id!==connectionId||row.connection_epoch!==epoch||prior.receipt.taskId!==taskId||prior.receipt.connectionEpoch!==epoch)throw fail(409)
     return claimDto(c,p,conversationId,row)
    }
    if(row.continuation_origin&&(!origin||!matchesContinuation(row.continuation_origin,origin)||!ch.file_id||(await loadFile(c,p,ch.file_id)).current_revision!==origin.revision))throw fail(409)
    if(row.execution||row.recipient!==actor.id||row.state!=='queued')throw fail(409)
    const busy=(await c.query("SELECT 1 FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient=$4 AND state IN ('running','cancel_requested')",[...scope(p),conversationId,actor.id])).rowCount
    if(busy)throw fail(409)
    const claimId=randomUUID()
    const claimed=(await c.query("UPDATE task_runtime_channel SET state='running',claim_id=$4,connection_id=$5,connection_epoch=$6,renewed_at=clock_timestamp(),lease_until=CASE WHEN recipient='office' THEN deadline_at ELSE LEAST(deadline_at,clock_timestamp()+interval '45 seconds') END WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3 AND state='queued' RETURNING *",[...scope(p),row.task_id,claimId,connectionId,epoch])).rows[0]
    if(!claimed)throw fail(409)
    await event(c,p,conversationId,'task',taskDto(claimed),actor.id,row.task_id)
    if(requestId)await c.query('INSERT INTO assistant_requests(deployment_id,owner_id,conversation_id,actor,request_id,params_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',[...scope(p),conversationId,actor.id,requestId,paramsHash,JSON.stringify({taskId:row.task_id,claimId,connectionEpoch:epoch})])
    return claimDto(c,p,conversationId,claimed)
   })
  },
  async yieldTask(credential:ChannelCredential,conversationId:string,input:{taskId:string;claimId:string;connectionEpoch:number;childTaskIds:string[]}) {
   if(!Array.isArray(input.childTaskIds)||!input.childTaskIds.length||input.childTaskIds.length>16)throw fail()
   const children=input.childTaskIds.map(uuid);if(new Set(children).size!==children.length)throw fail()
   return run(credential,conversationId,async(c,p,ch,actor)=>{
    await expire(c,p,conversationId)
    const row=await task(c,p,conversationId,input.taskId),epoch=actor.member?actor.member.connection_epoch:ch.office_epoch
    const connection=actor.member?actor.member.connection_id:ch.office_connection_id
    if(row.execution||row.recipient!==actor.id||row.claim_id!==uuid(input.claimId)||row.connection_epoch!==input.connectionEpoch||epoch!==input.connectionEpoch||!connection||row.connection_id!==connection)throw fail(409)
    if(row.state!=='running'){
     const saved=row.child_task_ids as string[]
     if(!['waiting_peer','queued'].includes(row.state)||saved.length!==children.length||children.some(id=>!saved.includes(id)))throw fail(409)
     return taskDto(row)
    }
    const rows=(await c.query('SELECT * FROM task_runtime_channel WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND parent_task_id=$4 AND task_id=ANY($5::uuid[])',[...scope(p),conversationId,row.task_id,children])).rows
    if(rows.length!==children.length)throw fail(409)
    await c.query('UPDATE task_runtime_channel SET child_task_ids=$4 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id,JSON.stringify(children)])
    await state(c,p,conversationId,row,'waiting_peer');await wake(c,p,conversationId,row.task_id)
    return taskDto(await task(c,p,conversationId,row.task_id))
   })
  },
  async reconcile(credential:ChannelCredential,conversationId:string,input:{taskId:string;claimId:string;connectionEpoch:number;outcome:'succeeded'|'failed'|'cancelled';summary:string}) {
   if(!['succeeded','failed','cancelled'].includes(input.outcome))throw fail()
   const summary=text(input.summary)
   return run(credential,conversationId,async(c,p,_ch,actor)=>{
    const row=await task(c,p,conversationId,input.taskId)
    // Reconciliation accepts the recorded executor's claim after a disconnect,
    // never a normal result from a new or fenced execution instance.
    if(row.execution||row.recipient!==actor.id||row.claim_id!==uuid(input.claimId)||row.connection_epoch!==input.connectionEpoch||row.state!=='unknown_outcome')throw fail(409)
    await c.query('UPDATE task_runtime_channel SET summary=$4,outcome=$5 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id,summary,input.outcome]);row.summary=summary;row.outcome=input.outcome
    await state(c,p,conversationId,row,row.cancel_requested?'cancelled':input.outcome);await wake(c,p,conversationId,row.parent_task_id)
    return taskDto(row)
   })
  },
  async notifications(token:string,fileId:string) {
   return owner(token,async(c,p)=>{
    await loadFile(c,p,uuid(fileId))
    const channels=(await c.query('SELECT conversation_id FROM assistant_channels WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 ORDER BY created_at DESC LIMIT 32 FOR UPDATE',[...scope(p),fileId])).rows
    for(const ch of channels)await reapDisconnected(c,p,ch.conversation_id)
    const rows=(await c.query('SELECT conversation_id,sequence FROM assistant_channels WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 ORDER BY created_at DESC LIMIT 32',[...scope(p),fileId])).rows
    return rows.map(r=>({conversationId:r.conversation_id,sequence:Number(r.sequence)}))
   })
  },
 }
 return service
}
export type AssistantChannelService=ReturnType<typeof createAssistantChannelService>
