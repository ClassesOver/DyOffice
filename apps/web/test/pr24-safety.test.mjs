
import {test} from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import {createWebDesktop} from '../../../packages/browser-host/src/web-desktop.ts'
import {projectDocx,applyDocxTextEdits} from '../server/docx-session.mjs'

for (const method of ['saveDocxNew','saveDocxAs','saveDocxTo']) test(method+' refuses unsupported file creation/copy/overwrite without writing',async()=>{
 let writes=0
 const api=createWebDesktop({fileId:'existing',fileName:'existing.docx',readBytes:async()=>new Uint8Array(),saveBytes:async()=>{writes++;return {revision:'r2'}}})
 await assert.rejects(api[method]('new-name.docx',new ArrayBuffer(1),'existing'),e=>e.code==='UNSUPPORTED')
 assert.equal(writes,0)
})
async function document(table){
 const zip=new JSZip()
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+table+'</w:body></w:document>')
 return zip.generateAsync({type:'uint8array'})
}
const para=text=>'<w:p><w:r><w:t>'+text+'</w:t></w:r></w:p>'
const table=second=>'<w:tbl><w:tr><w:tc>'+para('A')+'</w:tc><w:tc>'+second+'</w:tc></w:tr></w:tbl>'
test('editing one cell preserves unchanged cell XML byte-for-byte',async()=>{
 const untouched='<w:p><w:r><w:t>B</w:t></w:r></w:p>'
 const bytes=await document(table(untouched)), blocks=await projectDocx(bytes)
 const output=await applyDocxTextEdits(bytes,blocks.map(b=>({docxIndex:b.docxIndex,cells:[['Edited A','B']]})))
 const xml=await (await JSZip.loadAsync(output)).file('word/document.xml').async('string')
 assert.ok(xml.includes('<w:tc>'+untouched+'</w:tc>'),xml)
})
for(const [name,xml] of [
 ['mixed formatting','<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>Italic</w:t></w:r></w:p>'],
 ['bookmark','<w:p><w:bookmarkStart w:id="1" w:name="Mark"/><w:r><w:t>B</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>'],
 ['tracked insertion','<w:p><w:ins w:id="1"><w:r><w:t>B</w:t></w:r></w:ins></w:p>'],
 ['comment anchor','<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>B</w:t></w:r><w:commentRangeEnd w:id="1"/></w:p>'],
 ['paragraph identity','<w:p w:rsidR="00112233"><w:r><w:t>B</w:t></w:r></w:p>'],
]) test(name+' tables remain preserved and reject plain-grid writes',async()=>{
 const bytes=await document(table(xml)),blocks=await projectDocx(bytes),t=blocks.find(b=>b.type==='table')
 assert.equal(t.editable,false);assert.equal(t.cells,undefined)
 await assert.rejects(applyDocxTextEdits(bytes,blocks.map(b=>({docxIndex:b.docxIndex,cells:[['Edited A','B']]}))),e=>e.publicCode==='INVALID_DOCUMENT')
 const output=await applyDocxTextEdits(bytes,blocks.map(b=>({docxIndex:b.docxIndex})))
 const saved=await (await JSZip.loadAsync(output)).file('word/document.xml').async('string')
 assert.ok(saved.includes(xml))
})

test('clearing a styled single-run cell preserves its formatting through reopen and retyping',async()=>{
 const styled='<w:p><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>Styled</w:t></w:r></w:p>'
 const bytes=await document(table(styled)),blocks=await projectDocx(bytes)
 const cleared=await applyDocxTextEdits(bytes,blocks.map(b=>({docxIndex:b.docxIndex,cells:[['A','']]})))
 const xml=await (await JSZip.loadAsync(cleared)).file('word/document.xml').async('string')
 assert.ok(xml.includes('<w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr>'),xml)
 const reopened=await projectDocx(cleared)
 assert.deepEqual(reopened[0].cells,[['A','']])
 const retyped=await applyDocxTextEdits(cleared,reopened.map(b=>({docxIndex:b.docxIndex,cells:[['A','Again']]})))
 const next=await (await JSZip.loadAsync(retyped)).file('word/document.xml').async('string')
 assert.ok(next.includes('<w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr>'),next)
 assert.ok(next.includes('Again'))
})
test('programmatic cell edits update the matching table field immediately',async()=>{
 const {JSDOM}=await import('jsdom')
 const {mountDocsEditor}=await import('../../../packages/browser-host/src/files.ts')
 const dom=new JSDOM('<div id="editor"></div>'),element=dom.window.document.querySelector('#editor')
 const host={acquireLease:async()=>({leaseEpoch:1}),readDocx:async()=>({file:{revision:'r1'},blocks:[0,1].map(docxIndex=>({docxIndex,type:'table',text:'A',editable:true,cells:[['A']]}))}),commitDocx:async()=>({revision:'r2'})}
 const editor=await mountDocsEditor(host,element,'f')
 try{
  editor.updateCell(1,0,0,'B')
  const fields=element.querySelectorAll('textarea')
  assert.equal(fields[0].value,'A');assert.equal(fields[1].value,'B')
 }finally{editor.destroy();dom.window.close()}
})
