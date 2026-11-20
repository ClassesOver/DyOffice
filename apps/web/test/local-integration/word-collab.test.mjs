import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { docxBytes, fileFixture, importFile } from '../helpers/files.mjs'
import { createRevisionService } from '../../server/src/modules/revisions/service.ts'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createCsrfService, SESSION_COOKIE } from '../../server/src/modules/auth/csrf.ts'
import { restrictedOrigin as origin } from '../helpers/restricted.mjs'

test('Word sessions serialize concurrent appends, catch up on retries and preserve edits beyond a save checkpoint',async t=>{
  const f=await fileFixture(t,{wordCollaboration:true}),bytes=await docxBytes(),{file:initial}=await importFile(f,f.alice.token,bytes)
  const {fileId,revision}=initial,a=randomUUID(),b=randomUUID(),alice=f.alice.token
  const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
  const post=(clientId,input={},token=alice)=>f.app.inject({method:'POST',url:'/api/v1/files/'+fileId+'/word-collab',
    headers:{origin,cookie:SESSION_COOKIE+'='+token,'x-csrf-token':csrf.sessionToken(token)},payload:{clientId,revision,...input}})
  assert.equal((await post(b,{},f.bob.token)).statusCode,404)
  assert.equal((await post(a,{version:0,steps:[{stepType:'unknown'}]})).statusCode,400)
  assert.equal((await post(a)).json().baseVersion,0)
  const step=n=>({stepType:'replace',from:n,to:n,slice:{content:[{type:'text',text:'a'}]}})
  const [r1,r2]=await Promise.all([post(a,{version:0,steps:[step(1)]}),post(b,{version:0,steps:[step(1)]})])
  assert.equal(r1.statusCode,200);assert.deepEqual(r1.json(),r2.json())
  const loser=r1.json().clientIDs[0]===a?b:a
  assert.equal((await post(loser,{version:1,steps:[step(2)]})).json().version,2)
  assert.equal((await post(loser,{version:1,steps:[step(2)]})).json().version,2)
  const leases=createLeaseService({transactions:f.transactions}), revs=createRevisionService({transactions:f.transactions,files:f.files,objects:f.objects})
  const {leaseEpoch}=await leases.acquireLease(alice,fileId,{editorId:a})
  const save=async(baseRevision,wordVersion)=>{
    const {uploadId}=await revs.stageUpload(alice,fileId,{baseRevision,leaseEpoch,editorId:a,size:bytes.length})
    await f.files.receiveUpload(alice,uploadId,bytes)
    return revs.commitRevision(alice,{fileId,uploadId,baseRevision,leaseEpoch,idempotencyKey:randomUUID(),wordVersion})
  }
  await assert.rejects(save(revision,undefined),{statusCode:409})
  const saved=await save(revision,1)
  const newReader=(await post(randomUUID(),{revision:saved.revision})).json()
  assert.equal(newReader.baseVersion,1);assert.equal(newReader.version,2);assert.deepEqual(newReader.steps,[step(2)])
  const allSaved=await save(saved.revision,2)
  const external=await save(allSaved.revision,undefined)
  assert.equal((await post(a,{version:2})).statusCode,409)
  assert.equal((await post(a,{revision:external.revision})).json().version,0)
})
