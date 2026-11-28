import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {PDFDocument} from 'pdf-lib'
import JSZip from 'jszip'
import {PNG} from 'pngjs'
import {encryptDocument} from '../../pdf/src/main/pdf-crypt.ts'
import {createIsolatedPdfOfficeConversionJob,createPdfOfficeConversionJob} from '../server/src/pdf/convert-office-job.mjs'
import {buildImagePdf,buildListPdf,buildTablePdf} from '../../../packages/pdf2docx/tests/helpers/fixtures.ts'

test('PDF to Markdown reconstructs the source table',async()=>{
 const job=createIsolatedPdfOfficeConversionJob()
 const {bytes}=await job.execute(Buffer.from(await buildTablePdf()),
  JSON.stringify({version:1,action:'convertOffice',operation:{format:'md'}}))
 const markdown=bytes.toString('utf8')
 assert.match(markdown,/Before the table\./)
 assert.match(markdown,/\|\s*Name\s*\|\s*Qty\s*\|\s*Price\s*\|/)
 assert.match(markdown,/\|\s*Total\s*\|\s*wide merged cell/)
})

test('PDF to HTML exports images and table structure as a standalone document',async()=>{
 const pdf=await PDFDocument.load(await buildImagePdf())
 const table=await PDFDocument.load(await buildTablePdf())
 const [page]=await pdf.copyPages(table,[0])
 pdf.addPage(page)
 const job=createIsolatedPdfOfficeConversionJob()
 const {bytes}=await job.execute(Buffer.from(await pdf.save()),
  JSON.stringify({version:1,action:'convertOffice',operation:{format:'html',title:'Figures & tables'}}))
 const html=bytes.toString('utf8')
 assert.match(html,/^<!DOCTYPE html>/)
 assert.match(html,/<title>Figures &amp; tables<\/title>/)
 assert.match(html,/<meta http-equiv="Content-Security-Policy"[^>]*img-src data:/)
 assert.match(html,/Figure below:/)
 assert.match(html,/<img\b[^>]*src="data:image\/png;base64,[A-Za-z0-9+/]+=*"/)
 assert.match(html,/<td\b[^>]*colspan="2"[^>]*>/)
 assert.match(html,/<td\b[^>]*style="[^"]*border-(top|bottom|left|right):/)
})

test('PDF to HTML preserves Word list markers in the source worker',async()=>{
 const job=createPdfOfficeConversionJob()
 const {bytes}=await job.execute(Buffer.from(await buildListPdf()),
  JSON.stringify({version:1,action:'convertOffice',operation:{format:'html'}}))
 const html=bytes.toString('utf8')
 assert.match(html,/[•●]\s*<span[^>]*>apples and pears/)
 assert.match(html,/2\.[^<]*<span[^>]*>second step done/)
})

test('PDF to Markdown reports pages without extractable text',async()=>{
 const pdf=await PDFDocument.create()
 pdf.addPage().drawRectangle({x:100,y:100,width:100,height:100})
 const job=createIsolatedPdfOfficeConversionJob()
 await assert.rejects(job.execute(Buffer.from(await pdf.save()),
  JSON.stringify({version:1,action:'convertOffice',operation:{format:'md'}})),{code:'PDF_CONVERSION_NO_TEXT'})
})

test('PDF Office conversion respects the copy permission and accepts the owner password',async()=>{
 const {PDFDocument:NativePDFDocument}=createRequire(new URL('../../pdf/package.json',import.meta.url))('pdf-lib')
 const pdf=await NativePDFDocument.create()
 pdf.addPage().drawText('Restricted report')
 encryptDocument(pdf,{
  userPassword:'reader-pass',ownerPassword:'owner-pass',
  permissions:{printing:true,modifying:false,annotating:false,copying:false},
 })
 const bytes=Buffer.from(await pdf.save({useObjectStreams:false}))
 const job=createIsolatedPdfOfficeConversionJob()
 const convert=password=>job.execute(bytes,JSON.stringify({version:1,action:'convertOffice',operation:{format:'docx',password}}))
 await assert.rejects(convert('invalid'),{code:'PASSWORD'})
 await assert.rejects(convert('reader-pass'),{code:'PDF_COPY_RESTRICTED'})
 const {bytes:docx}=await convert('owner-pass')
 const zip=await JSZip.loadAsync(docx)
 assert.match(await zip.file('word/document.xml').async('string'),/Restricted report/)
})

test('PDF Office conversion bounds total page geometry before running the converter',async()=>{
 const pdf=await PDFDocument.create()
 for(let page=0;page<16;page++)pdf.addPage([1600,1600])
 const job=createIsolatedPdfOfficeConversionJob()
 await assert.rejects(job.execute(Buffer.from(await pdf.save()),
  JSON.stringify({version:1,action:'convertOffice',operation:{format:'pptx'}})),{code:'PDF_CONVERSION_LIMIT'})
})

test('PDF to Excel reports when an image-only scan needs OCR',async()=>{
 const pdf=await PDFDocument.create()
 const scan=new PNG({width:600,height:800})
 scan.data.fill(255)
 for(let line=50;line<750;line+=20){
  for(let y=line;y<line+6;y++)scan.data.fill(32,(y*600+50)*4,(y*600+550)*4)
 }
 const image=await pdf.embedPng(PNG.sync.write(scan))
 pdf.addPage([600,800]).drawImage(image,{x:0,y:0,width:600,height:800})
 const job=createIsolatedPdfOfficeConversionJob()
 await assert.rejects(job.execute(Buffer.from(await pdf.save()),
  JSON.stringify({version:1,action:'convertOffice',operation:{format:'xlsx'}})),{code:'PDF_CONVERSION_NEEDS_OCR'})
})
