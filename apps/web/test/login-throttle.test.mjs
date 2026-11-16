import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createPgLoginThrottle } from '../server/auth/login-throttle.mjs'

const deploymentId=randomUUID()
const hmacKey=randomBytes(32)
const limits={global:{maxAttempts:12,windowMs:60_000},ip:{maxAttempts:5,windowMs:60_000},account:{maxAttempts:2,windowMs:60_000}}
function fixture() {
  const persisted = new Map(), seen=[]
  let released=0
  const pool={seen,persisted,get released(){return released},async connect(){
    let pending
    return {async query(sql,params){seen.push({sql,params});if(sql==='BEGIN'){pending=new Map(persisted);return{rows:[]}}
      if(sql==='COMMIT'){persisted.clear();for(const [k,v] of pending)persisted.set(k,v);return {rows:[]}}
      if(sql==='ROLLBACK')return{rows:[]}
      if(!sql.startsWith('INSERT INTO dyoffice_login_rate_buckets'))throw Error('Unknown query')
      const key=params[0].toString('hex')
      const attempts=(pending.get(key)||0)+1
      pending.set(key,attempts)
      return{rowCount:1,rows:[{attempts}]}
    },release(){released++}}
  }}
  return pool
}

test('shared PostgreSQL throttle budgets account independently and never persists plaintext username/IP',async()=>{
  const pool=fixture()
  const throttle=createPgLoginThrottle({pool,hmacKey,limits})
  const input={deploymentId,usernameNormalized:'alice.local',ipAddress:'192.0.2.5'}
  assert.deepEqual(await throttle.consume(input),{allowed:true})
  assert.deepEqual(await throttle.consume(input),{allowed:true})
  assert.deepEqual(await throttle.consume(input),{allowed:false})
  assert.equal(pool.persisted.size,3)
  assert.equal(pool.released,3)
  const serialized=JSON.stringify(pool.seen.map(x=>x.params))
  assert.equal(serialized.includes('alice.local'),false)
  assert.equal(serialized.includes('192.0.2.5'),false)
  assert.ok(pool.seen.filter(x=>x.sql==='BEGIN').length===3)
  assert.ok(pool.seen.filter(x=>x.sql==='COMMIT').length===3)
  const queries=pool.seen.filter(x=>x.sql.startsWith('INSERT'))
  assert.equal(queries.length,9)
  for(const {params} of queries){assert.equal(params[0].length,32)}
})

test('same account across IPs still shares the account budget',async()=>{
  const pool=fixture(),throttle=createPgLoginThrottle({pool,hmacKey,limits})
  for(const ip of ['192.0.2.5','192.0.2.6','192.0.2.7']) {
    const answer=await throttle.consume({deploymentId,usernameNormalized:'alice.local',ipAddress:ip})
    assert.equal(answer.allowed,ip!=='192.0.2.7')
  }
})

test('invalid parameters and unavailable database reject without fail-open',async()=>{
  const pool=fixture()
  assert.throws(()=>createPgLoginThrottle({pool,hmacKey:Buffer.alloc(8)}),TypeError)
  assert.throws(()=>createPgLoginThrottle({pool,hmacKey,limits:{...limits,account:{maxAttempts:0,windowMs:1000}}}),TypeError)
  const throttle=createPgLoginThrottle({pool,hmacKey,limits})
  await assert.rejects(throttle.consume({deploymentId,usernameNormalized:'alice',ipAddress:'spoofed-ip'}),TypeError)
  const bad={connect:async()=>({async query(sql){if(sql==='BEGIN')return;throw Error('DB down')},release(){}})}
  const unavailable=createPgLoginThrottle({pool:bad,hmacKey,limits})
  await assert.rejects(unavailable.consume({deploymentId,usernameNormalized:'alice',ipAddress:'192.0.2.10'}),/Login throttle unavailable/)
})

test('IPv6 clients share one IP budget per /64 and mapped IPv4 shares the IPv4 budget',async()=>{
  const pool=fixture(),throttle=createPgLoginThrottle({pool,hmacKey,limits})
  // Distinct accounts so only the per-IP budget (5) can deny.
  const sameNet=['2001:db8:1:2::1','2001:db8:1:2::2','2001:DB8:1:2:ffff::9','2001:0db8:0001:0002:0:0:0:3','2001:db8:1:2:a:b:c:d','2001:db8:1:2::77']
  const answers=[]
  for(const [i,ip] of sameNet.entries()) answers.push((await throttle.consume({deploymentId,usernameNormalized:'user'+i,ipAddress:ip})).allowed)
  assert.deepEqual(answers,[true,true,true,true,true,false])
  assert.equal((await throttle.consume({deploymentId,usernameNormalized:'other1',ipAddress:'2001:db8:1:3::1'})).allowed,true,'another /64 has its own budget')
  const mapped=[]
  for(const [i,ip] of ['198.51.100.7','::ffff:198.51.100.7','::FFFF:198.51.100.7','198.51.100.7','::ffff:c633:6407','198.51.100.7'].entries()) {
    mapped.push((await throttle.consume({deploymentId,usernameNormalized:'mapped'+i,ipAddress:ip})).allowed)
  }
  assert.deepEqual(mapped,[true,true,true,true,true,false])
})
