import {performance} from 'node:perf_hooks'
import type {Pool} from 'pg'
import type {PrincipalTransactions} from '../db/context.ts'
import {createLeaseService} from '../modules/leases/service.ts'
import {createTestPdfClaimReader} from './command-claim.ts'
import {createTestNativeAuthorityVerifier,validateNativeExecutionFacts} from '../../../worker/src/sandbox/document-native-authority-pg.ts'
function fail():never{throw Object.assign(new Error('PDF_LEASE_DENIED'),{code:'PDF_LEASE_DENIED'})}
function capture(raw:unknown){
 if(!raw||typeof raw!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(raw))||Reflect.ownKeys(raw).length!==3)fail()
 const out:Record<string,unknown>={}
 for(const key of ['jobId','epoch','token']){const d=Object.getOwnPropertyDescriptor(raw,key);if(!d||!('value'in d)||!d.enumerable)fail();out[key]=d.value}
 if(typeof out.jobId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(out.jobId)||!Number.isSafeInteger(out.epoch)||(out.epoch as number)<1||typeof out.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(out.token))fail()
 return Object.freeze({jobId:out.jobId,epoch:out.epoch as number,token:out.token})
}
/** Test-only trusted controller: worker pool only observes claims/authority;
 * business transactions acquire the real job-bound edit lease. No native runtime
 * is started. Multiple transactions narrow races, never form an execution grant.
 * Failure never auto-releases: same-claim callers can share an epoch, and an
 * unknown acquisition response cannot safely identify a cleanup lease.
 */
export function createTestPdfLeaseController({transactions,workerPool,deploymentId,schema,leaseTtlMs=45000,unsafeTestOnly}:{transactions:PrincipalTransactions;workerPool:Pool;deploymentId:string;schema:string;leaseTtlMs?:number;unsafeTestOnly:true}){
 const gate=()=>{if(process.env.NODE_ENV!=='test'||unsafeTestOnly!==true)fail()};gate()
 const reader=createTestPdfClaimReader({pool:workerPool,deploymentId,unsafeTestOnly:true})
 const leases=createLeaseService({transactions,ttlMs:leaseTtlMs})
 const verifier=createTestNativeAuthorityVerifier(workerPool,{schema,unsafeTestOnly:true})
 return Object.freeze({async prepare(raw:unknown){
  gate();const claim=capture(raw),credential=Object.freeze({kind:'job' as const,...claim})
  let deadline=Infinity
  const observe=async<T extends {remainingMs:number}>(call:()=>Promise<T>)=>{
   gate();if(performance.now()>=deadline)fail()
   const start=performance.now(),value=await call();gate()
   if(!Number.isFinite(value.remainingMs)||value.remainingMs<=0)fail()
   // Conservative: adapters already subtract their own round trips. Anchoring
   // at call start cannot extend any prior observation, even after renewal.
   deadline=Math.min(deadline,start+value.remainingMs)
   if(performance.now()>=deadline)fail();return value
  }
  try{
   const initial=await observe(()=>reader.read(claim))
   const lease=await leases.acquireLease(credential,initial.facts.fileId as string,{editorId:claim.jobId});gate()
   if(performance.now()>=deadline||lease.editorId!==claim.jobId||!Number.isSafeInteger(lease.leaseEpoch)||lease.leaseEpoch<1)fail()
   const expected=validateNativeExecutionFacts({...initial.facts,editorId:claim.jobId,leaseEpoch:lease.leaseEpoch,jobType:'pdf.rotate'})
   await observe(()=>verifier.verify(expected,claim.token))
   const current=await observe(()=>reader.read(claim))
   if(current.digest!==initial.digest||Object.keys(initial.facts).some(key=>initial.facts[key]!==current.facts[key]))fail()
   const final=await observe(()=>verifier.verify(expected,claim.token))
   gate();const remainingMs=Math.floor(deadline-performance.now());if(remainingMs<=0)fail()
   return Object.freeze({scope:'pdf-edit-lease-observation' as const,command:current.command,commandDigest:current.digest,facts:final.facts,observedAt:final.observedAt,remainingMs})
  }catch{fail()}
 }})
}
