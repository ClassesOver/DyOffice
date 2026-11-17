import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createAssistantChannelService} from '../../server/src/modules/assistant-channel/service.ts'
test('malformed credentials and unsafe member metadata are rejected before session access',async()=>{
 let accesses=0
 const service=createAssistantChannelService({credentialKey:'k'.repeat(64),transactions:{withPrincipalTransaction(){accesses++;throw Error('unexpected database')}}})
 for(const token of ['', 'a'.repeat(2049),'bad.token','a'.repeat(43)]) {
  await assert.rejects(service.memberSnapshot(token),{statusCode:401})
  await assert.rejects(service.apply(token,{displayName:'Agent',kind:'custom'}),{statusCode:401})
 }
 for(const action of [{kind:'message',content:'x',from:'office'},{kind:'delegate',instruction:'x',officeWrite:true},{kind:'result',taskId:randomUUID(),claimId:randomUUID(),connectionEpoch:0,summary:'x',outcome:'succeeded'}]) {
  await assert.rejects(service.submit({kind:'owner',token:'unused'},{requestId:randomUUID(),conversationId:randomUUID(),to:'office',action}),{statusCode:400})
 }
 assert.equal(accesses,0)
})
