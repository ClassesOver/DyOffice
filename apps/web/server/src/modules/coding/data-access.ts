import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto'
import type {HarnessDataGrant,HarnessDataInputs} from '../../../../../../packages/web-contracts/src/harness-data.ts'
import type {WorkspaceSourceResultDownload} from '../../../../../../packages/web-contracts/src/source-results.ts'
import type {SessionService,SessionPrincipal} from '../auth/sessions.ts'
import type {WorkspaceSourceTools} from '../sources/tools.ts'
import type {WorkspaceSourceResults} from '../sources/results.ts'
import type {createHarnessArtifacts,AnalysisDelivery} from './artifacts.ts'

const unavailable=(statusCode=403)=>Object.assign(Error('Harness data unavailable'),{statusCode})
const hash=(value:string)=>createHash('sha256').update(value).digest()
const uuid=(value:unknown):string=>{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw unavailable(400);return value.toLowerCase()}
const sourceId=(value:unknown):string=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value))throw unavailable(400);return value}
function object(input:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||
    Reflect.ownKeys(input).some(key=>typeof key!=='string'||!keys.includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,key)??{},'value')))throw unavailable(400)
  return input as Record<string,unknown>
}
function scope(input:unknown):HarnessDataInputs {
  const value=object(input,['sourceIds','resultIds'])
  const ids=(raw:unknown,validate:(id:unknown)=>string)=>{
    if(!Array.isArray(raw)||raw.length>32)throw unavailable(400)
    const result=raw.map(validate)
    if(new Set(result).size!==result.length)throw unavailable(400)
    return result
  }
  return {sourceIds:ids(value.sourceIds,sourceId),resultIds:ids(value.resultIds,uuid)}
}
const identity=(principal:SessionPrincipal)=>{
  if(!principal.roles.includes('personal'))throw unavailable()
  return JSON.stringify([principal.deploymentId,principal.userId,principal.sessionId,principal.authVersion])
}
interface Entry {
  taskId:string;credentialHash:Buffer;token:string;agentId:string;claimId:string;expiresAt:number
  sourceIds:Set<string>;resultIds:Set<string>;signal:AbortSignal;owner?:string;identity?:string
  timer:ReturnType<typeof setTimeout>;abort:()=>void;busy:boolean
  authorize?:()=>Promise<void>
  delivery?:AnalysisDelivery
}

/** Task-scoped capabilities over the existing owner-authorized source services.
 * User session tokens stay in this bounded server-only map; only random task
 * credentials are returned. This is an in-memory task lifecycle, not pairing
 * or durable claim recovery. Revocation removes the sole current claim.
 */
