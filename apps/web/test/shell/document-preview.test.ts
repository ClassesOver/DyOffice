import {expect,test} from 'vitest'
import JSZip from 'jszip'
import {parseOfficePreview,resolvePreviewContentUrl} from '../../src/shell/DocumentPreview'
test('preview accepts only exact revision-bound metadata endpoints',()=>{
 expect(resolvePreviewContentUrl('a',{file:{fileId:'a',revision:'r1'},downloadEndpoint:'/api/v1/files/a/content?revision=r1'})).toBe('/api/v1/files/a/content?revision=r1')
 expect(()=>resolvePreviewContentUrl('a',{file:{fileId:'a',revision:'r1'},downloadEndpoint:'https://evil.test/content'})).toThrow()
})
test('spreadsheet preview renders shared strings and cached values as text',async()=>{
 const zip=new JSZip();zip.file('xl/sharedStrings.xml','<sst><si><t>&lt;script&gt;hello&lt;/script&gt;</t></si></sst>');zip.file('xl/worksheets/sheet1.xml','<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>')
 const result=await parseOfficePreview(new Uint8Array(await zip.generateAsync({type:'arraybuffer'})),'xlsx')
 expect(result[0].rows).toEqual([['<script>hello</script>','2']])
})
test('slides preview orders numbered pages and extracts text without following external links',async()=>{
 const zip=new JSZip();zip.file('ppt/slides/slide2.xml','<p:sld xmlns:p="p" xmlns:a="a"><a:t>第二页</a:t></p:sld>');zip.file('ppt/slides/slide1.xml','<p:sld xmlns:p="p" xmlns:a="a"><a:t>第一页</a:t></p:sld>')
 const result=await parseOfficePreview(new Uint8Array(await zip.generateAsync({type:'arraybuffer'})),'pptx')
 expect(result.map(page=>page.rows)).toEqual([[['第一页']],[['第二页']]])
})
test('preview rejects excessive archive entries before reading contents',async()=>{
 const zip=new JSZip();for(let i=0;i<513;i++)zip.file('entry'+i,'x')
 await expect(parseOfficePreview(new Uint8Array(await zip.generateAsync({type:'arraybuffer'})),'xlsx')).rejects.toThrow()
})
test('spreadsheet preview follows workbook order and worksheet names rather than archive filenames',async()=>{
 const zip=new JSZip()
 zip.file('xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="实际首表" sheetId="2" r:id="rId2"/><sheet name="实际次表" sheetId="1" r:id="rId1"/></sheets></workbook>')
 zip.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>')
 for(const number of [1,2])zip.file(`xl/worksheets/sheet${number}.xml`,`<worksheet><sheetData><row><c r="A1"><v>${number}</v></c></row></sheetData></worksheet>`)
 const result=await parseOfficePreview(new Uint8Array(await zip.generateAsync({type:'arraybuffer'})),'xlsx')
 expect(result.map(page=>({name:page.name,rows:page.rows}))).toEqual([{name:'实际首表',rows:[['2']]},{name:'实际次表',rows:[['1']]}])
})
test('slides preview follows presentation order and refuses external page targets',async()=>{
 const zip=new JSZip()
 zip.file('ppt/presentation.xml','<p:presentation xmlns:p="p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>')
 zip.file('ppt/_rels/presentation.xml.rels','<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>')
 for(const number of [1,2])zip.file(`ppt/slides/slide${number}.xml`,`<p:sld xmlns:p="p" xmlns:a="a"><a:t>${number}</a:t></p:sld>`)
 const bytes=()=>zip.generateAsync({type:'uint8array'})
 expect((await parseOfficePreview(await bytes(),'pptx')).map(page=>page.rows)).toEqual([[['2']],[['1']]])
 zip.file('ppt/_rels/presentation.xml.rels','<Relationships><Relationship Id="rId1" Target="https://example.test/slide.xml" TargetMode="External"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>')
 await expect(parseOfficePreview(await bytes(),'pptx')).rejects.toThrow('索引')
})
