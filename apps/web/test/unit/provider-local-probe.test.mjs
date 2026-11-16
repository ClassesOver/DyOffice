import test from 'node:test'
import assert from 'node:assert/strict'
import {createApiShell} from '../../server/src/framework.ts'
const module=await import('../../server/src/modules/providers/local-probe.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e})
async function fixture(t){
 assert.equal(typeof module.registerLocalProviderProbe,'function')
 const app=await createApiShell(),calls=[]
 const sessions={authenticate:async token=>{if(!token)throw Object.assign(Error(),{statusCode:401});return {roles:token==='a'.repeat(43)?['config_admin']:[]}}}
 const csrf={requireSession:r=>{if(r.headers['x-csrf-token']!=='proof')throw Object.assign(Error(),{statusCode:403})}}
 module.registerLocalProviderProbe(app,{sessions,csrf,pipeline:{turns:{run:async(input,emit)=>{calls.push(input);await emit({type:'delta',text:'ok'})},cancel:async()=>true},catalog:async()=>[{id:'primary',label:'Synthetic'}]}})
 await app.ready();t.after(()=>app.close());return {app,calls}
}
const path='/api/v1/admin/ai-probe/turns',headers={cookie:'__Host-dyoffice-session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','x-csrf-token':'proof'},body={modelId:'primary',turnId:'turn1',scenario:'hello'}
test('probe routes construct only fixed synthetic messages',async t=>{const {app,calls}=await fixture(t);const r=await app.inject({method:'POST',url:path,headers,payload:body});assert.equal(r.statusCode,200);assert.match(r.body,/event: done/);assert.equal(calls.length,1);assert.deepEqual(calls[0].request.tools,[]);assert.match(calls[0].request.system,/synthetic/i);assert.equal('scenario' in calls[0],false)})
test('probe denies extra input, member, absent csrf before dispatch',async t=>{const {app,calls}=await fixture(t);for(const [payload,h]of[[{...body,request:{messages:['private']}},headers],[body,{...headers,cookie:'__Host-dyoffice-session=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}],[body,{cookie:headers.cookie}]]){const r=await app.inject({method:'POST',url:path,headers:h,payload});assert.ok(r.statusCode>=400)}assert.equal(calls.length,0)})
test('probe status is admin-only no-store and generic endpoint absent',async t=>{const {app}=await fixture(t);const r=await app.inject({url:'/api/v1/admin/ai-probe',headers});assert.equal(r.statusCode,200);assert.match(r.headers['cache-control'],/no-store/);assert.deepEqual(r.json(),{experimental:true,entries:[{id:'primary',label:'Synthetic'}]});assert.equal((await app.inject({url:'/api/v1/admin/ai-probe'})).statusCode,401);assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload:body})).statusCode,404)})
