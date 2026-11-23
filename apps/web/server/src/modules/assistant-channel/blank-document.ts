import {readFile} from 'node:fs/promises'
import {PDFDocument} from 'pdf-lib'

export async function blankChannelDocument({format,title}:{format:unknown;title:unknown}) {
 if((format!=='docx'&&format!=='xlsx'&&format!=='pptx'&&format!=='pdf')||typeof title!=='string'||!title.trim()) {
  throw Object.assign(Error('Invalid document format or title'),{statusCode:400})
 }
 const base=title.trim()
 const name=base.toLowerCase().endsWith('.'+format)?base:base+'.'+format
 if(format==='pdf'){
  const pdf=await PDFDocument.create()
  pdf.addPage()
  return {name,bytes:Buffer.from(await pdf.save())}
 }
 const bytes=await readFile(new URL('../../../../../shell/build/shell-new/blank.'+format,import.meta.url))
 return {name,bytes}
}
