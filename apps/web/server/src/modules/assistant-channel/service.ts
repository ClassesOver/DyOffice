import {createHash,randomUUID,randomBytes,hkdfSync,createCipheriv,createDecipheriv} from 'node:crypto'
import type {PoolClient} from 'pg'
import type {PrincipalTransactions,BusinessPrincipal} from '../../db/context.ts'
import {loadFile,uuid,scope} from '../files/queries.ts'
import {decodeAgentAction,decodeChannelDataInputs,type SubmitAgentAction,type ChannelTask} from '../../../../../../packages/web-contracts/src/assistant-channel.ts'

export type ChannelCredential={kind:'owner'|'member';token:string}
type Sealed={kind:'invite'|'application'|'member';session:string;conversationId:string;id:string;nonce:string}
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
function taskDto(r:Record<string,any>):ChannelTask {return {taskId:r.task_id,conversationId:r.conversation_id,parentTaskId:r.parent_task_id,rootTaskId:r.root_task_id,state:r.state,from:r.sender,to:r.recipient,instruction:r.instruction,claimId:r.claim_id,connectionEpoch:r.connection_epoch,deadlineAt:r.deadline_at.toISOString(),summary:r.summary,...(r.data_inputs?{dataInputs:decodeChannelDataInputs(r.data_inputs)}:{}),...(r.outcome?{outcome:r.outcome}:{})}}
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
function memberDto(r:Record<string,any>) {return {membershipId:r.membership_id,agentId:r.agent_id,harnessSessionId:r.harness_session_id,capabilities:['chat','office.read','harness.execute'],displayName:r.display_name,kind:r.kind,connectionEpoch:r.connection_epoch,online:!!r.connection_id&&!r.revoked_at&&r.expires_at.getTime()>Date.now()&&!!r.last_seen_at&&r.last_seen_at.getTime()>=Date.now()-45000,revoked:!!r.revoked_at,expiresAt:r.expires_at.toISOString()}}

/** Credentials are sealed only for routing to the original owner's session.
 * The database hash, live membership, live file and live session remain authority.
 * Never pass these credentials to general-purpose authenticated routes.
 */
