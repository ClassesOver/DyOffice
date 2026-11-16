import test from 'node:test'
import assert from 'node:assert/strict'
import {createApiShell} from '../server/src/framework.ts'
import {registerFileRoutes} from '../server/src/modules/files/routes.ts'
import {registerSheetsRoutes} from '../server/src/modules/sheets/routes.ts'
import {createSheetsService} from '../server/src/modules/sheets/service.ts'
import {createSheetsSaveService} from '../server/src/modules/sheets/save.ts'
const id='11111111-1111-4111-8111-111111111111'
const headers={cookie:'__Host-dyoffice-session='+'a'.repeat(43)}
async function fixture({nativeError=false}={}){
 const app=await createApiShell();let active=0,peak=0,release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r)
 const download=async()=>{active++;peak=Math.max(peak,active);if(active===2)entered();await gate;active--;return {name:'a.xlsx',format:'xlsx',bytes:Buffer.from('fixture')}}
 const files={download,readFile:async()=>(await download()).bytes,openFile:async()=>({format:'xlsx',file:{revision:id}}),receiveUpload:async()=>{},cancelUpload:async()=>{}},sessions={authenticate:async token=>{if(!token)throw Object.assign(new Error('unauthorized'),{statusCode:401});return {}}},csrf={originCheck(){},requireSession(){}}
 const native={inspect:async()=>{if(nativeError)throw Error('failed native work');return {sheets:[]}},savePlan:async()=>({bytes:Buffer.from('saved')})}
 const saves=createSheetsSaveService({files,leases:{renewLease:async()=>{}},revisions:{stageUpload:async()=>({uploadId:id})},native,plan:async()=>({replaced:new Map(),added:new Map(),addedBinary:new Map(),removedEntries:[]})})
 registerFileRoutes(app,files,sessions,csrf);registerSheetsRoutes(app,createSheetsService({files,native}),sessions,csrf,saves);await app.ready()
 const get=()=>app.inject({method:'GET',url:`/api/v1/files/${id}/content?revision=${id}`,headers})
 const inspect=()=>app.inject({method:'POST',url:`/api/v1/files/${id}/sheets/inspect`,headers,payload:{revision:id}})
 const save=()=>app.inject({method:'POST',url:`/api/v1/files/${id}/sheets/uploads`,headers,payload:{baseRevision:id,leaseEpoch:1,editorId:id,request:{}}})
 return {app,get,inspect,save,ready,release,peak:()=>peak}
}
for(const first of ['file','sheets','save'])test(`${first} downloads share object admission with the other route group`,{timeout:5000},async()=>{
 const f=await fixture(),send=first==='file'?f.get:first==='save'?f.save:f.inspect,other=first==='file'?f.inspect:f.get
 const calls=[send(),send()];let third
 try{await f.ready;third=other();await new Promise(r=>setTimeout(r,30))}
 finally{f.release();await Promise.all(calls);await third}
 try{assert.equal(f.peak(),2);assert.equal((await third).statusCode,503);assert.equal((await other()).statusCode,200)}finally{await f.app.close()}
})

test('authorization schema and native failures release slots without granting extra capacity',async()=>{
 const f=await fixture({nativeError:true})
 try{
  for(let i=0;i<4;i++){
   assert.equal((await f.app.inject({method:'POST',url:`/api/v1/files/${id}/sheets/inspect`,payload:{revision:id}})).statusCode,401)
   assert.equal((await f.app.inject({method:'POST',url:`/api/v1/files/${id}/sheets/inspect`,headers,payload:{revision:'bad'}})).statusCode,400)
  }
  const calls=[f.inspect(),f.inspect()];await f.ready
  assert.equal((await f.get()).statusCode,503)
  f.release();assert.deepEqual((await Promise.all(calls)).map(r=>r.statusCode),[500,500])
  for(let i=0;i<4;i++)assert.equal((await f.get()).statusCode,200)
  assert.equal(f.peak(),2)
 }finally{f.release();await f.app.close()}
})

test('disconnected Sheets requests retain shared admission until object work ends',async()=>{
 const {request}=await import('node:http'),f=await fixture(),requests=[]
 const origin=await f.app.listen({host:'127.0.0.1',port:0})
 try{
  for(let i=0;i<2;i++){
   const r=request(`${origin}/api/v1/files/${id}/sheets/inspect`,{method:'POST',headers:{...headers,'content-type':'application/json'}})
   r.on('error',()=>{});r.end(JSON.stringify({revision:id}));requests.push(r)
  }
  await f.ready;requests.forEach(r=>r.destroy());await new Promise(r=>setTimeout(r,30))
  assert.equal((await f.get()).statusCode,503)
  f.release();await new Promise(r=>setTimeout(r,30))
  assert.equal((await f.get()).statusCode,200);assert.equal(f.peak(),2)
 }finally{f.release();requests.forEach(r=>r.destroy());await f.app.close()}
})

test('separate application instances do not consume each other object budget',async()=>{
 const a=await fixture(),b=await fixture();const calls=[a.get(),a.get(),b.get(),b.get()]
 try{await Promise.all([a.ready,b.ready]);assert.equal(a.peak(),2);assert.equal(b.peak(),2)}finally{a.release();b.release();await Promise.all(calls);await a.app.close();await b.app.close()}
})

test('a save queues for a bounded slot instead of starving behind concurrent reads',async()=>{
 const f=await fixture()
 try{
  const reads=[f.get(),f.inspect()];await f.ready
  const save=f.save()
  await new Promise(r=>setTimeout(r,30))
  f.release()
  const settled=await Promise.all([...reads,save])
  assert.equal(settled[0].statusCode,200);assert.equal(settled[1].statusCode,200)
  assert.equal(settled[2].statusCode,200)
 }finally{await f.app.close()}
})

test('bounded save-waiter queue still rejects immediate overload',async()=>{
 const f=await fixture()
 try{
  const reads=[f.get(),f.inspect()];await f.ready
  const saves=[f.save(),f.save(),f.save(),f.save()]
  await new Promise(r=>setTimeout(r,30))
  const overflow=await f.save()
  assert.equal(overflow.statusCode,503)
  f.release()
  const settled=await Promise.all([...reads,...saves])
  assert.equal(settled[0].statusCode,200);assert.equal(settled[1].statusCode,200)
  assert.deepEqual(settled.slice(2).map(r=>r.statusCode),[200,200,200,200])
 }finally{await f.app.close()}
})
