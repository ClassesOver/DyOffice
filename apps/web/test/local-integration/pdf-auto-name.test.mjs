import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'

test('only a workspace blank PDF takes its first saved heading, and a concurrent manual rename wins',async t=>{
 const f=await fileFixture(t,{buildApp:false}),token=f.alice.token
 const leases=createLeaseService({transactions:f.transactions})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const pdf=createPdfService({files:f.files,leases,revisions})
 const create=()=>f.files.createBlankPdf(token)
 async function prepare(source,head='Project: Review'){
  const {fileId,revision:baseRevision}=source,editorId=randomUUID()
  const {leaseEpoch}=await leases.acquireLease(token,fileId,{editorId})
  const snapshot={fileId,baseRevision,generation:0,markups:[],notes:[],imageEdits:[],formEdits:{},formFields:[],rotations:{},deleted:[],order:null,metadata:null,
   textInserts:[['Lower line',400],[head+'\nDraft body',530]].map(([text,y],i)=>({id:`T${i}`,input:{pageIndex:0,origin:[30,y],text,fontSize:12,color:[0,0,0]}}))}
  const staged=await pdf.stageApplyOps(token,fileId,{baseRevision,editorId,leaseEpoch,idempotencyKey:randomUUID(),snapshot})
  return {commit:()=>revisions.commitRevision(token,staged.commitInput),release:()=>leases.releaseLease(token,fileId,{editorId,leaseEpoch})}
 }
 const blank=await create()
 assert.equal(blank.name,'未命名.pdf');assert.equal(blank.pdfAutoNamePending,true)
 const original=await f.files.readFile(token,blank.file.fileId,blank.file.revision)
 assert.equal((await PDFDocument.load(original)).getPageCount(),1)
 const first=await prepare(blank.file)
 assert.equal((await f.files.openFile(token,blank.file.fileId)).name,'未命名.pdf')
 const receipt=await first.commit();assert.deepEqual(await first.commit(),receipt);await first.release()
 const opened=await f.files.openFile(token,blank.file.fileId)
 assert.equal(opened.name,'Project Review.pdf');assert.ok(!opened.pdfAutoNamePending)
 const bytes=await f.files.readFile(token,blank.file.fileId,receipt.revision)
 assert.ok((await readPdfLeafObjects(bytes)).some(item=>item.text==='Project: Review'))
 assert.deepEqual(await f.files.readFile(token,blank.file.fileId,blank.file.revision),original)
 const next=await prepare(receipt,'Later heading');await next.commit();await next.release()
 assert.equal((await f.files.openFile(token,blank.file.fileId)).name,'Project Review.pdf')

 const manual=await create(),staged=await prepare(manual.file)
 await f.files.renameFile(token,manual.file.fileId,'Custom.pdf')
 await f.files.renameFile(token,manual.file.fileId,'未命名.pdf')
 await staged.commit();await staged.release()
 assert.equal((await f.files.openFile(token,manual.file.fileId)).name,'未命名.pdf')
 const imported=await importFile(f,token,original,'未命名.pdf'),importEdit=await prepare(imported.file)
 await importEdit.commit();await importEdit.release()
 assert.equal((await f.files.openFile(token,imported.file.fileId)).name,'未命名.pdf')
})
