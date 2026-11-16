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
 for(const profiles of [[],[{...profile,deploymentId:'other'}],[profile,profile]]){
  const app=await createApiShell();assert.throws(()=>registerFixedProviderProbe(app,{...cfg,profiles,sessions:{authenticate:async()=>{}}}),/probe/);await app.close()
 }
})
