import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {PNG} from 'pngjs'
import {PDFDocument,PDFName,PDFArray,PDFDict,PDFRawStream,PDFString,degrees,rgb} from 'pdf-lib'
import {createPdfStampsJob} from '../server/src/pdf/stamps-job.mjs'
import {createIsolatedPdfStampsJob} from '../server/src/pdf/stamps-isolated.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
const command=operation=>JSON.stringify({version:1,action:'stamps',operation})
async function fixture(){const d=await PDFDocument.create();for(const rotation of [0,90,180,270]){const p=d.addPage([500,600]);p.setCropBox(20,30,450,540);p.setRotation(degrees(rotation));p.node.set(PDFName.of('UserUnit'),d.context.obj(2));p.drawText('Original native stamp',{x:55,y:320,size:16,color:rgb(.2,.3,.4)});p.drawText('Source body',{x:45,y:220,size:14})}return Buffer.from(await d.save())}
const text=async bytes=>(await readPdfLeafObjects(bytes)).filter(item=>item.type===1).map(item=>item.text).join('|')
test('watermark replaces and removes only managed content while preserving source text and inherited styles',async()=>{
 const source=await fixture(),first=await createPdfStampsJob().execute(source,command({op:'set_watermark',text:'内部草稿',angle:25,opacity:.3,color:'#123456',size:.1}));assert.match(await text(first.bytes),/内部草稿/)
 const second=await createIsolatedPdfStampsJob().execute(first.bytes,command({op:'set_watermark',text:'最终文档'})),value=await text(second.bytes);const saved=await PDFDocument.load(second.bytes),config=JSON.parse(saved.getPage(0).node.lookup(PDFName.of('DyOfficeStamps'),PDFDict).lookup(PDFName.of('Watermark'),PDFDict).get(PDFName.of('Config')).decodeText());assert.deepEqual(config,{op:'set_watermark',text:'最终文档',angle:25,opacity:.3,color:'#123456',size:.1});assert.doesNotMatch(value,/内部草稿/);assert.equal(value.match(/最终文档/g).length,4);assert.equal(value.match(/Original native stamp/g).length,4)
 const removed=await createPdfStampsJob().execute(second.bytes,command({op:'set_watermark',text:''}));assert.equal(await text(removed.bytes),await text(source));await assert.rejects(createPdfStampsJob().execute(removed.bytes,command({op:'set_watermark',text:''})),{code:'PDF_STAMP_NOT_FOUND'})
})
test('headers and footers use Chinese placeholders, page numbers and replace omitted slots without removing watermark',async()=>{
 const source=await fixture(),wm=await createPdfStampsJob().execute(source,command({op:'set_watermark',text:'机密'})),first=await createPdfStampsJob().execute(wm.bytes,command({op:'set_header_footer',header_left:'第{page}页',header_right:'共{total}页',footer_center:'ignored',page_number:true,start_at:0,font_size:10}));const contents=await text(first.bytes);assert.match(contents,/第0页/);assert.match(contents,/第3页/);assert.match(contents,/共4页/);assert.match(contents,/0 \/ 4/);assert.doesNotMatch(contents,/ignored/)
 const replaced=await createPdfStampsJob().execute(first.bytes,command({op:'set_header_footer',footer_right:'End'}));assert.doesNotMatch(await text(replaced.bytes),/第0页|0 \/ 4/);assert.match(await text(replaced.bytes),/End/);assert.match(await text(replaced.bytes),/机密/)
 const removed=await createPdfStampsJob().execute(replaced.bytes,command({op:'set_header_footer'}));assert.equal(await text(removed.bytes),await text(wm.bytes));await assert.rejects(createPdfStampsJob().execute(removed.bytes,command({op:'set_header_footer'})),{code:'PDF_STAMP_NOT_FOUND'})
})
test('managed stream integrity is checked across every page before replacement or deletion',async()=>{
 const result=await createPdfStampsJob().execute(await fixture(),command({op:'set_watermark',text:'Owned'})),d=await PDFDocument.load(result.bytes),page=d.getPage(3),meta=page.node.lookup(PDFName.of('DyOfficeStamps'),PDFDict),record=meta.lookup(PDFName.of('Watermark'),PDFDict),ref=record.get(PDFName.of('Stream'));d.context.assign(ref,d.context.flateStream('q\nQ\n'))
 await assert.rejects(createPdfStampsJob().execute(Buffer.from(await d.save()),command({op:'set_watermark',text:''})),{code:'PDF_STAMP_INTEGRITY_FAILED'})
})
test('stamp validation rejects clipping, missing glyphs, protected sources and cancellation',async()=>{
 const source=await fixture();await assert.rejects(createPdfStampsJob().execute(source,command({op:'set_header_footer',header_left:'W'.repeat(1000),font_size:72})),{code:'PDF_STAMP_LAYOUT_REFUSED'})
 await assert.rejects(createPdfStampsJob().execute(source,command({op:'set_watermark',text:'\u{10FFFF}'})),{code:'PDF_STAMP_FONT_UNAVAILABLE'})
 const signed=await PDFDocument.load(source);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}));await assert.rejects(createPdfStampsJob().execute(Buffer.from(await signed.save()),command({op:'set_watermark',text:'x'})),{code:'SIGNATURE_EDIT_REFUSED'})
 const controller=new AbortController(),pending=createIsolatedPdfStampsJob().execute(source,command({op:'set_watermark',text:'中文测试'}),controller.signal);setTimeout(()=>controller.abort(),10);await assert.rejects(pending,{code:'ABORTED'})
})

