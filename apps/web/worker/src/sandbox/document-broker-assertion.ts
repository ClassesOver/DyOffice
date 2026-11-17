import {createHash,createPublicKey,verify} from 'node:crypto'
import {validateExecutionHandle,type ExecutionHandle} from './document-control.ts'
import {DocumentContractError} from './document-profiles.ts'
const PREFIX=Buffer.from('DYOFFICE_BROKER_ASSERTION_V1\0','ascii')
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function bad():never{throw new DocumentContractError('DOCUMENT_BROKER_ASSERTION_DENIED')}
export interface BrokerAssertion {
 protocolVersion:1;kind:'test-only-broker-assertion';challengeId:string;nonce:string;
 keyId:string;keyVersion:number;claimId:string;reservationId:string;reservationVersion:number;
 expiresAt:string;handle:ExecutionHandle;reportedState:'stopped'|'unknown'
}
function snapshot(raw:unknown):BrokerAssertion{
 const keys=['protocolVersion','kind','challengeId','nonce','keyId','keyVersion','claimId','reservationId','reservationVersion','expiresAt','handle','reportedState'] as const
 if(!raw||typeof raw!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(raw))||Reflect.ownKeys(raw).length!==keys.length)bad()
 const o:Record<string,unknown>={}
 for(const k of keys){const d=Object.getOwnPropertyDescriptor(raw,k);if(!d||!('value'in d)||!d.enumerable)bad();o[k]=d.value}
 if(o.protocolVersion!==1||o.kind!=='test-only-broker-assertion'||!['stopped','unknown'].includes(o.reportedState as string))bad()
 for(const k of ['challengeId','keyId','claimId'])if(typeof o[k]!=='string'||!uuid.test(o[k] as string))bad()
 for(const k of ['keyVersion','reservationVersion'])if(!Number.isSafeInteger(o[k])||(o[k] as number)<1)bad()
 if(typeof o.nonce!=='string'||!/^[a-f0-9]{64}$/.test(o.nonce)||typeof o.reservationId!=='string'||o.reservationId.length>180)bad()
 if(typeof o.expiresAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(o.expiresAt)||!Number.isFinite(Date.parse(o.expiresAt))||new Date(o.expiresAt).toISOString()!==o.expiresAt)bad()
 const h=validateExecutionHandle(o.handle)
 if(o.reservationId!==`${h.deploymentId}/${h.jobId}/${h.attempt}/${h.jobEpoch}`)bad()
 o.handle=h
 return Object.freeze(o) as unknown as BrokerAssertion
}
export function brokerAssertionSigningBytes(raw:unknown):Buffer{
 return Buffer.concat([PREFIX,Buffer.from(JSON.stringify(snapshot(raw)),'utf8')])
}
export function encodeBrokerAssertion(raw:unknown,signature:Uint8Array):Buffer{
 if(!(signature instanceof Uint8Array)||signature.byteLength!==64)bad()
 return Buffer.from(JSON.stringify([snapshot(raw),Buffer.from(signature).toString('base64')]),'utf8')
}
export function decodeBrokerAssertion(raw:Uint8Array){
 if(!(raw instanceof Uint8Array)||raw.byteLength<1||raw.byteLength>4096)bad()
 const bytes=Buffer.from(raw)
 let parsed:unknown
 try{parsed=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes))}catch{bad()}
 if(!Array.isArray(parsed)||parsed.length!==2||typeof parsed[1]!=='string'||parsed[1].length!==88)bad()
 const body=snapshot(parsed[0]),signature=Buffer.from(parsed[1],'base64')
 if(signature.length!==64||signature.toString('base64')!==parsed[1]||!encodeBrokerAssertion(body,signature).equals(bytes))bad()
 return Object.freeze({body,signature,digest:createHash('sha256').update(bytes).digest('hex')})
}
export function verifyBrokerAssertion(publicKey:Uint8Array,body:BrokerAssertion,signature:Uint8Array):void{
 if(!(publicKey instanceof Uint8Array)||publicKey.byteLength!==44||signature.byteLength!==64)bad()
 try{
  const der=Buffer.from(publicKey),key=createPublicKey({key:der,format:'der',type:'spki'})
  if(key.asymmetricKeyType!=='ed25519'||!key.export({format:'der',type:'spki'}).equals(der)||!verify(null,brokerAssertionSigningBytes(body),key,signature))bad()
 }catch{bad()}
}
