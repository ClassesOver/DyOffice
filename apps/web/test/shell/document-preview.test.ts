import {expect,test} from 'vitest'
import JSZip from 'jszip'
import {parseOfficePreview,resolvePreviewContentUrl} from '../../src/shell/DocumentPreview'
test('preview accepts only exact revision-bound metadata endpoints',()=>{
 expect(resolvePreviewContentUrl('a',{file:{fileId:'a',revision:'r1'},downloadEndpoint:'/api/v1/files/a/content?revision=r1'})).toBe('/api/v1/files/a/content?revision=r1')
 expect(()=>resolvePreviewContentUrl('a',{file:{fileId:'a',revision:'r1'},downloadEndpoint:'https://evil.test/content'})).toThrow()
})
test('spreadsheet preview renders shared strings and cached values as text',async()=>{
 const zip=new JSZip();zip.file('xl/sharedStrings.xml','<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>&lt;script&gt;hello&lt;/script&gt;</t></si></sst>');zip.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>')
 const result=await parseOfficePreview(new Uint8Array(await zip.generateAsync({type:'arraybuffer'})),'xlsx')
 expect(result[0].rows).toEqual([['<script>hello</script>','2']])
})
test('slides preview orders numbered pages and extracts text without following external links',async()=>{
 const zip=new JSZip();zip.file('ppt/slides/slide2.xml','<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>第二页</a:t></p:sld>');zip.file('ppt/slides/slide1.xml','<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>第一页</a:t></p:sld>')
 const result=await parseOfficePreview(new Uint8Array(await zip.generateAsync({type:'arraybuffer'})),'pptx')
 expect(result.map(page=>page.rows)).toEqual([[['第一页']],[['第二页']]])
})
test('preview rejects excessive archive entries before reading contents',async()=>{
 const zip=new JSZip();for(let i=0;i<513;i++)zip.file('entry'+i,'x')
 await expect(parseOfficePreview(new Uint8Array(await zip.generateAsync({type:'arraybuffer'})),'xlsx')).rejects.toThrow()
})
test('spreadsheet preview follows workbook order and worksheet names rather than archive filenames',async()=>{
 const zip=new JSZip()
 zip.file('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="实际首表" sheetId="2" r:id="rId2"/><sheet name="实际次表" sheetId="1" r:id="rId1"/></sheets></workbook>')
 zip.file('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>')
 for(const number of [1,2])zip.file(`xl/worksheets/sheet${number}.xml`,`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><v>${number}</v></c></row></sheetData></worksheet>`)
 const result=await parseOfficePreview(new Uint8Array(await zip.generateAsync({type:'arraybuffer'})),'xlsx')
 expect(result.map(page=>({name:page.name,rows:page.rows}))).toEqual([{name:'实际首表',rows:[['2']]},{name:'实际次表',rows:[['1']]}])
})
test('slides preview follows presentation order and refuses external page targets',async()=>{
 const zip=new JSZip()
 zip.file('ppt/presentation.xml','<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>')
 zip.file('ppt/_rels/presentation.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>')
 for(const number of [1,2])zip.file(`ppt/slides/slide${number}.xml`,`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>${number}</a:t></p:sld>`)
 const bytes=()=>zip.generateAsync({type:'uint8array'})
 expect((await parseOfficePreview(await bytes(),'pptx')).map(page=>page.rows)).toEqual([[['2']],[['1']]])
 zip.file('ppt/_rels/presentation.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="https://example.test/slide.xml" TargetMode="External"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>')
 await expect(parseOfficePreview(await bytes(),'pptx')).rejects.toThrow('索引')
})

const spreadsheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const presentationNs = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const packageRelationshipsNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
const documentRelationshipsNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function indexedPreviewArchive(format: 'xlsx' | 'pptx', indexPrefix = '', relationshipPrefix = '') {
 const zip = new JSZip(), base = format === 'xlsx' ? 'xl' : 'ppt'
 const indexName = format === 'xlsx' ? 'workbook' : 'presentation'
 const indexNs = format === 'xlsx' ? spreadsheetNs : presentationNs
 const qualifier = indexPrefix ? indexPrefix + ':' : ''
 const relationshipQualifier = relationshipPrefix ? relationshipPrefix + ':' : ''
 const declaration = (prefix: string, namespace: string) => `xmlns${prefix ? ':' + prefix : ''}="${namespace}"`
 const nodes = [2, 1].map(number => format === 'xlsx'
  ? `<${qualifier}sheet name="Budget ${number}" sheetId="${number}" link:id="rId${number}"/>`
  : `<${qualifier}sldId id="${255 + number}" link:id="rId${number}"/>`).join('')
 const listName = format === 'xlsx' ? 'sheets' : 'sldIdLst'
 zip.file(`${base}/${indexName}.xml`, `<${qualifier}${indexName} ${declaration(indexPrefix, indexNs)} xmlns:link="${documentRelationshipsNs}"><${qualifier}${listName}>${nodes}</${qualifier}${listName}></${qualifier}${indexName}>`)
 const relationships = [1, 2].map(number => `<${relationshipQualifier}Relationship Id="rId${number}" Target="${format === 'xlsx' ? 'worksheets/sheet' : 'slides/slide'}${number}.xml"/>`).join('')
 const relationshipPath = `${base}/_rels/${indexName}.xml.rels`
 zip.file(relationshipPath, `<${relationshipQualifier}Relationships ${declaration(relationshipPrefix, packageRelationshipsNs)}>${relationships}</${relationshipQualifier}Relationships>`)
 for (const number of [1, 2]) zip.file(format === 'xlsx' ? `xl/worksheets/sheet${number}.xml` : `ppt/slides/slide${number}.xml`, format === 'xlsx'
  ? `<worksheet xmlns="${spreadsheetNs}"><sheetData><row><c r="A1"><v>${number}</v></c></row></sheetData></worksheet>`
  : '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>' + number + '</a:t></p:sld>')
 return {zip, relationshipPath, indexPath: `${base}/${indexName}.xml`, bytes: () => zip.generateAsync({type: 'uint8array'})}
}

for (const [indexPrefix, relationshipPrefix] of [['x', ''], ['', 'rel'], ['x', 'rel']]) {
 test(`spreadsheet index resolves namespace aliases (${indexPrefix || 'default'}, ${relationshipPrefix || 'default'})`, async () => {
  const fixture = indexedPreviewArchive('xlsx', indexPrefix, relationshipPrefix)
  expect(await parseOfficePreview(await fixture.bytes(), 'xlsx')).toEqual([
   {name: 'Budget 2', rows: [['2']]}, {name: 'Budget 1', rows: [['1']]},
  ])
 })
}

test('presentation index resolves prefixed package relationships and alternate relationship id prefixes', async () => {
 const fixture = indexedPreviewArchive('pptx', 'p', 'rel')
 expect((await parseOfficePreview(await fixture.bytes(), 'pptx')).map(page => page.rows)).toEqual([[['2']], [['1']]])
})

for (const format of ['xlsx', 'pptx'] as const) {
 for (const badTarget of ['external', 'traversal', 'missing', 'foreign-namespace']) {
  test(`${format} prefixed relationships still reject ${badTarget} targets`, async () => {
   const fixture = indexedPreviewArchive(format, 'x', 'rel')
   let relationships = await fixture.zip.file(fixture.relationshipPath)!.async('string')
   const part = format === 'xlsx' ? 'worksheets/sheet2.xml' : 'slides/slide2.xml'
   if (badTarget === 'external') relationships = relationships.replace(`Target="${part}"`, `Target="${part}" TargetMode="External"`)
   if (badTarget === 'traversal') relationships = relationships.replace(part, '../' + part)
   if (badTarget === 'missing') relationships = relationships.replace(part, part.replace('2.xml', 'missing.xml'))
   if (badTarget === 'foreign-namespace') relationships = relationships.replace(packageRelationshipsNs, 'urn:untrusted-relationships')
   fixture.zip.file(fixture.relationshipPath, relationships)
   await expect(parseOfficePreview(await fixture.bytes(), format)).rejects.toThrow('索引')
  })
 }
 test(`${format} ignores lookalike index elements from a foreign namespace`, async () => {
  const fixture = indexedPreviewArchive(format, 'x', 'rel')
  const source = await fixture.zip.file(fixture.indexPath)!.async('string')
  fixture.zip.file(fixture.indexPath, source.replace(format === 'xlsx' ? spreadsheetNs : presentationNs, 'urn:untrusted-index'))
  await expect(parseOfficePreview(await fixture.bytes(), format)).rejects.toThrow('没有可预览')
 })
 test(`${format} rejects a relationship id in a foreign namespace`, async () => {
  const fixture = indexedPreviewArchive(format, 'x', 'rel')
  const source = await fixture.zip.file(fixture.indexPath)!.async('string')
  fixture.zip.file(fixture.indexPath, source.replaceAll('link:', 'r:').replace('xmlns:link=', 'xmlns:r=').replace(documentRelationshipsNs, 'urn:untrusted-id'))
  await expect(parseOfficePreview(await fixture.bytes(), format)).rejects.toThrow('索引')
 })
}

