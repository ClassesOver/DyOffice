import test from 'node:test'
import assert from 'node:assert/strict'
import {createApiShell} from '../../server/src/framework.ts'
import {registerFixedProviderProbe} from '../../server/src/modules/providers/fixed-probe.ts'
const token='a'.repeat(43),headers={cookie:'__Host-dyoffice-session='+token}
const profile={deploymentId:'d',entryId:'model',revision:1,providerId:'openai',model:'model',baseUrl:'https://provider.example/v1',endpoint:'https://provider.example/v1/chat/completions',allowedIpv4:['8.8.8.8'],maxOutputTokens:32}
const cfg={deploymentId:'d',profiles:[profile],keyring:{activeKeyId:'k',keys:{k:Buffer.alloc(32)}},transactions:{withPrincipalTransaction:async()=>{throw Error('denied')}},csrf:{requireSession(){}}}
test('fixed probe tracks hung authentication through shutdown without releasing its orphan',async()=>{
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
 const app=await createApiShell()
 const owned=registerFixedProviderProbe(app,{...cfg,sessions:{authenticate:async()=>{entered();await gate;return {deploymentId:'d',userId:'u',sessionId:'s',roles:['config_admin']}}}})
 const result=app.inject({method:'POST',url:'/api/v1/admin/ai-probe/turns',headers,payload:{turnId:'t',modelId:'model',scenario:'hello'}}).then(r=>r)
 await started;owned.dispose();assert.equal((await result).statusCode,403)
 await assert.rejects(owned.drain({timeoutMs:20}),/drain/)
 release();await owned.drain({timeoutMs:500});await app.close()
})
test('fixed probe rejects empty/cross-deployment/duplicate profile admission before route registration',async()=>{
 for(const profiles of [[],[{...profile,entryId:'model.v1'}],[{...profile,entryId:'x'.repeat(101)}],Array.from({length:129},(_,i)=>({...profile,entryId:'m'+i})),[{...profile,deploymentId:'other'}],[profile,profile]]){
  const app=await createApiShell();assert.throws(()=>registerFixedProviderProbe(app,{...cfg,profiles,sessions:{authenticate:async()=>{}}}),/probe/);await app.close()
 }
})
test('fixed probe configuration reveals only immutable entry IDs to deployment admin, no provider traffic',async()=>{
 let principal={deploymentId:'d',userId:'u',sessionId:'s',roles:['config_admin']}
 const profiles=[{...profile}]
 const app=await createApiShell();const owned=registerFixedProviderProbe(app,{...cfg,profiles,sessions:{authenticate:async()=>principal}})
 profiles[0].entryId='mutated'
 const r=await app.inject({url:'/api/v1/admin/ai-probe/configuration',headers})
 assert.equal(r.statusCode,200);assert.deepEqual(r.json(),{experimental:true,entries:[{id:'model',label:'model'}]});assert.match(r.headers['cache-control'],/no-store/)
 for(const p of [{...principal,deploymentId:'other'},{...principal,roles:[]}]){principal=p;assert.equal((await app.inject({url:'/api/v1/admin/ai-probe/configuration',headers})).statusCode,403)}
 owned.dispose();await owned.drain();await app.close()
})
test('parallel asset admissions remain tracked through dispose without rejecting normal JS/CSS loads',async()=>{
 let release;const gate=new Promise(r=>release=r);let entered=0
 const app=await createApiShell();const owned=registerFixedProviderProbe(app,{...cfg,sessions:{authenticate:async()=>{entered++;await gate;return {deploymentId:'d',userId:'u',sessionId:'s',roles:['config_admin']}}}})
 const a=owned.authorize(token),b=owned.authorize(token);a.catch(()=>{});b.catch(()=>{})
 await new Promise(r=>setTimeout(r,10));assert.equal(entered,2)
 release();await Promise.all([a,b]);owned.dispose();await owned.drain();await app.close()
})
