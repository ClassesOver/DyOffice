import {createHash,randomBytes} from 'node:crypto'
import {open,link,unlink} from 'node:fs/promises'
import {basename,dirname,join,resolve} from 'node:path'
import {HARNESS_DATA_MAX_METADATA_BYTES} from '../../web-contracts/src/harness-data.ts'
import {SOURCE_QUERY_REQUEST_TIMEOUT_MS,sourceQueryBatchSize} from '../../web-contracts/src/source-query-batch.ts'
import {SOURCE_RESULT_MAX_BYTES} from '../../web-contracts/src/source-results.ts'

export interface HarnessDataClientOptions {
  baseUrl:string
  taskId:string
  credential:string
  fetchImpl?:typeof fetch
}
export interface HarnessDataDownload {
  destination:string
  resultId:string
  /** 下载原始字节的摘要，不等于快照语义证据摘要。 */
  sha256:string
  snapshotSha256:string
  sizeBytes:number
}
export const harnessDataRequestLimit=(operation:string)=>operation==='artifacts.stage'?12*1024*1024:operation==='artifacts.commit'?80*1024:40*1024
const failure=()=>new Error('Harness data operation unavailable')
const aborted=()=>new DOMException('Harness data operation cancelled','AbortError')
const checkAbort=(signal?:AbortSignal)=>{if(signal?.aborted)throw aborted()}
const identifier=(value:unknown):string=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw failure();return value}
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))

async function timedQuery<T>(send:(signal:AbortSignal)=>Promise<T>,count:number,caller?:AbortSignal):Promise<T> {
  const deadline=new AbortController()
  const signal=caller?AbortSignal.any([caller,deadline.signal]):deadline.signal
  let onAbort!:()=>void
  const stopped=new Promise<never>((_,reject)=>{
    onAbort=()=>reject(caller?.aborted?aborted():failure())
    signal.addEventListener('abort',onAbort,{once:true})
    if(signal.aborted)onAbort()
  })
  const timer=setTimeout(()=>deadline.abort(),count*SOURCE_QUERY_REQUEST_TIMEOUT_MS)
  try {
    // A custom fetch can deliver headers after cancellation. The request still
    // owns that late response and will cancel its body in boundedBody.
    return await Promise.race([send(signal),stopped])
  } finally {clearTimeout(timer);signal.removeEventListener('abort',onAbort)}
}

function baseAddress(value:string):string {
  if(typeof value!=='string'||!/^https?:\/\//.test(value)||/[\s\\?#]/.test(value)||/%(?:2e|2f|5c)/i.test(value)||/(?:^|\/)\.{1,2}(?:\/|$)/.test(value))throw failure()
  const url=new URL(value)
  if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||
    (url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw failure()
  return url.href.replace(/\/+$/,'')
}

async function boundedBody(response:Response,limit:number,signal?:AbortSignal):Promise<Buffer> {
  // A transport can deliver headers after cancellation. No reader exists yet,
  // so release that late body explicitly without replacing AbortError.
  if(signal?.aborted){void response.body?.cancel().catch(()=>{});throw aborted()}
  const length=response.headers.get('content-length')
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit)) {
    void response.body?.cancel().catch(()=>{})
    throw failure()
  }
  if(!response.body)throw failure()
  const reader=response.body.getReader(),chunks:Uint8Array[]=[]
  let bytes=0,rejectAbort!:(error:DOMException)=>void
  const stopped=new Promise<never>((_,reject)=>{rejectAbort=reject})
  void stopped.catch(()=>{})
  const cancel=()=>{rejectAbort(aborted());void reader.cancel().catch(()=>{})}
  signal?.addEventListener('abort',cancel,{once:true})
  if(signal?.aborted)cancel()
  try {
    for(;;) {
      const next=await Promise.race([reader.read(),stopped])
      checkAbort(signal)
      if(next.done)break
      bytes+=next.value.byteLength
      if(bytes>limit)throw failure()
      chunks.push(next.value)
    }
    if(length!==null&&Number(length)!==bytes)throw failure()
    return Buffer.concat(chunks,bytes)
  } finally {
    signal?.removeEventListener('abort',cancel)
    void reader.cancel().catch(()=>{})
    try{reader.releaseLock()}catch{/* 已取消的 pending read 正在释放。 */}
  }
}

function metadataOnly(value:unknown,depth=0):void {
  if(depth>24)throw failure()
  if(Array.isArray(value)){for(const child of value)metadataOnly(child,depth+1)}
  else if(record(value)) {
    if(Object.hasOwn(value,'rows')||Object.hasOwn(value,'preview'))throw failure()
    for(const child of Object.values(value))metadataOnly(child,depth+1)
  }
}

/** 与 PR #132 createQuerySnapshot 的证据格式一致：固定字段顺序，行按
 * schema 逐列重建，保留行序、单位、时区和截断标记，排除 sha256 本身。
 * 不把 JSON 原始字节摘要误作快照摘要，也不信任远端自报的 sha256。 */
