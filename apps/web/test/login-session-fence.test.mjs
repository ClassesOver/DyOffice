import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createSessionService } from '../server/auth/session-core.mjs'

test('session issuance binds to the auth_version read during password verification',async()=>{
  const deploymentId=randomUUID()
  const userId=randomUUID()
  const calls=[]
  const pool={async query(sql,params){
    calls.push({sql,params})
    assert.match(sql,/u\.auth_version = \$6::bigint/)
    assert.equal(params[5],'7')
    // Simulates a concurrent reset having changed the current version:
    return {rowCount:0,rows:[]}
  }}
  const service=createSessionService({pool})
  assert.equal(await service.issue({deploymentId,userId,expectedAuthVersion:'7'}),null)
  assert.equal(calls.length,1)
  for(const bad of ['0','-1','1.5','NaN','9223372036854775808',1,{},undefined]){
    if(bad===undefined) continue // old private callers retain optional guard
    await assert.rejects(service.issue({deploymentId,userId,expectedAuthVersion:bad}),TypeError)
  }
  assert.equal(calls.length,1)
})
