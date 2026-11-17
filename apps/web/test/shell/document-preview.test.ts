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
