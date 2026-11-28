import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createSheetsService} from '../../server/src/modules/sheets/service.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createCsrfService,SESSION_COOKIE} from '../../server/src/modules/auth/csrf.ts'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import officeCrypto from 'officecrypto-tool'
import {password as accountPassword} from '../helpers/identity.mjs'
const bytes=()=>readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
test('encrypted workbook queries require the current unlock before fetching and returning data',{timeout:60000},async t=>{
 const plain=await bytes(),password='Workbook query fixture',source='https://data.example.test/table.csv'
 let reads=0,fetches=0,entered,release
 const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
 const table={headers:['Price'],rows:[['42']]}
 const f=await fileFixture(t,{
  sheetsNative:{},
  async sheetsPackageReader(input,_signal,query){
   assert.deepEqual(input,plain)
   assert.deepEqual(query,{webQuery:'7'})
   reads++
   return {source}
  },
  async sheetsQueryFetcher(url){
   assert.equal(url,source)
   if(++fetches===2){entered();await gate}
   return table
  },
 })
 const encrypted=Buffer.from(officeCrypto.encrypt(plain,{password})),token=f.alice.token
 const upload=await f.files.stageUpload(token,{name:'Query.xlsx',size:encrypted.length})
 await f.files.receiveUpload(token,upload.uploadId,encrypted,{password})
 const {file}=await f.files.finishUpload(token,upload.uploadId)
 const leases=createLeaseService({transactions:f.transactions}),editorId=randomUUID()
 let authority=await leases.acquireLease(token,file.fileId,{editorId})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const request=(path,payload,unlockId,login=token)=>f.app.inject({
  method:'POST',url:`/api/v1/files/${file.fileId}/sheets/${path}`,payload,
  headers:{origin:restrictedOrigin,cookie:`${SESSION_COOKIE}=${login}`,'x-csrf-token':csrf.sessionToken(login),
   ...(unlockId?{'x-dyoffice-workbook-unlock':unlockId}:{})},
 })
 const query=(unlockId,login)=>request('web-query',{
  revision:file.revision,connectionId:'7',editorId:authority.editorId,leaseEpoch:authority.leaseEpoch,
 },unlockId,login)
 const unlocked=await request('unlock',{revision:file.revision,password})
 assert.equal(unlocked.statusCode,200,unlocked.body)
 const {unlockId}=unlocked.json()
 const otherLogin=(await f.sessions.login('alice',accountPassword)).token
 for(const response of [await query(),await query(randomUUID())])assert.equal(response.statusCode,423,response.body)
 authority=await leases.takeoverLease(otherLogin,file.fileId,{editorId:randomUUID(),expectedEpoch:authority.leaseEpoch})
 const wrongLogin=await query(unlockId,otherLogin)
 assert.equal(wrongLogin.statusCode,423,wrongLogin.body)
 authority=await leases.takeoverLease(token,file.fileId,{editorId,expectedEpoch:authority.leaseEpoch})
 assert.equal(reads,0)
 assert.equal(fetches,0)
 const refreshed=await query(unlockId)
 assert.equal(refreshed.statusCode,200,refreshed.body)
 assert.deepEqual(refreshed.json(),table)
 const pending=query(unlockId)
 await started
 try{
  assert.equal((await request('lock',{revision:file.revision,unlockId})).statusCode,200)
 }finally{release()}
 assert.equal((await pending).statusCode,423)
 assert.equal(reads,2)
 assert.equal(fetches,2)
 assert.deepEqual(await f.files.readFile(token,file.fileId,file.revision),encrypted)
})

