import {test} from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerPdfRecoveryRoutes} from '../../server/src/pdf/recovery-routes.mjs'
import {SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'

// Transport boundary only: authentication and receipt adapter are stubbed here.
// Actual sessions, CSRF, PostgreSQL and local objects are in pdf-recovery-http.test.
const fileId='11111111-1111-4111-8111-111111111111'
const revision={fileId,revision:'22222222-2222-4222-8222-222222222222',sha256:'a'.repeat(64),size:42}
async function fixture(t,result){
 const app=Fastify({logger:false,ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}})
 let lookups=0
 registerPdfRecoveryRoutes(app,{sessions:{authenticate:async()=>{}},csrf:{requireSession(){}},createRequestRecovery:()=>({lookup:async()=>{lookups++;return result}})})
 t.after(()=>app.close())
 const address=await app.listen({host:'127.0.0.1',port:0})
 return {get lookups(){return lookups},async post(raw=JSON.stringify({fileId,idempotencyKey:'private-key'})){
  const r=await fetch(address+'/api/v1/pdf-recovery/lookup',{method:'POST',headers:{cookie:`${SESSION_COOKIE}=${'x'.repeat(43)}`,'content-type':'application/json'},body:raw})
  return {status:r.status,headers:r.headers,json:await r.json()}
 }}
}
test('malformed and oversized HTTP bodies fail closed without adapter calls',async t=>{
 const f=await fixture(t,{state:'unresolved'})
 for(const [raw,status] of [['{',400],[' '.repeat(1025),413]]){
  const r=await f.post(raw);assert.equal(r.status,status)
  assert.deepEqual(r.json,{error:'PDF_RECEIPT_LOOKUP_FAILED'})
  assert.equal(r.headers.get('cache-control'),'private, no-store')
  assert.equal(r.headers.get('referrer-policy'),'no-referrer')
 }
 assert.equal(f.lookups,0)
})
test('HTTP projects a valid receipt and never returns adapter-only sensitive fields',async t=>{
 const f=await fixture(t,{state:'committed',secret:'private-key',revision:{...revision,token:'synthetic-token'}})
 assert.deepEqual((await f.post()).json,{state:'committed',revision})
})
test('HTTP rejects wrong-file malformed and unknown adapter receipts',async t=>{
 for(const result of [{state:'committed',revision:{...revision,fileId:revision.revision}},{state:'committed',revision:{...revision,size:-1}},{state:'failed',secret:'private-key'}]){
  const f=await fixture(t,result),r=await f.post()
  assert.equal(r.status,500);assert.deepEqual(r.json,{error:'PDF_RECEIPT_LOOKUP_FAILED'})
  assert.equal(r.headers.get('cache-control'),'private, no-store')
 }
})
