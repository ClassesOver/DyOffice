import {EventEmitter} from 'node:events'
import {Readable} from 'node:stream'
import dns from 'node:dns/promises'
import https from 'node:https'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {grantProviderBudgetRuntime} from '../../server/src/modules/providers/budget.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
const keyring={activeKeyId:'k1',keys:{k1:new Uint8Array(32).fill(71)}}
const config=f=>({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:'https://office.example',csrfKey:f.csrfKey,globalConfigKeyring:keyring})
test('local probe explicit empty/missing prerequisites fail closed',async t=>{const f=await restrictedFixture(t);await assert.rejects(buildLocalApp({...config(f),adminProviderProbe:{profiles:[]}}));await assert.rejects(buildLocalApp({...config(f),businessPool:undefined,adminProviderProbe:{profiles:[]}}))})
test('default application leaves probe absent',async t=>{const f=await restrictedFixture(t);const r=await f.app.inject({url:'/api/v1/admin/ai-probe',headers:{cookie:'__Host-dyoffice-session='+f.adminSigned.token}});assert.equal(r.statusCode,404)})

function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function bounded(p,ms=2000){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Gate timeout")),ms)})]).finally(()=>clearTimeout(timer))}
function network(t,chunks=[],{secureGate,finishGate,upstreamError}={}){
 let writes=0,wire,header;const connected=deferred(),sent=deferred()
 t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}])
 t.mock.method(https,'request',(_url,options,callback)=>{
  const req=new EventEmitter();req.on('error',()=>{})
  req.setHeader=(name,value)=>{options.headers[name]=value;return req}
  req.destroy=e=>{queueMicrotask(()=>req.emit('error',e??Error('closed')));return req}
  req.end=body=>{writes++;wire=Buffer.from(body);header=options.headers.authorization;sent.resolve();const res=typeof chunks==='function'?chunks():Readable.from(chunks);res.statusCode=200;res.headers={'content-type':'text/event-stream'};queueMicrotask(()=>{if(!finishGate)req.emit('finish');if(upstreamError)req.emit('error',Error(upstreamError));else callback(res)});if(finishGate)finishGate.then(()=>req.emit('finish'));return req}
  queueMicrotask(()=>{const socket=new EventEmitter();Object.assign(socket,{authorized:true,remoteAddress:'8.8.8.8',remotePort:443,destroyed:false,writable:true});req.socket=socket;req.emit('socket',socket);connected.resolve();if(secureGate)secureGate.then(()=>socket.emit('secureConnect'));else socket.emit('secureConnect')})
  return req
 })
 return {connected:connected.promise,sent:sent.promise,get writes(){return writes},get wire(){return wire},get header(){return header}}
}

