import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiShell } from '../server/src/framework.ts'
import { registerFileRoutes } from '../server/src/modules/files/routes.ts'
const id='00000000-0000-0000-0000-000000000001'
test('finish object verification shares bounded transfer admission and releases on completion', async () => {
 const app=await createApiShell(); let active=0,peak=0,release; const gate=new Promise(r=>release=r)
 registerFileRoutes(app,{finishUpload:async()=>{active++;peak=Math.max(peak,active);await gate;active--;return {ok:true}}},{authenticate:async()=>({})},{originCheck(){},requireSession(){}})
 await app.ready()
 const request=i=>app.inject({method:'POST',url:`/api/v1/uploads/${id}/finish`,headers:{cookie:'__Host-dyoffice-session='+String.fromCharCode(97+i).repeat(43)}})
 const calls=Array.from({length:5},(_,i)=>request(i).then(r=>r.statusCode))
 try { await new Promise(r=>setTimeout(r,50)); assert.equal(peak,2) }
 finally { release(); const statuses=await Promise.all(calls); await app.close(); assert.deepEqual(statuses,[200,200,503,503,503]) }
})
test('disconnected finish retains admission while object work is still pending',async()=>{
 const {request}=await import('node:http');const app=await createApiShell();let started=0,release;const gate=new Promise(r=>release=r)
 registerFileRoutes(app,{finishUpload:async()=>{started++;await gate;return {ok:true}}},{authenticate:async()=>({})},{originCheck(){},requireSession(){}})
 const origin=await app.listen({host:'127.0.0.1',port:0});const reqs=[]
 try {
 for(let i=0;i<2;i++){const req=request(`${origin}/api/v1/uploads/${id}/finish`,{method:'POST',headers:{cookie:'__Host-dyoffice-session='+String.fromCharCode(97+i).repeat(43)}});req.on('error',()=>{});req.end();reqs.push(req)}
 for(let i=0;i<100&&started<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(started,2)
 reqs.forEach(r=>r.destroy());await new Promise(r=>setTimeout(r,20))
 const third=await app.inject({method:'POST',url:`/api/v1/uploads/${id}/finish`,headers:{cookie:'__Host-dyoffice-session='+'c'.repeat(43)}});assert.equal(third.statusCode,503)
 release();await new Promise(r=>setTimeout(r,20));const fourth=await app.inject({method:'POST',url:`/api/v1/uploads/${id}/finish`,headers:{cookie:'__Host-dyoffice-session='+'d'.repeat(43)}});assert.equal(fourth.statusCode,200)
 }finally{release();reqs.forEach(r=>r.destroy());await app.close()}
})
