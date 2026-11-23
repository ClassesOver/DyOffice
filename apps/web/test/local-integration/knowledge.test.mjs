import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import JSZip from 'jszip'
import {PDFDocument} from 'pdf-lib'
import {readFile} from 'node:fs/promises'
import {fileFixture,importFile,docxBytes} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createWorkspaceService} from '../../server/src/modules/workspace/service.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
async function document(text){const zip=await JSZip.loadAsync(await docxBytes());zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);return zip.generateAsync({type:'nodebuffer'})}
function request(f,path,{token=f.alice.token,method='GET',payload,headers={}}={}){
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 return f.app.inject({method,url:'/api/v1/knowledge/'+path,payload,headers:{cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token),...headers}})
}
async function ok(f,path,options){const r=await request(f,path,options);assert.equal(r.statusCode,200,r.body);assert.match(r.headers['cache-control'],/no-store/);return r.json()}
const read=(f,path,offset=0,options)=>request(f,'read?'+new URLSearchParams({path,offset:String(offset)}),options)

test('knowledge reads full paged saved text and searches pinned revisions, not names or unsaved drafts',async t=>{
 const f=await fileFixture(t),workspace=createWorkspaceService(f.transactions),text='Knowledge alpha '.repeat(2000)+'FINALMARKER'
 const source=(await importFile(f,f.alice.token,await document(text),'参考 (one).docx')).file
 await workspace.setStar(f.alice.token,source.fileId,{starred:true})
 const files=await ok(f,'files');assert.equal(files.length,1);assert.equal(typeof files[0].sizeBytes,'number')
 const path=files[0].path;assert.equal(path,`/files/${source.fileId}/revisions/${source.revision}/${encodeURIComponent('参考 (one).docx')}`)
 const first=await read(f,path);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().text.length,24000)
 const second=(await read(f,path,24000)).json();assert.match(second.text,/FINALMARKER/);assert.equal(first.json().totalChars,24000+second.text.length)
 const search=await ok(f,'search',{method:'POST',payload:{q:'FINALMARKER',limit:8,paths:[path]}});assert.equal(search.length,1);assert.equal(search[0].path,path);assert.match(search[0].snippet,/FINALMARKER/)
 assert.deepEqual(await ok(f,'search',{method:'POST',payload:{q:'参考',paths:[path]}}),[],'file names alone never count as full-text evidence')
 const editorId=randomUUID(),leases=createLeaseService({transactions:f.transactions}),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),bytes=await document('New head NEWMARKER')
 const staged=await revisions.stageUpload(f.alice.token,source.fileId,{size:bytes.length,baseRevision:source.revision,leaseEpoch:lease.leaseEpoch,editorId})
 await f.files.receiveUpload(f.alice.token,staged.uploadId,bytes)
 await revisions.commitRevision(f.alice.token,{fileId:source.fileId,uploadId:staged.uploadId,baseRevision:source.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 assert.match((await read(f,path,24000)).json().text,/FINALMARKER/)
 assert.deepEqual(await ok(f,'search',{method:'POST',payload:{q:'NEWMARKER',paths:[path]}}),[])
 const updated=await ok(f,'files');assert.notEqual(updated[0].path,path)
 assert.match((await read(f,updated[0].path)).json().text,/NEWMARKER/)
})

test('knowledge only exposes personal live starred files and validates every requested reference',async t=>{
 const f=await fileFixture(t),workspace=createWorkspaceService(f.transactions),source=(await importFile(f,f.alice.token,await document('SECRET ALPHA'))).file
 assert.deepEqual(await ok(f,'files'),[])
 const path=`/files/${source.fileId}/revisions/${source.revision}/report.docx`
 assert.equal((await read(f,path)).statusCode,404)
 await workspace.setStar(f.alice.token,source.fileId,{starred:true})
 for(const token of [f.bob.token,f.adminSigned.token]){assert.deepEqual(await ok(f,'files',{token}),[]);assert.equal((await read(f,path,0,{token})).statusCode,404);assert.equal((await request(f,'search',{token,method:'POST',payload:{q:'SECRET',paths:[path]}})).statusCode,404)}
 assert.equal((await request(f,'files',{headers:{cookie:''}})).statusCode,401)
 assert.equal((await request(f,'search',{method:'POST',payload:{q:'SECRET',paths:[path]},headers:{'x-csrf-token':''}})).statusCode,403)
 for(const value of ['/etc/passwd',`/files/${source.fileId}/revisions/${randomUUID()}/report.docx`])assert.ok([400,404].includes((await read(f,value)).statusCode))
 assert.equal((await read(f,path,-1)).statusCode,400)
 assert.equal((await request(f,'search',{method:'POST',payload:{q:'',paths:[path]}})).statusCode,400)
 await workspace.setStar(f.alice.token,source.fileId,{starred:false});assert.equal((await read(f,path)).statusCode,404)
 await workspace.setStar(f.alice.token,source.fileId,{starred:true});await f.files.trashFile(f.alice.token,source.fileId)
 assert.deepEqual(await ok(f,'files'),[]);assert.equal((await read(f,path)).statusCode,404)
})

