import {AI_SEARCH_PROVIDERS} from '../../../../../../packages/ai-provider/src/search-settings.ts'
import {imageSearch,webSearch,type SearchOptions} from '../../../../../../packages/ai-search/src/index.ts'
import {globalSearchOptions} from '../../../../../../packages/ai-search/src/search-tools.ts'
import type {PrincipalTransactions} from '../../db/context.ts'
import {tokenHash} from '../auth/sessions.ts'
import type {SecretKeyring,SecretEnvelope} from '../admin/secrets.ts'
import {createSecretBox} from '../admin/secrets.ts'

type SearchKind='web_search'|'image_search'
type Provider={revision:number;id:string;kind:SearchKind;providerId:string;envelope:SecretEnvelope|null}
type SearchInput={kind:SearchKind;query:string;maxResults:number}
type SearchRunners={web:(query:string,count:number,options:SearchOptions)=>Promise<Awaited<ReturnType<typeof webSearch>>>;image:(query:string,count:number,options:SearchOptions)=>Promise<Awaited<ReturnType<typeof imageSearch>>>}
const unavailable=()=>new Error('AI search unavailable')
const maxResultsFor=(kind:SearchKind)=>kind==='web_search'?6:8

export function createAiSearchService({transactions,keyring,search={web:webSearch,image:imageSearch}}:{transactions:PrincipalTransactions;keyring?:SecretKeyring;search?:SearchRunners}){
 const box=keyring?createSecretBox(keyring):undefined
 async function searchFor(token:string,input:SearchInput){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!input||!['web_search','image_search'].includes(input.kind)||typeof input.query!=='string'||input.query.trim().length<1||input.query.length>300||!Number.isSafeInteger(input.maxResults)||input.maxResults<1||input.maxResults>maxResultsFor(input.kind))throw unavailable()
  const query=input.query.trim()
  const configured=await transactions.withPrincipalTransaction({kind:'session',token},async(connection,principal)=>{
   if(!principal.roles.includes('personal'))throw unavailable()
   await connection.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)",[tokenHash(token),String(transactions.sessionIdleMs)])
   const result=await connection.query<{config:Provider|null}>('SELECT global_ai_tool_provider($1) AS config',[input.kind])
   const value=result.rows[0]?.config
   if(!value||value.kind!==input.kind||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.id!=='string'||typeof value.providerId!=='string')throw unavailable()
   const meta=AI_SEARCH_PROVIDERS.find(item=>item.id===value.providerId)
   if(!meta||value.providerId==='genspark'||(input.kind==='image_search'&&!meta.imageSearch))throw unavailable()
   return {provider:value,deploymentId:principal.deploymentId}
  })
  const {provider,deploymentId}=configured
  let apiKey=''
  if(provider.envelope){
   if(!box)throw unavailable()
   try{apiKey=box.unseal(provider.envelope,{deploymentId,configId:provider.id,providerId:provider.providerId,kind:input.kind})}catch{throw unavailable()}
  }
  if(!apiKey&&!['parallel','keenable'].includes(provider.providerId))throw unavailable()
  const options=globalSearchOptions(provider.providerId,apiKey)
  return input.kind==='web_search'?search.web(query,input.maxResults,options):search.image(query,input.maxResults,options)
 }
 return {search:searchFor}
}
