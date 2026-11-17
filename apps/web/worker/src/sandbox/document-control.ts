import {validateXlsxCloseValue,validateXlsxCloseFrame,type XlsxCloseValue} from './xlsx-close-schema.ts'
import {validatePptxOutline,type PptxOutline} from './pptx-outline-schema.ts'
import { DocumentContractError, getDocumentProfile, type ProfileId } from './document-profiles.ts'
import type { DocumentExecutionRequest } from './document-contract.ts'

export interface ExecutionHandle {
  readonly deploymentId: string; readonly jobId: string; readonly attempt: number; readonly jobEpoch: number
  readonly brokerBootId: string; readonly backendInstanceId: string; readonly invocationId: string
  readonly runtimeDigest: string; readonly profileId: ProfileId
}
/** Only source-backed PPTX outline and XLSX session-close commands have complete schemas. */
export type ProfileCommand = {readonly profileId:'pptx-edit-v1';readonly command:'outline';readonly args:Readonly<{expected:number}>} | {readonly profileId:'xlsx-edit-v1';readonly command:'close';readonly args:Readonly<Record<string,never>>}
export interface ResultContext { readonly handle:ExecutionHandle; readonly requestId:string; readonly command:'export'|'outline'|'close'; readonly generation:number; readonly engineSessionId?:string }
export interface ArtifactResult extends ResultContext {
  readonly kind:'artifact'; readonly command:'export'; readonly outputHandle:string; readonly sha256:string; readonly size:number
}
export interface OutlineReply extends ResultContext {readonly kind:'reply';readonly command:'outline';readonly value:PptxOutline}
export interface XlsxCloseReply extends ResultContext {readonly kind:'reply';readonly command:'close';readonly engineSessionId:string;readonly value:XlsxCloseValue}
export type CommandResult = ArtifactResult | OutlineReply | XlsxCloseReply
export interface StopObservation { readonly handle:ExecutionHandle; readonly confirmed:boolean; readonly reason:string }
export interface InstanceObservation { readonly handle: ExecutionHandle; readonly state: 'starting' | 'running' | 'stopped' | 'unknown' }
/** Trusted worker constructs this only AFTER PG epoch/ownership verification. Broker has no PG credential. */
export interface AdoptionRequest { readonly previous: ExecutionHandle; readonly expectedInvocationId: string; readonly validUntil: string }
export interface SandboxBackend {
  start(request: DocumentExecutionRequest, input: Uint8Array): Promise<ExecutionHandle>
  execute(handle: ExecutionHandle, command: ProfileCommand): Promise<CommandResult>
  stop(handle: ExecutionHandle): Promise<StopObservation>
  inspect(handle: ExecutionHandle): Promise<InstanceObservation>
  renew(handle: ExecutionHandle, expectedEpoch: number, validUntil: string): Promise<ExecutionHandle>
  readArtifact(handle: ExecutionHandle, outputHandle: string): AsyncIterable<Uint8Array>
  releaseArtifact(handle: ExecutionHandle, outputHandle: string): Promise<void>
  adopt(request: AdoptionRequest): Promise<ExecutionHandle>
}
export interface DocumentAdapter {
  open(request: DocumentExecutionRequest, input: Uint8Array): Promise<ExecutionHandle>
  command(handle: ExecutionHandle, command: ProfileCommand): Promise<CommandResult>
  close(handle: ExecutionHandle): Promise<StopObservation>
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const HASH=/^[a-f0-9]{64}$/
function bad():never { throw new DocumentContractError('INVALID_DOCUMENT_CONTROL') }
function record(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad()
  const names=Reflect.ownKeys(value)
  if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)))bad()
  const copy:Record<string,unknown>=Object.create(null)
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value' in d)||!d.enumerable)bad();copy[key]=d.value}
  return copy
}
function identifier(value:unknown):string { if(typeof value!=='string'||!UUID.test(value))bad();return value.toLowerCase() }
function integer(value:unknown,min:number):number {if(!Number.isSafeInteger(value)||(value as number)<min)bad();return value as number}
export function validateExecutionHandle(value:unknown):ExecutionHandle {
  const v=record(value,['deploymentId','jobId','attempt','jobEpoch','brokerBootId','backendInstanceId','invocationId','runtimeDigest','profileId'])
  for(const key of ['deploymentId','jobId','brokerBootId','backendInstanceId'])v[key]=identifier(v[key])
  v.invocationId=invocation(v.invocationId)
  integer(v.attempt,1);integer(v.jobEpoch,1)
  if(typeof v.runtimeDigest!=='string'||!HASH.test(v.runtimeDigest))bad()
  getDocumentProfile(v.profileId)
  return Object.freeze({...v}) as unknown as ExecutionHandle
}
function invocation(value:unknown):string {if(typeof value!=='string'||! /^[a-f0-9]{32}$/.test(value))bad();return value}
function sameHandle(value:unknown,expected:ExecutionHandle):ExecutionHandle {
  const actual=validateExecutionHandle(value),trusted=validateExecutionHandle(expected)
  for(const key of Object.keys(trusted) as (keyof ExecutionHandle)[])if(actual[key]!==trusted[key])bad()
  return actual
}
/** Schema admission only; this does not start a runtime or authorize a document. */
export function validateProfileCommand(value:unknown):ProfileCommand {
 const v=record(value,['profileId','command','args'])
 if(v.profileId==='xlsx-edit-v1'&&v.command==='close'){record(v.args,[]);return Object.freeze({profileId:'xlsx-edit-v1',command:'close',args:Object.freeze({})})}
 if(v.profileId!=='pptx-edit-v1'||v.command!=='outline')throw new DocumentContractError('DOCUMENT_COMMAND_UNSUPPORTED')
 const args=record(v.args,['expected'])
 return Object.freeze({profileId:'pptx-edit-v1',command:'outline',args:Object.freeze({expected:integer(args.expected,0)})})
}
/** This validates a sealed artifact ENVELOPE only, not bytes, provenance or commit authority.
 * expected comes from trusted pending-request state, never from the response itself.
 * Sequence/replay consumption must be atomic in the future session implementation.
 */
