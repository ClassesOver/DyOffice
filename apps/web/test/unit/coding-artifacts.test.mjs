import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {createHarnessArtifacts} from '../../server/src/modules/coding/artifacts.ts'

test('invalid artifact metadata, path names, bounds and hash fail before database or objects',async()=>{
 let accessed=0
 const service=createHarnessArtifacts({transactions:{withPrincipalTransaction(){accessed++;throw Error('unexpected database')}},objects:{}})
 const bytes=Buffer.from('analysis'),valid={taskId:randomUUID(),claimId:randomUUID(),epoch:1,name:'result.txt',mediaType:'text/plain',role:'report',inputResultIds:[],sha256:createHash('sha256').update(bytes).digest('hex')}
 for(const change of [{name:'../secret'},{name:'nested/file.csv'},{taskId:'arbitrary'},{claimId:'other'},{epoch:0},{mediaType:'text/plain\r\nInjected: yes'},{sha256:'0'.repeat(64)},{inputResultIds:['not-a-result-id']}]) {
  await assert.rejects(service.stage('private-token',{...valid,...change},bytes))
 }
 await assert.rejects(service.stage('private-token',valid,Buffer.alloc(8*1024*1024+1)))
 assert.equal(accessed,0)
})
