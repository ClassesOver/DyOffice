import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { PDFDocument } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createAiPdf } from '../../src/editors/create-ai-pdf.ts'

test('AI PDF output is a readable PDF containing Chinese document content', async () => {
  const previousParser = globalThis.DOMParser
  globalThis.DOMParser = new JSDOM('').window.DOMParser
  try {
    const font = new Uint8Array(await readFile(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url)))
    const bytes = await createAiPdf('季度报告', '<h1>经营结果</h1><p>收入增长 12%。<script>恶意脚本</script></p>', font)
    assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-')
    const document = await PDFDocument.load(bytes)
    assert.equal(document.getPageCount(), 1)
    assert.equal(document.getTitle(), '季度报告')
  } finally {
    if (previousParser === undefined) delete globalThis.DOMParser
    else globalThis.DOMParser = previousParser
  }
})

test('AI PDF output preserves list markers and table cell boundaries', async () => {
  const previousParser = globalThis.DOMParser
  globalThis.DOMParser = new JSDOM('').window.DOMParser
  try {
    const font = new Uint8Array(await readFile(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url)))
    const bytes = await createAiPdf('结构报告', '<ul><li>第一项</li><li>第二项</li></ul><table><tr><th>名称</th><th>数量</th></tr><tr><td>苹果</td><td>3</td></tr></table>', font)
    const task = getDocument({ data: bytes, disableFontFace: true, useSystemFonts: true })
    try {
      const page = await (await task.promise).getPage(1)
      const text = (await page.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ')
      assert.match(text, /- 第一项/)
      assert.match(text, /- 第二项/)
      assert.match(text, /名称\s+数量/)
      assert.match(text, /苹果\s+3/)
    } finally { await task.destroy() }
  } finally {
    if (previousParser === undefined) delete globalThis.DOMParser
    else globalThis.DOMParser = previousParser
  }
})

test('AI PDF table rows continue on new pages without drawing text below the page margin',async()=>{
 const previousParser=globalThis.DOMParser
 globalThis.DOMParser=new JSDOM('').window.DOMParser
 try{
  const font=new Uint8Array(await readFile(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url)))
  const bytes=await createAiPdf('长表格',`<table><tr><td>${'测试内容'.repeat(600)}</td><td>结束</td></tr></table>`,font)
  const task=getDocument({data:bytes,disableFontFace:true,useSystemFonts:true})
  try{
   const doc=await task.promise
   assert.ok(doc.numPages>1)
   for(let page=1;page<=doc.numPages;page++){
    const items=(await (await doc.getPage(page)).getTextContent()).items
    assert.ok(items.filter(item=>'str'in item&&item.str.trim()).every(item=>item.transform[5]>=52),'Text must stay inside the bottom margin')
   }
  }finally{await task.destroy()}
 }finally{if(previousParser===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=previousParser}
})

test('AI PDF keeps explicit breaks, code indentation and inline emphasis', async()=>{
 const parser=globalThis.DOMParser
 globalThis.DOMParser=new JSDOM('').window.DOMParser
 try {
  const font=new Uint8Array(await readFile(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url)))
  const bytes=await createAiPdf('Formatting','<p>first<br>second</p><pre>alpha\n  beta</pre><p><strong>粗体</strong> <em>斜体</em> <u>underlined</u> <s>deleted</s></p>',font)
  const task=getDocument({data:bytes,disableFontFace:true})
  try{
   const page=await (await task.promise).getPage(1),content=await page.getTextContent()
   const find=str=>content.items.find(item=>item.str?.trim()===str)
   assert.ok(find('first')?.transform[5]>find('second')?.transform[5],'br must advance to the next line')
   assert.ok(find('alpha')?.transform[5]>find('beta')?.transform[5],'pre must preserve line breaks')
   assert.ok(find('beta')?.transform[4]>find('alpha')?.transform[4],'pre must preserve indentation')
   const {fnArray,argsArray}=await page.getOperatorList()
   assert.ok(fnArray.some((op,i)=>op===OPS.setTextRenderingMode&&argsArray[i][0]===2),'bold glyphs are filled and stroked')
   assert.ok(content.items.some(item=>item.str?.startsWith('斜体')&&Math.abs(item.transform[2])>.1),'italic glyphs are slanted')
   assert.equal(fnArray.filter(op=>op===OPS.constructPath).length,2,'underline and strike are drawn as separate rules')
  }finally{await task.destroy()}
 }finally{if(parser===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=parser}
})
