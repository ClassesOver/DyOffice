import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {createPdfBlockEditsJob,planPdfBlockEdits,validatePdfBlockEditOperations} from '../server/src/pdf/block-edits-job.mjs'
import {createIsolatedPdfBlockEditsJob} from '../server/src/pdf/block-edits-isolated.mjs'
const command=operations=>JSON.stringify({version:1,action:'blockEdits',operations})
async function fixture(){
 const doc=await PDFDocument.create(),page=doc.addPage([500,500]),font=await doc.embedFont(StandardFonts.TimesRomanItalic)
 page.drawText('Original narrative covers the quarterly plan.',{x:40,y:420,size:14,font,color:rgb(0.15,0.3,0.65)})
 page.drawText('Second sentence records the approved budget.',{x:40,y:401,size:14,font,color:rgb(0.15,0.3,0.65)})
 page.drawText('Independent footer remains.',{x:40,y:70,size:10})
 return Buffer.from(await doc.save())
}
async function content(bytes){const task=getDocument({data:Uint8Array.from(bytes),disableFontFace:true,useSystemFonts:true});try{return await(await(await task.promise).getPage(1)).getTextContent()}finally{await task.destroy()}}
test('block replaces both source lines using native original face metrics and preserves unrelated text',async()=>{
 const input=await fixture(),copy=Buffer.from(input),operations=[{page:1,paragraph_text:'Original narrative',new_text:'Rewritten narrative explains the revised quarterly plan, delivery schedule and updated budget. The complete original paragraph is replaced and reflows into several lines.'}]
 const [plan]=await planPdfBlockEdits(input,validatePdfBlockEditOperations(operations));assert.ok(plan.newText.includes('\n'));assert.ok(plan.oldText.includes('Second sentence'));assert.equal(plan.newFont,undefined);assert.equal(plan.newColor,undefined)
 for(const job of [createPdfBlockEditsJob(),createIsolatedPdfBlockEditsJob()]){
  const result=await job.execute(input,command(operations)),items=(await content(result.bytes)).items,text=items.map(item=>item.str).join('').replace(/\s/g,'')
  assert.ok(text.includes('Rewrittennarrative'));assert.ok(!text.includes('Originalnarrative'));assert.ok(!text.includes('Secondsentence'));assert.ok(text.includes('Independentfooterremains.'))
  assert.ok(items.filter(item=>item.str.startsWith('Rewritten')).every(item=>Math.abs(item.height-14)<0.1))
 }
 assert.deepEqual(input,copy)
})
test('block deletion removes source text objects without introducing a replacement overlay',async()=>{
 const input=await fixture(),result=await createPdfBlockEditsJob().execute(input,command([{page:1,paragraph_text:'Original narrative',new_text:''}]))
 assert.deepEqual((await content(result.bytes)).items.filter(item=>item.str).map(item=>item.str),['Independent footer remains.'])
})
test('block can reflow Chinese with explicit font style, size, color and alignment',async()=>{
 const input=await fixture(),operations=[{page:1,paragraph_text:'Original narrative',new_text:'项目计划已经更新，预算与风险均完成复核。后续由项目经理跟进交付进度。',font_size:18,color:'#AA3300',font:'arial',bold:true,italic:true,align:'center'}]
 const [plan]=await planPdfBlockEdits(input,validatePdfBlockEditOperations(operations));assert.deepEqual(plan.newColor,[170,51,0]);assert.equal(plan.newFontSize,18);assert.ok(plan.lineXOffsets.every(offset=>offset>=0))
 const result=await createPdfBlockEditsJob().execute(input,command(operations));assert.ok((await content(result.bytes)).items.map(item=>item.str).join('').includes('项目计划已经更新'))
})
test('block anchors must identify exactly one paragraph and batches cannot overlap',async()=>{
 const input=await fixture()
 for(const operations of [[{page:1,paragraph_text:'Missing',new_text:'x'}],[{page:1,paragraph_text:'Original',new_text:'x'},{page:1,paragraph_text:'Second sentence',new_text:'y'}]])await assert.rejects(createPdfBlockEditsJob().execute(input,command(operations)))
 const doc=await PDFDocument.load(input),page=doc.getPage(0);page.drawText('Original narrative repeated.',{x:40,y:170,size:14})
 await assert.rejects(createPdfBlockEditsJob().execute(Buffer.from(await doc.save()),command([{page:1,paragraph_text:'Original narrative',new_text:'x'}])),{code:'PDF_BLOCK_AMBIGUOUS'})
 for(const patch of [{new_text:null},{font_size:0},{font:'unknown'},{align:'justify'},{paragraph_text:''},{bold:'true'},{rect:[0,0,1,1]}])assert.throws(()=>validatePdfBlockEditOperations([{page:1,paragraph_text:'Original',new_text:'x',...patch}]))
})

test('mixed original faces retain the correct short run when replacement repeats its words',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage([500,450]),mono=await doc.embedFont(StandardFonts.CourierBold),serif=await doc.embedFont(StandardFonts.TimesRomanItalic)
 page.drawText('Review',{x:40,y:370,size:14,font:mono,color:rgb(.1,.4,.7)})
 page.drawText(' delivery baseline follows the approved plan.',{x:90.4,y:370,size:14,font:serif,color:rgb(.1,.4,.7)})
 page.drawText('Footer untouched',{x:40,y:60,size:10})
 const input=Buffer.from(await doc.save()),operation={page:1,paragraph_text:'Review delivery',new_text:'Review Review Review new narrative follows the revised quarterly delivery plan and budget.'}
 const [plan]=await planPdfBlockEdits(input,validatePdfBlockEditOperations([operation]));assert.ok(plan.newText.includes('Review Review Review'))
 const result=await createPdfBlockEditsJob().execute(input,command([operation])),out=await content(result.bytes)
 assert.ok(out.items.map(item=>item.str).join('').replace(/\s/g,'').includes('ReviewReviewReviewnewnarrative'))
 const first=out.items.find(item=>item.str==='Review');assert.ok(first);assert.equal(out.styles[first.fontName].fontFamily,'monospace')
 assert.ok(out.items.some(item=>item.str==='Footer untouched'))
})

test('deleting one paragraph allows identical words in an unrelated surviving paragraph',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage([500,500])
 page.drawText('Quarterly unique heading same shared words',{x:40,y:400,size:14})
 page.drawText('Other unique heading same shared words',{x:40,y:100,size:14})
 const input=Buffer.from(await doc.save()),result=await createPdfBlockEditsJob().execute(input,command([{page:1,paragraph_text:'Quarterly unique',new_text:''}]))
 assert.equal((await content(result.bytes)).items.filter(item=>item.str).map(item=>item.str).join(''),'Other unique heading same shared words')
})

test('block reflow rejects collision with another paragraph and process cancellation suppresses results',async()=>{
 const input=await fixture(),raw=command([{page:1,paragraph_text:'Original narrative',new_text:'Long narrative about delivery and budget. '.repeat(70)}])
 await assert.rejects(createPdfBlockEditsJob().execute(input,raw),{code:'PDF_BLOCK_REFUSED'})
 const controller=new AbortController(),pending=createIsolatedPdfBlockEditsJob().execute(input,command([{page:1,paragraph_text:'Original narrative',new_text:'Changed'}]),controller.signal)
 controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})
