import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createLocalLoginService } from '../server/auth/login-service.mjs'

const deploymentId = randomUUID()
const id = randomUUID()
const PASSWORD = 'a long real example passphrase'
const invalid = {ok:false,code:'INVALID_CREDENTIALS'}

function fixture() {
  let row = {id, password_hash:'real-phc-hash',status:'active',disabled_at:null,auth_version:'1'}
  let consumed = 0
  let queryCount = 0
  let fakeHash, verifiedHashes=[]
  let issueArgs
  const pool = { async query(query, args) {
    queryCount++
    assert.match(query,/deployment_id=\$1 AND username_normalized=\$2/)
    assert.deepEqual(args,[deploymentId,'alice.local'])
    return {rowCount:row?1:0,rows:row?[row]:[]}
  } }
  const hasher = {
    async hashPassword(secret) { assert.notEqual(secret,PASSWORD);fakeHash='dummy-phc-hash';return fakeHash },
    async verifyPassword(hash,password) { verifiedHashes.push(hash);return hash==='real-phc-hash' && password===PASSWORD },
  }
  const throttle={async consume(input) {
    consumed++
    assert.equal(input.deploymentId,deploymentId)
    assert.equal(input.usernameNormalized,'alice.local')
    assert.equal(input.ipAddress,'192.0.2.10')
    return {allowed: true}
  }}
  const sessions = {async issue(input) {issueArgs=input;return {sessionId:randomUUID(),cookie:'session-internal-cookie',expiresAt:new Date()} } }
  return {pool,hasher,throttle,sessions,setRow:v=>row=v,get state(){return {consumed,queryCount,fakeHash,verifiedHashes,issueArgs}}}
}

test('valid local login normalizes name, limits attempt, verifies Argon2 and binds auth_version',async()=>{
  const f=fixture()
  const service=await createLocalLoginService({pool:f.pool,passwordHasher:f.hasher,sessionService:f.sessions,throttle:f.throttle,deploymentId})
  const result=await service.login({username:'  ALICE.LOCAL  ',password:PASSWORD,ipAddress:'192.0.2.10'})
  assert.equal(result.ok,true)
  assert.equal(result.userId,id)
  assert.deepEqual(f.state.issueArgs,{deploymentId,userId:id,expectedAuthVersion:'1'})
  assert.equal(f.state.consumed,1)
  assert.deepEqual(f.state.verifiedHashes,['real-phc-hash'])
  assert.equal(JSON.stringify(result).includes('password_hash'),false)
})

test('unknown, disabled and wrong-password accounts never issue and use real dummy verification',async()=>{
  const f=fixture()
  let issuances=0
  f.sessions.issue=async()=>{ issuances++;throw Error('Unexpected issuance') }
  const service=await createLocalLoginService({pool:f.pool,passwordHasher:f.hasher,sessionService:f.sessions,throttle:f.throttle,deploymentId})
  assert.deepEqual(await service.login({username:'Alice.Local',password:'wrong password',ipAddress:'192.0.2.10'}),invalid)
  f.setRow(null)
  assert.deepEqual(await service.login({username:'Alice.Local',password:PASSWORD,ipAddress:'192.0.2.10'}),invalid)
  f.setRow({id,password_hash:'real-phc-hash',status:'disabled',disabled_at:new Date(),auth_version:'2'})
  assert.deepEqual(await service.login({username:'Alice.Local',password:PASSWORD,ipAddress:'192.0.2.10'}),invalid)
  assert.deepEqual(f.state.verifiedHashes,['real-phc-hash',f.state.fakeHash,f.state.fakeHash])
  assert.equal(issuances,0)
})

test('malformed inputs, attempt-budget denial and stale auth version fail closed',async()=>{
  const f=fixture()
  const service=await createLocalLoginService({pool:f.pool,passwordHasher:f.hasher,sessionService:f.sessions,throttle:f.throttle,deploymentId})
  for(const username of ['x','not valid','x'.repeat(1025)]) {
    assert.deepEqual(await service.login({username,password:PASSWORD,ipAddress:'192.0.2.10'}),invalid)
  }
  assert.deepEqual(await service.login({username:'alice.local',password:'x'.repeat(1025),ipAddress:'192.0.2.10'}),invalid)
  assert.equal(f.state.queryCount,0)
  f.throttle.consume=async()=>({allowed:false})
  assert.deepEqual(await service.login({username:'alice.local',password:PASSWORD,ipAddress:'192.0.2.10'}),{ok:false,code:'RATE_LIMITED'})
  assert.equal(f.state.queryCount,0)
  f.throttle.consume=async()=>({allowed:true})
  f.sessions.issue=async input=>{assert.equal(input.expectedAuthVersion,'1');return null}
  assert.deepEqual(await service.login({username:'alice.local',password:PASSWORD,ipAddress:'192.0.2.10'}),invalid)
  assert.equal(f.state.queryCount,1)
})

test('invalid dependencies are rejected and rate-limit DB errors do not allow login',async()=>{
  await assert.rejects(createLocalLoginService({deploymentId}),TypeError)
  const f=fixture()
  const service=await createLocalLoginService({pool:f.pool,passwordHasher:f.hasher,sessionService:f.sessions,throttle:f.throttle,deploymentId})
  f.throttle.consume=async()=>{throw Error('database failed')}
  await assert.rejects(service.login({username:'alice.local',password:PASSWORD,ipAddress:'192.0.2.10'}),/database failed/)
  assert.equal(f.state.queryCount,0)
})
