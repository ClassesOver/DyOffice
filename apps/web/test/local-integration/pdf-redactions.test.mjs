import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument,PDFName,degrees} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
const text=async bytes=>(await readPdfLeafObjects(bytes)).filter(o=>o.type===1).map(o=>o.text).join('|')
test('redaction review binds candidates to source revision and publishes only a separately saved clean copy',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create()
 for(const angle of [0,90,180,270]){const page=doc.addPage([500,600]);page.setCropBox(20,30,450,540);page.setRotation(degrees(angle));page.node.set(PDFName.of('UserUnit'),doc.context.obj(2));page.drawText('PUBLIC',{x:50,y:400,size:14});page.drawText('chosen@example.com',{x:50,y:330,size:14});page.drawText('keep@example.com',{x:50,y:250,size:14})}
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'private.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions})
 const query={revision:source.revision,patterns:['email']}
 await assert.rejects(pdf.queryRedactions(f.bob.token,source.fileId,query),e=>e.statusCode===404)
 await assert.rejects(pdf.queryRedactions(f.adminSigned.token,source.fileId,query),e=>e.statusCode===404)
 const report=await pdf.queryRedactions(f.alice.token,source.fileId,query)
 assert.equal(report.revision,source.revision);assert.equal(report.truncated,false);assert.equal(report.candidates.length,8)
 assert.deepEqual(report.unsupportedPages,[])
 const selected=report.candidates.filter(c=>c.text==='chosen@example.com');assert.equal(selected.length,4)
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId}),input={baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,patterns:['email'],ids:selected.map(c=>c.id),name:'private-redacted.pdf'}
 await assert.rejects(pdf.stageRedactedCopy(f.alice.token,source.fileId,{...input,ids:['0'.repeat(64)]}),e=>e.statusCode===400)
 await assert.rejects(pdf.stageRedactedCopy(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),e=>e.statusCode===409)
 const staged=await pdf.stageRedactedCopy(f.alice.token,source.fileId,input)
 assert.notEqual(staged.fileId,source.fileId)
 await assert.rejects(f.files.openFile(f.alice.token,staged.fileId),e=>e.statusCode===404)
 const saved=await f.files.finishUpload(f.alice.token,staged.uploadId);assert.deepEqual(await f.files.finishUpload(f.alice.token,staged.uploadId),saved)
 assert.equal(saved.file.fileId,staged.fileId)
 const bytes=await f.files.readFile(f.alice.token,staged.fileId,saved.file.revision),output=await text(bytes)
 assert.doesNotMatch(output,/chosen@example.com/);assert.equal(output.match(/keep@example.com/g)?.length,4);assert.equal(output.match(/PUBLIC/g)?.length,4)
 const reopened=await PDFDocument.load(bytes);assert.equal(reopened.getPageCount(),4)
 for(let i=0;i<4;i++){assert.deepEqual(reopened.getPage(i).getCropBox(),doc.getPage(i).getCropBox());assert.equal(reopened.getPage(i).getRotation().angle,doc.getPage(i).getRotation().angle)}
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original);assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const directory='/tmp/dyoffice-pdf-redactions-review';await mkdir(directory,{recursive:true});await writeFile(directory+'/original.pdf',original);await writeFile(directory+'/redacted.pdf',bytes)
})
