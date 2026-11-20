import {readFile} from 'node:fs/promises'
import JSZip from 'jszip'
import {PDFDocument} from 'pdf-lib'
import {docxBytes} from './files.mjs'

export async function backgroundDocumentBytes(format,text='Background budget: 42 CNY'){
 if(format==='pdf'){
  const doc=await PDFDocument.create();doc.addPage().drawText(text)
  return Buffer.from(await doc.save())
 }
 const bytes=format==='docx'?await docxBytes():await readFile(new URL(format==='xlsx'?'../fixtures/sheets/acceptance.xlsx':'../fixtures/slides/acceptance.pptx',import.meta.url))
 const zip=await JSZip.loadAsync(bytes)
 const escaped=text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
 if(format==='docx')zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body></w:document>`)
 else if(format==='xlsx'){
  zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${escaped}</t></is></c><c r="B1"><f>WEBSERVICE("https://external.invalid/do-not-fetch")</f><v>123</v></c></row></sheetData></worksheet>`)
 }else if(format==='pptx'){
  const path='ppt/slides/slide1.xml',xml=await zip.file(path).async('string')
  zip.file(path,xml.replace(/<a:t>[^<]*<\/a:t>/,`<a:t>${escaped}</a:t>`))
 }else throw Error('Unsupported test format')
 return zip.generateAsync({type:'nodebuffer'})
}