async function enabled(t,{closeDb}={}){
 const f=await restrictedFixture(t),settings=createGlobalConfigService({transactions:f.transactions,keyring})
 await settings.saveGlobalConfig(f.adminSigned.token,0,{upserts:[{id:'primary',kind:'chat',providerId:'openai',label:'Synthetic',model:'synthetic',baseUrl:'https://provider.example/v1',enabled:true,apiKey:'synthetic-probe-key'}]})
 await grantProviderBudgetRuntime(f.ownerPool,f.names.business)
 await f.ownerPool.query("INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,'primary',1,100,10)",[f.deploymentId,f.initial.id])
 const profile={deploymentId:f.deploymentId,entryId:'primary',revision:1,providerId:'openai',model:'synthetic',baseUrl:'https://provider.example/v1',endpoint:'https://provider.example/v1/chat/completions',allowedIpv4:['8.8.8.8'],maxOutputTokens:128}
 const app=await buildLocalApp({...config(f),adminProviderProbe:{profiles:[profile]},closeDb})
 f.cleanup.push(()=>app.close())
 await app.listen({host:'127.0.0.1',port:0});const address=app.server.address(),url='http://127.0.0.1:'+address.port
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:'https://office.example',key:f.csrfKey})
 const headers={cookie:'__Host-dyoffice-session='+f.adminSigned.token,'x-csrf-token':csrf.sessionToken(f.adminSigned.token),origin:'https://office.example','content-type':'application/json'}
 return {...f,probeApp:app,url,headers,settings}
}
const success=[Buffer.from('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')]
test('actual local app and real loopback HTTP send only synthetic body and settle once',{timeout:10000},async t=>{
 const n=network(t,success),f=await enabled(t),body={turnId:'test-turn',modelId:'primary',scenario:'hello'}
 const r=await fetch(f.url+'/api/v1/admin/ai-probe/turns',{method:'POST',headers:f.headers,body:JSON.stringify(body)})
 assert.equal(r.status,200);const output=await r.text();assert.match(output,/event: delta/);assert.match(output,/event: done/);assert.doesNotMatch(output,/synthetic-probe-key/)
 assert.equal(n.writes,1);assert.equal(JSON.parse(n.wire).messages[1].content,'Synthetic hello probe.');assert.equal(JSON.parse(n.wire).tools,undefined)
 assert.equal((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0].state,'settled')
 await (await fetch(f.url+'/api/v1/admin/ai-probe/turns',{method:'POST',headers:f.headers,body:JSON.stringify(body)})).text();assert.equal(n.writes,1)
 const status=await (await fetch(f.url+'/api/v1/admin/ai-probe',{headers:f.headers})).json();assert.deepEqual(status,{experimental:true,entries:[{id:'primary',label:'primary'}]})
 await f.settings.saveGlobalConfig(f.adminSigned.token,1,{upserts:[{id:'primary',kind:'chat',providerId:'openai',label:'Synthetic',model:'synthetic',baseUrl:'https://provider.example/v1',enabled:false}]})
 assert.deepEqual((await (await fetch(f.url+'/api/v1/admin/ai-probe',{headers:f.headers})).json()).entries,[])
})
test('preClose aborts stalled upstream before DB close and no late dispatch',{timeout:10000},async t=>{
 let response,dbClosed=false;const n=network(t,()=>{response=new Readable({read(){}});response.push(Buffer.from('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'));return response})
 const f=await enabled(t,{closeDb:async()=>{assert.equal(response.destroyed,true);dbClosed=true}})
 const r=await fetch(f.url+'/api/v1/admin/ai-probe/turns',{method:'POST',headers:f.headers,body:JSON.stringify({turnId:'closing',modelId:'primary',scenario:'hello'})})
 const text=r.text();await bounded(f.probeApp.close(),4000);await text;assert.equal(dbClosed,true);assert.equal(n.writes,1)
 assert.equal((await f.ownerPool.query('SELECT state FROM provider_budget_reservations')).rows[0].state,'unknown')
})
test('real app member, missing csrf, free-form fields and revoked session never dispatch',async t=>{
 const n=network(t,success),f=await enabled(t),body={turnId:'denied',modelId:'primary',scenario:'hello'}
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:'https://office.example',key:f.csrfKey})
 const member={...f.headers,cookie:'__Host-dyoffice-session='+f.alice.token,'x-csrf-token':csrf.sessionToken(f.alice.token)}
 for(const [payload,headers] of [[body,member],[body,{cookie:f.headers.cookie,origin:f.headers.origin,'content-type':'application/json'}],[{...body,text:'private'},f.headers]]){
  const r=await fetch(f.url+'/api/v1/admin/ai-probe/turns',{method:'POST',headers,body:JSON.stringify(payload)});assert.ok(r.status>=400);await r.text()
 }
 await f.authPool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[f.adminSigned.sessionId])
 const r=await fetch(f.url+'/api/v1/admin/ai-probe/turns',{method:'POST',headers:f.headers,body:JSON.stringify(body)});assert.equal(r.status,401);await r.text()
 assert.equal(n.writes,0);assert.equal((await f.ownerPool.query('SELECT 1 FROM provider_budget_reservations')).rowCount,0)
})
test('browser probe controller over actual HTTP completes synthetic response exactly once',async t=>{
 const {createAdminAiProbeController}=await import('../../../../packages/browser-host/src/ai-probe.ts')
 const n=network(t,success),f=await enabled(t);let done=0,error,text=''
 const client=createAdminAiProbeController({getCsrfToken:async()=>f.headers['x-csrf-token'],createTurnId:()=> 'browser-probe',fetchImpl:(url,options)=>fetch(f.url+url,{...options,headers:{...options.headers,cookie:f.headers.cookie,origin:f.headers.origin}})})
 t.after(()=>client.dispose());assert.equal((await client.status()).entries[0].id,'primary')
 await bounded(new Promise(resolve=>client.run('primary',{onDelta:s=>text+=s,onError:e=>error=e,onDone:()=>{done++;resolve()}})))
 assert.equal(error,undefined);assert.equal(text,'OK');assert.equal(done,1);assert.equal(n.writes,1)
})
