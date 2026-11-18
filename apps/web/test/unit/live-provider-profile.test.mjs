import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveLiveProviderProfile} from '../../server/src/modules/providers/live-profile.ts'
const entry={deploymentId:'deployment',id:'shared-model',revision:3,providerId:'deepseek',model:'deepseek-v4-flash',baseUrl:'https://api.example.com/v1'}
test('uses the current saved shared model without an external profile file',async()=>{
 const p=await resolveLiveProviderProfile(entry,async()=>[{address:'8.8.8.8',family:4}])
 assert.equal(p.entryId,entry.id);assert.equal(p.revision,3);assert.equal(p.endpoint,entry.baseUrl+'/chat/completions');assert.deepEqual(p.allowedIpv4,['8.8.8.8'])
 const updated=await resolveLiveProviderProfile({...entry,revision:4,model:'updated-model'},async()=>[{address:'8.8.4.4',family:4}])
 assert.equal(updated.revision,4);assert.equal(updated.model,'updated-model')
})
test('rejects private, mixed and empty DNS answers before any credential access',async()=>{
 for(const answers of [[],[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]])await assert.rejects(resolveLiveProviderProfile(entry,async()=>answers))
})
test('rejects credential URLs, HTTP and native vendor protocols that this gateway cannot send',async()=>{
 for(const change of [{baseUrl:'http://api.example.com/v1'},{baseUrl:'https://key@api.example.com/v1'},{baseUrl:'https://api.example.com/v1?api_key=secret'},{providerId:'anthropic'}]){
 let lookups=0;await assert.rejects(resolveLiveProviderProfile({...entry,...change},async()=>{lookups++;return [{address:'8.8.8.8',family:4}]}));assert.equal(lookups,0)
 }
})