export function createHarnessDataAccess(options:{
  tools:Pick<WorkspaceSourceTools,'execute'>
  results:Pick<WorkspaceSourceResults,'read'|'download'>
  sessions:Pick<SessionService,'authenticate'>
  artifacts?:Pick<ReturnType<typeof createHarnessArtifacts>,'stage'|'commit'> & Partial<Pick<ReturnType<typeof createHarnessArtifacts>,'cancel'|'receipt'>>
}) {
  let disposed=false
  const entries=new Map<string,Entry>()
  const binding=(entry:Entry)=>({taskId:entry.taskId,claimId:entry.claimId,epoch:1})
  const cleanup=(entry:Entry,token:string)=>{
    // Failed/ambiguous cleanup remains charged by the artifact service. Never
    // release its accounting here or let cleanup suppress grant revocation.
    if(token&&options.artifacts?.cancel)void options.artifacts.cancel(token,binding(entry)).catch(()=>{})
  }
  const revoke=(taskId:string)=>{
    const entry=entries.get(taskId)
    if(!entry)return
    entries.delete(taskId);clearTimeout(entry.timer);entry.signal.removeEventListener('abort',entry.abort)
    cleanup(entry,entry.token);entry.token='';entry.credentialHash.fill(0)
  }
  const current=(entry:Entry)=>{
    if(disposed||entries.get(entry.taskId)!==entry||entry.signal.aborted||Date.now()>=entry.expiresAt){revoke(entry.taskId);throw unavailable()}
  }
  async function validate(entry:Entry) {
    current(entry)
    try {
      await entry.authorize?.()
      const principal=await options.sessions.authenticate(entry.token)
      current(entry)
      if(entry.identity!==identity(principal))throw unavailable()
    } catch {revoke(entry.taskId);throw unavailable()}
  }
  function lookup(taskId:unknown,bearer:unknown) {
    if(typeof taskId!=='string'||typeof bearer!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(bearer))throw unavailable()
    const entry=entries.get(taskId)
    if(!entry||!timingSafeEqual(entry.credentialHash,hash(bearer)))throw unavailable()
    current(entry)
    return entry
  }
  async function guarded<T>(entry:Entry,operation:()=>Promise<T>):Promise<T> {
    if(entry.busy)throw unavailable(429)
    entry.busy=true
    const token=entry.token
    try {await validate(entry);const result=await operation();await validate(entry);return result}
    catch(error){throw unavailable((error as {statusCode?:number}).statusCode===429?429:403)}
    finally {entry.busy=false;if(entries.get(entry.taskId)!==entry)cleanup(entry,token)}
  }
  function resultId(entry:Entry,value:unknown) {
    const id=uuid(value)
    if(!entry.resultIds.has(id))throw unavailable()
    return id
  }
  return {
    async issue(input:{token:string;agentId:string;inputs:HarnessDataInputs;signal:AbortSignal;ttlMs?:number;authorize?:()=>Promise<void>}):Promise<HarnessDataGrant> {
      const value={...object(input,['token','agentId','inputs','signal','ttlMs','authorize'])},inputs=scope(value.inputs)
      if(value.authorize!==undefined&&typeof value.authorize!=='function')throw unavailable(400)
      if(typeof value.token!=='string'||!value.token||typeof value.agentId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.agentId)||!(value.signal instanceof AbortSignal))throw unavailable(400)
      const ttlMs=value.ttlMs??600000
      if(!Number.isSafeInteger(ttlMs)||(ttlMs as number)<1||(ttlMs as number)>600000)throw unavailable(400)
      if(disposed||value.signal.aborted)throw unavailable()
      // Finished remote claims have no local finally block. Reclaim their
      // bounded slots on admission without introducing a cleanup daemon.
      for(const entry of [...entries.values()])if(entry.authorize&&entry.identity) {
        try {await validate(entry)} catch {/* validate already revoked it. */}
      }
      if(disposed||value.signal.aborted)throw unavailable()
      if(entries.size>=16)throw unavailable(429)
      const taskId=randomUUID(),credential=randomBytes(32).toString('base64url'),claimId=randomUUID(),expiresAt=Date.now()+(ttlMs as number)
      const abort=()=>revoke(taskId),timer=setTimeout(abort,ttlMs as number);timer.unref()
      const entry:Entry={taskId,credentialHash:hash(credential),token:value.token,agentId:value.agentId,claimId,expiresAt,
        sourceIds:new Set(inputs.sourceIds),resultIds:new Set(inputs.resultIds),signal:value.signal,timer,abort,busy:false,authorize:value.authorize as (()=>Promise<void>)|undefined}
      // Pending source/result checks consume the same slots as active grants.
      entries.set(taskId,entry);entry.signal.addEventListener('abort',abort,{once:true})
      try {
        await entry.authorize?.();current(entry)
        const principal=await options.sessions.authenticate(entry.token);current(entry)
        entry.identity=identity(principal)
        const owner=JSON.stringify([principal.deploymentId,principal.userId])
        if([...entries.values()].filter(other=>other.owner===owner).length>=2)throw unavailable(429)
        entry.owner=owner
        for(const id of entry.sourceIds){await options.tools.execute(entry.token,{name:'sources.describe',arguments:{sourceId:id}});current(entry)}
        for(const id of entry.resultIds){await options.results.read(entry.token,{resultId:id,limit:1});current(entry)}
        await validate(entry)
        return {taskId,claimId,connectionEpoch:1,credential,agentId:entry.agentId,expiresAt:new Date(expiresAt).toISOString(),inputs:{sourceIds:[...entry.sourceIds],resultIds:[...entry.resultIds]}}
      } catch(error){revoke(taskId);throw unavailable((error as {statusCode?:number}).statusCode===429?429:403)}
    },
    async execute(taskId:string,bearer:string,operation:string,args:unknown):Promise<unknown> {
      const entry=lookup(taskId,bearer)
      return guarded(entry,async()=>{
        if(operation==='sources.list') {
          const input=object(args,['after'])
          const after=input.after===undefined?undefined:sourceId(input.after)
          if(after!==undefined&&!entry.sourceIds.has(after))throw unavailable()
          if(!entry.sourceIds.size)return {items:[],nextCursor:null}
          const items:unknown[]=[],found=new Set<string>();let cursor=after
          // Scanning is bounded; raw source cursors/names outside scope never
          // leave this layer. A task's catalog itself has at most 32 entries.
          for(let page=0;page<32;page++) {
            current(entry)
            const result=await options.tools.execute(entry.token,{name:'sources.list',arguments:cursor===undefined?{}:{after:cursor}}) as {items:{sourceId:string}[];nextCursor:string|null}
            if(!result||!Array.isArray(result.items))throw unavailable()
            for(const item of result.items)if(entry.sourceIds.has(item.sourceId)&&!found.has(item.sourceId)) {items.push(item);found.add(item.sourceId)}
            if(!result.nextCursor||found.size===entry.sourceIds.size)return {items,nextCursor:null}
            if(result.nextCursor===cursor)throw unavailable()
            cursor=result.nextCursor
          }
          throw unavailable()
        }
        if(operation==='sources.describe'||operation==='sources.query') {
          const input=object(args,operation==='sources.describe'?['sourceId','table']:['sourceId','sql','sourceVersion']),id=sourceId(input.sourceId)
          if(!entry.sourceIds.has(id))throw unavailable()
          if(operation==='sources.query'&&entry.resultIds.size>=64)throw unavailable(429)
          const result=await options.tools.execute(entry.token,{name:operation,arguments:input})
          if(operation==='sources.describe')return result
          await validate(entry)
          const query=result as {artifact:{resultId:string};schema:unknown;timezone:string;totalRows:number;sourceTruncated:boolean;sha256:string;notice:string}
          const idResult=uuid(query.artifact?.resultId)
          entry.resultIds.add(idResult)
          return {artifact:query.artifact,schema:query.schema,timezone:query.timezone,totalRows:query.totalRows,sourceTruncated:query.sourceTruncated,sha256:query.sha256,notice:query.notice}
        }
        if(operation==='results.get_manifest') {
          const input=object(args,['resultId']),id=resultId(entry,input.resultId)
          const page=await options.results.read(entry.token,{resultId:id,limit:1})
          return {artifact:page.artifact,schema:page.schema,timezone:page.timezone,totalRows:page.totalRows,sourceTruncated:page.sourceTruncated,sha256:page.sha256}
        }
        if(operation==='results.download') {
          const input=object(args,['resultId'])
          return options.results.download(entry.token,resultId(entry,input.resultId))
        }
        if(operation==='artifacts.get_receipt') {
          if(!options.artifacts?.receipt)throw unavailable()
          const input=object(args,['commandId']),commandId=uuid(input.commandId)
          // Recovery reads the durable owner receipt, never expires/requeries
          // input snapshots or repeats a storage write. Owner scope alone is
          // insufficient: the current task, claim and epoch must also match.
          const receipt=await options.artifacts.receipt(entry.token,commandId)
          if(receipt.commandId!==commandId||receipt.taskId!==entry.taskId||
            receipt.claimId!==entry.claimId||receipt.connectionEpoch!==1)throw unavailable()
          await validate(entry)
          entry.delivery=structuredClone(receipt)
          return structuredClone(receipt)
        }
        if(operation==='artifacts.stage') {
          if(!options.artifacts)throw unavailable()
          const input=object(args,['name','mediaType','role','inputResultIds','sha256','bytesBase64'])
          if(!Array.isArray(input.inputResultIds)||input.inputResultIds.length>32)throw unavailable(400)
          const inputResultIds=input.inputResultIds.map(id=>resultId(entry,id))
          const encoded=input.bytesBase64
          if(typeof encoded!=='string'||encoded.length>11184812||encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw unavailable(400)
          const bytes=Buffer.from(encoded,'base64')
          if(bytes.length<1||bytes.length>8*1024*1024||bytes.toString('base64')!==encoded)throw unavailable(400)
          return options.artifacts.stage(entry.token,{...binding(entry),name:input.name as string,mediaType:input.mediaType as string,role:input.role as string,sha256:input.sha256 as string,inputResultIds},bytes)
        }
        if(operation==='artifacts.commit') {
          if(!options.artifacts)throw unavailable()
          const input=object(args,['commandId','summary','artifactIds','inputs','runtimeManifestSha256','limitations'])
          if(!Array.isArray(input.inputs)||input.inputs.length>32)throw unavailable(400)
          const verifiedInputs:unknown[]=[]
          for(const raw of input.inputs) {
            const ref=object(raw,['resultId','sha256','sourceId','sourceVersion','queryHash','rowCount','truncated']),id=resultId(entry,ref.resultId)
            const page=await options.results.read(entry.token,{resultId:id,limit:1})
            current(entry)
            for(const key of ['resultId','sha256','sourceId','sourceVersion','queryHash','rowCount','truncated'] as const)if(ref[key]!==page.artifact[key])throw unavailable()
            // These fields come only from the authorized frozen snapshot, never
            // from the harness submission, live source metadata or preview rows.
            verifiedInputs.push({...ref,schema:page.schema.map(column=>({name:column.name,type:column.type,...(column.unit===undefined?{}:{unit:column.unit})})),timezone:page.timezone})
          }
          const receipt=await options.artifacts.commit(entry.token,{...binding(entry),commandId:input.commandId as string,summary:input.summary as string,artifactIds:input.artifactIds as string[],inputs:verifiedInputs,runtimeManifestSha256:input.runtimeManifestSha256 as string,limitations:input.limitations as string[]})
          await validate(entry)
          entry.delivery=structuredClone(receipt)
          return receipt
        }
        throw unavailable(400)
      })
    },
    async download(taskId:string,bearer:string,id:string):Promise<WorkspaceSourceResultDownload> {
      const entry=lookup(taskId,bearer)
      return guarded(entry,()=>options.results.download(entry.token,resultId(entry,id)))
    },
    async authorize(taskId:string,bearer:string) {
      const entry=lookup(taskId,bearer)
      return guarded(entry,async()=>({taskId:entry.taskId,claimId:entry.claimId,connectionEpoch:1 as const,agentId:entry.agentId}))
    },
    async delivery(taskId:string,bearer:string):Promise<AnalysisDelivery|undefined> {
      const entry=lookup(taskId,bearer)
      return guarded(entry,async()=>entry.delivery===undefined?undefined:structuredClone(entry.delivery))
    },
    revoke,
    dispose(){disposed=true;for(const taskId of entries.keys())revoke(taskId)},
  }
}