test('stamps isolate source CTM and clipping and reject unbalanced or ambiguous source state',async t=>{
 const source=await fixture(),d=await PDFDocument.load(source)
 for(const page of d.getPages())page.node.addContentStream(d.context.register(d.context.stream('2 0 0 2 50 50 cm\n0 0 10 10 re W n\n')))
 const changed=Buffer.from(await d.save()),op=command({op:'set_watermark',text:'Overlay'})
 const baseline=await createPdfStampsJob().execute(source,op),isolated=await createPdfStampsJob().execute(changed,op)
 const bounds=async bytes=>(await readPdfLeafObjects(bytes)).filter(item=>item.text==='Overlay').map(item=>item.bounds)
 assert.deepEqual(await bounds(isolated.bytes),await bounds(baseline.bytes))
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-stamp-state-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 for(const [label,bytes] of [['baseline',baseline.bytes],['isolated',isolated.bytes]]){
  await writeFile(join(dir,label+'.pdf'),bytes)
  await promisify(execFile)('pdftoppm',['-r','36','-png',join(dir,label+'.pdf'),join(dir,label)],{timeout:15000})
 }
 for(let page=1;page<=4;page++){
  const a=PNG.sync.read(await readFile(join(dir,`baseline-${page}.png`))),b=PNG.sync.read(await readFile(join(dir,`isolated-${page}.png`)))
  assert.equal(b.width,a.width);assert.equal(b.height,a.height);assert.deepEqual(b.data,a.data,`rotation ${(page-1)*90} pixels`)
 }
 const removed=await createPdfStampsJob().execute(isolated.bytes,command({op:'set_watermark',text:''})),clean=await PDFDocument.load(removed.bytes)
 for(const page of clean.getPages())assert.equal(page.node.has(PDFName.of('DyOfficeStamps')),false)
 for(const syntax of ['q\n','Q\n','BT\n','ET\n','BI /W 1 ID binary EI\n']){
  const invalid=await PDFDocument.load(source);invalid.getPage(3).node.addContentStream(invalid.context.register(invalid.context.stream(syntax)))
  await assert.rejects(createPdfStampsJob().execute(Buffer.from(await invalid.save()),op),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 }
})