export function validateArtifactEnvelope(value:unknown,expected:ResultContext):ArtifactResult {
  const v=record(value,['kind','handle','requestId','command','outputHandle','sha256','size','generation'])
  const context=record(expected,['handle','requestId','command','generation'])
  const handle=sameHandle(v.handle,context.handle as ExecutionHandle)
  const requestId=identifier(v.requestId),generation=integer(v.generation,0),size=integer(v.size,1)
  if(v.kind!=='artifact'||v.command!=='export'||context.command!=='export'||requestId!==identifier(context.requestId)||generation!==integer(context.generation,0))bad()
  if(size>getDocumentProfile(handle.profileId).outputBytes||typeof v.sha256!=='string'||!HASH.test(v.sha256))bad()
  return Object.freeze({kind:'artifact',handle,requestId,command:'export',generation,outputHandle:identifier(v.outputHandle),sha256:v.sha256,size})
}
/** Expected is trusted outstanding-request state; schema checks do not consume replay state. */
export function validateCommandResult(value:unknown,expected:ResultContext):CommandResult {
 const discriminator=Object.getOwnPropertyDescriptor(expected,'command')
 const closing=discriminator&&'value'in discriminator&&discriminator.value==='close'
 const context=record(expected,closing?['handle','requestId','command','generation','engineSessionId']:['handle','requestId','command','generation'])
 const trusted=validateExecutionHandle(context.handle)
 if(closing){
  if(trusted.profileId!=='xlsx-edit-v1')throw new DocumentContractError('DOCUMENT_COMMAND_UNSUPPORTED')
  const v=record(value,['kind','handle','requestId','command','generation','engineSessionId','value'])
  const handle=sameHandle(v.handle,trusted),requestId=identifier(v.requestId),generation=integer(v.generation,0),engineSessionId=identifier(v.engineSessionId)
  if(v.kind!=='reply'||v.command!=='close'||requestId!==identifier(context.requestId)||generation!==integer(context.generation,0)||engineSessionId!==identifier(context.engineSessionId))bad()
  return Object.freeze({kind:'reply',handle,requestId,command:'close',generation,engineSessionId,value:validateXlsxCloseValue(v.value)})
 }
 if(context.command!=='outline'||trusted.profileId!=='pptx-edit-v1')throw new DocumentContractError('DOCUMENT_COMMAND_UNSUPPORTED')
 const v=record(value,['kind','handle','requestId','command','generation','value'])
 const handle=sameHandle(v.handle,trusted),requestId=identifier(v.requestId),generation=integer(v.generation,0)
 if(v.kind!=='reply'||v.command!=='outline'||requestId!==identifier(context.requestId)||generation!==integer(context.generation,0))bad()
 return Object.freeze({kind:'reply',handle,requestId,command:'outline',generation,value:validatePptxOutline(v.value)})
}
export function validateStopObservation(value:unknown,expected:ExecutionHandle):StopObservation {
  const v=record(value,['handle','confirmed','reason']),handle=sameHandle(v.handle,expected)
  if(typeof v.confirmed!=='boolean'||typeof v.reason!=='string'||! /^[A-Z][A-Z0-9_]{0,63}$/.test(v.reason))bad()
  return Object.freeze({handle,confirmed:v.confirmed,reason:v.reason})
}
export function validateInstanceObservation(value:unknown,expected:ExecutionHandle):InstanceObservation {
  const v=record(value,['handle','state']),handle=sameHandle(v.handle,expected)
  if(!['starting','running','stopped','unknown'].includes(v.state as string))bad()
  return Object.freeze({handle,state:v.state as InstanceObservation['state']})
}
export interface RenewalRequest { readonly handle:ExecutionHandle; readonly expectedEpoch:number; readonly validUntil:string }
function leaseDeadline(value:unknown,now:Date,absoluteDeadline:string,profileId:ProfileId):string {
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))bad()
  const iso=(v:unknown):number=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))bad();const t=Date.parse(v);if(!Number.isFinite(t)||new Date(t).toISOString()!==v)bad();return t}
  const end=iso(value),absolute=iso(absoluteDeadline)
  if(end<=now.getTime()||end>absolute||end-now.getTime()>getDocumentProfile(profileId).wallMs)bad()
  return value as string
}
/** Structural guard only: caller must first verify renewed PG authority. */
export function validateRenewal(value:unknown,now:Date,absoluteDeadline:string):RenewalRequest {
  const v=record(value,['handle','expectedEpoch','validUntil']),handle=validateExecutionHandle(v.handle)
  const expectedEpoch=integer(v.expectedEpoch,1)
  if(expectedEpoch!==handle.jobEpoch)bad()
  return Object.freeze({handle,expectedEpoch,validUntil:leaseDeadline(v.validUntil,now,absoluteDeadline,handle.profileId)})
}
export function validateAdoption(value:unknown,now:Date,absoluteDeadline:string):AdoptionRequest {
  const v=record(value,['previous','expectedInvocationId','validUntil']),previous=validateExecutionHandle(v.previous)
  const expectedInvocationId=invocation(v.expectedInvocationId)
  if(expectedInvocationId!==previous.invocationId)bad()
  return Object.freeze({previous,expectedInvocationId,validUntil:leaseDeadline(v.validUntil,now,absoluteDeadline,previous.profileId)})
}
/** Local protocol helper, not a durable replay ledger. Trusted caller supplies clock/deadline.
 * A fresh gate must never be reconstructed for an already-consumed request after restart.
 */
