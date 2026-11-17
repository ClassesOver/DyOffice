import {createHash,randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import type {Pool} from 'pg'
import type {PrincipalTransactions} from '../db/context.ts'
import type {ObjectStore} from '../storage/object-store.ts'
import {createTestPdfInputPreparation} from './input-preparation.ts'
import {createTestPdfPreparedContextIssuer,createTestPdfPreparedContextReader} from './prepared-context.ts'
function fail():never{throw Object.assign(new Error('PDF_PACKAGE_DENIED'),{code:'PDF_PACKAGE_DENIED'})}
function record(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length)fail()
 const out:Record<string,unknown>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)fail();out[key]=d.value}return Object.freeze(out)
}
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function same(a:object,b:object){const left=a as Record<string,unknown>,right=b as Record<string,unknown>;if(Object.keys(left).length!==Object.keys(right).length||Object.keys(left).some(k=>left[k]!==right[k]))fail()}
/** Non-executable control-plane package. Never spawns/parses and never commits
 * output. Fixture output checks are correlation + current PG facts, not runtime
 * authentication, PDF structural validation, isolation or a save grant.
 */
export function createTestPdfPreparedPackage(options:{transactions:PrincipalTransactions;workerPool:Pool;issuerPool:Pool;objects:ObjectStore;deploymentId:string;schema:string;expectedArtifactDigest:string;unsafeTestOnly:true}){
 const enabled=options.unsafeTestOnly===true,artifact=options.expectedArtifactDigest
 const gate=()=>{if(process.env.NODE_ENV!=='test'||!enabled)fail()};gate()
 if(typeof artifact!=='string'||!/^[a-f0-9]{64}$/.test(artifact))fail()
 const input=createTestPdfInputPreparation({...options}),issuer=createTestPdfPreparedContextIssuer(options.issuerPool,{...options}),reader=createTestPdfPreparedContextReader(options.workerPool,{...options})
 return Object.freeze({async prepare(rawClaim:unknown,rawRegistry:unknown,{signal}:{signal?:AbortSignal}={}){
  gate();const claim=record(rawClaim,['jobId','epoch','token']),registry=record(rawRegistry,['scopeId','scopeVersion','runtimeId','runtimeVersion'])
  for(const value of [claim.jobId,registry.scopeId,registry.runtimeId])if(typeof value!=='string'||!uuid.test(value))fail()
  for(const value of [claim.epoch,registry.scopeVersion,registry.runtimeVersion])if(!Number.isSafeInteger(value)||(value as number)<1)fail()
  if(typeof claim.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(claim.token))fail()
  const jobToken=claim.token;let deadline=Infinity
  const check=()=>{gate();if(signal?.aborted||performance.now()>=deadline)fail()}
  const observe=async<T extends {remainingMs:number}>(call:()=>Promise<T>)=>{check();const start=performance.now(),value=await call();if(!Number.isSafeInteger(value.remainingMs)||value.remainingMs<=0)fail();deadline=Math.min(deadline,start+value.remainingMs);check();return value}
  try{
   const snapshot=await observe(()=>input.prepare(claim,{signal}))
   if(snapshot.facts.inputSize<1||snapshot.facts.inputSize>32*1024*1024)fail()
   const issued=await observe(()=>issuer.issue(claim,registry))
   same(snapshot.facts,issued.facts)
   if(snapshot.commandDigest!==issued.commandDigest||issued.runtimeDigest!==artifact)fail()
   const context=Object.freeze({...issued.context})
   const validate=(current:typeof issued)=>{
    same(issued.facts,current.facts);same(context,current.context)
    for(const key of ['commandDigest','requestHash','tenantId','runtimeDigest','runtimeEnvironment','scopeId','scopeVersion','runtimeId','runtimeVersion','kind'] as const)if(issued[key]!==current[key])fail()
   }
   validate(await observe(()=>reader.verify(context,jobToken)))
   const privateBytes=snapshot.copyBytes();if(privateBytes.length!==issued.facts.inputSize||sha(privateBytes)!==issued.facts.inputSha256)fail()
   const binding=Object.freeze({requestId:randomUUID(),contextId:context.id,contextVersion:context.version,jobId:issued.facts.jobId,jobEpoch:issued.facts.jobEpoch,attempt:issued.facts.attempt,fileId:issued.facts.fileId,baseRevision:issued.facts.baseRevision,leaseEpoch:issued.facts.leaseEpoch,inputSha256:issued.facts.inputSha256,inputSize:issued.facts.inputSize,commandDigest:issued.commandDigest})
   let state:'open'|'checking'|'accepted'|'failed'='open'
   check();const remainingMs=Math.floor(deadline-performance.now());if(remainingMs<=0)fail()
   return Object.freeze({scope:'pdf-nonexecutable-prepared-package' as const,context,binding,command:issued.command,remainingMs,
    copyInput(){check();if(state!=='open')fail();const bytes=Buffer.from(privateBytes);check();return bytes},
    async acceptFixtureOutput(raw:unknown){
     if(state!=='open')fail();state='checking' // Synchronously consume, before any await.
     try{
      check();const result=record(raw,['binding','bytes','sha256','size','fixtureOnly']),received=record(result.binding,Object.keys(binding));same(binding,received)
      if(result.fixtureOnly!==true||!Buffer.isBuffer(result.bytes)||result.bytes.length<1||result.bytes.length>32*1024*1024||result.size!==result.bytes.length||typeof result.sha256!=='string'||!/^[a-f0-9]{64}$/.test(result.sha256))fail()
      const bytes=Buffer.from(result.bytes),digest=result.sha256;if(sha(bytes)!==digest)fail();check()
      validate(await observe(()=>reader.verify(context,jobToken)));check()
      state='accepted';return Object.freeze({scope:'pdf-fixture-output-observation' as const,bytes,sha256:digest,size:bytes.length,context,binding,facts:issued.facts,commandDigest:issued.commandDigest})
     }catch{state='failed';fail()}
    }
   })
  }catch{fail()}
 }})
}
