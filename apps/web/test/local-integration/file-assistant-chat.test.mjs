import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { docxBytes, fileFixture, importFile } from '../helpers/files.mjs'
import { password } from '../helpers/identity.mjs'
import { restrictedOrigin as origin } from '../helpers/restricted.mjs'
import { createCsrfService, SESSION_COOKIE } from '../../server/src/modules/auth/csrf.ts'

test('two authenticated sessions share a file conversation without replaying, reordering, or leaking other conversations',async t=>{
  const f=await fileFixture(t),bytes=await docxBytes()
  const {file:{fileId}}=await importFile(f,f.alice.token,bytes)
  const {file:{fileId:another}}=await importFile(f,f.alice.token,bytes)
  const peer=(await f.sessions.login('alice',password)).token
  const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin,key:f.csrfKey})
  const post=(token,body,id=fileId,proof=csrf.sessionToken(token))=>f.app.inject({method:'POST',url:'/api/v1/files/'+id+'/assistant-chat',
    headers:{origin,cookie:SESSION_COOKIE+'='+token,'x-csrf-token':proof},payload:body})
  const turnId=randomUUID(),question={turnId,role:'user',sender:'dsh',text:'Hello',seq:0,state:'done'}
  const assistant={turnId,role:'assistant',text:'Working',seq:0,state:'streaming'}
  assert.equal((await post(f.alice.token,{updates:[question]},fileId,'invalid')).statusCode,403)
  assert.equal((await post(f.bob.token,{})).statusCode,404)
  assert.equal((await post(f.alice.token,{updates:[{...assistant,sender:'dsh'}]})).statusCode,400)
  assert.equal((await post(f.alice.token,{updates:[{...assistant,toolArguments:{private:true}}]})).statusCode,400)
  const sent=await post(f.alice.token,{updates:[question,assistant]})
  assert.equal(sent.statusCode,200)
  const first=(await post(peer,{})).json()
  assert.deepEqual(first,sent.json())
  assert.deepEqual(first.messages.map(m=>m.role),['user','assistant'])
  assert.equal(first.messages[0].sender,'dsh')
  assert.equal((await post(peer,{},another)).json().messages.length,0)
  const final={...assistant,text:'Done',seq:2,state:'done'}
  const [one,two]=await Promise.all([post(f.alice.token,{updates:[final]}),post(peer,{updates:[{...assistant,seq:1,text:'Thinking'}]})])
  assert.equal(one.statusCode,200);assert.equal(two.statusCode,200)
  const delta=(await post(peer,{after:first.cursor})).json()
  assert.deepEqual(delta.messages,[{...final,order:first.messages[1].order}])
  assert.deepEqual((await post(peer,{after:delta.cursor,updates:[question,final,{...assistant,seq:8}]})).json(),{cursor:delta.cursor,hasMore:false,messages:[]})
  for(let i=0;i<4;i++)await post(f.alice.token,{updates:Array.from({length:8},()=>({...question,turnId:randomUUID()}))})
  const page1=(await post(peer,{})).json(),page2=(await post(peer,{after:page1.cursor})).json()
  assert.equal(page1.hasMore,true);assert.equal(page2.hasMore,false)
  assert.equal(new Set([...page1.messages,...page2.messages].map(m=>m.order)).size,34)
  await f.files.trashFile(f.alice.token,fileId)
  assert.equal((await post(peer,{})).statusCode,404)
  await f.files.purgeFile(f.alice.token,fileId)
  assert.equal((await post(peer,{})).statusCode,404)
})