export function createAssistantChannelService({transactions,credentialKey}:{transactions:PrincipalTransactions;credentialKey:string}) {
 if(typeof credentialKey!=='string'||credentialKey.length<32)throw Error('Channel credential key required')
 const key=Buffer.from(hkdfSync('sha256',credentialKey,'dyoffice','assistant-channel-v1',32))
 function seal(kind:Sealed['kind'],session:string,conversationId:string,id:string):string {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv)
  const bytes=Buffer.concat([cipher.update(JSON.stringify({kind,session,conversationId,id,nonce:randomBytes(32).toString('base64url')})),cipher.final()])
  return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url')
 }
 function unseal(token:string,kind:Sealed['kind']):Sealed {
  try {
   if(typeof token!=='string'||token.length>2048||!/^[A-Za-z0-9_-]+$/.test(token))throw fail(401)
   const bytes=Buffer.from(token,'base64url'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28))
   const value=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString()) as Sealed
   if(value.kind!==kind||typeof value.session!=='string')throw fail(401)
   uuid(value.conversationId);uuid(value.id);return value
  }catch {throw fail(401)}
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
  await loadFile(c,p,row.file_id)
  return row
 }
 async function run<T>(credential:ChannelCredential,conversationId:string,fn:(c:PoolClient,p:BusinessPrincipal,ch:Record<string,any>,actor:Actor)=>Promise<T>):Promise<T> {
  const captured={...credential},sealed=captured.kind==='member'?unseal(captured.token,'member'):null
  if(!['owner','member'].includes(captured.kind)||sealed&&sealed.conversationId!==conversationId)throw fail(401)
  return owner(sealed?sealed.session:captured.token,async(c,p)=>{
   const ch=await channel(c,p,conversationId)
   let actor:Actor={id:'office'}
   if(sealed) {
    const member=(await c.query('SELECT * FROM assistant_members WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND membership_id=$4 AND token_hash=$5 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[...scope(p),conversationId,sealed.id,hash(captured.token)])).rows[0]
    if(!member)throw fail(401)
    actor={id:member.membership_id,member}
   }
   await reapDisconnected(c,p,conversationId)
   if(actor.member) {
    actor.member=(await c.query('UPDATE assistant_members SET last_seen_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND membership_id=$3 RETURNING *',[...scope(p),actor.id])).rows[0]
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
  const row=(await c.query('SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND task_id=$4',[...scope(p),id,uuid(taskId)])).rows[0]
  if(!row)throw fail(404);return row
 }
 async function state(c:PoolClient,p:BusinessPrincipal,id:string,row:Record<string,any>,value:string) {
  await c.query('UPDATE assistant_tasks SET state=$4,cancel_requested=cancel_requested OR $5 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id,value,value==='cancel_requested'])
  row.state=value;await event(c,p,id,'task',taskDto(row),row.recipient,row.task_id)
 }
 async function reapDisconnected(c:PoolClient,p:BusinessPrincipal,id:string) {
  // At most four members and 32 active tasks; reuse requests/snapshots instead
  // of a second timer. Expired executors retain their claim for reconciliation.
  const members=(await c.query("UPDATE assistant_members SET connection_id=NULL,connection_epoch=connection_epoch+1 WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND connection_id IS NOT NULL AND (last_seen_at IS NULL OR last_seen_at<clock_timestamp()-interval '45 seconds' OR expires_at<=clock_timestamp()) RETURNING membership_id",[...scope(p),id])).rows
  for(const member of members) {
   const rows=(await c.query("SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient=$4 AND state IN ('running','cancel_requested') LIMIT 32",[...scope(p),id,member.membership_id])).rows
   for(const row of rows)await state(c,p,id,row,'unknown_outcome')
   await event(c,p,id,'member',{membershipId:member.membership_id,state:'offline'})
  }
 }
 async function expire(c:PoolClient,p:BusinessPrincipal,id:string) {
  const rows=(await c.query("SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND deadline_at<=clock_timestamp() AND state IN ('queued','running','waiting_peer','cancel_requested')",[...scope(p),id])).rows
  for(const row of rows)await state(c,p,id,row,row.state==='queued'?'cancelled':'unknown_outcome')
 }
 async function cancelTree(c:PoolClient,p:BusinessPrincipal,id:string,row:Record<string,any>) {
  const rows=(await c.query('WITH RECURSIVE tree AS (SELECT task_id FROM assistant_tasks WHERE task_id=$4 AND deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 UNION ALL SELECT t.task_id FROM assistant_tasks t JOIN tree ON t.parent_task_id=tree.task_id WHERE t.deployment_id=$1 AND t.owner_id=$2 AND t.conversation_id=$3) SELECT t.* FROM assistant_tasks t JOIN tree USING(task_id)',[...scope(p),id,row.task_id])).rows
  for(const item of rows)if(!terminal(item.state)&&item.state!=='unknown_outcome')await state(c,p,id,item,item.state==='queued'?'cancelled':'cancel_requested')
 }
 async function wake(c:PoolClient,p:BusinessPrincipal,id:string,parentId:string|null) {
  if(!parentId)return
  const parent=await task(c,p,id,parentId)
  if(parent.state!=='waiting_peer')return
  const children=parent.child_task_ids as string[]
  if(!children.length)return
  const rows=(await c.query('SELECT state FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND task_id=ANY($4::uuid[])',[...scope(p),id,children])).rows
  if(rows.length===children.length&&rows.every(r=>terminal(r.state)))await state(c,p,id,parent,'queued')
 }
 const service={
  async createConversation(token:string,input:{fileId:string;conversationId?:string}) {
   const fileId=uuid(input.fileId),conversationId=input.conversationId?uuid(input.conversationId):randomUUID()
   return owner(token,async(c,p)=>{
    await loadFile(c,p,fileId)
    await c.query('INSERT INTO assistant_channels(conversation_id,deployment_id,owner_id,file_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[conversationId,...scope(p),fileId])
    const ch=await channel(c,p,conversationId);if(ch.file_id!==fileId)throw fail(409)
    return {conversationId,fileId,paused:ch.paused}
   })
  },
  async invite(token:string,conversationId:string) {
   return owner(token,async(c,p)=>{
    await channel(c,p,conversationId)
    const id=randomUUID(),inviteToken=seal('invite',token,conversationId,id)
    const row=(await c.query("INSERT INTO assistant_invites(id,deployment_id,owner_id,conversation_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '5 minutes') RETURNING expires_at",[id,...scope(p),conversationId,hash(inviteToken)])).rows[0]
    return {inviteToken,expiresAt:row.expires_at.toISOString()}
   })
  },
  async apply(inviteToken:string,input:{displayName:string;kind:string}) {
   const sealed=unseal(inviteToken,'invite'),d=descriptor(input)
   return owner(sealed.session,async(c,p)=>{
    await channel(c,p,sealed.conversationId)
    const consumed=await c.query('UPDATE assistant_invites SET consumed_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND conversation_id=$4 AND token_hash=$5 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id',[...scope(p),sealed.id,sealed.conversationId,hash(inviteToken)])
    if(!consumed.rowCount)throw fail(410)
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
    let membershipId:null|string=null
    if(input.approved) {
     const count=(await c.query('SELECT count(*) FROM assistant_members WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[...scope(p),conversationId])).rows[0].count
     if(Number(count)>=4)throw fail(429)
     membershipId=randomUUID()
     await c.query("INSERT INTO assistant_members(membership_id,deployment_id,owner_id,conversation_id,agent_id,harness_session_id,display_name,kind,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '24 hours')",[membershipId,...scope(p),conversationId,randomUUID(),randomUUID(),row.display_name,row.kind])
    }
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
    const members=(await c.query('SELECT * FROM assistant_members WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 ORDER BY membership_id',[...scope(p),conversationId])).rows.map(memberDto)
    const applications=(await c.query("SELECT id AS \"applicationId\",display_name AS \"displayName\",kind,state FROM assistant_applications WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND state='pending' AND expires_at>clock_timestamp()",[...scope(p),conversationId])).rows
    const tasks=(await c.query("SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 ORDER BY (state IN ('queued','running','waiting_peer','cancel_requested','unknown_outcome')) DESC,created_at DESC,task_id LIMIT 64",[...scope(p),conversationId])).rows.map(taskPreview)
    const sequence=Number((await c.query('SELECT sequence FROM assistant_channels WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3',[...scope(p),conversationId])).rows[0].sequence)
    return {conversationId,fileId:ch.file_id,paused:ch.paused,sequence,members,applications,tasks}
   })
  },
  async memberSnapshot(token:string) {
   const sealed=unseal(token,'member')
   return run({kind:'member',token},sealed.conversationId,async(c,p,ch,actor)=>{
    await expire(c,p,sealed.conversationId)
    const tasks=(await c.query("SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND (sender=$4 OR recipient=$4) ORDER BY (state IN ('queued','running','waiting_peer','cancel_requested','unknown_outcome')) DESC,created_at DESC,task_id LIMIT 64",[...scope(p),sealed.conversationId,actor.id])).rows.map(taskPreview)
    const sequence=Number((await c.query('SELECT sequence FROM assistant_channels WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3',[...scope(p),sealed.conversationId])).rows[0].sequence)
    return {conversationId:sealed.conversationId,fileId:ch.file_id,paused:ch.paused,member:memberDto(actor.member!),tasks,sequence}
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
  async authorizeDataClaim(token:string,input:{taskId:string;claimId:string;connectionEpoch:number}) {
   const sealed=unseal(token,'member')
   return run({kind:'member',token},sealed.conversationId,async(c,p,ch,actor)=>{
    const row=await task(c,p,sealed.conversationId,uuid(input.taskId))
    if(ch.paused||row.state!=='running'||row.cancel_requested||row.deadline_at.getTime()<=Date.now()||
      row.sender!=='office'||row.recipient!==actor.id||!row.data_inputs||row.claim_id!==uuid(input.claimId)||
      row.connection_epoch!==input.connectionEpoch||actor.member!.connection_epoch!==input.connectionEpoch||
      !actor.member!.connection_id||row.connection_id!==actor.member!.connection_id)throw fail(403)
    return {ownerToken:sealed.session,agentId:actor.member!.agent_id as string,inputs:decodeChannelDataInputs(row.data_inputs),deadlineAt:row.deadline_at.toISOString()}
   })
  },
  async events(credential:ChannelCredential,conversationId:string,after=0) {
   if(!Number.isSafeInteger(after)||after<0)throw fail()
   return run(credential,conversationId,async(c,p,_ch,actor)=>{
    const rows=(await c.query("SELECT * FROM assistant_events WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND sequence>$4 AND ($5='office' OR audience=$5 OR task_id IN (SELECT task_id FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND (sender=$5 OR recipient=$5))) ORDER BY sequence LIMIT 256",[...scope(p),conversationId,after,actor.id])).rows
    return {events:rows.map(r=>({version:1,eventId:r.event_id,sequence:Number(r.sequence),conversationId,taskId:r.task_id??undefined,type:r.type,payload:r.payload}))}
   })
  },
  async revoke(token:string,conversationId:string,membershipId:string) {
   return run({kind:'owner',token},conversationId,async(c,p)=>{
    const row=(await c.query('UPDATE assistant_members SET revoked_at=COALESCE(revoked_at,clock_timestamp()),token_hash=NULL,connection_id=NULL,connection_epoch=connection_epoch+1 WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND membership_id=$4 RETURNING *',[...scope(p),conversationId,uuid(membershipId)])).rows[0]
    if(!row)throw fail(404)
    const tasks=(await c.query("SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND (sender=$4 OR recipient=$4) AND state IN ('queued','running','waiting_peer','cancel_requested')",[...scope(p),conversationId,membershipId])).rows
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
     const tasks=(await c.query("SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND state IN ('queued','running','waiting_peer')",[...scope(p),conversationId])).rows
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
    const rows=(await c.query("SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient=$4 AND state IN ('running','cancel_requested')",[...scope(p),conversationId,actor.id])).rows
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
    const rows=(await c.query("SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient=$4 AND state IN ('running','cancel_requested')",[...scope(p),conversationId,actor.id])).rows
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
     if(row.recipient!==actor.id||row.claim_id!==uuid(action.claimId)||row.connection_epoch!==action.connectionEpoch||epoch!==action.connectionEpoch||connection!==row.connection_id||!['running','cancel_requested'].includes(row.state))throw fail(409)
     if(!['succeeded','failed'].includes(action.outcome))throw fail()
     const summary=text(action.summary),next=row.state==='cancel_requested'?'cancelled':action.outcome
     await c.query('UPDATE assistant_tasks SET summary=$4,outcome=$5 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id,summary,action.outcome]);row.summary=summary;row.outcome=action.outcome
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
     const parentId=action.kind==='delegate'&&action.parentTaskId?uuid(action.parentTaskId):null
     let rootId:string,depth=0,deadline:Date
     taskId=randomUUID();rootId=taskId;deadline=new Date(Date.now()+600000)
     if(parentId) {
      const parent=await task(c,p,conversationId,parentId)
      if(parent.recipient!==actor.id||!['running','waiting_peer'].includes(parent.state))throw fail(409)
      rootId=parent.root_task_id;depth=parent.depth+1;deadline=parent.deadline_at
      if(depth>4)throw fail(429)
      const count=(await c.query('SELECT count(*) FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND root_task_id=$4',[...scope(p),conversationId,rootId])).rows[0].count
      if(Number(count)>=17)throw fail(429)
     }
     if(deadline.getTime()<=Date.now())throw fail(410)
     const active=(await c.query("SELECT count(*) FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND state IN ('queued','running','waiting_peer','cancel_requested','unknown_outcome')",[...scope(p),conversationId])).rows[0].count
     if(Number(active)>=32)throw fail(429)
     const row=(await c.query('INSERT INTO assistant_tasks(task_id,deployment_id,owner_id,conversation_id,root_task_id,parent_task_id,depth,sender,recipient,instruction,deadline_at,data_inputs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[taskId,...scope(p),conversationId,rootId,parentId,depth,actor.id,to,instruction,deadline,action.kind==='delegate'&&action.dataInputs!==undefined?JSON.stringify(action.dataInputs):null])).rows[0]
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
  async beginOfficeTask(token:string,conversationId:string,input:{requestId:string;connectionId:string;connectionEpoch:number;instruction:string}) {
   const requestId=uuid(input.requestId),connectionId=uuid(input.connectionId),instruction=text(input.instruction)
   const paramsHash=hash(JSON.stringify({operation:'begin-office',connectionId,connectionEpoch:input.connectionEpoch,instruction}))
   return run({kind:'owner',token},conversationId,async(c,p,ch)=>{
    await expire(c,p,conversationId)
    if(ch.paused||ch.office_connection_id!==connectionId||ch.office_epoch!==input.connectionEpoch)throw fail(409)
    const prior=(await c.query("SELECT * FROM assistant_requests WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND actor='office' AND request_id=$4",[...scope(p),conversationId,requestId])).rows[0]
    if(prior){if(prior.params_hash!==paramsHash)throw fail(409);return taskDto(await task(c,p,conversationId,prior.receipt.taskId))}
    const busy=(await c.query("SELECT 1 FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient='office' AND state IN ('running','cancel_requested')",[...scope(p),conversationId])).rowCount
    if(busy)throw fail(409)
    const active=(await c.query("SELECT count(*) FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND state IN ('queued','running','waiting_peer','cancel_requested','unknown_outcome')",[...scope(p),conversationId])).rows[0].count
    if(Number(active)>=32)throw fail(429)
    const taskId=randomUUID(),claimId=randomUUID()
    const row=(await c.query("INSERT INTO assistant_tasks(task_id,deployment_id,owner_id,conversation_id,root_task_id,depth,sender,recipient,instruction,state,claim_id,connection_id,connection_epoch,deadline_at) VALUES($1,$2,$3,$4,$1,0,'office','office',$5,'running',$6,$7,$8,clock_timestamp()+interval '10 minutes') RETURNING *",[taskId,...scope(p),conversationId,instruction,claimId,connectionId,input.connectionEpoch])).rows[0]
    const messageId=await event(c,p,conversationId,'task',taskDto(row),'office',taskId)
    await c.query("INSERT INTO assistant_requests(deployment_id,owner_id,conversation_id,actor,request_id,params_hash,receipt) VALUES($1,$2,$3,'office',$4,$5,$6)",[...scope(p),conversationId,requestId,paramsHash,JSON.stringify({messageId,taskId})])
    return taskDto(row)
   })
  },
  async claim(credential:ChannelCredential,conversationId:string,input:{taskId:string;connectionId:string;connectionEpoch:number}) {
   const connectionId=uuid(input.connectionId)
   return run(credential,conversationId,async(c,p,ch,actor)=>{
    await expire(c,p,conversationId)
    if(ch.paused)throw fail(409)
    const epoch=actor.member?actor.member.connection_epoch:ch.office_epoch,current=actor.member?actor.member.connection_id:ch.office_connection_id
    if(current!==connectionId||epoch!==input.connectionEpoch)throw fail(409)
    const row=await task(c,p,conversationId,input.taskId)
    if(row.recipient!==actor.id||row.state!=='queued')throw fail(409)
    const busy=(await c.query("SELECT 1 FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND recipient=$4 AND state IN ('running','cancel_requested')",[...scope(p),conversationId,actor.id])).rowCount
    if(busy)throw fail(409)
    const claimId=randomUUID()
    const claimed=(await c.query("UPDATE assistant_tasks SET state='running',claim_id=$4,connection_id=$5,connection_epoch=$6 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3 RETURNING *",[...scope(p),row.task_id,claimId,connectionId,epoch])).rows[0]
    await event(c,p,conversationId,'task',taskDto(claimed),actor.id,row.task_id)
    const result=taskDto(claimed)
    const ids=claimed.child_task_ids as string[]
    if(ids.length){
     const children=(await c.query('SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND parent_task_id=$4 AND task_id=ANY($5::uuid[])',[...scope(p),conversationId,claimed.task_id,ids])).rows
     if(children.length!==ids.length||children.some(child=>!terminal(child.state)))throw fail(409)
     result.continuation={parentTaskId:claimed.task_id,untrusted:true,children:ids.map(id=>{
      const child=children.find(row=>row.task_id===id)!,preview=taskPreview(child)
      return {taskId:id,state:child.state,summary:preview.summary,outcome:child.outcome??null,summaryTruncated:preview.summary!==child.summary}
     })}
    }
    return result
   })
  },
  async yieldTask(credential:ChannelCredential,conversationId:string,input:{taskId:string;claimId:string;connectionEpoch:number;childTaskIds:string[]}) {
   if(!Array.isArray(input.childTaskIds)||!input.childTaskIds.length||input.childTaskIds.length>16)throw fail()
   const children=input.childTaskIds.map(uuid);if(new Set(children).size!==children.length)throw fail()
   return run(credential,conversationId,async(c,p,ch,actor)=>{
    await expire(c,p,conversationId)
    const row=await task(c,p,conversationId,input.taskId),epoch=actor.member?actor.member.connection_epoch:ch.office_epoch
    const connection=actor.member?actor.member.connection_id:ch.office_connection_id
    if(row.recipient!==actor.id||row.claim_id!==uuid(input.claimId)||row.connection_epoch!==input.connectionEpoch||epoch!==input.connectionEpoch||!connection||row.connection_id!==connection)throw fail(409)
    if(row.state!=='running'){
     const saved=row.child_task_ids as string[]
     if(!['waiting_peer','queued'].includes(row.state)||saved.length!==children.length||children.some(id=>!saved.includes(id)))throw fail(409)
     return taskDto(row)
    }
    const rows=(await c.query('SELECT * FROM assistant_tasks WHERE deployment_id=$1 AND owner_id=$2 AND conversation_id=$3 AND parent_task_id=$4 AND task_id=ANY($5::uuid[])',[...scope(p),conversationId,row.task_id,children])).rows
    if(rows.length!==children.length)throw fail(409)
    await c.query('UPDATE assistant_tasks SET child_task_ids=$4 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id,JSON.stringify(children)])
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
    if(row.recipient!==actor.id||row.claim_id!==uuid(input.claimId)||row.connection_epoch!==input.connectionEpoch||row.state!=='unknown_outcome')throw fail(409)
    await c.query('UPDATE assistant_tasks SET summary=$4,outcome=$5 WHERE deployment_id=$1 AND owner_id=$2 AND task_id=$3',[...scope(p),row.task_id,summary,input.outcome]);row.summary=summary;row.outcome=input.outcome
    await state(c,p,conversationId,row,row.cancel_requested?'cancelled':input.outcome);await wake(c,p,conversationId,row.parent_task_id)
    return taskDto(row)
   })
  },
  async notifications(token:string,fileId:string) {
   return owner(token,async(c,p)=>{
    await loadFile(c,p,uuid(fileId))
    const channels=(await c.query('SELECT conversation_id FROM assistant_channels WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 ORDER BY created_at DESC LIMIT 32',[...scope(p),fileId])).rows
    for(const ch of channels){await channel(c,p,ch.conversation_id);await reapDisconnected(c,p,ch.conversation_id)}
    const rows=(await c.query('SELECT conversation_id,sequence FROM assistant_channels WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 ORDER BY created_at DESC LIMIT 32',[...scope(p),fileId])).rows
    return rows.map(r=>({conversationId:r.conversation_id,sequence:Number(r.sequence)}))
   })
  },
 }
 return service
}
export type AssistantChannelService=ReturnType<typeof createAssistantChannelService>
