import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import type {DocumentExecutionPorts} from './document-execution-ports.ts'
import {validateDocumentExecutionRequest} from './document-contract.ts'
import {DocumentContractError} from './document-profiles.ts'
const failure=(code:string)=>new DocumentContractError(code)
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export function createBrokerAdmissionBackend():DocumentExecutionPorts['backend']{
 const deny=async()=>{throw failure('DOCUMENT_BROKER_UNAVAILABLE')}
 return Object.freeze({start:deny,execute:deny,stop:deny})
}
/** Closed test composition: only two fixed repository build artifacts. Never a
 * production socket authenticator or proof that a document process stopped. */
export function createTestBrokerAdmissionBackend(options:{unsafeTestOnly:true;context:{id:string;version:number};brokerBootId:string;fixture?:'socketpair-denial'|'default-disabled'|'stall'|'stdout-flood'|'stderr-flood'|'partial'|'early-close'}):DocumentExecutionPorts['backend']{
 const enabled=options?.unsafeTestOnly===true
 const gate=()=>{if(!enabled||process.env.NODE_ENV!=='test')throw failure('DOCUMENT_BROKER_UNAVAILABLE')};gate()
 const context=Object.freeze({id:options.context.id,version:options.context.version}),boot=options.brokerBootId,fixture=options.fixture??'socketpair-denial'
 if(!uuid.test(context.id)||!Number.isSafeInteger(context.version)||context.version<1||!uuid.test(boot)||!['socketpair-denial','default-disabled','stall','stdout-flood','stderr-flood','partial','early-close'].includes(fixture))throw failure('DOCUMENT_BROKER_UNAVAILABLE')
 const artifact=fileURLToPath(new URL(fixture!=='default-disabled'?'../../../../../services/document-broker/target/debug/examples/admission-fixture':'../../../../../services/document-broker/target/debug/dyoffice-document-broker',import.meta.url))
 const unavailable=async()=>{gate();throw failure('DOCUMENT_BROKER_UNCERTAIN')}
 return Object.freeze({execute:unavailable,stop:unavailable,async start(raw,_input,signal):Promise<never>{
  gate();if(signal.aborted)throw failure('DOCUMENT_BROKER_UNCERTAIN')
  const request=validateDocumentExecutionRequest(raw,new Date()),requestId=randomUUID()
  const frame=Buffer.from(JSON.stringify({protocolVersion:1,requestId,brokerBootId:boot,context,operation:'start',request}))
  if(frame.length>65536)throw failure('DOCUMENT_BROKER_UNCERTAIN')
  return new Promise<never>((_resolve,reject)=>{
   const child=spawn(artifact,[],{shell:false,env:fixture!=='default-disabled'?{DOCUMENT_BROKER_TEST_HARNESS:'1',...(fixture==='socketpair-denial'?{}:{DOCUMENT_BROKER_TEST_FAULT:fixture})}:{},stdio:['pipe','pipe','pipe']})
   let done=false,size=0,stderr=0;const chunks:Buffer[]=[]
   const finish=(code:string)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();if(child.exitCode===null)child.kill('SIGKILL');reject(failure(code))}
   const abort=()=>finish('DOCUMENT_BROKER_UNCERTAIN')
   const timer=setTimeout(abort,1500);signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return}
   child.on('error',abort);child.stdin.on('error',abort)
   child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>1024)abort();else chunks.push(Buffer.from(b))})
   child.stderr.on('data',(b:Buffer)=>{stderr+=b.length;if(stderr>1024)abort()})
   child.on('close',code=>{
    if(done)return
    if(code!==0){abort();return}
    try{
     validateBrokerDenial(Buffer.concat(chunks),{requestId,brokerBootId:boot})
     finish('DOCUMENT_BROKER_DISABLED')
    }catch{abort()}
   })
   child.stdin.end(frame)
  })
 }})
}

/** Shape and request correlation only, NOT broker authentication or stop evidence. */
export function validateBrokerDenial(bytes:Uint8Array,expected:{requestId:string;brokerBootId:string}):void{
 try{
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>1024)throw Error()
  const text=new TextDecoder('utf8',{fatal:true}).decode(bytes),r=JSON.parse(text)
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='brokerBootId,protocolVersion,reason,requestId,status'||r.protocolVersion!==1||r.requestId!==expected.requestId||r.brokerBootId!==expected.brokerBootId||r.status!=='disabled'||r.reason!=='REAL_BACKEND_UNAVAILABLE'||JSON.stringify(r)!==text)throw Error()
 }catch{throw failure('DOCUMENT_BROKER_UNCERTAIN')}
}