for (const strict of [false, true]) {
 test(`fully prefixed ${strict ? 'Strict' : 'Transitional'} XLSX preserves shared, inline and cached cell values`, async () => {
  const fixture = indexedPreviewArchive('xlsx', 'book', 'package')
  const sheetNs = strict ? 'http://purl.oclc.org/ooxml/spreadsheetml/main' : spreadsheetNs
  if (strict) {
   const source = await fixture.zip.file(fixture.indexPath)!.async('string')
   fixture.zip.file(fixture.indexPath, source.replace(spreadsheetNs, sheetNs).replace(documentRelationshipsNs, 'http://purl.oclc.org/ooxml/officeDocument/relationships'))
  }
  fixture.zip.file('xl/sharedStrings.xml', `<s:sst xmlns:s="${sheetNs}"><s:si><s:t>&lt;script&gt;safe text&lt;/script&gt;</s:t></s:si></s:sst>`)
  fixture.zip.file('xl/worksheets/sheet2.xml', `<s:worksheet xmlns:s="${sheetNs}"><s:sheetData><s:row><s:c r="A1" t="s"><s:v>0</s:v></s:c><s:c r="B1" t="inlineStr"><s:is><s:t>Inline value</s:t></s:is></s:c><s:c r="C1"><s:f>1+1</s:f><s:v>2</s:v></s:c></s:row></s:sheetData></s:worksheet>`)
  expect((await parseOfficePreview(await fixture.bytes(), 'xlsx'))[0]).toEqual({name: 'Budget 2', rows: [['<script>safe text</script>', 'Inline value', '2']]})
 })
 test(`prefixed ${strict ? 'Strict' : 'Transitional'} PPTX preserves slide order and drawing text`, async () => {
  const fixture = indexedPreviewArchive('pptx', 'deck', 'package')
  const slideNs = strict ? 'http://purl.oclc.org/ooxml/presentationml/main' : presentationNs
  const drawingNs = strict ? 'http://purl.oclc.org/ooxml/drawingml/main' : 'http://schemas.openxmlformats.org/drawingml/2006/main'
  if (strict) {
   const source = await fixture.zip.file(fixture.indexPath)!.async('string')
   fixture.zip.file(fixture.indexPath, source.replace(presentationNs, slideNs).replace(documentRelationshipsNs, 'http://purl.oclc.org/ooxml/officeDocument/relationships'))
  }
  for (const number of [1, 2]) fixture.zip.file(`ppt/slides/slide${number}.xml`, `<deck:sld xmlns:deck="${slideNs}" xmlns:text="${drawingNs}"><text:t>Slide ${number}</text:t><alien:t xmlns:alien="urn:not-drawingml">Not slide text</alien:t></deck:sld>`)
  expect((await parseOfficePreview(await fixture.bytes(), 'pptx')).map(page => page.rows)).toEqual([[['Slide 2']], [['Slide 1']]])
 })
}

for (const format of ['xlsx', 'pptx'] as const) {
 test(`${format} prefixed indexes retain the 100-page limit`, async () => {
  const fixture = indexedPreviewArchive(format, 'x', 'rel')
  const source = await fixture.zip.file(fixture.indexPath)!.async('string')
  const node = source.match(format === 'xlsx' ? /<x:sheet [^>]+\/>/ : /<x:sldId [^>]+\/>/)![0]
  fixture.zip.file(fixture.indexPath, source.replace(node, node.repeat(100)))
  await expect(parseOfficePreview(await fixture.bytes(), format)).rejects.toThrow('页数超过')
 })
}

test('namespace-aware preview retains input and expanded-entry byte limits', async () => {
 await expect(parseOfficePreview(new Uint8Array(16 * 1024 * 1024 + 1), 'xlsx')).rejects.toThrow('预览文件超过')
 const fixture = indexedPreviewArchive('xlsx', 'x', 'rel')
 fixture.zip.file('xl/worksheets/sheet2.xml', ' '.repeat(8 * 1024 * 1024 + 1))
 const bytes = await fixture.zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'})
 await expect(parseOfficePreview(bytes, 'xlsx')).rejects.toThrow('文档解压大小超过')
})