test('password unlock gates native reads to the current workbook revision and login session',async t=>{
 const f=await fileFixture(t),plain=await bytes(),password='工作簿密码 fixture',encrypted=Buffer.from(officeCrypto.encrypt(plain,{password}))
 const staged=await f.files.stageUpload(f.alice.token,{name:'locked.xlsx',size:encrypted.length})
 await f.files.receiveUpload(f.alice.token,staged.uploadId,encrypted,{password})
 const {file}=await f.files.finishUpload(f.alice.token,staged.uploadId)
 const {fileId,revision}=file,owner=f.alice.token,otherLogin=(await f.sessions.login('alice',accountPassword)).token
 let reads=0
 const service=createSheetsService({files:f.files,native:{
  async inspect(actual){reads++;assert.deepEqual(actual,plain);return {sheets:[{id:'1',name:'Acceptance'}]}},
  async readRange(actual){reads++;assert.deepEqual(actual,plain);return {cells:[{row:0,column:0,value:'Title'}]}},
 }})
 await assert.rejects(service.inspect(owner,fileId,revision),{statusCode:423})
 await assert.rejects(service.unlockWorkbook(owner,fileId,revision,'incorrect'),{statusCode:422})
 await assert.rejects(service.unlockWorkbook(f.bob.token,fileId,revision,password),{statusCode:404})
 assert.equal(reads,0)
 const {unlockId}=await service.unlockWorkbook(owner,fileId,revision,password)
 const range={startRow:0,endRow:0,startColumn:0,endColumn:0}
 assert.deepEqual(await service.inspect(owner,fileId,revision,undefined,false,unlockId),{sheets:[{id:'1',name:'Acceptance'}]})
 assert.deepEqual(await service.readRange(owner,fileId,revision,'Acceptance',range,undefined,unlockId),{cells:[{row:0,column:0,value:'Title'}]})
 await assert.rejects(service.inspect(otherLogin,fileId,revision,undefined,false,unlockId),{statusCode:423})
 await assert.rejects(service.inspect(owner,fileId,'00000000-0000-4000-8000-000000000001',undefined,false,unlockId),{statusCode:409})
 assert.equal(reads,2)
 await service.lockWorkbook(owner,fileId,revision,unlockId)
 await assert.rejects(service.inspect(owner,fileId,revision,undefined,false,unlockId),{statusCode:423})
 assert.deepEqual(await f.files.readFile(owner,fileId,revision),encrypted)
})
test('sheets reads enforce ownership before native work and recheck revocation before returning',async t=>{
 const f=await fileFixture(t),input=await bytes(),file=await importFile(f,f.alice.token,input,'acceptance.xlsx')
 let calls=0,release,started
 const entered=new Promise(resolve=>{started=resolve})
 const gate=new Promise(resolve=>{release=resolve})
 const native={async inspect(actual){calls++;assert.deepEqual(actual,input);started();await gate;return {sheets:[{id:'1',name:'Acceptance'}]}},async readRange(){throw new Error('unexpected range')}}
 const service=createSheetsService({files:f.files,native})
 for(const token of [f.bob.token,f.adminSigned.token])await assert.rejects(()=>service.inspect(token,file.file.fileId,file.file.revision))
 assert.equal(calls,0)
 const pending=service.inspect(f.alice.token,file.file.fileId,file.file.revision)
 await entered
 await f.sessions.revoke(f.alice.token,f.alice.sessionId)
 release()
 await assert.rejects(pending)
 assert.equal(calls,1)
})
test('sheets admission bounds concurrent captured work and releases slots after failures',async t=>{
 const f=await fileFixture(t),file=await importFile(f,f.alice.token,await bytes(),'acceptance.xlsx')
 let release,started
 const entered=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
 let calls=0
 const native={async inspect(){calls++;started();await gate;throw new Error('native failure')},async readRange(){}}
 const service=createSheetsService({files:f.files,native,maxConcurrent:1})
 const pending=service.inspect(f.alice.token,file.file.fileId,file.file.revision)
 await entered
 await assert.rejects(()=>service.inspect(f.alice.token,file.file.fileId,file.file.revision),{statusCode:429})
 release();await assert.rejects(pending,/native failure/)
 await assert.rejects(()=>service.inspect(f.alice.token,file.file.fileId,file.file.revision),/native failure/)
 assert.equal(calls,2)
})

