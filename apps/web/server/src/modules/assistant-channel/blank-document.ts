import {readFile} from 'node:fs/promises'
import {PDFDocument} from 'pdf-lib'
import {buildBlankDocx} from '../../../../../../packages/docx-engine/src/blank.ts'

export async function blankChannelDocument({format,title,body}:{format:unknown;title:unknown;body?:unknown}) {
 if((format!=='docx'&&format!=='xlsx'&&format!=='pptx'&&format!=='pdf')||typeof title!=='string'||!title.trim()) {
  throw Object.assign(Error('Invalid document format or title'),{statusCode:400})
 }
 const base=title.trim()
 const name=base.toLowerCase().endsWith('.'+format)?base:base+'.'+format
 if(body!==undefined){
  if(format!=='docx'||typeof body!=='string'||!body.trim()||Buffer.byteLength(body)>24000||/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(body)) {
   throw Object.assign(Error('Invalid Word document body'),{statusCode:400})
  }
  return {name,bytes:Buffer.from(await buildBlankDocx({paragraphs:body.split(/\r\n?|\n/u)}))}
 }
 if(format==='pdf'){
  const pdf=await PDFDocument.create()
  pdf.addPage()
  return {name,bytes:Buffer.from(await pdf.save())}
 }
 const bytes=await readFile(new URL('../../../../../shell/build/shell-new/blank.'+format,import.meta.url))
 return {name,bytes}
}
