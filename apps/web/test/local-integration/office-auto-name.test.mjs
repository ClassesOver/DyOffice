import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {fileFixture,importFile,docxBytes} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'

test('only saved workspace blanks can take a generated name; collisions and manual names are preserved',async t=>{
 const f=await fileFixture(t,{buildApp:false}),token=f.alice.token
 const leases=createLeaseService({transactions:f.transactions})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 async function save(opened,bytes){
  const {fileId,revision:baseRevision}=opened.file,editorId=randomUUID()
  const {leaseEpoch}=await leases.acquireLease(token,fileId,{editorId})
  const {uploadId}=await revisions.stageUpload(token,fileId,{editorId,leaseEpoch,baseRevision,size:bytes.length})
  await f.files.receiveUpload(token,uploadId,bytes)
  return revisions.commitRevision(token,{fileId,uploadId,baseRevision,leaseEpoch,idempotencyKey:randomUUID()})
 }
 for(const [format,bytes] of [['docx',await docxBytes()],['xlsx',await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))],['pptx',await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))]]){
  const blankName='未命名.'+format
  const blank=async()=>{
   const {uploadId}=await f.files.stageUpload(token,{name:blankName,size:bytes.length,autoName:true})
   await f.files.receiveUpload(token,uploadId,bytes)
   return f.files.finishUpload(token,uploadId)
  }
  await importFile(f,token,bytes,'季度 汇报.'+format)
  const opened=await blank(),id=opened.file.fileId
  assert.equal(opened.autoNamePending,true)
  assert.deepEqual(await f.files.nameBlankFile(token,id,opened.file.revision,'季度/汇报'),{renamed:false})
  const saved=await save(opened,bytes)
  assert.deepEqual(await f.files.nameBlankFile(token,id,opened.file.revision,'季度/汇报'),{renamed:false})
  assert.deepEqual(await f.files.nameBlankFile(token,id,saved.revision,'季度/汇报'),{renamed:true,name:'季度 汇报-2.'+format})
  const listed=(await f.files.listFiles(token)).files.find(file=>file.id===id)
  assert.equal(listed.name,'季度 汇报-2.'+format)
  assert.equal(listed.revision,saved.revision)
  const manual=await blank(),receipt=await save(manual,bytes)
  await f.files.renameFile(token,manual.file.fileId,'我的文件.'+format)
  await f.files.renameFile(token,manual.file.fileId,blankName)
  assert.deepEqual(await f.files.nameBlankFile(token,manual.file.fileId,receipt.revision,'自动标题'),{renamed:false})
  const imported=await importFile(f,token,bytes,blankName),importedSave=await save(imported,bytes)
  assert.deepEqual(await f.files.nameBlankFile(token,imported.file.fileId,importedSave.revision,'自动标题'),{renamed:false})
 }
})
