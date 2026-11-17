import {performance} from 'node:perf_hooks'
import {createHash,randomUUID} from 'node:crypto'
import {DocumentContractError} from './document-profiles.ts'
import {validateDocumentExecutionRequest,type DocumentExecutionRequest} from './document-contract.ts'
import {createPendingOutlineReply,validateExecutionHandle,validateProfileCommand,validateStopObservation,type ExecutionHandle,type OutlineReply} from './document-control.ts'
import type {DocumentExecutionPorts,Reservation} from './document-execution-ports.ts'
const failure=(code:string)=>new DocumentContractError(code)
/** Production factory deliberately has no enabling option or injectable backend. */
export function createDocumentExecutionBoundary(){return Object.freeze({async run(_request:unknown,_input:Uint8Array):Promise<never>{throw failure('DOCUMENT_BOUNDARY_UNAVAILABLE')}})}
/** Test-only coordinator. It never certifies a fake backend or changes production profiles. */
export function createTestDocumentExecutionBoundary(ports:DocumentExecutionPorts,options:{unsafeTestOnly:true;operationTimeoutMs?:number;cleanupTimeoutMs?:number}) {
 if(process.env.NODE_ENV!=='test'||options?.unsafeTestOnly!==true)throw failure('DOCUMENT_BOUNDARY_UNAVAILABLE')
 const seenAttempts=new Set<string>()
 const operationMs=options.operationTimeoutMs??1000,cleanupMs=options.cleanupTimeoutMs??1000
 for(const n of [operationMs,cleanupMs])if(!Number.isSafeInteger(n)||n<1||n>5000)throw failure('INVALID_BOUNDARY_TIMEOUT')
 function bounded<T>(task:()=>Promise<T>,ms:number,signal?:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
   let done=false
   const finish=(ok:boolean,value:unknown)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(ok)resolve(value as T);else reject(value)}
   const abort=()=>finish(false,failure('DOCUMENT_ABORTED'))
   const timer=setTimeout(()=>finish(false,failure('DOCUMENT_OPERATION_TIMEOUT')),ms)
   signal?.addEventListener('abort',abort,{once:true})
   if(signal?.aborted){abort();return}
   // Late completion is observed but NEVER treated as proof of process termination.
   Promise.resolve().then(()=>{if(done||signal?.aborted)return;return task()}).then(value=>finish(true,value),error=>finish(false,error))
  })
 }
 return Object.freeze({async run(raw:unknown,input:Uint8Array,{signal}:{signal?:AbortSignal}={}):Promise<OutlineReply>{
  if(process.env.NODE_ENV!=='test')throw failure('DOCUMENT_BOUNDARY_UNAVAILABLE')
  const request=validateDocumentExecutionRequest(raw,new Date())
  if(request.profileId!=='pptx-edit-v1')throw failure('DOCUMENT_COMMAND_UNSUPPORTED')
  if(!(input instanceof Uint8Array)||input.byteLength!==request.inputSize)throw failure('DOCUMENT_INPUT_MISMATCH')
  const bytes=Uint8Array.from(input)
  if(createHash('sha256').update(bytes).digest('hex')!==request.inputSha256)throw failure('DOCUMENT_INPUT_MISMATCH')
  const attemptKey=`${request.deploymentId}/${request.jobId}/${request.attempt}/${request.jobEpoch}`
  if(seenAttempts.has(attemptKey))throw failure('DOCUMENT_ATTEMPT_DUPLICATE')
  if(seenAttempts.size>=1024)throw failure('DOCUMENT_BOUNDARY_CAPACITY')
  seenAttempts.add(attemptKey)
  const controller=new AbortController(),abort=()=>controller.abort()
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
  let authorityUntil=Date.parse(request.deadlineAt)
  let authorityDeadlineMono=performance.now()+Math.max(0,authorityUntil-Date.now())
  const businessDeadline=Math.min(authorityDeadlineMono,performance.now()+operationMs)
  const deadline=setTimeout(abort,Math.max(0,authorityUntil-Date.now()))
  const reservation:Reservation=Object.freeze({reservationId:attemptKey,jobId:request.jobId,attempt:request.attempt,jobEpoch:request.jobEpoch})
  let reserveAttempted=false,reserved=false,startAttempted=false,handle:ExecutionHandle|undefined,result:OutlineReply|undefined,error:unknown,ledgerFault=false
  const check=()=>{if(controller.signal.aborted)throw failure('DOCUMENT_ABORTED');if(Date.now()>=authorityUntil||performance.now()>=Math.min(authorityDeadlineMono,businessDeadline))throw failure('DOCUMENT_AUTHORITY_EXPIRED')}
  const work=<T>(task:()=>Promise<T>)=>{check();return bounded(()=>{check();return task()},Math.max(1,Math.min(authorityDeadlineMono,businessDeadline)-performance.now()),controller.signal)}
  const verify=async(phase:'pre'|'before_start'|'post'|'return')=>{
   check()
   const verifyStarted=performance.now()
   const proof=await work(()=>ports.authority.verify(request,phase,controller.signal))
   const confirmed=validateDocumentExecutionRequest(proof.request,new Date())
   for(const key of Object.keys(request) as (keyof DocumentExecutionRequest)[])if(confirmed[key]!==request[key])throw failure('DOCUMENT_AUTHORITY_CHANGED')
   if(!Number.isFinite(proof.validForMs)||proof.validForMs<=0)throw failure('DOCUMENT_AUTHORITY_EXPIRED')
   const expiry=Date.parse(proof.validUntil)
   if(!Number.isFinite(expiry)||new Date(expiry).toISOString()!==proof.validUntil||expiry<=Date.now())throw failure('DOCUMENT_AUTHORITY_EXPIRED')
   authorityUntil=Math.min(expiry,Date.parse(request.deadlineAt));authorityDeadlineMono=Math.min(authorityDeadlineMono,verifyStarted+proof.validForMs,performance.now()+Math.max(0,authorityUntil-Date.now()));check()
  }
  let cleanupDeadline=Infinity
  const clean=<T>(task:()=>Promise<T>)=>bounded(task,Math.max(1,cleanupDeadline-performance.now()))
  const ack=(value:unknown)=>{if(value!==undefined)throw failure('DOCUMENT_LEDGER_PROTOCOL')}
  const retain=async()=>{try{ack(await clean(()=>ports.reservations.retain(reservation,'EXECUTION_UNCERTAIN')))}catch{throw failure('DOCUMENT_LEDGER_UNAVAILABLE')}}
  try{
   await verify('pre');check();reserveAttempted=true
   const grant=await work(()=>ports.reservations.reserve(reservation,request))
   if(!grant||typeof grant!=='object'||Object.keys(grant).sort().join(',')!=='granted,reservationId'||grant.granted!==true||grant.reservationId!==attemptKey)throw failure('DOCUMENT_RESERVATION_DENIED')
   reserved=true
   await verify('before_start');check();startAttempted=true
   ack(await work(()=>ports.reservations.startIntent(reservation)))
   const candidate=validateExecutionHandle(await work(()=>ports.backend.start(request,bytes,controller.signal)))
   for(const key of ['deploymentId','jobId','attempt','jobEpoch','runtimeDigest','profileId'] as const)if(candidate[key]!==request[key])throw failure('DOCUMENT_INSTANCE_MISMATCH')
   // Never call stop with an untrusted/mismatched candidate.
   handle=candidate
   try{ack(await work(()=>ports.reservations.bind(reservation,candidate)))}catch(e){ledgerFault=true;throw e}
   check()
   const context=Object.freeze({handle:candidate,requestId:randomUUID(),command:'outline' as const,generation:request.generation})
   const gate=createPendingOutlineReply(context,new Date(Math.min(authorityUntil,Date.parse(request.deadlineAt))))
   const command=validateProfileCommand({profileId:'pptx-edit-v1',command:'outline',args:{expected:request.generation}})
   const reply=await work(()=>ports.backend.execute(candidate,command,context,controller.signal))
   check();result=gate.accept(reply,new Date());await verify('post')
  }catch(e){error=e??failure('DOCUMENT_EXECUTION_FAILED');controller.abort()}
  cleanupDeadline=performance.now()+cleanupMs
  try{
   if(reserveAttempted){
    if(!reserved){await retain();throw failure('DOCUMENT_RESERVATION_UNCERTAIN')}
    if(!startAttempted){try{ack(await clean(()=>ports.reservations.release(reservation,{notStarted:true})))}catch{await retain();throw failure('DOCUMENT_LEDGER_UNAVAILABLE')}}
    else if(!handle){await retain();throw failure('DOCUMENT_INSTANCE_UNKNOWN')}
    else{
     let stopped
     try{stopped=validateStopObservation(await clean(()=>ports.backend.stop(handle!)),handle);if(!stopped.confirmed)throw failure('DOCUMENT_STOP_UNKNOWN')}
     catch{await retain();throw failure('DOCUMENT_STOP_UNKNOWN')}
     if(ledgerFault){await retain();throw failure('DOCUMENT_LEDGER_UNAVAILABLE')}
     try{ack(await clean(()=>ports.reservations.release(reservation,{stop:stopped})))}catch{await retain();throw failure('DOCUMENT_LEDGER_UNAVAILABLE')}
    }
   }
   if(error)throw error
   await verify('return')
   if(!result)throw failure('DOCUMENT_EXECUTION_FAILED')
   check() // No await may separate the final cancellation/expiry check from return.
   return result
  }catch(e){const rejected=failure(e instanceof DocumentContractError?e.code:'DOCUMENT_EXECUTION_FAILED');if(reserveAttempted)Object.assign(rejected,{reservationKey:reservation.reservationId});throw rejected}
  finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort)}
 }})
}