test('external-link preview binds a readable saved source and rechecks it before returning values',{timeout:30000},async t=>{
 const input=await bytes()
 let work=0,entered,finish
 const started=new Promise(resolve=>{entered=resolve}), gate=new Promise(resolve=>{finish=resolve})
 const report={links:[],cells:[]}
 const native={async refreshExternalLinks(actual,sources){
  work++
  assert.deepEqual(actual,input)
  assert.deepEqual(sources,[{index:1,bytes:input}])
  if(work===2){entered();await gate}
  return report
 }}
 const f=await fileFixture(t,{sheetsNative:native})
 const target=(await importFile(f,f.alice.token,input,'dependent.xlsx')).file
 const source=(await importFile(f,f.alice.token,input,'source.xlsx')).file
 const foreign=(await importFile(f,f.bob.token,input,'private.xlsx')).file
 const binding={index:1,fileId:source.fileId,revision:source.revision}
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const refresh=(sources,token=f.alice.token)=>f.app.inject({
  method:'POST',url:`/api/v1/files/${target.fileId}/sheets/external-links/preview`,
  headers:{origin:restrictedOrigin,cookie:SESSION_COOKIE+'='+token,'x-csrf-token':csrf.sessionToken(token)},
  payload:{revision:target.revision,sources},
 })
 assert.equal((await refresh([binding],f.bob.token)).statusCode,404)
 assert.equal((await refresh([{...binding,fileId:foreign.fileId,revision:foreign.revision}])).statusCode,404)
 assert.equal((await refresh([{...binding,revision:target.revision}])).statusCode,404)
 assert.equal((await refresh([binding,binding])).statusCode,400)
 assert.equal((await refresh([{...binding,path:'/tmp/untrusted.xlsx'}])).statusCode,400)
 assert.equal(work,0)
 const result=await refresh([binding])
 assert.equal(result.statusCode,200,result.body)
 assert.equal(result.headers['cache-control'],'private, no-store')
 assert.deepEqual(result.json(),report)
 const pending=refresh([binding])
 await started
 await f.files.trashFile(f.alice.token,source.fileId)
 finish()
 assert.equal((await pending).statusCode,404)
 assert.equal((await f.files.openFile(f.alice.token,target.fileId)).file.revision,target.revision)
})

test('temporary merge workbook sessions bind source bytes to the current authorized workbook',async t=>{
 const input=await bytes(),revision='revision-1',fileId='file-1'
 let currentRevision=revision
 let inspected,read
 const files={
  async openFile(token,id){if(token!=='alice'||id!==fileId)throw new Error('not found');return {format:'xlsx',file:{revision:currentRevision}}},
 }
 const native={
  async inspect(actual){inspected=Buffer.from(actual);return {entryCount:1,sheets:[{id:'sheet-1',name:'Acceptance',rowCount:2,columnCount:6}],styles:[],dxfStyles:[],visuals:[],definedNames:[],activeTab:0}},
  async readRange(actual,name,range){read={actual:Buffer.from(actual),name,range};return {cells:[],rows:[],merges:[],indexingComplete:true,indexedThroughRow:1}},
 }
 const service=createSheetsService({files,native})
 await assert.rejects(()=>service.openMergeWorkbook('bob',fileId,revision,input,'source.xlsx'))
 const source=await service.openMergeWorkbook('alice',fileId,revision,input,'source.xlsx')
 assert.equal(source.name,'source.xlsx');assert.equal(source.sheets[0].name,'Acceptance');assert.deepEqual(inspected,input)
 const range=await service.readMergeWorkbookRange('alice',fileId,revision,source.sessionId,'Acceptance',{startRow:0,endRow:1,startColumn:0,endColumn:5})
 assert.equal(range.indexingComplete,true);assert.deepEqual(read.actual,input);assert.equal(read.name,'Acceptance')
 await assert.rejects(()=>service.readMergeWorkbookRange('bob',fileId,revision,source.sessionId,'Acceptance',{startRow:0,endRow:0,startColumn:0,endColumn:0}))
 currentRevision='revision-2'
 await assert.rejects(()=>service.readMergeWorkbookRange('alice',fileId,revision,source.sessionId,'Acceptance',{startRow:0,endRow:0,startColumn:0,endColumn:0}),{statusCode:409})
 await service.closeMergeWorkbook('alice',fileId,currentRevision,source.sessionId)
 await assert.rejects(()=>service.readMergeWorkbookRange('alice',fileId,revision,source.sessionId,'Acceptance',{startRow:0,endRow:0,startColumn:0,endColumn:0}))
})