export function createPendingOutlineReply(expected:ResultContext,expiresAt:Date):{accept(value:unknown,now:Date):OutlineReply} {
 const raw=record(expected,['handle','requestId','command','generation']),handle=validateExecutionHandle(raw.handle)
 if(raw.command!=='outline'||handle.profileId!=='pptx-edit-v1'||!(expiresAt instanceof Date)||!Number.isFinite(expiresAt.getTime()))bad()
 const context=Object.freeze({handle,requestId:identifier(raw.requestId),command:'outline' as const,generation:integer(raw.generation,0)})
 const deadline=expiresAt.getTime()
 let consumed=false,expired=false
 return Object.freeze({accept(value:unknown,now:Date):OutlineReply {
  if(consumed)throw new DocumentContractError('DOCUMENT_REPLY_CONSUMED')
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))bad()
  if(expired||now.getTime()>=deadline){expired=true;throw new DocumentContractError('DOCUMENT_REPLY_EXPIRED')}
  const result=validateCommandResult(value,context)
  if(result.kind!=='reply'||result.command!=='outline')bad()
  consumed=true
  return result
 }})
}

export interface XlsxSessionBinding {readonly handle:ExecutionHandle;readonly engineSessionId:string}
/** Trusted adapter owns session mapping. Caller command args never contain session IDs.
 * Receipt means native session closed only; OS stop/reservation release is independent.
 */
export function createPendingXlsxClose(expected:ResultContext,expiresAt:Date):{accept(frame:unknown,current:XlsxSessionBinding,now:Date):XlsxCloseReply} {
 const raw=record(expected,['handle','requestId','command','generation','engineSessionId']),handle=validateExecutionHandle(raw.handle)
 if(raw.command!=='close'||handle.profileId!=='xlsx-edit-v1'||!(expiresAt instanceof Date)||!Number.isFinite(expiresAt.getTime()))bad()
 const context=Object.freeze({handle,requestId:identifier(raw.requestId),command:'close' as const,generation:integer(raw.generation,0),engineSessionId:identifier(raw.engineSessionId)})
 const deadline=expiresAt.getTime();let consumed=false,expired=false
 return Object.freeze({accept(frame:unknown,current:XlsxSessionBinding,now:Date):XlsxCloseReply {
  if(consumed)throw new DocumentContractError('DOCUMENT_REPLY_CONSUMED')
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))bad()
  if(expired||now.getTime()>=deadline){expired=true;throw new DocumentContractError('DOCUMENT_REPLY_EXPIRED')}
  const binding=record(current,['handle','engineSessionId'])
  sameHandle(binding.handle,context.handle)
  if(identifier(binding.engineSessionId)!==context.engineSessionId)bad()
  const value=validateXlsxCloseFrame(frame,context.requestId)
  const result=validateCommandResult({kind:'reply',...context,value},context)
  if(result.kind!=='reply'||result.command!=='close')bad()
  consumed=true;return result
 }})
}
