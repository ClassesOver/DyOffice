import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName} from 'pdf-lib'
import {inspectPdf} from '../server/src/pdf/capabilities.mjs'
const MiB=1024*1024
async function fixture(streams,{compressed=true,form=false}={}){
 const doc=await PDFDocument.create(),page=doc.addPage()
 const refs=streams.map(bytes=>doc.context.register(compressed?doc.context.flateStream(bytes):doc.context.stream(bytes)))
 if(form){
  const stream=doc.context.lookup(refs[0]);stream.dict.set(PDFName.of('Subtype'),PDFName.of('Form'))
  page.node.set(PDFName.of('Resources'),doc.context.obj({XObject:{Fm:refs[0]}}))
  page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream('/Fm Do')))
 }else page.node.set(PDFName.of('Contents'),doc.context.obj(refs))
 return Buffer.from(await doc.save({useObjectStreams:false}))
}
test('over-budget Flate page stream is rejected rather than reported blank',async()=>{
 const bytes=await fixture([Buffer.alloc(MiB+1,32)])
 assert.ok(bytes.length<10000)
 const original=Buffer.from(bytes)
 await assert.rejects(inspectPdf(bytes),{code:'UNREADABLE',status:400})
 assert.deepEqual(bytes,original)
})
test('document aggregate budget counts repeated content references across pages',async()=>{
 const doc=await PDFDocument.create(),ref=doc.context.register(doc.context.flateStream(Buffer.alloc(MiB,32)))
 for(let i=0;i<9;i++)doc.addPage().node.set(PDFName.of('Contents'),ref)
 await assert.rejects(inspectPdf(Buffer.from(await doc.save({useObjectStreams:false}))),{code:'UNREADABLE'})
})
test('uncompressed and Form XObject content use the same bounded scanner',async()=>{
 for(const opts of [{compressed:false},{form:true}])await assert.rejects(inspectPdf(await fixture([Buffer.alloc(MiB+1,32)],opts)),{code:'UNREADABLE'})
})
test('corrupt Flate data cannot silently become an empty page',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage(),stream=doc.context.stream('invalid deflate',{Filter:'FlateDecode'})
 page.node.set(PDFName.of('Contents'),doc.context.register(stream))
 await assert.rejects(inspectPdf(Buffer.from(await doc.save({useObjectStreams:false}))),{code:'UNREADABLE'})
})
test('at-limit and normal split text streams remain readable',async()=>{
 const bytes=await fixture([Buffer.alloc(MiB,32)]),original=Buffer.from(bytes)
 const report=await inspectPdf(bytes)
 assert.deepEqual(bytes,original)
 assert.equal(report.pages[0].kind,'blank')
 const text=await inspectPdf(await fixture([Buffer.from('BT (hello)'),Buffer.from(' Tj ET')]))
 assert.equal(text.pages[0].kind,'text');assert.equal(text.capabilities.editText,'unsupported')
})

test('aggregate budget also applies within one Contents array and resets per inspection',async()=>{
 await assert.rejects(inspectPdf(await fixture(Array.from({length:9},()=>Buffer.alloc(MiB,32)))),{code:'UNREADABLE'})
 const bytes=await fixture([Buffer.from('BT (still readable) Tj ET')])
 assert.equal((await inspectPdf(bytes)).pages[0].kind,'text')
 assert.equal((await inspectPdf(bytes)).pages[0].kind,'text')
})
test('a non-stream Contents object is unreadable rather than a blank page',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage()
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.obj({Invalid:true})))
 await assert.rejects(inspectPdf(Buffer.from(await doc.save({useObjectStreams:false}))),{code:'UNREADABLE'})
})
test('exact document decoded budget remains valid without truncation',async()=>{
 const report=await inspectPdf(await fixture(Array.from({length:8},()=>Buffer.alloc(MiB,32))))
 assert.equal(report.pages.length,1)
 assert.equal(report.pages[0].kind,'blank')
})
test('a fake Encrypt marker after EOF cannot disguise a scan budget failure',async()=>{
 const bytes=await fixture([Buffer.alloc(MiB+1,32)])
 await assert.rejects(inspectPdf(Buffer.concat([bytes,Buffer.from('\n% /Encrypt fake marker\n')])),{code:'UNREADABLE',status:400})
})
test('a fake Encrypt marker cannot disguise corrupt Flate content',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage()
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream('broken',{Filter:'FlateDecode'})))
 const bytes=Buffer.from(await doc.save({useObjectStreams:false}))
 await assert.rejects(inspectPdf(Buffer.concat([bytes,Buffer.from('\n% /Encrypt\n')])),{code:'UNREADABLE',status:400})
})
test('a fake Encrypt marker on an invalid PDF is not encryption evidence',async()=>{
 await assert.rejects(inspectPdf(Buffer.from('%PDF-1.7\n% /Encrypt\n%%EOF')),{code:'UNREADABLE',status:400})
})
test('valid plaintext with a trailing Encrypt marker stays plaintext',async()=>{
 const bytes=await fixture([Buffer.from('BT (hello) Tj ET')])
 const report=await inspectPdf(Buffer.concat([bytes,Buffer.from('\n% /Encrypt\n')]))
 assert.equal(report.encrypted,false);assert.equal(report.pages[0].kind,'text')
})
test('parsed Encrypt trailer stays locked before corrupt content is scanned',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage()
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream('broken',{Filter:'FlateDecode'})))
 doc.context.trailerInfo.Encrypt=doc.context.obj({Filter:'Standard'})
 const report=await inspectPdf(Buffer.from(await doc.save({useObjectStreams:false})))
 assert.equal(report.encrypted,true);assert.equal(report.capabilities.read,'password_required')
 assert.deepEqual(report.pages,[])
})
test('exact aggregate budget permits following empty raw and Flate streams',async()=>{
 for(const compressed of [false,true]){
  const doc=await PDFDocument.create(),page=doc.addPage()
  const refs=Array.from({length:8},()=>doc.context.register(doc.context.flateStream(Buffer.alloc(MiB,32))))
  refs.push(doc.context.register(compressed?doc.context.flateStream(Buffer.alloc(0)):doc.context.stream(Buffer.alloc(0))))
  page.node.set(PDFName.of('Contents'),doc.context.obj(refs))
  const report=await inspectPdf(Buffer.from(await doc.save({useObjectStreams:false})))
  assert.equal(report.pages[0].kind,'blank')
 }
})
test('exhausted budget still rejects a following one-byte or expanding Flate stream',async()=>{
 for(const bytes of [Buffer.from(' '),Buffer.alloc(MiB,32)]){
  await assert.rejects(inspectPdf(await fixture([...Array.from({length:8},()=>Buffer.alloc(MiB,32)),bytes])),{code:'UNREADABLE',status:400})
 }
})
test('many individually small Form streams share the document aggregate budget',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage(),objects={}
 for(let i=0;i<17;i++)objects['F'+i]=doc.context.register(doc.context.flateStream(Buffer.alloc(MiB/2,32),{Subtype:'Form'}))
 page.node.set(PDFName.of('Resources'),doc.context.obj({XObject:objects}))
 const calls=Object.keys(objects).map(name=>'/'+name+' Do')
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(calls.slice(0,15).join('\n'))))
 assert.equal((await inspectPdf(Buffer.from(await doc.save({useObjectStreams:false})))).pages[0].kind,'blank')
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(calls.join('\n'))))
 await assert.rejects(inspectPdf(Buffer.from(await doc.save({useObjectStreams:false}))),{code:'UNREADABLE',status:400})
})
