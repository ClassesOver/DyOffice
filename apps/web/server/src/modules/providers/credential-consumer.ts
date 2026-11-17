import {createDecipheriv} from 'node:crypto'
import type {PrincipalTransactions} from '../../db/context.ts'
import {tokenHash} from '../auth/sessions.ts'
import type {SecretKeyring} from '../admin/secrets.ts'

export interface DispatchRequest { reservationId:string; claimId:string; entryId:string; configRevision:number; requestDigest:string; turnId:string }
export interface DispatchGrant extends DispatchRequest { deploymentId:string; userId:string; sessionId:string }
export interface CredentialProfile { deploymentId:string; entryId:string; revision:number; providerId:string; model:string; baseUrl:string; endpoint:string }
export interface CredentialScope extends CredentialProfile { reservationId:string; claimId:string; requestDigest:string; turnId:string; credential:Buffer; signal:AbortSignal }
const unavailable=()=>new Error('Provider credential unavailable')
const valid=(v:unknown)=>typeof v==='string' && /^[A-Za-z0-9_.-]{1,128}$/.test(v)
const fields=['reservationId','claimId','entryId','configRevision','requestDigest','turnId']
function snapshot(input:DispatchRequest):DispatchRequest {
  if (!input || fields.some(k=>!Object.hasOwn(input,k)) || Object.keys(input).some(k=>!fields.includes(k)) ||
      ![input.reservationId,input.claimId,input.entryId,input.turnId].every(valid) ||
      !Number.isSafeInteger(input.configRevision) || input.configRevision<0 ||
      !/^[a-f0-9]{64}$/.test(input.requestDigest)) throw unavailable()
  return Object.freeze({...input})
}
function decode(value:unknown,length?:number):Buffer {
  if(typeof value!=='string'||!value||value.length>16384)throw unavailable()
  const bytes=Buffer.from(value,'base64')
  if(bytes.toString('base64')!==value || length!==undefined&&bytes.length!==length)throw unavailable()
  return bytes
}
/**
 * Server-private, admin-only, unmounted. The injected consumer is trusted code,
 * never a request callback; it must not retain/copy/log credentials.
 * takeForDispatch MUST commit the unique dispatching->unknown transition before
 * returning. This factory is not a replacement for that durable budget gate.
 */
