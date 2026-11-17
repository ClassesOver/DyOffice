import type {SettingsRequest} from './preferences.ts'

export interface AnalysisInput {resultId:string;sourceId:string;sourceVersion:number;queryHash:string;sha256:string;rowCount:number;truncated:boolean}
export interface AnalysisFile {artifactId:string;taskId:string;name:string;mediaType:string;role:string;sizeBytes:number;sha256:string;inputResultIds:string[]}
export interface AnalysisReceipt {taskId:string;claimId:string;connectionEpoch:number;commandId:string;summary:string;artifacts:AnalysisFile[];inputs:AnalysisInput[];runtimeManifestSha256:string;limitations:string[];createdAt:string}
export interface AnalysisAgent {id:string;name:string;origin:'builtin'|'external'}
export interface AnalysisPresentation {agent:AnalysisAgent;receipt:AnalysisReceipt}
const maxFileBytes=8*1024*1024
const unavailable=()=>Error('Cannot confirm analysis delivery')
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const uuid=(v:unknown):string=>{if(typeof v!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v))throw unavailable();return v.toLowerCase()}
const hash=(v:unknown):string=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw unavailable();return v}
const text=(v:unknown,max:number):string=>{if(typeof v!=='string'||new TextEncoder().encode(v).length>max)throw unavailable();return v}
const integer=(v:unknown,max:number,min=0):number=>{if(!Number.isSafeInteger(v)||(v as number)<min||(v as number)>max)throw unavailable();return v as number}
function list<T>(v:unknown,max:number,read:(item:unknown)=>T):T[]{if(!Array.isArray(v)||v.length>max)throw unavailable();return v.map(read)}
function receipt(value:unknown,taskId:string,commandId:string):AnalysisReceipt {
 if(!record(value)||uuid(value.taskId)!==taskId||uuid(value.commandId)!==commandId)throw unavailable()
 const inputs=list(value.inputs,32,item=>{
  if(!record(item)||Object.keys(item).some(k=>!['resultId','sourceId','sourceVersion','queryHash','sha256','rowCount','truncated'].includes(k))||typeof item.truncated!=='boolean')throw unavailable()
  return {resultId:uuid(item.resultId),sourceId:text(item.sourceId,200),sourceVersion:integer(item.sourceVersion,Number.MAX_SAFE_INTEGER,1),queryHash:hash(item.queryHash),sha256:hash(item.sha256),rowCount:integer(item.rowCount,10000),truncated:item.truncated}
 })
 const inputIds=new Set(inputs.map(x=>x.resultId));if(inputIds.size!==inputs.length)throw unavailable()
 const artifacts=list(value.artifacts,12,item=>{
  if(!record(item)||uuid(item.taskId)!==taskId)throw unavailable()
  const name=text(item.name,240),mediaType=text(item.mediaType,120),role=text(item.role,64)
  if(!name||name!==name.trim()||/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/u.test(name)||/[. ]$/.test(name)||!/^[-a-zA-Z0-9.+]+\/[-a-zA-Z0-9.+]+$/.test(mediaType)||!/^[-a-zA-Z0-9_]{1,64}$/.test(role))throw unavailable()
  const ids=list(item.inputResultIds,32,uuid);if(ids.some(id=>!inputIds.has(id))||new Set(ids).size!==ids.length)throw unavailable()
  return {artifactId:uuid(item.artifactId),taskId,name,mediaType,role,sizeBytes:integer(item.sizeBytes,maxFileBytes,1),sha256:hash(item.sha256),inputResultIds:ids}
 })
 if(!artifacts.length||new Set(artifacts.map(x=>x.artifactId)).size!==artifacts.length||artifacts.reduce((n,x)=>n+x.sizeBytes,0)>16*1024*1024)throw unavailable()
 const createdAt=text(value.createdAt,64);if(!Number.isFinite(Date.parse(createdAt)))throw unavailable()
 return {taskId,commandId,claimId:uuid(value.claimId),connectionEpoch:integer(value.connectionEpoch,2147483647,1),summary:text(value.summary,16000),artifacts,inputs,runtimeManifestSha256:hash(value.runtimeManifestSha256),limitations:list(value.limitations,32,x=>text(x,2000)),createdAt}
}
/** Session-bound server receipts are authoritative for committed references only.
 * Agent summaries and document bytes remain untrusted, never active previews. */