function verifiedSnapshot(bytes:Buffer,expected:string):void {
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
  const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v)
  if(!record(value)||Object.keys(value).some(key=>!['version','sourceId','sourceVersion','schema','timezone','rows','truncated','sha256'].includes(key))||
    value.version!==1||!text(value.sourceId,200)||!Number.isSafeInteger(value.sourceVersion)||(value.sourceVersion as number)<1||
    !text(value.timezone,100)||typeof value.truncated!=='boolean'||!sha(value.sha256)||value.sha256!==expected||
    !Array.isArray(value.schema)||value.schema.length<1||value.schema.length>256||!Array.isArray(value.rows)||value.rows.length>10_000)throw failure()
  new Intl.DateTimeFormat('en',{timeZone:value.timezone})
  const names=new Set<string>()
  const schema=value.schema.map(column=>{
    if(!record(column)||Object.keys(column).some(key=>!['name','type','unit'].includes(key))||!text(column.name,200)||names.has(column.name)||
      !['string','number','boolean'].includes(column.type as string)||(column.unit!==undefined&&!text(column.unit,100)))throw failure()
    names.add(column.name)
    return {name:column.name,type:column.type,...(column.unit===undefined?{}:{unit:column.unit})}
  })
  const rows=value.rows.map(raw=>{
    if(!record(raw)||Object.keys(raw).length!==schema.length)throw failure()
    const row:Record<string,unknown>=Object.create(null)
    for(const column of schema) {
      if(!Object.hasOwn(raw,column.name))throw failure()
      const cell=raw[column.name]
      if(cell!==null&&(typeof cell!==column.type||(typeof cell==='number'&&(!Number.isFinite(cell)||Object.is(cell,-0)))))throw failure()
      row[column.name]=cell
    }
    return row
  })
  const evidence={version:1,sourceId:value.sourceId,sourceVersion:value.sourceVersion,schema,timezone:value.timezone,rows,truncated:value.truncated}
  if(hash(JSON.stringify(evidence))!==expected)throw failure()
}

/** 同一客户端供内置 helper 与外部 CLI 使用。Cookie、上游密钥及远端路径
 * 不进入协议；仅使用本任务短期凭据。此处不重查 SQL、不自动重试请求。 */
export function createHarnessDataClient(options:HarnessDataClientOptions) {
  const baseUrl=baseAddress(options.baseUrl),taskId=identifier(options.taskId)
  if(typeof options.credential!=='string'||! /^[\x21-\x7e]{1,2048}$/.test(options.credential))throw failure()
  const endpoint=baseUrl+'/tasks/'+taskId+'/data',fetchImpl=options.fetchImpl??fetch
  const headers={authorization:'Bearer '+options.credential}
  async function request(url:string,init:RequestInit,limit:number,signal?:AbortSignal) {
    checkAbort(signal)
    try {
      const response=await fetchImpl(url,{...init,redirect:'error',credentials:'omit',cache:'no-store',...(signal?{signal}:{})})
      if(!response.ok||response.redirected||(response.url&&new URL(response.url).href!==url)||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')) {
        void response.body?.cancel().catch(()=>{})
        throw failure()
      }
      return {response,bytes:await boundedBody(response,limit,signal)}
    } catch {
      if(signal?.aborted)throw aborted()
      throw failure()
    }
  }
  async function execute<T=unknown>(operation:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<T> {
    checkAbort(signal)
    if(typeof operation!=='string'||operation.length>100||!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3}$/.test(operation)||!record(args))throw failure()
    let body:string
    try{body=JSON.stringify({operation,arguments:args})}catch{throw failure()}
    if(Buffer.byteLength(body)>harnessDataRequestLimit(operation))throw failure()
    // Size the response against the actual wire arguments, including custom JSON serialization.
    const queryCount=operation==='execute_sql'?(sourceQueryBatchSize(operation,JSON.parse(body).arguments)??1):1
    const send=(active?:AbortSignal)=>request(endpoint+'/execute',{method:'POST',headers:{...headers,'content-type':'application/json'},body},queryCount*HARNESS_DATA_MAX_METADATA_BYTES,active)
    const {bytes}=await (operation==='execute_sql'?timedQuery(send,queryCount,signal):send(signal))
    try {
      const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
      if(!record(value))throw failure()
      metadataOnly(value)
      return value as T
    } catch {throw failure()}
  }
  return {
    execute,
    async receipt<T=unknown>(commandId:string,signal?:AbortSignal){return execute<T>('artifacts.get_receipt',{commandId:identifier(commandId)},signal)},
    async manifest<T=unknown>(resultId:string,signal?:AbortSignal){return execute<T>('results.get_manifest',{resultId:identifier(resultId)},signal)},
    async download(resultId:string,destination:string,signal?:AbortSignal):Promise<HarnessDataDownload> {
      checkAbort(signal);identifier(resultId)
      if(typeof destination!=='string'||!destination.trim()||destination.includes('\0'))throw failure()
      const target=resolve(destination)
      const {response,bytes}=await request(endpoint+'/results/'+resultId+'/content',{method:'GET',headers},SOURCE_RESULT_MAX_BYTES,signal)
      const raw=response.headers.get('x-content-sha256'),snapshot=response.headers.get('x-snapshot-sha256')
      if(!sha(raw)||!sha(snapshot)||hash(bytes)!==raw)throw failure()
      try{verifiedSnapshot(bytes,snapshot)}catch{throw failure()}
      checkAbort(signal)
      const temporary=join(dirname(target),'.'+basename(target)+'.'+randomBytes(12).toString('hex')+'.tmp')
      let created=false
      try {
        const file=await open(temporary,'wx',0o600);created=true
        try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}
        checkAbort(signal)
        // Node rename 会覆盖目标。link 在同一文件系统原子发布，目标已存在
        // 时以 EEXIST 失败，避免 check-then-rename 的竞争与数据覆盖。
        await link(temporary,target)
        return {destination:target,resultId,sha256:raw,snapshotSha256:snapshot,sizeBytes:bytes.length}
      } catch {
        if(signal?.aborted)throw aborted()
        throw failure()
      } finally {if(created)await unlink(temporary)}
    },
  }
}