test('knowledge parses all four retained Office formats through real saved files',async t=>{
 const f=await fileFixture(t),workspace=createWorkspaceService(f.transactions)
 const pdf=await PDFDocument.create();pdf.addPage().drawText('PDFKNOWLEDGE')
 const zip=new JSZip();zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>');zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');zip.file('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>');zip.file('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');zip.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>XLSXKNOWLEDGE</t></is></c></row></sheetData></worksheet>')
 const ppt=await JSZip.loadAsync(await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url)));const part='ppt/slides/slide1.xml';ppt.file(part,(await ppt.file(part).async('string')).replace(/(<a:t>)[^<]*(<\/a:t>)/,'$1PPTXKNOWLEDGE$2'))
 for(const [name,bytes] of [['docx',await document('DOCXKNOWLEDGE')],['xlsx',await zip.generateAsync({type:'nodebuffer'})],['pptx',await ppt.generateAsync({type:'nodebuffer'})],['pdf',Buffer.from(await pdf.save())]]){const file=(await importFile(f,f.alice.token,bytes,'evidence.'+name)).file;await workspace.setStar(f.alice.token,file.fileId,{starred:true})}
 const corpus=await ok(f,'files');assert.equal(corpus.length,4)
 const hits=await ok(f,'search',{method:'POST',payload:{q:'KNOWLEDGE',paths:corpus.map(f=>f.path)}});assert.equal(hits.length,4)
 for(const file of corpus)assert.match((await read(f,file.path)).json().text,new RegExp(file.ext.toUpperCase()+'KNOWLEDGE'))
})


test('knowledge rechecks a revoked star and oversized documents never enter the readable corpus',async t=>{
 const {createKnowledgeService}=await import('../../server/src/modules/knowledge/service.ts')
 const f=await fileFixture(t),workspace=createWorkspaceService(f.transactions),source=(await importFile(f,f.alice.token,await document('private content'))).file
 await workspace.setStar(f.alice.token,source.fileId,{starred:true})
 const normal=createKnowledgeService({transactions:f.transactions,files:f.files}),path=(await normal.list(f.alice.token))[0].path
 const racing=createKnowledgeService({transactions:f.transactions,files:{...f.files,async readFile(...args){const bytes=await f.files.readFile(...args);await workspace.setStar(f.alice.token,source.fileId,{starred:false});return bytes}}})
 await assert.rejects(racing.read(f.alice.token,path),{statusCode:404})
 await assert.rejects(importFile(f,f.alice.token,await document('x'.repeat(4*1024*1024+1)),'large.docx'),{statusCode:413})
 assert.deepEqual(await normal.list(f.alice.token),[])
})

// The XML part fits the existing 32 MiB upload limit, but its non-text comment
// exceeds the extractor's former XML-prefix budget for 4,000,001 text chars.
async function knowledgeWorkbookWithLargeComment(){
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 zip.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>prefix</t></is></c></row><!--'+'x'.repeat(32_600_000)+'--><row r="2"><c r="A2" t="inlineStr"><is><t>FINAL-KNOWLEDGE-MARKER</t></is></c></row></sheetData></worksheet>')
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})
}

test('knowledge never mistakes an XLSX XML-prefix budget for complete saved text',async t=>{
 const f=await fileFixture(t),workspace=createWorkspaceService(f.transactions)
 const source=(await importFile(f,f.alice.token,await knowledgeWorkbookWithLargeComment(),'commented.xlsx')).file
 await workspace.setStar(f.alice.token,source.fileId,{starred:true})
 const [file]=await ok(f,'files'),response=await read(f,file.path)
 assert.equal(response.statusCode,200,response.body)
 assert.match(response.json().text,/FINAL-KNOWLEDGE-MARKER/)
 assert.equal(response.json().totalChars,response.json().text.length)
 const hits=await ok(f,'search',{method:'POST',payload:{q:'FINAL-KNOWLEDGE-MARKER',paths:[file.path]}})
 assert.equal(hits.length,1);assert.equal(hits[0].path,file.path);assert.match(hits[0].snippet,/FINAL-KNOWLEDGE-MARKER/)
})

test('knowledge refuses a valid workbook whose full parsed text exceeds the read budget',async t=>{
 const f=await fileFixture(t),workspace=createWorkspaceService(f.transactions)
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 zip.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>'+'z'.repeat(4_000_001)+'</t></is></c></row></sheetData></worksheet>')
 const source=(await importFile(f,f.alice.token,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),'full-text.xlsx')).file
 await workspace.setStar(f.alice.token,source.fileId,{starred:true})
 const [file]=await ok(f,'files')
 assert.equal((await read(f,file.path)).statusCode,413)
 assert.equal((await request(f,'search',{method:'POST',payload:{q:'z',paths:[file.path]}})).statusCode,413)
})