export function createScopedAdminCredentialConsumer({transactions,keyring,profiles,consume,takeForDispatch}:{
  transactions:PrincipalTransactions;keyring:SecretKeyring;profiles:readonly CredentialProfile[];
  consume:(scope:Readonly<CredentialScope>)=>Promise<void>;
  takeForDispatch:(token:string,request:DispatchRequest)=>Promise<DispatchGrant>;
}) {
  const keys=new Map<string,Buffer>()
  let disposed=false
  try {
    if(!keyring||!valid(keyring.activeKeyId)||!keyring.keys||typeof consume!=='function'||typeof takeForDispatch!=='function'||!Array.isArray(profiles))throw unavailable()
    for(const [id,key] of Object.entries(keyring.keys)){
      if(!valid(id)||!(key instanceof Uint8Array)||key.length!==32)throw unavailable()
      keys.set(id,Buffer.from(key))
    }
    if(!keys.has(keyring.activeKeyId)||keys.size>32||profiles.length>256)throw unavailable()
  }catch{for(const key of keys.values())key.fill(0);throw unavailable()}
  let approved:Readonly<CredentialProfile>[]
  try { approved=profiles.map(p=>{
    if(!p||Object.keys(p).length!==7||Object.keys(p).some(k=>!['deploymentId','entryId','revision','providerId','model','baseUrl','endpoint'].includes(k)))throw unavailable()
    const u=new URL(p.endpoint),b=new URL(p.baseUrl)
    if(![p.deploymentId,p.entryId,p.providerId].every(valid)||!Number.isSafeInteger(p.revision)||p.revision<0||typeof p.model!=='string'||!p.model||p.model.length>256||
       [u,b].some(v=>v.protocol!=='https:'||v.username||v.password||v.search||v.hash)||u.href!==p.endpoint||b.href!==p.baseUrl||u.origin!==b.origin)throw unavailable()
    return Object.freeze({...p})
  }) } catch {for(const key of keys.values())key.fill(0);throw unavailable()}
  function decrypt(value:unknown,profile:CredentialProfile):Buffer{
    if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable()
    const e=value as Record<string,unknown>
    if(Object.keys(e).some(k=>!['version','algorithm','keyId','iv','tag','ciphertext'].includes(k))||e.version!==1||e.algorithm!=='A256GCM'||typeof e.keyId!=='string'||!keys.has(e.keyId))throw unavailable()
    const d=createDecipheriv('aes-256-gcm',keys.get(e.keyId)!,decode(e.iv,12))
    d.setAAD(Buffer.from(JSON.stringify(['dyoffice.global-config',1,e.keyId,profile.deploymentId,profile.entryId,profile.providerId,'chat'])))
    d.setAuthTag(decode(e.tag,16))
    let partial:Buffer|undefined,tail:Buffer|undefined
    try{
      partial=d.update(decode(e.ciphertext));tail=d.final()
      const result=Buffer.concat([partial,tail])
      if(!result.length||result.length>8192){result.fill(0);throw unavailable()}
      return result
    }finally{partial?.fill(0);tail?.fill(0)}
  }
  return {
    dispose(){disposed=true;for(const key of keys.values())key.fill(0);keys.clear()},
    async run(token:string,input:DispatchRequest & {signal?:AbortSignal}):Promise<void>{
      let plaintext:Buffer|undefined
      try{
        const {signal=new AbortController().signal,...raw}=input
        const request=snapshot(raw)
        if(disposed||signal.aborted)throw unavailable()
        // A failed credential check after this point conservatively holds budget.
        const grant=await takeForDispatch(token,request)
        if(fields.some(k=>grant[k as keyof DispatchRequest]!==request[k as keyof DispatchRequest])||disposed||signal.aborted)throw unavailable()
        await transactions.withPrincipalTransaction({kind:'session',token},async(connection,principal)=>{
          if(!principal.roles.includes('config_admin')||['deploymentId','userId','sessionId'].some(k=>principal[k as 'deploymentId']!==grant[k as 'deploymentId']))throw unavailable()
          await connection.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(token),String(transactions.sessionIdleMs)])
          await connection.query('SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1,0))',['dyoffice:global-config:'+principal.deploymentId])
          // Recheck authorization after waiting on the config lock (not just the
          // principal snapshot), including clock-based expiry and token binding.
          if(!(await connection.query('SELECT global_config_authorized($1,true) AS authorized',[principal.deploymentId])).rows[0]?.authorized)throw unavailable()
          const row=(await connection.query(
            'SELECT c.revision,e.id,e.kind,e.provider_id,e.model,e.base_url,e.enabled,s.envelope FROM global_configs c JOIN global_config_entries e ON e.deployment_id=c.deployment_id JOIN global_config_secrets s ON s.deployment_id=e.deployment_id AND s.entry_id=e.id AND s.kind=e.kind AND s.provider_id=e.provider_id WHERE c.deployment_id=$1 AND e.id=$2',
            [principal.deploymentId,request.entryId])).rows[0]
          const matches=approved.filter(p=>p.deploymentId===principal.deploymentId&&p.entryId===request.entryId&&p.revision===request.configRevision)
          if(matches.length!==1||!row||row.kind!=='chat'||!row.enabled||row.revision!==request.configRevision)throw unavailable()
          const profile=matches[0]!
          if(row.provider_id!==profile.providerId||row.model!==profile.model||row.base_url!==profile.baseUrl||disposed||signal.aborted)throw unavailable()
          plaintext=decrypt(row.envelope,profile)
          if(disposed||signal.aborted)throw unavailable()
          // Return values are discarded, all thrown values redacted. The trusted
          // callback can technically copy bytes: Buffer zeroing does NOT erase
          // arbitrary JS/native copies and is not claimed as a secure enclave.
          await consume(Object.freeze({...profile,reservationId:request.reservationId,claimId:request.claimId,requestDigest:request.requestDigest,turnId:request.turnId,credential:plaintext,signal}))
        })
      }catch{throw unavailable()}
      finally{plaintext?.fill(0)}
    },
  }
}
