import type {AgentMessage,AgentTransport} from './types'

export interface VisibleChatAttachment {readonly name:string;readonly ext:string;readonly sizeBytes:number}
export interface VisibleChatMessage {text:string; sender?:'dsh'; attachments?:readonly VisibleChatAttachment[]}
export interface FileChatTurn {
  readonly turnId?: string
  consumedTurns?(): readonly string[]
  restoreConsumedTurns?(ids: readonly string[]): void
  history():Promise<AgentMessage[]>
  text(text:string):void
  finish(text:string,failed:boolean):void
}
type Start=(message:VisibleChatMessage,loop:object)=>FileChatTurn
const chats=new WeakMap<AgentTransport,Start>()
export function bindFileChat(transport:AgentTransport,start:Start){
  chats.set(transport,start)
  return ()=>{if(chats.get(transport)===start)chats.delete(transport)}
}
export function startFileChat(transport:AgentTransport,message:VisibleChatMessage,loop:object){
  return chats.get(transport)?.(message,loop)
}
