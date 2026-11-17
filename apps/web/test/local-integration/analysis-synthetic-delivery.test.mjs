import test from 'node:test'
import assert from 'node:assert/strict'
import {fileFixture} from '../helpers/files.mjs'
import {syntheticAnalysisAdapter} from '../helpers/analysis-delivery.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
test('local synthetic adapter commits through real task bearer and owner receipt routes without a model',async t=>{
 const origin='http://localhost:4271',f=await fileFixture(t,{origin,buildApp:false})
 let app
 const adapter=syntheticAnalysisAdapter(()=>app)
 app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin,csrfKey:f.csrfKey,objectStore:f.objects,globalConfigKeyring:{activeKeyId:'fixture',keys:{fixture:new Uint8Array(32).fill(9)}},providerGateway:{profiles:[{deploymentId:f.deploymentId,entryId:'fixture',revision:1,providerId:'openai',model:'synthetic',baseUrl:'https://provider.example/v1',endpoint:'https://provider.example/v1/chat/completions',allowedIpv4:['8.8.8.8'],maxOutputTokens:128}]},codingHarnesses:{adapters:[adapter],defaultId:adapter.descriptor.id}})
 f.cleanup.push(()=>app.close())
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
 const headers={origin,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)}
 const response=await app.inject({method:'POST',url:'/api/v1/agents/tasks',headers,payload:{turnId:'synthetic_analysis_fixture',modelId:adapter.descriptor.id,request:{system:'',messages:[{role:'user',text:JSON.stringify({instruction:'Produce only local fixture',officeModelId:'fixture',dataInputs:{sourceIds:[],resultIds:[]}})}],tools:[]}}})
 assert.equal(response.statusCode,200);assert.doesNotMatch(response.body,/event: error/)
 assert.equal(adapter.runs,1);assert.ok(adapter.committed?.commandId)
 const receipt=await app.inject({url:'/api/v1/agents/deliveries/'+adapter.committed.commandId,headers})
 assert.equal(receipt.statusCode,200);assert.deepEqual(receipt.json(),adapter.committed)
 const file=receipt.json().artifacts[0]
 const bytes=await app.inject({url:'/api/v1/agents/artifacts/'+file.artifactId+'/content',headers})
 assert.equal(bytes.statusCode,200);assert.equal(bytes.headers['x-content-sha256'],file.sha256);assert.match(bytes.body,/<script>not executable<\/script>/)
 const other=await app.inject({url:'/api/v1/agents/deliveries/'+adapter.committed.commandId,headers:{origin,cookie:'__Host-dyoffice-session='+f.bob.token,'x-csrf-token':csrf.sessionToken(f.bob.token)}})
 assert.notEqual(other.statusCode,200)
 assert.doesNotMatch(response.body,/Bearer|credential|__Host-dyoffice/)
})
