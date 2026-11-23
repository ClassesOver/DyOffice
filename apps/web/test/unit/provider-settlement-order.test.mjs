import test from 'node:test'
import assert from 'node:assert/strict'
import {createAdminProviderPipeline} from '../../server/src/modules/providers/admin-pipeline.ts'
import {createSecretBox} from '../../server/src/modules/admin/secrets.ts'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'

// Real pipeline/parser/budget adapter; only database transactions and HTTPS are
// controlled doubles. This is ordering coverage, not PostgreSQL/browser E2E.
test('visible reply delta precedes settlement; completed turn awaits the settlement transaction',async t=>{
 const keyring={activeKeyId:'test',keys:{test:new Uint8Array(32).fill(25)}}
 const principal={deploymentId:'dep',userId:'alice',sessionId:'session',roles:['personal']}
 const profile={deploymentId:'dep',entryId:'primary',revision:1,providerId:'openai',model:'synthetic',baseUrl:'https://provider.example/v1',endpoint:'https://provider.example/v1/chat/completions',allowedIpv4:['8.8.8.8'],maxOutputTokens:128}
 const envelope=createSecretBox(keyring).seal('synthetic-private-key',{deploymentId:'dep',configId:'primary',providerId:'openai',kind:'chat'})
 const row={revision:1,kind:'chat',provider_id:'openai',model:'synthetic',base_url:profile.baseUrl,enabled:true,envelope}
 const release=Promise.withResolvers(),settling=Promise.withResolvers(),delta=Promise.withResolvers()
 let record,finished=false
 const client={async query(sql,args){
  if(sql.includes('personal_provider_budget_action')){
   const [op,turnId,entryId,configRevision,requestDigest,claimId]=args
   if(op==='reserve')record={id:'reservation',deploymentId:'dep',userId:'alice',sessionId:'session',turnId,entryId,configRevision,requestDigest,claimId:null,state:'reserved'}
   if(op==='claim'){record.claimId=claimId;record.state='dispatching'}
   if(op==='dispatch')record.state='unknown'
   if(op==='settle'){settling.resolve();await release.promise;record.state='settled'}
   return {rows:[{record:{...record}}]}
  }
  if(sql.includes('AS authorized'))return {rows:[{authorized:true}]}
  if(sql.includes('SELECT c.revision')||sql.includes('personal_provider_secret'))return {rows:[row]}
  return {rows:[]}
 }}
 const transactions={sessionIdleMs:1000,withPrincipalTransaction:async(_,fn)=>fn(client,principal)}
 const pipeline=createAdminProviderPipeline({transactions,keyring,profiles:[profile],audience:'personal'})
 t.after(()=>{release.resolve();pipeline.dispose()})
 mockProviderNetwork(t,[Buffer.from('data: {"choices":[{"delta":{"content":"Verified assistant reply"},"finish_reason":"stop"}]}\n\n'),Buffer.from('data: [DONE]\n\n')])
 const work=pipeline.turns.run({token:'token',modelId:'primary',turnId:'turn',request:{system:'test',messages:[{role:'user',text:'hello'}],tools:[]}},async event=>{if(event.type==='delta')delta.resolve(event.text)})
 void work.then(()=>{finished=true},()=>{})
 assert.equal(await delta.promise,'Verified assistant reply')
 assert.equal(record.state,'unknown')
 await settling.promise
 assert.equal(finished,false)
 assert.equal(record.state,'unknown')
 release.resolve();await work
 assert.equal(record.state,'settled');assert.equal(finished,true)
})
