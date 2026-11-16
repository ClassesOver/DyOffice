import test from 'node:test'
import assert from 'node:assert/strict'
import {createApiShell} from '../../server/src/framework.ts'
import {registerAdminProviderAssembly} from '../../server/src/modules/providers/assembly.ts'
const headers={cookie:'__Host-dyoffice-session='+'a'.repeat(43)}
const payload={turnId:'turn',modelId:'model',request:{system:'',messages:[],tools:[]}}
const security={sessions:{authenticate:async()=>{}},csrf:{requireSession(){}}}
test('absent/false activation registers no routes and never touches dependencies',async()=>{
 for(const config of [undefined,{enabled:false,get keyring(){throw Error('secret accessed')}}]) {
  const app=await createApiShell()
  registerAdminProviderAssembly(app,config)
  const r=await app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload})
  assert.equal(r.statusCode,404);await app.close()
 }
})
test('nonboolean activation fails closed instead of enabling by truthiness',async()=>{
 for(const enabled of ['true',1,null,{},[]]){
  const app=await createApiShell()
  assert.throws(()=>registerAdminProviderAssembly(app,{enabled}),/Invalid AI assembly/)
  await app.close()
 }
})
test('enabled assembly rejects incomplete dependencies without leaking detail',async()=>{
 const app=await createApiShell()
 assert.throws(()=>registerAdminProviderAssembly(app,{enabled:true,...security}),/Invalid AI assembly/)
 await app.close()
})
test('enabled assembly uses existing admin-only coordinator and session/CSRF gates',async()=>{
 let db=0,auth=0,csrf=0
 const app=await createApiShell()
 const handle=registerAdminProviderAssembly(app,{enabled:true,keyring:{activeKeyId:'test',keys:{test:Buffer.alloc(32,7)}},profiles:[],transactions:{withPrincipalTransaction:async(_a,fn)=>{db++;return fn({}, {roles:[],deploymentId:'d',userId:'u',sessionId:'s'})}},sessions:{authenticate:async()=>{auth++}},csrf:{requireSession(){csrf++}}})
 let r=await app.inject({method:'POST',url:'/api/v1/ai/turns',payload})
 assert.equal(r.statusCode,401);assert.equal(db,0)
 r=await app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload})
 assert.equal(r.statusCode,200);assert.match(r.body,/event: error/);assert.doesNotMatch(r.body,/event: delta/)
 assert.equal(auth,1);assert.equal(csrf,1);assert.equal(db,1)
 handle.dispose();handle.dispose()
 await app.close()
})
test('preClose revokes the pipeline before waiting for streams, onClose is idempotent',async()=>{
 const app=await createApiShell(), hooks={}
 const addHook=app.addHook.bind(app)
 app.addHook=(name,fn)=>{if(['preClose','onClose'].includes(name))hooks[name]=fn;return addHook(name,fn)}
 let queries=0
 registerAdminProviderAssembly(app,{enabled:true,...security,keyring:{activeKeyId:'test',keys:{test:Buffer.alloc(32,7)}},profiles:[],transactions:{withPrincipalTransaction:async(_a,fn)=>fn({query:async()=>{queries++;return {rows:[{authorized:true}]}}},{roles:['config_admin'],deploymentId:'d',userId:'u',sessionId:'s'})}})
 const send=()=>app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload})
 assert.match((await send()).body,/event: error/);assert.ok(queries>0)
 const before=queries
 assert.equal(typeof hooks.preClose,'function');assert.equal(typeof hooks.onClose,'function')
 await hooks.preClose()
 assert.ok((await send()).statusCode>=400);assert.equal(queries,before)
 await hooks.onClose();await app.close()
})
test('instances are isolated: disposing one does not disable another',async()=>{
 let queries=0
 const make=async()=>{
  const app=await createApiShell()
  const handle=registerAdminProviderAssembly(app,{enabled:true,...security,keyring:{activeKeyId:'test',keys:{test:Buffer.alloc(32,7)}},profiles:[],transactions:{withPrincipalTransaction:async(_a,fn)=>fn({query:async()=>{queries++;return {rows:[{authorized:true}]}}},{roles:['config_admin'],deploymentId:'d',userId:'u',sessionId:'s'})}})
  return {app,handle}
 }
 const a=await make(),b=await make();a.handle.dispose()
 await a.app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload});assert.equal(queries,0)
 await b.app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload});assert.ok(queries>0)
 await a.app.close();await b.app.close()
})
for(const stage of ['identity','authorization']) test(`real app.close promptly ends SSE during pending ${stage} without waiting for DB`,async()=>{
 let release,entered;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r)
 let calls=0,queries=0
 const app=await createApiShell()
 registerAdminProviderAssembly(app,{enabled:true,...security,timeoutMs:5000,keyring:{activeKeyId:'test',keys:{test:Buffer.alloc(32,7)}},profiles:[],transactions:{withPrincipalTransaction:async(_a,fn)=>{
  calls++;if(calls===(stage==='identity'?1:2)){entered();await blocked}
  return fn({query:async()=>{queries++;return {rows:[{authorized:true}]}}},{roles:['config_admin'],deploymentId:'d',userId:'u',sessionId:'s'})
 }}})
 const response=app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload}).then(r=>r)
 await started
 let timer
 try {
  await Promise.race([Promise.all([app.close(),response]),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('close waited for blocked authorization')),300))])
  const r=await response;assert.match(r.body,/event: error/);assert.equal(queries,0)
 } finally {clearTimeout(timer);release();await response;await app.close()}
 assert.equal(queries,0)
})
test('real listening socket closes promptly during pending HTTP session authentication',async()=>{
 const {request}=await import('node:http')
 let release,entered,queries=0
 const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r)
 const app=await createApiShell()
 registerAdminProviderAssembly(app,{enabled:true,csrf:security.csrf,sessions:{authenticate:async()=>{entered();await blocked;return {}}},timeoutMs:5000,keyring:{activeKeyId:'test',keys:{test:Buffer.alloc(32,7)}},profiles:[],transactions:{withPrincipalTransaction:async()=>{queries++;throw Error('unexpected')}}})
 const address=await app.listen({host:'127.0.0.1',port:0})
 const result=new Promise((resolve,reject)=>{
  const req=request(address+'/api/v1/ai/turns',{method:'POST',agent:false,headers:{...headers,'content-type':'application/json'}},res=>{
   let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}))
  });req.on('error',reject);req.end(JSON.stringify(payload))
 })
 await started
 let timer
 try{
  const [,r]=await Promise.race([Promise.all([app.close(),result]),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('socket close waited for authentication')),500))])
  assert.ok(r.status>=400);assert.equal(queries,0)
 } finally {clearTimeout(timer);release();await result;await app.close()}
 assert.equal(queries,0)
})
test('successful and failed HTTP authentication release shutdown subscriptions on every request',async t=>{
 const subscriptions=new Set(),originalAdd=Set.prototype.add
 t.mock.method(Set.prototype,'add',function(value){
  if(typeof value==='function' && new Error().stack?.includes('/providers/assembly.ts:')) originalAdd.call(subscriptions,this)
  return originalAdd.call(this,value)
 })
 let failed=false
 const app=await createApiShell()
 registerAdminProviderAssembly(app,{enabled:true,csrf:security.csrf,sessions:{authenticate:async()=>{if(failed)throw Error('synthetic failure')}},keyring:{activeKeyId:'test',keys:{test:Buffer.alloc(32,7)}},profiles:[],transactions:{withPrincipalTransaction:async()=>{throw Error('denied')}}})
 for(let i=0;i<40;i++){
  failed=i%2===1
  await app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload})
  assert.equal(subscriptions.size,1,'assembly must use removable shutdown subscriptions')
  assert.equal([...subscriptions][0].size,0,'completed authentication must remove its shutdown callback')
 }
 await app.close();assert.equal([...subscriptions][0].size,0)
})
