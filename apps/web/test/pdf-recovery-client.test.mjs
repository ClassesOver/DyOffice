import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createPdfRecoveryClient} from '../src/editors/pdf-recovery-client.ts'
const fileId='11111111-1111-4111-8111-111111111111',idempotencyKey='private-key'
const receipt={state:'committed',revision:{fileId,revision:'22222222-2222-4222-8222-222222222222',sha256:'a'.repeat(64),size:42}}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})
function setup(result=receipt){const calls=[];return {calls,client:createPdfRecoveryClient(async(url,options)=>{calls.push({url,options});return calls.length%2===1?json({csrfToken:'x'.repeat(43)}):typeof result==='function'?result():json(result)})}}
test('one explicit lookup obtains CSRF and posts key only in body with same-origin no-cache transport',async()=>{
 const {client,calls}=setup();assert.deepEqual(await client.lookup(fileId,idempotencyKey),receipt)
 assert.equal(calls.length,2);assert.equal(calls[0].url,'/api/v1/auth/csrf');assert.equal(calls[1].url,'/api/v1/pdf-recovery/lookup')
 for(const c of calls){assert.equal(c.options.credentials,'same-origin');assert.equal(c.options.cache,'no-store');assert.equal(c.options.redirect,'error');assert.equal(c.options.referrerPolicy,'no-referrer');assert.equal(c.url.includes(idempotencyKey),false)}
 assert.equal(calls[1].options.method,'POST');assert.equal(calls[1].options.headers['X-CSRF-Token'],'x'.repeat(43));assert.deepEqual(JSON.parse(calls[1].options.body),{fileId,idempotencyKey})
})
test('unresolved remains unresolved and never automatically replays',async()=>{const {client,calls}=setup({state:'unresolved'});assert.deepEqual(await client.lookup(fileId,idempotencyKey),{state:'unresolved'});await Promise.resolve();assert.equal(calls.length,2)})
test('invalid identifiers cause no network request',async()=>{const {client,calls}=setup();for(const args of [['bad',idempotencyKey],[fileId,'x'],[fileId,'x'.repeat(129)]])await assert.rejects(client.lookup(...args));assert.equal(calls.length,0)})
test('bad csrf prevents lookup and never leaks server body',async()=>{let calls=0;const client=createPdfRecoveryClient(async()=>{calls++;return json({csrfToken:'bad',secret:idempotencyKey})});await assert.rejects(client.lookup(fileId,idempotencyKey),e=>!e.message.includes(idempotencyKey));assert.equal(calls,1)})
test('network errors non-200 and malformed responses fail closed without retries',async()=>{
 for(const result of [()=>{throw new Error(idempotencyKey)},()=>json({secret:idempotencyKey},401),()=>json(receipt,202),()=>new Response('{',{headers:{'content-type':'application/json'}}),{state:'failed'},{state:'committed',revision:{...receipt.revision,fileId:receipt.revision.revision}},{state:'committed',revision:{...receipt.revision,size:-1}},{state:'unresolved',revision:receipt.revision}]){
 const {client,calls}=setup(result);await assert.rejects(client.lookup(fileId,idempotencyKey),e=>!e.message.includes(idempotencyKey));assert.equal(calls.length,2)
 }
})
test('only approved receipt fields survive and later explicit lookup rechecks authorization',async()=>{const {client,calls}=setup({...receipt,secret:idempotencyKey,revision:{...receipt.revision,token:'secret'}});assert.deepEqual(await client.lookup(fileId,idempotencyKey),receipt);assert.deepEqual(await client.lookup(fileId,idempotencyKey),receipt);assert.equal(calls.length,4)})
