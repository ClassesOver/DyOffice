import dns from 'node:dns/promises'
import {isIP} from 'node:net'
import {getProviderAdapter} from '../../../../../../packages/ai-provider/src/registry.ts'
import type {AiProviderId} from '../../../../../../packages/ai-provider/src/types.ts'
import {publicIpv4} from './pinned-egress.ts'
import type {AdminPipelineProfile} from './admin-pipeline.ts'

export interface LiveProviderEntry {
  deploymentId:string; id:string; revision:number; providerId:string; model:string; baseUrl:string
}
/** Resolve only administrator-saved metadata. Credentials never enter profiles. */
export async function resolveLiveProviderProfile(entry:LiveProviderEntry,lookup=dns.lookup):Promise<AdminPipelineProfile> {
  const fail=()=>new Error('Shared model connection unavailable')
  const base=new URL(entry.baseUrl)
  if(base.protocol!=='https:'||base.port||base.username||base.password||base.search||base.hash||isIP(base.hostname)||base.href!==entry.baseUrl)throw fail()
  const adapter=getProviderAdapter(entry.providerId as AiProviderId)
  if(!adapter||adapter.resolveEndpoint({apiKey:'',model:entry.model,baseUrl:entry.baseUrl}).protocol!=='openai-compatible')throw fail()
  const answers=await lookup(base.hostname,{family:4,all:true,verbatim:true})
  if(!answers.length||answers.length>64||answers.some(answer=>answer.family!==4||!publicIpv4(answer.address)))throw fail()
  return {deploymentId:entry.deploymentId,entryId:entry.id,revision:entry.revision,providerId:entry.providerId,model:entry.model,baseUrl:entry.baseUrl,
    endpoint:entry.baseUrl.replace(/\/$/,'')+'/chat/completions',allowedIpv4:[...new Set(answers.map(answer=>answer.address))],maxOutputTokens:4096}
}
