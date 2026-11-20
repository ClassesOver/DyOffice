import type {CodingTask,CodingResult,HarnessDescriptor,CodingProgress} from '../../../../../../packages/agent-core/src/coding-skill.ts'

export interface HarnessRunContext {
  onProgress?:(event:CodingProgress)=>void
  modelId:string
  openModel?:()=>Promise<{baseUrl:string;apiKey:string;modelId:string;close():Promise<void>}>
  data?:{baseUrl:string;grant:import('../../../../../../packages/web-contracts/src/harness-data.ts').HarnessDataGrant}
}
export interface HarnessAdapter {
  descriptor: HarnessDescriptor
  run(input:CodingTask,signal:AbortSignal,context?:HarnessRunContext):Promise<CodingResult>
}
/** Origin is display metadata; built-in and external adapters share every execution rule. */
export function createHarnessRegistry(adapters:readonly HarnessAdapter[],defaultId:string) {
  const entries=new Map<string,HarnessAdapter>()
  for(const adapter of adapters) {
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(adapter.descriptor.id)||entries.has(adapter.descriptor.id))throw Error('Invalid harness registration')
    entries.set(adapter.descriptor.id,{descriptor:{...adapter.descriptor,capabilities:[...adapter.descriptor.capabilities]},run:adapter.run.bind(adapter)})
  }
  if(!entries.has(defaultId))throw Error('Default coding agent unavailable')
  const owners=new Set<string>()
  return {
    defaultId,
    list:()=>[...entries.values()].map(x=>({...x.descriptor,capabilities:[...x.descriptor.capabilities]})),
    async run(owner:string,input:CodingTask,signal:AbortSignal,context?:HarnessRunContext):Promise<CodingResult> {
      const adapter=entries.get(input.agentId??defaultId)
      if(!adapter?.descriptor.capabilities.includes('coding'))throw Error('Coding agent unavailable')
      if(owners.has(owner)||owners.size>=4)throw Error('Coding agents are busy')
      if(signal.aborted)throw Object.assign(Error('Coding task cancelled'),{name:'AbortError'})
      owners.add(owner)
      try {return await adapter.run({...input},signal,context)}
      finally {owners.delete(owner)}
    },
  }
}
export type HarnessRegistry=ReturnType<typeof createHarnessRegistry>
