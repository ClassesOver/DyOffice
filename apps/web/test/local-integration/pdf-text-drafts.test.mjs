import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,PDFName,degrees} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
test('text insert preview requires owner access and leaves real PostgreSQL source head/bytes untouched without a lease',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create()
 for(const angle of [0,90,180,270]){const p=doc.addPage([500,600]);p.setCropBox(20,30,450,540);p.setRotation(degrees(angle));p.node.set(PDFName.of('UserUnit'),doc.context.obj(2));p.drawText('Anchor',{x:50,y:330,size:14})}
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'preview.pdf')).file,pdf=createPdfService({files:f.files,leases:createLeaseService({transactions:f.transactions}),revisions:createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})}),input={revision:source.revision,operations:[1,2,3,4].map(page=>({page,text:'Draft preview words',anchor_text:'Anchor',placement:'below',max_width:100,align:'center'}))}
 for(const token of [f.bob.token,f.adminSigned.token])await assert.rejects(pdf.queryTextInserts(token,source.fileId,input),e=>e.statusCode===404)
 const before=(await f.files.openFile(f.alice.token,source.fileId)).file,result=await pdf.queryTextInserts(f.alice.token,source.fileId,input)
 assert.equal(result.revision,source.revision);assert.equal(result.blocks.length,4);for(const block of result.blocks){assert.equal(block.font_size,14);assert.equal(block.width,100);assert.ok(block.height>0);assert.ok(block.x>=0);assert.ok(block.y>=0);assert.equal(block.line_widths.length,block.text.split('\n').length)}
 const defaults=await pdf.queryTextInserts(f.alice.token,source.fileId,{revision:source.revision,operations:[{page:1,text:'Defaults'}]});assert.equal(defaults.blocks[0].font_size,14);assert.equal(defaults.blocks[0].y,72);assert.equal(defaults.blocks[0].color,'#000000')
 await assert.rejects(pdf.queryTextInserts(f.alice.token,source.fileId,{...input,revision:randomUUID()}),e=>e.statusCode===409)
 assert.deepEqual((await f.files.openFile(f.alice.token,source.fileId)).file,before);assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
})
