import test from 'node:test'
import assert from 'node:assert/strict'
import {createSecretBox} from '../../server/src/modules/admin/secrets.ts'
import {createAiSearchService} from '../../server/src/modules/ai-tools/search-service.ts'

const keyring={activeKeyId:'k1',keys:{k1:Buffer.alloc(32,7)}}
const deploymentId='11111111-1111-4111-8111-111111111111'
const userId='22222222-2222-4222-8222-222222222222'
const sessionId='33333333-3333-4333-8333-333333333333'
const token='a'.repeat(43)

function fixture(config){
 const calls=[],principal={deploymentId,userId,sessionId,roles:['personal']}
 const transactions={sessionIdleMs:3600000,async withPrincipalTransaction(credential,work){assert.deepEqual(credential,{kind:'session',token});return work({async query(sql,params){calls.push({sql,params});if(sql.includes('global_ai_tool_provider'))return {rows:[{config}]};return {rows:[]}}},principal)}}
 return {calls,transactions}
}

test('executes the configured web search with a server-decrypted key without returning it',async()=>{
 const box=createSecretBox(keyring)
 const envelope=box.seal('serper-secret',{deploymentId,configId:'search-1',providerId:'serper',kind:'web_search'})
 const {calls,transactions}=fixture({revision:3,id:'search-1',kind:'web_search',providerId:'serper',envelope})
 const dispatched=[]
 const service=createAiSearchService({transactions,keyring,search:{web:async(query,count,options)=>{dispatched.push({query,count,options});return {results:[{title:'Result',url:'https://example.com',snippet:'Snippet'}],method:'serper'}},image:assert.fail}})
 const result=await service.search(token,{kind:'web_search',query:'current facts',maxResults:4})
 assert.deepEqual(dispatched,[{query:'current facts',count:4,options:{useGsk:false,serperKey:'serper-secret',serplyKey:'',searchapiKey:'',tavilyKey:'',parallelKey:'',exaKey:'',firecrawlKey:'',keenableKey:'',prefer:'serper'}}])
 assert.deepEqual(result,{results:[{title:'Result',url:'https://example.com',snippet:'Snippet'}],method:'serper'})
 assert.doesNotMatch(JSON.stringify(result),/serper-secret/)
 assert.ok(calls.some(call=>call.sql.includes('dyoffice.global_session_hash')))
 assert.ok(calls.some(call=>call.sql.includes('global_ai_tool_provider')&&call.params[0]==='web_search'))
})

test('rejects image search through a provider without image support before dispatch',async()=>{
 const {transactions}=fixture({revision:2,id:'search-2',kind:'image_search',providerId:'tavily',envelope:null})
 let dispatched=false
 const service=createAiSearchService({transactions,keyring,search:{web:assert.fail,image:async()=>{dispatched=true;return {images:[],method:'tavily'}}}})
 await assert.rejects(service.search(token,{kind:'image_search',query:'city skyline',maxResults:2}),/unavailable/i)
 assert.equal(dispatched,false)
})

test('rejects search for a session without the personal role before reading provider settings',async()=>{
 const {transactions}=fixture(null)
 transactions.withPrincipalTransaction=async(_credential,_work)=>_work({query:async()=>{assert.fail('provider config must not be read')}},{deploymentId,userId,sessionId,roles:[]})
 const service=createAiSearchService({transactions,keyring,search:{web:assert.fail,image:assert.fail}})
 await assert.rejects(service.search(token,{kind:'web_search',query:'query',maxResults:1}),/unavailable/i)
})
