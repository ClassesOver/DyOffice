import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createSheetsService} from '../../server/src/modules/sheets/service.ts'
const bytes=()=>readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
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
