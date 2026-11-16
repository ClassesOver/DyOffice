import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {s3Fixture} from '../helpers/s3.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'

for(const first of ['file','sheets'])test(`real scoped ${first} downloads retain one cross-route object budget`,{timeout:15000},async t=>{
 let paused=false,active=0,peak=0,enter,release
 const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);t.after(()=>release())
 const objectStore=process.env.DYOFFICE_TEST_RECLAMATION_STORE==='s3'?(await s3Fixture(t)).store:undefined
 const f=await fileFixture(t,{objectStore,sheetsNative:{inspect:async()=>({sheets:[]})},wrapObjects:store=>({...store,async readVerified(reference){
  active++;peak=Math.max(peak,active);if(paused&&active===2)enter()
  try{if(paused)await gate;return await store.readVerified(reference)}finally{active--}
 }})})
 const bytes=await readFile(new URL('../../../shell/build/shell-new/blank.xlsx',import.meta.url))
 const a=(await importFile(f,f.alice.token,bytes,'a.xlsx')).file,b=(await importFile(f,f.bob.token,bytes,'b.xlsx')).file,c=(await importFile(f,f.adminSigned.token,bytes,'c.xlsx')).file
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const request=(kind,user,file,extra={})=>f.app.inject(kind==='file'?{method:'GET',url:`/api/v1/files/${file.fileId}/content?revision=${file.revision}`,headers:{cookie:'__Host-dyoffice-session='+user.token,...extra}}:{method:'POST',url:`/api/v1/files/${file.fileId}/sheets/inspect`,payload:{revision:file.revision},headers:{origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+user.token,'x-csrf-token':csrf.sessionToken(user.token),...extra}})
 // Real RLS/service ownership rejection, before using the controlled I/O gate.
 assert.equal((await request('sheets',f.bob,a)).statusCode,404)
 paused=true;const calls=[request(first,f.alice,a),request(first,f.bob,b)]
 let third
 try{
  await ready
  assert.equal((await request('sheets',f.alice,a,{'x-csrf-token':'invalid'})).statusCode,403)
  third=await request(first==='file'?'sheets':'file',f.adminSigned,c)
  assert.equal(third.statusCode,503);assert.equal(peak,2)
 }finally{release();await Promise.all(calls)}
 assert.deepEqual((await Promise.all(calls)).map(r=>r.statusCode),[200,200])
 assert.equal((await request(first==='file'?'sheets':'file',f.adminSigned,c)).statusCode,200)
 assert.equal(peak,2)
})
