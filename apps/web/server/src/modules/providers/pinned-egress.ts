import dns from 'node:dns/promises'
import https from 'node:https'
import {isIP} from 'node:net'
import {createHash} from 'node:crypto'
import {ASSISTANT_MAX_REQUEST_BYTES,PPTX_GENERATION_DEADLINE_MS} from '../../../../../../packages/web-contracts/src/assistant.ts'
import type {ClientRequest,IncomingMessage} from 'node:http'
import type {TLSSocket} from 'node:tls'
import {ProviderResponseFailure,providerResponseFailure} from './response-failure.ts'

export interface EgressProfile {
 deploymentId:string;entryId:string;revision:number;providerId:string;model:string;baseUrl:string;endpoint:string;allowedIpv4:readonly string[]
}
export interface EgressScope extends Omit<EgressProfile,'allowedIpv4'> {
 credential:Uint8Array;requestDigest:string;turnId:string;reservationId:string;claimId:string;signal:AbortSignal
}
const fail=()=>new Error('Provider transport unavailable')
const profileFields=['deploymentId','entryId','revision','providerId','model','baseUrl','endpoint'] as const
// IANA IPv4 special-purpose registry (RFC 6890 and successors): every block
// that is not globally routable, plus multicast and reserved space. Blocking
// whole first octets (all of 100/8, 169/8, 192/8, 198/8, 203/8) also rejected
// ordinary public provider addresses.
const NON_GLOBAL_IPV4:readonly (readonly [number,number])[]=[
 ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
 ['192.0.0.0',24],['192.0.2.0',24],['192.31.196.0',24],['192.52.193.0',24],['192.88.99.0',24],['192.168.0.0',16],
 ['192.175.48.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
].map(([base,bits])=>[ipv4Number(base as string),bits as number] as const)
function ipv4Number(address:string):number {
 return address.split('.').reduce((value,part)=>value*256+Number(part),0)
}
export function publicIpv4(address:string):boolean {
 if(isIP(address)!==4)return false
 const value=ipv4Number(address)
 return !NON_GLOBAL_IPV4.some(([base,bits])=>Math.floor(value/2**(32-bits))===Math.floor(base/2**(32-bits)))
}
function url(value:string):URL {
 const u=new URL(value)
 if(u.href!==value||u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash||isIP(u.hostname)||u.hostname.includes(':'))throw fail()
 return u
}
/**
 * Unmounted admin transport preparation. No credential authority or budget is
 * created here; compose ONLY behind #74's unique durable dispatch gate.
 * Look up IPv4 only; never connect to IPv6 or an unlisted IPv4 address.
 */
export function createPinnedProviderTransport({profiles,timeoutMs=30_000,maxConcurrent=8,maxResponseBytes=8*1024*1024,authorizationTimeoutMs=5000}:{
 profiles:readonly EgressProfile[];timeoutMs?:number;maxConcurrent?:number;maxResponseBytes?:number;authorizationTimeoutMs?:number
}) {
 let approved:Readonly<EgressProfile>[]
 try{
  if(!Array.isArray(profiles)||profiles.length>256||![timeoutMs,maxConcurrent,maxResponseBytes,authorizationTimeoutMs].every(Number.isSafeInteger)||authorizationTimeoutMs<1||authorizationTimeoutMs>5000||timeoutMs<1||timeoutMs>PPTX_GENERATION_DEADLINE_MS||maxConcurrent<1||maxConcurrent>64||maxResponseBytes<1||maxResponseBytes>32*1024*1024)throw fail()
  approved=profiles.map((p:EgressProfile)=>{
   if(!p||Object.keys(p).length!==8||Object.keys(p).some(k=>![...profileFields,'allowedIpv4'].includes(k as typeof profileFields[number]))||
      profileFields.some(k=>k==='revision'?!Number.isSafeInteger(p[k])||p[k]<0:typeof p[k]!=='string'||!p[k]||p[k].length>2048))throw fail()
   const endpoint=url(p.endpoint),base=url(p.baseUrl)
   if(endpoint.origin!==base.origin||!Array.isArray(p.allowedIpv4)||!p.allowedIpv4.length||p.allowedIpv4.length>64||p.allowedIpv4.some((a:string)=>!publicIpv4(a))||new Set(p.allowedIpv4).size!==p.allowedIpv4.length)throw fail()
   return Object.freeze({...p,allowedIpv4:Object.freeze([...p.allowedIpv4])})
  })
 }catch{throw fail()}
 let active=0
 async function sendAuthorized(scope:Omit<EgressScope,'credential'>,body:Uint8Array,authorize:(write:(credential:Uint8Array)=>Promise<void>,signal:AbortSignal)=>Promise<void>,onChunk:(chunk:Uint8Array)=>void|Promise<void>):Promise<void>{
   let wire:Buffer|undefined
   let request:ClientRequest|undefined,response:IncomingMessage|undefined
   let deadline:ReturnType<typeof setTimeout>|undefined
   let release=false,externalSignal:AbortSignal|undefined
   const pending=new Set<Promise<unknown>>(),control=new AbortController()
   const stop=()=>control.abort()
   let rejectStop:()=>void=()=>{}
   const stopped=new Promise<never>((_,reject)=>{rejectStop=()=>reject(fail())})
   void stopped.catch(()=>{})
   const abort=()=>{rejectStop();request?.destroy(fail());response?.destroy(fail())}
   control.signal.addEventListener('abort',abort,{once:true})
   const step=<T>(operation:()=>Promise<T>):Promise<T>=>{
    if(control.signal.aborted)return Promise.reject(fail())
    const work=Promise.resolve().then(()=>{if(control.signal.aborted)throw fail();return operation()})
    pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work))
    return Promise.race([work,stopped])
   }
   try{
    const suppliedSignal=scope?.signal
    if(!(suppliedSignal instanceof AbortSignal))throw fail()
    externalSignal=suppliedSignal
    if(!scope||![scope.reservationId,scope.claimId,scope.turnId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v))||!(body instanceof Uint8Array)||body.byteLength>ASSISTANT_MAX_REQUEST_BYTES||!body.byteLength||typeof onChunk!=='function'||typeof authorize!=='function'||externalSignal.aborted||active>=maxConcurrent)throw fail()
    // Only primitives/private snapshots survive the first await.
    const matches=approved.filter(p=>profileFields.every(k=>p[k]===scope[k]))
    if(matches.length!==1||!/^[a-f0-9]{64}$/.test(scope.requestDigest))throw fail()
    const profile=matches[0]!,target=url(profile.endpoint)
    wire=Buffer.from(body)
    if(createHash('sha256').update(wire).digest('hex')!==scope.requestDigest)throw fail()
    const text=new TextDecoder('utf-8',{fatal:true}).decode(wire),payload=JSON.parse(text)
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||JSON.stringify(payload)!==text||payload.model!==profile.model||payload.stream!==true)throw fail()
    active++;release=true
    externalSignal.addEventListener('abort',stop,{once:true})
    deadline=setTimeout(stop,timeoutMs)
    if(externalSignal.aborted)stop()
    const answers=await step(()=>dns.lookup(target.hostname,{family:4,all:true,verbatim:true}))
    if(!answers.length||answers.length>64||answers.some(a=>a.family!==4||!publicIpv4(a.address)||!profile.allowedIpv4.includes(a.address)))throw fail()
    const pinned=answers[0]!.address
    response=await step(()=>new Promise<IncomingMessage>((resolve,reject)=>{
     let finished=false,received:IncomingMessage|undefined,authorized=false
     let resolveFlush!:()=>void,rejectFlush!:()=>void
     const flushed=new Promise<void>((res,rej)=>{resolveFlush=res;rejectFlush=()=>rej(fail())})
     void flushed.catch(()=>{})
     const complete=()=>{if(finished&&received&&authorized)resolve(received)}
     const options:https.RequestOptions & {autoSelectFamily:boolean}={
      method:'POST',agent:false,family:4,autoSelectFamily:false,
      servername:target.hostname,rejectUnauthorized:true,maxHeaderSize:16*1024,
      lookup:(hostname,options,callback)=>{
       if(hostname!==target.hostname){(callback as Function)(fail());return}
       if(typeof options==='object'&&options?.all)(callback as Function)(null,[{address:pinned,family:4}])
       else (callback as Function)(null,pinned,4)
      },
      headers:{'content-type':'application/json','accept':'text/event-stream','content-length':wire!.length},
     }
     let verifiedSocket:TLSSocket|undefined
     const peerValid=()=>Boolean(verifiedSocket&&request?.socket===verifiedSocket&&!verifiedSocket.destroyed&&verifiedSocket.writable&&verifiedSocket.authorized&&verifiedSocket.remoteAddress===pinned&&verifiedSocket.remotePort===443)
     request=https.request(target,options,res=>{
      res.on('error',()=>{})
      if(control.signal.aborted||!verifiedSocket){res.destroy();reject(fail());return}
      response=res;received=res;complete()
     })
     request.once('finish',()=>{finished=true;resolveFlush();complete()})
     request.on('error',()=>{rejectFlush();reject(fail())})
     request.once('close',()=>{if(!finished){rejectFlush();reject(fail())}})
     request.once('socket',socket=>{
      const tls=socket as TLSSocket
      tls.once('secureConnect',()=>{
       verifiedSocket=tls
       if(control.signal.aborted||!peerValid()){request?.destroy(fail());reject(fail());return}
       let activeWriter=true,used=false,written=false
       const phaseDeadline=setTimeout(stop,authorizationTimeoutMs)
       const write=async(value:Uint8Array):Promise<void>=>{
        let key:Buffer|undefined
        try{
         if(!activeWriter||used||control.signal.aborted||!peerValid()||!(value instanceof Uint8Array)||value.byteLength<1||value.byteLength>8192)throw fail()
         used=true;key=Buffer.from(value)
         if(key.some(b=>b<33||b>126))throw fail()
         request!.setHeader('authorization','Bearer '+key.toString('ascii'))
         request!.end(wire)
         await Promise.race([flushed,stopped])
         if(control.signal.aborted)throw fail()
         written=true
        }catch{stop();throw fail()}
        finally{key?.fill(0)}
       }
       // The trusted authority callback may hold a short DB transaction only
       // across this single flush. Do not deliver early responses before commit.
       void step(async()=>{
        try{await authorize(write,control.signal);if(!written||control.signal.aborted)throw fail()}
        finally{activeWriter=false;clearTimeout(phaseDeadline)}
       }).then(()=>{authorized=true;complete()},()=>{activeWriter=false;clearTimeout(phaseDeadline);stop();reject(fail())})
      })
     })
    }))
    if(response.statusCode!==200)throw providerResponseFailure(response.statusCode)??fail()
    if(typeof response.headers['content-type']!=='string'||
       response.headers['content-type'].split(';',1)[0]!.trim().toLowerCase()!=='text/event-stream'||
       response.headers['content-encoding']!==undefined&&response.headers['content-encoding']!=='identity')throw fail()
    const iterator=response[Symbol.asyncIterator]()
    let received=0
    for(;;){
     const result=await step(()=>iterator.next())
     if(result.done)break
     if(!(result.value instanceof Uint8Array))throw fail()
     received+=result.value.byteLength
     if(received>maxResponseBytes)throw fail()
     const chunk=Buffer.from(result.value)
     await step(async()=>{await onChunk(chunk)})
    }
   }catch(error){throw error instanceof ProviderResponseFailure?error:fail()}
   finally{
    if(deadline)clearTimeout(deadline)
    externalSignal?.removeEventListener('abort',stop)
    control.abort();control.signal.removeEventListener('abort',abort)
    request?.destroy();response?.destroy()
    wire?.fill(0)
    // OS DNS and trusted callback work may ignore cancellation. Retain capacity
    // until actual work settles, not merely until the caller observes timeout.
    if(release){if(pending.size)void Promise.allSettled([...pending]).then(()=>{active--});else active--}
   }
  }
 return {
  activeCount:()=>active,
  sendAuthorized,
  /** Legacy explicit server-only entry. Pipeline must use sendAuthorized so
   * no credential transaction spans DNS/TLS or response streaming. */
  async send(scope:EgressScope,body:Uint8Array,onChunk:(chunk:Uint8Array)=>void|Promise<void>){
   let key:Buffer|undefined
   try{
    if(!(scope?.credential instanceof Uint8Array)||scope.credential.length<1||scope.credential.length>8192)throw fail()
    key=Buffer.from(scope.credential)
    if(key.some(b=>b<33||b>126))throw fail()
    await sendAuthorized(scope,body,write=>write(key!),onChunk)
   }catch{throw fail()}
   finally{key?.fill(0)}
  },
 }
}
