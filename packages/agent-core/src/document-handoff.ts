import type { AgentTransport } from './types'
import type { AgentRunResult, DocumentHandoffOptions } from './loop'

type Send = (instruction:string, input:DocumentHandoffOptions)=>Promise<AgentRunResult|undefined>
const editors = new WeakMap<AgentTransport, Send>()
export function bindDocumentHandoff(transport:AgentTransport|undefined,send:Send) {
  if (!transport) return
  editors.set(transport,send)
  return ()=>{if(editors.get(transport)===send)editors.delete(transport)}
}
export function documentHandoffEditor(transport:AgentTransport) {return editors.get(transport)}
