import test from 'node:test'
import assert from 'node:assert/strict'

test('runtime keyring is optional but supplied values must be canonical independent 32-byte keys',async()=>{
 const {parseConfigKeyring}=await import('../server/src/modules/admin/keyring-config.ts')
 assert.equal(parseConfigKeyring(undefined),undefined)
 const secret=Buffer.alloc(32,23).toString('base64')
 const ring=parseConfigKeyring(JSON.stringify({activeKeyId:'k2',keys:{k1:secret,k2:secret}}))
 assert.equal(ring.activeKeyId,'k2');assert.equal(ring.keys.k2.byteLength,32)
 for(const value of ['', '{', JSON.stringify({activeKeyId:'k1',keys:{k1:'SECRET-IN-ERROR'}}),JSON.stringify({activeKeyId:'missing',keys:{k1:secret}}),JSON.stringify({activeKeyId:'k1',keys:{k1:secret},password:'SECRET-IN-ERROR'})]) {
  assert.throws(()=>parseConfigKeyring(value),error=>error.message==='Invalid global configuration keyring')
 }
})
