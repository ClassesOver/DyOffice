import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument,rgb} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'

async function textOf(bytes){
 const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true})
 try{return (await (await (await task.promise).getPage(1)).getTextContent()).items.map(item=>item.str??'').join(' ')}finally{await task.destroy()}
}
test('PDF paragraph rewrite and deletion commit real content changes and preserve other paragraphs and revisions',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create(),page=doc.addPage([500,400])
 page.drawText('Original project summary first line.',{x:40,y:330,size:14,color:rgb(.1,.2,.6)})
 page.drawText('Second line belongs to this paragraph.',{x:40,y:312,size:14,color:rgb(.1,.2,.6)})
 page.drawText('Unrelated footer must remain.',{x:40,y:80,size:12})
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'paragraph.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const pdf=createPdfService({files:f.files,leases,revisions}),editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId})
 const input={baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operations:[{page:1,paragraph_text:'Original project summary',new_text:'Rewritten project summary uses several words to exercise paragraph wrapping and keeps the original blue text color.'}]}
 await assert.rejects(pdf.stageBlockEdits(f.bob.token,source.fileId,input),error=>error.statusCode===404)
 await assert.rejects(pdf.stageBlockEdits(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),error=>error.statusCode===409)
 await assert.rejects(pdf.stageBlockEdits(f.alice.token,source.fileId,{...input,operations:[input.operations[0],{page:1,paragraph_text:'missing paragraph',new_text:'No publication'}]}),error=>error.statusCode===400)
 const prepared=await pdf.stageBlockEdits(f.alice.token,source.fileId,input)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const saved=await revisions.commitRevision(f.alice.token,prepared.commitInput)
 assert.deepEqual(await revisions.commitRevision(f.alice.token,prepared.commitInput),saved)
 const bytes=await f.files.readFile(f.alice.token,source.fileId,saved.revision),text=await textOf(bytes)
 assert.match(text,/Rewritten project summary/);assert.match(text,/Unrelated footer must remain/)
 assert.doesNotMatch(text,/Original project summary|Second line belongs/)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 const deletion=await pdf.stageBlockEdits(f.alice.token,source.fileId,{...input,baseRevision:saved.revision,idempotencyKey:randomUUID(),operations:[{page:1,paragraph_text:'Rewritten project summary',new_text:''}]})
 const deleted=await revisions.commitRevision(f.alice.token,deletion.commitInput)
 const removed=await textOf(await f.files.readFile(f.alice.token,source.fileId,deleted.revision))
 assert.doesNotMatch(removed,/Rewritten project summary|exercise paragraph/);assert.match(removed,/Unrelated footer must remain/)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,saved.revision),bytes)
 await mkdir('/tmp/dyoffice-pdf-block-review',{recursive:true})
 await writeFile('/tmp/dyoffice-pdf-block-review/rewritten.pdf',bytes)
})
