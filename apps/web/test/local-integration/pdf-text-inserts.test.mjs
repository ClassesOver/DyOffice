import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument,degrees} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'

test('PDF inserts publish one verified revision, preserve source bytes and retain rotated page content',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create()
 doc.addPage([500,400]).drawText('Name:',{x:30,y:300,size:14})
 const rotated=doc.addPage([500,400]);rotated.setRotation(degrees(90));rotated.drawText('Original',{x:30,y:300,size:14})
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'insert.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId})
 const input={baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operations:[{page:1,text:'张三',anchor_text:'Name:',placement:'right',font_size:14},{page:2,text:'Inserted report',x:30,y:60,font_size:16,max_width:200,align:'right',color:'#124578'}]}
 await assert.rejects(pdf.stageTextInserts(f.bob.token,source.fileId,input),error=>error.statusCode===404)
 await assert.rejects(pdf.stageTextInserts(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),error=>error.statusCode===409)
 await assert.rejects(pdf.stageTextInserts(f.alice.token,source.fileId,{...input,operations:[input.operations[0],{page:2,text:'Do not publish',anchor_text:'missing'}]}),error=>error.statusCode===400)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const staged=await pdf.stageTextInserts(f.alice.token,source.fileId,input)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const saved=await revisions.commitRevision(f.alice.token,staged.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved)
 const bytes=await f.files.readFile(f.alice.token,source.fileId,saved.revision)
 const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{
  const pdf=await task.promise
  const text=async page=>(await (await pdf.getPage(page)).getTextContent()).items.map(item=>item.str??'').join(' ')
  assert.match(await text(1),/Name:/);assert.match(await text(1),/张三/)
  assert.match(await text(2),/Original/);assert.match(await text(2),/Inserted report/)
  assert.equal((await pdf.getPage(2)).rotate,90)
 }finally{await task.destroy()}
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 await mkdir('/tmp/dyoffice-pdf-insert-review',{recursive:true})
 await writeFile('/tmp/dyoffice-pdf-insert-review/inserted.pdf',bytes)
})
