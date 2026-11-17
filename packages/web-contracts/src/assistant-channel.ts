import type {HarnessDataInputs} from './harness-data.ts'
export const CHANNEL_LIMITS=Object.freeze({maxContentBytes:32768,maxMembers:4,maxActiveTasks:32,maxDepth:4,maxChildren:16,deadlineMs:600000})
export type TaskState='queued'|'running'|'waiting_peer'|'cancel_requested'|'succeeded'|'failed'|'cancelled'|'unknown_outcome'
export type AgentCapability='chat'|'office.read'|'harness.execute'
export type AgentAction=
 |{kind:'message';content:string;replyTo?:string}
 |{kind:'delegate';instruction:string;parentTaskId?:string;dataInputs?:HarnessDataInputs}
 |{kind:'result';taskId:string;claimId:string;connectionEpoch:number;summary:string;outcome:'succeeded'|'failed'}
 |{kind:'cancel';taskId:string}
export interface SubmitAgentAction {requestId:string;conversationId:string;to:string;action:AgentAction}
export interface AgentReceipt {messageId:string;taskId?:string}
export interface ChannelTask {
 taskId:string;conversationId:string;parentTaskId:string|null;rootTaskId:string;state:TaskState
 from:string;to:string;instruction:string;claimId:string|null;connectionEpoch:number|null
 deadlineAt:string;summary:string|null;outcome?:string|null;dataInputs?:HarnessDataInputs
}
const invalid=()=>Object.assign(Error('Invalid assistant channel request'),{statusCode:400})
export function channelObject(raw:unknown,keys:readonly string[]):Record<string,unknown> {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw))||
  Reflect.ownKeys(raw).some(key=>typeof key!=='string'||!keys.includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(raw,key)??{},'value')))throw invalid()
 return raw as Record<string,unknown>
}
export function channelUuid(raw:unknown):string {
 if(typeof raw!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw))throw invalid()
 return raw.toLowerCase()
}
function content(raw:unknown):string {
 if(typeof raw!=='string'||!raw.trim()||new TextEncoder().encode(raw).length>CHANNEL_LIMITS.maxContentBytes||raw.includes('\0'))throw invalid()
 return raw
}
export function decodeAgentAction(raw:unknown):SubmitAgentAction {
 const input=channelObject(raw,['requestId','conversationId','to','action'])
 const requestId=channelUuid(input.requestId),conversationId=channelUuid(input.conversationId),to=input.to==='office'?'office':channelUuid(input.to)
 const kind=(input.action as {kind?:unknown})?.kind
 let action:AgentAction
 if(kind==='message') {
  const a=channelObject(input.action,['kind','content','replyTo'])
  action={kind,content:content(a.content),...(a.replyTo===undefined?{}:{replyTo:channelUuid(a.replyTo)})}
 } else if(kind==='delegate') {
  const a=channelObject(input.action,['kind','instruction','parentTaskId','dataInputs'])
  const dataInputs=a.dataInputs===undefined?undefined:decodeChannelDataInputs(a.dataInputs)
  action={kind,...(dataInputs===undefined?{}:{dataInputs}),instruction:content(a.instruction),...(a.parentTaskId===undefined?{}:{parentTaskId:channelUuid(a.parentTaskId)})}
 } else if(kind==='result') {
  const a=channelObject(input.action,['kind','taskId','claimId','connectionEpoch','summary','outcome'])
  if(!Number.isSafeInteger(a.connectionEpoch)||(a.connectionEpoch as number)<1||!['succeeded','failed'].includes(a.outcome as string))throw invalid()
  action={kind,taskId:channelUuid(a.taskId),claimId:channelUuid(a.claimId),connectionEpoch:a.connectionEpoch as number,summary:content(a.summary),outcome:a.outcome as 'succeeded'|'failed'}
 } else if(kind==='cancel') {
  const a=channelObject(input.action,['kind','taskId']);action={kind,taskId:channelUuid(a.taskId)}
 } else throw invalid()
 return {requestId,conversationId,to,action}
}
export function canTransition(from:TaskState,to:TaskState):boolean {
 const transitions:Record<TaskState,readonly TaskState[]>={queued:['running','cancelled'],running:['waiting_peer','succeeded','failed','cancel_requested','unknown_outcome'],waiting_peer:['queued','cancel_requested','failed'],cancel_requested:['cancelled','unknown_outcome'],unknown_outcome:['succeeded','failed','cancelled'],succeeded:[],failed:[],cancelled:[]}
 return transitions[from]?.includes(to)??false
}

export function decodeChannelDataInputs(raw:unknown):HarnessDataInputs {
 const value=channelObject(raw,['sourceIds','resultIds'])
 const ids=(input:unknown,parse:(id:unknown)=>string)=>{
  if(!Array.isArray(input)||input.length>32)throw invalid()
  const parsed=input.map(parse)
  if(new Set(parsed).size!==parsed.length)throw invalid()
  return parsed
 }
 return {sourceIds:ids(value.sourceIds,id=>{if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id))throw invalid();return id}),resultIds:ids(value.resultIds,channelUuid)}
}