export function createAnalysisDeliveryClient(options:{request:SettingsRequest;csrfToken:string;fetchImpl?:typeof fetch}) {
 const send=options.fetchImpl??fetch,items=new Map<string,AnalysisPresentation>(),listeners=new Set<()=>void>(),pending=new Set<string>(),downloads=new Set<AbortController>()
 let disposed=false,generation=0,message='',refreshing=false
 const emit=()=>{for(const listener of listeners)try{listener()}catch{}}
 const current=(stamp:number)=>!disposed&&stamp===generation
 function check(stamp:number){if(!current(stamp))throw unavailable()}
 function clear(){generation++;items.clear();pending.clear();for(const c of downloads)c.abort();downloads.clear()}
 function fail(){if(disposed)return;clear();message='无法确认分析交付或当前会话，请重新打开助手。';emit()}
 async function load(taskId:string,commandId:string,stamp:number){const value=await options.request('/api/v1/agents/deliveries/'+commandId);check(stamp);return receipt(value,taskId,commandId)}
 return {
  snapshot:()=>structuredClone([...items.values()]),error:()=>message,
  subscribe(listener:()=>void){listeners.add(listener);return()=>listeners.delete(listener)},
  async observe(hint:unknown,agent:AnalysisAgent) {
   if(disposed)return
   const stamp=generation;let commandId:string|undefined
   try {
    if(!record(hint))throw unavailable();const taskId=uuid(hint.taskId);commandId=uuid(hint.commandId)
    if(pending.has(commandId))return
    if(pending.size>=16)throw unavailable()
    if(!agent||!['builtin','external'].includes(agent.origin))throw unavailable()
    const identity={id:text(agent.id,100),name:text(agent.name,200),origin:agent.origin}
    pending.add(commandId)
    const trusted=await load(taskId,commandId,stamp);check(stamp)
    items.delete(commandId);items.set(commandId,{agent:identity,receipt:trusted})
    if(items.size>10)items.delete(items.keys().next().value!)
    message='';emit()
   }catch{if(current(stamp))fail()}
   finally{if(commandId&&current(stamp))pending.delete(commandId)}
  },
  async refresh() {
   const stamp=generation;if(disposed||refreshing||!items.size)return
   refreshing=true
   try {
    for(const item of [...items.values()]) {
     const updated=await load(item.receipt.taskId,item.receipt.commandId,stamp)
     if(items.get(item.receipt.commandId)===item)items.set(item.receipt.commandId,{agent:item.agent,receipt:updated})
    }
    check(stamp);message='';emit()
   }catch{if(current(stamp))fail()}
   finally{refreshing=false}
  },
  async download(commandId:string,artifactId:string) {
   const stamp=generation,controller=new AbortController();downloads.add(controller)
   try {
    check(stamp);uuid(commandId);uuid(artifactId)
    if(!/^[A-Za-z0-9_-]{43}$/.test(options.csrfToken))throw unavailable()
    const displayed=items.get(commandId);if(!displayed)throw unavailable()
    const fresh=await load(displayed.receipt.taskId,commandId,stamp)
    const artifact=fresh.artifacts.find(x=>x.artifactId===artifactId),old=displayed.receipt.artifacts.find(x=>x.artifactId===artifactId)
    if(!artifact||!old||JSON.stringify(artifact)!==JSON.stringify(old))throw unavailable()
    const path='/api/v1/agents/artifacts/'+artifact.artifactId+'/content'
    const response=await send(path,{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'X-CSRF-Token':options.csrfToken},signal:controller.signal});check(stamp)
    if(!response.ok||response.redirected||response.headers.get('content-type')?.split(';')[0]!=='application/octet-stream'||response.headers.get('x-content-sha256')!==artifact.sha256)throw unavailable()
    if(response.url&&(typeof location==='undefined'||response.url!==new URL(path,location.origin).href))throw unavailable()
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==artifact.sizeBytes))throw unavailable()
    if(!response.body)throw unavailable();const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
    try {for(;;){const part=await reader.read();check(stamp);if(part.done)break;size+=part.value.byteLength;if(size>artifact.sizeBytes||size>maxFileBytes)throw unavailable();chunks.push(part.value)}}finally{await reader.cancel().catch(()=>{})}
    check(stamp);if(size!==artifact.sizeBytes)throw unavailable()
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
    // This is the raw artifact byte hash, not its input snapshot provenance hash.
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));check(stamp)
    if([...digest].map(v=>v.toString(16).padStart(2,'0')).join('')!==artifact.sha256)throw unavailable()
    const final=await load(fresh.taskId,commandId,stamp);check(stamp)
    if(JSON.stringify(final)!==JSON.stringify(fresh))throw unavailable()
    return {name:artifact.name,bytes,current:()=>current(stamp)}
   }catch{if(current(stamp))fail();throw unavailable()}
   finally{controller.abort();downloads.delete(controller)}
  },
  dispose(){if(disposed)return;disposed=true;clear();emit();listeners.clear()},
 }
}
