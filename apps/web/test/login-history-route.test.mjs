import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createApiShell} from '../server/src/framework.ts'
import {registerAuthRoutes} from '../server/src/modules/auth/routes.ts'
const token='a'.repeat(43), url='/api/v1/auth/login-history'
async function fixture(t){
 const app=await createApiShell(),calls=[]; t.after(()=>app.close())
 registerAuthRoutes(app,{sessions:{async loginHistory(value){calls.push(value);if(value!==token)throw Object.assign(Error('Authentication failed'),{statusCode:401});return [{occurredAt:'2026-01-01T00:00:00.000Z',outcome:'success'}]}},csrf:{},users:{},throttle:{}})
 return {app,calls,headers:{cookie:'__Host-dyoffice-session='+token}}
}
test('login history is current-cookie only, no-store and has no credential cookie mutation',async t=>{
 const {app,calls,headers}=await fixture(t),r=await app.inject({method:'GET',url,headers})
 assert.equal(r.statusCode,200);assert.deepEqual(r.json(),{events:[{occurredAt:'2026-01-01T00:00:00.000Z',outcome:'success'}]});assert.deepEqual(calls,[token]);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['set-cookie'],undefined)
})
test('login history rejects client owner, account hash, deployment and pagination selectors',async t=>{
 const {app,calls,headers}=await fixture(t)
 for(const key of ['userId','ownerId','accountKey','deploymentId','limit','cursor'])assert.equal((await app.inject({method:'GET',url:url+'?'+key+'=other',headers})).statusCode,400)
 assert.deepEqual(calls,[])
})
test('login history without valid current credential is unauthorized',async t=>{
 const {app}=await fixture(t)
 for(const cookie of ['', '__Host-dyoffice-session=invalid'])assert.equal((await app.inject({method:'GET',url,headers:{cookie}})).statusCode,401)
})
